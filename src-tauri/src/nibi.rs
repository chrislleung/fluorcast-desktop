use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const SSH_TIMEOUT: Duration = Duration::from_secs(20);
const WSL_SCRIPT_TIMEOUT: Duration = Duration::from_secs(30);
const MANUAL_MFA_OK: &str = "FLUORCAST_AUTH_OK";
const CANONICAL_WSL_CONTROL_SOCKET_PATH: &str = "$HOME/.fluorcast/ssh/cm-nibi.sock";
const ROBOT_AUTOMATION_OK: &str = "FLUORCAST_ROBOT_OK";
const ROBOT_NOT_READY_MESSAGE: &str = "Robot automation is not ready. Manual login may work, but automatic FluorCast job submission requires robot-node access with a restricted public key.";
const PERSISTENT_SHELL_TIMEOUT: Duration = Duration::from_secs(60);
const PERSISTENT_SHELL_LOG_LIMIT: usize = 128_000;

static PERSISTENT_SHELL: OnceLock<Mutex<Option<PersistentShell>>> = OnceLock::new();
static MANUAL_MFA_TERMINAL_LAUNCH: OnceLock<Mutex<()>> = OnceLock::new();

#[derive(Debug, Deserialize)]
pub struct NibiSettings {
    #[serde(default = "default_manual_mfa_provider")]
    manual_mfa_provider: String,
    nibi_username: String,
    #[serde(default = "default_normal_login_host")]
    normal_login_host: String,
    #[serde(default = "default_robot_login_host")]
    robot_login_host: String,
    #[serde(default = "default_robot_key_restriction_from")]
    robot_key_restriction_from: String,
    #[serde(default = "default_robot_key_forced_command")]
    robot_key_forced_command: String,
    #[serde(default = "default_normal_login_host")]
    nibi_host: String,
    #[serde(default)]
    ssh_private_key_path: String,
    ssh_key_path: String,
    #[serde(default = "default_wsl_key_path")]
    wsl_ssh_private_key_path: String,
    #[serde(default)]
    wsl_control_socket_path: String,
    #[serde(default = "default_wsl_distro")]
    manual_mfa_wsl_distro: String,
    remote_project_path: String,
    remote_jobs_path: String,
    python_environment_path: String,
    manual_ssh_login_confirmed: bool,
}

impl NibiSettings {
    fn private_key_path(&self) -> &str {
        if self.ssh_private_key_path.trim().is_empty() {
            self.ssh_key_path.trim()
        } else {
            self.ssh_private_key_path.trim()
        }
    }

    fn manual_login_host(&self) -> &str {
        if self.normal_login_host.trim().is_empty() {
            self.nibi_host.trim()
        } else {
            self.normal_login_host.trim()
        }
    }

    fn robot_host(&self) -> &str {
        self.robot_login_host.trim()
    }

    fn uses_persistent_shell(&self) -> bool {
        self.manual_mfa_provider.trim() == "persistent_shell"
    }

    fn uses_terminal_action(&self) -> bool {
        self.manual_mfa_provider.trim().is_empty()
            || self.manual_mfa_provider.trim() == "terminal_action"
    }
}

#[derive(Debug, Serialize)]
pub struct RobotPublicKeyResult {
    restricted_public_key: String,
    public_key_path: String,
}

#[derive(Debug, Serialize)]
pub struct RobotAutomationTestResult {
    status: RobotAutomationTestStatus,
    message: String,
    robot_access_verified: bool,
    redacted_command_preview: String,
    stdout: String,
    stderr: String,
}

