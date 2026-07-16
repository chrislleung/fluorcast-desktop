import type { NibiSettings } from "../../features/settings";
import { trimNibiSettings } from "../../features/settings";

export type ManualMfaSessionStatus =
  | "login_required"
  | "waiting_for_user_mfa"
  | "authenticated"
  | "authentication_required"
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
  control_path: string;
  control_path_exists: boolean;
  redacted_command_preview: string;
  can_run_background_commands: boolean;
  last_master_check_result: string;
  last_auth_ok_result: string;
  selected_backend: "wsl";
  wsl_available: boolean | null;
  wsl_ssh_available: boolean | null;
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
  last_session_test_result: string;
  control_path_exists: boolean | null;
  can_run_background_commands: boolean;
  last_master_check_result: string;
  last_auth_ok_result: string;
  selected_backend: "wsl";
  wsl_available: boolean | null;
  wsl_ssh_available: boolean | null;
  wsl_distro: string;
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
};

export const defaultManualMfaSessionState: ManualMfaSessionUiState = {
  status: "login_required",
  control_path: "",
  session_started_at: "",
  last_successful_command_at: "",
  last_session_test_result: "Manual login has not been completed yet.",
  control_path_exists: null,
  can_run_background_commands: false,
  last_master_check_result: "",
  last_auth_ok_result: "",
  selected_backend: "wsl",
  wsl_available: null,
  wsl_ssh_available: null,
  wsl_distro: "Ubuntu",
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
};

const AUTH_OK = "FLUORCAST_AUTH_OK";

