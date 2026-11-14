import { describe, expect, it } from 'vitest';
import type { WhatIfData } from './application/icr-whatif';
import { blockChange, candidatesFor, findPlaces, icrBlockBefore, lowsNotWorse, placeWindow, risesCostLimited, searchPlace } from './application/settings-search';
import { windowOutcome } from './application/settings-replay';

const DAY = 24 * 3600 * 1000;
const START = Date.UTC(2026, 9, 1);

function data(glucose: (day: number, minute: number) => number, therapies?: WhatIfData['therapies']): WhatIfData {
  const readings: Array<[number, number]> = [];
  for (let ms = START; ms < START + 30 * DAY; ms += 300000) {
    const day = Math.floor((ms - START) / DAY);
    readings.push([ms, glucose(day, ((ms - START) % DAY) / 60000)]);
  }
  return {
    time_zone: 'UTC',
    readings,
    carbs: [],
    boluses: [],
    smbs: [],
    temps: [],
    therapies: therapies ?? [{
      from_ms: null,
      carb_ratio_g_per_u: [['00:00', 10], ['06:00', 5], ['09:30', 8], ['18:00', 7]],
      sensitivity_per_u: [['00:00', 190], ['03:30', 120]],
      basal_u_per_h: [['00:00', 0.05], ['02:00', 0.1], ['05:00', 0.3], ['06:00', 0.15]],
      target_low_mgdl: [['00:00', 110]],
      units: 'mg/dl',
    }],
    dia_hours: 10,
    peak_minutes: 75,
    trio_cycles: [],
  };
}

const TODAY = '2026-10-29';

describe('findPlaces', () => {
  it('is quiet when every block is within the goals', () => {
    const r = findPlaces(data(() => 120), TODAY);
    expect(r.places).toEqual([]);
    expect(r.within_goals.map((b) => b.from)).toEqual(['00:00', '06:00', '09:30', '18:00']);
    expect(r.first_date).toBe('2026-10-02');
    expect(r.last_date).toBe('2026-10-28');
  });

  it('finds night lows hidden in a long block through the 3-hour windows', () => {
    // 30 min below 70 between 01:00 and 01:30 on 8 of 27 nights: 0–3 over 4 % on those nights, 0–6 on average not.
    const r = findPlaces(data((day, m) => (day % 3 === 0 && m >= 60 && m < 90 ? 60 : 120)), TODAY);
    expect(r.places).toHaveLength(1);
    expect(r.places[0]).toMatchObject({ from: '00:00', to: '06:00', kind: 'LOWS', lows_window: { from: '00:00', to: '03:00' } });
    expect(r.places[0].stats.below_70).toBeLessThan(0.04);
  });

  it('ignores lows on too few days', () => {
    const r = findPlaces(data((day, m) => (day % 9 === 0 && m >= 60 && m < 120 ? 60 : 120)), TODAY);
    expect(r.places).toEqual([]);
  });

  it('shows rises only above 1.2 × the goal and puts lows first', () => {
    // evening: 35 % above 180 (1.4 × the goal); day 9:30–18: 28 % (1.12 ×, no place); lows 12–15 every second day (13:00).
    const r = findPlaces(data((day, m) => {
      if (m >= 18 * 60 && m < 18 * 60 + 126) return 200;
      if (m >= 10 * 60 && m < 10 * 60 + 143) return 200;
      if (day % 2 === 0 && m >= 13 * 60 && m < 13 * 60 + 15) return 60;
      return 120;
    }), TODAY);
    expect(r.places.map((p) => `${p.kind} ${p.from}`)).toEqual(['LOWS 09:30', 'RISES 18:00']);
  });

  it('a block changed in the last 14 days waits for its comparison', () => {
    const base = data(() => 120).therapies[0];
    const changed = { ...base, from_ms: Date.UTC(2026, 9, 20, 12), carb_ratio_g_per_u: [['00:00', 10], ['06:00', 5], ['09:30', 8], ['18:00', 6.5]] as Array<[string, number]> };
    const r = findPlaces(data((day, m) => (m >= 18 * 60 && m < 18 * 60 + 150 ? 260 : 120), [base, changed]), TODAY);
    expect(r.places[0]).toMatchObject({ from: '18:00', kind: 'RISES', changed_on: '2026-10-20', waits_until: '2026-11-03' });
    expect(searchPlace(data(() => 120, [base, changed]), r.places[0])).toMatchObject({ status: 'WAITS', waits_until: '2026-11-03' });
  });
});

