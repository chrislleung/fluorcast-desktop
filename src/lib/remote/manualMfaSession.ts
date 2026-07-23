import type { NibiSettings } from "../../features/settings";
import {
  CANONICAL_WSL_CONTROL_SOCKET_PATH,
  trimNibiSettings,
} from "../../features/settings";

export type ManualMfaSessionStatus =
  | "login_required"
  | "not_started"
  | "connecting"
  | "waiting_for_user_mfa"
  | "active"
  | "authenticated"
  | "authentication_required"
  | "session_not_found"
  | "session_not_reused"
  | "control_path_not_socket"
  | "stale_controlmaster"
  | "batch_mode_reuse_failed"
  | "auth_marker_missing"
  | "timeout"
  | "wsl_unavailable"
  | "bash_transport_failed"
  | "controlmaster_unsupported"
  | "permission_denied"
  | "disconnected"
  | "failed";

export type ManualMfaSessionCommands = {
  backend: "wsl";
  control_path: string;
  control_path_exists: boolean;
  control_socket_filename: string;
  script_dir: string;
  start_script_path: string;
  check_script_path: string;
  end_script_path: string;
  clean_script_path: string;
  wsl_distro: string;
  wsl_key_path: string;
  host: string;
  wsl_setup_key_commands: string;
  clean_stale_session_command: string;
  windows_terminal_command: string;
  powershell_launch_command: string;
  login_command: string;
  clean_script_content: string;
  check_script_content: string;
  end_script_content: string;
  check_command: string;
  test_command: string;
  end_command: string;
  background_command_template: string;
  manual_wsl_login_command: string;
  redacted_login_command_preview: string;
  redacted_test_command_preview: string;
  redacted_end_command_preview: string;
};

export type ManualMfaSessionResult = {
  status: ManualMfaSessionStatus;
  message: string;
  success: boolean;
  authenticated: boolean;
  failure_code: string;
  exit_code: number | null;
  wsl_distro: string;
  wsl_user: string;
  wsl_home: string;
  resolved_control_path: string;
  socket_exists: boolean;
  master_running: boolean;
  authentication_marker_received: boolean;
  stdout: string;
  stderr: string;
  control_path: string;
  control_path_exists: boolean;
  redacted_command_preview: string;
  can_run_background_commands: boolean;
  last_master_check_result: string;
  last_auth_ok_result: string;
  last_session_test_stdout: string;
  last_session_test_stderr: string;
  last_session_test_exit_code: number | null;
  parsed_session_status: ManualMfaSessionStatus;
  selected_backend: "wsl" | "persistent_shell";
  wsl_available: boolean | null;
  wsl_ssh_available: boolean | null;
};

export type LocalSshCapabilitiesResult = {
  ssh_version: string;
  platform: string;
  controlmaster_supported: boolean | null;
  controlpath_supported: boolean | null;
  attempted_controlmaster: boolean;
  syntax_stdout: string;
  syntax_stderr: string;
  syntax_exit_code: number | null;
  recommendation: string;
};

export type ManualMfaTerminalLaunchResult = {
  launched: boolean;
  method: "windows_terminal" | "powershell" | "manual";
  message: string;
  error_message: string;
  timestamp: string;
  commands: ManualMfaSessionCommands;
  windows_terminal_available: boolean;
  powershell_available: boolean;
  wsl_available: boolean;
  distro_available: boolean;
  command_preview: string;
  generated_script_path: string;
  script_file_exists: boolean;
  launch_method_attempted: string;
  launch_error_code: string;
  manual_wsl_command: string;
};

