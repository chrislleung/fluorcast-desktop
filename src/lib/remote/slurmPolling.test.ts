import { beforeEach, describe, expect, it, vi } from "vitest";
import flatRemoteOutput from "../../../tests/fixtures/remote-output.flat-success.example.json";
import { defaultNibiSettings, type NibiSettings } from "../../features/settings";
import type { PersistedPredictionJob } from "../db";
import type { RemoteExecutor } from "./RemoteExecutor";
import {
  buildRemoteOutputExistsCommand,
  checkRemoteOutputExists,
  classifySqueueResult,
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

  it("classifies invalid squeue job id as active queue not found", () => {
    expect(classifySqueueResult(commandResult({
      exit_code: 1,
      stderr: "slurm_load_jobs error: Invalid job id specified",
    }), null)).toBe("active_job_not_found");
  });

  it("parses sacct output and prefers the parent job row", () => {
    expect(parseSacctOutput("12345.batch|COMPLETED|0:0\n12345|FAILED|1:0", "12345")).toEqual({
      jobId: "12345",
      state: "FAILED",
      exitCode: "1:0",
    });
  });

  it("maps Slurm states to app statuses", () => {
    expect(mapSlurmStateToJobStatus("PENDING")).toBe("queued");
    expect(mapSlurmStateToJobStatus("RUNNING")).toBe("running");
    expect(mapSlurmStateToJobStatus("COMPLETED", "0:0")).toBe("completed");
    expect(mapSlurmStateToJobStatus("CANCELLED")).toBe("cancelled");
    expect(mapSlurmStateToJobStatus("TIMEOUT")).toBe("timed_out");
    expect(mapSlurmStateToJobStatus("FAILED", "1:0")).toBe("failed");
    expect(mapSlurmStateToJobStatus("MYSTERY")).toBe("unknown");
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

    const result = await downloadPredictionOutput(
      job,
      settings,
      executor([], { onDownload: (remotePath, localPath) => downloads.push([remotePath, localPath]) }),
      persistence(),
    );

    expect(result).toMatchObject({ status: "output_invalid" });
    expect(result.technicalDetails).toContain("DOWNLOAD_FAILURE_CODE=49");
    expect(result.technicalDetails).toContain("JSON_SYNTAX_STATUS=invalid");
    expect(result.technicalDetails).not.toContain("JSON_PARSE_STATUS=invalid");

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
        return JSON.stringify({ ...flatRemoteOutput, job_id: "job-1" });
      }
      if (command === "prediction_output_file_modified_at") return "1780000000000";
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

  it("does not download when the remote output is not ready", async () => {
    const downloads: Array<[string, string]> = [];
    const result = await downloadPredictionOutput(
      job,
      settings,
      executor([commandResult({ exit_code: 1 })], {
        onDownload: (remotePath, localPath) => downloads.push([remotePath, localPath]),
      }),
      persistence(),
    );

    expect(result.status).toBe("output_missing");
    expect(result.technicalDetails).toContain("DOWNLOAD_FAILURE_CODE=46");
    expect(downloads).toEqual([]);
  });

  it("download failure preserves the Slurm ID and does not become Slurm unavailable", async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "prediction_output_temp_file_path") return "C:\\Temp\\fluorcast-job-1-output.json";
      return null;
    });
    const store = persistence();

    const result = await downloadPredictionOutput(
      { ...job, remote_slurm_id: "18217313" },
      settings,
      executor([], {
        onDownload: () => {
          throw new Error("DOWNLOAD_FAILURE_CODE=47\nSCP_EXIT_CODE=1\nSTDERR=scp failed");
        },
      }),
      store,
    );

    expect(result.status).toBe("download_failed");
    expect(result.slurmJobId).toBe("18217313");
    expect(result.appError?.code).toBe("download_failed");
    expect(result.message).toBe("Could not download remote output.json.");
    expect(result.technicalDetails).not.toContain("Slurm is unavailable");
    expect(store.updateJobStatus).toHaveBeenCalledWith("job-1", "download_failed", expect.objectContaining({
      errorMessage: expect.stringContaining("SCP_EXIT_CODE=1"),
    }));
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

  it("resumes monitoring existing Slurm job 18215500 with squeue then sacct", async () => {
    const commands: RemoteCommandSpec[] = [];
    const result = await pollSlurmJobStatus(
      {
        ...job,
        id: "83fa52c2-9f8d-4e89-a64f-eb8d69842b40",
        remote_slurm_id: "18215500",
        remote_job_dir: "/home/chrisl/scratch/fluorcast-jobs/83fa52c2-9f8d-4e89-a64f-eb8d69842b40",
      },
      settings,
      executor([
        commandResult({ stdout: "" }),
        commandResult({ stdout: "18215500|RUNNING|0:0" }),
      ], { onCommand: (command) => commands.push(command) }),
      persistence(),
    );

    expect(result.status).toBe("running");
    expect(commands[0]).toMatchObject({
      executable: "squeue",
      args: ["-j", "18215500", "--noheader", "--format=%i|%T|%M|%R"],
    });
    expect(commands[1]).toMatchObject({
      executable: "sacct",
      args: ["-j", "18215500", "--format=JobID,State,ExitCode,End", "--parsable2", "--noheader"],
    });
  });

  it("replaces connection failed with sacct running for an existing Slurm job", async () => {
    const store = persistence();
    const remoteJobDir = "/home/chrisl/scratch/fluorcast-jobs/connection-failed-running";

    const result = await pollSlurmJobStatus(
      {
        ...job,
        status: "connection_failed",
        remote_slurm_id: "18215501",
        remote_job_dir: remoteJobDir,
      },
      settings,
      executor([
        commandResult({ stdout: "" }),
        commandResult({ stdout: "18215501|RUNNING|0:0|" }),
      ]),
      store,
    );

    expect(result).toMatchObject({
      status: "running",
      slurmJobId: "18215501",
      slurmState: "RUNNING",
    });
    expect(store.updateJobStatus).toHaveBeenCalledWith("job-1", "running", expect.objectContaining({
      slurmState: "RUNNING",
      errorMessage: expect.any(String),
    }));
  });

  it("falls back to sacct when squeue reports invalid job id", async () => {
    const commands: RemoteCommandSpec[] = [];
    const result = await pollSlurmJobStatus(
      {
        ...job,
        status: "connection_failed",
        remote_slurm_id: "18234413",
      },
      settings,
      executor([
        commandResult({
          exit_code: 1,
          stderr: "slurm_load_jobs error: Invalid job id specified",
        }),
        commandResult({ stdout: "18234413|RUNNING|0:0|" }),
      ], { onCommand: (command) => commands.push(command) }),
      persistence(),
    );

    expect(result.status).toBe("running");
    expect(result.appError?.code).not.toBe("slurm_unavailable");
    expect(result.status).not.toBe("connection_failed");
    expect(commands.map((command) => command.executable)).toEqual(["squeue", "sacct"]);
    expect(commands[1].args).toEqual(["-j", "18234413", "--format=JobID,State,ExitCode,End", "--parsable2", "--noheader"]);
  });

  it("recovers completed historical jobs after invalid squeue job id", async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "prediction_output_temp_file_path") return "C:\\Temp\\fluorcast-18234413-output.json";
      if (command === "read_prediction_output_file") {
        return JSON.stringify({ ...flatRemoteOutput, job_id: "9063ef52-e2d0-48c5-a7e9-786be6042f78" });
      }
      if (command === "prediction_output_file_modified_at") return "1780000000000";
      return null;
    });
    const commands: RemoteCommandSpec[] = [];
    const downloads: Array<[string, string]> = [];
    const store = persistence();
    const remoteJobDir = "/home/alice/scratch/fluorcast-jobs/9063ef52-e2d0-48c5-a7e9-786be6042f78";

    const result = await pollSlurmJobStatus(
      {
        ...job,
        id: "9063ef52-e2d0-48c5-a7e9-786be6042f78",
        status: "connection_failed",
        remote_slurm_id: "18234413",
        remote_job_dir: remoteJobDir,
      },
      settings,
      executor([
        commandResult({
          exit_code: 1,
          stderr: "slurm_load_jobs error: Invalid job id specified",
        }),
        commandResult({ stdout: "18234413|COMPLETED|0:0|2026-07-22T11:22:03" }),
        commandResult({ exit_code: 0 }),
        commandResult({ stdout: "stdout text" }),
        commandResult({ stdout: "stderr text" }),
      ], {
        onCommand: (command) => commands.push(command),
        onDownload: (remotePath, localPath) => downloads.push([remotePath, localPath]),
      }),
      store,
    );

    expect(result).toMatchObject({
      status: "completed",
      slurmJobId: "18234413",
      slurmState: "COMPLETED",
      slurmExitCode: "0:0",
    });
    expect(commands.map((command) => command.executable)).toEqual(["squeue", "sacct", "test", "cat", "cat"]);
    expect(commands.some((command) => command.executable === "sbatch")).toBe(false);
    expect(downloads).toEqual([[`${remoteJobDir}/output.json`, "C:\\Temp\\fluorcast-18234413-output.json"]]);
    expect(store.updateJobStatus).toHaveBeenCalledWith(
      "9063ef52-e2d0-48c5-a7e9-786be6042f78",
      "completed",
      expect.objectContaining({
        errorMessage: undefined,
      }),
    );
  });

  it("maps sacct failed after invalid squeue job id to job failure", async () => {
    const result = await pollSlurmJobStatus(
      { ...job, status: "connection_failed", remote_slurm_id: "18234414" },
      settings,
      executor([
        commandResult({
          exit_code: 1,
          stderr: "slurm_load_jobs error: Invalid job id specified",
        }),
        commandResult({ stdout: "18234414|FAILED|1:0|" }),
        commandResult({ stdout: "stdout text" }),
        commandResult({ stdout: "stderr text" }),
      ]),
      persistence(),
    );

    expect(result.status).toBe("failed");
    expect(result.appError?.code).toBe("job_failed");
    expect(result.status).not.toBe("connection_failed");
  });

  it("keeps genuine squeue transport failures distinguishable", async () => {
    const result = await pollSlurmJobStatus(
      job,
      settings,
      executor([
        commandResult({
          exit_code: 255,
          stderr: "ssh: connect to host nibi.example port 22: Connection timed out",
        }),
      ]),
      persistence(),
    );

    expect(result.status).toBe("connection_failed");
    expect(result.appError?.code).toBe("ssh_connection_failed");
  });

  it("records squeue active-not-found and sacct fallback diagnostics", async () => {
    const events: Array<{ stage: string; fields?: Record<string, unknown> }> = [];
    await pollSlurmJobStatus(
      { ...job, status: "connection_failed", remote_slurm_id: "18234415" },
      settings,
      executor([
        commandResult({
          exit_code: 1,
          stderr: "slurm_load_jobs error: Invalid job id specified",
        }),
        commandResult({ stdout: "18234415|RUNNING|0:0|" }),
      ]),
      persistence(),
      {
        record: (stage, fields) => events.push({ stage, fields }),
        recordRowStatusWrite: () => undefined,
      },
    );

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: "SQUEUE_STARTED" }),
      expect.objectContaining({ stage: "SQUEUE_EXIT_CODE", fields: expect.objectContaining({ exitCode: 1 }) }),
      expect.objectContaining({ stage: "SQUEUE_CLASSIFICATION", fields: expect.objectContaining({ SQUEUE_CLASSIFICATION: "active_job_not_found" }) }),
      expect.objectContaining({ stage: "SACCT_FALLBACK_STARTED", fields: expect.objectContaining({ SACCT_FALLBACK_STARTED: 1 }) }),
      expect.objectContaining({ stage: "SACCT_PARENT_STATE", fields: expect.objectContaining({ state: "RUNNING" }) }),
    ]));
  });

  it("does not map result import errors after completed sacct fallback to connection failed", async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "prediction_output_temp_file_path") return "C:\\Temp\\fluorcast-invalid-output.json";
      if (command === "read_prediction_output_file") return "{not-json";
      if (command === "prediction_output_file_modified_at") return "1780000000000";
      return null;
    });

    const result = await pollSlurmJobStatus(
      { ...job, status: "connection_failed", remote_slurm_id: "18234416" },
      settings,
      executor([
        commandResult({
          exit_code: 1,
          stderr: "slurm_load_jobs error: Invalid job id specified",
        }),
        commandResult({ stdout: "18234416|COMPLETED|0:0|" }),
        commandResult({ exit_code: 0 }),
        commandResult({ stdout: "stdout text" }),
        commandResult({ stdout: "stderr text" }),
      ]),
      persistence(),
    );

    expect(result.status).toBe("output_invalid");
    expect(result.appError?.code).toBe("output_invalid");
    expect(result.status).not.toBe("connection_failed");
  });

  it("retrieves stdout stderr and output from the existing remote directory", async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "prediction_output_temp_file_path") return "C:\\Temp\\fluorcast-83-output.json";
      if (command === "read_prediction_output_file") {
        return JSON.stringify({ ...flatRemoteOutput, job_id: "83fa52c2-9f8d-4e89-a64f-eb8d69842b40" });
      }
      if (command === "prediction_output_file_modified_at") return "1780000000000";
      return null;
    });
    const commands: RemoteCommandSpec[] = [];
    const downloads: Array<[string, string]> = [];
    const remoteJobDir = "/home/chrisl/scratch/fluorcast-jobs/83fa52c2-9f8d-4e89-a64f-eb8d69842b40";

    const result = await pollSlurmJobStatus(
      {
        ...job,
        id: "83fa52c2-9f8d-4e89-a64f-eb8d69842b40",
        remote_slurm_id: "18215500",
        remote_job_dir: remoteJobDir,
      },
      settings,
      executor([
        commandResult({ stdout: "" }),
        commandResult({ stdout: "18215500|COMPLETED|0:0" }),
        commandResult({ exit_code: 0 }),
        commandResult({ stdout: "stdout text" }),
        commandResult({ stdout: "stderr text" }),
      ], {
        onCommand: (command) => commands.push(command),
        onDownload: (remotePath, localPath) => downloads.push([remotePath, localPath]),
      }),
      persistence(),
    );

    expect(result.status).toBe("completed");
    expect(commands).toEqual(expect.arrayContaining([
      expect.objectContaining({ executable: "cat", args: [`${remoteJobDir}/stdout.log`] }),
      expect.objectContaining({ executable: "cat", args: [`${remoteJobDir}/stderr.log`] }),
    ]));
    expect(downloads).toEqual([[`${remoteJobDir}/output.json`, "C:\\Temp\\fluorcast-83-output.json"]]);
  });

  it("recovers existing completed job 18231560 from sacct End and output.json without sbatch", async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "prediction_output_temp_file_path") {
        return "C:\\Temp\\fluorcast-fa4-output.json";
      }
      if (command === "read_prediction_output_file") {
        return JSON.stringify({ ...flatRemoteOutput, job_id: "fa4a0a65-32c6-4516-9e3c-c60954d9be2e" });
      }
      if (command === "prediction_output_file_modified_at") return "1780000000000";
      return null;
    });
    const commands: RemoteCommandSpec[] = [];
    const downloads: Array<[string, string]> = [];
    const store = persistence();
    const remoteJobDir = "/home/chrisl/scratch/fluorcast-jobs/fa4a0a65-32c6-4516-9e3c-c60954d9be2e";

    const result = await pollSlurmJobStatus(
      {
        ...job,
        id: "fa4a0a65-32c6-4516-9e3c-c60954d9be2e",
        status: "connection_failed",
        remote_slurm_id: "18231560",
        remote_job_dir: remoteJobDir,
        remote_output_path: `${remoteJobDir}/output.json`,
      },
      settings,
      executor([
        commandResult({ stdout: "", stderr: "Master running (pid=1234)" }),
        commandResult({ stdout: "18231560|COMPLETED|0:0|2026-07-22T11:22:03" }),
        commandResult({ exit_code: 0 }),
        commandResult({ stdout: "stdout text" }),
        commandResult({ stdout: "stderr text" }),
      ], {
        onCommand: (command) => commands.push(command),
        onDownload: (remotePath, localPath) => downloads.push([remotePath, localPath]),
      }),
      store,
    );

    expect(result).toMatchObject({
      status: "completed",
      slurmJobId: "18231560",
      slurmState: "COMPLETED",
      slurmExitCode: "0:0",
    });
    expect(commands.map((command) => command.executable)).toEqual([
      "squeue",
      "sacct",
      "test",
      "cat",
      "cat",
    ]);
    expect(commands.some((command) => command.executable === "sbatch")).toBe(false);
    expect(downloads).toEqual([[`${remoteJobDir}/output.json`, "C:\\Temp\\fluorcast-fa4-output.json"]]);
    expect(store.saveResult).toHaveBeenCalledTimes(1);
    expect(store.saveResult).toHaveBeenCalledWith(
      "fa4a0a65-32c6-4516-9e3c-c60954d9be2e",
      expect.objectContaining({
        job_id: "fa4a0a65-32c6-4516-9e3c-c60954d9be2e",
        status: "succeeded",
        completed_at_source: "sacct",
      }),
      expect.any(String),
    );
  });

  it("does not fail a successful command only because stderr contains Master running", async () => {
    const result = await pollSlurmJobStatus(
      job,
      settings,
      executor([
        commandResult({
          stdout: "12345|RUNNING|00:01:00|node-a",
          stderr: "Master running (pid=1234)",
        }),
      ]),
      persistence(),
    );

    expect(result.status).toBe("running");
    expect(result.message).toBe("Slurm job 12345 is RUNNING.");
  });

  it("does not classify sacct exit 0 with no parent row as a connection failure", async () => {
    const store = persistence();
    const result = await pollSlurmJobStatus(
      job,
      settings,
      executor([
        commandResult({ stdout: "" }),
        commandResult({ stdout: "" }),
      ]),
      store,
    );

    expect(result.status).toBe("output_missing");
    expect(result.appError?.code).toBe("output_missing");
    expect(result.technicalDetails).toContain("SACCT_EXIT=0");
    expect(result.technicalDetails).toContain("SACCT_PARENT_STATE=");
    expect(store.updateJobStatus).toHaveBeenCalledWith("job-1", "output_missing", expect.any(Object));
  });

  it("retries a completed job using its persisted remote output path", async () => {
    let readAttempts = 0;
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "prediction_output_temp_file_path") return "C:\\Temp\\fluorcast-7d-output.json";
      if (command === "read_prediction_output_file") {
        readAttempts += 1;
        if (readAttempts === 1) {
          throw new Error("Could not read downloaded output.json: not found");
        }
        return JSON.stringify({ ...flatRemoteOutput, job_id: "7d676c1e-2a98-4f38-8ba7-5858182b6ade" });
      }
      if (command === "prediction_output_file_modified_at") return "1780000000000";
      return null;
    });
    const commands: RemoteCommandSpec[] = [];
    const downloads: Array<[string, string]> = [];

    const result = await pollSlurmJobStatus(
      {
        ...job,
        id: "7d676c1e-2a98-4f38-8ba7-5858182b6ade",
        status: "download_failed",
        remote_slurm_id: "18217313",
        remote_job_dir: "/home/chrisl/scratch/fluorcast-jobs/7d676c1e-2a98-4f38-8ba7-5858182b6ade",
        remote_output_path: "/home/chrisl/scratch/fluorcast-jobs/7d676c1e-2a98-4f38-8ba7-5858182b6ade/output.json",
      },
      settings,
      executor([
        commandResult({ stdout: "" }),
        commandResult({ stdout: "18217313|COMPLETED|0:0" }),
        commandResult({ exit_code: 0 }),
        commandResult({ exit_code: 0 }),
        commandResult({ stdout: "stdout text" }),
        commandResult({ stdout: "stderr text" }),
      ], {
        onCommand: (command) => commands.push(command),
        onDownload: (remotePath, localPath) => downloads.push([remotePath, localPath]),
      }),
      persistence(),
    );

    expect(result.status).toBe("completed");
    expect(commands.some((command) => command.executable === "sbatch")).toBe(false);
    expect(downloads).toEqual([[
      "/home/chrisl/scratch/fluorcast-jobs/7d676c1e-2a98-4f38-8ba7-5858182b6ade/output.json",
      "C:\\Temp\\fluorcast-7d-output.json",
    ]]);
  });

  it("imports existing downloaded flat output without resubmitting or redownloading", async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "prediction_output_temp_file_path") {
        return "C:\\Users\\CL\\AppData\\Local\\Temp\\fluorcast-2e80b1b9-f65f-426a-a289-1466ab7f0abd-output.json";
      }
      if (command === "read_prediction_output_file") return JSON.stringify(flatRemoteOutput);
      if (command === "prediction_output_file_modified_at") return "1780000000000";
      return null;
    });
    const commands: RemoteCommandSpec[] = [];
    const downloads: Array<[string, string]> = [];
    const store = persistence();

    const result = await downloadPredictionOutput(
      {
        ...job,
        id: "2e80b1b9-f65f-426a-a289-1466ab7f0abd",
        status: "output_invalid",
        remote_slurm_id: "18226108",
        remote_job_dir: "/home/chrisl/scratch/fluorcast-jobs/2e80b1b9-f65f-426a-a289-1466ab7f0abd",
        remote_output_path: "/home/chrisl/scratch/fluorcast-jobs/2e80b1b9-f65f-426a-a289-1466ab7f0abd/output.json",
      },
      settings,
      executor([], {
        onCommand: (command) => commands.push(command),
        onDownload: (remotePath, localPath) => downloads.push([remotePath, localPath]),
      }),
      store,
    );

    expect(result).toMatchObject({
      status: "completed",
      slurmJobId: "18226108",
      output: expect.objectContaining({
        job_id: "2e80b1b9-f65f-426a-a289-1466ab7f0abd",
        status: "succeeded",
      }),
    });
    expect(commands.some((command) => command.executable === "sbatch")).toBe(false);
    expect(downloads).toEqual([]);
    expect(store.saveResult).toHaveBeenCalledTimes(1);
    expect(store.updateJobStatus).toHaveBeenCalledWith(
      "2e80b1b9-f65f-426a-a289-1466ab7f0abd",
      "completed",
      expect.objectContaining({ errorMessage: undefined }),
    );
  });

  it("preserves completed scheduler state when output download fails", async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "prediction_output_temp_file_path") return "C:\\Temp\\fluorcast-7d-output.json";
      return null;
    });
    const commands: RemoteCommandSpec[] = [];
    const store = persistence();

    const result = await pollSlurmJobStatus(
      {
        ...job,
        id: "7d676c1e-2a98-4f38-8ba7-5858182b6ade",
        status: "download_failed",
        remote_slurm_id: "18217313",
        remote_job_dir: "/home/chrisl/scratch/fluorcast-jobs/7d676c1e-2a98-4f38-8ba7-5858182b6ade",
        remote_output_path: "/home/chrisl/scratch/fluorcast-jobs/7d676c1e-2a98-4f38-8ba7-5858182b6ade/output.json",
      },
      settings,
      executor([
        commandResult({ stdout: "" }),
        commandResult({ stdout: "18217313|COMPLETED|0:0" }),
        commandResult({ exit_code: 0 }),
        commandResult({ exit_code: 0 }),
        commandResult({ stdout: "stdout text" }),
        commandResult({ stdout: "stderr text" }),
      ], {
        onCommand: (command) => commands.push(command),
        onDownload: () => {
          throw new Error("DOWNLOAD_FAILURE_CODE=47\nSCP_EXIT_CODE=1");
        },
      }),
      store,
    );

    expect(result.status).toBe("download_failed");
    expect(result.slurmJobId).toBe("18217313");
    expect(result.slurmState).toBe("COMPLETED");
    expect(commands.some((command) => command.executable === "sbatch")).toBe(false);
    expect(store.updateJobStatus).toHaveBeenCalledWith(
      "7d676c1e-2a98-4f38-8ba7-5858182b6ade",
      "download_failed",
      expect.objectContaining({
        slurmState: "COMPLETED",
        slurmExitCode: "0:0",
      }),
    );
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
