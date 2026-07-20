import { fireEvent, render, screen, within } from "@testing-library/react";
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

  it("section is collapsed by default in interactive_mfa mode and shows status summary", () => {
    renderMode("interactive_mfa");

    expect(screen.getByText("Remote Environment Checks")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Remote Environment Checks/ }))
      .toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("Log into NIBI first before running remote environment checks."))
      .toBeInTheDocument();
    expect(screen.getAllByText("Login required").length).toBeGreaterThan(1);
    expect(screen.queryByRole("button", { name: "Run remote environment checks" })).not.toBeInTheDocument();
  });

  it("expanding reveals disabled interactive_mfa message and Run button", () => {
    renderMode("interactive_mfa");

    expandRemoteEnvironmentChecks();

    expect(screen.getByRole("button", { name: /Remote Environment Checks/ }))
      .toHaveAttribute("aria-expanded", "true");
    expect(screen.getAllByText("Log into NIBI first before running remote environment checks.").length)
      .toBeGreaterThan(1);
    expect(screen.getByRole("button", { name: "Run remote environment checks" })).toBeDisabled();
  });

  it("enables Remote Environment Checks in interactive_mfa after authenticated", () => {
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

    expect(screen.getByText("Remote Environment Checks")).toBeInTheDocument();
    expect(screen.getByText("Not run yet")).toBeInTheDocument();
    expect(screen.getByText("Not run")).toBeInTheDocument();
    expandRemoteEnvironmentChecks();
    expect(screen.queryByText("Log into NIBI first before running remote environment checks."))
      .not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Run remote environment checks" })).toBeEnabled();
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

  it("preserves previous check results after collapse and re-expand", async () => {
    coreMock.invoke.mockImplementation(async (_command, payload) => ({
      exit_code: payload.commandSpec.args?.includes("sacct") ? 1 : 0,
      stdout: payload.commandSpec.args?.includes("sacct") ? "" : "ok",
      stderr: payload.commandSpec.args?.includes("sacct") ? "sacct missing" : "",
      duration_ms: 10,
      command_label: payload.commandSpec.label,
      redacted_command_preview: payload.commandSpec.redacted_preview,
    }));

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

    const toggle = screen.getByRole("button", { name: /Remote Environment Checks/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(screen.getByRole("button", { name: "Run remote environment checks" }));

    expect(await screen.findByText("Remote environment ready; sacct unavailable, polling will use fallback checks."))
      .toBeInTheDocument();
    expect(screen.getByText("sacct is unavailable. Job polling may fall back to squeue/output-file checks."))
      .toBeInTheDocument();
    expect(screen.getAllByText("Ready").length).toBeGreaterThan(1);

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("sacct is unavailable. Job polling may fall back to squeue/output-file checks."))
      .not.toBeInTheDocument();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("sacct is unavailable. Job polling may fall back to squeue/output-file checks."))
      .toBeInTheDocument();
  });

  it("interactive_mfa shows manual login controls and hides robot-only controls", () => {
    renderMode("interactive_mfa");

    expect(screen.getByLabelText("NIBI username")).toBeInTheDocument();
    expect(screen.getByLabelText("Normal login host")).toHaveValue("nibi.alliancecan.ca");
    expect(screen.getByLabelText(/Private SSH key file/)).toBeInTheDocument();
    expect(screen.getByText("Manual MFA Login")).toBeInTheDocument();
    expect(screen.getAllByText(/Manual MFA mode runs each NIBI action in a visible PowerShell window/).length)
      .toBeGreaterThanOrEqual(1);
    expect(screen.getByRole("button", { name: "Copy manual SSH command" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Start NIBI session" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Test session readiness" })).not.toBeInTheDocument();
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

  it("shows reusable session controls only for legacy persistent shell mode", () => {
    renderMode("interactive_mfa", {
      manual_mfa_provider: "persistent_shell",
    });

    expect(screen.getByRole("button", { name: "Start NIBI session" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Test session readiness" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "End NIBI session" })).toBeInTheDocument();
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

  it("updates the SSH key path when a file is selected from Browse", async () => {
    dialogMock.open.mockResolvedValue("C:\\Users\\CL\\.ssh\\fluorcast_nibi_ed25519");
    pathMock.homeDir.mockResolvedValue("C:\\Users\\CL");
    pathMock.join.mockResolvedValue("C:\\Users\\CL\\.ssh");

    renderMode("interactive_mfa");

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

  it("copies the manual SSH command and saves manual login confirmation", async () => {
    const save = vi.fn().mockResolvedValue(true);
    renderMode("interactive_mfa", {
      nibi_username: "alice",
      ssh_private_key_path: "C:\\Users\\Alice\\.ssh\\id_ed25519",
    });

    fireEvent.click(screen.getByRole("button", { name: "Copy manual SSH command" }));

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      "ssh -i \"C:\\Users\\Alice\\.ssh\\id_ed25519\" alice@nibi.alliancecan.ca",
    );
    expect(await screen.findByText("Manual SSH command copied.")).toBeInTheDocument();

    renderSettings({
      connection_mode: "interactive_mfa",
      nibi_username: "alice",
      ssh_private_key_path: "C:\\Users\\Alice\\.ssh\\id_ed25519",
    }, { onNibiSettingsSave: save });
    fireEvent.click(screen.getAllByLabelText("Manual SSH login works in PowerShell").at(-1)!);
    fireEvent.click(screen.getAllByRole("button", { name: "Save settings" }).at(-1)!);

    expect(save).toHaveBeenCalledWith(expect.objectContaining({ manual_login_verified: true }));
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
    }, { onManualMfaSessionChange });

    fireEvent.click(screen.getByRole("button", { name: "Start NIBI session" }));

    expect(await screen.findByText("Windows Terminal opened. Complete password/Duo there, then click Test authenticated session."))
      .toBeInTheDocument();
    expect(onManualMfaSessionChange).toHaveBeenCalledWith(expect.objectContaining({
      status: "waiting_for_user_mfa",
      can_run_background_commands: false,
    }));
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
