#!/usr/bin/env bash
#SBATCH --job-name=fluorcast-prediction
#SBATCH --time=00:30:00
#SBATCH --cpus-per-task=1
#SBATCH --mem=4G

set -euo pipefail

fail() {
  echo "FluorCast Slurm job failed: $*" >&2
  exit 1
}

require_absolute_path() {
  local label="$1"
  local value="$2"
  [[ -n "$value" ]] || fail "$label is required."
  [[ "$value" == /* ]] || fail "$label must be an absolute path: $value"
}

INPUT_JSON="${1:-${FLUORCAST_INPUT_JSON:-}}"
OUTPUT_JSON="${2:-${FLUORCAST_OUTPUT_JSON:-}}"

require_absolute_path "Input JSON" "$INPUT_JSON"
require_absolute_path "Output JSON" "$OUTPUT_JSON"

[[ -r "$INPUT_JSON" ]] || fail "Input JSON is not readable or does not exist: $INPUT_JSON"

OUTPUT_PARENT="$(dirname "$OUTPUT_JSON")"
[[ -d "$OUTPUT_PARENT" ]] || fail "Output parent directory does not exist: $OUTPUT_PARENT"
[[ -w "$OUTPUT_PARENT" ]] || fail "Output parent directory is not writable: $OUTPUT_PARENT"

if [[ -n "${FLUORCAST_REPO:-}" ]]; then
  REPO="$FLUORCAST_REPO"
else
  REPO="$PWD"
fi

require_absolute_path "FluorCast repository" "$REPO"
[[ -d "$REPO" ]] || fail "FluorCast repository directory does not exist: $REPO"
[[ -r "$REPO/scripts/run_prediction_job.py" ]] || fail "Prediction script is missing: $REPO/scripts/run_prediction_job.py"

if [[ ! -d "$REPO/models" && ! -d "$REPO/model_artifacts" && ! -d "$REPO/artifacts" && ! -d "$REPO/checkpoints" ]]; then
  fail "FluorCast repository is missing expected model directories or artifacts under $REPO"
fi

cd "$REPO"

PYTHON_BIN="${FLUORCAST_PYTHON:-python3}"
exec "$PYTHON_BIN" "$REPO/scripts/run_prediction_job.py" "$INPUT_JSON" "$OUTPUT_JSON"
