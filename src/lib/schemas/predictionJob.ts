export const predictionJobStatuses = [
  "queued",
  "running",
  "succeeded",
  "failed",
] as const;

export type PredictionJobStatus = (typeof predictionJobStatuses)[number];

export type ApplicabilityDomain = {
  in_domain: boolean;
  score: number;
  message?: string;
};

export type ResultApplicabilityDomain = {
  nearest_training_similarity: number;
  outside_applicability_domain: boolean;
  exact_molecule_match: boolean;
  exact_solvent_pair_match: boolean;
  scaffold_match: boolean;
};

export type PredictionItem = {
  property: string;
  value: number;
  unit: string;
  model: string;
  applicability_domain: ApplicabilityDomain;
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
};

export type PredictionJobSuccessOutput = PredictionJobOutputBase & {
  status: "succeeded";
  canonical_molecule_smiles: string;
  canonical_solvent_smiles: string;
  predictions: PredictionItem[];
  applicability_domain: ResultApplicabilityDomain;
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

function parseApplicabilityDomain(value: unknown, path: string): ApplicabilityDomain {
  const item = record(value, path);
  exactKeys(item, ["in_domain", "score", "message"], path);
  if (typeof item.in_domain !== "boolean") {
    throw new PredictionJobValidationError(`${path}.in_domain must be a boolean`);
  }
  if (typeof item.score !== "number" || !Number.isFinite(item.score) || item.score < 0 || item.score > 1) {
    throw new PredictionJobValidationError(`${path}.score must be between 0 and 1`);
  }
  return {
    in_domain: item.in_domain,
    score: item.score,
    ...(item.message === undefined
      ? {}
      : { message: nonEmptyString(item.message, `${path}.message`) }),
  };
}

function parseResultApplicabilityDomain(
  value: unknown,
  path: string,
): ResultApplicabilityDomain {
  const item = record(value, path);
  exactKeys(
    item,
    [
      "nearest_training_similarity",
      "outside_applicability_domain",
      "exact_molecule_match",
      "exact_solvent_pair_match",
      "scaffold_match",
    ],
    path,
  );
  if (
    typeof item.nearest_training_similarity !== "number" ||
    !Number.isFinite(item.nearest_training_similarity) ||
    item.nearest_training_similarity < 0 ||
    item.nearest_training_similarity > 1
  ) {
    throw new PredictionJobValidationError(
      `${path}.nearest_training_similarity must be between 0 and 1`,
    );
  }
  for (const key of [
    "outside_applicability_domain",
    "exact_molecule_match",
    "exact_solvent_pair_match",
    "scaffold_match",
  ]) {
    if (typeof item[key] !== "boolean") {
      throw new PredictionJobValidationError(`${path}.${key} must be a boolean`);
    }
  }
  return {
    nearest_training_similarity: item.nearest_training_similarity,
    outside_applicability_domain: item.outside_applicability_domain,
    exact_molecule_match: item.exact_molecule_match,
    exact_solvent_pair_match: item.exact_solvent_pair_match,
    scaffold_match: item.scaffold_match,
  };
}

function parsePredictionItem(value: unknown, path: string): PredictionItem {
  const item = record(value, path);
  exactKeys(item, ["property", "value", "unit", "model", "applicability_domain"], path);
  if (typeof item.value !== "number" || !Number.isFinite(item.value)) {
    throw new PredictionJobValidationError(`${path}.value must be a finite number`);
  }
  return {
    property: nonEmptyString(item.property, `${path}.property`),
    value: item.value,
    unit: nonEmptyString(item.unit, `${path}.unit`),
    model: nonEmptyString(item.model, `${path}.model`),
    applicability_domain: parseApplicabilityDomain(
      item.applicability_domain,
      `${path}.applicability_domain`,
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
      "applicability_domain",
      "warnings",
      "error",
    ],
    "output",
  );
  const job_id = nonEmptyString(output.job_id, "output.job_id");
  const completed_at = isoDate(output.completed_at, "output.completed_at");

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
      applicability_domain: parseResultApplicabilityDomain(
        output.applicability_domain,
        "output.applicability_domain",
      ),
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

export function validatePredictionJobInput(value: unknown): PredictionJobInput {
  return predictionJobInputSchema.parse(value);
}

export function validatePredictionJobOutput(value: unknown): PredictionJobOutput {
  return predictionJobOutputSchema.parse(value);
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
