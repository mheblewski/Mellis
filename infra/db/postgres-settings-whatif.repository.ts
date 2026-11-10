import type { Pool } from 'pg';
import type { CarbKind, WhatIfData, WhatIfTherapy } from '@modules/settings-whatif/application/icr-whatif';

/** Events a user excluded from the evidence are left out here too (same rule as the other readers). */
const NOT_EXCLUDED_EVIDENCE_SQL = `NOT EXISTS (
  SELECT 1 FROM evidence_exclusions x
  WHERE x.patient_id = e.patient_id
    AND x.lifecycle_status = 'ACTIVE'
    AND ((x.target_kind = 'EVENT' AND x.target_id = e.id) OR (x.target_kind = 'SOURCE_RECORD' AND x.target_id = e.source_record_id))
)`;

const CARB_KINDS: ReadonlySet<string> = new Set(['MEAL', 'HYPO_TREATMENT', 'CORRECTION_CARBS', 'IGNORED', 'FAT_PROTEIN_UNITS']);

type Schedule = Array<[string, number]>;

function schedule(value: unknown): Schedule | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const entries = value
    .map((entry) => entry as Record<string, unknown>)
    .filter((entry) => typeof entry?.time === 'string' && Number.isFinite(Number(entry.value)))
    .map((entry) => [String(entry.time), Number(entry.value)] as [string, number]);
  return entries.length > 0 ? entries : null;
}

const num = (value: unknown): number | null => {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
};

/**
 * Read-only input of the ICR what-if replay (icr-whatif.v1): one patient's readings, carb entries with their kinds,
 * manual boluses, SMBs, temp basals and therapy history for the last `days` days before `endIso` (+ 6 h before, so the
 * first meals have their doses). The insulin curve's peak comes from the caller (it is resolved elsewhere).
 */
export class PostgresSettingsWhatIfRepository {
  constructor(private readonly pool: Pick<Pool, 'query'>) {}

  async loadIcrWhatIfData(args: { patientId: string; endIso: string; days: number; defaultTimeZone: string; peakMinutes: number }): Promise<WhatIfData> {
    const params = [args.patientId, args.endIso, `${Math.max(1, Math.min(90, Math.floor(args.days)))} days`];
    const range = `e.patient_id = $1::uuid AND e.occurred_at <= $2::timestamptz AND e.occurred_at >= $2::timestamptz - $3::interval - interval '6 hours' AND ${NOT_EXCLUDED_EVIDENCE_SQL}`;
    const ms = (value: unknown) => new Date(value as string).getTime();

    const [readings, carbs, doses, therapies] = await Promise.all([
      this.pool.query(
        `
          SELECT e.occurred_at,
            CASE
              WHEN jsonb_typeof(e.payload->'glucose_value') = 'number' THEN (e.payload->>'glucose_value')::float8
              WHEN jsonb_typeof(e.payload->'glucose') = 'number' THEN (e.payload->>'glucose')::float8
              WHEN jsonb_typeof(e.payload->'raw_payload'->'sgv') = 'number' THEN (e.payload->'raw_payload'->>'sgv')::float8
            END AS value
          FROM events e
          WHERE ${range} AND e.type IN ('GLUCOSE_READING_AVAILABLE', 'GLUCOSE_READING', 'GLUCOSE')
          ORDER BY e.occurred_at
        `,
        params,
      ),
      this.pool.query(
        `
          SELECT e.occurred_at, (e.payload->>'carbs')::float8 AS grams, k.kind
          FROM events e
          LEFT JOIN carb_entry_kinds k ON k.event_id = e.id AND k.patient_id = e.patient_id
          WHERE ${range} AND e.type = 'CARB_ENTRY'
          ORDER BY e.occurred_at
        `,
        params,
      ),
      this.pool.query(
        `
          SELECT e.type, e.occurred_at, (e.payload->>'insulin_units')::float8 AS units,
            (e.payload->>'absolute')::float8 AS rate, (e.payload->>'duration_minutes')::float8 AS duration
          FROM events e
          WHERE ${range} AND e.type IN ('BOLUS', 'SMB', 'TEMP_BASAL')
          ORDER BY e.occurred_at
        `,
        params,
      ),
      this.pool.query(
        `
          SELECT valid_from, snapshot->'profile' AS profile
          FROM therapies
          WHERE patient_id = $1::uuid
            AND (valid_from IS NULL OR valid_from <= $2::timestamptz)
            AND (valid_to IS NULL OR valid_to >= $2::timestamptz - $3::interval - interval '1 day')
          ORDER BY valid_from NULLS FIRST, created_at
        `,
        params,
      ),
    ]);

    const therapyRows = therapies.rows.map((row) => ({ from: row.valid_from ? ms(row.valid_from) : null, profile: (row.profile ?? {}) as Record<string, unknown> }));
    const latest = therapyRows[therapyRows.length - 1]?.profile ?? null;
    const dia = num(latest?.dia);

    return {
      time_zone: typeof latest?.timezone === 'string' && latest.timezone ? latest.timezone : args.defaultTimeZone,
      readings: readings.rows.map((row) => [ms(row.occurred_at), num(row.value)] as [number, number | null]).filter((r): r is [number, number] => r[1] !== null && r[1] > 0),
      carbs: carbs.rows
        .map((row) => ({ ms: ms(row.occurred_at), g: num(row.grams) ?? 0, kind: (typeof row.kind === 'string' && CARB_KINDS.has(row.kind) ? row.kind : null) as CarbKind }))
        .filter((c) => c.g > 0),
      boluses: doses.rows.filter((row) => row.type === 'BOLUS' && (num(row.units) ?? 0) > 0).map((row) => [ms(row.occurred_at), num(row.units) as number]),
      smbs: doses.rows.filter((row) => row.type === 'SMB' && (num(row.units) ?? 0) > 0).map((row) => [ms(row.occurred_at), num(row.units) as number]),
      temps: doses.rows
        .filter((row) => row.type === 'TEMP_BASAL' && num(row.rate) !== null && (num(row.duration) ?? 0) > 0)
        .map((row) => [ms(row.occurred_at), num(row.rate) as number, num(row.duration) as number]),
      therapies: therapyRows.map((row): WhatIfTherapy => ({
        from_ms: row.from,
        carb_ratio_g_per_u: schedule(row.profile.carbratio),
        sensitivity_per_u: schedule(row.profile.sens),
        basal_u_per_h: schedule(row.profile.basal),
        units: typeof row.profile.units === 'string' ? row.profile.units : null,
      })),
      dia_hours: dia !== null && dia > 0 ? dia : null,
      peak_minutes: args.peakMinutes,
    };
  }
}
