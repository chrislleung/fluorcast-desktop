import { describe, expect, it } from "vitest";
import flatRemoteOutput from "../../../tests/fixtures/remote-output.flat-success.example.json";
import { validatePredictionJobOutput } from "../schemas";
import {
  adaptFlatRemotePredictionOutput,
  deriveCompletionTimestamp,
  parseRemoteOutputJsonForImport,
} from "./remotePredictionOutputAdapter";

const localJobId = "2e80b1b9-f65f-426a-a289-1466ab7f0abd";

describe("remote prediction output adapter", () => {
  it("imports the actual flat remote success payload without an output wrapper or remote completed_at", () => {
    const { output, diagnostics } = adaptFlatRemotePredictionOutput(flatRemoteOutput, {
      localJobId,
      completion: {
        remoteFileMtime: "1780000000000",
        importTime: "2026-07-22T12:00:00.000Z",
      },
    });

    expect(output).toMatchObject({
      job_id: localJobId,
      status: "succeeded",
      completed_at: "2026-05-28T20:26:40.000Z",
      completed_at_source: "remote_file_mtime",
      canonical_molecule_smiles: "CCO",
      canonical_solvent_smiles: "O",
    });
    expect(output.predictions).toHaveLength(2);
    expect(diagnostics).toMatchObject({
      jsonSyntaxStatus: "valid",
      remoteSchemaStatus: "valid",
      adapterStatus: "success",
      canonicalSchemaStatus: "valid",
      persistenceStatus: "not_started",
    });
  });

  it("requires the remote job ID to match the local job ID", () => {
    expect(() =>
      adaptFlatRemotePredictionOutput({ ...flatRemoteOutput, job_id: "different-job" }, {
        localJobId,
        completion: { importTime: "2026-07-22T12:00:00.000Z" },
      }),
    ).toThrow(/job_id must match/);
  });

  it("requires a non-empty predictions array", () => {
    expect(() =>
      adaptFlatRemotePredictionOutput({ ...flatRemoteOutput, predictions: [] }, {
        localJobId,
        completion: { importTime: "2026-07-22T12:00:00.000Z" },
      }),
    ).toThrow(/predictions must be a non-empty array/);
  });

  it("preserves nullable targets, negative quantum yield, warnings, and Stokes fields", () => {
    const { output } = adaptFlatRemotePredictionOutput(flatRemoteOutput, {
      localJobId,
      completion: { importTime: "2026-07-22T12:00:00.000Z" },
    });
    const extraTrees = output.predictions[0];
    const mlp = output.predictions[1];

    expect(mlp.predicted_absorption_nm).toBeNull();
    expect(mlp.predicted_quantum_yield).toBe(-0.0015463866293430328);
    expect(mlp.warnings).toEqual(["Absorption model unavailable for this variant."]);
    expect(output.warnings).toEqual([
      "Model file not found; skipping mlp_large_alpha_1e-04 absorption_nm.",
    ]);
    expect(extraTrees.predicted_stokes_shift_nm).toBe(191.11240000000026);
    expect(extraTrees["predicted_stokes_shift_cm^-1"]).toBe(21652.845944993347);
    expect(mlp.predicted_stokes_shift_nm).toBeUndefined();
    expect(validatePredictionJobOutput(output)).toEqual(output);
  });

  it("reports valid JSON separately from schema adaptation failures", () => {
    expect(() =>
      parseRemoteOutputJsonForImport(
        JSON.stringify({
          ...flatRemoteOutput,
          predictions: [{ ...flatRemoteOutput.predictions[0], model_name: "" }],
        }),
        {
          localJobId,
          completion: { importTime: "2026-07-22T12:00:00.000Z" },
        },
      ),
    ).toThrow(/model_name/);

    try {
      parseRemoteOutputJsonForImport(
        JSON.stringify({
          ...flatRemoteOutput,
          predictions: [{ ...flatRemoteOutput.predictions[0], model_name: "" }],
        }),
        {
          localJobId,
          completion: { importTime: "2026-07-22T12:00:00.000Z" },
        },
      );
    } catch (error) {
      expect(error).toMatchObject({
        diagnostics: {
          jsonSyntaxStatus: "valid",
          remoteSchemaStatus: "invalid",
          adapterStatus: "invalid",
          canonicalSchemaStatus: "not_started",
          persistenceStatus: "not_started",
        },
      });
    }
  });

  it("derives completion metadata in the trusted order", () => {
    expect(deriveCompletionTimestamp({
      persistedCompletedAt: "2026-07-22T10:00:00.000Z",
      sacctEnd: "2026-07-22T11:00:00.000Z",
      remoteFileMtime: "1780000000000",
    })).toEqual({ completedAt: "2026-07-22T10:00:00.000Z", source: "slurm" });

    expect(deriveCompletionTimestamp({
      sacctEnd: "2026-07-22T11:00:00.000Z",
      remoteFileMtime: "1780000000000",
    })).toEqual({ completedAt: "2026-07-22T11:00:00.000Z", source: "sacct" });
  });
});
