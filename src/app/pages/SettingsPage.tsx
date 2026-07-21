import type { FormEvent } from "react";
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { homeDir, join } from "@tauri-apps/api/path";
import { open } from "@tauri-apps/plugin-dialog";
import {
  defaultNibiSettings,
  buildAllianceSupportRequest,
  buildManualSshCommand,
  trimNibiSettings,
  validateNibiSettings,
  validateNibiSettingsWarnings,
  type ConnectionMode,
  type NibiSettings,
  type NibiSettingsErrors,
} from "../../features/settings";
import {
  buildManualMfaSessionCommands,
  buildRemoteEnvironmentCheckDefinitions,
  createInitialRemoteEnvironmentRows,
  createRemoteExecutor,
  defaultManualMfaSessionState,
  getRemoteEnvironmentReadiness,
  InteractiveMfaRemoteExecutor,
  resultToRemoteEnvironmentRow,
  validateRemoteEnvironmentLocalInputs,
  applyManualMfaSessionResult,
  applyManualMfaTerminalLaunchResult,
  type RemoteEnvironmentCheckRow,
} from "../../lib/remote";
import type {
  ManualMfaSessionCommands,
  ManualMfaSessionResult,
  ManualMfaTerminalLaunchResult,
  ManualMfaSessionUiState,
  LocalSshCapabilitiesResult,
  RemoteCommandResult,
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

type RobotPublicKeyResult = {
  restricted_public_key: string;
  public_key_path: string;
};

type RobotAutomationTestResult = {
  status: "passed" | "robot_not_ready" | "failed";
  message: string;
  robot_access_verified: boolean;
  redacted_command_preview: string;
  stdout: string;
  stderr: string;
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
  const [manualCommandStatus, setManualCommandStatus] = useState("");
  const [manualMfaCommands, setManualMfaCommands] = useState<ManualMfaSessionCommands | null>(null);
  const [manualMfaStatus, setManualMfaStatus] = useState("");
  const [localSshCapabilities, setLocalSshCapabilities] = useState<LocalSshCapabilitiesResult | null>(null);
  const [isManualMfaWorking, setIsManualMfaWorking] = useState(false);
  const startManualMfaLaunchInFlightRef = useRef(false);
  const [restrictedPublicKey, setRestrictedPublicKey] = useState("");
  const [restrictedPublicKeyStatus, setRestrictedPublicKeyStatus] = useState("");
  const [robotTestStatus, setRobotTestStatus] = useState("");
  const [robotCommandPreview, setRobotCommandPreview] = useState("");
  const [isTestingRobotAutomation, setIsTestingRobotAutomation] = useState(false);
  const [remoteEnvironmentRows, setRemoteEnvironmentRows] = useState<RemoteEnvironmentCheckRow[]>(
    () => createInitialRemoteEnvironmentRows(nibiSettings),
  );
  const [remoteEnvironmentStatus, setRemoteEnvironmentStatus] = useState("");
  const [isRunningRemoteEnvironmentChecks, setIsRunningRemoteEnvironmentChecks] = useState(false);
  const [isRemoteEnvironmentOpen, setIsRemoteEnvironmentOpen] = useState(false);

  const warnings = validateNibiSettingsWarnings(values);
  const manualSshCommand = buildManualSshCommand(values);
  const displayedManualMfaCommands = values.connection_mode === "interactive_mfa"
    ? manualMfaCommands ?? buildManualMfaSessionCommands(values)
    : null;
  const remoteExecutor = createRemoteExecutor(values.connection_mode);
  const connectionStatus = remoteExecutor.getConnectionStatus(values);

  useEffect(() => {
    setValues(nibiSettings);
  }, [nibiSettings]);

  function updateField(field: keyof NibiSettings, value: string) {
    const typedValue = field === "connection_mode"
      ? (value as ConnectionMode)
      : field === "manual_mfa_provider"
      ? (value as NibiSettings["manual_mfa_provider"])
      : value;
    setValues((current) => ({
      ...current,
      [field]: typedValue,
    }));
    setErrors((current) => ({ ...current, [field]: undefined }));
    setSaveStatus("");
    setManualCommandStatus("");
    setRestrictedPublicKeyStatus("");
    setRobotTestStatus("");
    setRobotCommandPreview("");
    setRemoteEnvironmentStatus("");
    setRemoteEnvironmentRows(createInitialRemoteEnvironmentRows({
      ...values,
      [field]: typedValue,
    }));
  }

  function updateBooleanField(field: "robot_access_verified", value: boolean) {
    setValues((current) => ({
      ...current,
      [field]: value,
    }));
    setSaveStatus("");
    setRobotTestStatus("");
    setRobotCommandPreview("");
    setRemoteEnvironmentStatus("");
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
    setManualCommandStatus("");
    setRestrictedPublicKey("");
    setRestrictedPublicKeyStatus("");
    setRobotTestStatus("");
    setRobotCommandPreview("");
    setRemoteEnvironmentStatus("");
    setRemoteEnvironmentRows(createInitialRemoteEnvironmentRows(defaultNibiSettings));
  }

  function createFailedRemoteEnvironmentResult(label: string, message: string): RemoteCommandResult {
    return {
      exit_code: 1,
      stdout: "",
      stderr: message,
      duration_ms: 0,
      command_label: label,
      redacted_command_preview: label,
    };
  }

  function createSessionReadinessRemoteEnvironmentResult(result: ManualMfaSessionResult): RemoteCommandResult {
    return {
      exit_code: result.can_run_background_commands ? 0 : result.last_session_test_exit_code ?? 1,
      stdout: result.last_session_test_stdout,
      stderr: result.can_run_background_commands ? "" : result.message || result.last_session_test_stderr,
      duration_ms: 0,
      command_label: "Authenticated session reuse",
      redacted_command_preview: result.redacted_command_preview,
      timed_out: result.status === "timeout",
    };
  }

  async function runRemoteEnvironmentChecks() {
    const trimmed = trimNibiSettings(values);
    const isConnectionReady = isManualMfaMode
      ? manualMfaSession.status === "authenticated" || manualMfaSession.can_run_background_commands
      : isRobotAutomationMode && trimmed.robot_access_verified;
    const localValidation = validateRemoteEnvironmentLocalInputs(trimmed, isConnectionReady);
    setRemoteEnvironmentStatus("");

    if (!localValidation.valid) {
      setRemoteEnvironmentStatus(localValidation.messages.join(" "));
      return;
    }

    const definitions = buildRemoteEnvironmentCheckDefinitions(trimmed);
    setRemoteEnvironmentRows(definitions.map((definition) => ({
      ...definition,
      status: "not_run",
      message: "Not run.",
    })));
    setIsRunningRemoteEnvironmentChecks(true);

    const completedRows: RemoteEnvironmentCheckRow[] = [];
    const executor = createRemoteExecutor(trimmed.connection_mode);
    if (executor instanceof InteractiveMfaRemoteExecutor) {
      executor.setAuthenticated(isConnectionReady);
    }
    let stoppedAfterReadinessFailure = false;
    try {
      for (const definition of definitions) {
        setRemoteEnvironmentRows((current) => current.map((row) => (
          row.id === definition.id
            ? { ...row, status: "running", message: "Running..." }
            : row
        )));

        let result: RemoteCommandResult;
        if (definition.id === "authenticated_session") {
          const readiness = await invoke<ManualMfaSessionResult>("test_manual_mfa_session", {
            settings: trimmed,
          });
          updateManualMfaFromResult(readiness, true);
          result = createSessionReadinessRemoteEnvironmentResult(readiness);
        } else {
          try {
          result = await executor.runCommand(definition.commandSpec);
          } catch (error) {
            result = createFailedRemoteEnvironmentResult(
              definition.name,
              error instanceof Error ? error.message : "Remote environment check could not run.",
            );
          }
        }

        const completedRow = resultToRemoteEnvironmentRow(definition, result);
        completedRows.push(completedRow);
        setRemoteEnvironmentRows((current) => current.map((row) => (
          row.id === definition.id ? completedRow : row
        )));

        if (definition.id === "authenticated_session" && completedRow.status !== "passed") {
          setRemoteEnvironmentStatus("Authenticated session reuse failed. Remote environment checks were not run.");
          stoppedAfterReadinessFailure = true;
          break;
        }
      }

      if (!stoppedAfterReadinessFailure) {
        setRemoteEnvironmentStatus(getRemoteEnvironmentReadiness(completedRows).summary);
      }
    } finally {
      setIsRunningRemoteEnvironmentChecks(false);
      void executor.dispose();
    }
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

  async function copyManualSshCommand() {
    setManualCommandStatus("");
    try {
      await navigator.clipboard.writeText(manualSshCommand);
      setManualCommandStatus("Manual SSH command copied.");
    } catch {
      setManualCommandStatus("Copy failed. Select the command and copy it manually.");
    }
  }

  async function refreshRestrictedPublicKey() {
    setRestrictedPublicKeyStatus("");
    try {
      const result = await invoke<RobotPublicKeyResult>("get_restricted_robot_public_key", {
        settings: trimNibiSettings(values),
      });
      setRestrictedPublicKey(result.restricted_public_key);
      setRestrictedPublicKeyStatus(`Restricted public key loaded from ${result.public_key_path}.`);
      return result.restricted_public_key;
    } catch (error) {
      setRestrictedPublicKey("");
      setRestrictedPublicKeyStatus(
        error instanceof Error ? error.message : "Could not generate the restricted public key.",
      );
      return "";
    }
  }

  async function copyRestrictedPublicKey() {
    const key = restrictedPublicKey || await refreshRestrictedPublicKey();
    if (!key) {
      return;
    }
    try {
      await navigator.clipboard.writeText(key);
      setRestrictedPublicKeyStatus("Restricted public key copied. Only upload this restricted public key to CCDB.");
    } catch {
      setRestrictedPublicKeyStatus("Copy failed. Select the restricted public key and copy it manually.");
    }
  }

  async function copyAllianceSupportRequest() {
    setRestrictedPublicKeyStatus("");
    try {
      await navigator.clipboard.writeText(buildAllianceSupportRequest(values));
      setRestrictedPublicKeyStatus("Alliance support request copied.");
    } catch {
      setRestrictedPublicKeyStatus("Copy failed. Select the support request and copy it manually.");
    }
  }

  async function testRobotAutomation() {
    const trimmed = trimNibiSettings({ ...values, connection_mode: "robot_automation" });
    const nextErrors = validateNibiSettings(trimmed);
    setErrors(nextErrors);
    setRobotTestStatus("");
    setRobotCommandPreview("");

    if (Object.keys(nextErrors).length > 0) {
      setRobotTestStatus("Fix the highlighted robot automation settings before testing.");
      return;
    }

    setIsTestingRobotAutomation(true);
    try {
      const result = await invoke<RobotAutomationTestResult>("test_robot_automation", {
        settings: trimmed,
      });
      setRobotCommandPreview(result.redacted_command_preview);
      setRobotTestStatus(result.message);
      if (result.robot_access_verified) {
        const nextSettings = {
          ...trimmed,
          robot_access_verified: true,
        };
        setValues(nextSettings);
        void onNibiSettingsSave(nextSettings);
      }
    } catch (error) {
      setRobotTestStatus(error instanceof Error ? error.message : "Robot automation test could not run.");
    } finally {
      setIsTestingRobotAutomation(false);
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
    const nextSession = applyManualMfaSessionResult(manualMfaSession, result, { canMarkAuthenticated });
    onManualMfaSessionChange(nextSession);
    setManualMfaStatus(result.message);
    if (nextSession.can_run_background_commands) {
      const nextSettings = {
        ...trimNibiSettings(values),
        manual_login_verified: true,
        last_manual_login_check_at: nextSession.last_successful_command_at,
      };
      setValues(nextSettings);
      void onNibiSettingsSave(nextSettings);
    }
  }

  async function copyManualMfaLoginCommand() {
    setManualMfaStatus("");
    try {
      const commands = displayedManualMfaCommands ?? await invoke<ManualMfaSessionCommands>(
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

  async function copyManualMfaSessionTestCommand() {
    setManualMfaStatus("");
    try {
      const commands = displayedManualMfaCommands ?? await invoke<ManualMfaSessionCommands>(
        "get_manual_mfa_session_commands",
        { settings: trimNibiSettings(values) },
      );
      setManualMfaCommands(commands);
      await navigator.clipboard.writeText(commands.test_command);
      setManualMfaStatus("Manual MFA session test command copied.");
    } catch (error) {
      setManualMfaStatus(error instanceof Error ? error.message : "Copy failed. Select the command and copy it manually.");
    }
  }

  async function checkLocalSshCapabilities() {
    setIsManualMfaWorking(true);
    setManualMfaStatus("");
    try {
      const result = await invoke<LocalSshCapabilitiesResult>("check_local_ssh_capabilities");
      setLocalSshCapabilities(result);
      setManualMfaStatus(result.recommendation);
    } catch (error) {
      setManualMfaStatus(error instanceof Error ? error.message : "Could not check local SSH capabilities.");
    } finally {
      setIsManualMfaWorking(false);
    }
  }

  async function startManualMfaLogin() {
    if (startManualMfaLaunchInFlightRef.current) {
      return;
    }
    startManualMfaLaunchInFlightRef.current = true;
    setIsManualMfaWorking(true);
    setManualMfaStatus("Opening NIBI login terminal...");
    try {
      const launch = await invoke<ManualMfaTerminalLaunchResult>("open_manual_mfa_login", {
        settings: trimNibiSettings(values),
      });
      const commands = launch.commands;
      setManualMfaCommands(commands);
      onManualMfaSessionChange(applyManualMfaTerminalLaunchResult(manualMfaSession, launch));
      setManualMfaStatus(launch.message);
    } catch (error) {
      setManualMfaStatus(error instanceof Error ? error.message : "Could not open a terminal automatically. Copy the WSL login command and run it manually.");
    } finally {
      setIsManualMfaWorking(false);
      startManualMfaLaunchInFlightRef.current = false;
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

  const isMockMode = values.connection_mode === "mock";
  const isManualMfaMode = values.connection_mode === "interactive_mfa";
  const isRobotAutomationMode = values.connection_mode === "robot_automation";
  const isManualSessionReady = manualMfaSession.status === "authenticated"
    || manualMfaSession.can_run_background_commands;
  const isRobotAutomationReady = values.robot_access_verified;
  const nibiTarget = `${values.nibi_username || "<username>"}@${values.normal_login_host || "nibi.alliancecan.ca"}`;
  const resolvedWslUser = manualMfaSession.wsl_user || "Unknown until tested";
  const resolvedWslHome = manualMfaSession.wsl_home || "Unknown until tested";
  const resolvedControlPath = manualMfaSession.control_path
    || displayedManualMfaCommands?.control_path
    || "$HOME/.fluorcast/ssh/cm-nibi.sock";
  const mostRecentManualAction = manualMfaStatus || manualMfaSession.last_session_test_result || "No action run yet.";
  const canRunRemoteEnvironmentChecks = isManualMfaMode
    ? isManualSessionReady
    : isRobotAutomationMode && isRobotAutomationReady;
  const remoteEnvironmentDisabledMessage = isManualMfaMode && !isManualSessionReady
    ? "Log into NIBI first before running remote environment checks."
    : isRobotAutomationMode && !isRobotAutomationReady
    ? "Verify robot automation before running remote environment checks."
    : "";
  const remoteEnvironmentReadiness = getRemoteEnvironmentReadiness(remoteEnvironmentRows);
  const requiredRemoteEnvironmentFailures = remoteEnvironmentRows.filter((row) => (
    !row.optional && row.status === "failed"
  )).length;
  const remoteEnvironmentHasRun = remoteEnvironmentRows.some((row) => row.status !== "not_run");
  const remoteEnvironmentBadge = isRunningRemoteEnvironmentChecks
    ? "Running"
    : isManualMfaMode && !isManualSessionReady
    ? "Login required"
    : isRobotAutomationMode && !isRobotAutomationReady
    ? "Robot not verified"
    : !remoteEnvironmentHasRun
    ? "Not run"
    : remoteEnvironmentReadiness.ready
    ? "Ready"
    : "Needs attention";
  const remoteEnvironmentSummary = remoteEnvironmentDisabledMessage
    || (isRunningRemoteEnvironmentChecks
      ? "Running remote environment checks"
      : !remoteEnvironmentHasRun
      ? "Not run yet"
      : remoteEnvironmentReadiness.ready
      ? "Remote environment ready"
      : `${requiredRemoteEnvironmentFailures || 1} check${(requiredRemoteEnvironmentFailures || 1) === 1 ? "" : "s"} need attention`);
  const modeStatusSummary = isMockMode
    ? "Mock mode is active. Predictions are simulated locally."
    : isManualMfaMode
    ? isManualSessionReady
      ? "Manual NIBI session authenticated"
      : values.manual_login_verified
      ? "Session expired or not tested"
      : "Login required"
    : values.robot_access_verified
    ? "Robot automation verified"
    : robotTestStatus
    ? "Robot automation test failed"
    : "Robot access not configured";

  return (
    <div className="page narrow-page">
      <header className="page-header">
        <p className="eyebrow">Preferences</p>
        <h1>Settings</h1>
        <p>Configure the local workspace appearance and how FluorCast will connect to NIBI.</p>
      </header>

      <form className="form-card settings-section" aria-labelledby="connection-mode-heading" onSubmit={handleSubmit}>
        <div className="section-heading">
          <h2 id="connection-mode-heading">Connection Mode</h2>
          <span>Local only</span>
        </div>

        <fieldset className="connection-mode-grid" aria-describedby="connection_mode-error">
          <legend className="sr-only">Connection mode</legend>
          {[
            {
              value: "mock",
              label: "Mock mode",
              description: "Use local mock predictions for UI testing. No NIBI connection required.",
            },
            {
              value: "interactive_mfa",
              label: "Manual MFA login",
              description:
                "Log into nibi.alliancecan.ca with password and Duo each app session. Best for development/testing before robot access is enabled.",
            },
            {
              value: "robot_automation",
              label: "Robot automation",
              description:
                "Use robot.nibi.alliancecan.ca with a restricted SSH key after Alliance enables robot-node access. Best for production.",
            },
          ].map((mode) => (
            <label className="connection-mode-card" key={mode.value}>
              <input
                checked={values.connection_mode === mode.value}
                name="connection_mode"
                onChange={() => updateField("connection_mode", mode.value)}
                type="radio"
                value={mode.value}
              />
              <span>{mode.label}</span>
              <small>{mode.description}</small>
            </label>
          ))}
        </fieldset>
        {errors.connection_mode ? (
          <span className="field-error" id="connection_mode-error">
            {errors.connection_mode}
          </span>
        ) : null}

        <section className="connection-status-panel" aria-label="Mode status summary">
          <span>Selected mode: {connectionStatus.mode}</span>
          <strong>{modeStatusSummary}</strong>
          <p>{connectionStatus.message}</p>
        </section>

        {!isMockMode ? (
          <section className="settings-subsection" aria-labelledby="mode-specific-setup-heading">
            <div className="section-heading compact-heading">
              <h3 id="mode-specific-setup-heading">Mode-specific setup</h3>
              <span>{isManualMfaMode ? "Manual MFA" : "Robot"}</span>
            </div>
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

          {isManualMfaMode ? (
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
          ) : null}
            </div>
            {isManualMfaMode ? (
              <p className="settings-note">Password and Duo may be required each app session.</p>
            ) : null}
            {isManualMfaMode ? (
              <label>
                <span>WSL distribution</span>
                <input
                  name="manual_mfa_wsl_distro"
                  onChange={(event) => updateField("manual_mfa_wsl_distro", event.target.value)}
                  placeholder="Ubuntu"
                  value={values.manual_mfa_wsl_distro}
                />
                <small>Use the Ubuntu distribution that contains the NIBI SSH key.</small>
              </label>
            ) : null}
          </section>
        ) : null}

        {isRobotAutomationMode ? (
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
        ) : null}

        {isRobotAutomationMode ? (
        <div className="field-row">
          <label>
            <span>Robot key from= restriction</span>
            <input
              aria-describedby="robot_key_restriction_from-error"
              aria-invalid={errors.robot_key_restriction_from ? "true" : "false"}
              name="robot_key_restriction_from"
              onChange={(event) => updateField("robot_key_restriction_from", event.target.value)}
              value={values.robot_key_restriction_from}
            />
            {errors.robot_key_restriction_from ? (
              <span className="field-error" id="robot_key_restriction_from-error">
                {errors.robot_key_restriction_from}
              </span>
            ) : null}
          </label>

          <label>
            <span>Robot forced command</span>
            <input
              aria-describedby="robot_key_forced_command-error"
              aria-invalid={errors.robot_key_forced_command ? "true" : "false"}
              name="robot_key_forced_command"
              onChange={(event) => updateField("robot_key_forced_command", event.target.value)}
              value={values.robot_key_forced_command}
            />
            {errors.robot_key_forced_command ? (
              <span className="field-error" id="robot_key_forced_command-error">
                {errors.robot_key_forced_command}
              </span>
            ) : null}
          </label>
        </div>
        ) : null}

        {!isMockMode ? (
        <section className="settings-subsection" aria-labelledby="ssh-key-heading">
          <div className="section-heading compact-heading">
            <h3 id="ssh-key-heading">SSH key</h3>
            <span>{isManualMfaMode ? "WSL private key" : "Private key"}</span>
          </div>
        {isManualMfaMode ? (
        <label>
          <span>WSL private key path</span>
          <input
            aria-describedby="wsl_ssh_private_key_path-help wsl_ssh_private_key_path-error wsl_ssh_private_key_path-warning"
            aria-invalid={errors.wsl_ssh_private_key_path ? "true" : "false"}
            name="wsl_ssh_private_key_path"
            onChange={(event) => updateField("wsl_ssh_private_key_path", event.target.value)}
            placeholder="/home/<wsl-user>/.ssh/fluorcast_nibi_ed25519"
            value={values.wsl_ssh_private_key_path}
          />
          {errors.wsl_ssh_private_key_path ? (
            <span className="field-error" id="wsl_ssh_private_key_path-error">
              {errors.wsl_ssh_private_key_path}
            </span>
          ) : null}
          {warnings.wsl_ssh_private_key_path ? (
            <span className="field-warning" id="wsl_ssh_private_key_path-warning">
              {warnings.wsl_ssh_private_key_path}
            </span>
          ) : null}
          <small className="field-help" id="wsl_ssh_private_key_path-help">
            Use the absolute private-key path inside WSL. The tested path for this workstation is <code>/home/cl/.ssh/fluorcast_nibi_ed25519</code>.
          </small>
        </label>
        ) : null}
        {isRobotAutomationMode ? (
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
        ) : null}
        {isRobotAutomationMode ? (
          <div>
            <span className="step-label">Expected public key path</span>
            <code>{values.ssh_private_key_path ? `${values.ssh_private_key_path}.pub` : "Choose a private key first"}</code>
          </div>
        ) : null}
        {isRobotAutomationMode ? (
          <div>
            <span className="step-label">Restricted public key preview</span>
            <pre>{restrictedPublicKey || "Click Generate restricted public key to read <private_key_path>.pub and build the CCDB key text."}</pre>
          </div>
        ) : null}
        {isRobotAutomationMode ? (
          <div className="button-row manual-login-actions">
            <button className="secondary-button" onClick={refreshRestrictedPublicKey} type="button">
              Generate restricted public key
            </button>
            <button className="secondary-button" onClick={copyRestrictedPublicKey} type="button">
              Copy restricted public key
            </button>
          </div>
        ) : null}
        </section>
        ) : null}

        {isRobotAutomationMode ? (
        <>
        <details className="help-disclosure">
          <summary>{isRobotAutomationMode ? "How to upload public key to Alliance/CCDB" : "How to set up SSH key"}</summary>
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
        </>
        ) : null}

        {!isMockMode ? (
        <details className="help-disclosure remote-paths-section" open>
          <summary>Remote FluorCast paths</summary>
          <div>
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
          </div>
        </details>
        ) : null}

        {isRobotAutomationMode ? (
        <section className="remote-environment-panel" aria-labelledby="remote-environment-heading">
          <button
            aria-expanded={isRemoteEnvironmentOpen}
            className="remote-environment-summary"
            onClick={() => setIsRemoteEnvironmentOpen((current) => !current)}
            type="button"
          >
            <span id="remote-environment-heading">Remote Environment Checks</span>
            <span>{remoteEnvironmentSummary}</span>
            <span className={`remote-environment-badge remote-environment-badge-${remoteEnvironmentBadge.toLowerCase().replaceAll(" ", "-")}`}>
              {remoteEnvironmentBadge}
            </span>
          </button>
          {isRemoteEnvironmentOpen ? (
          <div className="remote-environment-content">
            <p>
              Verify the remote FluorCast project, jobs folder, Python environment,
              prediction scripts, and Slurm commands before upload or submission.
            </p>
          {remoteEnvironmentDisabledMessage ? (
            <p className="connection-test-status">{remoteEnvironmentDisabledMessage}</p>
          ) : null}
          {remoteEnvironmentStatus ? (
            <p className="connection-test-status" role="status">{remoteEnvironmentStatus}</p>
          ) : (
            <p className="connection-test-status" role="status">{remoteEnvironmentReadiness.summary}</p>
          )}
          <button
            className="secondary-button"
            disabled={!canRunRemoteEnvironmentChecks || isRunningRemoteEnvironmentChecks}
            onClick={runRemoteEnvironmentChecks}
            type="button"
          >
            {isRunningRemoteEnvironmentChecks ? "Running remote environment checks" : "Run remote environment checks"}
          </button>
          <ol className="remote-checklist" aria-label="Remote environment check results">
            {remoteEnvironmentRows.map((row) => (
              <li className={`remote-check-${row.status}`} key={row.id}>
                <div className="remote-check-row">
                  <div>
                    <strong>{row.name}</strong>
                    <p>{row.message}</p>
                  </div>
                  <span>{row.status.replaceAll("_", " ")}</span>
                </div>
                <details className="remote-check-details">
                  <summary>Technical details</summary>
                  <dl>
                    <dt>Command</dt>
                    <dd><code>{row.result?.redacted_command_preview || row.commandSpec.redacted_preview || row.commandSpec.executable}</code></dd>
                    <dt>Exit code</dt>
                    <dd>{row.result?.exit_code ?? "Not run"}</dd>
                    <dt>stdout</dt>
                    <dd><pre>{row.result?.stdout || "(empty)"}</pre></dd>
                    <dt>stderr</dt>
                    <dd><pre>{row.result?.stderr || "(empty)"}</pre></dd>
                  </dl>
                </details>
              </li>
            ))}
          </ol>
          </div>
          ) : null}
        </section>
        ) : null}

        {isMockMode ? (
        <section className="settings-subsection" aria-labelledby="mock-mode-heading">
          <div className="section-heading compact-heading">
            <h3 id="mock-mode-heading">Mode-specific setup</h3>
            <span>Mock</span>
          </div>
          <p className="settings-note">Mock mode uses local mock predictions for UI testing. No NIBI connection is required.</p>
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
        </section>
        ) : null}

        {!isMockMode ? (
        <p className="settings-note">
          FluorCast does not store your NIBI password. SSH keys remain on your computer.
        </p>
        ) : null}

        {isManualMfaMode ? (
        <section className="manual-login-panel" aria-labelledby="manual-login-heading">
          <div>
            <h3 id="manual-login-heading">NIBI Session</h3>
            <p>Start one WSL SSH ControlMaster session, then verify FluorCast can reuse it without another password or Duo prompt.</p>
          </div>

          <div className="diagnostic-grid">
            <div><span className="step-label">WSL distribution</span><code>{values.manual_mfa_wsl_distro || "Ubuntu"}</code></div>
            <div><span className="step-label">Resolved WSL user</span><code>{resolvedWslUser}</code></div>
            <div><span className="step-label">Resolved WSL HOME</span><code>{resolvedWslHome}</code></div>
            <div><span className="step-label">NIBI target</span><code>{nibiTarget}</code></div>
            <div><span className="step-label">Resolved ControlPath</span><code>{resolvedControlPath}</code></div>
            <div><span className="step-label">Session status</span><strong>{manualMfaSession.status.replaceAll("_", " ")}</strong></div>
            <div><span className="step-label">Most recent action result</span><strong>{mostRecentManualAction}</strong></div>
          </div>

          <div className="button-row manual-login-actions">
            <button className="secondary-button" disabled={isManualMfaWorking} onClick={cleanStaleManualMfaSession} type="button">
              Clean stale WSL session
            </button>
            <button className="secondary-button" disabled={isManualMfaWorking} onClick={startManualMfaLogin} type="button">
              Start NIBI session
            </button>
            <button className="secondary-button" disabled={isManualMfaWorking} onClick={testManualMfaSession} type="button">
              Test authenticated session
            </button>
            <button
              className="secondary-button"
              disabled={!canRunRemoteEnvironmentChecks || isRunningRemoteEnvironmentChecks}
              onClick={runRemoteEnvironmentChecks}
              type="button"
            >
              {isRunningRemoteEnvironmentChecks ? "Running remote environment checks" : "Run remote environment checks"}
            </button>
          </div>

          {manualMfaStatus || manualMfaSession.last_session_test_result ? (
            <p className="connection-test-status" role="status">
              {manualMfaStatus || manualMfaSession.last_session_test_result}
            </p>
          ) : null}
          {remoteEnvironmentDisabledMessage ? (
            <p className="connection-test-status">{remoteEnvironmentDisabledMessage}</p>
          ) : null}
          {remoteEnvironmentStatus ? (
            <p className="connection-test-status" role="status">{remoteEnvironmentStatus}</p>
          ) : null}

          <ol className="remote-checklist" aria-label="Remote environment check results">
            {remoteEnvironmentRows.map((row) => (
              <li className={`remote-check-${row.status}`} key={row.id}>
                <div className="remote-check-row">
                  <div>
                    <strong>{row.name}</strong>
                    <p>{row.message}</p>
                  </div>
                  <span>{row.status.replaceAll("_", " ")}</span>
                </div>
                <details className="remote-check-details">
                  <summary>Technical details</summary>
                  <dl>
                    <dt>Command</dt>
                    <dd><code>{row.result?.redacted_command_preview || row.commandSpec.redacted_preview || row.commandSpec.executable}</code></dd>
                    <dt>Exit code</dt>
                    <dd>{row.result?.exit_code ?? "Not run"}</dd>
                    <dt>stdout</dt>
                    <dd><pre>{row.result?.stdout || "(empty)"}</pre></dd>
                    <dt>stderr</dt>
                    <dd><pre>{row.result?.stderr || "(empty)"}</pre></dd>
                  </dl>
                </details>
              </li>
            ))}
          </ol>

          <details className="help-disclosure" data-testid="advanced-session-diagnostics">
            <summary>Advanced session diagnostics</summary>
            <div>
              <div className="button-row manual-login-actions">
                <button className="secondary-button" onClick={copyManualMfaLoginCommand} type="button">
                  Copy generated login script
                </button>
                <button className="secondary-button" onClick={copyManualMfaSessionTestCommand} type="button">
                  Copy generated session-test script
                </button>
                <button className="secondary-button" disabled={isManualMfaWorking} onClick={checkLocalSshCapabilities} type="button">
                  Debug: check legacy PowerShell SSH capabilities
                </button>
                <button className="secondary-button" onClick={copyManualSshCommand} type="button">
                  Debug: copy legacy PowerShell SSH command
                </button>
                <button className="secondary-button" onClick={openPowerShellLogin} type="button">
                  Debug: open legacy PowerShell SSH login
                </button>
              </div>
              {manualCommandStatus ? (
                <p className="connection-test-status" role="status">{manualCommandStatus}</p>
              ) : null}
              {displayedManualMfaCommands ? (
                <>
                  <p className="settings-note">Generated login script</p>
                  <pre>{displayedManualMfaCommands.login_command}</pre>
                  <p className="settings-note">Generated session-test script</p>
                  <pre>{displayedManualMfaCommands.test_command}</pre>
                  <p>Clean stale session script</p>
                  <pre>{displayedManualMfaCommands.clean_script_content}</pre>
                  <p>Open with Windows Terminal command</p>
                  <pre>{displayedManualMfaCommands.windows_terminal_command}</pre>
                  <p>Open with PowerShell command</p>
                  <pre>{displayedManualMfaCommands.powershell_launch_command}</pre>
                </>
              ) : null}
              <div className="diagnostic-grid">
                <div><span className="step-label">stdout</span><pre>{manualMfaSession.last_session_test_stdout || "(empty)"}</pre></div>
                <div><span className="step-label">stderr</span><pre>{manualMfaSession.last_session_test_stderr || "(empty)"}</pre></div>
                <div><span className="step-label">Exit code</span><strong>{manualMfaSession.last_session_test_exit_code ?? "None"}</strong></div>
                <div><span className="step-label">Master-check output</span><pre>{manualMfaSession.last_master_check_result || "(empty)"}</pre></div>
                <div><span className="step-label">Authentication-marker output</span><pre>{manualMfaSession.last_auth_ok_result || "(empty)"}</pre></div>
              </div>
              {localSshCapabilities ? (
                <div>
                  <p>Legacy PowerShell diagnostics</p>
                  <pre>{localSshCapabilities.ssh_version || "(empty)"}</pre>
                  <pre>{localSshCapabilities.syntax_stdout || "(empty)"}</pre>
                  <pre>{localSshCapabilities.syntax_stderr || "(empty)"}</pre>
                  <p>{localSshCapabilities.recommendation}</p>
                </div>
              ) : null}
            </div>
          </details>
        </section>
        ) : null}

        {isRobotAutomationMode ? (
        <section className="robot-automation-panel" aria-labelledby="robot-automation-heading">
          <div>
            <h3 id="robot-automation-heading">Robot Automation</h3>
            <p>
              Configure the future production path independently of manual MFA login. FluorCast
              tests only robot-node SSH access here; no files are uploaded and no jobs are submitted.
            </p>
          </div>
          <div className="diagnostic-grid">
            <div><span className="step-label">Robot host</span><code>{values.robot_login_host || "robot.nibi.alliancecan.ca"}</code></div>
            <div><span className="step-label">Username</span><code>{values.nibi_username || "Not configured"}</code></div>
            <div><span className="step-label">Private key path</span><code>{values.ssh_private_key_path || "Not configured"}</code></div>
            <div><span className="step-label">Access status</span><strong>{values.robot_access_verified ? "Verified" : "Not verified"}</strong></div>
          </div>
          <ul className="warning-list">
            <li>Only upload the restricted public key to CCDB.</li>
            <li>Never upload or paste the private key.</li>
            <li>The from= restriction may require an approved network or VPN.</li>
            <li>Robot-node access must be enabled by Alliance support.</li>
          </ul>
          <div className="button-row manual-login-actions">
            <button className="secondary-button" onClick={copyAllianceSupportRequest} type="button">
              Copy Alliance support request
            </button>
            <button className="secondary-button" disabled={isTestingRobotAutomation} onClick={testRobotAutomation} type="button">
              {isTestingRobotAutomation ? "Testing..." : "Test robot automation"}
            </button>
          </div>
          <label className="checkbox-label">
            <input
              checked={values.robot_access_verified}
              name="robot_access_verified"
              onChange={(event) => updateBooleanField("robot_access_verified", event.target.checked)}
              type="checkbox"
            />
            <span>Robot automation access has been verified</span>
          </label>
          {robotCommandPreview ? (
            <pre>{robotCommandPreview}</pre>
          ) : null}
          {restrictedPublicKeyStatus || robotTestStatus ? (
            <p className="connection-test-status" role="status">
              {robotTestStatus || restrictedPublicKeyStatus}
            </p>
          ) : null}
        </section>
        ) : null}

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
