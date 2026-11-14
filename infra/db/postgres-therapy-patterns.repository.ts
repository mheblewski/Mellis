import type { Pool } from 'pg';
import { detectLoopSystem } from '@modules/loop-system/domain/loop-system';
import { caregiverDeviceSql } from './sharing-access.sql';
import type { PatternId, PatternResult } from '@modules/therapy-patterns/application/pattern-detectors';
import type { PatternState } from '@modules/therapy-patterns/application/pattern-states';

/** Owners' active iOS phones of a patient (the weekly "Nowy wzorzec" push). */
export const OWNER_PUSH_DEVICES_SQL = `
  SELECT DISTINCT ON (d.push_token) d.device_id, d.push_token
  FROM patient_devices d
  WHERE d.patient_id = $1::uuid AND d.platform = 'ios' AND d.active = true AND d.user_id IS NOT NULL
    AND EXISTS (SELECT 1 FROM caregiver_relationships r WHERE r.user_id = d.user_id AND r.patient_id = d.patient_id AND r.is_owner)
  ORDER BY d.push_token, d.updated_at DESC
`;

/**
 * The night under 54 push (owner's decision 2026-11-12): caregivers with full access only — owners, and members allowed
 * both glucose alerts and the chat and meals (not someone who only views glucose, e.g. a teacher). One row per push
 * token, with whether that person is an owner (an owner's tap opens Wzorce; the others open the patient).
 */
export const CAREGIVER_NIGHT_PUSH_DEVICES_SQL = `
  SELECT DISTINCT ON (d.push_token) d.device_id, d.push_token,
    EXISTS (SELECT 1 FROM caregiver_relationships o WHERE o.user_id = d.user_id AND o.patient_id = d.patient_id AND o.is_owner) AS is_owner
  FROM patient_devices d
  WHERE d.patient_id = $1::uuid AND d.platform = 'ios' AND d.active = true
    AND ${caregiverDeviceSql('glucose_alerts')} AND ${caregiverDeviceSql('care')}
  ORDER BY d.push_token, d.updated_at DESC
`;

/** The nightly run's marker row (one per patient): not a pattern, never listed. */
export const PATTERN_RUN_KEY = '_run';
/** The morning check of last night (one row per local date, key NIGHT_54.<date>): not a pattern, never listed. */
export const NIGHT_CHECK_ID = 'NIGHT_54';

type Row = {
  pattern_key: string; pattern_id: string; shown: boolean; result: PatternResult; severity: number;
  first_shown_at: Date | null; last_shown_at: Date | null; computed_at: Date; notified_at: Date | null;
  notified_severity: number | null; dismissed_until: Date | null; revision: number; dismissed_by_name?: string | null;
};

const iso = (value: Date | null) => (value ? value.toISOString() : null);

function toState(row: Row): PatternState {
  return {
    pattern_key: row.pattern_key,
    pattern_id: row.pattern_id as PatternId,
    shown: row.shown,
    result: row.result,
    severity: Number(row.severity),
    first_shown_at: iso(row.first_shown_at),
    last_shown_at: iso(row.last_shown_at),
    computed_at: row.computed_at.toISOString(),
    notified_at: iso(row.notified_at),
    notified_severity: row.notified_severity === null ? null : Number(row.notified_severity),
    dismissed_until: iso(row.dismissed_until),
    revision: row.revision,
    dismissed_by: row.dismissed_by_name ?? null,
  };
}

/** "Wzorce" (therapy-patterns.v1, family migration 920). */
export class PostgresTherapyPatternsRepository {
  constructor(private readonly pool: Pool) {}

