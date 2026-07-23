import { describe, expect, it } from "vitest";
import validOutput from "../../../tests/fixtures/prediction-output.success.example.json";
import type { PredictionJobOutput } from "../schemas";
import {
  createDatabaseRepository,
  jobRowToStoredJob,
  parsePredictionResult,
  serializePredictionResult,
} from "./index";

describe("database pure helpers", () => {
  it("maps database job rows to app jobs", () => {
    expect(
      jobRowToStoredJob({
        id: "job-1",
        molecule_smiles: "CCO",
        solvent_smiles: "O",
        model_choice: "rf",
        status: "completed",
        local_created_at: "2026-07-03T14:30:00.000Z",
        local_completed_at: "2026-07-03T14:31:00.000Z",
        remote_slurm_id: null,
        remote_job_dir: "/scratch/job-1",
        remote_input_path: "/scratch/job-1/input.json",
        remote_output_path: "/scratch/job-1/output.json",
        submitted_at: "2026-07-03T14:30:30.000Z",
        error_message: null,
      }),
    ).toEqual({
      id: "job-1",
      molecule_smiles: "CCO",
      solvent_smiles: "O",
      model_choice: "rf",
      status: "completed",
      created_at: "2026-07-03T14:30:00.000Z",
      completed_at: "2026-07-03T14:31:00.000Z",
      remote_job_dir: "/scratch/job-1",
      remote_input_path: "/scratch/job-1/input.json",
      remote_output_path: "/scratch/job-1/output.json",
      submitted_at: "2026-07-03T14:30:30.000Z",
    });
  });

  it("round trips and validates persisted result JSON", () => {
    const output = { ...validOutput, job_id: "job-1" } as PredictionJobOutput;

    expect(parsePredictionResult(serializePredictionResult(output))).toMatchObject({
      job_id: "job-1",
      status: "succeeded",
      predictions: expect.any(Array),
    });
  });

  it("round trips Hybrid metadata and missing confidence through persisted result JSON", () => {
    const output = {
      ...validOutput,
      job_id: "job-1",
      predictions: [{
        ...validOutput.predictions[0],
        model_name: "hybrid",
        confidence_label: undefined,
        outside_applicability_domain: false,
        prediction_intervals: {
          quantum_yield: { lower: -0.23344108221592028, upper: 0.9, coverage: 0.9 },
        },
        applicability_domain: {
          outside_applicability_domain: false,
          targets: {
            absorption: { outside_applicability_domain: false },
          },
        },
        brightness_class: "dim",
      }],
    } as PredictionJobOutput;

    const parsed = parsePredictionResult(serializePredictionResult(output));

    expect(parsed.status).toBe("succeeded");
    if (parsed.status !== "succeeded") return;
    expect(parsed.predictions[0].confidence_label).toBeUndefined();
    expect(parsed.predictions[0].prediction_intervals?.quantum_yield?.lower).toBe(-0.23344108221592028);
    expect(parsed.predictions[0].applicability_domain?.targets?.absorption?.outside_applicability_domain).toBe(false);
    expect(parsed.predictions[0].brightness_class).toBe("dim");
  });

  it("returns a persisted job with a parsed and validated result", async () => {
    const output = { ...validOutput, job_id: "job-1" } as PredictionJobOutput;
    const repository = createDatabaseRepository(async () => ({
      execute: async () => ({ rowsAffected: 0 }),
      select: async () => [
        {
          id: "job-1",
          molecule_smiles: "CCO",
          solvent_smiles: "O",
          model_choice: "rf",
          status: "completed",
          local_created_at: "2026-07-03T14:30:00.000Z",
          local_completed_at: "2026-07-03T14:31:00.000Z",
          remote_slurm_id: null,
          remote_job_dir: null,
          remote_input_path: null,
          remote_output_path: null,
          submitted_at: null,
          error_message: null,
          job_id: "job-1",
          output_json: serializePredictionResult(output),
          downloaded_at: "2026-07-03T14:31:00.000Z",
        },
      ],
    }));

    await expect(repository.getJobWithResult("job-1")).resolves.toMatchObject({
      id: "job-1",
      status: "completed",
      output: {
        job_id: "job-1",
        status: "succeeded",
        predictions: expect.any(Array),
      },
    });
  });

  it("persists result JSON into the results table", async () => {
    const output = { ...validOutput, job_id: "job-1" } as PredictionJobOutput;
    const calls: Array<{ query: string; bindValues?: unknown[] }> = [];
    const repository = createDatabaseRepository(async () => ({
      execute: async (query, bindValues) => {
        calls.push({ query, bindValues });
        return { rowsAffected: 1 };
      },
      select: async () => [],
    }));

    await repository.saveResult("job-1", output, "2026-07-03T14:31:00.000Z");

    expect(calls[0].query).toContain("INSERT INTO results");
    expect(calls[0].bindValues).toEqual([
      "job-1",
      serializePredictionResult(output),
      "2026-07-03T14:31:00.000Z",
    ]);
  });

  it("returns a completed job without output when the result row is missing", async () => {
    const repository = createDatabaseRepository(async () => ({
      execute: async () => ({ rowsAffected: 0 }),
      select: async () => [
        {
          id: "job-1",
          molecule_smiles: "CCO",
          solvent_smiles: "O",
          model_choice: "rf",
          status: "completed",
          local_created_at: "2026-07-03T14:30:00.000Z",
          local_completed_at: "2026-07-03T14:31:00.000Z",
          remote_slurm_id: null,
          remote_job_dir: null,
          remote_input_path: null,
          remote_output_path: null,
          submitted_at: null,
          error_message: null,
          job_id: null,
          output_json: null,
          downloaded_at: null,
        },
      ],
    }));

    await expect(repository.getJobWithResult("job-1")).resolves.toEqual({
      id: "job-1",
      molecule_smiles: "CCO",
      solvent_smiles: "O",
      model_choice: "rf",
      status: "completed",
      created_at: "2026-07-03T14:30:00.000Z",
      completed_at: "2026-07-03T14:31:00.000Z",
    });
  });

  it("reports diagnostics counts and latest result validation", async () => {
    const output = { ...validOutput, job_id: "job-1" } as PredictionJobOutput;
    const repository = createDatabaseRepository(async () => ({
      execute: async () => ({ rowsAffected: 0 }),
      select: async (query: string, bindValues?: unknown[]) => {
        if (query.includes("sqlite_master")) return bindValues?.[0] ? [{ name: bindValues[0] }] : [];
        if (query.includes("COUNT(*)") && query.includes("jobs")) return [{ count: 2 }];
        if (query.includes("COUNT(*)") && query.includes("results")) return [{ count: 1 }];
        if (query.includes("SELECT id, status FROM jobs")) return [{ id: "job-1", status: "completed" }];
        if (query.includes("SELECT job_id, output_json")) {
          return [{
            job_id: "job-1",
            output_json: serializePredictionResult(output),
            output_json_length: serializePredictionResult(output).length,
            downloaded_at: "2026-07-03T14:31:00.000Z",
          }];
        }
        if (query.includes("FROM jobs")) {
          return [{
            id: "job-1",
            status: "completed",
            local_created_at: "2026-07-03T14:30:00.000Z",
            local_completed_at: "2026-07-03T14:31:00.000Z",
          }];
        }
        if (query.includes("FROM results")) {
          return [{
            job_id: "job-1",
            output_json_length: serializePredictionResult(output).length,
            downloaded_at: "2026-07-03T14:31:00.000Z",
          }];
        }
        return [];
      },
    }));

    await expect(repository.getDatabaseDiagnostics()).resolves.toMatchObject({
      initializedSuccessfully: true,
      jobsCount: 2,
      resultsCount: 1,
      latestJobId: "job-1",
      latestResultJobId: "job-1",
      latestOutputJsonParsesAsJson: true,
      latestOutputJsonValidates: true,
    });
  });
});
