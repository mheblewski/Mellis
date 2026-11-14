import type { Pool } from 'pg';
import type { DashboardDeviceStatus, DashboardGlucoseReading } from '@modules/dashboard/application/dashboard-snapshot';

/** Reads for the Dashboard tab: synced CGM readings and the newest pump and loop status uploaded by the loop app. */
export class PostgresDashboardRepository {
  constructor(private readonly pool: Pool) {}

  async listGlucoseReadingsSince(patientId: string, sinceIso: string): Promise<DashboardGlucoseReading[]> {
    const result = await this.pool.query<{ occurred_at: Date | string; glucose_value: string | number; direction: string | null }>(
      `
        SELECT e.occurred_at,
               e.payload->>'glucose_value' AS glucose_value,
               COALESCE(sr.raw_payload->>'direction', sr.provenance->'source_fields'->>'direction') AS direction
        FROM events e
        INNER JOIN source_records sr ON sr.id = e.source_record_id
        WHERE e.patient_id = $1
          AND e.type = 'GLUCOSE_READING_AVAILABLE'
          AND e.occurred_at >= $2::timestamptz
        ORDER BY e.occurred_at ASC
      `,
      [patientId, sinceIso],
    );
    return PostgresDashboardRepository.readings(result.rows);
  }

  /** The chart's history: the same readings in [from, to), without the trend (only the latest reading's is shown). */
  async listGlucoseReadingsBetween(patientId: string, fromIso: string, toIso: string): Promise<DashboardGlucoseReading[]> {
    const result = await this.pool.query<{ occurred_at: Date | string; glucose_value: string | number; direction: string | null }>(
      `
        SELECT e.occurred_at,
               e.payload->>'glucose_value' AS glucose_value,
               NULL::text AS direction
        FROM events e
        INNER JOIN source_records sr ON sr.id = e.source_record_id
        WHERE e.patient_id = $1
          AND e.type = 'GLUCOSE_READING_AVAILABLE'
          AND e.occurred_at >= $2::timestamptz
          AND e.occurred_at < $3::timestamptz
        ORDER BY e.occurred_at ASC
      `,
      [patientId, fromIso, toIso],
    );
    return PostgresDashboardRepository.readings(result.rows);
  }

  /**
   * The loop's calculations in [from, to) for the chart's IOB/COB. Only the few numbers the chart reads leave the
   * database (a Trio devicestatus carries kilobytes of predictions).
   */
  async listLoopStatusesBetween(patientId: string, fromIso: string, toIso: string): Promise<DashboardDeviceStatus[]> {
    const result = await this.pool.query<{ occurred_at: Date | string; loop_payload: Record<string, unknown> | null }>(
      `
        SELECT occurred_at,
               jsonb_build_object(
                 'openaps', jsonb_build_object(
                   'iob', jsonb_build_object('iob', raw_payload #> '{openaps,iob,iob}'),
                   'suggested', jsonb_build_object('IOB', raw_payload #> '{openaps,suggested,IOB}', 'COB', raw_payload #> '{openaps,suggested,COB}'),
                   'enacted', jsonb_build_object('IOB', raw_payload #> '{openaps,enacted,IOB}', 'COB', raw_payload #> '{openaps,enacted,COB}')
                 ),
                 'loop', jsonb_build_object(
                   'iob', jsonb_build_object('iob', raw_payload #> '{loop,iob,iob}'),
                   'cob', jsonb_build_object('cob', raw_payload #> '{loop,cob,cob}')
                 )
               ) AS loop_payload
        FROM source_records
        WHERE patient_id = $1
          AND record_type = 'DEVICE_STATUS'
          AND occurred_at >= $2::timestamptz
          AND occurred_at < $3::timestamptz
          AND raw_payload ?| ARRAY['openaps', 'loop']
        ORDER BY occurred_at ASC
      `,
      [patientId, fromIso, toIso],
    );
    return result.rows.map((row) => ({ observed_at: new Date(row.occurred_at).toISOString(), raw_payload: row.loop_payload ?? {} }));
  }

