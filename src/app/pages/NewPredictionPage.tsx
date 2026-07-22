import type { FormEvent } from "react";
import { useMemo, useRef, useState } from "react";
import {
  createDuplicateCheckInput,
  createPredictionJobInput,
  validatePredictionJobInput,
  type DuplicateCheckOutput,
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
import type { NibiSettings } from "../../features/settings";
import { defaultNibiSettings } from "../../features/settings";
import {
  createRemoteExecutor,
  duplicateCheckMatchSummary,
  appErrorMessages,
  InteractiveMfaRemoteExecutor,
  runDuplicateCheck,
  type DuplicateCheckResult,
  type ManualMfaSessionUiState,
  submitPredictionSlurmJob,
  uploadPredictionInput,
} from "../../lib/remote";
import {
  addJobEvent,
  saveJob,
  updateJobStatus,
} from "../../lib/db";

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

const jobStatusLabels: Record<MockPredictionJobStatus | "submitting" | "uploaded_to_nibi" | "upload_failed" | "submitted_to_slurm" | "slurm_submission_failed" | "login_required" | "robot_access_required", string> = {
  queued_locally: "Queued locally",
  submitting: "Submitting",
  running: "Running",
  completed: "Completed",
  uploaded_to_nibi: "Uploaded to NIBI",
  upload_failed: "Upload failed",
  submitted_to_slurm: "Submitted to Slurm",
  slurm_submission_failed: "Slurm submission failed",
  login_required: "Login required",
  robot_access_required: "Robot access required",
};

type NewPredictionPageProps = {
  manualMfaSession?: ManualMfaSessionUiState;
  nibiSettings?: NibiSettings;
  onJobChange?: (job: StoredPredictionJob) => void | Promise<void>;
  onOpenResult?: (jobId: string) => void;
  onOpenSettings?: () => void;
};

export function NewPredictionPage({
  manualMfaSession,
  nibiSettings = defaultNibiSettings,
  onJobChange,
  onOpenResult,
  onOpenSettings,
}: NewPredictionPageProps = {}) {
  const [values, setValues] = useState<FormValues>({
    molecule_smiles: "",
    solvent_smiles: "",
    model_choice: "all",
  });
  const [errors, setErrors] = useState<FormErrors>({});
  const [previewInput, setPreviewInput] = useState<PredictionJobInput | null>(null);
  const [localJob, setLocalJob] = useState<LocalPredictionJob | null>(null);
  const [uploadedJob, setUploadedJob] = useState<StoredPredictionJob | null>(null);
  const [copyStatus, setCopyStatus] = useState("");
  const [submitStatus, setSubmitStatus] = useState("");
  const [duplicateCheckStatus, setDuplicateCheckStatus] = useState<DuplicateCheckResult | null>(null);
  const [duplicateCheckOutput, setDuplicateCheckOutput] = useState<DuplicateCheckOutput | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const submissionInProgressRef = useRef(false);
  const [isCheckingDuplicate, setIsCheckingDuplicate] = useState(false);
  const isRealNibi = nibiSettings.backend_mode === "nibi" && nibiSettings.connection_mode !== "mock";

  const previewJson = useMemo(
    () => (previewInput ? JSON.stringify(previewInput, null, 2) : ""),
    [previewInput],
  );

  function updateField(field: keyof FormValues, value: string) {
    setValues((current) => ({ ...current, [field]: value }));
    setErrors((current) => ({ ...current, [field]: undefined }));
    setCopyStatus("");
    setSubmitStatus("");
    setDuplicateCheckStatus(null);
    setDuplicateCheckOutput(null);
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
    if (submissionInProgressRef.current) {
      return;
    }
    submissionInProgressRef.current = true;
    setIsSubmitting(true);
    setSubmitStatus(isRealNibi ? "Submitting to NIBI." : "Running mock prediction.");
    const nextErrors = validateForm(values);
    setErrors(nextErrors);
    setCopyStatus("");

    if (Object.keys(nextErrors).length > 0) {
      setPreviewInput(null);
      setLocalJob(null);
      setUploadedJob(null);
      setIsSubmitting(false);
      submissionInProgressRef.current = false;
      return;
    }

    const input = createPredictionJobInput({
      molecule_smiles: values.molecule_smiles.trim(),
      solvent_smiles: values.solvent_smiles.trim(),
      model_choice: values.model_choice,
    });

    const validatedInput = validatePredictionJobInput(input);
    setPreviewInput(validatedInput);
    const submittingJob: StoredPredictionJob = {
      id: validatedInput.job_id,
      submission_id: validatedInput.job_id,
      molecule_smiles: validatedInput.molecule_smiles,
      solvent_smiles: validatedInput.solvent_smiles,
      model_choice: validatedInput.model_choice,
      status: "submitting",
      created_at: validatedInput.requested_at,
    };
    setUploadedJob(submittingJob);
    void onJobChange?.(submittingJob);

    try {
      if (isRealNibi) {
        const remoteExecutor = createRemoteExecutor(nibiSettings.connection_mode);
        if (remoteExecutor instanceof InteractiveMfaRemoteExecutor) {
          remoteExecutor.setAuthenticated(
            manualMfaSession?.status === "authenticated"
            && manualMfaSession.can_run_background_commands,
          );
        }

        const connectionStatus = remoteExecutor.getConnectionStatus(nibiSettings);
        if (nibiSettings.connection_mode === "interactive_mfa" && connectionStatus.state !== "authenticated") {
          const message = appErrorMessages.interactive_login_required;
          const blockedJob: StoredPredictionJob = {
            ...submittingJob,
            status: "login_required",
            error_message: message,
          };
          setUploadedJob(blockedJob);
          setSubmitStatus(message);
          await onJobChange?.(blockedJob);
          onOpenSettings?.();
          return;
        }
        if (nibiSettings.connection_mode === "robot_automation" && !nibiSettings.robot_access_verified) {
          const message = appErrorMessages.robot_access_not_ready;
          const blockedJob: StoredPredictionJob = {
            ...submittingJob,
            status: "robot_access_required",
            error_message: message,
          };
          setUploadedJob(blockedJob);
          setSubmitStatus(message);
          await onJobChange?.(blockedJob);
          onOpenSettings?.();
          return;
        }

        const uploadResult = await uploadPredictionInput(
          validatedInput,
          nibiSettings,
          remoteExecutor,
          { saveJob, updateJobStatus, addJobEvent },
        );
        const uploaded: StoredPredictionJob = {
          id: validatedInput.job_id,
          molecule_smiles: validatedInput.molecule_smiles,
          solvent_smiles: validatedInput.solvent_smiles,
          model_choice: validatedInput.model_choice,
          status: "uploaded_to_nibi",
          created_at: validatedInput.requested_at,
          submission_id: validatedInput.job_id,
          remote_job_dir: uploadResult.remote_job_dir,
          remote_input_path: uploadResult.remote_input_path,
          remote_output_path: uploadResult.remote_output_path,
        };
        setUploadedJob(uploaded);
        setSubmitStatus("Uploaded input.json to NIBI; submitting Slurm job.");
        await onJobChange?.(uploaded);

        const submission = await submitPredictionSlurmJob(
          uploaded,
          nibiSettings,
          remoteExecutor,
          { updateJobStatus, addJobEvent },
        );
        const submittedJob: StoredPredictionJob = {
          ...uploaded,
          status: submission.status,
          ...(submission.remoteSlurmId ? { remote_slurm_id: submission.remoteSlurmId } : {}),
          ...(submission.submittedAt ? { submitted_at: submission.submittedAt } : {}),
          ...(submission.status === "submitted_to_slurm" && !submission.technicalDetails ? {} : { error_message: [
            submission.message,
            submission.technicalDetails,
          ].filter(Boolean).join("\n\n") }),
        };
        setUploadedJob(submittedJob);
        setLocalJob(null);
        setSubmitStatus(submission.message);
        await onJobChange?.(submittedJob);
        return;
      }

      const completedJob = await runMockPredictionJob(validatedInput, {
        onStatusChange: async (nextJob) => {
          await onJobChange?.(createStoredJobFromLocalJob(nextJob));
          setLocalJob(nextJob);
        },
      });
      setLocalJob(completedJob);
      setUploadedJob(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Prediction submission failed.";
      setSubmitStatus(message);
      const failedJob: StoredPredictionJob = {
        id: validatedInput.job_id,
        molecule_smiles: validatedInput.molecule_smiles,
        solvent_smiles: validatedInput.solvent_smiles,
        model_choice: validatedInput.model_choice,
        status: "upload_failed",
        created_at: validatedInput.requested_at,
        submission_id: validatedInput.job_id,
        completed_at: new Date().toISOString(),
        error_message: message,
      };
      setUploadedJob(failedJob);
      await onJobChange?.(failedJob);
    } finally {
      setIsSubmitting(false);
      submissionInProgressRef.current = false;
    }
  }

  function createSelectedExecutor() {
    const remoteExecutor = createRemoteExecutor(nibiSettings.connection_mode);
    if (remoteExecutor instanceof InteractiveMfaRemoteExecutor) {
      remoteExecutor.setAuthenticated(
        manualMfaSession?.status === "authenticated"
        && manualMfaSession.can_run_background_commands,
      );
    }
    return remoteExecutor;
  }

  async function handleDuplicateCheck() {
    const nextErrors = validateForm(values);
    setErrors(nextErrors);
    setCopyStatus("");
    setSubmitStatus("");
    setDuplicateCheckOutput(null);

    if (Object.keys(nextErrors).length > 0) {
      setDuplicateCheckStatus({
        status: "failed",
        message: "Enter a molecule and solvent before checking training data.",
      });
      return;
    }

    const duplicateInput = createDuplicateCheckInput({
      molecule_smiles: values.molecule_smiles.trim(),
      solvent_smiles: values.solvent_smiles.trim(),
    });

    setIsCheckingDuplicate(true);
    setDuplicateCheckStatus({
      status: "uploading",
      message: isRealNibi
        ? "Preparing duplicate-check input.json."
        : "Running mock training-data match check.",
    });

    try {
      const remoteExecutor = createSelectedExecutor();
      const result = await runDuplicateCheck(
        duplicateInput,
        nibiSettings,
        remoteExecutor,
        {
          onStatusChange: setDuplicateCheckStatus,
        },
      );
      setDuplicateCheckStatus(result);
      setDuplicateCheckOutput(result.output ?? null);
      if (result.status === "login_required" || result.status === "robot_auth_failed") {
        onOpenSettings?.();
      }
    } catch (error) {
      setDuplicateCheckStatus({
        status: "failed",
        message: error instanceof Error ? error.message : "Training-data match check failed.",
      });
    } finally {
      setIsCheckingDuplicate(false);
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
        <p>Describe a molecule and its solvent, then submit it with the selected FluorCast connection mode.</p>
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
          <span>{isRealNibi ? "Uploads input.json to NIBI" : "Runs a deterministic local mock job"}</span>
          <div className="button-row">
            <button
              className="secondary-button"
              disabled={isSubmitting || isCheckingDuplicate}
              onClick={handleDuplicateCheck}
              type="button"
            >
              {isCheckingDuplicate ? "Checking training data" : "Check training-data match"}
            </button>
            <button
              aria-busy={isSubmitting}
              className="primary-button"
              disabled={isSubmitting || isCheckingDuplicate}
              type="submit"
            >
              {isSubmitting
                ? "Submitting..."
                : isRealNibi ? "Submit to NIBI" : "Run mock prediction"}
            </button>
          </div>
        </div>
      </form>
      {isSubmitting ? <p className="copy-status" role="status">Submitting...</p> : null}
      {submitStatus ? <p className="copy-status" role="status">{submitStatus}</p> : null}

      {duplicateCheckStatus ? (
        <section className="job-panel" aria-label="Training-data match check status">
          <div>
            <span className="step-label">Training-data match</span>
            <h2>{duplicateCheckStatus.status === "completed" ? "Check completed" : "Checking training data"}</h2>
            <p>{duplicateCheckStatus.message}</p>
            {duplicateCheckStatus.slurmJobId ? <p>Slurm job {duplicateCheckStatus.slurmJobId}</p> : null}
          </div>
          {duplicateCheckStatus.status === "login_required" ? (
            <button className="secondary-button" onClick={onOpenSettings} type="button">
              Go to Settings and reconnect
            </button>
          ) : duplicateCheckStatus.status === "robot_auth_failed" ? (
            <button className="secondary-button" onClick={onOpenSettings} type="button">
              Open robot setup instructions
            </button>
          ) : null}
        </section>
      ) : null}

      {duplicateCheckOutput ? (
        <section className="result-section" aria-label="Training-data match result">
          <div className="section-heading">
            <div>
              <span>Duplicate check</span>
              <h2>{duplicateCheckMatchSummary(duplicateCheckOutput)}</h2>
            </div>
          </div>
          <div className="applicability-grid duplicate-check-grid">
            <div>
              <span className="step-label">Exact molecule</span>
              <h3>{duplicateCheckOutput.exact_molecule_match ? "Found" : "Not found"}</h3>
            </div>
            <div>
              <span className="step-label">Exact molecule-solvent pair</span>
              <h3>{duplicateCheckOutput.exact_solvent_pair_match ? "Found" : "Not found"}</h3>
            </div>
            <div>
              <span className="step-label">Scaffold</span>
              <h3>{duplicateCheckOutput.scaffold_match ? "Found" : "Not found"}</h3>
            </div>
            <div>
              <span className="step-label">Nearest training similarity</span>
              <h3>{Math.round(duplicateCheckOutput.nearest_training_similarity * 100)}%</h3>
              <p><code>{duplicateCheckOutput.nearest_training_molecule_smiles}</code></p>
            </div>
          </div>
          {duplicateCheckOutput.warnings.length > 0 ? (
            <ul className="warning-list">
              {duplicateCheckOutput.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}

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

      {uploadedJob ? (
        <section className="job-panel" aria-label="Remote prediction upload status">
          <div>
            <span className="step-label">Remote job</span>
            <h2>{jobStatusLabels[uploadedJob.status as keyof typeof jobStatusLabels]}</h2>
            <p>{uploadedJob.remote_slurm_id ? `Slurm job ${uploadedJob.remote_slurm_id}` : uploadedJob.error_message ?? uploadedJob.id}</p>
          </div>
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
