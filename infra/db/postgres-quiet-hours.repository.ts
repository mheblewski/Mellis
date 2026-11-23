import type { Pool } from 'pg';
import type { QuietHoursSettings } from '@modules/notifications/application/quiet-hours';
import { QUIET_HOURS_POLICY } from '@modules/notifications/application/quiet-hours';
import { resolveHomeTimeZone } from '@shared/primitives/home-time-zone';

export interface DeviceQuietHours extends QuietHoursSettings {
  device_id: string;
  updated_at: string | null;
}

export type DeviceQuietHoursChanges = Partial<QuietHoursSettings>;

/**
 * "Godziny ciszy" of a phone (quiet-hours.v1, migration 121). Keyed by the app's device id; a push finds them
 * through every patient_devices row with its token (the app can register under another device id after a launch before
 * the first unlock), the newest setting winning.
 */
export class PostgresQuietHoursRepository {
  constructor(private readonly pool: Pool) {}

  /** The phone's quiet hours, or the defaults (off, 22:00–7:00) for a phone that never saved them. */
  async get(deviceId: string): Promise<DeviceQuietHours> {
    const row = (await this.pool.query<DeviceQuietHours>(
      `SELECT device_id, enabled, start_minute, end_minute, time_zone, low_warnings, updated_at FROM device_quiet_hours WHERE platform = 'ios' AND device_id = $1`,
      [deviceId],
    )).rows[0];
    return row ? normalize(row) : defaults(deviceId);
  }

  async set(deviceId: string, changes: DeviceQuietHoursChanges, userId: string | null): Promise<DeviceQuietHours> {
    const current = await this.get(deviceId);
    const next = { ...current, ...changes };
    const row = (await this.pool.query<DeviceQuietHours>(
      `
        INSERT INTO device_quiet_hours (platform, device_id, enabled, start_minute, end_minute, time_zone, low_warnings, updated_by, updated_at)
        VALUES ('ios', $1, $2, $3, $4, $5, $6, $7::uuid, now())
        ON CONFLICT (platform, device_id) DO UPDATE SET
          enabled = EXCLUDED.enabled, start_minute = EXCLUDED.start_minute, end_minute = EXCLUDED.end_minute,
          time_zone = EXCLUDED.time_zone, low_warnings = EXCLUDED.low_warnings, updated_by = EXCLUDED.updated_by, updated_at = now()
        RETURNING device_id, enabled, start_minute, end_minute, time_zone, low_warnings, updated_at
      `,
      [deviceId, next.enabled, next.start_minute, next.end_minute, next.time_zone, next.low_warnings, userId],
    )).rows[0]!;
    return normalize(row);
  }

  /** The quiet hours of the phone a push token belongs to (null: none saved, or switched off). */
  async forPushToken(pushToken: string): Promise<QuietHoursSettings | null> {
    if (!pushToken) return null;
    const row = (await this.pool.query<DeviceQuietHours>(
      `
        SELECT q.device_id, q.enabled, q.start_minute, q.end_minute, q.time_zone, q.low_warnings, q.updated_at
        FROM device_quiet_hours q
        WHERE q.platform = 'ios'
          AND q.device_id IN (SELECT d.device_id FROM patient_devices d WHERE d.platform = 'ios' AND d.push_token = $1)
        ORDER BY q.updated_at DESC
        LIMIT 1
      `,
      [pushToken],
    )).rows[0];
    return row?.enabled ? normalize(row) : null;
  }
}

function defaults(deviceId: string): DeviceQuietHours {
  return {
    device_id: deviceId,
    enabled: false,
    start_minute: QUIET_HOURS_POLICY.default_start_minute,
    end_minute: QUIET_HOURS_POLICY.default_end_minute,
    time_zone: resolveHomeTimeZone(),
    low_warnings: true,
    updated_at: null,
  };
}

function normalize(row: DeviceQuietHours): DeviceQuietHours {
  return {
    device_id: row.device_id,
    enabled: row.enabled,
    start_minute: Number(row.start_minute),
    end_minute: Number(row.end_minute),
    time_zone: row.time_zone,
    low_warnings: row.low_warnings,
    updated_at: row.updated_at ? new Date(row.updated_at).toISOString() : null,
  };
}
