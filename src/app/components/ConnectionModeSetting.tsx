import {
  type ConnectionMode,
  type NibiSettings,
  type NibiSettingsErrors,
} from "../../features/settings";
import { createRemoteExecutor } from "../../lib/remote";
import type { ManualMfaSessionUiState } from "../../lib/remote";

type ConnectionModeSettingProps = {
  errors: NibiSettingsErrors;
  isManualSessionReady: boolean;
  manualMfaSession: ManualMfaSessionUiState;
  robotTestStatus: string;
  updateField: (field: keyof NibiSettings, value: string) => void;
  values: NibiSettings;
};

const connectionModeOptions: Array<{
  value: ConnectionMode;
  label: string;
  description: string;
}> = [
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
];

export function ConnectionModeSetting({
  errors,
  isManualSessionReady,
  manualMfaSession,
  robotTestStatus,
  updateField,
  values,
}: ConnectionModeSettingProps) {
  const remoteExecutor = createRemoteExecutor(values.connection_mode);
  const connectionStatus = remoteExecutor.getConnectionStatus(values);
  const isMockMode = values.connection_mode === "mock";
  const isManualMfaMode = values.connection_mode === "interactive_mfa";
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
  const modeStatusMessage = isManualMfaMode && isManualSessionReady
    ? manualMfaSession.last_session_test_result || "Manual NIBI session authenticated."
    : connectionStatus.message;

  return (
    <>
      <div className="section-heading">
        <h2 id="connection-mode-heading">Connection Mode</h2>
        <span>Local only</span>
      </div>

      <fieldset className="connection-mode-grid" aria-describedby="connection_mode-error">
        <legend className="sr-only">Connection mode</legend>
        {connectionModeOptions.map((mode) => (
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
        <p>{modeStatusMessage}</p>
      </section>
    </>
  );
}
