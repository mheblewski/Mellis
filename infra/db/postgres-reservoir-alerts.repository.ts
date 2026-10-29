import type { Pool } from 'pg';
import { caregiverDeviceSql } from './sharing-access.sql';
import type { ReservoirAlertDecision, ReservoirAlertState, ReservoirAlertStore } from '@modules/reservoir-alerts/application/reservoir-alerts';

/** Only phones of members allowed glucose alerts (sharing): the reservoir push is one of them. */
const CURRENT_CAREGIVER_DEVICE_SQL = caregiverDeviceSql('glucose_alerts');

/** Reservoir pushes (migration 096, reservoir-alerts.v1): the phones with "Zbiornik insuliny" on and what was pushed. */
export class PostgresReservoirAlertsRepository implements ReservoirAlertStore {
  constructor(private readonly pool: Pool) {}

  async listPatientsWithReservoirDevices(): Promise<string[]> {
    const result = await this.pool.query<{ patient_id: string }>(
      `SELECT DISTINCT d.patient_id::text FROM patient_devices d WHERE d.platform = 'ios' AND d.active = true AND d.reservoir_push_enabled = true AND ${CURRENT_CAREGIVER_DEVICE_SQL}`,
    );
    return result.rows.map((row) => row.patient_id);
  }

  /** One row per push token: a phone registered twice (a reinstall) gets the push once. */
  async listReservoirDevices(patientId: string): Promise<Array<{ device_id: string; push_token: string }>> {
    const result = await this.pool.query<{ device_id: string; push_token: string }>(
      `
        SELECT DISTINCT ON (d.push_token) d.device_id, d.push_token
        FROM patient_devices d
        WHERE d.patient_id = $1::uuid AND d.platform = 'ios' AND d.active = true AND d.reservoir_push_enabled = true
          AND ${CURRENT_CAREGIVER_DEVICE_SQL}
        ORDER BY d.push_token, d.updated_at DESC
      `,
      [patientId],
    );
    return result.rows;
  }

  async getState(patientId: string): Promise<ReservoirAlertState | null> {
    const result = await this.pool.query(
      `SELECT patient_id::text, notified_level, notified_at, last_units, reservoir_changed_at, revision FROM reservoir_alert_states WHERE patient_id = $1::uuid`,
      [patientId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      patient_id: String(row.patient_id),
      notified_level: row.notified_level ?? null,
      notified_at: row.notified_at ? new Date(row.notified_at).toISOString() : null,
      last_units: row.last_units === null || row.last_units === undefined ? null : Number(row.last_units),
      reservoir_changed_at: row.reservoir_changed_at ? new Date(row.reservoir_changed_at).toISOString() : null,
      revision: Number(row.revision),
    };
  }

  async saveState(
    patientId: string,
    revision: number,
    next: NonNullable<ReservoirAlertDecision['next']>,
    notified: { units: number; hours_left: number | null } | null,
  ): Promise<boolean> {
    const values = [patientId, next.notified_level, next.notified_at, next.last_units, next.reservoir_changed_at, notified?.units ?? null, notified?.hours_left ?? null];
    if (revision < 0) {
      const inserted = await this.pool.query(
        `
          INSERT INTO reservoir_alert_states (patient_id, notified_level, notified_at, last_units, reservoir_changed_at, notified_units, notified_hours_left)
          VALUES ($1::uuid, $2, $3::timestamptz, $4, $5::timestamptz, $6, $7)
          ON CONFLICT (patient_id) DO NOTHING
        `,
        values,
      );
      return (inserted.rowCount ?? 0) > 0;
    }
    const updated = await this.pool.query(
      `
        UPDATE reservoir_alert_states
        SET notified_level = $2,
            notified_at = $3::timestamptz,
            last_units = $4,
            reservoir_changed_at = $5::timestamptz,
            notified_units = CASE WHEN $6::numeric IS NULL THEN notified_units ELSE $6::numeric END,
            notified_hours_left = CASE WHEN $6::numeric IS NULL THEN notified_hours_left ELSE $7::numeric END,
            revision = revision + 1,
            updated_at = now()
        WHERE patient_id = $1::uuid AND revision = $8
      `,
      [...values, revision],
    );
    return (updated.rowCount ?? 0) > 0;
  }

  async deactivatePushToken(pushToken: string): Promise<void> {
    await this.pool.query(`UPDATE patient_devices SET active = false, updated_at = now() WHERE platform = 'ios' AND push_token = $1 AND active = true`, [pushToken]);
  }
}
