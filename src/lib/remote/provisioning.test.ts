import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultNibiSettings } from "../../features/settings";
import {
  parseProvisioningStatus,
  provisioningRecordStatus,
  runRemoteProvisioningCommand,
} from "./provisioning";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

const readyStatus = {
  schema_version: "1",
  stage: "ready",
  ready: true,
  repository: {
    status: "ok",
    installed_version: "v0.1.0",
    expected_ref: "v0.1.0",
  },
  environment: {
    status: "ok",
  },
  data: {
    status: "ok",
  },
  production_model: {
    status: "ok",
    installed_artifact_version: "production-models-2026-07-27",
    expected_artifact_version: "production-models-2026-07-27",
  },
  smoke_test: {
    status: "passed",
  },
  setup_slurm_id: "111",
  training_slurm_id: "222",
  last_checked_at: "2026-07-27T10:00:00.000Z",
};

describe("remote provisioning state", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("normalizes a complete ready installation", () => {
    expect(parseProvisioningStatus(readyStatus)).toMatchObject({
      ready: true,
      stage: "ready",
      repository: {
        status: "ok",
        installed_version: "v0.1.0",
      },
      production_model: {
        status: "ok",
        installed_artifact_version: "production-models-2026-07-27",
      },
      smoke_test: {
        status: "passed",
      },
    });
  });

  it.each([
    ["fresh account", { repository: { status: "missing" } }],
    ["repo exists, environment missing", { repository: { status: "present" }, environment: { status: "missing" } }],
    ["environment exists, models missing", { environment: { status: "present" }, production_model: { status: "missing" } }],
    ["wrong repository origin", { repository: { status: "wrong_origin" } }],
    ["dirty repository", { repository: { status: "dirty" } }],
    ["version mismatch", { repository: { status: "version_mismatch" } }],
    ["checksum mismatch", { production_model: { status: "checksum_mismatch" } }],
    ["corrupt model bundle", { production_model: { status: "corrupt" } }],
    ["final validation failure", { stage: "failed", smoke_test: { status: "failed" }, error: "Smoke validation failed." }],
  ])("keeps actionable %s status", (_name, patch) => {
    const status = parseProvisioningStatus({
      ...readyStatus,
      stage: "failed",
      ready: false,
      ...patch,
    });

    expect(status.ready).toBe(false);
    expect(status.stage).toBe("failed");
  });

  it("falls back when saved status JSON is corrupt", () => {
    expect(provisioningRecordStatus({
      id: "remote_fluorcast",
      operation: "check",
      stage: "checking",
      ready: false,
      status_json: "{",
      updated_at: "2026-07-27T10:00:00.000Z",
    })).toMatchObject({
      stage: "failed",
      error: "Saved provisioning status JSON is invalid.",
    });
  });

  it("deduplicates duplicate clicks while preserving Slurm job IDs", async () => {
    let resolveInvoke!: (value: unknown) => void;
    vi.mocked(invoke).mockImplementation(() => new Promise((resolve) => {
      resolveInvoke = resolve;
    }));
    const saved: unknown[] = [];
    const persistence = {
      saveRemoteProvisioningRecord: vi.fn(async (record) => {
        saved.push(record);
        return true;
      }),
      getRemoteProvisioningRecord: vi.fn(),
    };
    const settings = {
      ...defaultNibiSettings,
      connection_mode: "interactive_mfa" as const,
      backend_mode: "nibi" as const,
      nibi_username: "alice",
      slurm_account: "def-alice",
    };

    const first = runRemoteProvisioningCommand("submit_remote_model_training", settings, {
      trainingAccount: "def-alice",
      confirmed: true,
    }, persistence);
    const second = runRemoteProvisioningCommand("submit_remote_model_training", settings, {
      trainingAccount: "def-alice",
      confirmed: true,
    }, persistence);

    await Promise.resolve();

    resolveInvoke({
      status_json: readyStatus,
      raw: {
        exit_code: 0,
        stdout: JSON.stringify(readyStatus),
        stderr: "",
        duration_ms: 1,
        command_label: "Submit remote model training",
        redacted_command_preview: "desktop_provisioning.py",
      },
    });

    expect(await first).toEqual(await second);
    expect(vi.mocked(invoke)).toHaveBeenCalledTimes(1);
    expect(saved.at(-1)).toMatchObject({
      training_slurm_id: "222",
      setup_slurm_id: "111",
      ready: true,
    });
  });
});
