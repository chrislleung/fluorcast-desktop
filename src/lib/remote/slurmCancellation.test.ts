import { describe, expect, it, vi } from "vitest";
import type { StoredPredictionJob } from "../../features/jobs";
import { defaultNibiSettings } from "../../features/settings";
import type { RemoteExecutor } from "./RemoteExecutor";
import { cancelSlurmJob } from "./slurmCancellation";

const job: StoredPredictionJob = {
  id: "job-1",
  molecule_smiles: "CCO",
  solvent_smiles: "O",
  model_choice: "rf",
  status: "running",
  created_at: "2026-07-17T12:00:00.000Z",
  remote_slurm_id: "12345",
};

function executor(exitCode = 0): RemoteExecutor {
  return {
    getMode: () => "interactive_mfa",
    getConnectionStatus: () => ({
      mode: "interactive_mfa",
      state: "authenticated",
      label: "Ready",
      message: "Ready",
    }),
    validateLocalConfig: () => ({}),
    testConnection: async () => ({
      mode: "interactive_mfa",
      state: "authenticated",
      label: "Ready",
      message: "Ready",
    }),
    runCommand: vi.fn(async (commandSpec) => ({
      exit_code: exitCode,
      stdout: "",
      stderr: exitCode === 0 ? "" : "scancel failed",
      duration_ms: 1,
      command_label: commandSpec.label,
      redacted_command_preview: commandSpec.redacted_preview ?? commandSpec.executable,
    })),
    uploadFile: vi.fn(async () => undefined),
    downloadFile: vi.fn(async () => undefined),
    dispose: vi.fn(),
  };
}

describe("Slurm cancellation", () => {
  it("calls scancel once and persists cancelled status", async () => {
    const selectedExecutor = executor();
    const persistence = {
      updateJobStatus: vi.fn(async () => true),
      addJobEvent: vi.fn(async () => true),
    };

    const result = await cancelSlurmJob(
      job,
      { ...defaultNibiSettings, backend_mode: "nibi", connection_mode: "interactive_mfa" },
      selectedExecutor,
      persistence,
    );

    expect(result.status).toBe("cancelled");
    expect(selectedExecutor.runCommand).toHaveBeenCalledTimes(1);
    expect(selectedExecutor.runCommand).toHaveBeenCalledWith(expect.objectContaining({
      executable: "scancel",
      args: ["12345"],
    }));
    expect(persistence.updateJobStatus).toHaveBeenCalledWith("job-1", "cancelled", expect.objectContaining({
      errorMessage: "Slurm job 12345 cancelled.",
    }));
  });
});
