import { beforeEach, describe, expect, it, vi } from "vitest";
import validOutput from "../../../tests/fixtures/prediction-output.success.example.json";
import { defaultNibiSettings, type NibiSettings } from "../../features/settings";
import type { PersistedPredictionJob } from "../db";
import type { PredictionJobOutput } from "../schemas";
import type { RemoteExecutor } from "./RemoteExecutor";
import {
  buildRemoteOutputExistsCommand,
  checkRemoteOutputExists,
  downloadPredictionOutput,
  mapSlurmStateToJobStatus,
  parseSacctOutput,
  parseSqueueOutput,
  pollSlurmJobStatus,
  type SlurmPollingPersistence,
} from "./slurmPolling";
import type { RemoteCommandResult, RemoteCommandSpec, RemoteConnectionMode } from "./types";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

const settings: NibiSettings = {
  ...defaultNibiSettings,
  backend_mode: "nibi",
  connection_mode: "interactive_mfa",
  nibi_username: "alice",
  manual_login_verified: true,
};

const job: PersistedPredictionJob = {
  id: "job-1",
  molecule_smiles: "CCO",
  solvent_smiles: "O",
  model_choice: "rf",
  status: "running",
  created_at: "2026-07-03T14:30:00.000Z",
  remote_slurm_id: "12345",
  remote_job_dir: "/home/alice/scratch/fluorcast-jobs/job-1",
};

function commandResult(partial: Partial<RemoteCommandResult>): RemoteCommandResult {
  return {
    exit_code: 0,
    stdout: "",
    stderr: "",
    duration_ms: 1,
    command_label: "test",
    redacted_command_preview: "test",
    ...partial,
  };
}

function executor(
  commandResults: RemoteCommandResult[],
  options: {
    mode?: RemoteConnectionMode;
    authenticated?: boolean;
    onCommand?: (command: RemoteCommandSpec) => void;
    onDownload?: (remotePath: string, localPath: string) => void;
  } = {},
): RemoteExecutor {
  const commands = [...commandResults];
  return {
    getMode: () => options.mode ?? "interactive_mfa",
    getConnectionStatus: () => ({
      mode: options.mode ?? "interactive_mfa",
      state: options.authenticated === false
        ? options.mode === "robot_automation" ? "failed" : "ready_for_manual_login"
        : options.mode === "robot_automation" ? "robot_automation_ready" : "authenticated",
      label: "Test",
      message: "Test connection state",
    }),
    validateLocalConfig: () => ({}),
    testConnection: async () => ({
      mode: options.mode ?? "interactive_mfa",
      state: "authenticated",
      label: "Test",
      message: "Test",
    }),
    runCommand: async (command) => {
      options.onCommand?.(command);
      return commands.shift() ?? commandResult({});
    },
    uploadFile: async () => undefined,
    downloadFile: async (remotePath, localPath) => {
      options.onDownload?.(remotePath, localPath);
    },
    dispose: () => undefined,
  };
}

function persistence(calls: string[] = []): SlurmPollingPersistence {
  return {
    updateJobStatus: vi.fn(async (_jobId, status) => {
      calls.push(`status:${status}`);
      return true;
    }),
    saveResult: vi.fn(async () => {
      calls.push("saveResult");
      return true;
    }),
    addJobEvent: vi.fn(async () => true),
  };
}

