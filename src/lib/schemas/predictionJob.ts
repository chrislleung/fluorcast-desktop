export const predictionJobStatuses = [
  "queued",
  "running",
  "succeeded",
  "failed",
] as const;

export type PredictionJobStatus = (typeof predictionJobStatuses)[number];

export type ResultApplicabilityDomain = {
  nearest_training_similarity: number;
  outside_applicability_domain: boolean;
  exact_molecule_match: boolean;
  exact_solvent_pair_match: boolean;
  scaffold_match: boolean;
};

export type PredictionItem = {
  model_name: string;
  predicted_absorption_nm: number | null;
  predicted_emission_nm: number | null;
  predicted_quantum_yield: number | null;
  predicted_stokes_shift_nm?: number;
  "predicted_stokes_shift_cm^-1"?: number;
  physically_valid_stokes?: boolean;
  nearest_training_similarity: number;
  nearest_training_smiles: string;
  confidence_label: string;
  outside_applicability_domain: boolean;
  warnings: string[];
};

export type PredictionJobInput = {
  job_id: string;
  user_id: string;
  molecule_smiles: string;
  solvent_smiles: string;
  model_choice: string;
  requested_at: string;
};

type PredictionJobOutputBase = {
  job_id: string;
  status: PredictionJobStatus;
  completed_at: string;
  completed_at_source?: "slurm" | "sacct" | "remote_file_mtime" | "import_time";
};

export type PredictionJobSuccessOutput = PredictionJobOutputBase & {
  status: "succeeded";
  canonical_molecule_smiles: string;
  canonical_solvent_smiles: string;
  predictions: PredictionItem[];
  warnings: string[];
  error?: never;
};

export type PredictionJobFailureOutput = PredictionJobOutputBase & {
  status: "failed";
  predictions: [];
  error: string;
};

export type PredictionJobOutput =
  | PredictionJobSuccessOutput
  | PredictionJobFailureOutput;

export type DuplicateCheckInput = {
  job_id: string;
  user_id: string;
  molecule_smiles: string;
  solvent_smiles: string;
  requested_at: string;
};

export type DuplicateCheckOutput = {
  exact_molecule_match: boolean;
  exact_solvent_pair_match: boolean;
  scaffold_match: boolean;
  nearest_training_similarity: number;
  nearest_training_molecule_smiles: string;
  warnings: string[];
  error?: string;
};

export class PredictionJobValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PredictionJobValidationError";
  }
}

export type RuntimeSchema<T> = {
  parse(value: unknown): T;
  safeParse(value: unknown):
    | { success: true; data: T }
    | { success: false; error: PredictionJobValidationError };
};

function schema<T>(parser: (value: unknown) => T): RuntimeSchema<T> {
  return {
    parse: parser,
    safeParse(value) {
      try {
        return { success: true, data: parser(value) };
      } catch (error) {
        return {
          success: false,
          error:
            error instanceof PredictionJobValidationError
              ? error
              : new PredictionJobValidationError("Invalid prediction job"),
        };
      }
    },
  };
}

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

function isoDate(value: unknown, path: string): string {
  const date = nonEmptyString(value, path);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(date)) {
    throw new PredictionJobValidationError(`${path} must be an ISO UTC timestamp`);
  }
  return date;
}

function exactKeys(value: Record<string, unknown>, allowed: string[], path: string) {
  const extra = Object.keys(value).find((key) => !allowed.includes(key));
  if (extra) {
    throw new PredictionJobValidationError(`${path}.${extra} is not supported`);
  }
}

