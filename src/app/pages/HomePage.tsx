import type { MouseEvent } from "react";
import { useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { NibiSettings } from "../../features/settings";
import { defaultManualMfaSessionState, type ManualMfaSessionUiState } from "../../lib/remote";
import { ConnectionSettingsPanel } from "../components/ConnectionSettingsPanel";

const officialRepositoryUrl = "https://github.com/chrislleung/fluorcast";

const capabilities = [
  { symbol: "A", title: "Absorption", detail: "Predicted maximum absorption wavelength" },
  { symbol: "E", title: "Emission", detail: "Predicted maximum emission wavelength" },
  { symbol: "QY", title: "Quantum yield", detail: "Predicted fluorescence efficiency" },
];

const setupCommands = [
  {
    title: "1. Connect to Nibi",
    command: "ssh YOUR_USERNAME@nibi.alliancecan.ca",
  },
  {
    title: "2. Clone or update FluorCast",
    command: `cd ~/scratch
git clone https://github.com/chrislleung/fluorcast.git FluorCast
cd ~/scratch/FluorCast`,
    secondaryLabel: "Update an existing checkout",
    secondaryCommand: `cd ~/scratch/FluorCast
git pull origin main`,
  },
  {
    title: "3. Create and activate the environment",
    command: `module purge
module load python/3.11
module load gcc
module load rdkit

python -m venv --system-site-packages ~/scratch/chemfluor_env
source ~/scratch/chemfluor_env/bin/activate

python -m pip install --upgrade pip setuptools wheel
python -m pip install -r requirements.txt
python -m pip install pytest typing_extensions matplotlib scipy`,
  },
  {
    title: "4. Verify RDKit",
    command: `python -c "from rdkit import Chem; print('RDKit OK:', Chem.MolFromSmiles('CCO'))"`,
  },
  {
    title: "5. Train tree models",
    command: `cd ~/scratch/FluorCast
source ~/scratch/chemfluor_env/bin/activate
mkdir -p outputs/slurm
sbatch slurm/base_models/run_model_experiments_fluodb.sbatch`,
  },
  {
    title: "6. Train neural models",
    command: `cd ~/scratch/FluorCast
source ~/scratch/chemfluor_env/bin/activate
mkdir -p outputs/slurm
sbatch slurm/base_models/run_neural_experiments.sbatch`,
  },
  {
    title: "7. Train absorption hybrid",
    command: `cd ~/scratch/FluorCast
source ~/scratch/chemfluor_env/bin/activate
export FLUORCAST_TARGET_NAME="absorption_nm"
export FLUORCAST_SPLIT_TYPE="molecule"
export FLUORCAST_SEED="0"
export FLUORCAST_OUT_DIR="outputs/hybrid_three_way/molecule/absorption_nm"
export FLUORCAST_MODEL_OUT_DIR="models/production_hybrid/absorption_nm"
sbatch slurm/run_hybrid_three_way_experiment.sbatch`,
  },
  {
    title: "8. Train emission hybrid",
    command: `cd ~/scratch/FluorCast
source ~/scratch/chemfluor_env/bin/activate
export FLUORCAST_TARGET_NAME="emission_nm"
export FLUORCAST_SPLIT_TYPE="molecule"
export FLUORCAST_SEED="0"
export FLUORCAST_OUT_DIR="outputs/hybrid_three_way/molecule/emission_nm"
export FLUORCAST_MODEL_OUT_DIR="models/production_hybrid/emission_nm"
sbatch slurm/run_hybrid_three_way_experiment.sbatch`,
  },
  {
    title: "9. Train quantum-yield hybrid",
    command: `cd ~/scratch/FluorCast
source ~/scratch/chemfluor_env/bin/activate
export FLUORCAST_TARGET_NAME="quantum_yield"
export FLUORCAST_SPLIT_TYPE="molecule"
export FLUORCAST_SEED="0"
export FLUORCAST_OUT_DIR="outputs/hybrid_three_way/molecule/quantum_yield"
export FLUORCAST_MODEL_OUT_DIR="models/production_hybrid/quantum_yield"
sbatch slurm/run_hybrid_three_way_experiment.sbatch`,
  },
  {
    title: "10. Monitor jobs",
    command: `squeue -u "$USER"`,
  },
  {
    title: "11. Verify model directories",
    command: `cd ~/scratch/FluorCast

test -d models/experiments_fluodb &&
echo "PASS: tree models found" ||
echo "FAIL: tree models missing"

test -d models/neural_experiments_fluodb &&
echo "PASS: neural models found" ||
echo "FAIL: neural models missing"

test -d models/production_hybrid/absorption_nm &&
echo "PASS: absorption hybrid found" ||
echo "FAIL: absorption hybrid missing"

test -d models/production_hybrid/emission_nm &&
echo "PASS: emission hybrid found" ||
echo "FAIL: emission hybrid missing"

test -d models/production_hybrid/quantum_yield &&
echo "PASS: quantum-yield hybrid found" ||
echo "FAIL: quantum-yield hybrid missing"`,
  },
] as const;

const readinessChecklist = [
  "Repository cloned",
  "Environment installed",
  "Tree models trained",
  "Neural models trained",
  "Absorption hybrid trained",
  "Emission hybrid trained",
  "Quantum-yield hybrid trained",
  "Manual MFA session connected",
  "Remote environment checks pass",
];

type HomePageProps = {
  manualMfaSession?: ManualMfaSessionUiState;
  nibiSettings: NibiSettings;
  onManualMfaSessionChange?: (session: ManualMfaSessionUiState) => void;
  onNibiSettingsSave: (settings: NibiSettings) => Promise<boolean>;
};

type CommandBlockProps = {
  command: string;
  label: string;
};

function CommandBlock({ command, label }: CommandBlockProps) {
  const [copyStatus, setCopyStatus] = useState("");

  async function copyCommand() {
    setCopyStatus("");
    try {
      await navigator.clipboard.writeText(command);
      setCopyStatus("Copied.");
    } catch {
      setCopyStatus("Copy failed.");
    }
  }

  return (
    <div className="command-block">
      <div className="command-block-header">
        <span>{label}</span>
        <button className="secondary-button compact-button" onClick={copyCommand} type="button">
          Copy
        </button>
      </div>
      <pre><code>{command}</code></pre>
      {copyStatus ? <span className="copy-status" role="status">{copyStatus}</span> : null}
    </div>
  );
}

function RepositoryLink() {
  async function handleClick(event: MouseEvent<HTMLAnchorElement>) {
    event.preventDefault();
    await openUrl(officialRepositoryUrl);
  }

  return (
    <a
      className="external-help-link"
      href={officialRepositoryUrl}
      onClick={handleClick}
      rel="noopener noreferrer"
      target="_blank"
    >
      {officialRepositoryUrl}
    </a>
  );
}

function RequiredNibiSetupGuide() {
  const [isOpen, setIsOpen] = useState(false);
  const contentId = "required-nibi-setup-content";

  return (
    <section className="required-nibi-setup" aria-labelledby="required-nibi-setup-heading">
      <button
        aria-controls={contentId}
        aria-expanded={isOpen}
        className="required-nibi-setup-toggle"
        onClick={() => setIsOpen((current) => !current)}
        type="button"
      >
        <div>
          <span>Required before remote predictions</span>
          <h2 id="required-nibi-setup-heading">Required Nibi setup</h2>
        </div>
        <span className="setup-chevron" aria-hidden="true">{isOpen ? "v" : ">"}</span>
      </button>
      {isOpen ? (
        <div className="required-nibi-setup-content" data-testid="required-nibi-setup-content" id={contentId}>
          <div className="warning-callout">
            <p>
              FluorCast Desktop does not currently install or train FluorCast automatically.
              Before remote predictions work, clone the official repository onto Nibi, create
              the Python environment, and train the required models.
            </p>
          </div>
          <p>
            Trained model artifacts are not bundled with the desktop installer. Setup is generally
            performed once, but users may need to pull updates or retrain later.
          </p>
          <div className="diagnostic-grid">
            <div><span className="step-label">Official repository</span><RepositoryLink /></div>
            <div><span className="step-label">Expected repository path</span><code>~/scratch/FluorCast</code></div>
            <div><span className="step-label">Expected environment path</span><code>~/scratch/chemfluor_env</code></div>
          </div>
          <div className="help-disclosure nibi-setup-instructions" data-testid="required-nibi-setup-instructions">
            <h3>Detailed terminal instructions</h3>
          <ol className="help-steps numbered-setup-steps">
            {setupCommands.map((step) => (
              <li key={step.title}>
                <h3>{step.title}</h3>
                <CommandBlock command={step.command} label={step.title} />
                {"secondaryCommand" in step ? (
                  <CommandBlock command={step.secondaryCommand} label={step.secondaryLabel} />
                ) : null}
              </li>
            ))}
          </ol>
          </div>
          <div className="readiness-checklist-panel">
            <h3>Readiness checklist</h3>
            <p>
              This checklist is local and informational. Only the remote environment checks can
              report verified remote status after they actually pass.
            </p>
            <ul className="readiness-checklist" aria-label="Nibi setup readiness checklist">
              {readinessChecklist.map((item) => (
                <li key={item}>
                  <span aria-hidden="true">-</span>
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}
    </section>
  );
}

export function HomePage({
  manualMfaSession = defaultManualMfaSessionState,
  nibiSettings,
  onManualMfaSessionChange,
  onNibiSettingsSave,
}: HomePageProps) {
  return (
    <div className="page home-page">
      <section className="home-hero">
        <p className="eyebrow">Molecular fluorescence prediction</p>
        <h1>From structure to signal.</h1>
        <p className="lede">
          FluorCast predicts absorption wavelength, emission wavelength, and quantum yield
          for molecule-solvent pairs.
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
          Prepare jobs in this app and submit them to Nibi for computation. FluorCast handles
          prediction submission after the remote repository, environment, and trained models
          have been prepared.
        </p>
      </section>

      <RequiredNibiSetupGuide />

      <ConnectionSettingsPanel
        manualMfaSession={manualMfaSession}
        nibiSettings={nibiSettings}
        onManualMfaSessionChange={onManualMfaSessionChange}
        onNibiSettingsSave={onNibiSettingsSave}
      />
    </div>
  );
}
