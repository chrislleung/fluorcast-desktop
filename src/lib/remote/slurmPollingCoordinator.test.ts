import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PersistedPredictionJob } from "../db";
import type { RemoteExecutor } from "./RemoteExecutor";
import {
  getNextSlurmPollDelayMs,
  SLURM_POLL_INTERVALS_MS,
  SlurmPollingCoordinator,
  type SlurmPollingCoordinatorOptions,
} from "./slurmPollingCoordinator";
import type { SlurmPollingResult } from "./slurmPolling";

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
    await expect(Promise.all([first, second, third])).resolves.toEqual([resolved, resolved, resolved]);
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
