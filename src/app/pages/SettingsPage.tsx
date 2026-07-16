import type { FormEvent } from "react";
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { homeDir, join } from "@tauri-apps/api/path";
import { open } from "@tauri-apps/plugin-dialog";
import {
  defaultNibiSettings,
  buildManualSshCommand,
  trimNibiSettings,
  validateNibiSettings,
  validateNibiSettingsWarnings,
  type ConnectionMode,
  type NibiSettings,
  type NibiSettingsErrors,
} from "../../features/settings";
import { createRemoteExecutor, defaultManualMfaSessionState } from "../../lib/remote";
import type {
  ManualMfaSessionCommands,
  ManualMfaSessionResult,
  ManualMfaTerminalLaunchResult,
  ManualMfaSessionUiState,
} from "../../lib/remote";

const accentPresets = [
  { name: "Blue", value: "#8ab4ff" },
  { name: "Violet", value: "#c4a7ff" },
  { name: "Amber", value: "#f3c969" },
  { name: "Rose", value: "#ff9bb3" },
  { name: "Mint", value: "#8ee6c8" },
] as const;

const secondaryPresets = [
  { name: "Mint", value: "#8ee6c8" },
  { name: "Amber", value: "#f3c969" },
  { name: "Steel", value: "#9fb7c8" },
  { name: "Coral", value: "#ffad91" },
  { name: "Lilac", value: "#d6b8ff" },
] as const;

const modelChoices = [
  { value: "all", label: "All models" },
  { value: "hybrid_full", label: "Hybrid full" },
  { value: "rf", label: "Random forest" },
  { value: "extratrees", label: "Extra trees" },
  { value: "graph", label: "Graph" },
] as const;

type SettingsPageProps = {
  accentColor: string;
  manualMfaSession?: ManualMfaSessionUiState;
  nibiSettings: NibiSettings;
  onAccentColorChange: (color: string) => void;
  onManualMfaSessionChange?: (session: ManualMfaSessionUiState) => void;
  onNibiSettingsSave: (settings: NibiSettings) => Promise<boolean>;
  onSecondaryColorChange: (color: string) => void;
  secondaryColor: string;
};

type NibiConnectionCheck = {
  id: string;
  label: string;
  status: "passed" | "failed" | "interactive_login_required" | "skipped";
  message: string;
};

