import { describe, expect, it } from "vitest";
import validInput from "../../../tests/fixtures/prediction-input.example.json";
import validSuccessOutput from "../../../tests/fixtures/prediction-output.success.example.json";
import validFailureOutput from "../../../tests/fixtures/prediction-output.failure.example.json";
import {
  createDuplicateCheckInput,
  createPredictionJobInput,
  toRemoteModelChoice,
  toRemotePredictionJobInput,
  validateDuplicateCheckInput,
  validateDuplicateCheckOutput,
  validatePredictionJobInput,
  validatePredictionJobOutput,
  validateRemotePredictionJobInput,
} from "./predictionJob";

describe("prediction job contract", () => {
  it("accepts the valid input fixture", () => {
    expect(validatePredictionJobInput(validInput)).toEqual(validInput);
  });

  it("accepts the valid success output fixture", () => {
    expect(validatePredictionJobOutput(validSuccessOutput)).toEqual(validSuccessOutput);
  });

  it("accepts the valid failure output fixture", () => {
    expect(validatePredictionJobOutput(validFailureOutput)).toEqual(validFailureOutput);
  });

  it("rejects input without molecule_smiles", () => {
    const invalidInput: Partial<typeof validInput> = { ...validInput };
    delete invalidInput.molecule_smiles;
    expect(() => validatePredictionJobInput(invalidInput)).toThrow(/molecule_smiles/);
  });

  it("rejects a malformed predictions array", () => {
    const invalidOutput = {
      ...validSuccessOutput,
      predictions: [{ ...validSuccessOutput.predictions[0], predicted_emission_nm: "462.7" }],
    };
    expect(() => validatePredictionJobOutput(invalidOutput)).toThrow(/predicted_emission_nm/);
  });

  it("creates a valid local-user request", () => {
    const input = createPredictionJobInput({
      molecule_smiles: "C1=CC=CC=C1",
      solvent_smiles: "O",
      model_choice: "all",
    });

    expect(input.user_id).toBe("local_user");
    expect(input.job_id).toBeTruthy();
    expect(Number.isNaN(Date.parse(input.requested_at))).toBe(false);
  });

  it("maps desktop hybrid_full to the remote hybrid wire value", () => {
    const input = validatePredictionJobInput({
      ...validInput,
      model_choice: "hybrid_full",
    });

    expect(input.model_choice).toBe("hybrid_full");
    expect(toRemoteModelChoice(input.model_choice)).toBe("hybrid");
    expect(validateRemotePredictionJobInput(toRemotePredictionJobInput(input))).toMatchObject({
      model_choice: "hybrid",
    });
  });

  it("preserves supported remote model choices other than hybrid_full", () => {
    expect(toRemoteModelChoice("all")).toBe("all");
    expect(toRemoteModelChoice("extratrees")).toBe("extratrees");
    expect(toRemoteModelChoice("gbdt")).toBe("gbdt");
    expect(toRemoteModelChoice("histgb")).toBe("histgb");
    expect(toRemoteModelChoice("rf")).toBe("rf");
  });

  it("rejects unsupported desktop model choices locally", () => {
    expect(() => validatePredictionJobInput({
      ...validInput,
      model_choice: "unsupported-model",
    })).toThrow(/model_choice must be one of/);
  });

  it("accepts the duplicate-check contract", () => {
    const input = createDuplicateCheckInput({
      molecule_smiles: "C1=CC=CC=C1",
      solvent_smiles: "O",
    });
    const output = {
      exact_molecule_match: true,
      exact_solvent_pair_match: false,
      scaffold_match: true,
      nearest_training_similarity: 0.94,
      nearest_training_molecule_smiles: "c1ccccc1",
      warnings: ["Solvent differs from the nearest training pair."],
    };

    expect(validateDuplicateCheckInput(input)).toEqual(input);
    expect(validateDuplicateCheckOutput(output)).toEqual(output);
  });

  it("rejects malformed duplicate-check similarity", () => {
    expect(() => validateDuplicateCheckOutput({
      exact_molecule_match: false,
      exact_solvent_pair_match: false,
      scaffold_match: false,
      nearest_training_similarity: 1.4,
      nearest_training_molecule_smiles: "CCO",
      warnings: [],
    })).toThrow(/nearest_training_similarity/);
  });
});
