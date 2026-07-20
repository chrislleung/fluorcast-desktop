export type RemoteConnectionMode = "mock" | "interactive_mfa" | "robot_automation";

export type RemoteConnectionState =
  | "not_configured"
  | "ready_for_manual_login"
  | "authenticated"
  | "authentication_required"
  | "robot_automation_ready"
  | "failed";

export type RemoteConnectionStatus = {
  mode: RemoteConnectionMode;
  state: RemoteConnectionState;
  label: string;
  message: string;
  host?: string;
};

export type RemoteCommandSpec = {
  label: string;
  executable: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeout_ms?: number;
  redacted_preview?: string;
  settings?: unknown;
};

export type RemoteCommandResult = {
  exit_code: number;
  stdout: string;
  stderr: string;
  duration_ms: number;
  command_label: string;
  redacted_command_preview: string;
  timed_out?: boolean;
};

export class RemoteExecutionError extends Error {
  readonly code: string;
  readonly status?: RemoteConnectionStatus;

  constructor(message: string, code = "remote_execution_error", status?: RemoteConnectionStatus) {
    super(message);
    this.name = "RemoteExecutionError";
    this.code = code;
    this.status = status;
  }
}
