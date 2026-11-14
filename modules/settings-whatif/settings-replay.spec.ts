import { describe, expect, it } from 'vitest';
import type { WhatIfData } from './application/icr-whatif';
import { replaySettingChange, windowOutcome, type SettingChange } from './application/settings-replay';
import type { TrioCycleRecord } from './application/trio-replica';

const DAY = 24 * 3600 * 1000;
const STEP = 300000;
const START = Date.UTC(2026, 9, 1);

/**
 * A synthetic Trio log in UTC: glucose flat at `level`, every 5 min a cycle in which the loop wants insulin
 * (insulinReq > 0), sits on the HIGH path and asks for a temp; SMB cap comes from the schedule (not in the text).
 */
function synthetic(days: number, level: number, basal: number, extra: Partial<WhatIfData> = {}): WhatIfData {
  const readings: Array<[number, number]> = [];
  const cycles: TrioCycleRecord[] = [];
  for (let ms = START; ms < START + days * DAY; ms += STEP) {
    readings.push([ms, level]);
    const iob = Array.from({ length: 48 }, () => level);
    const ireq = Math.max(0, (level - 110) / 100);
    const rate = Math.min(basal + 2 * ireq, 4 * basal, 1);
    cycles.push({
      ms: ms + 10000,
      suggested: {
        bg: level, rate, units: null, threshold: 80, current_target: 110, ISF: 100, IOB: 0, eventualBG: level,
        insulinReq: ireq, minDelta: 0, expectedDelta: 0, predBGs: { IOB: iob },
        reason: `Target: 110, minPredBG ${level}, minGuardBG ${level}, Basal ratio: 1; Eventual BG ${level} >= 110, insulinReq ${ireq}; Setting temp basal of ${rate}U/hr.`,
      },
    });
  }
  return {
    time_zone: 'UTC',
    readings,
    carbs: [],
    boluses: [],
    smbs: [],
    temps: [],
    therapies: [{ from_ms: null, carb_ratio_g_per_u: [['00:00', 10]], sensitivity_per_u: [['00:00', 100]], basal_u_per_h: [['00:00', basal]], target_low_mgdl: [['00:00', 110]], units: 'mg/dl' }],
    dia_hours: 10,
    peak_minutes: 75,
    trio_cycles: cycles,
    ...extra,
  };
}

const night = { from: '00:00', to: '06:00' };

