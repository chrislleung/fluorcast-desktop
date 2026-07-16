import { describe, expect, it } from "vitest";
import { defaultNibiSettings } from "../../features/settings";
import {
  createRemoteExecutor,
  InteractiveMfaRemoteExecutor,
  MockRemoteExecutor,
  RobotAutomationRemoteExecutor,
} from "./RemoteExecutor";

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

  it("robot executor uses robot host, not normal login host", () => {
    const executor = createRemoteExecutor("robot_automation");

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
});
