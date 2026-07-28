import {
  isAbsolutePath,
  trimNibiSettings,
  type NibiSettings,
} from "../../features/settings";
import type { RemoteCommandResult, RemoteCommandSpec } from "./types";

export type RemoteEnvironmentCheckStatus = "not_run" | "running" | "passed" | "failed" | "runner_error";

export type RemoteEnvironmentCheckId =
  | "authenticated_session"
  | "remote_project_path"
  | "remote_project_readable"
  | "remote_jobs_path"
  | "remote_jobs_writable"
  | "python_environment_exists"
  | "python_environment_runs"
  | "sbatch"
  | "squeue"
  | "sacct"
  | "prediction_entry_point"
  | "tree_model_artifacts"
  | "neural_model_artifacts"
  | "absorption_hybrid_artifacts"
  | "emission_hybrid_artifacts"
  | "quantum_yield_hybrid_artifacts"
  | "upload_read_delete_smoke";

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

export type EnvironmentCheckResult = {
  id: RemoteEnvironmentCheckId;
  status: "passed" | "failed" | "running" | "not_run" | "runner_error";
  summary: string;
  detail?: string | null;
  exit_code?: number | null;
  stdout?: string;
  stderr?: string;
};

export type EnvironmentCheckDiagnostics = {
  operation_status: string;
  wsl_launch_count: number;
  ssh_launch_count: number;
  expected_check_count: number;
  parsed_check_count: number;
  duplicate_ids: string[];
  unknown_ids: string[];
  missing_ids: string[];
  malformed_rows: string[];
  parser_error?: string | null;
  ssh_exit_code?: number | null;
  timed_out: boolean;
  sanitized_stderr: string;
  total_duration_ms: number;
};

