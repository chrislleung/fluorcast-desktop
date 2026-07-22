import type { LocalPredictionJob } from "../../lib/mock";
import type { PredictionJobOutput } from "../../lib/schemas";

export type StoredJobStatus =
  | "queued_locally"
  | "submitting"
  | "upload_waiting_for_login"
  | "uploaded_to_nibi"
  | "upload_failed"
  | "queued"
  | "submitted_to_slurm"
  | "slurm_submission_failed"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed_out"
  // Legacy value kept readable for jobs saved before the Slurm status rename.
  | "timeout"
  | "login_required"
  | "robot_access_required"
  | "robot_auth_failed"
  | "connection_failed"
  | "output_missing"
  | "output_invalid"
  | "download_failed"
  | "unknown";

export type StoredPredictionJob = {
  id: string;
  molecule_smiles: string;
  solvent_smiles: string;
  model_choice: string;
  status: StoredJobStatus;
  created_at: string;
  completed_at?: string;
  remote_slurm_id?: string;
  remote_job_dir?: string;
  remote_input_path?: string;
  remote_output_path?: string;
  submission_id?: string;
  submitted_at?: string;
  slurm_state?: string;
  slurm_exit_code?: string;
  slurm_stdout?: string;
  slurm_stderr?: string;
  submitted_command?: string;
  output?: PredictionJobOutput;
  error_message?: string;
};

export type JobsState = {
  jobs: StoredPredictionJob[];
};

export type JobsAction =
  | { type: "set_jobs"; jobs: StoredPredictionJob[] }
  | { type: "add_job"; job: StoredPredictionJob }
  | { type: "update_status"; id: string; status: Exclude<StoredJobStatus, "completed" | "failed" | "upload_failed">; remote_job_dir?: string; remote_input_path?: string; remote_output_path?: string; remote_slurm_id?: string; submission_id?: string; submitted_at?: string; slurm_state?: string; slurm_exit_code?: string; slurm_stdout?: string; slurm_stderr?: string; submitted_command?: string; error_message?: string }
  | { type: "patch_job"; id: string; patch: Partial<StoredPredictionJob> }
  | { type: "complete_job"; id: string; completed_at: string; output: PredictionJobOutput }
  | { type: "fail_job"; id: string; completed_at: string; error_message: string }
  | { type: "upload_failed"; id: string; completed_at: string; error_message: string };

export const initialJobsState: JobsState = {
  jobs: [],
};

function replaceJob(
  state: JobsState,
  id: string,
  update: (job: StoredPredictionJob) => StoredPredictionJob,
): JobsState {
  let changed = false;
  const jobs = state.jobs.map((job) => {
    if (job.id !== id) {
      return job;
    }
    const nextJob = update(job);
    changed ||= nextJob !== job;
    return nextJob;
  });
  return changed ? { jobs } : state;
}

function shallowEqualJob(a: StoredPredictionJob, b: StoredPredictionJob) {
  const aKeys = Object.keys(a) as Array<keyof StoredPredictionJob>;
  const bKeys = Object.keys(b) as Array<keyof StoredPredictionJob>;
  return aKeys.length === bKeys.length
    && aKeys.every((key) => Object.is(a[key], b[key]));
}

function unchangedOrNext(job: StoredPredictionJob, nextJob: StoredPredictionJob) {
  return shallowEqualJob(job, nextJob) ? job : nextJob;
}

export function jobsReducer(state: JobsState, action: JobsAction): JobsState {
  switch (action.type) {
    case "set_jobs":
      return {
        jobs: action.jobs,
      };
    case "add_job":
      return {
        jobs: [
          action.job,
          ...state.jobs.filter((job) => job.id !== action.job.id),
        ],
      };
    case "update_status":
      return replaceJob(state, action.id, (job) => unchangedOrNext(job, {
        ...job,
        status: action.status,
        ...(action.remote_job_dir ? { remote_job_dir: action.remote_job_dir } : {}),
        ...(action.remote_input_path ? { remote_input_path: action.remote_input_path } : {}),
        ...(action.remote_output_path ? { remote_output_path: action.remote_output_path } : {}),
        ...(action.remote_slurm_id ? { remote_slurm_id: action.remote_slurm_id } : {}),
        ...(action.submission_id ? { submission_id: action.submission_id } : {}),
        ...(action.submitted_at ? { submitted_at: action.submitted_at } : {}),
        ...(action.slurm_state ? { slurm_state: action.slurm_state } : {}),
        ...(action.slurm_exit_code ? { slurm_exit_code: action.slurm_exit_code } : {}),
        ...(action.slurm_stdout ? { slurm_stdout: action.slurm_stdout } : {}),
        ...(action.slurm_stderr ? { slurm_stderr: action.slurm_stderr } : {}),
        ...(action.submitted_command ? { submitted_command: action.submitted_command } : {}),
        error_message: action.error_message,
      }));
    case "patch_job":
      return replaceJob(state, action.id, (job) => unchangedOrNext(job, {
        ...job,
        ...action.patch,
      }));
    case "complete_job":
      return replaceJob(state, action.id, (job) => unchangedOrNext(job, {
        ...job,
        status: "completed",
        completed_at: action.completed_at,
        output: action.output,
        error_message: undefined,
      }));
    case "fail_job":
      return replaceJob(state, action.id, (job) => unchangedOrNext(job, {
        ...job,
        status: "failed",
        completed_at: action.completed_at,
        error_message: action.error_message,
      }));
    case "upload_failed":
      return replaceJob(state, action.id, (job) => unchangedOrNext(job, {
        ...job,
        status: "upload_failed",
        completed_at: action.completed_at,
        error_message: action.error_message,
      }));
  }
}

export function createStoredJobFromLocalJob(job: LocalPredictionJob): StoredPredictionJob {
  return {
    id: job.job_id,
    molecule_smiles: job.input.molecule_smiles,
    solvent_smiles: job.input.solvent_smiles,
    model_choice: job.input.model_choice,
    status: job.status,
    created_at: job.created_at,
    ...(job.output ? { completed_at: job.output.completed_at, output: job.output } : {}),
  };
}
