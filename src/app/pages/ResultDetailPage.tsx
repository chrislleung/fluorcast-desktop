import type { PredictionItem, PredictionJobOutput } from "../../lib/schemas";
import {
  formatPredictionValue,
  getBrightnessClass,
  getSpectralRegion,
} from "../../lib/formatting";

type ResultDetailPageProps = {
  output: PredictionJobOutput;
};

function yesNo(value: boolean) {
  return value ? "Yes" : "No";
}

function formatNullablePredictionValue(value: number | null, unit: string) {
  return value === null ? "Unavailable" : formatPredictionValue(value, unit);
}

function spectralLabel(value: number | null) {
  return value === null ? "Unavailable" : getSpectralRegion(value);
}

function brightnessLabel(value: number | null) {
  return value === null ? "Unavailable" : getBrightnessClass(value);
}

function modelWarnings(prediction: PredictionItem) {
  return prediction.warnings.length > 0 ? prediction.warnings.join("; ") : "None";
}

export function ResultDetailPage({ output }: ResultDetailPageProps) {
  const rawJson = JSON.stringify(output, null, 2);

  if (output.status === "failed") {
    return (
      <section className="result-detail" aria-label="Prediction result detail">
        <header className="result-header">
          <div>
            <p className="eyebrow">Result detail</p>
            <h1>Prediction failed</h1>
          </div>
          <span className="status-badge">Failed</span>
        </header>
        <div className="result-summary-grid">
          <div>
            <span className="step-label">Job ID</span>
            <code>{output.job_id}</code>
          </div>
          <div>
            <span className="step-label">Status</span>
            <strong>{output.status}</strong>
          </div>
        </div>
        <section className="result-section">
          <h2>Error</h2>
          <p>{output.error}</p>
        </section>
        <section className="result-section" aria-label="Raw result JSON">
          <h2>Raw JSON</h2>
          <pre>{rawJson}</pre>
        </section>
      </section>
    );
  }

  return (
    <section className="result-detail" aria-label="Prediction result detail">
      <header className="result-header">
        <div>
          <p className="eyebrow">Result detail</p>
          <h1>Prediction result</h1>
        </div>
        <span className="status-badge">{output.status}</span>
      </header>

      <div className="result-summary-grid">
        <div>
          <span className="step-label">Job ID</span>
          <code>{output.job_id}</code>
        </div>
        <div>
          <span className="step-label">Status</span>
          <strong>{output.status}</strong>
        </div>
        <div>
          <span className="step-label">Canonical molecule SMILES</span>
          <code>{output.canonical_molecule_smiles}</code>
        </div>
        <div>
          <span className="step-label">Canonical solvent SMILES</span>
          <code>{output.canonical_solvent_smiles}</code>
        </div>
      </div>

      <section className="result-section">
        <div className="section-heading">
          <h2>Predictions</h2>
          <span>{output.predictions.length} values</span>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Model name</th>
                <th>Absorption</th>
                <th>Emission</th>
                <th>Quantum yield</th>
                <th>Stokes shift</th>
                <th>Confidence</th>
                <th>Warnings</th>
              </tr>
            </thead>
            <tbody>
              {output.predictions.map((prediction) => (
                <tr key={prediction.model_name}>
                  <td>{prediction.model_name}</td>
                  <td>
                    {formatNullablePredictionValue(prediction.predicted_absorption_nm, "nm")}
                    <br />
                    <span className="step-label">{spectralLabel(prediction.predicted_absorption_nm)}</span>
                  </td>
                  <td>
                    {formatNullablePredictionValue(prediction.predicted_emission_nm, "nm")}
                    <br />
                    <span className="step-label">{spectralLabel(prediction.predicted_emission_nm)}</span>
                  </td>
                  <td>
                    {formatNullablePredictionValue(prediction.predicted_quantum_yield, "ratio")}
                    <br />
                    <span className="step-label">{brightnessLabel(prediction.predicted_quantum_yield)}</span>
                  </td>
                  <td>
                    {prediction.predicted_stokes_shift_nm === undefined
                      ? "Unavailable"
                      : formatPredictionValue(prediction.predicted_stokes_shift_nm, "nm")}
                    {prediction["predicted_stokes_shift_cm^-1"] === undefined ? null : (
                      <>
                        <br />
                        <span className="step-label">
                          {formatPredictionValue(prediction["predicted_stokes_shift_cm^-1"], "cm^-1")} cm^-1
                        </span>
                      </>
                    )}
                  </td>
                  <td>{prediction.confidence_label}</td>
                  <td>{modelWarnings(prediction)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="result-section">
        <div className="section-heading">
          <h2>Applicability domain</h2>
          <span>{output.predictions.length} models</span>
        </div>
        <div className="applicability-grid">
          {output.predictions.map((prediction) => (
            <div key={prediction.model_name}>
              <span className="step-label">{prediction.model_name}</span>
              <strong>{formatPredictionValue(prediction.nearest_training_similarity, "ratio")}</strong>
              <p>
                Nearest: <code>{prediction.nearest_training_smiles}</code>
                <br />
                Outside domain: {yesNo(prediction.outside_applicability_domain)}
              </p>
            </div>
          ))}
        </div>
      </section>

      <section className="result-section">
        <div className="section-heading">
          <h2>Warnings</h2>
          <span>{output.warnings.length}</span>
        </div>
        {output.warnings.length > 0 ? (
          <ul className="warning-list">
            {output.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        ) : (
          <p>No warnings reported.</p>
        )}
      </section>

      <section className="result-section" aria-label="Raw result JSON">
        <h2>Raw JSON</h2>
        <pre>{rawJson}</pre>
      </section>
    </section>
  );
}