#[derive(Debug, Deserialize)]
pub struct RemoteCommandSpecInput {
    label: String,
    executable: String,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    redacted_preview: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct RemoteCommandResult {
    exit_code: i32,
    stdout: String,
    stderr: String,
    duration_ms: u128,
    command_label: String,
    redacted_command_preview: String,
    timed_out: bool,
}

#[derive(Debug, Serialize)]
pub struct TerminalActionPaths {
    action_id: String,
    work_dir: String,
    command_path: String,
    stdout_path: String,
    stderr_path: String,
    exit_code_path: String,
    result_json_path: String,
}

#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
#[allow(dead_code)]
pub enum PersistentShellStatus {
    NotStarted,
    Connecting,
    WaitingForLoginMfa,
    Active,
    Failed,
    Disconnected,
}

#[derive(Debug, Serialize)]
pub struct PersistentShellSessionStatus {
    session_id: String,
    process_id: Option<u32>,
    started_at: String,
    status: PersistentShellStatus,
    output: String,
    message: String,
}

struct PersistentShell {
    session_id: String,
    process_id: u32,
    started_at: String,
    status: PersistentShellStatus,
    child: Child,
    stdin: ChildStdin,
    rx: Receiver<ShellChunk>,
    output_log: VecDeque<String>,
}

struct ShellChunk {
    stream: &'static str,
    text: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RobotAutomationTestStatus {
    Passed,
    RobotNotReady,
    Failed,
}

#[derive(Debug, Serialize)]
pub struct NibiConnectionCheck {
    id: &'static str,
    label: &'static str,
    status: CheckStatus,
    message: String,
}

#[derive(Debug, Serialize)]
pub struct ManualMfaSessionCommands {
    backend: &'static str,
    control_path: String,
    control_socket_filename: String,
    control_path_exists: bool,
    script_dir: String,
    start_script_path: String,
    check_script_path: String,
    end_script_path: String,
    clean_script_path: String,
    wsl_distro: String,
    wsl_key_path: String,
    host: String,
    wsl_setup_key_commands: String,
    clean_stale_session_command: String,
    windows_terminal_command: String,
    powershell_launch_command: String,
    login_command: String,
    clean_script_content: String,
    check_script_content: String,
    end_script_content: String,
    check_command: String,
    test_command: String,
    end_command: String,
    background_command_template: String,
    manual_wsl_login_command: String,
    redacted_login_command_preview: String,
    redacted_test_command_preview: String,
    redacted_end_command_preview: String,
}

#[derive(Debug, Serialize)]
pub struct ManualMfaTerminalLaunchResult {
    launched: bool,
    method: TerminalLaunchMethod,
    message: String,
    error_message: String,
    timestamp: String,
    commands: ManualMfaSessionCommands,
    windows_terminal_available: bool,
    powershell_available: bool,
    wsl_available: bool,
    distro_available: bool,
    command_preview: String,
    generated_script_path: String,
    script_file_exists: bool,
    launch_method_attempted: String,
    launch_error_code: String,
    manual_wsl_command: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TerminalLaunchMethod {
    WindowsTerminal,
    Powershell,
    Manual,
}

#[derive(Debug, Serialize)]
pub struct ManualMfaSessionResult {
    status: ManualMfaSessionStatus,
    message: String,
    control_path: String,
    control_path_exists: bool,
    redacted_command_preview: String,
    can_run_background_commands: bool,
    last_master_check_result: String,
    last_auth_ok_result: String,
    last_session_test_stdout: String,
    last_session_test_stderr: String,
    last_session_test_exit_code: Option<i32>,
    parsed_session_status: ManualMfaSessionStatus,
    selected_backend: &'static str,
    wsl_available: bool,
    wsl_ssh_available: bool,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ManualMfaSessionStatus {
    Authenticated,
    AuthenticationRequired,
    SessionNotFound,
    SessionNotReused,
    ControlPathNotSocket,
    StaleControlmaster,
    BatchModeReuseFailed,
    AuthMarkerMissing,
    Timeout,
    WslUnavailable,
    BashTransportFailed,
    ControlmasterUnsupported,
    PermissionDenied,
    Disconnected,
    Failed,
}

#[derive(Debug, Serialize)]
pub struct LocalSshCapabilitiesResult {
    ssh_version: String,
    platform: String,
    controlmaster_supported: Option<bool>,
    controlpath_supported: Option<bool>,
    attempted_controlmaster: bool,
    syntax_stdout: String,
    syntax_stderr: String,
    syntax_exit_code: Option<i32>,
    recommendation: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CheckStatus {
    Passed,
    Failed,
    InteractiveLoginRequired,
    Skipped,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SshInvocation {
    program: String,
    args: Vec<String>,
}

#[derive(Clone, Copy)]
struct RemoteCheck {
    id: &'static str,
    label: &'static str,
    command: RemoteCommand,
    expected_stdout: Option<&'static str>,
}

#[derive(Clone, Copy)]
enum RemoteCommand {
    Echo,
    ProjectPathExists,
    PredictionScriptExists,
    SlurmScriptExists,
    JobsPathExistsOrCreate,
    SbatchExists,
    PythonEnvironmentExists,
}

const INTERACTIVE_LOGIN_REQUIRED_MESSAGE: &str = "NIBI is asking for interactive password/Duo authentication. This confirms the app reached NIBI, but a hidden background command cannot complete the login. First test the manual PowerShell SSH command. For automatic job submission, FluorCast will need an automation-compatible SSH setup.";

#[tauri::command]
pub fn test_nibi_connection(settings: NibiSettings) -> Vec<NibiConnectionCheck> {
    let mut results = Vec::new();
    let local_checks = build_local_checks(&settings);
    let local_checks_passed = local_checks
        .iter()
        .filter(|check| check.id.starts_with("local_"))
        .all(|check| matches!(check.status, CheckStatus::Passed));
    results.extend(local_checks);

    if !local_checks_passed {
        results.push(skipped_check(
            "ssh_automation",
            "Non-interactive SSH automation test",
            "Fix local settings before testing SSH automation.",
        ));
        results.extend(skipped_remote_environment_checks(
            "Skipped until the non-interactive SSH automation test passes.",
        ));
        return results;
    }

    for check in remote_checks() {
        let invocation = build_ssh_invocation(&settings, check.command);
        match run_ssh_invocation(&invocation) {
            Ok(output) => {
                let status = classify_command_output(&output, check.expected_stdout);
                let should_stop =
                    check.id == "ssh_automation" && !matches!(status, CheckStatus::Passed);
                results.push(NibiConnectionCheck {
                    id: check.id,
                    label: check.label,
                    message: result_message(&status, &output),
                    status,
                });
                if should_stop {
                    results.extend(skipped_remote_environment_checks(
                        "Skipped because non-interactive SSH automation did not pass.",
                    ));
                    break;
                }
            }
            Err(message) => {
                let status = if is_interactive_login_required_output(&message) {
                    CheckStatus::InteractiveLoginRequired
                } else {
                    CheckStatus::Failed
                };
                let should_stop = check.id == "ssh_automation";
                results.push(NibiConnectionCheck {
                    id: check.id,
                    label: check.label,
                    message: if matches!(status, CheckStatus::InteractiveLoginRequired) {
                        INTERACTIVE_LOGIN_REQUIRED_MESSAGE.to_string()
                    } else {
                        message
                    },
                    status,
                });
                if should_stop {
                    results.extend(skipped_remote_environment_checks(
                        "Skipped because non-interactive SSH automation did not pass.",
                    ));
                    break;
                }
            }
        }
    }

    results
}

#[tauri::command]
pub fn open_powershell_login(settings: NibiSettings) -> Result<(), String> {
    validate_manual_login_settings(&settings)?;
    let command = build_manual_ssh_command(&settings);
    Command::new("powershell.exe")
        .args(["-NoExit", "-Command", &command])
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("Could not open PowerShell: {error}"))
}

#[tauri::command]
pub fn get_restricted_robot_public_key(
    settings: NibiSettings,
) -> Result<RobotPublicKeyResult, String> {
    validate_robot_settings(&settings)?;
    let public_key_path = public_key_path_for_private_key(settings.private_key_path());
    let public_key_text = std::fs::read_to_string(&public_key_path)
        .map_err(|error| format!("Could not read public key at {public_key_path}: {error}"))?;
    Ok(RobotPublicKeyResult {
        restricted_public_key: build_restricted_public_key(&public_key_text, &settings)?,
        public_key_path,
    })
}

#[tauri::command]
pub fn test_robot_automation(settings: NibiSettings) -> Result<RobotAutomationTestResult, String> {
    validate_robot_settings(&settings)?;
    let invocation = build_robot_ssh_invocation(&settings);
    let redacted_command_preview = redacted_robot_command_preview(&settings);
    match run_ssh_invocation(&invocation) {
        Ok(output) => Ok(classify_robot_automation_output(
            output,
            redacted_command_preview,
        )),
        Err(message) => {
            if is_interactive_login_required_output(&message) {
                Ok(RobotAutomationTestResult {
                    status: RobotAutomationTestStatus::RobotNotReady,
                    message: ROBOT_NOT_READY_MESSAGE.to_string(),
                    robot_access_verified: false,
                    redacted_command_preview,
                    stdout: String::new(),
                    stderr: message,
                })
            } else {
                Ok(RobotAutomationTestResult {
                    status: RobotAutomationTestStatus::Failed,
                    message,
                    robot_access_verified: false,
                    redacted_command_preview,
                    stdout: String::new(),
                    stderr: String::new(),
                })
            }
        }
    }
}

#[tauri::command]
pub fn write_prediction_input_temp_file(
    job_id: String,
    input_json: String,
) -> Result<String, String> {
    validate_job_id(&job_id)?;
    let path = std::env::temp_dir().join(format!("fluorcast-{job_id}-input.json"));
    std::fs::write(&path, input_json)
        .map_err(|error| format!("Could not write temporary input.json: {error}"))?;
    path.to_str()
        .map(|value| value.to_string())
        .ok_or_else(|| "Temporary input path is not valid UTF-8.".to_string())
}

#[tauri::command]
pub fn prediction_output_temp_file_path(job_id: String) -> Result<String, String> {
    validate_job_id(&job_id)?;
    let path = std::env::temp_dir().join(format!("fluorcast-{job_id}-output.json"));
    path.to_str()
        .map(|value| value.to_string())
        .ok_or_else(|| "Temporary output path is not valid UTF-8.".to_string())
}

#[tauri::command]
pub fn read_prediction_output_file(local_path: String) -> Result<String, String> {
    validate_local_download_path(&local_path)?;
    std::fs::read_to_string(&local_path)
        .map_err(|error| format!("Could not read downloaded output.json: {error}"))
}

#[tauri::command]
pub fn run_nibi_remote_command(
    mode: String,
    settings: NibiSettings,
    command_spec: RemoteCommandSpecInput,
) -> Result<RemoteCommandResult, String> {
    validate_remote_command_spec(&command_spec)?;
    let remote_command = structured_remote_command_to_shell(&command_spec)?;
    if mode == "interactive_mfa" {
        return run_manual_mfa_remote_command_result(
            &settings,
            &remote_command,
            command_spec.label,
            command_spec.redacted_preview,
        );
    }
    let invocation = if mode == "robot_automation" {
        build_robot_remote_invocation(&settings, &remote_command)?
    } else {
        return Err("Unsupported NIBI connection mode.".to_string());
    };
    run_remote_invocation_result(
        invocation,
        command_spec.label,
        command_spec.redacted_preview,
    )
}

#[tauri::command]
pub fn upload_nibi_file(
    mode: String,
    settings: NibiSettings,
    local_path: String,
    remote_path: String,
) -> Result<(), String> {
    validate_local_upload_path(&local_path)?;
    validate_remote_path(&remote_path, "Remote upload path")?;
    if mode == "interactive_mfa" && settings.uses_terminal_action() {
        return upload_file_via_terminal(&settings, &local_path, &remote_path);
    }
    if mode == "interactive_mfa" && settings.uses_persistent_shell() {
        validate_remote_path_under_jobs(&remote_path, &settings.remote_jobs_path)?;
        let text = std::fs::read_to_string(&local_path)
            .map_err(|error| format!("Could not read upload file: {error}"))?;
        upload_text_file_via_shell(&settings, &remote_path, &text)?;
        return Ok(());
    }
    let target = if mode == "interactive_mfa" {
        build_manual_mfa_scp_target(&settings, &local_path, &remote_path)?
    } else if mode == "robot_automation" {
        build_robot_scp_target(&settings, &local_path, &remote_path)?
    } else {
        return Err("Unsupported NIBI connection mode.".to_string());
    };
    let mut command = Command::new(target.program);
    command.args(target.args);
    let output = command
        .output()
        .map_err(|error| format!("Could not start remote upload: {error}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

#[tauri::command]
pub fn download_nibi_file(
    mode: String,
    settings: NibiSettings,
    remote_path: String,
    local_path: String,
) -> Result<(), String> {
    validate_remote_path(&remote_path, "Remote download path")?;
    validate_local_download_path(&local_path)?;
    if mode == "interactive_mfa" && settings.uses_terminal_action() {
        return download_file_via_terminal(&settings, &remote_path, &local_path);
    }
    if mode == "interactive_mfa" && settings.uses_persistent_shell() {
        validate_remote_path_under_jobs(&remote_path, &settings.remote_jobs_path)?;
        let text = download_text_file_via_shell(&settings, &remote_path)?;
        std::fs::write(&local_path, text)
            .map_err(|error| format!("Could not write downloaded output.json: {error}"))?;
        return Ok(());
    }
    let source = if mode == "interactive_mfa" {
        build_manual_mfa_download_target(&settings, &remote_path, &local_path)?
    } else if mode == "robot_automation" {
        build_robot_download_target(&settings, &remote_path, &local_path)?
    } else {
        return Err("Unsupported NIBI connection mode.".to_string());
    };
    let mut command = Command::new(source.program);
    command.args(source.args);
    let output = command
        .output()
        .map_err(|error| format!("Could not start remote download: {error}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

#[tauri::command]
pub fn get_manual_mfa_session_commands(
    settings: NibiSettings,
) -> Result<ManualMfaSessionCommands, String> {
    validate_manual_login_settings(&settings)?;
    build_manual_mfa_session_commands(&settings)
}

#[tauri::command]
pub fn open_manual_mfa_login(
    settings: NibiSettings,
) -> Result<ManualMfaTerminalLaunchResult, String> {
    validate_manual_login_start_settings(&settings)?;
    let _guard = MANUAL_MFA_TERMINAL_LAUNCH
        .get_or_init(|| Mutex::new(()))
        .try_lock()
        .map_err(|_| "A NIBI session launch is already in progress.".to_string())?;
    let commands = build_manual_mfa_session_commands(&settings)?;
    Ok(launch_manual_mfa_terminal(commands))
}

#[tauri::command]
pub fn clean_stale_manual_mfa_session(
    settings: NibiSettings,
) -> Result<ManualMfaSessionResult, String> {
    validate_manual_login_settings(&settings)?;
    let commands = build_manual_mfa_session_commands(&settings)?;
    let args = vec![commands.host.clone()];
    match run_wsl_bash_script(
        &commands.wsl_distro,
        &commands.clean_script_content,
        &args,
        WSL_SCRIPT_TIMEOUT,
    ) {
        Ok(output) => {
            let status = if output.status == 0 {
                ManualMfaSessionStatus::Disconnected
            } else if output.timed_out {
                ManualMfaSessionStatus::Timeout
            } else {
                ManualMfaSessionStatus::Failed
            };
            Ok(ManualMfaSessionResult {
                status,
                message: if output.status == 0 {
                    "Stale WSL NIBI session cleaned.".to_string()
                } else if output.timed_out {
                    "WSL stale-session cleanup timed out.".to_string()
                } else {
                    "WSL stale-session cleanup failed.".to_string()
                },
                control_path: resolved_control_path_from_output(&output)
                    .unwrap_or_else(|| commands.control_path.clone()),
                control_path_exists: false,
                redacted_command_preview: "wsl.exe -d <distribution> -- bash -s -- <host>"
                    .to_string(),
                can_run_background_commands: false,
                last_master_check_result: output.combined(),
                last_auth_ok_result: String::new(),
                last_session_test_stdout: output.stdout,
                last_session_test_stderr: output.stderr,
                last_session_test_exit_code: Some(output.status),
                parsed_session_status: status,
                selected_backend: "wsl",
                wsl_available: wsl_available_for_distro(&commands.wsl_distro),
                wsl_ssh_available: wsl_ssh_available_for_distro(&commands.wsl_distro),
            })
        }
        Err(message) => Ok(manual_mfa_transport_error_result(&commands, message)),
    }
}

#[tauri::command]
pub fn test_manual_mfa_session(settings: NibiSettings) -> Result<ManualMfaSessionResult, String> {
    validate_manual_login_settings(&settings)?;
    let commands = build_manual_mfa_session_commands(&settings)?;
    Ok(run_manual_mfa_session_readiness(&commands))
}

#[tauri::command]
pub fn persistent_shell_start(
    settings: NibiSettings,
) -> Result<PersistentShellSessionStatus, String> {
    validate_manual_login_settings(&settings)?;
    let mut guard = persistent_shell_slot()
        .lock()
        .map_err(|_| "Persistent shell state is unavailable.".to_string())?;
    if let Some(shell) = guard.as_mut() {
        shell.drain_output();
        if shell
            .child
            .try_wait()
            .map_err(|error| format!("Could not inspect SSH session: {error}"))?
            .is_none()
        {
            return Ok(shell.snapshot("Persistent NIBI session is already running."));
        }
        shell.status = PersistentShellStatus::Disconnected;
    }

    let (tx, rx) = mpsc::channel();
    let ssh_target = format!(
        "{}@{}",
        settings.nibi_username.trim(),
        settings.manual_login_host()
    );
    let mut child = Command::new("ssh")
        .args([
            "-tt",
            "-i",
            settings.private_key_path(),
            "-o",
            "IdentitiesOnly=yes",
            &ssh_target,
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("Could not start persistent SSH session: {error}"))?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Could not capture SSH stdout.".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Could not capture SSH stderr.".to_string())?;
    spawn_shell_reader(stdout, "stdout", tx.clone());
    spawn_shell_reader(stderr, "stderr", tx);
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Could not open SSH stdin.".to_string())?;
    let process_id = child.id();
    let mut shell = PersistentShell {
        session_id: new_nonce("session"),
        process_id,
        started_at: now_millis_string(),
        status: PersistentShellStatus::WaitingForLoginMfa,
        child,
        stdin,
        rx,
        output_log: VecDeque::new(),
    };
    shell.drain_output();
    let snapshot = shell.snapshot(
        "Persistent NIBI SSH session started. Complete password and Duo in the session panel.",
    );
    *guard = Some(shell);
    Ok(snapshot)
}

#[tauri::command]
pub fn persistent_shell_send_input(input: String) -> Result<PersistentShellSessionStatus, String> {
    if input.contains('\0') {
        return Err("Session input contains unsupported characters.".to_string());
    }
    with_persistent_shell_mut(|shell| {
        shell
            .stdin
            .write_all(input.as_bytes())
            .and_then(|_| shell.stdin.write_all(b"\n"))
            .and_then(|_| shell.stdin.flush())
            .map_err(|error| format!("Could not send input to SSH session: {error}"))?;
        thread::sleep(Duration::from_millis(80));
        shell.drain_output();
        Ok(shell.snapshot("Input sent to persistent NIBI session."))
    })
}

#[tauri::command]
pub fn persistent_shell_read() -> Result<PersistentShellSessionStatus, String> {
    with_persistent_shell_mut(|shell| {
        shell.drain_output();
        Ok(shell.snapshot("Persistent NIBI session output refreshed."))
    })
}

#[tauri::command]
pub fn persistent_shell_status() -> Result<PersistentShellSessionStatus, String> {
    let mut guard = persistent_shell_slot()
        .lock()
        .map_err(|_| "Persistent shell state is unavailable.".to_string())?;
    if let Some(shell) = guard.as_mut() {
        shell.drain_output();
        return Ok(shell.snapshot("Persistent NIBI session status refreshed."));
    }
    Ok(PersistentShellSessionStatus {
        session_id: String::new(),
        process_id: None,
        started_at: String::new(),
        status: PersistentShellStatus::NotStarted,
        output: String::new(),
        message: "No persistent NIBI session has been started.".to_string(),
    })
}

#[tauri::command]
pub fn persistent_shell_stop() -> Result<PersistentShellSessionStatus, String> {
    let mut guard = persistent_shell_slot()
        .lock()
        .map_err(|_| "Persistent shell state is unavailable.".to_string())?;
    if let Some(mut shell) = guard.take() {
        let _ = shell.stdin.write_all(b"exit\n");
        let _ = shell.stdin.flush();
        thread::sleep(Duration::from_millis(150));
        if shell.child.try_wait().ok().flatten().is_none() {
            let _ = shell.child.kill();
            let _ = shell.child.wait();
        }
        shell.status = PersistentShellStatus::Disconnected;
        shell.drain_output();
        return Ok(shell.snapshot("Persistent NIBI SSH session disconnected."));
    }
    Ok(PersistentShellSessionStatus {
        session_id: String::new(),
        process_id: None,
        started_at: String::new(),
        status: PersistentShellStatus::NotStarted,
        output: String::new(),
        message: "No persistent NIBI session was running.".to_string(),
    })
}

#[tauri::command]
pub fn persistent_shell_test_readiness(
    _settings: NibiSettings,
) -> Result<PersistentShellSessionStatus, String> {
    let result = run_persistent_shell_probe(
        "printf '\\n__FLUORCAST_READY_START__\\n'; echo FLUORCAST_READY; printf '\\n__FLUORCAST_READY_END__\\n'",
        "__FLUORCAST_READY_END__",
        Duration::from_secs(20),
    )?;
    let active = result.contains("__FLUORCAST_READY_START__")
        && result.contains("FLUORCAST_READY")
        && result.contains("__FLUORCAST_READY_END__");
    with_persistent_shell_mut(|shell| {
        shell.status = if active {
            PersistentShellStatus::Active
        } else {
            PersistentShellStatus::WaitingForLoginMfa
        };
        Ok(shell.snapshot(if active {
            "Persistent NIBI session is active."
        } else {
            "NIBI session is not ready yet. Complete password and Duo, then test again."
        }))
    })
}

#[tauri::command]
pub fn check_local_ssh_capabilities() -> LocalSshCapabilitiesResult {
    let version_output = Command::new("ssh")
        .arg("-V")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output();
    let ssh_version = match version_output {
        Ok(output) => {
            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            if stdout.is_empty() {
                stderr
            } else {
                stdout
            }
        }
        Err(error) => format!("Could not run ssh -V: {error}"),
    };

    let syntax_output = Command::new("ssh")
        .args([
            "-G",
            "-o",
            "ControlMaster=auto",
            "-o",
            "ControlPath=fluorcast-test-%r@%h:%p",
            "example.invalid",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output();
    let (syntax_stdout, syntax_stderr, syntax_exit_code) = match syntax_output {
        Ok(output) => (
            String::from_utf8_lossy(&output.stdout).trim().to_string(),
            String::from_utf8_lossy(&output.stderr).trim().to_string(),
            output.status.code(),
        ),
        Err(error) => (
            String::new(),
            format!("Could not run ssh -G: {error}"),
            None,
        ),
    };
    let syntax_text = format!("{syntax_stdout}\n{syntax_stderr}");
    let supported = if syntax_exit_code == Some(0) {
        Some(true)
    } else if is_controlmaster_unsupported_output(&syntax_text) {
        Some(false)
    } else {
        None
    };
    let recommendation = if supported == Some(false) {
        "Your SSH client may not support reusable ControlMaster sessions on Windows. Use WSL/manual fallback or robot automation.".to_string()
    } else if supported == Some(true) {
        "The local ssh client accepts ControlMaster and ControlPath options.".to_string()
    } else {
        "Could not reliably determine ControlMaster support. If reuse fails, try WSL OpenSSH or robot automation.".to_string()
    };

    LocalSshCapabilitiesResult {
        ssh_version,
        platform: format!("{} {}", std::env::consts::OS, std::env::consts::ARCH),
        controlmaster_supported: supported,
        controlpath_supported: supported,
        attempted_controlmaster: true,
        syntax_stdout,
        syntax_stderr,
        syntax_exit_code,
        recommendation,
    }
}

#[tauri::command]
pub fn end_manual_mfa_session(settings: NibiSettings) -> Result<ManualMfaSessionResult, String> {
    validate_manual_login_settings(&settings)?;
    let commands = build_manual_mfa_session_commands(&settings)?;
    if let Err(message) = write_manual_mfa_scripts(&commands) {
        return Ok(ManualMfaSessionResult {
            status: ManualMfaSessionStatus::Failed,
            message,
            control_path: commands.control_path.clone(),
            control_path_exists: wsl_path_exists(&commands.control_path),
            redacted_command_preview: commands.redacted_end_command_preview.clone(),
            can_run_background_commands: false,
            last_master_check_result: String::new(),
            last_auth_ok_result: String::new(),
            last_session_test_stdout: String::new(),
            last_session_test_stderr: String::new(),
            last_session_test_exit_code: None,
            parsed_session_status: ManualMfaSessionStatus::Failed,
            selected_backend: "wsl",
            wsl_available: wsl_available(),
            wsl_ssh_available: wsl_ssh_available(),
        });
    }
    match run_wsl_script(&commands.end_command) {
        Ok(output) => {
            let combined = output.combined();
            let control_path_exists = wsl_path_exists(&commands.control_path);
            if output.status == 0 || combined.to_ascii_lowercase().contains("no such file") {
                Ok(ManualMfaSessionResult {
                    status: ManualMfaSessionStatus::Disconnected,
                    message: "Manual NIBI session ended.".to_string(),
                    control_path: commands.control_path.clone(),
                    control_path_exists,
                    redacted_command_preview: commands.redacted_end_command_preview.clone(),
                    can_run_background_commands: false,
                    last_master_check_result: combined,
                    last_auth_ok_result: String::new(),
                    last_session_test_stdout: output.stdout,
                    last_session_test_stderr: output.stderr,
                    last_session_test_exit_code: Some(output.status),
                    parsed_session_status: ManualMfaSessionStatus::Disconnected,
                    selected_backend: "wsl",
                    wsl_available: wsl_available(),
                    wsl_ssh_available: wsl_ssh_available(),
                })
            } else if is_interactive_login_required_output(&combined) {
                Ok(ManualMfaSessionResult {
                    status: ManualMfaSessionStatus::AuthenticationRequired,
                    message: "NIBI still requested password/Duo, so the app cannot run background commands yet. Start manual login again.".to_string(),
                    control_path: commands.control_path.clone(),
                    control_path_exists,
                    redacted_command_preview: commands.redacted_end_command_preview.clone(),
                    can_run_background_commands: false,
                    last_master_check_result: combined,
                    last_auth_ok_result: String::new(),
                    last_session_test_stdout: output.stdout,
                    last_session_test_stderr: output.stderr,
                    last_session_test_exit_code: Some(output.status),
                    parsed_session_status: ManualMfaSessionStatus::SessionNotReused,
                    selected_backend: "wsl",
                    wsl_available: wsl_available(),
                    wsl_ssh_available: wsl_ssh_available(),
                })
            } else {
                Ok(ManualMfaSessionResult {
                    status: ManualMfaSessionStatus::Failed,
                    message: "Could not end the manual NIBI session.".to_string(),
                    control_path: commands.control_path.clone(),
                    control_path_exists,
                    redacted_command_preview: commands.redacted_end_command_preview.clone(),
                    can_run_background_commands: false,
                    last_master_check_result: combined,
                    last_auth_ok_result: String::new(),
                    last_session_test_stdout: output.stdout,
                    last_session_test_stderr: output.stderr,
                    last_session_test_exit_code: Some(output.status),
                    parsed_session_status: ManualMfaSessionStatus::Failed,
                    selected_backend: "wsl",
                    wsl_available: wsl_available(),
                    wsl_ssh_available: wsl_ssh_available(),
                })
            }
        }
        Err(message) => Ok(ManualMfaSessionResult {
            status: ManualMfaSessionStatus::Disconnected,
            message: map_manual_mfa_error(&message),
            control_path: commands.control_path.clone(),
            control_path_exists: wsl_path_exists(&commands.control_path),
            redacted_command_preview: commands.redacted_end_command_preview,
            can_run_background_commands: false,
            last_master_check_result: message,
            last_auth_ok_result: String::new(),
            last_session_test_stdout: String::new(),
            last_session_test_stderr: String::new(),
            last_session_test_exit_code: None,
            parsed_session_status: ManualMfaSessionStatus::Disconnected,
            selected_backend: "wsl",
            wsl_available: wsl_available(),
            wsl_ssh_available: wsl_ssh_available(),
        }),
    }
}

fn remote_checks() -> [RemoteCheck; 7] {
    [
        RemoteCheck {
            id: "ssh_automation",
            label: "Non-interactive SSH automation test",
            command: RemoteCommand::Echo,
            expected_stdout: Some("fluorcast-nibi-ok"),
        },
        RemoteCheck {
            id: "remote_project_path",
            label: "Remote project path exists",
            command: RemoteCommand::ProjectPathExists,
            expected_stdout: None,
        },
        RemoteCheck {
            id: "prediction_script",
            label: "scripts/run_prediction_job.py exists",
            command: RemoteCommand::PredictionScriptExists,
            expected_stdout: None,
        },
        RemoteCheck {
            id: "slurm_script",
            label: "slurm/run_prediction_job.sbatch exists",
            command: RemoteCommand::SlurmScriptExists,
            expected_stdout: None,
        },
        RemoteCheck {
            id: "remote_jobs_path",
            label: "Remote jobs path exists or can be created",
            command: RemoteCommand::JobsPathExistsOrCreate,
            expected_stdout: None,
        },
        RemoteCheck {
            id: "sbatch",
            label: "sbatch command exists",
            command: RemoteCommand::SbatchExists,
            expected_stdout: None,
        },
        RemoteCheck {
            id: "python_environment",
            label: "Python environment path exists",
            command: RemoteCommand::PythonEnvironmentExists,
            expected_stdout: None,
        },
    ]
}

fn build_local_checks(settings: &NibiSettings) -> Vec<NibiConnectionCheck> {
    vec![
        local_check(
            "local_username",
            "Username is filled and not \"user\"",
            validate_simple_identifier(&settings.nibi_username, "NIBI username").and_then(|_| {
                if settings.nibi_username.trim() == "user" {
                    Err("Replace the placeholder username with your Alliance username.".to_string())
                } else {
                    Ok(())
                }
            }),
        ),
        local_check(
            "local_host",
            "Host is filled",
            validate_host(settings.manual_login_host()),
        ),
        local_check(
            "local_wsl_private_key_path",
            "WSL private key path is configured",
            validate_wsl_private_key_path_setting(&settings.wsl_ssh_private_key_path),
        ),
        local_check(
            "local_remote_paths_absolute",
            "Remote paths are absolute",
            validate_remote_path(&settings.remote_project_path, "Remote project path")
                .and_then(|_| validate_remote_path(&settings.remote_jobs_path, "Remote jobs path"))
                .and_then(|_| {
                    validate_remote_path(
                        &settings.python_environment_path,
                        "Python environment path",
                    )
                }),
        ),
    ]
}

fn local_check(
    id: &'static str,
    label: &'static str,
    result: Result<(), String>,
) -> NibiConnectionCheck {
    match result {
        Ok(()) => NibiConnectionCheck {
            id,
            label,
            status: CheckStatus::Passed,
            message: "Passed.".to_string(),
        },
        Err(message) => NibiConnectionCheck {
            id,
            label,
            status: CheckStatus::Failed,
            message,
        },
    }
}

fn skipped_check(
    id: &'static str,
    label: &'static str,
    message: &'static str,
) -> NibiConnectionCheck {
    NibiConnectionCheck {
        id,
        label,
        status: CheckStatus::Skipped,
        message: message.to_string(),
    }
}

fn skipped_remote_environment_checks(message: &'static str) -> Vec<NibiConnectionCheck> {
    remote_checks()
        .into_iter()
        .skip(1)
        .map(|check| skipped_check(check.id, check.label, message))
        .collect()
}

fn build_ssh_invocation(settings: &NibiSettings, remote_command: RemoteCommand) -> SshInvocation {
    SshInvocation {
        program: "ssh".to_string(),
        args: vec![
            "-i".to_string(),
            settings.private_key_path().to_string(),
            "-o".to_string(),
            "BatchMode=yes".to_string(),
            "-o".to_string(),
            "PasswordAuthentication=no".to_string(),
            "-o".to_string(),
            "ConnectTimeout=10".to_string(),
            "-o".to_string(),
            "StrictHostKeyChecking=accept-new".to_string(),
            "--".to_string(),
            format!(
                "{}@{}",
                settings.nibi_username.trim(),
                settings.manual_login_host()
            ),
            remote_command.to_shell_fragment(settings),
        ],
    }
}

fn build_robot_ssh_invocation(settings: &NibiSettings) -> SshInvocation {
    SshInvocation {
        program: "ssh".to_string(),
        args: vec![
            "-i".to_string(),
            settings.private_key_path().to_string(),
            "-o".to_string(),
            "IdentitiesOnly=yes".to_string(),
            format!(
                "{}@{}",
                settings.nibi_username.trim(),
                settings.robot_host()
            ),
            format!("echo {ROBOT_AUTOMATION_OK}"),
        ],
    }
}

fn build_manual_ssh_command(settings: &NibiSettings) -> String {
    format!(
        "ssh -i {} {}@{}",
        powershell_single_quote(settings.private_key_path()),
        settings.nibi_username.trim(),
        settings.manual_login_host()
    )
}

fn build_manual_mfa_session_commands(
    settings: &NibiSettings,
) -> Result<ManualMfaSessionCommands, String> {
    let control_path = manual_mfa_control_path(settings);
    let target = format!(
        "{}@{}",
        settings.nibi_username.trim(),
        settings.manual_login_host()
    );
    let key = if settings.wsl_ssh_private_key_path.trim().is_empty() {
        default_wsl_key_path()
    } else {
        settings.wsl_ssh_private_key_path.trim().to_string()
    };
    let distro = settings.manual_mfa_wsl_distro.trim().to_string();
    let socket_name = control_path
        .rsplit('/')
        .next()
        .unwrap_or("cm-nibi.sock")
        .to_string();
    let script_dir = "$HOME/.fluorcast/scripts".to_string();
    let start_script_path = "$HOME/.fluorcast/scripts/start-nibi-login.sh".to_string();
    let check_script_path = "$HOME/.fluorcast/scripts/check-nibi-session.sh".to_string();
    let end_script_path = "$HOME/.fluorcast/scripts/end-nibi-session.sh".to_string();
    let clean_script_path = "$HOME/.fluorcast/scripts/clean-nibi-session.sh".to_string();
    let manual_wsl_login_command = format!(
        "wsl.exe -d {} -- bash -c {} -- {} {}",
        powershell_single_quote(&distro),
        powershell_single_quote("exec \"$HOME/.fluorcast/scripts/start-nibi-login.sh\" \"$@\""),
        powershell_single_quote(&target),
        powershell_single_quote(&key),
    );
    let setup = "Debug only: create or copy the private key inside WSL, then enter its absolute Linux path in FluorCast.".to_string();
    let clean = [
        "#!/usr/bin/env bash",
        "set -Eeuo pipefail",
        "",
        "HOST=\"$1\"",
        "CTL=\"$HOME/.fluorcast/ssh/cm-nibi.sock\"",
        "",
        "printf 'WSL_DISTRO=%s\\n' \"${WSL_DISTRO_NAME:-unknown}\"",
        "printf 'WSL_USER=%s\\n' \"$(whoami)\"",
        "printf 'WSL_HOME=%s\\n' \"$HOME\"",
        "printf 'CONTROL_PATH=%s\\n' \"$CTL\"",
        "mkdir -p \"$HOME/.fluorcast/ssh\"",
        "chmod 700 \"$HOME/.fluorcast/ssh\"",
        "",
        "if [[ ! -e \"$CTL\" ]]; then",
        "    printf 'CLEAN_RESULT=NO_SESSION\\n'",
        "    exit 0",
        "fi",
        "",
        "if [[ -S \"$CTL\" ]] && ssh -S \"$CTL\" -O check \"$HOST\" >/dev/null 2>&1; then",
        "    ssh -S \"$CTL\" -O exit \"$HOST\" >/dev/null 2>&1 || true",
        "fi",
        "",
        "rm -f \"$CTL\"",
        "",
        "printf 'CLEAN_RESULT=SESSION_REMOVED\\n'",
    ]
    .join("\n");
    let login = [
        "#!/usr/bin/env bash",
        "set -Eeuo pipefail",
        "",
        "HOST=\"$1\"",
        "KEY=\"$2\"",
        "CTL=\"$HOME/.fluorcast/ssh/cm-nibi.sock\"",
        "",
        "mkdir -p \"$HOME/.fluorcast/ssh\"",
        "chmod 700 \"$HOME/.fluorcast/ssh\"",
        "",
        "if [[ \"$KEY\" != /* ]]; then",
        "  echo \"WSL private key path must be an absolute POSIX path.\"",
        "  exit 20",
        "fi",
        "if [[ ! -e \"$KEY\" ]]; then",
        "  echo \"WSL private key was not found.\"",
        "  exit 21",
        "fi",
        "if [[ ! -f \"$KEY\" ]]; then",
        "  echo \"WSL private key path is not a regular file.\"",
        "  exit 22",
        "fi",
        "if [[ ! -r \"$KEY\" ]]; then",
        "  echo \"WSL private key is not readable.\"",
        "  exit 23",
        "fi",
        "",
        "if [[ -S \"$CTL\" ]] && ssh -S \"$CTL\" -O check \"$HOST\" >/dev/null 2>&1; then",
        "  echo \"An active FluorCast NIBI session already exists.\"",
        "else",
        "  rm -f \"$CTL\"",
        "  ssh -fMN \\",
        "    -S \"$CTL\" \\",
        "    -i \"$KEY\" \\",
        "    -o IdentitiesOnly=yes \\",
        "    -o ControlMaster=yes \\",
        "    -o ControlPath=\"$CTL\" \\",
        "    -o ControlPersist=4h \\",
        "    -o ServerAliveInterval=60 \\",
        "    -o ServerAliveCountMax=3 \\",
        "    \"$HOST\"",
        "fi",
        "echo",
        "echo \"Checking FluorCast NIBI session...\"",
        "test -S \"$CTL\"",
        "ssh -S \"$CTL\" -O check \"$HOST\"",
        "echo",
        "echo \"FluorCast NIBI session created.\"",
        "echo \"Return to FluorCast and press Test authenticated session.\"",
        "read -r -p \"Press Enter to close this window...\"",
    ]
    .join("\n");
    let check_script = manual_mfa_session_test_script();
    let end_script = [
        "#!/usr/bin/env bash",
        "set -Eeuo pipefail",
        "",
        "HOST=\"$1\"",
        "CTL=\"$HOME/.fluorcast/ssh/cm-nibi.sock\"",
        "",
        "ssh -S \"$CTL\" -O exit \"$HOST\"",
    ]
    .join("\n");
    let check = format!(
        "wsl.exe -d {} -- bash -s -- {}",
        powershell_single_quote(&distro),
        powershell_single_quote(&target)
    );
    let test = check_script.clone();
    let end = format!("bash {end_script_path}");
    let background = [
        "HOST=\"$1\"",
        "REMOTE_COMMAND=\"$2\"",
        "CTL=\"$HOME/.fluorcast/ssh/cm-nibi.sock\"",
        "ssh -S \"$CTL\" -o ControlMaster=no -o BatchMode=yes \"$HOST\" \"$REMOTE_COMMAND\"",
    ]
    .join("\n");

    Ok(ManualMfaSessionCommands {
        backend: "wsl",
        control_path_exists: wsl_path_exists(&control_path),
        control_socket_filename: socket_name,
        script_dir,
        start_script_path: start_script_path.clone(),
        check_script_path: check_script_path.clone(),
        end_script_path: end_script_path.clone(),
        clean_script_path: clean_script_path.clone(),
        wsl_distro: distro.clone(),
        wsl_key_path: key.clone(),
        host: target.clone(),
        wsl_setup_key_commands: setup,
        clean_stale_session_command: format!("bash {clean_script_path}"),
        windows_terminal_command: windows_terminal_command(&distro, &target, &key),
        powershell_launch_command: powershell_launch_command(&distro, &target, &key),
        login_command: login.clone(),
        clean_script_content: clean,
        check_script_content: check_script.clone(),
        end_script_content: end_script.clone(),
        check_command: check,
        test_command: test.clone(),
        end_command: end.clone(),
        background_command_template: background,
        manual_wsl_login_command,
        redacted_login_command_preview: redact_session_command(&login, &control_path, &key),
        redacted_test_command_preview: redact_session_command(&test, &control_path, &key),
        redacted_end_command_preview: redact_session_command(&end_script, &control_path, &key),
        control_path,
    })
}

impl RemoteCommand {
    fn to_shell_fragment(self, settings: &NibiSettings) -> String {
        match self {
            RemoteCommand::Echo => "echo fluorcast-nibi-ok".to_string(),
            RemoteCommand::ProjectPathExists => {
                format!("test -d {}", shell_quote(&settings.remote_project_path))
            }
            RemoteCommand::PredictionScriptExists => format!(
                "test -f {}/scripts/run_prediction_job.py",
                shell_quote(&settings.remote_project_path)
            ),
            RemoteCommand::SlurmScriptExists => format!(
                "test -f {}/slurm/run_prediction_job.sbatch",
                shell_quote(&settings.remote_project_path)
            ),
            RemoteCommand::JobsPathExistsOrCreate => {
                format!(
                    "test -d {0} || mkdir -p {0}",
                    shell_quote(&settings.remote_jobs_path)
                )
            }
            RemoteCommand::SbatchExists => "command -v sbatch >/dev/null 2>&1".to_string(),
            RemoteCommand::PythonEnvironmentExists => {
                format!("test -e {}", shell_quote(&settings.python_environment_path))
            }
        }
    }
}

fn run_ssh_invocation(invocation: &SshInvocation) -> Result<CommandOutput, String> {
    let mut child = Command::new(&invocation.program)
        .args(&invocation.args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("Could not start ssh: {error}"))?;

    let started = Instant::now();
    loop {
        if let Some(_status) = child
            .try_wait()
            .map_err(|error| format!("Could not read ssh status: {error}"))?
        {
            let output = child
                .wait_with_output()
                .map_err(|error| format!("Could not read ssh output: {error}"))?;
            return Ok(CommandOutput {
                status: output.status.code().unwrap_or(1),
                stdout: String::from_utf8_lossy(&output.stdout).trim().to_string(),
                stderr: String::from_utf8_lossy(&output.stderr).trim().to_string(),
                timed_out: false,
            });
        }

        if started.elapsed() > SSH_TIMEOUT {
            let _ = child.kill();
            let _ = child.wait();
            return Err("SSH command timed out after 20 seconds.".to_string());
        }

        thread::sleep(Duration::from_millis(100));
    }
}

fn run_remote_invocation_result(
    invocation: SshInvocation,
    label: String,
    redacted_preview: Option<String>,
) -> Result<RemoteCommandResult, String> {
    let started = Instant::now();
    let preview = redacted_preview.unwrap_or_else(|| invocation.program.clone());
    match run_ssh_invocation(&invocation) {
        Ok(output) => Ok(RemoteCommandResult {
            exit_code: output.status,
            stdout: output.stdout,
            stderr: output.stderr,
            duration_ms: started.elapsed().as_millis(),
            command_label: label,
            redacted_command_preview: preview,
            timed_out: false,
        }),
        Err(message) => Ok(RemoteCommandResult {
            exit_code: 1,
            stdout: String::new(),
            stderr: message,
            duration_ms: started.elapsed().as_millis(),
            command_label: label,
            redacted_command_preview: preview,
            timed_out: false,
        }),
    }
}

fn run_remote_command_via_terminal(
    settings: &NibiSettings,
    remote_command: &str,
    label: String,
    redacted_preview: Option<String>,
) -> Result<RemoteCommandResult, String> {
    validate_manual_login_settings(settings)?;
    let started = Instant::now();
    let paths = create_terminal_action_paths("ssh")?;
    let script = terminal_ssh_script(settings, remote_command, &paths);
    run_terminal_action_script(&paths, &script)?;
    let output = read_terminal_action_output(&paths)?;
    Ok(RemoteCommandResult {
        exit_code: output.status,
        stdout: output.stdout,
        stderr: output.stderr,
        duration_ms: started.elapsed().as_millis(),
        command_label: label.clone(),
        redacted_command_preview: redacted_preview.unwrap_or(label),
        timed_out: false,
    })
}

fn upload_file_via_terminal(
    settings: &NibiSettings,
    local_path: &str,
    remote_path: &str,
) -> Result<(), String> {
    validate_manual_login_settings(settings)?;
    let paths = create_terminal_action_paths("scp-upload")?;
    let target = format!(
        "{}@{}:{}",
        settings.nibi_username.trim(),
        settings.manual_login_host(),
        remote_path
    );
    let script = terminal_scp_script(settings, local_path, &target, &paths);
    run_terminal_action_script(&paths, &script)?;
    let output = read_terminal_action_output(&paths)?;
    if output.status == 0 {
        Ok(())
    } else {
        Err(output.combined())
    }
}

fn download_file_via_terminal(
    settings: &NibiSettings,
    remote_path: &str,
    local_path: &str,
) -> Result<(), String> {
    validate_manual_login_settings(settings)?;
    let paths = create_terminal_action_paths("scp-download")?;
    let source = format!(
        "{}@{}:{}",
        settings.nibi_username.trim(),
        settings.manual_login_host(),
        remote_path
    );
    let script = terminal_scp_script(settings, &source, local_path, &paths);
    run_terminal_action_script(&paths, &script)?;
    let output = read_terminal_action_output(&paths)?;
    if output.status == 0 {
        Ok(())
    } else {
        Err(output.combined())
    }
}

fn create_terminal_action_paths(action_kind: &str) -> Result<TerminalActionPaths, String> {
    let action_id = new_nonce(action_kind);
    let work_dir = std::env::temp_dir()
        .join("fluorcast-terminal-actions")
        .join(&action_id);
    std::fs::create_dir_all(&work_dir)
        .map_err(|error| format!("Could not create terminal action folder: {error}"))?;
    let command_path = work_dir.join("command.ps1");
    let stdout_path = work_dir.join("stdout.txt");
    let stderr_path = work_dir.join("stderr.txt");
    let exit_code_path = work_dir.join("exit_code.txt");
    let result_json_path = work_dir.join("result.json");
    Ok(TerminalActionPaths {
        action_id,
        work_dir: path_to_string(&work_dir)?,
        command_path: path_to_string(&command_path)?,
        stdout_path: path_to_string(&stdout_path)?,
        stderr_path: path_to_string(&stderr_path)?,
        exit_code_path: path_to_string(&exit_code_path)?,
        result_json_path: path_to_string(&result_json_path)?,
    })
}

fn terminal_ssh_script(
    settings: &NibiSettings,
    remote_command: &str,
    paths: &TerminalActionPaths,
) -> String {
    let target = format!(
        "{}@{}",
        settings.nibi_username.trim(),
        settings.manual_login_host()
    );
    format!(
        "$ErrorActionPreference = 'Continue'\n\
         Write-Host 'FluorCast NIBI action: complete password and Duo when prompted.'\n\
         ssh -i {key} -o IdentitiesOnly=yes {target} {remote_command} 1> {stdout} 2> {stderr}\n\
         $exitCode = if ($null -eq $LASTEXITCODE) {{ 1 }} else {{ $LASTEXITCODE }}\n\
         $exitCode | Out-File -Encoding utf8 {exit_code}\n\
         '{{\"action_id\":{action_id},\"exit_code\":' + $exitCode + '}}' | Out-File -Encoding utf8 {result_json}\n\
         Write-Host \"FluorCast action finished with exit code $exitCode. You may close this window.\"\n",
        key = powershell_single_quote(settings.private_key_path()),
        target = powershell_single_quote(&target),
        remote_command = powershell_single_quote(remote_command),
        stdout = powershell_single_quote(&paths.stdout_path),
        stderr = powershell_single_quote(&paths.stderr_path),
        exit_code = powershell_single_quote(&paths.exit_code_path),
        result_json = powershell_single_quote(&paths.result_json_path),
        action_id = json_string_literal(&paths.action_id),
    )
}

fn terminal_scp_script(
    settings: &NibiSettings,
    source: &str,
    destination: &str,
    paths: &TerminalActionPaths,
) -> String {
    format!(
        "$ErrorActionPreference = 'Continue'\n\
         Write-Host 'FluorCast NIBI file action: complete password and Duo when prompted.'\n\
         scp -i {key} -o IdentitiesOnly=yes {source} {destination} 1> {stdout} 2> {stderr}\n\
         $exitCode = if ($null -eq $LASTEXITCODE) {{ 1 }} else {{ $LASTEXITCODE }}\n\
         $exitCode | Out-File -Encoding utf8 {exit_code}\n\
         '{{\"action_id\":{action_id},\"exit_code\":' + $exitCode + '}}' | Out-File -Encoding utf8 {result_json}\n\
         Write-Host \"FluorCast file action finished with exit code $exitCode. You may close this window.\"\n",
        key = powershell_single_quote(settings.private_key_path()),
        source = powershell_single_quote(source),
        destination = powershell_single_quote(destination),
        stdout = powershell_single_quote(&paths.stdout_path),
        stderr = powershell_single_quote(&paths.stderr_path),
        exit_code = powershell_single_quote(&paths.exit_code_path),
        result_json = powershell_single_quote(&paths.result_json_path),
        action_id = json_string_literal(&paths.action_id),
    )
}

fn run_terminal_action_script(paths: &TerminalActionPaths, script: &str) -> Result<(), String> {
    std::fs::write(&paths.command_path, script)
        .map_err(|error| format!("Could not write terminal action script: {error}"))?;
    let launch = format!(
        "Start-Process -Wait -FilePath powershell.exe -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',{})",
        powershell_single_quote(&paths.command_path)
    );
    let status = Command::new("powershell.exe")
        .args(["-NoProfile", "-Command", &launch])
        .status()
        .map_err(|error| format!("Could not open PowerShell terminal action: {error}"))?;
    if status.code().is_none() {
        return Err("PowerShell terminal action ended without an exit code.".to_string());
    }
    Ok(())
}

fn read_terminal_action_output(paths: &TerminalActionPaths) -> Result<CommandOutput, String> {
    let stdout = read_optional_text_file(&paths.stdout_path)?;
    let stderr = read_optional_text_file(&paths.stderr_path)?;
    let exit_code_text = read_optional_text_file(&paths.exit_code_path)?;
    let status = exit_code_text
        .trim_start_matches('\u{feff}')
        .trim()
        .parse::<i32>()
        .unwrap_or(1);
    Ok(CommandOutput {
        status,
        stdout: stdout.trim().to_string(),
        stderr: stderr.trim().to_string(),
        timed_out: false,
    })
}

fn read_optional_text_file(path: &str) -> Result<String, String> {
    match std::fs::read_to_string(path) {
        Ok(value) => Ok(value),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(error) => Err(format!(
            "Could not read terminal action file {path}: {error}"
        )),
    }
}

fn path_to_string(path: &PathBuf) -> Result<String, String> {
    path.to_str()
        .map(|value| value.to_string())
        .ok_or_else(|| "Terminal action path is not valid UTF-8.".to_string())
}

fn persistent_shell_slot() -> &'static Mutex<Option<PersistentShell>> {
    PERSISTENT_SHELL.get_or_init(|| Mutex::new(None))
}

impl PersistentShell {
    fn drain_output(&mut self) {
        while let Ok(chunk) = self.rx.try_recv() {
            self.push_output(format!("[{}] {}", chunk.stream, chunk.text));
        }
        if matches!(
            self.status,
            PersistentShellStatus::Active
                | PersistentShellStatus::WaitingForLoginMfa
                | PersistentShellStatus::Connecting
        ) {
            if self.child.try_wait().ok().flatten().is_some() {
                self.status = PersistentShellStatus::Disconnected;
            }
        }
    }

    fn push_output(&mut self, text: String) {
        self.output_log.push_back(text);
        while self.output_text().len() > PERSISTENT_SHELL_LOG_LIMIT {
            let _ = self.output_log.pop_front();
        }
    }

    fn output_text(&self) -> String {
        self.output_log.iter().cloned().collect::<Vec<_>>().join("")
    }

    fn snapshot(&self, message: &str) -> PersistentShellSessionStatus {
        PersistentShellSessionStatus {
            session_id: self.session_id.clone(),
            process_id: Some(self.process_id),
            started_at: self.started_at.clone(),
            status: self.status.clone(),
            output: self.output_text(),
            message: message.to_string(),
        }
    }
}

fn with_persistent_shell_mut<T>(
    f: impl FnOnce(&mut PersistentShell) -> Result<T, String>,
) -> Result<T, String> {
    let mut guard = persistent_shell_slot()
        .lock()
        .map_err(|_| "Persistent shell state is unavailable.".to_string())?;
    let shell = guard
        .as_mut()
        .ok_or_else(|| "No persistent NIBI session is running.".to_string())?;
    f(shell)
}

fn spawn_shell_reader(
    mut reader: impl Read + Send + 'static,
    stream: &'static str,
    tx: mpsc::Sender<ShellChunk>,
) {
    thread::spawn(move || {
        let mut buffer = [0_u8; 4096];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(count) => {
                    let text = String::from_utf8_lossy(&buffer[..count]).to_string();
                    if tx.send(ShellChunk { stream, text }).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });
}

fn run_persistent_shell_probe(
    command: &str,
    end_marker: &str,
    timeout: Duration,
) -> Result<String, String> {
    with_persistent_shell_mut(|shell| {
        shell
            .stdin
            .write_all(b"stty -echo 2>/dev/null || true\n")
            .and_then(|_| shell.stdin.write_all(command.as_bytes()))
            .and_then(|_| shell.stdin.write_all(b"\n"))
            .and_then(|_| shell.stdin.flush())
            .map_err(|error| format!("Could not write to persistent SSH session: {error}"))?;
        collect_until_marker(shell, end_marker, timeout)
    })
}

fn collect_until_marker(
    shell: &mut PersistentShell,
    end_marker: &str,
    timeout: Duration,
) -> Result<String, String> {
    let started = Instant::now();
    let mut collected = String::new();
    loop {
        while let Ok(chunk) = shell.rx.try_recv() {
            collected.push_str(&chunk.text);
            shell.push_output(format!("[{}] {}", chunk.stream, chunk.text));
        }
        if collected.contains(end_marker) {
            return Ok(collected);
        }
        if shell.child.try_wait().ok().flatten().is_some() {
            shell.status = PersistentShellStatus::Disconnected;
            return Err("Persistent NIBI session disconnected.".to_string());
        }
        if started.elapsed() > timeout {
            return Err(format!(
                "Persistent shell command timed out after {} seconds.",
                timeout.as_secs()
            ));
        }
        thread::sleep(Duration::from_millis(50));
    }
}

fn run_command_in_persistent_shell(
    settings: &NibiSettings,
    remote_command: &str,
    label: String,
    redacted_preview: Option<String>,
    timeout: Duration,
) -> Result<RemoteCommandResult, String> {
    validate_manual_login_settings(settings)?;
    let started = Instant::now();
    let nonce = new_nonce("cmd");
    let wrapped = build_persistent_shell_command(remote_command, &nonce);
    let end_marker = format!("__FC_END_{nonce}__");
    let preview = redacted_preview.unwrap_or_else(|| label.clone());
    let raw = match run_persistent_shell_probe(&wrapped, &end_marker, timeout) {
        Ok(output) => output,
        Err(message) => {
            return Ok(RemoteCommandResult {
                exit_code: 1,
                stdout: String::new(),
                stderr: message,
                duration_ms: started.elapsed().as_millis(),
                command_label: label,
                redacted_command_preview: preview,
                timed_out: true,
            });
        }
    };
    let parsed = parse_persistent_shell_command_output(&raw, &nonce);
    Ok(RemoteCommandResult {
        exit_code: parsed.exit_code.unwrap_or(1),
        stdout: parsed.stdout,
        stderr: String::new(),
        duration_ms: started.elapsed().as_millis(),
        command_label: label,
        redacted_command_preview: preview,
        timed_out: false,
    })
}

struct ParsedPersistentShellOutput {
    stdout: String,
    exit_code: Option<i32>,
}

fn build_persistent_shell_command(command: &str, nonce: &str) -> String {
    format!(
        "printf '\\n__FC_START_{nonce}__\\n'\n{command}\nprintf '\\n__FC_EXIT_{nonce}__:%s\\n' \"$?\"\nprintf '\\n__FC_END_{nonce}__\\n'"
    )
}

fn parse_persistent_shell_command_output(output: &str, nonce: &str) -> ParsedPersistentShellOutput {
    let start_marker = format!("__FC_START_{nonce}__");
    let exit_marker = format!("__FC_EXIT_{nonce}__:");
    let end_marker = format!("__FC_END_{nonce}__");
    let after_start = output.split(&start_marker).last().unwrap_or(output);
    let before_end = after_start.split(&end_marker).next().unwrap_or(after_start);
    let (stdout, exit_code) = if let Some((body, exit_part)) = before_end.rsplit_once(&exit_marker)
    {
        let code = exit_part
            .lines()
            .next()
            .and_then(|value| value.trim().parse::<i32>().ok());
        (body.trim_matches('\n').to_string(), code)
    } else {
        (before_end.trim_matches('\n').to_string(), None)
    };
    ParsedPersistentShellOutput { stdout, exit_code }
}

fn upload_text_file_via_shell(
    settings: &NibiSettings,
    remote_path: &str,
    text: &str,
) -> Result<(), String> {
    let encoded = base64_encode(text.as_bytes());
    let parent = remote_parent_dir(remote_path)?;
    let command = format!(
        "mkdir -p {parent} && base64 -d > {path} <<'__FC_UPLOAD__'\n{encoded}\n__FC_UPLOAD__",
        parent = shell_quote(&parent),
        path = shell_quote(remote_path),
        encoded = encoded,
    );
    let result = run_command_in_persistent_shell(
        settings,
        &command,
        "Upload JSON via persistent shell".to_string(),
        Some(format!("base64 upload {}", shell_quote(remote_path))),
        PERSISTENT_SHELL_TIMEOUT,
    )?;
    if result.exit_code == 0 {
        Ok(())
    } else {
        Err(result.stderr)
    }
}

fn download_text_file_via_shell(
    settings: &NibiSettings,
    remote_path: &str,
) -> Result<String, String> {
    let command = format!("base64 {}", shell_quote(remote_path));
    let result = run_command_in_persistent_shell(
        settings,
        &command,
        "Download JSON via persistent shell".to_string(),
        Some(format!("base64 {}", shell_quote(remote_path))),
        PERSISTENT_SHELL_TIMEOUT,
    )?;
    if result.exit_code != 0 {
        return Err(result.stderr);
    }
    let bytes = base64_decode(&result.stdout.replace(['\r', '\n'], ""))?;
    String::from_utf8(bytes).map_err(|error| format!("Downloaded file is not UTF-8 JSON: {error}"))
}

fn validate_remote_command_spec(command_spec: &RemoteCommandSpecInput) -> Result<(), String> {
    match command_spec.executable.as_str() {
        "mkdir" if command_spec.args.len() == 2 && command_spec.args[0] == "-p" => {
            validate_remote_path(&command_spec.args[1], "Remote job directory")
        }
        "mkdir" if command_spec.args.len() == 1 => {
            validate_remote_path(&command_spec.args[0], "Remote claim directory")
        }
        "test"
            if command_spec.args.len() == 2
                && matches!(
                    command_spec.args[0].as_str(),
                    "-d" | "-f" | "-r" | "-w" | "-x"
                ) =>
        {
            validate_remote_path(&command_spec.args[1], "Remote path")
        }
        "bash" if command_spec.args.len() == 2 && command_spec.args[0] == "-n" => {
            validate_remote_path(&command_spec.args[1], "Remote bash script")
        }
        "bash" if command_spec.args.len() == 2 && command_spec.args[0] == "-lc" => {
            validate_jobs_path_check_command(&command_spec.args[1])
        }
        "python3"
            if command_spec.args.len() == 3
                && command_spec.args[0] == "-m"
                && command_spec.args[1] == "json.tool" =>
        {
            validate_remote_path(&command_spec.args[2], "Remote JSON path")
        }
        "fluorcast-python-version" if command_spec.args.len() == 1 => {
            validate_remote_path(&command_spec.args[0], "Python executable path")
        }
        "cat" if command_spec.args.len() == 1 => {
            validate_remote_path(&command_spec.args[0], "Remote log path")
        }
        "fluorcast-record-slurm-submission" if command_spec.args.len() == 4 => {
            validate_remote_path(&command_spec.args[0], "Remote job directory")?;
            validate_job_id(&command_spec.args[1])?;
            validate_job_id(&command_spec.args[2])?;
            validate_slurm_job_id(&command_spec.args[3])
        }
        "command" if command_spec.args.len() == 2 && command_spec.args[0] == "-v" => {
            match command_spec.args[1].as_str() {
                "sbatch" | "squeue" | "sacct" => Ok(()),
                _ => Err("Unsupported remote command lookup.".to_string()),
            }
        }
        "squeue"
            if command_spec.args.len() == 4
                && command_spec.args[0] == "-j"
                && command_spec.args[2] == "--noheader"
                && command_spec.args[3] == "--format=%i|%T|%M|%R" =>
        {
            validate_slurm_job_id(&command_spec.args[1])
        }
        "sacct"
            if command_spec.args.len() == 5
                && command_spec.args[0] == "-j"
                && command_spec.args[2] == "--format=JobID,State,ExitCode"
                && command_spec.args[3] == "--parsable2"
                && command_spec.args[4] == "--noheader" =>
        {
            validate_slurm_job_id(&command_spec.args[1])
        }
        "scancel" if command_spec.args.len() == 1 => validate_slurm_job_id(&command_spec.args[0]),
        "sbatch"
            if command_spec.args.len() == 10
                && command_spec.args[0] == "--parsable"
                && command_spec.args[1] == "--chdir"
                && command_spec.args[3] == "--output"
                && command_spec.args[5] == "--error"
                && command_spec.args[7].ends_with("/slurm/run_prediction_job.sbatch") =>
        {
            validate_remote_path(&command_spec.args[2], "Remote project path")?;
            validate_remote_path(&command_spec.args[4], "Remote stdout path")?;
            validate_remote_path(&command_spec.args[6], "Remote stderr path")?;
            validate_remote_path(&command_spec.args[7], "Remote prediction Slurm script")?;
            validate_remote_path(&command_spec.args[8], "Remote input path")?;
            validate_remote_path(&command_spec.args[9], "Remote output path")
        }
        "sbatch"
            if command_spec.args.len() == 2
                && command_spec.args[0].ends_with("/slurm/run_duplicate_check_job.sbatch") =>
        {
            validate_remote_path(&command_spec.args[0], "Remote duplicate-check Slurm script")?;
            validate_remote_path(&command_spec.args[1], "Remote job directory")
        }
        _ => Err("Unsupported structured remote command.".to_string()),
    }
}

fn structured_remote_command_to_shell(
    command_spec: &RemoteCommandSpecInput,
) -> Result<String, String> {
    validate_remote_command_spec(command_spec)?;
    match command_spec.executable.as_str() {
        "mkdir" if command_spec.args.first().map(String::as_str) == Some("-p") => {
            Ok(format!("mkdir -p {}", shell_quote(&command_spec.args[1])))
        }
        "mkdir" => Ok(format!("mkdir {}", shell_quote(&command_spec.args[0]))),
        "test" => Ok(format!(
            "test {} {}",
            command_spec.args[0],
            shell_quote(&command_spec.args[1])
        )),
        "bash" if command_spec.args.first().map(String::as_str) == Some("-n") => {
            Ok(format!("bash -n {}", shell_quote(&command_spec.args[1])))
        }
        "bash" => Ok(command_spec.args[1].clone()),
        "python3" => Ok(format!(
            "python3 -m json.tool {} >/dev/null",
            shell_quote(&command_spec.args[2])
        )),
        "fluorcast-python-version" => Ok(format!(
            "{} --version",
            shell_quote(&command_spec.args[0])
        )),
        "cat" => Ok(format!("cat {}", shell_quote(&command_spec.args[0]))),
        "fluorcast-record-slurm-submission" => Ok(format!(
            "tmp={dir}/slurm_job_id.txt.tmp.$$ && printf '%s\\n' {slurm_id} > \"$tmp\" && mv \"$tmp\" {dir}/slurm_job_id.txt && printf '%s\\n' {submission_json} > {dir}/submission.json && printf '%s\\n' {status_json} > {dir}/status.json",
            dir = shell_quote(&command_spec.args[0]),
            slurm_id = shell_quote(&command_spec.args[3]),
            submission_json = shell_quote(&format!(
                "{{\"submission_id\":{},\"job_id\":{},\"slurm_job_id\":{},\"state\":\"submitted\"}}",
                json_string_literal(&command_spec.args[1]),
                json_string_literal(&command_spec.args[2]),
                json_string_literal(&command_spec.args[3])
            )),
            status_json = shell_quote(&format!(
                "{{\"state\":\"submitted\",\"slurm_job_id\":{}}}",
                json_string_literal(&command_spec.args[3])
            )),
        )),
        "command" => Ok(format!("command -v {}", command_spec.args[1])),
        "squeue" => Ok(format!(
            "squeue -j {} --noheader --format=\"%i|%T|%M|%R\"",
            shell_quote(&command_spec.args[1])
        )),
        "sacct" => Ok(format!(
            "sacct -j {} --format=JobID,State,ExitCode --parsable2 --noheader",
            shell_quote(&command_spec.args[1])
        )),
        "scancel" => Ok(format!("scancel {}", shell_quote(&command_spec.args[0]))),
        "sbatch" if command_spec.args.first().map(String::as_str) == Some("--parsable") => {
            Ok(format!(
                "sbatch --parsable --chdir={} --output={} --error={} {} {} {}",
                shell_quote(&command_spec.args[2]),
                shell_quote(&command_spec.args[4]),
                shell_quote(&command_spec.args[6]),
                shell_quote(&command_spec.args[7]),
                shell_quote(&command_spec.args[8]),
                shell_quote(&command_spec.args[9])
            ))
        }
        "sbatch" => Ok(format!(
            "sbatch {} {}",
            shell_quote(&command_spec.args[0]),
            shell_quote(&command_spec.args[1])
        )),
        _ => Err("Unsupported structured remote command.".to_string()),
    }
}

fn validate_jobs_path_check_command(command: &str) -> Result<(), String> {
    let prefix = "mkdir -p '";
    let separator = "' && test -d '";
    if !command.starts_with(prefix) || !command.ends_with('\'') {
        return Err("Unsupported remote jobs path check command.".to_string());
    }

    let rest = &command[prefix.len()..command.len() - 1];
    let Some((mkdir_path, test_path)) = rest.split_once(separator) else {
        return Err("Unsupported remote jobs path check command.".to_string());
    };
    if mkdir_path != test_path {
        return Err("Remote jobs path check must verify the created directory.".to_string());
    }
    validate_remote_path(mkdir_path, "Remote jobs path")
}

fn build_robot_remote_invocation(
    settings: &NibiSettings,
    remote_command: &str,
) -> Result<SshInvocation, String> {
    validate_robot_settings(settings)?;
    Ok(SshInvocation {
        program: "ssh".to_string(),
        args: vec![
            "-i".to_string(),
            settings.private_key_path().to_string(),
            "-o".to_string(),
            "IdentitiesOnly=yes".to_string(),
            format!(
                "{}@{}",
                settings.nibi_username.trim(),
                settings.robot_host()
            ),
            remote_command.to_string(),
        ],
    })
}

fn build_manual_mfa_remote_invocation(
    settings: &NibiSettings,
    remote_command: &str,
) -> Result<SshInvocation, String> {
    validate_manual_login_settings(settings)?;
    let commands = build_manual_mfa_session_commands(settings)?;
    let script = format!(
        "{}\nssh -S \"$ctl\" -o BatchMode=yes \"$host\" {}",
        wsl_prelude(
            &commands.control_path,
            &commands.wsl_key_path,
            &commands.host
        ),
        shell_quote(remote_command)
    );
    Ok(SshInvocation {
        program: "wsl.exe".to_string(),
        args: vec![
            "-e".to_string(),
            "bash".to_string(),
            "-lc".to_string(),
            script,
        ],
    })
}

struct UploadTarget {
    program: String,
    args: Vec<String>,
}

fn build_robot_scp_target(
    settings: &NibiSettings,
    local_path: &str,
    remote_path: &str,
) -> Result<UploadTarget, String> {
    validate_robot_settings(settings)?;
    Ok(UploadTarget {
        program: "scp".to_string(),
        args: vec![
            "-i".to_string(),
            settings.private_key_path().to_string(),
            "-o".to_string(),
            "IdentitiesOnly=yes".to_string(),
            local_path.to_string(),
            format!(
                "{}@{}:{}",
                settings.nibi_username.trim(),
                settings.robot_host(),
                remote_path
            ),
        ],
    })
}

fn build_manual_mfa_scp_target(
    settings: &NibiSettings,
    local_path: &str,
    remote_path: &str,
) -> Result<UploadTarget, String> {
    validate_manual_login_settings(settings)?;
    let commands = build_manual_mfa_session_commands(settings)?;
    let wsl_local_path = windows_path_to_wsl_mount(local_path);
    Ok(UploadTarget {
        program: "wsl.exe".to_string(),
        args: vec![
            "-e".to_string(),
            "bash".to_string(),
            "-lc".to_string(),
            format!(
                "{}\nscp -o BatchMode=yes -o ControlPath=\"$ctl\" {} \"$host:{}\"",
                wsl_prelude(
                    &commands.control_path,
                    &commands.wsl_key_path,
                    &commands.host
                ),
                shell_quote(&wsl_local_path),
                remote_path
            ),
        ],
    })
}

fn build_robot_download_target(
    settings: &NibiSettings,
    remote_path: &str,
    local_path: &str,
) -> Result<UploadTarget, String> {
    validate_robot_settings(settings)?;
    Ok(UploadTarget {
        program: "scp".to_string(),
        args: vec![
            "-i".to_string(),
            settings.private_key_path().to_string(),
            "-o".to_string(),
            "IdentitiesOnly=yes".to_string(),
            format!(
                "{}@{}:{}",
                settings.nibi_username.trim(),
                settings.robot_host(),
                remote_path
            ),
            local_path.to_string(),
        ],
    })
}

fn build_manual_mfa_download_target(
    settings: &NibiSettings,
    remote_path: &str,
    local_path: &str,
) -> Result<UploadTarget, String> {
    validate_manual_login_settings(settings)?;
    let commands = build_manual_mfa_session_commands(settings)?;
    let wsl_local_path = windows_path_to_wsl_mount(local_path);
    Ok(UploadTarget {
        program: "wsl.exe".to_string(),
        args: vec![
            "-e".to_string(),
            "bash".to_string(),
            "-lc".to_string(),
            format!(
                "{}\nscp -o BatchMode=yes -o ControlPath=\"$ctl\" \"$host:{}\" {}",
                wsl_prelude(
                    &commands.control_path,
                    &commands.wsl_key_path,
                    &commands.host
                ),
                remote_path,
                shell_quote(&wsl_local_path)
            ),
        ],
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct WslBashScriptInvocation {
    program: String,
    args: Vec<String>,
    stdin: String,
}

fn build_wsl_bash_script_invocation(
    distro: &str,
    script: &str,
    positional_args: &[String],
) -> WslBashScriptInvocation {
    let mut args = vec![
        "-d".to_string(),
        wsl_distro_name(distro),
        "--".to_string(),
        "bash".to_string(),
        "-s".to_string(),
        "--".to_string(),
    ];
    args.extend(positional_args.iter().cloned());
    WslBashScriptInvocation {
        program: "wsl.exe".to_string(),
        args,
        stdin: normalize_bash_source(script),
    }
}

fn run_manual_mfa_remote_command_result(
    settings: &NibiSettings,
    remote_command: &str,
    label: String,
    redacted_preview: Option<String>,
) -> Result<RemoteCommandResult, String> {
    validate_manual_login_settings(settings)?;
    let commands = build_manual_mfa_session_commands(settings)?;
    let preview = redacted_preview.unwrap_or_else(|| label.clone());
    let started = Instant::now();
    let readiness = run_manual_mfa_session_readiness(&commands);
    if !readiness.can_run_background_commands {
        return Ok(RemoteCommandResult {
            exit_code: readiness.last_session_test_exit_code.unwrap_or(1),
            stdout: readiness.last_session_test_stdout,
            stderr: readiness.message,
            duration_ms: started.elapsed().as_millis(),
            command_label: label,
            redacted_command_preview: preview,
            timed_out: matches!(readiness.status, ManualMfaSessionStatus::Timeout),
        });
    }

    let invocation = build_manual_mfa_remote_command_invocation(&commands, remote_command);
    let output = run_program_with_stdin_timeout(
        &invocation.program,
        &invocation.args,
        &invocation.stdin,
        command_timeout(settings, remote_command),
    )?;

    Ok(RemoteCommandResult {
        exit_code: output.status,
        stdout: output.stdout,
        stderr: output.stderr,
        duration_ms: started.elapsed().as_millis(),
        command_label: label,
        redacted_command_preview: preview,
        timed_out: output.timed_out,
    })
}

fn build_manual_mfa_remote_command_invocation(
    commands: &ManualMfaSessionCommands,
    remote_command: &str,
) -> WslBashScriptInvocation {
    let args = vec![commands.host.clone(), remote_command.to_string()];
    build_wsl_bash_script_invocation(
        &commands.wsl_distro,
        &manual_mfa_remote_command_script(),
        &args,
    )
}

fn manual_mfa_remote_command_script() -> String {
    [
        "#!/usr/bin/env bash",
        "set -Eeuo pipefail",
        "",
        "HOST=\"$1\"",
        "REMOTE_COMMAND=\"$2\"",
        "CTL=\"$HOME/.fluorcast/ssh/cm-nibi.sock\"",
        "",
        "ssh \\",
        "  -S \"$CTL\" \\",
        "  -o ControlMaster=no \\",
        "  -o BatchMode=yes \\",
        "  \"$HOST\" \\",
        "  \"$REMOTE_COMMAND\"",
    ]
    .join("\n")
}

fn command_timeout(_settings: &NibiSettings, _remote_command: &str) -> Duration {
    WSL_SCRIPT_TIMEOUT
}

fn manual_mfa_session_test_script() -> String {
    [
        "#!/usr/bin/env bash",
        "set -Eeuo pipefail",
        "",
        "HOST=\"$1\"",
        "CTL=\"$HOME/.fluorcast/ssh/cm-nibi.sock\"",
        "",
        "printf 'WSL_DISTRO=%s\\n' \"${WSL_DISTRO_NAME:-unknown}\"",
        "printf 'WSL_USER=%s\\n' \"$(whoami)\"",
        "printf 'WSL_HOME=%s\\n' \"$HOME\"",
        "printf 'CONTROL_PATH=%s\\n' \"$CTL\"",
        "",
        "if [[ ! -e \"$CTL\" ]]; then",
        "    printf 'SESSION_ERROR=CONTROL_PATH_MISSING\\n'",
        "    exit 10",
        "fi",
        "",
        "if [[ ! -S \"$CTL\" ]]; then",
        "    printf 'SESSION_ERROR=CONTROL_PATH_NOT_SOCKET\\n'",
        "    exit 11",
        "fi",
        "",
        "printf 'SOCKET_EXISTS=1\\n'",
        "",
        "if ! ssh -S \"$CTL\" -O check \"$HOST\"; then",
        "    printf 'SESSION_ERROR=CONTROL_MASTER_CHECK_FAILED\\n'",
        "    exit 12",
        "fi",
        "",
        "printf 'MASTER_RUNNING=1\\n'",
        "",
        "RESULT=\"$(",
        "    ssh \\",
        "      -S \"$CTL\" \\",
        "      -o ControlMaster=no \\",
        "      -o BatchMode=yes \\",
        "      -o ConnectTimeout=10 \\",
        "      -o PasswordAuthentication=no \\",
        "      -o KbdInteractiveAuthentication=no \\",
        "      \"$HOST\" \\",
        "      'printf \"FLUORCAST_AUTH_OK\\n\"'",
        ")\"",
        "",
        "if [[ \"$RESULT\" != \"FLUORCAST_AUTH_OK\" ]]; then",
        "    printf 'SESSION_ERROR=AUTH_MARKER_MISSING\\n'",
        "    printf 'REMOTE_OUTPUT=%s\\n' \"$RESULT\"",
        "    exit 13",
        "fi",
        "",
        "printf 'FLUORCAST_AUTH_OK\\n'",
    ]
    .join("\n")
}

fn run_manual_mfa_session_readiness(commands: &ManualMfaSessionCommands) -> ManualMfaSessionResult {
    let args = vec![commands.host.clone()];
    match run_wsl_bash_script(
        &commands.wsl_distro,
        &commands.check_script_content,
        &args,
        WSL_SCRIPT_TIMEOUT,
    ) {
        Ok(output) => classify_manual_mfa_session_probe_output(commands, &output),
        Err(message) => manual_mfa_transport_error_result(commands, message),
    }
}

fn classify_manual_mfa_session_probe_output(
    commands: &ManualMfaSessionCommands,
    output: &CommandOutput,
) -> ManualMfaSessionResult {
    let combined = output.combined();
    let control_path =
        resolved_control_path_from_output(output).unwrap_or_else(|| commands.control_path.clone());
    let (status, message, can_run_background_commands, control_path_exists) = if output.status == 0
        && output.stdout.contains(MANUAL_MFA_OK)
    {
        (
            ManualMfaSessionStatus::Authenticated,
            format!("Authenticated WSL NIBI session is ready.\n{MANUAL_MFA_OK}"),
            true,
            true,
        )
    } else if output.timed_out || output.status == 124 {
        (
            ManualMfaSessionStatus::Timeout,
            "The WSL NIBI session test timed out.".to_string(),
            false,
            output.stdout.contains("SOCKET_EXISTS=1"),
        )
    } else if output.status == 10 || combined.contains("SESSION_ERROR=CONTROL_PATH_MISSING") {
        (
            ManualMfaSessionStatus::SessionNotFound,
            "ControlPath is missing. Start the NIBI session, then test again.".to_string(),
            false,
            false,
        )
    } else if output.status == 11 || combined.contains("SESSION_ERROR=CONTROL_PATH_NOT_SOCKET") {
        (
            ManualMfaSessionStatus::ControlPathNotSocket,
            "ControlPath exists but is not a socket. Clean stale WSL session, then start again."
                .to_string(),
            false,
            true,
        )
    } else if output.status == 12 || combined.contains("SESSION_ERROR=CONTROL_MASTER_CHECK_FAILED")
    {
        (
            ManualMfaSessionStatus::StaleControlmaster,
            "The ControlMaster socket is stale or not running. Clean stale WSL session, then start again."
                .to_string(),
            false,
            true,
        )
    } else if output.status == 13 || combined.contains("SESSION_ERROR=AUTH_MARKER_MISSING") {
        (
            ManualMfaSessionStatus::AuthMarkerMissing,
            "Authenticated session reuse did not return FLUORCAST_AUTH_OK.".to_string(),
            false,
            output.stdout.contains("SOCKET_EXISTS=1"),
        )
    } else if is_interactive_login_required_output(&combined) {
        (
            ManualMfaSessionStatus::SessionNotReused,
            "BatchMode reuse failed and NIBI attempted interactive authentication.".to_string(),
            false,
            output.stdout.contains("SOCKET_EXISTS=1"),
        )
    } else if output.status == 126 || output.status == 127 {
        (
            ManualMfaSessionStatus::BashTransportFailed,
            "WSL bash transport failed before the session test could complete.".to_string(),
            false,
            output.stdout.contains("SOCKET_EXISTS=1"),
        )
    } else {
        (
            ManualMfaSessionStatus::BatchModeReuseFailed,
            "BatchMode session reuse failed; no fresh password or Duo prompt was attempted."
                .to_string(),
            false,
            output.stdout.contains("SOCKET_EXISTS=1"),
        )
    };

    ManualMfaSessionResult {
        status,
        message,
        control_path,
        control_path_exists,
        redacted_command_preview: commands.redacted_test_command_preview.clone(),
        can_run_background_commands,
        last_master_check_result: combined.clone(),
        last_auth_ok_result: if output.stdout.contains(MANUAL_MFA_OK) {
            MANUAL_MFA_OK.to_string()
        } else {
            combined.clone()
        },
        last_session_test_stdout: output.stdout.clone(),
        last_session_test_stderr: output.stderr.clone(),
        last_session_test_exit_code: Some(output.status),
        parsed_session_status: status,
        selected_backend: "wsl",
        wsl_available: wsl_available_for_distro(&commands.wsl_distro),
        wsl_ssh_available: wsl_ssh_available_for_distro(&commands.wsl_distro),
    }
}

fn manual_mfa_transport_error_result(
    commands: &ManualMfaSessionCommands,
    message: String,
) -> ManualMfaSessionResult {
    let status = if message.to_ascii_lowercase().contains("could not start wsl") {
        ManualMfaSessionStatus::WslUnavailable
    } else {
        ManualMfaSessionStatus::BashTransportFailed
    };
    ManualMfaSessionResult {
        status,
        message,
        control_path: commands.control_path.clone(),
        control_path_exists: false,
        redacted_command_preview: commands.redacted_test_command_preview.clone(),
        can_run_background_commands: false,
        last_master_check_result: String::new(),
        last_auth_ok_result: String::new(),
        last_session_test_stdout: String::new(),
        last_session_test_stderr: String::new(),
        last_session_test_exit_code: None,
        parsed_session_status: status,
        selected_backend: "wsl",
        wsl_available: wsl_available_for_distro(&commands.wsl_distro),
        wsl_ssh_available: false,
    }
}

fn resolved_control_path_from_output(output: &CommandOutput) -> Option<String> {
    output
        .stdout
        .lines()
        .find_map(|line| line.strip_prefix("CONTROL_PATH=").map(str::to_string))
}

fn normalize_bash_source(script: &str) -> String {
    script.replace("\r\n", "\n").replace('\r', "\n")
}

fn run_wsl_bash_script(
    distro: &str,
    script: &str,
    positional_args: &[String],
    timeout: Duration,
) -> Result<CommandOutput, String> {
    let invocation = build_wsl_bash_script_invocation(distro, script, positional_args);
    run_program_with_stdin_timeout(
        &invocation.program,
        &invocation.args,
        &invocation.stdin,
        timeout,
    )
    .map_err(|error| format!("Could not run WSL bash script: {error}"))
}

fn run_program_with_stdin_timeout(
    program: &str,
    args: &[String],
    stdin_text: &str,
    timeout: Duration,
) -> Result<CommandOutput, String> {
    let mut child = Command::new(program)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("Could not start {program}: {error}"))?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| format!("Could not capture {program} stdout."))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| format!("Could not capture {program} stderr."))?;
    let stdout_handle = thread::spawn(move || {
        let mut reader = stdout;
        let mut output = String::new();
        reader.read_to_string(&mut output).map(|_| output)
    });
    let stderr_handle = thread::spawn(move || {
        let mut reader = stderr;
        let mut output = String::new();
        reader.read_to_string(&mut output).map(|_| output)
    });

    if let Some(mut stdin) = child.stdin.take() {
        if let Err(error) = stdin
            .write_all(stdin_text.as_bytes())
            .and_then(|_| stdin.flush())
        {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!("Could not write script stdin: {error}"));
        }
    }

    let started = Instant::now();
    let mut timed_out = false;
    let status = loop {
        if let Some(status) = child
            .try_wait()
            .map_err(|error| format!("Could not read {program} status: {error}"))?
        {
            break status;
        }
        if started.elapsed() > timeout {
            timed_out = true;
            let _ = child.kill();
            break child
                .wait()
                .map_err(|error| format!("Could not wait for timed out {program}: {error}"))?;
        }
        thread::sleep(Duration::from_millis(50));
    };

    let stdout = stdout_handle
        .join()
        .map_err(|_| format!("Could not join {program} stdout reader."))?
        .map_err(|error| format!("Could not read {program} stdout: {error}"))?;
    let stderr = stderr_handle
        .join()
        .map_err(|_| format!("Could not join {program} stderr reader."))?
        .map_err(|error| format!("Could not read {program} stderr: {error}"))?;

    Ok(CommandOutput {
        status: if timed_out {
            124
        } else {
            status.code().unwrap_or(1)
        },
        stdout: stdout.trim().to_string(),
        stderr: stderr.trim().to_string(),
        timed_out,
    })
}

fn run_wsl_script(script: &str) -> Result<CommandOutput, String> {
    let output = run_wsl_bash_script(&default_wsl_distro(), script, &[], WSL_SCRIPT_TIMEOUT)?;
    if output.status == 0 {
        Ok(output)
    } else {
        Err(output.combined())
    }
}

fn write_manual_mfa_scripts(commands: &ManualMfaSessionCommands) -> Result<(), String> {
    for (path, content) in [
        (&commands.start_script_path, &commands.login_command),
        (&commands.check_script_path, &commands.check_script_content),
        (&commands.end_script_path, &commands.end_script_content),
        (&commands.clean_script_path, &commands.clean_script_content),
    ] {
        write_wsl_script(path, content, &commands.wsl_distro)?;
    }
    Ok(())
}

fn write_wsl_script(path: &str, content: &str, distro: &str) -> Result<(), String> {
    let script_name = path
        .rsplit('/')
        .next()
        .ok_or_else(|| "WSL script path is invalid.".to_string())?
        .to_string();
    if script_name.is_empty()
        || !script_name.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.')
        })
    {
        return Err("WSL script filename contains unsupported characters.".to_string());
    }
    let writer_script = [
        "#!/usr/bin/env bash",
        "set -Eeuo pipefail",
        "SCRIPT_NAME=\"$1\"",
        "CONTENT_B64=\"$2\"",
        "SCRIPT_DIR=\"$HOME/.fluorcast/scripts\"",
        "SCRIPT_PATH=\"$SCRIPT_DIR/$SCRIPT_NAME\"",
        "mkdir -p \"$SCRIPT_DIR\"",
        "printf '%s' \"$CONTENT_B64\" | base64 -d > \"$SCRIPT_PATH\"",
        "chmod +x \"$SCRIPT_PATH\"",
        "printf 'SCRIPT_PATH=%s\\n' \"$SCRIPT_PATH\"",
    ]
    .join("\n");
    let args = vec![script_name, base64_encode(content.as_bytes())];
    let output = run_wsl_bash_script(distro, &writer_script, &args, WSL_SCRIPT_TIMEOUT).map_err(
        |error| {
            format!(
                "{} {}",
                terminal_command_not_found_message(&error),
                "Could not write WSL Manual MFA scripts."
            )
        },
    )?;
    if output.status == 0 {
        Ok(())
    } else {
        Err(format!(
            "Could not write WSL script {path}.\n{}\n{}",
            output.stdout, output.stderr
        ))
    }
}

fn launch_manual_mfa_terminal(commands: ManualMfaSessionCommands) -> ManualMfaTerminalLaunchResult {
    let wsl_ok = command_available("wsl.exe");
    let wt_ok = command_available("wt.exe");
    let powershell_ok = command_available("powershell.exe");
    let distro_ok = wsl_distro_available(&commands.wsl_distro);
    let timestamp = timestamp_now();
    let manual_message = format!(
        "Could not open the login terminal automatically. Open WSL and run:\n{}",
        commands.manual_wsl_login_command
    );

    if !wsl_ok {
        return ManualMfaTerminalLaunchResult {
            launched: false,
            method: TerminalLaunchMethod::Manual,
            message: manual_message,
            error_message: "wsl.exe was not found.".to_string(),
            timestamp,
            command_preview: commands.manual_wsl_login_command.clone(),
            generated_script_path: commands.start_script_path.clone(),
            script_file_exists: false,
            launch_method_attempted: "manual".to_string(),
            launch_error_code: String::new(),
            manual_wsl_command: commands.manual_wsl_login_command.clone(),
            commands,
            windows_terminal_available: wt_ok,
            powershell_available: powershell_ok,
            wsl_available: false,
            distro_available: false,
        };
    }

    if !distro_ok {
        return ManualMfaTerminalLaunchResult {
            launched: false,
            method: TerminalLaunchMethod::Manual,
            message: manual_message,
            error_message: format!("WSL distro '{}' was not found.", commands.wsl_distro),
            timestamp,
            command_preview: commands.manual_wsl_login_command.clone(),
            generated_script_path: commands.start_script_path.clone(),
            script_file_exists: false,
            launch_method_attempted: "manual".to_string(),
            launch_error_code: String::new(),
            manual_wsl_command: commands.manual_wsl_login_command.clone(),
            commands,
            windows_terminal_available: wt_ok,
            powershell_available: powershell_ok,
            wsl_available: true,
            distro_available: false,
        };
    }

    if let Err(error_message) = write_manual_mfa_scripts(&commands) {
        return ManualMfaTerminalLaunchResult {
            launched: false,
            method: TerminalLaunchMethod::Manual,
            message: manual_message,
            error_message,
            timestamp,
            command_preview: commands.manual_wsl_login_command.clone(),
            generated_script_path: commands.start_script_path.clone(),
            script_file_exists: wsl_path_exists(&commands.start_script_path),
            launch_method_attempted: "script_generation".to_string(),
            launch_error_code: String::new(),
            manual_wsl_command: commands.manual_wsl_login_command.clone(),
            commands,
            windows_terminal_available: wt_ok,
            powershell_available: powershell_ok,
            wsl_available: true,
            distro_available: true,
        };
    }

    if wt_ok {
        let mut args = vec![
            "new-tab".to_string(),
            "--title".to_string(),
            "FluorCast NIBI Login".to_string(),
            "wsl.exe".to_string(),
        ];
        if !commands.wsl_distro.trim().is_empty() {
            args.extend(["-d".to_string(), commands.wsl_distro.clone()]);
        }
        args.extend([
            "--".to_string(),
            "bash".to_string(),
            "-c".to_string(),
            "exec \"$HOME/.fluorcast/scripts/start-nibi-login.sh\" \"$@\"".to_string(),
            "--".to_string(),
            commands.host.clone(),
            commands.wsl_key_path.clone(),
        ]);
        match Command::new("wt.exe").args(&args).spawn() {
            Ok(_) => {
                return ManualMfaTerminalLaunchResult {
                    launched: true,
                    method: TerminalLaunchMethod::WindowsTerminal,
                    message: "Windows Terminal opened. Complete password/Duo there, then click Test authenticated session.".to_string(),
                    error_message: String::new(),
                    timestamp,
                    command_preview: commands.windows_terminal_command.clone(),
                    generated_script_path: commands.start_script_path.clone(),
                    script_file_exists: wsl_path_exists(&commands.start_script_path),
                    launch_method_attempted: "windows_terminal".to_string(),
                    launch_error_code: String::new(),
                    manual_wsl_command: commands.manual_wsl_login_command.clone(),
                    commands,
                    windows_terminal_available: true,
                    powershell_available: powershell_ok,
                    wsl_available: true,
                    distro_available: true,
                };
            }
            Err(error) => {
                // Fall through to PowerShell visible-window launch.
                let _ = error;
            }
        }
    }

    if powershell_ok {
        let ps_command = format!(
            "Start-Process powershell.exe -ArgumentList '-NoExit','-Command',{}",
            powershell_single_quote(&wsl_command_line(
                &commands.wsl_distro,
                &commands.host,
                &commands.wsl_key_path
            ))
        );
        match Command::new("powershell.exe")
            .args(["-NoProfile", "-Command", &ps_command])
            .spawn()
        {
            Ok(_) => ManualMfaTerminalLaunchResult {
                launched: true,
                method: TerminalLaunchMethod::Powershell,
                message: "PowerShell opened. Complete password/Duo there, then click Test authenticated session.".to_string(),
                error_message: String::new(),
                timestamp,
                command_preview: commands.powershell_launch_command.clone(),
                generated_script_path: commands.start_script_path.clone(),
                script_file_exists: wsl_path_exists(&commands.start_script_path),
                launch_method_attempted: "powershell".to_string(),
                launch_error_code: String::new(),
                manual_wsl_command: commands.manual_wsl_login_command.clone(),
                commands,
                windows_terminal_available: wt_ok,
                powershell_available: true,
                wsl_available: true,
                distro_available: true,
            },
            Err(error) => ManualMfaTerminalLaunchResult {
                launched: false,
                method: TerminalLaunchMethod::Manual,
                message: terminal_command_not_found_message(&error.to_string()),
                error_message: format!("Process launch failed: {error}"),
                timestamp,
                command_preview: commands.manual_wsl_login_command.clone(),
                generated_script_path: commands.start_script_path.clone(),
                script_file_exists: wsl_path_exists(&commands.start_script_path),
                launch_method_attempted: "powershell".to_string(),
                launch_error_code: terminal_launch_error_code(&error.to_string()),
                manual_wsl_command: commands.manual_wsl_login_command.clone(),
                commands,
                windows_terminal_available: wt_ok,
                powershell_available: true,
                wsl_available: true,
                distro_available: true,
            },
        }
    } else {
        ManualMfaTerminalLaunchResult {
            launched: false,
            method: TerminalLaunchMethod::Manual,
            message: manual_message,
            error_message: "powershell.exe was not found.".to_string(),
            timestamp,
            command_preview: commands.manual_wsl_login_command.clone(),
            generated_script_path: commands.start_script_path.clone(),
            script_file_exists: wsl_path_exists(&commands.start_script_path),
            launch_method_attempted: if wt_ok { "windows_terminal" } else { "manual" }.to_string(),
            launch_error_code: String::new(),
            manual_wsl_command: commands.manual_wsl_login_command.clone(),
            commands,
            windows_terminal_available: wt_ok,
            powershell_available: false,
            wsl_available: true,
            distro_available: true,
        }
    }
}

fn command_available(program: &str) -> bool {
    Command::new("where.exe")
        .arg(program)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

fn wsl_distro_available(distro: &str) -> bool {
    wsl_available_for_distro(distro)
}

fn wsl_available() -> bool {
    wsl_available_for_distro(&default_wsl_distro())
}

fn wsl_available_for_distro(distro: &str) -> bool {
    run_wsl_bash_script(distro, "printf 'ok\\n'", &[], Duration::from_secs(5))
        .map(|output| output.status == 0)
        .unwrap_or(false)
}

fn wsl_ssh_available() -> bool {
    wsl_ssh_available_for_distro(&default_wsl_distro())
}

fn wsl_ssh_available_for_distro(distro: &str) -> bool {
    run_wsl_bash_script(
        distro,
        "command -v ssh >/dev/null 2>&1",
        &[],
        Duration::from_secs(5),
    )
    .map(|output| output.status == 0)
    .unwrap_or(false)
}

fn wsl_path_exists(path: &str) -> bool {
    let args = vec![path.to_string()];
    run_wsl_bash_script(
        &default_wsl_distro(),
        "PATH_TO_CHECK=\"$1\"\ncase \"$PATH_TO_CHECK\" in\n  '$HOME'/*) PATH_TO_CHECK=\"$HOME/${PATH_TO_CHECK#'$HOME'/}\" ;;\nesac\ntest -S \"$PATH_TO_CHECK\" || test -e \"$PATH_TO_CHECK\"",
        &args,
        Duration::from_secs(5),
    )
    .map(|output| output.status == 0)
    .unwrap_or(false)
}

fn result_message(status: &CheckStatus, output: &CommandOutput) -> String {
    match status {
        CheckStatus::Passed => {
            if output.stdout.is_empty() {
                "Passed.".to_string()
            } else {
                format!("Passed: {}", output.stdout)
            }
        }
        CheckStatus::InteractiveLoginRequired => INTERACTIVE_LOGIN_REQUIRED_MESSAGE.to_string(),
        CheckStatus::Skipped => "Skipped.".to_string(),
        CheckStatus::Failed => {
            if !output.stderr.is_empty() {
                output.stderr.clone()
            } else if !output.stdout.is_empty() {
                output.stdout.clone()
            } else {
                format!("Command exited with status {}.", output.status)
            }
        }
    }
}

fn public_key_path_for_private_key(private_key_path: &str) -> String {
    format!("{}.pub", private_key_path.trim_end_matches(".pub"))
}

fn build_restricted_public_key(
    public_key_text: &str,
    settings: &NibiSettings,
) -> Result<String, String> {
    let public_key = public_key_text.trim();
    if public_key.is_empty() {
        return Err("Public key file is empty.".to_string());
    }
    if public_key.contains("PRIVATE KEY") {
        return Err("Public key file appears to contain private key text.".to_string());
    }
    if !(public_key.starts_with("ssh-ed25519 ")
        || public_key.starts_with("ssh-rsa ")
        || public_key.starts_with("ecdsa-sha2-"))
    {
        return Err(
            "Public key text must start with ssh-ed25519, ssh-rsa, or ecdsa-sha2-*.".to_string(),
        );
    }
    Ok(format!(
        "restrict,from=\"{}\",command=\"{}\" {}",
        settings.robot_key_restriction_from.trim(),
        settings.robot_key_forced_command.trim(),
        public_key
    ))
}

fn classify_robot_automation_output(
    output: CommandOutput,
    redacted_command_preview: String,
) -> RobotAutomationTestResult {
    if is_interactive_login_required_output(&output.combined()) {
        RobotAutomationTestResult {
            status: RobotAutomationTestStatus::RobotNotReady,
            message: ROBOT_NOT_READY_MESSAGE.to_string(),
            robot_access_verified: false,
            redacted_command_preview,
            stdout: output.stdout,
            stderr: output.stderr,
        }
    } else if output.status == 0 && output.stdout.trim() == ROBOT_AUTOMATION_OK {
        RobotAutomationTestResult {
            status: RobotAutomationTestStatus::Passed,
            message: "Robot automation access verified.".to_string(),
            robot_access_verified: true,
            redacted_command_preview,
            stdout: output.stdout,
            stderr: output.stderr,
        }
    } else {
        let message = if !output.stderr.is_empty() {
            output.stderr.clone()
        } else if !output.stdout.is_empty() {
            output.stdout.clone()
        } else {
            format!(
                "Robot automation test exited with status {}.",
                output.status
            )
        };
        RobotAutomationTestResult {
            status: RobotAutomationTestStatus::Failed,
            message,
            robot_access_verified: false,
            redacted_command_preview,
            stdout: output.stdout,
            stderr: output.stderr,
        }
    }
}

fn redacted_robot_command_preview(settings: &NibiSettings) -> String {
    format!(
        "ssh -i <private_key_path> -o IdentitiesOnly=yes {}@{} \"echo {ROBOT_AUTOMATION_OK}\"",
        settings.nibi_username.trim(),
        settings.robot_host()
    )
}

fn classify_command_output(output: &CommandOutput, expected_stdout: Option<&str>) -> CheckStatus {
    if is_interactive_login_required_output(&output.combined()) {
        CheckStatus::InteractiveLoginRequired
    } else if output.status == 0
        && expected_stdout
            .map(|expected| output.stdout.trim() == expected)
            .unwrap_or(true)
    {
        CheckStatus::Passed
    } else {
        CheckStatus::Failed
    }
}

fn classify_manual_mfa_session_output(
    commands: &ManualMfaSessionCommands,
    check_output: &CommandOutput,
    auth_output: &CommandOutput,
) -> ManualMfaSessionResult {
    let combined = auth_output.combined();
    let control_path_exists = wsl_path_exists(&commands.control_path);
    let parsed = classify_manual_mfa_status(&combined, control_path_exists);
    if check_output.status == 0
        && auth_output.status == 0
        && auth_output.stdout.trim() == MANUAL_MFA_OK
    {
        ManualMfaSessionResult {
            status: ManualMfaSessionStatus::Authenticated,
            message:
                "Manual NIBI login is authenticated and background commands can reuse the session."
                    .to_string(),
            control_path: commands.control_path.clone(),
            control_path_exists,
            redacted_command_preview: commands.redacted_test_command_preview.clone(),
            can_run_background_commands: true,
            last_master_check_result: check_output.combined(),
            last_auth_ok_result: auth_output.combined(),
            last_session_test_stdout: auth_output.stdout.clone(),
            last_session_test_stderr: auth_output.stderr.clone(),
            last_session_test_exit_code: Some(auth_output.status),
            parsed_session_status: ManualMfaSessionStatus::Authenticated,
            selected_backend: "wsl",
            wsl_available: wsl_available(),
            wsl_ssh_available: wsl_ssh_available(),
        }
    } else if matches!(parsed, ManualMfaSessionStatus::SessionNotReused) {
        ManualMfaSessionResult {
            status: ManualMfaSessionStatus::SessionNotReused,
            message: "The app session was not reused. NIBI is asking for login again.".to_string(),
            control_path: commands.control_path.clone(),
            control_path_exists,
            redacted_command_preview: commands.redacted_test_command_preview.clone(),
            can_run_background_commands: false,
            last_master_check_result: check_output.combined(),
            last_auth_ok_result: combined,
            last_session_test_stdout: auth_output.stdout.clone(),
            last_session_test_stderr: auth_output.stderr.clone(),
            last_session_test_exit_code: Some(auth_output.status),
            parsed_session_status: ManualMfaSessionStatus::SessionNotReused,
            selected_backend: "wsl",
            wsl_available: wsl_available(),
            wsl_ssh_available: wsl_ssh_available(),
        }
    } else if matches!(parsed, ManualMfaSessionStatus::ControlmasterUnsupported) {
        ManualMfaSessionResult {
            status: ManualMfaSessionStatus::ControlmasterUnsupported,
            message: "Your SSH client may not support reusable ControlMaster sessions on Windows. Use WSL/manual fallback or robot automation.".to_string(),
            control_path: commands.control_path.clone(),
            control_path_exists,
            redacted_command_preview: commands.redacted_test_command_preview.clone(),
            can_run_background_commands: false,
            last_master_check_result: check_output.combined(),
            last_auth_ok_result: combined,
            last_session_test_stdout: auth_output.stdout.clone(),
            last_session_test_stderr: auth_output.stderr.clone(),
            last_session_test_exit_code: Some(auth_output.status),
            parsed_session_status: ManualMfaSessionStatus::ControlmasterUnsupported,
            selected_backend: "wsl",
            wsl_available: wsl_available(),
            wsl_ssh_available: wsl_ssh_available(),
        }
    } else if matches!(parsed, ManualMfaSessionStatus::PermissionDenied) {
        ManualMfaSessionResult {
            status: ManualMfaSessionStatus::PermissionDenied,
            message: "Authentication failed. Check username, SSH key, and MFA setup.".to_string(),
            control_path: commands.control_path.clone(),
            control_path_exists,
            redacted_command_preview: commands.redacted_test_command_preview.clone(),
            can_run_background_commands: false,
            last_master_check_result: check_output.combined(),
            last_auth_ok_result: combined,
            last_session_test_stdout: auth_output.stdout.clone(),
            last_session_test_stderr: auth_output.stderr.clone(),
            last_session_test_exit_code: Some(auth_output.status),
            parsed_session_status: ManualMfaSessionStatus::PermissionDenied,
            selected_backend: "wsl",
            wsl_available: wsl_available(),
            wsl_ssh_available: wsl_ssh_available(),
        }
    } else if matches!(parsed, ManualMfaSessionStatus::SessionNotFound) {
        ManualMfaSessionResult {
            status: ManualMfaSessionStatus::SessionNotFound,
            message: "FluorCast did not find the reusable SSH session. Start login from FluorCast and keep the session alive.".to_string(),
            control_path: commands.control_path.clone(),
            control_path_exists,
            redacted_command_preview: commands.redacted_test_command_preview.clone(),
            can_run_background_commands: false,
            last_master_check_result: check_output.combined(),
            last_auth_ok_result: combined,
            last_session_test_stdout: auth_output.stdout.clone(),
            last_session_test_stderr: auth_output.stderr.clone(),
            last_session_test_exit_code: Some(auth_output.status),
            parsed_session_status: ManualMfaSessionStatus::SessionNotFound,
            selected_backend: "wsl",
            wsl_available: wsl_available(),
            wsl_ssh_available: wsl_ssh_available(),
        }
    } else {
        ManualMfaSessionResult {
            status: ManualMfaSessionStatus::Failed,
            message: "Manual login has not been completed yet.".to_string(),
            control_path: commands.control_path.clone(),
            control_path_exists,
            redacted_command_preview: commands.redacted_test_command_preview.clone(),
            can_run_background_commands: false,
            last_master_check_result: check_output.combined(),
            last_auth_ok_result: combined,
            last_session_test_stdout: auth_output.stdout.clone(),
            last_session_test_stderr: auth_output.stderr.clone(),
            last_session_test_exit_code: Some(auth_output.status),
            parsed_session_status: ManualMfaSessionStatus::Failed,
            selected_backend: "wsl",
            wsl_available: wsl_available(),
            wsl_ssh_available: wsl_ssh_available(),
        }
    }
}

fn classify_manual_mfa_session_error(
    commands: &ManualMfaSessionCommands,
    check_message: &str,
    auth_message: &str,
) -> ManualMfaSessionResult {
    let message = if auth_message.is_empty() {
        check_message
    } else {
        auth_message
    };
    let control_path_exists = wsl_path_exists(&commands.control_path);
    let parsed = classify_manual_mfa_status(message, control_path_exists);
    if matches!(parsed, ManualMfaSessionStatus::SessionNotReused) {
        ManualMfaSessionResult {
            status: ManualMfaSessionStatus::SessionNotReused,
            message: "The app session was not reused. NIBI is asking for login again.".to_string(),
            control_path: commands.control_path.clone(),
            control_path_exists,
            redacted_command_preview: commands.redacted_test_command_preview.clone(),
            can_run_background_commands: false,
            last_master_check_result: check_message.to_string(),
            last_auth_ok_result: auth_message.to_string(),
            last_session_test_stdout: String::new(),
            last_session_test_stderr: auth_message.to_string(),
            last_session_test_exit_code: None,
            parsed_session_status: ManualMfaSessionStatus::SessionNotReused,
            selected_backend: "wsl",
            wsl_available: wsl_available(),
            wsl_ssh_available: wsl_ssh_available(),
        }
    } else {
        let status = parsed;
        let friendly_message = match status {
            ManualMfaSessionStatus::ControlmasterUnsupported => "Your SSH client may not support reusable ControlMaster sessions on Windows. Use WSL/manual fallback or robot automation.".to_string(),
            ManualMfaSessionStatus::PermissionDenied => "Authentication failed. Check username, SSH key, and MFA setup.".to_string(),
            ManualMfaSessionStatus::SessionNotFound => "FluorCast did not find the reusable SSH session. Start login from FluorCast and keep the session alive.".to_string(),
            _ => map_manual_mfa_error(message),
        };
        ManualMfaSessionResult {
            status,
            message: friendly_message,
            control_path: commands.control_path.clone(),
            control_path_exists,
            redacted_command_preview: commands.redacted_test_command_preview.clone(),
            can_run_background_commands: false,
            last_master_check_result: check_message.to_string(),
            last_auth_ok_result: auth_message.to_string(),
            last_session_test_stdout: String::new(),
            last_session_test_stderr: message.to_string(),
            last_session_test_exit_code: None,
            parsed_session_status: status,
            selected_backend: "wsl",
            wsl_available: wsl_available(),
            wsl_ssh_available: wsl_ssh_available(),
        }
    }
}

fn classify_manual_mfa_status(message: &str, control_path_exists: bool) -> ManualMfaSessionStatus {
    if is_controlmaster_unsupported_output(message) {
        ManualMfaSessionStatus::ControlmasterUnsupported
    } else if is_interactive_login_required_output(message) {
        ManualMfaSessionStatus::SessionNotReused
    } else if is_permission_denied_output(message) {
        ManualMfaSessionStatus::PermissionDenied
    } else if !control_path_exists || is_control_path_missing_output(message) {
        ManualMfaSessionStatus::SessionNotFound
    } else {
        ManualMfaSessionStatus::Failed
    }
}

fn is_controlmaster_unsupported_output(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    lower.contains("bad configuration option: controlmaster")
        || lower.contains("unsupported option")
        || lower.contains("controlmaster")
        || lower.contains("controlpath")
        || lower.contains("mux")
}

fn is_control_path_missing_output(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    lower.contains("no such file or directory")
        || lower.contains("no such file")
        || lower.contains("no such socket")
        || lower.contains("connection refused")
        || lower.contains("master is not running")
        || lower.contains("control socket connect")
}

fn is_permission_denied_output(message: &str) -> bool {
    message.to_ascii_lowercase().contains("permission denied")
        && !is_interactive_login_required_output(message)
}

struct CommandOutput {
    status: i32,
    stdout: String,
    stderr: String,
    timed_out: bool,
}

impl CommandOutput {
    fn combined(&self) -> String {
        format!("{}\n{}", self.stdout, self.stderr)
    }
}

#[cfg(test)]
fn validate_settings(settings: &NibiSettings) -> Result<(), String> {
    validate_simple_identifier(&settings.nibi_username, "NIBI username")?;
    validate_host(settings.manual_login_host())?;
    validate_local_path(settings.private_key_path(), "SSH key path")?;
    validate_remote_path(&settings.remote_project_path, "Remote project path")?;
    validate_remote_path(&settings.remote_jobs_path, "Remote jobs path")?;
    validate_remote_path(&settings.python_environment_path, "Python environment path")?;
    Ok(())
}

fn validate_manual_login_settings(settings: &NibiSettings) -> Result<(), String> {
    validate_simple_identifier(&settings.nibi_username, "NIBI username")?;
    validate_host(settings.manual_login_host())?;
    validate_wsl_distro(&settings.manual_mfa_wsl_distro)?;
    Ok(())
}

fn validate_manual_login_start_settings(settings: &NibiSettings) -> Result<(), String> {
    validate_manual_login_settings(settings)?;
    validate_wsl_private_key_path_setting(&settings.wsl_ssh_private_key_path)
}

fn validate_robot_settings(settings: &NibiSettings) -> Result<(), String> {
    validate_simple_identifier(&settings.nibi_username, "NIBI username")?;
    validate_host(settings.robot_host())?;
    validate_local_path(settings.private_key_path(), "SSH key path")?;
    if settings.robot_key_restriction_from.trim().is_empty() {
        return Err("Robot key from= restriction is required.".to_string());
    }
    if settings.robot_key_forced_command.trim().is_empty() {
        return Err("Robot key forced command is required.".to_string());
    }
    Ok(())
}

fn validate_simple_identifier(value: &str, label: &str) -> Result<(), String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(format!("{label} is required."));
    }
    if !trimmed
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || matches!(character, '_' | '-' | '.'))
    {
        return Err(format!("{label} contains unsupported characters."));
    }
    Ok(())
}

fn validate_host(value: &str) -> Result<(), String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err("NIBI host is required.".to_string());
    }
    if !trimmed
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '.'))
    {
        return Err("NIBI host contains unsupported characters.".to_string());
    }
    Ok(())
}

fn validate_job_id(value: &str) -> Result<(), String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err("Job ID is required.".to_string());
    }
    if trimmed.contains("..")
        || !trimmed.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.')
        })
    {
        return Err("Job ID contains unsupported path characters.".to_string());
    }
    Ok(())
}