  /**
   * The nightly run's patients: an enabled Nightscout source and Trio as the loop (the detectors read Trio's logged
   * decisions; Wzorce are shown for Trio patients only).
   */
  async listPatientsToAnalyse(): Promise<string[]> {
    const result = await this.pool.query<{ patient_id: string; raw_payload: Record<string, unknown> | null }>(
      `SELECT p.patient_id, latest.raw_payload
       FROM (SELECT DISTINCT s.patient_id FROM sources s WHERE s.source_system = 'NIGHTSCOUT' AND s.enabled) p
       CROSS JOIN LATERAL (
         SELECT r.raw_payload FROM source_records r
         WHERE r.patient_id = p.patient_id AND r.record_type = 'DEVICE_STATUS'
         ORDER BY r.occurred_at DESC LIMIT 1
       ) latest`,
    );
    return result.rows.filter((row) => detectLoopSystem(row.raw_payload).kind === 'TRIO').map((row) => String(row.patient_id));
  }

  /** The patient's timezone from the newest profile (local nights are cut by it); null when no profile yet. */
  async getTimezone(patientId: string): Promise<string | null> {
    const row = (await this.pool.query<{ tz: string | null }>(
      `SELECT COALESCE(snapshot->'profile'->>'timezone', snapshot->>'timezone') AS tz FROM therapies
       WHERE patient_id = $1::uuid ORDER BY valid_from DESC NULLS LAST, created_at DESC LIMIT 1`,
      [patientId],
    )).rows[0];
    return row?.tz ?? null;
  }

  /** Active iOS phones of the patient's owners, one row per push token (a reinstall registered twice gets one push). */
  async listOwnerPushDevices(patientId: string): Promise<Array<{ device_id: string; push_token: string }>> {
    return (await this.pool.query<{ device_id: string; push_token: string }>(OWNER_PUSH_DEVICES_SQL, [patientId])).rows;
  }

  async listCaregiverNightPushDevices(patientId: string): Promise<Array<{ device_id: string; push_token: string; is_owner: boolean }>> {
    return (await this.pool.query<{ device_id: string; push_token: string; is_owner: boolean }>(CAREGIVER_NIGHT_PUSH_DEVICES_SQL, [patientId])).rows;
  }

  async deactivatePushToken(pushToken: string): Promise<void> {
    await this.pool.query(`UPDATE patient_devices SET active = false, updated_at = now() WHERE platform = 'ios' AND push_token = $1 AND active = true`, [pushToken]);
  }

  async listStates(patientId: string): Promise<PatternState[]> {
    const rows = (await this.pool.query<Row>(
      `SELECT s.*, u.display_name AS dismissed_by_name FROM therapy_pattern_states s LEFT JOIN users u ON u.id = s.dismissed_by_user_id
       WHERE s.patient_id = $1::uuid AND s.pattern_key <> $2 AND s.pattern_id <> '${NIGHT_CHECK_ID}' ORDER BY s.pattern_key`,
      [patientId, PATTERN_RUN_KEY],
    )).rows;
    return rows.map(toState);
  }

  async getState(patientId: string, key: string): Promise<PatternState | null> {
    const row = (await this.pool.query<Row>(`SELECT * FROM therapy_pattern_states WHERE patient_id = $1::uuid AND pattern_key = $2`, [patientId, key])).rows[0];
    return row && key !== PATTERN_RUN_KEY ? toState(row) : null;
  }

  /** When the nightly run last finished for the patient. */
  async lastRunAt(patientId: string): Promise<string | null> {
    const row = (await this.pool.query<{ computed_at: Date }>(
      `SELECT computed_at FROM therapy_pattern_states WHERE patient_id = $1::uuid AND pattern_key = $2`, [patientId, PATTERN_RUN_KEY],
    )).rows[0];
    return row ? row.computed_at.toISOString() : null;
  }

