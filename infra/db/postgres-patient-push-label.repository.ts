import type { Pool } from 'pg';
import type { PatientPushLabeler } from '@modules/notifications/application/patient-push-label';

/** A phone registers once per patient it can access (patient_devices): more than one active row = several patients. */
export class PostgresPatientPushLabeler implements PatientPushLabeler {
  constructor(private readonly pool: Pool) {}

  async labelFor(pushToken: string, patientId: string): Promise<string | null> {
    const row = (await this.pool.query<{ display_name: string | null; patients: number }>(
      `
        SELECT p.display_name,
               (SELECT count(DISTINCT d.patient_id)::int FROM patient_devices d WHERE d.platform = 'ios' AND d.active = true AND d.push_token = $1) AS patients
        FROM patients p
        WHERE p.id = $2::uuid
      `,
      [pushToken, patientId],
    )).rows[0];
    return row && row.patients > 1 && row.display_name?.trim() ? row.display_name.trim() : null;
  }
}
