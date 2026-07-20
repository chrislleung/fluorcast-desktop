# NIBI Connection Setup

This guide is for researchers and testers who need to connect FluorCast to NIBI. FluorCast supports local mock predictions, manual interactive MFA login, and approved robot automation.

Important warnings:

- FluorCast does not store NIBI or Alliance passwords.
- Do not paste private keys into Alliance/CCDB. Only upload public keys.
- Robot mode may require an approved network or VPN because restricted keys can include a `from=` network rule.
- Robot access requires Alliance support before it can run automated jobs.

## Connection Mode Comparison

| Mode | Host | Requires Duo? | Best for | Status |
| --- | --- | --- | --- | --- |
| Mock | none | No | Local demos, training, and UI testing without NIBI access | Available now |
| Manual MFA | `nibi.alliancecan.ca` | Yes | Researchers who need to sign in interactively with password and Duo/MFA | Available now |
| Robot automation | `robot.nibi.alliancecan.ca` | No, after approved setup | Reliable unattended upload, submission, polling, and download | Requires Alliance support approval |

The Settings page only shows fields relevant to the selected connection mode. Hidden settings are preserved when switching modes.

Do not use the robot host for Manual MFA mode. Do not use the normal login host for Robot automation mode.

## Real App Vs Browser Preview

Use the real desktop app for NIBI setup and testing:

```powershell
npm.cmd run tauri dev
```

Use the browser preview only for frontend UI work:

```powershell
npm.cmd run dev
```

The browser preview does not provide the full desktop shell, SSH workflow, file dialogs, or real app behavior.

## What You Need

- Your Alliance/NIBI username.
- An SSH key pair on your computer.
- Your public key uploaded to Alliance/CCDB.
- Remote FluorCast project, jobs, and Python paths on NIBI.
- For Robot automation, Alliance support approval.

## Find Or Create An SSH Key

Check for existing SSH keys:

```powershell
dir $env:USERPROFILE\.ssh
```

Common private key files:

```powershell
C:\Users\<your Windows username>\.ssh\id_ed25519
C:\Users\<your Windows username>\.ssh\fluorcast_nibi_ed25519
```

The matching public key files end with `.pub`:

```powershell
C:\Users\<your Windows username>\.ssh\id_ed25519.pub
C:\Users\<your Windows username>\.ssh\fluorcast_nibi_ed25519.pub
```

Do not choose the `.pub` file in FluorCast. The `.pub` file is for Alliance/CCDB. The private key stays on your computer.

Create a FluorCast-specific key if you do not already have one:

```powershell
ssh-keygen -t ed25519 -a 100 -f "$env:USERPROFILE\.ssh\fluorcast_nibi_ed25519" -C "fluorcast-nibi"
```

If the `.pub` file is missing, recreate it from the private key:

```powershell
ssh-keygen -y -f "$env:USERPROFILE\.ssh\fluorcast_nibi_ed25519" | Set-Content "$env:USERPROFILE\.ssh\fluorcast_nibi_ed25519.pub"
```

## Upload Your Public Key To CCDB

FluorCast and Alliance need different parts of the same SSH key pair.

FluorCast uses the private key path on your computer:

```powershell
C:\Users\<your Windows username>\.ssh\fluorcast_nibi_ed25519
```

Alliance/CCDB needs the public key text:

```powershell
C:\Users\<your Windows username>\.ssh\fluorcast_nibi_ed25519.pub
```

Never paste or upload your private key. The private key is the file without `.pub`, for example `fluorcast_nibi_ed25519`. Only paste the public key text, usually from `fluorcast_nibi_ed25519.pub`. Public key text usually starts with `ssh-ed25519` or `ssh-rsa`.

Open the Alliance Manage SSH Keys page:

```text
https://ccdb.alliancecan.ca/ssh_authorized_keys
```

Copy the public key:

```powershell
Get-Content "$env:USERPROFILE\.ssh\fluorcast_nibi_ed25519.pub" | Set-Clipboard
```

On the Alliance/CCDB Manage SSH Keys page:

1. Paste the copied public key text into the SSH Key box.
2. Add a description, for example: `FluorCast NIBI key - Windows laptop`.
3. Click Add Key.
4. Wait a few minutes before testing login.

Test login from PowerShell:

```powershell
ssh -i "$env:USERPROFILE\.ssh\fluorcast_nibi_ed25519" -o IdentitiesOnly=yes <your_alliance_username>@nibi.alliancecan.ca
```

