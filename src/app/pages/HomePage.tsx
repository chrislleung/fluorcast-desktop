import { useEffect, useRef, useState } from "react";
import type { NibiSettings } from "../../features/settings";
import { defaultManualMfaSessionState, type ManualMfaSessionUiState } from "../../lib/remote";
import {
  EXPECTED_FLUORCAST_REPOSITORY_REF,
  EXPECTED_MODEL_ARTIFACT_VERSION,
  EXPECTED_PROVISIONING_SCHEMA_VERSION,
  provisioningRecordStatus,
  runRemoteProvisioningCommand,
} from "../../lib/remote";
import type { RemoteProvisioningRecord } from "../../lib/db";
import { ConnectionSettingsPanel } from "../components/ConnectionSettingsPanel";

const capabilities = [
  { symbol: "λₐ", title: "Absorption", detail: "Predicted maximum absorption wavelength" },
  { symbol: "λₑ", title: "Emission", detail: "Predicted maximum emission wavelength" },
  { symbol: "Φ", title: "Quantum yield", detail: "Predicted fluorescence efficiency" },
];

type HomePageProps = {
  manualMfaSession?: ManualMfaSessionUiState;
  nibiSettings: NibiSettings;
  onManualMfaSessionChange?: (session: ManualMfaSessionUiState) => void;
  onNibiSettingsSave: (settings: NibiSettings) => Promise<boolean>;
  provisioningRecord?: RemoteProvisioningRecord | null;
  onProvisioningRecordChange?: (record: RemoteProvisioningRecord) => void;
  onViewTrainingJobs?: () => void;
};

export function HomePage({
  manualMfaSession = defaultManualMfaSessionState,
  nibiSettings,
  onManualMfaSessionChange,
  onNibiSettingsSave,
  provisioningRecord = null,
  onProvisioningRecordChange,
  onViewTrainingJobs,
}: HomePageProps) {
  return (
    <div className="page home-page">
      <section className="home-hero">
        <p className="eyebrow">Molecular fluorescence prediction</p>
        <h1>From structure to signal.</h1>
        <p className="lede">
          FluorCast predicts absorption wavelength, emission wavelength, and quantum yield
          for molecule–solvent pairs.
        </p>
      </section>

      <section className="capability-grid" aria-label="Prediction capabilities">
        {capabilities.map((capability) => (
          <article className="capability-card" key={capability.title}>
            <span className="science-symbol">{capability.symbol}</span>
            <div><h2>{capability.title}</h2><p>{capability.detail}</p></div>
          </article>
        ))}
      </section>

      <section className="info-panel">
        <div><span className="step-label">How it works</span><h2>Desktop here. Compute there.</h2></div>
        <p>
          Prepare jobs in this app and submit them to NIBI for computation. FluorCast handles
          the workflow, so users never need to work from the command line.
        </p>
      </section>

      <ConnectionSettingsPanel
        manualMfaSession={manualMfaSession}
        nibiSettings={nibiSettings}
        onManualMfaSessionChange={onManualMfaSessionChange}
        onNibiSettingsSave={onNibiSettingsSave}
      />

      <RemoteSetupCard
        manualMfaSession={manualMfaSession}
        nibiSettings={nibiSettings}
        onProvisioningRecordChange={onProvisioningRecordChange}
        onViewTrainingJobs={onViewTrainingJobs}
        provisioningRecord={provisioningRecord}
      />
    </div>
  );
}

type RemoteSetupCardProps = {
  manualMfaSession: ManualMfaSessionUiState;
  nibiSettings: NibiSettings;
  provisioningRecord: RemoteProvisioningRecord | null;
  onProvisioningRecordChange?: (record: RemoteProvisioningRecord) => void;
  onViewTrainingJobs?: () => void;
};

