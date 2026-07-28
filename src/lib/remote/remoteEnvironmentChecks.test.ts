import { describe, expect, it } from "vitest";
import { defaultNibiSettings } from "../../features/settings";
import {
  buildRemoteEnvironmentCheckDefinitions,
  getRemoteEnvironmentReadiness,
  operationDetail,
  reportToRemoteEnvironmentRows,
  resultToRemoteEnvironmentRow,
  validateRemoteEnvironmentLocalInputs,
  type EnvironmentCheckReport,
} from "./remoteEnvironmentChecks";
import type { RemoteCommandResult } from "./types";

const settings = {
  ...defaultNibiSettings,
  connection_mode: "interactive_mfa" as const,
  nibi_username: "alice",
  remote_project_path: "/home/alice/scratch/FluorCast",
  remote_jobs_path: "/home/alice/scratch/fluorcast-jobs",
  python_environment_path: "/home/alice/scratch/chemfluor_env/bin/python",
};

function result(exitCode: number, label = "check"): RemoteCommandResult {
  return {
    exit_code: exitCode,
    stdout: exitCode === 0 ? "ok" : "",
    stderr: exitCode === 0 ? "" : "missing",
    duration_ms: 12,
    command_label: label,
    redacted_command_preview: label,
  };
}

describe("remote environment checks", () => {
  it("defines the exact 17 check IDs in contract order", () => {
    expect(buildRemoteEnvironmentCheckDefinitions(settings).map((check) => check.id)).toEqual([
      "authenticated_session",
      "remote_project_path",
      "remote_project_readable",
      "remote_jobs_path",
      "remote_jobs_writable",
      "python_environment_exists",
      "python_environment_runs",
      "sbatch",
      "squeue",
      "sacct",
      "prediction_entry_point",
      "tree_model_artifacts",
      "neural_model_artifacts",
      "absorption_hybrid_artifacts",
      "emission_hybrid_artifacts",
      "quantum_yield_hybrid_artifacts",
      "upload_read_delete_smoke",
    ]);
  });

  it("generates project path check command", () => {
    const check = buildRemoteEnvironmentCheckDefinitions(settings).find((item) => item.id === "remote_project_path");

    expect(check?.commandSpec).toMatchObject({
      executable: "test",
      args: ["-d", "/home/alice/scratch/FluorCast"],
      redacted_preview: "test -d '/home/alice/scratch/FluorCast'",
    });
  });

  it("generates authenticated session reuse check first for manual MFA", () => {
    const checks = buildRemoteEnvironmentCheckDefinitions(settings);

    expect(checks[0]).toMatchObject({
      id: "authenticated_session",
      name: "Authenticated session reuse",
      commandSpec: {
        executable: "fluorcast-session-ready",
        redacted_preview: "test_manual_mfa_session",
      },
    });
  });

  it("generates project readability check command", () => {
    const check = buildRemoteEnvironmentCheckDefinitions(settings).find((item) => item.id === "remote_project_readable");

    expect(check?.commandSpec).toMatchObject({
      executable: "test",
      args: ["-r", "/home/alice/scratch/FluorCast"],
    });
  });

  it("generates jobs path mkdir/test command", () => {
    const check = buildRemoteEnvironmentCheckDefinitions(settings).find((item) => item.id === "remote_jobs_path");

    expect(check?.commandSpec).toMatchObject({
      executable: "bash",
      args: [
        "-lc",
        "mkdir -p '/home/alice/scratch/fluorcast-jobs' && test -d '/home/alice/scratch/fluorcast-jobs'",
      ],
    });
  });

  it("generates jobs path writable check command", () => {
    const check = buildRemoteEnvironmentCheckDefinitions(settings).find((item) => item.id === "remote_jobs_writable");

    expect(check?.commandSpec).toMatchObject({
      executable: "test",
      args: ["-w", "/home/alice/scratch/fluorcast-jobs"],
    });
  });

  it("generates python environment existence command", () => {
    const check = buildRemoteEnvironmentCheckDefinitions(settings).find((item) => item.id === "python_environment_exists");

    expect(check?.commandSpec).toMatchObject({
      executable: "test",
      args: ["-x", "/home/alice/scratch/chemfluor_env/bin/python"],
    });
  });

  it("generates python environment version command", () => {
    const check = buildRemoteEnvironmentCheckDefinitions(settings).find((item) => item.id === "python_environment_runs");

    expect(check?.commandSpec).toMatchObject({
      executable: "fluorcast-python-version",
      args: ["/home/alice/scratch/chemfluor_env/bin/python"],
    });
  });

  it("generates prediction entry point check command", () => {
    const check = buildRemoteEnvironmentCheckDefinitions(settings).find((item) => item.id === "prediction_entry_point");

    expect(check?.commandSpec).toMatchObject({
      executable: "test",
      args: ["-f", "/home/alice/scratch/FluorCast/scripts/run_prediction_job.py"],
    });
  });

  it("generates sbatch, squeue, and sacct command checks", () => {
    const checks = buildRemoteEnvironmentCheckDefinitions(settings);

    expect(checks.find((item) => item.id === "sbatch")?.commandSpec).toMatchObject({
      executable: "command",
      args: ["-v", "sbatch"],
    });
    expect(checks.find((item) => item.id === "squeue")?.commandSpec).toMatchObject({
      executable: "command",
      args: ["-v", "squeue"],
    });
    expect(checks.find((item) => item.id === "sacct")?.commandSpec).toMatchObject({
      executable: "command",
      args: ["-v", "sacct"],
    });
    expect(checks.find((item) => item.id === "sacct")?.optional).toBe(false);
  });

  it("generates trained model artifact directory checks", () => {
    const checks = buildRemoteEnvironmentCheckDefinitions(settings);

    expect(checks.find((item) => item.id === "tree_model_artifacts")?.commandSpec).toMatchObject({
      executable: "test",
      args: ["-d", "/home/alice/scratch/FluorCast/models/experiments_fluodb"],
    });
    expect(checks.find((item) => item.id === "neural_model_artifacts")?.commandSpec).toMatchObject({
      executable: "test",
      args: ["-d", "/home/alice/scratch/FluorCast/models/neural_experiments_fluodb"],
    });
    expect(checks.find((item) => item.id === "absorption_hybrid_artifacts")?.commandSpec).toMatchObject({
      executable: "test",
      args: ["-d", "/home/alice/scratch/FluorCast/models/production_hybrid/absorption_nm"],
    });
    expect(checks.find((item) => item.id === "emission_hybrid_artifacts")?.commandSpec).toMatchObject({
      executable: "test",
      args: ["-d", "/home/alice/scratch/FluorCast/models/production_hybrid/emission_nm"],
    });
    expect(checks.find((item) => item.id === "quantum_yield_hybrid_artifacts")?.commandSpec).toMatchObject({
      executable: "test",
      args: ["-d", "/home/alice/scratch/FluorCast/models/production_hybrid/quantum_yield"],
    });
  });

  it("generates upload/read/delete smoke test command", () => {
    const check = buildRemoteEnvironmentCheckDefinitions(settings).find((item) => item.id === "upload_read_delete_smoke");

    expect(check?.commandSpec).toMatchObject({
      executable: "fluorcast-upload-smoke-test",
      args: ["/home/alice/scratch/fluorcast-jobs"],
      redacted_preview: "create/read/delete <remote_jobs_path>/.fluorcast-smoke-*.txt",
    });
  });

  it("maps upload/read/delete smoke test failures to specific messages", () => {
    const check = buildRemoteEnvironmentCheckDefinitions(settings)
      .find((item) => item.id === "upload_read_delete_smoke")!;

    expect(resultToRemoteEnvironmentRow(check, {
      ...result(30, check.id),
      stdout: "SMOKE_ERROR=REMOTE_JOBS_PATH_EMPTY",
    }).message).toBe("Remote jobs path was empty before the smoke test ran.");
    expect(resultToRemoteEnvironmentRow(check, {
      ...result(31, check.id),
      stdout: "SMOKE_ERROR=CONTENT_MISMATCH",
    }).message).toBe("The smoke-test file contents did not match.");
    expect(resultToRemoteEnvironmentRow(check, {
      ...result(32, check.id),
      stdout: "SMOKE_ERROR=DELETE_FAILED",
    }).message).toBe("The smoke-test file could not be deleted.");
    expect(resultToRemoteEnvironmentRow(check, {
      ...result(1, check.id),
      stderr: "ssh failed",
    }).message).toBe("The authenticated remote smoke-test command failed.");
  });

  it("sacct failure is a required Stage 1 failure", () => {
    const rows = buildRemoteEnvironmentCheckDefinitions(settings).map((definition) =>
      resultToRemoteEnvironmentRow(definition, result(definition.id === "sacct" ? 1 : 0, definition.id)),
    );

    expect(rows.find((row) => row.id === "sacct")).toMatchObject({
      status: "failed",
      optional: false,
      message: "sacct is unavailable.",
    });
    expect(getRemoteEnvironmentReadiness(rows)).toEqual({
      ready: false,
      summary: "Remote environment needs attention",
    });
  });

  it("required check failure makes readiness false", () => {
    const rows = buildRemoteEnvironmentCheckDefinitions(settings).map((definition) =>
      resultToRemoteEnvironmentRow(definition, result(definition.id === "remote_project_path" ? 1 : 0, definition.id)),
    );

    expect(getRemoteEnvironmentReadiness(rows)).toEqual({
      ready: false,
      summary: "Remote environment needs attention",
    });
  });

  it("all required checks passing makes readiness true", () => {
    const rows = buildRemoteEnvironmentCheckDefinitions(settings).map((definition) =>
      resultToRemoteEnvironmentRow(definition, result(0, definition.id)),
    );

    expect(getRemoteEnvironmentReadiness(rows)).toEqual({
      ready: true,
      summary: "Remote environment ready",
    });
  });

  it("validates local inputs before running remote checks", () => {
    expect(validateRemoteEnvironmentLocalInputs({
      ...settings,
      nibi_username: "user",
      remote_project_path: "relative/project",
    }, false)).toEqual({
      valid: false,
      messages: [
        "Remote project path must be absolute.",
        "Enter your Alliance/NIBI username before running remote environment checks.",
        "Selected connection mode must be authenticated or verified.",
      ],
    });
  });

  it("maps backend report results by ID when the report order is shuffled", () => {
    const definitions = buildRemoteEnvironmentCheckDefinitions(settings);
    const checks = definitions
      .map((definition) => ({
        id: definition.id,
        status: definition.id === "sacct" ? "failed" as const : "passed" as const,
        summary: `${definition.id} summary`,
        detail: definition.id === "sacct" ? "sacct missing" : "",
        exit_code: definition.id === "sacct" ? 1 : 0,
        stdout: definition.id,
        stderr: definition.id === "sacct" ? "sacct missing" : "",
      }))
      .reverse();

    const rows = reportToRemoteEnvironmentRows(definitions, report({ status: "failed", checks }));

    expect(rows.map((row) => row.id)).toEqual(definitions.map((definition) => definition.id));
    expect(rows.find((row) => row.id === "sacct")).toMatchObject({
      status: "failed",
      message: "sacct summary",
      result: expect.objectContaining({
        exit_code: 1,
        stderr: "sacct missing",
      }),
    });
    expect(rows.find((row) => row.id === "remote_project_path")).toMatchObject({
      status: "passed",
      message: "remote_project_path summary",
    });
  });

  it("does not convert missing backend results into genuine environment failures", () => {
    const definitions = buildRemoteEnvironmentCheckDefinitions(settings);
    const rows = reportToRemoteEnvironmentRows(definitions, report({
      status: "runner_error",
      checks: [{
        id: "authenticated_session",
        status: "passed",
        summary: "Authenticated session reuse returned FLUORCAST_AUTH_OK.",
        exit_code: 0,
        stdout: "FLUORCAST_AUTH_OK",
        stderr: "",
      }],
      diagnostics: {
        parser_error: "Missing check IDs: remote_project_path.",
        missing_ids: ["remote_project_path"],
      },
    }));

    expect(rows.find((row) => row.id === "authenticated_session")).toMatchObject({
      status: "passed",
    });
    expect(rows.find((row) => row.id === "remote_project_path")).toMatchObject({
      status: "runner_error",
      message: "Not run because the batched environment-check report was incomplete.",
    });
    expect(rows.find((row) => row.id === "remote_project_path")?.result).toBeUndefined();
    expect(operationDetail(report({
      status: "runner_error",
      checks: [],
      diagnostics: {
        parser_error: "Missing check IDs.",
        missing_ids: ["remote_project_path"],
      },
    }))).toContain("PARSER_ERROR=Missing check IDs.");
  });
});

function report(overrides: Partial<EnvironmentCheckReport>): EnvironmentCheckReport {
  return {
    status: "passed",
    checks: [],
    diagnostics: {
      operation_status: overrides.status ?? "passed",
      wsl_launch_count: 1,
      ssh_launch_count: 1,
      expected_check_count: 17,
      parsed_check_count: overrides.checks?.length ?? 17,
      duplicate_ids: [],
      unknown_ids: [],
      missing_ids: [],
      malformed_rows: [],
      parser_error: null,
      ssh_exit_code: 0,
      timed_out: false,
      sanitized_stderr: "",
      total_duration_ms: 12,
      ...overrides.diagnostics,
    },
    started_at: "2026-07-27T00:00:00.000Z",
    completed_at: "2026-07-27T00:00:00.012Z",
    duration_ms: 12,
    operation_name: "run_nibi_environment_checks",
    timed_out: false,
    process_exit_code: 0,
    process_visibility: "hidden",
    backend_process_launches: 1,
    wsl_process_launches: 1,
    ssh_remote_sessions: 1,
    ...overrides,
  };
}