export function quotePowerShellArg(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function buildManualMfaSessionCommands(
  settings: NibiSettings,
  controlPath = trimNibiSettings(settings).wsl_control_socket_path,
): ManualMfaSessionCommands {
  const trimmed = trimNibiSettings(settings);
  const target = `${trimmed.nibi_username}@${trimmed.normal_login_host}`;
  const key = trimmed.wsl_ssh_private_key_path;
  const distro = trimmed.manual_mfa_wsl_distro;
  const socketName = controlPath.split("/").at(-1) ?? "cm-user-nibi.sock";
  const prelude = wslPrelude(controlPath, key, target);
  const scriptDir = "$HOME/.fluorcast/scripts";
  const startScriptPath = `${scriptDir}/start-nibi-login.sh`;
  const checkScriptPath = `${scriptDir}/check-nibi-session.sh`;
  const endScriptPath = `${scriptDir}/end-nibi-session.sh`;
  const cleanScriptPath = `${scriptDir}/clean-nibi-session.sh`;
  const manualWslLoginCommand = `bash ${startScriptPath}`;
  const wslSetupKeyCommands = [
    "mkdir -p ~/.ssh ~/.fluorcast/ssh",
    `cp ${shellQuote(windowsPathToWslMount(trimmed.ssh_private_key_path) || "/mnt/c/Users/<you>/.ssh/id_ed25519")} ~/.ssh/fluorcast_nibi_ed25519`,
    "chmod 600 ~/.ssh/fluorcast_nibi_ed25519",
  ].join("\n");
  const clean = [
    "#!/usr/bin/env bash",
    "set -u",
    "",
    prelude,
    "",
    'ssh -S "$ctl" -O exit "$host" 2>/dev/null || true',
    'rm -f "$ctl"',
    'mkdir -p "$HOME/.fluorcast/ssh"',
  ].join("\n");
  const start = [
    "#!/usr/bin/env bash",
    "set -u",
    "",
    prelude,
    "",
    'mkdir -p "$HOME/.fluorcast/ssh"',
    "",
    'if ssh -S "$ctl" -O check "$host" >/dev/null 2>&1; then',
    '  echo "An active FluorCast NIBI session already exists."',
    "else",
    '  rm -f "$ctl"',
    "  ssh -fMN \\",
    '    -S "$ctl" \\',
    '    -i "$key" \\',
    "    -o IdentitiesOnly=yes \\",
    "    -o ControlPersist=4h \\",
    "    -o ServerAliveInterval=60 \\",
    "    -o ServerAliveCountMax=3 \\",
    '    "$host"',
    "fi",
    "echo",
    'echo "Checking FluorCast NIBI session..."',
    'ssh -S "$ctl" -O check "$host" || true',
    "echo",
    'echo "Return to FluorCast and click Test authenticated session."',
    'read -r -p "Press Enter to close this window..."',
  ].join("\n");
  const checkScript = ["#!/usr/bin/env bash", "set -u", "", prelude, "", 'ssh -S "$ctl" -O check "$host"'].join("\n");
  const endScript = ["#!/usr/bin/env bash", "set -u", "", prelude, "", 'ssh -S "$ctl" -O exit "$host"'].join("\n");
  const check = `bash ${checkScriptPath}`;
  const test = [prelude, `ssh -S "$ctl" -o BatchMode=yes "$host" "echo ${AUTH_OK}"`].join("\n");
  const end = `bash ${endScriptPath}`;
  const background = [prelude, 'ssh -S "$ctl" -o BatchMode=yes "$host" "<remote command>"'].join("\n");

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
    windows_terminal_command: buildWindowsTerminalCommand(startScriptPath, distro),
    powershell_launch_command: buildPowerShellLaunchCommand(startScriptPath, distro),
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
  if (output.exit_code === 0 && output.stdout.trim() === AUTH_OK) {
    return {
      status: "authenticated",
      message: "Manual NIBI login is authenticated and background commands can reuse the session.",
      can_run_background_commands: true,
    };
  }
  if (isInteractiveAuthenticationOutput(combined)) {
    return {
      status: "authentication_required",
      message: "NIBI still requested password/Duo, so the app cannot run background commands yet. Start manual login again.",
      can_run_background_commands: false,
    };
  }
  if (!output.control_path_exists) {
    return {
      status: "disconnected",
      message: "The SSH control session was not found or expired. Start manual login again.",
      can_run_background_commands: false,
    };
  }
  return {
    status: "failed",
    message: "Manual login has not been completed yet.",
    can_run_background_commands: false,
  };
}

export function mapManualMfaSessionError(output: string): string {
  if (/getsockname failed: Not a socket/i.test(output)) {
    return "Native Windows SSH session reuse failed. Use WSL Manual MFA mode.";
  }
  if (/code 15|0x0000000f|exit status:\s*15|signal:\s*15/i.test(output)) {
    return "The login terminal exited before authentication. The start script may have terminated itself. Try again after cleaning stale session.";
  }
  if (/0x80070002|2147942402/i.test(output)) {
    return "Windows could not find the terminal command to launch. Use the manual WSL command below.";
  }
  if (/Broken pipe|mux_client_request_session|Control socket connect|Connection refused|No such file or directory|Master is not running/i.test(output)) {
    return "The NIBI login session is not active. Start manual login again.";
  }
  return output;
}

export function buildWslBackgroundCommand(settings: NibiSettings, remoteCommand: string): string {
  const commands = buildManualMfaSessionCommands(settings);
  return `${wslPrelude(commands.control_path, commands.wsl_key_path, commands.host)}\nssh -S "$ctl" -o BatchMode=yes "$host" ${shellQuote(remoteCommand)}`;
}

export function buildWindowsTerminalCommand(scriptPath: string, distro: string): string {
  const bashCommand = `bash ${scriptPath}`;
  const wsl = distro.trim()
    ? `wsl.exe -d ${quoteWindowsArg(distro.trim())} -- bash -lc ${quoteWindowsArg(bashCommand)}`
    : `wsl.exe -- bash -lc ${quoteWindowsArg(bashCommand)}`;
  return `wt.exe new-tab --title "FluorCast NIBI Login" ${wsl}`;
}

export function buildPowerShellLaunchCommand(scriptPath: string, distro: string): string {
  const bashCommand = `bash ${scriptPath}`;
  const wsl = distro.trim()
    ? `wsl.exe -d ${quoteWindowsArg(distro.trim())} -- bash -lc ${quoteWindowsArg(bashCommand)}`
    : `wsl.exe -- bash -lc ${quoteWindowsArg(bashCommand)}`;
  return `powershell.exe -NoProfile -Command "Start-Process powershell.exe -ArgumentList '-NoExit', '-Command', '${wsl.replaceAll("'", "''")}'"`;
}

function wslPrelude(controlPath: string, key: string, host: string) {
  return [
    `ctl=${shellQuote(controlPath)}`,
    `key=${shellQuote(key)}`,
    `host=${shellQuote(host)}`,
  ].join("\n");
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