export type EnvironmentCheckReport = {
  status: string;
  checks: EnvironmentCheckResult[];
  diagnostics?: EnvironmentCheckDiagnostics;
  started_at: string;
  completed_at: string;
  duration_ms: number;
  operation_name: string;
  timed_out: boolean;
  process_exit_code?: number | null;
  process_visibility: "hidden" | "visible";
  backend_process_launches: number;
  wsl_process_launches: number;
  ssh_remote_sessions: number;
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

function resultMarker(stdout: string, marker: string): string | undefined {
  const prefix = `${marker}=`;
  return stdout
    .split(/\r?\n/)
    .find((line) => line.trim().startsWith(prefix))
    ?.trim()
    .slice(prefix.length);
}

function smokeFailureMessage(result: RemoteCommandResult): string {
  const failureCode = resultMarker(result.stdout, "SMOKE_ERROR");

  if (result.exit_code === 30 || failureCode === "REMOTE_JOBS_PATH_EMPTY") {
    return "Remote jobs path was empty before the smoke test ran.";
  }
  if (result.exit_code === 31 || failureCode === "CONTENT_MISMATCH") {
    return "The smoke-test file contents did not match.";
  }
  if (result.exit_code === 32 || failureCode === "DELETE_FAILED") {
    return "The smoke-test file could not be deleted.";
  }

  return "The authenticated remote smoke-test command failed.";
}

function modelDirectoryCheck(
  id: Extract<RemoteEnvironmentCheckId, "tree_model_artifacts" | "neural_model_artifacts" | "absorption_hybrid_artifacts" | "emission_hybrid_artifacts" | "quantum_yield_hybrid_artifacts">,
  name: string,
  settings: NibiSettings,
  remoteProjectPath: string,
  relativePath: string,
  successMessage: string,
): RemoteEnvironmentCheckDefinition {
  const path = `${remoteProjectPath}/${relativePath}`;
  return {
    id,
    name,
    optional: false,
    commandSpec: withSettings({
      label: name,
      executable: "test",
      args: ["-d", path],
      redacted_preview: `test -d ${shellQuote(path)}`,
    }, settings),
    successMessage,
    failureMessage: `Missing model artifacts: ${relativePath}. Complete the training instructions in Required Nibi setup.`,
  };
}

export function buildRemoteEnvironmentCheckDefinitions(settings: NibiSettings): RemoteEnvironmentCheckDefinition[] {
  const trimmed = trimNibiSettings(settings);
  const predictionScriptPath = `${trimmed.remote_project_path}/scripts/run_prediction_job.py`;
  const jobsCommand = `mkdir -p ${shellQuote(trimmed.remote_jobs_path)} && test -d ${shellQuote(trimmed.remote_jobs_path)}`;
  const checks: RemoteEnvironmentCheckDefinition[] = [];

  if (trimmed.connection_mode === "interactive_mfa") {
    checks.push({
      id: "authenticated_session",
      name: "Authenticated session reuse",
      optional: false,
      commandSpec: withSettings({
        label: "Authenticated session reuse",
        executable: "fluorcast-session-ready",
        args: [],
        redacted_preview: "test_manual_mfa_session",
      }, trimmed),
      successMessage: "Authenticated session reuse returned FLUORCAST_AUTH_OK.",
      failureMessage: "Authenticated session reuse failed.",
    });
  }

  checks.push(
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
      id: "remote_project_readable",
      name: "Remote project path is readable",
      optional: false,
      commandSpec: withSettings({
        label: "Remote project path is readable",
        executable: "test",
        args: ["-r", trimmed.remote_project_path],
        redacted_preview: `test -r ${shellQuote(trimmed.remote_project_path)}`,
      }, trimmed),
      successMessage: "Remote project path is readable.",
      failureMessage: "Remote project path is not readable.",
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
      id: "remote_jobs_writable",
      name: "Remote jobs path is writable",
      optional: false,
      commandSpec: withSettings({
        label: "Remote jobs path is writable",
        executable: "test",
        args: ["-w", trimmed.remote_jobs_path],
        redacted_preview: `test -w ${shellQuote(trimmed.remote_jobs_path)}`,
      }, trimmed),
      successMessage: "Remote jobs path is writable.",
      failureMessage: "Remote jobs path is not writable.",
    },
    {
      id: "python_environment_exists",
      name: "Python executable exists",
      optional: false,
      commandSpec: withSettings({
        label: "Python executable exists",
        executable: "test",
        args: ["-x", trimmed.python_environment_path],
        redacted_preview: `test -x ${shellQuote(trimmed.python_environment_path)}`,
      }, trimmed),
      successMessage: "Python executable exists.",
      failureMessage: "Python executable was not found or is not executable.",
    },
    {
      id: "python_environment_runs",
      name: "Python executable reports version",
      optional: false,
      commandSpec: withSettings({
        label: "Python executable reports version",
        executable: "fluorcast-python-version",
        args: [trimmed.python_environment_path],
        redacted_preview: `${shellQuote(trimmed.python_environment_path)} --version`,
      }, trimmed),
      successMessage: "Python executable reports its version.",
      failureMessage: "Python executable was not found or did not run.",
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
      optional: false,
      commandSpec: withSettings({
        label: "sacct is available",
        executable: "command",
        args: ["-v", "sacct"],
        redacted_preview: "command -v sacct",
      }, trimmed),
      successMessage: "sacct is available.",
      failureMessage: "sacct is unavailable.",
    },
    {
      id: "prediction_entry_point",
      name: "Prediction entry point exists",
      optional: false,
      commandSpec: withSettings({
        label: "Prediction entry point exists",
        executable: "test",
        args: ["-f", predictionScriptPath],
        redacted_preview: `test -f ${shellQuote(predictionScriptPath)}`,
      }, trimmed),
      successMessage: "Prediction entry point exists.",
      failureMessage: "Prediction entry point was not found.",
    },
    modelDirectoryCheck(
      "tree_model_artifacts",
      "Tree model artifacts exist",
      trimmed,
      trimmed.remote_project_path,
      "models/experiments_fluodb",
      "Tree model artifacts exist.",
    ),
    modelDirectoryCheck(
      "neural_model_artifacts",
      "Neural model artifacts exist",
      trimmed,
      trimmed.remote_project_path,
      "models/neural_experiments_fluodb",
      "Neural model artifacts exist.",
    ),
    modelDirectoryCheck(
      "absorption_hybrid_artifacts",
      "Absorption hybrid artifacts exist",
      trimmed,
      trimmed.remote_project_path,
      "models/production_hybrid/absorption_nm",
      "Absorption hybrid artifacts exist.",
    ),
    modelDirectoryCheck(
      "emission_hybrid_artifacts",
      "Emission hybrid artifacts exist",
      trimmed,
      trimmed.remote_project_path,
      "models/production_hybrid/emission_nm",
      "Emission hybrid artifacts exist.",
    ),
    modelDirectoryCheck(
      "quantum_yield_hybrid_artifacts",
      "Quantum-yield hybrid artifacts exist",
      trimmed,
      trimmed.remote_project_path,
      "models/production_hybrid/quantum_yield",
      "Quantum-yield hybrid artifacts exist.",
    ),
    {
      id: "upload_read_delete_smoke",
      name: "Upload/read/delete smoke test",
      optional: false,
      commandSpec: withSettings({
        label: "Upload/read/delete smoke test",
        executable: "fluorcast-upload-smoke-test",
        args: [trimmed.remote_jobs_path],
        redacted_preview: "create/read/delete <remote_jobs_path>/.fluorcast-smoke-*.txt",
      }, trimmed),
      successMessage: "Remote jobs path passed the create/read/delete smoke test.",
      failureMessage: "Remote jobs path failed the create/read/delete smoke test.",
    },
  );

  return checks;
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
  const message = passed
    ? definition.successMessage
    : definition.id === "upload_read_delete_smoke"
    ? smokeFailureMessage(result)
    : definition.failureMessage;
  return {
    ...definition,
    status: passed ? "passed" : "failed",
    message,
    result,
  };
}

