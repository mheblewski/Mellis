import { describe, expect, it } from 'vitest';
import { dayLines, NOW_DAY_LINES_POLICY } from './now-day-lines';

const MINUTE = 60_000;
const series = (nowMs: number, days: number, value: (ms: number) => number) => {
  const out: Array<{ at: string; value: number }> = [];
  for (let ms = nowMs - days * 24 * 60 * MINUTE; ms <= nowMs; ms += 5 * MINUTE) out.push({ at: new Date(ms).toISOString(), value: value(ms) });
  return out;
};
// A Monday, 14:00 in Warsaw.
const monday = new Date('2026-11-09T13:00:00Z');

describe('now-day-lines', () => {
  it('gives short true lines after a good fortnight', () => {
    const result = dayLines({ now: monday, time_zone: 'Europe/Warsaw', readings: series(monday.getTime(), 14, () => 120) });
    expect(result.any.some((line) => line.startsWith('Przez 7 dni') || line.startsWith('Najdłużej') || line.startsWith('Tej nocy') || line === 'Nuda. Polecam.')).toBe(false);
    expect(result.any).toContain('W weekend w zakresie było 48 z 48 godzin.');
    expect(result.any).toContain('W weekend glukoza nie spadła poniżej 70.');
    expect(result.any).toContain('W 7 z 7 nocy glukoza nie spadła poniżej 70.');
    expect(result.any).toContain('Dziś glukoza ani razu nie przekroczyła 180.');
    for (const line of result.any) expect(line.length).toBeLessThanOrEqual(NOW_DAY_LINES_POLICY.max_chars);
  });

  it('stays quiet about the week after one with many lows', () => {
    const readings = series(monday.getTime(), 14, (ms) => (Math.floor(ms / (60 * MINUTE)) % 12 === 0 ? 60 : 120));
    const result = dayLines({ now: monday, time_zone: 'Europe/Warsaw', readings });
    expect(result.any.filter((line) => line.includes('zakresie'))).toEqual([]);
  });

  it('says nothing about a weekend outside Monday and Tuesday', () => {
    const friday = new Date('2026-11-13T13:00:00Z');
    const result = dayLines({ now: friday, time_zone: 'Europe/Warsaw', readings: series(friday.getTime(), 14, () => 120) });
    expect(result.any.filter((line) => line.includes('weekend'))).toEqual([]);
  });

  it('says nothing without enough readings', () => {
    expect(dayLines({ now: monday, time_zone: 'Europe/Warsaw', readings: series(monday.getTime(), 1, () => 120) }).any.filter((line) => line.includes('7'))).toEqual([]);
  });

  it('counts only meals without a low or rescue carbs', () => {
    const meals = Array.from({ length: 12 }, (_, index) => ({ at: new Date(monday.getTime() - (index + 1) * 24 * 60 * MINUTE).toISOString(), rescue_near: false }));
    const good = dayLines({ now: monday, time_zone: 'Europe/Warsaw', readings: series(monday.getTime(), 14, () => 120), meals });
    expect(good.during_meal).toEqual(['Po 12 z 12 posiłków glukoza była poniżej 180.']);
    const rescued = dayLines({ now: monday, time_zone: 'Europe/Warsaw', readings: series(monday.getTime(), 14, () => 120), meals: meals.map((meal) => ({ ...meal, rescue_near: true })) });
    expect(rescued.during_meal).toEqual([]);
  });
});
