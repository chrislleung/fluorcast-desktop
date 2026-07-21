import type { PredictionItem, PredictionJobOutput } from "../../lib/schemas";
import {
  formatPredictionValue,
  formatTargetName,
  getApplicabilityConfidenceLabel,
  getBrightnessClass,
  getSpectralRegion,
} from "../../lib/formatting";

type ResultDetailPageProps = {
  output: PredictionJobOutput;
};

function yesNo(value: boolean) {
  return value ? "Yes" : "No";
}

function derivedPredictionLabel(prediction: PredictionItem) {
  if (prediction.unit === "nm" && prediction.property.includes("wavelength")) {
    return getSpectralRegion(prediction.value);
  }
  if (prediction.property === "quantum_yield") {
    return getBrightnessClass(prediction.value);
  }
  return "Not applicable";
}

function getStokesShiftRows(predictions: PredictionItem[]) {
  const byModel = new Map<string, { absorption?: number; emission?: number; unit?: string }>();
  for (const prediction of predictions) {
    if (prediction.unit !== "nm") continue;
    const row = byModel.get(prediction.model) ?? {};
    if (prediction.property === "absorption_wavelength") {
      row.absorption = prediction.value;
      row.unit = prediction.unit;
    }
    if (prediction.property === "emission_wavelength") {
      row.emission = prediction.value;
      row.unit = prediction.unit;
    }
    byModel.set(prediction.model, row);
  }
  return Array.from(byModel.entries())
    .flatMap(([model, row]) => (
      row.absorption !== undefined && row.emission !== undefined
        ? [{ model, value: row.emission - row.absorption, unit: row.unit ?? "nm" }]
        : []
    ));
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

  const confidenceLabel = getApplicabilityConfidenceLabel(output.applicability_domain);
  const stokesShiftRows = getStokesShiftRows(output.predictions);

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
                <th>Target</th>
                <th>Prediction</th>
                <th>Unit</th>
                <th>Derived label</th>
              </tr>
            </thead>
            <tbody>
              {output.predictions.map((prediction) => (
                <tr key={`${prediction.model}-${prediction.property}`}>
                  <td>{prediction.model}</td>
                  <td>{formatTargetName(prediction.property)}</td>
                  <td>{formatPredictionValue(prediction.value, prediction.unit)}</td>
                  <td>{prediction.unit}</td>
                  <td>{derivedPredictionLabel(prediction)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {stokesShiftRows.length > 0 ? (
        <section className="result-section">
          <div className="section-heading">
            <h2>Stokes shift</h2>
            <span>{stokesShiftRows.length} values</span>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Model name</th>
                  <th>Shift</th>
                  <th>Unit</th>
                </tr>
              </thead>
              <tbody>
                {stokesShiftRows.map((shift) => (
                  <tr key={shift.model}>
                    <td>{shift.model}</td>
                    <td>{formatPredictionValue(shift.value, shift.unit)}</td>
                    <td>{shift.unit}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      <section className="result-section">
        <div className="section-heading">
          <h2>Applicability domain</h2>
          <span>{confidenceLabel}</span>
        </div>
        <div className="applicability-grid">
          <div>
            <span className="step-label">Nearest training similarity</span>
            <strong>{formatPredictionValue(output.applicability_domain.nearest_training_similarity, "ratio")}</strong>
          </div>
          <div>
            <span className="step-label">Outside applicability domain</span>
            <strong>{yesNo(output.applicability_domain.outside_applicability_domain)}</strong>
          </div>
          <div>
            <span className="step-label">Exact molecule match</span>
            <strong>{yesNo(output.applicability_domain.exact_molecule_match)}</strong>
          </div>
          <div>
            <span className="step-label">Exact solvent pair match</span>
            <strong>{yesNo(output.applicability_domain.exact_solvent_pair_match)}</strong>
          </div>
          <div>
            <span className="step-label">Scaffold match</span>
            <strong>{yesNo(output.applicability_domain.scaffold_match)}</strong>
          </div>
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