function RemoteSetupCard({
  manualMfaSession,
  nibiSettings,
  provisioningRecord,
  onProvisioningRecordChange,
  onViewTrainingJobs,
}: RemoteSetupCardProps) {
  const [record, setRecord] = useState(provisioningRecord);
  const [isWorking, setIsWorking] = useState(false);
  const [localStatus, setLocalStatus] = useState("");
  const [trainingConfirmed, setTrainingConfirmed] = useState(false);
  const operationAbortRef = useRef<AbortController | null>(null);
  const status = provisioningRecordStatus(record);
  const isMockMode = nibiSettings.connection_mode === "mock" || nibiSettings.backend_mode === "mock";
  const isManualReady = nibiSettings.connection_mode !== "interactive_mfa"
    || (manualMfaSession.status === "authenticated" && manualMfaSession.can_run_background_commands);
  const canRunRemote = !isMockMode && isManualReady && !isWorking;
  const remoteDisabledMessage = isMockMode
    ? "Remote setup is skipped in mock mode."
    : !isManualReady
      ? "Start and test the NIBI session before remote setup."
      : "";

  useEffect(() => {
    setRecord(provisioningRecord);
  }, [provisioningRecord]);

  async function run(command: Parameters<typeof runRemoteProvisioningCommand>[0], nextStatus: string) {
    if (!canRunRemote && command !== "cancel_remote_provisioning_training") {
      setLocalStatus(remoteDisabledMessage);
      return;
    }
    const controller = new AbortController();
    operationAbortRef.current = controller;
    setIsWorking(true);
    setLocalStatus(nextStatus);
    try {
      const nextRecord = await runRemoteProvisioningCommand(command, nibiSettings, {
        trainingAccount: nibiSettings.slurm_account,
        confirmed: trainingConfirmed,
        slurmJobId: status.training_slurm_id,
        signal: controller.signal,
      });
      setRecord(nextRecord);
      onProvisioningRecordChange?.(nextRecord);
      setLocalStatus(provisioningRecordStatus(nextRecord).error ?? "Remote setup status updated.");
    } finally {
      setIsWorking(false);
      operationAbortRef.current = null;
    }
  }

  function cancelLocalOperation() {
    operationAbortRef.current?.abort();
    setIsWorking(false);
    setLocalStatus("Local operation cancelled. Recorded remote Slurm job IDs are preserved.");
  }

  function submitTraining() {
    if (!trainingConfirmed) {
      setLocalStatus("Confirm retraining first. Selected Slurm account/RAP: " + (nibiSettings.slurm_account || "not configured"));
      return;
    }
    void run("submit_remote_model_training", "Submitting training with account/RAP " + nibiSettings.slurm_account + ".");
  }

  return (
    <section className="remote-setup-card" aria-labelledby="remote-setup-heading">
      <div className="section-heading compact-heading">
        <div>
          <span>Remote setup</span>
          <h2 id="remote-setup-heading">Remote Setup</h2>
        </div>
        <strong>{status.ready ? "Ready" : status.stage.replaceAll("_", " ")}</strong>
      </div>

      <div className="diagnostic-grid">
        <RemoteSetupMetric label="Repository status" value={status.repository.status} />
        <RemoteSetupMetric label="Environment status" value={status.environment.status} />
        <RemoteSetupMetric label="Data status" value={status.data.status} />
        <RemoteSetupMetric label="Production model status" value={status.production_model.status} />
        <RemoteSetupMetric label="Smoke-test status" value={status.smoke_test.status} />
        <RemoteSetupMetric label="Installed repository version" value={status.repository.installed_version ?? "Not installed"} />
        <RemoteSetupMetric label="Installed artifact version" value={status.production_model.installed_artifact_version ?? "Not installed"} />
        <RemoteSetupMetric label="Last checked time" value={status.last_checked_at || "Never"} />
        <RemoteSetupMetric label="Setup job ID" value={status.setup_slurm_id ?? "None"} />
        <RemoteSetupMetric label="Training job ID" value={status.training_slurm_id ?? "None"} />
      </div>

      <div className="diagnostic-grid">
        <RemoteSetupMetric label="Expected repository ref" value={EXPECTED_FLUORCAST_REPOSITORY_REF} />
        <RemoteSetupMetric label="Expected artifact version" value={EXPECTED_MODEL_ARTIFACT_VERSION} />
        <RemoteSetupMetric label="Provisioning schema" value={EXPECTED_PROVISIONING_SCHEMA_VERSION} />
        <RemoteSetupMetric label="Training account/RAP" value={nibiSettings.slurm_account || "Not configured"} />
      </div>

      {status.error || localStatus || remoteDisabledMessage ? (
        <p className="connection-test-status" role="status">
          {localStatus || status.error || remoteDisabledMessage}
        </p>
      ) : null}

      <div className="button-row manual-login-actions">
        <button className="secondary-button" disabled={!canRunRemote} onClick={() => void run("check_remote_fluorcast_installation", "Checking remote installation.")} type="button">
          Check installation
        </button>
        <button className="secondary-button" disabled={!canRunRemote} onClick={() => void run("provision_remote_fluorcast", "Installing FluorCast remotely.")} type="button">
          Install FluorCast
        </button>
        <button className="secondary-button" disabled={!canRunRemote} onClick={() => void run("provision_remote_fluorcast", "Repairing remote environment.")} type="button">
          Repair environment
        </button>
        <button className="secondary-button" disabled={!canRunRemote} onClick={() => void run("install_remote_model_bundle", "Installing production models.")} type="button">
          Install production models
        </button>
        <button className="secondary-button" disabled={!canRunRemote} onClick={() => void run("get_remote_provisioning_status", "Retrying validation.")} type="button">
          Retry validation
        </button>
        <button className="secondary-button" onClick={onViewTrainingJobs} type="button">
          View training jobs
        </button>
        {isWorking ? (
          <button className="secondary-button" onClick={cancelLocalOperation} type="button">
            Cancel local operation
          </button>
        ) : null}
      </div>

      <details className="help-disclosure">
        <summary>Advanced</summary>
        <div className="remote-advanced-content">
          <label className="checkbox-label">
            <input
              checked={trainingConfirmed}
              onChange={(event) => setTrainingConfirmed(event.target.checked)}
              type="checkbox"
            />
            <span>I confirm retraining may consume allocation on {nibiSettings.slurm_account || "the selected Slurm account/RAP"}</span>
          </label>
          <div className="button-row manual-login-actions">
            <button className="secondary-button" disabled={!canRunRemote || !trainingConfirmed || !nibiSettings.slurm_account} onClick={submitTraining} type="button">
              Retrain models
            </button>
          </div>
        </div>
      </details>
    </section>
  );
}

function RemoteSetupMetric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span className="step-label">{label}</span>
      <code>{value}</code>
    </div>
  );
}
