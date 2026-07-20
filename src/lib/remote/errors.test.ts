import { describe, expect, it } from "vitest";
import {
  appErrorMessages,
  classifyRemoteCommandFailure,
  hasInteractiveAuthPrompt,
  redactRemoteErrorText,
} from "./errors";
import type { RemoteCommandResult } from "./types";

function result(stderr: string): RemoteCommandResult {
  return {
    exit_code: 1,
    stdout: "",
    stderr,
    duration_ms: 1,
    command_label: "Remote command",
    redacted_command_preview: "ssh <host> <command>",
  };
}

describe("remote AppError mapping", () => {
  it("maps SSH MFA prompts to expired interactive sessions", () => {
    const error = classifyRemoteCommandFailure(
      result("alice@nibi.alliancecan.ca's password:\nDuo two-factor login for alice"),
      "slurm_poll",
    );

    expect(error.code).toBe("interactive_session_expired");
    expect(error.message).toBe(appErrorMessages.interactive_session_expired);
    expect(error.technicalDetails).toBe("[redacted authentication prompt]");
    expect(error.technicalDetails).not.toMatch(/password|duo/i);
  });

  it("maps robot command rejection to allowed_commands guidance", () => {
    const error = classifyRemoteCommandFailure(
      result("allowed_commands.sh: command not allowed: sacct"),
      "slurm_poll",
    );

    expect(error.code).toBe("remote_command_not_allowed");
    expect(error.message).toBe(appErrorMessages.remote_command_not_allowed);
  });

  it("maps Slurm command failures separately from SSH failures", () => {
    expect(classifyRemoteCommandFailure(result("squeue: command not found"), "slurm_poll").code)
      .toBe("slurm_unavailable");
    expect(classifyRemoteCommandFailure(result("ssh: connect to host nibi port 22: Connection timed out"), "ssh").code)
      .toBe("ssh_connection_failed");
  });

  it("redacts password and MFA text from logs", () => {
    expect(hasInteractiveAuthPrompt("Verification code:")).toBe(true);
    expect(redactRemoteErrorText("Password:\npasscode: 123456\nordinary failure"))
      .toBe("[redacted authentication prompt]\nordinary failure");
  });
});