export type ManualMfaSessionUiState = {
  status: ManualMfaSessionStatus;
  control_path: string;
  session_started_at: string;
  last_successful_command_at: string;
  last_session_probe_at: string;
  last_session_test_result: string;
  control_path_exists: boolean | null;
  can_run_background_commands: boolean;
  last_master_check_result: string;
  last_auth_ok_result: string;
  last_session_test_stdout: string;
  last_session_test_stderr: string;
  last_session_test_exit_code: number | null;
  parsed_session_status: ManualMfaSessionStatus;
  selected_backend: "wsl" | "persistent_shell";
  wsl_available: boolean | null;
  wsl_ssh_available: boolean | null;
  wsl_distro: string;
  wsl_user: string;
  wsl_home: string;
  windows_terminal_available: boolean | null;
  powershell_available: boolean | null;
  last_terminal_launch_method: string;
  last_terminal_launch_command_preview: string;
  last_terminal_launch_success: boolean | null;
  last_terminal_launch_error: string;
  last_terminal_launch_at: string;
  last_generated_script_path: string;
  last_launch_method_attempted: string;
  last_launch_error_code: string;
  last_script_file_exists: boolean | null;
  manual_wsl_command: string;
  jobs_page_login_required_at: string;
  persistent_shell_output: string;
  persistent_shell_process_id: number | null;
};

export const defaultManualMfaSessionState: ManualMfaSessionUiState = {
  status: "login_required",
  control_path: "",
  session_started_at: "",
  last_successful_command_at: "",
  last_session_probe_at: "",
  last_session_test_result: "Manual login has not been completed yet.",
  control_path_exists: null,
  can_run_background_commands: false,
  last_master_check_result: "",
  last_auth_ok_result: "",
  last_session_test_stdout: "",
  last_session_test_stderr: "",
  last_session_test_exit_code: null,
  parsed_session_status: "login_required",
  selected_backend: "wsl",
  wsl_available: null,
  wsl_ssh_available: null,
  wsl_distro: "Ubuntu",
  wsl_user: "",
  wsl_home: "",
  windows_terminal_available: null,
  powershell_available: null,
  last_terminal_launch_method: "",
  last_terminal_launch_command_preview: "",
  last_terminal_launch_success: null,
  last_terminal_launch_error: "",
  last_terminal_launch_at: "",
  last_generated_script_path: "",
  last_launch_method_attempted: "",
  last_launch_error_code: "",
  last_script_file_exists: null,
  manual_wsl_command: "",
  jobs_page_login_required_at: "",
  persistent_shell_output: "",
  persistent_shell_process_id: null,
};

const AUTH_OK = "FLUORCAST_AUTH_OK";

function hasCompleteTrimmedLine(output: string, expected: string): boolean {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .some((line) => line === expected);
}

