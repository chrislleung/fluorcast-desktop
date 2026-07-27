# FluorCast Desktop

FluorCast Desktop is a Windows desktop application for preparing, submitting, monitoring, and reviewing molecular fluorescence predictions.

The application accepts a chromophore SMILES string and solvent information, submits the prediction job to the NIBI high-performance computing cluster, and displays predicted:

- absorption wavelength;
- emission wavelength;
- quantum yield;
- Stokes shift;
- prediction intervals and applicability-domain information, when available.

FluorCast Desktop is built with Tauri, React, TypeScript, Rust, and SQLite.

> **Current platform:** Windows 10/11 with WSL2  
> **Remote compute:** NIBI through the Digital Research Alliance of Canada  
> **Authentication:** SSH plus Duo multi-factor authentication for normal user accounts

## Release v1 provisioning model

The first public release uses manual NIBI provisioning. FluorCast Desktop does not
clone the model repository, install Python packages, train models, or bundle trained
model artifacts in the desktop installer.

Before remote predictions work, clone the official FluorCast repository on NIBI,
create the Python environment, and train the required tree, neural, and hybrid
models:

- Official repository: <https://github.com/chrislleung/fluorcast>
- Expected repository path: `~/scratch/FluorCast`
- Expected environment path: `~/scratch/chemfluor_env`

The Home page includes a collapsible **Required Nibi setup** guide with the
desktop-specific commands and readiness checklist.

---

## Table of contents

