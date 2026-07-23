import type { StoredPredictionJob } from "../../features/jobs";
import type { NibiSettings } from "../../features/settings";
import { trimNibiSettings } from "../../features/settings";
import { addJobEvent, updateJobStatus } from "../db";
import type { RemoteExecutor } from "./RemoteExecutor";
import { classifyRemoteCommandFailure, type AppError } from "./errors";

export type SlurmCancellationResult = {
  jobId: string;
  status: "cancelled" | "connection_failed";
  message: string;
  technicalDetails?: string;
  appError?: AppError;
};

export type SlurmCancellationPersistence = {
  updateJobStatus: typeof updateJobStatus;
  addJobEvent: typeof addJobEvent;
};

const defaultPersistence: SlurmCancellationPersistence = {
  updateJobStatus,
  addJobEvent,
};

export async function cancelSlurmJob(
  job: StoredPredictionJob,
  settings: NibiSettings,
  remoteExecutor: RemoteExecutor,
  persistence: SlurmCancellationPersistence = defaultPersistence,
): Promise<SlurmCancellationResult> {
  if (!job.remote_slurm_id) {
    const result: SlurmCancellationResult = {
      jobId: job.id,
      status: "connection_failed",
      message: "Cannot cancel this job because no Slurm job ID is recorded.",
    };
    await persistence.updateJobStatus(job.id, "connection_failed", { errorMessage: result.message });
    return result;
  }

  await persistence.addJobEvent(job.id, "slurm_cancellation_requested", `Cancellation requested for Slurm job ${job.remote_slurm_id}.`);
  const scancel = await remoteExecutor.runCommand({
    label: "Cancel Slurm job",
    executable: "scancel",
    args: [job.remote_slurm_id],
    settings: trimNibiSettings(settings),
    redacted_preview: "scancel <job_id>",
  });

  if (scancel.exit_code !== 0) {
    const error = classifyRemoteCommandFailure(scancel, "slurm_poll");
    const result: SlurmCancellationResult = {
      jobId: job.id,
      status: "connection_failed",
      message: error.message,
      technicalDetails: error.technicalDetails,
      appError: error,
    };
    await persistence.updateJobStatus(job.id, "connection_failed", {
      errorMessage: [result.message, result.technicalDetails].filter(Boolean).join("\n\n"),
    });
    return result;
  }

  const completedAt = new Date().toISOString();
  const result: SlurmCancellationResult = {
    jobId: job.id,
    status: "cancelled",
    message: `Slurm job ${job.remote_slurm_id} cancelled.`,
  };
  await persistence.updateJobStatus(job.id, "cancelled", {
    completedAt,
    errorMessage: result.message,
  });
  await persistence.addJobEvent(job.id, "slurm_cancelled", result.message, completedAt);
  return result;
}
