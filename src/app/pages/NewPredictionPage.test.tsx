import { fireEvent, render, screen } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  validatePredictionJobInput,
} from "../../lib/schemas";
import { NewPredictionPage } from "./NewPredictionPage";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string, args?: { commandSpec?: { executable?: string } }) => {
    if (command === "write_prediction_input_temp_file") {
      return "C:\\Temp\\fluorcast-job-input.json";
    }
    if (command === "run_nibi_remote_command") {
      const executable = args?.commandSpec?.executable;
      if (executable === "cat") {
        return {
          exit_code: 1,
          stdout: "",
          stderr: "missing",
          duration_ms: 1,
          command_label: "Read remote Slurm submission marker",
          redacted_command_preview: "cat <remote_job_dir>/slurm_job_id.txt",
        };
      }
      return {
        exit_code: 0,
        stdout: executable === "sbatch" ? "123456" : "",
        stderr: "",
        duration_ms: 1,
        command_label: executable === "sbatch" ? "Submit prediction Slurm job" : "Remote command",
        redacted_command_preview: "sbatch --parsable <remote_project>/slurm/run_prediction_job.sbatch <remote_input_json> <remote_output_json>",
      };
    }
    return undefined;
  }),
}));

describe("NewPredictionPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects an empty molecule SMILES", () => {
    render(<NewPredictionPage />);

    fireEvent.change(screen.getByLabelText(/Solvent SMILES/i), {
      target: { value: "O" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Run mock prediction/i }));

    expect(screen.getByText("Molecule SMILES is required.")).toBeInTheDocument();
    expect(screen.getByText("No input generated yet.")).toBeInTheDocument();
  });

  it("rejects an empty solvent SMILES", () => {
    render(<NewPredictionPage />);

    fireEvent.change(screen.getByLabelText(/Molecule SMILES/i), {
      target: { value: "C1=CC=CC=C1" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Run mock prediction/i }));

    expect(screen.getByText("Solvent SMILES is required.")).toBeInTheDocument();
    expect(screen.getByText("No input generated yet.")).toBeInTheDocument();
  });

  it("creates valid input JSON from a valid form", () => {
    render(<NewPredictionPage />);

    fireEvent.change(screen.getByLabelText(/Molecule SMILES/i), {
      target: { value: "C1=CC=CC=C1" },
    });
    fireEvent.change(screen.getByLabelText(/Solvent SMILES/i), {
      target: { value: "O" },
    });
    fireEvent.change(screen.getByLabelText(/Model choice/i), {
      target: { value: "rf" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Run mock prediction/i }));

    const preview = screen.getByLabelText("Generated input JSON");
    const inputJson = JSON.parse(preview.querySelector("pre")?.textContent ?? "");
    const validatedInput = validatePredictionJobInput(inputJson);

    expect(validatedInput).toMatchObject({
      user_id: "local_user",
      molecule_smiles: "C1=CC=CC=C1",
      solvent_smiles: "O",
      model_choice: "rf",
    });
    expect(validatedInput.job_id).toEqual(expect.any(String));
    expect(Number.isNaN(Date.parse(validatedInput.requested_at))).toBe(false);
  });

  it("keeps Hybrid full available with the local hybrid_full selection value", () => {
    render(<NewPredictionPage />);

    expect(screen.getByRole("option", { name: "Hybrid full" })).toHaveValue("hybrid_full");
    fireEvent.change(screen.getByLabelText(/Molecule SMILES/i), {
      target: { value: "C1=CC=CC=C1" },
    });
    fireEvent.change(screen.getByLabelText(/Solvent SMILES/i), {
      target: { value: "O" },
    });
    fireEvent.change(screen.getByLabelText(/Model choice/i), {
      target: { value: "hybrid_full" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Run mock prediction/i }));

    const preview = screen.getByLabelText("Generated input JSON");
    const inputJson = JSON.parse(preview.querySelector("pre")?.textContent ?? "");
    expect(inputJson.model_choice).toBe("hybrid_full");
  });

  it("transitions a submitted mock job to completed and opens the stored result", async () => {
    const handleOpenResult = vi.fn();
    render(<NewPredictionPage onOpenResult={handleOpenResult} />);

    fireEvent.change(screen.getByLabelText(/Molecule SMILES/i), {
      target: { value: "C1=CC=CC=C1" },
    });
    fireEvent.change(screen.getByLabelText(/Solvent SMILES/i), {
      target: { value: "O" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Run mock prediction/i }));

    expect(await screen.findByText("Queued locally")).toBeInTheDocument();
    expect(await screen.findByText("Completed")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /View completed result/i }));

    expect(handleOpenResult).toHaveBeenCalledWith(expect.any(String));
  });

  it("displays mock training-data match results", async () => {
    render(<NewPredictionPage />);

    fireEvent.change(screen.getByLabelText(/Molecule SMILES/i), {
      target: { value: "CCO" },
    });
    fireEvent.change(screen.getByLabelText(/Solvent SMILES/i), {
      target: { value: "O" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Check training-data match/i }));

    expect(await screen.findByLabelText("Training-data match result")).toBeInTheDocument();
    expect(screen.getByText("Exact molecule-solvent pair found in training data.")).toBeInTheDocument();
    expect(screen.getByText("100%")).toBeInTheDocument();
  });

  it("automatically submits to Slurm after a successful NIBI upload", async () => {
    const handleJobChange = vi.fn();
    render(
      <NewPredictionPage
        manualMfaSession={{
          status: "authenticated",
          message: "Ready",
          can_run_background_commands: true,
        }}
        nibiSettings={{
          connection_mode: "interactive_mfa",
          backend_mode: "nibi",
          manual_mfa_provider: "persistent_shell",
          manual_mfa_ssh_backend: "wsl",
          manual_mfa_wsl_distro: "Ubuntu",
          nibi_username: "alice",
          normal_login_host: "nibi.alliancecan.ca",
          robot_login_host: "robot.nibi.alliancecan.ca",
          robot_key_restriction_from: "134.153.150.*",
          robot_key_forced_command: "/allowed_commands.sh",
          nibi_host: "nibi.alliancecan.ca",
          ssh_private_key_path: "C:\\Users\\Alice\\.ssh\\fluorcast_nibi_ed25519",
          wsl_ssh_private_key_path: "$HOME/.ssh/fluorcast_nibi_ed25519",
          wsl_control_socket_path: "$HOME/.fluorcast/ssh/cm-alice-nibi.sock",
          ssh_key_path: "C:\\Users\\Alice\\.ssh\\fluorcast_nibi_ed25519",
          remote_project_path: "/home/alice/scratch/FluorCast",
          remote_jobs_path: "/home/alice/scratch/fluorcast-jobs",
          python_environment_path: "/home/alice/scratch/FluorCast/.venv/bin/python",
          default_model_choice: "all",
          manual_login_verified: true,
          robot_access_verified: false,
          last_manual_login_check_at: "",
          manual_ssh_login_confirmed: true,
        }}
        onJobChange={handleJobChange}
      />,
    );

    fireEvent.change(screen.getByLabelText(/Molecule SMILES/i), {
      target: { value: "CCO" },
    });
    fireEvent.change(screen.getByLabelText(/Solvent SMILES/i), {
      target: { value: "O" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Submit to NIBI/i }));

    expect(await screen.findByText("Slurm job 123456 submitted.")).toBeInTheDocument();
    expect(handleJobChange).toHaveBeenCalledWith(expect.objectContaining({
      status: "submitted_to_slurm",
      remote_slurm_id: "123456",
    }));
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("run_nibi_remote_command", expect.objectContaining({
      commandSpec: expect.objectContaining({
        executable: "sbatch",
        args: expect.arrayContaining(["--parsable"]),
      }),
    }));
  });

  it("ignores three rapid Submit to NIBI clicks and submits exactly one Slurm job", async () => {
    render(
      <NewPredictionPage
        manualMfaSession={{
          status: "authenticated",
          message: "Ready",
          can_run_background_commands: true,
        }}
        nibiSettings={{
          connection_mode: "interactive_mfa",
          backend_mode: "nibi",
          manual_mfa_provider: "persistent_shell",
          manual_mfa_ssh_backend: "wsl",
          manual_mfa_wsl_distro: "Ubuntu",
          nibi_username: "alice",
          normal_login_host: "nibi.alliancecan.ca",
          robot_login_host: "robot.nibi.alliancecan.ca",
          robot_key_restriction_from: "134.153.150.*",
          robot_key_forced_command: "/allowed_commands.sh",
          nibi_host: "nibi.alliancecan.ca",
          ssh_private_key_path: "C:\\Users\\Alice\\.ssh\\fluorcast_nibi_ed25519",
          wsl_ssh_private_key_path: "$HOME/.ssh/fluorcast_nibi_ed25519",
          wsl_control_socket_path: "$HOME/.fluorcast/ssh/cm-alice-nibi.sock",
          ssh_key_path: "C:\\Users\\Alice\\.ssh\\fluorcast_nibi_ed25519",
          remote_project_path: "/home/alice/scratch/FluorCast",
          remote_jobs_path: "/home/alice/scratch/fluorcast-jobs",
          python_environment_path: "/home/alice/scratch/FluorCast/.venv/bin/python",
          default_model_choice: "all",
          manual_login_verified: true,
          robot_access_verified: false,
          last_manual_login_check_at: "",
          manual_ssh_login_confirmed: true,
        }}
      />,
    );

    fireEvent.change(screen.getByLabelText(/Molecule SMILES/i), {
      target: { value: "CCO" },
    });
    fireEvent.change(screen.getByLabelText(/Solvent SMILES/i), {
      target: { value: "O" },
    });
    const button = screen.getByRole("button", { name: /Submit to NIBI/i });
    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.click(button);

    expect(await screen.findByText("Slurm job 123456 submitted.")).toBeInTheDocument();
    const sbatchCalls = vi.mocked(invoke).mock.calls.filter(([command, args]) => (
      command === "run_nibi_remote_command"
      && (args as { commandSpec?: { executable?: string } } | undefined)?.commandSpec?.executable === "sbatch"
    ));
    expect(sbatchCalls).toHaveLength(1);
  });

  it("legacy terminal-action Manual MFA settings still require an authenticated session", async () => {
    const handleJobChange = vi.fn();
    render(
      <NewPredictionPage
        nibiSettings={{
          connection_mode: "interactive_mfa",
          backend_mode: "nibi",
          manual_mfa_provider: "terminal_action",
          manual_mfa_ssh_backend: "wsl",
          manual_mfa_wsl_distro: "Ubuntu",
          nibi_username: "alice",
          normal_login_host: "nibi.alliancecan.ca",
          robot_login_host: "robot.nibi.alliancecan.ca",
          robot_key_restriction_from: "134.153.150.*",
          robot_key_forced_command: "/allowed_commands.sh",
          nibi_host: "nibi.alliancecan.ca",
          ssh_private_key_path: "C:\\Users\\Alice\\.ssh\\fluorcast_nibi_ed25519",
          wsl_ssh_private_key_path: "$HOME/.ssh/fluorcast_nibi_ed25519",
          wsl_control_socket_path: "$HOME/.fluorcast/ssh/cm-alice-nibi.sock",
          ssh_key_path: "C:\\Users\\Alice\\.ssh\\fluorcast_nibi_ed25519",
          remote_project_path: "/home/alice/scratch/FluorCast",
          remote_jobs_path: "/home/alice/scratch/fluorcast-jobs",
          python_environment_path: "/home/alice/scratch/FluorCast/.venv/bin/python",
          default_model_choice: "all",
          manual_login_verified: false,
          robot_access_verified: false,
          last_manual_login_check_at: "",
          manual_ssh_login_confirmed: false,
        } as unknown as typeof defaultNibiSettings}
        onJobChange={handleJobChange}
      />,
    );

    fireEvent.change(screen.getByLabelText(/Molecule SMILES/i), {
      target: { value: "CCO" },
    });
    fireEvent.change(screen.getByLabelText(/Solvent SMILES/i), {
      target: { value: "O" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Submit to NIBI/i }));

    expect(await screen.findAllByText("Log into NIBI first, then retry this action.")).toHaveLength(2);
    expect(handleJobChange).toHaveBeenCalledWith(expect.objectContaining({
      status: "login_required",
      molecule_smiles: "CCO",
      solvent_smiles: "O",
    }));
    const sbatchCalls = vi.mocked(invoke).mock.calls.filter(([command, args]) => (
      command === "run_nibi_remote_command"
      && (args as { commandSpec?: { executable?: string } } | undefined)?.commandSpec?.executable === "sbatch"
    ));
    expect(sbatchCalls).toHaveLength(0);
  });
});
