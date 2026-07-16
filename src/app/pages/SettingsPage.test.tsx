import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultNibiSettings } from "../../features/settings";
import { SettingsPage } from "./SettingsPage";

const dialogMock = vi.hoisted(() => ({
  open: vi.fn(),
}));

const pathMock = vi.hoisted(() => ({
  homeDir: vi.fn(),
  join: vi.fn(),
}));

const coreMock = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => dialogMock);
vi.mock("@tauri-apps/api/path", () => pathMock);
vi.mock("@tauri-apps/api/core", () => coreMock);

describe("SettingsPage", () => {
  beforeEach(() => {
    dialogMock.open.mockReset();
    pathMock.homeDir.mockReset();
    pathMock.join.mockReset();
    coreMock.invoke.mockReset();
    Object.assign(navigator, {
      clipboard: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    });
  });

  it("updates the SSH key path when a file is selected from Browse", async () => {
    dialogMock.open.mockResolvedValue("C:\\Users\\CL\\.ssh\\fluorcast_nibi_ed25519");
    pathMock.homeDir.mockResolvedValue("C:\\Users\\CL");
    pathMock.join.mockResolvedValue("C:\\Users\\CL\\.ssh");

    render(
      <SettingsPage
        accentColor="#8ab4ff"
        nibiSettings={defaultNibiSettings}
        secondaryColor="#8ee6c8"
        onAccentColorChange={vi.fn()}
        onNibiSettingsSave={vi.fn().mockResolvedValue(true)}
        onSecondaryColorChange={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Browse..." }));

    expect(await screen.findByDisplayValue("C:\\Users\\CL\\.ssh\\fluorcast_nibi_ed25519"))
      .toBeInTheDocument();
    expect(dialogMock.open).toHaveBeenCalledWith({
      title: "Choose your private SSH key",
      multiple: false,
      directory: false,
      defaultPath: "C:\\Users\\CL\\.ssh",
    });
  });

  it("renders Alliance public key upload instructions near the SSH key field", () => {
    render(
      <SettingsPage
        accentColor="#8ab4ff"
        nibiSettings={defaultNibiSettings}
        secondaryColor="#8ee6c8"
        onAccentColorChange={vi.fn()}
        onNibiSettingsSave={vi.fn().mockResolvedValue(true)}
        onSecondaryColorChange={vi.fn()}
      />,
    );

    expect(screen.getByText("How to upload your SSH public key to Alliance/CCDB"))
      .toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open Alliance Manage SSH Keys" }))
      .toHaveAttribute("href", "https://ccdb.alliancecan.ca/ssh_authorized_keys");
    expect(screen.getByText(/Do not paste your private key into Alliance\/CCDB/))
      .toBeInTheDocument();
    expect(screen.getByText(/FluorCast uses the private key path on your computer/))
      .toBeInTheDocument();
    expect(screen.getByText(/Alliance\/CCDB needs the public key text pasted into the Manage SSH Keys page/))
      .toBeInTheDocument();
  });

  it("explains what to do if no terminal appears for Manual MFA login", () => {
    render(
      <SettingsPage
        accentColor="#8ab4ff"
        nibiSettings={defaultNibiSettings}
        secondaryColor="#8ee6c8"
        onAccentColorChange={vi.fn()}
        onNibiSettingsSave={vi.fn().mockResolvedValue(true)}
        onSecondaryColorChange={vi.fn()}
      />,
    );

    expect(screen.getByText(/If no terminal window appears, copy the Raw WSL login command/))
      .toBeInTheDocument();
  });

  it("renders copyable PowerShell commands for public key upload", () => {
    render(
      <SettingsPage
        accentColor="#8ab4ff"
        nibiSettings={defaultNibiSettings}
        secondaryColor="#8ee6c8"
        onAccentColorChange={vi.fn()}
        onNibiSettingsSave={vi.fn().mockResolvedValue(true)}
        onSecondaryColorChange={vi.fn()}
      />,
    );

    expect(screen.getAllByText("dir $env:USERPROFILE\\.ssh").length).toBeGreaterThan(0);
    expect(screen.getByText("Get-Content \"$env:USERPROFILE\\.ssh\\id_ed25519.pub\""))
      .toBeInTheDocument();
    expect(screen.getByText("Get-Content \"$env:USERPROFILE\\.ssh\\id_ed25519.pub\" | Set-Clipboard"))
      .toBeInTheDocument();
    expect(screen.getByText("ssh-keygen -y -f \"$env:USERPROFILE\\.ssh\\id_ed25519\" | Set-Content \"$env:USERPROFILE\\.ssh\\id_ed25519.pub\""))
      .toBeInTheDocument();
    expect(screen.getByText("ssh -i \"$env:USERPROFILE\\.ssh\\id_ed25519\" -o IdentitiesOnly=yes <your_alliance_username>@nibi.alliancecan.ca"))
      .toBeInTheDocument();
    expect(screen.getByText("Get-Content \"$env:USERPROFILE\\.ssh\\fluorcast_nibi_ed25519.pub\" | Set-Clipboard"))
      .toBeInTheDocument();
  });

  it("keeps appearance collapsed by default and expands color controls on request", () => {
    const { container } = render(
      <SettingsPage
        accentColor="#8ab4ff"
        nibiSettings={defaultNibiSettings}
        secondaryColor="#8ee6c8"
        onAccentColorChange={vi.fn()}
        onNibiSettingsSave={vi.fn().mockResolvedValue(true)}
        onSecondaryColorChange={vi.fn()}
      />,
    );

    const appearancePanel = container.querySelector(".appearance-panel") as HTMLDetailsElement;
    expect(appearancePanel.open).toBe(false);

    fireEvent.click(screen.getByText("Appearance"));

    expect(appearancePanel.open).toBe(true);
    expect(screen.getByRole("button", { name: "Rose accent" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Amber secondary" })).toBeInTheDocument();
  });

  it("runs the NIBI connection test with current settings and shows checklist results", async () => {
    coreMock.invoke.mockResolvedValue([
      {
        id: "ssh_automation",
        label: "Non-interactive SSH automation test",
        status: "passed",
        message: "Passed: fluorcast-nibi-ok",
      },
      {
        id: "sbatch",
        label: "sbatch command exists",
        status: "failed",
        message: "Command exited with status 1.",
      },
    ]);

    render(
      <SettingsPage
        accentColor="#8ab4ff"
        nibiSettings={{
          ...defaultNibiSettings,
          connection_mode: "robot_automation",
          nibi_username: "alice",
          ssh_private_key_path: "C:\\Users\\Alice\\.ssh\\fluorcast_nibi_ed25519",
          remote_project_path: "/home/alice/scratch/FluorCast",
          remote_jobs_path: "/home/alice/scratch/fluorcast-jobs",
          python_environment_path: "/home/alice/scratch/FluorCast/.venv/bin/python",
        }}
        secondaryColor="#8ee6c8"
        onAccentColorChange={vi.fn()}
        onNibiSettingsSave={vi.fn().mockResolvedValue(true)}
        onSecondaryColorChange={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Test NIBI Connection" }));

    expect(await screen.findByText("Non-interactive SSH automation test")).toBeInTheDocument();
    expect(screen.getByText("sbatch command exists")).toBeInTheDocument();
    expect(screen.getByText("1 NIBI connection check failed.")).toBeInTheDocument();
    expect(coreMock.invoke).toHaveBeenCalledWith("test_nibi_connection", {
      settings: expect.objectContaining({
        nibi_username: "alice",
        ssh_key_path: "C:\\Users\\Alice\\.ssh\\fluorcast_nibi_ed25519",
        ssh_private_key_path: "C:\\Users\\Alice\\.ssh\\fluorcast_nibi_ed25519",
        remote_project_path: "/home/alice/scratch/FluorCast",
      }),
    });
  });

  it("shows the interactive login required message from the automation test", async () => {
    coreMock.invoke.mockResolvedValue([
      {
        id: "ssh_automation",
        label: "Non-interactive SSH automation test",
        status: "interactive_login_required",
        message:
          "NIBI is asking for interactive password/Duo authentication. This confirms the app reached NIBI, but a hidden background command cannot complete the login. First test the manual PowerShell SSH command. For automatic job submission, FluorCast will need an automation-compatible SSH setup.",
      },
      {
        id: "remote_project_path",
        label: "Remote project path exists",
        status: "skipped",
        message: "Skipped because non-interactive SSH automation did not pass.",
      },
    ]);

    render(
      <SettingsPage
        accentColor="#8ab4ff"
        nibiSettings={{
          ...defaultNibiSettings,
          connection_mode: "robot_automation",
          nibi_username: "alice",
          ssh_private_key_path: "C:\\Users\\Alice\\.ssh\\fluorcast_nibi_ed25519",
          remote_project_path: "/home/alice/scratch/FluorCast",
          remote_jobs_path: "/home/alice/scratch/fluorcast-jobs",
          python_environment_path: "/home/alice/scratch/FluorCast/.venv/bin/python",
        }}
        secondaryColor="#8ee6c8"
        onAccentColorChange={vi.fn()}
        onNibiSettingsSave={vi.fn().mockResolvedValue(true)}
        onSecondaryColorChange={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Test NIBI Connection" }));

    expect(await screen.findByText(/NIBI is asking for interactive password\/Duo authentication/))
      .toBeInTheDocument();
    expect(screen.getByText("NIBI is asking for interactive login. Manual SSH may work, but app automation is not ready yet."))
      .toBeInTheDocument();
    expect(screen.getByText("Remote project path exists")).toBeInTheDocument();
  });

  it("copies the manual SSH command and saves manual login confirmation", async () => {
    const save = vi.fn().mockResolvedValue(true);
    render(
      <SettingsPage
        accentColor="#8ab4ff"
        nibiSettings={{
          ...defaultNibiSettings,
          nibi_username: "alice",
          ssh_private_key_path: "C:\\Users\\Alice\\.ssh\\id_ed25519",
        }}
        secondaryColor="#8ee6c8"
        onAccentColorChange={vi.fn()}
        onNibiSettingsSave={save}
        onSecondaryColorChange={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Copy manual SSH command" }));

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      "ssh -i \"C:\\Users\\Alice\\.ssh\\id_ed25519\" alice@nibi.alliancecan.ca",
    );
    expect(await screen.findByText("Manual SSH command copied.")).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("Manual SSH login works in PowerShell"));
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));

    expect(save).toHaveBeenCalledWith(expect.objectContaining({
      manual_login_verified: true,
    }));
  });

  it("opens PowerShell login through the backend command", async () => {
    coreMock.invoke.mockResolvedValue(undefined);

    render(
      <SettingsPage
        accentColor="#8ab4ff"
        nibiSettings={{
          ...defaultNibiSettings,
          nibi_username: "alice",
          ssh_private_key_path: "C:\\Users\\Alice\\.ssh\\id_ed25519",
        }}
        secondaryColor="#8ee6c8"
        onAccentColorChange={vi.fn()}
        onNibiSettingsSave={vi.fn().mockResolvedValue(true)}
        onSecondaryColorChange={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open PowerShell login" }));

    expect(coreMock.invoke).toHaveBeenCalledWith("open_powershell_login", {
      settings: expect.objectContaining({
        nibi_username: "alice",
        ssh_key_path: "C:\\Users\\Alice\\.ssh\\id_ed25519",
      }),
    });
    expect(await screen.findByText("PowerShell opened for manual SSH login.")).toBeInTheDocument();
  });

  it("marks terminal launch as waiting for user MFA, not authenticated", async () => {
    const onManualMfaSessionChange = vi.fn();
    coreMock.invoke.mockResolvedValue({
      launched: true,
      method: "windows_terminal",
      message: "Windows Terminal opened. Complete password/Duo there, then click Test authenticated session.",
      error_message: "",
      timestamp: "2026-07-16T10:00:00.000Z",
      command_preview: "wt.exe new-tab --title \"FluorCast NIBI Login\" wsl.exe -d 'Ubuntu' -- bash -lc 'bash $HOME/.fluorcast/scripts/start-nibi-login.sh'",
      generated_script_path: "$HOME/.fluorcast/scripts/start-nibi-login.sh",
      script_file_exists: true,
      launch_method_attempted: "windows_terminal",
      launch_error_code: "",
      manual_wsl_command: "bash $HOME/.fluorcast/scripts/start-nibi-login.sh",
      windows_terminal_available: true,
      powershell_available: true,
      wsl_available: true,
      distro_available: true,
      commands: {
        backend: "wsl",
        control_path: "$HOME/.fluorcast/ssh/cm-alice-nibi.sock",
        control_path_exists: false,
        control_socket_filename: "cm-alice-nibi.sock",
        script_dir: "$HOME/.fluorcast/scripts",
        start_script_path: "$HOME/.fluorcast/scripts/start-nibi-login.sh",
        check_script_path: "$HOME/.fluorcast/scripts/check-nibi-session.sh",
        end_script_path: "$HOME/.fluorcast/scripts/end-nibi-session.sh",
        clean_script_path: "$HOME/.fluorcast/scripts/clean-nibi-session.sh",
        wsl_distro: "Ubuntu",
        wsl_key_path: "$HOME/.ssh/fluorcast_nibi_ed25519",
        host: "alice@nibi.alliancecan.ca",
        wsl_setup_key_commands: "",
        clean_stale_session_command: "",
        windows_terminal_command: "",
        powershell_launch_command: "",
        login_command: "",
        clean_script_content: "",
        check_script_content: "",
        end_script_content: "",
        check_command: "",
        test_command: "",
        end_command: "",
        background_command_template: "",
        manual_wsl_login_command: "bash $HOME/.fluorcast/scripts/start-nibi-login.sh",
        redacted_login_command_preview: "redacted login",
        redacted_test_command_preview: "",
        redacted_end_command_preview: "",
      },
    });

    render(
      <SettingsPage
        accentColor="#8ab4ff"
        nibiSettings={{
          ...defaultNibiSettings,
          connection_mode: "interactive_mfa",
          nibi_username: "alice",
          ssh_private_key_path: "C:\\Users\\Alice\\.ssh\\id_ed25519",
        }}
        secondaryColor="#8ee6c8"
        onAccentColorChange={vi.fn()}
        onManualMfaSessionChange={onManualMfaSessionChange}
        onNibiSettingsSave={vi.fn().mockResolvedValue(true)}
        onSecondaryColorChange={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Start manual NIBI login" }));

    expect(await screen.findByText("Windows Terminal opened. Complete password/Duo there, then click Test authenticated session."))
      .toBeInTheDocument();
    expect(onManualMfaSessionChange).toHaveBeenCalledWith(expect.objectContaining({
      status: "waiting_for_user_mfa",
      can_run_background_commands: false,
      last_terminal_launch_success: true,
      last_generated_script_path: "$HOME/.fluorcast/scripts/start-nibi-login.sh",
      last_launch_method_attempted: "windows_terminal",
      last_script_file_exists: true,
    }));
  });

  it("only Test authenticated session can mark Manual MFA authenticated", async () => {
    const onManualMfaSessionChange = vi.fn();
    const save = vi.fn().mockResolvedValue(true);
    coreMock.invoke
      .mockResolvedValueOnce({
        status: "authenticated",
        message: "Unexpected authenticated cleanup result.",
        control_path: "$HOME/.fluorcast/ssh/cm-alice-nibi.sock",
        control_path_exists: true,
        redacted_command_preview: "",
        can_run_background_commands: true,
        last_master_check_result: "",
        last_auth_ok_result: "FLUORCAST_AUTH_OK",
        selected_backend: "wsl",
        wsl_available: true,
        wsl_ssh_available: true,
      })
      .mockResolvedValueOnce({
        status: "authenticated",
        message: "Manual NIBI login is authenticated and background commands can reuse the session.",
        control_path: "$HOME/.fluorcast/ssh/cm-alice-nibi.sock",
        control_path_exists: true,
        redacted_command_preview: "",
        can_run_background_commands: true,
        last_master_check_result: "Master running",
        last_auth_ok_result: "FLUORCAST_AUTH_OK",
        selected_backend: "wsl",
        wsl_available: true,
        wsl_ssh_available: true,
      });

    render(
      <SettingsPage
        accentColor="#8ab4ff"
        nibiSettings={{
          ...defaultNibiSettings,
          connection_mode: "interactive_mfa",
          nibi_username: "alice",
          ssh_private_key_path: "C:\\Users\\Alice\\.ssh\\id_ed25519",
        }}
        secondaryColor="#8ee6c8"
        onAccentColorChange={vi.fn()}
        onManualMfaSessionChange={onManualMfaSessionChange}
        onNibiSettingsSave={save}
        onSecondaryColorChange={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Clean stale WSL session" }));

    expect(await screen.findByText("Unexpected authenticated cleanup result.")).toBeInTheDocument();
    expect(onManualMfaSessionChange).toHaveBeenLastCalledWith(expect.objectContaining({
      status: "login_required",
      can_run_background_commands: false,
    }));
    expect(save).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Test authenticated session" }));

    expect(await screen.findByText("Manual NIBI login is authenticated and background commands can reuse the session."))
      .toBeInTheDocument();
    expect(onManualMfaSessionChange).toHaveBeenLastCalledWith(expect.objectContaining({
      status: "authenticated",
      can_run_background_commands: true,
    }));
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ manual_login_verified: true }));
  });

  it("validates required NIBI fields before running the connection test", () => {
    render(
      <SettingsPage
        accentColor="#8ab4ff"
        nibiSettings={{
          ...defaultNibiSettings,
          connection_mode: "robot_automation",
          nibi_username: "",
          ssh_private_key_path: "",
        }}
        secondaryColor="#8ee6c8"
        onAccentColorChange={vi.fn()}
        onNibiSettingsSave={vi.fn().mockResolvedValue(true)}
        onSecondaryColorChange={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Test NIBI Connection" }));

    expect(screen.getByText("Username is required for NIBI mode.")).toBeInTheDocument();
    expect(screen.getByText("SSH key path is required for robot automation mode.")).toBeInTheDocument();
    expect(screen.getByText("Fix the highlighted NIBI settings before testing.")).toBeInTheDocument();
    expect(coreMock.invoke).not.toHaveBeenCalled();
  });
});
