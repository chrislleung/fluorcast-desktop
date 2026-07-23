import type { StoredJobStatus } from "../../features/jobs";
import type { PersistedPredictionJob } from "../db";
import type { RemoteExecutor } from "./RemoteExecutor";
import type { SlurmPollingPersistence, SlurmPollingResult, SlurmRefreshDiagnosticsRecorder } from "./slurmPolling";
import {
  MAX_REFRESH_TRACE_EVENTS,
  type BannerWriteTrace,
  type ManualRefreshTrace,
  type RefreshTraceStage,
  type RowStatusWriteTrace,
  sanitizeDiagnosticFields,
} from "./refreshDiagnostics";

type TimerHandle = ReturnType<typeof setTimeout>;

export const SLURM_POLL_INTERVALS_MS = {
  running: 15_000,
  queued: 25_000,
  resultRetry: 30_000,
  failureBackoffBase: 30_000,
  failureBackoffMax: 120_000,
};

export const HARD_SESSION_FAILURE_THRESHOLD = 1;
export const GLOBAL_POLLING_REMOTE_CONCURRENCY = 1;
export const MAX_GLOBAL_REMOTE_QUEUE_LENGTH = 24;

export type PollStateSnapshot = {
  generation: number;
  inFlight: boolean;
  stopped: boolean;
  lastStartedAt?: string;
  lastCompletedAt?: string;
  lastPollDurationMs?: number;
  consecutiveFailures: number;
  lastSuccessfulState?: string;
  staleResponsesIgnored: number;
  databaseWritesDuringLastPoll: number;
  remoteCommandsDuringLastPoll: number;
  resultImportInFlight: boolean;
  nextPollAt?: string;
};

export type SlurmPollingCoordinatorDiagnostics = {
  coordinatorCount: number;
  activePollStateCount: number;
  activeTimerCount: number;
  inFlightRemoteRequestCount: number;
  inFlightRequestCountByJob: Record<string, number>;
  currentPollGenerationByJob: Record<string, number>;
  pollStatesByJob: Record<string, PollStateSnapshot>;
  staleResponsesIgnored: number;
  remoteCommandsLaunchedLastMinute: number;
  lastPollDurationMs?: number;
  lastSuccessfulSlurmAt?: string;
  consecutiveHardSessionFailures: number;
  databaseWritesDuringLastPoll: number;
  resultImportInFlightByJob: Record<string, boolean>;
  authenticatedSessionState: "unknown" | "available" | "unavailable";
  globalUnavailableMessage?: string;
  globalQueueLength: number;
  globalRunningRemoteRequestCount: number;
  maxGlobalConcurrency: number;
  queuedJobs: string[];
  currentlyExecutingJob?: string;
  coalescedRequestCount: number;
  pollableJobCount: number;
  sessionHealthState: "unknown" | "checking" | "authenticated" | "unavailable";
  sessionHealthCheckInFlightCount: number;
  lastSuccessfulSessionCheck?: string;
  timedOutCommands: number;
  jobsExcludedFromAutomaticPolling: Record<string, string>;
  sessionGeneration: number;
  sessionStateSource: "unknown" | "session_test" | "cached" | "scheduler_success" | "session_failure";
  lastAuthSuccess?: string;
  lastAuthFailure?: string;
  lastGlobalStateWriter?: string;
  lastGlobalStateWriteReason?: string;
  staleSessionResponsesIgnored: number;
  latestManualRefreshTraceByJob: Record<string, ManualRefreshTrace>;
  latestGlobalBannerWriteTrace?: BannerWriteTrace;
};

export type PollResultMeta = {
  generation: number;
  pollSessionGeneration: number;
  currentSessionGeneration: number;
  staleSessionResponse: boolean;
  stale: boolean;
  transientConnectionFailure: boolean;
  consecutiveFailures: number;
  databaseWritesDuringPoll: number;
  remoteCommandsDuringPoll: number;
  startedAt: string;
  completedAt: string;
};

type PollState = {
  timer: TimerHandle | null;
  inFlight: Promise<SlurmPollingResult> | null;
  generation: number;
  lastStartedAt?: number;
  lastCompletedAt?: number;
  consecutiveFailures: number;
  lastSuccessfulState?: string;
  stopped: boolean;
  lastJob?: PersistedPredictionJob;
  lastPollDurationMs?: number;
  staleResponsesIgnored: number;
  databaseWritesDuringLastPoll: number;
  remoteCommandsDuringLastPoll: number;
  resultImportInFlight: boolean;
  nextPollAt?: number;
  manualRefreshCoalesced: boolean;
  sessionGenerationAtStart: number;
};

type QueuedRefresh = {
  jobId: string;
  reason: "auto" | "manual";
  generation: number;
  promise: Promise<SlurmPollingResult>;
  resolve: (result: SlurmPollingResult) => void;
  reject: (error: unknown) => void;
  coalesced: boolean;
  refreshTraceId?: string;
};

export type SlurmPollingCoordinatorOptions = {
  persistence: SlurmPollingPersistence;
  runRemoteRefresh: (
    job: PersistedPredictionJob,
    context: {
      generation: number;
      persistence: SlurmPollingPersistence;
      wrapExecutor: (executor: RemoteExecutor) => RemoteExecutor;
      refreshTraceId?: string;
      diagnostics?: SlurmRefreshDiagnosticsRecorder;
    },
  ) => Promise<SlurmPollingResult>;
  onResult?: (
    job: PersistedPredictionJob,
    result: SlurmPollingResult,
    meta: PollResultMeta,
  ) => void | Promise<void>;
  onStaleResult?: (
    job: PersistedPredictionJob,
    result: SlurmPollingResult,
    meta: PollResultMeta,
  ) => void | Promise<void>;
  onError?: (job: PersistedPredictionJob, error: unknown) => void | Promise<void>;
  onDiagnosticsChange?: (diagnostics: SlurmPollingCoordinatorDiagnostics) => void;
  now?: () => number;
  setTimer?: (handler: () => void, delayMs: number) => TimerHandle;
  clearTimer?: (timer: TimerHandle) => void;
  document?: Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener">;
};

