import type { StoredPredictionJob } from "../../features/jobs";
import type { NibiSettings } from "../../features/settings";
import type { ManualMfaSessionUiState } from "../../lib/remote";

type JobsPageProps = {
  jobs: StoredPredictionJob[];
  manualMfaSession?: ManualMfaSessionUiState;
  manualMfaStatus?: string;
  nibiSettings?: NibiSettings;
  onOpenResult: (jobId: string) => void;
  onReconnect?: () => void;
  onOpenRobotSetup?: () => void;
  onRefreshJobStatus?: (job: StoredPredictionJob) => Promise<unknown>;
  onCancelRemoteJob?: (job: StoredPredictionJob) => Promise<unknown>;
  onSubmitSlurmJob?: (job: StoredPredictionJob) => Promise<unknown>;
};

const statusLabels: Record<StoredPredictionJob["status"], string> = {
  queued_locally: "Queued locally",
  submitting: "Submitting",
  upload_waiting_for_login: "Waiting for login",
  uploaded_to_nibi: "Uploaded to NIBI",
  upload_failed: "Upload failed",
  queued: "Queued",
  submitted_to_slurm: "Submitted to Slurm",
  slurm_submission_failed: "Submission failed",
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
  timed_out: "Timed out",
  timeout: "Timed out",
  login_required: "Login required",
  robot_access_required: "Robot access required",
  robot_auth_failed: "Robot auth failed",
  connection_failed: "Connection failed",
  output_missing: "Output missing",
  output_invalid: "Output invalid",
  download_failed: "Download failed",
  unknown: "Unknown",
};

function formatCreatedDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function canRefresh(job: StoredPredictionJob) {
  return Boolean(job.remote_slurm_id) && job.status !== "completed";
}

function canSubmitToSlurm(job: StoredPredictionJob) {
  return !job.remote_slurm_id && (
    job.status === "uploaded_to_nibi"
    || job.status === "slurm_submission_failed"
    || (job.status === "login_required" && Boolean(job.remote_input_path) && !job.remote_slurm_id)
  );
}

function isRemoteActive(job: StoredPredictionJob) {
  return job.status === "submitting"
    || job.status === "queued"
    || job.status === "submitted_to_slurm"
    || job.status === "running";
}

function isManualSessionReady(manualMfaSession?: ManualMfaSessionUiState) {
  return manualMfaSession?.status === "authenticated" && manualMfaSession.can_run_background_commands;
}

function usesPersistentShell(nibiSettings?: NibiSettings) {
  return nibiSettings?.manual_mfa_provider === "persistent_shell";
}

function showReconnectPanel(job: StoredPredictionJob, nibiSettings?: NibiSettings, manualMfaSession?: ManualMfaSessionUiState) {
  return nibiSettings?.connection_mode === "interactive_mfa"
    && job.status === "login_required"
    && !isManualSessionReady(manualMfaSession);
}

function failureDetails(job: StoredPredictionJob) {
  return [
    job.slurm_state ? `Slurm State: ${job.slurm_state}` : "",
    job.slurm_exit_code ? `Slurm ExitCode: ${job.slurm_exit_code}` : "",
    job.remote_job_dir ? `Remote job folder: ${job.remote_job_dir}` : "",
    job.submitted_command ? `Submitted command: ${job.submitted_command}` : "",
    job.slurm_stdout ? `stdout.log:\n${job.slurm_stdout}` : "",
    job.slurm_stderr ? `stderr.log:\n${job.slurm_stderr}` : "",
    job.error_message ?? "",
  ].filter(Boolean).join("\n\n");
}

