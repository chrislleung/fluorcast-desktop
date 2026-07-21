import { describe, expect, it, vi } from "vitest";
import { defaultNibiSettings } from "../../features/settings";
import {
  createRemoteExecutor,
  InteractiveMfaRemoteExecutor,
  MockRemoteExecutor,
  RobotAutomationRemoteExecutor,
} from "./RemoteExecutor";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => ({
    exit_code: 0,
    stdout: "",
    stderr: "",
    duration_ms: 1,
    command_label: "Remote command",
    redacted_command_preview: "remote <redacted>",
  })),
}));

describe("remote executor factory", () => {
  it("returns the correct executor for each mode", () => {
    expect(createRemoteExecutor("mock")).toBeInstanceOf(MockRemoteExecutor);
    expect(createRemoteExecutor("interactive_mfa")).toBeInstanceOf(InteractiveMfaRemoteExecutor);
    expect(createRemoteExecutor("robot_automation")).toBeInstanceOf(RobotAutomationRemoteExecutor);
  });

  it("mock executor works", async () => {
    const executor = createRemoteExecutor("mock");
    const result = await executor.runCommand({
      label: "Probe",
      executable: "echo",
      args: ["ok"],
    });

    expect(executor.getMode()).toBe("mock");
    expect(executor.getConnectionStatus(defaultNibiSettings).state).toBe("authenticated");
    expect(result).toMatchObject({
      exit_code: 0,
      stdout: "mock command: Probe",
      stderr: "",
      command_label: "Probe",
      redacted_command_preview: "echo ok",
    });
  });

  it("interactive executor reports not authenticated until login exists", () => {
    const executor = createRemoteExecutor("interactive_mfa");

    expect(executor.getConnectionStatus({
      ...defaultNibiSettings,
      connection_mode: "interactive_mfa",
      manual_mfa_provider: "persistent_shell",
      manual_login_verified: false,
    })).toMatchObject({
      state: "authentication_required",
      host: "nibi.alliancecan.ca",
    });
  });

  it("interactive executor blocks remote operations until authenticated", async () => {
    const executor = createRemoteExecutor("interactive_mfa");
    const result = await executor.runCommand({
      label: "Background probe",
      executable: "ssh",
      redacted_preview: "ssh <redacted>",
    });

    expect(result).toMatchObject({
      exit_code: 1,
      command_label: "Background probe",
      redacted_command_preview: "ssh <redacted>",
    });
    expect(result.stderr).toContain("Manual MFA login is not authenticated");
  });

  it("legacy terminal-action Manual MFA settings do not bypass session auth", async () => {
    vi.mocked(invoke).mockClear();
    const executor = createRemoteExecutor("interactive_mfa");
    const settings = {
      ...defaultNibiSettings,
      connection_mode: "interactive_mfa" as const,
      manual_mfa_provider: "terminal_action",
      nibi_username: "alice",
      ssh_private_key_path: "C:\\Users\\Alice\\.ssh\\fluorcast_nibi",
    } as unknown as typeof defaultNibiSettings;

    expect(executor.getConnectionStatus(settings)).toMatchObject({
      state: "authentication_required",
      label: "Login required",
    });

    const result = await executor.runCommand({
      label: "Submit prediction Slurm job",
      executable: "sbatch",
      args: ["--parsable", "/project/slurm/run_prediction_job.sbatch", "/jobs/job-1/input.json", "/jobs/job-1/output.json"],
      settings,
    });

    expect(result.exit_code).toBe(1);
    expect(result.stderr).toContain("Manual MFA login is not authenticated");
    expect(invoke).not.toHaveBeenCalledWith("run_nibi_remote_command", expect.anything());
  });

  it("robot executor uses robot host, not normal login host", () => {
    const executor = new RobotAutomationRemoteExecutor();

    expect(executor.getConnectionStatus({
      ...defaultNibiSettings,
      connection_mode: "robot_automation",
      nibi_username: "alice",
      normal_login_host: "nibi.alliancecan.ca",
      robot_login_host: "robot.nibi.alliancecan.ca",
      ssh_private_key_path: "C:\\Users\\Alice\\.ssh\\fluorcast_robot",
      robot_access_verified: true,
    })).toMatchObject({
      state: "robot_automation_ready",
      host: "robot.nibi.alliancecan.ca",
    });
  });

  it("robot mode blocks remote operations until robot access is verified", async () => {
    const executor = createRemoteExecutor("robot_automation");
    const result = await executor.runCommand({
      label: "Robot background probe",
      executable: "ssh",
      redacted_preview: "ssh <robot>",
      settings: {
        ...defaultNibiSettings,
        connection_mode: "robot_automation",
        nibi_username: "alice",
        robot_login_host: "robot.nibi.alliancecan.ca",
        ssh_private_key_path: "C:\\Users\\Alice\\.ssh\\fluorcast_robot",
        robot_access_verified: false,
      },
    });

    expect(result).toMatchObject({
      exit_code: 1,
      command_label: "Robot background probe",
      redacted_command_preview: "ssh <robot>",
    });
    expect(result.stderr).toContain("Robot automation access is not verified");
    await expect(executor.uploadFile("input.json", "/remote/input.json"))
      .rejects.toMatchObject({ code: "robot_access_not_verified" });
  });

  it("interactive upload uses the authenticated executor boundary", async () => {
    const executor = new InteractiveMfaRemoteExecutor();
    executor.setAuthenticated(true);

    await expect(executor.uploadFile(
      "C:\\Temp\\input.json",
      "/home/alice/jobs/job-1/input.json",
      {
        ...defaultNibiSettings,
        connection_mode: "interactive_mfa",
        ssh_private_key_path: "C:\\Users\\Alice\\.ssh\\fluorcast_nibi",
      },
    )).resolves.toBeUndefined();
  });
});