function parsePredictionItem(value: unknown, path: string): PredictionItem {
  const item = record(value, path);
  exactKeys(
    item,
    [
      "model_name",
      "predicted_absorption_nm",
      "predicted_emission_nm",
      "predicted_quantum_yield",
      "predicted_stokes_shift_nm",
      "predicted_stokes_shift_cm^-1",
      "physically_valid_stokes",
      "nearest_training_similarity",
      "nearest_training_smiles",
      "confidence_label",
      "outside_applicability_domain",
      "warnings",
    ],
    path,
  );
  function nullableFiniteNumber(key: string): number | null {
    const itemValue = item[key];
    if (itemValue === null) return null;
    if (typeof itemValue !== "number" || !Number.isFinite(itemValue)) {
      throw new PredictionJobValidationError(`${path}.${key} must be a finite number or null`);
    }
    return itemValue;
  }
  function optionalFiniteNumber(key: string): number | undefined {
    const itemValue = item[key];
    if (itemValue === undefined) return undefined;
    if (typeof itemValue !== "number" || !Number.isFinite(itemValue)) {
      throw new PredictionJobValidationError(`${path}.${key} must be a finite number`);
    }
    return itemValue;
  }
  if (
    typeof item.nearest_training_similarity !== "number" ||
    !Number.isFinite(item.nearest_training_similarity) ||
    item.nearest_training_similarity < 0 ||
    item.nearest_training_similarity > 1
  ) {
    throw new PredictionJobValidationError(`${path}.nearest_training_similarity must be between 0 and 1`);
  }
  if (typeof item.outside_applicability_domain !== "boolean") {
    throw new PredictionJobValidationError(`${path}.outside_applicability_domain must be a boolean`);
  }
  if (item.physically_valid_stokes !== undefined && typeof item.physically_valid_stokes !== "boolean") {
    throw new PredictionJobValidationError(`${path}.physically_valid_stokes must be a boolean`);
  }
  if (!Array.isArray(item.warnings)) {
    throw new PredictionJobValidationError(`${path}.warnings must be an array`);
  }
  return {
    model_name: nonEmptyString(item.model_name, `${path}.model_name`),
    predicted_absorption_nm: nullableFiniteNumber("predicted_absorption_nm"),
    predicted_emission_nm: nullableFiniteNumber("predicted_emission_nm"),
    predicted_quantum_yield: nullableFiniteNumber("predicted_quantum_yield"),
    ...(optionalFiniteNumber("predicted_stokes_shift_nm") === undefined ? {} : {
      predicted_stokes_shift_nm: optionalFiniteNumber("predicted_stokes_shift_nm"),
    }),
    ...(optionalFiniteNumber("predicted_stokes_shift_cm^-1") === undefined ? {} : {
      "predicted_stokes_shift_cm^-1": optionalFiniteNumber("predicted_stokes_shift_cm^-1"),
    }),
    ...(item.physically_valid_stokes === undefined ? {} : {
      physically_valid_stokes: item.physically_valid_stokes,
    }),
    nearest_training_similarity: item.nearest_training_similarity,
    nearest_training_smiles: nonEmptyString(item.nearest_training_smiles, `${path}.nearest_training_smiles`),
    confidence_label: nonEmptyString(item.confidence_label, `${path}.confidence_label`),
    outside_applicability_domain: item.outside_applicability_domain,
    warnings: item.warnings.map((warning, index) =>
      nonEmptyString(warning, `${path}.warnings[${index}]`),
    ),
  };
}

export const predictionJobInputSchema = schema<PredictionJobInput>((value) => {
  const input = record(value, "input");
  exactKeys(
    input,
    ["job_id", "user_id", "molecule_smiles", "solvent_smiles", "model_choice", "requested_at"],
    "input",
  );
  return {
    job_id: nonEmptyString(input.job_id, "input.job_id"),
    user_id: nonEmptyString(input.user_id, "input.user_id"),
    molecule_smiles: nonEmptyString(input.molecule_smiles, "input.molecule_smiles"),
    solvent_smiles: nonEmptyString(input.solvent_smiles, "input.solvent_smiles"),
    model_choice: nonEmptyString(input.model_choice, "input.model_choice"),
    requested_at: isoDate(input.requested_at, "input.requested_at"),
  };
});

export const duplicateCheckInputSchema = schema<DuplicateCheckInput>((value) => {
  const input = record(value, "input");
  exactKeys(
    input,
    ["job_id", "user_id", "molecule_smiles", "solvent_smiles", "requested_at"],
    "input",
  );
  return {
    job_id: nonEmptyString(input.job_id, "input.job_id"),
    user_id: nonEmptyString(input.user_id, "input.user_id"),
    molecule_smiles: nonEmptyString(input.molecule_smiles, "input.molecule_smiles"),
    solvent_smiles: nonEmptyString(input.solvent_smiles, "input.solvent_smiles"),
    requested_at: isoDate(input.requested_at, "input.requested_at"),
  };
});