describe("Slurm polling helpers", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("parses squeue output", () => {
    expect(parseSqueueOutput("12345|RUNNING|00:02:13|node-a\n")).toEqual({
      jobId: "12345",
      state: "RUNNING",
      elapsed: "00:02:13",
      reason: "node-a",
    });
  });

  it("parses sacct output and prefers the parent job row", () => {
    expect(parseSacctOutput("12345.batch|COMPLETED|0:0\n12345|FAILED|1:0", "12345")).toEqual({
      jobId: "12345",
      state: "FAILED",
      exitCode: "1:0",
    });
  });

  it("maps Slurm states to app statuses", () => {
    expect(mapSlurmStateToJobStatus("PENDING")).toBe("submitted_to_slurm");
    expect(mapSlurmStateToJobStatus("RUNNING")).toBe("running");
    expect(mapSlurmStateToJobStatus("COMPLETED", "0:0")).toBe("completed");
    expect(mapSlurmStateToJobStatus("CANCELLED")).toBe("cancelled");
    expect(mapSlurmStateToJobStatus("TIMEOUT")).toBe("timeout");
    expect(mapSlurmStateToJobStatus("FAILED", "1:0")).toBe("failed");
  });

  it("generates the remote output exists command", () => {
    expect(buildRemoteOutputExistsCommand(job)).toMatchObject({
      executable: "test",
      args: ["-f", "/home/alice/scratch/fluorcast-jobs/job-1/output.json"],
    });
  });

  it("checks output existence through the selected executor", async () => {
    const commands: RemoteCommandSpec[] = [];
    await expect(checkRemoteOutputExists(
      job,
      settings,
      executor([commandResult({ exit_code: 0 })], { onCommand: (command) => commands.push(command) }),
    )).resolves.toBe(true);

    expect(commands[0]).toMatchObject({
      executable: "test",
      args: ["-f", "/home/alice/scratch/fluorcast-jobs/job-1/output.json"],
    });
  });

  it("handles output download path and validates invalid JSON", async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "prediction_output_temp_file_path") return "C:\\Temp\\fluorcast-job-1-output.json";
      if (command === "read_prediction_output_file") return "{not-json";
      return null;
    });
    const downloads: Array<[string, string]> = [];

    await expect(downloadPredictionOutput(
      job,
      settings,
      executor([], { onDownload: (remotePath, localPath) => downloads.push([remotePath, localPath]) }),
      persistence(),
    )).resolves.toMatchObject({ status: "output_invalid" });

    expect(downloads).toEqual([[
      "/home/alice/scratch/fluorcast-jobs/job-1/output.json",
      "C:\\Temp\\fluorcast-job-1-output.json",
    ]]);
  });

  it("saves a completed result before marking the job completed", async () => {
    const calls: string[] = [];
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "prediction_output_temp_file_path") return "C:\\Temp\\fluorcast-job-1-output.json";
      if (command === "read_prediction_output_file") {
        return JSON.stringify({ ...(validOutput as PredictionJobOutput), job_id: "job-1" });
      }
      return null;
    });

    await expect(downloadPredictionOutput(
      job,
      settings,
      executor([]),
      persistence(calls),
    )).resolves.toMatchObject({ status: "completed" });

    expect(calls.slice(0, 2)).toEqual(["saveResult", "status:completed"]);
  });

  it("allows login_required jobs to recover after re-authentication", async () => {
    const first = await pollSlurmJobStatus(
      job,
      settings,
      executor([], { authenticated: false }),
      persistence(),
    );
    expect(first.status).toBe("login_required");
    expect(first.appError?.code).toBe("interactive_session_expired");
    expect(first.message).toBe("Your NIBI login session expired. Reconnect to NIBI, then refresh this job.");

    const second = await pollSlurmJobStatus(
      { ...job, status: "login_required" },
      settings,
      executor([commandResult({ stdout: "12345|RUNNING|00:01:00|node-a" })], { authenticated: true }),
      persistence(),
    );
    expect(second.status).toBe("running");
  });

  it("maps robot allowed_commands rejection and redacts details", async () => {
    const result = await pollSlurmJobStatus(
      job,
      { ...settings, connection_mode: "robot_automation", robot_access_verified: true },
      executor([
        commandResult({
          exit_code: 1,
          stderr: "allowed_commands.sh: command not allowed\nDuo verification prompt",
        }),
      ], { mode: "robot_automation" }),
      persistence(),
    );

    expect(result.status).toBe("connection_failed");
    expect(result.appError?.code).toBe("remote_command_not_allowed");
    expect(result.message).toBe("The robot node rejected this command. The command may not be allowed by allowed_commands.sh.");
    expect(result.technicalDetails).not.toMatch(/duo|verification/i);
  });

  it("polling uses the selected executor", async () => {
    const commands: RemoteCommandSpec[] = [];
    await pollSlurmJobStatus(
      job,
      settings,
      executor([commandResult({ stdout: "12345|PENDING|00:00:00|Priority" })], {
        mode: "robot_automation",
        onCommand: (command) => commands.push(command),
      }),
      persistence(),
    );

    expect(commands).toHaveLength(1);
    expect(commands[0].executable).toBe("squeue");
    expect(commands[0].settings).toMatchObject({ connection_mode: "interactive_mfa" });
  });

  it("preserves per-job stderr when a Slurm job fails", async () => {
    const store = persistence();
    const result = await pollSlurmJobStatus(
      {
        ...job,
        submitted_command: "sbatch --parsable --chdir=<remote_project> ...",
      },
      settings,
      executor([
        commandResult({ stdout: "" }),
        commandResult({ stdout: "12345|FAILED|1:0" }),
        commandResult({ stdout: "starting job\n" }),
        commandResult({ stdout: "FLUORCAST_INPUT_JSON must point to the input JSON\n" }),
      ]),
      store,
    );

    expect(result.status).toBe("failed");
    expect(result.technicalDetails).toContain("Slurm State: FAILED");
    expect(result.technicalDetails).toContain("stderr.log");
    expect(result.technicalDetails).toContain("FLUORCAST_INPUT_JSON");
    expect(store.updateJobStatus).toHaveBeenCalledWith("job-1", "failed", expect.objectContaining({
      slurmState: "FAILED",
      slurmExitCode: "1:0",
      slurmStdout: "starting job\n",
      slurmStderr: "FLUORCAST_INPUT_JSON must point to the input JSON\n",
      errorMessage: expect.stringContaining("stderr.log"),
    }));
  });
});
