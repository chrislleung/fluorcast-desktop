use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

const SSH_TIMEOUT: Duration = Duration::from_secs(20);
const MANUAL_MFA_OK: &str = "FLUORCAST_AUTH_OK";

#[derive(Debug, Deserialize)]
pub struct NibiSettings {
    nibi_username: String,
    nibi_host: String,
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
    selected_backend: &'static str,
    wsl_available: bool,
    wsl_ssh_available: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ManualMfaSessionStatus {
    Authenticated,
    AuthenticationRequired,
    Disconnected,
    Failed,
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
    validate_manual_login_settings(&settings)?;
    let commands = build_manual_mfa_session_commands(&settings)?;
    Ok(launch_manual_mfa_terminal(commands))
}

#[tauri::command]
pub fn clean_stale_manual_mfa_session(
    settings: NibiSettings,
) -> Result<ManualMfaSessionResult, String> {
    validate_manual_login_settings(&settings)?;
    let commands = build_manual_mfa_session_commands(&settings)?;
    if let Err(message) = write_manual_mfa_scripts(&commands) {
        return Ok(ManualMfaSessionResult {
            status: ManualMfaSessionStatus::Failed,
            message,
            control_path: commands.control_path.clone(),
            control_path_exists: false,
            redacted_command_preview: commands.redacted_login_command_preview.clone(),
            can_run_background_commands: false,
            last_master_check_result: String::new(),
            last_auth_ok_result: String::new(),
            selected_backend: "wsl",
            wsl_available: wsl_available(),
            wsl_ssh_available: wsl_ssh_available(),
        });
    }
    match run_wsl_script(&commands.clean_stale_session_command) {
        Ok(output) => Ok(ManualMfaSessionResult {
            status: ManualMfaSessionStatus::Disconnected,
            message: "Stale WSL NIBI session cleaned.".to_string(),
            control_path: commands.control_path.clone(),
            control_path_exists: false,
            redacted_command_preview: redact_session_command(
                &commands.clean_stale_session_command,
                &commands.control_path,
                &commands.wsl_key_path,
            ),
            can_run_background_commands: false,
            last_master_check_result: output.combined(),
            last_auth_ok_result: String::new(),
            selected_backend: "wsl",
            wsl_available: wsl_available(),
            wsl_ssh_available: wsl_ssh_available(),
        }),
        Err(message) => Ok(ManualMfaSessionResult {
            status: ManualMfaSessionStatus::Failed,
            message,
            control_path: commands.control_path.clone(),
            control_path_exists: false,
            redacted_command_preview: redact_session_command(
                &commands.clean_stale_session_command,
                &commands.control_path,
                &commands.wsl_key_path,
            ),
            can_run_background_commands: false,
            last_master_check_result: String::new(),
            last_auth_ok_result: String::new(),
            selected_backend: "wsl",
            wsl_available: wsl_available(),
            wsl_ssh_available: wsl_ssh_available(),
        }),
    }
}

#[tauri::command]
pub fn test_manual_mfa_session(settings: NibiSettings) -> Result<ManualMfaSessionResult, String> {
    validate_manual_login_settings(&settings)?;
    let commands = build_manual_mfa_session_commands(&settings)?;
    if let Err(message) = write_manual_mfa_scripts(&commands) {
        return Ok(ManualMfaSessionResult {
            status: ManualMfaSessionStatus::Failed,
            message,
            control_path: commands.control_path.clone(),
            control_path_exists: false,
            redacted_command_preview: commands.redacted_test_command_preview.clone(),
            can_run_background_commands: false,
            last_master_check_result: String::new(),
            last_auth_ok_result: String::new(),
            selected_backend: "wsl",
            wsl_available: wsl_available(),
            wsl_ssh_available: wsl_ssh_available(),
        });
    }
    match run_wsl_script(&commands.check_command) {
        Ok(check_output) => match run_wsl_script(&commands.test_command) {
            Ok(auth_output) => Ok(classify_manual_mfa_session_output(
                &commands,
                &check_output,
                &auth_output,
            )),
            Err(message) => Ok(classify_manual_mfa_session_error(
                &commands,
                &check_output.combined(),
                &message,
            )),
        },
        Err(message) => Ok(classify_manual_mfa_session_error(&commands, &message, "")),
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
            validate_host(&settings.nibi_host),
        ),
        local_check(
            "local_private_key_exists",
            "Private key path exists",
            validate_local_path(&settings.ssh_key_path, "SSH key path").and_then(|_| {
                if Path::new(settings.ssh_key_path.trim()).is_file() {
                    Ok(())
                } else {
                    Err("Private SSH key file was not found at this path.".to_string())
                }
            }),
        ),
        local_check(
            "local_private_key_not_public",
            "Key path is not .pub",
            if settings
                .ssh_key_path
                .trim()
                .to_ascii_lowercase()
                .ends_with(".pub")
            {
                Err("Choose the private SSH key file, not the .pub public key.".to_string())
            } else {
                Ok(())
            },
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
        NibiConnectionCheck {
            id: "manual_login_confirmed",
            label: "Manual SSH login works in PowerShell",
            status: if settings.manual_ssh_login_confirmed {
                CheckStatus::Passed
            } else {
                CheckStatus::Skipped
            },
            message: if settings.manual_ssh_login_confirmed {
                "You marked manual PowerShell login as working.".to_string()
            } else {
                "Use the manual SSH command below, complete password/Duo if prompted, then check the confirmation box.".to_string()
            },
        },
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
            settings.ssh_key_path.clone(),
            "-o".to_string(),
            "BatchMode=yes".to_string(),
            "-o".to_string(),
            "PasswordAuthentication=no".to_string(),
            "-o".to_string(),
            "ConnectTimeout=10".to_string(),
            "-o".to_string(),
            "StrictHostKeyChecking=accept-new".to_string(),
            "--".to_string(),
            format!("{}@{}", settings.nibi_username, settings.nibi_host),
            remote_command.to_shell_fragment(settings),
        ],
    }
}