const autoPollableStatuses = new Set<StoredJobStatus>([
  "submitted_to_slurm",
  "queued",
  "running",
  "output_missing",
]);

const terminalPollingStatuses = new Set<SlurmPollingResult["status"]>([
  "completed",
  "failed",
  "cancelled",
  "timed_out",
]);

const hardSessionFailureCodes = new Set([
  "interactive_login_required",
  "interactive_session_expired",
  "ssh_connection_failed",
]);

export function isAutoPollableSlurmJob(job: PersistedPredictionJob) {
  return Boolean(job.remote_slurm_id) && autoPollableStatuses.has(job.status);
}

export function canManuallyRefreshSlurmJob(job: PersistedPredictionJob) {
  return Boolean(job.remote_slurm_id?.trim()) && Boolean(job.remote_job_dir?.trim());
}

export function getNextSlurmPollDelayMs(job: Pick<PersistedPredictionJob, "status">, consecutiveFailures = 0) {
  const baseDelay = job.status === "running"
    ? SLURM_POLL_INTERVALS_MS.running
    : job.status === "output_missing"
      ? SLURM_POLL_INTERVALS_MS.resultRetry
      : SLURM_POLL_INTERVALS_MS.queued;

  if (consecutiveFailures <= 0) {
    return baseDelay;
  }

  return Math.min(
    SLURM_POLL_INTERVALS_MS.failureBackoffMax,
    Math.max(baseDelay, SLURM_POLL_INTERVALS_MS.failureBackoffBase * 2 ** (consecutiveFailures - 1)),
  );
}

function isHardSessionFailure(result: SlurmPollingResult) {
  return Boolean(result.appError?.code && hardSessionFailureCodes.has(result.appError.code));
}

function isSuccessfulSchedulerRefresh(result: SlurmPollingResult) {
  return Boolean(result.schedulerConfirmed || result.slurmState);
}

function isRefreshFailure(result: SlurmPollingResult) {
  return result.status === "connection_failed"
    || result.status === "login_required"
    || result.status === "robot_auth_failed";
}

function isTerminalResult(result: SlurmPollingResult) {
  return terminalPollingStatuses.has(result.status);
}

function isoFromMs(value?: number) {
  return value === undefined ? undefined : new Date(value).toISOString();
}

function createState(): PollState {
  return {
    timer: null,
    inFlight: null,
    generation: 0,
    consecutiveFailures: 0,
    stopped: false,
    staleResponsesIgnored: 0,
    databaseWritesDuringLastPoll: 0,
    remoteCommandsDuringLastPoll: 0,
    resultImportInFlight: false,
    manualRefreshCoalesced: false,
    sessionGenerationAtStart: 0,
  };
}

export class SlurmPollingCoordinator {
  private readonly states = new Map<string, PollState>();
  private readonly remoteCommandLaunches: number[] = [];
  private readonly now: () => number;
  private readonly setTimer: (handler: () => void, delayMs: number) => TimerHandle;
  private readonly clearTimer: (timer: TimerHandle) => void;
  private readonly document?: SlurmPollingCoordinatorOptions["document"];
  private staleResponsesIgnored = 0;
  private lastPollDurationMs: number | undefined;
  private lastSuccessfulSlurmAt: number | undefined;
  private consecutiveHardSessionFailures = 0;
  private databaseWritesDuringLastPoll = 0;
  private authenticatedSessionState: SlurmPollingCoordinatorDiagnostics["authenticatedSessionState"] = "unknown";
  private globalUnavailableMessage: string | undefined;
  private sessionGeneration = 0;
  private sessionStateSource: SlurmPollingCoordinatorDiagnostics["sessionStateSource"] = "unknown";
  private lastAuthSuccess: number | undefined;
  private lastAuthFailure: number | undefined;
  private lastGlobalStateWriter: string | undefined;
  private lastGlobalStateWriteReason: string | undefined;
  private staleSessionResponsesIgnored = 0;
  private readonly latestManualRefreshTraceByJob = new Map<string, ManualRefreshTrace>();
  private latestGlobalBannerWriteTrace: BannerWriteTrace | undefined;
  private readonly queuedRefreshes = new Map<string, QueuedRefresh>();
  private readonly queuedOrder: string[] = [];
  private globalRunningRemoteRequestCount = 0;
  private currentlyExecutingJob: string | undefined;
  private coalescedRequestCount = 0;
  private readonly coalescedManualRefreshJobs = new Set<string>();
  private timedOutCommands = 0;
  private jobsExcludedFromAutomaticPolling: Record<string, string> = {};
  private readonly handleVisibilityChange = () => {
    if (this.isHidden()) {
      this.pauseTimers();
      this.emitDiagnostics();
      return;
    }
    for (const [jobId, state] of this.states) {
      if (!state.stopped && state.lastJob && !state.inFlight && !state.timer) {
        this.schedule(jobId, 0);
      }
    }
    this.emitDiagnostics();
  };

