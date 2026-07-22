import {
  PredictionJobValidationError,
  validatePredictionJobOutput,
  type PredictionItem,
  type PredictionJobOutput,
  type PredictionJobSuccessOutput,
} from "../schemas";

export type CompletionTimestampSource =
  | "slurm"
  | "sacct"
  | "remote_file_mtime"
  | "import_time";

export type CompletionTimestampMetadata = {
  persistedCompletedAt?: string;
  sacctEnd?: string;
  remoteFileMtime?: string;
  importTime?: string;
};

export type ImportDiagnosticsStatus = "not_started" | "valid" | "invalid" | "success" | "complete";

export type RemoteOutputImportDiagnostics = {
  jsonSyntaxStatus: "valid" | "invalid";
  remoteSchemaStatus: "not_started" | "valid" | "invalid";
  adapterStatus: "not_started" | "success" | "invalid";
  canonicalSchemaStatus: "not_started" | "valid" | "invalid";
  persistenceStatus: "not_started" | "complete";
};

type AdaptFlatRemoteOutputOptions = {
  localJobId: string;
  completion: CompletionTimestampMetadata;
};

type FlatRemoteOutput = {
  status: "success";
  job_id: string;
  canonical_molecule_smiles: string;
  canonical_solvent_smiles: string;
  predictions: PredictionItem[];
  warnings: string[];
};

const successDiagnostics: RemoteOutputImportDiagnostics = {
  jsonSyntaxStatus: "valid",
  remoteSchemaStatus: "valid",
  adapterStatus: "success",
  canonicalSchemaStatus: "valid",
  persistenceStatus: "not_started",
};

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PredictionJobValidationError(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new PredictionJobValidationError(`${path} must be a non-empty string`);
  }
  return value;
}

function exactKeys(value: Record<string, unknown>, allowed: string[], path: string) {
  const extra = Object.keys(value).find((key) => !allowed.includes(key));
  if (extra) {
    throw new PredictionJobValidationError(`${path}.${extra} is not supported`);
  }
}

function isoDate(value: string): string | null {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) ? value : null;
}

function normalizeTimestamp(value: string): string | null {
  if (/^\d+$/.test(value)) {
    return new Date(Number(value)).toISOString();
  }
  return isoDate(value);
}

function finiteNumberOrNull(value: unknown, path: string): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new PredictionJobValidationError(`${path} must be a finite number or null`);
  }
  return value;
}

function optionalFiniteNumber(value: unknown, path: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new PredictionJobValidationError(`${path} must be a finite number`);
  }
  return value;
}

function parseWarnings(value: unknown, path: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new PredictionJobValidationError(`${path} must be an array`);
  }
  return value.map((warning, index) => nonEmptyString(warning, `${path}[${index}]`));
}

function parseRemotePrediction(value: unknown, path: string): PredictionItem {
  const prediction = record(value, path);
  exactKeys(
    prediction,
    [
      "model_name",
      "predicted_absorption_nm",
      "predicted_emission_nm",
      "predicted_quantum_yield",
      "nearest_training_similarity",
      "nearest_training_smiles",
      "confidence_label",
      "outside_applicability_domain",
      "warnings",
      "predicted_stokes_shift_nm",
      "predicted_stokes_shift_cm^-1",
      "physically_valid_stokes",
    ],
    path,
  );
  const nearestTrainingSimilarity = prediction.nearest_training_similarity;
  if (
    typeof nearestTrainingSimilarity !== "number" ||
    !Number.isFinite(nearestTrainingSimilarity) ||
    nearestTrainingSimilarity < 0 ||
    nearestTrainingSimilarity > 1
  ) {
    throw new PredictionJobValidationError(`${path}.nearest_training_similarity must be between 0 and 1`);
  }
  if (typeof prediction.outside_applicability_domain !== "boolean") {
    throw new PredictionJobValidationError(`${path}.outside_applicability_domain must be a boolean`);
  }
  if (
    prediction.physically_valid_stokes !== undefined &&
    typeof prediction.physically_valid_stokes !== "boolean"
  ) {
    throw new PredictionJobValidationError(`${path}.physically_valid_stokes must be a boolean`);
  }

  const stokesShiftNm = optionalFiniteNumber(prediction.predicted_stokes_shift_nm, `${path}.predicted_stokes_shift_nm`);
  const stokesShiftCm = optionalFiniteNumber(
    prediction["predicted_stokes_shift_cm^-1"],
    `${path}.predicted_stokes_shift_cm^-1`,
  );

  return {
    model_name: nonEmptyString(prediction.model_name, `${path}.model_name`),
    predicted_absorption_nm: finiteNumberOrNull(prediction.predicted_absorption_nm, `${path}.predicted_absorption_nm`),
    predicted_emission_nm: finiteNumberOrNull(prediction.predicted_emission_nm, `${path}.predicted_emission_nm`),
    predicted_quantum_yield: finiteNumberOrNull(prediction.predicted_quantum_yield, `${path}.predicted_quantum_yield`),
    nearest_training_similarity: nearestTrainingSimilarity,
    nearest_training_smiles: nonEmptyString(prediction.nearest_training_smiles, `${path}.nearest_training_smiles`),
    confidence_label: nonEmptyString(prediction.confidence_label, `${path}.confidence_label`),
    outside_applicability_domain: prediction.outside_applicability_domain,
    warnings: parseWarnings(prediction.warnings, `${path}.warnings`),
    ...(stokesShiftNm === undefined ? {} : { predicted_stokes_shift_nm: stokesShiftNm }),
    ...(stokesShiftCm === undefined ? {} : { "predicted_stokes_shift_cm^-1": stokesShiftCm }),
    ...(prediction.physically_valid_stokes === undefined ? {} : {
      physically_valid_stokes: prediction.physically_valid_stokes,
    }),
  };
}

