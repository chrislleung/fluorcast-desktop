import { invoke } from "@tauri-apps/api/core";
import type { NibiSettings } from "../../features/settings";
import { trimNibiSettings } from "../../features/settings";
import type { PersistedPredictionJob } from "../db";
import { addJobEvent, saveResult, updateJobStatus } from "../db";
import { validatePredictionJobOutput, type PredictionJobOutput } from "../schemas";
import type { RemoteExecutor } from "./RemoteExecutor";
import {
  appError,
  classifyRemoteCommandFailure,
  type AppError,
} from "./errors";
import { joinRemoteChildPath } from "./uploadPredictionInput";

export type SlurmPollingStatus =
  | "submitted_to_slurm"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "timeout"
  | "login_required"
  | "robot_auth_failed"
  | "connection_failed"
  | "output_missing"
  | "output_invalid"
  | "download_failed";

export type SlurmPollingResult = {
  jobId: string;
  slurmJobId?: string;
  status: SlurmPollingStatus;
  message: string;
  technicalDetails?: string;
  appError?: AppError;
  slurmState?: string;
  output?: PredictionJobOutput;
};

export type SlurmPollingPersistence = {
  updateJobStatus: typeof updateJobStatus;
  saveResult: typeof saveResult;
  addJobEvent: typeof addJobEvent;
};

type SqueueRow = {
  jobId: string;
  state: string;
  elapsed: string;
  reason: string;
};

type SacctRow = {
  jobId: string;
  state: string;
  exitCode: string;
};

const defaultPersistence: SlurmPollingPersistence = {
  updateJobStatus,
  saveResult,
  addJobEvent,
};

function activeStatus(status: SlurmPollingStatus) {
  return status === "submitted_to_slurm" || status === "running";
}

function connectionFailureStatus(settings: NibiSettings, remoteExecutor: RemoteExecutor): SlurmPollingResult | null {
  const status = remoteExecutor.getConnectionStatus(settings);
  if (remoteExecutor.getMode() === "interactive_mfa" && status.state !== "authenticated") {
    const error = appError(
      status.state === "ready_for_manual_login" ? "interactive_session_expired" : "interactive_login_required",
      status.message,
    );
    return {
      jobId: "",
      status: "login_required",
      message: error.message,
      technicalDetails: error.technicalDetails,
      appError: error,
    };
  }
  if (remoteExecutor.getMode() === "robot_automation" && status.state !== "robot_automation_ready") {
    const error = appError("robot_access_not_ready", status.message);
    return {
      jobId: "",
      status: "robot_auth_failed",
      message: error.message,
      technicalDetails: error.technicalDetails,
      appError: error,
    };
  }
  return null;
}

function remoteOutputPath(job: PersistedPredictionJob) {
  if (!job.remote_job_dir) {
    throw new Error("Remote job directory is missing.");
  }
  return joinRemoteChildPath(job.remote_job_dir, "output.json");
}

function remoteJobChildPath(job: PersistedPredictionJob, filename: "stdout.log" | "stderr.log") {
  if (!job.remote_job_dir) {
    throw new Error("Remote job directory is missing.");
  }
  return joinRemoteChildPath(job.remote_job_dir, filename);
}

function localOutputPath(jobId: string) {
  return invoke<string>("prediction_output_temp_file_path", { jobId });
}

