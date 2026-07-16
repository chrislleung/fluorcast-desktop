import type { LocalPredictionJob } from "../../lib/mock";
import type { PredictionJobOutput } from "../../lib/schemas";

export type StoredJobStatus = "queued_locally" | "running" | "completed" | "failed";

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
  output?: PredictionJobOutput;
  error_message?: string;
};

export type JobsState = {
  jobs: StoredPredictionJob[];
};

export type JobsAction =
  | { type: "set_jobs"; jobs: StoredPredictionJob[] }
  | { type: "add_job"; job: StoredPredictionJob }
  | { type: "update_status"; id: string; status: Exclude<StoredJobStatus, "completed" | "failed"> }
  | { type: "complete_job"; id: string; completed_at: string; output: PredictionJobOutput }
  | { type: "fail_job"; id: string; completed_at: string; error_message: string };

export const initialJobsState: JobsState = {
  jobs: [],
};

function replaceJob(
  state: JobsState,
  id: string,
  update: (job: StoredPredictionJob) => StoredPredictionJob,
): JobsState {
  return {
    jobs: state.jobs.map((job) => (job.id === id ? update(job) : job)),
  };
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
      return replaceJob(state, action.id, (job) => ({
        ...job,
        status: action.status,
      }));
    case "complete_job":
      return replaceJob(state, action.id, (job) => ({
        ...job,
        status: "completed",
        completed_at: action.completed_at,
        output: action.output,
        error_message: undefined,
      }));
    case "fail_job":
      return replaceJob(state, action.id, (job) => ({
        ...job,
        status: "failed",
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