  /** The loop's numbers for the Teraz screen in [from, to): IOB, COB and the rate it last set, without the kilobytes of predictions. */
  async listLoopSnapshotsBetween(patientId: string, fromIso: string, toIso: string): Promise<DashboardDeviceStatus[]> {
    const result = await this.pool.query<{ occurred_at: Date | string; loop_payload: Record<string, unknown> | null }>(
      `
        SELECT occurred_at,
               jsonb_build_object(
                 'openaps', jsonb_build_object(
                   'iob', jsonb_build_object('iob', raw_payload #> '{openaps,iob,iob}'),
                   'suggested', jsonb_build_object('IOB', raw_payload #> '{openaps,suggested,IOB}', 'COB', raw_payload #> '{openaps,suggested,COB}'),
                   'enacted', jsonb_build_object('IOB', raw_payload #> '{openaps,enacted,IOB}', 'COB', raw_payload #> '{openaps,enacted,COB}', 'rate', raw_payload #> '{openaps,enacted,rate}')
                 ),
                 'loop', jsonb_build_object(
                   'iob', jsonb_build_object('iob', raw_payload #> '{loop,iob,iob}'),
                   'cob', jsonb_build_object('cob', raw_payload #> '{loop,cob,cob}'),
                   'enacted', jsonb_build_object('rate', raw_payload #> '{loop,enacted,rate}')
                 )
               ) AS loop_payload
        FROM source_records
        WHERE patient_id = $1
          AND record_type = 'DEVICE_STATUS'
          AND occurred_at >= $2::timestamptz
          AND occurred_at < $3::timestamptz
          AND raw_payload ?| ARRAY['openaps', 'loop']
        ORDER BY occurred_at ASC
      `,
      [patientId, fromIso, toIso],
    );
    return result.rows.map((row) => ({ observed_at: new Date(row.occurred_at).toISOString(), raw_payload: row.loop_payload ?? {} }));
  }

  /**
   * Carb entries of [from, to) for the Teraz screen: the stored kind without a default, who set it, and whether Mellis
   * logged the entry. Deleted, ignored and fat-protein entries are left out.
   */
  async listSituationCarbEntries(patientId: string, fromIso: string, toIso: string): Promise<Array<{ event_id: string; occurred_at: Date | string; carbs: string | number | null; kind: string | null; entry_source: string | null; in_loop: string | boolean | null; by_user_id: string | null; by_name: string | null; by_gender: string | null }>> {
    const result = await this.pool.query(
      `
        SELECT e.id::text AS event_id, e.occurred_at, e.payload->>'carbs' AS carbs, k.kind, e.payload->>'entry_source' AS entry_source, e.payload->>'in_loop' AS in_loop,
               k.set_by_user_id::text AS by_user_id,
               CASE WHEN u.display_name ~* '^(cognito:)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN NULL ELSE u.display_name END AS by_name,
               u.preferences->>'grammatical_gender' AS by_gender
        FROM events e
        LEFT JOIN carb_entry_kinds k ON k.patient_id = e.patient_id AND k.event_id = e.id
        LEFT JOIN users u ON u.id = k.set_by_user_id
        WHERE e.patient_id = $1
          AND e.type = 'CARB_ENTRY'
          AND e.occurred_at >= $2::timestamptz
          AND e.occurred_at < $3::timestamptz
          AND COALESCE(k.kind, '') NOT IN ('IGNORED', 'FAT_PROTEIN_UNITS')
        ORDER BY e.occurred_at ASC
      `,
      [patientId, fromIso, toIso],
    );
    return result.rows;
  }

  /**
   * Remote boluses the loop confirmed (fully or in part) since then, with who sent them, for Teraz's "Ewa 5 minut temu
   * podała bolus" (now-situation v4). The time is when the command went to the loop.
   */
  async listRemoteBolusesSince(patientId: string, sinceIso: string): Promise<Array<{ at: string; units: number; carbs_g: number; status: 'SUCCEEDED' | 'PARTIAL'; by_user_id: string; by_name: string | null; by_gender: 'f' | 'm' | null }>> {
    const result = await this.pool.query<{ at: Date | string; units: string | number; carbs_g: string | number; status: 'SUCCEEDED' | 'PARTIAL'; by_user_id: string; by_name: string | null; by_gender: string | null }>(
      `SELECT COALESCE(c.sent_at, c.authorized_at) AS at, c.insulin_u AS units, c.carbs_g, c.status, c.user_id::text AS by_user_id,
              CASE WHEN u.display_name ~* '^(cognito:)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN NULL ELSE u.display_name END AS by_name,
              u.preferences->>'grammatical_gender' AS by_gender
       FROM remote_commands c
       JOIN users u ON u.id = c.user_id
       WHERE c.patient_id = $1::uuid AND c.insulin_u > 0 AND c.status IN ('SUCCEEDED', 'PARTIAL')
         AND COALESCE(c.sent_at, c.authorized_at) >= $2::timestamptz
       ORDER BY 1 ASC`,
      [patientId, sinceIso],
    );
    return result.rows.map((row) => ({
      at: new Date(row.at).toISOString(),
      units: Number(row.units),
      carbs_g: Number(row.carbs_g),
      status: row.status,
      by_user_id: row.by_user_id,
      by_name: row.by_name,
      by_gender: row.by_gender === 'f' || row.by_gender === 'm' ? row.by_gender : null,
    }));
  }