If it asks for a key passphrase, your private key is being used. If it asks for Duo/MFA, authentication has reached the interactive MFA step. If it still asks for your account password, the uploaded public key may not be active yet or may not match the selected private key.

## Suggested NIBI Paths

The Settings page starts with generic suggested paths. Replace `user` with your Alliance username if your NIBI scratch directory uses that name.

```text
NIBI username: user
Remote project path: /home/user/scratch/FluorCast
Remote jobs path: /home/user/scratch/fluorcast-jobs
Python environment path: /home/user/scratch/FluorCast/.venv/bin/python
```

The remote project folder should point to the FluorCast model repository on NIBI and contain:

```text
scripts/run_prediction_job.py
slurm/run_prediction_job.sbatch
```

The remote jobs path should be a writable directory for prediction job files. The Python environment path should point to the Python executable that runs FluorCast jobs.

## Manual MFA Login Mode

Manual MFA connects to `nibi.alliancecan.ca`. Use this mode when a person will complete password and Duo/MFA login.

Workflow:

1. Start FluorCast with `npm.cmd run tauri dev`.
2. Open Settings.
3. Select **Manual MFA**.
4. Enter your NIBI username.
5. Confirm the normal login host is `nibi.alliancecan.ca`.
6. Choose the private SSH key file on your computer.
7. Enter the remote project path, remote jobs path, and Python environment path.
8. Save settings.
9. Confirm the Manual MFA provider is **Terminal action recommended**.
10. Upload a prediction input.
11. Open Jobs and click **Submit to Slurm**.
12. Complete password and Duo/MFA in the visible PowerShell window.
13. Return to FluorCast after PowerShell finishes so the app can read stdout, stderr, and the exit code.
14. Use **Refresh status** and **Download result** from Jobs; each action may open PowerShell and ask for password + Duo again.

### Manual MFA terminal-action mode

Terminal-action mode is the recommended Manual MFA mode for Windows. FluorCast opens a visible PowerShell window for each NIBI action, such as Slurm submission, status refresh, and result download. You complete password and Duo in PowerShell. FluorCast does not capture that input; it reads local output files after the command finishes.

This mode does not reuse login sessions. It is slower because each remote action may ask for password + Duo, but it avoids unreliable SSH `ControlMaster`/`ControlPath` reuse on Windows. Robot automation remains the preferred production path because it removes repeated MFA once enabled.

For Slurm submission, FluorCast runs:

```powershell
ssh -i "<ssh_private_key_path>" -o IdentitiesOnly=yes <username>@<normal_login_host> "sbatch --parsable <remote_project_path>/slurm/run_prediction_job.sbatch <remote_input_path> <remote_output_path>"
```

For result download, FluorCast runs:

```powershell
scp -i "<ssh_private_key_path>" -o IdentitiesOnly=yes <username>@<normal_login_host>:<remote_output_path> "<local_output_path>"
```

### Legacy Manual MFA persistent shell mode

Persistent shell mode is a legacy Manual MFA option. FluorCast opens one live SSH session to `nibi.alliancecan.ca`, the user enters password and Duo into that session, and FluorCast keeps the session open. Upload, submission, polling, and JSON download commands run through that same live shell.

FluorCast does not store NIBI passwords, Duo codes, or raw terminal input. The session is memory-only and disconnects when the user closes the session or exits the app.

The readiness test sends:

```bash
printf '\n__FLUORCAST_READY_START__\n'; echo FLUORCAST_READY; printf '\n__FLUORCAST_READY_END__\n'
```

If the marked output contains `FLUORCAST_READY`, FluorCast marks the session active. If NIBI asks for password, Duo, passcode, verification, or keyboard-interactive authentication again, FluorCast blocks remote commands and asks you to reconnect.

For small JSON files, persistent shell mode transfers content through the live shell instead of opening separate `scp` or `sftp` processes. Remote paths must be absolute and under the configured remote jobs path.

### Legacy ControlMaster mode

ControlMaster mode is experimental on Windows and may not work reliably. It depends on SSH multiplexing options such as `ControlMaster`, `ControlPath`, and `ControlPersist`. Use it only if you explicitly need the older WSL/OpenSSH reusable-session diagnostics.

A normal SSH login in a separate terminal can confirm your account works, but FluorCast cannot send commands through that separate process. Terminal-action mode avoids reusable-session assumptions by opening a fresh visible PowerShell action when work is needed.

## Robot Automation Mode

Robot automation connects to `robot.nibi.alliancecan.ca` with a restricted SSH key after Alliance enables robot-node access for the user or project. Use this mode for reliable non-interactive upload, submission, polling, and download.