export function SettingsPage({
  accentColor,
  manualMfaSession = defaultManualMfaSessionState,
  nibiSettings,
  onAccentColorChange,
  onManualMfaSessionChange = () => undefined,
  onNibiSettingsSave,
  onSecondaryColorChange,
  secondaryColor,
}: SettingsPageProps) {
  const [values, setValues] = useState<NibiSettings>(nibiSettings);
  const [errors, setErrors] = useState<NibiSettingsErrors>({});
  const [saveStatus, setSaveStatus] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [isBrowsingSshKey, setIsBrowsingSshKey] = useState(false);
  const [isTestingConnection, setIsTestingConnection] = useState(false);
  const [connectionChecks, setConnectionChecks] = useState<NibiConnectionCheck[]>([]);
  const [connectionTestStatus, setConnectionTestStatus] = useState("");
  const [manualCommandStatus, setManualCommandStatus] = useState("");
  const [manualMfaCommands, setManualMfaCommands] = useState<ManualMfaSessionCommands | null>(null);
  const [manualMfaStatus, setManualMfaStatus] = useState("");
  const [isManualMfaWorking, setIsManualMfaWorking] = useState(false);

  const warnings = validateNibiSettingsWarnings(values);
  const manualSshCommand = buildManualSshCommand(values);
  const remoteExecutor = createRemoteExecutor(values.connection_mode);
  const connectionStatus = remoteExecutor.getConnectionStatus(values);

  useEffect(() => {
    setValues(nibiSettings);
  }, [nibiSettings]);

  function updateField(field: keyof NibiSettings, value: string) {
    setValues((current) => ({
      ...current,
      [field]: field === "connection_mode" ? (value as ConnectionMode) : value,
    }));
    setErrors((current) => ({ ...current, [field]: undefined }));
    setSaveStatus("");
    setConnectionTestStatus("");
    setConnectionChecks([]);
    setManualCommandStatus("");
  }

  function updateBooleanField(field: "manual_login_verified" | "robot_access_verified", value: boolean) {
    setValues((current) => ({
      ...current,
      [field]: value,
    }));
    setSaveStatus("");
    setConnectionTestStatus("");
    setConnectionChecks([]);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = trimNibiSettings(values);
    const nextErrors = validateNibiSettings(trimmed);
    setErrors(nextErrors);
    setSaveStatus("");

    if (Object.keys(nextErrors).length > 0) {
      return;
    }

    setIsSaving(true);
    try {
      const saved = await onNibiSettingsSave(trimmed);
      setSaveStatus(saved ? "NIBI settings saved locally." : "Settings were not saved in this runtime.");
      if (saved) {
        setValues(trimmed);
      }
    } catch (error) {
      setSaveStatus(error instanceof Error ? error.message : "NIBI settings could not be saved.");
    } finally {
      setIsSaving(false);
    }
  }

  function resetSuggestedDefaults() {
    setValues(defaultNibiSettings);
    setErrors({});
    setSaveStatus("");
    setConnectionTestStatus("");
    setConnectionChecks([]);
    setManualCommandStatus("");
  }

  async function getDefaultSshDirectory() {
    try {
      return await join(await homeDir(), ".ssh");
    } catch {
      return undefined;
    }
  }

  async function browseSshKeyPath() {
    setIsBrowsingSshKey(true);
    setSaveStatus("");
    try {
      const selected = await open({
        title: "Choose your private SSH key",
        multiple: false,
        directory: false,
        defaultPath: await getDefaultSshDirectory(),
      });
      if (typeof selected === "string") {
        updateField("ssh_key_path", selected);
        updateField("ssh_private_key_path", selected);
      }
    } catch (error) {
      setSaveStatus(error instanceof Error ? error.message : "Could not open the file picker.");
    } finally {
      setIsBrowsingSshKey(false);
    }
  }

  async function testNibiConnection() {
    const trimmed = trimNibiSettings(values);
    const nextErrors = validateNibiSettings({
      ...trimmed,
      connection_mode: values.connection_mode === "mock" ? "interactive_mfa" : values.connection_mode,
    });
    setErrors(nextErrors);
    setSaveStatus("");
    setConnectionTestStatus("");
    setConnectionChecks([]);

    if (Object.keys(nextErrors).length > 0) {
      setConnectionTestStatus("Fix the highlighted NIBI settings before testing.");
      return;
    }

    setIsTestingConnection(true);
    try {
      const checks = await invoke<NibiConnectionCheck[]>("test_nibi_connection", {
        settings: trimmed,
      });
      setConnectionChecks(checks);
      const failedCount = checks.filter((check) => check.status === "failed").length;
      const interactiveCount = checks.filter((check) => check.status === "interactive_login_required").length;
      setConnectionTestStatus(
        interactiveCount > 0
          ? "NIBI is asking for interactive login. Manual SSH may work, but app automation is not ready yet."
          : failedCount === 0
          ? "NIBI connection checks passed."
          : `${failedCount} NIBI connection check${failedCount === 1 ? "" : "s"} failed.`,
      );
    } catch (error) {
      setConnectionTestStatus(
        error instanceof Error ? error.message : "NIBI connection test could not run.",
      );
    } finally {
      setIsTestingConnection(false);
    }
  }

  async function copyManualSshCommand() {
    setManualCommandStatus("");
    try {
      await navigator.clipboard.writeText(manualSshCommand);
      setManualCommandStatus("Manual SSH command copied.");
    } catch {
      setManualCommandStatus("Copy failed. Select the command and copy it manually.");
    }
  }

  async function openPowerShellLogin() {
    setManualCommandStatus("");
    try {
      await invoke("open_powershell_login", {
        settings: trimNibiSettings(values),
      });
      setManualCommandStatus("PowerShell opened for manual SSH login.");
    } catch (error) {
      setManualCommandStatus(
        error instanceof Error
          ? error.message
          : "Could not open PowerShell. Copy the command and paste it into PowerShell.",
      );
    }
  }

  function updateManualMfaFromResult(result: ManualMfaSessionResult, canMarkAuthenticated = false) {
    const checkedAt = new Date().toISOString();
    const resultMarksAuthenticated = result.status === "authenticated" || result.can_run_background_commands;
    const status = resultMarksAuthenticated && !canMarkAuthenticated ? "login_required" : result.status;
    const canRunBackgroundCommands = canMarkAuthenticated && result.can_run_background_commands;
    const nextSession: ManualMfaSessionUiState = {
      ...manualMfaSession,
      status,
      control_path: result.control_path,
      control_path_exists: result.control_path_exists,
      last_session_test_result: result.message,
      can_run_background_commands: canRunBackgroundCommands,
      last_master_check_result: result.last_master_check_result,
      last_auth_ok_result: result.last_auth_ok_result,
      selected_backend: "wsl",
      wsl_available: result.wsl_available,
      wsl_ssh_available: result.wsl_ssh_available,
      last_successful_command_at: canRunBackgroundCommands
        ? checkedAt
        : manualMfaSession.last_successful_command_at,
    };
    onManualMfaSessionChange(nextSession);
    setManualMfaStatus(result.message);
    if (canRunBackgroundCommands) {
      const nextSettings = {
        ...trimNibiSettings(values),
        manual_login_verified: true,
        last_manual_login_check_at: checkedAt,
      };
      setValues(nextSettings);
      void onNibiSettingsSave(nextSettings);
    }
  }

  async function copyManualMfaLoginCommand() {
    setManualMfaStatus("");
    try {
      const commands = manualMfaCommands ?? await invoke<ManualMfaSessionCommands>(
        "get_manual_mfa_session_commands",
        { settings: trimNibiSettings(values) },
      );
      setManualMfaCommands(commands);
      await navigator.clipboard.writeText(commands.login_command);
      setManualMfaStatus("Manual MFA login command copied.");
    } catch (error) {
      setManualMfaStatus(error instanceof Error ? error.message : "Copy failed. Select the command and copy it manually.");
    }
  }

  async function startManualMfaLogin() {
    setIsManualMfaWorking(true);
    setManualMfaStatus("");
    try {
      const launch = await invoke<ManualMfaTerminalLaunchResult>("open_manual_mfa_login", {
        settings: trimNibiSettings(values),
      });
      const commands = launch.commands;
      const startedAt = new Date().toISOString();
      setManualMfaCommands(commands);
      onManualMfaSessionChange({
        ...manualMfaSession,
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
      });
      setManualMfaStatus(launch.message);
    } catch (error) {
      setManualMfaStatus(error instanceof Error ? error.message : "Could not open a terminal automatically. Copy the WSL login command and run it manually.");
    } finally {
      setIsManualMfaWorking(false);
    }
  }

  async function testManualMfaSession() {
    setIsManualMfaWorking(true);
    setManualMfaStatus("");
    try {
      updateManualMfaFromResult(await invoke<ManualMfaSessionResult>("test_manual_mfa_session", {
        settings: trimNibiSettings(values),
      }), true);
    } catch (error) {
      setManualMfaStatus(error instanceof Error ? error.message : "Manual MFA session test could not run.");
    } finally {
      setIsManualMfaWorking(false);
    }
  }

  async function endManualMfaSession() {
    setIsManualMfaWorking(true);
    setManualMfaStatus("");
    try {
      updateManualMfaFromResult(await invoke<ManualMfaSessionResult>("end_manual_mfa_session", {
        settings: trimNibiSettings(values),
      }));
    } catch (error) {
      setManualMfaStatus(error instanceof Error ? error.message : "Manual MFA session could not be ended.");
    } finally {
      setIsManualMfaWorking(false);
    }
  }

  async function cleanStaleManualMfaSession() {
    setIsManualMfaWorking(true);
    setManualMfaStatus("");
    try {
      const result = await invoke<ManualMfaSessionResult>("clean_stale_manual_mfa_session", {
        settings: trimNibiSettings(values),
      });
      updateManualMfaFromResult(result);
    } catch (error) {
      setManualMfaStatus(error instanceof Error ? error.message : "Stale WSL session cleanup could not run.");
    } finally {
      setIsManualMfaWorking(false);
    }
  }

  function getCheckClassName(status: NibiConnectionCheck["status"]) {
    return `check-${status.replaceAll("_", "-")}`;
  }

  function getCheckBadge(status: NibiConnectionCheck["status"]) {
    if (status === "interactive_login_required") {
      return "LOGIN";
    }
    return status.toUpperCase();
  }

  return (
    <div className="page narrow-page">
      <header className="page-header">
        <p className="eyebrow">Preferences</p>
        <h1>Settings</h1>
        <p>Configure the local workspace appearance and how FluorCast will connect to NIBI.</p>
      </header>

      <form className="form-card settings-section" aria-labelledby="nibi-heading" onSubmit={handleSubmit}>
        <div className="section-heading">
          <h2 id="nibi-heading">NIBI settings</h2>
          <span>Local only</span>
        </div>

        <label>
          <span>Connection mode</span>
          <select
            aria-describedby="connection_mode-help connection_mode-error"
            aria-invalid={errors.connection_mode ? "true" : "false"}
            name="connection_mode"
            onChange={(event) => updateField("connection_mode", event.target.value)}
            value={values.connection_mode}
          >
            <option value="mock">Mock mode</option>
            <option value="interactive_mfa">Manual MFA login</option>
            <option value="robot_automation">Robot automation</option>
          </select>
          {errors.connection_mode ? (
            <span className="field-error" id="connection_mode-error">
              {errors.connection_mode}
            </span>
          ) : null}
          <small className="field-help" id="connection_mode-help">
            Mock mode: local UI testing only.
            <br />
            Manual MFA login: user logs into nibi.alliancecan.ca each app session with password and Duo; app reuses the session where possible.
            <br />
            Robot automation: app connects to robot.nibi.alliancecan.ca using a restricted SSH key after Alliance enables robot-node access.
          </small>
        </label>

        <section className="connection-status-panel" aria-label="Connection status">
          <span>Selected mode: {connectionStatus.mode}</span>
          <strong>{connectionStatus.label}</strong>
          <p>{connectionStatus.message}</p>
        </section>

        <div className="field-row">
          <label>
            <span>NIBI username</span>
            <input
              aria-describedby="nibi_username-error"
              aria-invalid={errors.nibi_username ? "true" : "false"}
              name="nibi_username"
              onChange={(event) => updateField("nibi_username", event.target.value)}
              placeholder="Alliance username"
              value={values.nibi_username}
            />
            {errors.nibi_username ? (
              <span className="field-error" id="nibi_username-error">
                {errors.nibi_username}
              </span>
            ) : null}
          </label>

          <label>
            <span>Normal login host</span>
            <input
              aria-describedby="normal_login_host-error"
              aria-invalid={errors.normal_login_host ? "true" : "false"}
              name="normal_login_host"
              onChange={(event) => updateField("normal_login_host", event.target.value)}
              value={values.normal_login_host}
            />
            {errors.normal_login_host ? (
              <span className="field-error" id="normal_login_host-error">
                {errors.normal_login_host}
              </span>
            ) : null}
          </label>
        </div>

        <label>
          <span>Robot login host</span>
          <input
            aria-describedby="robot_login_host-error"
            aria-invalid={errors.robot_login_host ? "true" : "false"}
            name="robot_login_host"
            onChange={(event) => updateField("robot_login_host", event.target.value)}
            value={values.robot_login_host}
          />
          {errors.robot_login_host ? (
            <span className="field-error" id="robot_login_host-error">
              {errors.robot_login_host}
            </span>
          ) : null}
        </label>

        <label>
          <span>Private SSH key file</span>
          <div className="field-with-button">
            <input
              aria-describedby="ssh_private_key_path-help ssh_private_key_path-error ssh_private_key_path-warning"
              aria-invalid={errors.ssh_private_key_path ? "true" : "false"}
              name="ssh_private_key_path"
              onChange={(event) => updateField("ssh_private_key_path", event.target.value)}
              placeholder="C:\\Users\\you\\.ssh\\id_ed25519"
              value={values.ssh_private_key_path}
            />
            <button
              className="secondary-button"
              disabled={isBrowsingSshKey}
              onClick={browseSshKeyPath}
              type="button"
            >
              {isBrowsingSshKey ? "Opening..." : "Browse..."}
            </button>
          </div>
          {errors.ssh_private_key_path ? (
            <span className="field-error" id="ssh_private_key_path-error">
              {errors.ssh_private_key_path}
            </span>
          ) : null}
          {warnings.ssh_private_key_path ? (
            <span className="field-warning" id="ssh_private_key_path-warning">
              {warnings.ssh_private_key_path}
            </span>
          ) : null}
          <small className="field-help" id="ssh_private_key_path-help">
            Choose your private SSH key file used to connect to NIBI.
            <br />
            <br />
            On Windows this is usually:
            <br />
            <code>C:\Users\&lt;your Windows username&gt;\.ssh\id_ed25519</code>
            <br />
            <br />
            If you created a FluorCast-specific key, it may be:
            <br />
            <code>C:\Users\&lt;your Windows username&gt;\.ssh\fluorcast_nibi_ed25519</code>
            <br />
            <br />
            Do not choose the .pub file. The .pub file is the public key uploaded to
            Alliance/CCDB. The private key stays on your computer and is used by this app to
            connect to NIBI.
          </small>
        </label>

        <div className="field-row">
          <label>
            <span>WSL private key path</span>
            <input
              name="wsl_ssh_private_key_path"
              onChange={(event) => updateField("wsl_ssh_private_key_path", event.target.value)}
              value={values.wsl_ssh_private_key_path}
            />
          </label>
          <label>
            <span>WSL control socket path</span>
            <input
              name="wsl_control_socket_path"
              onChange={(event) => updateField("wsl_control_socket_path", event.target.value)}
              value={values.wsl_control_socket_path}
            />
          </label>
        </div>

        <label>
          <span>WSL distro</span>
          <input
            name="manual_mfa_wsl_distro"
            onChange={(event) => updateField("manual_mfa_wsl_distro", event.target.value)}
            placeholder="Ubuntu"
            value={values.manual_mfa_wsl_distro}
          />
          <small>Use Ubuntu by default. Leave blank to use the default WSL distro.</small>
        </label>

        <details className="help-disclosure">
          <summary>How to upload your SSH public key to Alliance/CCDB</summary>
          <div>
            <p>
              FluorCast and Alliance need different parts of the same SSH key pair.
              <br />
              <br />
              FluorCast uses the private key path on your computer.
              <br />
              Alliance/CCDB needs the public key text pasted into the Manage SSH Keys page.
              <br />
              <br />
              Never paste or upload your private key.
            </p>

            <div className="key-help-grid">
              <section>
                <h4>FluorCast app</h4>
                <ul>
                  <li>Use the private key file.</li>
                  <li>This file stays on your computer.</li>
                  <li>Do not paste this file into Alliance/CCDB.</li>
                </ul>
                <pre>C:\Users\&lt;your Windows username&gt;\.ssh\id_ed25519</pre>
              </section>
              <section>
                <h4>Alliance/CCDB</h4>
                <ul>
                  <li>Paste the public key text.</li>
                  <li>The text usually starts with <code>ssh-ed25519</code> or <code>ssh-rsa</code>.</li>
                </ul>
                <pre>C:\Users\&lt;your Windows username&gt;\.ssh\id_ed25519.pub</pre>
              </section>
            </div>

            <p>Check existing keys:</p>
            <pre>dir $env:USERPROFILE\.ssh</pre>
            <p>Show your public key:</p>
            <pre>Get-Content "$env:USERPROFILE\.ssh\id_ed25519.pub"</pre>
            <p>Copy your public key to clipboard:</p>
            <pre>Get-Content "$env:USERPROFILE\.ssh\id_ed25519.pub" | Set-Clipboard</pre>
            <p>If the .pub file is missing, recreate it from the private key:</p>
            <pre>ssh-keygen -y -f "$env:USERPROFILE\.ssh\id_ed25519" | Set-Content "$env:USERPROFILE\.ssh\id_ed25519.pub"</pre>

            <p>On the Alliance/CCDB Manage SSH Keys page:</p>
            <ol className="help-steps">
              <li>Paste the copied public key text into the SSH Key box.</li>
              <li>Add a description, for example: FluorCast NIBI key - Windows laptop.</li>
              <li>Click Add Key.</li>
              <li>Wait a few minutes before testing login.</li>
            </ol>
            <a
              className="secondary-button help-link-button"
              href="https://ccdb.alliancecan.ca/ssh_authorized_keys"
              rel="noreferrer"
              target="_blank"
            >
              Open Alliance Manage SSH Keys
            </a>

            <p className="warning-callout">
              Do not paste your private key into Alliance/CCDB. The private key is the file
              without .pub, for example id_ed25519. Only paste the public key, usually
              id_ed25519.pub.
            </p>

            <p>After uploading the public key, test login from PowerShell:</p>
            <pre>ssh -i "$env:USERPROFILE\.ssh\id_ed25519" -o IdentitiesOnly=yes &lt;your_alliance_username&gt;@nibi.alliancecan.ca</pre>
            <ul>
              <li>If it asks for a key passphrase, your private key is being used.</li>
              <li>If it asks for Duo/MFA, authentication has reached the interactive MFA step.</li>
              <li>If it still asks for your account password, the uploaded public key may not be active yet or may not match the selected private key.</li>
              <li>If it says Permission denied, check username, private key path, uploaded public key, and MFA setup.</li>
            </ul>

            <h4>Create a FluorCast-specific key</h4>
            <p>This is optional, but keeps the FluorCast NIBI key separate from other SSH keys.</p>
            <pre>ssh-keygen -t ed25519 -a 100 -f "$env:USERPROFILE\.ssh\fluorcast_nibi_ed25519" -C "fluorcast-nibi"</pre>
            <p>Use this private key path in FluorCast:</p>
            <pre>C:\Users\&lt;your Windows username&gt;\.ssh\fluorcast_nibi_ed25519</pre>
            <p>Upload this public key text to Alliance/CCDB:</p>
            <pre>C:\Users\&lt;your Windows username&gt;\.ssh\fluorcast_nibi_ed25519.pub</pre>
            <p>Copy the FluorCast-specific public key to clipboard:</p>
            <pre>Get-Content "$env:USERPROFILE\.ssh\fluorcast_nibi_ed25519.pub" | Set-Clipboard</pre>
          </div>
        </details>

        <details className="help-disclosure">
          <summary>How do I create an SSH key?</summary>
          <div>
            <p>Check existing keys:</p>
            <pre>dir $env:USERPROFILE\.ssh</pre>
            <p>Create a FluorCast-specific key:</p>
            <pre>ssh-keygen -t ed25519 -a 100 -f "$env:USERPROFILE\.ssh\fluorcast_nibi_ed25519" -C "fluorcast-nibi"</pre>
            <p>Use this private key path in FluorCast:</p>
            <pre>C:\Users\&lt;your Windows username&gt;\.ssh\fluorcast_nibi_ed25519</pre>
            <p>Upload this public key to Alliance/CCDB:</p>
            <pre>C:\Users\&lt;your Windows username&gt;\.ssh\fluorcast_nibi_ed25519.pub</pre>
          </div>
        </details>

        <details className="help-disclosure">
          <summary>How do I test my key?</summary>
          <div>
            <pre>ssh -i "$env:USERPROFILE\.ssh\fluorcast_nibi_ed25519" &lt;your_alliance_username&gt;@nibi.alliancecan.ca</pre>
          </div>
        </details>

        <label>
          <span>Remote project path</span>
          <input
            aria-describedby="remote_project_path-error"
            aria-invalid={errors.remote_project_path ? "true" : "false"}
            name="remote_project_path"
            onChange={(event) => updateField("remote_project_path", event.target.value)}
            value={values.remote_project_path}
          />
          {errors.remote_project_path ? (
            <span className="field-error" id="remote_project_path-error">
              {errors.remote_project_path}
            </span>
          ) : null}
        </label>

        <label>
          <span>Remote jobs path</span>
          <input
            aria-describedby="remote_jobs_path-error"
            aria-invalid={errors.remote_jobs_path ? "true" : "false"}
            name="remote_jobs_path"
            onChange={(event) => updateField("remote_jobs_path", event.target.value)}
            value={values.remote_jobs_path}
          />
          {errors.remote_jobs_path ? (
            <span className="field-error" id="remote_jobs_path-error">
              {errors.remote_jobs_path}
            </span>
          ) : null}
        </label>

        <label>
          <span>Python environment path</span>
          <input
            aria-describedby="python_environment_path-error"
            aria-invalid={errors.python_environment_path ? "true" : "false"}
            name="python_environment_path"
            onChange={(event) => updateField("python_environment_path", event.target.value)}
            value={values.python_environment_path}
          />
          {errors.python_environment_path ? (
            <span className="field-error" id="python_environment_path-error">
              {errors.python_environment_path}
            </span>
          ) : null}
        </label>

        <label>
          <span>Default model choice</span>
          <select
            aria-describedby="default_model_choice-error"
            aria-invalid={errors.default_model_choice ? "true" : "false"}
            name="default_model_choice"
            onChange={(event) => updateField("default_model_choice", event.target.value)}
            value={values.default_model_choice}
          >
            <option value="">Select a model</option>
            {modelChoices.map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.label}
              </option>
            ))}
          </select>
          {errors.default_model_choice ? (
            <span className="field-error" id="default_model_choice-error">
              {errors.default_model_choice}
            </span>
          ) : null}
        </label>

        <p className="settings-note">
          FluorCast does not store your NIBI password. SSH keys remain on your computer.
        </p>

        <section className="manual-login-panel" aria-labelledby="manual-login-heading">
          <div>
            <h3 id="manual-login-heading">Manual MFA Login</h3>
            <p>
              Start an interactive NIBI SSH login in PowerShell, enter your password and
              Duo/MFA there, then test whether FluorCast can reuse the SSH control session for
              background commands.
            </p>
            <p>
              If no terminal window appears, copy the Raw WSL login command, open PowerShell,
              run <code>wsl -d {values.manual_mfa_wsl_distro || "Ubuntu"}</code>, paste the command,
              complete Duo, then return here and click Test authenticated session.
            </p>
          </div>
          <div className="diagnostic-grid">
            <div><span className="step-label">Normal login host</span><code>{values.normal_login_host || "Not configured"}</code></div>
            <div><span className="step-label">Username</span><code>{values.nibi_username || "Not configured"}</code></div>
            <div><span className="step-label">Private key path</span><code>{values.ssh_private_key_path || "Not configured"}</code></div>
            <div><span className="step-label">Manual MFA SSH backend</span><strong>WSL</strong></div>
            <div><span className="step-label">WSL key path</span><code>{values.wsl_ssh_private_key_path}</code></div>
            <div><span className="step-label">WSL distro</span><code>{values.manual_mfa_wsl_distro || "Default WSL"}</code></div>
            <div><span className="step-label">Login status</span><strong>{manualMfaSession.status.replaceAll("_", " ")}</strong></div>
            <div><span className="step-label">Control path</span><code>{manualMfaSession.control_path || manualMfaCommands?.control_path || "Created when login starts"}</code></div>
            <div><span className="step-label">Background commands</span><strong>{manualMfaSession.can_run_background_commands ? "Ready" : "Blocked"}</strong></div>
          </div>
          {manualMfaCommands ? (
            <pre>{manualMfaCommands.redacted_login_command_preview}</pre>
          ) : (
            <pre>{manualSshCommand}</pre>
          )}
          <div className="button-row manual-login-actions">
            <button className="secondary-button" onClick={copyManualMfaLoginCommand} type="button">
              Copy login command
            </button>
            <button className="secondary-button" disabled={isManualMfaWorking} onClick={startManualMfaLogin} type="button">
              Start manual NIBI login
            </button>
            <button className="secondary-button" disabled={isManualMfaWorking} onClick={cleanStaleManualMfaSession} type="button">
              Clean stale WSL session
            </button>
            <button className="secondary-button" disabled={isManualMfaWorking} onClick={testManualMfaSession} type="button">
              Test authenticated session
            </button>
            <button className="secondary-button" disabled={isManualMfaWorking} onClick={endManualMfaSession} type="button">
              End NIBI session
            </button>
          </div>
          <div className="button-row manual-login-actions">
            <button className="secondary-button" onClick={copyManualSshCommand} type="button">
              Copy manual SSH command
            </button>
            <button className="secondary-button" onClick={openPowerShellLogin} type="button">
              Open PowerShell login
            </button>
          </div>
          <label className="checkbox-label">
            <input
              checked={values.manual_login_verified}
              name="manual_login_verified"
              onChange={(event) => updateBooleanField("manual_login_verified", event.target.checked)}
              type="checkbox"
            />
            <span>Manual SSH login works in PowerShell</span>
          </label>
          {manualCommandStatus ? (
            <p className="connection-test-status" role="status">
              {manualCommandStatus}
            </p>
          ) : null}
          {manualMfaStatus || manualMfaSession.last_session_test_result ? (
            <p className="connection-test-status" role="status">
              {manualMfaStatus || manualMfaSession.last_session_test_result}
            </p>
          ) : null}
          {manualMfaCommands ? (
            <details className="help-disclosure">
              <summary>WSL Manual MFA debug commands</summary>
              <div>
                <p>WSL setup key commands:</p>
                <pre>{manualMfaCommands.wsl_setup_key_commands}</pre>
                <p>Clean stale session command:</p>
                <pre>{manualMfaCommands.clean_stale_session_command}</pre>
                <p>Start login script path:</p>
                <pre>{manualMfaCommands.start_script_path}</pre>
                <p>Manual WSL login command:</p>
                <pre>{manualMfaCommands.manual_wsl_login_command}</pre>
                <p>Start master login script content:</p>
                <pre>{manualMfaCommands.login_command}</pre>
                <p>Open with Windows Terminal command:</p>
                <pre>{manualMfaCommands.windows_terminal_command}</pre>
                <p>Open with PowerShell command:</p>
                <pre>{manualMfaCommands.powershell_launch_command}</pre>
                <p>Raw WSL login command:</p>
                <pre>{manualMfaCommands.login_command}</pre>
                <p>Check master command:</p>
                <pre>{manualMfaCommands.check_command}</pre>
                <p>Check master script content:</p>
                <pre>{manualMfaCommands.check_script_content}</pre>
                <p>Test FLUORCAST_AUTH_OK command:</p>
                <pre>{manualMfaCommands.test_command}</pre>
                <p>End session command:</p>
                <pre>{manualMfaCommands.end_command}</pre>
                <p>End session script content:</p>
                <pre>{manualMfaCommands.end_script_content}</pre>
                <p>Clean stale session script content:</p>
                <pre>{manualMfaCommands.clean_script_content}</pre>
                <p>Background command template:</p>
                <pre>{manualMfaCommands.background_command_template}</pre>
              </div>
            </details>
          ) : null}
        </section>

        <label className="checkbox-label">
          <input
            checked={values.robot_access_verified}
            name="robot_access_verified"
            onChange={(event) => updateBooleanField("robot_access_verified", event.target.checked)}
            type="checkbox"
          />
          <span>Robot automation access has been verified</span>
        </label>

        <section className="connection-test-panel" aria-labelledby="nibi-test-heading">
          <div>
            <h3 id="nibi-test-heading">Non-interactive automation test</h3>
            <p>
              This test checks whether FluorCast can run remote commands without asking for a
              password or Duo prompt. Manual SSH login may work even if this automation test fails.
              No prediction jobs are submitted.
            </p>
          </div>
          <button
            className="secondary-button"
            disabled={isTestingConnection}
            onClick={testNibiConnection}
            type="button"
          >
            {isTestingConnection ? "Testing..." : "Test NIBI Connection"}
          </button>
          {connectionTestStatus ? (
            <p className="connection-test-status" role="status">
              {connectionTestStatus}
            </p>
          ) : null}
          {connectionChecks.length > 0 ? (
            <ol className="connection-checklist" aria-label="NIBI connection test results">
              {connectionChecks.map((check) => (
                <li className={getCheckClassName(check.status)} key={check.id}>
                  <span aria-hidden="true">{getCheckBadge(check.status)}</span>
                  <div>
                    <strong>{check.label}</strong>
                    <p>{check.message}</p>
                  </div>
                </li>
              ))}
            </ol>
          ) : null}
        </section>

        <div className="form-actions">
          <span>{saveStatus || "Settings are stored locally on this device."}</span>
          <div className="button-row">
            <button className="secondary-button" onClick={resetSuggestedDefaults} type="button">
              Reset suggested values
            </button>
            <button className="primary-button" disabled={isSaving} type="submit">
              {isSaving ? "Saving settings" : "Save settings"}
            </button>
          </div>
        </div>
      </form>

      <details className="form-card appearance-panel" aria-labelledby="appearance-heading">
        <summary className="appearance-summary">
          <span id="appearance-heading">Appearance</span>
          <span>Local</span>
        </summary>
        <label>
          <span>Accent color</span>
          <div className="accent-controls">
            <div className="accent-grid" role="group" aria-label="Accent presets">
              {accentPresets.map((preset) => (
                <button
                  aria-label={`${preset.name} accent`}
                  aria-pressed={accentColor.toLowerCase() === preset.value}
                  className="accent-swatch"
                  key={preset.value}
                  onClick={() => onAccentColorChange(preset.value)}
                  style={{ backgroundColor: preset.value }}
                  type="button"
                />
              ))}
            </div>
            <input
              aria-label="Custom accent color"
              className="color-input"
              onChange={(event) => onAccentColorChange(event.target.value)}
              type="color"
              value={accentColor}
            />
          </div>
          <small>Accent color controls primary actions, active navigation, and key highlights.</small>
        </label>

        <label>
          <span>Secondary color</span>
          <div className="accent-controls">
            <div className="accent-grid" role="group" aria-label="Secondary color presets">
              {secondaryPresets.map((preset) => (
                <button
                  aria-label={`${preset.name} secondary`}
                  aria-pressed={secondaryColor.toLowerCase() === preset.value}
                  className="accent-swatch secondary-swatch"
                  key={preset.value}
                  onClick={() => onSecondaryColorChange(preset.value)}
                  style={{ backgroundColor: preset.value }}
                  type="button"
                />
              ))}
            </div>
            <input
              aria-label="Custom secondary color"
              className="color-input"
              onChange={(event) => onSecondaryColorChange(event.target.value)}
              type="color"
              value={secondaryColor}
            />
          </div>
          <small>Secondary color supports quieter buttons, cards, badges, and helper panels.</small>
        </label>
      </details>
    </div>
  );
}