  /** A remote bolus since then that did not finish cleanly: refused, partial, or still without an answer. */
  async hasBolusProblemSince(patientId: string, sinceIso: string): Promise<boolean> {
    const result = await this.pool.query(
      `SELECT EXISTS (
         SELECT 1 FROM remote_commands
         WHERE patient_id = $1::uuid AND insulin_u > 0 AND created_at >= $2::timestamptz
           AND status IN ('PARTIAL', 'NO_REPLY', 'SENT', 'TRIO_ACCEPTED')
       ) AS problem`,
      [patientId, sinceIso],
    );
    return Boolean(result.rows[0]?.problem);
  }

  /** The patient's name for texts; null when it is only an id. */
  async getPatientLabel(patientId: string): Promise<string | null> {
    const result = await this.pool.query<{ label: string | null }>(
      `SELECT CASE WHEN display_name ~* '^(cognito:)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN NULL ELSE display_name END AS label FROM patients WHERE id = $1`,
      [patientId],
    );
    return result.rows[0]?.label ?? null;
  }

  private static readings(rows: Array<{ occurred_at: Date | string; glucose_value: string | number; direction: string | null }>): DashboardGlucoseReading[] {
    return rows.map((row) => ({
      at: new Date(row.occurred_at).toISOString(),
      value: Number(row.glucose_value),
      direction: row.direction && row.direction.trim() ? row.direction.trim() : null,
    }));
  }

  async getLatestPumpStatus(patientId: string): Promise<DashboardDeviceStatus | null> {
    return this.latestDeviceStatusWith(patientId, ['pump']);
  }

  /** The loop's calculation (IOB, COB): Trio/AAPS upload it under `openaps`, Loop under `loop`. */
  async getLatestLoopStatus(patientId: string): Promise<DashboardDeviceStatus | null> {
    return this.latestDeviceStatusWith(patientId, ['openaps', 'loop']);
  }

  /** The loop's newest calculation stored at or before `atIso` (therapy-now.v1: as of the caregiver's question). */
  async getLoopStatusAtOrBefore(patientId: string, atIso: string): Promise<DashboardDeviceStatus | null> {
    const result = await this.pool.query<{ occurred_at: Date | string; raw_payload: Record<string, unknown> }>(
      `
        SELECT occurred_at, raw_payload
        FROM source_records
        WHERE patient_id = $1
          AND record_type = 'DEVICE_STATUS'
          AND raw_payload ?| ARRAY['openaps', 'loop']
          AND occurred_at <= $2::timestamptz
        ORDER BY occurred_at DESC
        LIMIT 1
      `,
      [patientId, atIso],
    );
    const row = result.rows[0];
    return row ? { observed_at: new Date(row.occurred_at).toISOString(), raw_payload: row.raw_payload ?? {} } : null;
  }

  private async latestDeviceStatusWith(patientId: string, anyOfKeys: string[]): Promise<DashboardDeviceStatus | null> {
    const result = await this.pool.query<{ occurred_at: Date | string; raw_payload: Record<string, unknown> }>(
      `
        SELECT occurred_at, raw_payload
        FROM source_records
        WHERE patient_id = $1
          AND record_type = 'DEVICE_STATUS'
          AND raw_payload ?| $2::text[]
        ORDER BY occurred_at DESC
        LIMIT 1
      `,
      [patientId, anyOfKeys],
    );

    const row = result.rows[0];
    return row ? { observed_at: new Date(row.occurred_at).toISOString(), raw_payload: row.raw_payload ?? {} } : null;
  }
}
