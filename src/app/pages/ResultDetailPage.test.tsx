import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import validOutput from "../../../tests/fixtures/prediction-output.success.example.json";
import type { PredictionJobOutput } from "../../lib/schemas";
import { ResultDetailPage } from "./ResultDetailPage";

describe("ResultDetailPage", () => {
  it("renders missing confidence labels as not available", () => {
    const output = {
      ...validOutput,
      predictions: [{
        ...validOutput.predictions[0],
        model_name: "hybrid",
        confidence_label: undefined,
        brightness_class: "dim",
      }],
    } as PredictionJobOutput;

    render(<ResultDetailPage output={output} />);

    expect(screen.getByRole("heading", { name: "Prediction result" })).toBeInTheDocument();
    expect(screen.getByText("Not available")).toBeInTheDocument();
    expect(screen.queryByText("dim")).not.toBeInTheDocument();
  });
});
