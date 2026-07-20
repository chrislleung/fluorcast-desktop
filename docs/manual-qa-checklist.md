# Manual QA Checklist

Use `npm.cmd run tauri dev` for these checks unless a step explicitly says otherwise. The browser preview from `npm.cmd run dev` is only for frontend preview and does not exercise the real desktop shell.

## Mock Prediction

- Start the desktop app with `npm.cmd run tauri dev`.
- Open Settings.
- Select Mock mode.
- Save settings.
- Go to New Prediction.
- Enter a valid molecule and solvent.
- Submit the mock prediction.
- Confirm the job appears in Jobs.
- Wait for the job to complete.
- Open the completed result.
- Confirm predicted values and status are visible.
- Refresh the page.
- Confirm the result still appears.

## Manual MFA Terminal-Action Mode

- Open Settings.
- Select Manual MFA mode.
- Confirm the provider is `terminal_action`.
- Confirm the host is `nibi.alliancecan.ca`.
- Confirm the private SSH key path points to a private key file, not a `.pub` file.
- Confirm the UI says each NIBI action runs in a visible PowerShell window.
- Confirm the UI says FluorCast does not store passwords or Duo codes.
- Upload a real or mock-safe prediction input to NIBI.
- Confirm the job reaches `uploaded_to_nibi`.
- Open Jobs.
- Click Submit to Slurm.
- Complete password and Duo/MFA in the PowerShell window.
- Return to FluorCast after PowerShell finishes.
- Confirm the Slurm job ID appears.
- Verify on NIBI with `squeue -u <username>`.
- Click Refresh status.
- Complete password and Duo/MFA in PowerShell if prompted.
- Confirm status updates to queued, running, completed, failed, cancelled, or timeout.
- When output is ready, click Download result.
- Complete password and Duo/MFA in PowerShell if prompted.
- Confirm FluorCast validates `output.json`, saves the result, marks the job completed, and opens the result.

## Remote Environment Checks

- Start the desktop app with `npm.cmd run tauri dev`.
- Open Settings.
- Choose Manual MFA mode.
- Confirm terminal-action mode is selected, or use robot automation.
- Remote Environment Checks are collapsed by default. Expand the section after logging into NIBI or verifying robot automation.
- Run Remote Environment Checks.
- Confirm the remote project path check passes.
- Confirm the remote jobs path exists or can be created.
- Confirm the Python environment path passes.
- Confirm the prediction script check passes.
- Confirm the Slurm script check passes.
- Confirm `sbatch` and `squeue` pass.
- Note that `sacct` may be optional; if unavailable, confirm the UI says polling may fall back to `squeue` or output-file checks.
- Do not proceed to upload or submission until all required checks pass.

## Upload and Slurm Submission

- Start the app with `npm.cmd run tauri dev`.
- Choose Manual MFA mode.
- Confirm the provider is `terminal_action`.
- Submit prediction.
- Confirm the job reaches `uploaded_to_nibi`.
- Open Jobs and click Submit to Slurm.
- Complete password and Duo/MFA in the PowerShell window.
- Return to FluorCast after PowerShell finishes.
- Confirm the job reaches `submitted_to_slurm`.
- Confirm the Slurm job ID appears.
- Verify on NIBI with `squeue -u <username>`.
- If submission fails, use Retry Slurm submission.

## Manual MFA Legacy Reconnect From Jobs Page

- Start app with `npm.cmd run tauri dev`.
- Choose Manual MFA mode.
- Start manual NIBI login from Settings.
- Complete password + Duo.
- Test authenticated session.
- Submit prediction until uploaded/submitted.
- Close or expire the session if possible.
- Open Jobs.
- Confirm reconnect panel appears.
- Click Start manual NIBI login or Test app session.
- Confirm job can continue without creating duplicate job.

## Manual MFA Session Reuse Debug

- Start app with `npm.cmd run tauri dev`.
- Open Settings -> Manual MFA login.
- Copy the app-generated login command.
- Confirm it includes `ControlMaster`, `ControlPath`, and `ControlPersist`.
- Click Start manual NIBI login.
- Complete password and Duo.
- Keep terminal open.
- Click Test authenticated session.
- If it fails, copy session test command and run it manually.
- Open diagnostics and inspect stdout/stderr.
- Confirm the app shows a specific cause, not a vague reconnect message.

## Manual MFA Upload, Submission, Poll, Download

- With Manual MFA terminal-action mode selected, upload input.json.
- Open Jobs and click Submit to Slurm.
- Complete password and Duo/MFA in PowerShell.
- Submit a real prediction.
- Confirm input files upload to the configured remote jobs path.
- Confirm the Slurm submission step returns a job id.
- Click Refresh status and complete password/Duo if prompted.
- Confirm polling shows queued or running status.
- Wait for completion.
- Click Download result and complete password/Duo if prompted.
- Confirm FluorCast downloads and validates the result file.
- Open the completed result.
- Confirm the result data is readable and associated with the correct molecule and solvent.

## Session Expired And Reconnect

- Start in Manual MFA mode with a previously authenticated session.
- End the session from FluorCast, wait for it to expire, or clean the stale WSL session.
- Try an operation that requires NIBI access.
- Confirm FluorCast blocks background work instead of asking for or storing a password.
- Confirm the UI asks the user to reconnect.
- Start manual NIBI login again.
- Complete password and Duo/MFA in the terminal.
- Test the authenticated session.
- Retry the blocked workflow and confirm it proceeds.

