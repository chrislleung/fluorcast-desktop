import type { FormEvent } from "react";
import { useMemo, useState } from "react";
import {
  createPredictionJobInput,
  validatePredictionJobInput,
  type PredictionJobInput,
} from "../../lib/schemas";
import {
  runMockPredictionJob,
  type LocalPredictionJob,
  type MockPredictionJobStatus,
} from "../../lib/mock";
import {
  createStoredJobFromLocalJob,
  type StoredPredictionJob,
} from "../../features/jobs";

const modelChoices = [
  { value: "all", label: "All models" },
  { value: "hybrid_full", label: "Hybrid full" },
  { value: "rf", label: "Random forest" },
  { value: "extratrees", label: "Extra trees" },
  { value: "graph", label: "Graph" },
] as const;

type FormValues = {
  molecule_smiles: string;
  solvent_smiles: string;
  model_choice: string;
};

type FormErrors = Partial<Record<keyof FormValues, string>>;

const jobStatusLabels: Record<MockPredictionJobStatus, string> = {
  queued_locally: "Queued locally",
  running: "Running",
  completed: "Completed",
};

type NewPredictionPageProps = {
  onJobChange?: (job: StoredPredictionJob) => void | Promise<void>;
  onOpenResult?: (jobId: string) => void;
};

export function NewPredictionPage({
  onJobChange,
  onOpenResult,
}: NewPredictionPageProps = {}) {
  const [values, setValues] = useState<FormValues>({
    molecule_smiles: "",
    solvent_smiles: "",
    model_choice: "all",
  });
  const [errors, setErrors] = useState<FormErrors>({});
  const [previewInput, setPreviewInput] = useState<PredictionJobInput | null>(null);
  const [localJob, setLocalJob] = useState<LocalPredictionJob | null>(null);
  const [copyStatus, setCopyStatus] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const previewJson = useMemo(
    () => (previewInput ? JSON.stringify(previewInput, null, 2) : ""),
    [previewInput],
  );

  function updateField(field: keyof FormValues, value: string) {
    setValues((current) => ({ ...current, [field]: value }));
    setErrors((current) => ({ ...current, [field]: undefined }));
    setCopyStatus("");
  }

  function validateForm(formValues: FormValues): FormErrors {
    const nextErrors: FormErrors = {};
    if (formValues.molecule_smiles.trim().length === 0) {
      nextErrors.molecule_smiles = "Molecule SMILES is required.";
    }
    if (formValues.solvent_smiles.trim().length === 0) {
      nextErrors.solvent_smiles = "Solvent SMILES is required.";
    }
    if (formValues.model_choice.trim().length === 0) {
      nextErrors.model_choice = "Model choice is required.";
    }
    return nextErrors;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextErrors = validateForm(values);
    setErrors(nextErrors);
    setCopyStatus("");

    if (Object.keys(nextErrors).length > 0) {
      setPreviewInput(null);
      setLocalJob(null);
      return;
    }

    const input = createPredictionJobInput({
      molecule_smiles: values.molecule_smiles.trim(),
      solvent_smiles: values.solvent_smiles.trim(),
      model_choice: values.model_choice,
    });

    const validatedInput = validatePredictionJobInput(input);
    setPreviewInput(validatedInput);
    setIsSubmitting(true);

    try {
      const completedJob = await runMockPredictionJob(validatedInput, {
        onStatusChange: async (nextJob) => {
          await onJobChange?.(createStoredJobFromLocalJob(nextJob));
          setLocalJob(nextJob);
        },
      });
      setLocalJob(completedJob);
    } finally {
      setIsSubmitting(false);
    }
  }

  async function copyPreviewJson() {
    if (!previewJson) return;
    await navigator.clipboard.writeText(previewJson);
    setCopyStatus("Input JSON copied.");
  }

  return (
    <div className="page narrow-page">
      <header className="page-header">
        <p className="eyebrow">Prediction request</p>
        <h1>New Prediction</h1>
        <p>Describe a molecule and its solvent, then run a local mock prediction before NIBI is connected.</p>
      </header>

      <form className="form-card" onSubmit={handleSubmit}>
        <label>
          <span>Molecule SMILES</span>
          <textarea
            aria-describedby="molecule_smiles-help molecule_smiles-error"
            aria-invalid={errors.molecule_smiles ? "true" : "false"}
            name="molecule_smiles"
            onChange={(event) => updateField("molecule_smiles", event.target.value)}
            placeholder="e.g. CCOc1ccc2nc(S(N)(=O)=O)sc2c1"
            rows={3}
            value={values.molecule_smiles}
          />
          {errors.molecule_smiles ? (
            <span className="field-error" id="molecule_smiles-error">
              {errors.molecule_smiles}
            </span>
          ) : null}
          <small id="molecule_smiles-help">The molecular structure to evaluate.</small>
        </label>

        <label>
          <span>Solvent SMILES</span>
          <input
            aria-describedby="solvent_smiles-help solvent_smiles-error"
            aria-invalid={errors.solvent_smiles ? "true" : "false"}
            name="solvent_smiles"
            onChange={(event) => updateField("solvent_smiles", event.target.value)}
            placeholder="e.g. CCO"
            value={values.solvent_smiles}
          />
          {errors.solvent_smiles ? (
            <span className="field-error" id="solvent_smiles-error">
              {errors.solvent_smiles}
            </span>
          ) : null}
          <small id="solvent_smiles-help">The solvent environment for the prediction.</small>
        </label>

        <label>
          <span>Model choice</span>
          <select
            aria-describedby="model_choice-error"
            aria-invalid={errors.model_choice ? "true" : "false"}
            name="model_choice"
            onChange={(event) => updateField("model_choice", event.target.value)}
            value={values.model_choice}
          >
            <option value="">Select a model</option>
            {modelChoices.map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.label}
              </option>
            ))}
          </select>
          {errors.model_choice ? (
            <span className="field-error" id="model_choice-error">
              {errors.model_choice}
            </span>
          ) : null}
        </label>

        <div className="form-actions">
          <span>Runs a deterministic local mock job</span>
          <button className="primary-button" disabled={isSubmitting} type="submit">
            {isSubmitting ? "Running mock job" : "Run mock prediction"}
          </button>
        </div>
      </form>

      {localJob ? (
        <section className="job-panel" aria-label="Local prediction job status">
          <div>
            <span className="step-label">Local job</span>
            <h2>{jobStatusLabels[localJob.status]}</h2>
            <p>{localJob.job_id}</p>
          </div>
          {localJob.output ? (
            <button
              className="secondary-button"
              onClick={() => onOpenResult?.(localJob.job_id)}
              type="button"
            >
              View completed result
            </button>
          ) : null}
        </section>
      ) : null}

      <section className="preview-panel" aria-label="Generated input JSON">
        <div className="section-heading">
          <div>
            <span>Local payload</span>
            <h2>Generated input JSON</h2>
          </div>
          <button
            className="secondary-button"
            disabled={!previewInput}
            onClick={copyPreviewJson}
            type="button"
          >
            Copy input JSON
          </button>
        </div>
        {previewInput ? (
          <pre>{previewJson}</pre>
        ) : (
          <p>No input generated yet.</p>
        )}
        {copyStatus ? <p className="copy-status">{copyStatus}</p> : null}
      </section>
    </div>
  );
}
