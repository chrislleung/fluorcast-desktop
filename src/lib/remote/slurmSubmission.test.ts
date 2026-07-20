import { describe, expect, it, vi } from "vitest";
import type { StoredPredictionJob } from "../../features/jobs";
import { defaultNibiSettings } from "../../features/settings";
import type { RemoteExecutor } from "./RemoteExecutor";
import { parseSbatchJobId, submitPredictionSlurmJob } from "./slurmSubmission";

const job: StoredPredictionJob = {
  id: "job-1",
  molecule_smiles: "CCO",
  solvent_smiles: "O",
  model_choice: "rf",
  status: "uploaded_to_nibi",
  created_at: "2026-07-17T12:00:00.000Z",
  remote_job_dir: "/home/alice/scratch/fluorcast-jobs/job-1",
  remote_input_path: "/home/alice/scratch/fluorcast-jobs/job-1/input.json",
  remote_output_path: "/home/alice/scratch/fluorcast-jobs/job-1/output.json",
};

function executor(
  mode: "interactive_mfa" | "robot_automation" = "interactive_mfa",
  ready = true,
  stdout = "123456",
): RemoteExecutor {
  return {
    getMode: () => mode,
    getConnectionStatus: () => ({
      mode,
      state: mode === "interactive_mfa"
        ? ready ? "authenticated" : "authentication_required"
        : ready ? "robot_automation_ready" : "failed",
      label: ready ? "Ready" : "Not ready",
      message: ready ? "Ready" : "Not ready",
    }),
    validateLocalConfig: () => ({}),
    testConnection: async () => ({
      mode,
      state: "authenticated",
      label: "Ready",
      message: "Ready",
    }),
    runCommand: vi.fn(async (commandSpec) => ({
      exit_code: commandSpec.executable === "cat" ? 1 : 0,
      stdout: commandSpec.executable === "sbatch" ? stdout : "",
      stderr: commandSpec.executable === "cat" ? "missing" : "",
      duration_ms: 1,
      command_label: commandSpec.label,
      redacted_command_preview: commandSpec.redacted_preview ?? commandSpec.executable,
    })),
    uploadFile: vi.fn(async () => undefined),
    downloadFile: vi.fn(async () => undefined),
    dispose: vi.fn(),
  };
}

function persistence() {
  return {
    updateJobStatus: vi.fn(async () => true),
    addJobEvent: vi.fn(async () => true),
  };
}

