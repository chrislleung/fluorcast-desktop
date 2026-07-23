import { describe, expect, it } from "vitest";
import { defaultNibiSettings } from "../../features/settings";
import {
  buildRemoteEnvironmentCheckDefinitions,
  getRemoteEnvironmentReadiness,
  resultToRemoteEnvironmentRow,
  validateRemoteEnvironmentLocalInputs,
} from "./remoteEnvironmentChecks";
import type { RemoteCommandResult } from "./types";

const settings = {
  ...defaultNibiSettings,
  connection_mode: "interactive_mfa" as const,
  nibi_username: "alice",
  remote_project_path: "/home/alice/scratch/FluorCast",
  remote_jobs_path: "/home/alice/scratch/fluorcast-jobs",
  python_environment_path: "/home/alice/scratch/FluorCast/.venv/bin/python",
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
      args: ["-x", "/home/alice/scratch/FluorCast/.venv/bin/python"],
    });
  });

  it("generates python environment version command", () => {
    const check = buildRemoteEnvironmentCheckDefinitions(settings).find((item) => item.id === "python_environment_runs");

    expect(check?.commandSpec).toMatchObject({
      executable: "fluorcast-python-version",
      args: ["/home/alice/scratch/FluorCast/.venv/bin/python"],
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
});
