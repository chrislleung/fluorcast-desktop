import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { AppShell, type AppPage } from "./components/AppShell";
import { AboutPage } from "./pages/AboutPage";
import { DiagnosticsPage } from "./pages/DiagnosticsPage";
import { HomePage } from "./pages/HomePage";
import { JobsPage } from "./pages/JobsPage";
import { NewPredictionPage } from "./pages/NewPredictionPage";
import { ResultDetailPage } from "./pages/ResultDetailPage";
import { SettingsPage } from "./pages/SettingsPage";
import {
  initialJobsState,
  jobsReducer,
  type StoredPredictionJob,
} from "../features/jobs";
import {
  defaultNibiSettings,
  loadNibiSettings,
  saveNibiSettings,
  type NibiSettings,
} from "../features/settings";
import {
  addJobEvent,
  getJobWithResult,
  getSetting,
  initializeDatabase,
  listJobs,
  saveJob,
  saveResult,
  saveSetting,
  updateJobStatus,
  type JobWithResult,
} from "../lib/db";
import {
  createRemoteExecutor,
  defaultManualMfaSessionState,
  InteractiveMfaRemoteExecutor,
  applyManualMfaSessionResult,
  applyManualMfaTerminalLaunchResult,
  cancelSlurmJob,
  pollSlurmJobStatus,
  submitPredictionSlurmJob,
  type ManualMfaSessionCommands,
  type ManualMfaSessionResult,
  type ManualMfaTerminalLaunchResult,
  type ManualMfaSessionUiState,
  type SlurmPollingResult,
} from "../lib/remote";
import { PredictionJobValidationError } from "../lib/schemas";

const ACCENT_COLOR_SETTING_KEY = "accentColor";
const SECONDARY_COLOR_SETTING_KEY = "secondaryColor";
const DEFAULT_SECONDARY_COLOR = "#8ee6c8";
type DatabaseStatus = "initializing" | "ready" | "fatal";
type PersistentShellSessionStatus = {
  process_id: number | null;
  started_at: string;
  status: "not_started" | "connecting" | "waiting_for_login_mfa" | "active" | "failed" | "disconnected";
  output: string;
  message: string;
};

