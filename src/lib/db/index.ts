import Database from "@tauri-apps/plugin-sql";
import { createMockPredictionOutput } from "../mock";
import {
  validatePredictionJobInput,
  validatePredictionJobOutput,
  type PredictionJobOutput,
} from "../schemas";
import type { StoredPredictionJob, StoredJobStatus } from "../../features/jobs";

export const DATABASE_PATH = "sqlite:fluorcast.db";

type SqlDatabase = {
  execute(query: string, bindValues?: unknown[]): Promise<unknown>;
  select<T>(query: string, bindValues?: unknown[]): Promise<T>;
};

type SettingsRow = {
  key: string;
  value: string;
};

type JobRow = {
  id: string;
  molecule_smiles: string;
  solvent_smiles: string;
  model_choice: string;
  status: StoredJobStatus;
  local_created_at: string;
  local_completed_at: string | null;
  remote_slurm_id: string | null;
  remote_job_dir: string | null;
  remote_input_path: string | null;
  remote_output_path: string | null;
  submission_id?: string | null;
  submitted_at: string | null;
  slurm_state?: string | null;
  slurm_exit_code?: string | null;
  slurm_stdout?: string | null;
  slurm_stderr?: string | null;
  submitted_command?: string | null;
  error_message: string | null;
};

type ResultRow = {
  job_id: string;
  output_json: string;
  downloaded_at: string;
};

type CountRow = {
  count: number;
};

type TableExistsRow = {
  name: string;
};

type TableColumnRow = {
  name: string;
};

type LatestJobRow = {
  id: string;
  status: StoredJobStatus;
};

export type DiagnosticJobSummary = {
  id: string;
  status: StoredJobStatus;
  local_created_at: string;
  local_completed_at: string | null;
};

export type DiagnosticResultSummary = {
  job_id: string;
  output_json_length: number;
  downloaded_at: string;
};

export type DatabaseDiagnostics = {
  databaseUrl: string;
  initializedSuccessfully: boolean;
  tables: {
    jobs: boolean;
    results: boolean;
    job_events: boolean;
    settings: boolean;
  };
  jobsCount: number;
  resultsCount: number;
  latestJobId: string | null;
  latestJobStatus: StoredJobStatus | null;
  latestResultJobId: string | null;
  latestOutputJsonLength: number | null;
  latestOutputJsonParsesAsJson: boolean | null;
  latestOutputJsonValidates: boolean | null;
  recentJobs: DiagnosticJobSummary[];
  recentResults: DiagnosticResultSummary[];
  errors: string[];
};

export type PersistenceProbeResult = {
  pass: boolean;
  jobId: string;
  savedResult: boolean;
  updatedCompleted: boolean;
  loadedJob: boolean;
  loadedResult: boolean;
  outputValidates: boolean;
  error?: string;
};

export type PersistedPredictionJob = StoredPredictionJob & {
  remote_slurm_id?: string;
  remote_job_dir?: string;
};

export type JobWithResult = PersistedPredictionJob & {
  output?: PredictionJobOutput;
};

let databasePromise: Promise<SqlDatabase | null> | null = null;

function devLog(message: string, details?: unknown) {
  if (import.meta.env.DEV && import.meta.env.MODE !== "test") {
    console.info(`[FluorCast DB] ${message}`, details ?? "");
  }
}

function isTauriRuntime() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

async function getOpenDatabase(): Promise<SqlDatabase | null> {
  if (!isTauriRuntime()) {
    return null;
  }

  databasePromise ??= Database.load(DATABASE_PATH);
  return databasePromise;
}

function getRowsAffected(result: unknown): number | undefined {
  if (typeof result !== "object" || result === null || !("rowsAffected" in result)) {
    return undefined;
  }
  const rowsAffected = (result as { rowsAffected?: unknown }).rowsAffected;
  return typeof rowsAffected === "number" ? rowsAffected : undefined;
}

async function tableExists(db: SqlDatabase, tableName: string): Promise<boolean> {
  const rows = await db.select<TableExistsRow[]>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = $1 LIMIT 1",
    [tableName],
  );
  return rows.length > 0;
}

async function columnExists(db: SqlDatabase, tableName: string, columnName: string): Promise<boolean> {
  const rows = await db.select<TableColumnRow[]>(`PRAGMA table_info(${tableName})`);
  return rows.some((row) => row.name === columnName);
}

