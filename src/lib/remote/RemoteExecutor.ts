import type { NibiSettings, NibiSettingsErrors } from "../../features/settings";
import {
  trimNibiSettings,
  validateNibiSettings,
} from "../../features/settings";
import { invoke } from "@tauri-apps/api/core";
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
  uploadFile(localPath: string, remotePath: string, settings?: NibiSettings): Promise<void>;
  downloadFile(remotePath: string, localPath: string, settings?: NibiSettings): Promise<void>;
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

    if (trimmed.manual_mfa_provider === "terminal_action") {
      return {
        mode: "interactive_mfa",
        state: "authenticated",
        label: "Terminal action ready",
        message: "Manual MFA mode runs each NIBI action in a visible PowerShell window. Complete password and Duo when prompted.",
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
    const settings = commandSpec.settings as NibiSettings | undefined;
    if (!this.isAuthenticated && settings?.manual_mfa_provider !== "terminal_action") {
      return {
        exit_code: 1,
        stdout: "",
        stderr: "Manual MFA login is not authenticated. Start manual NIBI login and test the session before running background commands.",
        duration_ms: 0,
        command_label: commandSpec.label,
        redacted_command_preview: commandSpec.redacted_preview ?? commandSpec.executable,
      };
    }
    return invoke<RemoteCommandResult>("run_nibi_remote_command", {
      mode: "interactive_mfa",
      settings,
      commandSpec,
    });
  }

  async uploadFile(localPath: string, remotePath: string, settings?: NibiSettings): Promise<void> {
    if (!this.isAuthenticated && settings?.manual_mfa_provider !== "terminal_action") {
      throw new RemoteExecutionError(
        "Log into NIBI first",
        "manual_session_not_authenticated",
      );
    }
    await invoke("upload_nibi_file", {
      mode: "interactive_mfa",
      settings,
      localPath,
      remotePath,
    });
  }

  async downloadFile(remotePath: string, localPath: string, settings?: NibiSettings): Promise<void> {
    if (!this.isAuthenticated && settings?.manual_mfa_provider !== "terminal_action") {
      throw new RemoteExecutionError(
        "Log into NIBI first",
        "manual_session_not_authenticated",
      );
    }
    await invoke("download_nibi_file", {
      mode: "interactive_mfa",
      settings,
      remotePath,
      localPath,
    });
  }
}

export class RobotAutomationRemoteExecutor extends BaseRemoteExecutor {
  private isVerified(settings?: NibiSettings): boolean {
    return Boolean(settings && this.getConnectionStatus(settings).state === "robot_automation_ready");
  }

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

  async runCommand(commandSpec: RemoteCommandSpec): Promise<RemoteCommandResult> {
    const settings = commandSpec.settings as NibiSettings | undefined;
    if (!this.isVerified(settings)) {
      return {
        exit_code: 1,
        stdout: "",
        stderr: "Robot automation access is not verified. Test robot automation before running background commands.",
        duration_ms: 0,
        command_label: commandSpec.label,
        redacted_command_preview: commandSpec.redacted_preview ?? commandSpec.executable,
      };
    }
    return invoke<RemoteCommandResult>("run_nibi_remote_command", {
      mode: "robot_automation",
      settings,
      commandSpec,
    });
  }

  async uploadFile(localPath: string, remotePath: string, settings?: NibiSettings): Promise<void> {
    if (!this.isVerified(settings)) {
      throw new RemoteExecutionError(
        "Robot automation is not ready",
        "robot_access_not_verified",
      );
    }
    await invoke("upload_nibi_file", {
      mode: "robot_automation",
      settings,
      localPath,
      remotePath,
    });
  }

  async downloadFile(remotePath: string, localPath: string, settings?: NibiSettings): Promise<void> {
    if (!this.isVerified(settings)) {
      throw new RemoteExecutionError(
        "Robot automation access is not verified. Test robot automation before downloading files.",
        "robot_access_not_verified",
      );
    }
    await invoke("download_nibi_file", {
      mode: "robot_automation",
      settings,
      remotePath,
      localPath,
    });
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