export const predictionJobOutputSchema = schema<PredictionJobOutput>((value) => {
  const output = record(value, "output");
  exactKeys(
    output,
    [
      "job_id",
      "status",
      "completed_at",
      "canonical_molecule_smiles",
      "canonical_solvent_smiles",
      "predictions",
      "warnings",
      "error",
      "completed_at_source",
    ],
    "output",
  );
  const job_id = nonEmptyString(output.job_id, "output.job_id");
  const completed_at = isoDate(output.completed_at, "output.completed_at");
  if (
    output.completed_at_source !== undefined &&
    !["slurm", "sacct", "remote_file_mtime", "import_time"].includes(String(output.completed_at_source))
  ) {
    throw new PredictionJobValidationError("output.completed_at_source is not supported");
  }

  if (!Array.isArray(output.predictions)) {
    throw new PredictionJobValidationError("output.predictions must be an array");
  }
  if (output.status === "succeeded") {
    if (output.predictions.length === 0 || output.error !== undefined) {
      throw new PredictionJobValidationError(
        "successful output must contain predictions and must not contain an error",
      );
    }
    return {
      job_id,
      status: "succeeded",
      completed_at,
      canonical_molecule_smiles: nonEmptyString(
        output.canonical_molecule_smiles,
        "output.canonical_molecule_smiles",
      ),
      canonical_solvent_smiles: nonEmptyString(
        output.canonical_solvent_smiles,
        "output.canonical_solvent_smiles",
      ),
      predictions: output.predictions.map((item, index) =>
        parsePredictionItem(item, `output.predictions[${index}]`),
      ),
      ...(output.completed_at_source === undefined ? {} : {
        completed_at_source: output.completed_at_source as PredictionJobSuccessOutput["completed_at_source"],
      }),
      warnings: Array.isArray(output.warnings)
        ? output.warnings.map((warning, index) =>
            nonEmptyString(warning, `output.warnings[${index}]`),
          )
        : (() => {
            throw new PredictionJobValidationError("output.warnings must be an array");
          })(),
    };
  }
  if (output.status === "failed") {
    if (output.predictions.length !== 0) {
      throw new PredictionJobValidationError("failed output predictions must be empty");
    }
    return {
      job_id,
      status: "failed",
      completed_at,
      predictions: [],
      error: nonEmptyString(output.error, "output.error"),
    };
  }
  throw new PredictionJobValidationError(
    "output.status must be either succeeded or failed",
  );
});

export const duplicateCheckOutputSchema = schema<DuplicateCheckOutput>((value) => {
  const output = record(value, "output");
  exactKeys(
    output,
    [
      "exact_molecule_match",
      "exact_solvent_pair_match",
      "scaffold_match",
      "nearest_training_similarity",
      "nearest_training_molecule_smiles",
      "warnings",
      "error",
    ],
    "output",
  );
  for (const key of ["exact_molecule_match", "exact_solvent_pair_match", "scaffold_match"]) {
    if (typeof output[key] !== "boolean") {
      throw new PredictionJobValidationError(`output.${key} must be a boolean`);
    }
  }
  if (
    typeof output.nearest_training_similarity !== "number" ||
    !Number.isFinite(output.nearest_training_similarity) ||
    output.nearest_training_similarity < 0 ||
    output.nearest_training_similarity > 1
  ) {
    throw new PredictionJobValidationError(
      "output.nearest_training_similarity must be between 0 and 1",
    );
  }
  if (!Array.isArray(output.warnings)) {
    throw new PredictionJobValidationError("output.warnings must be an array");
  }
  return {
    exact_molecule_match: output.exact_molecule_match,
    exact_solvent_pair_match: output.exact_solvent_pair_match,
    scaffold_match: output.scaffold_match,
    nearest_training_similarity: output.nearest_training_similarity,
    nearest_training_molecule_smiles: nonEmptyString(
      output.nearest_training_molecule_smiles,
      "output.nearest_training_molecule_smiles",
    ),
    warnings: output.warnings.map((warning, index) =>
      nonEmptyString(warning, `output.warnings[${index}]`),
    ),
    ...(output.error === undefined
      ? {}
      : { error: nonEmptyString(output.error, "output.error") }),
  };
});

export function validatePredictionJobInput(value: unknown): PredictionJobInput {
  return predictionJobInputSchema.parse(value);
}

export function validatePredictionJobOutput(value: unknown): PredictionJobOutput {
  return predictionJobOutputSchema.parse(value);
}

export function validateDuplicateCheckInput(value: unknown): DuplicateCheckInput {
  return duplicateCheckInputSchema.parse(value);
}

export function validateDuplicateCheckOutput(value: unknown): DuplicateCheckOutput {
  return duplicateCheckOutputSchema.parse(value);
}

export type CreatePredictionJobInputOptions = {
  molecule_smiles: string;
  solvent_smiles: string;
  model_choice: string;
};

export function createPredictionJobInput(
  options: CreatePredictionJobInputOptions,
): PredictionJobInput {
  return validatePredictionJobInput({
    job_id: crypto.randomUUID(),
    user_id: "local_user",
    molecule_smiles: options.molecule_smiles,
    solvent_smiles: options.solvent_smiles,
    model_choice: options.model_choice,
    requested_at: new Date().toISOString(),
  });
}

export type CreateDuplicateCheckInputOptions = {
  molecule_smiles: string;
  solvent_smiles: string;
};

export function createDuplicateCheckInput(
  options: CreateDuplicateCheckInputOptions,
): DuplicateCheckInput {
  return validateDuplicateCheckInput({
    job_id: `duplicate-${crypto.randomUUID()}`,
    user_id: "local_user",
    molecule_smiles: options.molecule_smiles,
    solvent_smiles: options.solvent_smiles,
    requested_at: new Date().toISOString(),
  });
}
