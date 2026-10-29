import { memberAllowsSql } from './sharing-access.sql';
import type { Pool } from 'pg';

export interface LiveActivitySubscription {
  device_id: string;
  patient_id: string;
  user_id: string;
  enabled: boolean;
  island_enabled: boolean;
  start_token: string | null;
  activity_id: string | null;
  update_token: string | null;
  activity_started_at: string | null;
  start_requested_at: string | null;
  last_reading_at: string | null;
  last_push_at: string | null;
  /** The patients the caregiver picked, in order (1 or 2); patient_id is the first (migration 094). */
  patient_ids: string[];
  /** Two patients: 'both' or 'closer' in the Dynamic Island. */
  island_mode: LiveActivityIslandMode;
  island_left_patient_id: string | null;
  /** { patient_id: reading time } of the readings the activity shows. */
  last_readings: Record<string, string>;
}

export type LiveActivityIslandMode = 'both' | 'closer';

/** listEnabled: the row with the patients it may show now (access and registration checked per patient, in order). */
export interface EnabledLiveActivitySubscription extends LiveActivitySubscription {
  shown_patient_ids: string[];
}

/** The phone's part of a change: what it knows (its switch, tokens, running activity); left out = unchanged. */
export interface LiveActivityDeviceChange {
  enabled?: boolean;
  island_enabled?: boolean;
  start_token?: string | null;
  activity_id?: string | null;
  update_token?: string | null;
  /** The patients shown, first = path patient (1 or 2). Left out: unchanged, or [patient] when the patient changed. */
  patient_ids?: string[];
  island_mode?: LiveActivityIslandMode;
  island_left_patient_id?: string | null;
}

const COLUMNS = `device_id, patient_id::text, user_id::text, enabled, island_enabled, start_token, activity_id, update_token,
  activity_started_at::text, start_requested_at::text, last_reading_at::text, last_push_at::text,
  patient_ids::text[], island_mode, island_left_patient_id::text, last_readings`;

/** The phone is registered (actively) for the patient `p` and its person may see glucose alerts for them. */
const SHOWABLE = (p: string) => `
  EXISTS (
    SELECT 1 FROM patient_devices d
    WHERE d.patient_id = ${p} AND d.platform = 'ios' AND d.device_id = s.device_id AND d.active = true
  )
  -- Live Activities are glucose: only for members with "Glukoza i alarmy".
  AND EXISTS (
    SELECT 1 FROM caregiver_relationships r
    WHERE r.user_id = s.user_id AND r.patient_id = ${p} AND ${memberAllowsSql('r', 'glucose_alerts')}
  )`;

/** live_activity_subscriptions: one row per phone (migrations 088, 094: up to two patients). */
export class PostgresLiveActivityRepository {
  constructor(private readonly pool: Pool) {}

