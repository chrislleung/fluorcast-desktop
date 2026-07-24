import { useEffect, useRef, useState } from "react";
import type { StoredPredictionJob } from "../../features/jobs";
import { JOB_NOTE_MAX_LENGTH } from "../../lib/db";
import type { NibiSettings } from "../../features/settings";
import {
  canManuallyRefreshSlurmJob,
  createRefreshTraceId,
  formatRefreshDiagnosticsText,
  type BannerWriteTrace,
  type ManualMfaSessionUiState,
  type ManualRefreshTrace,
} from "../../lib/remote";

type JobsPageProps = {
  jobs: StoredPredictionJob[];
  manualMfaSession?: ManualMfaSessionUiState;
  manualMfaStatus?: string;
  nibiSettings?: NibiSettings;
  refreshingJobIds?: string[];
  onOpenResult: (jobId: string) => void;
  onReconnect?: () => void;
  onOpenRobotSetup?: () => void;
  latestManualRefreshTraceByJob?: Record<string, ManualRefreshTrace>;
  latestGlobalBannerWriteTrace?: BannerWriteTrace;
  onRefreshJobStatus?: (job: StoredPredictionJob, traceId: string) => Promise<unknown>;
  onCancelRemoteJob?: (job: StoredPredictionJob) => Promise<unknown>;
  onSubmitSlurmJob?: (job: StoredPredictionJob) => Promise<unknown>;
  onSaveJobNote?: (jobId: string, note: string | null) => Promise<boolean>;
  onDeleteJobPermanently?: (jobId: string) => Promise<boolean>;
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
  return job.status !== "completed" && canManuallyRefreshSlurmJob(job);
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

function isActiveJobStatus(status: StoredPredictionJob["status"]) {
  return status === "queued_locally"
    || status === "submitting"
    || status === "upload_waiting_for_login"
    || status === "uploaded_to_nibi"
    || status === "queued"
    || status === "submitted_to_slurm"
    || status === "running";
}

const deleteBlockedStatuses = new Set<StoredPredictionJob["status"]>([
  "submitting",
  "upload_waiting_for_login",
  "uploaded_to_nibi",
  "queued",
  "submitted_to_slurm",
  "running",
]);

const locallyDeletableStatuses = new Set<StoredPredictionJob["status"]>([
  "queued_locally",
  "completed",
  "failed",
  "cancelled",
  "timed_out",
  "timeout",
  "upload_failed",
  "slurm_submission_failed",
  "robot_access_required",
  "robot_auth_failed",
  "output_missing",
  "output_invalid",
  "download_failed",
]);

function canDeleteLocally(job: StoredPredictionJob) {
  if (deleteBlockedStatuses.has(job.status)) {
    return false;
  }
  if (job.remote_slurm_id && !locallyDeletableStatuses.has(job.status)) {
    return false;
  }
  return true;
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

function safeFailureSummary(job: StoredPredictionJob) {
  return job.error_message?.split(/\n\n/)[0] ?? "Failed";
}

function shortJobId(jobId: string) {
  return jobId.length > 12 ? `${jobId.slice(0, 8)}...` : jobId;
}

export function JobsPage({
  jobs,
  manualMfaSession,
  manualMfaStatus,
  nibiSettings,
  refreshingJobIds = [],
  onOpenResult,
  onReconnect,
  onOpenRobotSetup,
  onRefreshJobStatus,
  onCancelRemoteJob,
  onSubmitSlurmJob,
  onSaveJobNote,
  onDeleteJobPermanently,
  latestManualRefreshTraceByJob = {},
  latestGlobalBannerWriteTrace,
}: JobsPageProps) {
  const refreshingJobs = new Set(refreshingJobIds);
  const [editingNoteJobId, setEditingNoteJobId] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState("");
  const [noteSavingJobId, setNoteSavingJobId] = useState<string | null>(null);
  const [noteErrorByJob, setNoteErrorByJob] = useState<Record<string, string>>({});
  const [deleteCandidate, setDeleteCandidate] = useState<StoredPredictionJob | null>(null);
  const [deleteErrorByJob, setDeleteErrorByJob] = useState<Record<string, string>>({});
  const [deleteDiagnosticByJob, setDeleteDiagnosticByJob] = useState<Record<string, string>>({});
  const [deletingJobId, setDeletingJobId] = useState<string | null>(null);
  const [openMenuJobId, setOpenMenuJobId] = useState<string | null>(null);
  const deleteDialogRef = useRef<HTMLDivElement | null>(null);
  const deleteTriggerRef = useRef<HTMLButtonElement | null>(null);
  const menuTriggerRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const menuRefs = useRef<Record<string, HTMLDivElement | null>>({});

  useEffect(() => {
    if (deleteCandidate) {
      deleteDialogRef.current?.focus();
    } else {
      deleteTriggerRef.current?.focus();
    }
  }, [deleteCandidate]);

  useEffect(() => {
    if (!openMenuJobId) {
      return;
    }

    const menu = menuRefs.current[openMenuJobId];
    const firstEnabledItem = menu?.querySelector<HTMLButtonElement>("button:not(:disabled)");
    firstEnabledItem?.focus();

    function handlePointerDown(event: MouseEvent) {
      const target = event.target;
      if (!(target instanceof Node) || !openMenuJobId) {
        return;
      }
      const menuElement = menuRefs.current[openMenuJobId];
      const triggerElement = menuTriggerRefs.current[openMenuJobId];
      if (menuElement?.contains(target) || triggerElement?.contains(target)) {
        return;
      }
      setOpenMenuJobId(null);
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpenMenuJobId(null);
        menuTriggerRefs.current[openMenuJobId]?.focus();
      }
    }

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [openMenuJobId]);

  function refreshJobStatus(job: StoredPredictionJob) {
    const traceId = createRefreshTraceId();
    void onRefreshJobStatus?.(job, traceId);
  }

  function copyDiagnostics(job: StoredPredictionJob) {
    const text = formatRefreshDiagnosticsText(latestManualRefreshTraceByJob[job.id], latestGlobalBannerWriteTrace);
    void navigator.clipboard?.writeText(text);
  }

  function confirmAndCancel(job: StoredPredictionJob) {
    if (!job.remote_slurm_id) return;
    if (window.confirm(`Cancel Slurm job ${job.remote_slurm_id}?`)) {
      void onCancelRemoteJob?.(job);
    }
  }

  function startNoteEdit(job: StoredPredictionJob) {
    setEditingNoteJobId(job.id);
    setNoteDraft(job.note ?? "");
    setNoteErrorByJob((current) => ({ ...current, [job.id]: "" }));
  }

  function selectNoteMenuItem(job: StoredPredictionJob) {
    startNoteEdit(job);
    setOpenMenuJobId(null);
  }

  async function saveNote(job: StoredPredictionJob, overrideDraft?: string) {
    if (!onSaveJobNote || noteSavingJobId) return;
    const normalizedNote = (overrideDraft ?? noteDraft).trim() || null;
    setNoteSavingJobId(job.id);
    setNoteErrorByJob((current) => ({ ...current, [job.id]: "" }));
    try {
      const saved = await onSaveJobNote(job.id, normalizedNote);
      if (!saved) {
        throw new Error("Local note could not be saved.");
      }
      setEditingNoteJobId(null);
      setNoteDraft("");
    } catch (error) {
      setNoteErrorByJob((current) => ({
        ...current,
        [job.id]: error instanceof Error ? error.message : "Local note could not be saved.",
      }));
    } finally {
      setNoteSavingJobId(null);
    }
  }

  function closeDeleteDialog() {
    setDeleteCandidate(null);
  }

  async function confirmPermanentDelete() {
    if (!deleteCandidate || !onDeleteJobPermanently || deletingJobId) return;
    if (!canDeleteLocally(deleteCandidate)) {
      setDeleteErrorByJob((current) => ({
        ...current,
        [deleteCandidate.id]: "Cancel the remote job and wait for it to reach a terminal state before deleting it locally.",
      }));
      closeDeleteDialog();
      return;
    }

    setDeletingJobId(deleteCandidate.id);
    setDeleteErrorByJob((current) => ({ ...current, [deleteCandidate.id]: "" }));
    setDeleteDiagnosticByJob((current) => ({ ...current, [deleteCandidate.id]: "" }));
    try {
      const deleted = await onDeleteJobPermanently(deleteCandidate.id);
      if (!deleted) {
        throw new Error("Local job could not be deleted.");
      }
      setEditingNoteJobId((current) => current === deleteCandidate.id ? null : current);
      setNoteErrorByJob((current) => {
        const next = { ...current };
        delete next[deleteCandidate.id];
        return next;
      });
      setDeleteDiagnosticByJob((current) => {
        const next = { ...current };
        delete next[deleteCandidate.id];
        return next;
      });
      closeDeleteDialog();
    } catch (error) {
      const technicalDetails = typeof error === "object"
        && error !== null
        && "technicalDetails" in error
        && typeof (error as { technicalDetails?: unknown }).technicalDetails === "string"
        ? (error as { technicalDetails: string }).technicalDetails
        : error instanceof Error
          ? error.message
          : "Local job could not be deleted.";
      setDeleteErrorByJob((current) => ({
        ...current,
        [deleteCandidate.id]: "Local job could not be deleted.",
      }));
      setDeleteDiagnosticByJob((current) => ({
        ...current,
        [deleteCandidate.id]: technicalDetails,
      }));
      closeDeleteDialog();
    } finally {
      setDeletingJobId(null);
    }
  }

  function renderJobNote(job: StoredPredictionJob) {
    const isEditing = editingNoteJobId === job.id;
    const hasNote = Boolean(job.note);
    const remaining = JOB_NOTE_MAX_LENGTH - noteDraft.length;
    const showCount = isEditing && remaining <= 200;
    const textareaId = `job-note-${job.id}`;
    const errorId = `job-note-error-${job.id}`;

    if (!hasNote && !isEditing) {
      return null;
    }

    return (
      <section className="job-note-area" aria-label={`Note for job ${job.id}`}>
        {hasNote && !isEditing ? (
          <p className="job-note-text">{job.note}</p>
        ) : null}
        {isEditing ? (
          <div className="job-note-editor">
            <label htmlFor={textareaId}>
              Job note
              <textarea
                aria-describedby={noteErrorByJob[job.id] ? errorId : undefined}
                id={textareaId}
                maxLength={JOB_NOTE_MAX_LENGTH}
                onChange={(event) => setNoteDraft(event.target.value)}
                rows={4}
                value={noteDraft}
              />
            </label>
            {showCount ? (
              <span className="field-help">{noteDraft.length} / {JOB_NOTE_MAX_LENGTH}</span>
            ) : null}
            {noteErrorByJob[job.id] ? (
              <p className="field-error" id={errorId} role="alert">{noteErrorByJob[job.id]}</p>
            ) : null}
            <div className="button-row job-note-actions">
              {hasNote ? (
                <button
                  className="secondary-button compact-button cancel-button"
                  disabled={noteSavingJobId === job.id}
                  onClick={() => {
                    void saveNote(job, "");
                  }}
                  type="button"
                >
                  Remove note
                </button>
              ) : null}
              <button
                className="secondary-button compact-button"
                disabled={noteSavingJobId === job.id}
                onClick={() => {
                  setEditingNoteJobId(null);
                  setNoteDraft(job.note ?? "");
                }}
                type="button"
              >
                Cancel
              </button>
              <button
                className="secondary-button compact-button"
                disabled={noteSavingJobId === job.id}
                onClick={() => void saveNote(job)}
                type="button"
              >
                {noteSavingJobId === job.id ? "Saving..." : "Save note"}
              </button>
            </div>
          </div>
        ) : null}
      </section>
    );
  }

  function renderDeleteFeedback(job: StoredPredictionJob) {
    const errorId = `job-delete-error-${job.id}`;
    const diagnosticId = `job-delete-diagnostics-${job.id}`;
    if (!deleteErrorByJob[job.id] && !deleteDiagnosticByJob[job.id]) {
      return null;
    }

    return (
      <section className="job-delete-feedback" aria-label={`Delete status for job ${job.id}`}>
        {deleteErrorByJob[job.id] ? (
          <p className="field-error" id={errorId} role="alert">{deleteErrorByJob[job.id]}</p>
        ) : null}
        {deleteDiagnosticByJob[job.id] ? (
          <details className="remote-check-details job-detail-row" id={diagnosticId}>
            <summary>Development diagnostics</summary>
            <pre>{deleteDiagnosticByJob[job.id]}</pre>
          </details>
        ) : null}
      </section>
    );
  }

  function renderOverflowMenu(job: StoredPredictionJob) {
    const isOpen = openMenuJobId === job.id;
    const menuId = `job-overflow-menu-${job.id}`;
    const deleteBlocked = !canDeleteLocally(job);
    const deleteHelpId = `job-delete-menu-help-${job.id}`;
    return (
      <div
        className="job-overflow"
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) {
            setOpenMenuJobId((current) => current === job.id ? null : current);
          }
        }}
      >
        <button
          aria-controls={menuId}
          aria-expanded={isOpen}
          aria-haspopup="menu"
          aria-label={`More actions for job ${shortJobId(job.id)}`}
          className="secondary-button compact-button icon-button overflow-menu-trigger"
          onClick={(event) => {
            menuTriggerRefs.current[job.id] = event.currentTarget;
            setOpenMenuJobId((current) => current === job.id ? null : job.id);
          }}
          ref={(element) => {
            menuTriggerRefs.current[job.id] = element;
          }}
          type="button"
        >
          <span aria-hidden="true">⋮</span>
        </button>
        {isOpen ? (
          <div
            aria-label={`Actions for job ${shortJobId(job.id)}`}
            className="job-overflow-menu"
            id={menuId}
            ref={(element) => {
              menuRefs.current[job.id] = element;
            }}
            role="menu"
          >
            <button
              className="job-overflow-item"
              onClick={() => selectNoteMenuItem(job)}
              role="menuitem"
              type="button"
            >
              {job.note ? "Edit note" : "Add note"}
            </button>
            {deleteBlocked ? (
              <>
                <button
                  aria-describedby={deleteHelpId}
                  className="job-overflow-item job-overflow-item-danger"
                  disabled
                  role="menuitem"
                  type="button"
                >
                  Delete job permanently
                </button>
                <p className="job-overflow-help" id={deleteHelpId}>
                  Cancel the remote job and wait for it to reach a terminal state before deleting it locally.
                </p>
              </>
            ) : (
              <button
                className="job-overflow-item job-overflow-item-danger"
                disabled={deletingJobId === job.id}
                onClick={() => {
                  deleteTriggerRef.current = menuTriggerRefs.current[job.id];
                  setOpenMenuJobId(null);
                  setDeleteCandidate(job);
                }}
                role="menuitem"
                type="button"
              >
                Delete job permanently
              </button>
            )}
          </div>
        ) : null}
      </div>
    );
  }

  function renderJobActions(job: StoredPredictionJob) {
    if (job.status === "completed") {
      return (
        <button
          className="secondary-button compact-button"
          onClick={() => onOpenResult(job.id)}
          type="button"
        >
          Open result
        </button>
      );
    }

    if (job.status === "submitting") {
      return <span>Submitting...</span>;
    }

    if (job.status === "uploaded_to_nibi" && onSubmitSlurmJob) {
      return (
        <button
          className="secondary-button compact-button"
          onClick={() => void onSubmitSlurmJob(job)}
          type="button"
        >
          Submit to Slurm
        </button>
      );
    }

    if (job.status === "uploaded_to_nibi") {
      return <span>Input uploaded. Submit to Slurm.</span>;
    }

    if (job.status === "slurm_submission_failed" && job.remote_slurm_id) {
      return (
        <>
          <span>Submission accepted by Slurm</span>
          {onRefreshJobStatus ? (
            <button
              className="secondary-button compact-button"
              disabled={refreshingJobs.has(job.id)}
              onClick={() => refreshJobStatus(job)}
              type="button"
            >
              {refreshingJobs.has(job.id) ? "Refreshing..." : "Resume monitoring"}
            </button>
          ) : null}
          {job.error_message ? (
            <details className="remote-check-details">
              <summary>Marker warning</summary>
              <pre>{job.error_message}</pre>
            </details>
          ) : null}
        </>
      );
    }

    if (job.status === "slurm_submission_failed") {
      return (
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
      );
    }

    if (job.status === "submitted_to_slurm" || job.status === "queued") {
      return (
        <>
          <span>{job.remote_slurm_id ? "View queued job" : "Submitted to Slurm"}</span>
          {onRefreshJobStatus ? (
            <button
              className="secondary-button compact-button"
              disabled={refreshingJobs.has(job.id)}
              onClick={() => refreshJobStatus(job)}
              type="button"
            >
              {refreshingJobs.has(job.id) ? "Refreshing..." : "Refresh status"}
            </button>
          ) : null}
          {onCancelRemoteJob && job.remote_slurm_id ? (
            <button
              className="secondary-button compact-button cancel-button"
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
      );
    }

    if (showReconnectPanel(job, nibiSettings, manualMfaSession)) {
      return (
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
      );
    }

    if (job.status === "login_required" && isManualSessionReady(manualMfaSession) && canSubmitToSlurm(job) && onSubmitSlurmJob) {
      return (
        <button
          className="secondary-button compact-button"
          onClick={() => void onSubmitSlurmJob(job)}
          type="button"
        >
          Submit to Slurm
        </button>
      );
    }

    if (job.status === "login_required" && isManualSessionReady(manualMfaSession) && canRefresh(job) && onRefreshJobStatus) {
      return (
        <button
          className="secondary-button compact-button"
          disabled={refreshingJobs.has(job.id)}
          onClick={() => refreshJobStatus(job)}
          type="button"
        >
          {refreshingJobs.has(job.id) ? "Refreshing..." : "Refresh status"}
        </button>
      );
    }

    if (job.status === "login_required") {
      return (
        <span>
          {usesPersistentShell(nibiSettings)
            ? "NIBI session required. Start a Manual MFA session and complete password + Duo."
            : "Open Settings, start the NIBI session, then press Test authenticated session before continuing."}
        </span>
      );
    }

    if (job.status === "robot_access_required" || job.status === "robot_auth_failed") {
      return (
        <button
          className="secondary-button compact-button"
          onClick={onOpenRobotSetup}
          type="button"
        >
          Open robot setup instructions
        </button>
      );
    }

    if (job.status === "output_missing" && canRefresh(job) && onRefreshJobStatus) {
      return (
        <button
          className="secondary-button compact-button"
          disabled={refreshingJobs.has(job.id)}
          onClick={() => refreshJobStatus(job)}
          type="button"
        >
          {refreshingJobs.has(job.id) ? "Refreshing..." : "Download result"}
        </button>
      );
    }

    if (job.status === "download_failed" && canRefresh(job) && onRefreshJobStatus) {
      return (
        <>
          <span>{job.error_message ?? "The prediction completed, but FluorCast could not download output.json."}</span>
          <button
            className="secondary-button compact-button"
            disabled={refreshingJobs.has(job.id)}
            onClick={() => refreshJobStatus(job)}
            type="button"
          >
            {refreshingJobs.has(job.id) ? "Refreshing..." : "Retry output download"}
          </button>
          {failureDetails(job) ? (
            <details className="remote-check-details">
              <summary>Failure details</summary>
              <pre>{failureDetails(job)}</pre>
            </details>
          ) : null}
        </>
      );
    }

    if (job.status === "output_invalid" && canRefresh(job) && onRefreshJobStatus) {
      return (
        <>
          <span>{job.error_message ?? "Remote output.json was downloaded but needs to be re-imported."}</span>
          <button
            className="secondary-button compact-button"
            disabled={refreshingJobs.has(job.id)}
            onClick={() => refreshJobStatus(job)}
            type="button"
          >
            {refreshingJobs.has(job.id) ? "Refreshing..." : "Retry result import"}
          </button>
          {failureDetails(job) ? (
            <details className="remote-check-details">
              <summary>Failure details</summary>
              <pre>{failureDetails(job)}</pre>
            </details>
          ) : null}
        </>
      );
    }

    if (
      job.status === "failed"
      || job.status === "upload_failed"
      || job.status === "cancelled"
      || job.status === "timed_out"
      || job.status === "timeout"
      || job.status === "unknown"
    ) {
      return (
        <>
          <span>{safeFailureSummary(job)}</span>
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
      );
    }

    if (isRemoteActive(job)) {
      return (
        <>
          <span>{job.status === "running" ? "View running job" : "View queued job"}</span>
          {onCancelRemoteJob && job.remote_slurm_id ? (
            <button
              className="secondary-button compact-button cancel-button"
              onClick={() => confirmAndCancel(job)}
              type="button"
            >
              Cancel remote job
            </button>
          ) : null}
        </>
      );
    }

    if (canRefresh(job) && onRefreshJobStatus) {
      return (
        <button
          className="secondary-button compact-button"
          disabled={refreshingJobs.has(job.id)}
          onClick={() => refreshJobStatus(job)}
          type="button"
        >
          {refreshingJobs.has(job.id) ? "Refreshing..." : "Refresh status"}
        </button>
      );
    }

    if (canSubmitToSlurm(job)) {
      return <span>Input uploaded. Submit to Slurm.</span>;
    }

    return <span>Loading</span>;
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
          <ol className="job-list">
            {jobs.map((job) => (
              <li
                className={isActiveJobStatus(job.status) ? "job-card job-card-active" : "job-card"}
                key={job.id}
              >
                <article aria-label={`Job ${job.id}`}>
                  <div className="job-card-header">
                    <div className="job-card-status">
                      <span className={`job-status job-status-${job.status}`}>
                        {statusLabels[job.status]}
                      </span>
                      <span className="job-card-created">{formatCreatedDate(job.created_at)}</span>
                    </div>
                    <div className="job-card-model">
                      <span className="step-label">Model choice</span>
                      <span>{job.model_choice}</span>
                    </div>
                    <div className="job-card-actions" aria-label={`Actions for job ${job.id}`}>
                      {renderJobActions(job)}
                      {renderOverflowMenu(job)}
                    </div>
                  </div>

                  <dl className="job-metadata-grid">
                    <div>
                      <dt>Local job ID</dt>
                      <dd><code className="job-metadata-value-wrap" title={job.id}>{job.id}</code></dd>
                    </div>
                    <div>
                      <dt>Molecule SMILES</dt>
                      <dd><code title={job.molecule_smiles}>{job.molecule_smiles}</code></dd>
                    </div>
                    <div>
                      <dt>Solvent SMILES</dt>
                      <dd><code title={job.solvent_smiles}>{job.solvent_smiles}</code></dd>
                    </div>
                    {job.remote_slurm_id ? (
                      <div>
                        <dt>Slurm ID</dt>
                        <dd><code title={job.remote_slurm_id}>{job.remote_slurm_id}</code></dd>
                      </div>
                    ) : null}
                  </dl>

                  {renderJobNote(job)}

                  {job.remote_job_dir ? (
                    <details className="remote-check-details job-detail-row">
                      <summary>Remote folder</summary>
                      <code title={job.remote_job_dir}>{job.remote_job_dir}</code>
                    </details>
                  ) : null}
                  {latestManualRefreshTraceByJob[job.id] || latestGlobalBannerWriteTrace ? (
                    <details className="remote-check-details job-detail-row">
                      <summary>Development diagnostics</summary>
                      <button
                        className="secondary-button compact-button"
                        onClick={() => copyDiagnostics(job)}
                        type="button"
                      >
                        Copy diagnostics
                      </button>
                      <pre>{formatRefreshDiagnosticsText(latestManualRefreshTraceByJob[job.id], latestGlobalBannerWriteTrace)}</pre>
                    </details>
                  ) : null}
                  {renderDeleteFeedback(job)}
                </article>
              </li>
            ))}
          </ol>
        </section>
      )}
      {deleteCandidate ? (
        <div className="dialog-backdrop" role="presentation">
          <div
            aria-labelledby="delete-job-dialog-title"
            aria-modal="true"
            className="confirmation-dialog"
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                closeDeleteDialog();
              }
            }}
            ref={deleteDialogRef}
            role="dialog"
            tabIndex={-1}
          >
            <h2 id="delete-job-dialog-title">Delete local job permanently?</h2>
            <p>
              The local job record will be permanently deleted. Locally stored results, events,
              logs, and related records will also be deleted. This action cannot be undone.
            </p>
            <p>
              The remote NIBI folder will not be deleted, and this action does not cancel an
              active Slurm job.
            </p>
            <dl className="confirmation-details">
              <div>
                <dt>Local job ID</dt>
                <dd><code>{deleteCandidate.id}</code></dd>
              </div>
              <div>
                <dt>Created</dt>
                <dd>{formatCreatedDate(deleteCandidate.created_at)}</dd>
              </div>
              <div>
                <dt>Model choice</dt>
                <dd>{deleteCandidate.model_choice}</dd>
              </div>
              <div>
                <dt>Status</dt>
                <dd>{statusLabels[deleteCandidate.status]}</dd>
              </div>
            </dl>
            <div className="button-row">
              <button
                className="secondary-button compact-button"
                disabled={deletingJobId === deleteCandidate.id}
                onClick={closeDeleteDialog}
                type="button"
              >
                Cancel
              </button>
              <button
                className="secondary-button compact-button cancel-button"
                disabled={deletingJobId === deleteCandidate.id}
                onClick={() => void confirmPermanentDelete()}
                type="button"
              >
                {deletingJobId === deleteCandidate.id ? "Deleting..." : "Permanently delete job"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
