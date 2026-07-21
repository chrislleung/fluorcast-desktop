import { fireEvent, render, screen } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import validOutput from "../../tests/fixtures/prediction-output.success.example.json";
import type { PredictionJobOutput } from "../lib/schemas";
import { App } from "./App";

const dbMock = vi.hoisted(() => ({
  addJobEvent: vi.fn(),
  createMockPersistenceProbe: vi.fn(),
  getDatabaseDiagnostics: vi.fn(),
  getJobWithResult: vi.fn(),
  getSetting: vi.fn(),
  initializeDatabase: vi.fn(),
  listJobs: vi.fn(),
  saveJob: vi.fn(),
  saveResult: vi.fn(),
  saveSetting: vi.fn(),
  updateJobStatus: vi.fn(),
}));

vi.mock("../lib/db", () => dbMock);

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

const completedJob = {
  id: "job-1",
  molecule_smiles: "C1=CC=CC=C1",
  solvent_smiles: "O",
  model_choice: "rf",
  status: "completed" as const,
  created_at: "2026-07-03T14:30:00.000Z",
  completed_at: "2026-07-03T14:31:00.000Z",
};

const completedOutput = {
  ...validOutput,
  job_id: "job-1",
} as PredictionJobOutput;

describe("App", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.addJobEvent.mockResolvedValue(true);
    dbMock.createMockPersistenceProbe.mockResolvedValue({ pass: true });
    dbMock.getDatabaseDiagnostics.mockResolvedValue(null);
    dbMock.getJobWithResult.mockResolvedValue(null);
    dbMock.getSetting.mockResolvedValue(null);
    dbMock.initializeDatabase.mockResolvedValue(true);
    dbMock.listJobs.mockResolvedValue([]);
    dbMock.saveJob.mockResolvedValue(true);
    dbMock.saveResult.mockResolvedValue(true);
    dbMock.saveSetting.mockResolvedValue(true);
    dbMock.updateJobStatus.mockResolvedValue(true);
    vi.mocked(invoke).mockReset();
  });

  it("introduces the FluorCast prediction workflow", async () => {
    render(<App />);
    expect(await screen.findByRole("heading", { name: /from structure to signal/i })).toBeInTheDocument();
    expect(screen.getByText(/never need to work from the command line/i)).toBeInTheDocument();
  });

  it("navigates between application pages", async () => {
    render(<App />);
    await screen.findByRole("heading", { name: /from structure to signal/i });

    fireEvent.click(screen.getByRole("button", { name: "New Prediction" }));
    expect(await screen.findByRole("heading", { name: "New Prediction" })).toBeInTheDocument();
    expect(screen.getByLabelText(/Molecule SMILES/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Jobs" }));
    expect(await screen.findByText("No prediction jobs yet")).toBeInTheDocument();
  });

  it("stores mock jobs, lists them, and opens the selected result", async () => {
    dbMock.listJobs.mockImplementation(async () => {
      const savedJob = dbMock.saveJob.mock.calls.at(-1)?.[0];
      if (!savedJob) return [];
      return [{
        ...savedJob,
        status: dbMock.saveResult.mock.calls.length > 0 ? "completed" : savedJob.status,
        completed_at: dbMock.saveResult.mock.calls.at(-1)?.[2],
      }];
    });
    dbMock.getJobWithResult.mockImplementation(async (jobId: string) => ({
      ...completedJob,
      id: jobId,
      output: { ...completedOutput, job_id: jobId },
    }));
    render(<App />);
    await screen.findByRole("heading", { name: /from structure to signal/i });

    fireEvent.click(screen.getByRole("button", { name: "New Prediction" }));
    fireEvent.change(await screen.findByLabelText(/Molecule SMILES/i), {
      target: { value: "C1=CC=CC=C1" },
    });
    fireEvent.change(screen.getByLabelText(/Solvent SMILES/i), {
      target: { value: "O" },
    });
    fireEvent.change(screen.getByLabelText(/Model choice/i), {
      target: { value: "rf" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Run mock prediction/i }));

    expect(await screen.findByText("Completed")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Jobs" }));
    expect(screen.getByLabelText("Prediction job history")).toBeInTheDocument();
    expect(screen.getByText("C1=CC=CC=C1")).toBeInTheDocument();
    expect(screen.getByText("O")).toBeInTheDocument();
    expect(screen.getByText("rf")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Open result/i }));

    expect(await screen.findByRole("heading", { name: "Prediction result" })).toBeInTheDocument();
    expect(screen.getByText("Emission wavelength")).toBeInTheDocument();
    expect(screen.getByText("Blue")).toBeInTheDocument();
    expect(screen.getByText("Bright")).toBeInTheDocument();
    expect(screen.getByText("High confidence")).toBeInTheDocument();
  });

  it("persists completed mock job results before marking the job completed", async () => {
    render(<App />);
    await screen.findByRole("heading", { name: /from structure to signal/i });

    fireEvent.click(screen.getByRole("button", { name: "New Prediction" }));
    fireEvent.change(await screen.findByLabelText(/Molecule SMILES/i), {
      target: { value: "C1=CC=CC=C1" },
    });
    fireEvent.change(screen.getByLabelText(/Solvent SMILES/i), {
      target: { value: "O" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Run mock prediction/i }));

    expect(await screen.findByText("Completed")).toBeInTheDocument();
    expect(dbMock.saveResult).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ status: "succeeded" }),
      expect.any(String),
    );

    const completedStatusCall = dbMock.updateJobStatus.mock.calls.findIndex(
      ([, status]) => status === "completed",
    );
    expect(completedStatusCall).toBeGreaterThanOrEqual(0);
    expect(dbMock.saveResult.mock.invocationCallOrder[0]).toBeLessThan(
      dbMock.updateJobStatus.mock.invocationCallOrder[completedStatusCall],
    );
  });

  it("renders a refreshed result page from the database-loaded result", async () => {
    window.location.hash = "#/result/job-1";
    dbMock.getJobWithResult.mockResolvedValue({
      ...completedJob,
      output: completedOutput,
    });

    render(<App />);

    expect(await screen.findByRole("heading", { name: "Prediction result" })).toBeInTheDocument();
    expect(dbMock.getJobWithResult).toHaveBeenCalledWith("job-1");
    expect(screen.getByText("Emission wavelength")).toBeInTheDocument();
  });

  it("keeps result routes loading while the database is not ready", async () => {
    window.location.hash = "#/result/job-1";
    dbMock.initializeDatabase.mockImplementation(() => new Promise(() => {}));

    render(<App />);

    expect(await screen.findByRole("heading", { name: "Opening local database" })).toBeInTheDocument();
    expect(dbMock.getJobWithResult).not.toHaveBeenCalled();
  });

  it("shows a readable error when saved result JSON is invalid", async () => {
    window.location.hash = "#/result/job-1";
    dbMock.getJobWithResult.mockRejectedValue(new SyntaxError("Unexpected token"));

    render(<App />);

    expect(await screen.findByText("Saved result exists, but the output JSON is invalid.")).toBeInTheDocument();
  });

  it("opens a persisted completed job from Jobs after app reload", async () => {
    dbMock.listJobs.mockResolvedValue([completedJob]);
    dbMock.getJobWithResult.mockResolvedValue({
      ...completedJob,
      output: completedOutput,
    });

    render(<App />);
    await screen.findByRole("heading", { name: /from structure to signal/i });
    fireEvent.click(screen.getByRole("button", { name: "Jobs" }));

    expect(await screen.findByLabelText("Prediction job history")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Open result/i }));

    expect(await screen.findByRole("heading", { name: "Prediction result" })).toBeInTheDocument();
    expect(dbMock.getJobWithResult).toHaveBeenCalledWith("job-1");
  });

  it("shows a readable error for completed jobs with no saved result row", async () => {
    window.location.hash = "#/result/job-1";
    dbMock.getJobWithResult.mockResolvedValue(completedJob);

    render(<App />);

    expect(await screen.findByText("This job is marked completed, but no saved result was found.")).toBeInTheDocument();
  });

  it("updates the app accent color from settings", async () => {
    const { container } = render(<App />);
    await screen.findByRole("heading", { name: /from structure to signal/i });

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(await screen.findByText("Appearance"));
    fireEvent.click(await screen.findByRole("button", { name: "Rose accent" }));

    expect(container.querySelector(".app-shell")).toHaveStyle({ "--accent": "#ff9bb3" });
  });

  it("loads and updates the app secondary color from settings", async () => {
    dbMock.getSetting.mockImplementation(async (key: string) => (
      key === "secondaryColor" ? "#f3c969" : null
    ));

    const { container } = render(<App />);
    await screen.findByRole("heading", { name: /from structure to signal/i });

    expect(container.querySelector(".app-shell")).toHaveStyle({ "--secondary": "#f3c969" });

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(await screen.findByText("Appearance"));
    fireEvent.click(await screen.findByRole("button", { name: "Coral secondary" }));

    expect(container.querySelector(".app-shell")).toHaveStyle({ "--secondary": "#ffad91" });
    expect(dbMock.saveSetting).toHaveBeenCalledWith("secondaryColor", "#ffad91");
  });

  it("probes Manual MFA session on Jobs when stale state would block remote jobs", async () => {
    dbMock.getSetting.mockImplementation(async (key: string) => (
      key === "nibiSettings"
        ? JSON.stringify({
          connection_mode: "interactive_mfa",
          backend_mode: "nibi",
          manual_mfa_provider: "persistent_shell",
          nibi_username: "alice",
          normal_login_host: "nibi.alliancecan.ca",
          ssh_private_key_path: "C:\\Users\\Alice\\.ssh\\fluorcast_nibi_ed25519",
          wsl_ssh_private_key_path: "$HOME/.ssh/fluorcast_nibi_ed25519",
          wsl_control_socket_path: "$HOME/.fluorcast/ssh/cm-alice-nibi.sock",
          remote_project_path: "/home/alice/scratch/FluorCast",
          remote_jobs_path: "/home/alice/scratch/fluorcast-jobs",
          python_environment_path: "/home/alice/scratch/FluorCast/.venv/bin/python",
        })
        : null
    ));
    dbMock.listJobs.mockResolvedValue([{
      id: "job-remote",
      molecule_smiles: "CCO",
      solvent_smiles: "O",
      model_choice: "rf",
      status: "submitted_to_slurm",
      created_at: "2026-07-17T12:00:00.000Z",
      remote_slurm_id: "12345",
      remote_job_dir: "/home/alice/scratch/fluorcast-jobs/job-remote",
    }]);
    vi.mocked(invoke).mockResolvedValue({
      status: "authenticated",
      message: "Manual NIBI login is authenticated and background commands can reuse the session.",
      control_path: "$HOME/.fluorcast/ssh/cm-alice-nibi.sock",
      control_path_exists: true,
      redacted_command_preview: "ssh -S <wsl_control_socket_path> alice@nibi.alliancecan.ca echo",
      can_run_background_commands: true,
      last_master_check_result: "Master running",
      last_auth_ok_result: "FLUORCAST_AUTH_OK",
      selected_backend: "wsl",
      wsl_available: true,
      wsl_ssh_available: true,
    });

    render(<App />);
    await screen.findByRole("heading", { name: /from structure to signal/i });
    fireEvent.click(screen.getByRole("button", { name: "Jobs" }));

    expect(await screen.findByLabelText("Prediction job history")).toBeInTheDocument();
    await vi.waitFor(() => {
      expect(vi.mocked(invoke)).toHaveBeenCalledWith("test_manual_mfa_session", expect.any(Object));
    });
    expect(screen.queryByText("NIBI login required")).not.toBeInTheDocument();
  });

  it("shows reconnect panel when Jobs Manual MFA probe fails", async () => {
    dbMock.getSetting.mockImplementation(async (key: string) => (
      key === "nibiSettings"
        ? JSON.stringify({
          connection_mode: "interactive_mfa",
          backend_mode: "nibi",
          manual_mfa_provider: "persistent_shell",
          nibi_username: "alice",
          normal_login_host: "nibi.alliancecan.ca",
          ssh_private_key_path: "C:\\Users\\Alice\\.ssh\\fluorcast_nibi_ed25519",
          wsl_ssh_private_key_path: "$HOME/.ssh/fluorcast_nibi_ed25519",
          wsl_control_socket_path: "$HOME/.fluorcast/ssh/cm-alice-nibi.sock",
          remote_project_path: "/home/alice/scratch/FluorCast",
          remote_jobs_path: "/home/alice/scratch/fluorcast-jobs",
          python_environment_path: "/home/alice/scratch/FluorCast/.venv/bin/python",
        })
        : null
    ));
    dbMock.listJobs.mockResolvedValue([{
      id: "job-remote",
      molecule_smiles: "CCO",
      solvent_smiles: "O",
      model_choice: "rf",
      status: "login_required",
      created_at: "2026-07-17T12:00:00.000Z",
      remote_slurm_id: "12345",
      remote_job_dir: "/home/alice/scratch/fluorcast-jobs/job-remote",
    }]);
    vi.mocked(invoke).mockResolvedValue({
      status: "disconnected",
      message: "The SSH control session was not found or expired. Start manual login again.",
      control_path: "$HOME/.fluorcast/ssh/cm-alice-nibi.sock",
      control_path_exists: false,
      redacted_command_preview: "ssh -S <wsl_control_socket_path> alice@nibi.alliancecan.ca echo",
      can_run_background_commands: false,
      last_master_check_result: "No such file or directory",
      last_auth_ok_result: "",
      selected_backend: "wsl",
      wsl_available: true,
      wsl_ssh_available: true,
    });

    render(<App />);
    await screen.findByRole("heading", { name: /from structure to signal/i });
    fireEvent.click(screen.getByRole("button", { name: "Jobs" }));

    expect(await screen.findByText("NIBI login required")).toBeInTheDocument();
    expect(screen.getByText(/Open Settings to start or test the NIBI session/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Test app session" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Start manual NIBI login" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open Settings" }));
    expect(await screen.findByRole("heading", { name: "Settings" })).toBeInTheDocument();
  });
});
