# FluorCast Desktop

FluorCast Desktop is the local controller application for molecular fluorescence prediction jobs. It will let researchers prepare molecule/solvent inputs, submit jobs to NIBI, monitor their progress, and review returned results without using the command line.

This repository contains only the Tauri desktop application. The scientific ML models, training code, and prediction runtime remain in the separate ChemFluor/FluorCast model repository deployed on NIBI. This app orchestrates that prediction engine; it does not duplicate it.

## Stack

- Tauri 2 and Rust
- React 19 and TypeScript
- Vite
- npm
- Vitest and Testing Library
- ESLint

## Development

Install dependencies, then start either the real desktop app or the browser-only preview:

```powershell
npm install
npm.cmd run tauri dev
```

`npm.cmd run tauri dev` starts the real FluorCast desktop app. Use this for NIBI settings, SSH login, file dialogs, local database behavior, and end-to-end manual QA.

```powershell
npm.cmd run dev
```

`npm.cmd run dev` starts only the Vite browser preview. It is useful for quick UI work, but it does not provide the full desktop shell.

On Windows systems that block PowerShell's `npm.ps1`, use `npm.cmd` in place of `npm`.

## NIBI Connection Modes

FluorCast supports three connection modes:

| Mode | Host | Requires Duo? | Best for | Status |
| --- | --- | --- | --- | --- |
| Mock | none | No | Local demos, training, and UI testing without NIBI access | Available now |
| Manual MFA | `nibi.alliancecan.ca` | Yes | Researchers who need to sign in interactively with password and Duo/MFA | Available now |
| Robot automation | `robot.nibi.alliancecan.ca` | No, after approved setup | Reliable unattended upload, submission, polling, and download | Requires Alliance support approval |

The Settings page only shows fields relevant to the selected connection mode. Hidden settings are preserved when switching modes.

Important warnings:

- FluorCast does not store NIBI or Alliance passwords.
- Do not paste private keys into Alliance/CCDB. Only upload public keys.
- Robot mode may require an approved network or VPN because restricted keys can include a `from=` network rule.
- Robot access requires Alliance support before it can run automated jobs.

### Manual MFA Workflow

Use Manual MFA when you need to approve Duo yourself.

1. Open the real app with `npm.cmd run tauri dev`.
2. Go to Settings and select **Manual MFA**.
3. Enter your NIBI username, normal login host, private SSH key path, remote project path, remote jobs path, and Python path.
4. Start the manual login session from FluorCast.
5. Complete password and Duo/MFA in the terminal window that opens.
6. Return to FluorCast and test the authenticated session.
7. Run the prediction workflow while the session is active.
8. Reconnect if the session expires.

FluorCast uses the active SSH session for background commands. It cannot type your password, approve Duo, or save MFA credentials.

### Robot Automation Workflow

Use Robot automation after Alliance support has enabled robot-node access.

1. Create or choose a private SSH key on your computer.
2. Generate the restricted public key in FluorCast.
3. Upload only the restricted public key to Alliance/CCDB.
4. Ask Alliance support to enable robot-node access for FluorCast automation.
5. Connect from an approved network or VPN if required.
6. Test robot automation in FluorCast.
7. Run the upload, submission, polling, and download workflow.

See [docs/nibi-setup.md](docs/nibi-setup.md) for step-by-step setup instructions.

## Checks

```powershell
npm.cmd run test
npm.cmd run typecheck
npm.cmd run lint
npm.cmd run build
cargo check --manifest-path src-tauri/Cargo.toml
```

See [docs/architecture.md](docs/architecture.md) for the planned system boundaries and NIBI job flow.
See [docs/nibi-setup.md](docs/nibi-setup.md) for SSH key setup guidance.
See [docs/manual-qa-checklist.md](docs/manual-qa-checklist.md) for manual testing steps.
