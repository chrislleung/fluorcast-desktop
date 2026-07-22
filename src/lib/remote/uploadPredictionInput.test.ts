import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultNibiSettings } from "../../features/settings";
import type { PredictionJobInput } from "../schemas";
import type { RemoteExecutor } from "./RemoteExecutor";
import {
  joinRemoteJobPath,
  uploadPredictionInput,
} from "./uploadPredictionInput";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => "C:\\Temp\\fluorcast-job-1-input.json"),
}));

const input: PredictionJobInput = {
  job_id: "job-1",
  user_id: "local_user",
  molecule_smiles: "CCO",
  solvent_smiles: "O",
  model_choice: "rf",
  requested_at: "2026-07-17T12:00:00.000Z",
};

function executor(mode: "interactive_mfa" | "robot_automation", ready = true): RemoteExecutor {
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
      exit_code: 0,
      stdout: "",
      stderr: "",
      duration_ms: 1,
      command_label: commandSpec.label,
      redacted_command_preview: commandSpec.redacted_preview ?? commandSpec.executable,
    })),
    uploadFile: vi.fn(async () => undefined),
    downloadFile: vi.fn(async () => undefined),
    dispose: vi.fn(),
  };
}

describe("uploadPredictionInput", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("joins remote job paths under the configured root", () => {
    expect(joinRemoteJobPath("/home/user/scratch/fluorcast-jobs/", "job-1"))
      .toBe("/home/user/scratch/fluorcast-jobs/job-1");
  });

  it("prevents path traversal through the job id", () => {
    expect(() => joinRemoteJobPath("/home/user/scratch/fluorcast-jobs", "../job-1"))
      .toThrow("unsafe path");
  });

  it("blocks interactive_mfa upload without an authenticated session", async () => {
    const persistence = {
      saveJob: vi.fn(),
      updateJobStatus: vi.fn(),
      addJobEvent: vi.fn(),
    };

    await expect(uploadPredictionInput(
      input,
      {
        ...defaultNibiSettings,
        backend_mode: "nibi",
        connection_mode: "interactive_mfa",
        manual_mfa_provider: "persistent_shell",
      },
      executor("interactive_mfa", false),
      persistence,
    )).rejects.toMatchObject({ message: "Log into NIBI first, then retry this action." });

    expect(persistence.updateJobStatus).toHaveBeenCalledWith("job-1", "upload_waiting_for_login", {
      errorMessage: "Log into NIBI first, then retry this action.",
    });
    expect(persistence.addJobEvent).toHaveBeenCalledWith(
      "job-1",
      "waiting_for_nibi_login",
      "waiting for NIBI login",
    );
  });

  it("blocks robot_automation upload without verified robot access", async () => {
    await expect(uploadPredictionInput(
      input,
      {
        ...defaultNibiSettings,
        backend_mode: "nibi",
        connection_mode: "robot_automation",
        robot_access_verified: false,
      },
      executor("robot_automation", false),
    )).rejects.toMatchObject({
      message: "Robot automation is not ready. Upload the restricted public key to Alliance/CCDB and ask support to enable robot-node access.",
    });
  });

  it("uses the selected executor and returns input/output paths", async () => {
    const selectedExecutor = executor("robot_automation", true);
    const result = await uploadPredictionInput(
      input,
      {
        ...defaultNibiSettings,
        backend_mode: "nibi",
        connection_mode: "robot_automation",
        remote_jobs_path: "/home/alice/scratch/fluorcast-jobs",
        robot_access_verified: true,
      },
      selectedExecutor,
    );

    expect(selectedExecutor.runCommand).toHaveBeenCalledWith(expect.objectContaining({
      executable: "mkdir",
      args: ["-p", "/home/alice/scratch/fluorcast-jobs/job-1"],
    }));
    expect(selectedExecutor.uploadFile).toHaveBeenCalledWith(
      "C:\\Temp\\fluorcast-job-1-input.json",
      "/home/alice/scratch/fluorcast-jobs/job-1/input.json",
      expect.objectContaining({ connection_mode: "robot_automation" }),
    );
    expect(result).toEqual({
      remote_job_dir: "/home/alice/scratch/fluorcast-jobs/job-1",
      remote_input_path: "/home/alice/scratch/fluorcast-jobs/job-1/input.json",
      remote_output_path: "/home/alice/scratch/fluorcast-jobs/job-1/output.json",
    });
  });

  it("records status and event updates for a successful upload", async () => {
    const persistence = {
      saveJob: vi.fn(),
      updateJobStatus: vi.fn(),
      addJobEvent: vi.fn(),
    };

    await uploadPredictionInput(
      input,
      {
        ...defaultNibiSettings,
        backend_mode: "nibi",
        connection_mode: "robot_automation",
        robot_access_verified: true,
      },
      executor("robot_automation", true),
      persistence,
    );

    expect(persistence.saveJob).toHaveBeenCalledWith(expect.objectContaining({
      id: "job-1",
      status: "submitting",
      submission_id: "job-1",
    }));
    expect(persistence.updateJobStatus).toHaveBeenCalledWith("job-1", "uploaded_to_nibi", {
      remoteJobDir: "/home/user/scratch/fluorcast-jobs/job-1",
      remoteInputPath: "/home/user/scratch/fluorcast-jobs/job-1/input.json",
      remoteOutputPath: "/home/user/scratch/fluorcast-jobs/job-1/output.json",
      submissionId: "job-1",
    });
    expect(persistence.addJobEvent.mock.calls.map((call) => call[1])).toEqual([
      "created_input_json",
      "created_remote_job_directory",
      "uploaded_input_json",
    ]);
  });

  it("maps remote directory creation failure to upload exit 42 details", async () => {
    const selectedExecutor = executor("interactive_mfa", true);
    vi.mocked(selectedExecutor.runCommand).mockResolvedValueOnce({
      exit_code: 13,
      stdout: "mkdir stdout",
      stderr: "mkdir stderr",
      duration_ms: 1,
      command_label: "Create remote prediction job directory",
      redacted_command_preview: "mkdir -p <remote_job_dir>",
    });
    const persistence = {
      saveJob: vi.fn(),
      updateJobStatus: vi.fn(),
      addJobEvent: vi.fn(),
    };

    await expect(uploadPredictionInput(
      input,
      {
        ...defaultNibiSettings,
        backend_mode: "nibi",
        connection_mode: "interactive_mfa",
        remote_jobs_path: "/home/alice/scratch/fluorcast-jobs",
      },
      selectedExecutor,
      persistence,
    )).rejects.toThrow("UPLOAD_FAILURE_CODE=42");

    expect(persistence.updateJobStatus).toHaveBeenCalledWith("job-1", "upload_failed", expect.objectContaining({
      errorMessage: expect.stringContaining("UPLOAD_FAILURE_CODE=42"),
    }));
    expect(persistence.updateJobStatus).toHaveBeenCalledWith("job-1", "upload_failed", expect.objectContaining({
      errorMessage: expect.stringContaining("EXIT_CODE=13"),
    }));
    expect(persistence.updateJobStatus).toHaveBeenCalledWith("job-1", "upload_failed", expect.objectContaining({
      errorMessage: expect.stringContaining("STDOUT=mkdir stdout"),
    }));
    expect(persistence.updateJobStatus).toHaveBeenCalledWith("job-1", "upload_failed", expect.objectContaining({
      errorMessage: expect.stringContaining("STDERR=mkdir stderr"),
    }));
  });
});
