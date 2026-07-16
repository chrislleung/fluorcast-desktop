# NIBI Connection Setup

FluorCast supports three NIBI connection modes. FluorCast never stores NIBI passwords.

## Connection Modes

### Mock Mode

Mock mode is for local UI testing only. It does not connect to NIBI, upload files, submit Slurm jobs, or run predictions remotely.

### Manual MFA Login

Manual MFA login connects to `nibi.alliancecan.ca`. You may need to enter your Alliance/NIBI password and approve Duo/MFA every time the app opens. FluorCast can reuse the session where possible, but it cannot store or replay your password or Duo response.

Use this mode while interactive login is the only available NIBI path.

On Windows, Manual MFA login uses WSL OpenSSH by default. Native Windows OpenSSH ControlMaster session reuse is not used by default because testing confirmed it fails while WSL OpenSSH works.

FluorCast may open PowerShell with a WSL-backed OpenSSH multiplexed login command. You enter your password and Duo/MFA response in that terminal, not in FluorCast. The app then tests whether background commands can reuse the session through the same WSL SSH control socket.

Set up the WSL key once:

```powershell
mkdir -p ~/.ssh ~/.fluorcast/ssh
cp /mnt/c/Users/<your Windows username>/.ssh/id_ed25519 ~/.ssh/fluorcast_nibi_ed25519
chmod 600 ~/.ssh/fluorcast_nibi_ed25519
```

FluorCast writes the Manual MFA scripts into WSL under:

```bash
~/.fluorcast/scripts/start-nibi-login.sh
~/.fluorcast/scripts/check-nibi-session.sh
~/.fluorcast/scripts/end-nibi-session.sh
~/.fluorcast/scripts/clean-nibi-session.sh
```

Windows Terminal and PowerShell launch the login script by running:

```bash
bash ~/.fluorcast/scripts/start-nibi-login.sh
```

The generated start script has this shape:

```bash
#!/usr/bin/env bash
set -u

ctl="$HOME/.fluorcast/ssh/cm-<username>-nibi.sock"
key="$HOME/.ssh/fluorcast_nibi_ed25519"
host="<username>@nibi.alliancecan.ca"

mkdir -p "$HOME/.fluorcast/ssh"

if ssh -S "$ctl" -O check "$host" >/dev/null 2>&1; then
  echo "An active FluorCast NIBI session already exists."
else
  rm -f "$ctl"
  ssh -fMN \
    -S "$ctl" \
    -i "$key" \
    -o IdentitiesOnly=yes \
    -o ControlPersist=4h \
    -o ServerAliveInterval=60 \
    -o ServerAliveCountMax=3 \
    "$host"
fi

echo
echo "Checking FluorCast NIBI session..."
ssh -S "$ctl" -O check "$host"
echo
echo "Return to FluorCast and click Test authenticated session."
read -r -p "Press Enter to close this window..."
```

The authenticated session test remains non-interactive:

```bash
ssh -S "$ctl" -o BatchMode=yes "$host" "echo FLUORCAST_AUTH_OK"
```

If the master check reports `Master running` and the response is `FLUORCAST_AUTH_OK`, the app marks the session authenticated for this app session. If NIBI asks for password, Duo, passcode, verification, or keyboard-interactive authentication again, the app keeps background remote commands blocked and asks you to start manual login again.

To end the session, FluorCast attempts:

```powershell
ssh -S "$ctl" -O exit "$host"
```

To clean a stale WSL session, FluorCast attempts a graceful master exit, removes the socket, and recreates the socket directory:

```bash
ssh -S "$ctl" -O exit "$host" 2>/dev/null || true
rm -f "$ctl"
mkdir -p "$HOME/.fluorcast/ssh"
```

This manual MFA path is a development and transition path. Robot automation remains preferred for production use.

### Robot Automation

Robot automation connects to `robot.nibi.alliancecan.ca` with a restricted SSH key after Alliance enables robot-node access for the user/project. This is the future preferred route for reliable app automation because it is designed for non-interactive remote commands.