fn validate_local_path(value: &str, label: &str) -> Result<(), String> {
    if value.trim().is_empty() {
        return Err(format!("{label} is required."));
    }
    if value.trim().to_ascii_lowercase().ends_with(".pub") {
        return Err("Choose the private SSH key file, not the .pub public key.".to_string());
    }
    if value
        .chars()
        .any(|character| character == '\0' || matches!(character, '\r' | '\n'))
    {
        return Err(format!("{label} contains unsupported characters."));
    }
    Ok(())
}

fn validate_local_upload_path(value: &str) -> Result<(), String> {
    let path = Path::new(value.trim());
    if value.trim().is_empty() {
        return Err("Local upload path is required.".to_string());
    }
    if !path.is_absolute() {
        return Err("Local upload path must be absolute.".to_string());
    }
    if !path.exists() {
        return Err("Local upload file does not exist.".to_string());
    }
    Ok(())
}

fn validate_local_download_path(value: &str) -> Result<(), String> {
    let trimmed = value.trim();
    let path = Path::new(trimmed);
    if trimmed.is_empty() {
        return Err("Local download path is required.".to_string());
    }
    if !path.is_absolute() {
        return Err("Local download path must be absolute.".to_string());
    }
    let temp_dir = std::env::temp_dir();
    if !path.starts_with(&temp_dir) {
        return Err("Local download path must be inside the system temp directory.".to_string());
    }
    Ok(())
}

