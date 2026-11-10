import type { Pool } from 'pg';
import { detectLoopSystem } from '@modules/loop-system/domain/loop-system';
import type { DiagnosticEventRow, DiagnosticEventWriter } from '../application/diagnostic-recorder';
import type {
  DiagnosticAiRow, DiagnosticCommandFacts, DiagnosticCountRow, DiagnosticDeviceFacts, DiagnosticEventTotal,
  DiagnosticJobRow, DiagnosticPatientFacts, DiagnosticReportStore, DiagnosticTimelineRow,
} from '../application/diagnostic-report';

const iso = (value: unknown): string | null => (value ? new Date(value as string).toISOString() : null);
const num = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));

/**
 * Reads for the report. Every query names its columns: no display name, base URL, token, amount, message or identifier
 * is selected, so none can reach the report by mistake. The one payload read (the newest loop status) stays in this
 * file: only the loop's kind and version come out of it.
 */
export class PostgresDiagnosticStore implements DiagnosticEventWriter, DiagnosticReportStore {
  constructor(
    private readonly pool: Pick<Pool, 'query'>,
    private readonly therapyTimezone: (patientId: string, atIso: string) => Promise<string | null> = async () => null,
  ) {}

  async writeDiagnosticEvents(rows: DiagnosticEventRow[]): Promise<void> {
    await this.pool.query(
      `INSERT INTO diagnostic_events (bucket_start, source, level, event, fields_key, fields, count, first_at, last_at, duration_ms_total, duration_ms_max)
       SELECT r.bucket_start, r.source, r.level, r.event, r.fields_key, r.fields, r.count, r.first_at, r.last_at, r.duration_ms_total, r.duration_ms_max
         FROM jsonb_to_recordset($1::jsonb) AS r(bucket_start timestamptz, source text, level text, event text, fields_key text, fields jsonb,
                                                 count integer, first_at timestamptz, last_at timestamptz, duration_ms_total bigint, duration_ms_max integer)
       ON CONFLICT (bucket_start, source, level, event, fields_key) DO UPDATE SET
         count = diagnostic_events.count + EXCLUDED.count,
         first_at = LEAST(diagnostic_events.first_at, EXCLUDED.first_at),
         last_at = GREATEST(diagnostic_events.last_at, EXCLUDED.last_at),
         duration_ms_total = COALESCE(diagnostic_events.duration_ms_total, 0) + EXCLUDED.duration_ms_total,
         duration_ms_max = GREATEST(diagnostic_events.duration_ms_max, EXCLUDED.duration_ms_max)`,
      [JSON.stringify(rows)],
    );
  }

  async deleteDiagnosticEventsBefore(cutoffIso: string): Promise<number> {
    return (await this.pool.query('DELETE FROM diagnostic_events WHERE last_at < $1::timestamptz', [cutoffIso])).rowCount ?? 0;
  }

  async newestMigration(): Promise<string | null> {
    return (await this.pool.query<{ version: string | null }>('SELECT max(version) AS version FROM schema_migrations')).rows[0]?.version ?? null;
  }