  /**
   * The phone's switch and tokens for a patient. The phone must be registered (actively) for the patient. Switching
   * to another patient moves the row and forgets the old activity (its tokens belong to the old patient).
   */
  async upsertFromDevice(args: { deviceId: string; patientId: string; userId: string; change: LiveActivityDeviceChange; now: Date }): Promise<LiveActivitySubscription | null> {
    const { change } = args;
    const result = await this.pool.query<LiveActivitySubscription>(
      `
        WITH ids AS (SELECT COALESCE($13::uuid[], ARRAY[$2::uuid]) AS patient_ids),
        device AS (
          -- Registered (actively) for every patient it is to show.
          SELECT 1 FROM ids
          WHERE (
            SELECT count(DISTINCT d.patient_id) FROM patient_devices d
            WHERE d.patient_id = ANY(ids.patient_ids) AND d.platform = 'ios' AND d.device_id = $1 AND d.active = true
          ) = cardinality(ids.patient_ids)
        )
        INSERT INTO live_activity_subscriptions (device_id, patient_id, user_id, enabled, island_enabled, start_token, activity_id, update_token, activity_started_at, start_requested_at, updated_at,
                                                patient_ids, island_mode, island_left_patient_id)
        SELECT $1, $2::uuid, $3::uuid, COALESCE($4::boolean, true), COALESCE($12::boolean, true), $6::text, $8::text, $10::text, CASE WHEN $10::text IS NOT NULL THEN $11::timestamptz END,
               -- Just switched on: the app starts its own activity and reports it in seconds; no push-to-start meanwhile.
               CASE WHEN COALESCE($4::boolean, true) AND $10::text IS NULL THEN $11::timestamptz END, $11::timestamptz,
               (SELECT patient_ids FROM ids), COALESCE($14::text, 'both'), CASE WHEN $15::boolean THEN $16::uuid END
        FROM device
        ON CONFLICT (device_id) DO UPDATE SET
          user_id = EXCLUDED.user_id,
          island_enabled = COALESCE($12::boolean, live_activity_subscriptions.island_enabled),
          enabled = COALESCE($4::boolean, CASE WHEN live_activity_subscriptions.patient_id = EXCLUDED.patient_id THEN live_activity_subscriptions.enabled ELSE true END),
          start_token = CASE WHEN $5::boolean THEN $6::text ELSE live_activity_subscriptions.start_token END,
          activity_id = CASE
            WHEN $7::boolean THEN $8::text
            WHEN live_activity_subscriptions.patient_id <> EXCLUDED.patient_id THEN NULL
            ELSE live_activity_subscriptions.activity_id END,
          update_token = CASE
            WHEN $9::boolean THEN $10::text
            WHEN live_activity_subscriptions.patient_id <> EXCLUDED.patient_id THEN NULL
            ELSE live_activity_subscriptions.update_token END,
          activity_started_at = CASE
            WHEN $9::boolean AND $10::text IS NOT NULL AND $10::text IS DISTINCT FROM live_activity_subscriptions.update_token THEN $11::timestamptz
            WHEN $9::boolean AND $10::text IS NULL THEN NULL
            WHEN live_activity_subscriptions.patient_id <> EXCLUDED.patient_id THEN NULL
            ELSE live_activity_subscriptions.activity_started_at END,
          -- An activity the phone saw end (swiped away, ended by iOS) is not started again at once: the start rule waits
          -- as it does after a start of its own.
          start_requested_at = CASE
            WHEN $9::boolean AND $10::text IS NOT NULL THEN NULL
            WHEN $4::boolean AND NOT live_activity_subscriptions.enabled THEN $11::timestamptz
            WHEN $9::boolean AND $10::text IS NULL THEN $11::timestamptz
            ELSE live_activity_subscriptions.start_requested_at END,
          last_reading_at = CASE
            WHEN live_activity_subscriptions.patient_id <> EXCLUDED.patient_id OR ($9::boolean AND $10::text IS DISTINCT FROM live_activity_subscriptions.update_token)
              OR ($13::uuid[] IS NOT NULL AND $13::uuid[] IS DISTINCT FROM live_activity_subscriptions.patient_ids)
              OR ($14::text IS NOT NULL AND $14::text IS DISTINCT FROM live_activity_subscriptions.island_mode)
              OR ($15::boolean AND $16::uuid IS DISTINCT FROM live_activity_subscriptions.island_left_patient_id) THEN NULL
            ELSE live_activity_subscriptions.last_reading_at END,
          -- An older app (no patient_ids) switching patients shows that one patient; the same patient keeps the list.
          patient_ids = CASE
            WHEN $13::uuid[] IS NOT NULL THEN $13::uuid[]
            WHEN live_activity_subscriptions.patient_id = EXCLUDED.patient_id THEN live_activity_subscriptions.patient_ids
            ELSE ARRAY[EXCLUDED.patient_id] END,
          island_mode = COALESCE($14::text, live_activity_subscriptions.island_mode),
          island_left_patient_id = CASE WHEN $15::boolean THEN $16::uuid ELSE live_activity_subscriptions.island_left_patient_id END,
          -- Anything the activity shows changed: the next tick pushes at once instead of waiting for a new reading.
          last_readings = CASE
            WHEN live_activity_subscriptions.patient_id <> EXCLUDED.patient_id
              OR ($9::boolean AND $10::text IS DISTINCT FROM live_activity_subscriptions.update_token)
              OR ($13::uuid[] IS NOT NULL AND $13::uuid[] IS DISTINCT FROM live_activity_subscriptions.patient_ids)
              OR ($14::text IS NOT NULL AND $14::text IS DISTINCT FROM live_activity_subscriptions.island_mode)
              OR ($15::boolean AND $16::uuid IS DISTINCT FROM live_activity_subscriptions.island_left_patient_id)
              OR ($12::boolean IS NOT NULL AND $12::boolean IS DISTINCT FROM live_activity_subscriptions.island_enabled)
            THEN '{}'::jsonb
            ELSE live_activity_subscriptions.last_readings END,
          patient_id = EXCLUDED.patient_id,
          updated_at = $11::timestamptz
        RETURNING ${COLUMNS}
      `,
      [
        args.deviceId,
        args.patientId,
        args.userId,
        change.enabled ?? null,
        change.start_token !== undefined,
        change.start_token ?? null,
        change.activity_id !== undefined,
        change.activity_id ?? null,
        change.update_token !== undefined,
        change.update_token ?? null,
        args.now.toISOString(),
        change.island_enabled ?? null,
        change.patient_ids ?? null,
        change.island_mode ?? null,
        change.island_left_patient_id !== undefined,
        change.island_left_patient_id ?? null,
      ],
    );
    return result.rows[0] ?? null;
  }