fn validate_remote_path(value: &str, label: &str) -> Result<(), String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(format!("{label} is required."));
    }
    if !trimmed.starts_with('/') {
        return Err(format!("{label} must be an absolute Linux path."));
    }
    if trimmed
        .chars()
        .any(|character| character.is_control() || "'\";&|`$<>\\\t".contains(character))
    {
        return Err(format!("{label} contains unsupported characters."));
    }
    if trimmed.split('/').any(|part| part == "..") {
        return Err(format!("{label} cannot contain path traversal."));
    }
    Ok(())
}

fn validate_remote_path_under_jobs(
    remote_path: &str,
    remote_jobs_path: &str,
) -> Result<(), String> {
    validate_remote_path(remote_path, "Remote path")?;
    validate_remote_path(remote_jobs_path, "Remote jobs path")?;
    let jobs = remote_jobs_path.trim().trim_end_matches('/');
    let path = remote_path.trim();
    if path == jobs || path.starts_with(&format!("{jobs}/")) {
        Ok(())
    } else {
        Err("Remote path must be under the configured remote jobs path.".to_string())
    }
}

fn remote_parent_dir(remote_path: &str) -> Result<String, String> {
    let trimmed = remote_path.trim().trim_end_matches('/');
    let Some((parent, _)) = trimmed.rsplit_once('/') else {
        return Err("Remote path must include a parent directory.".to_string());
    };
    if parent.is_empty() {
        Ok("/".to_string())
    } else {
        Ok(parent.to_string())
    }
}

