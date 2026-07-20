import { invoke } from "@tauri-apps/api/core";
import type { NibiSettings } from "../../features/settings";
import { trimNibiSettings } from "../../features/settings";
import { createMockDuplicateCheckOutput } from "../mock";
import {
  validateDuplicateCheckOutput,
  type DuplicateCheckInput,
  type DuplicateCheckOutput,
} from "../schemas";
import type { RemoteExecutor } from "./RemoteExecutor";
import { appError, classifyRemoteCommandFailure } from "./errors";
import { parseSacctOutput, parseSqueueOutput, mapSlurmStateToJobStatus } from "./slurmPolling";
import { RemoteExecutionError } from "./types";
import { joinRemoteChildPath, joinRemoteJobPath } from "./uploadPredictionInput";

export type DuplicateCheckStatus =
  | "idle"
  | "uploading"
  | "submitted_to_slurm"
  | "running"
  | "completed"
  | "login_required"
  | "robot_auth_failed"
  | "failed";

export type DuplicateCheckResult = {
  status: DuplicateCheckStatus;
  message: string;
  remoteJobDir?: string;
  slurmJobId?: string;
  output?: DuplicateCheckOutput;
  technicalDetails?: string;
};

export type DuplicateCheckOptions = {
  maxPollAttempts?: number;
  pollIntervalMs?: number;
  onStatusChange?: (result: DuplicateCheckResult) => void | Promise<void>;
};

