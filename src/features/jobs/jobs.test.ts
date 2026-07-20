import { describe, expect, it } from "vitest";
import validOutput from "../../../tests/fixtures/prediction-output.success.example.json";
import type { PredictionJobOutput } from "../../lib/schemas";
import {
  initialJobsState,
  jobsReducer,
  type StoredPredictionJob,
} from "./index";

const baseJob: StoredPredictionJob = {
  id: "job-1",
  molecule_smiles: "C1=CC=CC=C1",
  solvent_smiles: "O",
  model_choice: "rf",
  status: "queued_locally",
  created_at: "2026-07-03T14:30:00.000Z",
};

describe("jobsReducer", () => {
  it("adds submitted jobs to the front of history", () => {
    const firstState = jobsReducer(initialJobsState, {
      type: "add_job",
      job: baseJob,
    });
    const secondState = jobsReducer(firstState, {
      type: "add_job",
      job: { ...baseJob, id: "job-2", molecule_smiles: "CCO" },
    });

    expect(secondState.jobs.map((job) => job.id)).toEqual(["job-2", "job-1"]);
  });

  it("updates loading status for an existing job", () => {
    const state = jobsReducer({ jobs: [baseJob] }, {
      type: "update_status",
      id: "job-1",
      status: "running",
    });

    expect(state.jobs[0].status).toBe("running");
  });

  it("stores completed output", () => {
    const output = { ...validOutput, job_id: "job-1" } as PredictionJobOutput;
    const state = jobsReducer({ jobs: [baseJob] }, {
      type: "complete_job",
      id: "job-1",
      completed_at: "2026-07-03T14:34:12.000Z",
      output,
    });

    expect(state.jobs[0]).toMatchObject({
      status: "completed",
      completed_at: "2026-07-03T14:34:12.000Z",
      output,
    });
  });

  it("stores failed job errors", () => {
    const state = jobsReducer({ jobs: [baseJob] }, {
      type: "fail_job",
      id: "job-1",
      completed_at: "2026-07-03T14:34:12.000Z",
      error_message: "Mock backend failed",
    });

    expect(state.jobs[0]).toMatchObject({
      status: "failed",
      error_message: "Mock backend failed",
    });
  });

  it("stores upload status and remote job directory", () => {
    const state = jobsReducer({ jobs: [baseJob] }, {
      type: "update_status",
      id: "job-1",
      status: "uploaded_to_nibi",
      remote_job_dir: "/home/user/scratch/fluorcast-jobs/job-1",
    });

    expect(state.jobs[0]).toMatchObject({
      status: "uploaded_to_nibi",
      remote_job_dir: "/home/user/scratch/fluorcast-jobs/job-1",
    });
  });

  it("stores upload failures", () => {
    const state = jobsReducer({ jobs: [baseJob] }, {
      type: "upload_failed",
      id: "job-1",
      completed_at: "2026-07-03T14:34:12.000Z",
      error_message: "Upload failed",
    });

    expect(state.jobs[0]).toMatchObject({
      status: "upload_failed",
      error_message: "Upload failed",
    });
  });
});