Workflow:

1. Create or choose a private SSH key on your computer.
2. Open Settings.
3. Select **Robot automation**.
4. Confirm the robot host is `robot.nibi.alliancecan.ca`.
5. Choose the private SSH key path.
6. Generate the restricted public key.
7. Upload only the restricted public key to Alliance/CCDB.
8. Copy the Alliance support request.
9. Ask Alliance support to enable robot-node access.
10. Connect through an approved network or VPN if your key restriction requires it.
11. Click **Test robot automation**.
12. Run prediction upload, submission, polling, and download without manual Duo prompts.

The robot automation smoke test is:

```powershell
ssh -i "<ssh_private_key_path>" -o IdentitiesOnly=yes <nibi_username>@robot.nibi.alliancecan.ca "echo FLUORCAST_ROBOT_OK"
```

If this asks for a password, Duo, passcode, verification, or keyboard-interactive authentication, robot automation is not ready. Manual login may still work, but automatic FluorCast job submission requires robot-node access with a restricted public key.

## Restricted Robot Public Key

For robot automation, do not upload the ordinary public key directly. FluorCast generates a restricted CCDB key from `<private_key_path>.pub`:

```text
restrict,from="<robot_key_restriction_from>",command="<robot_key_forced_command>" <public-key-text>
```

Defaults:

```text
robot_key_restriction_from = 134.153.150.*
robot_key_forced_command = /cvmfs/soft.computecanada.ca/custom/bin/computecanada/allowed_commands/allowed_commands.sh
```

Only upload the restricted public key to CCDB. Never upload or paste the private key. The `from=` restriction may require an approved network or VPN.

## Alliance Support Request

Use **Copy Alliance support request** from Settings, or send this template:

```text
Hello Alliance support,

Please enable robot-node access for FluorCast automation.

Username: <nibi_username>
Robot host: robot.nibi.alliancecan.ca

Requested app actions:
- transfer input files with scp/sftp
- submit jobs with sbatch
- check jobs with squeue/sacct
- download completed output files

The restricted public key uploaded to CCDB will use a forced command and from= network restriction.
```

## Test From FluorCast

Open Settings and fill in:

```text
Connection mode
NIBI username
Normal login host
Robot login host
Private SSH key file
Remote project path
Remote jobs path
Python environment path
```

For Manual MFA, start manual login first, complete Duo/MFA in the terminal, then click **Test authenticated session**.

For Robot automation, confirm Alliance approval and restricted-key upload first, then click **Test robot automation**. A successful test returns `FLUORCAST_ROBOT_OK` and marks robot access verified.

## Remote Environment Checks

After Manual MFA is authenticated or Robot automation is verified, run **Remote Environment Checks** from Settings before upload or submission.

The checks mean:

- Remote project path exists: confirms the configured FluorCast model repository directory is present on NIBI.
- Remote jobs path exists or can be created: confirms FluorCast can create or use the directory where job inputs and outputs will live.
- Python environment exists: confirms the configured Python executable exists and is executable.
- Prediction script exists: confirms `<remote_project_path>/scripts/run_prediction_job.py` is present.
- Slurm prediction script exists: confirms `<remote_project_path>/slurm/run_prediction_job.sbatch` is present.
- `sbatch` is available: confirms Slurm job submission is available.
- `squeue` is available: confirms queued/running job checks are available.
- `sacct` is available: helpful for accounting/history checks, but optional. If `sacct` is unavailable, job polling may fall back to `squeue` and output-file checks.

Do not proceed to prediction upload or Slurm submission until all required checks pass.

## Troubleshooting

If FluorCast asks you to reconnect in Manual MFA mode, the SSH session may have expired. Start manual NIBI login again, complete Duo/MFA in the terminal, then test the authenticated session.

If robot automation asks for password, Duo, passcode, verification, or keyboard-interactive authentication, robot access is not ready. Check the restricted public key, robot host, username, VPN or approved network, and Alliance support approval.

If SSH says `Permission denied`, check the username, private key path, uploaded public key, and CCDB propagation time.

If FluorCast cannot find the remote project, confirm the project path contains:

```text
scripts/run_prediction_job.py
slurm/run_prediction_job.sbatch
```

If FluorCast cannot create or write jobs, confirm the remote jobs path exists or can be created by your NIBI account.

If the hidden automation check reports that NIBI is asking for interactive password or Duo authentication, the app reached NIBI but cannot complete a background command. Use Manual MFA for interactive sessions or finish Robot automation setup for unattended jobs.
