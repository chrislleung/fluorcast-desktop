import { useEffect, useReducer, useState } from "react";
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
  defaultManualMfaSessionState,
  type ManualMfaSessionUiState,
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

  const selectedJob = selectedJobDetail ?? undefined;

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
  }, [currentPage, databaseStatus]);

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

  async function refreshJobsFromDatabase() {
    const persistedJobs = await listJobs();
    dispatchJobs({ type: "set_jobs", jobs: persistedJobs });
  }

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

    if (job.status === "queued_locally" || job.status === "running") {
      return (
        <div className="page narrow-page">
          <section className="empty-state loading-state">
            <span className="empty-icon" aria-hidden="true">...</span>
            <h2>{job.status === "queued_locally" ? "Queued locally" : "Running"}</h2>
            <p>This mock prediction is still being prepared.</p>
          </section>
        </div>
      );
    }

    if (job.status === "failed") {
      return (
        <div className="page narrow-page">
          <section className="empty-state failed-state">
            <span className="empty-icon" aria-hidden="true">!</span>
            <h2>Prediction failed</h2>
            <p>{job.error_message ?? "No error message was recorded."}</p>
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
            onJobChange={persistJobChange}
            onOpenResult={openResult}
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
        return <JobsPage jobs={jobsState.jobs} onOpenResult={openResult} />;
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
