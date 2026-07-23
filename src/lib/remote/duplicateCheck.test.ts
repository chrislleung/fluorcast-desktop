import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultNibiSettings } from "../../features/settings";
import type { DuplicateCheckInput, DuplicateCheckOutput } from "../schemas";
import type { RemoteExecutor } from "./RemoteExecutor";
import { duplicateCheckMatchSummary, runDuplicateCheck } from "./duplicateCheck";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

const input: DuplicateCheckInput = {
  job_id: "duplicate-job-1",
  user_id: "local_user",
  molecule_smiles: "CCO",
  solvent_smiles: "O",
  requested_at: "2026-07-17T12:00:00.000Z",
};

const output: DuplicateCheckOutput = {
  exact_molecule_match: true,
  exact_solvent_pair_match: false,
  scaffold_match: true,
  nearest_training_similarity: 0.93,
  nearest_training_molecule_smiles: "CCO",
  warnings: [],
};

function executor(mode: "mock" | "interactive_mfa" | "robot_automation", ready = true): RemoteExecutor {
  return {
    getMode: () => mode,
    getConnectionStatus: () => ({
      mode,
      state: mode === "interactive_mfa"
        ? ready ? "authenticated" : "authentication_required"
        : mode === "robot_automation"
          ? ready ? "robot_automation_ready" : "failed"
          : "authenticated",
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
    runCommand: vi.fn(async (commandSpec) => {
      if (commandSpec.executable === "sbatch") {
        return {
          exit_code: 0,
          stdout: "Submitted batch job 98765",
          stderr: "",
          duration_ms: 1,
          command_label: commandSpec.label,
          redacted_command_preview: commandSpec.redacted_preview ?? commandSpec.executable,
        };
      }
      if (commandSpec.executable === "sacct") {
        return {
          exit_code: 0,
          stdout: "98765|COMPLETED|0:0",
          stderr: "",
          duration_ms: 1,
          command_label: commandSpec.label,
          redacted_command_preview: commandSpec.redacted_preview ?? commandSpec.executable,
        };
      }
      return {
        exit_code: 0,
        stdout: "",
        stderr: "",
        duration_ms: 1,
        command_label: commandSpec.label,
        redacted_command_preview: commandSpec.redacted_preview ?? commandSpec.executable,
      };
    }),
    uploadFile: vi.fn(async () => undefined),
    downloadFile: vi.fn(async () => undefined),
    dispose: vi.fn(),
  };
}

describe("duplicate-check remote flow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "write_prediction_input_temp_file") return "C:\\Temp\\duplicate-job-1-input.json";
      if (command === "prediction_output_temp_file_path") return "C:\\Temp\\duplicate-job-1-output.json";
      if (command === "read_prediction_output_file") return JSON.stringify(output);
      return "";
    });
  });

  it("returns mock duplicate-check output without remote calls", async () => {
    const selectedExecutor = executor("mock");
    const result = await runDuplicateCheck(input, defaultNibiSettings, selectedExecutor);

    expect(result.status).toBe("completed");
    expect(result.output?.exact_solvent_pair_match).toBe(true);
    expect(selectedExecutor.runCommand).not.toHaveBeenCalled();
  });

  it("uses the selected executor to upload, submit, poll, and download", async () => {
    const selectedExecutor = executor("robot_automation", true);
    const result = await runDuplicateCheck(
      input,
      {
        ...defaultNibiSettings,
        backend_mode: "nibi",
        connection_mode: "robot_automation",
        remote_project_path: "/home/alice/scratch/FluorCast",
        remote_jobs_path: "/home/alice/scratch/fluorcast-jobs",
        robot_access_verified: true,
      },
      selectedExecutor,
      { maxPollAttempts: 1 },
    );

    expect(selectedExecutor.runCommand).toHaveBeenCalledWith(expect.objectContaining({
      executable: "mkdir",
      args: ["-p", "/home/alice/scratch/fluorcast-jobs/duplicate-job-1"],
    }));
    expect(selectedExecutor.runCommand).toHaveBeenCalledWith(expect.objectContaining({
      executable: "sbatch",
      args: [
        "/home/alice/scratch/FluorCast/slurm/run_duplicate_check_job.sbatch",
        "/home/alice/scratch/fluorcast-jobs/duplicate-job-1",
      ],
    }));
    expect(selectedExecutor.uploadFile).toHaveBeenCalledWith(
      "C:\\Temp\\duplicate-job-1-input.json",
      "/home/alice/scratch/fluorcast-jobs/duplicate-job-1/input.json",
      expect.objectContaining({ connection_mode: "robot_automation" }),
    );
    expect(selectedExecutor.downloadFile).toHaveBeenCalledWith(
      "/home/alice/scratch/fluorcast-jobs/duplicate-job-1/output.json",
      "C:\\Temp\\duplicate-job-1-output.json",
      expect.objectContaining({ connection_mode: "robot_automation" }),
    );
    expect(result).toMatchObject({ status: "completed", slurmJobId: "98765", output });
  });

  it("blocks interactive_mfa when the session is not authenticated", async () => {
    const result = await runDuplicateCheck(
      input,
      { ...defaultNibiSettings, backend_mode: "nibi", connection_mode: "interactive_mfa" },
      executor("interactive_mfa", false),
    );

    expect(result).toMatchObject({
      status: "login_required",
      message: "Log into NIBI first, then retry this action.",
    });
  });

  it("blocks robot_automation when robot access is not ready", async () => {
    const result = await runDuplicateCheck(
      input,
      {
        ...defaultNibiSettings,
        backend_mode: "nibi",
        connection_mode: "robot_automation",
        robot_access_verified: false,
      },
      executor("robot_automation", false),
    );

    expect(result).toMatchObject({
      status: "robot_auth_failed",
      message: "Robot automation is not ready. Upload the restricted public key to Alliance/CCDB and ask support to enable robot-node access.",
    });
  });

  it("summarizes duplicate-check result display states", () => {
    expect(duplicateCheckMatchSummary({ ...output, exact_solvent_pair_match: true }))
      .toBe("Exact molecule-solvent pair found in training data.");
    expect(duplicateCheckMatchSummary({ ...output, exact_molecule_match: false, scaffold_match: false }))
      .toBe("No exact training-data match found.");
  });
});