async function addColumnIfMissing(db: SqlDatabase, tableName: string, columnName: string, definition: string) {
  if (!await columnExists(db, tableName, columnName)) {
    await db.execute(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  }
}

async function rowCount(db: SqlDatabase, tableName: string): Promise<number> {
  const rows = await db.select<CountRow[]>(`SELECT COUNT(*) AS count FROM ${tableName}`);
  return rows[0]?.count ?? 0;
}

export function createDatabaseRepository(openDatabase: () => Promise<SqlDatabase | null>) {
  return {
    async initializeDatabase(): Promise<boolean> {
      const db = await openDatabase();
      if (!db) {
        return false;
      }

      devLog("initializing database", DATABASE_PATH);
      await db.execute(`
        CREATE TABLE IF NOT EXISTS settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        )
      `);
      await db.execute(`
        CREATE TABLE IF NOT EXISTS jobs (
          id TEXT PRIMARY KEY,
          molecule_smiles TEXT NOT NULL,
          solvent_smiles TEXT NOT NULL,
          model_choice TEXT NOT NULL,
          status TEXT NOT NULL,
          local_created_at TEXT NOT NULL,
          local_completed_at TEXT,
          remote_slurm_id TEXT,
          remote_job_dir TEXT,
          remote_input_path TEXT,
          remote_output_path TEXT,
          submission_id TEXT UNIQUE,
          submitted_at TEXT,
          slurm_state TEXT,
          slurm_exit_code TEXT,
          slurm_stdout TEXT,
          slurm_stderr TEXT,
          submitted_command TEXT,
          error_message TEXT
        )
      `);
      await addColumnIfMissing(db, "jobs", "remote_input_path", "TEXT");
      await addColumnIfMissing(db, "jobs", "remote_output_path", "TEXT");
      await addColumnIfMissing(db, "jobs", "submission_id", "TEXT");
      await addColumnIfMissing(db, "jobs", "submitted_at", "TEXT");
      await addColumnIfMissing(db, "jobs", "slurm_state", "TEXT");
      await addColumnIfMissing(db, "jobs", "slurm_exit_code", "TEXT");
      await addColumnIfMissing(db, "jobs", "slurm_stdout", "TEXT");
      await addColumnIfMissing(db, "jobs", "slurm_stderr", "TEXT");
      await addColumnIfMissing(db, "jobs", "submitted_command", "TEXT");
      await db.execute(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_submission_id
        ON jobs(submission_id)
        WHERE submission_id IS NOT NULL
      `);
      await db.execute(`
        CREATE TABLE IF NOT EXISTS results (
          job_id TEXT PRIMARY KEY,
          output_json TEXT NOT NULL,
          downloaded_at TEXT NOT NULL
        )
      `);
      await db.execute(`
        CREATE TABLE IF NOT EXISTS job_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          job_id TEXT NOT NULL,
          event_type TEXT NOT NULL,
          message TEXT,
          created_at TEXT NOT NULL
        )
      `);

      return true;
    },

    async saveSetting(key: string, value: string): Promise<boolean> {
      const db = await openDatabase();
      if (!db) {
        return false;
      }

      const result = await db.execute(
        `
          INSERT INTO settings (key, value)
          VALUES ($1, $2)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value
        `,
        [key, value],
      );
      devLog("saveSetting", { key, rowsAffected: getRowsAffected(result) });
      return true;
    },

    async getSetting(key: string): Promise<string | null> {
      const db = await openDatabase();
      if (!db) {
        return null;
      }

      const rows = await db.select<SettingsRow[]>(
        "SELECT key, value FROM settings WHERE key = $1 LIMIT 1",
        [key],
      );
      return rows[0]?.value ?? null;
    },

    async saveJob(job: PersistedPredictionJob): Promise<boolean> {
      const db = await openDatabase();
      if (!db) {
        return false;
      }

      devLog("saveJob", { jobId: job.id, status: job.status });
      const result = await db.execute(
        `
          INSERT INTO jobs (
            id,
            molecule_smiles,
            solvent_smiles,
            model_choice,
            status,
            local_created_at,
            local_completed_at,
            remote_slurm_id,
            remote_job_dir,
            remote_input_path,
            remote_output_path,
            submission_id,
            submitted_at,
            slurm_state,
            slurm_exit_code,
            slurm_stdout,
            slurm_stderr,
            submitted_command,
            error_message
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
          ON CONFLICT(id) DO UPDATE SET
            molecule_smiles = excluded.molecule_smiles,
            solvent_smiles = excluded.solvent_smiles,
            model_choice = excluded.model_choice,
            status = excluded.status,
            local_created_at = excluded.local_created_at,
            local_completed_at = excluded.local_completed_at,
            remote_slurm_id = excluded.remote_slurm_id,
            remote_job_dir = excluded.remote_job_dir,
            remote_input_path = excluded.remote_input_path,
            remote_output_path = excluded.remote_output_path,
            submission_id = COALESCE(jobs.submission_id, excluded.submission_id),
            submitted_at = excluded.submitted_at,
            slurm_state = excluded.slurm_state,
            slurm_exit_code = excluded.slurm_exit_code,
            slurm_stdout = excluded.slurm_stdout,
            slurm_stderr = excluded.slurm_stderr,
            submitted_command = excluded.submitted_command,
            error_message = excluded.error_message
        `,
        [
          job.id,
          job.molecule_smiles,
          job.solvent_smiles,
          job.model_choice,
          job.status,
          job.created_at,
          job.completed_at ?? null,
          job.remote_slurm_id ?? null,
          job.remote_job_dir ?? null,
          job.remote_input_path ?? null,
          job.remote_output_path ?? null,
          job.submission_id ?? job.id,
          job.submitted_at ?? null,
          job.slurm_state ?? null,
          job.slurm_exit_code ?? null,
          job.slurm_stdout ?? null,
          job.slurm_stderr ?? null,
          job.submitted_command ?? null,
          job.error_message ?? null,
        ],
      );
      devLog("saveJob complete", { jobId: job.id, rowsAffected: getRowsAffected(result) });
      return true;
    },

    async updateJobStatus(
      jobId: string,
      status: StoredJobStatus,
      options: {
        completedAt?: string;
        remoteSlurmId?: string;
        remoteJobDir?: string;
        remoteInputPath?: string;
        remoteOutputPath?: string;
        submissionId?: string;
        submittedAt?: string;
        slurmState?: string;
        slurmExitCode?: string;
        slurmStdout?: string;
        slurmStderr?: string;
        submittedCommand?: string;
        errorMessage?: string;
      } = {},
    ): Promise<boolean> {
      const db = await openDatabase();
      if (!db) {
        return false;
      }

      devLog("updateJobStatus", { jobId, status });
      const result = await db.execute(
        `
          UPDATE jobs
          SET
            status = $1,
            local_completed_at = COALESCE($2, local_completed_at),
            remote_slurm_id = COALESCE($3, remote_slurm_id),
            remote_job_dir = COALESCE($4, remote_job_dir),
            remote_input_path = COALESCE($5, remote_input_path),
            remote_output_path = COALESCE($6, remote_output_path),
            submission_id = COALESCE($7, submission_id),
            submitted_at = COALESCE($8, submitted_at),
            slurm_state = COALESCE($9, slurm_state),
            slurm_exit_code = COALESCE($10, slurm_exit_code),
            slurm_stdout = COALESCE($11, slurm_stdout),
            slurm_stderr = COALESCE($12, slurm_stderr),
            submitted_command = COALESCE($13, submitted_command),
            error_message = $14
          WHERE id = $15
        `,
        [
          status,
          options.completedAt ?? null,
          options.remoteSlurmId ?? null,
          options.remoteJobDir ?? null,
          options.remoteInputPath ?? null,
          options.remoteOutputPath ?? null,
          options.submissionId ?? null,
          options.submittedAt ?? null,
          options.slurmState ?? null,
          options.slurmExitCode ?? null,
          options.slurmStdout ?? null,
          options.slurmStderr ?? null,
          options.submittedCommand ?? null,
          options.errorMessage ?? null,
          jobId,
        ],
      );
      devLog("updateJobStatus complete", { jobId, status, rowsAffected: getRowsAffected(result) });
      return true;
    },

    async saveResult(
      jobId: string,
      output: PredictionJobOutput,
      downloadedAt = new Date().toISOString(),
    ): Promise<boolean> {
      const db = await openDatabase();
      if (!db) {
        return false;
      }

      const outputJson = serializePredictionResult(output);
      devLog("saveResult", { jobId, outputJsonLength: outputJson.length });
      const result = await db.execute(
        `
          INSERT INTO results (job_id, output_json, downloaded_at)
          VALUES ($1, $2, $3)
          ON CONFLICT(job_id) DO UPDATE SET
            output_json = excluded.output_json,
            downloaded_at = excluded.downloaded_at
        `,
        [jobId, outputJson, downloadedAt],
      );
      devLog("saveResult complete", { jobId, rowsAffected: getRowsAffected(result) });
      return true;
    },

    async listJobs(): Promise<PersistedPredictionJob[]> {
      const db = await openDatabase();
      if (!db) {
        return [];
      }

      const rows = await db.select<JobRow[]>(`
        SELECT
          id,
          molecule_smiles,
          solvent_smiles,
          model_choice,
          status,
          local_created_at,
          local_completed_at,
          remote_slurm_id,
          remote_job_dir,
          remote_input_path,
          remote_output_path,
          submission_id,
          submitted_at,
          slurm_state,
          slurm_exit_code,
          slurm_stdout,
          slurm_stderr,
          submitted_command,
          error_message
        FROM jobs
        ORDER BY local_created_at DESC
      `);
      devLog("listJobs", { count: rows.length });
      return rows.map(jobRowToStoredJob);
    },

    async getJobWithResult(jobId: string): Promise<JobWithResult | null> {
      const db = await openDatabase();
      if (!db) {
        return null;
      }

      const rows = await db.select<(JobRow & Partial<ResultRow>)[]>(
        `
          SELECT
            jobs.id,
            jobs.molecule_smiles,
            jobs.solvent_smiles,
            jobs.model_choice,
            jobs.status,
            jobs.local_created_at,
            jobs.local_completed_at,
            jobs.remote_slurm_id,
            jobs.remote_job_dir,
            jobs.remote_input_path,
            jobs.remote_output_path,
            jobs.submission_id,
            jobs.submitted_at,
            jobs.slurm_state,
            jobs.slurm_exit_code,
            jobs.slurm_stdout,
            jobs.slurm_stderr,
            jobs.submitted_command,
            jobs.error_message,
            results.job_id,
            results.output_json,
            results.downloaded_at
          FROM jobs
          LEFT JOIN results ON results.job_id = jobs.id
          WHERE jobs.id = $1
          LIMIT 1
        `,
        [jobId],
      );

      const row = rows[0];
      if (!row) {
        devLog("getJobWithResult", { jobId, foundJob: false, foundResult: false });
        return null;
      }

      devLog("getJobWithResult", {
        jobId,
        foundJob: true,
        foundResult: Boolean(row.output_json),
      });
      return {
        ...jobRowToStoredJob(row),
        ...(row.output_json ? { output: parsePredictionResult(row.output_json) } : {}),
      };
    },

    async addJobEvent(
      jobId: string,
      eventType: string,
      message?: string,
      createdAt = new Date().toISOString(),
    ): Promise<boolean> {
      const db = await openDatabase();
      if (!db) {
        return false;
      }

      await db.execute(
        `
          INSERT INTO job_events (job_id, event_type, message, created_at)
          VALUES ($1, $2, $3, $4)
        `,
        [jobId, eventType, message ?? null, createdAt],
      );
      return true;
    },

    async getDatabaseDiagnostics(): Promise<DatabaseDiagnostics> {
      const diagnostics: DatabaseDiagnostics = {
        databaseUrl: DATABASE_PATH,
        initializedSuccessfully: false,
        tables: {
          jobs: false,
          results: false,
          job_events: false,
          settings: false,
        },
        jobsCount: 0,
        resultsCount: 0,
        latestJobId: null,
        latestJobStatus: null,
        latestResultJobId: null,
        latestOutputJsonLength: null,
        latestOutputJsonParsesAsJson: null,
        latestOutputJsonValidates: null,
        recentJobs: [],
        recentResults: [],
        errors: [],
      };

      const db = await openDatabase();
      if (!db) {
        diagnostics.errors.push("Database is not available outside the Tauri runtime.");
        return diagnostics;
      }

      try {
        diagnostics.initializedSuccessfully = await this.initializeDatabase();
        diagnostics.tables = {
          jobs: await tableExists(db, "jobs"),
          results: await tableExists(db, "results"),
          job_events: await tableExists(db, "job_events"),
          settings: await tableExists(db, "settings"),
        };

        if (diagnostics.tables.jobs) {
          diagnostics.jobsCount = await rowCount(db, "jobs");
          const latestJobs = await db.select<LatestJobRow[]>(
            "SELECT id, status FROM jobs ORDER BY local_created_at DESC LIMIT 1",
          );
          diagnostics.latestJobId = latestJobs[0]?.id ?? null;
          diagnostics.latestJobStatus = latestJobs[0]?.status ?? null;
          diagnostics.recentJobs = await db.select<DiagnosticJobSummary[]>(`
            SELECT id, status, local_created_at, local_completed_at
            FROM jobs
            ORDER BY local_created_at DESC
            LIMIT 5
          `);
        }

        if (diagnostics.tables.results) {
          diagnostics.resultsCount = await rowCount(db, "results");
          const latestResults = await db.select<(ResultRow & { output_json_length: number })[]>(`
            SELECT job_id, output_json, downloaded_at, LENGTH(output_json) AS output_json_length
            FROM results
            ORDER BY downloaded_at DESC
            LIMIT 1
          `);
          const latestResult = latestResults[0];
          diagnostics.latestResultJobId = latestResult?.job_id ?? null;
          diagnostics.latestOutputJsonLength = latestResult?.output_json_length ?? null;

          if (latestResult?.output_json) {
            try {
              JSON.parse(latestResult.output_json);
              diagnostics.latestOutputJsonParsesAsJson = true;
            } catch {
              diagnostics.latestOutputJsonParsesAsJson = false;
            }

            try {
              parsePredictionResult(latestResult.output_json);
              diagnostics.latestOutputJsonValidates = true;
            } catch {
              diagnostics.latestOutputJsonValidates = false;
            }
          }

          diagnostics.recentResults = await db.select<DiagnosticResultSummary[]>(`
            SELECT job_id, LENGTH(output_json) AS output_json_length, downloaded_at
            FROM results
            ORDER BY downloaded_at DESC
            LIMIT 5
          `);
        }
      } catch (error) {
        diagnostics.errors.push(error instanceof Error ? error.message : "Diagnostics failed.");
      }

      return diagnostics;
    },

    async createMockPersistenceProbe(): Promise<PersistenceProbeResult> {
      const now = new Date();
      const jobId = `persistence_probe_${now.getTime()}`;
      const createdAt = now.toISOString();

      try {
        const input = validatePredictionJobInput({
          job_id: jobId,
          user_id: "local_user",
          molecule_smiles: "CCO",
          solvent_smiles: "O",
          model_choice: "all",
          requested_at: createdAt,
        });
        const output = createMockPredictionOutput(input);
        const job: PersistedPredictionJob = {
          id: jobId,
          molecule_smiles: input.molecule_smiles,
          solvent_smiles: input.solvent_smiles,
          model_choice: input.model_choice,
          status: "queued_locally",
          created_at: createdAt,
        };

        await this.saveJob(job);
        const savedResult = await this.saveResult(jobId, output, output.completed_at);
        if (!savedResult) {
          await this.updateJobStatus(jobId, "failed", {
            completedAt: new Date().toISOString(),
            errorMessage: "Persistence probe could not save a result row.",
          });
          return {
            pass: false,
            jobId,
            savedResult: false,
            updatedCompleted: false,
            loadedJob: false,
            loadedResult: false,
            outputValidates: false,
            error: "saveResult returned false.",
          };
        }

        const updatedCompleted = await this.updateJobStatus(jobId, "completed", {
          completedAt: output.completed_at,
        });
        await this.addJobEvent(jobId, "completed", "Persistence probe completed.", output.completed_at);
        const loaded = await this.getJobWithResult(jobId);

        return {
          pass: Boolean(updatedCompleted && loaded?.output && loaded.output.job_id === jobId),
          jobId,
          savedResult,
          updatedCompleted,
          loadedJob: Boolean(loaded),
          loadedResult: Boolean(loaded?.output),
          outputValidates: Boolean(loaded?.output),
        };
      } catch (error) {
        try {
          await this.updateJobStatus(jobId, "failed", {
            completedAt: new Date().toISOString(),
            errorMessage: error instanceof Error ? error.message : "Persistence probe failed.",
          });
        } catch {
          // The original probe error is more useful than a cleanup failure.
        }

        return {
          pass: false,
          jobId,
          savedResult: false,
          updatedCompleted: false,
          loadedJob: false,
          loadedResult: false,
          outputValidates: false,
          error: error instanceof Error ? error.message : "Persistence probe failed.",
        };
      }
    },
  };
}

const databaseRepository = createDatabaseRepository(getOpenDatabase);

export function jobRowToStoredJob(row: JobRow): PersistedPredictionJob {
  return {
    id: row.id,
    molecule_smiles: row.molecule_smiles,
    solvent_smiles: row.solvent_smiles,
    model_choice: row.model_choice,
    status: row.status,
    created_at: row.local_created_at,
    ...(row.local_completed_at ? { completed_at: row.local_completed_at } : {}),
    ...(row.remote_slurm_id ? { remote_slurm_id: row.remote_slurm_id } : {}),
    ...(row.remote_job_dir ? { remote_job_dir: row.remote_job_dir } : {}),
    ...(row.remote_input_path ? { remote_input_path: row.remote_input_path } : {}),
    ...(row.remote_output_path ? { remote_output_path: row.remote_output_path } : {}),
    ...(row.submission_id ? { submission_id: row.submission_id } : {}),
    ...(row.submitted_at ? { submitted_at: row.submitted_at } : {}),
    ...(row.slurm_state ? { slurm_state: row.slurm_state } : {}),
    ...(row.slurm_exit_code ? { slurm_exit_code: row.slurm_exit_code } : {}),
    ...(row.slurm_stdout ? { slurm_stdout: row.slurm_stdout } : {}),
    ...(row.slurm_stderr ? { slurm_stderr: row.slurm_stderr } : {}),
    ...(row.submitted_command ? { submitted_command: row.submitted_command } : {}),
    ...(row.error_message ? { error_message: row.error_message } : {}),
  };
}

export function serializePredictionResult(output: PredictionJobOutput) {
  return JSON.stringify(output);
}

export function parsePredictionResult(outputJson: string): PredictionJobOutput {
  return validatePredictionJobOutput(JSON.parse(outputJson));
}

export async function initializeDatabase(): Promise<boolean> {
  return databaseRepository.initializeDatabase();
}

export async function saveSetting(key: string, value: string): Promise<boolean> {
  return databaseRepository.saveSetting(key, value);
}

export async function getSetting(key: string): Promise<string | null> {
  return databaseRepository.getSetting(key);
}

export async function saveJob(job: PersistedPredictionJob): Promise<boolean> {
  return databaseRepository.saveJob(job);
}

export async function updateJobStatus(
  jobId: string,
  status: StoredJobStatus,
  options: {
    completedAt?: string;
    remoteSlurmId?: string;
    remoteJobDir?: string;
    remoteInputPath?: string;
    remoteOutputPath?: string;
    submissionId?: string;
    submittedAt?: string;
    slurmState?: string;
    slurmExitCode?: string;
    slurmStdout?: string;
    slurmStderr?: string;
    submittedCommand?: string;
    errorMessage?: string;
  } = {},
): Promise<boolean> {
  return databaseRepository.updateJobStatus(jobId, status, options);
}

export async function saveResult(
  jobId: string,
  output: PredictionJobOutput,
  downloadedAt = new Date().toISOString(),
): Promise<boolean> {
  return databaseRepository.saveResult(jobId, output, downloadedAt);
}

export async function listJobs(): Promise<PersistedPredictionJob[]> {
  return databaseRepository.listJobs();
}

export async function getJobWithResult(jobId: string): Promise<JobWithResult | null> {
  return databaseRepository.getJobWithResult(jobId);
}

export async function addJobEvent(
  jobId: string,
  eventType: string,
  message?: string,
  createdAt = new Date().toISOString(),
): Promise<boolean> {
  return databaseRepository.addJobEvent(jobId, eventType, message, createdAt);
}

export async function getDatabaseDiagnostics(): Promise<DatabaseDiagnostics> {
  return databaseRepository.getDatabaseDiagnostics();
}

export async function createMockPersistenceProbe(): Promise<PersistenceProbeResult> {
  return databaseRepository.createMockPersistenceProbe();
}