fn build_manual_ssh_command(settings: &NibiSettings) -> String {
    format!(
        "ssh -i {} {}@{}",
        powershell_single_quote(settings.ssh_key_path.trim()),
        settings.nibi_username.trim(),
        settings.nibi_host.trim()
    )
}

fn build_manual_mfa_session_commands(
    settings: &NibiSettings,
) -> Result<ManualMfaSessionCommands, String> {
    let control_path = manual_mfa_control_path(settings);
    let target = format!(
        "{}@{}",
        settings.nibi_username.trim(),
        settings.nibi_host.trim()
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
        .unwrap_or("cm-user-nibi.sock")
        .to_string();
    let prelude = wsl_prelude(&control_path, &key, &target);
    let script_dir = "$HOME/.fluorcast/scripts".to_string();
    let start_script_path = "$HOME/.fluorcast/scripts/start-nibi-login.sh".to_string();
    let check_script_path = "$HOME/.fluorcast/scripts/check-nibi-session.sh".to_string();
    let end_script_path = "$HOME/.fluorcast/scripts/end-nibi-session.sh".to_string();
    let clean_script_path = "$HOME/.fluorcast/scripts/clean-nibi-session.sh".to_string();
    let manual_wsl_login_command = format!("bash {start_script_path}");
    let setup = format!(
        "mkdir -p ~/.ssh ~/.fluorcast/ssh\ncp {} ~/.ssh/fluorcast_nibi_ed25519\nchmod 600 ~/.ssh/fluorcast_nibi_ed25519",
        shell_quote(&windows_path_to_wsl_mount(settings.ssh_key_path.trim()))
    );
    let clean = format!(
        "#!/usr/bin/env bash\nset -u\n\n{prelude}\n\nssh -S \"$ctl\" -O exit \"$host\" 2>/dev/null || true\nrm -f \"$ctl\"\nmkdir -p \"$HOME/.fluorcast/ssh\""
    );
    let login = format!(
        "#!/usr/bin/env bash\nset -u\n\n{prelude}\n\nmkdir -p \"$HOME/.fluorcast/ssh\"\n\nif ssh -S \"$ctl\" -O check \"$host\" >/dev/null 2>&1; then\n  echo \"An active FluorCast NIBI session already exists.\"\nelse\n  rm -f \"$ctl\"\n  ssh -fMN \\\n    -S \"$ctl\" \\\n    -i \"$key\" \\\n    -o IdentitiesOnly=yes \\\n    -o ControlPersist=4h \\\n    -o ServerAliveInterval=60 \\\n    -o ServerAliveCountMax=3 \\\n    \"$host\"\nfi\n\necho\necho \"Checking FluorCast NIBI session...\"\nssh -S \"$ctl\" -O check \"$host\" || true\necho\necho \"Return to FluorCast and click Test authenticated session.\"\nread -r -p \"Press Enter to close this window...\""
    );
    let check_script =
        format!("#!/usr/bin/env bash\nset -u\n\n{prelude}\n\nssh -S \"$ctl\" -O check \"$host\"");
    let end_script =
        format!("#!/usr/bin/env bash\nset -u\n\n{prelude}\n\nssh -S \"$ctl\" -O exit \"$host\"");
    let check = format!("bash {check_script_path}");
    let test =
        format!("{prelude}\nssh -S \"$ctl\" -o BatchMode=yes \"$host\" \"echo {MANUAL_MFA_OK}\"");
    let end = format!("bash {end_script_path}");
    let background =
        format!("{prelude}\nssh -S \"$ctl\" -o BatchMode=yes \"$host\" \"<remote command>\"");

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
        host: target,
        wsl_setup_key_commands: setup,
        clean_stale_session_command: format!("bash {clean_script_path}"),
        windows_terminal_command: windows_terminal_command(&start_script_path, &distro),
        powershell_launch_command: powershell_launch_command(&start_script_path, &distro),
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

fn run_wsl_script(script: &str) -> Result<CommandOutput, String> {
    let output = Command::new("wsl.exe")
        .args(["-e", "bash", "-lc", script])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|error| format!("Could not start WSL: {error}"))?;
    let result = CommandOutput {
        status: output.status.code().unwrap_or(1),
        stdout: String::from_utf8_lossy(&output.stdout).trim().to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).trim().to_string(),
    };
    if result.status == 0 {
        Ok(result)
    } else {
        Err(result.combined())
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
    let script = format!(
        "mkdir -p \"$HOME/.fluorcast/scripts\" && cat > {} && chmod +x {}",
        wsl_assignment_quote(path),
        wsl_assignment_quote(path)
    );
    let mut command = Command::new("wsl.exe");
    if !distro.trim().is_empty() {
        command.args(["-d", distro.trim()]);
    }
    let mut child = command
        .args(["--", "bash", "-lc", &script])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| {
            format!(
                "{} {}",
                terminal_command_not_found_message(&error.to_string()),
                "Could not write WSL Manual MFA scripts."
            )
        })?;
    if let Some(stdin) = child.stdin.as_mut() {
        stdin
            .write_all(content.as_bytes())
            .map_err(|error| format!("Could not send WSL script content: {error}"))?;
    }
    let output = child
        .wait_with_output()
        .map_err(|error| format!("Could not finish writing WSL script: {error}"))?;
    if output.status.success() {
        Ok(())
    } else {
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(format!(
            "Could not write WSL script {path}.\n{}\n{}",
            stdout, stderr
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
            "-lc".to_string(),
            commands.manual_wsl_login_command.clone(),
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
                &commands.start_script_path,
                &commands.wsl_distro
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
    if distro.trim().is_empty() {
        return true;
    }
    Command::new("wsl.exe")
        .args(["-d", distro.trim(), "--", "bash", "-lc", "echo ok"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

fn wsl_available() -> bool {
    Command::new("wsl.exe")
        .args(["-e", "bash", "-lc", "echo ok"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

fn wsl_ssh_available() -> bool {
    Command::new("wsl.exe")
        .args(["-e", "bash", "-lc", "command -v ssh >/dev/null 2>&1"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

fn wsl_path_exists(path: &str) -> bool {
    Command::new("wsl.exe")
        .args([
            "-e",
            "bash",
            "-lc",
            &format!(
                "test -S {} || test -e {}",
                shell_quote(path),
                shell_quote(path)
            ),
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
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
            selected_backend: "wsl",
            wsl_available: wsl_available(),
            wsl_ssh_available: wsl_ssh_available(),
        }
    } else if is_interactive_login_required_output(&combined) {
        ManualMfaSessionResult {
            status: ManualMfaSessionStatus::AuthenticationRequired,
            message: "NIBI still requested password/Duo, so the app cannot run background commands yet. Start manual login again.".to_string(),
            control_path: commands.control_path.clone(),
            control_path_exists,
            redacted_command_preview: commands.redacted_test_command_preview.clone(),
            can_run_background_commands: false,
            last_master_check_result: check_output.combined(),
            last_auth_ok_result: combined,
            selected_backend: "wsl",
            wsl_available: wsl_available(),
            wsl_ssh_available: wsl_ssh_available(),
        }
    } else if !control_path_exists {
        ManualMfaSessionResult {
            status: ManualMfaSessionStatus::Disconnected,
            message: "The SSH control session was not found or expired. Start manual login again."
                .to_string(),
            control_path: commands.control_path.clone(),
            control_path_exists,
            redacted_command_preview: commands.redacted_test_command_preview.clone(),
            can_run_background_commands: false,
            last_master_check_result: check_output.combined(),
            last_auth_ok_result: combined,
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
    if is_interactive_login_required_output(message) {
        ManualMfaSessionResult {
            status: ManualMfaSessionStatus::AuthenticationRequired,
            message: "NIBI still requested password/Duo, so the app cannot run background commands yet. Start manual login again.".to_string(),
            control_path: commands.control_path.clone(),
            control_path_exists,
            redacted_command_preview: commands.redacted_test_command_preview.clone(),
            can_run_background_commands: false,
            last_master_check_result: check_message.to_string(),
            last_auth_ok_result: auth_message.to_string(),
            selected_backend: "wsl",
            wsl_available: wsl_available(),
            wsl_ssh_available: wsl_ssh_available(),
        }
    } else {
        ManualMfaSessionResult {
            status: ManualMfaSessionStatus::Disconnected,
            message: map_manual_mfa_error(message),
            control_path: commands.control_path.clone(),
            control_path_exists,
            redacted_command_preview: commands.redacted_test_command_preview.clone(),
            can_run_background_commands: false,
            last_master_check_result: check_message.to_string(),
            last_auth_ok_result: auth_message.to_string(),
            selected_backend: "wsl",
            wsl_available: wsl_available(),
            wsl_ssh_available: wsl_ssh_available(),
        }
    }
}

struct CommandOutput {
    status: i32,
    stdout: String,
    stderr: String,
}

impl CommandOutput {
    fn combined(&self) -> String {
        format!("{}\n{}", self.stdout, self.stderr)
    }
}

#[cfg(test)]
fn validate_settings(settings: &NibiSettings) -> Result<(), String> {
    validate_simple_identifier(&settings.nibi_username, "NIBI username")?;
    validate_host(&settings.nibi_host)?;
    validate_local_path(&settings.ssh_key_path, "SSH key path")?;
    validate_remote_path(&settings.remote_project_path, "Remote project path")?;
    validate_remote_path(&settings.remote_jobs_path, "Remote jobs path")?;
    validate_remote_path(&settings.python_environment_path, "Python environment path")?;
    Ok(())
}

fn validate_manual_login_settings(settings: &NibiSettings) -> Result<(), String> {
    validate_simple_identifier(&settings.nibi_username, "NIBI username")?;
    validate_host(&settings.nibi_host)?;
    validate_local_path(&settings.ssh_key_path, "SSH key path")?;
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
        .any(|character| character.is_control() || "'\";&|`$<>\\ \t".contains(character))
    {
        return Err(format!("{label} contains unsupported characters."));
    }
    Ok(())
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn powershell_single_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn default_wsl_key_path() -> String {
    "$HOME/.ssh/fluorcast_nibi_ed25519".to_string()
}

fn default_wsl_distro() -> String {
    "Ubuntu".to_string()
}

fn timestamp_now() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0);
    format!("{seconds}")
}

fn wsl_command_line(script_path: &str, distro: &str) -> String {
    let bash_command = format!("bash {script_path}");
    if distro.trim().is_empty() {
        format!(
            "wsl.exe -- bash -lc {}",
            powershell_single_quote(&bash_command)
        )
    } else {
        format!(
            "wsl.exe -d {} -- bash -lc {}",
            powershell_single_quote(distro.trim()),
            powershell_single_quote(&bash_command)
        )
    }
}

fn windows_terminal_command(script_path: &str, distro: &str) -> String {
    let bash_command = format!("bash {script_path}");
    if distro.trim().is_empty() {
        format!(
            "wt.exe new-tab --title \"FluorCast NIBI Login\" wsl.exe -- bash -lc {}",
            powershell_single_quote(&bash_command)
        )
    } else {
        format!(
            "wt.exe new-tab --title \"FluorCast NIBI Login\" wsl.exe -d {} -- bash -lc {}",
            powershell_single_quote(distro.trim()),
            powershell_single_quote(&bash_command)
        )
    }
}

fn powershell_launch_command(script_path: &str, distro: &str) -> String {
    format!(
        "powershell.exe -NoProfile -Command \"Start-Process powershell.exe -ArgumentList '-NoExit', '-Command', '{}'\"",
        wsl_command_line(script_path, distro).replace('\'', "''")
    )
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
        || lower.contains("master is not running")
    {
        "The NIBI login session is not active. Start manual login again.".to_string()
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
    if !settings.wsl_control_socket_path.trim().is_empty() {
        return settings.wsl_control_socket_path.trim().to_string();
    }
    format!(
        "$HOME/.fluorcast/ssh/cm-{}-{}.sock",
        safe_control_path_part(settings.nibi_username.trim()),
        safe_control_path_part(
            settings
                .nibi_host
                .trim()
                .split('.')
                .next()
                .unwrap_or("nibi")
        )
    )
}

fn safe_control_path_part(value: &str) -> String {
    let safe = value
        .chars()
        .filter(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
        .collect::<String>();
    if safe.is_empty() {
        "nibi".to_string()
    } else {
        safe
    }
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
            nibi_username: "alice".to_string(),
            nibi_host: "nibi.alliancecan.ca".to_string(),
            ssh_key_path: "C:\\Users\\Alice\\.ssh\\fluorcast_nibi_ed25519".to_string(),
            wsl_ssh_private_key_path: "$HOME/.ssh/fluorcast_nibi_ed25519".to_string(),
            wsl_control_socket_path: "$HOME/.fluorcast/ssh/cm-alice-nibi.sock".to_string(),
            manual_mfa_wsl_distro: "Ubuntu".to_string(),
            remote_project_path: "/home/alice/scratch/FluorCast".to_string(),
            remote_jobs_path: "/home/alice/scratch/fluorcast-jobs".to_string(),
            python_environment_path: "/home/alice/scratch/FluorCast/.venv/bin/python".to_string(),
            manual_ssh_login_confirmed: true,
        }
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
    fn builds_manual_mfa_login_command_with_control_master() {
        let commands = build_manual_mfa_session_commands(&settings()).unwrap();

        assert_eq!(commands.backend, "wsl");
        assert_eq!(
            commands.start_script_path,
            "$HOME/.fluorcast/scripts/start-nibi-login.sh"
        );
        assert!(commands
            .start_script_path
            .starts_with("$HOME/.fluorcast/scripts/"));
        assert!(commands
            .login_command
            .contains("ctl=\"$HOME/.fluorcast/ssh/cm-alice-nibi.sock\""));
        assert!(commands
            .login_command
            .contains("key=\"$HOME/.ssh/fluorcast_nibi_ed25519\""));
        assert!(commands.login_command.contains("ssh -fMN"));
        assert!(commands.login_command.contains("-o ControlPersist=4h"));
        assert!(commands
            .login_command
            .contains("host=\"alice@nibi.alliancecan.ca\""));
        assert!(commands
            .login_command
            .contains("ssh -S \"$ctl\" -O check \"$host\" >/dev/null 2>&1"));
        assert!(commands
            .login_command
            .contains("An active FluorCast NIBI session already exists."));
        assert!(
            commands
                .login_command
                .find("ssh -S \"$ctl\" -O check \"$host\"")
                .unwrap()
                < commands.login_command.find("rm -f \"$ctl\"").unwrap()
        );
        assert!(commands
            .login_command
            .contains("read -r -p \"Press Enter to close this window...\""));
        assert!(!commands.login_command.contains("pkill -f"));
        assert!(commands.windows_terminal_command.contains("wt.exe new-tab"));
        assert!(commands.windows_terminal_command.contains(
            "wsl.exe -d 'Ubuntu' -- bash -lc 'bash $HOME/.fluorcast/scripts/start-nibi-login.sh'"
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
            .contains("bash $HOME/.fluorcast/scripts/start-nibi-login.sh"));
        assert!(!commands.powershell_launch_command.contains("ssh -fMN"));
        assert!(commands.powershell_launch_command.contains("-NoExit"));
        assert!(!commands
            .redacted_login_command_preview
            .contains("$HOME/.ssh/fluorcast_nibi_ed25519"));
        assert!(commands
            .redacted_login_command_preview
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
            .contains("ssh -S \"$ctl\" -O exit \"$host\" 2>/dev/null || true"));
        assert_eq!(
            commands.check_command,
            "bash $HOME/.fluorcast/scripts/check-nibi-session.sh"
        );
        assert!(commands
            .check_script_content
            .contains("ssh -S \"$ctl\" -O check \"$host\""));
        assert!(commands
            .test_command
            .contains("ssh -S \"$ctl\" -o BatchMode=yes \"$host\" \"echo FLUORCAST_AUTH_OK\""));
        assert_eq!(
            commands.end_command,
            "bash $HOME/.fluorcast/scripts/end-nibi-session.sh"
        );
        assert!(commands
            .end_script_content
            .contains("ssh -S \"$ctl\" -O exit \"$host\""));
        assert!(commands
            .background_command_template
            .contains("-o BatchMode=yes"));
    }

    #[test]
    fn maps_manual_mfa_terminal_code_15_to_friendly_message() {
        assert_eq!(
            map_manual_mfa_error("[process exited with code 15 (0x0000000f)]"),
            "The login terminal exited before authentication. The start script may have terminated itself. Try again after cleaning stale session."
        );
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
}
