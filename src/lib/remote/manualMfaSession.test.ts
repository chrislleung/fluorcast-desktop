import { describe, expect, it } from "vitest";
import { defaultNibiSettings } from "../../features/settings";
import {
  buildWslBackgroundCommand,
  buildManualMfaSessionCommands,
  classifyManualMfaSessionTest,
  isInteractiveAuthenticationOutput,
  mapManualMfaSessionError,
} from "./manualMfaSession";

const settings = {
  ...defaultNibiSettings,
  connection_mode: "interactive_mfa" as const,
  nibi_username: "alice",
  normal_login_host: "nibi.alliancecan.ca",
  ssh_private_key_path: "C:\\Users\\Alice\\.ssh\\fluorcast_nibi_ed25519",
  wsl_ssh_private_key_path: "/home/alice/.ssh/fluorcast_nibi_ed25519",
  wsl_control_socket_path: "$HOME/.fluorcast/ssh/cm-alice-nibi.sock",
  manual_mfa_wsl_distro: "Ubuntu",
};

describe("manual MFA session helpers", () => {
  it("selects WSL by default and generates the -fMN start command", () => {
    const commands = buildManualMfaSessionCommands(settings);

    expect(commands.backend).toBe("wsl");
    expect(commands.control_path).toBe("$HOME/.fluorcast/ssh/cm-nibi.sock");
    expect(commands.start_script_path).toBe("$HOME/.fluorcast/scripts/start-nibi-login.sh");
    expect(commands.start_script_path.startsWith("$HOME/.fluorcast/scripts/")).toBe(true);
    expect(commands.login_command).toContain('CTL="$HOME/.fluorcast/ssh/cm-nibi.sock"');
    expect(commands.login_command).toContain('KEY="$2"');
    expect(commands.login_command).toContain('HOST="$1"');
    expect(commands.login_command).toContain("'$HOME'/*) KEY=\"$HOME/${KEY#\\$HOME/}\"");
    expect(commands.login_command).toContain("'~'/*) KEY=\"$HOME/${KEY#~/}\"");
    expect(commands.login_command).toContain("ssh -fMN");
    expect(commands.login_command).toContain('-S "$CTL"');
    expect(commands.login_command).toContain("-o ControlMaster=yes");
    expect(commands.login_command).toContain('-o ControlPath="$CTL"');
    expect(commands.login_command).toContain("-o ControlPersist=4h");
    expect(commands.login_command).not.toContain("pkill -f");
    expect(commands.login_command).toContain('ssh -S "$CTL" -O check "$HOST" >/dev/null 2>&1');
    expect(commands.login_command).toContain("An active FluorCast NIBI session already exists.");
    expect(commands.login_command.indexOf('ssh -S "$CTL" -O check "$HOST"'))
      .toBeLessThan(commands.login_command.indexOf('rm -f "$CTL"'));
  });

  it("generates WSL check, test, and end commands", () => {
    const commands = buildManualMfaSessionCommands(settings);

    expect(commands.check_command).toBe('wsl.exe -d "Ubuntu" -- bash -s -- "alice@nibi.alliancecan.ca"');
    expect(commands.check_script_content).toContain('ssh -S "$CTL" -O check "$HOST"');
    expect(commands.test_command).toContain('printf \'FLUORCAST_AUTH_OK\\n\'');
    expect(commands.test_command).not.toContain("KEY=");
    expect(commands.end_command).toBe("bash $HOME/.fluorcast/scripts/end-nibi-session.sh");
    expect(commands.end_script_content).toContain('ssh -S "$CTL" -O exit "$HOST"');
  });

  it("generates terminal launch commands with configured distro", () => {
    const commands = buildManualMfaSessionCommands(settings);

    expect(commands.windows_terminal_command).toContain("wt.exe new-tab");
    expect(commands.windows_terminal_command).toContain("wsl.exe -d \"Ubuntu\" -- bash --");
    expect(commands.windows_terminal_command).toContain("start-nibi-login.sh");
    expect(commands.windows_terminal_command).toContain("alice@nibi.alliancecan.ca");
    expect(commands.windows_terminal_command).toContain("<wsl_private_key_path>");
    expect(commands.windows_terminal_command).not.toContain("bash -c");
    expect(commands.windows_terminal_command).not.toContain("$@");
    expect(commands.windows_terminal_command).not.toContain("An active FluorCast NIBI session already exists.");
    expect(commands.windows_terminal_command).not.toContain("ssh -fMN");
    expect(commands.powershell_launch_command).toContain("PowerShell fallback is disabled");
    expect(commands.powershell_launch_command).not.toContain("An active FluorCast NIBI session already exists.");
    expect(commands.powershell_launch_command).not.toContain("ssh -fMN");
  });

  it("generates stale socket cleanup command", () => {
    const commands = buildManualMfaSessionCommands(settings);

    expect(commands.clean_script_content).not.toContain("pkill -f");
    expect(commands.clean_stale_session_command).toBe("bash $HOME/.fluorcast/scripts/clean-nibi-session.sh");
    expect(commands.clean_script_content).toContain('ssh -S "$CTL" -O exit "$HOST" >/dev/null 2>&1 || true');
    expect(commands.clean_script_content).toContain('rm -f "$CTL"');
    expect(commands.clean_script_content).toContain('mkdir -p "$HOME/.fluorcast/ssh"');
    expect(commands.clean_script_content).toContain('CLEAN_RESULT=HEALTHY_SESSION_CLOSED');
    expect(commands.clean_script_content).toContain('CLEAN_RESULT=STALE_SOCKET_REMOVED');
  });

  it("passes configurable values as positional arguments in generated scripts", () => {
    const commands = buildManualMfaSessionCommands(settings);

    expect(commands.login_command).toContain('HOST="$1"');
    expect(commands.login_command).toContain('KEY="$2"');
    expect(commands.check_script_content).toContain('HOST="$1"');
    expect(commands.clean_script_content).toContain('HOST="$1"');
    expect(commands.login_command).not.toContain("alice@nibi.alliancecan.ca");
    expect(commands.test_command).not.toContain("/home/alice/.ssh/fluorcast_nibi_ed25519");
  });

  it("background remote command uses BatchMode=yes", () => {
    expect(buildWslBackgroundCommand(settings, "hostname")).toContain(
      'ssh -S "$CTL" -o ControlMaster=no -o BatchMode=yes -o PasswordAuthentication=no -o KbdInteractiveAuthentication=no "$HOST" "$REMOTE_COMMAND"',
    );
  });

  it("maps password and Duo prompts to authentication required", () => {
    expect(isInteractiveAuthenticationOutput("alice@nibi.alliancecan.ca's password:")).toBe(true);
    expect(isInteractiveAuthenticationOutput("Duo two-factor login. Passcode:")).toBe(true);
    expect(isInteractiveAuthenticationOutput("keyboard-interactive verification required")).toBe(true);

    expect(classifyManualMfaSessionTest({
      exit_code: 255,
      stdout: "",
      stderr: "Duo two-factor login. Passcode:",
      control_path_exists: true,
    })).toMatchObject({
      status: "session_not_reused",
      can_run_background_commands: false,
    });
  });

  it("maps FLUORCAST_AUTH_OK to authenticated", () => {
    expect(classifyManualMfaSessionTest({
      exit_code: 0,
      stdout: "FLUORCAST_AUTH_OK",
      stderr: "",
      control_path_exists: true,
    })).toMatchObject({
      status: "authenticated",
      can_run_background_commands: true,
    });
  });

  it("maps connection refused to session inactive", () => {
    expect(mapManualMfaSessionError("Control socket connect failed: Connection refused"))
      .toBe("FluorCast did not find the reusable SSH session. Start login from FluorCast and keep the session alive.");
    expect(classifyManualMfaSessionTest({
      exit_code: 255,
      stdout: "",
      stderr: "No such file or directory",
      control_path_exists: false,
    })).toMatchObject({
      status: "session_not_found",
    });
  });

  it("maps ControlMaster and permission failures to specific causes", () => {
    expect(classifyManualMfaSessionTest({
      exit_code: 255,
      stdout: "",
      stderr: "Bad configuration option: controlmaster",
      control_path_exists: true,
    })).toMatchObject({
      status: "controlmaster_unsupported",
    });
    expect(classifyManualMfaSessionTest({
      exit_code: 255,
      stdout: "",
      stderr: "Permission denied (publickey)",
      control_path_exists: true,
    })).toMatchObject({
      status: "permission_denied",
    });
  });

  it("maps terminal exit code 15 to terminal-exited-before-authentication guidance", () => {
    expect(mapManualMfaSessionError("[process exited with code 15 (0x0000000f)]"))
      .toBe("The login terminal exited before authentication. The start script may have terminated itself. Try again after cleaning stale session.");
  });

  it("maps Windows terminal command-not-found to manual WSL fallback guidance", () => {
    expect(mapManualMfaSessionError("error 2147942402 (0x80070002)"))
      .toBe("Windows could not find the terminal command to launch. Use the manual WSL command below.");
  });
});