export function parseFlatRemoteOutput(value: unknown, localJobId: string): FlatRemoteOutput {
  const output = record(value, "remote_output");
  exactKeys(
    output,
    [
      "status",
      "job_id",
      "canonical_molecule_smiles",
      "canonical_solvent_smiles",
      "predictions",
      "warnings",
    ],
    "remote_output",
  );
  if (output.status !== "success") {
    throw new PredictionJobValidationError('remote_output.status must be "success"');
  }
  const jobId = nonEmptyString(output.job_id, "remote_output.job_id");
  if (jobId !== localJobId) {
    throw new PredictionJobValidationError("remote_output.job_id must match the local job ID");
  }
  if (!Array.isArray(output.predictions) || output.predictions.length === 0) {
    throw new PredictionJobValidationError("remote_output.predictions must be a non-empty array");
  }
  return {
    status: "success",
    job_id: jobId,
    canonical_molecule_smiles: nonEmptyString(
      output.canonical_molecule_smiles,
      "remote_output.canonical_molecule_smiles",
    ),
    canonical_solvent_smiles: nonEmptyString(
      output.canonical_solvent_smiles,
      "remote_output.canonical_solvent_smiles",
    ),
    predictions: output.predictions.map((prediction, index) =>
      parseRemotePrediction(prediction, `remote_output.predictions[${index}]`),
    ),
    warnings: parseWarnings(output.warnings, "remote_output.warnings"),
  };
}

export function deriveCompletionTimestamp(metadata: CompletionTimestampMetadata): {
  completedAt: string;
  source: CompletionTimestampSource;
} {
  const candidates: Array<[string | undefined, CompletionTimestampSource]> = [
    [metadata.persistedCompletedAt, "slurm"],
    [metadata.sacctEnd, "sacct"],
    [metadata.remoteFileMtime, "remote_file_mtime"],
    [metadata.importTime, "import_time"],
  ];
  const match = candidates.find(([value]) => value !== undefined && normalizeTimestamp(value) !== null);
  if (match) {
    return { completedAt: normalizeTimestamp(match[0] as string) as string, source: match[1] };
  }
  return { completedAt: new Date().toISOString(), source: "import_time" };
}

export function adaptFlatRemotePredictionOutput(
  value: unknown,
  options: AdaptFlatRemoteOutputOptions,
): { output: PredictionJobSuccessOutput; diagnostics: RemoteOutputImportDiagnostics } {
  const remoteOutput = parseFlatRemoteOutput(value, options.localJobId);
  const completion = deriveCompletionTimestamp(options.completion);
  const canonical = validatePredictionJobOutput({
    ...remoteOutput,
    status: "succeeded",
    completed_at: completion.completedAt,
    completed_at_source: completion.source,
  });
  if (canonical.status !== "succeeded") {
    throw new PredictionJobValidationError("adapter produced a non-success canonical output");
  }
  return {
    output: canonical,
    diagnostics: { ...successDiagnostics },
  };
}

export function parseRemoteOutputJsonForImport(
  outputJson: string,
  options: AdaptFlatRemoteOutputOptions,
): { output: PredictionJobOutput; diagnostics: RemoteOutputImportDiagnostics } {
  const diagnostics: RemoteOutputImportDiagnostics = {
    jsonSyntaxStatus: "invalid",
    remoteSchemaStatus: "not_started",
    adapterStatus: "not_started",
    canonicalSchemaStatus: "not_started",
    persistenceStatus: "not_started",
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(outputJson);
    diagnostics.jsonSyntaxStatus = "valid";
  } catch (error) {
    throw Object.assign(
      new PredictionJobValidationError(error instanceof Error ? error.message : "output.json is not valid JSON"),
      { diagnostics },
    );
  }

  try {
    const result = adaptFlatRemotePredictionOutput(parsed, options);
    return result;
  } catch (error) {
    diagnostics.remoteSchemaStatus = "invalid";
    diagnostics.adapterStatus = "invalid";
    if (error instanceof PredictionJobValidationError) {
      throw Object.assign(error, { diagnostics });
    }
    throw Object.assign(new PredictionJobValidationError("Remote output import failed"), { diagnostics });
  }
}
