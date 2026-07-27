import { invoke } from "@tauri-apps/api/core";
import type { NibiSettings } from "../../features/settings";
import { trimNibiSettings } from "../../features/settings";
import {
  getRemoteProvisioningRecord,
  saveRemoteProvisioningRecord,
  type RemoteProvisioningOperation,
  type RemoteProvisioningRecord,
} from "../db";

export const EXPECTED_FLUORCAST_REPOSITORY_REF = "v0.1.0";
export const EXPECTED_MODEL_ARTIFACT_VERSION = "production-models-2026-07-27";
export const EXPECTED_PROVISIONING_SCHEMA_VERSION = "1";

export type ProvisioningStage =
  | "not_checked"
  | "checking"
  | "cloning"
  | "environment_setup"
  | "model_download"
  | "checksum_verification"
  | "smoke_validation"
  | "training_queued"
  | "training_running"
  | "ready"
  | "failed"
  | "cancelled";

export type RemoteProvisioningStatus = {
  schema_version: string;
  stage: ProvisioningStage;
  ready: boolean;
  repository: {
    status: "missing" | "present" | "wrong_origin" | "dirty" | "version_mismatch" | "ok" | "unknown";
    installed_version?: string;
    expected_ref: string;
    origin?: string;
  };
  environment: {
    status: "missing" | "present" | "repair_required" | "ok" | "unknown";
  };
  data: {
    status: "missing" | "present" | "ok" | "unknown";
  };
  production_model: {
    status: "missing" | "present" | "checksum_mismatch" | "corrupt" | "ok" | "unknown";
    installed_artifact_version?: string;
    expected_artifact_version: string;
  };
  smoke_test: {
    status: "not_run" | "passed" | "failed" | "unknown";
  };
  setup_slurm_id?: string;
  training_slurm_id?: string;
  slurm_state?: string;
  slurm_exit_code?: string;
  last_checked_at: string;
  error?: string;
};

export type RemoteProvisioningCommandResult = {
  status_json: RemoteProvisioningStatus;
  raw: {
    exit_code: number;
    stdout: string;
    stderr: string;
    duration_ms: number;
    command_label: string;
    redacted_command_preview: string;
    timed_out?: boolean;
  };
};

export type ProvisioningPersistence = {
  saveRemoteProvisioningRecord: typeof saveRemoteProvisioningRecord;
  getRemoteProvisioningRecord: typeof getRemoteProvisioningRecord;
};

const defaultPersistence: ProvisioningPersistence = {
  saveRemoteProvisioningRecord,
  getRemoteProvisioningRecord,
};

const activeProvisioningPromises = new Map<string, Promise<RemoteProvisioningRecord>>();