describe('candidates', () => {
  const d = { ...data(() => 120), carbs: [{ ms: START + 2 * 3600000, g: 20, kind: 'MEAL' as const }] };
  it('leaves ICR out of a block without meals', () => {
    expect(candidatesFor(data(() => 120), { from: '00:00', to: '06:00', kind: 'RISES' }).some((c) => c.setting === 'ICR')).toBe(false);
  });
  it('takes one step per setting block inside the place, and none that adds insulin in a lows place', () => {
    const all = candidatesFor(d, { from: '00:00', to: '06:00', kind: 'RISES' });
    expect(all.map((c) => `${c.setting} ${c.from}-${c.to} ${c.now_value}→${c.value}`)).toEqual([
      'ICR 00:00-06:00 10→11', 'ICR 00:00-06:00 10→9',
      'ISF 00:00-03:30 190→210', 'ISF 00:00-03:30 190→170', 'ISF 03:30-06:00 120→130', 'ISF 03:30-06:00 120→110',
      'TARGET 00:00-06:00 110→120', 'TARGET 00:00-06:00 110→100',
      'BASAL 00:00-02:00 0.05→0.1', 'BASAL 02:00-05:00 0.1→0.15', 'BASAL 02:00-05:00 0.1→0.05', 'BASAL 05:00-06:00 0.3→0.35', 'BASAL 05:00-06:00 0.3→0.25',
    ]);
    const lows = candidatesFor(d, { from: '00:00', to: '06:00', kind: 'LOWS' });
    expect(lows.every((c) => !c.more_insulin)).toBe(true);
    expect(lows.map((c) => c.setting + c.value)).toEqual(['ICR11', 'ISF210', 'ISF130', 'TARGET120', 'BASAL0.05', 'BASAL0.25']);
  });

  it('the outcome window runs 4 h past the place', () => {
    expect(placeWindow({ from: '00:00', to: '06:00' })).toEqual({ from: '00:00', to: '10:00' });
    expect(placeWindow({ from: '18:00', to: '00:00' })).toEqual({ from: '18:00', to: '04:00' });
  });
});

describe('limits', () => {
  const run = (values: number[]) => ({ date: '2026-10-01', obs: values, sim: values, extra_u: 0, smb_count_change: 0, rescues_removed: 0 });
  it('lows may not grow in minutes or days', () => {
    const now = windowOutcome([run([60, 120, 120])], 'obs');
    expect(lowsNotWorse(now, windowOutcome([run([120, 120, 120])], 'obs'))).toBe(true);
    expect(lowsNotWorse(now, windowOutcome([run([60, 60, 120])], 'obs'))).toBe(false);
    expect(lowsNotWorse(now, windowOutcome([run([120, 120, 50])], 'obs'))).toBe(false);
  });
  it('rises may grow by at most half, in minutes and in days', () => {
    const day = (high: number) => run([...Array(high).fill(200), ...Array(40 - high).fill(120)]);
    const now = windowOutcome([day(12), day(12), day(0), day(0)], 'obs');
    // 120 → 180 min (+50 %), days over 1 h 2 → 3 (+50 %): allowed
    expect(risesCostLimited(now, windowOutcome([day(12), day(12), day(12), day(0)], 'obs'))).toBe(true);
    // days over 1 h 2 → 4: not allowed although minutes grow only 120 → 200
    expect(risesCostLimited(now, windowOutcome([day(12), day(12), day(12), day(4)].map((r, i) => (i === 3 ? day(12) : r)), 'obs'))).toBe(false);
    // from zero: one more hour is the floor
    const calm = windowOutcome([day(0), day(0)], 'obs');
    expect(risesCostLimited(calm, windowOutcome([day(12), day(0)], 'obs'))).toBe(true);
    expect(risesCostLimited(calm, windowOutcome([day(13), day(0)], 'obs'))).toBe(false);
  });
});

describe('blocks', () => {
  it('finds the block before a night and the last change of a block', () => {
    const base = data(() => 120).therapies[0];
    const changed = { ...base, from_ms: Date.UTC(2026, 9, 20, 12), carb_ratio_g_per_u: [['00:00', 10], ['06:00', 5], ['09:30', 8], ['18:00', 6.5]] as Array<[string, number]> };
    const d = data(() => 120, [base, changed]);
    expect(icrBlockBefore(d, '00:00')).toEqual({ from: '18:00', to: '00:00' });
    expect(icrBlockBefore(d, '06:00')).toEqual({ from: '00:00', to: '06:00' });
    expect(blockChange(d, 18 * 60, 1440, '2026-10-29')).toEqual({ changed_on: '2026-10-20', waits_until: '2026-11-03' });
    expect(blockChange(d, 18 * 60, 1440, '2026-11-05')).toEqual({ changed_on: '2026-10-20', waits_until: null });
    expect(blockChange(d, 0, 360, '2026-10-29')).toEqual({ changed_on: null, waits_until: null });
  });
});