  /**
   * Tonight's states, all in one transaction with the run marker. The push fields (notified_*) and "Nie dotyczy nas"
   * are never written here: a push claim or a dismissal made meanwhile is kept.
   */
  async saveRun(patientId: string, states: PatternState[], computedAt: string, engineVersion: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const s of states) {
        await client.query(
          `INSERT INTO therapy_pattern_states (patient_id, pattern_key, pattern_id, shown, result, severity, first_shown_at, last_shown_at, computed_at, engine_version)
           VALUES ($1::uuid, $2, $3, $4, $5::jsonb, $6, $7::timestamptz, $8::timestamptz, $9::timestamptz, $10)
           ON CONFLICT (patient_id, pattern_key) DO UPDATE SET pattern_id = EXCLUDED.pattern_id, shown = EXCLUDED.shown,
             result = EXCLUDED.result, severity = EXCLUDED.severity, first_shown_at = EXCLUDED.first_shown_at,
             last_shown_at = EXCLUDED.last_shown_at, computed_at = EXCLUDED.computed_at, engine_version = EXCLUDED.engine_version,
             revision = therapy_pattern_states.revision + 1`,
          [patientId, s.pattern_key, s.pattern_id, s.shown, JSON.stringify(s.result), s.severity, s.first_shown_at, s.last_shown_at, computedAt, engineVersion],
        );
      }
      await client.query(
        `INSERT INTO therapy_pattern_states (patient_id, pattern_key, pattern_id, shown, result, computed_at, engine_version)
         VALUES ($1::uuid, $2, $2, false, '{}'::jsonb, $3::timestamptz, $4)
         ON CONFLICT (patient_id, pattern_key) DO UPDATE SET computed_at = EXCLUDED.computed_at, engine_version = EXCLUDED.engine_version`,
        [patientId, PATTERN_RUN_KEY, computedAt, engineVersion],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /** The push claim, written before sending: false when another tick (or a newer run) got there first. */
  async claimPush(patientId: string, key: string, revision: number, notifiedAt: string, severity: number): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE therapy_pattern_states SET notified_at = $4::timestamptz, notified_severity = $5, revision = revision + 1
       WHERE patient_id = $1::uuid AND pattern_key = $2 AND revision = $3`,
      [patientId, key, revision, notifiedAt, severity],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /** When this caregiver last opened each pattern of the patient ("Nowy" until opened). */
  async listOpens(patientId: string, userId: string): Promise<Map<string, string>> {
    const rows = (await this.pool.query<{ pattern_key: string; opened_at: Date }>(
      `SELECT pattern_key, opened_at FROM therapy_pattern_opens WHERE patient_id = $1::uuid AND user_id = $2::uuid`, [patientId, userId],
    )).rows;
    return new Map(rows.map((r) => [r.pattern_key, r.opened_at.toISOString()]));
  }

  /** The caregiver opened the pattern's card now. */
  async markOpened(patientId: string, key: string, userId: string, at: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO therapy_pattern_opens (patient_id, pattern_key, user_id, opened_at) VALUES ($1::uuid, $2, $3::uuid, $4::timestamptz)
       ON CONFLICT (patient_id, pattern_key, user_id) DO UPDATE SET opened_at = EXCLUDED.opened_at`,
      [patientId, key, userId, at],
    );
  }

  /** "Nie dotyczy nas" (until a date), or null to show it again. */
  async setDismissed(patientId: string, key: string, until: string | null, userId: string | null): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE therapy_pattern_states SET dismissed_until = $3::timestamptz, dismissed_by_user_id = $4::uuid, revision = revision + 1
       WHERE patient_id = $1::uuid AND pattern_key = $2 AND pattern_key <> '${PATTERN_RUN_KEY}'`,
      [patientId, key, until, userId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /** Last night's morning check: when it was last looked at and whether its push went out. */
  async getNightCheck(patientId: string, date: string): Promise<{ checked_at: string; notified_at: string | null } | null> {
    const row = (await this.pool.query<{ computed_at: Date; notified_at: Date | null }>(
      `SELECT computed_at, notified_at FROM therapy_pattern_states WHERE patient_id = $1::uuid AND pattern_key = $2`, [patientId, `${NIGHT_CHECK_ID}.${date}`],
    )).rows[0];
    return row ? { checked_at: row.computed_at.toISOString(), notified_at: iso(row.notified_at) } : null;
  }

  async saveNightCheck(patientId: string, date: string, checkedAt: string, result: unknown): Promise<void> {
    await this.pool.query(
      `INSERT INTO therapy_pattern_states (patient_id, pattern_key, pattern_id, shown, result, computed_at, engine_version)
       VALUES ($1::uuid, $2, $3, false, $4::jsonb, $5::timestamptz, 'night-check.v1')
       ON CONFLICT (patient_id, pattern_key) DO UPDATE SET result = EXCLUDED.result, computed_at = EXCLUDED.computed_at`,
      [patientId, `${NIGHT_CHECK_ID}.${date}`, NIGHT_CHECK_ID, JSON.stringify(result ?? {}), checkedAt],
    );
  }

  /** The push claim for that night, once: false when it was already sent. */
  async claimNightPush(patientId: string, date: string, notifiedAt: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE therapy_pattern_states SET notified_at = $3::timestamptz, revision = revision + 1
       WHERE patient_id = $1::uuid AND pattern_key = $2 AND notified_at IS NULL`,
      [patientId, `${NIGHT_CHECK_ID}.${date}`, notifiedAt],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /** The newest glucose reading of the last 20 minutes (no push while a low is being handled). */
  async latestGlucose(patientId: string): Promise<number | null> {
    const row = (await this.pool.query<{ value: number | null }>(
      `SELECT CASE
          WHEN jsonb_typeof(e.payload->'glucose_value') = 'number' THEN (e.payload->>'glucose_value')::float8
          WHEN jsonb_typeof(e.payload->'glucose') = 'number' THEN (e.payload->>'glucose')::float8
          WHEN jsonb_typeof(e.payload->'raw_payload'->'sgv') = 'number' THEN (e.payload->'raw_payload'->>'sgv')::float8
        END AS value
       FROM events e
       WHERE e.patient_id = $1::uuid AND e.type IN ('GLUCOSE_READING_AVAILABLE', 'GLUCOSE_READING', 'GLUCOSE')
         AND e.occurred_at >= now() - interval '20 minutes'
       ORDER BY e.occurred_at DESC LIMIT 1`,
      [patientId],
    )).rows[0];
    return row?.value ?? null;
  }

  /** The pattern of a conversation ("Omów z Mellis"); null for an ordinary conversation. */
  async getThreadPatternKey(patientId: string, conversationId: string): Promise<string | null> {
    const row = (await this.pool.query<{ pattern_key: string }>(
      `SELECT pattern_key FROM therapy_pattern_threads WHERE patient_id = $1::uuid AND conversation_id = $2::uuid`, [patientId, conversationId],
    )).rows[0];
    return row?.pattern_key ?? null;
  }

  /** The pattern's conversation, created on first open (one per pattern even when two owners open it at once). */
  async getOrCreateThread(patientId: string, key: string, title: string): Promise<string> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('therapy-pattern-thread:' || $1::text || ':' || $2::text))`, [patientId, key]);
      const existing = (await client.query<{ conversation_id: string; deleted_at: string | null }>(
        `SELECT t.conversation_id::text, c.deleted_at FROM therapy_pattern_threads t JOIN conversations c ON c.id = t.conversation_id
         WHERE t.patient_id = $1::uuid AND t.pattern_key = $2`,
        [patientId, key],
      )).rows[0];
      if (existing && !existing.deleted_at) {
        await client.query('COMMIT');
        return existing.conversation_id;
      }
      const created = (await client.query<{ id: string }>(
        `INSERT INTO conversations (patient_id, episode_id, origin, trigger_type, thread_state_version, awaiting_user_answer, conversation_type, title, title_source, title_updated_at)
         VALUES ($1::uuid, NULL, 'USER', 'THERAPY_PATTERN', 'conv-v1', false, 'USER_INITIATED', $2, 'SYSTEM', now())
         RETURNING id::text`,
        [patientId, title],
      )).rows[0];
      await client.query(
        `INSERT INTO therapy_pattern_threads (patient_id, pattern_key, conversation_id) VALUES ($1::uuid, $2, $3::uuid)
         ON CONFLICT (patient_id, pattern_key) DO UPDATE SET conversation_id = EXCLUDED.conversation_id, created_at = now()`,
        [patientId, key, created.id],
      );
      await client.query('COMMIT');
      return created.id;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
