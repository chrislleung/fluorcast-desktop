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

  it("keeps historical hybrid_full jobs readable", () => {
    render(
      <JobsPage
        jobs={[{
          ...baseJob,
          model_choice: "hybrid_full",
        }]}
        onOpenResult={vi.fn()}
      />,
    );

    expect(screen.getByText("hybrid_full")).toBeInTheDocument();
  });

  it("shows structured INVALID_MODEL_CHOICE safely with traceback in details", () => {
    render(
      <JobsPage
        jobs={[{
          ...baseJob,
          status: "failed",
          error_message: [
            "INVALID_MODEL_CHOICE:\nmodel_choice must be one of: all, extratrees, gbdt, graph_model_later, histgb, hybrid, rf",
            "REMOTE_TRACEBACK=\nTraceback (most recent call last):\nValueError: invalid model choice",
          ].join("\n\n"),
        }]}
        onOpenResult={vi.fn()}
      />,
    );

    expect(screen.getAllByText(/INVALID_MODEL_CHOICE/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/model_choice must be one of/).length).toBeGreaterThan(0);
    expect(screen.getByText("Failure details")).toBeInTheDocument();
    expect(screen.getByText(/REMOTE_TRACEBACK=/)).toBeInTheDocument();
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
    expect(refresh).toHaveBeenCalledWith(expect.objectContaining({ status: "output_missing" }), expect.stringMatching(/^refresh-/));
  });

  it("allows connection-failed jobs with persisted Slurm metadata to refresh", () => {
    const refresh = vi.fn();
    render(
      <JobsPage
        jobs={[{
          ...baseJob,
          status: "connection_failed",
          remote_slurm_id: "18231560",
          remote_job_dir: "/home/alice/scratch/fluorcast-jobs/job-1",
        }]}
        onOpenResult={vi.fn()}
        onRefreshJobStatus={refresh}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Refresh status" }));
    expect(refresh).toHaveBeenCalledWith(expect.objectContaining({
      status: "connection_failed",
      remote_slurm_id: "18231560",
      remote_job_dir: "/home/alice/scratch/fluorcast-jobs/job-1",
    }), expect.stringMatching(/^refresh-/));
  });

  it("does not show refresh for connection-failed jobs missing the remote directory", () => {
    render(
      <JobsPage
        jobs={[{
          ...baseJob,
          status: "connection_failed",
          remote_slurm_id: "18231560",
          remote_job_dir: undefined,
        }]}
        onOpenResult={vi.fn()}
        onRefreshJobStatus={vi.fn()}
      />,
    );

    expect(screen.queryByRole("button", { name: "Refresh status" })).not.toBeInTheDocument();
  });

  it("shows retry output download for download failures without Slurm resubmission", () => {
    const refresh = vi.fn();
    const submit = vi.fn();
    render(
      <JobsPage
        jobs={[{
          ...baseJob,
          status: "download_failed",
          remote_slurm_id: "18217313",
          remote_output_path: "/home/chrisl/scratch/fluorcast-jobs/7d676c1e-2a98-4f38-8ba7-5858182b6ade/output.json",
          error_message: "The prediction completed, but FluorCast could not download output.json.",
        }]}
        onOpenResult={vi.fn()}
        onRefreshJobStatus={refresh}
        onSubmitSlurmJob={submit}
      />,
    );

    expect(screen.queryByRole("button", { name: "Retry Slurm submission" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry output download" }));
    expect(refresh).toHaveBeenCalledWith(expect.objectContaining({
      status: "download_failed",
      remote_slurm_id: "18217313",
    }), expect.stringMatching(/^refresh-/));
    expect(submit).not.toHaveBeenCalled();
  });

  it("shows retry result import for invalid output without Slurm resubmission", () => {
    const refresh = vi.fn();
    const submit = vi.fn();
    render(
      <JobsPage
        jobs={[{
          ...baseJob,
          status: "output_invalid",
          remote_slurm_id: "18226108",
          remote_output_path: "/home/chrisl/scratch/fluorcast-jobs/2e80/output.json",
          error_message: "JSON_SYNTAX_STATUS=valid\nREMOTE_SCHEMA_STATUS=invalid",
        }]}
        onOpenResult={vi.fn()}
        onRefreshJobStatus={refresh}
        onSubmitSlurmJob={submit}
      />,
    );

    expect(screen.queryByRole("button", { name: "Retry Slurm submission" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry result import" }));
    expect(refresh).toHaveBeenCalledWith(expect.objectContaining({
      status: "output_invalid",
      remote_slurm_id: "18226108",
    }), expect.stringMatching(/^refresh-/));
    expect(submit).not.toHaveBeenCalled();
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

  it("shows resume monitoring instead of retry when a failed submission already has a Slurm ID", () => {
    const submit = vi.fn();
    const refresh = vi.fn();
    render(
      <JobsPage
        jobs={[{
          ...baseJob,
          status: "slurm_submission_failed",
          remote_slurm_id: "18215500",
          error_message: "Submitted - remote marker warning",
        }]}
        onOpenResult={vi.fn()}
        onSubmitSlurmJob={submit}
        onRefreshJobStatus={refresh}
      />,
    );

    expect(screen.queryByRole("button", { name: "Retry Slurm submission" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Resume monitoring" }));
    expect(refresh).toHaveBeenCalledWith(expect.objectContaining({ remote_slurm_id: "18215500" }), expect.stringMatching(/^refresh-/));
    expect(submit).not.toHaveBeenCalled();
    expect(screen.getByText("Marker warning")).toBeInTheDocument();
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
    expect(refresh).toHaveBeenCalledWith(expect.objectContaining({ id: "job-1" }), expect.stringMatching(/^refresh-/));
  });

  it("generates one refresh trace ID for one click", () => {
    const refresh = vi.fn();
    render(
      <JobsPage
        jobs={[{ ...baseJob, status: "connection_failed" }]}
        onOpenResult={vi.fn()}
        onRefreshJobStatus={refresh}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Refresh status" }));

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh.mock.calls[0][1]).toMatch(/^refresh-/);
  });

  it("copies ordered manual refresh diagnostics", () => {
    const writeText = vi.fn();
    Object.assign(navigator, { clipboard: { writeText } });
    render(
      <JobsPage
        jobs={[baseJob]}
        latestManualRefreshTraceByJob={{
          [baseJob.id]: {
            traceId: "refresh-test",
            localJobId: baseJob.id,
            slurmId: "12345",
            remoteJobDir: baseJob.remote_job_dir,
            events: [
              {
                traceId: "refresh-test",
                seq: 1,
                timestamp: "2026-07-22T12:00:00.000Z",
                stage: "BUTTON_CLICKED",
                localJobId: baseJob.id,
              },
              {
                traceId: "refresh-test",
                seq: 2,
                timestamp: "2026-07-22T12:00:01.000Z",
                stage: "SQUEUE_STARTED",
                localJobId: baseJob.id,
              },
            ],
            rowStatusWrites: [],
          },
        }}
        latestGlobalBannerWriteTrace={{
          traceId: "banner-test",
          seq: 1,
          timestamp: "2026-07-22T12:00:02.000Z",
          oldBannerState: "unknown",
          newBannerState: "available",
          writerFunction: "SlurmPollingCoordinator.applyResult",
          writerFile: "src/lib/remote/slurmPollingCoordinator.ts",
          reason: "scheduler_success",
          sessionGeneration: 1,
          relatedRefreshTraceId: "refresh-test",
        }}
        onOpenResult={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Copy diagnostics" }));

    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("1. 2026-07-22T12:00:00.000Z BUTTON_CLICKED"));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("2. 2026-07-22T12:00:01.000Z SQUEUE_STARTED"));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("BANNER_WRITE_TRACE_ID=banner-test"));
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
