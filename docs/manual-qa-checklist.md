# Manual QA Checklist

Use `npm.cmd run tauri dev` for desktop checks. The Vite browser preview does not exercise Tauri shell, WSL, SSH, or SQLite integration.

## Appearance

- Confirm System mode follows the Windows light/dark preference and updates while FluorCast is running.
- Confirm Light and Dark modes switch immediately.
- Restart FluorCast and confirm the selected mode and both palettes persist.
- Edit every semantic color token and confirm the application plus live preview update.
- Confirm Light palette and Dark palette edits remain independent.
- Confirm Restore current palette defaults affects only the palette being edited.
- Confirm Restore all appearance defaults shows confirmation and restores mode plus both palettes.
- Confirm Settings has no collapsed Appearance panel.
- Confirm dialogs, dropdowns, tooltips, tables, diagnostics, result views, job cards, empty states, navigation, and focus indicators remain readable.
- Confirm the app starts without an obvious light/dark flash.
- Confirm the monochrome FluorCast logo is crisp and visible on light and dark backgrounds.
- Regenerate Tauri icons with `.\scripts\generate-icons.ps1` when `app-icon.svg` changes, then confirm Windows/Tauri icons render at small and large sizes.

## Final NIBI Acceptance

- Start FluorCast.
- Open Settings.
- Select NIBI with Manual MFA.
- Save these settings:
  - WSL distribution: `Ubuntu`
  - NIBI username: `<nibi-username>`
  - NIBI host: `nibi.alliancecan.ca`
  - WSL private key path: `/home/username/.ssh/fluorcast_nibi_ed25519`
  - Remote project path: `/home/<nibi-username>/scratch/FluorCast`
  - Remote jobs path: `/home/<nibi-username>/scratch/fluorcast-jobs`
  - Python environment path: `/home/<nibi-username>/scratch/FluorCast/.venv/bin/python`
- Click Clean stale WSL session.
- Click Start NIBI session.
- Confirm the terminal receives `HOST` and `KEY` arguments and does not report `$1: unbound variable`.
- Enter the NIBI password and Duo option `1`.
- Approve Duo.
- Return to Settings and click Test authenticated session.
- Confirm the result includes `FLUORCAST_AUTH_OK`.
- Click Run remote environment checks.
- Confirm there is no second Duo prompt.
- Submit one prediction from New Prediction.
- Confirm exactly one Slurm job is submitted.
- Confirm the Slurm job ID is persisted in Jobs.
- Confirm polling changes from queued to running to a terminal state.
- Confirm `stdout.log` and `stderr.log` are retrieved when available.
- Confirm `output.json` is retrieved and parsed on success.
- Restart the application.
- Confirm the job and result still exist.

## Manual MFA Session

- Confirm the Home page has no NIBI login button or automatic login workflow.
- In Settings, confirm the visible NIBI Session buttons are ordered:
  - Clean stale WSL session
  - Start NIBI session
  - Test authenticated session
  - Run remote environment checks
- Confirm Settings shows WSL distribution, resolved WSL user, resolved WSL HOME, NIBI target, resolved ControlPath, session status, and most recent result.
- Confirm Advanced session diagnostics is collapsed by default.
- Confirm the generated launcher uses:
  `wt.exe new-tab --title "FluorCast NIBI Login" wsl.exe -d Ubuntu -- bash -- /home/<wsl-username>/.fluorcast/scripts/start-nibi-login.sh <nibi-username>@nibi.alliancecan.ca /home/<wsl-username>/.ssh/fluorcast_nibi_ed25519`
- Confirm Test authenticated session reuses:
  `$HOME/.fluorcast/ssh/cm-nibi.sock`
- Confirm Clean stale WSL session only affects:
  `$HOME/.fluorcast/ssh/cm-nibi.sock`

## Remote Work

- Run remote environment checks only after `FLUORCAST_AUTH_OK`.
- Confirm each check is reported as passed, failed, or not run.
- Confirm checks cover project exists/readable, jobs directory create/write, Python exists/version, prediction entry point, `sbatch`, `squeue`, `sacct`, and create/read/delete smoke test.
- Confirm upload and download do not open another terminal and do not prompt for Duo again.
- Confirm Slurm submission uses:
  `run_prediction_job.sbatch "<remote job directory>/input.json" "<remote job directory>/output.json"`
- Click Submit three times rapidly and confirm one local submission and one Slurm job.
- For an active job, click Cancel and confirm only the recorded Slurm job ID is cancelled.

## Persistence

- Submit a mock prediction and confirm its result opens.
- Refresh the result page and confirm the saved result reloads by job ID.
- Restart FluorCast and confirm persisted jobs, Slurm IDs, logs, and results remain.
- Confirm completed results show Stokes shift when absorption and emission predictions are present.


