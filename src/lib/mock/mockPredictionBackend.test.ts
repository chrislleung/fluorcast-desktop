import { describe, expect, it } from "vitest";
import validInput from "../../../tests/fixtures/prediction-input.example.json";
import { validatePredictionJobOutput } from "../schemas";
import {
  createMockPredictionOutput,
  mockPredictionOutputFixture,
  runMockPredictionJob,
} from "./mockPredictionBackend";

describe("mock prediction backend", () => {
  it("returns a valid PredictionJobOutput", () => {
    const output = createMockPredictionOutput(validInput);

    expect(validatePredictionJobOutput(output)).toEqual(output);
    expect(output.job_id).toBe(validInput.job_id);
    expect(output.status).toBe("succeeded");
  });

  it("transitions a local job to completed", async () => {
    const seenStatuses: string[] = [];

    const job = await runMockPredictionJob(validInput, {
      delayMs: 0,
      onStatusChange: (nextJob) => seenStatuses.push(nextJob.status),
    });

    expect(seenStatuses).toEqual(["queued_locally", "running", "completed"]);
    expect(job.status).toBe("completed");
    expect(job.output?.status).toBe("succeeded");
  });

  it("rejects malformed mock output through schema validation", () => {
    const malformedOutput = {
      ...mockPredictionOutputFixture,
      predictions: [{ ...mockPredictionOutputFixture.predictions[0], value: "462.7" }],
    };

    expect(() => validatePredictionJobOutput(malformedOutput)).toThrow(/value/);
  });
});