1. [How FluorCast works](#how-fluorcast-works)
2. [Connection modes](#connection-modes)
3. [Requirements](#requirements)
4. [Install the desktop application](#install-the-desktop-application)
5. [Install and configure WSL2](#install-and-configure-wsl2)
6. [Create an SSH key in WSL](#create-an-ssh-key-in-wsl)
7. [Add the SSH key to your Alliance account](#add-the-ssh-key-to-your-alliance-account)
8. [Prepare FluorCast on NIBI](#prepare-fluorcast-on-nibi)
9. [Configure FluorCast Desktop](#configure-fluorcast-desktop)
10. [Start and verify a NIBI session](#start-and-verify-a-nibi-session)
11. [Run a prediction](#run-a-prediction)
12. [Understand job states](#understand-job-states)
13. [Security and privacy](#security-and-privacy)
14. [Troubleshooting](#troubleshooting)
15. [Developer setup](#developer-setup)
16. [Build a downloadable release](#build-a-downloadable-release)
17. [Release checklist](#release-checklist)
18. [License and citation](#license-and-citation)

---

## How FluorCast works

FluorCast separates the desktop interface from the compute-intensive prediction workflow.

```text
Windows desktop app
        |
        | WSL2 + SSH
        v
NIBI login node
        |
        | Slurm
        v
FluorCast prediction job
        |
        v
JSON result returned to the desktop app
```

The desktop app:

1. stores local settings and job history in SQLite;
2. prepares a prediction request;
3. transfers the request to NIBI;
4. submits a Slurm job;
5. monitors the remote job;
6. downloads the completed JSON output;
7. validates and stores the result locally;
8. displays the prediction and diagnostics.

The app does not perform the production machine-learning inference directly on the Windows computer.

---

## Connection modes

FluorCast Desktop supports three connection modes.

### Mock mode

Use mock mode for interface testing and demonstrations.

- No NIBI account is required.
- No SSH connection is created.
- Results are generated locally for testing.
- Mock results must not be treated as scientific predictions.

### Manual MFA login

This is the normal mode for individual Alliance users.

- The app starts an SSH session inside WSL2.
- You authenticate using your Alliance password and Duo.
- The authenticated SSH ControlMaster session is reused for later app actions.
- You normally authenticate once per app session.

### Robot automation

This mode is intended only for approved non-interactive Alliance robot accounts.

- It requires a restricted SSH key and cluster-side authorization.
- It is not available to ordinary user accounts by default.
- Do not select this mode unless the Alliance has explicitly enabled robot-node access for the account.

---

## Requirements

Before using production predictions, you need:

- Windows 10 or Windows 11;
- administrator access for installing WSL2;
- a Digital Research Alliance of Canada account;
- access to NIBI;
- Duo multi-factor authentication configured for the Alliance account;
- an Ubuntu WSL distribution;
- an SSH key stored inside WSL;
- a working FluorCast checkout and Python environment on NIBI;
- internet access.

For mock mode, only the desktop application is required.

---

## Install the desktop application

1. Open the project’s **GitHub Releases** page.
2. Open the newest stable release.
3. Download the Windows installer:
   - `.msi`, or
   - setup `.exe`, depending on the published assets.
4. Run the installer.
5. If Windows SmartScreen appears:
   - confirm that the publisher and download source are expected;
   - select **More info**;
   - select **Run anyway** only when you trust the release.
6. Start **FluorCast** from the Start menu.

> Before public release, replace this section with a direct link to the final GitHub Releases page.

---

## Install and configure WSL2

Open PowerShell as Administrator:

```powershell
wsl --install -d Ubuntu
```

Restart Windows if prompted.

After restarting, open Ubuntu from the Start menu and create your Linux username and password.

Confirm WSL is installed:

```powershell
wsl --list --verbose
```

Expected output should show an Ubuntu distribution using WSL version 2.

Example:

```text
NAME      STATE    VERSION
Ubuntu    Stopped  2
```

Inside Ubuntu, install the OpenSSH client:

```bash
sudo apt update
sudo apt install -y openssh-client
```

Confirm SSH is available:

```bash
ssh -V
```

---

## Create an SSH key in WSL

Open Ubuntu and run:

```bash
mkdir -p ~/.ssh
chmod 700 ~/.ssh

ssh-keygen \
  -t ed25519 \
  -f ~/.ssh/fluorcast_nibi_ed25519 \
  -C "fluorcast-nibi"
```

Choose a passphrase if required by your security policy.

The key files will be:

```text
~/.ssh/fluorcast_nibi_ed25519
~/.ssh/fluorcast_nibi_ed25519.pub
```

Apply safe permissions:

```bash
chmod 600 ~/.ssh/fluorcast_nibi_ed25519
chmod 644 ~/.ssh/fluorcast_nibi_ed25519.pub
```

Display the public key:

```bash
cat ~/.ssh/fluorcast_nibi_ed25519.pub
```

Copy the entire output. Never upload or share the private key.

---

## Add the SSH key to your Alliance account

1. Sign in to your Digital Research Alliance of Canada account.
2. Open the SSH-key management page.
3. Add a new SSH key.
4. Paste the complete contents of:

```text
~/.ssh/fluorcast_nibi_ed25519.pub
```

5. Save the key.

Test the key from Ubuntu:

```bash
ssh \
  -i ~/.ssh/fluorcast_nibi_ed25519 \
  <your-nibi-username>@nibi.alliancecan.ca
```

Complete the password and Duo prompts.

A normal Alliance SSH key may identify the client without eliminating the password or Duo requirement. This is expected for manual MFA accounts.

Exit after confirming login:

```bash
exit
```

---

## Prepare FluorCast on NIBI

The desktop application requires a working copy of the FluorCast model repository on NIBI.

Sign in:

```bash
ssh \
  -i ~/.ssh/fluorcast_nibi_ed25519 \
  <your-nibi-username>@nibi.alliancecan.ca
```

Choose a persistent project location. One example is:

```bash
mkdir -p "$HOME/scratch"
cd "$HOME/scratch"
```

Clone the FluorCast model repository:

```bash
git clone https://github.com/chrislleung/fluorcast.git FluorCast
cd FluorCast
```

If the repository is private, authenticate using a supported GitHub method.

### Create the Python environment

For the v1 desktop workflow, create the environment under the expected NIBI scratch
path:

```bash
module purge
module load python/3.11
module load gcc
module load rdkit

python -m venv --system-site-packages ~/scratch/chemfluor_env
source ~/scratch/chemfluor_env/bin/activate

python -m pip install --upgrade pip setuptools wheel
python -m pip install -r requirements.txt
python -m pip install pytest typing_extensions matplotlib scipy
```

Confirm the Python executable:

```bash
realpath ~/scratch/chemfluor_env/bin/python
```

Confirm that the prediction entry point and trained model artifacts are present before using the desktop app. The desktop installer does not include trained models.

### Create the remote job directory

```bash
mkdir -p "$HOME/scratch/fluorcast-jobs"
```

Recommended remote paths:

```text
Remote project path:
$HOME/scratch/FluorCast

Remote jobs path:
$HOME/scratch/fluorcast-jobs

Python environment path:
$HOME/scratch/chemfluor_env/bin/python
```

In the desktop app, use fully resolved paths such as:

```text
/home/<username>/scratch/FluorCast
/home/<username>/scratch/fluorcast-jobs
/home/<username>/scratch/chemfluor_env/bin/python
```

Do not enter `$HOME` or `~` unless the app explicitly documents support for shell expansion.

---

## Configure FluorCast Desktop

Open the **Home** page and find the connection settings.

### 1. Select the connection mode

For normal user accounts, select:

```text
Manual MFA login
```

### 2. Mode-specific setup

Enter:

| Setting | Example |
|---|---|
| NIBI username | `jsmith` |
| Normal login host | `nibi.alliancecan.ca` |
| WSL distribution | `Ubuntu` |

Use the exact distribution name shown by:

```powershell
wsl --list --quiet
```

### 3. SSH key

Enter the WSL private-key path:

```text
/home/<wsl-username>/.ssh/fluorcast_nibi_ed25519
```

This path must be a Linux path inside WSL, not a Windows path.

### 4. Remote FluorCast paths

Enter the fully resolved NIBI paths:

```text
Remote project path:
 /home/<nibi-username>/scratch/FluorCast

Remote jobs path:
 /home/<nibi-username>/scratch/fluorcast-jobs

Python environment path:
 /home/<nibi-username>/scratch/chemfluor_env/bin/python
```

### 5. Save the settings

Select **Save settings** before starting the NIBI session.

Settings are stored locally on the current Windows device.

---

## Start and verify a NIBI session

The NIBI Session section provides four actions.

### Clean stale WSL session

Use this when:

- the app reports a stale or unusable ControlMaster socket;
- an earlier login window was closed unexpectedly;
- session testing fails even though no current login is active.

This removes stale FluorCast session state. It does not delete the SSH private key.

### Start NIBI session

1. Select **Start NIBI session**.
2. A terminal window opens through WSL.
3. Enter the Alliance password when requested.
4. Complete the Duo prompt.
5. Keep the authentication process open until the app confirms that the session is ready.

The app creates or reuses an SSH ControlMaster socket under a WSL path similar to:

```text
~/.fluorcast/ssh/cm-nibi.sock
```

### Test authenticated session

Select **Test authenticated session** after login.

A successful test confirms that FluorCast can reuse the authenticated session without another immediate password or Duo prompt.

### Run remote environment checks

After the authenticated-session test succeeds, select **Run remote environment checks**.

The checks should confirm that:

- the remote host is reachable;
- the configured project directory exists;
- the configured Python executable exists;
- required scripts or entry points are available;
- the remote jobs directory can be used;
- the authenticated SSH session can run non-interactive commands.

Do not submit production jobs until the environment checks pass.

---

## Run a prediction

1. Open **New Prediction**.
2. Enter the chromophore SMILES string.
3. Select or enter the solvent.
4. Select the prediction model.
5. Review the request.
6. Submit the prediction once.
7. Open **Jobs** to monitor progress.

Avoid pressing the submit button repeatedly while the interface is waiting for NIBI. Each accepted submission may create a separate Slurm job.

When the job completes, FluorCast downloads and stores the result locally.

Depending on the model output, the result may include:

- absorption wavelength in nanometres;
- emission wavelength in nanometres;
- quantum yield;
- Stokes shift in nanometres;
- Stokes shift in inverse centimetres;
- prediction intervals;
- brightness class;
- applicability-domain status;
- model and runtime metadata.

---

## Understand job states

Common local job states include:

| State | Meaning |
|---|---|
| Draft | Request has not been submitted |
| Submitted | Request was transferred and submitted to Slurm |
| Queued | Slurm is waiting for resources |
| Running | The remote prediction process is active |
| Completed | Output was downloaded, validated, and stored |
| Failed | Submission, execution, download, or validation failed |
| Cancelled | The job was cancelled locally or remotely |

A Slurm job can finish remotely before the desktop app imports the output. When available, use the app’s retry or refresh action to retrieve the completed result rather than submitting a duplicate job.

---

## Security and privacy

FluorCast Desktop is designed so that:

- the Alliance password is not stored by the app;
- Duo approval remains under the user’s control;
- the SSH private key remains on the user’s computer;
- authentication is performed through WSL and SSH;
- job history and settings are stored locally in SQLite;
- remote prediction inputs and outputs are stored in the configured NIBI job directory.

Users should:

- never commit private SSH keys to Git;
- never share Alliance credentials;
- never share authenticated SSH ControlMaster sockets;
- use robot automation only with explicit authorization;
- remove sensitive prediction inputs and outputs according to institutional policy;
- verify downloaded installers and release checksums.

---

## Troubleshooting

### The app says “session not found”

1. Confirm Ubuntu is installed:

```powershell
wsl --list --verbose
```

2. Confirm the configured WSL distribution name is exact.
3. Select **Clean stale WSL session**.
4. Select **Start NIBI session**.
5. Complete password and Duo.
6. Select **Test authenticated session**.

### The session test fails after a successful login

Inside Ubuntu, test SSH directly:

```bash
ssh \
  -i ~/.ssh/fluorcast_nibi_ed25519 \
  <your-nibi-username>@nibi.alliancecan.ca
```

Also confirm:

```bash
ls -l ~/.ssh/fluorcast_nibi_ed25519
```

The private key should normally have mode `600`.

### The environment-check button is disabled

The authenticated session must pass first.

Use this order:

```text
Clean stale WSL session, when needed
→ Start NIBI session
→ Test authenticated session
→ Run remote environment checks
```

### The remote project directory is missing

Log in to NIBI and verify:

```bash
test -d /home/<username>/scratch/FluorCast && echo PROJECT_OK
```

### The Python path is invalid

Verify:

```bash
test -x /home/<username>/scratch/chemfluor_env/bin/python \
  && echo PYTHON_OK
```

### A job remains queued

This may be normal when NIBI is busy.

Use Slurm on NIBI:

```bash
squeue -u "$USER"
```

### A job failed

Inspect the remote job directory:

```bash
cd /home/<username>/scratch/fluorcast-jobs/<job-id>

cat stdout.log
cat stderr.log
```

The desktop app’s job details and diagnostics pages may also show the remote directory, Slurm ID, exit state, and error text.

### The result exists remotely but is not displayed

Use the existing job’s refresh or retry-import action. Do not create a new prediction unless the original job genuinely needs to be rerun.

### Windows cannot move or delete the development folder

Close:

- FluorCast;
- VS Code;
- Node;
- Vite;
- Tauri;
- Cargo;
- terminals opened inside the repository.

Generated directories such as these can be recreated and should not be archived as source:

```text
node_modules
dist
src-tauri/target
```

---

## Developer setup

### Required software

Install:

- Git;
- Node.js and npm;
- Rust through `rustup`;
- Microsoft C++ Build Tools;
- WebView2 runtime;
- WSL2 and Ubuntu for remote-workflow testing.

Clone the repository:

```powershell
git clone https://github.com/chrislleung/fluorcast-desktop.git
cd fluorcast-desktop
```

Install JavaScript dependencies:

```powershell
npm ci
```

Run the desktop app in development mode:

```powershell
npm run tauri dev
```

### Validation

Run all checks before opening a pull request:

```powershell
npm run typecheck
npm test
npm run lint
npm run build
```

For a Tauri production build, also run:

```powershell
npm run tauri build
```

### Repository hygiene

Do not commit:

```text
node_modules/
dist/
src-tauri/target/
private SSH keys
local SQLite databases
temporary prediction outputs
local diagnostic fixtures containing sensitive data
```

---

## Build a downloadable release

Run from a clean `main` branch:

```powershell
git switch main
git pull --ff-only origin main
git status --short
```

The working tree should be clean.

Install exact dependencies:

```powershell
npm ci
```

Run validation:

```powershell
npm run typecheck
npm test
npm run lint
npm run build
```

Build the Tauri packages:

```powershell
npm run tauri build
```

Tauri normally writes Windows release artifacts under directories similar to:

```text
src-tauri/target/release/bundle/msi/
src-tauri/target/release/bundle/nsis/
```

The exact output depends on the enabled Tauri bundle targets.

### Create checksums

From PowerShell:

```powershell
Get-FileHash .\path\to\FluorCast-installer.exe -Algorithm SHA256
Get-FileHash .\path\to\FluorCast-installer.msi -Algorithm SHA256
```

Publish the checksums in the release notes or as a separate `SHA256SUMS.txt` file.

### Create the Git tag

Example:

```powershell
$version = "v0.1.0"

git tag -a $version -m "FluorCast Desktop $version"
git push origin $version
```

### Publish on GitHub

Create a GitHub Release from the version tag and upload:

- the `.msi` installer;
- the setup `.exe`, if built;
- `SHA256SUMS.txt`;
- release notes;
- any required license notices.

The release notes should include:

- supported Windows versions;
- whether the build is signed;
- required WSL and NIBI setup;
- known limitations;
- changes since the previous release;
- upgrade or migration notes.

---

## Release checklist

Before publishing a downloadable build:

- [ ] Update the application version.
- [ ] Confirm the Git working tree is clean.
- [ ] Run `npm ci`.
- [ ] Run `npm run typecheck`.
- [ ] Run the full test suite.
- [ ] Run `npm run lint`.
- [ ] Run `npm run build`.
- [ ] Run `npm run tauri build`.
- [ ] Install the generated package on a clean Windows test account or virtual machine.
- [ ] Test mock mode.
- [ ] Test manual MFA login.
- [ ] Test stale-session cleanup.
- [ ] Test authenticated-session reuse.
- [ ] Test remote environment checks.
- [ ] Submit exactly one real NIBI prediction.
- [ ] Confirm Slurm monitoring.
- [ ] Confirm output download and validation.
- [ ] Restart the app and confirm result persistence.
- [ ] Verify uninstall behavior.
- [ ] Generate SHA-256 checksums.
- [ ] Review security and privacy wording.
- [ ] Confirm that no credentials, private keys, or sensitive outputs are bundled.
- [ ] Create and push the release tag.
- [ ] Upload installers and checksums to GitHub Releases.
- [ ] Publish release notes.
- [ ] Preserve a tested recovery tag.

---

## Known limitations

Current limitations may include:

- Windows and WSL2 are required for the supported desktop workflow.
- Normal NIBI accounts require interactive password and Duo authentication.
- Robot automation requires separate institutional approval.
- Production predictions require a separately configured FluorCast environment on NIBI.
- Cluster queue time depends on current NIBI availability.
- Prediction quality depends on molecular coverage and the model’s applicability domain.
- The desktop app is not a substitute for expert scientific interpretation.

Update this section for each public release.

---

## License and citation

Add the project’s software license before public release.

If FluorCast is used in academic work, cite the accompanying FluorCast publication, dataset sources, and model dependencies.

> Replace this section with the final license identifier, paper citation, DOI, and repository citation before publishing the first stable release.

---

## Support

For reproducible bug reports, include:

- FluorCast Desktop version;
- Windows version;
- WSL distribution and version;
- selected connection mode;
- the failed workflow step;
- local job ID;
- Slurm job ID, when available;
- the sanitized error message;
- relevant diagnostics with usernames, paths, credentials, and molecular data removed when necessary.

Do not include passwords, Duo information, private SSH keys, or unredacted confidential research inputs in public issues.
