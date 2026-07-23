import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultNibiSettings } from "../../features/settings";
import type { PersistedPredictionJob } from "../db";
import type { RemoteExecutor } from "./RemoteExecutor";
import {
  GLOBAL_POLLING_REMOTE_CONCURRENCY,
  canManuallyRefreshSlurmJob,
  isAutoPollableSlurmJob,
  MAX_GLOBAL_REMOTE_QUEUE_LENGTH,
  getNextSlurmPollDelayMs,
  SLURM_POLL_INTERVALS_MS,
  SlurmPollingCoordinator,
  type SlurmPollingCoordinatorOptions,
} from "./slurmPollingCoordinator";
import { pollSlurmJobStatus, type SlurmPollingResult } from "./slurmPolling";

const runningJob: PersistedPredictionJob = {
  id: "job-1",
  molecule_smiles: "CCO",
  solvent_smiles: "O",
  model_choice: "rf",
  status: "running",
  created_at: "2026-07-22T12:00:00.000Z",
  remote_slurm_id: "12345",
  remote_job_dir: "/scratch/fluorcast/job-1",
};

const queuedJob: PersistedPredictionJob = {
  ...runningJob,
  id: "job-queued",
  status: "queued",
  remote_slurm_id: "12346",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

function result(status: SlurmPollingResult["status"], overrides: Partial<SlurmPollingResult> = {}): SlurmPollingResult {
  return {
    jobId: overrides.jobId ?? runningJob.id,
    slurmJobId: overrides.slurmJobId ?? runningJob.remote_slurm_id,
    status,
    message: `${status} message`,
    ...overrides,
  };
}

function noopPersistence(): SlurmPollingCoordinatorOptions["persistence"] {
  return {
    updateJobStatus: vi.fn().mockResolvedValue(true),
    saveResult: vi.fn().mockResolvedValue(true),
    addJobEvent: vi.fn().mockResolvedValue(true),
  };
}

function executor(runCommand = vi.fn().mockResolvedValue({
  exit_code: 0,
  stdout: "",
  stderr: "",
  duration_ms: 0,
  command_label: "ok",
  redacted_command_preview: "ok",
})): RemoteExecutor {
  return {
    getMode: () => "mock",
    getConnectionStatus: () => ({ mode: "mock", state: "not_configured", label: "Mock", message: "mock" }),
    validateLocalConfig: () => ({}),
    testConnection: vi.fn(),
    runCommand,
    uploadFile: vi.fn(),
    downloadFile: vi.fn(),
    dispose: vi.fn(),
  };
}

function createCoordinator(options: Partial<SlurmPollingCoordinatorOptions> = {}) {
  const persistence = options.persistence ?? noopPersistence();
  const runRemoteRefresh = options.runRemoteRefresh ?? vi.fn(async (_job, { wrapExecutor }) => {
    await wrapExecutor(executor()).runCommand({
      label: "Poll active Slurm job",
      executable: "squeue",
      args: [],
      redacted_preview: "squeue",
    });
    return result("running", { schedulerConfirmed: true, slurmState: "RUNNING" });
  });
  return new SlurmPollingCoordinator({
    persistence,
    runRemoteRefresh,
    ...options,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-22T12:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("SlurmPollingCoordinator", () => {
  it("only automatically polls active Slurm/result-import states", () => {
    expect([
      "submitted_to_slurm",
      "queued",
      "running",
      "output_missing",
    ].filter((status) => isAutoPollableSlurmJob({ ...runningJob, status: status as PersistedPredictionJob["status"] })))
      .toEqual(["submitted_to_slurm", "queued", "running", "output_missing"]);

    for (const status of [
      "completed",
      "failed",
      "cancelled",
      "timed_out",
      "connection_failed",
      "download_failed",
      "output_invalid",
      "slurm_submission_failed",
      "login_required",
    ] satisfies PersistedPredictionJob["status"][]) {
      expect(isAutoPollableSlurmJob({ ...runningJob, status })).toBe(false);
    }
  });

  it("allows connection failures with Slurm metadata to be manually refreshed", async () => {
    const connectionFailedJob: PersistedPredictionJob = {
      ...runningJob,
      status: "connection_failed",
    };
    const runRemoteRefresh = vi.fn().mockResolvedValue(result("running", {
      schedulerConfirmed: true,
      slurmState: "RUNNING",
    }));
    const coordinator = createCoordinator({ runRemoteRefresh });

    expect(isAutoPollableSlurmJob(connectionFailedJob)).toBe(false);
    expect(canManuallyRefreshSlurmJob(connectionFailedJob)).toBe(true);
    expect(coordinator.getDiagnostics().activeTimerCount).toBe(0);

    const refreshed = await coordinator.refreshNow(connectionFailedJob);

    expect(runRemoteRefresh).toHaveBeenCalledTimes(1);
    expect(refreshed.status).toBe("running");
    expect(refreshed.technicalDetails).toContain("MANUAL_REFRESH_REQUESTED=1");
    expect(refreshed.technicalDetails).toContain("UPDATED_JOB_STATUS=running");
    expect(coordinator.getDiagnostics().activeTimerCount).toBe(0);
  });

  it("records FLUORCAST_AUTH_OK as the authoritative live session state", () => {
    const coordinator = createCoordinator();

    coordinator.markSessionUnavailable({
      writer: "test",
      reason: "session_check_failed",
      message: "old unavailable",
    });
    coordinator.markSessionAuthenticated({
      writer: "SettingsPage.testManualMfaSession",
      reason: "FLUORCAST_AUTH_OK",
    });

    expect(coordinator.getDiagnostics()).toMatchObject({
      authenticatedSessionState: "available",
      globalUnavailableMessage: undefined,
      sessionGeneration: 2,
      sessionStateSource: "session_test",
      lastGlobalStateWriter: "SettingsPage.testManualMfaSession",
      lastGlobalStateWriteReason: "FLUORCAST_AUTH_OK",
    });
  });

  it("does not let an older poll failure overwrite newer authentication success", async () => {
    const pending = deferred<SlurmPollingResult>();
    const coordinator = createCoordinator({
      runRemoteRefresh: vi.fn(() => pending.promise),
    });

    const refresh = coordinator.refreshNow(runningJob);
    coordinator.markSessionAuthenticated({
      writer: "SettingsPage.testManualMfaSession",
      reason: "FLUORCAST_AUTH_OK",
    });
    pending.resolve(result("connection_failed", {
      appError: {
        code: "ssh_connection_failed",
        message: "old poll failed",
      },
    }));
    await refresh;

    expect(coordinator.getDiagnostics()).toMatchObject({
      authenticatedSessionState: "available",
      sessionStateSource: "session_test",
      staleSessionResponsesIgnored: 1,
    });
  });

  it("keeps job-level refresh failures from setting global session unavailable", async () => {
    const coordinator = createCoordinator({
      runRemoteRefresh: vi.fn().mockResolvedValue(result("connection_failed", {
        appError: {
          code: "slurm_unavailable",
          message: "Slurm is unavailable from this session. Check the NIBI environment.",
        },
      })),
    });

    await coordinator.refreshNow(runningJob);

    expect(coordinator.getDiagnostics()).toMatchObject({
      authenticatedSessionState: "unknown",
      globalUnavailableMessage: undefined,
    });
  });

  it("keeps FLUORCAST_AUTH_OK available while invalid squeue falls back to sacct", async () => {
    const runCommand = vi.fn()
      .mockResolvedValueOnce({
        exit_code: 1,
        stdout: "",
        stderr: "slurm_load_jobs error: Invalid job id specified",
        duration_ms: 1,
        command_label: "squeue",
        redacted_command_preview: "squeue",
      })
      .mockResolvedValueOnce({
        exit_code: 0,
        stdout: "12345|RUNNING|0:0|",
        stderr: "",
        duration_ms: 1,
        command_label: "sacct",
        redacted_command_preview: "sacct",
      });
    const coordinator = createCoordinator({
      runRemoteRefresh: vi.fn((job, context) => pollSlurmJobStatus(
        job,
        {
          ...defaultNibiSettings,
          backend_mode: "nibi",
          connection_mode: "interactive_mfa",
          manual_login_verified: true,
        },
        context.wrapExecutor(executor(runCommand)),
        context.persistence,
        context.diagnostics,
      )),
    });

    coordinator.markSessionAuthenticated({
      writer: "App.testManualMfaSessionForJobs",
      reason: "FLUORCAST_AUTH_OK",
    });
    await coordinator.refreshNow({ ...runningJob, status: "connection_failed" }, { traceId: "refresh-fallback" });

    const diagnostics = coordinator.getDiagnostics();
    expect(diagnostics.authenticatedSessionState).toBe("available");
    expect(diagnostics.latestGlobalBannerWriteTrace?.newBannerState).toBe("available");
    expect(diagnostics.latestManualRefreshTraceByJob[runningJob.id].events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        stage: "SQUEUE_CLASSIFICATION",
        fields: expect.objectContaining({ SQUEUE_CLASSIFICATION: "active_job_not_found" }),
      }),
      expect.objectContaining({
        stage: "SACCT_FALLBACK_STARTED",
      }),
    ]));
  });

  it("rejects manual refresh without both Slurm ID and remote job directory", async () => {
    const coordinator = createCoordinator();

    await expect(coordinator.refreshNow({
      ...runningJob,
      remote_job_dir: undefined,
    })).rejects.toThrow("Manual refresh requires an existing Slurm ID and remote job directory");
    await expect(coordinator.refreshNow({
      ...runningJob,
      remote_slurm_id: undefined,
    })).rejects.toThrow("Manual refresh requires an existing Slurm ID and remote job directory");
  });

  it("keeps twelve stored jobs with one running job to one poll state and one timer", () => {
    const jobs = [
      runningJob,
      ...Array.from({ length: 11 }, (_, index): PersistedPredictionJob => ({
        ...runningJob,
        id: `stored-${index}`,
        remote_slurm_id: `${20000 + index}`,
        status: index % 3 === 0
          ? "connection_failed"
          : index % 3 === 1
          ? "download_failed"
          : "completed",
      })),
    ];
    const coordinator = createCoordinator();

    coordinator.syncJobs(jobs);

    const diagnostics = coordinator.getDiagnostics();
    expect(diagnostics.pollableJobCount).toBe(1);
    expect(diagnostics.activeTimerCount).toBe(1);
    expect(Object.keys(diagnostics.jobsExcludedFromAutomaticPolling)).toHaveLength(11);
  });

  it("limits remote polling work globally even when twelve active jobs refresh", async () => {
    const pending = deferred<SlurmPollingResult>();
    const runRemoteRefresh = vi.fn(() => pending.promise);
    const coordinator = createCoordinator({ runRemoteRefresh });
    const activeJobs = Array.from({ length: 12 }, (_, index): PersistedPredictionJob => ({
      ...runningJob,
      id: `active-${index}`,
      remote_slurm_id: `${30000 + index}`,
    }));

    const refreshes = activeJobs.map((job) => coordinator.refreshNow(job));

    expect(runRemoteRefresh).toHaveBeenCalledTimes(GLOBAL_POLLING_REMOTE_CONCURRENCY);
    expect(coordinator.getDiagnostics()).toMatchObject({
      globalRunningRemoteRequestCount: 1,
      maxGlobalConcurrency: 1,
      globalQueueLength: 11,
    });

    pending.resolve(result("running", { schedulerConfirmed: true, slurmState: "RUNNING" }));
    await Promise.all(refreshes);
  });

  it("bounds the global queue", async () => {
    const pending = deferred<SlurmPollingResult>();
    const coordinator = createCoordinator({ runRemoteRefresh: vi.fn(() => pending.promise) });
    const activeJobs = Array.from({ length: MAX_GLOBAL_REMOTE_QUEUE_LENGTH + 1 }, (_, index): PersistedPredictionJob => ({
      ...runningJob,
      id: `bounded-${index}`,
      remote_slurm_id: `${40000 + index}`,
    }));

    const refreshes = activeJobs.map((job) => coordinator.refreshNow(job));

    await expect(refreshes.at(-1)).rejects.toThrow("Polling queue is full");
    pending.resolve(result("running", { schedulerConfirmed: true, slurmState: "RUNNING" }));
    await Promise.allSettled(refreshes.slice(0, -1));
  });

  it("runs manual refreshes before queued background polls", async () => {
    const pending = deferred<SlurmPollingResult>();
    const started: string[] = [];
    const runRemoteRefresh = vi.fn((job: PersistedPredictionJob) => {
      started.push(job.id);
      return job.id === "active-0"
        ? pending.promise
        : Promise.resolve(result("running", { jobId: job.id, slurmJobId: job.remote_slurm_id, schedulerConfirmed: true, slurmState: "RUNNING" }));
    });
    const timers: Array<() => void> = [];
    const coordinator = createCoordinator({
      runRemoteRefresh,
      setTimer: (handler) => {
        timers.push(handler);
        return handler as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimer: vi.fn(),
    });
    const first = { ...runningJob, id: "active-0", remote_slurm_id: "50000" };
    const auto = { ...runningJob, id: "auto", remote_slurm_id: "50001" };
    const manual = { ...runningJob, id: "manual", remote_slurm_id: "50002" };

    const firstRefresh = coordinator.refreshNow(first);
    coordinator.syncJobs([first, auto]);
    timers.forEach((handler) => handler());
    const manualRefresh = coordinator.refreshNow(manual);

    expect(coordinator.getDiagnostics().queuedJobs[0]).toBe("manual");
    pending.resolve(result("running", { jobId: first.id, slurmJobId: first.remote_slurm_id, schedulerConfirmed: true, slurmState: "RUNNING" }));
    await Promise.all([firstRefresh, manualRefresh]);
    expect(started.slice(0, 2)).toEqual(["active-0", "manual"]);
  });

  it("creates one active timer for one active job and survives Strict Mode remount cleanup", () => {
    const clearTimer = vi.fn((timer: ReturnType<typeof setTimeout>) => clearTimeout(timer));
    const first = createCoordinator({ clearTimer });
    first.syncJobs([runningJob]);
    expect(first.getDiagnostics().activeTimerCount).toBe(1);
    first.shutdown();
    expect(first.getDiagnostics().activeTimerCount).toBe(0);

    const second = createCoordinator({ clearTimer });
    second.syncJobs([runningJob]);
    expect(second.getDiagnostics()).toMatchObject({
      coordinatorCount: 1,
      activePollStateCount: 1,
      activeTimerCount: 1,
    });
    second.shutdown();
  });

  it("serializes in-flight refreshes and coalesces repeated manual refreshes without extra timers", async () => {
    const pending = deferred<SlurmPollingResult>();
    const runRemoteRefresh = vi.fn(() => pending.promise);
    const coordinator = createCoordinator({ runRemoteRefresh });

    const first = coordinator.refreshNow(runningJob);
    const second = coordinator.refreshNow(runningJob);
    const third = coordinator.refreshNow(runningJob);

    expect(runRemoteRefresh).toHaveBeenCalledTimes(1);
    expect(coordinator.getDiagnostics()).toMatchObject({
      activeTimerCount: 0,
      inFlightRemoteRequestCount: 1,
    });

    const resolved = result("running", { schedulerConfirmed: true, slurmState: "RUNNING" });
    pending.resolve(resolved);
    const results = await Promise.all([first, second, third]);
    expect(results).toHaveLength(3);
    expect(results.every((item) => item.status === "running")).toBe(true);
    expect(results[0].technicalDetails).toContain("MANUAL_REFRESH_REQUESTED=1");
    expect(runRemoteRefresh).toHaveBeenCalledTimes(1);
    expect(coordinator.getDiagnostics().activeTimerCount).toBe(1);
  });

  it("manual refresh does not call sbatch", async () => {
    const runCommand = vi.fn().mockResolvedValue({
      exit_code: 0,
      stdout: "",
      stderr: "",
      duration_ms: 0,
      command_label: "squeue",
      redacted_command_preview: "squeue",
    });
    const runRemoteRefresh = vi.fn(async (_job, { wrapExecutor }) => {
      const wrapped = wrapExecutor(executor(runCommand));
      await wrapped.runCommand({ label: "squeue", executable: "squeue", args: [], redacted_preview: "squeue" });
      return result("running", { schedulerConfirmed: true, slurmState: "RUNNING" });
    });
    const coordinator = createCoordinator({ runRemoteRefresh });

    await coordinator.refreshNow(runningJob);

    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(runCommand.mock.calls.some(([command]) => command.executable === "sbatch")).toBe(false);
  });

  it("passes the manual refresh trace ID to the remote executor context", async () => {
    const runRemoteRefresh = vi.fn(async (_job, context) => {
      context.diagnostics?.record("SQUEUE_STARTED", { password: "secret-password" });
      return result("running", { schedulerConfirmed: true, slurmState: "RUNNING" });
    });
    const coordinator = createCoordinator({ runRemoteRefresh });

    await coordinator.refreshNow(runningJob, { traceId: "refresh-one" });

    expect(runRemoteRefresh.mock.calls[0][1].refreshTraceId).toBe("refresh-one");
    const trace = coordinator.getDiagnostics().latestManualRefreshTraceByJob[runningJob.id];
    expect(trace.events.map((event) => event.stage)).toContain("SQUEUE_STARTED");
    expect(JSON.stringify(trace)).not.toContain("secret-password");
    expect(JSON.stringify(trace)).toContain("<redacted>");
  });

  it("records banner writers and row status writers in diagnostics", async () => {
    const persistence = noopPersistence();
    const coordinator = createCoordinator({
      persistence,
      runRemoteRefresh: vi.fn(async (job, context) => {
        await context.persistence.updateJobStatus(job.id, "running", {});
        return result("running", {
        schedulerConfirmed: true,
        slurmState: "RUNNING",
        });
      }),
    });

    await coordinator.refreshNow(runningJob, { traceId: "refresh-writers" });

    const diagnostics = coordinator.getDiagnostics();
    expect(diagnostics.latestGlobalBannerWriteTrace).toMatchObject({
      writerFunction: "SlurmPollingCoordinator.applyResult",
      writerFile: "src/lib/remote/slurmPollingCoordinator.ts",
      reason: "scheduler_success",
    });
    expect(diagnostics.latestManualRefreshTraceByJob[runningJob.id].rowStatusWrites[0]).toMatchObject({
      writerFunction: "SlurmPollingCoordinator.wrapPersistence.updateJobStatus",
      newStatus: "running",
      appliedOrIgnored: "applied",
    });
  });

  it("shows stale response row writes as ignored in diagnostics", async () => {
    const pending = deferred<SlurmPollingResult>();
    const coordinator = createCoordinator({
      runRemoteRefresh: vi.fn(() => pending.promise),
    });

    const refresh = coordinator.refreshNow(runningJob, { traceId: "refresh-stale" });
    const state = coordinator.getState(runningJob.id);
    if (!state) throw new Error("missing poll state");
    state.generation = 7;
    pending.resolve(result("connection_failed"));
    await refresh;

    expect(coordinator.getDiagnostics().latestManualRefreshTraceByJob[runningJob.id].rowStatusWrites[0])
      .toMatchObject({ reason: "stale_response", appliedOrIgnored: "ignored" });
  });

  it("bounds manual refresh trace storage", async () => {
    const coordinator = createCoordinator({
      runRemoteRefresh: vi.fn(async (_job, context) => {
        for (let index = 0; index < 120; index += 1) {
          context.diagnostics?.record("SQUEUE_STDOUT", { index });
        }
        return result("running", { schedulerConfirmed: true, slurmState: "RUNNING" });
      }),
    });

    await coordinator.refreshNow(runningJob, { traceId: "refresh-bounded" });

    const trace = coordinator.getDiagnostics().latestManualRefreshTraceByJob[runningJob.id];
    expect(trace.events.length + trace.rowStatusWrites.length).toBeLessThanOrEqual(100);
  });

  it("stops polling after result import and on disposal", async () => {
    const runRemoteRefresh = vi.fn().mockResolvedValue(result("completed", {
      output: {
        job_id: runningJob.id,
        status: "succeeded",
        completed_at: "2026-07-22T12:01:00.000Z",
        canonical_molecule_smiles: "CCO",
        canonical_solvent_smiles: "O",
        predictions: [],
        warnings: [],
      },
      schedulerConfirmed: true,
      slurmState: "COMPLETED",
      slurmExitCode: "0:0",
    }));
    const coordinator = createCoordinator({ runRemoteRefresh });

    await coordinator.refreshNow(runningJob);

    expect(coordinator.getDiagnostics().activeTimerCount).toBe(0);
    expect(coordinator.getDiagnostics().pollStatesByJob[runningJob.id].stopped).toBe(true);

    coordinator.syncJobs([queuedJob]);
    expect(coordinator.getDiagnostics().activeTimerCount).toBe(1);
    coordinator.shutdown();
    expect(coordinator.getDiagnostics().activeTimerCount).toBe(0);
  });

  it("uses conservative minimum intervals", () => {
    expect(getNextSlurmPollDelayMs({ status: "running" })).toBe(SLURM_POLL_INTERVALS_MS.running);
    expect(getNextSlurmPollDelayMs({ status: "queued" })).toBe(SLURM_POLL_INTERVALS_MS.queued);
    expect(getNextSlurmPollDelayMs({ status: "output_missing" })).toBe(SLURM_POLL_INTERVALS_MS.resultRetry);
    expect(getNextSlurmPollDelayMs({ status: "running" }, 1)).toBeGreaterThanOrEqual(30_000);
  });

  it("ignores late stale responses after a newer generation wins", async () => {
    const pending = deferred<SlurmPollingResult>();
    const onResult = vi.fn();
    const onStaleResult = vi.fn();
    const persistence = noopPersistence();
    const coordinator = createCoordinator({
      persistence,
      onResult,
      onStaleResult,
      runRemoteRefresh: vi.fn(() => pending.promise),
    });

    const refresh = coordinator.refreshNow(runningJob);
    const state = coordinator.getState(runningJob.id);
    if (!state) throw new Error("missing poll state");
    state.generation = 11;
    pending.reject(new Error("older poll failed"));

    await expect(refresh).rejects.toThrow("older poll failed");

    expect(onResult).not.toHaveBeenCalled();
    expect(onStaleResult).not.toHaveBeenCalled();
    expect(persistence.updateJobStatus).not.toHaveBeenCalled();
    expect(coordinator.getDiagnostics().staleResponsesIgnored).toBe(1);
  });

  it("preserves last confirmed state through a transient failure and clears unavailable state on success", async () => {
    const coordinator = createCoordinator({
      runRemoteRefresh: vi.fn()
        .mockResolvedValueOnce(result("running", { schedulerConfirmed: true, slurmState: "RUNNING" }))
        .mockResolvedValueOnce(result("connection_failed"))
        .mockResolvedValueOnce(result("queued", { schedulerConfirmed: true, slurmState: "PENDING" })),
    });

    await coordinator.refreshNow(runningJob);
    await coordinator.refreshNow(runningJob);
    let diagnostics = coordinator.getDiagnostics();
    expect(diagnostics.pollStatesByJob[runningJob.id].lastSuccessfulState).toBe("RUNNING");
    expect(diagnostics.pollStatesByJob[runningJob.id].consecutiveFailures).toBe(1);
    expect(diagnostics.authenticatedSessionState).toBe("available");

    await coordinator.refreshNow(queuedJob);
    diagnostics = coordinator.getDiagnostics();
    expect(diagnostics.authenticatedSessionState).toBe("available");
    expect(diagnostics.globalUnavailableMessage).toBeUndefined();
  });

  it("disposal invalidates late responses", async () => {
    const pending = deferred<SlurmPollingResult>();
    const onResult = vi.fn();
    const onStaleResult = vi.fn();
    const coordinator = createCoordinator({
      onResult,
      onStaleResult,
      runRemoteRefresh: vi.fn(() => pending.promise),
    });

    const refresh = coordinator.refreshNow(runningJob);
    coordinator.shutdown();
    pending.resolve(result("running", { schedulerConfirmed: true, slurmState: "RUNNING" }));
    await refresh;

    expect(onResult).not.toHaveBeenCalled();
    expect(onStaleResult).toHaveBeenCalledTimes(1);
    expect(coordinator.getDiagnostics().activeTimerCount).toBe(0);
  });
});