fn validate_slurm_job_id(value: &str) -> Result<(), String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err("Slurm job ID is required.".to_string());
    }
    if trimmed.chars().any(|character| {
        !(character.is_ascii_alphanumeric() || matches!(character, '_' | '-' | '.'))
    }) {
        return Err("Slurm job ID contains unsupported characters.".to_string());
    }
    Ok(())
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn powershell_single_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn json_string_literal(value: &str) -> String {
    let mut out = String::from("\"");
    for character in value.chars() {
        match character {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            character if character.is_control() => {
                out.push_str(&format!("\\u{:04x}", character as u32));
            }
            character => out.push(character),
        }
    }
    out.push('"');
    out
}

fn default_wsl_key_path() -> String {
    "$HOME/.ssh/fluorcast_nibi_ed25519".to_string()
}

fn default_wsl_distro() -> String {
    "Ubuntu".to_string()
}

fn validate_wsl_distro(value: &str) -> Result<(), String> {
    let distro = wsl_distro_name(value);
    if !distro
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.'))
    {
        return Err("WSL distribution contains unsupported characters.".to_string());
    }
    Ok(())
}

fn validate_wsl_private_key_path_setting(value: &str) -> Result<(), String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err("WSL private key path is required.".to_string());
    }
    if !trimmed.starts_with('/') {
        return Err("WSL private key path must be an absolute POSIX path.".to_string());
    }
    if trimmed.to_ascii_lowercase().ends_with(".pub") {
        return Err("Choose the private SSH key file, not the .pub public key.".to_string());
    }
    if trimmed
        .chars()
        .any(|character| character.is_control() || "\"';&|`$<>\\\t".contains(character))
    {
        return Err("WSL private key path contains unsupported characters.".to_string());
    }
    Ok(())
}

