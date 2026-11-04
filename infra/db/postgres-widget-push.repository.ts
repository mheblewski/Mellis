import type { Pool } from 'pg';
import { memberAllowsSql } from './sharing-access.sql';

export type WidgetPushEnvironment = 'sandbox' | 'production';
export type WidgetPushPlatform = 'watchos' | 'ios';

export interface WidgetPushTokenRow {
  token: string;
  user_id: string;
  watch_device_id: string;
  topic: string;
  environment: WidgetPushEnvironment;
  platform: WidgetPushPlatform;
  patient_ids: string[];
  last_pushed_at: string | null;
}

/** One token and one of its patients, with the throttle state of the pair. */
export interface WidgetPushTarget {
  token: string;
  user_id: string;
  topic: string;
  environment: WidgetPushEnvironment;
  platform: WidgetPushPlatform;
  /** The token's last push for any patient. */
  token_last_pushed_at: string | null;
  patient_id: string;
  /** False until the first decision for this pair (no watch_push_state row). */
  has_state: boolean;
  last_reading_at: string | null;
  deferred_reading_at: string | null;
  last_pushed_at: string | null;
  last_value: number | null;
  last_level: string | null;
}

/**
 * watch_push_tokens + watch_push_state (102_watch_devices.sql); every token belongs to a watch device and lives only
 * as long as that device is not revoked.
 */
export class PostgresWidgetPushRepository {
  constructor(private readonly pool: Pool) {}

  /**
   * The token's watch device (and its caregiver), topic, environment and patients, keyed by token: a token registered
   * again (another watch device, other patients) replaces the old row; the throttle state of patients no longer listed
   * goes.
   */
  async upsert(args: {
    token: string;
    userId: string;
    watchDeviceId: string;
    topic: string;
    environment: WidgetPushEnvironment;
    platform: WidgetPushPlatform;
    patientIds: string[];
    now: Date;
  }): Promise<WidgetPushTokenRow> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<WidgetPushTokenRow>(
        `
          INSERT INTO watch_push_tokens (token, user_id, watch_device_id, topic, environment, platform, patient_ids, created_at, updated_at)
          VALUES ($1, $2::uuid, $8::uuid, $3, $4, $5, $6::uuid[], $7::timestamptz, $7::timestamptz)
          ON CONFLICT (token) DO UPDATE SET
            user_id = EXCLUDED.user_id,
            watch_device_id = EXCLUDED.watch_device_id,
            topic = EXCLUDED.topic,
            environment = EXCLUDED.environment,
            platform = EXCLUDED.platform,
            patient_ids = EXCLUDED.patient_ids,
            updated_at = EXCLUDED.updated_at
          RETURNING token, user_id::text, watch_device_id::text, topic, environment, platform, patient_ids::text[] AS patient_ids, last_pushed_at::text
        `,
        [args.token, args.userId, args.topic, args.environment, args.platform, args.patientIds, args.now.toISOString(), args.watchDeviceId],
      );
      await client.query(
        `DELETE FROM watch_push_state WHERE token = $1 AND NOT (patient_id = ANY($2::uuid[]))`,
        [args.token, args.patientIds],
      );
      await client.query('COMMIT');
      return result.rows[0];
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /** APNs refused the token (invalid or unregistered): the widget registers a new one. */
  async deleteToken(token: string): Promise<void> {
    await this.pool.query(`DELETE FROM watch_push_tokens WHERE token = $1`, [token]);
  }

  /**
   * Every token × patient pair whose watch device was not revoked and whose caregiver may still see the patient's
   * dashboard (sharing-access.sql.ts).
   */
  async listTargets(): Promise<WidgetPushTarget[]> {
    const result = await this.pool.query<WidgetPushTarget>(
      `
        SELECT t.token, t.user_id::text, t.topic, t.environment, t.platform, t.last_pushed_at::text AS token_last_pushed_at,
               p.patient_id::text, (s.token IS NOT NULL) AS has_state,
               s.last_reading_at::text, s.deferred_reading_at::text, s.last_pushed_at::text,
               s.last_value::float8 AS last_value, s.last_level
        FROM watch_push_tokens t
        JOIN watch_devices d ON d.id = t.watch_device_id AND d.revoked_at IS NULL AND d.user_id = t.user_id
        CROSS JOIN LATERAL unnest(t.patient_ids) AS p(patient_id)
        LEFT JOIN watch_push_state s ON s.token = t.token AND s.patient_id = p.patient_id
        WHERE EXISTS (
          SELECT 1 FROM caregiver_relationships r
          WHERE r.user_id = t.user_id AND r.patient_id = p.patient_id AND ${memberAllowsSql('r', 'glucose')}
        )
        ORDER BY p.patient_id, t.token
      `,
    );
    return result.rows;
  }

  /** A push went out for this reading. */
  async markPushed(args: { token: string; patientId: string; readingAt: string; value: number; level: string; now: Date }): Promise<void> {
    const now = args.now.toISOString();
    await this.pool.query(
      `
        WITH token AS (
          UPDATE watch_push_tokens SET last_pushed_at = $6::timestamptz WHERE token = $1 RETURNING token
        )
        INSERT INTO watch_push_state (token, patient_id, last_reading_at, deferred_reading_at, last_pushed_at, last_value, last_level, updated_at)
        SELECT token, $2::uuid, $3::timestamptz, NULL, $6::timestamptz, $4::numeric, $5, $6::timestamptz FROM token
        ON CONFLICT (token, patient_id) DO UPDATE SET
          last_reading_at = EXCLUDED.last_reading_at, deferred_reading_at = NULL, last_pushed_at = EXCLUDED.last_pushed_at,
          last_value = EXCLUDED.last_value, last_level = EXCLUDED.last_level, updated_at = EXCLUDED.updated_at
      `,
      [args.token, args.patientId, args.readingAt, args.value, args.level, now],
    );
  }

  /** The reading was decided on without a push (the push failed): not looked at again. */
  async markEvaluated(args: { token: string; patientId: string; readingAt: string; now: Date }): Promise<void> {
    await this.pool.query(
      `
        INSERT INTO watch_push_state (token, patient_id, last_reading_at, updated_at)
        SELECT token, $2::uuid, $3::timestamptz, $4::timestamptz FROM watch_push_tokens WHERE token = $1
        ON CONFLICT (token, patient_id) DO UPDATE SET
          last_reading_at = EXCLUDED.last_reading_at, deferred_reading_at = NULL, updated_at = EXCLUDED.updated_at
      `,
      [args.token, args.patientId, args.readingAt, args.now.toISOString()],
    );
  }

  /** The reading is held back by the token's 4-min rule only: later ticks look at it again. */
  async markDeferred(args: { token: string; patientId: string; readingAt: string; now: Date }): Promise<void> {
    await this.pool.query(
      `
        INSERT INTO watch_push_state (token, patient_id, deferred_reading_at, updated_at)
        SELECT token, $2::uuid, $3::timestamptz, $4::timestamptz FROM watch_push_tokens WHERE token = $1
        ON CONFLICT (token, patient_id) DO UPDATE SET deferred_reading_at = EXCLUDED.deferred_reading_at, updated_at = EXCLUDED.updated_at
      `,
      [args.token, args.patientId, args.readingAt, args.now.toISOString()],
    );
  }
}
