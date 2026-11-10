import { describe, expect, it } from 'vitest';
import { PostgresSettingsWhatIfRepository } from './postgres-settings-whatif.repository';

/** A pool that answers each query by its first matching keyword. */
function fakePool(answers: Array<[string, Array<Record<string, unknown>>]>) {
  const seen: string[] = [];
  return {
    seen,
    pool: {
      query: async (sql: string, params: unknown[]) => {
        seen.push(String(params[2]));
        const hit = answers.find(([key]) => sql.includes(key));
        return { rows: hit ? hit[1] : [] };
      },
    },
  };
}

describe('PostgresSettingsWhatIfRepository.loadIcrWhatIfData', () => {
  it('maps readings, carbs with kinds, doses and therapies into the replay input', async () => {
    const { pool, seen } = fakePool([
      ["'GLUCOSE_READING_AVAILABLE'", [
        { occurred_at: '2026-11-01T12:00:00Z', value: 120 },
        { occurred_at: '2026-11-01T12:05:00Z', value: null },
      ]],
      ["'CARB_ENTRY'", [
        { occurred_at: '2026-11-01T12:00:00Z', grams: 30, kind: 'MEAL' },
        { occurred_at: '2026-11-01T14:00:00Z', grams: 10, kind: 'SOMETHING_NEW' },
        { occurred_at: '2026-11-01T15:00:00Z', grams: 0, kind: null },
      ]],
      ["'TEMP_BASAL'", [
        { type: 'BOLUS', occurred_at: '2026-11-01T12:00:00Z', units: 3 },
        { type: 'SMB', occurred_at: '2026-11-01T12:30:00Z', units: 0.1 },
        { type: 'SMB', occurred_at: '2026-11-01T12:35:00Z', units: 0 },
        { type: 'TEMP_BASAL', occurred_at: '2026-11-01T13:00:00Z', rate: 0, duration: 30 },
        { type: 'TEMP_BASAL', occurred_at: '2026-11-01T13:30:00Z', rate: null, duration: 30 },
      ]],
      ['FROM therapies', [
        { valid_from: '2026-10-01T00:00:00Z', profile: { carbratio: [{ time: '00:00', value: 10 }], sens: [{ time: '00:00', value: 100 }], basal: [{ time: '00:00', value: 0.2 }], units: 'mg/dl', dia: 5, timezone: 'Europe/Warsaw' } },
      ]],
    ]);
    const data = await new PostgresSettingsWhatIfRepository(pool).loadIcrWhatIfData({ patientId: 'p', endIso: '2026-11-08T00:00:00Z', days: 31, defaultTimeZone: 'UTC', peakMinutes: 75 });

    expect(seen.every((interval) => interval === '31 days')).toBe(true);
    expect(data.time_zone).toBe('Europe/Warsaw');
    expect(data.readings).toEqual([[Date.parse('2026-11-01T12:00:00Z'), 120]]);
    expect(data.carbs).toEqual([
      { ms: Date.parse('2026-11-01T12:00:00Z'), g: 30, kind: 'MEAL' },
      { ms: Date.parse('2026-11-01T14:00:00Z'), g: 10, kind: null },
    ]);
    expect(data.boluses).toEqual([[Date.parse('2026-11-01T12:00:00Z'), 3]]);
    expect(data.smbs).toEqual([[Date.parse('2026-11-01T12:30:00Z'), 0.1]]);
    expect(data.temps).toEqual([[Date.parse('2026-11-01T13:00:00Z'), 0, 30]]);
    expect(data.therapies).toEqual([{ from_ms: Date.parse('2026-10-01T00:00:00Z'), carb_ratio_g_per_u: [['00:00', 10]], sensitivity_per_u: [['00:00', 100]], basal_u_per_h: [['00:00', 0.2]], units: 'mg/dl' }]);
    expect(data.dia_hours).toBe(5);
    expect(data.peak_minutes).toBe(75);
  });

  it('caps the range at 90 days and falls back to the given time zone', async () => {
    const { pool, seen } = fakePool([]);
    const data = await new PostgresSettingsWhatIfRepository(pool).loadIcrWhatIfData({ patientId: 'p', endIso: '2026-11-08T00:00:00Z', days: 400, defaultTimeZone: 'Europe/Warsaw', peakMinutes: 75 });
    expect(seen[0]).toBe('90 days');
    expect(data.time_zone).toBe('Europe/Warsaw');
    expect(data.therapies).toEqual([]);
    expect(data.dia_hours).toBeNull();
  });
});
