import type { Pool } from 'pg';
import type { PushNotificationEnvelope } from '@modules/notifications/domain/push-notification';

export interface HeldPush {
  id: string;
  push_token: string;
  patient_id: string;
  item_key: string;
  notification_type: string;
  envelope: PushNotificationEnvelope;
  held_at: string;
  release_after: string;
}

/** The phones' quiet hours with the patients on each phone, for the check before them (quiet-hours.v1). */
export interface QuietPhonePatient {
  device_id: string;
  push_token: string;
  patient_id: string;
  reservoir_on: boolean;
  battery_on: boolean;
  site_on: boolean;
}

/**
 * Pushes waiting for the end of a phone's quiet hours (quiet-hours.v1, migration 121). One waiting row per phone,
 * patient and item: a newer push of the same item replaces the waiting one ("< 8 h" replaces "< 24 h").
 */
export class PostgresQuietHeldRepository {
  constructor(private readonly pool: Pool) {}

  async hold(input: { pushToken: string; patientId: string; itemKey: string; type: string; envelope: PushNotificationEnvelope; releaseAfter: Date }): Promise<void> {
    await this.pool.query(
      `
        INSERT INTO quiet_held_pushes (push_token, patient_id, item_key, notification_type, envelope, release_after)
        VALUES ($1, $2::uuid, $3, $4, $5::jsonb, $6)
        ON CONFLICT (push_token, patient_id, item_key) WHERE released_at IS NULL DO UPDATE SET
          notification_type = EXCLUDED.notification_type, envelope = EXCLUDED.envelope, held_at = now(), release_after = EXCLUDED.release_after
      `,
      [input.pushToken, input.patientId, input.itemKey, input.type, JSON.stringify(input.envelope), input.releaseAfter.toISOString()],
    );
  }

  /** Every waiting push (few: a handful per phone and night). */
  async listWaiting(): Promise<HeldPush[]> {
    const rows = (await this.pool.query<HeldPush & { held_at: Date | string; release_after: Date | string }>(
      `SELECT id, push_token, patient_id, item_key, notification_type, envelope, held_at, release_after FROM quiet_held_pushes WHERE released_at IS NULL ORDER BY held_at`,
    )).rows;
    return rows.map((row) => ({ ...row, held_at: new Date(row.held_at).toISOString(), release_after: new Date(row.release_after).toISOString() }));
  }

  /** Marks them done; false when another worker got there first. */
  async markReleased(ids: string[], outcome: string): Promise<boolean> {
    if (ids.length === 0) return true;
    const result = await this.pool.query(
      `UPDATE quiet_held_pushes SET released_at = now(), outcome = $2 WHERE id = ANY($1::uuid[]) AND released_at IS NULL`,
      [ids, outcome],
    );
    return (result.rowCount ?? 0) === ids.length;
  }

  /** Phones with quiet hours on and the patients on them, with their equipment switches. */
  async listQuietPhones(): Promise<Array<QuietPhonePatient & { enabled: boolean; start_minute: number; end_minute: number; time_zone: string; low_warnings: boolean; pre_checked_on: string | null }>> {
    const rows = (await this.pool.query(
      `
        SELECT DISTINCT ON (d.push_token, d.patient_id)
               q.device_id, d.push_token, d.patient_id::text AS patient_id,
               d.reservoir_push_enabled AS reservoir_on, d.battery_push_enabled AS battery_on, d.site_push_enabled AS site_on,
               q.enabled, q.start_minute, q.end_minute, q.time_zone, q.low_warnings, q.pre_checked_on::text AS pre_checked_on
        FROM device_quiet_hours q
        JOIN patient_devices k ON k.platform = 'ios' AND k.device_id = q.device_id AND k.push_token IS NOT NULL
        JOIN patient_devices d ON d.platform = 'ios' AND d.active = true AND d.push_token = k.push_token
        WHERE q.platform = 'ios' AND q.enabled = true
        ORDER BY d.push_token, d.patient_id, q.updated_at DESC
      `,
    )).rows as Array<QuietPhonePatient & { enabled: boolean; start_minute: number; end_minute: number; time_zone: string; low_warnings: boolean; pre_checked_on: string | null }>;
    return rows.map((row) => ({ ...row, start_minute: Number(row.start_minute), end_minute: Number(row.end_minute) }));
  }

  /** Claims tonight's check for a phone; false when it was claimed already. */
  async claimPreCheck(deviceId: string, localDate: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE device_quiet_hours SET pre_checked_on = $2::date WHERE platform = 'ios' AND device_id = $1 AND (pre_checked_on IS NULL OR pre_checked_on < $2::date)`,
      [deviceId, localDate],
    );
    return (result.rowCount ?? 0) > 0;
  }
}