export function quotePowerShellArg(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function buildManualMfaSessionCommands(
  settings: NibiSettings,
  controlPath = CANONICAL_WSL_CONTROL_SOCKET_PATH,
): ManualMfaSessionCommands {
  const trimmed = trimNibiSettings(settings);
  const target = `${trimmed.nibi_username}@${trimmed.normal_login_host}`;
  const key = trimmed.wsl_ssh_private_key_path;
  const distro = trimmed.manual_mfa_wsl_distro;
  const socketName = controlPath.split("/").at(-1) ?? "cm-nibi.sock";
  const scriptDir = "$HOME/.fluorcast/scripts";
  const startScriptPath = `${scriptDir}/start-nibi-login.sh`;
  const checkScriptPath = `${scriptDir}/check-nibi-session.sh`;
  const endScriptPath = `${scriptDir}/end-nibi-session.sh`;
  const cleanScriptPath = `${scriptDir}/clean-nibi-session.sh`;
  const manualWslLoginCommand = `wsl.exe -d ${quoteWindowsArg(distro)} -- bash -- ${quoteWindowsArg(startScriptPath)} ${quoteWindowsArg(target)} ${quoteWindowsArg(key)}`;
  const wslSetupKeyCommands = "Debug only: create or copy the private key inside WSL, then enter its absolute Linux path in FluorCast.";
  const clean = [
    "#!/usr/bin/env bash",
    "set -Eeuo pipefail",
    "",
    'HOST="$1"',
    'CTL="$HOME/.fluorcast/ssh/cm-nibi.sock"',
    "",
    'printf \'WSL_DISTRO=%s\\n\' "${WSL_DISTRO_NAME:-unknown}"',
    'printf \'WSL_USER=%s\\n\' "$(whoami)"',
    'printf \'WSL_HOME=%s\\n\' "$HOME"',
    'printf \'CONTROL_PATH=%s\\n\' "$CTL"',
    'mkdir -p "$HOME/.fluorcast/ssh"',
    'chmod 700 "$HOME/.fluorcast/ssh"',
    "",
    'if [[ ! -e "$CTL" ]]; then',
    "  printf 'CLEAN_RESULT=NO_SESSION\\n'",
    "  exit 0",
    "fi",
    "",
    'if [[ -S "$CTL" ]] && ssh -n -S "$CTL" -O check "$HOST" >/dev/null 2>&1; then',
    '  ssh -n -S "$CTL" -O exit "$HOST" >/dev/null 2>&1 || true',
    '  rm -f "$CTL"',
    "  printf 'CLEAN_RESULT=HEALTHY_SESSION_CLOSED\\n'",
    "  exit 0",
    "fi",
    "",
    'if [[ -S "$CTL" ]]; then',
    '  rm -f "$CTL"',
    "  printf 'CLEAN_RESULT=STALE_SOCKET_REMOVED\\n'",
    "  exit 0",
    "fi",
    "",
    "printf 'CLEAN_RESULT=CLEANUP_FAILED\\n'",
    "exit 14",
  ].join("\n");
  const start = [
    "#!/usr/bin/env bash",
    "set -Eeuo pipefail",
    "",
    'HOST="$1"',
    'KEY="$2"',
    'CTL="$HOME/.fluorcast/ssh/cm-nibi.sock"',
    "",
    'mkdir -p "$HOME/.fluorcast/ssh"',
    'chmod 700 "$HOME/.fluorcast/ssh"',
    "",
    'case "$KEY" in',
    "  '$HOME'/*) KEY=\"$HOME/${KEY#\\$HOME/}\" ;;",
    "  '~'/*) KEY=\"$HOME/${KEY#~/}\" ;;",
    "  /*) ;;",
    "  *)",
    '    echo "WSL private key path must be /home, $HOME/, or ~/."',
    "    exit 20",
    "    ;;",
    "esac",
    "",
    'if [[ ! -e "$KEY" ]]; then',
    '  echo "WSL private key was not found."',
    "  exit 21",
    "fi",
    'if [[ ! -f "$KEY" ]]; then',
    '  echo "WSL private key path is not a regular file."',
    "  exit 22",
    "fi",
    'if [[ ! -r "$KEY" ]]; then',
    '  echo "WSL private key is not readable."',
    "  exit 23",
    "fi",
    "",
    'if [[ -S "$CTL" ]] && ssh -S "$CTL" -O check "$HOST" >/dev/null 2>&1; then',
    '  echo "An active FluorCast NIBI session already exists."',
    'elif [[ -e "$CTL" && ! -S "$CTL" ]]; then',
    '  echo "ControlPath exists but is not a socket. Clean stale WSL session first."',
    "  exit 24",
    "else",
    '  [[ ! -e "$CTL" || -S "$CTL" ]] && rm -f "$CTL"',
    "  ssh -fMN \\",
    '    -S "$CTL" \\',
    '    -i "$KEY" \\',
    "    -o IdentitiesOnly=yes \\",
    "    -o ControlMaster=yes \\",
    '    -o ControlPath="$CTL" \\',
    "    -o ControlPersist=4h \\",
    "    -o ServerAliveInterval=60 \\",
    "    -o ServerAliveCountMax=3 \\",
    '    "$HOST"',
    "fi",
    "echo",
    'echo "Checking FluorCast NIBI session..."',
    'test -S "$CTL"',
    'ssh -S "$CTL" -O check "$HOST"',
    "echo",
    'echo "FluorCast NIBI session created."',
    'echo "Return to FluorCast and press Test authenticated session."',
    'read -r -p "Press Enter to close this window..."',
  ].join("\n");
  const checkScript = [
    "#!/usr/bin/env bash",
    "set -Eeuo pipefail",
    "",
    'HOST="$1"',
    'CTL="$HOME/.fluorcast/ssh/cm-nibi.sock"',
    "",
    "printf 'SESSION_TEST_VERSION=4\\n'",
    'printf \'WSL_DISTRO=%s\\n\' "${WSL_DISTRO_NAME:-unknown}"',
    'printf \'WSL_USER=%s\\n\' "$(whoami)"',
    'printf \'WSL_HOME=%s\\n\' "$HOME"',
    'printf \'CONTROL_PATH=%s\\n\' "$CTL"',
    "",
    'if [[ ! -e "$CTL" ]]; then',
    "  printf 'SESSION_ERROR=CONTROL_PATH_MISSING\\n'",
    "  exit 10",
    "fi",
    "",
    'if [[ ! -S "$CTL" ]]; then',
    "  printf 'SESSION_ERROR=CONTROL_PATH_NOT_SOCKET\\n'",
    "  exit 11",
    "fi",
    "",
    "printf 'SOCKET_EXISTS=1\\n'",
    "",
    "set +e",
    'ssh -n -S "$CTL" -O check "$HOST"',
    "MASTER_EXIT=$?",
    "set -e",
    'printf \'MASTER_EXIT=%s\\n\' "$MASTER_EXIT"',
    'if [[ "$MASTER_EXIT" -ne 0 ]]; then',
    "  printf 'SESSION_ERROR=CONTROL_MASTER_CHECK_FAILED\\n'",
    "  exit 12",
    "fi",
    "",
    "printf 'MASTER_RUNNING=1\\n'",
    "",
    "printf 'BATCH_REUSE_BEGIN=1\\n'",
    "set +e",
    'RESULT="$(',
    "  ssh \\",
    "    -n \\",
    '    -S "$CTL" \\',
    "    -o ControlMaster=no \\",
    "    -o BatchMode=yes \\",
    "    -o ConnectTimeout=10 \\",
    "    -o PasswordAuthentication=no \\",
    "    -o KbdInteractiveAuthentication=no \\",
    '    "$HOST" \\',
    "    'printf \"FLUORCAST_AUTH_OK\\n\"'",
    ')"',
    "BATCH_EXIT=$?",
    "set -e",
    'printf \'BATCH_EXIT=%s\\n\' "$BATCH_EXIT"',
    'printf \'REMOTE_RESULT=%s\\n\' "$RESULT"',
    'if [[ "$BATCH_EXIT" -ne 0 ]]; then',
    '  exit "$BATCH_EXIT"',
    "fi",
    "",
    'if [[ "$RESULT" != "FLUORCAST_AUTH_OK" ]]; then',
    "  printf 'SESSION_ERROR=AUTH_MARKER_MISSING\\n'",
    "  printf 'REMOTE_OUTPUT=%s\\n' \"$RESULT\"",
    "  exit 13",
    "fi",
    "",
    "printf 'AUTHENTICATION_MARKER_RECEIVED=1\\n'",
    "printf 'FLUORCAST_AUTH_OK\\n'",
  ].join("\n");
  const endScript = [
    "#!/usr/bin/env bash",
    "set -Eeuo pipefail",
    "",
    'HOST="$1"',
    'CTL="$HOME/.fluorcast/ssh/cm-nibi.sock"',
    "",
    'ssh -n -S "$CTL" -O exit "$HOST"',
  ].join("\n");
  const check = `wsl.exe -d ${quoteWindowsArg(distro)} -- bash -s -- ${quoteWindowsArg(target)}`;
  const test = checkScript;
  const end = `bash ${endScriptPath}`;
  const background = [
    'HOST="$1"',
    'REMOTE_COMMAND="$2"',
    'CTL="$HOME/.fluorcast/ssh/cm-nibi.sock"',
    'ssh -n -S "$CTL" -o ControlMaster=no -o BatchMode=yes -o PasswordAuthentication=no -o KbdInteractiveAuthentication=no "$HOST" "$REMOTE_COMMAND"',
  ].join("\n");

  return {
    backend: "wsl",
    control_path: controlPath,
    control_path_exists: false,
    control_socket_filename: socketName,
    script_dir: scriptDir,
    start_script_path: startScriptPath,
    check_script_path: checkScriptPath,
    end_script_path: endScriptPath,
    clean_script_path: cleanScriptPath,
    wsl_distro: distro,
    wsl_key_path: key,
    host: target,
    wsl_setup_key_commands: wslSetupKeyCommands,
    clean_stale_session_command: `bash ${cleanScriptPath}`,
    windows_terminal_command: buildWindowsTerminalCommand(distro, target, key),
    powershell_launch_command: buildPowerShellLaunchCommand(distro, target, key),
    login_command: start,
    clean_script_content: clean,
    check_script_content: checkScript,
    end_script_content: endScript,
    check_command: check,
    test_command: test,
    end_command: end,
    background_command_template: background,
    manual_wsl_login_command: manualWslLoginCommand,
    redacted_login_command_preview: redactSessionCommand(start, controlPath, key),
    redacted_test_command_preview: redactSessionCommand(test, controlPath, key),
    redacted_end_command_preview: redactSessionCommand(endScript, controlPath, key),
  };
}

export function isInteractiveAuthenticationOutput(output: string): boolean {
  const lower = output.toLowerCase();
  return lower.includes("password:")
    || lower.includes("duo")
    || lower.includes("passcode")
    || lower.includes("verification")
    || lower.includes("keyboard-interactive")
    || lower.includes("multifactor authentication")
    || output.includes("Permission denied (publickey,keyboard-interactive,hostbased)");
}

export function classifyManualMfaSessionTest(
  output: { exit_code: number; stdout: string; stderr: string; control_path_exists: boolean },
): Pick<ManualMfaSessionResult, "status" | "message" | "can_run_background_commands"> {
  const combined = `${output.stdout}\n${output.stderr}`;
  if (output.exit_code === 0 && hasCompleteTrimmedLine(output.stdout, AUTH_OK)) {
    return {
      status: "authenticated",
      message: `Authenticated WSL NIBI session is ready.\n${AUTH_OK}`,
      can_run_background_commands: true,
    };
  }
  if (output.exit_code === 10 || combined.includes("SESSION_ERROR=CONTROL_PATH_MISSING")) {
    return {
      status: "session_not_found",
      message: "No FluorCast WSL session socket was found.",
      can_run_background_commands: false,
    };
  }
  if (output.exit_code === 11 || combined.includes("SESSION_ERROR=CONTROL_PATH_NOT_SOCKET")) {
    return {
      status: "control_path_not_socket",
      message: "The FluorCast ControlPath exists but is not a Unix socket.",
      can_run_background_commands: false,
    };
  }
  if (output.exit_code === 12 || combined.includes("SESSION_ERROR=CONTROL_MASTER_CHECK_FAILED")) {
    return {
      status: "stale_controlmaster",
      message: "The FluorCast SSH ControlMaster is no longer running.",
      can_run_background_commands: false,
    };
  }
  if (output.exit_code === 13 || combined.includes("SESSION_ERROR=AUTH_MARKER_MISSING")) {
    return {
      status: "auth_marker_missing",
      message: "The SSH master was found, but the authentication marker was not returned.",
      can_run_background_commands: false,
    };
  }
  if (output.exit_code === 124) {
    return {
      status: "timeout",
      message: "The authenticated-session test timed out.",
      can_run_background_commands: false,
    };
  }
  if (isControlMasterUnsupportedOutput(combined)) {
    return {
      status: "controlmaster_unsupported",
      message: "Your SSH client may not support reusable ControlMaster sessions on Windows. Use WSL/manual fallback or robot automation.",
      can_run_background_commands: false,
    };
  }
  if (isInteractiveAuthenticationOutput(combined)) {
    return {
      status: "session_not_reused",
      message: "The app session was not reused. NIBI is asking for login again.",
      can_run_background_commands: false,
    };
  }
  if (isPermissionDeniedOutput(combined)) {
    return {
      status: "permission_denied",
      message: "Authentication failed. Check username, SSH key, and MFA setup.",
      can_run_background_commands: false,
    };
  }
  if (!output.control_path_exists) {
    return {
      status: "session_not_found",
      message: "FluorCast did not find the reusable SSH session. Start login from FluorCast and keep the session alive.",
      can_run_background_commands: false,
    };
  }
  return {
    status: "failed",
    message: "Manual login has not been completed yet.",
    can_run_background_commands: false,
  };
}

export function isControlMasterUnsupportedOutput(output: string): boolean {
  return /Bad configuration option:\s*controlmaster|Unsupported option|ControlMaster|ControlPath|mux/i.test(output);
}

export function isPermissionDeniedOutput(output: string): boolean {
  return /Permission denied/i.test(output) && !isInteractiveAuthenticationOutput(output);
}

export function applyManualMfaSessionResult(
  current: ManualMfaSessionUiState,
  result: ManualMfaSessionResult,
  options: { canMarkAuthenticated?: boolean; jobsPageBlocked?: boolean } = {},
): ManualMfaSessionUiState {
  const checkedAt = new Date().toISOString();
  const canMarkAuthenticated = options.canMarkAuthenticated ?? false;
  const resultMarksAuthenticated = result.status === "authenticated" || result.can_run_background_commands;
  const canRunBackgroundCommands = canMarkAuthenticated && result.can_run_background_commands;
  const markers = parseSessionMarkers([
    result.stdout,
    result.stderr,
    result.last_session_test_stdout,
    result.last_session_test_stderr,
    result.last_master_check_result,
    result.last_auth_ok_result,
  ].join("\n"));
  return {
    ...current,
    status: resultMarksAuthenticated && !canMarkAuthenticated ? "login_required" : result.status,
    control_path: result.resolved_control_path || markers.CONTROL_PATH || result.control_path,
    control_path_exists: result.control_path_exists,
    last_session_probe_at: checkedAt,
    last_session_test_result: result.message,
    can_run_background_commands: canRunBackgroundCommands,
    last_master_check_result: result.last_master_check_result,
    last_auth_ok_result: result.last_auth_ok_result,
    last_session_test_stdout: result.last_session_test_stdout ?? "",
    last_session_test_stderr: result.last_session_test_stderr ?? "",
    last_session_test_exit_code: result.last_session_test_exit_code ?? null,
    parsed_session_status: result.parsed_session_status ?? result.status,
    selected_backend: "wsl",
    wsl_available: result.wsl_available,
    wsl_ssh_available: result.wsl_ssh_available,
    wsl_distro: result.wsl_distro || markers.WSL_DISTRO || current.wsl_distro,
    wsl_user: result.wsl_user || markers.WSL_USER || current.wsl_user,
    wsl_home: result.wsl_home || markers.WSL_HOME || current.wsl_home,
    last_successful_command_at: canRunBackgroundCommands
      ? checkedAt
      : current.last_successful_command_at,
    jobs_page_login_required_at: options.jobsPageBlocked ? checkedAt : current.jobs_page_login_required_at,
  };
}

function parseSessionMarkers(output: string): Record<string, string> {
  const markers: Record<string, string> = {};
  for (const line of output.split(/\r?\n/)) {
    const match = /^(WSL_DISTRO|WSL_USER|WSL_HOME|CONTROL_PATH)=(.*)$/.exec(line.trim());
    if (match) {
      markers[match[1]] = match[2];
    }
  }
  return markers;
}

export function applyManualMfaTerminalLaunchResult(
  current: ManualMfaSessionUiState,
  launch: ManualMfaTerminalLaunchResult,
): ManualMfaSessionUiState {
  const startedAt = new Date().toISOString();
  const commands = launch.commands;
  return {
    ...current,
    status: launch.launched ? "waiting_for_user_mfa" : "login_required",
    control_path: commands.control_path,
    session_started_at: startedAt,
    last_session_test_result: launch.message,
    control_path_exists: commands.control_path_exists,
    can_run_background_commands: false,
    selected_backend: "wsl",
    wsl_available: launch.wsl_available,
    wsl_ssh_available: null,
    wsl_distro: commands.wsl_distro,
    windows_terminal_available: launch.windows_terminal_available,
    powershell_available: launch.powershell_available,
    last_terminal_launch_method: launch.method,
    last_terminal_launch_command_preview: launch.command_preview,
    last_terminal_launch_success: launch.launched,
    last_terminal_launch_error: launch.error_message,
    last_terminal_launch_at: launch.timestamp,
    last_generated_script_path: launch.generated_script_path,
    last_launch_method_attempted: launch.launch_method_attempted,
    last_launch_error_code: launch.launch_error_code,
    last_script_file_exists: launch.script_file_exists,
    manual_wsl_command: launch.manual_wsl_command,
  };
}

export function mapManualMfaSessionError(output: string): string {
  if (/getsockname failed: Not a socket/i.test(output)) {
    return "Native Windows SSH session reuse failed. Use WSL Manual MFA mode.";
  }
  if (isControlMasterUnsupportedOutput(output)) {
    return "Your SSH client may not support reusable ControlMaster sessions on Windows. Use WSL/manual fallback or robot automation.";
  }
  if (isPermissionDeniedOutput(output)) {
    return "Authentication failed. Check username, SSH key, and MFA setup.";
  }
  if (/code 15|0x0000000f|exit status:\s*15|signal:\s*15/i.test(output)) {
    return "The login terminal exited before authentication. The start script may have terminated itself. Try again after cleaning stale session.";
  }
  if (/0x80070002|2147942402/i.test(output)) {
    return "Windows could not find the terminal command to launch. Use the manual WSL command below.";
  }
  if (/Broken pipe|mux_client_request_session|Control socket connect|Connection refused|No such file or directory|Master is not running/i.test(output)) {
    return "FluorCast did not find the reusable SSH session. Start login from FluorCast and keep the session alive.";
  }
  return output;
}

export function buildWslBackgroundCommand(settings: NibiSettings, remoteCommand: string): string {
  const commands = buildManualMfaSessionCommands(settings);
  return [
    `HOST=${shellQuote(commands.host)}`,
    `REMOTE_COMMAND=${shellQuote(remoteCommand)}`,
    'CTL="$HOME/.fluorcast/ssh/cm-nibi.sock"',
    'ssh -n -S "$CTL" -o ControlMaster=no -o BatchMode=yes -o PasswordAuthentication=no -o KbdInteractiveAuthentication=no "$HOST" "$REMOTE_COMMAND"',
  ].join("\n");
}

export function buildWindowsTerminalCommand(distro: string, host: string, key: string): string {
  const wsl = distro.trim()
    ? `wsl.exe -d ${quoteWindowsArg(distro.trim())} -- bash -- ${quoteWindowsArg("$HOME/.fluorcast/scripts/start-nibi-login.sh")} ${quoteWindowsArg(host)} ${quoteWindowsArg(key)}`
    : `wsl.exe -- bash -- ${quoteWindowsArg("$HOME/.fluorcast/scripts/start-nibi-login.sh")} ${quoteWindowsArg(host)} ${quoteWindowsArg(key)}`;
  return redactSessionCommand(`wt.exe new-tab --title "FluorCast NIBI Login" ${wsl}`, CANONICAL_WSL_CONTROL_SOCKET_PATH, key);
}

export function buildPowerShellLaunchCommand(distro: string, host: string, key: string): string {
  void distro;
  void host;
  void key;
  return "PowerShell fallback is disabled for Manual MFA terminal launch; FluorCast spawns wt.exe directly.";
}

function shellQuote(value: string) {
  return `"${value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"`;
}

function quoteWindowsArg(value: string) {
  return `"${value.replaceAll("\"", "\\\"")}"`;
}

function redactSessionCommand(command: string, controlPath: string, key: string) {
  return command
    .replaceAll(controlPath, "<wsl_control_socket_path>")
    .replaceAll(key, "<wsl_private_key_path>");
}

export function windowsPathToWslMount(path: string): string {
  const match = /^([a-zA-Z]):[\\/](.*)$/.exec(path.trim());
  if (!match) return "";
  return `/mnt/${match[1].toLowerCase()}/${match[2].replaceAll("\\", "/")}`;
}
