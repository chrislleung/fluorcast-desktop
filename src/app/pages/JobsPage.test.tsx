import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
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

function openJobMenu(jobId = "job-1") {
  fireEvent.click(screen.getByRole("button", { name: `More actions for job ${jobId}` }));
}

describe("JobsPage recovery actions", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders a running job as a readable full-width job item", () => {
    const { container } = render(
      <JobsPage
        jobs={[baseJob]}
        onOpenResult={vi.fn()}
        onCancelRemoteJob={vi.fn()}
      />,
    );

    expect(container.querySelectorAll(".job-card")).toHaveLength(1);
    expect(container.querySelector(".job-card-active")).toBeInTheDocument();
    expect(screen.getByText("Running")).toBeInTheDocument();
    expect(screen.getByText("View running job")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel remote job" })).toBeInTheDocument();
  });

  it("renders a queued job with active-job presentation", () => {
    const { container } = render(
      <JobsPage
        jobs={[{ ...baseJob, status: "queued" }]}
        onOpenResult={vi.fn()}
      />,
    );

    expect(container.querySelector(".job-card-active")).toBeInTheDocument();
    expect(screen.getByText("Queued")).toBeInTheDocument();
    expect(screen.getByText("View queued job")).toBeInTheDocument();
  });

  it("keeps completed jobs opening results from the job item", () => {
    const openResult = vi.fn();
    render(
      <JobsPage
        jobs={[{ ...baseJob, status: "completed" }]}
        onOpenResult={openResult}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open result" }));
    expect(openResult).toHaveBeenCalledWith("job-1");
  });

  it("keeps disabled and loading refresh states correct", () => {
    render(
      <JobsPage
        jobs={[{ ...baseJob, status: "output_missing" }]}
        onOpenResult={vi.fn()}
        onRefreshJobStatus={vi.fn()}
        refreshingJobIds={["job-1"]}
      />,
    );

    expect(screen.getByRole("button", { name: "Refreshing..." })).toBeDisabled();
  });

  it("shows long IDs and SMILES as complete DOM values without changing job order", () => {
    const longMolecule = "C1=CC=C(C=C1)N=NC2=CC=C(C=C2)N(CCO)CCO".repeat(4);
    const longSolvent = "O=C(N(C)C)N(C)C".repeat(4);
    const firstJobId = "job-2026-07-17-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const secondJobId = "job-2026-07-17-ffffffff-1111-2222-3333-444444444444";
    render(
      <JobsPage
        jobs={[
          {
            ...baseJob,
            id: firstJobId,
            molecule_smiles: longMolecule,
            solvent_smiles: longSolvent,
            remote_slurm_id: "182315601234567890",
          },
          { ...baseJob, id: secondJobId, status: "completed", remote_slurm_id: undefined },
        ]}
        onOpenResult={vi.fn()}
      />,
    );

    expect(screen.getByText("2")).toBeInTheDocument();
    const localJobId = screen.getByText(firstJobId);
    expect(localJobId).toBeInTheDocument();
    expect(localJobId).toHaveTextContent(firstJobId);
    expect(localJobId).toHaveClass("job-metadata-value-wrap");
    expect(localJobId).not.toHaveClass("job-metadata-value-scroll");
    expect(screen.getByText("182315601234567890")).toBeInTheDocument();
    expect(screen.getByText(longMolecule)).toBeInTheDocument();
    expect(screen.getByText(longSolvent)).toBeInTheDocument();
    expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      expect.stringContaining(firstJobId),
      expect.stringContaining(secondJobId),
    ]);
  });

  it("keeps remote folder and development diagnostics collapsible beneath the job summary", () => {
    render(
      <JobsPage
        jobs={[baseJob]}
        latestManualRefreshTraceByJob={{
          [baseJob.id]: {
            traceId: "refresh-test",
            localJobId: baseJob.id,
            slurmId: "12345",
            remoteJobDir: baseJob.remote_job_dir,
            events: [],
            rowStatusWrites: [],
          },
        }}
        onOpenResult={vi.fn()}
      />,
    );

    expect(screen.getByText("Remote folder").closest("details")).toHaveClass("job-detail-row");
    expect(screen.getByText("Development diagnostics").closest("details")).toHaveClass("job-detail-row");
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

  it("renders one overflow trigger per job card with job-specific accessible names", () => {
    render(
      <JobsPage
        jobs={[
          { ...baseJob, id: "job-1", status: "completed", remote_slurm_id: undefined },
          { ...baseJob, id: "job-2", status: "running" },
        ]}
        onOpenResult={vi.fn()}
      />,
    );

    expect(screen.getAllByRole("button", { name: /More actions for job/ })).toHaveLength(2);
    expect(screen.getByRole("button", { name: "More actions for job job-1" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("button", { name: "More actions for job job-2" })).toHaveAttribute("aria-controls", "job-overflow-menu-job-2");
  });

  it("opens only one overflow menu at a time and closes on outside click and Escape", () => {
    render(
      <JobsPage
        jobs={[
          { ...baseJob, id: "job-1", status: "completed", remote_slurm_id: undefined },
          { ...baseJob, id: "job-2", status: "completed", remote_slurm_id: undefined },
        ]}
        onOpenResult={vi.fn()}
      />,
    );

    openJobMenu("job-1");
    expect(screen.getByRole("menu", { name: "Actions for job job-1" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "More actions for job job-1" })).toHaveAttribute("aria-expanded", "true");

    openJobMenu("job-2");
    expect(screen.queryByRole("menu", { name: "Actions for job job-1" })).not.toBeInTheDocument();
    expect(screen.getByRole("menu", { name: "Actions for job job-2" })).toBeInTheDocument();

    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();

    openJobMenu("job-1");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("associates menu note actions with the correct job card", () => {
    render(
      <JobsPage
        jobs={[
          { ...baseJob, id: "job-1", status: "completed", remote_slurm_id: undefined },
          { ...baseJob, id: "job-2", status: "completed", remote_slurm_id: undefined, note: "saved for job 2" },
        ]}
        onOpenResult={vi.fn()}
        onSaveJobNote={vi.fn()}
      />,
    );

    openJobMenu("job-2");
    expect(screen.getByRole("menuitem", { name: "Edit note" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: "Edit note" }));

    const jobOneCard = screen.getByRole("article", { name: "Job job-1" });
    const jobTwoCard = screen.getByRole("article", { name: "Job job-2" });
    expect(within(jobOneCard).queryByLabelText("Job note")).not.toBeInTheDocument();
    expect(within(jobTwoCard).getByLabelText("Job note")).toHaveValue("saved for job 2");
  });

  it("does not invoke permanent deletion from disabled active-job menu items", () => {
    const deleteJob = vi.fn();
    render(
      <JobsPage
        jobs={[{ ...baseJob, status: "running" }]}
        onOpenResult={vi.fn()}
        onDeleteJobPermanently={deleteJob}
      />,
    );

    openJobMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete job permanently" }));

    expect(deleteJob).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByText(/Cancel the remote job and wait for it to reach a terminal state/i)).toBeInTheDocument();
  });

  it("shows Add note for a job without a note and opens only that job editor", () => {
    render(
      <JobsPage
        jobs={[
          { ...baseJob, id: "job-1", status: "completed", remote_slurm_id: undefined },
          { ...baseJob, id: "job-2", status: "completed", remote_slurm_id: undefined },
        ]}
        onOpenResult={vi.fn()}
        onSaveJobNote={vi.fn()}
      />,
    );

    expect(screen.queryByRole("button", { name: "Add note" })).not.toBeInTheDocument();
    openJobMenu("job-1");
    expect(screen.getByRole("menuitem", { name: "Add note" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: "Add note" }));

    expect(screen.getByLabelText("Job note")).toBeInTheDocument();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("saves, edits, cancels, and removes a note on the correct job card", async () => {
    function Harness() {
      const [jobs, setJobs] = useState<StoredPredictionJob[]>([
        { ...baseJob, id: "job-1", status: "completed", remote_slurm_id: undefined },
        { ...baseJob, id: "job-2", status: "completed", remote_slurm_id: undefined },
      ]);
      return (
        <JobsPage
          jobs={jobs}
          onOpenResult={vi.fn()}
          onSaveJobNote={async (jobId, note) => {
            setJobs((current) => current.map((job) => (
              job.id === jobId ? { ...job, note: note ?? undefined } : job
            )));
            return true;
          }}
        />
      );
    }

    render(<Harness />);
    openJobMenu("job-1");
    fireEvent.click(screen.getByRole("menuitem", { name: "Add note" }));
    fireEvent.change(screen.getByLabelText("Job note"), { target: { value: "first line\nsecond line" } });
    fireEvent.click(screen.getByRole("button", { name: "Save note" }));

    expect(await screen.findByText((_, element) => (
      element?.classList.contains("job-note-text") === true
      && element.textContent === "first line\nsecond line"
    ))).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit note" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add note" })).not.toBeInTheDocument();

    openJobMenu("job-1");
    fireEvent.click(screen.getByRole("menuitem", { name: "Edit note" }));
    fireEvent.change(screen.getByLabelText("Job note"), { target: { value: "changed" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByText((_, element) => (
      element?.classList.contains("job-note-text") === true
      && element.textContent === "first line\nsecond line"
    ))).toBeInTheDocument();

    openJobMenu("job-1");
    fireEvent.click(screen.getByRole("menuitem", { name: "Edit note" }));
    expect(screen.getByRole("button", { name: "Save note" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove note" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remove note" }));
    await waitFor(() => expect(screen.queryByText((_, element) => (
      element?.classList.contains("job-note-text") === true
      && element.textContent === "first line\nsecond line"
    ))).not.toBeInTheDocument());
  });

  it("renders note content strictly as plain text", () => {
    const { container } = render(
      <JobsPage
        jobs={[{
          ...baseJob,
          status: "completed",
          remote_slurm_id: undefined,
          note: "<script>alert('x')</script>\n<b>bold?</b>",
        }]}
        onOpenResult={vi.fn()}
      />,
    );

    expect(screen.getByText((_, element) => (
      element?.classList.contains("job-note-text") === true
      && element.textContent === "<script>alert('x')</script>\n<b>bold?</b>"
    ))).toBeInTheDocument();
    expect(container.querySelector("script")).toBeNull();
  });

  it("disables duplicate note saves and preserves the saved note on failure", async () => {
    const save = vi.fn(async () => {
      throw new Error("disk is unavailable");
    });
    render(
      <JobsPage
        jobs={[{
          ...baseJob,
          status: "completed",
          remote_slurm_id: undefined,
          note: "saved note",
        }]}
        onOpenResult={vi.fn()}
        onSaveJobNote={save}
      />,
    );

    openJobMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Edit note" }));
    fireEvent.change(screen.getByLabelText("Job note"), { target: { value: "next note" } });
    fireEvent.click(screen.getByRole("button", { name: "Save note" }));

    expect(screen.getByRole("button", { name: "Saving..." })).toBeDisabled();
    expect(await screen.findByText("disk is unavailable")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByText("saved note")).toBeInTheDocument();
  });

  it.each(["completed", "failed", "cancelled"] as const)(
    "exposes permanent local deletion for %s jobs",
    (status) => {
      render(
        <JobsPage
          jobs={[{ ...baseJob, status, remote_slurm_id: undefined }]}
          onOpenResult={vi.fn()}
          onDeleteJobPermanently={vi.fn()}
        />,
      );

      openJobMenu();
      expect(screen.getByRole("menuitem", { name: "Delete job permanently" })).toBeEnabled();
      expect(screen.queryByRole("button", { name: "Delete job permanently" })).not.toBeInTheDocument();
    },
  );

  it.each(["running", "queued", "submitted_to_slurm", "submitting"] as const)(
    "blocks permanent local deletion for %s jobs",
    (status) => {
      render(
        <JobsPage
          jobs={[{ ...baseJob, status }]}
          onOpenResult={vi.fn()}
          onDeleteJobPermanently={vi.fn()}
        />,
      );

      openJobMenu();
      expect(screen.getByRole("menuitem", { name: "Delete job permanently" })).toBeDisabled();
      expect(screen.getByText(/Cancel the remote job and wait for it to reach a terminal state/i)).toBeInTheDocument();
    },
  );

  it("requires confirmation before permanently deleting a local job and shows identity", async () => {
    const deleteJob = vi.fn(async () => true);
    render(
      <JobsPage
        jobs={[{ ...baseJob, status: "completed", remote_slurm_id: undefined }]}
        onOpenResult={vi.fn()}
        onDeleteJobPermanently={deleteJob}
      />,
    );

    openJobMenu();

    expect(deleteJob).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete job permanently" }));
    expect(screen.getByRole("dialog", { name: "Delete local job permanently?" })).toBeInTheDocument();
    expect(screen.getAllByText("job-1").length).toBeGreaterThan(1);
    expect(screen.getAllByText("rf").length).toBeGreaterThan(1);
    expect(screen.getAllByText("Completed").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "Permanently delete job" }));
    await waitFor(() => expect(deleteJob).toHaveBeenCalledTimes(1));
    expect(deleteJob).toHaveBeenCalledWith("job-1");
  });

  it("cancels the delete dialog without deleting", () => {
    const deleteJob = vi.fn();
    render(
      <JobsPage
        jobs={[{ ...baseJob, status: "completed", remote_slurm_id: undefined }]}
        onOpenResult={vi.fn()}
        onDeleteJobPermanently={deleteJob}
      />,
    );

    openJobMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete job permanently" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(deleteJob).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("successful deletion removes the correct card and decrements the count", async () => {
    function Harness() {
      const [jobs, setJobs] = useState<StoredPredictionJob[]>([
        { ...baseJob, id: "job-1", status: "completed", remote_slurm_id: undefined },
        { ...baseJob, id: "job-2", status: "failed", remote_slurm_id: undefined },
      ]);
      return (
        <JobsPage
          jobs={jobs}
          onOpenResult={vi.fn()}
          onDeleteJobPermanently={async (jobId) => {
            setJobs((current) => current.filter((job) => job.id !== jobId));
            return true;
          }}
        />
      );
    }

    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "More actions for job job-1" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete job permanently" }));
    fireEvent.click(screen.getByRole("button", { name: "Permanently delete job" }));

    await waitFor(() => expect(screen.queryByText("job-1")).not.toBeInTheDocument());
    expect(screen.getByText("1")).toBeInTheDocument();
    expect(screen.getByText("job-2")).toBeInTheDocument();
  });

  it("failed deletion leaves the card visible, preserves the note, and exposes diagnostics for retry", async () => {
    const deleteJob = vi.fn(async () => {
      const error = new Error("Local job could not be deleted. delete results row failed: FOREIGN KEY constraint failed");
      Object.assign(error, {
        technicalDetails: [
          "LOCAL_JOB_ID=job-1",
          "DB_OPERATION=delete results row",
          "SQL_STATEMENT=DELETE FROM results WHERE job_id = $1",
          "DB_ERROR=FOREIGN KEY constraint failed",
        ].join("\n"),
      });
      throw error;
    });
    const cancel = vi.fn();
    render(
      <JobsPage
        jobs={[{ ...baseJob, status: "completed", remote_slurm_id: undefined, note: "saved note" }]}
        onOpenResult={vi.fn()}
        onCancelRemoteJob={cancel}
        onDeleteJobPermanently={deleteJob}
      />,
    );

    openJobMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete job permanently" }));
    fireEvent.click(screen.getByRole("button", { name: "Permanently delete job" }));

    expect(await screen.findByText("Local job could not be deleted.")).toBeInTheDocument();
    expect(screen.getByText("saved note")).toBeInTheDocument();
    expect(screen.getByText("Development diagnostics")).toBeInTheDocument();
    expect(screen.getByText(/DB_OPERATION=delete results row/)).toBeInTheDocument();
    expect(screen.getByText("job-1")).toBeInTheDocument();
    expect(cancel).not.toHaveBeenCalled();

    openJobMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete job permanently" }));
    fireEvent.click(screen.getByRole("button", { name: "Permanently delete job" }));
    await waitFor(() => expect(deleteJob).toHaveBeenCalledTimes(2));
  });
});
