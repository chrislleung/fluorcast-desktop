import { invoke } from "@tauri-apps/api/core";
import type { NibiSettings } from "../../features/settings";
import { trimNibiSettings } from "../../features/settings";
import type { PredictionJobInput } from "../schemas";
import { appError } from "./errors";
import type { RemoteExecutor } from "./RemoteExecutor";
import { RemoteExecutionError } from "./types";

export type PredictionInputUploadResult = {
  remote_job_dir: string;
  remote_input_path: string;
  remote_output_path: string;
};

export type PredictionUploadPersistence = {
  saveJob?: (job: {
    id: string;
    molecule_smiles: string;
    solvent_smiles: string;
    model_choice: string;
    status: "queued_locally" | "submitting" | "upload_waiting_for_login" | "uploaded_to_nibi" | "upload_failed";
    created_at: string;
    submission_id?: string;
    remote_job_dir?: string;
    remote_input_path?: string;
    remote_output_path?: string;
    error_message?: string;
  }) => Promise<unknown> | unknown;
  updateJobStatus?: (
    jobId: string,
    status: "queued_locally" | "submitting" | "upload_waiting_for_login" | "uploaded_to_nibi" | "upload_failed",
    options?: { remoteJobDir?: string; remoteInputPath?: string; remoteOutputPath?: string; submissionId?: string; errorMessage?: string; completedAt?: string },
  ) => Promise<unknown> | unknown;
  addJobEvent?: (
    jobId: string,
    eventType: string,
    message?: string,
    createdAt?: string,
  ) => Promise<unknown> | unknown;
};

const remotePathUnsafePattern = /[\0\r\n;&|`$<>]/;
const safeJobIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function assertSafeJobId(jobId: string) {
  if (!safeJobIdPattern.test(jobId) || jobId.includes("..")) {
    throw new RemoteExecutionError("Job ID contains unsafe path characters.", "unsafe_remote_path");
  }
}

function normalizeAbsoluteRemotePath(path: string, label: string) {
  const normalized = path.trim().replace(/\/+/g, "/").replace(/\/$/, "");
  if (!normalized.startsWith("/")) {
    throw new RemoteExecutionError(`${label} must be an absolute remote path.`, "unsafe_remote_path");
  }
  if (remotePathUnsafePattern.test(normalized)) {
    throw new RemoteExecutionError(`${label} contains unsupported shell characters.`, "unsafe_remote_path");
  }
  for (const part of normalized.split("/")) {
    if (part === "..") {
      throw new RemoteExecutionError(`${label} cannot contain path traversal.`, "unsafe_remote_path");
    }
  }
  return normalized;
}

export function joinRemoteJobPath(remoteJobsPath: string, jobId: string) {
  assertSafeJobId(jobId);
  const root = normalizeAbsoluteRemotePath(remoteJobsPath, "Remote jobs path");
  return `${root}/${jobId}`;
}

export function joinRemoteChildPath(remoteJobDir: string, filename: "input.json" | "output.json" | "stdout.log" | "stderr.log") {
  const normalizedJobDir = normalizeAbsoluteRemotePath(remoteJobDir, "Remote job directory");
  return `${normalizedJobDir}/${filename}`;
}

async function writeTemporaryInputFile(jobInput: PredictionJobInput): Promise<string> {
  return invoke<string>("write_prediction_input_temp_file", {
    jobId: jobInput.job_id,
    inputJson: JSON.stringify(jobInput, null, 2),
  });
}

async function recordEvent(
  persistence: PredictionUploadPersistence | undefined,
  jobId: string,
  eventType: string,
  message: string,
) {
  await persistence?.addJobEvent?.(jobId, eventType, message);
}

export async function uploadPredictionInput(
  jobInput: PredictionJobInput,
  settings: NibiSettings,
  remoteExecutor: RemoteExecutor,
  persistence?: PredictionUploadPersistence,
): Promise<PredictionInputUploadResult> {
  const trimmed = trimNibiSettings(settings);
  const remote_job_dir = joinRemoteJobPath(trimmed.remote_jobs_path, jobInput.job_id);
  const submission_id = jobInput.job_id;
  const remote_input_path = joinRemoteChildPath(remote_job_dir, "input.json");
  const remote_output_path = joinRemoteChildPath(remote_job_dir, "output.json");
  const mode = remoteExecutor.getMode();

  await persistence?.saveJob?.({
    id: jobInput.job_id,
    molecule_smiles: jobInput.molecule_smiles,
    solvent_smiles: jobInput.solvent_smiles,
    model_choice: jobInput.model_choice,
    status: "submitting",
    created_at: jobInput.requested_at,
    submission_id,
  });
  await recordEvent(persistence, jobInput.job_id, "created_input_json", "created input JSON");

  if (
    mode === "interactive_mfa"
    && trimmed.manual_mfa_provider !== "terminal_action"
    && remoteExecutor.getConnectionStatus(trimmed).state !== "authenticated"
  ) {
    const error = appError("interactive_login_required");
    await persistence?.updateJobStatus?.(jobInput.job_id, "upload_waiting_for_login", {
      errorMessage: error.message,
    });
    await recordEvent(persistence, jobInput.job_id, "waiting_for_nibi_login", "waiting for NIBI login");
    throw new RemoteExecutionError(error.message, "manual_session_not_authenticated");
  }

  if (mode === "robot_automation" && !trimmed.robot_access_verified) {
    const error = appError("robot_access_not_ready");
    await persistence?.updateJobStatus?.(jobInput.job_id, "upload_waiting_for_login", {
      errorMessage: error.message,
    });
    await recordEvent(persistence, jobInput.job_id, "waiting_for_nibi_login", "waiting for NIBI login");
    throw new RemoteExecutionError(error.message, "robot_access_not_verified");
  }

  try {
    const localInputPath = await writeTemporaryInputFile(jobInput);
    const createDirectoryResult = await remoteExecutor.runCommand({
      label: "Create remote prediction job directory",
      executable: "mkdir",
      args: ["-p", remote_job_dir],
      settings: trimmed,
      redacted_preview: "mkdir -p <remote_job_dir>",
    });
    if (createDirectoryResult.exit_code !== 0) {
      throw new RemoteExecutionError(
        createDirectoryResult.stderr || "Could not create remote job directory.",
        "remote_directory_create_failed",
      );
    }
    await recordEvent(persistence, jobInput.job_id, "created_remote_job_directory", "created remote job directory");

    await remoteExecutor.uploadFile(localInputPath, remote_input_path, trimmed);
    await persistence?.updateJobStatus?.(jobInput.job_id, "uploaded_to_nibi", {
      remoteJobDir: remote_job_dir,
      remoteInputPath: remote_input_path,
      remoteOutputPath: remote_output_path,
      submissionId: submission_id,
    });
    await recordEvent(persistence, jobInput.job_id, "uploaded_input_json", "uploaded input JSON");

    return {
      remote_job_dir,
      remote_input_path,
      remote_output_path,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Remote upload failed.";
    await persistence?.updateJobStatus?.(jobInput.job_id, "upload_failed", {
      completedAt: new Date().toISOString(),
      errorMessage: message,
    });
    await recordEvent(persistence, jobInput.job_id, "upload_failed", "upload failed");
    throw error;
  }
}
