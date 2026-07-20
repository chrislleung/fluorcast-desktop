import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const script = readFileSync(resolve(process.cwd(), "slurm/run_prediction_job.sbatch"), "utf8");

describe("prediction Slurm batch script contract", () => {
  it("uses positional input and output arguments with environment fallback", () => {
    expect(script).toContain('INPUT_JSON="${1:-${FLUORCAST_INPUT_JSON:-}}"');
    expect(script).toContain('OUTPUT_JSON="${2:-${FLUORCAST_OUTPUT_JSON:-}}"');
  });

  it("fails clearly when input or output paths are missing", () => {
    expect(script).toContain('require_absolute_path "Input JSON" "$INPUT_JSON"');
    expect(script).toContain('require_absolute_path "Output JSON" "$OUTPUT_JSON"');
    expect(script).toContain("$label is required.");
  });

  it("uses FLUORCAST_REPO only as an explicit override and otherwise trusts sbatch chdir", () => {
    expect(script).toContain('if [[ -n "${FLUORCAST_REPO:-}" ]]; then');
    expect(script).toContain('REPO="$PWD"');
    expect(script).toContain('[[ -r "$REPO/scripts/run_prediction_job.py" ]]');
  });

  it("passes the resolved input and output paths to the Python prediction command", () => {
    expect(script).toContain('exec "$PYTHON_BIN" "$REPO/scripts/run_prediction_job.py" "$INPUT_JSON" "$OUTPUT_JSON"');
  });
});
