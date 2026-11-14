import { describe, expect, it } from 'vitest';
import { binomialTail, detectPatterns, lastNightVeryLows, plural, wilsonLower } from './application/pattern-detectors';
import type { WhatIfData } from '@modules/settings-whatif/application/icr-whatif';

const DAY = 86_400_000;
const START = Date.UTC(2026, 9, 1);
function data(glucose: (day: number, minute: number) => number, extra: Partial<WhatIfData> = {}): WhatIfData {
  const readings: Array<[number, number]> = [];
  for (let ms = START; ms < START + 20 * DAY; ms += 300_000) readings.push([ms, glucose(Math.floor((ms - START) / DAY), ((ms - START) % DAY) / 60000)]);
  return {
    time_zone: 'UTC', readings, carbs: [], boluses: [], smbs: [], temps: [], dia_hours: 5, peak_minutes: 75, trio_cycles: [],
    therapies: [{ from_ms: null, carb_ratio_g_per_u: [['00:00', 10]], sensitivity_per_u: [['00:00', 100]], basal_u_per_h: [['00:00', 0.3]], target_low_mgdl: [['00:00', 110]], units: 'mg/dl' }],
    ...extra,
  };
}

describe('wilsonLower', () => {
  it('is below the share and tighter with more cases', () => {
    expect(wilsonLower(5, 10)).toBeLessThan(0.5);
    expect(wilsonLower(50, 100)).toBeGreaterThan(wilsonLower(5, 10));
    expect(wilsonLower(0, 0)).toBe(0);
  });
});

