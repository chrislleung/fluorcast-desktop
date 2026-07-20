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
  wsl_ssh_private_key_path: "$HOME/.ssh/fluorcast_nibi_ed25519",
  wsl_control_socket_path: "$HOME/.fluorcast/ssh/cm-alice-nibi.sock",
  manual_mfa_wsl_distro: "Ubuntu",
};

describe("manual MFA session helpers", () => {
  it("selects WSL by default and generates the -fMN start command", () => {
    const commands = buildManualMfaSessionCommands(settings);

    expect(commands.backend).toBe("wsl");
    expect(commands.start_script_path).toBe("$HOME/.fluorcast/scripts/start-nibi-login.sh");
    expect(commands.start_script_path.startsWith("$HOME/.fluorcast/scripts/")).toBe(true);
    expect(commands.login_command).toContain("ctl=\"$HOME/.fluorcast/ssh/cm-alice-nibi.sock\"");
    expect(commands.login_command).toContain("key=\"$HOME/.ssh/fluorcast_nibi_ed25519\"");
    expect(commands.login_command).toContain("host=\"alice@nibi.alliancecan.ca\"");
    expect(commands.login_command).toContain("ssh -fMN");
    expect(commands.login_command).toContain('-S "$ctl"');
    expect(commands.login_command).toContain("-o ControlMaster=yes");
    expect(commands.login_command).toContain('-o ControlPath="$ctl"');
    expect(commands.login_command).toContain("-o ControlPersist=4h");
    expect(commands.login_command).not.toContain("pkill -f");
    expect(commands.login_command).toContain('ssh -S "$ctl" -O check "$host" >/dev/null 2>&1');
    expect(commands.login_command).toContain("An active FluorCast NIBI session already exists.");
    expect(commands.login_command.indexOf('ssh -S "$ctl" -O check "$host"'))
      .toBeLessThan(commands.login_command.indexOf('rm -f "$ctl"'));
  });

  it("generates WSL check, test, and end commands", () => {
    const commands = buildManualMfaSessionCommands(settings);

    expect(commands.check_command).toBe("bash $HOME/.fluorcast/scripts/check-nibi-session.sh");
    expect(commands.check_script_content).toContain('ssh -S "$ctl" -O check "$host"');
    expect(commands.test_command).toContain('ssh -S "$ctl" -o BatchMode=yes "$host" "echo FLUORCAST_AUTH_OK"');
    expect(commands.end_command).toBe("bash $HOME/.fluorcast/scripts/end-nibi-session.sh");
    expect(commands.end_script_content).toContain('ssh -S "$ctl" -O exit "$host"');
  });

  it("generates terminal launch commands with configured distro", () => {
    const commands = buildManualMfaSessionCommands(settings);

    expect(commands.windows_terminal_command).toContain("wt.exe new-tab");
    expect(commands.windows_terminal_command).toContain("wsl.exe -d \"Ubuntu\" -- bash -lc \"bash $HOME/.fluorcast/scripts/start-nibi-login.sh\"");
    expect(commands.windows_terminal_command).not.toContain("An active FluorCast NIBI session already exists.");
    expect(commands.windows_terminal_command).not.toContain("ssh -fMN");
    expect(commands.powershell_launch_command).toContain("powershell.exe -NoProfile");
    expect(commands.powershell_launch_command).toContain("Start-Process powershell.exe");
    expect(commands.powershell_launch_command).toContain("wsl.exe -d \"Ubuntu\" -- bash -lc \"bash $HOME/.fluorcast/scripts/start-nibi-login.sh\"");
    expect(commands.powershell_launch_command).not.toContain("An active FluorCast NIBI session already exists.");
    expect(commands.powershell_launch_command).not.toContain("ssh -fMN");
    expect(commands.powershell_launch_command).toContain("-NoExit");
  });

  it("generates stale socket cleanup command", () => {
    const commands = buildManualMfaSessionCommands(settings);

    expect(commands.clean_script_content).not.toContain("pkill -f");
    expect(commands.clean_stale_session_command).toBe("bash $HOME/.fluorcast/scripts/clean-nibi-session.sh");
    expect(commands.clean_script_content).toContain('ssh -S "$ctl" -O exit "$host" 2>/dev/null || true');
    expect(commands.clean_script_content).toContain('rm -f "$ctl"');
    expect(commands.clean_script_content).toContain('mkdir -p "$HOME/.fluorcast/ssh"');
  });

  it("defines ctl key and host inside every copied debug command block", () => {
    const commands = buildManualMfaSessionCommands(settings);

    for (const command of [
      commands.login_command,
      commands.test_command,
      commands.clean_script_content,
      commands.check_script_content,
      commands.end_script_content,
    ]) {
      expect(command).toContain("ctl=");
      expect(command).toContain("key=");
      expect(command).toContain("host=");
    }
  });

  it("background remote command uses BatchMode=yes", () => {
    expect(buildWslBackgroundCommand(settings, "hostname")).toContain(
      'ssh -S "$ctl" -o BatchMode=yes "$host" "hostname"',
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
