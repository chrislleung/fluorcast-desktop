import { getSetting, saveSetting } from "../../lib/db";
import type { RemoteConnectionMode } from "../../lib/remote/types";

export const NIBI_SETTINGS_KEY = "nibiSettings";
export const CANONICAL_WSL_CONTROL_SOCKET_PATH = "$HOME/.fluorcast/ssh/cm-nibi.sock";

export const connectionModes = ["mock", "interactive_mfa", "robot_automation"] as const;
export type ConnectionMode = (typeof connectionModes)[number];

export const backendModes = ["mock", "nibi"] as const;
export type BackendMode = (typeof backendModes)[number];

export type NibiSettings = {
  connection_mode: RemoteConnectionMode;
  backend_mode: BackendMode;
  manual_mfa_provider: "terminal_action" | "persistent_shell" | "controlmaster" | "windows_openssh" | "wsl_openssh";
  manual_mfa_ssh_backend: "wsl";
  manual_mfa_wsl_distro: string;
  nibi_username: string;
  normal_login_host: string;
  robot_login_host: string;
  robot_key_restriction_from: string;
  robot_key_forced_command: string;
  nibi_host: string;
  ssh_private_key_path: string;
  wsl_ssh_private_key_path: string;
  wsl_control_socket_path: string;
  ssh_key_path: string;
  remote_project_path: string;
  remote_jobs_path: string;
  python_environment_path: string;
  default_model_choice: string;
  manual_login_verified: boolean;
  robot_access_verified: boolean;
  last_manual_login_check_at: string;
  manual_ssh_login_confirmed: boolean;
};

export type NibiSettingsErrors = Partial<Record<keyof NibiSettings, string>>;
export type NibiSettingsWarnings = Partial<Record<keyof NibiSettings, string>>;

export const defaultNibiSettings: NibiSettings = {
  connection_mode: "mock",
  backend_mode: "mock",
  manual_mfa_provider: "controlmaster",
  manual_mfa_ssh_backend: "wsl",
  manual_mfa_wsl_distro: "Ubuntu",
  nibi_username: "user",
  normal_login_host: "nibi.alliancecan.ca",
  robot_login_host: "robot.nibi.alliancecan.ca",
  robot_key_restriction_from: "134.153.150.*",
  robot_key_forced_command: "/cvmfs/soft.computecanada.ca/custom/bin/computecanada/allowed_commands/allowed_commands.sh",
  nibi_host: "nibi.alliancecan.ca",
  ssh_private_key_path: "",
  wsl_ssh_private_key_path: "$HOME/.ssh/fluorcast_nibi_ed25519",
  wsl_control_socket_path: CANONICAL_WSL_CONTROL_SOCKET_PATH,
  ssh_key_path: "",
  remote_project_path: "/home/user/scratch/FluorCast",
  remote_jobs_path: "/home/user/scratch/fluorcast-jobs",
  python_environment_path: "/home/user/scratch/FluorCast/.venv/bin/python",
  default_model_choice: "all",
  manual_login_verified: false,
  robot_access_verified: false,
  last_manual_login_check_at: "",
  manual_ssh_login_confirmed: false,
};