describe("Slurm submission", () => {
  it("parses parsable and classic sbatch output", () => {
    expect(parseSbatchJobId("123456")).toBe("123456");
    expect(parseSbatchJobId("Submitted batch job 123456")).toBe("123456");
  });

  it("stores submitted Slurm job ID and status", async () => {
    const selectedExecutor = executor("interactive_mfa", true, "Submitted batch job 123456");
    const store = persistence();

    const result = await submitPredictionSlurmJob(
      job,
      {
        ...defaultNibiSettings,
        backend_mode: "nibi",
        connection_mode: "interactive_mfa",
        remote_project_path: "/home/alice/scratch/FluorCast",
        remote_jobs_path: "/home/alice/scratch/fluorcast-jobs",
      },
      selectedExecutor,
      store,
    );

    expect(selectedExecutor.runCommand).toHaveBeenCalledWith(expect.objectContaining({
      executable: "sbatch",
      args: [
        "--parsable",
        "--chdir",
        "/home/alice/scratch/FluorCast",
        "--output",
        "/home/alice/scratch/fluorcast-jobs/job-1/stdout.log",
        "--error",
        "/home/alice/scratch/fluorcast-jobs/job-1/stderr.log",
        "/home/alice/scratch/FluorCast/slurm/run_prediction_job.sbatch",
        "/home/alice/scratch/fluorcast-jobs/job-1/input.json",
        "/home/alice/scratch/fluorcast-jobs/job-1/output.json",
      ],
    }));
    expect(result).toMatchObject({
      status: "submitted_to_slurm",
      remoteSlurmId: "123456",
    });
    expect(store.updateJobStatus).toHaveBeenCalledWith("job-1", "submitted_to_slurm", expect.objectContaining({
      remoteSlurmId: "123456",
      errorMessage: undefined,
    }));
    expect(selectedExecutor.runCommand).toHaveBeenCalledWith(expect.objectContaining({
      executable: "fluorcast-record-slurm-submission",
      args: [
        "/home/alice/scratch/fluorcast-jobs/job-1",
        "job-1",
        "job-1",
        "123456",
      ],
    }));
  });

  it("returns the local Slurm job ID without calling sbatch", async () => {
    const selectedExecutor = executor("interactive_mfa", true, "123456");
    const result = await submitPredictionSlurmJob(
      {
        ...job,
        remote_slurm_id: "777",
        submitted_at: "2026-07-17T12:01:00.000Z",
      },
      {
        ...defaultNibiSettings,
        backend_mode: "nibi",
        connection_mode: "interactive_mfa",
        remote_project_path: "/home/alice/scratch/FluorCast",
        remote_jobs_path: "/home/alice/scratch/fluorcast-jobs",
      },
      selectedExecutor,
      persistence(),
    );

    expect(result.remoteSlurmId).toBe("777");
    expect(vi.mocked(selectedExecutor.runCommand).mock.calls.some(([command]) => command.executable === "sbatch")).toBe(false);
  });

  it("recovers a remote Slurm marker without calling sbatch", async () => {
    const selectedExecutor = executor("interactive_mfa", true, "123456");
    vi.mocked(selectedExecutor.runCommand).mockImplementation(async (commandSpec) => ({
      exit_code: commandSpec.executable === "cat" ? 0 : 0,
      stdout: commandSpec.executable === "cat" ? "888\n" : "",
      stderr: "",
      duration_ms: 1,
      command_label: commandSpec.label,
      redacted_command_preview: commandSpec.redacted_preview ?? commandSpec.executable,
    }));

    const result = await submitPredictionSlurmJob(
      job,
      {
        ...defaultNibiSettings,
        backend_mode: "nibi",
        connection_mode: "interactive_mfa",
        remote_project_path: "/home/alice/scratch/FluorCast",
        remote_jobs_path: "/home/alice/scratch/fluorcast-jobs",
      },
      selectedExecutor,
      persistence(),
    );

    expect(result.remoteSlurmId).toBe("888");
    expect(vi.mocked(selectedExecutor.runCommand).mock.calls.some(([command]) => command.executable === "sbatch")).toBe(false);
  });

  it("coalesces two simultaneous submissions for the same submission id", async () => {
    const selectedExecutor = executor("interactive_mfa", true, "123456");
    let sbatchCalls = 0;
    vi.mocked(selectedExecutor.runCommand).mockImplementation(async (commandSpec) => {
      if (commandSpec.executable === "sbatch") {
        sbatchCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return {
          exit_code: 0,
          stdout: "Submitted batch job 999",
          stderr: "",
          duration_ms: 1,
          command_label: commandSpec.label,
          redacted_command_preview: commandSpec.redacted_preview ?? commandSpec.executable,
        };
      }
      return {
        exit_code: commandSpec.executable === "cat" ? 1 : 0,
        stdout: "",
        stderr: "",
        duration_ms: 1,
        command_label: commandSpec.label,
        redacted_command_preview: commandSpec.redacted_preview ?? commandSpec.executable,
      };
    });
    const settings = {
      ...defaultNibiSettings,
      backend_mode: "nibi" as const,
      connection_mode: "interactive_mfa" as const,
      remote_project_path: "/home/alice/scratch/FluorCast",
      remote_jobs_path: "/home/alice/scratch/fluorcast-jobs",
    };

    const [first, second] = await Promise.all([
      submitPredictionSlurmJob({ ...job, submission_id: "same-submission" }, settings, selectedExecutor, persistence()),
      submitPredictionSlurmJob({ ...job, submission_id: "same-submission" }, settings, selectedExecutor, persistence()),
    ]);

    expect(first.remoteSlurmId).toBe("999");
    expect(second.remoteSlurmId).toBe("999");
    expect(sbatchCalls).toBe(1);
  });

  it("marks submission failed when sbatch returns no Slurm ID", async () => {
    const store = persistence();

    const result = await submitPredictionSlurmJob(
      job,
      {
        ...defaultNibiSettings,
        backend_mode: "nibi",
        connection_mode: "interactive_mfa",
        remote_project_path: "/home/alice/scratch/FluorCast",
        remote_jobs_path: "/home/alice/scratch/fluorcast-jobs",
      },
      executor("interactive_mfa", true, "queued"),
      store,
    );

    expect(result.status).toBe("slurm_submission_failed");
    expect(store.updateJobStatus).toHaveBeenCalledWith("job-1", "slurm_submission_failed", expect.objectContaining({
      errorMessage: expect.stringContaining("Slurm submission did not return a job ID."),
    }));
  });

  it("fails before submission when the repository preflight fails", async () => {
    const selectedExecutor = executor("interactive_mfa", true, "123456");
    vi.mocked(selectedExecutor.runCommand).mockImplementation(async (commandSpec) => ({
      exit_code: commandSpec.redacted_preview === "test -d <remote_project>" ? 1 : 0,
      stdout: "",
      stderr: "No such file or directory",
      duration_ms: 1,
      command_label: commandSpec.label,
      redacted_command_preview: commandSpec.redacted_preview ?? commandSpec.executable,
    }));

    const result = await submitPredictionSlurmJob(
      job,
      {
        ...defaultNibiSettings,
        backend_mode: "nibi",
        connection_mode: "interactive_mfa",
        remote_project_path: "/home/alice/scratch/Wrong",
        remote_jobs_path: "/home/alice/scratch/fluorcast-jobs",
      },
      selectedExecutor,
      persistence(),
    );

    expect(result.status).toBe("slurm_submission_failed");
    expect(result.message).toContain("Verify FluorCast repository directory failed");
    expect(vi.mocked(selectedExecutor.runCommand).mock.calls.some(([command]) => command.executable === "sbatch")).toBe(false);
  });

  it("keeps paths with spaces as structured arguments for safe quoting by the native layer", async () => {
    const selectedExecutor = executor("interactive_mfa", true, "123456");

    await submitPredictionSlurmJob(
      {
        ...job,
        remote_job_dir: "/home/alice/scratch/fluorcast jobs/job 1",
        remote_input_path: "/home/alice/scratch/fluorcast jobs/job 1/input.json",
        remote_output_path: "/home/alice/scratch/fluorcast jobs/job 1/output.json",
      },
      {
        ...defaultNibiSettings,
        backend_mode: "nibi",
        connection_mode: "interactive_mfa",
        remote_project_path: "/home/alice/scratch/FluorCast Project",
        remote_jobs_path: "/home/alice/scratch/fluorcast jobs",
      },
      selectedExecutor,
      persistence(),
    );

    expect(selectedExecutor.runCommand).toHaveBeenCalledWith(expect.objectContaining({
      executable: "sbatch",
      args: expect.arrayContaining([
        "/home/alice/scratch/FluorCast Project",
        "/home/alice/scratch/fluorcast jobs/job 1/stdout.log",
        "/home/alice/scratch/fluorcast jobs/job 1/stderr.log",
      ]),
    }));
  });

  it("blocks interactive MFA submission if the session is not authenticated", async () => {
    const store = persistence();

    const result = await submitPredictionSlurmJob(
      job,
      {
        ...defaultNibiSettings,
        backend_mode: "nibi",
        connection_mode: "interactive_mfa",
      },
      executor("interactive_mfa", false),
      store,
    );

    expect(result.status).toBe("login_required");
    expect(store.updateJobStatus).toHaveBeenCalledWith("job-1", "login_required", expect.any(Object));
  });

  it("blocks robot submission if robot access is not verified", async () => {
    const store = persistence();

    const result = await submitPredictionSlurmJob(
      job,
      {
        ...defaultNibiSettings,
        backend_mode: "nibi",
        connection_mode: "robot_automation",
        robot_access_verified: false,
      },
      executor("robot_automation", false),
      store,
    );

    expect(result.status).toBe("robot_access_required");
    expect(store.updateJobStatus).toHaveBeenCalledWith("job-1", "robot_access_required", expect.any(Object));
  });

  it("retry uses the existing remote input path and job id", async () => {
    const selectedExecutor = executor("robot_automation", true, "123456");

    await submitPredictionSlurmJob(
      { ...job, status: "slurm_submission_failed" },
      {
        ...defaultNibiSettings,
        backend_mode: "nibi",
        connection_mode: "robot_automation",
        robot_access_verified: true,
        remote_project_path: "/home/alice/scratch/FluorCast",
        remote_jobs_path: "/home/alice/scratch/fluorcast-jobs",
      },
      selectedExecutor,
      persistence(),
    );

    expect(selectedExecutor.runCommand).toHaveBeenCalledWith(expect.objectContaining({
      args: expect.arrayContaining(["/home/alice/scratch/fluorcast-jobs/job-1/input.json"]),
    }));
  });
});
