import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultNibiSettings, type NibiSettings } from "../../features/settings";
import {
  defaultManualMfaSessionState,
  type ManualMfaSessionResult,
  type ManualMfaSessionUiState,
} from "../../lib/remote";
import { HomePage } from "./HomePage";

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

const openerMock = vi.hoisted(() => ({
  openUrl: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => dialogMock);
vi.mock("@tauri-apps/api/path", () => pathMock);
vi.mock("@tauri-apps/api/core", () => coreMock);
vi.mock("@tauri-apps/plugin-opener", () => openerMock);

function renderHome(
  settings: Partial<NibiSettings> = {},
  options: {
    manualMfaSession?: ManualMfaSessionUiState;
    onManualMfaSessionChange?: (session: ManualMfaSessionUiState) => void;
    save?: (settings: NibiSettings) => Promise<boolean>;
  } = {},
) {
  const save = options.save ?? vi.fn().mockResolvedValue(true);
  return {
    save,
    ...render(
      <HomePage
        manualMfaSession={options.manualMfaSession ?? defaultManualMfaSessionState}
        nibiSettings={{
          ...defaultNibiSettings,
          ...settings,
        }}
        onManualMfaSessionChange={options.onManualMfaSessionChange}
        onNibiSettingsSave={save}
      />,
    ),
  };
}

function buildAuthenticatedSessionResult(overrides: Partial<ManualMfaSessionResult> = {}): ManualMfaSessionResult {
  const stdout = [
    "WSL_DISTRO=Ubuntu",
    "WSL_USER=alice",
    "WSL_HOME=/home/alice",
    "CONTROL_PATH=/home/alice/.fluorcast/ssh/cm-nibi.sock",
    "SOCKET_EXISTS=1",
    "MASTER_RUNNING=1",
    "FLUORCAST_AUTH_OK",
  ].join("\n");
  return {
    status: "authenticated",
    message: "Authenticated WSL NIBI session is ready.\nFLUORCAST_AUTH_OK",
    success: true,
    authenticated: true,
    failure_code: "none",
    exit_code: 0,
    wsl_distro: "Ubuntu",
    wsl_user: "alice",
    wsl_home: "/home/alice",
    resolved_control_path: "/home/alice/.fluorcast/ssh/cm-nibi.sock",
    socket_exists: true,
    master_running: true,
    authentication_marker_received: true,
    stdout,
    stderr: "",
    control_path: "/home/alice/.fluorcast/ssh/cm-nibi.sock",
    control_path_exists: true,
    redacted_command_preview: "wsl.exe -d <distribution> -- bash -s -- <host>",
    can_run_background_commands: true,
    last_master_check_result: "MASTER_RUNNING=1",
    last_auth_ok_result: "FLUORCAST_AUTH_OK",
    last_session_test_stdout: stdout,
    last_session_test_stderr: "",
    last_session_test_exit_code: 0,
    parsed_session_status: "authenticated",
    selected_backend: "wsl",
    wsl_available: true,
    wsl_ssh_available: true,
    ...overrides,
  };
}

describe("HomePage", () => {
  beforeEach(() => {
    dialogMock.open.mockReset();
    pathMock.homeDir.mockReset();
    pathMock.join.mockReset();
    coreMock.invoke.mockReset();
    openerMock.openUrl.mockReset();
    openerMock.openUrl.mockResolvedValue(undefined);
    Object.assign(navigator, {
      clipboard: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    });
  });

  it("renders Connection Mode before the moved connection configuration", () => {
    const { container } = renderHome({ connection_mode: "interactive_mfa" });

    expect(screen.getByRole("heading", { name: /from structure to signal/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Connection Mode" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Mode-specific setup" })).toBeInTheDocument();
    expect(screen.getByText("SSH key")).toBeInTheDocument();
    expect(screen.getByText("Remote FluorCast paths")).toBeInTheDocument();
    expect(screen.getByText("FluorCast does not store your NIBI password. SSH keys remain on your computer."))
      .toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "NIBI Session" })).toBeInTheDocument();

    const connectionMode = screen.getByRole("heading", { name: "Connection Mode" });
    const modeSetup = screen.getByRole("heading", { name: "Mode-specific setup" });
    const sshKey = screen.getByRole("heading", { name: "SSH key" });
    const remotePaths = within(container.querySelector("form")!).getByText("Remote FluorCast paths", { selector: "summary" });
    const securityNotice = screen.getByText("FluorCast does not store your NIBI password. SSH keys remain on your computer.");
    const nibiSession = screen.getByRole("heading", { name: "NIBI Session" });

    expect(connectionMode.compareDocumentPosition(modeSetup) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(modeSetup.compareDocumentPosition(sshKey) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(sshKey.compareDocumentPosition(remotePaths) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(remotePaths.compareDocumentPosition(securityNotice) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(securityNotice.compareDocumentPosition(nibiSession) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("renders only the available connection-mode options in the same order", () => {
    renderHome();

    const radios = within(screen.getByRole("group", { name: "Connection mode" })).getAllByRole("radio");
    const optionNames = radios.map((radio) => radio.getAttribute("value"));

    expect(screen.getByRole("radio", { name: /Mock mode/i })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Manual MFA login/i })).toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: /Robot automation/i })).not.toBeInTheDocument();
    expect(screen.queryByText("Robot automation")).not.toBeInTheDocument();
    expect(radios).toHaveLength(2);
    expect(optionNames).toEqual(["mock", "interactive_mfa"]);
  });

  it("renders mode-specific setup for mock and manual MFA", () => {
    const { rerender } = renderHome();

    expect(screen.getByLabelText("Default model choice")).toBeInTheDocument();
    expect(screen.queryByLabelText("NIBI username")).not.toBeInTheDocument();

    rerender(
      <HomePage
        manualMfaSession={defaultManualMfaSessionState}
        nibiSettings={{ ...defaultNibiSettings, connection_mode: "interactive_mfa" }}
        onNibiSettingsSave={vi.fn().mockResolvedValue(true)}
      />,
    );
    expect(screen.getByLabelText("NIBI username")).toBeInTheDocument();
    expect(screen.getByLabelText("Normal login host")).toHaveValue("nibi.alliancecan.ca");
    expect(screen.getAllByText("WSL distribution").length).toBeGreaterThan(0);
    expect(screen.queryByLabelText("Robot login host")).not.toBeInTheDocument();
  });

  it("selects Mock mode through the existing save path", async () => {
    const { save } = renderHome({
      connection_mode: "interactive_mfa",
      nibi_username: "alice",
    });

    fireEvent.click(screen.getByRole("radio", { name: /Mock mode/i }));
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));

    await waitFor(() => {
      expect(save).toHaveBeenCalledWith(expect.objectContaining({ connection_mode: "mock" }));
    });
  });

  it("selects Manual MFA login through the existing save path", async () => {
    const { save } = renderHome();

    fireEvent.click(screen.getByRole("radio", { name: /Manual MFA login/i }));
    fireEvent.change(screen.getByLabelText("NIBI username"), { target: { value: "alice" } });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));

    await waitFor(() => {
      expect(save).toHaveBeenCalledWith(expect.objectContaining({
        connection_mode: "interactive_mfa",
        nibi_username: "alice",
      }));
    });
  });

  it("normalizes a stored robot mode to Manual MFA login once", async () => {
    const save = vi.fn().mockResolvedValue(true);

    renderHome({ connection_mode: "robot_automation", nibi_username: "alice" }, { save });

    expect(screen.queryByRole("radio", { name: /Robot automation/i })).not.toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Manual MFA login/i })).toBeChecked();
    expect(screen.queryByLabelText("Robot login host")).not.toBeInTheDocument();
    await waitFor(() => {
      expect(save).toHaveBeenCalledTimes(1);
      expect(save).toHaveBeenCalledWith(expect.objectContaining({
        connection_mode: "interactive_mfa",
        nibi_username: "alice",
      }));
    });
  });

  it("does not repeatedly save after stored robot mode normalization updates settings", async () => {
    const save = vi.fn().mockImplementation(async (settings: NibiSettings) => {
      setHarnessSettings(settings);
      return true;
    });
    let setHarnessSettings!: (settings: NibiSettings) => void;

    function Harness() {
      const [settings, setSettings] = useState<NibiSettings>({
        ...defaultNibiSettings,
        connection_mode: "robot_automation",
        nibi_username: "alice",
      });
      setHarnessSettings = setSettings;
      return (
        <HomePage
          manualMfaSession={defaultManualMfaSessionState}
          nibiSettings={settings}
          onNibiSettingsSave={save}
        />
      );
    }

    render(<Harness />);

    await waitFor(() => {
      expect(save).toHaveBeenCalledTimes(1);
      expect(screen.getByRole("radio", { name: /Manual MFA login/i })).toBeChecked();
    });
  });

  it("leaves a stored Mock mode unchanged", () => {
    const save = vi.fn().mockResolvedValue(true);

    renderHome({ connection_mode: "mock" }, { save });

    expect(screen.getByRole("radio", { name: /Mock mode/i })).toBeChecked();
    expect(save).not.toHaveBeenCalled();
  });

  it("leaves a stored Manual MFA mode unchanged", () => {
    const save = vi.fn().mockResolvedValue(true);

    renderHome({ connection_mode: "interactive_mfa" }, { save });

    expect(screen.getByRole("radio", { name: /Manual MFA login/i })).toBeChecked();
    expect(save).not.toHaveBeenCalled();
  });

  it("renders the SSH key and Remote FluorCast path sections with existing values", () => {
    renderHome({
      connection_mode: "interactive_mfa",
      nibi_username: "alice",
      wsl_ssh_private_key_path: "/home/alice/.ssh/fluorcast_nibi_ed25519",
      remote_project_path: "/home/alice/fluorcast",
      remote_jobs_path: "/home/alice/scratch/jobs",
      python_environment_path: "/home/alice/fluorcast/.venv/bin/python",
    });

    expect(screen.getByLabelText("NIBI username")).toHaveValue("alice");
    expect(screen.getByLabelText(/WSL private key path/)).toHaveValue("/home/alice/.ssh/fluorcast_nibi_ed25519");
    expect(screen.getByLabelText("Remote project path")).toHaveValue("/home/alice/fluorcast");
    expect(screen.getByLabelText("Remote jobs path")).toHaveValue("/home/alice/scratch/jobs");
    expect(screen.getByLabelText("Python environment path")).toHaveValue("/home/alice/fluorcast/.venv/bin/python");
  });

  it("renders collapsed WSL SSH-key setup instructions with safe external links", () => {
    const { container } = renderHome({
      connection_mode: "interactive_mfa",
      wsl_ssh_private_key_path: "/home/alice/.ssh/fluorcast_nibi_ed25519",
    });

    const sshSection = screen.getByRole("heading", { name: "SSH key" }).closest("section")!;
    const privateKeyInput = screen.getByLabelText(/WSL private key path/);
    const setupSummary = within(sshSection).getByText("How to create and add an SSH key", { selector: "summary" });
    const setupPanel = screen.getByTestId("ssh-key-setup-panel");

    expect(sshSection).toContainElement(privateKeyInput);
    expect(sshSection).toContainElement(setupPanel);
    expect(privateKeyInput.compareDocumentPosition(setupPanel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(setupPanel).not.toHaveAttribute("open");

    fireEvent.click(setupSummary);

    expect(setupPanel).toHaveAttribute("open");
    [
      "1. Open Ubuntu WSL",
      "2. Check for an existing SSH key",
      "3. Create a dedicated FluorCast SSH key",
      "4. Copy the public key",
      "5. Add the public key to your Alliance account",
      "6. Enter the private-key path in FluorCast",
      "7. Test the SSH key",
      "8. Start the session in FluorCast",
    ].forEach((heading) => {
      expect(within(setupPanel).getByRole("heading", { name: heading })).toBeInTheDocument();
    });

    expect(within(setupPanel).getByText(/ssh-keygen -t ed25519 -f ~\/\.ssh\/fluorcast_nibi_ed25519/))
      .toBeInTheDocument();
    expect(within(setupPanel).getByText(/chmod 600 ~\/\.ssh\/fluorcast_nibi_ed25519/)).toBeInTheDocument();
    expect(within(setupPanel).getByText("cat ~/.ssh/fluorcast_nibi_ed25519.pub")).toBeInTheDocument();
    expect(within(setupPanel).getByText("ssh -i ~/.ssh/fluorcast_nibi_ed25519 <nibi-username>@nibi.alliancecan.ca"))
      .toBeInTheDocument();
    expect(within(setupPanel).getByText(/Only the public key is submitted to the Alliance/)).toBeInTheDocument();
    expect(within(setupPanel).getByText(/Never share the private key/)).toBeInTheDocument();
    expect(within(setupPanel).getByText(/Never paste the private key into CCDB/)).toBeInTheDocument();

    const officialReference = within(setupPanel).getByRole("link", {
      name: "Digital Research Alliance of Canada SSH Keys, external link",
    });
    const ccdbLink = within(setupPanel).getByRole("link", {
      name: "CCDB SSH authorized keys, external link",
    });

    expect(officialReference).toHaveAttribute("href", "https://docs.alliancecan.ca/wiki/SSH_Keys");
    expect(ccdbLink).toHaveAttribute("href", "https://ccdb.alliancecan.ca/ssh_authorized_keys");
    expect(officialReference).toHaveAttribute("target", "_blank");
    expect(ccdbLink).toHaveAttribute("target", "_blank");
    expect(officialReference).toHaveAttribute("rel", "noopener noreferrer");
    expect(ccdbLink).toHaveAttribute("rel", "noopener noreferrer");

    fireEvent.click(officialReference);
    fireEvent.click(ccdbLink);

    expect(openerMock.openUrl).toHaveBeenNthCalledWith(1, "https://docs.alliancecan.ca/wiki/SSH_Keys");
    expect(openerMock.openUrl).toHaveBeenNthCalledWith(2, "https://ccdb.alliancecan.ca/ssh_authorized_keys");
    expect(container.querySelector("form")).toContainElement(screen.getByRole("button", { name: "Save settings" }));

    fireEvent.click(setupSummary);
    expect(setupPanel).not.toHaveAttribute("open");
  });

  it("renders the four NIBI Session buttons with unchanged labels and order", () => {
    renderHome({ connection_mode: "interactive_mfa" });

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

  it("edits fields and saves through the existing persistence shape", async () => {
    const { save } = renderHome({
      connection_mode: "interactive_mfa",
      nibi_username: "alice",
      remote_project_path: "/home/alice/project",
    });

    fireEvent.change(screen.getByLabelText("NIBI username"), { target: { value: "bob" } });
    fireEvent.change(screen.getByLabelText(/WSL private key path/), {
      target: { value: "/home/bob/.ssh/fluorcast_nibi_ed25519" },
    });
    fireEvent.change(screen.getByLabelText("Remote project path"), { target: { value: "/home/bob/project" } });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));

    await waitFor(() => {
      expect(save).toHaveBeenCalledWith(expect.objectContaining({
        connection_mode: "interactive_mfa",
        nibi_username: "bob",
        wsl_ssh_private_key_path: "/home/bob/.ssh/fluorcast_nibi_ed25519",
        remote_project_path: "/home/bob/project",
      }));
    });
    expect(await screen.findByText("NIBI settings saved locally.")).toBeInTheDocument();
  });

  it("preserves save loading, disabled state, and validation behavior", async () => {
    let resolveSave!: (value: boolean) => void;
    renderHome({}, {
      save: vi.fn(() => new Promise<boolean>((resolve) => {
        resolveSave = resolve;
      })),
    });

    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    expect(screen.getByRole("button", { name: "Saving settings" })).toBeDisabled();

    resolveSave(true);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Save settings" })).toBeEnabled();
    });
  });

  it("calls the same manual session actions from the moved buttons", async () => {
    coreMock.invoke.mockResolvedValue(buildAuthenticatedSessionResult({
      message: "Authenticated WSL NIBI session is ready.",
    }));
    const onManualMfaSessionChange = vi.fn();

    renderHome({
      connection_mode: "interactive_mfa",
      nibi_username: "alice",
      wsl_ssh_private_key_path: "/home/alice/.ssh/fluorcast_nibi_ed25519",
    }, { onManualMfaSessionChange });

    fireEvent.click(screen.getByRole("button", { name: "Clean stale WSL session" }));
    await waitFor(() => {
      expect(coreMock.invoke).toHaveBeenCalledWith("clean_stale_manual_mfa_session", expect.any(Object));
    });

    fireEvent.click(screen.getByRole("button", { name: "Test authenticated session" }));
    await waitFor(() => {
      expect(coreMock.invoke).toHaveBeenCalledWith("test_manual_mfa_session", expect.any(Object));
    });
    expect(onManualMfaSessionChange).toHaveBeenCalledWith(expect.objectContaining({
      status: "authenticated",
      can_run_background_commands: true,
    }));
  });

  it("starts a NIBI session with the existing backend command and disables while loading", async () => {
    let resolveLaunch!: (value: unknown) => void;
    coreMock.invoke.mockImplementation(() => new Promise((resolve) => {
      resolveLaunch = resolve;
    }));

    renderHome({
      connection_mode: "interactive_mfa",
      nibi_username: "alice",
      wsl_ssh_private_key_path: "/home/alice/.ssh/fluorcast_nibi_ed25519",
    });

    const startButton = screen.getByRole("button", { name: "Start NIBI session" });
    fireEvent.click(startButton);

    expect(startButton).toBeDisabled();
    expect(coreMock.invoke).toHaveBeenCalledWith("open_manual_mfa_login", expect.any(Object));

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
    await waitFor(() => expect(startButton).toBeEnabled());
  });

  it("renders session diagnostics and remote environment check results", async () => {
    coreMock.invoke.mockImplementation(async (command, payload) => {
      if (command === "test_manual_mfa_session") {
        return buildAuthenticatedSessionResult();
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

    function Harness() {
      const [session, setSession] = useState<ManualMfaSessionUiState>({
        ...defaultManualMfaSessionState,
        status: "authenticated",
        can_run_background_commands: true,
      });
      return (
        <HomePage
          manualMfaSession={session}
          nibiSettings={{
            ...defaultNibiSettings,
            connection_mode: "interactive_mfa",
            nibi_username: "alice",
          }}
          onManualMfaSessionChange={setSession}
          onNibiSettingsSave={vi.fn().mockResolvedValue(true)}
        />
      );
    }

    render(<Harness />);

    expect(screen.getByText("Session status")).toBeInTheDocument();
    expect(screen.getByText("Most recent action result")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Run remote environment checks" }));

    expect(await screen.findByText("Remote environment needs attention")).toBeInTheDocument();
    expect(screen.getByText("sacct is unavailable.")).toBeInTheDocument();
    expect(screen.getAllByText("Technical details").length).toBeGreaterThan(0);
  });

  it("renders only one copy of each connection-related control", () => {
    renderHome({ connection_mode: "interactive_mfa" });

    expect(screen.getAllByRole("heading", { name: "Connection Mode" })).toHaveLength(1);
    expect(screen.getAllByRole("group", { name: "Connection mode" })).toHaveLength(1);
    expect(screen.getAllByLabelText("NIBI username")).toHaveLength(1);
    expect(screen.getAllByText("SSH key")).toHaveLength(1);
    expect(screen.getAllByText("Remote FluorCast paths")).toHaveLength(1);
    expect(screen.getAllByRole("heading", { name: "NIBI Session" })).toHaveLength(1);
  });
});