  async patients(): Promise<DiagnosticPatientFacts[]> {
    const rows = (await this.pool.query<{ id: string }>('SELECT id FROM patients ORDER BY created_at, id')).rows;
    const now = new Date().toISOString();
    return Promise.all(rows.map(async ({ id }) => {
      const source = (await this.pool.query(
        `SELECT enabled, (api_token_ciphertext IS NOT NULL) AS has_token, auth_mode, source_version, last_successful_observed_at, credentials_updated_at
           FROM sources WHERE patient_id = $1::uuid AND source_system = 'NIGHTSCOUT'
          ORDER BY (api_token_ciphertext IS NOT NULL) DESC, created_at DESC LIMIT 1`, [id],
      )).rows[0];
      const newest = (await this.pool.query<{ type: string; at: string }>(
        `SELECT type, max(occurred_at) AS at FROM events
          WHERE patient_id = $1::uuid AND occurred_at > now() - interval '14 days' GROUP BY type ORDER BY type`, [id],
      )).rows;
      const loop = (await this.pool.query<{ raw_payload: Record<string, unknown> | null }>(
        `SELECT raw_payload FROM source_records
          WHERE patient_id = $1::uuid AND record_type = 'DEVICE_STATUS' AND raw_payload ?| ARRAY['openaps', 'loop']
          ORDER BY occurred_at DESC LIMIT 1`, [id],
      )).rows[0];
      const system = detectLoopSystem(loop?.raw_payload ?? null);
      return {
        loop_kind: system.kind,
        loop_version: system.version,
        profile_timezone: await this.therapyTimezone(id, now).catch(() => null),
        source: source ? {
          enabled: source.enabled === true,
          has_token: source.has_token === true,
          auth_mode: source.auth_mode ?? null,
          version: source.source_version ?? null,
          last_observed_at: iso(source.last_successful_observed_at),
          credentials_updated_at: iso(source.credentials_updated_at),
        } : null,
        newest_by_type: newest.map((row) => ({ type: row.type, at: iso(row.at) as string })),
      };
    }));
  }

  async devices(): Promise<DiagnosticDeviceFacts> {
    const phones = (await this.pool.query(
      `SELECT platform, max(app_version) AS app_version, count(DISTINCT patient_id)::int AS patients, bool_or(active) AS active, max(last_seen_at) AS last_seen_at
         FROM patient_devices GROUP BY device_id, platform ORDER BY bool_or(active) DESC, max(last_seen_at) DESC, device_id LIMIT 30`,
    )).rows;
    const paired = (await this.pool.query(
      `SELECT count(*) FILTER (WHERE revoked_at IS NULL)::int AS active, count(*) FILTER (WHERE revoked_at IS NOT NULL)::int AS revoked,
              max(last_seen_at) FILTER (WHERE revoked_at IS NULL) AS newest_seen_at FROM devices`,
    )).rows[0];
    const watches = (await this.pool.query(
      `SELECT count(*) FILTER (WHERE revoked_at IS NULL)::int AS active, max(last_used_at) FILTER (WHERE revoked_at IS NULL) AS newest_used_at FROM watch_devices`,
    )).rows[0];
    return {
      phones: phones.map((row) => ({ platform: row.platform, app_version: row.app_version ?? null, patients: row.patients, active: row.active === true, last_seen_at: iso(row.last_seen_at) })),
      paired_devices: { active: paired?.active ?? 0, revoked: paired?.revoked ?? 0, newest_seen_at: iso(paired?.newest_seen_at) },
      watches: { active: watches?.active ?? 0, newest_used_at: iso(watches?.newest_used_at) },
    };
  }

  async pushFacts(since: string): Promise<{ outbox_open: number; outbox_errors: DiagnosticCountRow[]; notifications: DiagnosticCountRow[] }> {
    const open = (await this.pool.query<{ open: number }>('SELECT count(*)::int AS open FROM push_outbox WHERE completed_at IS NULL')).rows[0];
    const errors = (await this.pool.query<DiagnosticCountRow>(
      `SELECT last_error_code AS name, count(*)::int AS count FROM push_outbox
        WHERE last_error_code IS NOT NULL AND updated_at >= $1::timestamptz GROUP BY last_error_code ORDER BY count DESC LIMIT 20`, [since],
    )).rows;
    const notifications = (await this.pool.query<DiagnosticCountRow>(
      `SELECT notification_type || ':' || status AS name, count(*)::int AS count FROM push_notifications
        WHERE created_at >= $1::timestamptz GROUP BY notification_type, status ORDER BY count DESC LIMIT 30`, [since],
    )).rows;
    return { outbox_open: open?.open ?? 0, outbox_errors: errors, notifications };
  }

