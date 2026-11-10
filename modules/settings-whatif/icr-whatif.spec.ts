import { describe, expect, it } from 'vitest';
import { insulinOnBoard } from '@modules/glucose-forecast/application/bolus-forecast';
import { ICR_WHATIF_POLICY, replayIcrChange, type WhatIfData } from './application/icr-whatif';

const DAY = 24 * 3600 * 1000;
const START = Date.UTC(2026, 9, 1); // 1 Oct 2026, UTC
const at = (day: number, hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return START + day * DAY + (h * 60 + m) * 60000;
};

/** Flat glucose every 5 min for `days` days, with optional overrides (epoch ms → mg/dL). */
function readings(days: number, level: number, override: (ms: number) => number | null = () => null): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let ms = START; ms < START + (days + 1) * DAY; ms += 300000) out.push([ms, override(ms) ?? level]);
  return out;
}

function data(partial: Partial<WhatIfData> = {}): WhatIfData {
  return {
    time_zone: 'UTC',
    readings: readings(30, 120),
    carbs: [],
    boluses: [],
    smbs: [],
    temps: [],
    therapies: [{ from_ms: null, carb_ratio_g_per_u: [['00:00', 10], ['06:00', 5], ['09:30', 10]], sensitivity_per_u: [['00:00', 100]], basal_u_per_h: [['00:00', 0.2]], units: 'mg/dl' }],
    dia_hours: 5,
    peak_minutes: 75,
    ...partial,
  };
}

/** One 30 g lunch at 12:00 with its full ICR dose (3 U at ICR 10), every day. */
function lunches(days: number, time = '12:00', grams = 30, units = 3) {
  return {
    carbs: Array.from({ length: days }, (_, d) => ({ ms: at(d, time), g: grams, kind: 'MEAL' as const })),
    boluses: Array.from({ length: days }, (_, d) => [at(d, time), units] as [number, number]),
  };
}