function emptyStatus(stage: ProvisioningStage, error?: string): RemoteProvisioningStatus {
  return {
    schema_version: EXPECTED_PROVISIONING_SCHEMA_VERSION,
    stage,
    ready: false,
    repository: {
      status: "unknown",
      expected_ref: EXPECTED_FLUORCAST_REPOSITORY_REF,
    },
    environment: {
      status: "unknown",
    },
    data: {
      status: "unknown",
    },
    production_model: {
      status: "unknown",
      expected_artifact_version: EXPECTED_MODEL_ARTIFACT_VERSION,
    },
    smoke_test: {
      status: "unknown",
    },
    last_checked_at: new Date().toISOString(),
    ...(error ? { error } : {}),
  };
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function statusValue<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? value as T : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseProvisioningStatus(value: unknown): RemoteProvisioningStatus {
  if (!isRecord(value)) {
    throw new Error("Remote provisioning command did not return a JSON object.");
  }
  const repository = isRecord(value.repository) ? value.repository : {};
  const environment = isRecord(value.environment) ? value.environment : {};
  const data = isRecord(value.data) ? value.data : {};
  const productionModel = isRecord(value.production_model) ? value.production_model : {};
  const smokeTest = isRecord(value.smoke_test) ? value.smoke_test : {};
  return {
    schema_version: stringValue(value.schema_version) ?? EXPECTED_PROVISIONING_SCHEMA_VERSION,
    stage: statusValue(value.stage, [
      "not_checked",
      "checking",
      "cloning",
      "environment_setup",
      "model_download",
      "checksum_verification",
      "smoke_validation",
      "training_queued",
      "training_running",
      "ready",
      "failed",
      "cancelled",
    ] as const, "failed"),
    ready: value.ready === true,
    repository: {
      status: statusValue(repository.status, [
        "missing",
        "present",
        "wrong_origin",
        "dirty",
        "version_mismatch",
        "ok",
        "unknown",
      ] as const, "unknown"),
      installed_version: stringValue(repository.installed_version),
      expected_ref: stringValue(repository.expected_ref) ?? EXPECTED_FLUORCAST_REPOSITORY_REF,
      origin: stringValue(repository.origin),
    },
    environment: {
      status: statusValue(environment.status, [
        "missing",
        "present",
        "repair_required",
        "ok",
        "unknown",
      ] as const, "unknown"),
    },
    data: {
      status: statusValue(data.status, ["missing", "present", "ok", "unknown"] as const, "unknown"),
    },
    production_model: {
      status: statusValue(productionModel.status, [
        "missing",
        "present",
        "checksum_mismatch",
        "corrupt",
        "ok",
        "unknown",
      ] as const, "unknown"),
      installed_artifact_version: stringValue(productionModel.installed_artifact_version),
      expected_artifact_version: stringValue(productionModel.expected_artifact_version) ?? EXPECTED_MODEL_ARTIFACT_VERSION,
    },
    smoke_test: {
      status: statusValue(smokeTest.status, ["not_run", "passed", "failed", "unknown"] as const, "unknown"),
    },
    setup_slurm_id: stringValue(value.setup_slurm_id),
    training_slurm_id: stringValue(value.training_slurm_id),
    slurm_state: stringValue(value.slurm_state),
    slurm_exit_code: stringValue(value.slurm_exit_code),
    last_checked_at: stringValue(value.last_checked_at) ?? new Date().toISOString(),
    error: stringValue(value.error),
  };
}

function commandToOperation(command: string): RemoteProvisioningOperation {
  if (command === "provision_remote_fluorcast") return "install";
  if (command === "install_remote_model_bundle") return "install_models";
  if (command === "submit_remote_model_training") return "training";
  if (command === "cancel_remote_provisioning_training") return "cancel_training";
  if (command === "get_remote_provisioning_status") return "validation";
  return "check";
}

function recordFromStatus(
  operation: RemoteProvisioningOperation,
  status: RemoteProvisioningStatus,
): RemoteProvisioningRecord {
  return {
    id: "remote_fluorcast",
    operation,
    stage: status.stage,
    ready: status.ready,
    status_json: JSON.stringify(status),
    setup_slurm_id: status.setup_slurm_id,
    training_slurm_id: status.training_slurm_id,
    error_message: status.error,
    updated_at: status.last_checked_at,
  };
}

export function provisioningRecordStatus(record: RemoteProvisioningRecord | null): RemoteProvisioningStatus {
  if (!record) {
    return emptyStatus("not_checked");
  }
  try {
    return parseProvisioningStatus(JSON.parse(record.status_json));
  } catch {
    return emptyStatus("failed", "Saved provisioning status JSON is invalid.");
  }
}

export async function runRemoteProvisioningCommand(
  command: "check_remote_fluorcast_installation"
    | "provision_remote_fluorcast"
    | "install_remote_model_bundle"
    | "submit_remote_model_training"
    | "get_remote_provisioning_status"
    | "cancel_remote_provisioning_training",
  settings: NibiSettings,
  options: {
    trainingAccount?: string;
    confirmed?: boolean;
    slurmJobId?: string;
    signal?: AbortSignal;
  } = {},
  persistence: ProvisioningPersistence = defaultPersistence,
): Promise<RemoteProvisioningRecord> {
  const trimmed = trimNibiSettings(settings);
  const key = `${command}:${options.slurmJobId ?? ""}`;
  const active = activeProvisioningPromises.get(key);
  if (active) {
    return active;
  }

  const promise = (async () => {
    const operation = commandToOperation(command);
    const started = recordFromStatus(operation, emptyStatus(
      operation === "check" || operation === "validation" ? "checking" : "environment_setup",
    ));
    await persistence.saveRemoteProvisioningRecord(started);

    if (options.signal?.aborted) {
      const cancelled = recordFromStatus(operation, emptyStatus("cancelled", "Local operation was cancelled."));
      await persistence.saveRemoteProvisioningRecord(cancelled);
      return cancelled;
    }

    let result: RemoteProvisioningCommandResult;
    try {
      result = await invoke<RemoteProvisioningCommandResult>(command, {
        mode: trimmed.connection_mode,
        settings: trimmed,
        request: {
          expectedRepositoryRef: EXPECTED_FLUORCAST_REPOSITORY_REF,
          expectedArtifactVersion: EXPECTED_MODEL_ARTIFACT_VERSION,
          expectedSchemaVersion: EXPECTED_PROVISIONING_SCHEMA_VERSION,
          trainingAccount: options.trainingAccount,
          confirmed: options.confirmed === true,
          slurmJobId: options.slurmJobId,
        },
      });
    } catch (error) {
      const failed = recordFromStatus(
        operation,
        emptyStatus("failed", error instanceof Error ? error.message : "Remote provisioning command failed."),
      );
      await persistence.saveRemoteProvisioningRecord(failed);
      return failed;
    }

    const status = parseProvisioningStatus(result.status_json);
    const record = recordFromStatus(operation, status);
    await persistence.saveRemoteProvisioningRecord(record);
    return record;
  })();

  activeProvisioningPromises.set(key, promise);
  try {
    return await promise;
  } finally {
    activeProvisioningPromises.delete(key);
  }
}