  async commands(since: string): Promise<DiagnosticCommandFacts> {
    const byStatus = (await this.pool.query<DiagnosticCountRow>(
      'SELECT status AS name, count(*)::int AS count FROM remote_commands WHERE authorized_at >= $1::timestamptz GROUP BY status ORDER BY count DESC', [since],
    )).rows;
    const recent = (await this.pool.query(
      `SELECT source, status, authorized_at, sent_at, answered_at, matched_at FROM remote_commands
        WHERE authorized_at >= $1::timestamptz ORDER BY authorized_at DESC LIMIT 15`, [since],
    )).rows;
    return {
      by_status: byStatus,
      recent: recent.map((row) => ({ source: row.source, status: row.status, authorized_at: iso(row.authorized_at) as string, sent_at: iso(row.sent_at), answered_at: iso(row.answered_at), matched_at: iso(row.matched_at) })),
    };
  }

  async ai(since: string): Promise<DiagnosticAiRow[]> {
    const rows = (await this.pool.query(
      `SELECT a.provider, a.model, e.task_type, a.status, a.error_code, count(*)::int AS attempts,
              percentile_disc(0.5) WITHIN GROUP (ORDER BY a.provider_latency_ms) AS p50_ms,
              percentile_disc(0.95) WITHIN GROUP (ORDER BY a.provider_latency_ms) AS p95_ms,
              sum(a.total_tokens) AS tokens
         FROM ai_execution_attempts a JOIN ai_executions e ON e.id = a.ai_execution_id
        WHERE a.created_at >= $1::timestamptz
        GROUP BY a.provider, a.model, e.task_type, a.status, a.error_code ORDER BY attempts DESC LIMIT 40`, [since],
    )).rows;
    return rows.map((row) => ({
      provider: row.provider, model: row.model, task_type: row.task_type, status: row.status, error_code: row.error_code ?? null,
      attempts: row.attempts, p50_ms: num(row.p50_ms), p95_ms: num(row.p95_ms), tokens: num(row.tokens),
    }));
  }

  async jobs(since: string): Promise<DiagnosticJobRow[]> {
    const rows = (await this.pool.query(
      `SELECT job_type, status, count(*)::int AS count, min(created_at) AS oldest_at, max(attempts) AS max_attempts FROM jobs
        WHERE created_at >= $1::timestamptz OR (completed_at IS NULL AND failed_at IS NULL)
        GROUP BY job_type, status ORDER BY count DESC LIMIT 40`, [since],
    )).rows;
    return rows.map((row) => ({ job_type: row.job_type, status: row.status, count: row.count, oldest_at: iso(row.oldest_at), max_attempts: num(row.max_attempts) }));
  }

  async eventTotals(since: string): Promise<DiagnosticEventTotal[]> {
    const rows = (await this.pool.query(
      `SELECT level, event, sum(count)::int AS count, max(last_at) AS last_at FROM diagnostic_events
        WHERE last_at >= $1::timestamptz GROUP BY level, event
        ORDER BY CASE level WHEN 'error' THEN 0 WHEN 'warn' THEN 1 ELSE 2 END, count DESC LIMIT 120`, [since],
    )).rows;
    return rows.map((row) => ({ level: row.level, event: row.event, count: row.count, last_at: iso(row.last_at) as string }));
  }

  async timeline(problemsSince: string, recentSince: string, limit: number): Promise<DiagnosticTimelineRow[]> {
    const rows = (await this.pool.query(
      `SELECT source, level, event, fields, count, first_at, last_at, duration_ms_max FROM diagnostic_events
        WHERE (level IN ('warn', 'error') AND last_at >= $1::timestamptz) OR last_at >= $2::timestamptz
        ORDER BY last_at DESC LIMIT $3::int`, [problemsSince, recentSince, limit],
    )).rows;
    return rows.map((row) => ({
      source: row.source, level: row.level, event: row.event, fields: row.fields ?? {}, count: row.count,
      first_at: iso(row.first_at) as string, last_at: iso(row.last_at) as string, duration_ms_max: num(row.duration_ms_max),
    }));
  }
}
