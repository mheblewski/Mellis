import { describe, expect, it } from 'vitest';
import type { WhatIfData } from '@modules/settings-whatif/application/icr-whatif';
import { changeComparison, changeWindows } from './application/change-check';
import { duePatternPush, mergeStates, patternChatInstructions, patternKey } from './application/pattern-states';

const DAY = 86_400_000;
const END = Date.UTC(2026, 10, 11);
const START = END - 44 * DAY;
const CHANGE = END - 5 * DAY + 14 * 3_600_000; // 6.11 14:00 UTC

function data(): WhatIfData {
  const readings: Array<[number, number]> = [];
  for (let ms = START; ms < END; ms += 300_000) {
    const m = ((ms - START) % DAY) / 60_000;
    // evening lows under 54 (20:00–20:20) every day before the change, none after
    readings.push([ms, ms < CHANGE && m >= 1200 && m < 1220 ? 50 : 130]);
  }
  const base = { units: 'mg/dl', sensitivity_per_u: [['00:00', 120]] as Array<[string, number]>, basal_u_per_h: [['00:00', 0.2]] as Array<[string, number]>, target_low_mgdl: [['00:00', 110]] as Array<[string, number]> };
  return {
    time_zone: 'UTC', readings, carbs: [], boluses: [], smbs: [], temps: [], dia_hours: 10, peak_minutes: 75,
    therapies: [
      { ...base, from_ms: null, carb_ratio_g_per_u: [['00:00', 10], ['09:30', 7.7], ['18:00', 7.1]] },
      { ...base, from_ms: CHANGE, carb_ratio_g_per_u: [['00:00', 10], ['09:30', 8.3], ['18:00', 6.8]] },
    ],
  };
}

describe('changeComparison', () => {
  it('compares the changed hours (a carb ratio with its 3-hour tail) before and after, day 1 = the day after', () => {
    expect(changeWindows([{ at: 0, setting: 'ICR', unit: 'g/j', digits: 1, fromMinute: 1080, toMinute: 1440, before: 7.1, after: 6.8 }])).toEqual([[1080, 1620]]);
    const r = changeComparison(data(), '2026-11-11');
    expect(r.shown).toBe(true);
    expect(r.stats).toMatchObject({ date: '2026-11-06', day: 4, before_days: 14, after_days: 4 });
    // a weaker and a stronger range are never merged into one window (review 2026-11-12)
    expect(r.groups!.map((g) => [g.direction, g.hours])).toEqual([['MORE', '18:00–3:00'], ['LESS', '9:30–18:00']]);
    expect(r.groups![0].before.very_low_days).toBe(14);
    expect(r.groups![0].after.very_low_days).toBe(0);
    expect(r.sentence).toMatch(/^Zmiana z 6\.11: ICR 9:30–18:00: 7,7 → 8,3; ICR 18:00–24:00: 7,1 → 6,8\. W godzinach 18:00–3:00 \(więcej insuliny\)/);
    expect(patternKey(r)).toBe('CHANGE_CHECK.2026-11-06');
  });

  it('counts four shares of time and a smooth mean line for each period (owner 2026-11-23)', () => {
    const g = changeComparison(data(), '2026-11-11').groups![0];
    // 20:00–20:20 at 50 = 4 of 108 readings in 18:00–3:00 before, none after
    expect(g.before.very_low).toBe(3.7);
    expect(g.before.tbr).toBe(3.7);
    expect(g.after).toMatchObject({ very_low: 0, tbr: 0, tar: 0, tar250: 0 });
    expect(g.windows).toEqual([[1080, 1620]]);
    const before = g.profile!.before;
    expect(before[0][0]).toBe(1080);
    expect(before[before.length - 1][0]).toBe(1620);
    expect(before).toHaveLength(55);
    // smoothed: the 20-minute dip is a shallow, wide dent, not a drop to 50
    const at = (m: number) => before.find(([x]) => x === m)![1];
    expect(at(1210)).toBe(95);
    expect(at(1210)).toBeLessThan(at(1080));
    expect(at(1290)).toBe(130);
    expect(g.profile!.after.every(([, v]) => v === 130)).toBe(true);
  });

  it('waits for a full day after the change and never pushes', () => {
    expect(changeComparison(data(), '2026-11-07').shown).toBe(false);
    const states = mergeStates([], [changeComparison(data(), '2026-11-11')], Date.UTC(2026, 10, 15, 17, 30));
    expect(duePatternPush(states, Date.UTC(2026, 10, 15, 17, 30), 'Europe/Warsaw', 120)).toBeNull();
    expect(patternChatInstructions(states[0])).toContain('NEVER say the change helped');
  });
});