function commandText(result: { stdout: string; stderr: string }) {
  return [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
}

function isSacctUnavailable(result: { exit_code: number; stdout: string; stderr: string }) {
  const text = commandText(result).toLowerCase();
  return result.exit_code !== 0 && (
    text.includes("allowed_commands")
    || text.includes("not allowed")
    || text.includes("permission denied")
    || text.includes("command not found")
    || text.includes("no such file")
  );
}

function mapSlurmState(state: string, exitCode?: string): SlurmPollingStatus {
  const normalized = state.trim().toUpperCase().split(/\s+/)[0];
  if (["PENDING", "CONFIGURING", "REQUEUED", "RESIZING", "SUSPENDED"].includes(normalized)) {
    return "submitted_to_slurm";
  }
  if (["RUNNING", "COMPLETING", "STAGE_OUT"].includes(normalized)) {
    return "running";
  }
  if (normalized === "COMPLETED" && (!exitCode || exitCode.startsWith("0:"))) {
    return "completed";
  }
  if (normalized === "CANCELLED" || normalized === "CANCELLED+") {
    return "cancelled";
  }
  if (normalized === "TIMEOUT" || normalized === "DEADLINE") {
    return "timeout";
  }
  return "failed";
}

async function readRemoteLog(
  job: PersistedPredictionJob,
  filename: "stdout.log" | "stderr.log",
  settings: NibiSettings,
  remoteExecutor: RemoteExecutor,
) {
  try {
    const result = await remoteExecutor.runCommand({
      label: `Read remote ${filename}`,
      executable: "cat",
      args: [remoteJobChildPath(job, filename)],
      settings: trimNibiSettings(settings),
      redacted_preview: `cat <remote_job_dir>/${filename}`,
    });
    return result.exit_code === 0 ? result.stdout : result.stderr;
  } catch (error) {
    return error instanceof Error ? error.message : "";
  }
}

function buildFailureDetails(params: {
  state?: string;
  exitCode?: string;
  remoteJobDir?: string;
  submittedCommand?: string;
  stdout?: string;
  stderr?: string;
}) {
  return [
    params.state ? `Slurm State: ${params.state}` : "",
    params.exitCode ? `Slurm ExitCode: ${params.exitCode}` : "",
    params.remoteJobDir ? `Remote job folder: ${params.remoteJobDir}` : "",
    params.submittedCommand ? `Submitted command: ${params.submittedCommand}` : "",
    params.stdout ? `stdout.log:\n${params.stdout.trim()}` : "",
    params.stderr ? `stderr.log:\n${params.stderr.trim()}` : "",
  ].filter(Boolean).join("\n\n");
}

export function parseSqueueOutput(output: string): SqueueRow | null {
  const firstLine = output.trim().split(/\r?\n/).find(Boolean);
  if (!firstLine) return null;
  const [jobId, state, elapsed, reason] = firstLine.split("|");
  if (!jobId || !state) return null;
  return {
    jobId: jobId.trim(),
    state: state.trim(),
    elapsed: (elapsed ?? "").trim(),
    reason: (reason ?? "").trim(),
  };
}

export function parseSacctOutput(output: string, slurmJobId: string): SacctRow | null {
  const rows = output.trim().split(/\r?\n/)
    .map((line) => line.split("|"))
    .filter((parts) => parts.length >= 3)
    .map(([jobId, state, exitCode]) => ({
      jobId: jobId.trim(),
      state: state.trim(),
      exitCode: exitCode.trim(),
    }));

  return rows.find((row) => row.jobId === slurmJobId)
    ?? rows.find((row) => row.jobId.startsWith(`${slurmJobId}.batch`))
    ?? rows[0]
    ?? null;
}

export function mapSlurmStateToJobStatus(state: string, exitCode?: string): SlurmPollingStatus {
  return mapSlurmState(state, exitCode);
}

export function buildRemoteOutputExistsCommand(job: PersistedPredictionJob) {
  return {
    label: "Check remote prediction output",
    executable: "test",
    args: ["-f", remoteOutputPath(job)],
    redacted_preview: "test -f <remote_output_json>",
  };
}

async function persistPollingStatus(
  job: PersistedPredictionJob,
  result: SlurmPollingResult,
  persistence: SlurmPollingPersistence,
) {
  const completedAt = activeStatus(result.status) || result.status === "login_required" || result.status === "robot_auth_failed" || result.status === "connection_failed"
    ? undefined
    : new Date().toISOString();
  await persistence.updateJobStatus(job.id, result.status, {
    completedAt,
    slurmState: result.slurmState,
    errorMessage: result.status === "completed" ? undefined : [
      result.message,
      result.technicalDetails,
    ].filter(Boolean).join("\n\n"),
  });
  await persistence.addJobEvent(job.id, `slurm_${result.status}`, result.message, completedAt);
}

export async function checkRemoteOutputExists(
  job: PersistedPredictionJob,
  settings: NibiSettings,
  remoteExecutor: RemoteExecutor,
): Promise<boolean> {
  const result = await remoteExecutor.runCommand({
    ...buildRemoteOutputExistsCommand(job),
    settings: trimNibiSettings(settings),
  });
  return result.exit_code === 0;
}

export async function downloadPredictionOutput(
  job: PersistedPredictionJob,
  settings: NibiSettings,
  remoteExecutor: RemoteExecutor,
  persistence: SlurmPollingPersistence = defaultPersistence,
): Promise<SlurmPollingResult> {
  try {
    const localPath = await localOutputPath(job.id);
    await remoteExecutor.downloadFile(remoteOutputPath(job), localPath, trimNibiSettings(settings));
    const outputJson = await invoke<string>("read_prediction_output_file", { localPath });
    const output = validatePredictionJobOutput(JSON.parse(outputJson));
    await persistence.saveResult(job.id, output, output.completed_at);
    await persistence.updateJobStatus(job.id, "completed", {
      completedAt: output.completed_at,
      errorMessage: undefined,
    });
    await persistence.addJobEvent(job.id, "slurm_completed", "Downloaded and saved output.json.", output.completed_at);
    return {
      jobId: job.id,
      slurmJobId: job.remote_slurm_id,
      status: "completed",
      message: "Prediction output downloaded and saved.",
      output,
    };
  } catch (error) {
    const isJsonError = error instanceof SyntaxError || (error instanceof Error && error.name === "PredictionJobValidationError");
    const status: SlurmPollingStatus = isJsonError ? "output_invalid" : "download_failed";
    const appErrorResult = appError(
      isJsonError ? "output_invalid" : "download_failed",
      error instanceof Error ? error.message : String(error),
    );
    const result = {
      jobId: job.id,
      slurmJobId: job.remote_slurm_id,
      status,
      message: appErrorResult.message,
      technicalDetails: appErrorResult.technicalDetails,
      appError: appErrorResult,
    };
    await persistPollingStatus(job, result, persistence);
    return result;
  }
}

export async function pollSlurmJobStatus(
  job: PersistedPredictionJob,
  settings: NibiSettings,
  remoteExecutor: RemoteExecutor,
  persistence: SlurmPollingPersistence = defaultPersistence,
): Promise<SlurmPollingResult> {
  const connectionFailure = connectionFailureStatus(settings, remoteExecutor);
  if (connectionFailure) {
    const result = { ...connectionFailure, jobId: job.id, slurmJobId: job.remote_slurm_id };
    await persistPollingStatus(job, result, persistence);
    return result;
  }

  if (!job.remote_slurm_id) {
    const error = appError("output_missing");
    const result: SlurmPollingResult = {
      jobId: job.id,
      slurmJobId: job.remote_slurm_id,
      status: "output_missing",
      message: error.message,
      appError: error,
    };
    await persistPollingStatus(job, result, persistence);
    return result;
  }

  const trimmed = trimNibiSettings(settings);
  const squeue = await remoteExecutor.runCommand({
    label: "Poll active Slurm job",
    executable: "squeue",
    args: ["-j", job.remote_slurm_id, "--noheader", "--format=%i|%T|%M|%R"],
    settings: trimmed,
    redacted_preview: "squeue -j <job_id> --noheader --format=\"%i|%T|%M|%R\"",
  });

  if (squeue.exit_code !== 0 && commandText(squeue)) {
    const error = classifyRemoteCommandFailure(squeue, "slurm_poll");
    const result: SlurmPollingResult = {
      jobId: job.id,
      slurmJobId: job.remote_slurm_id,
      status: "connection_failed",
      message: error.message,
      technicalDetails: error.technicalDetails,
      appError: error,
    };
    await persistPollingStatus(job, result, persistence);
    return result;
  }

  const activeRow = parseSqueueOutput(squeue.stdout);
  if (activeRow) {
    const status = mapSlurmState(activeRow.state);
    const result: SlurmPollingResult = {
      jobId: job.id,
      slurmJobId: job.remote_slurm_id,
      status,
      message: `Slurm job ${activeRow.jobId} is ${activeRow.state}.`,
      technicalDetails: activeRow.reason,
      slurmState: activeRow.state,
    };
    await persistPollingStatus(job, result, persistence);
    return result;
  }

  const sacct = await remoteExecutor.runCommand({
    label: "Poll completed Slurm job",
    executable: "sacct",
    args: ["-j", job.remote_slurm_id, "--format=JobID,State,ExitCode", "--parsable2", "--noheader"],
    settings: trimmed,
    redacted_preview: "sacct -j <job_id> --format=JobID,State,ExitCode --parsable2 --noheader",
  });
  const sacctRow = sacct.exit_code === 0 ? parseSacctOutput(sacct.stdout, job.remote_slurm_id) : null;
  const sacctUnavailable = isSacctUnavailable(sacct);
  const mappedStatus = sacctRow ? mapSlurmState(sacctRow.state, sacctRow.exitCode) : null;

  if (mappedStatus === "completed" || (!sacctRow && sacctUnavailable)) {
    if (await checkRemoteOutputExists(job, settings, remoteExecutor)) {
      return downloadPredictionOutput(job, settings, remoteExecutor, persistence);
    }
    const error = sacctUnavailable
      ? classifyRemoteCommandFailure(sacct, "slurm_poll")
      : appError("output_missing");
    const result: SlurmPollingResult = {
      jobId: job.id,
      slurmJobId: job.remote_slurm_id,
      status: "output_missing",
      message: error.message,
      technicalDetails: error.technicalDetails,
      appError: error,
      slurmState: sacctRow?.state,
    };
    await persistPollingStatus(job, result, persistence);
    return result;
  }

  if (mappedStatus) {
    const [stdoutLog, stderrLog] = ["failed", "cancelled", "timeout"].includes(mappedStatus)
      ? await Promise.all([
        readRemoteLog(job, "stdout.log", settings, remoteExecutor),
        readRemoteLog(job, "stderr.log", settings, remoteExecutor),
      ])
      : ["", ""];
    const failureDetails = ["failed", "cancelled", "timeout"].includes(mappedStatus)
      ? buildFailureDetails({
        state: sacctRow?.state,
        exitCode: sacctRow?.exitCode,
        remoteJobDir: job.remote_job_dir,
        submittedCommand: job.submitted_command,
        stdout: stdoutLog,
        stderr: stderrLog,
      })
      : undefined;
    const error = appError("job_failed", sacctRow?.exitCode);
    const result: SlurmPollingResult = {
      jobId: job.id,
      slurmJobId: job.remote_slurm_id,
      status: mappedStatus,
      message: `${error.message} Slurm state: ${sacctRow?.state}.`,
      technicalDetails: failureDetails || error.technicalDetails,
      appError: error,
      slurmState: sacctRow?.state,
    };
    const completedAt = new Date().toISOString();
    await persistence.updateJobStatus(job.id, result.status, {
      completedAt,
      slurmState: sacctRow?.state,
      slurmExitCode: sacctRow?.exitCode,
      slurmStdout: stdoutLog,
      slurmStderr: stderrLog,
      errorMessage: [result.message, result.technicalDetails].filter(Boolean).join("\n\n"),
    });
    await persistence.addJobEvent(job.id, `slurm_${result.status}`, result.message, completedAt);
    return result;
  }

  const error = classifyRemoteCommandFailure(sacct, "slurm_poll");
  const result: SlurmPollingResult = {
    jobId: job.id,
    slurmJobId: job.remote_slurm_id,
    status: "connection_failed",
    message: error.message,
    technicalDetails: error.technicalDetails,
    appError: error,
  };
  await persistPollingStatus(job, result, persistence);
  return result;
}
