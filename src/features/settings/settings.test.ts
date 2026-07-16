import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildManualSshCommand,
  defaultNibiSettings,
  hasShellMetacharacters,
  isAbsolutePath,
  isPublicSshKeyPath,
  normalizeNibiSettings,
  PUBLIC_SSH_KEY_WARNING,
  trimNibiSettings,
  validateNibiSettings,
  validateNibiSettingsWarnings,
  type NibiSettings,
} from "./index";

describe("NIBI settings validation", () => {
  it("accepts the suggested mock defaults", () => {
    expect(validateNibiSettings(defaultNibiSettings)).toEqual({});
  });

  it("uses generic NIBI defaults", () => {
    expect(defaultNibiSettings).toMatchObject({
      connection_mode: "mock",
      manual_mfa_ssh_backend: "wsl",
      nibi_username: "user",
      normal_login_host: "nibi.alliancecan.ca",
      robot_login_host: "robot.nibi.alliancecan.ca",
      wsl_ssh_private_key_path: "$HOME/.ssh/fluorcast_nibi_ed25519",
      wsl_control_socket_path: "$HOME/.fluorcast/ssh/cm-user-nibi.sock",
      remote_project_path: "/home/user/scratch/FluorCast",
      remote_jobs_path: "/home/user/scratch/fluorcast-jobs",
      python_environment_path: "/home/user/scratch/FluorCast/.venv/bin/python",
      default_model_choice: "all",
      manual_login_verified: false,
      robot_access_verified: false,
    });
  });

  it("requires username, host, and SSH key path in manual MFA mode", () => {
    const errors = validateNibiSettings({
      ...defaultNibiSettings,
      connection_mode: "interactive_mfa",
      normal_login_host: "",
      nibi_username: "",
      ssh_private_key_path: "",
    });

    expect(errors).toMatchObject({
      nibi_username: "Username is required for NIBI mode.",
      normal_login_host: "Normal login host is required for manual MFA mode.",
      ssh_private_key_path: "SSH key path is required for manual MFA mode.",
    });
  });

  it("requires username, robot host, and SSH key path in robot automation mode", () => {
    const errors = validateNibiSettings({
      ...defaultNibiSettings,
      connection_mode: "robot_automation",
      nibi_username: "",
      robot_login_host: "",
      ssh_private_key_path: "",
    });

    expect(errors).toMatchObject({
      nibi_username: "Username is required for NIBI mode.",
      robot_login_host: "Robot login host is required for robot automation mode.",
      ssh_private_key_path: "SSH key path is required for robot automation mode.",
    });
  });

  it("warns when the SSH key path points at a public key", () => {
    expect(validateNibiSettingsWarnings({
      ...defaultNibiSettings,
      ssh_private_key_path: "C:\\Users\\CL\\.ssh\\fluorcast_nibi_ed25519.pub",
    })).toEqual({
      ssh_private_key_path: PUBLIC_SSH_KEY_WARNING,
      ssh_key_path: PUBLIC_SSH_KEY_WARNING,
    });
    expect(isPublicSshKeyPath("/home/chrisl/.ssh/id_ed25519.pub")).toBe(true);
  });

  it("accepts a non-public SSH key path", () => {
    const settings = {
      ...defaultNibiSettings,
      connection_mode: "robot_automation" as const,
      nibi_username: "chrisl",
      ssh_private_key_path: "C:\\Users\\CL\\.ssh\\fluorcast_nibi_ed25519",
    };

    expect(validateNibiSettings(settings).ssh_private_key_path).toBeUndefined();
    expect(validateNibiSettingsWarnings(settings).ssh_private_key_path).toBeUndefined();
    expect(isPublicSshKeyPath(settings.ssh_private_key_path)).toBe(false);
  });

  it("requires absolute remote and Python paths", () => {
    const errors = validateNibiSettings({
      ...defaultNibiSettings,
      remote_project_path: "scratch/ChemFluor_Project",
      remote_jobs_path: "fluorcast-jobs",
      python_environment_path: ".venv/bin/python",
    });

    expect(errors).toMatchObject({
      remote_project_path: "Path must be absolute.",
      remote_jobs_path: "Path must be absolute.",
      python_environment_path: "Path must be absolute.",
    });
  });

  it("rejects shell metacharacters in path fields", () => {
    const errors = validateNibiSettings({
      ...defaultNibiSettings,
      ssh_private_key_path: "C:\\Users\\CL\\.ssh\\id_ed25519; rm",
      remote_project_path: "/home/chrisl/scratch/project$(whoami)",
      remote_jobs_path: "/home/chrisl/scratch/jobs|tee",
      python_environment_path: "/home/chrisl/project/.venv/bin/python`date`",
    });

    expect(errors).toMatchObject({
      ssh_private_key_path: "Path contains unsupported shell metacharacters.",
      remote_project_path: "Path contains unsupported shell metacharacters.",
      remote_jobs_path: "Path contains unsupported shell metacharacters.",
      python_environment_path: "Path contains unsupported shell metacharacters.",
    });
  });

  it("detects common absolute path forms", () => {
    expect(isAbsolutePath("/home/chrisl/project")).toBe(true);
    expect(isAbsolutePath("C:\\Users\\CL\\.ssh\\id_ed25519")).toBe(true);
    expect(isAbsolutePath("\\\\server\\share\\id_ed25519")).toBe(true);
    expect(isAbsolutePath("relative/path")).toBe(false);
  });

  it("normalizes unknown persisted values back to safe defaults", () => {
    expect(normalizeNibiSettings({
      backend_mode: "remote",
      nibi_host: 42,
      remote_project_path: "/custom/project",
    })).toMatchObject({
      connection_mode: "mock",
      backend_mode: "mock",
      normal_login_host: defaultNibiSettings.normal_login_host,
      remote_project_path: "/custom/project",
      remote_jobs_path: defaultNibiSettings.remote_jobs_path,
    });
  });

  it("saves and loads the manual SSH login confirmation setting shape", () => {
    const persisted = JSON.stringify(trimNibiSettings({
      ...defaultNibiSettings,
      manual_login_verified: true,
    }));

    expect(normalizeNibiSettings(JSON.parse(persisted)).manual_login_verified).toBe(true);
    expect(normalizeNibiSettings({ manual_ssh_login_confirmed: "yes" }))
      .toMatchObject({ manual_login_verified: false });
  });

  it("builds a manual SSH command from current settings", () => {
    expect(buildManualSshCommand({
      ...defaultNibiSettings,
      nibi_username: " alice ",
      normal_login_host: " nibi.alliancecan.ca ",
      ssh_private_key_path: " C:\\Users\\Alice\\.ssh\\id_ed25519 ",
    })).toBe("ssh -i \"C:\\Users\\Alice\\.ssh\\id_ed25519\" alice@nibi.alliancecan.ca");
  });

  it("does not expose old user-specific NIBI paths in user-facing docs", () => {
    const docs = [
      readFileSync(join(process.cwd(), "README.md"), "utf8"),
      readFileSync(join(process.cwd(), "docs", "nibi-setup.md"), "utf8"),
      readFileSync(join(process.cwd(), "docs", "manual-qa-checklist.md"), "utf8"),
    ].join("\n");

    expect(docs).not.toContain("chrisl");
    expect(docs).not.toContain("ChemFluor_Project");
    expect(docs).not.toContain("/home/chrisl");
    expect(docs).not.toContain("scratch/ChemFluor_Project");
  });

  it("trims values before persistence or validation", () => {
    const settings: NibiSettings = {
      ...defaultNibiSettings,
      nibi_username: " chrisl ",
      ssh_private_key_path: " C:\\Users\\CL\\.ssh\\id_ed25519 ",
    };

    expect(trimNibiSettings(settings)).toMatchObject({
      nibi_username: "chrisl",
      ssh_private_key_path: "C:\\Users\\CL\\.ssh\\id_ed25519",
    });
  });

  it("does not define a password setting", () => {
    expect(Object.keys(defaultNibiSettings).some((key) => key.toLowerCase().includes("password")))
      .toBe(false);
  });

  it("flags shell metacharacters without rejecting ordinary paths", () => {
    expect(hasShellMetacharacters("/home/chrisl/scratch/ChemFluor_Project")).toBe(false);
    expect(hasShellMetacharacters("/home/chrisl/scratch/project && run")).toBe(true);
  });
});
