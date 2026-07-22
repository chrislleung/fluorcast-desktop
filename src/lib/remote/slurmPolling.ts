import { invoke } from "@tauri-apps/api/core";
import type { NibiSettings } from "../../features/settings";
import { trimNibiSettings } from "../../features/settings";
import type { PersistedPredictionJob } from "../db";
import { addJobEvent, saveResult, updateJobStatus } from "../db";
import { PredictionJobValidationError, type PredictionJobOutput } from "../schemas";
import type { RemoteExecutor } from "./RemoteExecutor";
import {
  parseRemoteOutputJsonForImport,
  type CompletionTimestampMetadata,
  type RemoteOutputImportDiagnostics,
} from "./remotePredictionOutputAdapter";
import {
  appError,
  classifyRemoteCommandFailure,
  type AppError,
} from "./errors";
import type { RefreshTraceStage } from "./refreshDiagnostics";
import { joinRemoteChildPath } from "./uploadPredictionInput";

export type SlurmPollingStatus =
  | "submitted_to_slurm"
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed_out"
  | "login_required"
  | "robot_auth_failed"
  | "connection_failed"
  | "output_missing"
  | "output_invalid"
  | "download_failed"
  | "unknown";

export type SlurmPollingResult = {
  jobId: string;
  slurmJobId?: string;
  status: SlurmPollingStatus;
  message: string;
  technicalDetails?: string;
  appError?: AppError;
  slurmState?: string;
  slurmExitCode?: string;
  output?: PredictionJobOutput;
  schedulerConfirmed?: boolean;
};

export type SlurmPollingPersistence = {
  updateJobStatus: typeof updateJobStatus;
  saveResult: typeof saveResult;
  addJobEvent: typeof addJobEvent;
};

export type SlurmRefreshDiagnosticsRecorder = {
  record(stage: RefreshTraceStage, fields?: Record<string, unknown>): void;
  recordRowStatusWrite(params: {
    localJobId: string;
    oldStatus?: PersistedPredictionJob["status"];
    newStatus: PersistedPredictionJob["status"];
    writerFunction: string;
    reason: string;
    pollGeneration?: number;
    appliedOrIgnored: "applied" | "ignored";
  }): void;
};

type SqueueRow = {
  jobId: string;
  state: string;
  elapsed: string;
  reason: string;
};

export type SqueueResultClassification =
  | "active_job_found"
  | "active_job_not_found"
  | "hard_failure";

type SacctRow = {
  jobId: string;
  state: string;
  exitCode: string;
  end?: string;
};

const defaultPersistence: SlurmPollingPersistence = {
  updateJobStatus,
  saveResult,
  addJobEvent,
};

function activeStatus(status: SlurmPollingStatus) {
  return status === "submitted_to_slurm" || status === "queued" || status === "running";
}

function resultErrorMessage(result: SlurmPollingResult) {
  return result.status === "completed"
    ? undefined
    : [
      result.message,
      result.technicalDetails,
    ].filter(Boolean).join("\n\n");
}

