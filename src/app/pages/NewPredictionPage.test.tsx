import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  validatePredictionJobInput,
} from "../../lib/schemas";
import { NewPredictionPage } from "./NewPredictionPage";

describe("NewPredictionPage", () => {
  it("rejects an empty molecule SMILES", () => {
    render(<NewPredictionPage />);

    fireEvent.change(screen.getByLabelText(/Solvent SMILES/i), {
      target: { value: "O" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Run mock prediction/i }));

    expect(screen.getByText("Molecule SMILES is required.")).toBeInTheDocument();
    expect(screen.getByText("No input generated yet.")).toBeInTheDocument();
  });

  it("rejects an empty solvent SMILES", () => {
    render(<NewPredictionPage />);

    fireEvent.change(screen.getByLabelText(/Molecule SMILES/i), {
      target: { value: "C1=CC=CC=C1" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Run mock prediction/i }));

    expect(screen.getByText("Solvent SMILES is required.")).toBeInTheDocument();
    expect(screen.getByText("No input generated yet.")).toBeInTheDocument();
  });

  it("creates valid input JSON from a valid form", () => {
    render(<NewPredictionPage />);

    fireEvent.change(screen.getByLabelText(/Molecule SMILES/i), {
      target: { value: "C1=CC=CC=C1" },
    });
    fireEvent.change(screen.getByLabelText(/Solvent SMILES/i), {
      target: { value: "O" },
    });
    fireEvent.change(screen.getByLabelText(/Model choice/i), {
      target: { value: "rf" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Run mock prediction/i }));

    const preview = screen.getByLabelText("Generated input JSON");
    const inputJson = JSON.parse(preview.querySelector("pre")?.textContent ?? "");
    const validatedInput = validatePredictionJobInput(inputJson);

    expect(validatedInput).toMatchObject({
      user_id: "local_user",
      molecule_smiles: "C1=CC=CC=C1",
      solvent_smiles: "O",
      model_choice: "rf",
    });
    expect(validatedInput.job_id).toEqual(expect.any(String));
    expect(Number.isNaN(Date.parse(validatedInput.requested_at))).toBe(false);
  });

  it("transitions a submitted mock job to completed and opens the stored result", async () => {
    const handleOpenResult = vi.fn();
    render(<NewPredictionPage onOpenResult={handleOpenResult} />);

    fireEvent.change(screen.getByLabelText(/Molecule SMILES/i), {
      target: { value: "C1=CC=CC=C1" },
    });
    fireEvent.change(screen.getByLabelText(/Solvent SMILES/i), {
      target: { value: "O" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Run mock prediction/i }));

    expect(await screen.findByText("Queued locally")).toBeInTheDocument();
    expect(await screen.findByText("Completed")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /View completed result/i }));

    expect(handleOpenResult).toHaveBeenCalledWith(expect.any(String));
  });
});
