import { useState } from "react";
import {
  createMockPersistenceProbe,
  getDatabaseDiagnostics,
  getJobWithResult,
  listJobs,
  type DatabaseDiagnostics,
  type JobWithResult,
  type PersistenceProbeResult,
} from "../../lib/db";
import type { NibiSettings } from "../../features/settings";
import type { ManualMfaSessionUiState, SlurmPollingResult } from "../../lib/remote";

type DiagnosticsPageProps = {
  isDatabaseReady: boolean;
  manualMfaSession?: ManualMfaSessionUiState;
  nibiSettings?: NibiSettings;
  activeJobsCount?: number;
  jobsPageLoginRequiredCount?: number;
  latestPollingResult?: SlurmPollingResult | null;
  onOpenResult: (jobId: string) => void;
  onJobsRefresh: (jobs: JobWithResult[]) => void;
};

function boolLabel(value: boolean | null) {
  if (value === null) return "Unknown";
  return value ? "Yes" : "No";
}

export function DiagnosticsPage({
  isDatabaseReady,
  manualMfaSession,
  nibiSettings,
  activeJobsCount = 0,
  jobsPageLoginRequiredCount = 0,
  latestPollingResult,
  onOpenResult,
  onJobsRefresh,
}: DiagnosticsPageProps) {
  const [diagnostics, setDiagnostics] = useState<DatabaseDiagnostics | null>(null);
  const [probe, setProbe] = useState<PersistenceProbeResult | null>(null);
  const [latestCompletedJob, setLatestCompletedJob] = useState<JobWithResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isWorking, setIsWorking] = useState(false);

  async function refreshDiagnostics() {
    setIsWorking(true);
    setError(null);
    try {
      const nextDiagnostics = await getDatabaseDiagnostics();
      setDiagnostics(nextDiagnostics);
      onJobsRefresh(await listJobs());
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Diagnostics refresh failed.");
    } finally {
      setIsWorking(false);
    }
  }

  async function createProbe() {
    setIsWorking(true);
    setError(null);
    try {
      setProbe(await createMockPersistenceProbe());
      await refreshDiagnostics();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Persistence probe failed.");
    } finally {
      setIsWorking(false);
    }
  }

  async function loadLatestCompletedJob() {
    setIsWorking(true);
    setError(null);
    try {
      const jobs = await listJobs();
      onJobsRefresh(jobs);
      const latest = jobs.find((job) => job.status === "completed");
      if (!latest) {
        setLatestCompletedJob(null);
        setError("No completed persisted job was found.");
        return null;
      }

      const loaded = await getJobWithResult(latest.id);
      setLatestCompletedJob(loaded);
      if (!loaded) {
        setError("No saved job was found for this result.");
      } else if (!loaded.output) {
        setError("This job is marked completed, but no saved result was found.");
      }
      return loaded;
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Latest completed job failed to load.");
      return null;
    } finally {
      setIsWorking(false);
    }
  }

  async function openLatestCompletedResult() {
    const loaded = latestCompletedJob ?? await loadLatestCompletedJob();
    if (loaded) {
      onOpenResult(loaded.id);
    }
  }

  return (
    <div className="page narrow-page">
      <header className="page-header">
        <p className="eyebrow">Local persistence</p>
        <h1>Diagnostics</h1>
        <p>Inspect the SQLite database used by this desktop app.</p>
      </header>

      {!isDatabaseReady ? (
        <section className="empty-state loading-state">
          <span className="empty-icon" aria-hidden="true">...</span>
          <h2>Database is initializing</h2>
          <p>Diagnostics will be available once local persistence is ready.</p>
        </section>
      ) : (
        <>
          <section className="result-section">
            <div className="diagnostic-actions">
              <button className="secondary-button" disabled={isWorking} onClick={refreshDiagnostics} type="button">Refresh diagnostics</button>
              <button className="secondary-button" disabled={isWorking} onClick={createProbe} type="button">Create mock persistence probe</button>
              <button className="secondary-button" disabled={isWorking} onClick={loadLatestCompletedJob} type="button">Load latest completed job</button>
              <button className="primary-button" disabled={isWorking} onClick={openLatestCompletedResult} type="button">Open latest completed result</button>
            </div>
          </section>

          {error ? <div className="app-alert" role="status">{error}</div> : null}

          {nibiSettings && manualMfaSession ? (
            <section className="result-section">
              <div className="section-heading"><h2>Remote session</h2><span>{manualMfaSession.status.replaceAll("_", " ")}</span></div>
              <div className="diagnostic-grid">
                <div><span className="step-label">Connection mode</span><strong>{nibiSettings.connection_mode}</strong></div>
                <div><span className="step-label">Authenticated/manual session</span><strong>{manualMfaSession.status}</strong></div>
                <div><span className="step-label">Robot access status</span><strong>{nibiSettings.robot_access_verified ? "verified" : "not verified"}</strong></div>
                <div><span className="step-label">Active jobs count</span><strong>{activeJobsCount}</strong></div>
                <div><span className="step-label">Jobs page login-required jobs</span><strong>{jobsPageLoginRequiredCount}</strong></div>
                <div><span className="step-label">Jobs page recently blocked</span><strong>{manualMfaSession.jobs_page_login_required_at ? "Yes" : "No"}</strong></div>
                <div><span className="step-label">Jobs page blocked timestamp</span><code>{manualMfaSession.jobs_page_login_required_at || "None"}</code></div>
                <div><span className="step-label">Latest Slurm job ID</span><code>{latestPollingResult?.slurmJobId ?? "None"}</code></div>
                <div><span className="step-label">Latest polling result</span><strong>{latestPollingResult?.status ?? "None"}</strong></div>
                <div><span className="step-label">Selected Manual MFA SSH backend</span><strong>{nibiSettings.manual_mfa_ssh_backend}</strong></div>
                <div><span className="step-label">Effective backend</span><strong>WSL</strong></div>
                <div><span className="step-label">WSL available</span><strong>{boolLabel(manualMfaSession.wsl_available)}</strong></div>
                <div><span className="step-label">WSL ssh available</span><strong>{boolLabel(manualMfaSession.wsl_ssh_available)}</strong></div>
                <div><span className="step-label">Windows Terminal available</span><strong>{boolLabel(manualMfaSession.windows_terminal_available)}</strong></div>
                <div><span className="step-label">PowerShell available</span><strong>{boolLabel(manualMfaSession.powershell_available)}</strong></div>
                <div><span className="step-label">WSL distro</span><code>{nibiSettings.manual_mfa_wsl_distro || "Default WSL"}</code></div>
                <div><span className="step-label">WSL key path</span><code>{nibiSettings.wsl_ssh_private_key_path}</code></div>
                <div><span className="step-label">WSL control socket path</span><code>{nibiSettings.wsl_control_socket_path}</code></div>
                <div><span className="step-label">Manual session status</span><strong>{manualMfaSession.status}</strong></div>
                <div><span className="step-label">Parsed session status</span><strong>{manualMfaSession.parsed_session_status}</strong></div>
                <div><span className="step-label">Control path exists</span><strong>{boolLabel(manualMfaSession.control_path_exists)}</strong></div>
                <div><span className="step-label">Can run without password/Duo</span><strong>{boolLabel(manualMfaSession.can_run_background_commands)}</strong></div>
                <div><span className="step-label">Session started</span><code>{manualMfaSession.session_started_at || "None"}</code></div>
                <div><span className="step-label">Last successful command</span><code>{manualMfaSession.last_successful_command_at || "None"}</code></div>
                <div><span className="step-label">Last manual session probe</span><code>{manualMfaSession.last_session_probe_at || "None"}</code></div>
                <div><span className="step-label">Last session test exit code</span><strong>{manualMfaSession.last_session_test_exit_code ?? "None"}</strong></div>
                <div><span className="step-label">Last session test result</span><strong>{manualMfaSession.last_session_test_result}</strong></div>
                <div><span className="step-label">Last session test stdout</span><pre>{manualMfaSession.last_session_test_stdout || "(empty)"}</pre></div>
                <div><span className="step-label">Last session test stderr</span><pre>{manualMfaSession.last_session_test_stderr || "(empty)"}</pre></div>
                <div><span className="step-label">Last master check result</span><strong>{manualMfaSession.last_master_check_result || "None"}</strong></div>
                <div><span className="step-label">Last FLUORCAST_AUTH_OK result</span><strong>{manualMfaSession.last_auth_ok_result || "None"}</strong></div>
                <div><span className="step-label">Last terminal launch method</span><strong>{manualMfaSession.last_terminal_launch_method || "None"}</strong></div>
                <div><span className="step-label">Launch method attempted</span><strong>{manualMfaSession.last_launch_method_attempted || "None"}</strong></div>
                <div><span className="step-label">Last terminal launch success</span><strong>{boolLabel(manualMfaSession.last_terminal_launch_success)}</strong></div>
                <div><span className="step-label">Last terminal launch error</span><strong>{manualMfaSession.last_terminal_launch_error || "None"}</strong></div>
                <div><span className="step-label">Last launch error code</span><strong>{manualMfaSession.last_launch_error_code || "None"}</strong></div>
                <div><span className="step-label">Last terminal launch timestamp</span><code>{manualMfaSession.last_terminal_launch_at || "None"}</code></div>
                <div><span className="step-label">Last generated script path</span><code>{manualMfaSession.last_generated_script_path || "None"}</code></div>
                <div><span className="step-label">WSL script file exists</span><strong>{boolLabel(manualMfaSession.last_script_file_exists)}</strong></div>
                <div><span className="step-label">Manual WSL command</span><code>{manualMfaSession.manual_wsl_command || "None"}</code></div>
              </div>
            </section>
          ) : null}

          {probe ? (
            <section className="result-section">
              <div className="section-heading"><h2>Persistence probe</h2><span>{probe.pass ? "Pass" : "Fail"}</span></div>
              <div className="diagnostic-grid">
                <div><span className="step-label">Job ID</span><code>{probe.jobId}</code></div>
                <div><span className="step-label">Saved result</span><strong>{boolLabel(probe.savedResult)}</strong></div>
                <div><span className="step-label">Updated completed</span><strong>{boolLabel(probe.updatedCompleted)}</strong></div>
                <div><span className="step-label">Loaded result</span><strong>{boolLabel(probe.loadedResult)}</strong></div>
              </div>
              {probe.error ? <p>{probe.error}</p> : null}
            </section>
          ) : null}

          {latestCompletedJob ? (
            <section className="result-section">
              <div className="section-heading"><h2>Latest completed job</h2><span>{latestCompletedJob.output ? "Result loaded" : "Missing result"}</span></div>
              <p><code>{latestCompletedJob.id}</code></p>
            </section>
          ) : null}

          {diagnostics ? (
            <>
              <section className="result-section">
                <div className="section-heading"><h2>Database</h2><span>{diagnostics.initializedSuccessfully ? "Ready" : "Not ready"}</span></div>
                <div className="diagnostic-grid">
                  <div><span className="step-label">DB URL</span><code>{diagnostics.databaseUrl}</code></div>
                  <div><span className="step-label">Jobs count</span><strong>{diagnostics.jobsCount}</strong></div>
                  <div><span className="step-label">Results count</span><strong>{diagnostics.resultsCount}</strong></div>
                  <div><span className="step-label">Latest job</span><code>{diagnostics.latestJobId ?? "None"}</code></div>
                  <div><span className="step-label">Latest result</span><code>{diagnostics.latestResultJobId ?? "None"}</code></div>
                  <div><span className="step-label">Latest output JSON length</span><strong>{diagnostics.latestOutputJsonLength ?? "None"}</strong></div>
                  <div><span className="step-label">Latest JSON parses</span><strong>{boolLabel(diagnostics.latestOutputJsonParsesAsJson)}</strong></div>
                  <div><span className="step-label">Latest JSON validates</span><strong>{boolLabel(diagnostics.latestOutputJsonValidates)}</strong></div>
                </div>
              </section>

              <section className="result-section">
                <div className="section-heading"><h2>Tables</h2><span>SQLite</span></div>
                <div className="diagnostic-grid">
                  <div><span className="step-label">jobs</span><strong>{boolLabel(diagnostics.tables.jobs)}</strong></div>
                  <div><span className="step-label">results</span><strong>{boolLabel(diagnostics.tables.results)}</strong></div>
                  <div><span className="step-label">job_events</span><strong>{boolLabel(diagnostics.tables.job_events)}</strong></div>
                  <div><span className="step-label">settings</span><strong>{boolLabel(diagnostics.tables.settings)}</strong></div>
                </div>
              </section>

              <section className="result-section">
                <div className="section-heading"><h2>Recent jobs</h2><span>{diagnostics.recentJobs.length}</span></div>
                <div className="table-wrap">
                  <table>
                    <thead><tr><th>Job ID</th><th>Status</th><th>Created</th><th>Completed</th></tr></thead>
                    <tbody>
                      {diagnostics.recentJobs.map((job) => (
                        <tr key={job.id}>
                          <td><code>{job.id}</code></td>
                          <td>{job.status}</td>
                          <td>{job.local_created_at}</td>
                          <td>{job.local_completed_at ?? "None"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>

              <section className="result-section">
                <div className="section-heading"><h2>Recent results</h2><span>{diagnostics.recentResults.length}</span></div>
                <div className="table-wrap">
                  <table>
                    <thead><tr><th>Job ID</th><th>JSON length</th><th>Downloaded</th></tr></thead>
                    <tbody>
                      {diagnostics.recentResults.map((result) => (
                        <tr key={result.job_id}>
                          <td><code>{result.job_id}</code></td>
                          <td>{result.output_json_length}</td>
                          <td>{result.downloaded_at}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            </>
          ) : null}
        </>
      )}
    </div>
  );
}