export function JobsPage({
  jobs,
  manualMfaSession,
  manualMfaStatus,
  nibiSettings,
  onOpenResult,
  onReconnect,
  onOpenRobotSetup,
  onRefreshJobStatus,
  onCancelRemoteJob,
  onSubmitSlurmJob,
}: JobsPageProps) {
  function confirmAndCancel(job: StoredPredictionJob) {
    if (!job.remote_slurm_id) return;
    if (window.confirm(`Cancel Slurm job ${job.remote_slurm_id}?`)) {
      void onCancelRemoteJob?.(job);
    }
  }

  return (
    <div className="page narrow-page">
      <header className="page-header">
        <p className="eyebrow">Job history</p>
        <h1>Jobs</h1>
        <p>Monitor submitted predictions and open completed results.</p>
      </header>

      {jobs.length === 0 ? (
        <section className="empty-state">
          <span className="empty-icon" aria-hidden="true">...</span>
          <h2>No prediction jobs yet</h2>
          <p>Your submitted and completed local mock jobs will appear here.</p>
        </section>
      ) : (
        <section className="result-section" aria-label="Prediction job history">
          {manualMfaStatus ? (
            <p className="connection-test-status" role="status">
              {manualMfaStatus}
            </p>
          ) : null}
          <div className="section-heading">
            <h2>Local jobs</h2>
            <span>{jobs.length}</span>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Created</th>
                  <th>Local job ID</th>
                  <th>Molecule SMILES</th>
                  <th>Solvent SMILES</th>
                  <th>Model choice</th>
                  <th>Status</th>
                  <th>Slurm</th>
                  <th>Result</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((job) => (
                  <tr key={job.id}>
                    <td>{formatCreatedDate(job.created_at)}</td>
                    <td><code>{job.id}</code></td>
                    <td><code>{job.molecule_smiles}</code></td>
                    <td><code>{job.solvent_smiles}</code></td>
                    <td>{job.model_choice}</td>
                    <td>
                      <span className={`job-status job-status-${job.status}`}>
                        {statusLabels[job.status]}
                      </span>
                    </td>
                    <td>{job.remote_slurm_id ? <code>{job.remote_slurm_id}</code> : "None"}</td>
                    <td>
                      {job.status === "completed" ? (
                        <button
                          className="secondary-button compact-button"
                          onClick={() => onOpenResult(job.id)}
                          type="button"
                        >
                          Open result
                        </button>
                      ) : job.status === "submitting" ? (
                        <span>Submitting...</span>
                      ) : job.status === "uploaded_to_nibi" && onSubmitSlurmJob ? (
                        <button
                          className="secondary-button compact-button"
                          onClick={() => void onSubmitSlurmJob(job)}
                          type="button"
                        >
                          Submit to Slurm
                        </button>
                      ) : job.status === "uploaded_to_nibi" ? (
                        <span>Input uploaded. Submit to Slurm.</span>
                      ) : job.status === "slurm_submission_failed" && job.remote_slurm_id ? (
                        <>
                          <span>Submission accepted by Slurm</span>
                          {onRefreshJobStatus ? (
                            <button
                              className="secondary-button compact-button"
                              onClick={() => void onRefreshJobStatus(job)}
                              type="button"
                            >
                              Resume monitoring
                            </button>
                          ) : null}
                          {job.error_message ? (
                            <details className="remote-check-details">
                              <summary>Marker warning</summary>
                              <pre>{job.error_message}</pre>
                            </details>
                          ) : null}
                        </>
                      ) : job.status === "slurm_submission_failed" ? (
                        <>
                          <span>Submission failed</span>
                          {onSubmitSlurmJob ? (
                            <button
                              className="secondary-button compact-button"
                              onClick={() => void onSubmitSlurmJob(job)}
                              type="button"
                            >
                              Retry Slurm submission
                            </button>
                          ) : null}
                          {job.error_message ? (
                            <details className="remote-check-details">
                              <summary>Technical details</summary>
                              <pre>{job.error_message}</pre>
                            </details>
                          ) : null}
                        </>
                      ) : job.status === "submitted_to_slurm" || job.status === "queued" ? (
                        <>
                          <span>{job.remote_slurm_id ? "View queued job" : "Submitted to Slurm"}</span>
                          {onRefreshJobStatus ? (
                            <button
                              className="secondary-button compact-button"
                              onClick={() => void onRefreshJobStatus(job)}
                              type="button"
                            >
                              Refresh status
                            </button>
                          ) : null}
                          {onCancelRemoteJob && job.remote_slurm_id ? (
                            <button
                              className="secondary-button compact-button"
                              onClick={() => confirmAndCancel(job)}
                              type="button"
                            >
                              Cancel remote job
                            </button>
                          ) : null}
                          {job.error_message ? (
                            <details className="remote-check-details">
                              <summary>Marker warning</summary>
                              <pre>{job.error_message}</pre>
                            </details>
                          ) : null}
                        </>
                      ) : showReconnectPanel(job, nibiSettings, manualMfaSession) ? (
                        <section className="inline-action-panel" aria-label="NIBI login required">
                          <h3>NIBI login required</h3>
                          <p>
                            Open Settings to start or test the NIBI session, then return here to refresh or submit this job.
                          </p>
                          <div className="button-row">
                            <button
                              className="secondary-button compact-button"
                              onClick={onReconnect}
                              type="button"
                            >
                              Open Settings
                            </button>
                          </div>
                          {manualMfaStatus || manualMfaSession?.last_session_test_result ? (
                            <p className="connection-test-status">
                              {manualMfaStatus || manualMfaSession?.last_session_test_result}
                            </p>
                          ) : null}
                        </section>
                      ) : job.status === "login_required" && isManualSessionReady(manualMfaSession) && canSubmitToSlurm(job) && onSubmitSlurmJob ? (
                        <button
                          className="secondary-button compact-button"
                          onClick={() => void onSubmitSlurmJob(job)}
                          type="button"
                        >
                          Submit to Slurm
                        </button>
                      ) : job.status === "login_required" && isManualSessionReady(manualMfaSession) && canRefresh(job) && onRefreshJobStatus ? (
                        <button
                          className="secondary-button compact-button"
                          onClick={() => void onRefreshJobStatus(job)}
                          type="button"
                        >
                          Refresh status
                        </button>
                      ) : job.status === "login_required" ? (
                        <span>
                          {usesPersistentShell(nibiSettings)
                            ? "NIBI session required. Start a Manual MFA session and complete password + Duo."
                            : "Open Settings, start the NIBI session, then press Test authenticated session before continuing."}
                        </span>
                      ) : job.status === "robot_access_required" || job.status === "robot_auth_failed" ? (
                        <button
                          className="secondary-button compact-button"
                          onClick={onOpenRobotSetup}
                          type="button"
                        >
                          Open robot setup instructions
                        </button>
                      ) : job.status === "output_missing" && canRefresh(job) && onRefreshJobStatus ? (
                        <button
                          className="secondary-button compact-button"
                          onClick={() => void onRefreshJobStatus(job)}
                          type="button"
                        >
                          Download result
                        </button>
                      ) : job.status === "download_failed" && canRefresh(job) && onRefreshJobStatus ? (
                        <>
                          <span>{job.error_message ?? "The prediction completed, but FluorCast could not download output.json."}</span>
                          <button
                            className="secondary-button compact-button"
                            onClick={() => void onRefreshJobStatus(job)}
                            type="button"
                          >
                            Retry output download
                          </button>
                          {failureDetails(job) ? (
                            <details className="remote-check-details">
                              <summary>Failure details</summary>
                              <pre>{failureDetails(job)}</pre>
                            </details>
                          ) : null}
                        </>
                      ) : job.status === "output_invalid" && canRefresh(job) && onRefreshJobStatus ? (
                        <>
                          <span>{job.error_message ?? "Remote output.json was downloaded but needs to be re-imported."}</span>
                          <button
                            className="secondary-button compact-button"
                            onClick={() => void onRefreshJobStatus(job)}
                            type="button"
                          >
                            Retry result import
                          </button>
                          {failureDetails(job) ? (
                            <details className="remote-check-details">
                              <summary>Failure details</summary>
                              <pre>{failureDetails(job)}</pre>
                            </details>
                          ) : null}
                        </>
                      ) : job.status === "failed"
                        || job.status === "upload_failed"
                        || job.status === "cancelled"
                        || job.status === "timed_out"
                        || job.status === "timeout"
                        || job.status === "unknown" ? (
                        <>
                          <span>{job.error_message ?? "Failed"}</span>
                          {failureDetails(job) ? (
                            <details className="remote-check-details">
                              <summary>Failure details</summary>
                              {job.slurm_stderr ? (
                                <>
                                  <span className="step-label">stderr.log</span>
                                  <pre>{job.slurm_stderr}</pre>
                                </>
                              ) : null}
                              <pre>{failureDetails(job)}</pre>
                            </details>
                          ) : null}
                        </>
                      ) : isRemoteActive(job) ? (
                        <>
                          <span>{job.status === "running" ? "View running job" : "View queued job"}</span>
                          {onCancelRemoteJob && job.remote_slurm_id ? (
                            <button
                              className="secondary-button compact-button"
                              onClick={() => confirmAndCancel(job)}
                              type="button"
                            >
                              Cancel remote job
                            </button>
                          ) : null}
                        </>
                      ) : canRefresh(job) && onRefreshJobStatus ? (
                        <button
                          className="secondary-button compact-button"
                          onClick={() => void onRefreshJobStatus(job)}
                          type="button"
                        >
                          Refresh status
                        </button>
                      ) : canSubmitToSlurm(job) ? (
                        <span>Input uploaded. Submit to Slurm.</span>
                      ) : (
                        <span>Loading</span>
                      )}
                      {job.remote_job_dir ? (
                        <details className="remote-check-details">
                          <summary>Remote folder</summary>
                          <code>{job.remote_job_dir}</code>
                        </details>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
