import mockPredictionOutputFixture from "./mock-prediction-output.fixture.json";
import {
  validatePredictionJobOutput,
  type PredictionJobInput,
  type PredictionJobOutput,
} from "../schemas";

export const mockPredictionJobStatuses = [
  "queued_locally",
  "running",
  "completed",
] as const;

export type MockPredictionJobStatus = (typeof mockPredictionJobStatuses)[number];

export type LocalPredictionJob = {
  job_id: string;
  input: PredictionJobInput;
  status: MockPredictionJobStatus;
  created_at: string;
  updated_at: string;
  output?: PredictionJobOutput;
};

export type MockPredictionBackendOptions = {
  delayMs?: number;
  onStatusChange?: (job: LocalPredictionJob) => void | Promise<void>;
};

const DEFAULT_DELAY_MS = 10;

function wait(delayMs: number) {
  return new Promise((resolve) => window.setTimeout(resolve, delayMs));
}

function timestamp() {
  return new Date().toISOString();
}

function cloneJob(job: LocalPredictionJob): LocalPredictionJob {
  return {
    ...job,
    input: { ...job.input },
    output: job.output ? { ...job.output, predictions: [...job.output.predictions] } : undefined,
  };
}

function updateJob(
  job: LocalPredictionJob,
  status: MockPredictionJobStatus,
  output?: PredictionJobOutput,
): LocalPredictionJob {
  return {
    ...job,
    status,
    updated_at: timestamp(),
    ...(output ? { output } : {}),
  };
}

export function createLocalPredictionJob(input: PredictionJobInput): LocalPredictionJob {
  const now = timestamp();
  return {
    job_id: input.job_id,
    input,
    status: "queued_locally",
    created_at: now,
    updated_at: now,
  };
}

export function createMockPredictionOutput(input: PredictionJobInput): PredictionJobOutput {
  return validatePredictionJobOutput({
    ...mockPredictionOutputFixture,
    job_id: input.job_id,
    canonical_molecule_smiles: input.molecule_smiles,
    canonical_solvent_smiles: input.solvent_smiles,
  });
}

export async function runMockPredictionJob(
  input: PredictionJobInput,
  options: MockPredictionBackendOptions = {},
): Promise<LocalPredictionJob> {
  const delayMs = options.delayMs ?? DEFAULT_DELAY_MS;
  let job = createLocalPredictionJob(input);
  await options.onStatusChange?.(cloneJob(job));

  await wait(delayMs);
  job = updateJob(job, "running");
  await options.onStatusChange?.(cloneJob(job));

  await wait(delayMs);
  job = updateJob(job, "completed", createMockPredictionOutput(input));
  await options.onStatusChange?.(cloneJob(job));

  return cloneJob(job);
}

export { mockPredictionOutputFixture };