const DEFAULT_POLL_ATTEMPTS = 30;
const DEFAULT_POLL_INTERVAL_MS = 2000;
const remotePathUnsafePattern = /[\0\r\n;&|`$<>]/;

function wait(delayMs: number) {
  return new Promise((resolve) => window.setTimeout(resolve, delayMs));
}

function normalizeAbsoluteRemotePath(path: string, label: string) {
  const normalized = path.trim().replace(/\/+/g, "/").replace(/\/$/, "");
  if (!normalized.startsWith("/")) {
    throw new RemoteExecutionError(`${label} must be an absolute remote path.`, "unsafe_remote_path");
  }
  if (remotePathUnsafePattern.test(normalized) || normalized.split("/").includes("..")) {
    throw new RemoteExecutionError(`${label} contains unsupported path characters.`, "unsafe_remote_path");
  }
  return normalized;
}

function joinRemoteProjectChildPath(remoteProjectPath: string, childPath: string) {
  return `${normalizeAbsoluteRemotePath(remoteProjectPath, "Remote project path")}/${childPath}`;
}

function parseSbatchJobId(stdout: string) {
  const match = stdout.match(/\b(\d+)\b/);
  if (!match) {
    throw new RemoteExecutionError("Slurm did not return a job ID.", "slurm_submit_failed");
  }
  return match[1];
}

async function writeTemporaryDuplicateCheckInputFile(input: DuplicateCheckInput): Promise<string> {
  return invoke<string>("write_prediction_input_temp_file", {
    jobId: input.job_id,
    inputJson: JSON.stringify(input, null, 2),
  });
}

async function localDuplicateCheckOutputPath(jobId: string) {
  return invoke<string>("prediction_output_temp_file_path", { jobId });
}

async function emitStatus(
  options: DuplicateCheckOptions | undefined,
  result: DuplicateCheckResult,
) {
  await options?.onStatusChange?.(result);
}

function ensureExecutorReady(settings: NibiSettings, remoteExecutor: RemoteExecutor) {
  const connectionStatus = remoteExecutor.getConnectionStatus(settings);
  if (remoteExecutor.getMode() === "interactive_mfa" && connectionStatus.state !== "authenticated") {
    const error = appError(
      connectionStatus.state === "ready_for_manual_login" ? "interactive_session_expired" : "interactive_login_required",
      connectionStatus.message,
    );
    throw new RemoteExecutionError(
      error.message,
      "manual_session_not_authenticated",
      connectionStatus,
    );
  }
  if (remoteExecutor.getMode() === "robot_automation" && connectionStatus.state !== "robot_automation_ready") {
    const error = appError("robot_access_not_ready", connectionStatus.message);
    throw new RemoteExecutionError(
      error.message,
      "robot_access_not_verified",
      connectionStatus,
    );
  }
}

async function downloadDuplicateCheckOutput(
  input: DuplicateCheckInput,
  settings: NibiSettings,
  remoteExecutor: RemoteExecutor,
  remoteOutputPath: string,
) {
  const localPath = await localDuplicateCheckOutputPath(input.job_id);
  await remoteExecutor.downloadFile(remoteOutputPath, localPath, settings);
  const outputJson = await invoke<string>("read_prediction_output_file", { localPath });
  return validateDuplicateCheckOutput(JSON.parse(outputJson));
}

export async function runDuplicateCheck(
  input: DuplicateCheckInput,
  settings: NibiSettings,
  remoteExecutor: RemoteExecutor,
  options: DuplicateCheckOptions = {},
): Promise<DuplicateCheckResult> {
  if (remoteExecutor.getMode() === "mock") {
    const output = createMockDuplicateCheckOutput(input);
    const result: DuplicateCheckResult = {
      status: "completed",
      message: "Mock training-data match check completed.",
      output,
    };
    await emitStatus(options, result);
    return result;
  }

  const trimmed = trimNibiSettings(settings);
  try {
    ensureExecutorReady(trimmed, remoteExecutor);
  } catch (error) {
    if (error instanceof RemoteExecutionError && error.code === "manual_session_not_authenticated") {
      const result = { status: "login_required", message: error.message } as const;
      await emitStatus(options, result);
      return result;
    }
    if (error instanceof RemoteExecutionError && error.code === "robot_access_not_verified") {
      const result = { status: "robot_auth_failed", message: error.message } as const;
      await emitStatus(options, result);
      return result;
    }
    throw error;
  }

  const remoteJobDir = joinRemoteJobPath(trimmed.remote_jobs_path, input.job_id);
  const remoteInputPath = joinRemoteChildPath(remoteJobDir, "input.json");
  const remoteOutputPath = joinRemoteChildPath(remoteJobDir, "output.json");
  const localInputPath = await writeTemporaryDuplicateCheckInputFile(input);

  await emitStatus(options, {
    status: "uploading",
    message: "Uploading duplicate-check input.json.",
    remoteJobDir,
  });

  const mkdir = await remoteExecutor.runCommand({
    label: "Create remote duplicate-check job directory",
    executable: "mkdir",
    args: ["-p", remoteJobDir],
    settings: trimmed,
    redacted_preview: "mkdir -p <remote_job_dir>",
  });
  if (mkdir.exit_code !== 0) {
    const error = classifyRemoteCommandFailure(mkdir, "ssh");
    throw new RemoteExecutionError(error.message, error.code);
  }

  await remoteExecutor.uploadFile(localInputPath, remoteInputPath, trimmed);
  const sbatch = await remoteExecutor.runCommand({
    label: "Submit duplicate-check Slurm job",
    executable: "sbatch",
    args: [
      joinRemoteProjectChildPath(trimmed.remote_project_path, "slurm/run_duplicate_check_job.sbatch"),
      remoteJobDir,
    ],
    settings: trimmed,
    redacted_preview: "sbatch <remote_project>/slurm/run_duplicate_check_job.sbatch <remote_job_dir>",
  });
  if (sbatch.exit_code !== 0) {
    const error = classifyRemoteCommandFailure(sbatch, "sbatch");
    throw new RemoteExecutionError(error.message, error.code);
  }
  const slurmJobId = parseSbatchJobId(sbatch.stdout);
  await emitStatus(options, {
    status: "submitted_to_slurm",
    message: `Duplicate-check Slurm job ${slurmJobId} submitted.`,
    remoteJobDir,
    slurmJobId,
  });

  const maxPollAttempts = options.maxPollAttempts ?? DEFAULT_POLL_ATTEMPTS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  for (let attempt = 0; attempt < maxPollAttempts; attempt += 1) {
    if (attempt > 0) {
      await wait(pollIntervalMs);
    }

    const squeue = await remoteExecutor.runCommand({
      label: "Poll active duplicate-check Slurm job",
      executable: "squeue",
      args: ["-j", slurmJobId, "--noheader", "--format=%i|%T|%M|%R"],
      settings: trimmed,
      redacted_preview: "squeue -j <job_id> --noheader --format=\"%i|%T|%M|%R\"",
    });
    const activeRow = squeue.exit_code === 0 ? parseSqueueOutput(squeue.stdout) : null;
    if (activeRow) {
      const status = mapSlurmStateToJobStatus(activeRow.state);
      await emitStatus(options, {
        status: status === "running" ? "running" : "submitted_to_slurm",
        message: `Duplicate-check Slurm job ${activeRow.jobId} is ${activeRow.state}.`,
        remoteJobDir,
        slurmJobId,
      });
      continue;
    }

    const sacct = await remoteExecutor.runCommand({
      label: "Poll completed duplicate-check Slurm job",
      executable: "sacct",
      args: ["-j", slurmJobId, "--format=JobID,State,ExitCode", "--parsable2", "--noheader"],
      settings: trimmed,
      redacted_preview: "sacct -j <job_id> --format=JobID,State,ExitCode --parsable2 --noheader",
    });
    const sacctRow = sacct.exit_code === 0 ? parseSacctOutput(sacct.stdout, slurmJobId) : null;
    const slurmStatus = sacctRow ? mapSlurmStateToJobStatus(sacctRow.state, sacctRow.exitCode) : null;

    if (slurmStatus === "completed") {
      const output = await downloadDuplicateCheckOutput(input, trimmed, remoteExecutor, remoteOutputPath);
      const result: DuplicateCheckResult = {
        status: "completed",
        message: "Training-data match check completed.",
        remoteJobDir,
        slurmJobId,
        output,
      };
      await emitStatus(options, result);
      return result;
    }
    if (slurmStatus && !["submitted_to_slurm", "running"].includes(slurmStatus)) {
      const result: DuplicateCheckResult = {
        status: "failed",
        message: `Duplicate-check Slurm job ${slurmJobId} ended with state ${sacctRow?.state}.`,
        remoteJobDir,
        slurmJobId,
        technicalDetails: sacctRow?.exitCode,
      };
      await emitStatus(options, result);
      return result;
    }
  }

  const result: DuplicateCheckResult = {
    status: "failed",
    message: "Duplicate-check Slurm job did not complete before polling timed out.",
    remoteJobDir,
    slurmJobId,
  };
  await emitStatus(options, result);
  return result;
}

export function duplicateCheckMatchSummary(output: DuplicateCheckOutput): string {
  if (output.error) return output.error;
  if (output.exact_solvent_pair_match) return "Exact molecule-solvent pair found in training data.";
  if (output.exact_molecule_match) return "Exact molecule found in training data with a different solvent.";
  if (output.scaffold_match) return "Related scaffold found in training data.";
  return "No exact training-data match found.";
}
