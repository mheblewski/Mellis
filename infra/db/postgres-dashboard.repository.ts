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