## Robot Automation Setup

- Open Settings.
- Select Robot automation mode.
- Confirm the host is `robot.nibi.alliancecan.ca`.
- Confirm the private SSH key path points to a private key file, not a `.pub` file.
- Generate the restricted public key.
- Confirm the generated key begins with the configured restrictions and contains public key text.
- Confirm the UI warns not to upload or paste a private key.
- Confirm the UI warns that robot mode may require an approved network or VPN.
- Confirm the UI states that Alliance support must enable robot access.
- Copy the Alliance support request.
- Confirm the request includes username, robot host, app actions, forced command, and network restriction context.

## Robot Automation Test

- Confirm Alliance support has approved robot access.
- Confirm the restricted public key has been uploaded to CCDB.
- Connect to the approved network or VPN if required.
- Select Robot automation mode.
- Click Test robot automation.
- Confirm the test returns `FLUORCAST_ROBOT_OK`.
- Confirm robot access is marked verified.
- If the test asks for password, Duo, passcode, verification, or keyboard-interactive authentication, confirm FluorCast reports robot automation is not ready.

## Robot Upload, Submission, Poll, Download

- With Robot automation mode selected, submit a real prediction.
- Confirm no password or Duo prompt appears.
- Confirm input files upload to the configured remote jobs path.
- Confirm Slurm submission returns a job id.
- Confirm polling updates queued, running, or completed status.
- Confirm completed output files download automatically.
- Open the completed result.
- Confirm the result data is readable and associated with the correct molecule and solvent.

## Export Result

- Open a completed prediction result from either Mock, Manual MFA, or Robot automation mode.
- Export the result.
- Confirm the exported file is created at the selected location.
- Open the exported file.
- Confirm molecule, solvent, prediction values, job id, status, and timestamps are present where expected.

## SQLite Refresh Persistence

- Start the desktop app with `npm.cmd run tauri dev`.
- Submit a mock prediction from the New Prediction page.
- Wait for the job to complete.
- Open the completed result.
- Refresh the page while viewing the result.
- Confirm the prediction result still appears.
- Go to the Jobs page.
- Open the completed job.
- Confirm the prediction result still appears.
- If a completed job has no saved result row, confirm the app shows: "This job is marked completed, but no saved result was found."

## SQLite Persistence Debug Test

- Run `npm.cmd run tauri dev`.
- Open Diagnostics.
- Click Refresh diagnostics.
- Click Create mock persistence probe.
- Confirm jobs count increased.
- Confirm results count increased.
- Open latest completed result.
- Refresh the result page.
- Confirm the same result still appears.
- Close app fully.
- Reopen app.
- Open Diagnostics.
- Confirm jobs/results counts persisted.
- Open latest completed result.
- Confirm the same result still appears.

## WSL Manual MFA ControlMaster Session

- Select Manual MFA login in Settings.
- Confirm WSL backend is shown.
- Confirm WSL setup key commands show:
  `mkdir -p ~/.ssh ~/.fluorcast/ssh`
  `cp /mnt/c/Users/<you>/.ssh/id_ed25519 ~/.ssh/fluorcast_nibi_ed25519`
  `chmod 600 ~/.ssh/fluorcast_nibi_ed25519`
- Start manual login should create or update WSL script files under:
  `~/.fluorcast/scripts`
- Confirm the start script path is:
  `~/.fluorcast/scripts/start-nibi-login.sh`
- Run or click Clean stale WSL session and confirm it uses:
  `bash ~/.fluorcast/scripts/clean-nibi-session.sh`
- Confirm the clean script content uses:
  `ssh -S "$ctl" -O exit "$host" 2>/dev/null || true`
  `rm -f "$ctl"`
  `mkdir -p "$HOME/.fluorcast/ssh"`
- Start manual NIBI login.
- Confirm the start-login command does not contain `pkill -f`.
- Confirm it checks for an active master before removing the socket:
  `if ssh -S "$ctl" -O check "$host" >/dev/null 2>&1; then`
- Confirm Windows Terminal or PowerShell runs:
  `bash ~/.fluorcast/scripts/start-nibi-login.sh`
- If an active session already exists, confirm the terminal says: "An active FluorCast NIBI session already exists."
- Confirm a visible terminal opens. Prefer Windows Terminal; PowerShell is an acceptable fallback.
- If terminal launch fails, run the displayed manual WSL command:
  `bash ~/.fluorcast/scripts/start-nibi-login.sh`
- If no terminal appears, open PowerShell, run `wsl -d Ubuntu`, run the displayed manual WSL command, complete Duo, then return to FluorCast.
- If the terminal exits with code 15 before Duo appears, update the app and confirm the start-login command has no `pkill -f`.
- Complete Duo/MFA once in the WSL-backed terminal.
- Return to FluorCast and click Test authenticated session.
- Check master with:
  `ssh -S "$ctl" -O check "$host"`
- Confirm the output includes `Master running`.
- Test reuse with:
  `ssh -S "$ctl" -o BatchMode=yes "$host" "echo FLUORCAST_AUTH_OK"`
- Confirm the output is `FLUORCAST_AUTH_OK`.
- Confirm there is no second Duo prompt during the `FLUORCAST_AUTH_OK` test.
- Open Diagnostics and confirm effective backend is WSL, generated script path, launch command preview, launch method attempted, launch result, launch error code, WSL script file existence, and background command readiness are recorded.