Robot automation still uses an SSH key stored on your computer. FluorCast does not store NIBI passwords.

## SSH Key Setup

FluorCast uses a private SSH key file on your computer to connect to NIBI when a real NIBI mode is selected. FluorCast does not store your NIBI password. SSH keys remain on your computer.

Alliance/CCDB SSH public keys are still required. Upload the `.pub` file to Alliance/CCDB, but choose the private key file in FluorCast.

The desktop app can test the configured SSH connection from the Settings page. The test uses your configured `connection_mode`, `nibi_username`, `normal_login_host`, `robot_login_host`, and `ssh_private_key_path`; it does not request or store passwords, and it does not submit prediction jobs.

## Choosing Your SSH Key

Choose your private SSH key file used to connect to NIBI.

On Windows this is usually:

```powershell
C:\Users\<your Windows username>\.ssh\id_ed25519
```

If you created a FluorCast-specific key, it may be:

```powershell
C:\Users\<your Windows username>\.ssh\fluorcast_nibi_ed25519
```

Do not choose the `.pub` file. The `.pub` file is the public key uploaded to Alliance/CCDB. The private key stays on your computer and is used by this app to connect to NIBI.

## Suggested NIBI Paths

The Settings page starts with generic suggested paths. Replace `user` with your Alliance username if your NIBI scratch directory uses that name.

```text
NIBI username: user
Remote project path: /home/user/scratch/FluorCast
Remote jobs path: /home/user/scratch/fluorcast-jobs
Python environment path: /home/user/scratch/FluorCast/.venv/bin/python
```

The remote project folder should point to the FluorCast model repository on NIBI.

That project folder must contain:

```text
scripts/run_prediction_job.py
slurm/run_prediction_job.sbatch
```

The remote jobs path should be a writable directory for prediction job files. The connection test will pass if the directory already exists or can be created.

The Python environment path should point to the Python executable that will run FluorCast jobs, for example:

```text
/home/user/scratch/FluorCast/.venv/bin/python
```

## Uploading Your Public SSH Key To Alliance/CCDB

FluorCast and Alliance need different parts of the same SSH key pair.

FluorCast uses the private key path on your computer. For example:

```powershell
C:\Users\<your Windows username>\.ssh\id_ed25519
```

Alliance/CCDB needs the public key text pasted into the Manage SSH Keys page. The public key file usually ends with `.pub`:

```powershell
C:\Users\<your Windows username>\.ssh\id_ed25519.pub
```

Never paste or upload your private key. The private key is the file without `.pub`, for example `id_ed25519`. Only paste the public key text, usually from `id_ed25519.pub`. The public key text usually starts with `ssh-ed25519` or `ssh-rsa`.

Open the Alliance Manage SSH Keys page:

```text
https://ccdb.alliancecan.ca/ssh_authorized_keys
```

Check existing keys:

```powershell
dir $env:USERPROFILE\.ssh
```

Show your public key:

```powershell
Get-Content "$env:USERPROFILE\.ssh\id_ed25519.pub"
```

Copy your public key to clipboard:

```powershell
Get-Content "$env:USERPROFILE\.ssh\id_ed25519.pub" | Set-Clipboard
```

If the `.pub` file is missing, recreate it from the private key:

```powershell
ssh-keygen -y -f "$env:USERPROFILE\.ssh\id_ed25519" | Set-Content "$env:USERPROFILE\.ssh\id_ed25519.pub"
```

On the Alliance/CCDB Manage SSH Keys page:

1. Paste the copied public key text into the SSH Key box.
2. Add a description, for example: FluorCast NIBI key - Windows laptop.
3. Click Add Key.
4. Wait a few minutes before testing login.

After uploading the public key, test login from PowerShell:

```powershell
ssh -i "$env:USERPROFILE\.ssh\id_ed25519" -o IdentitiesOnly=yes <your_alliance_username>@nibi.alliancecan.ca
```

