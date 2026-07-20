import type { RemoteCommandResult } from "./types";

export type AppErrorCode =
  | "interactive_login_required"
  | "interactive_session_expired"
  | "robot_access_not_ready"
  | "robot_auth_failed"
  | "ssh_connection_failed"
  | "remote_command_not_allowed"
  | "remote_project_missing"
  | "slurm_unavailable"
  | "sbatch_failed"
  | "job_failed"
  | "output_missing"
  | "output_invalid"
  | "download_failed";

export type AppError = {
  code: AppErrorCode;
  message: string;
  technicalDetails?: string;
};

export const appErrorMessages: Record<AppErrorCode, string> = {
  interactive_login_required: "Log into NIBI first, then retry this action.",
  interactive_session_expired: "Your NIBI login session expired. Reconnect to NIBI, then refresh this job.",
  robot_access_not_ready: "Robot automation is not ready. Upload the restricted public key to Alliance/CCDB and ask support to enable robot-node access.",
  robot_auth_failed: "Robot automation could not authenticate to the robot node.",
  ssh_connection_failed: "Could not connect to NIBI over SSH. Check your network, host, username, and SSH key settings.",
  remote_command_not_allowed: "The robot node rejected this command. The command may not be allowed by allowed_commands.sh.",
  remote_project_missing: "The remote FluorCast project path was not found. Check the project path in Settings.",
  slurm_unavailable: "Slurm is unavailable from this session. Check the NIBI environment or robot command allow-list.",
  sbatch_failed: "Slurm rejected the job submission.",
  job_failed: "The remote prediction job failed.",
  output_missing: "The job finished, but output.json is not available yet.",
  output_invalid: "Remote output.json was downloaded but is not valid FluorCast prediction output.",
  download_failed: "Could not download remote output.json.",
};

const sensitivePatterns = [
  /password[:\s]?/i,
  /duo/i,
  /passcode/i,
  /verification/i,
  /keyboard-interactive/i,
  /multifactor authentication/i,
];

function containsSensitiveAuthText(text: string) {
  return sensitivePatterns.some((pattern) => pattern.test(text));
}

export function redactRemoteErrorText(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => (containsSensitiveAuthText(line) ? "[redacted authentication prompt]" : line))
    .filter((line, index, lines) => index === 0 || line !== lines[index - 1])
    .join("\n");
}

export function hasInteractiveAuthPrompt(text: string): boolean {
  return containsSensitiveAuthText(text)
    || text.includes("Permission denied (publickey,keyboard-interactive,hostbased)");
}

function commandText(result: Pick<RemoteCommandResult, "stdout" | "stderr">) {
  return [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
}

export function appError(
  code: AppErrorCode,
  technicalDetails?: string,
): AppError {
  const redactedDetails = technicalDetails ? redactRemoteErrorText(technicalDetails) : undefined;
  return {
    code,
    message: appErrorMessages[code],
    ...(redactedDetails ? { technicalDetails: redactedDetails } : {}),
  };
}

export function classifyRemoteCommandFailure(
  result: RemoteCommandResult,
  context: "ssh" | "slurm_poll" | "sbatch" | "output" = "ssh",
): AppError {
  const text = commandText(result);
  const lower = text.toLowerCase();
  if (
    lower.includes("allowed_commands")
    || lower.includes("not allowed")
    || lower.includes("rejected this command")
  ) {
    return appError("remote_command_not_allowed", text);
  }
  if (hasInteractiveAuthPrompt(text)) {
    return appError("interactive_session_expired", text);
  }
  if (
    lower.includes("no such file or directory")
    && (lower.includes("fluorcast") || lower.includes("run_prediction") || lower.includes("run_duplicate"))
  ) {
    return appError("remote_project_missing", text);
  }
  if (
    lower.includes("squeue: command not found")
    || lower.includes("sacct: command not found")
    || lower.includes("sbatch: command not found")
    || lower.includes("slurm")
  ) {
    return appError(context === "sbatch" ? "sbatch_failed" : "slurm_unavailable", text);
  }
  if (context === "sbatch") {
    return appError("sbatch_failed", text);
  }
  return appError("ssh_connection_failed", text);
}