fn wsl_distro_name(distro: &str) -> String {
    let trimmed = distro.trim();
    if trimmed.is_empty() {
        default_wsl_distro()
    } else {
        trimmed.to_string()
    }
}

fn default_manual_mfa_provider() -> String {
    "terminal_action".to_string()
}

fn default_normal_login_host() -> String {
    "nibi.alliancecan.ca".to_string()
}

fn default_robot_login_host() -> String {
    "robot.nibi.alliancecan.ca".to_string()
}

fn now_millis_string() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .to_string()
}

fn new_nonce(prefix: &str) -> String {
    format!("{prefix}_{}", now_millis_string())
}

fn base64_encode(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    let mut index = 0;
    while index < bytes.len() {
        let b0 = bytes[index];
        let b1 = *bytes.get(index + 1).unwrap_or(&0);
        let b2 = *bytes.get(index + 2).unwrap_or(&0);
        out.push(TABLE[(b0 >> 2) as usize] as char);
        out.push(TABLE[(((b0 & 0b0000_0011) << 4) | (b1 >> 4)) as usize] as char);
        if index + 1 < bytes.len() {
            out.push(TABLE[(((b1 & 0b0000_1111) << 2) | (b2 >> 6)) as usize] as char);
        } else {
            out.push('=');
        }
        if index + 2 < bytes.len() {
            out.push(TABLE[(b2 & 0b0011_1111) as usize] as char);
        } else {
            out.push('=');
        }
        index += 3;
    }
    out
}

