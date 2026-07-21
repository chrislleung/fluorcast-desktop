import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultNibiSettings, type ConnectionMode, type NibiSettings } from "../../features/settings";
import { defaultManualMfaSessionState } from "../../lib/remote";
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

function renderSettings(
  settings: Partial<NibiSettings> = {},
  props: Partial<ComponentProps<typeof SettingsPage>> = {},
) {
  return render(
    <SettingsPage
      accentColor="#8ab4ff"
      nibiSettings={{
        ...defaultNibiSettings,
        ...settings,
      }}
      secondaryColor="#8ee6c8"
      onAccentColorChange={vi.fn()}
      onNibiSettingsSave={vi.fn().mockResolvedValue(true)}
      onSecondaryColorChange={vi.fn()}
      {...props}
    />,
  );
}

function renderMode(mode: ConnectionMode, settings: Partial<NibiSettings> = {}) {
  return renderSettings({ connection_mode: mode, ...settings });
}

function expandRemoteEnvironmentChecks() {
  fireEvent.click(screen.getByRole("button", { name: /Remote Environment Checks/ }));
}

function buildLaunchCommandsFixture() {
  return {
    backend: "wsl",
    control_path: "$HOME/.fluorcast/ssh/cm-nibi.sock",
    control_path_exists: false,
    control_socket_filename: "cm-nibi.sock",
    script_dir: "$HOME/.fluorcast/scripts",
    start_script_path: "$HOME/.fluorcast/scripts/start-nibi-login.sh",
    check_script_path: "$HOME/.fluorcast/scripts/check-nibi-session.sh",
    end_script_path: "$HOME/.fluorcast/scripts/end-nibi-session.sh",
    clean_script_path: "$HOME/.fluorcast/scripts/clean-nibi-session.sh",
    wsl_distro: "Ubuntu",
    wsl_key_path: "/home/alice/.ssh/fluorcast_nibi_ed25519",
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
    manual_wsl_login_command: "",
    redacted_login_command_preview: "redacted login",
    redacted_test_command_preview: "redacted test",
    redacted_end_command_preview: "redacted end",
  };
}

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

  it("renders a persistent Connection Mode section with mode descriptions and status", () => {
    renderMode("mock");

    expect(screen.getByRole("heading", { name: "Connection Mode" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Mock mode/ })).toBeChecked();
    expect(screen.getByText("Use local mock predictions for UI testing. No NIBI connection required."))
      .toBeInTheDocument();
    expect(screen.getByText(/Log into nibi\.alliancecan\.ca with password and Duo/))
      .toBeInTheDocument();
    expect(screen.getByText(/Use robot\.nibi\.alliancecan\.ca with a restricted SSH key/))
      .toBeInTheDocument();
    expect(screen.getByText("Mock mode is active. Predictions are simulated locally."))
      .toBeInTheDocument();
  });

  it("mock mode hides NIBI, SSH, robot, manual, and remote path settings", () => {
    renderMode("mock");

    expect(screen.getByText(/Mock mode uses local mock predictions/)).toBeInTheDocument();
    expect(screen.getByLabelText("Default model choice")).toBeInTheDocument();
    expect(screen.queryByLabelText("NIBI username")).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Private SSH key file/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Robot login host")).not.toBeInTheDocument();
    expect(screen.queryByText("Manual MFA Login")).not.toBeInTheDocument();
    expect(screen.queryByText("Robot Automation")).not.toBeInTheDocument();
    expect(screen.queryByText("Remote FluorCast paths")).not.toBeInTheDocument();
    expect(screen.queryByText("Remote Environment Checks")).not.toBeInTheDocument();
  });

  it("shows the Settings-only NIBI Session actions in Manual MFA mode", () => {
    renderMode("interactive_mfa");

    expect(screen.getByRole("heading", { name: "NIBI Session" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Clean stale WSL session" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start NIBI session" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Test authenticated session" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Run remote environment checks" })).toBeDisabled();
    expect(screen.getByText("Log into NIBI first before running remote environment checks."))
      .toBeInTheDocument();
    expect(screen.queryByText("Remote Environment Checks")).not.toBeInTheDocument();
  });

  it("keeps generated scripts hidden in collapsed diagnostics by default", () => {
    renderMode("interactive_mfa");

    const diagnostics = screen.getByTestId("advanced-session-diagnostics") as HTMLDetailsElement;

    expect(diagnostics.open).toBe(false);
    expect(within(diagnostics).getByText("Generated login script")).toBeInTheDocument();
  });

  it("section is collapsed by default in robot_automation mode and shows status summary", () => {
    renderMode("robot_automation", {
      nibi_username: "alice",
      ssh_private_key_path: "C:\\Users\\Alice\\.ssh\\fluorcast_robot",
      robot_access_verified: false,
    });

    expect(screen.getByText("Remote Environment Checks")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Remote Environment Checks/ }))
      .toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("Verify robot automation before running remote environment checks."))
      .toBeInTheDocument();
    expect(screen.getByText("Robot not verified")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Run remote environment checks" })).not.toBeInTheDocument();
  });

  it("expanding reveals disabled robot_automation message and Run button", () => {
    renderMode("robot_automation", {
      nibi_username: "alice",
      ssh_private_key_path: "C:\\Users\\Alice\\.ssh\\fluorcast_robot",
      robot_access_verified: false,
    });

    expandRemoteEnvironmentChecks();

    expect(screen.getAllByText("Verify robot automation before running remote environment checks.").length)
      .toBeGreaterThan(1);
    expect(screen.getByRole("button", { name: "Run remote environment checks" })).toBeDisabled();
  });

  it("enables Remote Environment Checks in robot_automation after robot verified", () => {
    renderMode("robot_automation", {
      nibi_username: "alice",
      ssh_private_key_path: "C:\\Users\\Alice\\.ssh\\fluorcast_robot",
      robot_access_verified: true,
    });

    expect(screen.getByText("Remote Environment Checks")).toBeInTheDocument();
    expect(screen.getByText("Not run yet")).toBeInTheDocument();
    expandRemoteEnvironmentChecks();
    expect(screen.queryByText("Verify robot automation before running remote environment checks."))
      .not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Run remote environment checks" })).toBeEnabled();
  });

  it("runs manual environment checks after authenticated session readiness", async () => {
    coreMock.invoke.mockImplementation(async (command, payload) => {
      if (command === "test_manual_mfa_session") {
        return {
          status: "authenticated",
          message: "Authenticated WSL NIBI session is ready.\nFLUORCAST_AUTH_OK",
          control_path: "/home/alice/.fluorcast/ssh/cm-nibi.sock",
          control_path_exists: true,
          redacted_command_preview: "wsl.exe -d <distribution> -- bash -s -- <host>",
          can_run_background_commands: true,
          last_master_check_result: "MASTER_RUNNING=1",
          last_auth_ok_result: "FLUORCAST_AUTH_OK",
          last_session_test_stdout: "WSL_DISTRO=Ubuntu\nWSL_USER=alice\nWSL_HOME=/home/alice\nCONTROL_PATH=/home/alice/.fluorcast/ssh/cm-nibi.sock\nFLUORCAST_AUTH_OK",
          last_session_test_stderr: "",
          last_session_test_exit_code: 0,
          parsed_session_status: "authenticated",
          selected_backend: "wsl",
          wsl_available: true,
          wsl_ssh_available: true,
        };
      }
      return {
        exit_code: payload.commandSpec.args?.includes("sacct") ? 1 : 0,
        stdout: payload.commandSpec.args?.includes("sacct") ? "" : "ok",
        stderr: payload.commandSpec.args?.includes("sacct") ? "sacct missing" : "",
        duration_ms: 10,
        command_label: payload.commandSpec.label,
        redacted_command_preview: payload.commandSpec.redacted_preview,
      };
    });

    renderSettings({
      connection_mode: "interactive_mfa",
      nibi_username: "alice",
    }, {
      manualMfaSession: {
        ...defaultManualMfaSessionState,
        status: "authenticated",
        can_run_background_commands: true,
      },
    });

    fireEvent.click(screen.getByRole("button", { name: "Run remote environment checks" }));

    expect(await screen.findByText("Remote environment needs attention"))
      .toBeInTheDocument();
    expect(screen.getByText("sacct is unavailable."))
      .toBeInTheDocument();
    expect(screen.getAllByText("failed").length).toBeGreaterThan(0);
    expect(coreMock.invoke).toHaveBeenNthCalledWith(1, "test_manual_mfa_session", expect.any(Object));
  });

  it("interactive_mfa shows manual login controls and hides robot-only controls", () => {
    renderMode("interactive_mfa");

    expect(screen.getByLabelText("NIBI username")).toBeInTheDocument();
    expect(screen.getByLabelText("Normal login host")).toHaveValue("nibi.alliancecan.ca");
    expect(screen.getByLabelText(/WSL private key path/)).toBeInTheDocument();
    expect(screen.getByText("/home/cl/.ssh/fluorcast_nibi_ed25519")).toBeInTheDocument();
    expect(screen.getByText("NIBI Session")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Clean stale WSL session" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start NIBI session" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Test authenticated session" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "End NIBI session" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Robot login host")).not.toBeInTheDocument();
    expect(screen.queryByText("Restricted public key preview")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Copy Alliance support request" })).not.toBeInTheDocument();
  });

  it("robot_automation shows robot controls and hides manual login controls", () => {
    renderMode("robot_automation");

    expect(screen.getByLabelText("NIBI username")).toBeInTheDocument();
    expect(screen.getByLabelText("Robot login host")).toHaveValue("robot.nibi.alliancecan.ca");
    expect(screen.getByLabelText("Robot key from= restriction")).toHaveValue("134.153.150.*");
    expect(screen.getByLabelText("Robot forced command")).toHaveValue(
      "/cvmfs/soft.computecanada.ca/custom/bin/computecanada/allowed_commands/allowed_commands.sh",
    );
    expect(screen.getByText("Restricted public key preview")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy restricted public key" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy Alliance support request" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Test robot automation" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Normal login host")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Start NIBI session" })).not.toBeInTheDocument();
    expect(screen.queryByText("Manual MFA Login")).not.toBeInTheDocument();
  });

  it("shows NIBI Session buttons in the requested order", () => {
    renderMode("interactive_mfa", {
      manual_mfa_provider: "controlmaster",
    });

    const buttons = within(screen.getByRole("heading", { name: "NIBI Session" }).closest("section")!)
      .getAllByRole("button")
      .slice(0, 4)
      .map((button) => button.textContent);

    expect(buttons).toEqual([
      "Clean stale WSL session",
      "Start NIBI session",
      "Test authenticated session",
      "Run remote environment checks",
    ]);
  });

  it("remote path section only appears for interactive_mfa and robot_automation", () => {
    renderMode("mock");
    expect(screen.queryByText("Remote FluorCast paths")).not.toBeInTheDocument();

    const manual = renderMode("interactive_mfa");
    expect(screen.getByText("Remote FluorCast paths")).toBeInTheDocument();
    expect(screen.getByLabelText("Remote project path")).toBeInTheDocument();
    manual.unmount();

    renderMode("robot_automation");
    expect(screen.getByText("Remote FluorCast paths")).toBeInTheDocument();
    expect(screen.getByLabelText("Python environment path")).toBeInTheDocument();
  });

  it("updates the robot SSH key path when a file is selected from Browse", async () => {
    dialogMock.open.mockResolvedValue("C:\\Users\\CL\\.ssh\\fluorcast_nibi_ed25519");
    pathMock.homeDir.mockResolvedValue("C:\\Users\\CL");
    pathMock.join.mockResolvedValue("C:\\Users\\CL\\.ssh");

    renderMode("robot_automation");

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

  it("switching modes preserves hidden settings and saving does not delete them", () => {
    const save = vi.fn().mockResolvedValue(true);
    renderSettings({
      connection_mode: "robot_automation",
      nibi_username: "alice",
      robot_login_host: "robot.example",
      robot_key_restriction_from: "203.0.113.*",
      ssh_private_key_path: "C:\\Users\\Alice\\.ssh\\robot_key",
      remote_project_path: "/home/alice/project",
      remote_jobs_path: "/home/alice/jobs",
      python_environment_path: "/home/alice/project/.venv/bin/python",
    }, { onNibiSettingsSave: save });

    fireEvent.click(screen.getByRole("radio", { name: /Manual MFA login/ }));
    expect(screen.queryByLabelText("Robot login host")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("radio", { name: /Robot automation/ }));
    expect(screen.getByLabelText("Robot login host")).toHaveValue("robot.example");
    expect(screen.getByLabelText("Robot key from= restriction")).toHaveValue("203.0.113.*");

    fireEvent.click(screen.getByRole("radio", { name: /Mock mode/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));

    expect(save).toHaveBeenCalledWith(expect.objectContaining({
      connection_mode: "mock",
      robot_login_host: "robot.example",
      robot_key_restriction_from: "203.0.113.*",
      ssh_private_key_path: "C:\\Users\\Alice\\.ssh\\robot_key",
      remote_project_path: "/home/alice/project",
    }));
  });

  it("copies the restricted public key without exposing private key text", async () => {
    coreMock.invoke.mockResolvedValue({
      restricted_public_key:
        "restrict,from=\"134.153.150.*\",command=\"/allowed_commands.sh\" ssh-ed25519 AAAATest alice@host",
      public_key_path: "C:\\Users\\Alice\\.ssh\\fluorcast_robot.pub",
    });

    renderMode("robot_automation", {
      nibi_username: "alice",
      ssh_private_key_path: "C:\\Users\\Alice\\.ssh\\fluorcast_robot",
    });

    fireEvent.click(screen.getByRole("button", { name: "Copy restricted public key" }));

    expect(await screen.findByText(/Restricted public key copied/)).toBeInTheDocument();
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(expect.stringContaining("restrict,from=\"134.153.150.*\""));
    expect(navigator.clipboard.writeText).not.toHaveBeenCalledWith(expect.stringContaining("PRIVATE KEY"));
  });

  it("copies the Alliance support request with username and robot host", async () => {
    renderMode("robot_automation", {
      nibi_username: "alice",
      robot_login_host: "robot.nibi.alliancecan.ca",
    });

    fireEvent.click(screen.getByRole("button", { name: "Copy Alliance support request" }));

    expect(await screen.findByText("Alliance support request copied.")).toBeInTheDocument();
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(expect.stringContaining("Username: alice"));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(expect.stringContaining("Robot host: robot.nibi.alliancecan.ca"));
  });

  it("tests robot automation independently and marks access verified on success", async () => {
    coreMock.invoke.mockResolvedValue({
      status: "passed",
      message: "Robot automation access verified.",
      robot_access_verified: true,
      redacted_command_preview:
        "ssh -i <private_key_path> -o IdentitiesOnly=yes alice@robot.nibi.alliancecan.ca \"echo FLUORCAST_ROBOT_OK\"",
      stdout: "FLUORCAST_ROBOT_OK",
      stderr: "",
    });

    renderMode("robot_automation", {
      nibi_username: "alice",
      normal_login_host: "nibi.alliancecan.ca",
      robot_login_host: "robot.nibi.alliancecan.ca",
      ssh_private_key_path: "C:\\Users\\Alice\\.ssh\\fluorcast_robot",
    });

    fireEvent.click(screen.getByRole("button", { name: "Test robot automation" }));

    expect(await screen.findByText("Robot automation access verified.")).toBeInTheDocument();
    expect(screen.getByText(/alice@robot\.nibi\.alliancecan\.ca/)).toBeInTheDocument();
    expect(coreMock.invoke).toHaveBeenCalledWith("test_robot_automation", {
      settings: expect.objectContaining({
        nibi_username: "alice",
        robot_login_host: "robot.nibi.alliancecan.ca",
        normal_login_host: "nibi.alliancecan.ca",
      }),
    });
  });

  it("removes the manual PowerShell confirmation checkbox from Manual MFA", () => {
    renderMode("interactive_mfa", {
      nibi_username: "alice",
      wsl_ssh_private_key_path: "/home/alice/.ssh/fluorcast_nibi_ed25519",
    });

    expect(screen.queryByLabelText("Manual SSH login works in PowerShell")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Copy manual SSH command" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open PowerShell login" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Debug: copy legacy PowerShell SSH command" }))
      .toBeInTheDocument();
  });

  it("marks terminal launch as waiting for user MFA, not authenticated", async () => {
    const onManualMfaSessionChange = vi.fn();
    coreMock.invoke.mockResolvedValue({
      launched: true,
      method: "windows_terminal",
      message: "Windows Terminal opened. Complete password/Duo there, then click Test authenticated session.",
      error_message: "",
      timestamp: "2026-07-16T10:00:00.000Z",
      command_preview: "",
      generated_script_path: "$HOME/.fluorcast/scripts/start-nibi-login.sh",
      script_file_exists: true,
      launch_method_attempted: "windows_terminal",
      launch_error_code: "",
      manual_wsl_command: "",
      windows_terminal_available: true,
      powershell_available: true,
      wsl_available: true,
      distro_available: true,
      commands: {
        backend: "wsl",
        control_path: "$HOME/.fluorcast/ssh/cm-nibi.sock",
        control_path_exists: false,
        control_socket_filename: "cm-nibi.sock",
        script_dir: "$HOME/.fluorcast/scripts",
        start_script_path: "$HOME/.fluorcast/scripts/start-nibi-login.sh",
        check_script_path: "$HOME/.fluorcast/scripts/check-nibi-session.sh",
        end_script_path: "$HOME/.fluorcast/scripts/end-nibi-session.sh",
        clean_script_path: "$HOME/.fluorcast/scripts/clean-nibi-session.sh",
        wsl_distro: "Ubuntu",
        wsl_key_path: "/home/alice/.ssh/fluorcast_nibi_ed25519",
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
        manual_wsl_login_command: "",
        redacted_login_command_preview: "redacted login",
        redacted_test_command_preview: "",
        redacted_end_command_preview: "",
      },
    });

    renderSettings({
      connection_mode: "interactive_mfa",
      manual_mfa_provider: "controlmaster",
      nibi_username: "alice",
      ssh_private_key_path: "C:\\Users\\Alice\\.ssh\\id_ed25519",
      wsl_ssh_private_key_path: "/home/alice/.ssh/fluorcast_nibi_ed25519",
    }, { onManualMfaSessionChange });

    fireEvent.click(screen.getByRole("button", { name: "Start NIBI session" }));

    expect((await screen.findAllByText("Windows Terminal opened. Complete password/Duo there, then click Test authenticated session.")).length)
      .toBeGreaterThan(0);
    expect(onManualMfaSessionChange).toHaveBeenCalledWith(expect.objectContaining({
      status: "waiting_for_user_mfa",
      can_run_background_commands: false,
    }));
  });

  it("rapid Start NIBI session clicks launch one session", async () => {
    let resolveLaunch!: (value: unknown) => void;
    coreMock.invoke.mockImplementation(() => new Promise((resolve) => {
      resolveLaunch = resolve;
    }));

    renderMode("interactive_mfa", {
      nibi_username: "alice",
      wsl_ssh_private_key_path: "/home/alice/.ssh/fluorcast_nibi_ed25519",
    });

    const startButton = screen.getByRole("button", { name: "Start NIBI session" });
    fireEvent.click(startButton);
    fireEvent.click(startButton);

    expect(coreMock.invoke).toHaveBeenCalledTimes(1);
    expect(startButton).toBeDisabled();

    resolveLaunch({
      launched: true,
      method: "windows_terminal",
      message: "Windows Terminal opened.",
      error_message: "",
      timestamp: "2026-07-16T10:00:00.000Z",
      command_preview: "wt.exe",
      generated_script_path: "$HOME/.fluorcast/scripts/start-nibi-login.sh",
      script_file_exists: true,
      launch_method_attempted: "windows_terminal",
      launch_error_code: "",
      manual_wsl_command: "",
      windows_terminal_available: true,
      powershell_available: true,
      wsl_available: true,
      distro_available: true,
      commands: buildLaunchCommandsFixture(),
    });
    await waitFor(() => expect(startButton).toBeEnabled());
  });

  it("a failed environment check preserves authenticated status", async () => {
    const onManualMfaSessionChange = vi.fn();
    coreMock.invoke.mockImplementation(async (command, payload) => {
      if (command === "test_manual_mfa_session") {
        return {
          status: "authenticated",
          message: "Authenticated WSL NIBI session is ready.\nFLUORCAST_AUTH_OK",
          control_path: "/home/alice/.fluorcast/ssh/cm-nibi.sock",
          control_path_exists: true,
          redacted_command_preview: "wsl.exe -d <distribution> -- bash -s -- <host>",
          can_run_background_commands: true,
          last_master_check_result: "MASTER_RUNNING=1",
          last_auth_ok_result: "FLUORCAST_AUTH_OK",
          last_session_test_stdout: "WSL_DISTRO=Ubuntu\nWSL_USER=alice\nWSL_HOME=/home/alice\nCONTROL_PATH=/home/alice/.fluorcast/ssh/cm-nibi.sock\nFLUORCAST_AUTH_OK",
          last_session_test_stderr: "",
          last_session_test_exit_code: 0,
          parsed_session_status: "authenticated",
          selected_backend: "wsl",
          wsl_available: true,
          wsl_ssh_available: true,
        };
      }
      return {
        exit_code: payload.commandSpec.args?.includes("-r") ? 1 : 0,
        stdout: payload.commandSpec.args?.includes("-r") ? "" : "ok",
        stderr: payload.commandSpec.args?.includes("-r") ? "not readable" : "",
        duration_ms: 10,
        command_label: payload.commandSpec.label,
        redacted_command_preview: payload.commandSpec.redacted_preview,
      };
    });

    renderSettings({
      connection_mode: "interactive_mfa",
      nibi_username: "alice",
      wsl_ssh_private_key_path: "/home/alice/.ssh/fluorcast_nibi_ed25519",
    }, {
      manualMfaSession: {
        ...defaultManualMfaSessionState,
        status: "authenticated",
        can_run_background_commands: true,
      },
      onManualMfaSessionChange,
    });

    fireEvent.click(screen.getByRole("button", { name: "Run remote environment checks" }));

    expect(await screen.findByText("Remote project path is not readable.")).toBeInTheDocument();
    expect(onManualMfaSessionChange).toHaveBeenCalledWith(expect.objectContaining({
      status: "authenticated",
      can_run_background_commands: true,
    }));
    expect(screen.getByText("authenticated")).toBeInTheDocument();
  });

  it("appearance section remains at the bottom and is collapsible", () => {
    const { container } = renderMode("mock");

    const form = container.querySelector("form");
    const appearancePanel = container.querySelector(".appearance-panel") as HTMLDetailsElement;
    expect(form?.nextElementSibling).toBe(appearancePanel);
    expect(appearancePanel.open).toBe(false);

    fireEvent.click(screen.getByText("Appearance"));

    expect(appearancePanel.open).toBe(true);
    expect(within(appearancePanel).getByRole("button", { name: "Rose accent" })).toBeInTheDocument();
    expect(within(appearancePanel).getByRole("button", { name: "Amber secondary" })).toBeInTheDocument();
  });
});