If it asks for a key passphrase, your private key is being used. If it asks for Duo/MFA, authentication has reached the interactive MFA step. If it still asks for your account password, the uploaded public key may not be active yet or may not match the selected private key. If it says Permission denied, check username, private key path, uploaded public key, and MFA setup.

### Create A FluorCast-Specific Key

This is optional, but keeps the FluorCast NIBI key separate from other SSH keys.

```powershell
ssh-keygen -t ed25519 -a 100 -f "$env:USERPROFILE\.ssh\fluorcast_nibi_ed25519" -C "fluorcast-nibi"
```

Use this private key path in FluorCast:

```powershell
C:\Users\<your Windows username>\.ssh\fluorcast_nibi_ed25519
```

Upload this public key text to Alliance/CCDB:

```powershell
C:\Users\<your Windows username>\.ssh\fluorcast_nibi_ed25519.pub
```

Copy the FluorCast-specific public key to clipboard:

```powershell
Get-Content "$env:USERPROFILE\.ssh\fluorcast_nibi_ed25519.pub" | Set-Clipboard
```

## How Do I Create An SSH Key?

Check existing keys:

```powershell
dir $env:USERPROFILE\.ssh
```

Create a FluorCast-specific key:

```powershell
ssh-keygen -t ed25519 -a 100 -f "$env:USERPROFILE\.ssh\fluorcast_nibi_ed25519" -C "fluorcast-nibi"
```

Use this private key path in FluorCast:

```powershell
C:\Users\<your Windows username>\.ssh\fluorcast_nibi_ed25519
```

Upload this public key to Alliance/CCDB:

```powershell
C:\Users\<your Windows username>\.ssh\fluorcast_nibi_ed25519.pub
```

## How Do I Test My Key?

```powershell
ssh -i "$env:USERPROFILE\.ssh\fluorcast_nibi_ed25519" <your_alliance_username>@nibi.alliancecan.ca
```

If PowerShell asks for your NIBI/Alliance password and Duo, that is normal for interactive login. Complete the prompt in PowerShell. Manual login working proves that your username, private key path, account, and MFA can work interactively.

The app's hidden remote-command tests cannot type a password or approve Duo. Automatic job submission requires non-interactive or automation-compatible SSH access.

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

For manual MFA login, first use **Copy manual SSH command** or **Open PowerShell login**. After you successfully complete login in PowerShell, check **Manual SSH login works in PowerShell** and save settings.

For the multiplexed manual MFA session:

1. Select **Manual MFA login** as the connection mode.
2. Confirm the normal login host, username, and private key path.
3. Click **Start manual NIBI login**.
4. Complete password and Duo/MFA in PowerShell.
5. Return to FluorCast and click **Test authenticated session**.
6. Confirm the status says background commands can run without a new password/Duo prompt.
7. Click **End NIBI session** when finished.

For robot automation, use `robot.nibi.alliancecan.ca` as the robot login host and the restricted private key path approved for robot-node access. After Alliance enables access and you verify it, mark robot automation access as verified.

Then press **Test NIBI Connection** for the non-interactive automation test.

FluorCast checks:

```text
Local username, host, key, and path checks
Manual SSH login confirmation
Non-interactive SSH automation test
Remote project path exists
scripts/run_prediction_job.py exists
slurm/run_prediction_job.sbatch exists
Remote jobs path exists or can be created
sbatch command exists
Python environment path exists
```

Each item is shown with a readable status. Remote environment checks only run after the non-interactive SSH automation test passes.

If NIBI asks for password or Duo during the hidden automation check, FluorCast shows:

```text
NIBI is asking for interactive password/Duo authentication. This confirms the app reached NIBI, but a hidden background command cannot complete the login. First test the manual PowerShell SSH command. For automatic job submission, FluorCast will need an automation-compatible SSH setup.
```

That message means the app reached NIBI, but background automation is not ready yet. Do not store NIBI passwords in FluorCast.