describe('detectPatterns', () => {
  it('is quiet on calm data', () => {
    const res = detectPatterns(data(() => 120), '2026-10-18');
    expect(res.filter((r) => r.shown)).toEqual([]);
  });

  it('shows the setting facts: long DIA and the basal that blocks microboluses', () => {
    const d = data(() => 120, { dia_hours: 10 });
    d.therapies[0].basal_u_per_h = [['00:00', 0.05], ['10:00', 0.3]];
    const check = detectPatterns(d, '2026-10-18').find((r) => r.id === 'SETTING_CHECK')!;
    expect(check.shown).toBe(true);
    expect(check.lines).toEqual(['Czas działania insuliny (DIA) w Trio: 10 godzin.', 'Przez 10 godzin doby baza jest tak niska, że pętla nie może dać mikrobolusa (może tylko podnieść bazę).']);
  });

  it('shows daytime lows without food when one window stands out', () => {
    const res = detectPatterns(data((day, m) => (day % 3 === 0 && m >= 420 && m < 465 ? 62 : 120)), '2026-10-18');
    const day = res.find((r) => r.id === 'DAY_LOWS_WITHOUT_FOOD')!;
    expect(day.shown).toBe(true);
    expect(day.sentence).toContain('między 6:00 a 9:00');
    // the "Kiedy" mini charts: 3:00–10:00 around the 6–9 window, every reading, the low's own minutes, a counted sentence
    expect(day.chart).toMatchObject({ from_minute: 180, to_minute: 600, band_from_minute: 360, band_to_minute: 540 });
    expect(day.chart!.comparison).toMatch(/^W pozostałych \d+ dniach między 6 a 9 glukoza nie spadła poniżej 70\./);
    expect(day.episodes[0].trace!.length).toBeGreaterThan(80);
    expect(day.episodes[0]).toMatchObject({ nadir: 62, low_minutes: 45 });
  });

  it('keeps lows on both sides of a full hour in one window (11:55 and 12:15 were split by fixed blocks)', () => {
    const at = (day: number) => (day % 6 === 0 ? 715 : 735);
    const res = detectPatterns(data((day, m) => (day % 3 === 0 && m >= at(day) && m < at(day) + 45 ? 62 : 120)), '2026-10-18');
    const day = res.find((r) => r.id === 'DAY_LOWS_WITHOUT_FOOD')!;
    expect(day.failed).toEqual([]);
    expect(day.shown).toBe(true);
    expect(day.stats.days).toBe(day.episodes.length);
    expect(day.episodes.length).toBeGreaterThanOrEqual(4);
    // centred on the lows: 10:00–13:00 or 11:00–14:00, never the fixed 9–12 / 12–15
    expect(day.sentence).toMatch(/między 1[01]:00 a 1[34]:00/);
  });

  it('shows rises after meals of one time of day, measured against the other times', () => {
    const carbs: WhatIfData['carbs'] = [];
    const boluses: Array<[number, number]> = [];
    for (let d = 0; d < 20; d += 1) for (const h of [8, 13, 19]) { carbs.push({ ms: START + d * DAY + h * 3_600_000, g: 20, kind: null }); boluses.push([START + d * DAY + h * 3_600_000, 2]); }
    const d = data((_day, m) => (m >= 1170 && m < 1320 ? 260 : 120), { carbs, boluses });
    d.therapies[0].carb_ratio_g_per_u = [['00:00', 10], ['18:00', 8]];
    const rises = detectPatterns(d, '2026-10-18').find((r) => r.id === 'MEAL_RISES_SAME_TIME')!;
    expect(rises.shown).toBe(true);
    expect(rises.sentence).toBe('Po 14 z 14 posiłków wieczorem glukoza mocno wzrosła (o innych porach 0%).');
    expect(rises.stats.from_minute).toBe(1080);
    expect(rises.episodes[0].note).toBe('20 g · bolus razem z jedzeniem · start 120 · najwyżej 260');
  });

  it('does not count a meal eaten already high as its rise', () => {
    const carbs: WhatIfData['carbs'] = [];
    const boluses: Array<[number, number]> = [];
    for (let d = 0; d < 20; d += 1) for (const h of [8, 13, 19]) { carbs.push({ ms: START + d * DAY + h * 3_600_000, g: 20, kind: null }); boluses.push([START + d * DAY + h * 3_600_000, 2]); }
    // glucose is already 240 at the evening meal and only reaches 260
    const d = data((_day, m) => (m >= 1130 && m < 1320 ? (m >= 1170 ? 260 : 240) : 120), { carbs, boluses });
    d.therapies[0].carb_ratio_g_per_u = [['00:00', 10], ['18:00', 8]];
    expect(detectPatterns(d, '2026-10-18').find((r) => r.id === 'MEAL_RISES_SAME_TIME')!.shown).toBe(false);
  });

  it('never runs the retired patterns (lows after a meal bolus failed the shuffle test)', () => {
    const carbs: WhatIfData['carbs'] = [];
    const boluses: Array<[number, number]> = [];
    for (let d = 0; d < 20; d += 1) { carbs.push({ ms: START + d * DAY + 12 * 3_600_000, g: 30, kind: null }); boluses.push([START + d * DAY + 12 * 3_600_000, 3]); }
    const d = data((day, m) => (day % 2 === 0 && m >= 780 && m < 900 ? 60 : 120), { carbs, boluses });
    const ids = detectPatterns(d, '2026-10-18').map((r) => r.id);
    expect(ids).not.toContain('LOWS_AFTER_MEAL_BOLUS');
    expect(ids).not.toContain('FOLLOW_UP_PORTIONS');
    expect(ids).not.toContain('LOOP_CANNOT_ADD');
    // facts left the screen (2026-11-13): time below the goal is in the TIR sheet, a night under 54 in its push
    expect(ids).not.toContain('NIGHT_LOWS');
    expect(ids).not.toContain('TIME_BELOW_GOAL');
  });

  it('finds last night under 54 for the morning push, after food too', () => {
    const carbs: WhatIfData['carbs'] = [{ ms: START + 9 * DAY + 22.5 * 3_600_000, g: 20, kind: null }];
    const boluses: Array<[number, number]> = [[START + 9 * DAY + 22.5 * 3_600_000, 2]];
    const d = data((day, m) => (day === 10 && m >= 60 && m < 120 ? 48 : 120), { carbs, boluses });
    const lows = lastNightVeryLows(d, '2026-10-11');
    expect(lows).toHaveLength(1);
    expect(lows[0]).toMatchObject({ nadir: 48, minutes: 60 });
    // a short fast dip and back (maybe compression) is kept and only marked
    const dip = data((day, m) => (day === 10 && m >= 60 && m < 75 ? 52 : 120));
    expect(lastNightVeryLows(dip, '2026-10-11')).toMatchObject([{ maybeCompression: true }]);
    // the critic's deep low, juice not entered: 85, 74, 66, 58, 52, 46, 42, 45, 51, 57 — a real night under 54, not compression
    const deepValues = [85, 74, 66, 58, 52, 46, 42, 45, 51, 57];
    const deep = data((day, m) => (day === 10 && m >= 40 && m < 90 ? deepValues[(m - 40) / 5] : 120));
    expect(lastNightVeryLows(deep, '2026-10-11')).toMatchObject([{ nadir: 42, maybeCompression: false }]);
    expect(lastNightVeryLows(d, '2026-10-12')).toEqual([]);
  });

  it('shows high glucose after treating a low', () => {
    const carbs: WhatIfData['carbs'] = [];
    for (let d = 4; d < 18; d += 2) carbs.push({ ms: START + d * DAY + 600 * 60_000, g: 10, kind: 'HYPO_TREATMENT' });
    const d = data((day, m) => (day % 2 === 0 && m >= 590 && m < 605 ? 62 : day % 2 === 0 && m >= 650 && m < 700 ? 270 : 120), { carbs });
    const rebound = detectPatterns(d, '2026-10-18').find((r) => r.id === 'RESCUE_REBOUND')!;
    expect(rebound.shown).toBe(true);
    expect(rebound.sentence).toBe('Po 7 z 7 zapisanych leczeń spadku glukoza przekroczyła 250 w ciągu 2 godzin.');
    expect(rebound.episodes[0].note).toBe('10 g · potem najwyżej 270');
  });
});

describe('binomialTail', () => {
  it('is 1 at zero and small for a clear cluster', () => {
    expect(binomialTail(0, 5, 1 / 6)).toBeCloseTo(1);
    expect(binomialTail(5, 6, 1 / 6)).toBeLessThan(0.01);
    expect(binomialTail(2, 6, 1 / 6)).toBeGreaterThan(0.05);
  });
});

describe('plural', () => {
  it('follows Polish numerals', () => {
    expect([1, 2, 5, 12, 22, 25].map((n) => plural(n, 'bolus', 'bolusy', 'bolusów'))).toEqual(['bolus', 'bolusy', 'bolusów', 'bolusów', 'bolusy', 'bolusów']);
  });
});