describe('replayIcrChange (icr-whatif.v1)', () => {
  it('refuses ratios outside 0.5–2 and missing settings', () => {
    expect(replayIcrChange(data(lunches(25)), { kind: 'ALL' }, 2.5).status).toBe('RATIO_OUT_OF_RANGE');
    expect(replayIcrChange(data(lunches(25)), { kind: 'ALL' }, 0.4).status).toBe('RATIO_OUT_OF_RANGE');
    expect(replayIcrChange(data({ ...lunches(25), therapies: [] }), { kind: 'ALL' }, 1.25).status).toBe('NO_SETTINGS');
  });

  it('gives no result below the minimum number of meals', () => {
    const result = replayIcrChange(data(lunches(ICR_WHATIF_POLICY.min_meals - 1)), { kind: 'ALL' }, 1.25);
    expect(result).toMatchObject({ status: 'TOO_FEW_MEALS', meals: ICR_WHATIF_POLICY.min_meals - 1 });
  });

  it('changes nothing at ratio 1', () => {
    const result = replayIcrChange(data(lunches(25)), { kind: 'ALL' }, 1);
    if (result.status !== 'OK') throw new Error(result.status);
    expect(result.total.after.mean_mgdl).toBeCloseTo(result.total.now.mean_mgdl, 6);
    expect(result.total.dose_change_u_per_meal).toBeCloseTo(0, 9);
  });

  it('shifts glucose by the missing carb insulin x ISF along the insulin curve (no loop data)', () => {
    const result = replayIcrChange(data(lunches(25)), { kind: 'ALL' }, 1.25);
    if (result.status !== 'OK') throw new Error(result.status);
    // 3 U at ICR 10 for 30 g; ICR 12.5 gives 2.4 U: 0.6 U less, ISF 100.
    expect(result.total.dose_change_u_per_meal).toBeCloseTo(-0.6, 6);
    const steps = ICR_WHATIF_POLICY.window_seconds / ICR_WHATIF_POLICY.step_seconds + 1;
    let expected = 0;
    for (let k = 0; k < steps; k += 1) expected += 0.6 * 100 * (1 - insulinOnBoard(k * 5, 300, 75));
    expect(result.total.after.mean_mgdl - result.total.now.mean_mgdl).toBeCloseTo(expected / steps, 6);
    expect(result.total.loop_change_u_per_meal).toBe(0);
    expect(result.small_sample).toBe(true);
  });

  it('scales only the carb part of a bolus, not a correction on top', () => {
    const plain = replayIcrChange(data(lunches(25)), { kind: 'ALL' }, 1.25);
    const withCorrection = replayIcrChange(data(lunches(25, '12:00', 30, 4)), { kind: 'ALL' }, 1.25);
    if (plain.status !== 'OK' || withCorrection.status !== 'OK') throw new Error('not OK');
    expect(withCorrection.total.dose_change_u_per_meal).toBeCloseTo(plain.total.dose_change_u_per_meal, 6);
  });

  it('replays only the meals of the named block, reading blocks from the current settings', () => {
    const morning = lunches(25, '07:00', 20, 4);
    const noon = lunches(25, '12:00');
    const both = data({ carbs: [...morning.carbs, ...noon.carbs], boluses: [...morning.boluses, ...noon.boluses] });
    const result = replayIcrChange(both, { kind: 'BLOCK', start: '06:00' }, 1.25);
    if (result.status !== 'OK') throw new Error(result.status);
    expect(result.total.key).toBe('06:00');
    expect(result.total.meals).toBe(25);
    expect(result.total.icr_now).toBe(5);
    expect(result.total.icr_after).toBe(6.3);
    expect(result.blocks.map((b) => b.key)).toEqual(['06:00']);
    expect(result.total.dose_change_u_per_meal).toBeCloseTo(-0.8, 6);
  });

  it('removes rescue carbs the shifted glucose no longer needs', () => {
    // Every lunch dips to 65 at 14:00–14:30 and gets 2 g of hypo treatment at 14:00 (removing it takes 20 mg/dL off
    // the later glucose: g x ISF / ICR, so a small rescue keeps the shifted glucose above 70).
    const dip = (ms: number) => {
      const minute = ((ms - START) % DAY) / 60000;
      return minute >= 14 * 60 && minute <= 14 * 60 + 30 ? 65 : null;
    };
    const base = lunches(25);
    const rescue = Array.from({ length: 25 }, (_, d) => ({ ms: at(d, '14:00'), g: 2, kind: 'HYPO_TREATMENT' as const }));
    const result = replayIcrChange(data({ ...base, carbs: [...base.carbs, ...rescue], readings: readings(30, 120, dip) }), { kind: 'ALL' }, 1.25);
    if (result.status !== 'OK') throw new Error(result.status);
    expect(result.total.rescues_removed).toBe(25);
    expect(result.total.now.meals_with_drop_below_70).toBe(25);
    expect(result.total.after.meals_with_drop_below_70).toBe(0);
    // Carbs eaten while below 80 are rescues, not meals.
    expect(result.total.meals).toBe(25);
  });

  it('counts meals that went above 180 and later below 70 as a fact from the data', () => {
    const shape = (ms: number) => {
      const minute = ((ms - START) % DAY) / 60000;
      if (minute >= 12 * 60 + 60 && minute < 12 * 60 + 120) return 220;
      if (minute >= 12 * 60 + 200 && minute < 12 * 60 + 230) return 62;
      return null;
    };
    const result = replayIcrChange(data({ ...lunches(25), readings: readings(30, 120, shape) }), { kind: 'ALL' }, 1.25);
    if (result.status !== 'OK') throw new Error(result.status);
    expect(result.total.meals_high_then_low).toBe(25);
    expect(result.total.now.meals_above_180_over_1h).toBe(25);
  });

  it('lets the measured loop answer a rise with the extra insulin it really gave at that glucose', () => {
    // At glucose >= 160 (30 min ahead) this loop gave an SMB of 0.1 U every 5 min; below it gave nothing.
    const rise = (ms: number) => {
      const minute = ((ms - START) % DAY) / 60000;
      return minute >= 12 * 60 && minute < 12 * 60 + 300 && (Math.floor(ms / 86400000) % 2 === 0) ? 200 : null;
    };
    const days = 30;
    const base = lunches(days);
    const all = readings(days, 120, rise);
    const smbs = all.filter(([, v]) => v >= 160).map(([ms]) => [ms, 0.1] as [number, number]);
    const result = replayIcrChange(data({ ...base, readings: all, smbs }), { kind: 'ALL' }, 1.5);
    if (result.status !== 'OK') throw new Error(result.status);
    expect(result.total.loop_change_u_per_meal).toBeGreaterThan(0);
    const noLoop = replayIcrChange(data({ ...base, readings: all }), { kind: 'ALL' }, 1.5);
    if (noLoop.status !== 'OK') throw new Error(noLoop.status);
    expect(result.total.after.mean_mgdl).toBeLessThan(noLoop.total.after.mean_mgdl);
  });

  it('adds the night after dinner for evening changes', () => {
    const dinners = lunches(25, '19:00', 30, 3);
    const result = replayIcrChange(data({ ...dinners, therapies: [{ from_ms: null, carb_ratio_g_per_u: [['00:00', 10], ['18:00', 10]], sensitivity_per_u: [['00:00', 100]], basal_u_per_h: [['00:00', 0.2]], units: 'mg/dl' }] }), { kind: 'BLOCK', start: '18:00' }, 1.25);
    if (result.status !== 'OK') throw new Error(result.status);
    expect(result.night?.nights).toBeGreaterThanOrEqual(24);
    const lunchOnly = replayIcrChange(data(lunches(25)), { kind: 'ALL' }, 1.25);
    if (lunchOnly.status !== 'OK') throw new Error(lunchOnly.status);
    expect(lunchOnly.night).toBeNull();
  });
});