fn base64_decode(value: &str) -> Result<Vec<u8>, String> {
    fn val(byte: u8) -> Option<u8> {
        match byte {
            b'A'..=b'Z' => Some(byte - b'A'),
            b'a'..=b'z' => Some(byte - b'a' + 26),
            b'0'..=b'9' => Some(byte - b'0' + 52),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    }

    let clean = value.trim().as_bytes();
    if clean.len() % 4 != 0 {
        return Err("Downloaded base64 content has invalid length.".to_string());
    }
    let mut out = Vec::new();
    for chunk in clean.chunks(4) {
        let pad2 = chunk[2] == b'=';
        let pad3 = chunk[3] == b'=';
        let n0 =
            val(chunk[0]).ok_or_else(|| "Downloaded base64 content is invalid.".to_string())?;
        let n1 =
            val(chunk[1]).ok_or_else(|| "Downloaded base64 content is invalid.".to_string())?;
        let n2 = if pad2 {
            0
        } else {
            val(chunk[2]).ok_or_else(|| "Downloaded base64 content is invalid.".to_string())?
        };
        let n3 = if pad3 {
            0
        } else {
            val(chunk[3]).ok_or_else(|| "Downloaded base64 content is invalid.".to_string())?
        };
        out.push((n0 << 2) | (n1 >> 4));
        if !pad2 {
            out.push((n1 << 4) | (n2 >> 2));
        }
        if !pad3 {
            out.push((n2 << 6) | n3);
        }
    }
    Ok(out)
}

fn default_robot_key_restriction_from() -> String {
    "134.153.150.*".to_string()
}

fn default_robot_key_forced_command() -> String {
    "/cvmfs/soft.computecanada.ca/custom/bin/computecanada/allowed_commands/allowed_commands.sh"
        .to_string()
}

fn timestamp_now() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0);
    format!("{seconds}")
}

fn wsl_command_line(distro: &str, host: &str, key: &str) -> String {
    let launcher = "exec \"$HOME/.fluorcast/scripts/start-nibi-login.sh\" \"$@\"";
    if distro.trim().is_empty() {
        format!(
            "wsl.exe -- bash -c {} -- {} {}",
            powershell_single_quote(launcher),
            powershell_single_quote(host),
            powershell_single_quote(key)
        )
    } else {
        format!(
            "wsl.exe -d {} -- bash -c {} -- {} {}",
            powershell_single_quote(distro.trim()),
            powershell_single_quote(launcher),
            powershell_single_quote(host),
            powershell_single_quote(key)
        )
    }
}

fn windows_terminal_command(distro: &str, host: &str, key: &str) -> String {
    let command = if distro.trim().is_empty() {
        format!(
            "wt.exe new-tab --title \"FluorCast NIBI Login\" wsl.exe -- bash -c {} -- {} {}",
            powershell_single_quote("exec \"$HOME/.fluorcast/scripts/start-nibi-login.sh\" \"$@\""),
            powershell_single_quote(host),
            powershell_single_quote(key)
        )
    } else {
        format!(
            "wt.exe new-tab --title \"FluorCast NIBI Login\" wsl.exe -d {} -- bash -c {} -- {} {}",
            powershell_single_quote(distro.trim()),
            powershell_single_quote("exec \"$HOME/.fluorcast/scripts/start-nibi-login.sh\" \"$@\""),
            powershell_single_quote(host),
            powershell_single_quote(key)
        )
    };
    redact_session_command(&command, CANONICAL_WSL_CONTROL_SOCKET_PATH, key)
}

fn powershell_launch_command(distro: &str, host: &str, key: &str) -> String {
    let command = format!(
        "powershell.exe -NoProfile -Command \"Start-Process powershell.exe -ArgumentList '-NoExit', '-Command', '{}'\"",
        wsl_command_line(distro, host, key).replace('\'', "''")
    );
    redact_session_command(&command, CANONICAL_WSL_CONTROL_SOCKET_PATH, key)
}

fn terminal_launch_error_code(message: &str) -> String {
    let lower = message.to_ascii_lowercase();
    if lower.contains("0x80070002") || lower.contains("2147942402") {
        "0x80070002".to_string()
    } else {
        String::new()
    }
}

fn terminal_command_not_found_message(message: &str) -> String {
    if terminal_launch_error_code(message) == "0x80070002" {
        "Windows could not find the terminal command to launch. Use the manual WSL command below."
            .to_string()
    } else {
        "Could not open the login terminal automatically. Open WSL and run:\nbash ~/.fluorcast/scripts/start-nibi-login.sh"
            .to_string()
    }
}

fn wsl_prelude(control_path: &str, key: &str, host: &str) -> String {
    format!(
        "ctl={}\nkey={}\nhost={}",
        wsl_assignment_quote(control_path),
        wsl_assignment_quote(key),
        wsl_assignment_quote(host)
    )
}