  /**
   * Switched on, with the patients each phone may show now: still registered for them and allowed glucose alerts (a
   * patient the person lost access to drops out of the activity). Rows with none left are skipped.
   */
  async listEnabled(): Promise<EnabledLiveActivitySubscription[]> {
    const result = await this.pool.query<EnabledLiveActivitySubscription>(
      `
        SELECT * FROM (
          SELECT ${COLUMNS.split(',').map((column) => `s.${column.trim()}`).join(', ')},
                 ARRAY(
                   SELECT u.p::text FROM unnest(s.patient_ids) WITH ORDINALITY AS u(p, n)
                   WHERE ${SHOWABLE('u.p')}
                   ORDER BY u.n
                 ) AS shown_patient_ids
          FROM live_activity_subscriptions s
          WHERE s.enabled = true
        ) rows
        WHERE cardinality(rows.shown_patient_ids) > 0
        ORDER BY rows.patient_id, rows.device_id
      `,
    );
    return result.rows;
  }

  /** Switched off with an activity still known: the server ends it once, then forgets it. */
  async listDisabledWithActivity(): Promise<LiveActivitySubscription[]> {
    const result = await this.pool.query<LiveActivitySubscription>(
      `SELECT ${COLUMNS} FROM live_activity_subscriptions WHERE enabled = false AND update_token IS NOT NULL`,
    );
    return result.rows;
  }

  /** A push went out with these readings ({ patient_id: reading time }; the first patient's also as last_reading_at). */
  async markUpdated(deviceId: string, readings: LiveActivityReadings, now: Date): Promise<void> {
    await this.pool.query(
      `
        UPDATE live_activity_subscriptions
        SET last_reading_at = ($2::jsonb ->> patient_id::text)::timestamptz, last_readings = $2::jsonb,
            last_push_at = $3::timestamptz, updated_at = $3::timestamptz
        WHERE device_id = $1
      `,
      [deviceId, JSON.stringify(compactReadings(readings)), now.toISOString()],
    );
  }

  /** A start went out: the old activity is forgotten until the phone reports the new one's update token. */
  async markStartRequested(deviceId: string, readings: LiveActivityReadings, now: Date): Promise<void> {
    await this.pool.query(
      `
        UPDATE live_activity_subscriptions
        SET start_requested_at = $3::timestamptz, activity_id = NULL, update_token = NULL, activity_started_at = NULL,
            last_reading_at = ($2::jsonb ->> patient_id::text)::timestamptz, last_readings = $2::jsonb,
            last_push_at = $3::timestamptz, updated_at = $3::timestamptz
        WHERE device_id = $1
      `,
      [deviceId, JSON.stringify(compactReadings(readings)), now.toISOString()],
    );
  }

  /** The activity's token is gone (APNs refused it, or it was ended): forgotten so the next tick can start anew. */
  async forgetActivity(deviceId: string, updateToken: string, now: Date): Promise<void> {
    await this.pool.query(
      `
        UPDATE live_activity_subscriptions
        SET activity_id = NULL, update_token = NULL, activity_started_at = NULL, updated_at = $3::timestamptz
        WHERE device_id = $1 AND update_token = $2
      `,
      [deviceId, updateToken, now.toISOString()],
    );
  }

  /** APNs refused the push-to-start token: the phone sends a new one on its next start of the app. */
  async forgetStartToken(deviceId: string, startToken: string, now: Date): Promise<void> {
    await this.pool.query(
      `UPDATE live_activity_subscriptions SET start_token = NULL, updated_at = $3::timestamptz WHERE device_id = $1 AND start_token = $2`,
      [deviceId, startToken, now.toISOString()],
    );
  }
}

/** { patient_id: newest reading time or null } as the pusher sees them. */
export type LiveActivityReadings = Record<string, string | null>;

function compactReadings(readings: LiveActivityReadings): Record<string, string> {
  return Object.fromEntries(Object.entries(readings).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
}
