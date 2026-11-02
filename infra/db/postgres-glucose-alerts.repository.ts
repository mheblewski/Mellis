import type { Pool } from 'pg';
import { caregiverDeviceSql } from './sharing-access.sql';
import {
  GLUCOSE_ALERT_SETTINGS,
  type GlucoseAlertDevice,
  type GlucoseAlertSetting,
  type GlucoseAlertState,
  type GlucoseAlertStore,
} from '@modules/glucose-alerts/application/glucose-alerts';

/** Only phones of members allowed glucose alerts (sharing). */
const CURRENT_CAREGIVER_DEVICE_SQL = caregiverDeviceSql('glucose_alerts');

/** Glucose pushes (migration 098, glucose-alerts.v1): the phones with "Powiadomienia o glikemii" on and what was pushed. */
export class PostgresGlucoseAlertsRepository implements GlucoseAlertStore {
  constructor(private readonly pool: Pool) {}

  async listPatientsWithGlucoseAlertDevices(): Promise<string[]> {
    const result = await this.pool.query<{ patient_id: string }>(
      `SELECT DISTINCT d.patient_id::text FROM patient_devices d WHERE d.platform = 'ios' AND d.active = true AND d.glucose_alerts_enabled = true AND ${CURRENT_CAREGIVER_DEVICE_SQL}`,
    );
    return result.rows.map((row) => row.patient_id);
  }

  /** One row per push token: a phone registered twice (a reinstall) gets the push once. */
  async listGlucoseAlertDevices(patientId: string): Promise<GlucoseAlertDevice[]> {
    const result = await this.pool.query<{
      device_id: string;
      push_token: string;
      glucose_alert_kinds_off: string[] | null;
      glucose_alert_low_repeat_minutes: number;
      glucose_alert_repeat_minutes: number;
    }>(
      `
        SELECT DISTINCT ON (d.push_token) d.device_id, d.push_token, d.glucose_alert_kinds_off,
          d.glucose_alert_low_repeat_minutes, d.glucose_alert_repeat_minutes
        FROM patient_devices d
        WHERE d.patient_id = $1::uuid AND d.platform = 'ios' AND d.active = true AND d.glucose_alerts_enabled = true
          AND ${CURRENT_CAREGIVER_DEVICE_SQL}
        ORDER BY d.push_token, d.updated_at DESC
      `,
      [patientId],
    );
    return result.rows.map((row) => ({
      device_id: row.device_id,
      push_token: row.push_token,
      kinds_off: (row.glucose_alert_kinds_off ?? []).filter((kind): kind is GlucoseAlertSetting => (GLUCOSE_ALERT_SETTINGS as readonly string[]).includes(kind)),
      low_repeat_minutes: Number(row.glucose_alert_low_repeat_minutes),
      repeat_minutes: Number(row.glucose_alert_repeat_minutes),
    }));
  }

  async getState(patientId: string): Promise<GlucoseAlertState | null> {
    const result = await this.pool.query(
      `SELECT patient_id::text, last_reading_at, sent, no_data_sent_at, revision FROM glucose_alert_states WHERE patient_id = $1::uuid`,
      [patientId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      patient_id: String(row.patient_id),
      last_reading_at: row.last_reading_at ? new Date(row.last_reading_at).toISOString() : null,
      sent: row.sent && typeof row.sent === 'object' ? row.sent : {},
      no_data_sent_at: row.no_data_sent_at ? new Date(row.no_data_sent_at).toISOString() : null,
      revision: Number(row.revision),
    };
  }

  async saveState(patientId: string, revision: number, next: Omit<GlucoseAlertState, 'patient_id' | 'revision'>): Promise<boolean> {
    const values = [patientId, next.last_reading_at, JSON.stringify(next.sent), next.no_data_sent_at];
    if (revision < 0) {
      const inserted = await this.pool.query(
        `
          INSERT INTO glucose_alert_states (patient_id, last_reading_at, sent, no_data_sent_at)
          VALUES ($1::uuid, $2::timestamptz, $3::jsonb, $4::timestamptz)
          ON CONFLICT (patient_id) DO NOTHING
        `,
        values,
      );
      return (inserted.rowCount ?? 0) > 0;
    }
    const updated = await this.pool.query(
      `
        UPDATE glucose_alert_states
        SET last_reading_at = $2::timestamptz, sent = $3::jsonb, no_data_sent_at = $4::timestamptz,
            revision = revision + 1, updated_at = now()
        WHERE patient_id = $1::uuid AND revision = $5
      `,
      [...values, revision],
    );
    return (updated.rowCount ?? 0) > 0;
  }

  async deactivatePushToken(pushToken: string): Promise<void> {
    await this.pool.query(`UPDATE patient_devices SET active = false, updated_at = now() WHERE platform = 'ios' AND push_token = $1 AND active = true`, [pushToken]);
  }
}
