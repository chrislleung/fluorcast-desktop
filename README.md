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

Install dependencies, then start either the full desktop shell or the browser-only frontend:

```powershell
npm install
npm run tauri dev
```

```powershell
npm run dev
```

On Windows systems that block PowerShell's `npm.ps1`, use `npm.cmd` in place of `npm`.

## Checks

```powershell
npm run test
npm run typecheck
npm run lint
npm run build
cargo check --manifest-path src-tauri/Cargo.toml
```

See [docs/architecture.md](docs/architecture.md) for the planned system boundaries and NIBI job flow.
See [docs/nibi-setup.md](docs/nibi-setup.md) for SSH key setup guidance.
