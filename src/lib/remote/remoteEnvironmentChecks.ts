import {
  isAbsolutePath,
  trimNibiSettings,
  type NibiSettings,
} from "../../features/settings";
import type { RemoteCommandResult, RemoteCommandSpec } from "./types";

export type RemoteEnvironmentCheckStatus = "not_run" | "running" | "passed" | "failed";

export type RemoteEnvironmentCheckId =
  | "remote_project_path"
  | "remote_jobs_path"
  | "python_environment"
  | "prediction_script"
  | "slurm_script"
  | "sbatch"
  | "squeue"
  | "sacct";

export type RemoteEnvironmentCheckDefinition = {
  id: RemoteEnvironmentCheckId;
  name: string;
  optional: boolean;
  commandSpec: RemoteCommandSpec;
  successMessage: string;
  failureMessage: string;
};

export type RemoteEnvironmentCheckRow = RemoteEnvironmentCheckDefinition & {
  status: RemoteEnvironmentCheckStatus;
  message: string;
  result?: RemoteCommandResult;
};

export type RemoteEnvironmentReadiness = {
  ready: boolean;
  summary: "Remote environment ready" | "Remote environment needs attention" | "Remote environment checks not run";
};

export type RemoteEnvironmentLocalValidation = {
  valid: boolean;
  messages: string[];
};

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function withSettings(commandSpec: Omit<RemoteCommandSpec, "settings">, settings: NibiSettings): RemoteCommandSpec {
  return {
    ...commandSpec,
    settings,
  };
}

export function buildRemoteEnvironmentCheckDefinitions(settings: NibiSettings): RemoteEnvironmentCheckDefinition[] {
  const trimmed = trimNibiSettings(settings);
  const predictionScriptPath = `${trimmed.remote_project_path}/scripts/run_prediction_job.py`;
  const slurmScriptPath = `${trimmed.remote_project_path}/slurm/run_prediction_job.sbatch`;
  const jobsCommand = `mkdir -p ${shellQuote(trimmed.remote_jobs_path)} && test -d ${shellQuote(trimmed.remote_jobs_path)}`;

  return [
    {
      id: "remote_project_path",
      name: "Remote project path exists",
      optional: false,
      commandSpec: withSettings({
        label: "Remote project path exists",
        executable: "test",
        args: ["-d", trimmed.remote_project_path],
        redacted_preview: `test -d ${shellQuote(trimmed.remote_project_path)}`,
      }, trimmed),
      successMessage: "Remote project path exists.",
      failureMessage: "Remote project path was not found.",
    },
    {
      id: "remote_jobs_path",
      name: "Remote jobs path exists or can be created",
      optional: false,
      commandSpec: withSettings({
        label: "Remote jobs path exists or can be created",
        executable: "bash",
        args: ["-lc", jobsCommand],
        redacted_preview: jobsCommand,
      }, trimmed),
      successMessage: "Remote jobs path exists or was created.",
      failureMessage: "Remote jobs path could not be created or verified.",
    },
    {
      id: "python_environment",
      name: "Python environment exists",
      optional: false,
      commandSpec: withSettings({
        label: "Python environment exists",
        executable: "test",
        args: ["-x", trimmed.python_environment_path],
        redacted_preview: `test -x ${shellQuote(trimmed.python_environment_path)}`,
      }, trimmed),
      successMessage: "Python environment is executable.",
      failureMessage: "Python environment was not found or is not executable.",
    },
    {
      id: "prediction_script",
      name: "Prediction script exists",
      optional: false,
      commandSpec: withSettings({
        label: "Prediction script exists",
        executable: "test",
        args: ["-f", predictionScriptPath],
        redacted_preview: `test -f ${shellQuote(predictionScriptPath)}`,
      }, trimmed),
      successMessage: "Prediction script exists.",
      failureMessage: "Prediction script was not found.",
    },
    {
      id: "slurm_script",
      name: "Slurm prediction script exists",
      optional: false,
      commandSpec: withSettings({
        label: "Slurm prediction script exists",
        executable: "test",
        args: ["-f", slurmScriptPath],
        redacted_preview: `test -f ${shellQuote(slurmScriptPath)}`,
      }, trimmed),
      successMessage: "Slurm prediction script exists.",
      failureMessage: "Slurm prediction script was not found.",
    },
    {
      id: "sbatch",
      name: "sbatch is available",
      optional: false,
      commandSpec: withSettings({
        label: "sbatch is available",
        executable: "command",
        args: ["-v", "sbatch"],
        redacted_preview: "command -v sbatch",
      }, trimmed),
      successMessage: "sbatch is available.",
      failureMessage: "sbatch is unavailable.",
    },
    {
      id: "squeue",
      name: "squeue is available",
      optional: false,
      commandSpec: withSettings({
        label: "squeue is available",
        executable: "command",
        args: ["-v", "squeue"],
        redacted_preview: "command -v squeue",
      }, trimmed),
      successMessage: "squeue is available.",
      failureMessage: "squeue is unavailable.",
    },
    {
      id: "sacct",
      name: "sacct is available",
      optional: true,
      commandSpec: withSettings({
        label: "sacct is available",
        executable: "command",
        args: ["-v", "sacct"],
        redacted_preview: "command -v sacct",
      }, trimmed),
      successMessage: "sacct is available.",
      failureMessage: "sacct is unavailable. Job polling may fall back to squeue/output-file checks.",
    },
  ];
}

export function createInitialRemoteEnvironmentRows(settings: NibiSettings): RemoteEnvironmentCheckRow[] {
  return buildRemoteEnvironmentCheckDefinitions(settings).map((definition) => ({
    ...definition,
    status: "not_run",
    message: "Not run.",
  }));
}

export function resultToRemoteEnvironmentRow(
  definition: RemoteEnvironmentCheckDefinition,
  result: RemoteCommandResult,
): RemoteEnvironmentCheckRow {
  const passed = result.exit_code === 0;
  return {
    ...definition,
    status: passed ? "passed" : "failed",
    message: passed ? definition.successMessage : definition.failureMessage,
    result,
  };
}

export function getRemoteEnvironmentReadiness(rows: RemoteEnvironmentCheckRow[]): RemoteEnvironmentReadiness {
  if (rows.every((row) => row.status === "not_run")) {
    return {
      ready: false,
      summary: "Remote environment checks not run",
    };
  }

  const requiredRows = rows.filter((row) => !row.optional);
  const ready = requiredRows.length > 0 && requiredRows.every((row) => row.status === "passed");
  return {
    ready,
    summary: ready ? "Remote environment ready" : "Remote environment needs attention",
  };
}

export function validateRemoteEnvironmentLocalInputs(
  settings: NibiSettings,
  isConnectionReady: boolean,
): RemoteEnvironmentLocalValidation {
  const trimmed = trimNibiSettings(settings);
  const messages: string[] = [];

  if (!isAbsolutePath(trimmed.remote_project_path)) {
    messages.push("Remote project path must be absolute.");
  }
  if (!isAbsolutePath(trimmed.remote_jobs_path)) {
    messages.push("Remote jobs path must be absolute.");
  }
  if (!isAbsolutePath(trimmed.python_environment_path)) {
    messages.push("Python environment path must be absolute.");
  }
  if (!trimmed.nibi_username || trimmed.nibi_username === "user") {
    messages.push("Enter your Alliance/NIBI username before running remote environment checks.");
  }
  if (!isConnectionReady) {
    messages.push("Selected connection mode must be authenticated or verified.");
  }

  return {
    valid: messages.length === 0,
    messages,
  };
}
