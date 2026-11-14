import type { Pool } from 'pg';
import type { ClinicReportCycle } from '@modules/clinic-report/application/clinic-report-data';

/** The clinic report's own reads (clinic-report.v1): the loop's decisions without predictions, and who the patient is. */
export class PostgresClinicReportRepository {
  constructor(private readonly pool: Pool) {}

  /** One oref decision per cycle (the enacted copy first): its reason text and IOB only — light for 28 days. */
  async loadCycles(patientId: string, fromIso: string, toIso: string): Promise<ClinicReportCycle[]> {
    const rows = (await this.pool.query<{ occurred_at: Date; reason: string | null; iob: number | null }>(
      `SELECT DISTINCT ON (coalesce(r.raw_payload->'openaps'->'suggested'->>'deliverAt', r.occurred_at::text))
         r.occurred_at, r.raw_payload->'openaps'->'suggested'->>'reason' AS reason,
         CASE WHEN jsonb_typeof(r.raw_payload->'openaps'->'suggested'->'IOB') = 'number' THEN (r.raw_payload->'openaps'->'suggested'->>'IOB')::float8 END AS iob
       FROM source_records r
       WHERE r.patient_id = $1::uuid AND r.record_type = 'DEVICE_STATUS' AND r.raw_payload->'openaps' ? 'suggested'
         AND r.occurred_at >= $2::timestamptz AND r.occurred_at < $3::timestamptz
       ORDER BY coalesce(r.raw_payload->'openaps'->'suggested'->>'deliverAt', r.occurred_at::text),
         (r.raw_payload->'openaps'->'enacted'->>'received')::boolean DESC NULLS LAST, r.occurred_at DESC`,
      [patientId, fromIso, toIso],
    )).rows;
    return rows.filter((r) => typeof r.reason === 'string').map((r) => ({ ms: r.occurred_at.getTime(), reason: r.reason as string, iob: r.iob }));
  }

  async patient(patientId: string): Promise<{ name: string; birthYear: number | null }> {
    const row = (await this.pool.query<{ display_name: string; birth_year: number | null }>(
      `SELECT display_name, birth_year FROM patients WHERE id = $1::uuid`, [patientId],
    )).rows[0];
    return { name: row?.display_name ?? '', birthYear: row?.birth_year ?? null };
  }
}