  constructor(private readonly options: SlurmPollingCoordinatorOptions) {
    this.now = options.now ?? (() => Date.now());
    this.setTimer = options.setTimer ?? ((handler, delayMs) => setTimeout(handler, delayMs));
    this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer));
    this.document = options.document ?? (typeof document === "undefined" ? undefined : document);
    this.document?.addEventListener("visibilitychange", this.handleVisibilityChange);
  }

  syncJobs(jobs: PersistedPredictionJob[]) {
    const activeJobIds = new Set<string>();
    const excluded: Record<string, string> = {};

    for (const job of jobs) {
      if (!isAutoPollableSlurmJob(job)) {
        if (job.remote_slurm_id) {
          excluded[job.id] = excludedPollingReason(job);
        }
        this.stopJob(job.id);
        continue;
      }

      activeJobIds.add(job.id);
      const state = this.ensureState(job.id);
      state.lastJob = job;
      state.stopped = false;
      if (!state.timer && !state.inFlight && !this.isHidden()) {
        this.schedule(job.id, state.lastCompletedAt ? getNextSlurmPollDelayMs(job, state.consecutiveFailures) : 0);
      }
    }

    for (const jobId of this.states.keys()) {
      if (!activeJobIds.has(jobId)) {
        this.stopJob(jobId);
      }
    }

    this.jobsExcludedFromAutomaticPolling = excluded;
    this.emitDiagnostics();
  }

  refreshNow(job: PersistedPredictionJob, options: { traceId?: string } = {}) {
    if (!canManuallyRefreshSlurmJob(job)) {
      return Promise.reject(new Error("Manual refresh requires an existing Slurm ID and remote job directory."));
    }
    if (options.traceId) {
      this.recordRefreshTrace(job, options.traceId, "COORDINATOR_REFRESH_REQUESTED", {
        REFRESH_TRACE_ID: options.traceId,
        LOCAL_JOB_ID: job.id,
        SLURM_ID: job.remote_slurm_id,
        REMOTE_JOB_DIR: job.remote_job_dir,
      });
      this.recordRefreshTrace(job, options.traceId, "SESSION_GENERATION", {
        SESSION_GENERATION: this.sessionGeneration,
      });
    }
    const state = this.ensureState(job.id);
    state.lastJob = job;
    state.stopped = false;

    if (state.inFlight) {
      if (options.traceId) {
        this.recordRefreshTrace(job, options.traceId, "COORDINATOR_REFRESH_COALESCED", {
          POLL_GENERATION: state.generation,
        });
      }
      this.emitDiagnostics();
      return state.inFlight;
    }

    this.clearScheduledTimer(state);
    return this.startRefresh(job.id, "manual", options.traceId);
  }

  shutdown() {
    this.document?.removeEventListener("visibilitychange", this.handleVisibilityChange);
    for (const jobId of this.states.keys()) {
      this.stopJob(jobId);
    }
    this.emitDiagnostics();
  }

  getDiagnostics() {
    return this.buildDiagnostics();
  }

  getState(jobId: string) {
    return this.states.get(jobId);
  }

  recordManualRefreshTrace(job: PersistedPredictionJob, traceId: string, stage: RefreshTraceStage, fields?: Record<string, unknown>) {
    this.recordRefreshTrace(job, traceId, stage, fields);
    this.emitDiagnostics();
  }

  recordLatestManualRefreshTrace(job: PersistedPredictionJob, stage: RefreshTraceStage, fields?: Record<string, unknown>) {
    const trace = this.latestManualRefreshTraceByJob.get(job.id);
    if (!trace) {
      return;
    }
    this.recordRefreshTrace(job, trace.traceId, stage, fields);
    this.emitDiagnostics();
  }

  markSessionAuthenticated(params: { writer: string; reason: string; checkedAt?: number; relatedRefreshTraceId?: string }) {
    const checkedAt = params.checkedAt ?? this.now();
    const oldBannerState = this.authenticatedSessionState;
    this.sessionGeneration += 1;
    this.authenticatedSessionState = "available";
    this.sessionStateSource = "session_test";
    this.lastAuthSuccess = checkedAt;
    this.lastGlobalStateWriter = params.writer;
    this.lastGlobalStateWriteReason = params.reason;
    this.globalUnavailableMessage = undefined;
    this.latestGlobalBannerWriteTrace = this.createBannerWriteTrace({
      checkedAt,
      oldBannerState,
      newBannerState: this.authenticatedSessionState,
      writerFunction: params.writer,
      reason: params.reason,
      relatedRefreshTraceId: params.relatedRefreshTraceId,
    });
    this.consecutiveHardSessionFailures = 0;
    for (const [jobId, state] of this.states) {
      if (!state.stopped && state.lastJob && isAutoPollableSlurmJob(state.lastJob) && !state.timer && !state.inFlight && !this.isHidden()) {
        this.schedule(jobId, 0);
      }
    }
    this.emitDiagnostics();
  }

  markSessionUnavailable(params: { writer: string; reason: string; checkedAt?: number; message?: string; relatedRefreshTraceId?: string }) {
    const checkedAt = params.checkedAt ?? this.now();
    const oldBannerState = this.authenticatedSessionState;
    this.sessionGeneration += 1;
    this.authenticatedSessionState = "unavailable";
    this.sessionStateSource = "session_failure";
    this.lastAuthFailure = checkedAt;
    this.lastGlobalStateWriter = params.writer;
    this.lastGlobalStateWriteReason = params.reason;
    this.globalUnavailableMessage = params.message ?? "The authenticated NIBI session is unavailable. Reconnect in Settings.";
    this.latestGlobalBannerWriteTrace = this.createBannerWriteTrace({
      checkedAt,
      oldBannerState,
      newBannerState: this.authenticatedSessionState,
      writerFunction: params.writer,
      reason: params.reason,
      relatedRefreshTraceId: params.relatedRefreshTraceId,
    });
    this.pauseTimers();
    this.emitDiagnostics();
  }

  private ensureState(jobId: string) {
    let state = this.states.get(jobId);
    if (!state) {
      state = createState();
      this.states.set(jobId, state);
    }
    return state;
  }

  private stopJob(jobId: string) {
    const state = this.states.get(jobId);
    if (!state || state.stopped) {
      return;
    }
    state.stopped = true;
    state.generation += 1;
    this.clearScheduledTimer(state);
    state.nextPollAt = undefined;
    if (this.currentlyExecutingJob !== jobId) {
      this.removeQueuedRefresh(jobId, new Error("Queued polling work was cancelled."));
    }
    this.emitDiagnostics();
  }

  private pauseTimers() {
    for (const state of this.states.values()) {
      this.clearScheduledTimer(state);
      state.nextPollAt = undefined;
    }
  }

  private clearScheduledTimer(state: PollState) {
    if (state.timer) {
      this.clearTimer(state.timer);
      state.timer = null;
    }
  }

  private schedule(jobId: string, delayMs: number) {
    const state = this.states.get(jobId);
    if (
      !state
      || state.stopped
      || state.inFlight
      || state.timer
      || this.isHidden()
      || this.authenticatedSessionState === "unavailable"
    ) {
      return;
    }
    state.nextPollAt = this.now() + delayMs;
    state.timer = this.setTimer(() => {
      state.timer = null;
      state.nextPollAt = undefined;
      void this.startRefresh(jobId, "auto").catch(() => undefined);
    }, delayMs);
  }

  private async startRefresh(jobId: string, reason: "auto" | "manual", refreshTraceId?: string) {
    const state = this.states.get(jobId);
    const job = state?.lastJob;
    if (!state || !job || state.stopped) {
      throw new Error("Polling state is not active for this job.");
    }
    if (state.inFlight) {
      this.coalescedRequestCount += 1;
      state.manualRefreshCoalesced ||= reason === "manual";
      if (reason === "manual") {
        this.coalescedManualRefreshJobs.add(jobId);
      }
      const queued = this.queuedRefreshes.get(jobId);
      if (queued && reason === "manual" && queued.reason === "auto") {
        queued.reason = "manual";
        queued.coalesced = true;
        this.promoteQueuedJob(jobId);
      }
      if (queued && reason === "manual") {
        queued.coalesced = true;
      }
      this.emitDiagnostics();
      return state.inFlight;
    }

    this.clearScheduledTimer(state);
    const generation = state.generation + 1;
    state.generation = generation;
    state.lastStartedAt = this.now();
    state.lastPollDurationMs = undefined;
    state.databaseWritesDuringLastPoll = 0;
    state.remoteCommandsDuringLastPoll = 0;
    state.resultImportInFlight = job.status === "output_missing" || job.status === "download_failed" || job.status === "output_invalid";
    state.manualRefreshCoalesced = false;
    state.sessionGenerationAtStart = this.sessionGeneration;

    const promise = this.enqueueRefresh(job, state, generation, reason, refreshTraceId);
    state.inFlight = promise;
    this.emitDiagnostics();
    return promise;
  }

  private enqueueRefresh(
    job: PersistedPredictionJob,
    state: PollState,
    generation: number,
    reason: "auto" | "manual",
    refreshTraceId?: string,
  ) {
    if (this.queuedRefreshes.size >= MAX_GLOBAL_REMOTE_QUEUE_LENGTH) {
      const error = new Error("Polling queue is full. Try refreshing again after current checks finish.");
      return Promise.reject(error);
    }

    let resolve!: (result: SlurmPollingResult) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<SlurmPollingResult>((innerResolve, innerReject) => {
      resolve = innerResolve;
      reject = innerReject;
    });
    const queued: QueuedRefresh = {
      jobId: job.id,
      reason,
      generation,
      promise,
      resolve,
      reject,
      coalesced: false,
      refreshTraceId,
    };
    this.queuedRefreshes.set(job.id, queued);
    if (reason === "manual") {
      this.queuedOrder.unshift(job.id);
    } else {
      this.queuedOrder.push(job.id);
    }
    this.drainQueue();
    return promise;
  }

  private drainQueue() {
    while (
      this.globalRunningRemoteRequestCount < GLOBAL_POLLING_REMOTE_CONCURRENCY
      && this.queuedOrder.length > 0
    ) {
      const jobId = this.queuedOrder.shift();
      if (!jobId) {
        continue;
      }
      const queued = this.queuedRefreshes.get(jobId);
      const state = this.states.get(jobId);
      const job = state?.lastJob;
      if (!queued || !state || !job || state.stopped || state.generation !== queued.generation) {
        this.queuedRefreshes.delete(jobId);
        queued?.reject(new Error("Queued polling work became stale."));
        continue;
      }
      if (queued.reason === "auto" && this.authenticatedSessionState === "unavailable") {
        this.queuedRefreshes.delete(jobId);
        queued.reject(new Error("Scheduled polling is paused until the NIBI session is reconnected."));
        continue;
      }
      this.globalRunningRemoteRequestCount += 1;
      this.currentlyExecutingJob = jobId;
      this.emitDiagnostics();
      void (async () => {
        let result: SlurmPollingResult | undefined;
        let error: unknown;
        try {
          result = await this.executeRefresh(job, state, queued);
        } catch (caught) {
          error = caught;
        } finally {
          this.globalRunningRemoteRequestCount = Math.max(0, this.globalRunningRemoteRequestCount - 1);
          this.queuedRefreshes.delete(jobId);
          if (this.currentlyExecutingJob === jobId) {
            this.currentlyExecutingJob = undefined;
          }
          this.drainQueue();
          this.emitDiagnostics();
        }
        if (error) {
          queued.reject(error);
        } else if (result) {
          queued.resolve(result);
        }
      })();
    }
  }

  private async executeRefresh(job: PersistedPredictionJob, state: PollState, queued: QueuedRefresh) {
    const generation = queued.generation;
    const persistence = this.wrapPersistence(job.id, generation, state);
    const wrapExecutor = (executor: RemoteExecutor) => this.wrapExecutor(executor, state);
    const diagnostics = queued.refreshTraceId
      ? this.createRefreshDiagnosticsRecorder(job, queued.refreshTraceId, generation)
      : undefined;

    try {
      if (queued.refreshTraceId) {
        this.recordRefreshTrace(job, queued.refreshTraceId, "COORDINATOR_EXECUTOR_STARTED", {
          POLL_GENERATION: generation,
          COORDINATOR_REFRESH_COALESCED: queued.coalesced || state.manualRefreshCoalesced || this.coalescedManualRefreshJobs.has(job.id),
        });
      }
      const result = await this.options.runRemoteRefresh(job, {
        generation,
        persistence,
        wrapExecutor,
        refreshTraceId: queued.refreshTraceId,
        diagnostics,
      });
      if (queued.refreshTraceId) {
        this.recordRefreshTrace(job, queued.refreshTraceId, "EXECUTOR_RETURNED_STATUS", {
          EXECUTOR_RETURNED_STATUS: result.status,
          ERROR_MESSAGE: result.status === "connection_failed" ? result.message : undefined,
        });
      }
      const nextResult = queued.reason === "manual"
        ? addManualRefreshDiagnostics(result, queued, state, this.sessionGeneration, this.coalescedManualRefreshJobs.has(job.id))
        : result;
      await this.applyResult(job, nextResult, generation, state);
      return nextResult;
    } catch (error) {
      await this.applyError(job, error, generation, state);
      throw error;
    } finally {
      if (this.states.get(job.id) === state && state.inFlight === queued.promise) {
        state.inFlight = null;
        state.resultImportInFlight = false;
        if (
          !state.stopped
          && state.generation === generation
          && state.lastJob
          && isAutoPollableSlurmJob(state.lastJob)
          && this.authenticatedSessionState !== "unavailable"
        ) {
          this.schedule(job.id, getNextSlurmPollDelayMs(state.lastJob, state.consecutiveFailures));
        }
      }
      if (queued.reason === "manual") {
        this.emitDiagnostics();
      }
    }
  }

  private async applyResult(
    job: PersistedPredictionJob,
    result: SlurmPollingResult,
    generation: number,
    state: PollState,
  ) {
    const completedAt = this.now();
    const stale = this.states.get(job.id) !== state || state.stopped || state.generation !== generation;
    state.lastCompletedAt = completedAt;
    state.lastPollDurationMs = state.lastStartedAt === undefined ? undefined : completedAt - state.lastStartedAt;
    this.lastPollDurationMs = state.lastPollDurationMs;
    this.databaseWritesDuringLastPoll = state.databaseWritesDuringLastPoll;

    const nextFailureCount = isRefreshFailure(result) ? state.consecutiveFailures + 1 : 0;
    state.consecutiveFailures = nextFailureCount;
    const staleSessionResponse = state.sessionGenerationAtStart !== this.sessionGeneration;
    const relatedRefreshTraceId = extractRefreshTraceId(result);
    if (isSuccessfulSchedulerRefresh(result)) {
      const oldBannerState = this.authenticatedSessionState;
      state.lastSuccessfulState = result.slurmState ?? result.status;
      this.lastSuccessfulSlurmAt = completedAt;
      this.consecutiveHardSessionFailures = 0;
      this.authenticatedSessionState = "available";
      this.sessionStateSource = "scheduler_success";
      this.lastGlobalStateWriter = "SlurmPollingCoordinator.applyResult";
      this.lastGlobalStateWriteReason = "scheduler_success";
      this.globalUnavailableMessage = undefined;
      this.latestGlobalBannerWriteTrace = this.createBannerWriteTrace({
        checkedAt: completedAt,
        oldBannerState,
        newBannerState: this.authenticatedSessionState,
        writerFunction: "SlurmPollingCoordinator.applyResult",
        reason: "scheduler_success",
        relatedRefreshTraceId,
      });
    } else if (isHardSessionFailure(result)) {
      this.consecutiveHardSessionFailures += staleSessionResponse ? 0 : 1;
      if (staleSessionResponse) {
        this.staleSessionResponsesIgnored += 1;
      }
    }

    const meta: PollResultMeta = {
      generation,
      pollSessionGeneration: state.sessionGenerationAtStart,
      currentSessionGeneration: this.sessionGeneration,
      staleSessionResponse,
      stale,
      transientConnectionFailure: result.status === "connection_failed" && nextFailureCount < HARD_SESSION_FAILURE_THRESHOLD,
      consecutiveFailures: nextFailureCount,
      databaseWritesDuringPoll: state.databaseWritesDuringLastPoll,
      remoteCommandsDuringPoll: state.remoteCommandsDuringLastPoll,
      startedAt: isoFromMs(state.lastStartedAt) ?? new Date(completedAt).toISOString(),
      completedAt: new Date(completedAt).toISOString(),
    };

    if (stale) {
      state.staleResponsesIgnored += 1;
      this.staleResponsesIgnored += 1;
      if (relatedRefreshTraceId) {
        this.recordRowStatusWrite(job.id, relatedRefreshTraceId, {
          localJobId: job.id,
          oldStatus: job.status,
          newStatus: result.status,
          writerFunction: "SlurmPollingCoordinator.applyResult",
          reason: "stale_response",
          pollGeneration: generation,
          appliedOrIgnored: "ignored",
        });
      }
      await this.options.onStaleResult?.(job, result, meta);
      this.emitDiagnostics();
      return;
    }

    await this.options.onResult?.(job, result, meta);

    if (isTerminalResult(result)) {
      this.stopJob(job.id);
    }
    this.emitDiagnostics();
  }

  private async applyError(
    job: PersistedPredictionJob,
    error: unknown,
    generation: number,
    state: PollState,
  ) {
    const completedAt = this.now();
    const stale = this.states.get(job.id) !== state || state.stopped || state.generation !== generation;
    state.lastCompletedAt = completedAt;
    state.lastPollDurationMs = state.lastStartedAt === undefined ? undefined : completedAt - state.lastStartedAt;
    this.lastPollDurationMs = state.lastPollDurationMs;
    state.consecutiveFailures += 1;
    if (stale) {
      state.staleResponsesIgnored += 1;
      this.staleResponsesIgnored += 1;
    } else {
      await this.options.onError?.(job, error);
    }
    this.emitDiagnostics();
  }

  private wrapPersistence(jobId: string, generation: number, state: PollState): SlurmPollingPersistence {
    const shouldPersist = () => this.states.get(jobId) === state && !state.stopped && state.generation === generation;
    const isStaleSessionFailure = (statusOrEvent?: string) => (
      state.sessionGenerationAtStart !== this.sessionGeneration
      && (
        statusOrEvent === "connection_failed"
        || statusOrEvent === "login_required"
        || statusOrEvent === "slurm_connection_failed"
        || statusOrEvent === "manual_mfa_session_required"
      )
    );
    const shouldSuppressTransientConnectionFailure = (statusOrEvent?: string) => (
      (statusOrEvent === "connection_failed" || statusOrEvent === "slurm_connection_failed")
      && state.consecutiveFailures + 1 < HARD_SESSION_FAILURE_THRESHOLD
    );

    return {
      updateJobStatus: async (targetJobId, status, options) => {
        if (!shouldPersist() || shouldSuppressTransientConnectionFailure(status) || isStaleSessionFailure(status)) {
          this.recordLatestRowStatusWrite(targetJobId, {
            localJobId: targetJobId,
            newStatus: status,
            writerFunction: "SlurmPollingCoordinator.wrapPersistence.updateJobStatus",
            reason: !shouldPersist()
              ? "stale_generation"
              : shouldSuppressTransientConnectionFailure(status)
                ? "transient_connection_failure"
                : "stale_session_failure",
            pollGeneration: generation,
            appliedOrIgnored: "ignored",
          });
          return true;
        }
        state.databaseWritesDuringLastPoll += 1;
        const updated = await this.options.persistence.updateJobStatus(targetJobId, status, options);
        this.recordLatestRowStatusWrite(targetJobId, {
          localJobId: targetJobId,
          newStatus: status,
          writerFunction: "SlurmPollingCoordinator.wrapPersistence.updateJobStatus",
          reason: "persistence_updateJobStatus",
          pollGeneration: generation,
          appliedOrIgnored: updated ? "applied" : "ignored",
        });
        return updated;
      },
      saveResult: async (targetJobId, output, downloadedAt) => {
        if (!shouldPersist()) {
          return true;
        }
        state.databaseWritesDuringLastPoll += 1;
        return this.options.persistence.saveResult(targetJobId, output, downloadedAt);
      },
      addJobEvent: async (targetJobId, eventType, message, createdAt) => {
        if (!shouldPersist() || shouldSuppressTransientConnectionFailure(eventType) || isStaleSessionFailure(eventType)) {
          return true;
        }
        state.databaseWritesDuringLastPoll += 1;
        return this.options.persistence.addJobEvent(targetJobId, eventType, message, createdAt);
      },
    };
  }

  private wrapExecutor(executor: RemoteExecutor, state: PollState): RemoteExecutor {
    return {
      getMode: () => executor.getMode(),
      getConnectionStatus: (settings) => executor.getConnectionStatus(settings),
      validateLocalConfig: (settings) => executor.validateLocalConfig(settings),
      testConnection: (settings) => executor.testConnection(settings),
      runCommand: async (commandSpec) => {
        this.recordRemoteCommand(state);
        const result = await executor.runCommand(commandSpec);
        if (result.timed_out) {
          this.timedOutCommands += 1;
        }
        return result;
      },
      uploadFile: async (localPath, remotePath, settings) => executor.uploadFile(localPath, remotePath, settings),
      downloadFile: async (remotePath, localPath, settings) => {
        this.recordRemoteCommand(state);
        return executor.downloadFile(remotePath, localPath, settings);
      },
      dispose: () => executor.dispose(),
    };
  }

  private recordRemoteCommand(state: PollState) {
    const now = this.now();
    state.remoteCommandsDuringLastPoll += 1;
    this.remoteCommandLaunches.push(now);
    this.pruneRemoteCommandLaunches(now);
  }

  private pruneRemoteCommandLaunches(now = this.now()) {
    const cutoff = now - 60_000;
    while (this.remoteCommandLaunches[0] !== undefined && this.remoteCommandLaunches[0] < cutoff) {
      this.remoteCommandLaunches.shift();
    }
  }

  private isHidden() {
    return this.document?.visibilityState === "hidden";
  }

  private emitDiagnostics() {
    this.options.onDiagnosticsChange?.(this.buildDiagnostics());
  }

  private removeQueuedRefresh(jobId: string, error: unknown) {
    const queued = this.queuedRefreshes.get(jobId);
    if (!queued) {
      return;
    }
    this.queuedRefreshes.delete(jobId);
    this.coalescedManualRefreshJobs.delete(jobId);
    const index = this.queuedOrder.indexOf(jobId);
    if (index >= 0) {
      this.queuedOrder.splice(index, 1);
    }
    queued.reject(error);
  }

  private promoteQueuedJob(jobId: string) {
    const index = this.queuedOrder.indexOf(jobId);
    if (index < 0) {
      return;
    }
    this.queuedOrder.splice(index, 1);
    this.queuedOrder.unshift(jobId);
  }

  private createRefreshDiagnosticsRecorder(job: PersistedPredictionJob, traceId: string, generation: number): SlurmRefreshDiagnosticsRecorder {
    return {
      record: (stage, fields) => {
        this.recordRefreshTrace(job, traceId, stage, fields);
      },
      recordRowStatusWrite: (params) => {
        this.recordRowStatusWrite(params.localJobId, traceId, {
          ...params,
          pollGeneration: params.pollGeneration ?? generation,
        });
      },
    };
  }

  private recordRefreshTrace(
    job: PersistedPredictionJob,
    traceId: string,
    stage: RefreshTraceStage,
    fields?: Record<string, unknown>,
  ) {
    const trace = this.ensureRefreshTrace(job, traceId);
    trace.events.push({
      traceId,
      seq: trace.events.length + trace.rowStatusWrites.length + 1,
      timestamp: new Date(this.now()).toISOString(),
      stage,
      localJobId: job.id,
      slurmId: job.remote_slurm_id,
      remoteJobDir: job.remote_job_dir,
      fields: sanitizeDiagnosticFields(fields),
    });
    this.boundTrace(trace);
  }

  private recordRowStatusWrite(
    jobId: string,
    traceId: string,
    params: Omit<RowStatusWriteTrace, "traceId" | "seq" | "timestamp" | "refreshTraceId">,
  ) {
    const trace = this.latestManualRefreshTraceByJob.get(jobId);
    if (!trace || trace.traceId !== traceId) {
      return;
    }
    trace.rowStatusWrites.push({
      ...params,
      traceId,
      seq: trace.events.length + trace.rowStatusWrites.length + 1,
      timestamp: new Date(this.now()).toISOString(),
      refreshTraceId: traceId,
    });
    this.boundTrace(trace);
  }

  private recordLatestRowStatusWrite(
    jobId: string,
    params: Omit<RowStatusWriteTrace, "traceId" | "seq" | "timestamp" | "refreshTraceId" | "oldStatus"> & { oldStatus?: StoredJobStatus },
  ) {
    const trace = this.latestManualRefreshTraceByJob.get(jobId);
    if (!trace) {
      return;
    }
    this.recordRowStatusWrite(jobId, trace.traceId, params);
  }

  private ensureRefreshTrace(job: PersistedPredictionJob, traceId: string) {
    const existing = this.latestManualRefreshTraceByJob.get(job.id);
    if (existing?.traceId === traceId) {
      return existing;
    }
    const trace: ManualRefreshTrace = {
      traceId,
      localJobId: job.id,
      slurmId: job.remote_slurm_id,
      remoteJobDir: job.remote_job_dir,
      events: [],
      rowStatusWrites: [],
    };
    this.latestManualRefreshTraceByJob.set(job.id, trace);
    return trace;
  }

  private boundTrace(trace: ManualRefreshTrace) {
    while (trace.events.length + trace.rowStatusWrites.length > MAX_REFRESH_TRACE_EVENTS) {
      if (trace.events.length >= trace.rowStatusWrites.length) {
        trace.events.shift();
      } else {
        trace.rowStatusWrites.shift();
      }
    }
  }

  private createBannerWriteTrace(params: {
    checkedAt: number;
    oldBannerState: string;
    newBannerState: string;
    writerFunction: string;
    reason: string;
    relatedRefreshTraceId?: string;
  }): BannerWriteTrace {
    return {
      traceId: `banner-${params.checkedAt.toString(36)}`,
      seq: 1,
      timestamp: new Date(params.checkedAt).toISOString(),
      oldBannerState: params.oldBannerState,
      newBannerState: params.newBannerState,
      writerFunction: params.writerFunction,
      writerFile: "src/lib/remote/slurmPollingCoordinator.ts",
      reason: params.reason,
      sessionGeneration: this.sessionGeneration,
      relatedRefreshTraceId: params.relatedRefreshTraceId,
    };
  }

  private buildDiagnostics(): SlurmPollingCoordinatorDiagnostics {
    const pollStatesByJob: Record<string, PollStateSnapshot> = {};
    const inFlightRequestCountByJob: Record<string, number> = {};
    const currentPollGenerationByJob: Record<string, number> = {};
    const resultImportInFlightByJob: Record<string, boolean> = {};
    let activeTimerCount = 0;
    let inFlightRemoteRequestCount = 0;
    let activePollStateCount = 0;

    for (const [jobId, state] of this.states) {
      if (!state.stopped) {
        activePollStateCount += 1;
      }
      if (state.timer) {
        activeTimerCount += 1;
      }
      if (state.inFlight) {
        inFlightRemoteRequestCount += 1;
      }
      inFlightRequestCountByJob[jobId] = state.inFlight ? 1 : 0;
      currentPollGenerationByJob[jobId] = state.generation;
      resultImportInFlightByJob[jobId] = state.resultImportInFlight;
      pollStatesByJob[jobId] = {
        generation: state.generation,
        inFlight: Boolean(state.inFlight),
        stopped: state.stopped,
        lastStartedAt: isoFromMs(state.lastStartedAt),
        lastCompletedAt: isoFromMs(state.lastCompletedAt),
        lastPollDurationMs: state.lastPollDurationMs,
        consecutiveFailures: state.consecutiveFailures,
        lastSuccessfulState: state.lastSuccessfulState,
        staleResponsesIgnored: state.staleResponsesIgnored,
        databaseWritesDuringLastPoll: state.databaseWritesDuringLastPoll,
        remoteCommandsDuringLastPoll: state.remoteCommandsDuringLastPoll,
        resultImportInFlight: state.resultImportInFlight,
        nextPollAt: isoFromMs(state.nextPollAt),
      };
    }

    this.pruneRemoteCommandLaunches();
    return {
      coordinatorCount: 1,
      activePollStateCount,
      activeTimerCount,
      inFlightRemoteRequestCount,
      inFlightRequestCountByJob,
      currentPollGenerationByJob,
      pollStatesByJob,
      staleResponsesIgnored: this.staleResponsesIgnored,
      remoteCommandsLaunchedLastMinute: this.remoteCommandLaunches.length,
      lastPollDurationMs: this.lastPollDurationMs,
      lastSuccessfulSlurmAt: isoFromMs(this.lastSuccessfulSlurmAt),
      consecutiveHardSessionFailures: this.consecutiveHardSessionFailures,
      databaseWritesDuringLastPoll: this.databaseWritesDuringLastPoll,
      resultImportInFlightByJob,
      authenticatedSessionState: this.authenticatedSessionState,
      globalUnavailableMessage: this.globalUnavailableMessage,
      globalQueueLength: this.queuedOrder.length,
      globalRunningRemoteRequestCount: this.globalRunningRemoteRequestCount,
      maxGlobalConcurrency: GLOBAL_POLLING_REMOTE_CONCURRENCY,
      queuedJobs: [...this.queuedOrder],
      currentlyExecutingJob: this.currentlyExecutingJob,
      coalescedRequestCount: this.coalescedRequestCount,
      pollableJobCount: activePollStateCount,
      sessionHealthState: this.authenticatedSessionState === "available"
        ? "authenticated"
        : this.authenticatedSessionState,
      sessionHealthCheckInFlightCount: this.authenticatedSessionState === "unknown" ? 0 : 0,
      lastSuccessfulSessionCheck: isoFromMs(this.lastSuccessfulSlurmAt),
      timedOutCommands: this.timedOutCommands,
      jobsExcludedFromAutomaticPolling: this.jobsExcludedFromAutomaticPolling,
      sessionGeneration: this.sessionGeneration,
      sessionStateSource: this.sessionStateSource,
      lastAuthSuccess: isoFromMs(this.lastAuthSuccess),
      lastAuthFailure: isoFromMs(this.lastAuthFailure),
      lastGlobalStateWriter: this.lastGlobalStateWriter,
      lastGlobalStateWriteReason: this.lastGlobalStateWriteReason,
      staleSessionResponsesIgnored: this.staleSessionResponsesIgnored,
      latestManualRefreshTraceByJob: Object.fromEntries(this.latestManualRefreshTraceByJob),
      latestGlobalBannerWriteTrace: this.latestGlobalBannerWriteTrace,
    };
  }
}