describe('replaySettingChange', () => {
  it('reproduces reality exactly when nothing changes', () => {
    const data = synthetic(14, 220, 0.05);
    for (const change of [
      { setting: 'BASAL', from: '00:00', to: '01:00', value: 0.05 },
      { setting: 'TARGET', from: '00:00', to: '06:00', value: 110 },
      { setting: 'ISF', from: '00:00', to: '06:00', value: 100 },
      { setting: 'ICR', from: '00:00', to: '06:00', value: 10 },
    ] as SettingChange[]) {
      const r = replaySettingChange(data, change, night);
      expect(r.status).toBe('OK');
      if (r.status !== 'OK') return;
      for (const run of r.runs) expect(run.sim).toEqual(run.obs);
      expect(r.after).toEqual(r.now);
    }
  });

  it('a basal that lifts the SMB cap from 0 to 0.1 U lowers night highs', () => {
    const r = replaySettingChange(synthetic(14, 220, 0.05), { setting: 'BASAL', from: '00:00', to: '01:00', value: 0.1 }, night);
    expect(r.status).toBe('OK');
    if (r.status !== 'OK') return;
    expect(r.after.mean_mgdl).toBeLessThan(r.now.mean_mgdl - 5);
    expect(r.extra_u_median).toBeGreaterThan(0.2);
    expect(r.runs[0].smb_count_change).toBeGreaterThan(0);
  });

  it('a lower target gives more insulin, a higher one less', () => {
    const data = synthetic(14, 140, 0.3);
    const lower = replaySettingChange(data, { setting: 'TARGET', from: '00:00', to: '06:00', value: 100 }, night);
    const higher = replaySettingChange(data, { setting: 'TARGET', from: '00:00', to: '06:00', value: 120 }, night);
    if (lower.status !== 'OK' || higher.status !== 'OK') throw new Error('not OK');
    expect(lower.extra_u_median).toBeGreaterThan(0);
    expect(higher.extra_u_median).toBeLessThan(0);
    expect(lower.after.mean_mgdl).toBeLessThan(higher.after.mean_mgdl);
  });

  it('a stronger ISF (lower number) makes the loop give more', () => {
    const data = synthetic(14, 140, 0.3);
    const stronger = replaySettingChange(data, { setting: 'ISF', from: '00:00', to: '06:00', value: 80 }, night);
    const weaker = replaySettingChange(data, { setting: 'ISF', from: '00:00', to: '06:00', value: 120 }, night);
    if (stronger.status !== 'OK' || weaker.status !== 'OK') throw new Error('not OK');
    expect(stronger.extra_u_median).toBeGreaterThan(weaker.extra_u_median);
  });

  it('a higher ICR gives less meal insulin, scaled from the value in force that day', () => {
    const base = synthetic(14, 140, 0.2);
    const carbs = Array.from({ length: 14 }, (_, d) => ({ ms: START + d * DAY + 2 * 3600000, g: 30, kind: 'MEAL' as const }));
    const boluses = Array.from({ length: 14 }, (_, d) => [START + d * DAY + 2 * 3600000, 3] as [number, number]);
    const r = replaySettingChange({ ...base, carbs, boluses }, { setting: 'ICR', from: '00:00', to: '06:00', value: 12.5 }, night);
    if (r.status !== 'OK') throw new Error(r.status);
    // carb part 3 U × (1 − 10/12.5) = −0.6 U per meal; this synthetic loop makes most of it up later
    expect(r.extra_u_median).toBeLessThan(0);
    expect(Math.min(...r.runs[0].sim.slice(26, 40).map((v, i) => v - r.runs[0].obs[26 + i]))).toBeGreaterThan(0);
    expect(r.after.mean_mgdl).toBeGreaterThan(r.now.mean_mgdl);
  });

  it('halving the insulin effect halves the glucose shift', () => {
    const data = synthetic(14, 220, 0.05);
    const change: SettingChange = { setting: 'BASAL', from: '00:00', to: '01:00', value: 0.1 };
    const full = replaySettingChange(data, change, night);
    const half = replaySettingChange(data, change, night, { insulin_effect_scale: 0.5 });
    if (full.status !== 'OK' || half.status !== 'OK') throw new Error('not OK');
    const drop = (r: typeof full) => (r.status === 'OK' ? r.now.mean_mgdl - r.after.mean_mgdl : 0);
    expect(drop(half)).toBeGreaterThan(0);
    expect(drop(half)).toBeLessThan(drop(full));
  });

  it('takes off a rescue the changed glucose no longer needs, and never adds one', () => {
    const data = synthetic(14, 220, 0.05);
    const lowAt = START + 3 * DAY + 3 * 3600000;
    data.readings = data.readings.map(([ms, v]) => [ms, Math.abs(ms - lowAt) <= 10 * 60000 ? 75 : v]);
    data.carbs = [{ ms: lowAt, g: 10, kind: 'HYPO_TREATMENT' }];
    const r = replaySettingChange(data, { setting: 'TARGET', from: '00:00', to: '06:00', value: 130 }, night);
    if (r.status !== 'OK') throw new Error(r.status);
    expect(r.runs.reduce((s, x) => s + x.rescues_removed, 0)).toBeLessThanOrEqual(1);
  });

  it('skips a window with a clock change and one with too little data', () => {
    const data = synthetic(40, 150, 0.2, { time_zone: 'Europe/Warsaw' });
    data.readings = data.readings.filter(([ms]) => !(ms >= START + 5 * DAY && ms < START + 6 * DAY));
    const r = replaySettingChange(data, { setting: 'BASAL', from: '00:00', to: '01:00', value: 0.25 }, night);
    if (r.status !== 'OK') throw new Error(r.status);
    expect(r.skipped).toContainEqual({ date: '2026-10-25', reason: 'CLOCK_CHANGE' });
    expect(r.skipped.some((s) => s.reason === 'LOW_COVERAGE')).toBe(true);
  });

  it('refuses without Trio cycles or with too few days', () => {
    expect(replaySettingChange({ ...synthetic(14, 150, 0.2), trio_cycles: null }, { setting: 'BASAL', from: '00:00', to: '01:00', value: 0.1 }, night).status).toBe('NO_TRIO_CYCLES');
    expect(replaySettingChange(synthetic(5, 150, 0.2), { setting: 'BASAL', from: '00:00', to: '01:00', value: 0.1 }, night).status).toBe('TOO_FEW_DAYS');
  });
});

describe('windowOutcome', () => {
  it('counts shares, days and total minutes', () => {
    const out = windowOutcome([
      { date: '2026-10-01', obs: [60, 50, 200, 260, ...Array(12).fill(190)], sim: [], extra_u: 0, smb_count_change: 0, rescues_removed: 0 },
      { date: '2026-10-02', obs: [100, 110, 120, 130], sim: [], extra_u: 0, smb_count_change: 0, rescues_removed: 0 },
    ], 'obs');
    expect(out.days_below_70).toBe(1);
    expect(out.days_below_54).toBe(1);
    expect(out.days_above_180_over_1h).toBe(1);
    expect(out.minutes_below_70).toBe(10);
    expect(out.minutes_below_54).toBe(5);
    expect(out.lowest_mgdl).toBe(50);
    expect(out.lowest_date).toBe('2026-10-01');
  });
});