function getPageFromHash(): { page: AppPage; jobId: string | null } {
  const hash = window.location.hash.replace(/^#\/?/, "");
  const [page, jobId] = hash.split("/");

  if (page === "result" && jobId) {
    return { page: "result", jobId };
  }
  if (page === "prediction" || page === "jobs" || page === "settings" || page === "diagnostics" || page === "about") {
    return { page, jobId: null };
  }
  return { page: "home", jobId: null };
}

function setHashForPage(page: AppPage, jobId?: string | null) {
  const nextHash = page === "result" && jobId ? `#/result/${jobId}` : `#/${page}`;
  if (window.location.hash !== nextHash) {
    window.location.hash = nextHash;
  }
}

export function App() {
  const initialLocation = getPageFromHash();
  const [currentPage, setCurrentPage] = useState<AppPage>(initialLocation.page);
  const [accentColor, setAccentColor] = useState("#8ab4ff");
  const [secondaryColor, setSecondaryColor] = useState(DEFAULT_SECONDARY_COLOR);
  const [nibiSettings, setNibiSettings] = useState<NibiSettings>(defaultNibiSettings);
  const [manualMfaSession, setManualMfaSession] = useState<ManualMfaSessionUiState>(
    defaultManualMfaSessionState,
  );
  const [selectedJobId, setSelectedJobId] = useState<string | null>(initialLocation.jobId);
  const [selectedJobDetail, setSelectedJobDetail] = useState<JobWithResult | null>(null);
  const [resultLoadError, setResultLoadError] = useState<string | null>(null);
  const [isResultLoading, setIsResultLoading] = useState(false);
  const [databaseError, setDatabaseError] = useState<string | null>(null);
  const [databaseStatus, setDatabaseStatus] = useState<DatabaseStatus>("initializing");
  const [jobsState, dispatchJobs] = useReducer(jobsReducer, initialJobsState);
  const [latestPollingResult, setLatestPollingResult] = useState<SlurmPollingResult | null>(null);
  const [manualMfaJobStatus, setManualMfaJobStatus] = useState("");
  const [isManualMfaJobActionWorking, setIsManualMfaJobActionWorking] = useState(false);
  const [lastJobsSessionProbeKey, setLastJobsSessionProbeKey] = useState("");
  const activeSlurmSubmissionsRef = useRef<Set<string>>(new Set());

  const selectedJob = selectedJobDetail ?? undefined;

  const refreshJobsFromDatabase = useCallback(async () => {
    const persistedJobs = await listJobs();
    dispatchJobs({ type: "set_jobs", jobs: persistedJobs });
  }, []);

  useEffect(() => {
    function syncPageFromHash() {
      const nextLocation = getPageFromHash();
      setCurrentPage(nextLocation.page);
      setSelectedJobId(nextLocation.jobId);
      if (nextLocation.page !== "result") {
        setSelectedJobDetail(null);
        setResultLoadError(null);
      }
    }

    window.addEventListener("hashchange", syncPageFromHash);
    return () => window.removeEventListener("hashchange", syncPageFromHash);
  }, []);

  useEffect(() => {
    let isMounted = true;

    async function loadPersistedState() {
      try {
        const initialized = await initializeDatabase();
        if (!isMounted) {
          return;
        }
        if (!initialized) {
          setDatabaseStatus("fatal");
          setDatabaseError("Local SQLite persistence is not available in this runtime.");
          return;
        }

        const [
          persistedAccentColor,
          persistedSecondaryColor,
          persistedNibiSettings,
          persistedJobs,
        ] = await Promise.all([
          getSetting(ACCENT_COLOR_SETTING_KEY),
          getSetting(SECONDARY_COLOR_SETTING_KEY),
          loadNibiSettings(),
          listJobs(),
        ]);

        if (!isMounted) {
          return;
        }

        if (persistedAccentColor) {
          setAccentColor(persistedAccentColor);
        }
        if (persistedSecondaryColor) {
          setSecondaryColor(persistedSecondaryColor);
        }
        setNibiSettings(persistedNibiSettings);
        dispatchJobs({ type: "set_jobs", jobs: persistedJobs });
        setDatabaseStatus("ready");
      } catch (error) {
        if (isMounted) {
          setDatabaseStatus("fatal");
          setDatabaseError(error instanceof Error ? error.message : "Local database failed to load.");
        }
      }
    }

    void loadPersistedState();

    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    let isMounted = true;

    async function loadSelectedJob() {
      if (!selectedJobId) {
        setSelectedJobDetail(null);
        setResultLoadError(null);
        return;
      }
      if (databaseStatus !== "ready") {
        return;
      }

      setIsResultLoading(true);
      setResultLoadError(null);
      try {
        const persistedJob = await getJobWithResult(selectedJobId);
        if (isMounted) {
          if (!persistedJob) {
            setSelectedJobDetail(null);
            setResultLoadError("No saved job was found for this result.");
            return;
          }
          setSelectedJobDetail(persistedJob);
        }
      } catch (error) {
        if (isMounted) {
          setSelectedJobDetail(null);
          setResultLoadError(
            error instanceof SyntaxError || error instanceof PredictionJobValidationError
              ? "Saved result exists, but the output JSON is invalid."
              : error instanceof Error
                ? error.message
                : "Local result failed to load.",
          );
        }
      } finally {
        if (isMounted) {
          setIsResultLoading(false);
        }
      }
    }

    void loadSelectedJob();

    return () => {
      isMounted = false;
    };
  }, [databaseStatus, selectedJobId]);

  useEffect(() => {
    if (databaseStatus !== "ready" || currentPage !== "jobs") {
      return;
    }

    void refreshJobsFromDatabase().catch((error: unknown) => {
      setDatabaseError(error instanceof Error ? error.message : "Local jobs failed to load.");
    });
  }, [currentPage, databaseStatus, refreshJobsFromDatabase]);

  function navigate(page: AppPage) {
    setHashForPage(page);
    if (page !== "result") {
      setSelectedJobId(null);
      setSelectedJobDetail(null);
      setResultLoadError(null);
    }
    setCurrentPage(page);
  }

  function openResult(jobId: string) {
    setHashForPage("result", jobId);
    setSelectedJobId(jobId);
    setSelectedJobDetail(null);
    setResultLoadError(null);
    setCurrentPage("result");
  }

  const createSelectedRemoteExecutor = useCallback(() => {
    const remoteExecutor = createRemoteExecutor(nibiSettings.connection_mode);
    if (remoteExecutor instanceof InteractiveMfaRemoteExecutor) {
      remoteExecutor.setAuthenticated(
        manualMfaSession.status === "authenticated"
        && manualMfaSession.can_run_background_commands,
      );
    }
    return remoteExecutor;
  }, [manualMfaSession, nibiSettings]);

  const createAuthenticatedManualExecutor = useCallback(() => {
    const remoteExecutor = createRemoteExecutor(nibiSettings.connection_mode);
    if (remoteExecutor instanceof InteractiveMfaRemoteExecutor) {
      remoteExecutor.setAuthenticated(true);
    }
    return remoteExecutor;
  }, [nibiSettings.connection_mode]);

  const isManualMfaReady = useCallback(() => (
    nibiSettings.connection_mode !== "interactive_mfa"
    || nibiSettings.manual_mfa_provider === "terminal_action"
    || (manualMfaSession.status === "authenticated" && manualMfaSession.can_run_background_commands)
  ), [manualMfaSession, nibiSettings.connection_mode, nibiSettings.manual_mfa_provider]);

  const testManualMfaSessionForJobs = useCallback(async (options: { jobsPageBlocked?: boolean } = {}) => {
    if (nibiSettings.connection_mode !== "interactive_mfa") {
      return true;
    }

    setIsManualMfaJobActionWorking(true);
    setManualMfaJobStatus("Testing the FluorCast Manual MFA session.");
    try {
      const result = await invoke<ManualMfaSessionResult>("test_manual_mfa_session", {
        settings: nibiSettings,
      });
      const nextSession = applyManualMfaSessionResult(manualMfaSession, result, {
        canMarkAuthenticated: true,
        jobsPageBlocked: options.jobsPageBlocked,
      });
      setManualMfaSession(nextSession);
      setManualMfaJobStatus(result.message);
      if (nextSession.can_run_background_commands) {
        const nextSettings = {
          ...nibiSettings,
          manual_login_verified: true,
          last_manual_login_check_at: nextSession.last_successful_command_at,
        };
        setNibiSettings(nextSettings);
        void saveNibiSettings(nextSettings);
      }
      return nextSession.status === "authenticated" && nextSession.can_run_background_commands;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Manual MFA session test could not run.";
      setManualMfaJobStatus(message);
      setManualMfaSession((current) => ({
        ...current,
        status: "failed",
        last_session_probe_at: new Date().toISOString(),
        last_session_test_result: message,
        can_run_background_commands: false,
        jobs_page_login_required_at: options.jobsPageBlocked ? new Date().toISOString() : current.jobs_page_login_required_at,
      }));
      return false;
    } finally {
      setIsManualMfaJobActionWorking(false);
    }
  }, [manualMfaSession, nibiSettings]);

  const startManualMfaLoginFromJobs = useCallback(async () => {
    if (nibiSettings.connection_mode !== "interactive_mfa") {
      return;
    }
    setIsManualMfaJobActionWorking(true);
    setManualMfaJobStatus("Starting the FluorCast Manual MFA login.");
    try {
      if (nibiSettings.manual_mfa_provider === "persistent_shell") {
        const result = await invoke<PersistentShellSessionStatus>("persistent_shell_start", {
          settings: nibiSettings,
        });
        setManualMfaSession((current) => ({
          ...current,
          status: result.status === "active" ? "authenticated" : "waiting_for_user_mfa",
          parsed_session_status: result.status === "active" ? "authenticated" : "authentication_required",
          selected_backend: "persistent_shell",
          session_started_at: result.started_at || current.session_started_at,
          can_run_background_commands: result.status === "active",
          last_session_test_result: result.message,
          persistent_shell_output: result.output,
          persistent_shell_process_id: result.process_id,
        }));
        setManualMfaJobStatus(result.message);
        setHashForPage("settings");
        setCurrentPage("settings");
        return;
      }
      const launch = await invoke<ManualMfaTerminalLaunchResult>("open_manual_mfa_login", {
        settings: nibiSettings,
      });
      setManualMfaSession((current) => applyManualMfaTerminalLaunchResult(current, launch));
      setManualMfaJobStatus(launch.message);
    } catch (error) {
      setManualMfaJobStatus(error instanceof Error ? error.message : "Could not open a terminal automatically. Start manual login from Settings.");
    } finally {
      setIsManualMfaJobActionWorking(false);
    }
  }, [nibiSettings]);

  const copyManualMfaLoginCommandFromJobs = useCallback(async () => {
    setManualMfaJobStatus("");
    try {
      const commands = await invoke<ManualMfaSessionCommands>("get_manual_mfa_session_commands", {
        settings: nibiSettings,
      });
      await navigator.clipboard.writeText(commands.login_command);
      setManualMfaSession((current) => ({
        ...current,
        control_path: commands.control_path,
        control_path_exists: commands.control_path_exists,
        manual_wsl_command: commands.manual_wsl_login_command,
      }));
      setManualMfaJobStatus("Manual MFA login command copied.");
    } catch (error) {
      setManualMfaJobStatus(error instanceof Error ? error.message : "Could not copy the Manual MFA login command.");
    }
  }, [nibiSettings]);

  const refreshRemoteJob = useCallback(async (job: StoredPredictionJob) => {
    const isTerminalAction = nibiSettings.connection_mode === "interactive_mfa" && nibiSettings.manual_mfa_provider === "terminal_action";
    if (isTerminalAction) {
      setIsManualMfaJobActionWorking(true);
      setManualMfaJobStatus("NIBI action running. Complete password/Duo in the PowerShell window.");
    }
    let remoteExecutor = createSelectedRemoteExecutor();
    try {
      if (nibiSettings.connection_mode === "interactive_mfa" && !isManualMfaReady()) {
        const ready = await testManualMfaSessionForJobs({ jobsPageBlocked: true });
        if (!ready) {
          await updateJobStatus(job.id, "login_required", {
            errorMessage: "Manual MFA mode runs each NIBI action in a visible PowerShell window. Complete password and Duo when prompted.",
          });
          await addJobEvent(job.id, "manual_mfa_session_required", "Jobs page blocked because the Manual MFA session is not reusable.");
          await refreshJobsFromDatabase();
          return {
            jobId: job.id,
            slurmJobId: job.remote_slurm_id,
            status: "login_required" as const,
            message: "Manual MFA mode runs each NIBI action in a visible PowerShell window. Complete password and Duo when prompted.",
          };
        }
        remoteExecutor = createAuthenticatedManualExecutor();
      }
      const result = await pollSlurmJobStatus(
        job,
        nibiSettings,
        remoteExecutor,
        { updateJobStatus, saveResult, addJobEvent },
      );
      setLatestPollingResult(result);
      if (isTerminalAction) {
        setManualMfaJobStatus(result.message);
      }
      await refreshJobsFromDatabase();
      if (selectedJobId === job.id) {
        const persistedJob = await getJobWithResult(job.id);
        setSelectedJobDetail(persistedJob);
      }
      return result;
    } finally {
      if (isTerminalAction) {
        setIsManualMfaJobActionWorking(false);
      }
    }
  }, [createAuthenticatedManualExecutor, createSelectedRemoteExecutor, isManualMfaReady, nibiSettings, refreshJobsFromDatabase, selectedJobId, testManualMfaSessionForJobs]);

  const submitRemoteSlurmJob = useCallback(async (job: StoredPredictionJob) => {
    const submissionId = job.submission_id ?? job.id;
    if (activeSlurmSubmissionsRef.current.has(submissionId)) {
      await addJobEvent(job.id, "slurm_submission_ignored", "duplicate Slurm submission ignored while an existing submission is active");
      return {
        jobId: job.id,
        status: job.remote_slurm_id ? "submitted_to_slurm" as const : "submitting" as const,
        message: job.remote_slurm_id ? `Slurm job ${job.remote_slurm_id} is already submitted.` : "Submission is already in progress.",
        remoteSlurmId: job.remote_slurm_id,
      };
    }
    activeSlurmSubmissionsRef.current.add(submissionId);
    const isTerminalAction = nibiSettings.connection_mode === "interactive_mfa" && nibiSettings.manual_mfa_provider === "terminal_action";
    if (isTerminalAction) {
      setIsManualMfaJobActionWorking(true);
      setManualMfaJobStatus("Slurm submission running. Complete password/Duo in the PowerShell window.");
    }
    await addJobEvent(job.id, "retry_slurm_submission_requested", "retry Slurm submission requested");
    let remoteExecutor = createSelectedRemoteExecutor();
    try {
      if (nibiSettings.connection_mode === "interactive_mfa" && !isManualMfaReady()) {
        const ready = await testManualMfaSessionForJobs({ jobsPageBlocked: true });
        if (!ready) {
          await updateJobStatus(job.id, "login_required", {
            errorMessage: "Manual MFA mode runs each NIBI action in a visible PowerShell window. Complete password and Duo when prompted.",
          });
          await addJobEvent(job.id, "manual_mfa_session_required", "Jobs page blocked because the Manual MFA session is not reusable.");
          await refreshJobsFromDatabase();
          return {
            jobId: job.id,
            status: "login_required" as const,
            message: "Manual MFA mode runs each NIBI action in a visible PowerShell window. Complete password and Duo when prompted.",
          };
        }
        remoteExecutor = createAuthenticatedManualExecutor();
      }
      const result = await submitPredictionSlurmJob(
        job,
        nibiSettings,
        remoteExecutor,
        { updateJobStatus, addJobEvent },
      );
      if (isTerminalAction) {
        setManualMfaJobStatus(result.message);
      }
      await refreshJobsFromDatabase();
      if (selectedJobId === job.id) {
        const persistedJob = await getJobWithResult(job.id);
        setSelectedJobDetail(persistedJob);
      }
      return result;
    } finally {
      activeSlurmSubmissionsRef.current.delete(submissionId);
      if (isTerminalAction) {
        setIsManualMfaJobActionWorking(false);
      }
    }
  }, [createAuthenticatedManualExecutor, createSelectedRemoteExecutor, isManualMfaReady, nibiSettings, refreshJobsFromDatabase, selectedJobId, testManualMfaSessionForJobs]);

  const cancelRemoteSlurmJob = useCallback(async (job: StoredPredictionJob) => {
    const remoteExecutor = createSelectedRemoteExecutor();
    const result = await cancelSlurmJob(
      job,
      nibiSettings,
      remoteExecutor,
      { updateJobStatus, addJobEvent },
    );
    setManualMfaJobStatus(result.message);
    await refreshJobsFromDatabase();
    return result;
  }, [createSelectedRemoteExecutor, nibiSettings, refreshJobsFromDatabase]);

  const testManualMfaSessionAndRetryJob = useCallback(async (job: StoredPredictionJob) => {
    const ready = await testManualMfaSessionForJobs({ jobsPageBlocked: true });
    if (!ready) {
      return false;
    }
    if (job.status === "uploaded_to_nibi" || job.status === "slurm_submission_failed") {
      await submitRemoteSlurmJob(job);
    } else if (job.remote_slurm_id) {
      await refreshRemoteJob(job);
    }
    return true;
  }, [refreshRemoteJob, submitRemoteSlurmJob, testManualMfaSessionForJobs]);

  useEffect(() => {
    if (
      databaseStatus !== "ready"
      || currentPage !== "jobs"
      || nibiSettings.connection_mode !== "interactive_mfa"
      || isManualMfaReady()
      || !hasManualMfaControlPath(nibiSettings, manualMfaSession)
      || !jobsState.jobs.some(needsRemoteJobAction)
    ) {
      return;
    }

    const probeKey = `${nibiSettings.wsl_control_socket_path || manualMfaSession.control_path}:${jobsState.jobs.map((job) => `${job.id}:${job.status}`).join(",")}`;
    if (probeKey === lastJobsSessionProbeKey) {
      return;
    }
    setLastJobsSessionProbeKey(probeKey);
    void testManualMfaSessionForJobs({ jobsPageBlocked: true }).catch((error: unknown) => {
      setManualMfaJobStatus(error instanceof Error ? error.message : "Manual MFA session probe failed.");
    });
  }, [
    currentPage,
    databaseStatus,
    isManualMfaReady,
    jobsState.jobs,
    lastJobsSessionProbeKey,
    manualMfaSession,
    nibiSettings,
    testManualMfaSessionForJobs,
  ]);

  const refreshActiveRemoteJobs = useCallback(async () => {
    for (const job of jobsState.jobs.filter(isPollableRemoteJob)) {
      await refreshRemoteJob(job);
    }
  }, [jobsState.jobs, refreshRemoteJob]);

  useEffect(() => {
    if (databaseStatus !== "ready") {
      return;
    }
    const activeJobs = jobsState.jobs.filter(isPollableRemoteJob);
    if (activeJobs.length === 0) {
      return;
    }
    const timer = window.setInterval(() => {
      void refreshActiveRemoteJobs().catch((error: unknown) => {
        setDatabaseError(error instanceof Error ? error.message : "Remote job polling failed.");
      });
    }, 15000);
    return () => window.clearInterval(timer);
  }, [databaseStatus, jobsState.jobs, refreshActiveRemoteJobs]);

  async function persistJobChange(job: StoredPredictionJob) {
    try {
      if (job.status === "completed" && job.output) {
        const resultSaved = await saveResult(job.id, job.output, job.completed_at);
        if (resultSaved) {
          await updateJobStatus(job.id, "completed", {
            completedAt: job.completed_at,
          });
          await addJobEvent(job.id, "completed", "Local mock prediction completed.", job.completed_at);
          dispatchJobs({ type: "add_job", job });
          await refreshJobsFromDatabase();
          return;
        }

        const failedJob: StoredPredictionJob = {
          ...job,
          status: "failed",
          completed_at: new Date().toISOString(),
          output: undefined,
          error_message: "Result persistence failed before the job could be marked completed.",
        };
        await updateJobStatus(job.id, "failed", {
          completedAt: failedJob.completed_at,
          errorMessage: failedJob.error_message,
        });
        dispatchJobs({ type: "add_job", job: failedJob });
        await refreshJobsFromDatabase();
        return;
      }

      const persisted = await saveJob(job);
      if (!persisted) {
        dispatchJobs({ type: "add_job", job });
        return;
      }

      if (job.status === "failed") {
        await updateJobStatus(job.id, "failed", {
          completedAt: job.completed_at,
          errorMessage: job.error_message,
        });
        await addJobEvent(job.id, "failed", job.error_message, job.completed_at);
      } else {
        await updateJobStatus(job.id, job.status);
        await addJobEvent(job.id, job.status, `Job status changed to ${job.status}.`);
      }

      dispatchJobs({ type: "add_job", job });
      await refreshJobsFromDatabase();
    } catch (error) {
      setDatabaseError(error instanceof Error ? error.message : "Local job failed to persist.");
    }
  }

  function handleAccentColorChange(color: string) {
    setAccentColor(color);
    void saveSetting(ACCENT_COLOR_SETTING_KEY, color).catch((error: unknown) => {
      setDatabaseError(error instanceof Error ? error.message : "Local setting failed to persist.");
    });
  }

  function handleSecondaryColorChange(color: string) {
    setSecondaryColor(color);
    void saveSetting(SECONDARY_COLOR_SETTING_KEY, color).catch((error: unknown) => {
      setDatabaseError(error instanceof Error ? error.message : "Local setting failed to persist.");
    });
  }

  async function handleNibiSettingsSave(settings: NibiSettings) {
    const saved = await saveNibiSettings(settings);
    if (saved) {
      setNibiSettings(settings);
    }
    return saved;
  }

  function renderResultPage(job: StoredPredictionJob | undefined) {
    if (databaseStatus === "initializing") {
      return (
        <div className="page narrow-page">
          <section className="empty-state loading-state">
            <span className="empty-icon" aria-hidden="true">...</span>
            <h2>Opening local database</h2>
            <p>Waiting for SQLite persistence before loading this result.</p>
          </section>
        </div>
      );
    }

    if (databaseStatus === "fatal") {
      return (
        <div className="page narrow-page">
          <section className="empty-state failed-state">
            <span className="empty-icon" aria-hidden="true">!</span>
            <h2>Persistence unavailable</h2>
            <p>{databaseError ?? "Local SQLite persistence could not be initialized."}</p>
          </section>
        </div>
      );
    }

    if (isResultLoading && selectedJobId && !job?.output) {
      return (
        <div className="page narrow-page">
          <section className="empty-state loading-state">
            <span className="empty-icon" aria-hidden="true">...</span>
            <h2>Loading result</h2>
            <p>Reading the saved local result from this device.</p>
          </section>
        </div>
      );
    }

    if (resultLoadError) {
      return (
        <div className="page narrow-page">
          <section className="empty-state failed-state">
            <span className="empty-icon" aria-hidden="true">!</span>
            <h2>Result unavailable</h2>
            <p>{resultLoadError}</p>
          </section>
        </div>
      );
    }

    if (!job) {
      return (
        <div className="page narrow-page">
          <section className="empty-state">
            <span className="empty-icon" aria-hidden="true">?</span>
            <h2>No job selected</h2>
            <p>Select a completed job from the job history table.</p>
          </section>
        </div>
      );
    }

    if (
      job.status === "queued_locally"
      || job.status === "submitting"
      || job.status === "running"
      || job.status === "submitted_to_slurm"
      || job.status === "uploaded_to_nibi"
      || job.status === "upload_waiting_for_login"
      || job.status === "connection_failed"
    ) {
      return (
        <div className="page narrow-page">
          <section className="empty-state loading-state">
            <span className="empty-icon" aria-hidden="true">...</span>
            <h2>{job.status === "uploaded_to_nibi" ? "Uploaded to NIBI" : job.status === "slurm_submission_failed" ? "Slurm submission failed" : job.status === "upload_waiting_for_login" ? "Waiting for login" : job.status === "queued_locally" ? "Queued locally" : job.status === "submitted_to_slurm" ? "Submitted to Slurm" : job.status === "output_missing" ? "Waiting for output" : "Running"}</h2>
            <p>{job.error_message ?? (job.remote_slurm_id ? `Slurm job ${job.remote_slurm_id}` : "This prediction is still being prepared.")}</p>
          </section>
        </div>
      );
    }

    if (job.status === "login_required") {
      return (
        <div className="page narrow-page">
          <section className="empty-state failed-state">
            <span className="empty-icon" aria-hidden="true">!</span>
            <h2>Reconnect to NIBI</h2>
            <p>{job.error_message ?? "Your NIBI login session expired. Reconnect to NIBI, then refresh this job."}</p>
            <button className="primary-button" onClick={() => navigate("settings")} type="button">
              Go to Settings and reconnect
            </button>
          </section>
        </div>
      );
    }

    if (job.status === "robot_access_required" || job.status === "robot_auth_failed") {
      return (
        <div className="page narrow-page">
          <section className="empty-state failed-state">
            <span className="empty-icon" aria-hidden="true">!</span>
            <h2>Robot automation not ready</h2>
            <p>{job.error_message ?? "Robot automation is not ready. Upload the restricted public key to Alliance/CCDB and ask support to enable robot-node access."}</p>
            <button className="primary-button" onClick={() => navigate("settings")} type="button">
              Open robot setup instructions
            </button>
          </section>
        </div>
      );
    }

    if (job.status === "output_missing") {
      return (
        <div className="page narrow-page">
          <section className="empty-state loading-state">
            <span className="empty-icon" aria-hidden="true">...</span>
            <h2>Waiting for output</h2>
            <p>{job.error_message ?? "The job finished, but output.json is not available yet."}</p>
            <button
              className="primary-button"
              disabled={!job.remote_slurm_id}
              onClick={() => void refreshRemoteJob(job)}
              type="button"
            >
              Refresh status
            </button>
          </section>
        </div>
      );
    }

    if (
      job.status === "failed"
      || job.status === "upload_failed"
      || job.status === "slurm_submission_failed"
      || job.status === "cancelled"
      || job.status === "timeout"
      || job.status === "output_invalid"
      || job.status === "download_failed"
    ) {
      return (
        <div className="page narrow-page">
          <section className="empty-state failed-state">
            <span className="empty-icon" aria-hidden="true">!</span>
            <h2>Prediction failed</h2>
            <p>{job.error_message ?? "No error message was recorded."}</p>
            {latestPollingResult?.jobId === job.id && latestPollingResult.technicalDetails ? (
              <pre>{latestPollingResult.technicalDetails}</pre>
            ) : null}
          </section>
        </div>
      );
    }

    if (!job.output) {
      return (
        <div className="page narrow-page">
          <section className="empty-state failed-state">
            <span className="empty-icon" aria-hidden="true">!</span>
            <h2>Saved result missing</h2>
            <p>This job is marked completed, but no saved result was found.</p>
          </section>
        </div>
      );
    }

    return (
      <div className="page narrow-page">
        <ResultDetailPage output={job.output} />
      </div>
    );
  }

  function renderPage() {
    if (databaseStatus === "initializing") {
      return (
        <div className="page narrow-page">
          <section className="empty-state loading-state">
            <span className="empty-icon" aria-hidden="true">...</span>
            <h2>Opening local database</h2>
            <p>Preparing SQLite persistence.</p>
          </section>
        </div>
      );
    }

    if (databaseStatus === "fatal") {
      return (
        <div className="page narrow-page">
          <section className="empty-state failed-state">
            <span className="empty-icon" aria-hidden="true">!</span>
            <h2>Fatal persistence error</h2>
            <p>{databaseError ?? "Local SQLite persistence could not be initialized."}</p>
          </section>
        </div>
      );
    }

    switch (currentPage) {
      case "home":
        return <HomePage />;
      case "prediction":
        return (
          <NewPredictionPage
            manualMfaSession={manualMfaSession}
            nibiSettings={nibiSettings}
            onJobChange={persistJobChange}
            onOpenResult={openResult}
            onOpenSettings={() => navigate("settings")}
          />
        );
      case "jobs":
        if (databaseStatus === "initializing") {
          return (
            <div className="page narrow-page">
              <section className="empty-state loading-state">
                <span className="empty-icon" aria-hidden="true">...</span>
                <h2>Opening local database</h2>
                <p>Loading persisted jobs from SQLite.</p>
              </section>
            </div>
          );
        }
        return (
          <JobsPage
            jobs={jobsState.jobs}
            isManualMfaWorking={isManualMfaJobActionWorking}
            manualMfaSession={manualMfaSession}
            manualMfaStatus={manualMfaJobStatus}
            nibiSettings={nibiSettings}
            onOpenResult={openResult}
            onOpenManualMfaDiagnostics={() => navigate("settings")}
            onOpenRobotSetup={() => navigate("settings")}
            onCopyManualMfaLoginCommand={copyManualMfaLoginCommandFromJobs}
            onReconnect={() => navigate("settings")}
            onRefreshJobStatus={refreshRemoteJob}
            onCancelRemoteJob={cancelRemoteSlurmJob}
            onStartManualMfaLogin={startManualMfaLoginFromJobs}
            onSubmitSlurmJob={submitRemoteSlurmJob}
            onTestManualMfaSession={testManualMfaSessionAndRetryJob}
          />
        );
      case "settings":
        return (
          <SettingsPage
            accentColor={accentColor}
            manualMfaSession={manualMfaSession}
            nibiSettings={nibiSettings}
            secondaryColor={secondaryColor}
            onAccentColorChange={handleAccentColorChange}
            onManualMfaSessionChange={setManualMfaSession}
            onNibiSettingsSave={handleNibiSettingsSave}
            onSecondaryColorChange={handleSecondaryColorChange}
          />
        );
      case "diagnostics":
        return (
          <DiagnosticsPage
            isDatabaseReady={databaseStatus === "ready"}
            manualMfaSession={manualMfaSession}
            nibiSettings={nibiSettings}
            activeJobsCount={jobsState.jobs.filter(isPollableRemoteJob).length}
            jobsPageLoginRequiredCount={jobsState.jobs.filter((job) => job.status === "login_required").length}
            latestPollingResult={latestPollingResult}
            onJobsRefresh={(jobs) => dispatchJobs({ type: "set_jobs", jobs })}
            onOpenResult={openResult}
          />
        );
      case "about":
        return <AboutPage />;
      case "result":
        return renderResultPage(selectedJob);
    }
  }

  return (
    <AppShell
      accentColor={accentColor}
      currentPage={currentPage}
      onNavigate={navigate}
      secondaryColor={secondaryColor}
    >
      {databaseError ? (
        <div className="app-alert" role="status">
          Local persistence warning: {databaseError}
        </div>
      ) : null}
      {renderPage()}
    </AppShell>
  );
}

function isPollableRemoteJob(job: StoredPredictionJob) {
  return Boolean(job.remote_slurm_id) && (
    job.status === "submitted_to_slurm"
    || job.status === "running"
    || job.status === "output_missing"
    || job.status === "login_required"
    || job.status === "connection_failed"
  );
}

function needsRemoteJobAction(job: StoredPredictionJob) {
  return job.status === "uploaded_to_nibi"
    || job.status === "submitting"
    || job.status === "slurm_submission_failed"
    || job.status === "submitted_to_slurm"
    || job.status === "running"
    || job.status === "login_required";
}

function hasManualMfaControlPath(
  settings: NibiSettings,
  session: ManualMfaSessionUiState,
) {
  return Boolean(session.control_path || settings.wsl_control_socket_path);
}