function pollingStatusChanged(job: PersistedPredictionJob, result: SlurmPollingResult) {
  const nextErrorMessage = resultErrorMessage(result);
  return job.status !== result.status
    || (result.slurmJobId !== undefined && job.remote_slurm_id !== result.slurmJobId)
    || (result.slurmState !== undefined && job.slurm_state !== result.slurmState)
    || (result.slurmExitCode !== undefined && job.slurm_exit_code !== result.slurmExitCode)
    || job.error_message !== nextErrorMessage;
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
  if (job.remote_output_path) {
    return job.remote_output_path;
  }
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

function localOutputModifiedAt(localPath: string) {
  return invoke<string>("prediction_output_file_modified_at", { localPath });
}

function commandText(result: { stdout: string; stderr: string }) {
  return [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
}

function commandDiagnostics(prefix: string, result: { exit_code: number; stdout: string; stderr: string }) {
  return [
    `${prefix}_EXIT=${result.exit_code}`,
    result.stdout ? `${prefix}_STDOUT=\n${result.stdout.trim()}` : `${prefix}_STDOUT=`,
    result.stderr ? `${prefix}_STDERR=\n${result.stderr.trim()}` : `${prefix}_STDERR=`,
  ].join("\n");
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

export function classifySqueueResult(
  result: { exit_code: number; stdout: string; stderr: string },
  activeRow: SqueueRow | null,
): SqueueResultClassification {
  if (activeRow) {
    return "active_job_found";
  }
  const text = commandText(result).toLowerCase();
  if (
    result.exit_code === 0
    || text.includes("invalid job id specified")
    || text.includes("job not found")
    || text.includes("invalid job id")
  ) {
    return "active_job_not_found";
  }
  return "hard_failure";
}

function mapSlurmState(state: string, exitCode?: string): SlurmPollingStatus {
  const normalized = state.trim().toUpperCase().split(/\s+/)[0];
  if (["PENDING", "CONFIGURING", "REQUEUED", "RESIZING", "SUSPENDED"].includes(normalized)) {
    return "queued";
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
    return "timed_out";
  }
  if (["FAILED", "NODE_FAIL", "OUT_OF_MEMORY", "PREEMPTED", "BOOT_FAIL"].includes(normalized)) {
    return "failed";
  }
  return "unknown";
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
  const firstLine = (output ?? "").trim().split(/\r?\n/).find(Boolean);
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
    .map(([jobId, state, exitCode, end]) => ({
      jobId: jobId.trim(),
      state: state.trim(),
      exitCode: exitCode.trim(),
      ...(end?.trim() ? { end: end.trim() } : {}),
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
  diagnostics?: SlurmRefreshDiagnosticsRecorder,
  reason = "polling_status_changed",
) {
  if (!pollingStatusChanged(job, result)) {
    diagnostics?.recordRowStatusWrite({
      localJobId: job.id,
      oldStatus: job.status,
      newStatus: result.status,
      writerFunction: "persistPollingStatus",
      reason,
      appliedOrIgnored: "ignored",
    });
    return;
  }
  const completedAt = activeStatus(result.status) || result.status === "login_required" || result.status === "robot_auth_failed" || result.status === "connection_failed"
    ? undefined
    : new Date().toISOString();
  const updated = await persistence.updateJobStatus(job.id, result.status, {
    completedAt,
    slurmState: result.slurmState,
    slurmExitCode: result.slurmExitCode,
    errorMessage: resultErrorMessage(result),
  });
  diagnostics?.recordRowStatusWrite({
    localJobId: job.id,
    oldStatus: job.status,
    newStatus: result.status,
    writerFunction: "persistPollingStatus",
    reason,
    appliedOrIgnored: updated ? "applied" : "ignored",
  });
  await persistence.addJobEvent(job.id, `slurm_${result.status}`, result.message, completedAt);
}

export async function checkRemoteOutputExists(
  job: PersistedPredictionJob,
  settings: NibiSettings,
  remoteExecutor: RemoteExecutor,
  diagnostics?: SlurmRefreshDiagnosticsRecorder,
): Promise<boolean> {
  diagnostics?.record("OUTPUT_CHECK_STARTED", { remoteOutputPath: remoteOutputPath(job) });
  const result = await remoteExecutor.runCommand({
    ...buildRemoteOutputExistsCommand(job),
    settings: trimNibiSettings(settings),
  });
  diagnostics?.record("OUTPUT_EXISTS", {
    exists: result.exit_code === 0,
    exitCode: result.exit_code,
    stdout: result.stdout,
    stderr: result.stderr,
  });
  return result.exit_code === 0;
}

function downloadDiagnostics(params: {
  remotePath: string;
  localPath?: string;
  remoteOutputExists?: boolean;
  error?: unknown;
  importDiagnostics?: RemoteOutputImportDiagnostics;
}) {
  const diagnostics = params.importDiagnostics ?? {
    jsonSyntaxStatus: "not_started",
    remoteSchemaStatus: "not_started",
    adapterStatus: "not_started",
    canonicalSchemaStatus: "not_started",
    persistenceStatus: "not_started",
  };
  return [
    `REMOTE_OUTPUT_PATH=${params.remotePath}`,
    params.remoteOutputExists === undefined ? "" : `REMOTE_OUTPUT_EXISTS=${params.remoteOutputExists ? 1 : 0}`,
    params.localPath ? `WINDOWS_DESTINATION=${params.localPath}` : "",
    params.localPath ? `NORMALIZED_WINDOWS_DESTINATION=${params.localPath.replace(/\\/g, "/")}` : "",
    `JSON_SYNTAX_STATUS=${diagnostics.jsonSyntaxStatus}`,
    `REMOTE_SCHEMA_STATUS=${diagnostics.remoteSchemaStatus}`,
    `ADAPTER_STATUS=${diagnostics.adapterStatus}`,
    `CANONICAL_SCHEMA_STATUS=${diagnostics.canonicalSchemaStatus}`,
    `PERSISTENCE_STATUS=${diagnostics.persistenceStatus}`,
    params.error instanceof Error ? params.error.message : params.error ? String(params.error) : "",
  ].filter(Boolean).join("\n");
}

function errorDiagnostics(error: unknown): RemoteOutputImportDiagnostics | undefined {
  if (typeof error !== "object" || error === null || !("diagnostics" in error)) {
    return undefined;
  }
  return (error as { diagnostics?: RemoteOutputImportDiagnostics }).diagnostics;
}

function toIsoUtcTimestamp(value?: string): string | undefined {
  if (!value || value === "Unknown") return undefined;
  if (/^\d+$/.test(value)) {
    return new Date(Number(value)).toISOString();
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString();
}

async function importPredictionOutputJson(params: {
  job: PersistedPredictionJob;
  outputJson: string;
  localPath: string;
  remotePath: string;
  persistence: SlurmPollingPersistence;
  completion: CompletionTimestampMetadata;
}) {
  const adapted = parseRemoteOutputJsonForImport(params.outputJson, {
    localJobId: params.job.id,
    completion: params.completion,
  });
  const saved = await params.persistence.saveResult(
    params.job.id,
    adapted.output,
    adapted.output.completed_at,
  );
  if (!saved) {
    throw Object.assign(
      new Error("Result persistence failed before the job could be marked completed."),
      {
        diagnostics: {
          ...adapted.diagnostics,
          persistenceStatus: "not_started",
        } satisfies RemoteOutputImportDiagnostics,
      },
    );
  }
  return {
    output: adapted.output,
    diagnostics: {
      ...adapted.diagnostics,
      persistenceStatus: "complete",
    } satisfies RemoteOutputImportDiagnostics,
  };
}

export async function downloadPredictionOutput(
  job: PersistedPredictionJob,
  settings: NibiSettings,
  remoteExecutor: RemoteExecutor,
  persistence: SlurmPollingPersistence = defaultPersistence,
  schedulerState: { state?: string; exitCode?: string; end?: string } = {},
  diagnostics?: SlurmRefreshDiagnosticsRecorder,
): Promise<SlurmPollingResult> {
  const outputPath = remoteOutputPath(job);
  let localPath = "";
  try {
    localPath = await localOutputPath(job.id);
    const importTime = new Date().toISOString();
    const sacctEnd = toIsoUtcTimestamp(schedulerState.end);
    const localMtime = async () => {
      try {
        return toIsoUtcTimestamp(await localOutputModifiedAt(localPath));
      } catch {
        return undefined;
      }
    };
    const tryLocalImport = async () => {
      try {
        const existingOutputJson = await invoke<string>("read_prediction_output_file", { localPath });
        return await importPredictionOutputJson({
          job,
          outputJson: existingOutputJson,
          localPath,
          remotePath: outputPath,
          persistence,
          completion: {
            persistedCompletedAt: job.completed_at,
            sacctEnd,
            remoteFileMtime: await localMtime(),
            importTime,
          },
        });
      } catch {
        return null;
      }
    };
    const existingImport = ["output_invalid", "download_failed"].includes(job.status)
      ? await tryLocalImport()
      : null;
    if (existingImport) {
      const updated = await persistence.updateJobStatus(job.id, "completed", {
        completedAt: existingImport.output.completed_at,
        errorMessage: undefined,
      });
      diagnostics?.recordRowStatusWrite({
        localJobId: job.id,
        oldStatus: job.status,
        newStatus: "completed",
        writerFunction: "downloadPredictionOutput.existingImport",
        reason: "existing_output_imported",
        appliedOrIgnored: updated ? "applied" : "ignored",
      });
      await persistence.addJobEvent(job.id, "slurm_completed", "Imported downloaded output.json.", existingImport.output.completed_at);
      diagnostics?.record("REMOTE_SCHEMA_STATUS", { status: existingImport.diagnostics.remoteSchemaStatus });
      diagnostics?.record("ADAPTER_STATUS", { status: existingImport.diagnostics.adapterStatus });
      diagnostics?.record("PERSISTENCE_STATUS", { status: existingImport.diagnostics.persistenceStatus });
      return {
        jobId: job.id,
        slurmJobId: job.remote_slurm_id,
        status: "completed",
        message: "Prediction output imported and saved.",
        technicalDetails: downloadDiagnostics({
          remotePath: outputPath,
          localPath,
          importDiagnostics: existingImport.diagnostics,
        }),
        output: existingImport.output,
        slurmState: schedulerState.state,
        slurmExitCode: schedulerState.exitCode,
        schedulerConfirmed: Boolean(schedulerState.state),
      };
    }
    const exists = await checkRemoteOutputExists(job, settings, remoteExecutor, diagnostics);
    if (!exists) {
      const error = appError("output_missing", `DOWNLOAD_FAILURE_CODE=46\n${downloadDiagnostics({ remotePath: outputPath, remoteOutputExists: false })}`);
      const result: SlurmPollingResult = {
        jobId: job.id,
        slurmJobId: job.remote_slurm_id,
        status: "output_missing",
        message: error.message,
        technicalDetails: error.technicalDetails,
        appError: error,
        slurmState: schedulerState.state,
        slurmExitCode: schedulerState.exitCode,
        schedulerConfirmed: Boolean(schedulerState.state),
      };
      await persistPollingStatus(job, result, persistence, diagnostics, "remote_output_missing");
      return result;
    }
    const [stdoutLog, stderrLog] = await Promise.all([
      readRemoteLog(job, "stdout.log", settings, remoteExecutor),
      readRemoteLog(job, "stderr.log", settings, remoteExecutor),
    ]);
    diagnostics?.record("OUTPUT_SIZE", { size: "unknown" });
    diagnostics?.record("DOWNLOAD_STARTED", { remotePath: outputPath, localPath });
    await remoteExecutor.downloadFile(outputPath, localPath, trimNibiSettings(settings));
    diagnostics?.record("DOWNLOAD_EXIT_CODE", { exitCode: 0 });
    const outputJson = await invoke<string>("read_prediction_output_file", { localPath });
    diagnostics?.record("OUTPUT_SIZE", { size: outputJson.length });
    const imported = await importPredictionOutputJson({
      job,
      outputJson,
      localPath,
      remotePath: outputPath,
      persistence,
      completion: {
        persistedCompletedAt: job.completed_at,
        sacctEnd,
        remoteFileMtime: await localMtime(),
        importTime,
      },
    });
    const output = imported.output;
    const updated = await persistence.updateJobStatus(job.id, "completed", {
      completedAt: output.completed_at,
      slurmStdout: stdoutLog,
      slurmStderr: stderrLog,
      errorMessage: undefined,
    });
    diagnostics?.recordRowStatusWrite({
      localJobId: job.id,
      oldStatus: job.status,
      newStatus: "completed",
      writerFunction: "downloadPredictionOutput",
      reason: "downloaded_output_imported",
      appliedOrIgnored: updated ? "applied" : "ignored",
    });
    await persistence.addJobEvent(job.id, "slurm_completed", "Downloaded and saved output.json.", output.completed_at);
    diagnostics?.record("REMOTE_SCHEMA_STATUS", { status: imported.diagnostics.remoteSchemaStatus });
    diagnostics?.record("ADAPTER_STATUS", { status: imported.diagnostics.adapterStatus });
    diagnostics?.record("PERSISTENCE_STATUS", { status: imported.diagnostics.persistenceStatus });
    return {
      jobId: job.id,
      slurmJobId: job.remote_slurm_id,
      status: "completed",
      message: "Prediction output downloaded and saved.",
      technicalDetails: downloadDiagnostics({
        remotePath: outputPath,
        localPath,
        remoteOutputExists: true,
        importDiagnostics: imported.diagnostics,
      }),
      output,
      slurmState: schedulerState.state,
      slurmExitCode: schedulerState.exitCode,
      schedulerConfirmed: Boolean(schedulerState.state),
    };
  } catch (error) {
    const isJsonError = error instanceof SyntaxError
      || error instanceof PredictionJobValidationError
      || (error instanceof Error && error.name === "PredictionJobValidationError");
    const status: SlurmPollingStatus = isJsonError ? "output_invalid" : "download_failed";
    const technicalDetails = [
      isJsonError ? "DOWNLOAD_FAILURE_CODE=49" : "",
      downloadDiagnostics({
        remotePath: outputPath,
        localPath,
        remoteOutputExists: true,
        error,
        importDiagnostics: errorDiagnostics(error),
      }),
    ].filter(Boolean).join("\n");
    const appErrorResult = appError(
      isJsonError ? "output_invalid" : "download_failed",
      technicalDetails,
    );
    const result = {
      jobId: job.id,
      slurmJobId: job.remote_slurm_id,
      status,
      message: appErrorResult.message,
      technicalDetails: appErrorResult.technicalDetails,
      appError: appErrorResult,
      slurmState: schedulerState.state,
      slurmExitCode: schedulerState.exitCode,
      schedulerConfirmed: Boolean(schedulerState.state),
    };
    diagnostics?.record("DOWNLOAD_EXIT_CODE", { exitCode: 1 });
    diagnostics?.record("ERROR_STAGE", { stage: "download/import" });
    diagnostics?.record("ERROR_CLASS", { class: error instanceof Error ? error.name : typeof error });
    diagnostics?.record("ERROR_MESSAGE", { message: error instanceof Error ? error.message : String(error) });
    await persistPollingStatus(job, result, persistence, diagnostics, status);
    return result;
  }
}

export async function pollSlurmJobStatus(
  job: PersistedPredictionJob,
  settings: NibiSettings,
  remoteExecutor: RemoteExecutor,
  persistence: SlurmPollingPersistence = defaultPersistence,
  diagnostics?: SlurmRefreshDiagnosticsRecorder,
): Promise<SlurmPollingResult> {
  const connectionFailure = connectionFailureStatus(settings, remoteExecutor);
  if (connectionFailure) {
    const result = { ...connectionFailure, jobId: job.id, slurmJobId: job.remote_slurm_id };
    diagnostics?.record("ERROR_STAGE", { stage: "connection_status" });
    diagnostics?.record("ERROR_CLASS", { class: result.appError?.code });
    diagnostics?.record("ERROR_MESSAGE", { message: result.message });
    await persistPollingStatus(job, result, persistence, diagnostics, "connection_status");
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
    await persistPollingStatus(job, result, persistence, diagnostics, "missing_slurm_id");
    return result;
  }

  const trimmed = trimNibiSettings(settings);
  diagnostics?.record("SQUEUE_STARTED", { slurmId: job.remote_slurm_id });
  const squeue = await remoteExecutor.runCommand({
    label: "Poll active Slurm job",
    executable: "squeue",
    args: ["-j", job.remote_slurm_id, "--noheader", "--format=%i|%T|%M|%R"],
    settings: trimmed,
    redacted_preview: "squeue -j <job_id> --noheader --format=\"%i|%T|%M|%R\"",
  });
  diagnostics?.record("SQUEUE_EXIT_CODE", { exitCode: squeue.exit_code });
  diagnostics?.record("SQUEUE_STDOUT", { stdout: squeue.stdout });
  diagnostics?.record("SQUEUE_STDERR", { stderr: squeue.stderr });

  const activeRow = parseSqueueOutput(squeue.stdout);
  const squeueClassification = classifySqueueResult(squeue, activeRow);
  diagnostics?.record("SQUEUE_CLASSIFICATION", {
    SQUEUE_CLASSIFICATION: squeueClassification,
  });
  diagnostics?.record("SQUEUE_MATCH_FOUND", { found: Boolean(activeRow) });

  if (squeueClassification === "hard_failure") {
    const error = classifyRemoteCommandFailure(squeue, "slurm_poll");
    const result: SlurmPollingResult = {
      jobId: job.id,
      slurmJobId: job.remote_slurm_id,
      status: "connection_failed",
      message: error.message,
      technicalDetails: error.technicalDetails,
      appError: error,
    };
    diagnostics?.record("ERROR_STAGE", { stage: "squeue" });
    diagnostics?.record("ERROR_CLASS", { class: error.code });
    diagnostics?.record("ERROR_MESSAGE", { message: error.message });
    await persistPollingStatus(job, result, persistence, diagnostics, "squeue_failed");
    return result;
  }

  if (activeRow) {
    const status = mapSlurmState(activeRow.state);
    const result: SlurmPollingResult = {
      jobId: job.id,
      slurmJobId: job.remote_slurm_id,
      status,
      message: `Slurm job ${activeRow.jobId} is ${activeRow.state}.`,
      technicalDetails: activeRow.reason,
      slurmState: activeRow.state,
      schedulerConfirmed: true,
    };
    await persistPollingStatus(job, result, persistence, diagnostics, "squeue_active_row");
    return result;
  }

  diagnostics?.record("SACCT_FALLBACK_STARTED", {
    SACCT_FALLBACK_STARTED: 1,
    GLOBAL_SESSION_STATE_CHANGED: false,
  });
  diagnostics?.record("GLOBAL_SESSION_STATE_CHANGED", {
    GLOBAL_SESSION_STATE_CHANGED: false,
  });
  diagnostics?.record("SACCT_STARTED", { slurmId: job.remote_slurm_id });
  const sacct = await remoteExecutor.runCommand({
    label: "Poll completed Slurm job",
    executable: "sacct",
    args: ["-j", job.remote_slurm_id, "--format=JobID,State,ExitCode,End", "--parsable2", "--noheader"],
    settings: trimmed,
    redacted_preview: "sacct -j <job_id> --format=JobID,State,ExitCode,End --parsable2 --noheader",
  });
  diagnostics?.record("SACCT_EXIT_CODE", { exitCode: sacct.exit_code });
  diagnostics?.record("SACCT_STDOUT", { stdout: sacct.stdout });
  diagnostics?.record("SACCT_STDERR", { stderr: sacct.stderr });
  const sacctRow = sacct.exit_code === 0 ? parseSacctOutput(sacct.stdout, job.remote_slurm_id) : null;
  diagnostics?.record("SACCT_PARENT_STATE", { state: sacctRow?.state ?? "" });
  diagnostics?.record("SACCT_PARENT_EXIT_CODE", { exitCode: sacctRow?.exitCode ?? "" });
  const sacctUnavailable = isSacctUnavailable(sacct);
  const mappedStatus = sacctRow ? mapSlurmState(sacctRow.state, sacctRow.exitCode) : null;

  if (mappedStatus === "completed" || (!sacctRow && sacctUnavailable)) {
    const downloaded = await downloadPredictionOutput(job, settings, remoteExecutor, persistence, {
      state: sacctRow?.state,
      exitCode: sacctRow?.exitCode,
      end: sacctRow?.end,
    }, diagnostics);
    if (downloaded.status !== "output_missing") {
      return {
        ...downloaded,
        schedulerConfirmed: Boolean(sacctRow),
      };
    }
    const [stdoutLog, stderrLog] = await Promise.all([
      readRemoteLog(job, "stdout.log", settings, remoteExecutor),
      readRemoteLog(job, "stderr.log", settings, remoteExecutor),
    ]);
    const error = sacctUnavailable
      ? classifyRemoteCommandFailure(sacct, "slurm_poll")
      : appError("output_missing");
    const details = buildFailureDetails({
      state: sacctRow?.state,
      exitCode: sacctRow?.exitCode,
      remoteJobDir: job.remote_job_dir,
      submittedCommand: job.submitted_command,
      stdout: stdoutLog,
      stderr: stderrLog,
    }) || error.technicalDetails;
    const result: SlurmPollingResult = {
      jobId: job.id,
      slurmJobId: job.remote_slurm_id,
      status: "output_missing",
      message: error.message,
      technicalDetails: [
        "SQUEUE_MATCH_FOUND=0",
        commandDiagnostics("SQUEUE", squeue),
        commandDiagnostics("SACCT", sacct),
        sacctRow ? `SACCT_PARENT_STATE=${sacctRow.state}` : "SACCT_PARENT_STATE=",
        sacctRow ? `SACCT_EXIT_CODE=${sacctRow.exitCode}` : "SACCT_EXIT_CODE=",
        sacctRow?.end ? `SACCT_END=${sacctRow.end}` : "SACCT_END=",
        details,
      ].filter(Boolean).join("\n\n"),
      appError: error,
      slurmState: sacctRow?.state,
      slurmExitCode: sacctRow?.exitCode,
      schedulerConfirmed: Boolean(sacctRow),
    };
    if (pollingStatusChanged(job, result) || job.slurm_stdout !== stdoutLog || job.slurm_stderr !== stderrLog) {
      const completedAt = new Date().toISOString();
      const updated = await persistence.updateJobStatus(job.id, result.status, {
        completedAt,
        slurmState: sacctRow?.state,
        slurmExitCode: sacctRow?.exitCode,
        slurmStdout: stdoutLog,
        slurmStderr: stderrLog,
        errorMessage: [result.message, result.technicalDetails].filter(Boolean).join("\n\n"),
      });
      diagnostics?.recordRowStatusWrite({
        localJobId: job.id,
        oldStatus: job.status,
        newStatus: result.status,
        writerFunction: "pollSlurmJobStatus.outputMissing",
        reason: "completed_but_output_missing",
        appliedOrIgnored: updated ? "applied" : "ignored",
      });
      await persistence.addJobEvent(job.id, `slurm_${result.status}`, result.message, completedAt);
    } else {
      diagnostics?.recordRowStatusWrite({
        localJobId: job.id,
        oldStatus: job.status,
        newStatus: result.status,
        writerFunction: "pollSlurmJobStatus.outputMissing",
        reason: "completed_but_output_missing",
        appliedOrIgnored: "ignored",
      });
    }
    return result;
  }

  if (mappedStatus) {
    const [stdoutLog, stderrLog] = ["failed", "cancelled", "timed_out", "unknown"].includes(mappedStatus)
      ? await Promise.all([
        readRemoteLog(job, "stdout.log", settings, remoteExecutor),
        readRemoteLog(job, "stderr.log", settings, remoteExecutor),
      ])
      : ["", ""];
    const failureDetails = ["failed", "cancelled", "timed_out", "unknown"].includes(mappedStatus)
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
      slurmExitCode: sacctRow?.exitCode,
      schedulerConfirmed: Boolean(sacctRow),
    };
    if (pollingStatusChanged(job, result) || job.slurm_stdout !== stdoutLog || job.slurm_stderr !== stderrLog) {
      const completedAt = new Date().toISOString();
      const updated = await persistence.updateJobStatus(job.id, result.status, {
        completedAt,
        slurmState: sacctRow?.state,
        slurmExitCode: sacctRow?.exitCode,
        slurmStdout: stdoutLog,
        slurmStderr: stderrLog,
        errorMessage: [result.message, result.technicalDetails].filter(Boolean).join("\n\n"),
      });
      diagnostics?.recordRowStatusWrite({
        localJobId: job.id,
        oldStatus: job.status,
        newStatus: result.status,
        writerFunction: "pollSlurmJobStatus.sacctMappedStatus",
        reason: "sacct_mapped_status",
        appliedOrIgnored: updated ? "applied" : "ignored",
      });
      await persistence.addJobEvent(job.id, `slurm_${result.status}`, result.message, completedAt);
    } else {
      diagnostics?.recordRowStatusWrite({
        localJobId: job.id,
        oldStatus: job.status,
        newStatus: result.status,
        writerFunction: "pollSlurmJobStatus.sacctMappedStatus",
        reason: "sacct_mapped_status",
        appliedOrIgnored: "ignored",
      });
    }
    return result;
  }

  const error = sacct.exit_code === 0
    ? appError(
      "output_missing",
      [
        "SQUEUE_MATCH_FOUND=0",
        commandDiagnostics("SQUEUE", squeue),
        commandDiagnostics("SACCT", sacct),
        "SACCT_PARENT_STATE=",
        "SACCT_EXIT_CODE=",
        "REMOTE_OUTPUT_EXISTS=unknown",
      ].join("\n"),
    )
    : classifyRemoteCommandFailure(sacct, "slurm_poll");
  const result: SlurmPollingResult = {
    jobId: job.id,
    slurmJobId: job.remote_slurm_id,
    status: sacct.exit_code === 0 ? "output_missing" : "connection_failed",
    message: error.message,
    technicalDetails: error.technicalDetails,
    appError: error,
  };
  diagnostics?.record("ERROR_STAGE", { stage: sacct.exit_code === 0 ? "sacct_no_parent_row" : "sacct" });
  diagnostics?.record("ERROR_CLASS", { class: error.code });
  diagnostics?.record("ERROR_MESSAGE", { message: error.message });
  await persistPollingStatus(job, result, persistence, diagnostics, sacct.exit_code === 0 ? "sacct_no_parent_row" : "sacct_failed");
  return result;
}