const shellMetacharacterPattern = /[\0\r\n;&|`$<>]/;
export const PUBLIC_SSH_KEY_WARNING =
  "This looks like a public key. Choose the private key file without .pub.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown, fallback: string) {
  return typeof value === "string" ? value : fallback;
}

function booleanValue(value: unknown, fallback: boolean) {
  return typeof value === "boolean" ? value : fallback;
}

function normalizeConnectionMode(value: Record<string, unknown>): RemoteConnectionMode {
  if (connectionModes.includes(value.connection_mode as RemoteConnectionMode)) {
    return value.connection_mode as RemoteConnectionMode;
  }
  return value.backend_mode === "nibi" ? "interactive_mfa" : "mock";
}

function normalizeManualMfaProvider(value: unknown): NibiSettings["manual_mfa_provider"] {
  if (value === "terminal_action" || value === "persistent_shell" || value === "controlmaster" || value === "wsl_openssh") {
    return value;
  }
  return "controlmaster";
}

export function safeWslControlSocketName(username: string, host: string): string {
  const hostLabel = host.split(".")[0] || "nibi";
  const safe = `${username || "user"}-${hostLabel}`
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `cm-${safe || "user-nibi"}.sock`;
}

export function defaultWslControlSocketPath(settings: Pick<NibiSettings, "nibi_username" | "normal_login_host">): string {
  void settings;
  return CANONICAL_WSL_CONTROL_SOCKET_PATH;
}

export function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith("\\\\");
}

export function hasShellMetacharacters(value: string): boolean {
  return shellMetacharacterPattern.test(value);
}

export function isPublicSshKeyPath(path: string): boolean {
  return path.trim().toLowerCase().endsWith(".pub");
}

export function normalizeNibiSettings(value: unknown): NibiSettings {
  if (!isRecord(value)) {
    return defaultNibiSettings;
  }

  const connectionMode = normalizeConnectionMode(value);
  const normalLoginHost = stringValue(
    value.normal_login_host ?? value.nibi_host,
    defaultNibiSettings.normal_login_host,
  );
  const sshPrivateKeyPath = stringValue(
    value.ssh_private_key_path ?? value.ssh_key_path,
    defaultNibiSettings.ssh_private_key_path,
  );
  const username = stringValue(value.nibi_username, defaultNibiSettings.nibi_username);
  const wslControlSocketPath = defaultWslControlSocketPath({
    nibi_username: username,
    normal_login_host: normalLoginHost,
  });
  const manualLoginVerified = booleanValue(
    value.manual_login_verified ?? value.manual_ssh_login_confirmed,
    defaultNibiSettings.manual_login_verified,
  );

  return {
    connection_mode: connectionMode,
    backend_mode: connectionMode === "mock" ? "mock" : "nibi",
    manual_mfa_provider: normalizeManualMfaProvider(value.manual_mfa_provider),
    manual_mfa_ssh_backend: "wsl",
    manual_mfa_wsl_distro: stringValue(
      value.manual_mfa_wsl_distro,
      defaultNibiSettings.manual_mfa_wsl_distro,
    ),
    nibi_username: username,
    normal_login_host: normalLoginHost,
    robot_login_host: stringValue(value.robot_login_host, defaultNibiSettings.robot_login_host),
    robot_key_restriction_from: stringValue(
      value.robot_key_restriction_from,
      defaultNibiSettings.robot_key_restriction_from,
    ),
    robot_key_forced_command: stringValue(
      value.robot_key_forced_command,
      defaultNibiSettings.robot_key_forced_command,
    ),
    nibi_host: normalLoginHost,
    ssh_private_key_path: sshPrivateKeyPath,
    wsl_ssh_private_key_path: stringValue(
      value.wsl_ssh_private_key_path,
      defaultNibiSettings.wsl_ssh_private_key_path,
    ),
    wsl_control_socket_path: wslControlSocketPath,
    ssh_key_path: sshPrivateKeyPath,
    remote_project_path: stringValue(
      value.remote_project_path,
      defaultNibiSettings.remote_project_path,
    ),
    remote_jobs_path: stringValue(value.remote_jobs_path, defaultNibiSettings.remote_jobs_path),
    python_environment_path: stringValue(
      value.python_environment_path,
      defaultNibiSettings.python_environment_path,
    ),
    default_model_choice: stringValue(
      value.default_model_choice,
      defaultNibiSettings.default_model_choice,
    ),
    manual_login_verified: manualLoginVerified,
    robot_access_verified: booleanValue(
      value.robot_access_verified,
      defaultNibiSettings.robot_access_verified,
    ),
    last_manual_login_check_at: stringValue(
      value.last_manual_login_check_at,
      defaultNibiSettings.last_manual_login_check_at,
    ),
    manual_ssh_login_confirmed: manualLoginVerified,
  };
}

export function validateNibiSettings(settings: NibiSettings): NibiSettingsErrors {
  const errors: NibiSettingsErrors = {};
  const trimmed = trimNibiSettings(settings);

  if (!connectionModes.includes(trimmed.connection_mode)) {
    errors.connection_mode = "Connection mode must be mock, manual MFA login, or robot automation.";
  }

  if (trimmed.connection_mode !== "mock") {
    if (!trimmed.nibi_username) {
      errors.nibi_username = "Username is required for NIBI mode.";
    }
    if (trimmed.connection_mode === "interactive_mfa" && !trimmed.normal_login_host) {
      errors.normal_login_host = "Normal login host is required for manual MFA mode.";
      errors.nibi_host = errors.normal_login_host;
    }
    if (trimmed.connection_mode === "robot_automation" && !trimmed.robot_login_host) {
      errors.robot_login_host = "Robot login host is required for robot automation mode.";
    }
    if (trimmed.connection_mode === "interactive_mfa" && !trimmed.wsl_ssh_private_key_path) {
      errors.wsl_ssh_private_key_path = "WSL private key path is required for manual MFA mode.";
    }
    if (trimmed.connection_mode === "robot_automation" && !trimmed.ssh_private_key_path) {
      errors.ssh_private_key_path = "SSH key path is required for robot automation mode.";
      errors.ssh_key_path = errors.ssh_private_key_path;
    }
  }

  const shellCheckedFields = trimmed.connection_mode === "mock"
    ? []
    : trimmed.connection_mode === "interactive_mfa"
    ? [
      "wsl_ssh_private_key_path",
      "remote_project_path",
      "remote_jobs_path",
      "python_environment_path",
    ] as const
    : [
      "ssh_private_key_path",
      "robot_key_restriction_from",
      "robot_key_forced_command",
      "remote_project_path",
      "remote_jobs_path",
      "python_environment_path",
    ] as const;

  for (const field of shellCheckedFields) {
    if (trimmed[field] && hasShellMetacharacters(trimmed[field])) {
      errors[field] = "Path contains unsupported shell metacharacters.";
    }
  }

  if (
    trimmed.connection_mode === "interactive_mfa"
    && trimmed.wsl_ssh_private_key_path
    && !trimmed.wsl_ssh_private_key_path.startsWith("/")
  ) {
    errors.wsl_ssh_private_key_path = "WSL private key path must be an absolute Linux path.";
  }

  if (trimmed.connection_mode !== "mock") {
    for (const field of [
      "remote_project_path",
      "remote_jobs_path",
      "python_environment_path",
    ] as const) {
      if (!trimmed[field]) {
        errors[field] = "Path is required.";
      } else if (!isAbsolutePath(trimmed[field])) {
        errors[field] = "Path must be absolute.";
      }
    }
  }

  if (trimmed.connection_mode === "mock" && !trimmed.default_model_choice) {
    errors.default_model_choice = "Default model choice is required.";
  }

  return errors;
}

export function validateNibiSettingsWarnings(settings: NibiSettings): NibiSettingsWarnings {
  const warnings: NibiSettingsWarnings = {};
  const trimmed = trimNibiSettings(settings);

  if (trimmed.ssh_private_key_path && isPublicSshKeyPath(trimmed.ssh_private_key_path)) {
    warnings.ssh_private_key_path = PUBLIC_SSH_KEY_WARNING;
    warnings.ssh_key_path = PUBLIC_SSH_KEY_WARNING;
  }
  if (trimmed.wsl_ssh_private_key_path && isPublicSshKeyPath(trimmed.wsl_ssh_private_key_path)) {
    warnings.wsl_ssh_private_key_path = PUBLIC_SSH_KEY_WARNING;
  }

  return warnings;
}

export function trimNibiSettings(settings: NibiSettings): NibiSettings {
  const normalLoginHost = settings.normal_login_host.trim();
  const sshPrivateKeyPath = settings.ssh_private_key_path.trim();
  const username = settings.nibi_username.trim();
  const manualLoginVerified = settings.manual_login_verified;
  return {
    connection_mode: settings.connection_mode,
    backend_mode: settings.connection_mode === "mock" ? "mock" : "nibi",
    manual_mfa_provider: normalizeManualMfaProvider(settings.manual_mfa_provider),
    manual_mfa_ssh_backend: "wsl",
    manual_mfa_wsl_distro: settings.manual_mfa_wsl_distro.trim() || defaultNibiSettings.manual_mfa_wsl_distro,
    nibi_username: username,
    normal_login_host: normalLoginHost,
    robot_login_host: settings.robot_login_host.trim(),
    robot_key_restriction_from: settings.robot_key_restriction_from.trim()
      || defaultNibiSettings.robot_key_restriction_from,
    robot_key_forced_command: settings.robot_key_forced_command.trim()
      || defaultNibiSettings.robot_key_forced_command,
    nibi_host: normalLoginHost,
    ssh_private_key_path: sshPrivateKeyPath,
    wsl_ssh_private_key_path: settings.wsl_ssh_private_key_path.trim(),
    wsl_control_socket_path: defaultWslControlSocketPath({
      nibi_username: username,
      normal_login_host: normalLoginHost,
    }),
    ssh_key_path: sshPrivateKeyPath,
    remote_project_path: settings.remote_project_path.trim(),
    remote_jobs_path: settings.remote_jobs_path.trim(),
    python_environment_path: settings.python_environment_path.trim(),
    default_model_choice: settings.default_model_choice.trim(),
    manual_login_verified: manualLoginVerified,
    robot_access_verified: settings.robot_access_verified,
    last_manual_login_check_at: settings.last_manual_login_check_at.trim(),
    manual_ssh_login_confirmed: manualLoginVerified,
  };
}

export function buildManualSshCommand(settings: NibiSettings): string {
  const trimmed = trimNibiSettings(settings);
  return `ssh -i "${trimmed.ssh_private_key_path.replaceAll('"', '\\"')}" ${trimmed.nibi_username}@${trimmed.normal_login_host}`;
}

export function buildRestrictedPublicKey(
  publicKeyText: string,
  settings: Pick<NibiSettings, "robot_key_restriction_from" | "robot_key_forced_command">,
): string {
  const publicKey = publicKeyText.trim();
  const restrictionFrom = settings.robot_key_restriction_from.trim();
  const forcedCommand = settings.robot_key_forced_command.trim();
  return `restrict,from="${restrictionFrom}",command="${forcedCommand}" ${publicKey}`;
}

export function buildAllianceSupportRequest(settings: NibiSettings): string {
  const trimmed = trimNibiSettings(settings);
  return [
    "Hello Alliance support,",
    "",
    "Please enable robot-node access for FluorCast automation.",
    "",
    `Username: ${trimmed.nibi_username || "<Alliance username>"}`,
    `Robot host: ${trimmed.robot_login_host || defaultNibiSettings.robot_login_host}`,
    "",
    "Requested app actions:",
    "- transfer input files with scp/sftp",
    "- submit jobs with sbatch",
    "- check jobs with squeue/sacct",
    "- download completed output files",
    "",
    "The restricted public key uploaded to CCDB will use a forced command and from= network restriction.",
  ].join("\n");
}

export async function loadNibiSettings(): Promise<NibiSettings> {
  const stored = await getSetting(NIBI_SETTINGS_KEY);
  if (!stored) {
    return defaultNibiSettings;
  }

  try {
    return normalizeNibiSettings(JSON.parse(stored));
  } catch {
    return defaultNibiSettings;
  }
}

export async function saveNibiSettings(settings: NibiSettings): Promise<boolean> {
  return saveSetting(NIBI_SETTINGS_KEY, JSON.stringify(trimNibiSettings(settings)));
}