export function reportToRemoteEnvironmentRows(
  definitions: RemoteEnvironmentCheckDefinition[],
  report: EnvironmentCheckReport,
): RemoteEnvironmentCheckRow[] {
  const resultById = new Map(report.checks.map((check) => [check.id, check]));
  return definitions.map((definition) => {
    const check = resultById.get(definition.id);
    if (!check) {
      return {
        ...definition,
        status: report.status === "runner_error" || report.diagnostics?.parser_error ? "runner_error" : "not_run",
        message: "Not run because the batched environment-check report was incomplete.",
      };
    }
    const status = check.status === "passed"
      ? "passed"
      : check.status === "failed"
      ? "failed"
      : check.status === "runner_error"
      ? "runner_error"
      : "not_run";
    return {
      ...definition,
      status,
      message: check.summary,
      result: createReportCommandResult(
        definition,
        report,
        check.exit_code ?? (check.status === "passed" ? 0 : check.status === "failed" ? 1 : null),
        check.detail ?? operationDetail(report),
        check.stdout,
        check.stderr,
      ),
    };
  });
}

function createReportCommandResult(
  definition: RemoteEnvironmentCheckDefinition,
  report: EnvironmentCheckReport,
  exitCode: number | null,
  detail: string,
  stdout?: string,
  stderr?: string,
): RemoteCommandResult {
  return {
    exit_code: exitCode ?? 0,
    stdout: stdout ?? detail,
    stderr: stderr ?? (exitCode === 0 ? "" : detail),
    duration_ms: report.duration_ms,
    command_label: definition.name,
    redacted_command_preview: "run_nibi_environment_checks",
    timed_out: report.timed_out,
  };
}

export function operationDetail(report: EnvironmentCheckReport): string {
  const diagnostics = report.diagnostics;
  if (!diagnostics) {
    return "";
  }
  const duplicateIds = diagnostics.duplicate_ids ?? [];
  const unknownIds = diagnostics.unknown_ids ?? [];
  const missingIds = diagnostics.missing_ids ?? [];
  const malformedRows = diagnostics.malformed_rows ?? [];
  return [
    `OPERATION_STATUS=${diagnostics.operation_status}`,
    `WSL_LAUNCH_COUNT=${diagnostics.wsl_launch_count}`,
    `SSH_LAUNCH_COUNT=${diagnostics.ssh_launch_count}`,
    `EXPECTED_CHECK_COUNT=${diagnostics.expected_check_count}`,
    `PARSED_CHECK_COUNT=${diagnostics.parsed_check_count}`,
    `DUPLICATE_IDS=${duplicateIds.join(",")}`,
    `UNKNOWN_IDS=${unknownIds.join(",")}`,
    `MISSING_IDS=${missingIds.join(",")}`,
    `MALFORMED_ROWS=${malformedRows.length}`,
    `SSH_EXIT_CODE=${diagnostics.ssh_exit_code ?? "none"}`,
    `TIMED_OUT=${diagnostics.timed_out}`,
    `SANITIZED_STDERR=${diagnostics.sanitized_stderr}`,
    `PARSER_ERROR=${diagnostics.parser_error ?? ""}`,
    `TOTAL_DURATION_MS=${diagnostics.total_duration_ms}`,
  ].join("\n");
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
