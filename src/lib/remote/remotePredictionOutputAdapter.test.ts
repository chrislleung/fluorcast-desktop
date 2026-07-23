import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import flatRemoteOutput from "../../../tests/fixtures/remote-output.flat-success.example.json";
import { validatePredictionJobOutput } from "../schemas";
import {
  adaptStructuredRemoteFailureOutput,
  adaptFlatRemotePredictionOutput,
  deriveCompletionTimestamp,
  parseRemoteOutputJsonForImport,
} from "./remotePredictionOutputAdapter";

const localJobId = "2e80b1b9-f65f-426a-a289-1466ab7f0abd";
const authoritativeHybridJobId = "d5607546-105a-4c1a-a4e0-6cb13fcba3d9";
const authoritativeHybridFixturePath = "src/lib/remote/test-fixtures/real-hybrid-output.json";

function basePrediction() {
  return {
    model_name: "hybrid",
    predicted_absorption_nm: 403.2,
    predicted_emission_nm: 515.6,
    predicted_quantum_yield: 0.62,
    predicted_stokes_shift_nm: 112.4,
    "predicted_stokes_shift_cm^-1": 5418.25,
    physically_valid_stokes: true,
    nearest_training_similarity: 0.84,
    nearest_training_smiles: "CCO",
    outside_applicability_domain: false,
    warnings: [],
  };
}

function remoteOutputWith(prediction: Record<string, unknown>) {
  return {
    status: "success",
    job_id: localJobId,
    canonical_molecule_smiles: "CCO",
    canonical_solvent_smiles: "O",
    predictions: [prediction],
    warnings: [],
  };
}

