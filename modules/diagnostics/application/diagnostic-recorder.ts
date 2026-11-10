import { allowedDiagnosticFields, type DiagnosticEvent, type DiagnosticLevel } from './diagnostic-events';

export const DIAGNOSTIC_BUCKET_MS = 10 * 60_000;
export const DIAGNOSTIC_FLUSH_INTERVAL_MS = 10_000;
export const DIAGNOSTIC_RETENTION_DAYS = 14;
const PRUNE_INTERVAL_MS = 60 * 60_000;
/** Distinct rows waiting for a write. A database that is down must not grow the process's memory. */
export const DIAGNOSTIC_MAX_PENDING = 500;

export interface DiagnosticEventRow {
  bucket_start: string;
  source: string;
  level: DiagnosticLevel;
  event: string;
  fields_key: string;
  fields: Record<string, unknown>;
  count: number;
  first_at: string;
  last_at: string;
  duration_ms_total: number | null;
  duration_ms_max: number | null;
}

export interface DiagnosticEventWriter {
  writeDiagnosticEvents(rows: DiagnosticEventRow[]): Promise<void>;
  deleteDiagnosticEventsBefore(cutoffIso: string): Promise<number>;
}

/**
 * Collects events in memory and writes them every ten seconds as ten-minute counts. Logging never waits for the database
 * and never fails because of it. Failures go to the console directly: through the logger they would be recorded again.
 */
export class DiagnosticRecorder {
  private pending = new Map<string, DiagnosticEventRow>();
  private writer: DiagnosticEventWriter | null = null;
  private source = 'server';
  private prunes = false;
  private lastPruneMs: number | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private flushing = false;

  record(event: DiagnosticEvent, now: Date = new Date()): void {
    const bucketMs = Math.floor(now.getTime() / DIAGNOSTIC_BUCKET_MS) * DIAGNOSTIC_BUCKET_MS;
    const bucket = new Date(bucketMs).toISOString();
    const at = now.toISOString();
    const fieldsKey = JSON.stringify(event.fields);
    const key = [bucket, event.level, event.event, fieldsKey].join('|');
    const row = this.pending.get(key);
    if (row) {
      merge(row, { count: 1, last_at: at, first_at: at, duration_ms_total: event.duration_ms, duration_ms_max: event.duration_ms });
      return;
    }
    if (this.pending.size >= DIAGNOSTIC_MAX_PENDING) return;
    this.pending.set(key, {
      bucket_start: bucket,
      source: this.source,
      level: event.level,
      event: event.event,
      fields_key: fieldsKey,
      fields: event.fields,
      count: 1,
      first_at: at,
      last_at: at,
      duration_ms_total: event.duration_ms,
      duration_ms_max: event.duration_ms,
    });
  }

  /** Starts writing (events recorded during start-up are kept and go out first). `prunes`: this process deletes old rows. */
  attach(writer: DiagnosticEventWriter, options: { source: string; prunes: boolean }): void {
    this.writer = writer;
    this.source = options.source;
    this.prunes = options.prunes;
    for (const row of this.pending.values()) row.source = options.source;
    this.timer = setInterval(() => { void this.flush(); }, DIAGNOSTIC_FLUSH_INTERVAL_MS);
    this.timer.unref?.();
    void this.flush();
  }

  async flush(now: Date = new Date()): Promise<void> {
    if (!this.writer || this.flushing) return;
    this.flushing = true;
    const rows = [...this.pending.entries()];
    this.pending = new Map();
    try {
      if (rows.length > 0) await this.writer.writeDiagnosticEvents(rows.map(([, row]) => row));
      await this.pruneIfDue(now);
    } catch (error) {
      // Kept for the next write: newer rows of the same key are merged, the size limit still applies.
      for (const [key, row] of rows) {
        const newer = this.pending.get(key);
        if (newer) merge(newer, row);
        else if (this.pending.size < DIAGNOSTIC_MAX_PENDING) this.pending.set(key, row);
      }
      console.warn(JSON.stringify({ event: 'diagnostic_events_write_failed', error: error instanceof Error ? error.name : 'UNKNOWN' }));
    } finally {
      this.flushing = false;
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async pruneIfDue(now: Date): Promise<void> {
    if (!this.prunes || !this.writer) return;
    if (this.lastPruneMs !== null && now.getTime() - this.lastPruneMs < PRUNE_INTERVAL_MS) return;
    this.lastPruneMs = now.getTime();
    await this.writer.deleteDiagnosticEventsBefore(new Date(now.getTime() - DIAGNOSTIC_RETENTION_DAYS * 24 * 3_600_000).toISOString());
  }
}

function merge(
  into: DiagnosticEventRow,
  other: Pick<DiagnosticEventRow, 'count' | 'first_at' | 'last_at' | 'duration_ms_total' | 'duration_ms_max'>,
): void {
  into.count += other.count;
  if (other.first_at < into.first_at) into.first_at = other.first_at;
  if (other.last_at > into.last_at) into.last_at = other.last_at;
  if (other.duration_ms_total !== null) into.duration_ms_total = (into.duration_ms_total ?? 0) + other.duration_ms_total;
  if (other.duration_ms_max !== null) into.duration_ms_max = Math.max(into.duration_ms_max ?? 0, other.duration_ms_max);
}

/** The one recorder of this process; nothing is written until main.ts attaches the database. */
export const diagnosticRecorder = new DiagnosticRecorder();

/** A failed API request: its route template, not its address, so no patient or meal id gets through. */
export function recordApiError(args: { route: unknown; method: unknown; status: number; code: string }): void {
  diagnosticRecorder.record({
    level: args.status >= 500 ? 'error' : 'warn',
    event: 'api_request_failed',
    fields: allowedDiagnosticFields({ route: args.route, method: args.method, status: args.status, code: args.code }),
    duration_ms: null,
  });
}
