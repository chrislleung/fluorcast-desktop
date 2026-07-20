import type { StoredJobStatus, StoredPredictionJob } from "../../features/jobs";
import type { NibiSettings } from "../../features/settings";
import { trimNibiSettings } from "../../features/settings";
import { updateJobStatus, addJobEvent } from "../db";
import type { RemoteExecutor } from "./RemoteExecutor";
import { appError, classifyRemoteCommandFailure, type AppError } from "./errors";
import { joinRemoteChildPath } from "./uploadPredictionInput";
import { RemoteExecutionError } from "./types";

export type SlurmSubmissionStatus =
  | "submitting"
  | "submitted_to_slurm"
  | "slurm_submission_failed"
  | "login_required"
  | "robot_access_required";

export type SlurmSubmissionResult = {
  jobId: string;
  status: SlurmSubmissionStatus;
  message: string;
  remoteSlurmId?: string;
  submittedAt?: string;
  technicalDetails?: string;
  appError?: AppError;
};

export type SlurmSubmissionPersistence = {
  updateJobStatus: typeof updateJobStatus;
  addJobEvent: typeof addJobEvent;
};

const defaultPersistence: SlurmSubmissionPersistence = {
  updateJobStatus,
  addJobEvent,
};

const remotePathUnsafePattern = /[\0\r\n;&|`$<>]/;
const activeSubmissionPromises = new Map<string, Promise<SlurmSubmissionResult>>();

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

function remoteProjectChildPath(remoteProjectPath: string, childPath: string) {
  return `${normalizeAbsoluteRemotePath(remoteProjectPath, "Remote project path")}/${childPath}`;
}

function remoteParentPath(remotePath: string, label: string) {
  const normalized = normalizeAbsoluteRemotePath(remotePath, label);
  const index = normalized.lastIndexOf("/");
  if (index <= 0) {
    return "/";
  }
  return normalized.slice(0, index);
}

export function parseSbatchJobId(output: string): string | null {
  const trimmed = output.trim();
  if (/^\d+(?:[.;].*)?$/.test(trimmed)) {
    return trimmed.match(/^\d+/)?.[0] ?? null;
  }
  return trimmed.match(/\bSubmitted batch job\s+(\d+)\b/i)?.[1] ?? null;
}

function buildTechnicalDetails(stdout: string, stderr: string) {
  return [
    stdout ? `stdout:\n${stdout.trim()}` : "",
    stderr ? `stderr:\n${stderr.trim()}` : "",
  ].filter(Boolean).join("\n\n");
}

function submissionIdForJob(job: StoredPredictionJob) {
  return job.submission_id ?? job.id;
}

function isNumericSlurmId(value: string | undefined | null) {
  return Boolean(value && /^\d+$/.test(value.trim()));
}

function preflightFailureDetails(result: Awaited<ReturnType<RemoteExecutor["runCommand"]>>) {
  return buildTechnicalDetails(result.stdout, result.stderr) || result.redacted_command_preview;
}

async function runPreflight(
  label: string,
  command: Parameters<RemoteExecutor["runCommand"]>[0],
  remoteExecutor: RemoteExecutor,
) {
  const result = await remoteExecutor.runCommand({ ...command, label });
  if (result.exit_code !== 0) {
    return {
      label,
      result,
    };
  }
  return null;
}

async function readRemoteSlurmId(
  remoteJobDir: string,
  trimmed: NibiSettings,
  remoteExecutor: RemoteExecutor,
) {
  const result = await remoteExecutor.runCommand({
    label: "Read remote Slurm submission marker",
    executable: "cat",
    args: [`${remoteJobDir}/slurm_job_id.txt`],
    settings: trimmed,
    redacted_preview: "cat <remote_job_dir>/slurm_job_id.txt",
  });
  const slurmId = result.stdout.trim();
  return result.exit_code === 0 && isNumericSlurmId(slurmId) ? slurmId : null;
}

async function claimRemoteSubmission(
  remoteJobDir: string,
  trimmed: NibiSettings,
  remoteExecutor: RemoteExecutor,
) {
  return remoteExecutor.runCommand({
    label: "Claim remote Slurm submission",
    executable: "mkdir",
    args: [`${remoteJobDir}/submission.lock`],
    settings: trimmed,
    redacted_preview: "mkdir <remote_job_dir>/submission.lock",
  });
}

async function writeRemoteSubmissionRecord(
  remoteJobDir: string,
  submissionId: string,
  jobId: string,
  slurmId: string,
  trimmed: NibiSettings,
  remoteExecutor: RemoteExecutor,
) {
  return remoteExecutor.runCommand({
    label: "Record remote Slurm submission",
    executable: "fluorcast-record-slurm-submission",
    args: [remoteJobDir, submissionId, jobId, slurmId],
    settings: trimmed,
    redacted_preview: "record <remote_job_dir>/slurm_job_id.txt and submission metadata",
  });
}

function readinessFailure(job: StoredPredictionJob, settings: NibiSettings, remoteExecutor: RemoteExecutor): SlurmSubmissionResult | null {
  const mode = remoteExecutor.getMode();
  const connectionStatus = remoteExecutor.getConnectionStatus(settings);

  if (mode === "mock") {
    return {
      jobId: job.id,
      status: "slurm_submission_failed",
      message: "Slurm submission requires Manual MFA or Robot automation mode.",
    };
  }
  if (mode === "interactive_mfa" && connectionStatus.state !== "authenticated") {
    const error = appError(
      connectionStatus.state === "ready_for_manual_login" ? "interactive_session_expired" : "interactive_login_required",
      connectionStatus.message,
    );
    return {
      jobId: job.id,
      status: "login_required",
      message: error.message,
      technicalDetails: error.technicalDetails,
      appError: error,
    };
  }
  if (mode === "robot_automation" && connectionStatus.state !== "robot_automation_ready") {
    const error = appError("robot_access_not_ready", connectionStatus.message);
    return {
      jobId: job.id,
      status: "robot_access_required",
      message: error.message,
      technicalDetails: error.technicalDetails,
      appError: error,
    };
  }

  try {
    normalizeAbsoluteRemotePath(settings.remote_project_path, "Remote project path");
    normalizeAbsoluteRemotePath(settings.remote_jobs_path, "Remote jobs path");
    normalizeAbsoluteRemotePath(job.remote_input_path ?? "", "Remote input path");
    normalizeAbsoluteRemotePath(job.remote_output_path ?? "", "Remote output path");
  } catch (error) {
    return {
      jobId: job.id,
      status: "slurm_submission_failed",
      message: error instanceof Error ? error.message : "Remote submission paths are not ready.",
    };
  }

  return null;
}

async function persistSubmissionResult(
  job: StoredPredictionJob,
  result: SlurmSubmissionResult,
  persistence: SlurmSubmissionPersistence,
) {
  const status: StoredJobStatus = result.status;
  await persistence.updateJobStatus(job.id, status, {
    remoteSlurmId: result.remoteSlurmId,
    submittedAt: result.submittedAt,
    errorMessage: result.status === "submitted_to_slurm" ? undefined : [
      result.message,
      result.technicalDetails,
    ].filter(Boolean).join("\n\n"),
  });
  await persistence.addJobEvent(job.id, result.status, result.message, result.submittedAt);
}

export async function submitPredictionSlurmJob(
  job: StoredPredictionJob,
  settings: NibiSettings,
  remoteExecutor: RemoteExecutor,
  persistence: SlurmSubmissionPersistence = defaultPersistence,
): Promise<SlurmSubmissionResult> {
  const submissionId = submissionIdForJob(job);
  const active = activeSubmissionPromises.get(submissionId);
  if (active) {
    await persistence.addJobEvent(job.id, "slurm_submission_reused", "duplicate Slurm submission call reused the active submission");
    return active;
  }
  const promise = submitPredictionSlurmJobOnce(job, settings, remoteExecutor, persistence);
  activeSubmissionPromises.set(submissionId, promise);
  try {
    return await promise;
  } finally {
    activeSubmissionPromises.delete(submissionId);
  }
}

async function submitPredictionSlurmJobOnce(
  job: StoredPredictionJob,
  settings: NibiSettings,
  remoteExecutor: RemoteExecutor,
  persistence: SlurmSubmissionPersistence,
): Promise<SlurmSubmissionResult> {
  const trimmed = trimNibiSettings(settings);
  const remoteInputPath = job.remote_input_path ?? (job.remote_job_dir ? joinRemoteChildPath(job.remote_job_dir, "input.json") : "");
  const remoteOutputPath = job.remote_output_path ?? (job.remote_job_dir ? joinRemoteChildPath(job.remote_job_dir, "output.json") : "");
  const submissionJob = {
    ...job,
    submission_id: submissionIdForJob(job),
    remote_input_path: remoteInputPath,
    remote_output_path: remoteOutputPath,
  };

  if (isNumericSlurmId(job.remote_slurm_id)) {
    const result: SlurmSubmissionResult = {
      jobId: job.id,
      status: "submitted_to_slurm",
      message: `Slurm job ${job.remote_slurm_id} is already submitted.`,
      remoteSlurmId: job.remote_slurm_id,
      submittedAt: job.submitted_at,
    };
    await persistence.addJobEvent(job.id, "slurm_submission_recovered", "local Slurm job ID reused; sbatch was not called");
    return result;
  }

  await persistence.addJobEvent(job.id, "starting_slurm_submission", "starting Slurm submission");
  await persistence.updateJobStatus(job.id, "submitting", {
    submissionId: submissionJob.submission_id,
    errorMessage: undefined,
  });

  const notReady = readinessFailure(submissionJob, trimmed, remoteExecutor);
  if (notReady) {
    await persistSubmissionResult(submissionJob, notReady, persistence);
    return notReady;
  }

  const slurmScriptPath = remoteProjectChildPath(trimmed.remote_project_path, "slurm/run_prediction_job.sbatch");
  const predictionScriptPath = remoteProjectChildPath(trimmed.remote_project_path, "scripts/run_prediction_job.py");
  const remoteJobDir = normalizeAbsoluteRemotePath(submissionJob.remote_job_dir ?? remoteParentPath(remoteInputPath, "Remote input path"), "Remote job directory");
  const remoteOutputParent = remoteParentPath(remoteOutputPath, "Remote output path");
  const remoteStdoutPath = `${remoteJobDir}/stdout.log`;
  const remoteStderrPath = `${remoteJobDir}/stderr.log`;
  const submittedCommandPreview = "sbatch --parsable --chdir=<remote_project> --output=<remote_job_dir>/stdout.log --error=<remote_job_dir>/stderr.log <remote_project>/slurm/run_prediction_job.sbatch <remote_job_dir>/input.json <remote_job_dir>/output.json";

  const existingRemoteSlurmId = await readRemoteSlurmId(remoteJobDir, trimmed, remoteExecutor);
  if (existingRemoteSlurmId) {
    const submittedAt = new Date().toISOString();
    const result: SlurmSubmissionResult = {
      jobId: job.id,
      status: "submitted_to_slurm",
      message: `Recovered existing Slurm job ${existingRemoteSlurmId}.`,
      remoteSlurmId: existingRemoteSlurmId,
      submittedAt,
    };
    await persistence.updateJobStatus(job.id, result.status, {
      remoteSlurmId: existingRemoteSlurmId,
      submittedAt,
      submittedCommand: submittedCommandPreview,
      errorMessage: undefined,
    });
    await persistence.addJobEvent(job.id, "slurm_submission_recovered", result.message, submittedAt);
    return result;
  }

  const claim = await claimRemoteSubmission(remoteJobDir, trimmed, remoteExecutor);
  if (claim.exit_code !== 0) {
    const afterClaimSlurmId = await readRemoteSlurmId(remoteJobDir, trimmed, remoteExecutor);
    if (afterClaimSlurmId) {
      const submittedAt = new Date().toISOString();
      const result: SlurmSubmissionResult = {
        jobId: job.id,
        status: "submitted_to_slurm",
        message: `Recovered existing Slurm job ${afterClaimSlurmId}.`,
        remoteSlurmId: afterClaimSlurmId,
        submittedAt,
      };
      await persistence.updateJobStatus(job.id, result.status, {
        remoteSlurmId: afterClaimSlurmId,
        submittedAt,
        submittedCommand: submittedCommandPreview,
        errorMessage: undefined,
      });
      await persistence.addJobEvent(job.id, "slurm_submission_recovered", result.message, submittedAt);
      return result;
    }
    const result: SlurmSubmissionResult = {
      jobId: job.id,
      status: "slurm_submission_failed",
      message: "A remote submission claim already exists, but no Slurm job ID was recorded. Slurm job was not submitted again.",
      technicalDetails: preflightFailureDetails(claim),
    };
    await persistSubmissionResult(submissionJob, result, persistence);
    await persistence.addJobEvent(job.id, "slurm_submission_uncertain", result.message);
    return result;
  }

  const preflightChecks: Array<[string, Parameters<RemoteExecutor["runCommand"]>[0]]> = [
    ["Verify FluorCast repository directory", {
      executable: "test",
      args: ["-d", trimmed.remote_project_path],
      settings: trimmed,
      redacted_preview: "test -d <remote_project>",
    }],
    ["Verify Slurm batch script", {
      executable: "test",
      args: ["-r", slurmScriptPath],
      settings: trimmed,
      redacted_preview: "test -r <remote_project>/slurm/run_prediction_job.sbatch",
    }],
    ["Verify prediction script", {
      executable: "test",
      args: ["-r", predictionScriptPath],
      settings: trimmed,
      redacted_preview: "test -r <remote_project>/scripts/run_prediction_job.py",
    }],
    ["Verify input JSON exists", {
      executable: "test",
      args: ["-r", remoteInputPath],
      settings: trimmed,
      redacted_preview: "test -r <remote_job_dir>/input.json",
    }],
    ["Validate input JSON syntax", {
      executable: "python3",
      args: ["-m", "json.tool", remoteInputPath],
      settings: trimmed,
      redacted_preview: "python3 -m json.tool <remote_job_dir>/input.json",
    }],
    ["Verify output directory is writable", {
      executable: "test",
      args: ["-w", remoteOutputParent],
      settings: trimmed,
      redacted_preview: "test -w <remote_job_dir>",
    }],
    ["Check Slurm batch script syntax", {
      executable: "bash",
      args: ["-n", slurmScriptPath],
      settings: trimmed,
      redacted_preview: "bash -n <remote_project>/slurm/run_prediction_job.sbatch",
    }],
  ];

  for (const [label, command] of preflightChecks) {
    const failure = await runPreflight(label, command, remoteExecutor);
    if (failure) {
      const result: SlurmSubmissionResult = {
        jobId: job.id,
        status: "slurm_submission_failed",
        message: `${label} failed. Slurm job was not submitted.`,
        technicalDetails: preflightFailureDetails(failure.result),
      };
      await persistSubmissionResult(submissionJob, result, persistence);
      await persistence.addJobEvent(job.id, "slurm_preflight_failed", result.message);
      return result;
    }
  }

  const sbatch = await remoteExecutor.runCommand({
    label: "Submit prediction Slurm job",
    executable: "sbatch",
    args: [
      "--parsable",
      "--chdir", trimmed.remote_project_path,
      "--output", remoteStdoutPath,
      "--error", remoteStderrPath,
      slurmScriptPath,
      remoteInputPath,
      remoteOutputPath,
    ],
    settings: trimmed,
    redacted_preview: submittedCommandPreview,
  });
  await persistence.addJobEvent(job.id, "slurm_command_submitted", "Slurm command submitted");

  if (sbatch.exit_code !== 0) {
    const error = classifyRemoteCommandFailure(sbatch, "sbatch");
    const result: SlurmSubmissionResult = {
      jobId: job.id,
      status: "slurm_submission_failed",
      message: error.message,
      technicalDetails: error.technicalDetails,
      appError: error,
    };
    await persistSubmissionResult(submissionJob, result, persistence);
    await persistence.addJobEvent(job.id, "slurm_submission_failed", result.message);
    return result;
  }

  const remoteSlurmId = parseSbatchJobId(sbatch.stdout) ?? parseSbatchJobId(sbatch.stderr);
  if (!isNumericSlurmId(remoteSlurmId)) {
    const technicalDetails = buildTechnicalDetails(sbatch.stdout, sbatch.stderr);
    const result: SlurmSubmissionResult = {
      jobId: job.id,
      status: "slurm_submission_failed",
      message: "Slurm submission did not return a job ID.",
      technicalDetails,
    };
    await persistSubmissionResult(submissionJob, result, persistence);
    await persistence.addJobEvent(job.id, "slurm_submission_failed", result.message);
    return result;
  }

  const submittedAt = new Date().toISOString();
  const record = await writeRemoteSubmissionRecord(
    remoteJobDir,
    submissionJob.submission_id,
    job.id,
    remoteSlurmId,
    trimmed,
    remoteExecutor,
  );
  if (record.exit_code !== 0) {
    const result: SlurmSubmissionResult = {
      jobId: job.id,
      status: "slurm_submission_failed",
      message: "Slurm accepted the job, but FluorCast could not record the remote submission marker.",
      remoteSlurmId,
      technicalDetails: preflightFailureDetails(record),
    };
    await persistence.updateJobStatus(job.id, result.status, {
      remoteSlurmId,
      submittedAt,
      submittedCommand: sbatch.redacted_command_preview,
      errorMessage: [result.message, result.technicalDetails].filter(Boolean).join("\n\n"),
    });
    await persistence.addJobEvent(job.id, "slurm_submission_record_failed", result.message, submittedAt);
    return result;
  }
  const result: SlurmSubmissionResult = {
    jobId: job.id,
    status: "submitted_to_slurm",
    message: `Slurm job ${remoteSlurmId} submitted.`,
    remoteSlurmId,
    submittedAt,
  };
  await persistence.updateJobStatus(job.id, result.status, {
    remoteSlurmId,
    submittedAt,
    submittedCommand: sbatch.redacted_command_preview,
    errorMessage: undefined,
  });
  await persistence.addJobEvent(job.id, result.status, result.message, submittedAt);
  await persistence.addJobEvent(job.id, "slurm_job_id_received", `Slurm job ID ${remoteSlurmId} received.`, submittedAt);
  return result;
}