function adaptPrediction(prediction: Record<string, unknown>) {
  return adaptFlatRemotePredictionOutput(remoteOutputWith(prediction), {
    localJobId,
    completion: { importTime: "2026-07-22T12:00:00.000Z" },
  }).output.predictions[0];
}

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

  it("imports Hybrid output without confidence_label and preserves Hybrid metadata", () => {
    const prediction = adaptPrediction({
      ...basePrediction(),
      confidence_label: undefined,
      outside_applicability_domain: undefined,
      prediction_intervals: {
        absorption_nm: { lower: 390.1, upper: 420.2, coverage: 0.9 },
        quantum_yield: { lower: -0.23344108221592028, upper: 0.91, coverage: 0.9 },
      },
      applicability_domain: {
        outside_applicability_domain: false,
        targets: {
          absorption: { outside_applicability_domain: false },
          emission: { outside_applicability_domain: false },
          quantum_yield: { outside_applicability_domain: false },
        },
      },
      brightness_class: "dim",
    });

    expect(prediction.model_name).toBe("hybrid");
    expect(prediction.predicted_absorption_nm).toBe(403.2);
    expect(prediction.confidence_label).toBeUndefined();
    expect(prediction.outside_applicability_domain).toBe(false);
    expect(prediction.applicability_domain?.outside_applicability_domain).toBe(false);
    expect(prediction.prediction_intervals?.quantum_yield?.lower).toBe(-0.23344108221592028);
    expect(prediction.brightness_class).toBe("dim");
  });

  it("imports the authoritative real Hybrid output fixture through the JSON import boundary", () => {
    const fixtureJson = readFileSync(authoritativeHybridFixturePath, "utf8");
    const source = JSON.parse(fixtureJson) as Record<string, unknown>;
    const { output, diagnostics } = parseRemoteOutputJsonForImport(fixtureJson, {
      localJobId: authoritativeHybridJobId,
      completion: { importTime: "2026-07-22T12:00:00.000Z" },
    });
    const prediction = output.predictions[0];

    expect(source.status).toBe("success");
    expect(diagnostics).toMatchObject({
      jsonSyntaxStatus: "valid",
      remoteSchemaStatus: "valid",
      adapterStatus: "success",
      canonicalSchemaStatus: "valid",
    });
    expect(output.status).toBe("succeeded");
    expect(output.job_id).toBe(authoritativeHybridJobId);
    expect(prediction.model_name).toBe("hybrid");
    expect(prediction.predicted_absorption_nm).toBe(320.69705127630357);
    expect(prediction.predicted_emission_nm).toBe(501.3903336407451);
    expect(prediction.predicted_quantum_yield).toBe(0.11199180746552381);
    expect(prediction.predicted_stokes_shift_nm).toBe(180.69328236444153);
    expect(prediction["predicted_stokes_shift_cm^-1"]).toBe(11237.535675197625);
    expect(prediction.physically_valid_stokes).toBe(true);
    expect(prediction.confidence_label).toBeUndefined();
    expect(prediction.confidence_label).not.toBe(prediction.brightness_class);
    expect(prediction.brightness_class).toBe("dim");
    expect(prediction.applicability_domain?.outside_applicability_domain).toBe(false);
    expect(prediction.outside_applicability_domain).toBe(false);
    expect(prediction.prediction_intervals).toEqual({
      absorption_nm: {
        lower: 269.8078535450293,
        upper: 371.58624900757786,
        coverage: 0.9,
      },
      emission_nm: {
        lower: 433.7084180663891,
        upper: 569.0722492151011,
        coverage: 0.9,
      },
      quantum_yield: {
        lower: -0.23344108221592028,
        upper: 0.4574246971469679,
        coverage: 0.9,
      },
    });
    expect(prediction.prediction_intervals?.quantum_yield?.lower).toBe(-0.23344108221592028);
    expect(prediction.prediction_intervals?.quantum_yield?.coverage).toBe(0.9);
  });

  it("preserves valid confidence_label when supplied", () => {
    const prediction = adaptPrediction({ ...basePrediction(), confidence_label: "low-medium" });

    expect(prediction.confidence_label).toBe("low-medium");
  });

  it("rejects invalid confidence_label values", () => {
    expect(() => adaptPrediction({ ...basePrediction(), confidence_label: "" })).toThrow(/confidence_label/);
    expect(() => adaptPrediction({ ...basePrediction(), confidence_label: "   " })).toThrow(/confidence_label/);
    expect(() => adaptPrediction({ ...basePrediction(), confidence_label: 12 })).toThrow(/confidence_label/);
  });

  it("maps flat, nested, and equal applicability-domain values", () => {
    expect(adaptPrediction({ ...basePrediction(), outside_applicability_domain: true }).outside_applicability_domain)
      .toBe(true);
    expect(adaptPrediction({
      ...basePrediction(),
      outside_applicability_domain: undefined,
      applicability_domain: { outside_applicability_domain: true },
    }).outside_applicability_domain).toBe(true);
    expect(adaptPrediction({
      ...basePrediction(),
      outside_applicability_domain: true,
      applicability_domain: { outside_applicability_domain: true },
    }).outside_applicability_domain).toBe(true);
  });

  it("rejects malformed applicability-domain values", () => {
    expect(() => adaptPrediction({
      ...basePrediction(),
      outside_applicability_domain: false,
      applicability_domain: { outside_applicability_domain: true },
    })).toThrow(/conflicts/);
    expect(() => adaptPrediction({
      ...basePrediction(),
      outside_applicability_domain: undefined,
      applicability_domain: { outside_applicability_domain: "false" },
    })).toThrow(/applicability_domain\.outside_applicability_domain/);
    expect(() => adaptPrediction({
      ...basePrediction(),
      applicability_domain: {
        outside_applicability_domain: false,
        targets: { absorption: { outside_applicability_domain: "false" } },
      },
    })).toThrow(/targets\.absorption\.outside_applicability_domain/);
    expect(() => adaptPrediction({
      ...basePrediction(),
      applicability_domain: { outside_applicability_domain: false, extra: false },
    })).toThrow(/applicability_domain\.extra is not supported/);
    expect(() => adaptPrediction({
      ...basePrediction(),
      applicability_domain: {
        outside_applicability_domain: false,
        targets: { lifetime: { outside_applicability_domain: false } },
      },
    })).toThrow(/targets\.lifetime is not supported/);
  });

  it("validates prediction intervals strictly", () => {
    expect(adaptPrediction({
      ...basePrediction(),
      prediction_intervals: {
        emission_nm: { lower: 500, upper: 530, coverage: 0.8 },
      },
    }).prediction_intervals?.emission_nm).toEqual({ lower: 500, upper: 530, coverage: 0.8 });
    expect(adaptPrediction({
      ...basePrediction(),
      prediction_intervals: {
        quantum_yield: { lower: -0.4, upper: 1.2, coverage: 0.95 },
      },
    }).prediction_intervals?.quantum_yield).toEqual({ lower: -0.4, upper: 1.2, coverage: 0.95 });
    expect(() => adaptPrediction({
      ...basePrediction(),
      prediction_intervals: { absorption_nm: { lower: 2, upper: 1, coverage: 0.9 } },
    })).toThrow(/lower/);
    expect(() => adaptPrediction({
      ...basePrediction(),
      prediction_intervals: { absorption_nm: { lower: 1, upper: 2, coverage: -0.1 } },
    })).toThrow(/coverage/);
    expect(() => adaptPrediction({
      ...basePrediction(),
      prediction_intervals: { absorption_nm: { lower: 1, upper: 2, coverage: 1.1 } },
    })).toThrow(/coverage/);
    expect(() => adaptPrediction({
      ...basePrediction(),
      prediction_intervals: { absorption_nm: { lower: Number.NaN, upper: 2, coverage: 0.9 } },
    })).toThrow(/lower/);
    expect(() => adaptPrediction({
      ...basePrediction(),
      prediction_intervals: { absorption_nm: { lower: 1, upper: Number.POSITIVE_INFINITY, coverage: 0.9 } },
    })).toThrow(/upper/);
    expect(() => adaptPrediction({
      ...basePrediction(),
      prediction_intervals: { absorption_nm: { lower: 1, coverage: 0.9 } },
    })).toThrow(/upper/);
    expect(() => adaptPrediction({
      ...basePrediction(),
      prediction_intervals: { absorption_nm: { lower: 1, upper: 2, coverage: "0.9" } },
    })).toThrow(/coverage/);
    expect(() => adaptPrediction({
      ...basePrediction(),
      prediction_intervals: { lifetime: { lower: 1, upper: 2, coverage: 0.9 } },
    })).toThrow(/prediction_intervals\.lifetime is not supported/);
    expect(() => adaptPrediction({
      ...basePrediction(),
      prediction_intervals: { absorption_nm: { lower: 1, upper: 2, coverage: 0.9, median: 1.5 } },
    })).toThrow(/absorption_nm\.median is not supported/);
  });

  it("validates brightness_class without using it as confidence", () => {
    expect(adaptPrediction({ ...basePrediction(), confidence_label: undefined, brightness_class: "bright" }))
      .toMatchObject({ brightness_class: "bright" });
    expect(adaptPrediction({ ...basePrediction(), brightness_class: undefined }).brightness_class).toBeUndefined();
    expect(() => adaptPrediction({ ...basePrediction(), brightness_class: "" })).toThrow(/brightness_class/);
    expect(() => adaptPrediction({ ...basePrediction(), brightness_class: "   " })).toThrow(/brightness_class/);
    expect(() => adaptPrediction({ ...basePrediction(), brightness_class: false })).toThrow(/brightness_class/);
  });

  it("continues rejecting unrelated prediction and top-level fields", () => {
    expect(() => adaptPrediction({ ...basePrediction(), extra: "nope" })).toThrow(/extra is not supported/);
    expect(() => adaptFlatRemotePredictionOutput({ ...remoteOutputWith(basePrediction()), extra: "nope" }, {
      localJobId,
      completion: { importTime: "2026-07-22T12:00:00.000Z" },
    })).toThrow(/remote_output\.extra is not supported/);
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

  it("imports structured remote failures with safe code and message", () => {
    const { output, diagnostics } = adaptStructuredRemoteFailureOutput({
      status: "failed",
      job_id: localJobId,
      error_code: "INVALID_MODEL_CHOICE",
      error_message: "model_choice must be one of: all, extratrees, gbdt, graph_model_later, histgb, hybrid, rf",
      traceback: "Traceback (most recent call last):\nValueError: bad model choice",
      warnings: [],
    }, {
      localJobId,
      completion: { importTime: "2026-07-22T12:00:00.000Z" },
    });

    expect(output).toMatchObject({
      job_id: localJobId,
      status: "failed",
      predictions: [],
      error: "INVALID_MODEL_CHOICE:\nmodel_choice must be one of: all, extratrees, gbdt, graph_model_later, histgb, hybrid, rf",
    });
    expect(diagnostics).toMatchObject({
      remoteSchemaStatus: "valid",
      adapterStatus: "success",
      remoteErrorCode: "INVALID_MODEL_CHOICE",
      remoteErrorMessage: "model_choice must be one of: all, extratrees, gbdt, graph_model_later, histgb, hybrid, rf",
      remoteTraceback: expect.stringContaining("Traceback"),
    });
  });

  it("parses structured remote failures through the JSON import boundary", () => {
    const { output } = parseRemoteOutputJsonForImport(JSON.stringify({
      status: "failed",
      error_code: "INVALID_MODEL_CHOICE",
      error_message: "model_choice must be one of: all, extratrees, gbdt, graph_model_later, histgb, hybrid, rf",
      traceback: "technical traceback",
      warnings: [],
    }), {
      localJobId,
      completion: { importTime: "2026-07-22T12:00:00.000Z" },
    });

    expect(output.status).toBe("failed");
    expect(output.error).toContain("INVALID_MODEL_CHOICE");
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