function excludedPollingReason(job: PersistedPredictionJob) {
  if (!job.remote_slurm_id) {
    return "missing_slurm_id";
  }
  if (job.status === "connection_failed") {
    return "connection_failed_requires_explicit_refresh";
  }
  if (job.status === "download_failed") {
    return "download_failed_requires_explicit_refresh";
  }
  if (job.status === "output_invalid") {
    return "output_invalid_requires_explicit_refresh";
  }
  if (job.status === "completed") {
    return "completed_imported";
  }
  if (job.status === "login_required") {
    return "session_reconnect_required";
  }
  if (job.status === "slurm_submission_failed") {
    return "submission_failed_requires_explicit_retry";
  }
  return "terminal_or_manual_action_required";
}

function addManualRefreshDiagnostics(
  result: SlurmPollingResult,
  queued: QueuedRefresh,
  state: PollState,
  currentSessionGeneration: number,
  wasCoalesced: boolean,
): SlurmPollingResult {
  return {
    ...result,
    technicalDetails: [
      queued.refreshTraceId ? `REFRESH_TRACE_ID=${queued.refreshTraceId}` : "",
      "MANUAL_REFRESH_REQUESTED=1",
      "MANUAL_REFRESH_EXECUTOR_STARTED=1",
      `MANUAL_REFRESH_COALESCED=${queued.coalesced || state.manualRefreshCoalesced || wasCoalesced ? 1 : 0}`,
      `POLL_GENERATION=${queued.generation}`,
      `POLL_SESSION_GENERATION=${state.sessionGenerationAtStart}`,
      `CURRENT_SESSION_GENERATION=${currentSessionGeneration}`,
      result.schedulerConfirmed === undefined ? "" : `SCHEDULER_CONFIRMED=${result.schedulerConfirmed ? 1 : 0}`,
      result.slurmState ? `SLURM_STATE=${result.slurmState}` : "",
      result.slurmExitCode ? `SLURM_EXIT_CODE=${result.slurmExitCode}` : "",
      `UPDATED_JOB_STATUS=${result.status}`,
      result.technicalDetails,
    ].filter(Boolean).join("\n"),
  };
}

function extractRefreshTraceId(result: SlurmPollingResult) {
  return result.technicalDetails?.match(/REFRESH_TRACE_ID=([^\n]+)/)?.[1];
}
