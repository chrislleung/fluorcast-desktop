# Manual QA Checklist

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
