use std::process::Command as StdCommand;
use std::process::Stdio;
use std::time::{Duration, Instant};
use tokio::io::AsyncWriteExt;
use tokio::process::Command;
use tokio::time::timeout;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
pub const CREATE_NO_WINDOW: u32 = 0x08000000;

#[cfg(not(windows))]
pub const CREATE_NO_WINDOW: u32 = 0;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HiddenCommandOutput {
    pub status: i32,
    pub stdout: String,
    pub stderr: String,
    pub duration_ms: u128,
    pub timed_out: bool,
    pub intentionally_visible: bool,
}

pub fn hidden_command(program: &str) -> Command {
    let mut command = Command::new(program);
    apply_hidden_process_flags(&mut command);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    command
}

pub fn hidden_command_with_stdin(program: &str) -> Command {
    let mut command = Command::new(program);
    apply_hidden_process_flags(&mut command);
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    command
}

pub fn hidden_std_command_with_stdin(program: &str) -> StdCommand {
    let mut command = StdCommand::new(program);
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    command
}

pub fn apply_hidden_process_flags(command: &mut Command) {
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
}

pub async fn run_hidden_command(
    program: &str,
    args: &[String],
    duration: Duration,
) -> Result<HiddenCommandOutput, String> {
    let mut command = hidden_command(program);
    command.args(args);
    wait_for_hidden_output(command, program, duration).await
}

pub async fn run_hidden_command_with_stdin(
    program: &str,
    args: &[String],
    stdin_text: &str,
    duration: Duration,
) -> Result<HiddenCommandOutput, String> {
    let mut command = hidden_command_with_stdin(program);
    command.args(args);
    let started = Instant::now();
    let mut child = command
        .spawn()
        .map_err(|error| format!("Could not start {program}: {error}"))?;

    if let Some(mut stdin) = child.stdin.take() {
        if let Err(error) = stdin.write_all(stdin_text.as_bytes()).await {
            let _ = child.kill().await;
            return Err(format!("Could not write script stdin: {error}"));
        }
    }

    match timeout(duration, child.wait_with_output()).await {
        Ok(Ok(output)) => Ok(HiddenCommandOutput {
            status: output.status.code().unwrap_or(1),
            stdout: String::from_utf8_lossy(&output.stdout).trim().to_string(),
            stderr: String::from_utf8_lossy(&output.stderr).trim().to_string(),
            duration_ms: started.elapsed().as_millis(),
            timed_out: false,
            intentionally_visible: false,
        }),
        Ok(Err(error)) => Err(format!("Could not read {program} output: {error}")),
        Err(_) => Ok(HiddenCommandOutput {
            status: 124,
            stdout: String::new(),
            stderr: format!("{program} timed out after {} seconds.", duration.as_secs()),
            duration_ms: started.elapsed().as_millis(),
            timed_out: true,
            intentionally_visible: false,
        }),
    }
}

async fn wait_for_hidden_output(
    mut command: Command,
    program: &str,
    duration: Duration,
) -> Result<HiddenCommandOutput, String> {
    let started = Instant::now();
    let child = command
        .spawn()
        .map_err(|error| format!("Could not start {program}: {error}"))?;
    match timeout(duration, child.wait_with_output()).await {
        Ok(Ok(output)) => Ok(HiddenCommandOutput {
            status: output.status.code().unwrap_or(1),
            stdout: String::from_utf8_lossy(&output.stdout).trim().to_string(),
            stderr: String::from_utf8_lossy(&output.stderr).trim().to_string(),
            duration_ms: started.elapsed().as_millis(),
            timed_out: false,
            intentionally_visible: false,
        }),
        Ok(Err(error)) => Err(format!("Could not read {program} output: {error}")),
        Err(_) => Ok(HiddenCommandOutput {
            status: 124,
            stdout: String::new(),
            stderr: format!("{program} timed out after {} seconds.", duration.as_secs()),
            duration_ms: started.elapsed().as_millis(),
            timed_out: true,
            intentionally_visible: false,
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn create_no_window_has_expected_windows_value() {
        assert_eq!(CREATE_NO_WINDOW, if cfg!(windows) { 0x08000000 } else { 0 });
    }

    #[test]
    fn hidden_builders_are_the_documented_background_entry_points() {
        let _ = hidden_command("where.exe");
        let _ = hidden_command_with_stdin("wsl.exe");
    }
}
