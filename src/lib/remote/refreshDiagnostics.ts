import type { StoredJobStatus } from "../../features/jobs";

export const MAX_REFRESH_TRACE_EVENTS = 100;

export type RefreshTraceStage =
  | "BUTTON_CLICKED"
  | "APP_CALLBACK_STARTED"
  | "COORDINATOR_REFRESH_REQUESTED"
  | "COORDINATOR_REFRESH_COALESCED"
  | "COORDINATOR_EXECUTOR_STARTED"
  | "SESSION_STATE_BEFORE"
  | "SESSION_GENERATION"
  | "SESSION_CHECK_STARTED"
  | "SESSION_CHECK_EXIT_CODE"
  | "SESSION_CHECK_STDOUT"
  | "SESSION_CHECK_STDERR"
  | "SESSION_AUTH_MARKER_FOUND"
  | "SQUEUE_STARTED"
  | "SQUEUE_EXIT_CODE"
  | "SQUEUE_STDOUT"
  | "SQUEUE_STDERR"
  | "SQUEUE_CLASSIFICATION"
  | "SQUEUE_MATCH_FOUND"
  | "SACCT_FALLBACK_STARTED"
  | "SACCT_STARTED"
  | "SACCT_EXIT_CODE"
  | "SACCT_STDOUT"
  | "SACCT_STDERR"
  | "SACCT_PARENT_STATE"
  | "SACCT_PARENT_EXIT_CODE"
  | "OUTPUT_CHECK_STARTED"
  | "OUTPUT_EXISTS"
  | "OUTPUT_SIZE"
  | "DOWNLOAD_STARTED"
  | "DOWNLOAD_EXIT_CODE"
  | "REMOTE_SCHEMA_STATUS"
  | "ADAPTER_STATUS"
  | "PERSISTENCE_STATUS"
  | "EXECUTOR_RETURNED_STATUS"
  | "APP_RECEIVED_STATUS"
  | "REDUCER_UPDATE_ATTEMPTED"
  | "REDUCER_UPDATE_APPLIED"
  | "FINAL_RENDERED_STATUS"
  | "GLOBAL_SESSION_STATE_CHANGED"
  | "ERROR_STAGE"
  | "ERROR_CLASS"
  | "ERROR_MESSAGE"
  | "ROW_STATUS_WRITE";

export type RefreshTraceEvent = {
  traceId: string;
  seq: number;
  timestamp: string;
  stage: RefreshTraceStage;
  localJobId?: string;
  slurmId?: string;
  remoteJobDir?: string;
  fields?: Record<string, string | number | boolean | null | undefined>;
};

export type BannerWriteTrace = {
  traceId: string;
  seq: number;
  timestamp: string;
  oldBannerState: string;
  newBannerState: string;
  writerFunction: string;
  writerFile: string;
  reason: string;
  sessionGeneration: number;
  relatedRefreshTraceId?: string;
};

export type RowStatusWriteTrace = {
  traceId: string;
  seq: number;
  timestamp: string;
  localJobId: string;
  oldStatus?: StoredJobStatus;
  newStatus: StoredJobStatus;
  writerFunction: string;
  reason: string;
  refreshTraceId?: string;
  pollGeneration?: number;
  appliedOrIgnored: "applied" | "ignored";
};

export type ManualRefreshTrace = {
  traceId: string;
  localJobId: string;
  slurmId?: string;
  remoteJobDir?: string;
  events: RefreshTraceEvent[];
  rowStatusWrites: RowStatusWriteTrace[];
};

let nextTraceOrdinal = 0;

export function createRefreshTraceId(now = Date.now()) {
  nextTraceOrdinal += 1;
  return `refresh-${now.toString(36)}-${nextTraceOrdinal.toString(36)}`;
}

function sanitizeString(value: string) {
  return value
    .replace(/(password|passwd|token|secret|credential|private[_ -]?key)(\s*[=:]\s*)[^\s'"\\]+/gi, "$1$2<redacted>")
    .replace(/-----BEGIN [^-]+PRIVATE KEY-----[\s\S]*?-----END [^-]+PRIVATE KEY-----/g, "<redacted-private-key>");
}

export function sanitizeDiagnosticValue(value: unknown): string | number | boolean | null | undefined {
  if (value === undefined || value === null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  return sanitizeString(String(value));
}

export function sanitizeDiagnosticFields(fields?: Record<string, unknown>) {
  if (!fields) return undefined;
  return Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [
      key,
      /(password|passwd|token|secret|credential|private[_ -]?key)/i.test(key)
        ? "<redacted>"
        : sanitizeDiagnosticValue(value),
    ]),
  );
}

export function formatRefreshDiagnosticsText(trace?: ManualRefreshTrace, banner?: BannerWriteTrace) {
  const lines: string[] = [];
  if (trace) {
    lines.push(`REFRESH_TRACE_ID=${trace.traceId}`);
    lines.push(`LOCAL_JOB_ID=${trace.localJobId}`);
    if (trace.slurmId) lines.push(`SLURM_ID=${trace.slurmId}`);
    if (trace.remoteJobDir) lines.push(`REMOTE_JOB_DIR=${trace.remoteJobDir}`);
    for (const event of trace.events) {
      lines.push(`${event.seq}. ${event.timestamp} ${event.stage}`);
      for (const [key, value] of Object.entries(event.fields ?? {})) {
        lines.push(`  ${key}=${value ?? ""}`);
      }
    }
    for (const write of trace.rowStatusWrites) {
      lines.push(`${write.seq}. ${write.timestamp} ROW_STATUS_WRITE`);
      lines.push(`  LOCAL_JOB_ID=${write.localJobId}`);
      lines.push(`  OLD_STATUS=${write.oldStatus ?? ""}`);
      lines.push(`  NEW_STATUS=${write.newStatus}`);
      lines.push(`  WRITER_FUNCTION=${write.writerFunction}`);
      lines.push(`  REASON=${write.reason}`);
      lines.push(`  REFRESH_TRACE_ID=${write.refreshTraceId ?? ""}`);
      lines.push(`  POLL_GENERATION=${write.pollGeneration ?? ""}`);
      lines.push(`  APPLIED_OR_IGNORED=${write.appliedOrIgnored}`);
    }
  }
  if (banner) {
    lines.push(`BANNER_WRITE_TRACE_ID=${banner.traceId}`);
    lines.push(`OLD_BANNER_STATE=${banner.oldBannerState}`);
    lines.push(`NEW_BANNER_STATE=${banner.newBannerState}`);
    lines.push(`WRITER_FUNCTION=${banner.writerFunction}`);
    lines.push(`WRITER_FILE=${banner.writerFile}`);
    lines.push(`REASON=${banner.reason}`);
    lines.push(`SESSION_GENERATION=${banner.sessionGeneration}`);
    lines.push(`RELATED_REFRESH_TRACE_ID=${banner.relatedRefreshTraceId ?? ""}`);
    lines.push(`TIMESTAMP=${banner.timestamp}`);
  }
  return lines.join("\n");
}
