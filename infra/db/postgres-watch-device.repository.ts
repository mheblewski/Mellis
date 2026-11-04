import type { Pool } from 'pg';
import { memberAllowsSql } from './sharing-access.sql';

export interface WatchDeviceRow {
  id: string;
  user_id: string;
  device: string | null;
  patient_ids: string[];
  created_at: Date;
  last_used_at: Date | null;
}

/** watch_devices (102_watch_devices.sql). */
export class PostgresWatchDeviceRepository {
  constructor(private readonly pool: Pool) {}

  /**
   * A new device for the caregiver's phone. An earlier active device with the same label goes (revoked) in the same
   * transaction: the phone lost the old one (reinstall) or replaces it.
   */
  async createWatchDevice(args: {
    userId: string;
    device: string | null;
    patientIds: string[];
    tokenHash: string;
    now: Date;
  }): Promise<WatchDeviceRow> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const replaced = await client.query<{ id: string }>(
        `
          UPDATE watch_devices SET revoked_at = $3::timestamptz
          WHERE user_id = $1::uuid AND device IS NOT DISTINCT FROM $2 AND revoked_at IS NULL
          RETURNING id::text
        `,
        [args.userId, args.device, args.now.toISOString()],
      );
      if (replaced.rows.length > 0) {
        await client.query(`DELETE FROM watch_push_tokens WHERE watch_device_id = ANY($1::uuid[])`, [replaced.rows.map((row) => row.id)]);
      }
      const device = await client.query<WatchDeviceRow>(
        `
          INSERT INTO watch_devices (user_id, device, patient_ids, token_hash, created_at)
          VALUES ($1::uuid, $2, $3::uuid[], $4, $5::timestamptz)
          RETURNING ${DEVICE_COLUMNS}
        `,
        [args.userId, args.device, args.patientIds, args.tokenHash, args.now.toISOString()],
      );
      await client.query('COMMIT');
      return device.rows[0];
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /** The device of a token that was not revoked; null otherwise. */
  async findActiveDeviceByTokenHash(tokenHash: string): Promise<WatchDeviceRow | null> {
    const result = await this.pool.query<WatchDeviceRow>(
      `SELECT ${DEVICE_COLUMNS} FROM watch_devices WHERE token_hash = $1 AND revoked_at IS NULL`,
      [tokenHash],
    );
    return result.rows[0] ?? null;
  }

  /** last_used_at = now, at most once a minute (a write per glance read would be wasted). */
  async touchDevice(id: string, now: Date): Promise<void> {
    await this.pool.query(
      `
        UPDATE watch_devices SET last_used_at = $2::timestamptz
        WHERE id = $1::uuid AND (last_used_at IS NULL OR last_used_at <= $2::timestamptz - interval '1 minute')
      `,
      [id, now.toISOString()],
    );
  }

  /**
   * Revokes the caller's own device and forgets its WidgetKit push tokens; false for another caregiver's, an
   * unknown or an already revoked one.
   */
  async revokeDevice(id: string, userId: string, now: Date): Promise<boolean> {
    const result = await this.pool.query<{ revoked: boolean }>(
      `
        WITH revoked AS (
          UPDATE watch_devices SET revoked_at = $3::timestamptz
          WHERE id = $1::uuid AND user_id = $2::uuid AND revoked_at IS NULL
          RETURNING id
        ), tokens AS (
          DELETE FROM watch_push_tokens WHERE watch_device_id IN (SELECT id FROM revoked)
        )
        SELECT EXISTS (SELECT 1 FROM revoked) AS revoked
      `,
      [id, userId, now.toISOString()],
    );
    return result.rows[0]?.revoked === true;
  }

  /**
   * Of these patients, the ones this caregiver may still see on a dashboard (owner, or a member allowed glucose or the
   * AI and meals: sharing-access.sql.ts), with their names (unordered).
   */
  async readablePatients(userId: string, patientIds: string[]): Promise<Array<{ id: string; name: string }>> {
    if (patientIds.length === 0) return [];
    const result = await this.pool.query<{ id: string; name: string }>(
      `
        SELECT DISTINCT p.id::text AS id, p.display_name AS name
        FROM patients p
        JOIN caregiver_relationships r ON r.patient_id = p.id
        WHERE r.user_id = $1::uuid AND p.id = ANY($2::uuid[]) AND ${memberAllowsSql('r', 'glucose')}
      `,
      [userId, patientIds],
    );
    return result.rows;
  }
}

const DEVICE_COLUMNS = `id::text, user_id::text, device, patient_ids::text[] AS patient_ids, created_at, last_used_at`;
