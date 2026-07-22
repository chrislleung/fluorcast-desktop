import type { StoredJobStatus } from "../../features/jobs";
import type { PersistedPredictionJob } from "../db";
import type { RemoteExecutor } from "./RemoteExecutor";
import type { SlurmPollingPersistence, SlurmPollingResult } from "./slurmPolling";

type TimerHandle = ReturnType<typeof setTimeout>;

export const SLURM_POLL_INTERVALS_MS = {
  running: 15_000,
  queued: 25_000,
  resultRetry: 30_000,
  failureBackoffBase: 30_000,
  failureBackoffMax: 120_000,
};

export const HARD_SESSION_FAILURE_THRESHOLD = 3;

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
};

export type PollResultMeta = {
  generation: number;
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
};

export type SlurmPollingCoordinatorOptions = {
  persistence: SlurmPollingPersistence;
  runRemoteRefresh: (
    job: PersistedPredictionJob,
    context: {
      generation: number;
      persistence: SlurmPollingPersistence;
      wrapExecutor: (executor: RemoteExecutor) => RemoteExecutor;
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
  "login_required",
  "connection_failed",
  "slurm_submission_failed",
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

    for (const job of jobs) {
      if (!isAutoPollableSlurmJob(job)) {
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

    this.emitDiagnostics();
  }

  refreshNow(job: PersistedPredictionJob) {
    const state = this.ensureState(job.id);
    state.lastJob = job;
    state.stopped = false;

    if (state.inFlight) {
      this.emitDiagnostics();
      return state.inFlight;
    }

    this.clearScheduledTimer(state);
    return this.startRefresh(job.id, "manual");
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
    if (!state || state.stopped || state.inFlight || state.timer || this.isHidden()) {
      return;
    }
    state.nextPollAt = this.now() + delayMs;
    state.timer = this.setTimer(() => {
      state.timer = null;
      state.nextPollAt = undefined;
      void this.startRefresh(jobId, "auto").catch(() => undefined);
    }, delayMs);
  }

  private async startRefresh(jobId: string, reason: "auto" | "manual") {
    const state = this.states.get(jobId);
    const job = state?.lastJob;
    if (!state || !job || state.stopped) {
      throw new Error("Polling state is not active for this job.");
    }
    if (state.inFlight) {
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

    const persistence = this.wrapPersistence(job.id, generation, state);
    const wrapExecutor = (executor: RemoteExecutor) => this.wrapExecutor(executor, state);

    const promise = this.options.runRemoteRefresh(job, {
      generation,
      persistence,
      wrapExecutor,
    });
    state.inFlight = promise;
    this.emitDiagnostics();

    try {
      const result = await promise;
      await this.applyResult(job, result, generation, state);
      return result;
    } catch (error) {
      await this.applyError(job, error, generation, state);
      throw error;
    } finally {
      if (this.states.get(job.id) === state && state.inFlight === promise) {
        state.inFlight = null;
        state.resultImportInFlight = false;
        if (!state.stopped && state.generation === generation && state.lastJob && !isTerminalPollingJob(state.lastJob)) {
          this.schedule(job.id, getNextSlurmPollDelayMs(state.lastJob, state.consecutiveFailures));
        }
      }
      if (reason === "manual") {
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
    if (isSuccessfulSchedulerRefresh(result)) {
      state.lastSuccessfulState = result.slurmState ?? result.status;
      this.lastSuccessfulSlurmAt = completedAt;
      this.consecutiveHardSessionFailures = 0;
      this.authenticatedSessionState = "available";
      this.globalUnavailableMessage = undefined;
    } else if (isHardSessionFailure(result)) {
      this.consecutiveHardSessionFailures += 1;
      if (this.consecutiveHardSessionFailures >= HARD_SESSION_FAILURE_THRESHOLD) {
        this.authenticatedSessionState = "unavailable";
        this.globalUnavailableMessage = "The authenticated NIBI session is unavailable. Reconnect in Settings.";
      }
    }

    const meta: PollResultMeta = {
      generation,
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
    const shouldSuppressTransientConnectionFailure = (statusOrEvent?: string) => (
      (statusOrEvent === "connection_failed" || statusOrEvent === "slurm_connection_failed")
      && state.consecutiveFailures + 1 < HARD_SESSION_FAILURE_THRESHOLD
    );

    return {
      updateJobStatus: async (targetJobId, status, options) => {
        if (!shouldPersist() || shouldSuppressTransientConnectionFailure(status)) {
          return true;
        }
        state.databaseWritesDuringLastPoll += 1;
        return this.options.persistence.updateJobStatus(targetJobId, status, options);
      },
      saveResult: async (targetJobId, output, downloadedAt) => {
        if (!shouldPersist()) {
          return true;
        }
        state.databaseWritesDuringLastPoll += 1;
        return this.options.persistence.saveResult(targetJobId, output, downloadedAt);
      },
      addJobEvent: async (targetJobId, eventType, message, createdAt) => {
        if (!shouldPersist() || shouldSuppressTransientConnectionFailure(eventType)) {
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
        return executor.runCommand(commandSpec);
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
    };
  }
}

function isTerminalPollingJob(job: PersistedPredictionJob) {
  return job.status === "completed"
    || job.status === "failed"
    || job.status === "cancelled"
    || job.status === "timed_out"
    || job.status === "timeout";
}
