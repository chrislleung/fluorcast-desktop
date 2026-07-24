import { describe, expect, it, vi } from "vitest";
import validOutput from "../../../tests/fixtures/prediction-output.success.example.json";
import type { PredictionJobOutput } from "../schemas";
import {
  createDatabaseRepository,
  DatabaseDeleteJobError,
  JOB_NOTE_MAX_LENGTH,
  jobRowToStoredJob,
  normalizeJobNote,
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
        note: "Reviewed locally\nlooks good",
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
      note: "Reviewed locally\nlooks good",
    });
  });

  it("migrates an existing jobs table by adding a nullable note column", async () => {
    const calls: Array<{ query: string; bindValues?: unknown[] }> = [];
    const repository = createDatabaseRepository(async () => ({
      execute: async (query, bindValues) => {
        calls.push({ query, bindValues });
        return { rowsAffected: 0 };
      },
      select: async (query: string, bindValues?: unknown[]) => {
        if (query.includes("PRAGMA table_info(jobs)")) {
          return [
            { name: "id" },
            { name: "molecule_smiles" },
            { name: "solvent_smiles" },
            { name: "model_choice" },
            { name: "status" },
            { name: "local_created_at" },
            { name: "local_completed_at" },
          ];
        }
        if (query.includes("sqlite_master")) return bindValues?.[0] ? [{ name: bindValues[0] }] : [];
        return [];
      },
    }));

    await expect(repository.initializeDatabase()).resolves.toBe(true);
    expect(calls.some((call) => call.query.includes("ALTER TABLE jobs ADD COLUMN note TEXT"))).toBe(true);
  });

  it("loads existing jobs without a note as empty local note state", async () => {
    const repository = createDatabaseRepository(async () => ({
      execute: async () => ({ rowsAffected: 0 }),
      select: async () => [{
        id: "job-1",
        molecule_smiles: "CCO",
        solvent_smiles: "O",
        model_choice: "rf",
        status: "completed",
        local_created_at: "2026-07-03T14:30:00.000Z",
        local_completed_at: null,
        remote_slurm_id: null,
        remote_job_dir: null,
        remote_input_path: null,
        remote_output_path: null,
        submitted_at: null,
        error_message: null,
        note: null,
      }],
    }));

    await expect(repository.listJobs()).resolves.toEqual([
      expect.not.objectContaining({ note: expect.anything() }),
    ]);
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
          note: "Line one\nLine two 'quoted'",
          job_id: "job-1",
          output_json: serializePredictionResult(output),
          downloaded_at: "2026-07-03T14:31:00.000Z",
        },
      ],
    }));

    await expect(repository.getJobWithResult("job-1")).resolves.toMatchObject({
      id: "job-1",
      status: "completed",
      note: "Line one\nLine two 'quoted'",
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

  it("saves and removes notes with parameterized SQL", async () => {
    const calls: Array<{ query: string; bindValues?: unknown[] }> = [];
    const repository = createDatabaseRepository(async () => ({
      execute: async (query, bindValues) => {
        calls.push({ query, bindValues });
        return { rowsAffected: 1 };
      },
      select: async () => [],
    }));
    const note = "Line 1\nUnicode: λ\napostrophe's text; DROP TABLE jobs;";

    await repository.updateJobNote("job-1", note);
    await repository.updateJobNote("job-1", "   ");

    expect(calls[0].query).toBe("UPDATE jobs SET note = $1 WHERE id = $2");
    expect(calls[0].bindValues).toEqual([note, "job-1"]);
    expect(calls[1].bindValues).toEqual([null, "job-1"]);
  });

  it("normalizes whitespace notes and enforces the note length limit", () => {
    expect(normalizeJobNote(" \n\t ")).toBeNull();
    expect(normalizeJobNote("  keep me  ")).toBe("keep me");
    expect(normalizeJobNote("a".repeat(JOB_NOTE_MAX_LENGTH))).toHaveLength(JOB_NOTE_MAX_LENGTH);
    expect(() => normalizeJobNote("a".repeat(JOB_NOTE_MAX_LENGTH + 1))).toThrow(RangeError);
  });

  it("updates one job note without touching another job", async () => {
    const calls: Array<{ query: string; bindValues?: unknown[] }> = [];
    const repository = createDatabaseRepository(async () => ({
      execute: async (query, bindValues) => {
        calls.push({ query, bindValues });
        return { rowsAffected: 1 };
      },
      select: async () => [],
    }));

    await repository.updateJobNote("job-1", "job-1 note");

    expect(calls).toEqual([{
      query: "UPDATE jobs SET note = $1 WHERE id = $2",
      bindValues: ["job-1 note", "job-1"],
    }]);
  });

  it("permanently deletes associated local rows for only the target job", async () => {
    const calls: Array<{ query: string; bindValues?: unknown[] }> = [];
    const repository = createDatabaseRepository(async () => ({
      execute: async (query, bindValues) => {
        calls.push({ query, bindValues });
        return { rowsAffected: query.includes("DELETE FROM jobs") ? 1 : 2 };
      },
      select: async (query: string) => {
        if (query.includes("COUNT(*)")) return [{ count: 1 }];
        if (query.includes("PRAGMA foreign_keys")) return [{ foreign_keys: 0 }];
        return [];
      },
    }));

    await expect(repository.deleteJobPermanently("job-1")).resolves.toBe(true);

    expect(calls.map((call) => call.query)).toEqual([
      "BEGIN IMMEDIATE TRANSACTION",
      "DELETE FROM job_events WHERE job_id = $1",
      "DELETE FROM results WHERE job_id = $1",
      "DELETE FROM jobs WHERE id = $1",
      "COMMIT",
    ]);
    expect(calls.slice(1, 4).map((call) => call.bindValues)).toEqual([
      ["job-1"],
      ["job-1"],
      ["job-1"],
    ]);
  });

  it("uses the native transaction delete path when available", async () => {
    const calls: string[] = [];
    const nativeDelete = vi.fn(async () => true);
    const repository = createDatabaseRepository(
      async () => ({
        execute: async (query) => {
          calls.push(query);
          return { rowsAffected: 1 };
        },
        select: async () => [],
      }),
      nativeDelete,
    );

    await expect(repository.deleteJobPermanently("job-1")).resolves.toBe(true);

    expect(nativeDelete).toHaveBeenCalledWith("job-1");
    expect(calls).toEqual([]);
  });

  it("returns false without deleting dependencies when the job is already gone", async () => {
    const calls: string[] = [];
    const repository = createDatabaseRepository(async () => ({
      execute: async (query) => {
        calls.push(query);
        return { rowsAffected: 1 };
      },
      select: async (query: string) => {
        if (query.includes("COUNT(*)")) return [{ count: 0 }];
        return [];
      },
    }));

    await expect(repository.deleteJobPermanently("job-1")).resolves.toBe(false);
    expect(calls).toEqual([]);
  });

  it("rolls back permanent deletion atomically when a dependent delete fails", async () => {
    const calls: string[] = [];
    const repository = createDatabaseRepository(async () => ({
      execute: async (query) => {
        calls.push(query);
        if (query.includes("DELETE FROM results")) {
          throw new Error("dependent delete failed");
        }
        return { rowsAffected: 1 };
      },
      select: async (query: string) => {
        if (query.includes("COUNT(*)")) return [{ count: 1 }];
        if (query.includes("PRAGMA foreign_keys")) return [{ foreign_keys: 1 }];
        return [];
      },
    }));

    try {
      await repository.deleteJobPermanently("job-1");
      throw new Error("Expected permanent delete to fail.");
    } catch (error) {
      expect(error).toBeInstanceOf(DatabaseDeleteJobError);
      expect(error).toMatchObject({
        operation: "delete results row",
        statement: "DELETE FROM results WHERE job_id = $1",
      });
      expect(error).toHaveProperty(
        "message",
        "Local job could not be deleted. delete results row failed: dependent delete failed",
      );
    }
    expect(calls).toEqual([
      "BEGIN IMMEDIATE TRANSACTION",
      "DELETE FROM job_events WHERE job_id = $1",
      "DELETE FROM results WHERE job_id = $1",
      "ROLLBACK",
    ]);
    expect(calls).not.toContain("DELETE FROM jobs WHERE id = $1");
  });

  it("exposes the failed permanent-delete operation and sanitized SQLite error", async () => {
    const repository = createDatabaseRepository(async () => ({
      execute: async (query) => {
        if (query.includes("COMMIT")) {
          throw new Error("error returned from database: (code: 1) cannot commit - no transaction is active");
        }
        return { rowsAffected: 1 };
      },
      select: async (query: string) => {
        if (query.includes("COUNT(*)")) return [{ count: 1 }];
        if (query.includes("PRAGMA foreign_keys")) return [{ foreign_keys: 0 }];
        return [];
      },
    }));

    await expect(repository.deleteJobPermanently("job-1")).rejects.toMatchObject({
      operation: "commit permanent local job delete transaction",
      statement: "COMMIT",
      technicalDetails: expect.stringContaining("DB_ERROR=error returned from database: (code: 1) cannot commit - no transaction is active"),
    });
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
