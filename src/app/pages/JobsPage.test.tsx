import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StoredPredictionJob } from "../../features/jobs";
import { defaultNibiSettings } from "../../features/settings";
import { defaultManualMfaSessionState } from "../../lib/remote";
import { JobsPage } from "./JobsPage";

const baseJob: StoredPredictionJob = {
  id: "job-1",
  molecule_smiles: "CCO",
  solvent_smiles: "O",
  model_choice: "rf",
  status: "running",
  created_at: "2026-07-17T12:00:00.000Z",
  remote_slurm_id: "12345",
  remote_job_dir: "/home/alice/scratch/fluorcast-jobs/job-1",
};

describe("JobsPage recovery actions", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });
  it("points login-required Manual MFA jobs back to Settings", () => {
    const reconnect = vi.fn();
    render(
      <JobsPage
        jobs={[{
          ...baseJob,
          status: "login_required",
          error_message: "Your NIBI login session expired. Reconnect to NIBI, then refresh this job.",
        }]}
        manualMfaSession={defaultManualMfaSessionState}
        nibiSettings={{
          ...defaultNibiSettings,
          backend_mode: "nibi",
          connection_mode: "interactive_mfa",
        }}
        onOpenResult={vi.fn()}
        onReconnect={reconnect}
      />,
    );

    expect(screen.getByText("NIBI login required")).toBeInTheDocument();
    expect(screen.getByText(/Open Settings to start or test the NIBI session/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Copy app login command" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Test app session" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Start manual NIBI login" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open Settings" }));
    expect(reconnect).toHaveBeenCalled();
  });

  it("shows robot setup action for robot-not-ready jobs", () => {
    const openRobotSetup = vi.fn();
    render(
      <JobsPage
        jobs={[{
          ...baseJob,
          status: "robot_auth_failed",
          error_message: "Robot automation is not ready.",
        }]}
        onOpenResult={vi.fn()}
        onOpenRobotSetup={openRobotSetup}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open robot setup instructions" }));
    expect(openRobotSetup).toHaveBeenCalled();
  });

  it("shows refresh action for missing output jobs", () => {
    const refresh = vi.fn();
    render(
      <JobsPage
        jobs={[{
          ...baseJob,
          status: "output_missing",
          error_message: "The job finished, but output.json is not available yet.",
        }]}
        onOpenResult={vi.fn()}
        onRefreshJobStatus={refresh}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Download result" }));
    expect(refresh).toHaveBeenCalledWith(expect.objectContaining({ status: "output_missing" }));
  });

  it("does not show remote folder as the result action for uploaded jobs", () => {
    render(
      <JobsPage
        jobs={[{
          ...baseJob,
          status: "uploaded_to_nibi",
          remote_slurm_id: undefined,
        }]}
        onOpenResult={vi.fn()}
      />,
    );

    expect(screen.getByText("Input uploaded. Submit to Slurm.")).toBeInTheDocument();
    expect(screen.getByText("/home/alice/scratch/fluorcast-jobs/job-1")).not.toBeVisible();
    expect(screen.getByText("Remote folder")).toBeInTheDocument();
  });

  it("exposes submit action for uploaded jobs", () => {
    const submit = vi.fn();
    render(
      <JobsPage
        jobs={[{
          ...baseJob,
          status: "uploaded_to_nibi",
          remote_slurm_id: undefined,
        }]}
        onOpenResult={vi.fn()}
        onSubmitSlurmJob={submit}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Submit to Slurm" }));
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({ id: "job-1" }));
  });

  it("exposes retry action and technical details for failed submissions", () => {
    const submit = vi.fn();
    render(
      <JobsPage
        jobs={[{
          ...baseJob,
          status: "slurm_submission_failed",
          remote_slurm_id: undefined,
          error_message: "stdout:\nqueued",
        }]}
        onOpenResult={vi.fn()}
        onSubmitSlurmJob={submit}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Retry Slurm submission" }));
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({ status: "slurm_submission_failed" }));
    expect(screen.getByText("Technical details")).toBeInTheDocument();
  });

  it("shows safe upload failure diagnostics for failed uploads", () => {
    render(
      <JobsPage
        jobs={[{
          ...baseJob,
          status: "upload_failed",
          remote_slurm_id: undefined,
          error_message: [
            "UPLOAD_FAILURE_CODE=43",
            "ORIGINAL_WINDOWS_PATH=C:\\Temp\\fluorcast input.json",
            "NORMALIZED_WINDOWS_PATH=C:/Temp/fluorcast input.json",
            "CONVERTED_WSL_PATH=/mnt/c/Temp/fluorcast input.json",
            "WSLPATH_EXIT_CODE=0",
            "SCP_EXIT_CODE=1",
            "STDOUT=",
            "STDERR=scp failed",
          ].join("\n"),
        }]}
        onOpenResult={vi.fn()}
      />,
    );

    expect(screen.getByText("Upload failed")).toBeInTheDocument();
    expect(screen.getAllByText(/UPLOAD_FAILURE_CODE=43/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/SCP_EXIT_CODE=1/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/STDERR=scp failed/).length).toBeGreaterThan(0);
  });

  it("allows uploaded login-required jobs to retry after session is authenticated", () => {
    const submit = vi.fn();
    render(
      <JobsPage
        jobs={[{
          ...baseJob,
          status: "login_required",
          remote_slurm_id: undefined,
          remote_input_path: "/home/alice/scratch/fluorcast-jobs/job-1/input.json",
          remote_output_path: "/home/alice/scratch/fluorcast-jobs/job-1/output.json",
        }]}
        manualMfaSession={{
          ...defaultManualMfaSessionState,
          status: "authenticated",
          can_run_background_commands: true,
        }}
        nibiSettings={{
          ...defaultNibiSettings,
          backend_mode: "nibi",
          connection_mode: "interactive_mfa",
        }}
        onOpenResult={vi.fn()}
        onSubmitSlurmJob={submit}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Submit to Slurm" }));
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({ id: "job-1" }));
  });

  it("allows submitted login-required jobs to refresh after session is authenticated", () => {
    const refresh = vi.fn();
    render(
      <JobsPage
        jobs={[{
          ...baseJob,
          status: "login_required",
        }]}
        manualMfaSession={{
          ...defaultManualMfaSessionState,
          status: "authenticated",
          can_run_background_commands: true,
        }}
        nibiSettings={{
          ...defaultNibiSettings,
          backend_mode: "nibi",
          connection_mode: "interactive_mfa",
        }}
        onOpenResult={vi.fn()}
        onRefreshJobStatus={refresh}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Refresh status" }));
    expect(refresh).toHaveBeenCalledWith(expect.objectContaining({ id: "job-1" }));
  });

  it("requires confirmation before cancelling a remote Slurm job", () => {
    const cancel = vi.fn();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(
      <JobsPage
        jobs={[{
          ...baseJob,
          status: "submitted_to_slurm",
        }]}
        onOpenResult={vi.fn()}
        onCancelRemoteJob={cancel}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Cancel remote job" }));

    expect(window.confirm).toHaveBeenCalledWith("Cancel Slurm job 12345?");
    expect(cancel).toHaveBeenCalledWith(expect.objectContaining({ remote_slurm_id: "12345" }));
  });
});
