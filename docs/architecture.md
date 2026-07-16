# Architecture

FluorCast is split into a lightweight desktop controller and an existing scientific prediction engine. Keeping that boundary explicit prevents desktop concerns from leaking into the model repository and lets both projects evolve independently.

## Components

### Desktop app

The Tauri application provides the React user interface and a Rust backend for privileged operating-system work. It prepares prediction requests, presents job state, validates returned data, and gives researchers a local workflow that does not require shell commands.

### Local job history

Job metadata and status snapshots will be stored locally on the researcher's computer. The history is an operational index, not a cloud database: it associates local requests with remote Slurm job IDs and paths, and lets the app recover state across restarts. Secrets and SSH private keys must not be stored in job records.

### NIBI connector

A Rust-side connector will use SSH for remote commands, SFTP for file transfer, and Slurm commands for job submission and status. Its responsibilities are to create a remote job directory, upload `input.json`, submit the model repository's prediction entrypoint, poll job state, and download `output.json` and relevant logs. The connector boundary keeps remote-system details out of React components.

### Prediction engine

The existing ChemFluor/FluorCast model repository on NIBI remains the sole prediction engine. It owns the trained models, scientific dependencies, inference code, and NIBI execution environment. The desktop repository must not vendor or fork those assets.

## File contract

`input.json` and `output.json` form the versioned interface between the two repositories:

1. The desktop app validates and writes `input.json` from the user's molecule, solvent, and prediction options.
2. The connector transfers the file and starts a Slurm job against a pinned model-repository version.
3. The prediction engine reads `input.json` and writes `output.json` on successful completion.
4. The connector downloads the output; the desktop app validates its schema before displaying or recording results.

Both documents should include a contract/schema version. Additive changes should remain backward compatible where practical; breaking changes require coordinated version handling in both repositories. Exact schemas will live under `src/lib/schemas` once the scientific request and response fields are finalized.

## Intended dependency direction

React features depend on shared schemas and application services. Application services call Tauri commands. Tauri commands call the NIBI connector and local persistence. The remote connector depends only on the stable JSON contract and remote execution configuration—not on UI concepts.

No hosted authentication, cloud database, Supabase, or Vercel layer is part of this architecture.
