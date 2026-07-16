import { describe, expect, it } from "vitest";
import validInput from "../../../tests/fixtures/prediction-input.example.json";
import validSuccessOutput from "../../../tests/fixtures/prediction-output.success.example.json";
import validFailureOutput from "../../../tests/fixtures/prediction-output.failure.example.json";
import {
  createPredictionJobInput,
  validatePredictionJobInput,
  validatePredictionJobOutput,
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
    const invalidOutput = { ...validSuccessOutput, predictions: [{ value: "462.7" }] };
    expect(() => validatePredictionJobOutput(invalidOutput)).toThrow(/value/);
  });

  it("creates a valid local-user request", () => {
    const input = createPredictionJobInput({
      molecule_smiles: "C1=CC=CC=C1",
      solvent_smiles: "O",
      model_choice: "fluorcast-default",
    });

    expect(input.user_id).toBe("local_user");
    expect(input.job_id).toBeTruthy();
    expect(Number.isNaN(Date.parse(input.requested_at))).toBe(false);
  });
});
