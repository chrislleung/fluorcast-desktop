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
  cancelSlurmJob,
  pollSlurmJobStatus,
  submitPredictionSlurmJob,
  type ManualMfaSessionResult,
  type ManualMfaSessionUiState,
  SlurmPollingCoordinator,
  createRefreshTraceId,
  type SlurmPollingCoordinatorDiagnostics,
  type SlurmPollingCoordinatorOptions,
  type SlurmPollingResult,
} from "../lib/remote";
import { PredictionJobValidationError } from "../lib/schemas";

const ACCENT_COLOR_SETTING_KEY = "accentColor";
const SECONDARY_COLOR_SETTING_KEY = "secondaryColor";
const DEFAULT_SECONDARY_COLOR = "#8ee6c8";
type DatabaseStatus = "initializing" | "ready" | "fatal";
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
  const [pollingDiagnostics, setPollingDiagnostics] = useState<SlurmPollingCoordinatorDiagnostics | null>(null);
  const [manualMfaJobStatus, setManualMfaJobStatus] = useState("");
  const [lastJobsSessionProbeKey, setLastJobsSessionProbeKey] = useState("");
  const activeSlurmSubmissionsRef = useRef<Set<string>>(new Set());
  const pollingCoordinatorRef = useRef<SlurmPollingCoordinator | null>(null);
  const nibiSettingsRef = useRef(nibiSettings);
  const manualMfaSessionRef = useRef(manualMfaSession);
  const jobsStateRef = useRef(jobsState);
  const selectedJobIdRef = useRef(selectedJobId);
  const manualMfaHealthRef = useRef<{
    promise: Promise<boolean> | null;
    lastSuccessAt: number;
    lastResult: ManualMfaSessionResult | null;
  }>({
    promise: null,
    lastSuccessAt: 0,
    lastResult: null,
  });
  const pollingDiagnosticsUpdateRef = useRef<{
    lastUpdatedAt: number;
    timer: ReturnType<typeof setTimeout> | null;
    pending: SlurmPollingCoordinatorDiagnostics | null;
  }>({
    lastUpdatedAt: 0,
    timer: null,
    pending: null,
  });
  const runRemoteRefreshRef = useRef<SlurmPollingCoordinatorOptions["runRemoteRefresh"]>(async () => {
    throw new Error("Slurm polling coordinator was used before it was initialized.");
  });
  const handlePollingResultRef = useRef<NonNullable<SlurmPollingCoordinatorOptions["onResult"]>>(async () => undefined);
  const handleStalePollingResultRef = useRef<NonNullable<SlurmPollingCoordinatorOptions["onStaleResult"]>>(async () => undefined);
  const handlePollingErrorRef = useRef<NonNullable<SlurmPollingCoordinatorOptions["onError"]>>(async () => undefined);

  const selectedJob = selectedJobDetail ?? undefined;

  useEffect(() => {
    nibiSettingsRef.current = nibiSettings;
    manualMfaSessionRef.current = manualMfaSession;
    jobsStateRef.current = jobsState;
    selectedJobIdRef.current = selectedJobId;
  });

  const refreshJobsFromDatabase = useCallback(async () => {
    const persistedJobs = await listJobs();
    dispatchJobs({ type: "set_jobs", jobs: persistedJobs });
  }, []);

  const patchJobFromStatusUpdate = useCallback((
    id: string,
    status: StoredPredictionJob["status"],
    options: Parameters<typeof updateJobStatus>[2] = {},
  ) => {
    const oldStatus = jobsStateRef.current.jobs.find((job) => job.id === id)?.status;
    pollingCoordinatorRef.current?.recordLatestManualRefreshTrace({
      id,
      molecule_smiles: "",
      solvent_smiles: "",
      model_choice: "",
      status,
      created_at: new Date().toISOString(),
    }, "REDUCER_UPDATE_ATTEMPTED", {
      LOCAL_JOB_ID: id,
      OLD_STATUS: oldStatus,
      NEW_STATUS: status,
      WRITER_FUNCTION: "App.patchJobFromStatusUpdate",
      REASON: "persistence_updateJobStatus",
    });
    const patch: Partial<StoredPredictionJob> = { status };
    if (options.completedAt !== undefined) patch.completed_at = options.completedAt;
    if (options.remoteSlurmId !== undefined) patch.remote_slurm_id = options.remoteSlurmId;
    if (options.remoteJobDir !== undefined) patch.remote_job_dir = options.remoteJobDir;
    if (options.remoteInputPath !== undefined) patch.remote_input_path = options.remoteInputPath;
    if (options.remoteOutputPath !== undefined) patch.remote_output_path = options.remoteOutputPath;
    if (options.submissionId !== undefined) patch.submission_id = options.submissionId;
    if (options.submittedAt !== undefined) patch.submitted_at = options.submittedAt;
    if (options.slurmState !== undefined) patch.slurm_state = options.slurmState;
    if (options.slurmExitCode !== undefined) patch.slurm_exit_code = options.slurmExitCode;
    if (options.slurmStdout !== undefined) patch.slurm_stdout = options.slurmStdout;
    if (options.slurmStderr !== undefined) patch.slurm_stderr = options.slurmStderr;
    if (options.submittedCommand !== undefined) patch.submitted_command = options.submittedCommand;
    if ("errorMessage" in options) patch.error_message = options.errorMessage;

    dispatchJobs({
      type: "patch_job",
      id,
      patch,
    });
    pollingCoordinatorRef.current?.recordLatestManualRefreshTrace({
      id,
      molecule_smiles: "",
      solvent_smiles: "",
      model_choice: "",
      status,
      created_at: new Date().toISOString(),
    }, "REDUCER_UPDATE_APPLIED", {
      LOCAL_JOB_ID: id,
      OLD_STATUS: oldStatus,
      NEW_STATUS: status,
      WRITER_FUNCTION: "App.patchJobFromStatusUpdate",
      REASON: "dispatch_patch_job",
      APPLIED_OR_IGNORED: oldStatus === status ? "ignored" : "applied",
    });
  }, []);

  const pollingPersistenceRef = useRef<SlurmPollingCoordinatorOptions["persistence"]>({
    updateJobStatus: async (jobId, status, options) => {
      const updated = await updateJobStatus(jobId, status, options);
      if (updated) {
        patchJobFromStatusUpdate(jobId, status, options);
      }
      return updated;
    },
    saveResult: async (jobId, output, downloadedAt) => {
      const saved = await saveResult(jobId, output, downloadedAt);
      if (saved) {
        dispatchJobs({
          type: "complete_job",
          id: jobId,
          completed_at: downloadedAt ?? output.completed_at,
          output,
        });
      }
      return saved;
    },
    addJobEvent,
  });

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

  function isJobRefreshInFlight(jobId: string) {
    return (pollingDiagnostics?.inFlightRequestCountByJob[jobId] ?? 0) > 0;
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
    || (manualMfaSession.status === "authenticated" && manualMfaSession.can_run_background_commands)
  ), [manualMfaSession, nibiSettings.connection_mode]);

  const createPollingRemoteExecutor = useCallback((forceAuthenticated = false) => {
    const currentSettings = nibiSettingsRef.current;
    const currentSession = manualMfaSessionRef.current;
    const remoteExecutor = createRemoteExecutor(currentSettings.connection_mode);
    if (remoteExecutor instanceof InteractiveMfaRemoteExecutor) {
      remoteExecutor.setAuthenticated(
        forceAuthenticated
        || (
          currentSession.status === "authenticated"
          && currentSession.can_run_background_commands
        ),
      );
    }
    return remoteExecutor;
  }, []);

  const updateLiveSessionState = useCallback((session: ManualMfaSessionUiState, writer = "App.updateLiveSessionState") => {
    setManualMfaSession(session);
    if (session.status === "authenticated" && session.can_run_background_commands) {
      pollingCoordinatorRef.current?.markSessionAuthenticated({
        writer,
        reason: "FLUORCAST_AUTH_OK",
      });
    }
  }, []);

  const testManualMfaSessionForJobs = useCallback(async (options: { jobsPageBlocked?: boolean; force?: boolean; refreshTraceId?: string; job?: StoredPredictionJob } = {}) => {
    const currentSettings = nibiSettingsRef.current;
    if (currentSettings.connection_mode !== "interactive_mfa") {
      return true;
    }
    if (options.refreshTraceId && options.job) {
      pollingCoordinatorRef.current?.recordManualRefreshTrace(options.job, options.refreshTraceId, "SESSION_STATE_BEFORE", {
        SESSION_STATE_BEFORE: manualMfaSessionRef.current.status,
        canRunBackgroundCommands: manualMfaSessionRef.current.can_run_background_commands,
      });
    }

    const cached = manualMfaHealthRef.current;
    if (!options.force && cached.lastResult?.can_run_background_commands && Date.now() - cached.lastSuccessAt < 45_000) {
      return true;
    }
    if (cached.promise) {
      return cached.promise;
    }

    setManualMfaJobStatus("Testing the FluorCast Manual MFA session.");
    const probe = (async () => {
      if (options.refreshTraceId && options.job) {
        pollingCoordinatorRef.current?.recordManualRefreshTrace(options.job, options.refreshTraceId, "SESSION_CHECK_STARTED", {
          SESSION_CHECK_STARTED: true,
        });
      }
      const result = await invoke<ManualMfaSessionResult>("test_manual_mfa_session", {
        settings: currentSettings,
      });
      if (options.refreshTraceId && options.job) {
        pollingCoordinatorRef.current?.recordManualRefreshTrace(options.job, options.refreshTraceId, "SESSION_CHECK_EXIT_CODE", {
          SESSION_CHECK_EXIT_CODE: result.success ? 0 : 1,
        });
        pollingCoordinatorRef.current?.recordManualRefreshTrace(options.job, options.refreshTraceId, "SESSION_CHECK_STDOUT", {
          SESSION_CHECK_STDOUT: result.last_session_test_stdout ?? "",
        });
        pollingCoordinatorRef.current?.recordManualRefreshTrace(options.job, options.refreshTraceId, "SESSION_CHECK_STDERR", {
          SESSION_CHECK_STDERR: result.last_session_test_stderr ?? "",
        });
        pollingCoordinatorRef.current?.recordManualRefreshTrace(options.job, options.refreshTraceId, "SESSION_AUTH_MARKER_FOUND", {
          SESSION_AUTH_MARKER_FOUND: result.status === "authenticated" || result.can_run_background_commands,
        });
      }
      const nextSession = applyManualMfaSessionResult(manualMfaSessionRef.current, result, {
        canMarkAuthenticated: true,
        jobsPageBlocked: options.jobsPageBlocked,
      });
      updateLiveSessionState(nextSession, "App.testManualMfaSessionForJobs");
      setManualMfaJobStatus(result.message);
      manualMfaHealthRef.current.lastResult = result;
      if (!nextSession.can_run_background_commands) {
        pollingCoordinatorRef.current?.markSessionUnavailable({
          writer: "App.testManualMfaSessionForJobs",
          reason: result.status,
          message: result.message,
          relatedRefreshTraceId: options.refreshTraceId,
        });
      }
      if (nextSession.can_run_background_commands) {
        const nextSettings = {
          ...currentSettings,
          manual_login_verified: true,
          last_manual_login_check_at: nextSession.last_successful_command_at,
        };
        manualMfaHealthRef.current.lastSuccessAt = Date.now();
        setNibiSettings(nextSettings);
        void saveNibiSettings(nextSettings);
      }
      return nextSession.status === "authenticated" && nextSession.can_run_background_commands;
    })();
    manualMfaHealthRef.current.promise = probe;
    try {
      return await probe;
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
      pollingCoordinatorRef.current?.markSessionUnavailable({
        writer: "App.testManualMfaSessionForJobs",
        reason: "session_check_failed",
        message,
        relatedRefreshTraceId: options.refreshTraceId,
      });
      return false;
    } finally {
      if (manualMfaHealthRef.current.promise === probe) {
        manualMfaHealthRef.current.promise = null;
      }
    }
  }, [updateLiveSessionState]);

  runRemoteRefreshRef.current = async (job, { generation, persistence, wrapExecutor, refreshTraceId, diagnostics }) => {
    const currentSettings = nibiSettingsRef.current;
    let remoteExecutor = createPollingRemoteExecutor();
    if (currentSettings.connection_mode === "interactive_mfa") {
      const ready = await testManualMfaSessionForJobs({ jobsPageBlocked: true, refreshTraceId, job });
      if (!ready) {
        const result = manualMfaHealthRef.current.lastResult;
        const message = result?.message || "Open Settings, start the NIBI session, then press Test authenticated session before continuing.";
        await persistence.updateJobStatus(job.id, "login_required", { errorMessage: message });
        await persistence.addJobEvent(job.id, "manual_mfa_session_required", "Jobs page blocked because the Manual MFA session is not reusable.");
        return {
          jobId: job.id,
          slurmJobId: job.remote_slurm_id,
          status: "login_required",
          message,
          technicalDetails: [
            `POLL_GENERATION=${generation}`,
            result?.last_session_test_stdout ? `SESSION_STDOUT=\n${result.last_session_test_stdout}` : "",
            result?.last_session_test_stderr ? `SESSION_STDERR=\n${result.last_session_test_stderr}` : "",
          ].filter(Boolean).join("\n"),
          appError: {
            code: "interactive_session_expired",
            message,
          },
        };
      }
      remoteExecutor = createPollingRemoteExecutor(true);
    }
    return pollSlurmJobStatus(
      job,
      currentSettings,
      wrapExecutor(remoteExecutor),
      persistence,
      diagnostics,
    );
  };

  handlePollingResultRef.current = async (job, result, meta) => {
    const refreshTraceId = result.technicalDetails?.match(/REFRESH_TRACE_ID=([^\n]+)/)?.[1];
    if (refreshTraceId) {
      pollingCoordinatorRef.current?.recordManualRefreshTrace(job, refreshTraceId, "APP_RECEIVED_STATUS", {
        APP_RECEIVED_STATUS: result.status,
        POLL_GENERATION: meta.generation,
        POLL_STALE: meta.stale,
      });
    }
    setLatestPollingResult({
      ...result,
      technicalDetails: [
        `POLL_GENERATION=${meta.generation}`,
        `POLL_STALE=${meta.stale ? 1 : 0}`,
        result.technicalDetails,
      ].filter(Boolean).join("\n"),
    });
    if (selectedJobIdRef.current === job.id) {
      const persistedJob = await getJobWithResult(job.id);
      setSelectedJobDetail(persistedJob);
    }
  };

  handleStalePollingResultRef.current = async (job, _result, meta) => {
    const refreshTraceId = _result.technicalDetails?.match(/REFRESH_TRACE_ID=([^\n]+)/)?.[1];
    if (refreshTraceId) {
      pollingCoordinatorRef.current?.recordManualRefreshTrace(job, refreshTraceId, "APP_RECEIVED_STATUS", {
        APP_RECEIVED_STATUS: _result.status,
        POLL_GENERATION: meta.generation,
        POLL_STALE: true,
      });
    }
    await addJobEvent(job.id, "slurm_poll_stale_response_ignored", `STALE_RESPONSE_IGNORED=1\nPOLL_GENERATION=${meta.generation}`);
  };

  handlePollingErrorRef.current = async (_job, error) => {
    setDatabaseError(error instanceof Error ? error.message : "Remote job polling failed.");
  };

  const refreshRemoteJob = useCallback(async (job: StoredPredictionJob, providedTraceId?: string) => {
    const traceId = providedTraceId ?? createRefreshTraceId();
    pollingCoordinatorRef.current?.recordManualRefreshTrace(job, traceId, "BUTTON_CLICKED", {
      REFRESH_TRACE_ID: traceId,
      LOCAL_JOB_ID: job.id,
      SLURM_ID: job.remote_slurm_id,
      REMOTE_JOB_DIR: job.remote_job_dir,
    });
    pollingCoordinatorRef.current?.recordManualRefreshTrace(job, traceId, "APP_CALLBACK_STARTED", {
      REFRESH_TRACE_ID: traceId,
    });
    await (pollingCoordinatorRef.current?.refreshNow(job, { traceId }) ?? runRemoteRefreshRef.current(job, {
      generation: 0,
      persistence: pollingPersistenceRef.current,
      wrapExecutor: (executor) => executor,
      refreshTraceId: traceId,
    }));
    await refreshJobsFromDatabase();
    const refreshedJob = await getJobWithResult(job.id);
    pollingCoordinatorRef.current?.recordManualRefreshTrace(job, traceId, "FINAL_RENDERED_STATUS", {
      FINAL_RENDERED_STATUS: refreshedJob?.status ?? "missing",
    });
    if (selectedJobIdRef.current === job.id) {
      setSelectedJobDetail(refreshedJob);
    }
    return refreshedJob;
  }, [refreshJobsFromDatabase]);

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
    await addJobEvent(job.id, "retry_slurm_submission_requested", "retry Slurm submission requested");
    let remoteExecutor = createSelectedRemoteExecutor();
    try {
      if (nibiSettings.connection_mode === "interactive_mfa" && !isManualMfaReady()) {
        const ready = await testManualMfaSessionForJobs({ jobsPageBlocked: true });
        if (!ready) {
          await updateJobStatus(job.id, "login_required", {
            errorMessage: "Open Settings, start the NIBI session, then press Test authenticated session before continuing.",
          });
          await addJobEvent(job.id, "manual_mfa_session_required", "Jobs page blocked because the Manual MFA session is not reusable.");
          await refreshJobsFromDatabase();
          return {
            jobId: job.id,
            status: "login_required" as const,
            message: "Open Settings, start the NIBI session, then press Test authenticated session before continuing.",
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
      setManualMfaJobStatus(result.message);
      await refreshJobsFromDatabase();
      if (result.remoteSlurmId) {
        const persistedJob = await getJobWithResult(job.id);
        if (persistedJob) {
          await refreshRemoteJob(persistedJob);
        }
      }
      if (selectedJobId === job.id) {
        const persistedJob = await getJobWithResult(job.id);
        setSelectedJobDetail(persistedJob);
      }
      return result;
    } finally {
      activeSlurmSubmissionsRef.current.delete(submissionId);
    }
  }, [createAuthenticatedManualExecutor, createSelectedRemoteExecutor, isManualMfaReady, nibiSettings, refreshJobsFromDatabase, refreshRemoteJob, selectedJobId, testManualMfaSessionForJobs]);

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

  useEffect(() => {
    const diagnosticsUpdate = pollingDiagnosticsUpdateRef.current;
    const handleDiagnosticsChange = (diagnostics: SlurmPollingCoordinatorDiagnostics) => {
      const updateState = (next: SlurmPollingCoordinatorDiagnostics) => {
        diagnosticsUpdate.lastUpdatedAt = Date.now();
        diagnosticsUpdate.pending = null;
        setPollingDiagnostics(next);
      };
      const elapsed = Date.now() - diagnosticsUpdate.lastUpdatedAt;
      if (elapsed >= 500) {
        updateState(diagnostics);
        return;
      }
      diagnosticsUpdate.pending = diagnostics;
      if (diagnosticsUpdate.timer) {
        return;
      }
      diagnosticsUpdate.timer = setTimeout(() => {
        diagnosticsUpdate.timer = null;
        const pending = diagnosticsUpdate.pending;
        if (pending) {
          updateState(pending);
        }
      }, 500 - elapsed);
    };
    const coordinator = new SlurmPollingCoordinator({
      persistence: pollingPersistenceRef.current,
      runRemoteRefresh: (...args) => runRemoteRefreshRef.current(...args),
      onResult: (...args) => handlePollingResultRef.current(...args),
      onStaleResult: (...args) => handleStalePollingResultRef.current(...args),
      onError: (...args) => handlePollingErrorRef.current(...args),
      onDiagnosticsChange: handleDiagnosticsChange,
    });
    pollingCoordinatorRef.current = coordinator;

    return () => {
      coordinator.shutdown();
      if (pollingCoordinatorRef.current === coordinator) {
        pollingCoordinatorRef.current = null;
      }
      if (diagnosticsUpdate.timer) {
        clearTimeout(diagnosticsUpdate.timer);
        diagnosticsUpdate.timer = null;
      }
    };
  }, []);

  useEffect(() => {
    const coordinator = pollingCoordinatorRef.current;
    if (!coordinator) {
      return;
    }
    if (databaseStatus !== "ready") {
      coordinator.syncJobs([]);
      return;
    }
    coordinator.syncJobs(jobsState.jobs);
  }, [databaseStatus, jobsState.jobs]);

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
        await updateJobStatus(job.id, job.status, {
          completedAt: job.completed_at,
          remoteSlurmId: job.remote_slurm_id,
          remoteJobDir: job.remote_job_dir,
          remoteInputPath: job.remote_input_path,
          remoteOutputPath: job.remote_output_path,
          submissionId: job.submission_id,
          submittedAt: job.submitted_at,
          slurmState: job.slurm_state,
          slurmExitCode: job.slurm_exit_code,
          slurmStdout: job.slurm_stdout,
          slurmStderr: job.slurm_stderr,
          submittedCommand: job.submitted_command,
          errorMessage: job.error_message,
        });
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
      || job.status === "queued"
      || job.status === "submitting"
      || job.status === "running"
      || job.status === "submitted_to_slurm"
      || job.status === "uploaded_to_nibi"
      || job.status === "upload_waiting_for_login"
      || job.status === "connection_failed"
    ) {
      const title = job.status === "uploaded_to_nibi"
        ? "Uploaded to NIBI"
        : job.status === "upload_waiting_for_login"
          ? "Waiting for login"
          : job.status === "queued_locally"
            ? "Queued locally"
            : job.status === "queued"
              ? "Queued"
              : job.status === "submitted_to_slurm"
                ? "Submitted to Slurm"
                : "Running";
      return (
        <div className="page narrow-page">
          <section className="empty-state loading-state">
            <span className="empty-icon" aria-hidden="true">...</span>
            <h2>{title}</h2>
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
              disabled={!job.remote_slurm_id || isJobRefreshInFlight(job.id)}
              onClick={() => void refreshRemoteJob(job)}
              type="button"
            >
              {isJobRefreshInFlight(job.id) ? "Refreshing..." : "Refresh status"}
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
      || job.status === "timed_out"
      || job.status === "timeout"
      || job.status === "output_invalid"
      || job.status === "download_failed"
      || job.status === "unknown"
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
        return (
          <JobsPage
            jobs={jobsState.jobs}
            manualMfaSession={manualMfaSession}
            manualMfaStatus={manualMfaJobStatus}
            nibiSettings={nibiSettings}
            refreshingJobIds={Object.entries(pollingDiagnostics?.inFlightRequestCountByJob ?? {})
              .filter(([, count]) => count > 0)
              .map(([jobId]) => jobId)}
            latestManualRefreshTraceByJob={pollingDiagnostics?.latestManualRefreshTraceByJob}
            latestGlobalBannerWriteTrace={pollingDiagnostics?.latestGlobalBannerWriteTrace}
            onOpenResult={openResult}
            onOpenRobotSetup={() => navigate("settings")}
            onReconnect={() => navigate("settings")}
            onRefreshJobStatus={refreshRemoteJob}
            onCancelRemoteJob={cancelRemoteSlurmJob}
            onSubmitSlurmJob={submitRemoteSlurmJob}
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
            onManualMfaSessionChange={(session) => updateLiveSessionState(session, "SettingsPage.onManualMfaSessionChange")}
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
            pollingDiagnostics={pollingDiagnostics}
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
    || job.status === "queued"
    || job.status === "running"
    || job.status === "output_missing"
  );
}

function needsRemoteJobAction(job: StoredPredictionJob) {
  return job.status === "uploaded_to_nibi"
    || job.status === "submitting"
    || job.status === "slurm_submission_failed"
    || job.status === "submitted_to_slurm"
    || job.status === "queued"
    || job.status === "running"
    || job.status === "login_required";
}

function hasManualMfaControlPath(
  settings: NibiSettings,
  session: ManualMfaSessionUiState,
) {
  return Boolean(session.control_path || settings.wsl_control_socket_path);
}
