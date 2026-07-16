import type { NibiSettings, NibiSettingsErrors } from "../../features/settings";
import {
  trimNibiSettings,
  validateNibiSettings,
} from "../../features/settings";
import type {
  RemoteCommandResult,
  RemoteCommandSpec,
  RemoteConnectionMode,
  RemoteConnectionStatus,
} from "./types";
import { RemoteExecutionError } from "./types";

export interface RemoteExecutor {
  getMode(): RemoteConnectionMode;
  getConnectionStatus(settings: NibiSettings): RemoteConnectionStatus;
  validateLocalConfig(settings: NibiSettings): NibiSettingsErrors;
  testConnection(settings: NibiSettings): Promise<RemoteConnectionStatus>;
  runCommand(commandSpec: RemoteCommandSpec): Promise<RemoteCommandResult>;
  uploadFile(localPath: string, remotePath: string): Promise<void>;
  downloadFile(remotePath: string, localPath: string): Promise<void>;
  dispose(): Promise<void> | void;
}

function commandPreview(commandSpec: RemoteCommandSpec): string {
  if (commandSpec.redacted_preview) {
    return commandSpec.redacted_preview;
  }

  const args = commandSpec.args ?? [];
  return [commandSpec.executable, ...args.map((arg) => (arg.includes(" ") ? "\"...\"" : arg))]
    .join(" ")
    .trim();
}

function notImplementedResult(commandSpec: RemoteCommandSpec, mode: RemoteConnectionMode): RemoteCommandResult {
  return {
    exit_code: 1,
    stdout: "",
    stderr: `${mode} remote operations are not implemented yet.`,
    duration_ms: 0,
    command_label: commandSpec.label,
    redacted_command_preview: commandPreview(commandSpec),
  };
}

abstract class BaseRemoteExecutor implements RemoteExecutor {
  abstract getMode(): RemoteConnectionMode;
  abstract getConnectionStatus(settings: NibiSettings): RemoteConnectionStatus;
  abstract testConnection(settings: NibiSettings): Promise<RemoteConnectionStatus>;

  validateLocalConfig(settings: NibiSettings): NibiSettingsErrors {
    return validateNibiSettings({
      ...settings,
      connection_mode: this.getMode(),
    });
  }

  async runCommand(commandSpec: RemoteCommandSpec): Promise<RemoteCommandResult> {
    return notImplementedResult(commandSpec, this.getMode());
  }

  async uploadFile(): Promise<void> {
    throw new RemoteExecutionError(
      `${this.getMode()} upload is not implemented yet.`,
      "not_implemented",
    );
  }

  async downloadFile(): Promise<void> {
    throw new RemoteExecutionError(
      `${this.getMode()} download is not implemented yet.`,
      "not_implemented",
    );
  }

  dispose(): void {
    // Stubs do not own external resources yet.
  }
}

export class MockRemoteExecutor extends BaseRemoteExecutor {
  getMode(): RemoteConnectionMode {
    return "mock";
  }

  getConnectionStatus(): RemoteConnectionStatus {
    return {
      mode: "mock",
      state: "authenticated",
      label: "Mock mode",
      message: "Local mock execution is ready.",
    };
  }

  async testConnection(): Promise<RemoteConnectionStatus> {
    return this.getConnectionStatus();
  }

  validateLocalConfig(settings: NibiSettings): NibiSettingsErrors {
    return validateNibiSettings({
      ...settings,
      connection_mode: "mock",
    });
  }

  async runCommand(commandSpec: RemoteCommandSpec): Promise<RemoteCommandResult> {
    const started = performance.now();
    return {
      exit_code: 0,
      stdout: `mock command: ${commandSpec.label}`,
      stderr: "",
      duration_ms: Math.max(0, Math.round(performance.now() - started)),
      command_label: commandSpec.label,
      redacted_command_preview: commandPreview(commandSpec),
    };
  }

  async uploadFile(): Promise<void> {
    return undefined;
  }

  async downloadFile(): Promise<void> {
    return undefined;
  }
}

export class InteractiveMfaRemoteExecutor extends BaseRemoteExecutor {
  private isAuthenticated = false;

  setAuthenticated(isAuthenticated: boolean): void {
    this.isAuthenticated = isAuthenticated;
  }

  getMode(): RemoteConnectionMode {
    return "interactive_mfa";
  }

  getConnectionStatus(settings: NibiSettings): RemoteConnectionStatus {
    const trimmed = trimNibiSettings(settings);
    if (!trimmed.nibi_username || !trimmed.normal_login_host) {
      return {
        mode: "interactive_mfa",
        state: "not_configured",
        label: "Not configured",
        message: "Add a NIBI username and normal login host.",
        host: trimmed.normal_login_host,
      };
    }

    if (this.isAuthenticated) {
      return {
        mode: "interactive_mfa",
        state: "authenticated",
        label: "Authenticated",
        message: "Manual login has been marked verified for this device.",
        host: trimmed.normal_login_host,
      };
    }

    if (trimmed.manual_login_verified) {
      return {
        mode: "interactive_mfa",
        state: "ready_for_manual_login",
        label: "Ready for manual login",
        message: "Manual login has worked before, but this app session still needs a fresh NIBI login.",
        host: trimmed.normal_login_host,
      };
    }

    return {
      mode: "interactive_mfa",
      state: "authentication_required",
      label: "Login required",
      message: "Manual password and Duo login is required for this app session.",
      host: trimmed.normal_login_host,
    };
  }

  async testConnection(settings: NibiSettings): Promise<RemoteConnectionStatus> {
    return this.getConnectionStatus(settings);
  }

  async runCommand(commandSpec: RemoteCommandSpec): Promise<RemoteCommandResult> {
    if (!this.isAuthenticated) {
      return {
        exit_code: 1,
        stdout: "",
        stderr: "Manual MFA login is not authenticated. Start manual NIBI login and test the session before running background commands.",
        duration_ms: 0,
        command_label: commandSpec.label,
        redacted_command_preview: commandSpec.redacted_preview ?? commandSpec.executable,
      };
    }
    return super.runCommand(commandSpec);
  }
}

export class RobotAutomationRemoteExecutor extends BaseRemoteExecutor {
  getMode(): RemoteConnectionMode {
    return "robot_automation";
  }

  getConnectionStatus(settings: NibiSettings): RemoteConnectionStatus {
    const trimmed = trimNibiSettings(settings);
    if (!trimmed.nibi_username || !trimmed.robot_login_host || !trimmed.ssh_private_key_path) {
      return {
        mode: "robot_automation",
        state: "not_configured",
        label: "Not configured",
        message: "Add a NIBI username, robot host, and restricted SSH key path.",
        host: trimmed.robot_login_host,
      };
    }

    return {
      mode: "robot_automation",
      state: trimmed.robot_access_verified ? "robot_automation_ready" : "failed",
      label: trimmed.robot_access_verified ? "Robot automation ready" : "Failed",
      message: trimmed.robot_access_verified
        ? "Robot-node access has been marked verified for this device."
        : "Robot access has not been verified yet.",
      host: trimmed.robot_login_host,
    };
  }

  async testConnection(settings: NibiSettings): Promise<RemoteConnectionStatus> {
    return this.getConnectionStatus(settings);
  }
}

export function createRemoteExecutor(mode: RemoteConnectionMode): RemoteExecutor {
  switch (mode) {
    case "interactive_mfa":
      return new InteractiveMfaRemoteExecutor();
    case "robot_automation":
      return new RobotAutomationRemoteExecutor();
    case "mock":
    default:
      return new MockRemoteExecutor();
  }
}