fn wsl_assignment_quote(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

fn redact_session_command(command: &str, control_path: &str, key: &str) -> String {
    command
        .replace(control_path, "<wsl_control_socket_path>")
        .replace(key, "<wsl_private_key_path>")
}

fn map_manual_mfa_error(message: &str) -> String {
    let lower = message.to_ascii_lowercase();
    if lower.contains("getsockname failed: not a socket") {
        "Native Windows SSH session reuse failed. Use WSL Manual MFA mode.".to_string()
    } else if is_controlmaster_unsupported_output(message) {
        "Your SSH client may not support reusable ControlMaster sessions on Windows. Use WSL/manual fallback or robot automation.".to_string()
    } else if is_permission_denied_output(message) {
        "Authentication failed. Check username, SSH key, and MFA setup.".to_string()
    } else if lower.contains("0x80070002") || lower.contains("2147942402") {
        "Windows could not find the terminal command to launch. Use the manual WSL command below."
            .to_string()
    } else if lower.contains("code 15")
        || lower.contains("0x0000000f")
        || lower.contains("exit status: 15")
        || lower.contains("signal: 15")
    {
        "The login terminal exited before authentication. The start script may have terminated itself. Try again after cleaning stale session.".to_string()
    } else if lower.contains("broken pipe")
        || lower.contains("mux_client_request_session")
        || lower.contains("control socket connect")
        || lower.contains("connection refused")
        || lower.contains("no such file or directory")
        || lower.contains("no such socket")
        || lower.contains("master is not running")
    {
        "FluorCast did not find the reusable SSH session. Start login from FluorCast and keep the session alive.".to_string()
    } else {
        message.to_string()
    }
}

fn windows_path_to_wsl_mount(path: &str) -> String {
    let trimmed = path.trim().replace('\\', "/");
    let bytes = trimmed.as_bytes();
    if bytes.len() >= 3 && bytes[1] == b':' && bytes[2] == b'/' {
        let drive = (bytes[0] as char).to_ascii_lowercase();
        format!("/mnt/{drive}/{}", &trimmed[3..])
    } else {
        "/mnt/c/Users/<you>/.ssh/id_ed25519".to_string()
    }
}

fn manual_mfa_control_path(settings: &NibiSettings) -> String {
    let _ = settings;
    CANONICAL_WSL_CONTROL_SOCKET_PATH.to_string()
}

fn is_interactive_login_required_output(output: &str) -> bool {
    let lower = output.to_ascii_lowercase();
    lower.contains("password:")
        || output.contains("Password:")
        || lower.contains("duo")
        || lower.contains("passcode")
        || lower.contains("verification")
        || lower.contains("keyboard-interactive")
        || lower.contains("multifactor authentication")
        || output.contains("Permission denied (publickey,keyboard-interactive,hostbased)")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings() -> NibiSettings {
        NibiSettings {
            manual_mfa_provider: "controlmaster".to_string(),
            nibi_username: "alice".to_string(),
            normal_login_host: "nibi.alliancecan.ca".to_string(),
            robot_login_host: "robot.nibi.alliancecan.ca".to_string(),
            robot_key_restriction_from: "134.153.150.*".to_string(),
            robot_key_forced_command: "/cvmfs/soft.computecanada.ca/custom/bin/computecanada/allowed_commands/allowed_commands.sh".to_string(),
            nibi_host: "nibi.alliancecan.ca".to_string(),
            ssh_private_key_path: "C:\\Users\\Alice\\.ssh\\fluorcast_nibi_ed25519".to_string(),
            ssh_key_path: "C:\\Users\\Alice\\.ssh\\fluorcast_nibi_ed25519".to_string(),
            wsl_ssh_private_key_path: "/home/alice/.ssh/fluorcast_nibi_ed25519".to_string(),
            wsl_control_socket_path: "$HOME/.fluorcast/ssh/cm-alice-nibi.sock".to_string(),
            manual_mfa_wsl_distro: "Ubuntu".to_string(),
            remote_project_path: "/home/alice/scratch/FluorCast".to_string(),
            remote_jobs_path: "/home/alice/scratch/fluorcast-jobs".to_string(),
            python_environment_path: "/home/alice/scratch/FluorCast/.venv/bin/python".to_string(),
            manual_ssh_login_confirmed: true,
        }
    }

    #[test]
    fn persistent_shell_wrapper_uses_unique_markers() {
        let wrapped = build_persistent_shell_command("hostname", "abc123");

        assert!(wrapped.contains("__FC_START_abc123__"));
        assert!(wrapped.contains("__FC_EXIT_abc123__:"));
        assert!(wrapped.contains("__FC_END_abc123__"));
        assert!(wrapped.contains("hostname"));
    }

    #[test]
    fn persistent_shell_parser_extracts_stdout_and_exit_code() {
        let parsed = parse_persistent_shell_command_output(
            "\n__FC_START_abc__\nhello\nworld\n__FC_EXIT_abc__:7\n\n__FC_END_abc__\n",
            "abc",
        );

        assert_eq!(parsed.stdout, "hello\nworld");
        assert_eq!(parsed.exit_code, Some(7));
    }

    #[test]
    fn remote_jobs_path_safety_rejects_traversal_and_siblings() {
        assert!(validate_remote_path_under_jobs(
            "/home/alice/scratch/fluorcast-jobs/job-1/input.json",
            "/home/alice/scratch/fluorcast-jobs",
        )
        .is_ok());
        assert!(validate_remote_path_under_jobs(
            "/home/alice/scratch/fluorcast-jobs/../secret.json",
            "/home/alice/scratch/fluorcast-jobs",
        )
        .is_err());
        assert!(validate_remote_path_under_jobs(
            "/home/alice/scratch/other/input.json",
            "/home/alice/scratch/fluorcast-jobs",
        )
        .is_err());
    }

    #[test]
    fn base64_roundtrip_supports_json_text() {
        let text = "{\"job_id\":\"job-1\",\"value\":42}\n";
        let encoded = base64_encode(text.as_bytes());
        let decoded = base64_decode(&encoded).unwrap();

        assert_eq!(String::from_utf8(decoded).unwrap(), text);
    }

    #[test]
    fn builds_ssh_invocation_as_strict_arguments() {
        let invocation = build_ssh_invocation(&settings(), RemoteCommand::Echo);

        assert_eq!(invocation.program, "ssh");
        assert_eq!(
            invocation.args,
            vec![
                "-i",
                "C:\\Users\\Alice\\.ssh\\fluorcast_nibi_ed25519",
                "-o",
                "BatchMode=yes",
                "-o",
                "PasswordAuthentication=no",
                "-o",
                "ConnectTimeout=10",
                "-o",
                "StrictHostKeyChecking=accept-new",
                "--",
                "alice@nibi.alliancecan.ca",
                "echo fluorcast-nibi-ok",
            ]
        );
    }

    #[test]
    fn builds_robot_ssh_invocation_with_robot_host() {
        let invocation = build_robot_ssh_invocation(&settings());

        assert_eq!(invocation.program, "ssh");
        assert_eq!(
            invocation.args,
            vec![
                "-i",
                "C:\\Users\\Alice\\.ssh\\fluorcast_nibi_ed25519",
                "-o",
                "IdentitiesOnly=yes",
                "alice@robot.nibi.alliancecan.ca",
                "echo FLUORCAST_ROBOT_OK",
            ]
        );
        assert!(!invocation
            .args
            .contains(&"alice@nibi.alliancecan.ca".to_string()));
    }

    #[test]
    fn builds_restricted_public_key_without_private_key_text() {
        let restricted = build_restricted_public_key(
            "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakePublic alice@host\n",
            &settings(),
        )
        .unwrap();

        assert_eq!(
            restricted,
            "restrict,from=\"134.153.150.*\",command=\"/cvmfs/soft.computecanada.ca/custom/bin/computecanada/allowed_commands/allowed_commands.sh\" ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakePublic alice@host"
        );
        assert!(!restricted.contains("PRIVATE KEY"));
    }

    #[test]
    fn rejects_private_key_text_for_restricted_public_key() {
        assert_eq!(
            build_restricted_public_key("-----BEGIN OPENSSH PRIVATE KEY-----\nsecret", &settings(),),
            Err("Public key file appears to contain private key text.".to_string())
        );
    }

    #[test]
    fn builds_remote_path_checks_with_quoted_paths() {
        let settings = settings();

        assert_eq!(
            RemoteCommand::ProjectPathExists.to_shell_fragment(&settings),
            "test -d '/home/alice/scratch/FluorCast'"
        );
        assert_eq!(
            RemoteCommand::PredictionScriptExists.to_shell_fragment(&settings),
            "test -f '/home/alice/scratch/FluorCast'/scripts/run_prediction_job.py"
        );
        assert_eq!(
            RemoteCommand::SlurmScriptExists.to_shell_fragment(&settings),
            "test -f '/home/alice/scratch/FluorCast'/slurm/run_prediction_job.sbatch"
        );
        assert_eq!(
            RemoteCommand::JobsPathExistsOrCreate.to_shell_fragment(&settings),
            "test -d '/home/alice/scratch/fluorcast-jobs' || mkdir -p '/home/alice/scratch/fluorcast-jobs'"
        );
        assert_eq!(
            RemoteCommand::PythonEnvironmentExists.to_shell_fragment(&settings),
            "test -e '/home/alice/scratch/FluorCast/.venv/bin/python'"
        );
    }

    #[test]
    fn builds_manual_ssh_command_for_powershell() {
        assert_eq!(
            build_manual_ssh_command(&settings()),
            "ssh -i 'C:\\Users\\Alice\\.ssh\\fluorcast_nibi_ed25519' alice@nibi.alliancecan.ca"
        );
    }

    #[test]
    fn builds_terminal_action_powershell_ssh_command() {
        let paths = TerminalActionPaths {
            action_id: "ssh_123".to_string(),
            work_dir: "C:\\Temp\\fluorcast-terminal-actions\\ssh_123".to_string(),
            command_path: "C:\\Temp\\fluorcast-terminal-actions\\ssh_123\\command.ps1".to_string(),
            stdout_path: "C:\\Temp\\fluorcast-terminal-actions\\ssh_123\\stdout.txt".to_string(),
            stderr_path: "C:\\Temp\\fluorcast-terminal-actions\\ssh_123\\stderr.txt".to_string(),
            exit_code_path: "C:\\Temp\\fluorcast-terminal-actions\\ssh_123\\exit_code.txt"
                .to_string(),
            result_json_path: "C:\\Temp\\fluorcast-terminal-actions\\ssh_123\\result.json"
                .to_string(),
        };
        let script = terminal_ssh_script(
            &settings(),
            "sbatch --parsable '/project/run.sbatch' '/jobs/input.json' '/jobs/output.json'",
            &paths,
        );

        assert!(script.contains("ssh -i 'C:\\Users\\Alice\\.ssh\\fluorcast_nibi_ed25519' -o IdentitiesOnly=yes 'alice@nibi.alliancecan.ca'"));
        assert!(script.contains("'sbatch --parsable ''/project/run.sbatch'' ''/jobs/input.json'' ''/jobs/output.json'''"));
        assert!(script.contains("1> 'C:\\Temp\\fluorcast-terminal-actions\\ssh_123\\stdout.txt'"));
        assert!(script.contains("2> 'C:\\Temp\\fluorcast-terminal-actions\\ssh_123\\stderr.txt'"));
        assert!(script.contains("$LASTEXITCODE"));
        assert!(!script.contains("Read-Host"));
        assert!(!script.to_ascii_lowercase().contains("passcode"));
    }

    #[test]
    fn builds_terminal_action_powershell_scp_command() {
        let paths = TerminalActionPaths {
            action_id: "scp_123".to_string(),
            work_dir: "C:\\Temp\\fluorcast-terminal-actions\\scp_123".to_string(),
            command_path: "C:\\Temp\\fluorcast-terminal-actions\\scp_123\\command.ps1".to_string(),
            stdout_path: "C:\\Temp\\fluorcast-terminal-actions\\scp_123\\stdout.txt".to_string(),
            stderr_path: "C:\\Temp\\fluorcast-terminal-actions\\scp_123\\stderr.txt".to_string(),
            exit_code_path: "C:\\Temp\\fluorcast-terminal-actions\\scp_123\\exit_code.txt"
                .to_string(),
            result_json_path: "C:\\Temp\\fluorcast-terminal-actions\\scp_123\\result.json"
                .to_string(),
        };
        let script = terminal_scp_script(
            &settings(),
            "alice@nibi.alliancecan.ca:/home/alice/scratch/fluorcast-jobs/job-1/output.json",
            "C:\\Temp\\fluorcast-job-1-output.json",
            &paths,
        );

        assert!(script.contains(
            "scp -i 'C:\\Users\\Alice\\.ssh\\fluorcast_nibi_ed25519' -o IdentitiesOnly=yes"
        ));
        assert!(script.contains(
            "'alice@nibi.alliancecan.ca:/home/alice/scratch/fluorcast-jobs/job-1/output.json'"
        ));
        assert!(script.contains("'C:\\Temp\\fluorcast-job-1-output.json'"));
        assert!(script.contains("exit_code.txt"));
    }

    #[test]
    fn builds_manual_mfa_login_command_with_control_master() {
        let commands = build_manual_mfa_session_commands(&settings()).unwrap();

        assert_eq!(commands.backend, "wsl");
        assert_eq!(commands.control_path, "$HOME/.fluorcast/ssh/cm-nibi.sock");
        assert_eq!(
            commands.start_script_path,
            "$HOME/.fluorcast/scripts/start-nibi-login.sh"
        );
        assert!(commands
            .start_script_path
            .starts_with("$HOME/.fluorcast/scripts/"));
        assert!(commands
            .login_command
            .contains("CTL=\"$HOME/.fluorcast/ssh/cm-nibi.sock\""));
        assert!(commands.login_command.contains("HOST=\"$1\""));
        assert!(commands.login_command.contains("KEY=\"$2\""));
        assert!(commands.login_command.contains("[[ \"$KEY\" != /* ]]"));
        assert!(commands.login_command.contains("ssh -fMN"));
        assert!(commands.login_command.contains("-o ControlMaster=yes"));
        assert!(commands.login_command.contains("-o ControlPath=\"$CTL\""));
        assert!(commands.login_command.contains("-o ControlPersist=4h"));
        assert!(commands
            .login_command
            .contains("ssh -S \"$CTL\" -O check \"$HOST\" >/dev/null 2>&1"));
        assert!(commands
            .login_command
            .contains("An active FluorCast NIBI session already exists."));
        assert!(
            commands
                .login_command
                .find("ssh -S \"$CTL\" -O check \"$HOST\"")
                .unwrap()
                < commands.login_command.find("rm -f \"$CTL\"").unwrap()
        );
        assert!(commands
            .login_command
            .contains("read -r -p \"Press Enter to close this window...\""));
        assert!(!commands.login_command.contains("pkill -f"));
        assert!(!commands
            .login_command
            .contains("/home/alice/.ssh/fluorcast_nibi_ed25519"));
        assert!(!commands.login_command.contains("alice@nibi.alliancecan.ca"));
        assert!(commands.windows_terminal_command.contains("wt.exe new-tab"));
        assert!(commands.windows_terminal_command.contains(
            "wsl.exe -d 'Ubuntu' -- bash -c 'exec \"$HOME/.fluorcast/scripts/start-nibi-login.sh\" \"$@\"'"
        ));
        assert!(!commands.windows_terminal_command.contains("ssh -fMN"));
        assert!(!commands
            .windows_terminal_command
            .contains("An active FluorCast NIBI session already exists."));
        assert!(commands
            .powershell_launch_command
            .contains("Start-Process powershell.exe"));
        assert!(commands
            .powershell_launch_command
            .contains("exec \"$HOME/.fluorcast/scripts/start-nibi-login.sh\" \"$@\""));
        assert!(!commands.powershell_launch_command.contains("ssh -fMN"));
        assert!(commands.powershell_launch_command.contains("-NoExit"));
        assert!(!commands
            .redacted_login_command_preview
            .contains("/home/alice/.ssh/fluorcast_nibi_ed25519"));
        assert!(!commands
            .redacted_login_command_preview
            .contains("<wsl_private_key_path>"));
        assert!(!commands
            .windows_terminal_command
            .contains("/home/alice/.ssh/fluorcast_nibi_ed25519"));
        assert!(commands
            .windows_terminal_command
            .contains("<wsl_private_key_path>"));
    }

    #[test]
    fn builds_manual_mfa_check_test_cleanup_and_end_commands() {
        let commands = build_manual_mfa_session_commands(&settings()).unwrap();

        assert!(!commands.clean_script_content.contains("pkill -f"));
        assert_eq!(
            commands.clean_stale_session_command,
            "bash $HOME/.fluorcast/scripts/clean-nibi-session.sh"
        );
        assert!(commands
            .clean_script_content
            .contains("ssh -S \"$CTL\" -O exit \"$HOST\" >/dev/null 2>&1 || true"));
        assert_eq!(
            commands.check_command,
            "wsl.exe -d 'Ubuntu' -- bash -s -- 'alice@nibi.alliancecan.ca'"
        );
        assert!(commands
            .check_script_content
            .contains("ssh -S \"$CTL\" -O check \"$HOST\""));
        assert!(commands.check_script_content.contains("HOST=\"$1\""));
        assert!(commands.check_script_content.contains("CONTROL_PATH=%s"));
        assert!(commands.test_command.contains("-o ControlMaster=no"));
        assert!(commands.test_command.contains("-o BatchMode=yes"));
        assert!(commands
            .test_command
            .contains("-o PasswordAuthentication=no"));
        assert!(commands
            .test_command
            .contains("-o KbdInteractiveAuthentication=no"));
        assert!(commands.test_command.contains("FLUORCAST_AUTH_OK"));
        assert!(!commands.test_command.contains("KEY="));
        assert!(!commands
            .test_command
            .contains("/home/alice/.ssh/fluorcast_nibi_ed25519"));
        assert_eq!(
            commands.end_command,
            "bash $HOME/.fluorcast/scripts/end-nibi-session.sh"
        );
        assert!(commands
            .end_script_content
            .contains("ssh -S \"$CTL\" -O exit \"$HOST\""));
        assert!(commands
            .clean_script_content
            .contains("CLEAN_RESULT=SESSION_REMOVED"));
        assert!(commands.clean_script_content.contains("rm -f \"$CTL\""));
        assert!(!commands.clean_script_content.contains("cm-alice-nibi.sock"));
        assert!(commands
            .background_command_template
            .contains("ControlMaster=no -o BatchMode=yes"));
    }

    #[test]
    fn wsl_bash_invocation_uses_separate_arguments_and_stdin() {
        let invocation = build_wsl_bash_script_invocation(
            "Ubuntu",
            "printf 'one'\r\nprintf 'two'\r",
            &[
                "alice@nibi.alliancecan.ca".to_string(),
                "hostname".to_string(),
            ],
        );

        assert_eq!(invocation.program, "wsl.exe");
        assert_eq!(
            invocation.args,
            vec![
                "-d",
                "Ubuntu",
                "--",
                "bash",
                "-s",
                "--",
                "alice@nibi.alliancecan.ca",
                "hostname",
            ]
        );
        assert_eq!(invocation.stdin, "printf 'one'\nprintf 'two'\n");
        assert!(!invocation
            .args
            .iter()
            .any(|arg| arg.contains("printf 'one'")));
    }

    #[cfg(windows)]
    #[test]
    fn program_runner_keeps_streams_exit_code_and_timeout_distinct() {
        let echo = run_program_with_stdin_timeout(
            "powershell.exe",
            &[
                "-NoProfile".to_string(),
                "-Command".to_string(),
                "$stdinText = [Console]::In.ReadToEnd(); [Console]::Out.Write(\"OUT:\" + $stdinText); [Console]::Error.Write(\"ERR\"); exit 7".to_string(),
            ],
            "script-over-stdin",
            Duration::from_secs(5),
        )
        .unwrap();

        assert_eq!(echo.status, 7);
        assert_eq!(echo.stdout, "OUT:script-over-stdin");
        assert_eq!(echo.stderr, "ERR");
        assert!(!echo.timed_out);

        let timed_out = run_program_with_stdin_timeout(
            "powershell.exe",
            &[
                "-NoProfile".to_string(),
                "-Command".to_string(),
                "Start-Sleep -Seconds 5".to_string(),
            ],
            "",
            Duration::from_millis(100),
        )
        .unwrap();

        assert_eq!(timed_out.status, 124);
        assert!(timed_out.timed_out);
    }

    #[test]
    fn manual_mfa_remote_environment_commands_reuse_wsl_socket() {
        let commands = build_manual_mfa_session_commands(&settings()).unwrap();
        let invocation = build_manual_mfa_remote_command_invocation(&commands, "command -v sacct");

        assert_eq!(invocation.program, "wsl.exe");
        assert_eq!(
            invocation.args[..6],
            [
                "-d".to_string(),
                "Ubuntu".to_string(),
                "--".to_string(),
                "bash".to_string(),
                "-s".to_string(),
                "--".to_string(),
            ]
        );
        assert_eq!(invocation.args[6], "alice@nibi.alliancecan.ca");
        assert_eq!(invocation.args[7], "command -v sacct");
        assert!(invocation
            .stdin
            .contains("CTL=\"$HOME/.fluorcast/ssh/cm-nibi.sock\""));
        assert!(invocation.stdin.contains("-o ControlMaster=no"));
        assert!(invocation.stdin.contains("-o BatchMode=yes"));
        assert!(!invocation.stdin.contains("ssh.exe"));
        assert!(!invocation.stdin.contains("-i \"$KEY\""));
    }

    #[test]
    fn manual_mfa_session_probe_resolves_control_path_inside_wsl() {
        let script = manual_mfa_session_test_script();

        assert!(script.contains("CTL=\"$HOME/.fluorcast/ssh/cm-nibi.sock\""));
        assert!(script.contains("printf 'WSL_USER=%s\\n' \"$(whoami)\""));
        assert!(script.contains("printf 'WSL_HOME=%s\\n' \"$HOME\""));
        assert!(script.contains("printf 'CONTROL_PATH=%s\\n' \"$CTL\""));
        assert!(!script.contains("KEY="));
        assert!(!script.contains("-i \"$KEY\""));
        assert!(script.contains("-o ControlMaster=no"));
        assert!(script.contains("-o BatchMode=yes"));
        assert!(script.contains("-o PasswordAuthentication=no"));
        assert!(script.contains("-o KbdInteractiveAuthentication=no"));
    }

    #[test]
    fn manual_mfa_probe_exit_codes_map_to_specific_statuses() {
        let commands = build_manual_mfa_session_commands(&settings()).unwrap();

        let missing = CommandOutput {
            status: 10,
            stdout: "CONTROL_PATH=/home/alice/.fluorcast/ssh/cm-nibi.sock\nSESSION_ERROR=CONTROL_PATH_MISSING".to_string(),
            stderr: String::new(),
            timed_out: false,
        };
        assert!(matches!(
            classify_manual_mfa_session_probe_output(&commands, &missing).status,
            ManualMfaSessionStatus::SessionNotFound
        ));

        let not_socket = CommandOutput {
            status: 11,
            stdout: "SOCKET_EXISTS=0\nSESSION_ERROR=CONTROL_PATH_NOT_SOCKET".to_string(),
            stderr: String::new(),
            timed_out: false,
        };
        assert!(matches!(
            classify_manual_mfa_session_probe_output(&commands, &not_socket).status,
            ManualMfaSessionStatus::ControlPathNotSocket
        ));

        let stale = CommandOutput {
            status: 12,
            stdout: "SOCKET_EXISTS=1\nSESSION_ERROR=CONTROL_MASTER_CHECK_FAILED".to_string(),
            stderr: String::new(),
            timed_out: false,
        };
        assert!(matches!(
            classify_manual_mfa_session_probe_output(&commands, &stale).status,
            ManualMfaSessionStatus::StaleControlmaster
        ));

        let marker_missing = CommandOutput {
            status: 13,
            stdout: "SOCKET_EXISTS=1\nMASTER_RUNNING=1\nSESSION_ERROR=AUTH_MARKER_MISSING"
                .to_string(),
            stderr: String::new(),
            timed_out: false,
        };
        assert!(matches!(
            classify_manual_mfa_session_probe_output(&commands, &marker_missing).status,
            ManualMfaSessionStatus::AuthMarkerMissing
        ));

        let timeout = CommandOutput {
            status: 124,
            stdout: "SOCKET_EXISTS=1".to_string(),
            stderr: String::new(),
            timed_out: true,
        };
        assert!(matches!(
            classify_manual_mfa_session_probe_output(&commands, &timeout).status,
            ManualMfaSessionStatus::Timeout
        ));
    }

    #[test]
    fn manual_mfa_probe_success_requires_auth_marker() {
        let commands = build_manual_mfa_session_commands(&settings()).unwrap();
        let output = CommandOutput {
            status: 0,
            stdout: "WSL_DISTRO=Ubuntu\nWSL_USER=alice\nWSL_HOME=/home/alice\nCONTROL_PATH=/home/alice/.fluorcast/ssh/cm-nibi.sock\nSOCKET_EXISTS=1\nMASTER_RUNNING=1\nFLUORCAST_AUTH_OK".to_string(),
            stderr: String::new(),
            timed_out: false,
        };
        let result = classify_manual_mfa_session_probe_output(&commands, &output);

        assert!(matches!(
            result.status,
            ManualMfaSessionStatus::Authenticated
        ));
        assert_eq!(
            result.message,
            "Authenticated WSL NIBI session is ready.\nFLUORCAST_AUTH_OK"
        );
        assert_eq!(
            result.control_path,
            "/home/alice/.fluorcast/ssh/cm-nibi.sock"
        );
        assert!(result.can_run_background_commands);
    }

    #[test]
    fn maps_manual_mfa_terminal_code_15_to_friendly_message() {
        assert_eq!(
            map_manual_mfa_error("[process exited with code 15 (0x0000000f)]"),
            "The login terminal exited before authentication. The start script may have terminated itself. Try again after cleaning stale session."
        );
    }

    #[test]
    fn maps_manual_mfa_session_failure_causes() {
        let commands = build_manual_mfa_session_commands(&settings()).unwrap();
        let missing = classify_manual_mfa_session_error(
            &commands,
            "Control socket connect failed: No such file or directory",
            "",
        );
        assert!(matches!(
            missing.status,
            ManualMfaSessionStatus::SessionNotFound
        ));
        assert_eq!(
            missing.message,
            "FluorCast did not find the reusable SSH session. Start login from FluorCast and keep the session alive."
        );

        let reused = classify_manual_mfa_session_error(
            &commands,
            "",
            "alice@nibi.alliancecan.ca's password:",
        );
        assert!(matches!(
            reused.status,
            ManualMfaSessionStatus::SessionNotReused
        ));

        let unsupported = classify_manual_mfa_session_error(
            &commands,
            "",
            "Bad configuration option: controlmaster",
        );
        assert!(matches!(
            unsupported.status,
            ManualMfaSessionStatus::ControlmasterUnsupported
        ));
    }

    #[test]
    fn maps_windows_terminal_command_not_found_to_manual_fallback() {
        assert_eq!(
            map_manual_mfa_error("error 2147942402 (0x80070002)"),
            "Windows could not find the terminal command to launch. Use the manual WSL command below."
        );
    }

    #[test]
    fn maps_manual_mfa_success_to_authenticated() {
        let commands = build_manual_mfa_session_commands(&settings()).unwrap();
        let output = CommandOutput {
            status: 0,
            stdout: "FLUORCAST_AUTH_OK".to_string(),
            stderr: String::new(),
            timed_out: false,
        };

        assert!(matches!(
            classify_manual_mfa_session_output(&commands, &output, &output).status,
            ManualMfaSessionStatus::Authenticated
        ));
    }

    #[test]
    fn parses_password_prompt_as_interactive_login_required() {
        let output = CommandOutput {
            status: 255,
            stdout: String::new(),
            stderr: "alice@nibi.alliancecan.ca's password:".to_string(),
            timed_out: false,
        };

        assert!(matches!(
            classify_command_output(&output, Some("fluorcast-nibi-ok")),
            CheckStatus::InteractiveLoginRequired
        ));
    }

    #[test]
    fn parses_duo_output_as_interactive_login_required() {
        let output = CommandOutput {
            status: 255,
            stdout: "Duo two-factor login for alice".to_string(),
            stderr: String::new(),
            timed_out: false,
        };

        assert!(matches!(
            classify_command_output(&output, Some("fluorcast-nibi-ok")),
            CheckStatus::InteractiveLoginRequired
        ));
    }

    #[test]
    fn parses_mfa_mandatory_output_as_interactive_login_required() {
        let output = CommandOutput {
            status: 255,
            stdout: String::new(),
            stderr: "Multifactor authentication is mandatory. Passcode:".to_string(),
            timed_out: false,
        };

        assert!(matches!(
            classify_command_output(&output, Some("fluorcast-nibi-ok")),
            CheckStatus::InteractiveLoginRequired
        ));
    }

    #[test]
    fn parses_keyboard_interactive_permission_denied_as_interactive_login_required() {
        assert!(is_interactive_login_required_output(
            "Permission denied (publickey,keyboard-interactive,hostbased)."
        ));
    }

    #[test]
    fn maps_robot_password_or_duo_prompt_to_robot_not_ready() {
        let result = classify_robot_automation_output(
            CommandOutput {
                status: 255,
                stdout: "Duo two-factor login for alice".to_string(),
                stderr: String::new(),
                timed_out: false,
            },
            redacted_robot_command_preview(&settings()),
        );

        assert!(matches!(
            result.status,
            RobotAutomationTestStatus::RobotNotReady
        ));
        assert_eq!(result.message, ROBOT_NOT_READY_MESSAGE);
        assert!(!result.robot_access_verified);
    }

    #[test]
    fn skips_remote_environment_checks_until_automation_passes() {
        let skipped = skipped_remote_environment_checks(
            "Skipped because non-interactive SSH automation did not pass.",
        );

        assert_eq!(skipped.len(), 6);
        assert!(skipped
            .iter()
            .all(|check| matches!(check.status, CheckStatus::Skipped)));
        assert_eq!(skipped[0].id, "remote_project_path");
        assert_eq!(skipped[5].id, "python_environment");
    }

    #[test]
    fn rejects_remote_path_shell_metacharacters() {
        let mut settings = settings();
        settings.remote_project_path = "/home/alice/project;rm".to_string();

        assert_eq!(
            validate_settings(&settings),
            Err("Remote project path contains unsupported characters.".to_string())
        );
    }

    #[test]
    fn rejects_public_ssh_key_path() {
        let mut settings = settings();
        settings.ssh_key_path = "C:\\Users\\Alice\\.ssh\\id_ed25519.pub".to_string();
        settings.ssh_private_key_path = "C:\\Users\\Alice\\.ssh\\id_ed25519.pub".to_string();

        assert_eq!(
            validate_settings(&settings),
            Err("Choose the private SSH key file, not the .pub public key.".to_string())
        );
    }

    #[test]
    fn rejects_injected_username() {
        let mut settings = settings();
        settings.nibi_username = "alice@example.com;whoami".to_string();

        assert_eq!(
            validate_settings(&settings),
            Err("NIBI username contains unsupported characters.".to_string())
        );
    }

    #[test]
    fn allows_duplicate_check_sbatch_command_only_for_expected_script() {
        let command = RemoteCommandSpecInput {
            label: "Submit duplicate-check Slurm job".to_string(),
            executable: "sbatch".to_string(),
            args: vec![
                "/home/alice/scratch/FluorCast/slurm/run_duplicate_check_job.sbatch".to_string(),
                "/home/alice/scratch/fluorcast-jobs/duplicate-job-1".to_string(),
            ],
            redacted_preview: None,
        };

        assert_eq!(
            structured_remote_command_to_shell(&command),
            Ok("sbatch '/home/alice/scratch/FluorCast/slurm/run_duplicate_check_job.sbatch' '/home/alice/scratch/fluorcast-jobs/duplicate-job-1'".to_string())
        );
    }

    #[test]
    fn allows_prediction_sbatch_parsable_command() {
        let command = RemoteCommandSpecInput {
            label: "Submit prediction Slurm job".to_string(),
            executable: "sbatch".to_string(),
            args: vec![
                "--parsable".to_string(),
                "--chdir".to_string(),
                "/home/alice/scratch/FluorCast Project".to_string(),
                "--output".to_string(),
                "/home/alice/scratch/fluorcast jobs/job 1/stdout.log".to_string(),
                "--error".to_string(),
                "/home/alice/scratch/fluorcast jobs/job 1/stderr.log".to_string(),
                "/home/alice/scratch/FluorCast/slurm/run_prediction_job.sbatch".to_string(),
                "/home/alice/scratch/fluorcast jobs/job 1/input.json".to_string(),
                "/home/alice/scratch/fluorcast jobs/job 1/output.json".to_string(),
            ],
            redacted_preview: None,
        };

        assert_eq!(
            structured_remote_command_to_shell(&command),
            Ok("sbatch --parsable --chdir='/home/alice/scratch/FluorCast Project' --output='/home/alice/scratch/fluorcast jobs/job 1/stdout.log' --error='/home/alice/scratch/fluorcast jobs/job 1/stderr.log' '/home/alice/scratch/FluorCast/slurm/run_prediction_job.sbatch' '/home/alice/scratch/fluorcast jobs/job 1/input.json' '/home/alice/scratch/fluorcast jobs/job 1/output.json'".to_string())
        );
    }

    #[test]
    fn allows_slurm_cancellation_and_submission_record_commands() {
        let cancel = RemoteCommandSpecInput {
            label: "Cancel Slurm job".to_string(),
            executable: "scancel".to_string(),
            args: vec!["12345".to_string()],
            redacted_preview: None,
        };
        assert_eq!(
            structured_remote_command_to_shell(&cancel),
            Ok("scancel '12345'".to_string())
        );

        let record = RemoteCommandSpecInput {
            label: "Record Slurm submission".to_string(),
            executable: "fluorcast-record-slurm-submission".to_string(),
            args: vec![
                "/home/alice/scratch/fluorcast-jobs/job-1".to_string(),
                "job-1".to_string(),
                "job-1".to_string(),
                "12345".to_string(),
            ],
            redacted_preview: None,
        };
        let command = structured_remote_command_to_shell(&record).expect("record command");
        assert!(command.contains("slurm_job_id.txt"));
        assert!(command.contains("submission.json"));
        assert!(command.contains("status.json"));
        assert!(command.contains("'12345'"));
    }
}
