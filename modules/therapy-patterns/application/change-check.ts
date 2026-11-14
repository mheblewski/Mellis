import type { WhatIfData } from '@modules/settings-whatif/application/icr-whatif';
import { localClock } from '@modules/settings-whatif/application/settings-replay';
import { localInstant } from '@modules/settings-insights/application/settings-insights-common';
import { profileChanges, type ProfileChange } from '@modules/clinic-report/application/profile-changes';
import type { ChangeGroup, PatternResult } from './pattern-detectors';

/**
 * "Przed i po zmianie" (therapy-patterns.v1, change card): the newest Trio profile change of the last 28 days, the same
 * hours compared 14 days before it and the days after it (day 1 = the first full day after). Numbers only — no verdict:
 * meals, dosing habits or illness change in the same weeks, and the card says so.
 */
export const CHANGE_CHECK_POLICY = {
  version: 'change-check.v1',
  beforeDays: 14,
  afterDays: 14,
  /** The card stays this long after the change (the comparison, then its result for two more weeks). */
  showDays: 28,
  /** A carb ratio acts through the meal after its hours: the window runs on this long. */
  icrTailMinutes: 180,
  /** A day counts when it has at least this share of its readings in the window. */
  minDayCoverage: 0.5,
} as const;

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const C = CHANGE_CHECK_POLICY;
const pl = (x: number, k = 1) => x.toFixed(k).replace('.', ',');
const hhmm = (m: number) => { const x = ((m % 1440) + 1440) % 1440; return `${Math.floor(x / 60)}:${String(x % 60).padStart(2, '0')}`; };

/** More insulin from the new value: a lower ratio, sensitivity or target, or a higher basal. */
export function changeDirection(change: ProfileChange): 'MORE' | 'LESS' {
  const more = change.setting === 'Baza' ? change.after > change.before : change.after < change.before;
  return more ? 'MORE' : 'LESS';
}

/**
 * The hours to compare: the changed ranges, a carb ratio's with its tail; overlapping ones merged (may pass midnight).
 * Call it per direction: a weaker and a stronger range merged into one window average opposite effects (review 2026-11-12).
 */
export function changeWindows(changes: ProfileChange[], opposite: ProfileChange[] = []): Array<[number, number]> {
  // A carb ratio's tail stops where a range changed the other way begins: 18–21 is not in both sections (review B3).
  const tailEnd = (c: ProfileChange) => {
    const next = opposite.map((o) => (o.fromMinute >= c.toMinute ? o.fromMinute : o.fromMinute + 1440)).filter((m) => m >= c.toMinute).sort((a, b) => a - b)[0];
    return Math.min(c.toMinute + C.icrTailMinutes, next ?? Infinity);
  };
  const raw = changes.map((c) => [c.fromMinute, c.setting === 'ICR' ? tailEnd(c) : c.toMinute] as [number, number]).sort((a, b) => a[0] - b[0]);
  const out: Array<[number, number]> = [];
  for (const [a, b] of raw) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b); else out.push([a, Math.min(b, a + 1440)]);
  }
  return out;
}

interface PeriodStats { days: number; veryLowDays: number; tbr: number; tar: number }

function periodStats(readings: Array<[number, number]>, firstDay: number, days: number, windows: Array<[number, number]>): PeriodStats {
  const expected = windows.reduce((s, [a, b]) => s + (b - a) / 5, 0);
  let counted = 0; let veryLowDays = 0; let n = 0; let below = 0; let above = 0;
  for (let k = 0; k < days; k += 1) {
    const dayStart = firstDay + k * DAY;
    const values: Array<[number, number]> = [];
    for (const [a, b] of windows) {
      const from = dayStart + a * MIN; const to = dayStart + b * MIN;
      for (const r of readings) if (r[0] >= from && r[0] < to) values.push(r);
    }
    if (values.length < expected * C.minDayCoverage) continue;
    counted += 1;
    values.sort((x, y) => x[0] - y[0]);
    // A level-2 low = at least 15 min under 54 (three readings in a row), as in the clinic report. Days with any low
    // under 70 were nearly all days in both periods (12 of 14, 4 of 4) and told nothing (review 2026-11-12).
    let run = 0; let low = false;
    for (const [, v] of values) { run = v < 54 ? run + 1 : 0; if (run >= 3) low = true; }
    if (low) veryLowDays += 1;
    n += values.length; below += values.filter(([, v]) => v < 70).length; above += values.filter(([, v]) => v > 180).length;
  }
  return { days: counted, veryLowDays, tbr: n ? (100 * below) / n : 0, tar: n ? (100 * above) / n : 0 };
}

/** What else may differ between the periods, whole days: boluses per meal (meal = carbs within 45 min) and carbs a day. */
function habits(data: WhatIfData, firstDay: number, days: number): { bolusesPerMeal: number | null; carbsPerDay: number | null } {
  if (days < 1) return { bolusesPerMeal: null, carbsPerDay: null };
  const end = firstDay + days * DAY;
  const carbs = data.carbs.filter((c) => c.ms >= firstDay && c.ms < end && c.g > 0 && c.kind !== 'HYPO_TREATMENT').sort((a, b) => a.ms - b.ms);
  const meals: Array<{ first: number; last: number }> = [];
  for (const c of carbs) { const m = meals[meals.length - 1]; if (m && c.ms - m.last <= 45 * MIN) m.last = c.ms; else meals.push({ first: c.ms, last: c.ms }); }
  const boluses = data.boluses.filter(([ms, u]) => ms >= firstDay - 30 * MIN && ms < end && u >= 0.3);
  const perMeal = meals.map((m) => boluses.filter(([ms]) => ms >= m.first - 30 * MIN && ms <= m.last + 90 * MIN).length).filter((k) => k > 0);
  return {
    bolusesPerMeal: perMeal.length ? perMeal.reduce((a, b) => a + b, 0) / perMeal.length : null,
    carbsPerDay: carbs.reduce((a, c) => a + c.g, 0) / days,
  };
}

export function changeComparison(data: WhatIfData, todayIso: string): PatternResult {
  const none = (failed: string): PatternResult => ({ id: 'CHANGE_CHECK', shown: false, failed: [failed], sentence: '', stats: {}, episodes: [] });
  const tz = data.time_zone;
  const loc = localClock(tz);
  const end = localInstant(todayIso, 0, tz);
  const all = profileChanges(data.therapies, end - C.showDays * DAY, end, (ms) => loc(ms).date);
  if (!all.length) return none('no profile change in 28 days');
  const day = loc(Math.max(...all.map((c) => c.at))).date;
  const changes = all.filter((c) => loc(c.at).date === day);
  const changeDayStart = localInstant(day, 0, tz);
  const afterStart = changeDayStart + DAY;
  const afterDays = Math.min(C.afterDays, Math.floor((end - afterStart) / DAY));
  if (afterDays < 1) return none('no full day after the change yet');
  const readings = data.readings.filter(([, v]) => v > 0).sort((a, b) => a[0] - b[0]);
  const beforeStart = changeDayStart - C.beforeDays * DAY;
  const fmtHours = (windows: Array<[number, number]>) => windows.map(([a, b]) => `${hhmm(a)}–${b === 1440 ? '24:00' : hhmm(b)}`).join(', ');
  const round = (p: PeriodStats) => ({ days: p.days, very_low_days: p.veryLowDays, tbr: Math.round(p.tbr * 10) / 10, tar: Math.round(p.tar) });
  const groups: ChangeGroup[] = (['MORE', 'LESS'] as const).flatMap((direction) => {
    const windows = changeWindows(changes.filter((c) => changeDirection(c) === direction), changes.filter((c) => changeDirection(c) !== direction));
    if (!windows.length) return [];
    return [{ direction, hours: fmtHours(windows), before: round(periodStats(readings, beforeStart, C.beforeDays, windows)), after: round(periodStats(readings, afterStart, afterDays, windows)) }];
  });
  const dayLabel = `${Number(day.slice(8))}.${day.slice(5, 7)}`;
  const what = changes.map((c) => `${c.setting} ${hhmm(c.fromMinute)}–${c.toMinute >= 1440 ? '24:00' : hhmm(c.toMinute)}: ${pl(c.before, c.digits)} → ${pl(c.after, c.digits)}`).join('; ');
  const word = (d: 'MORE' | 'LESS') => (d === 'MORE' ? 'więcej insuliny' : 'mniej insuliny');
  const sentence = `Zmiana z ${dayLabel}: ${what}. ` + groups.map((g) => `W godzinach ${g.hours} (${word(g.direction)}) przed zmianą (${g.before.days} dni): poniżej 54 w ${g.before.very_low_days} dniach, `
    + `poniżej 70 przez ${pl(g.before.tbr)}% czasu, powyżej 180 przez ${pl(g.before.tar, 0)}%; po zmianie (${g.after.days} dni): ${g.after.very_low_days} dni, ${pl(g.after.tbr)}%, ${pl(g.after.tar, 0)}%.`).join(' ');
  const hb = habits(data, beforeStart, C.beforeDays);
  const ha = habits(data, afterStart, afterDays);
  const first = groups[0];
  return {
    id: 'CHANGE_CHECK',
    shown: true,
    failed: [],
    sentence,
    stats: {
      date: day, day: afterDays, of: C.afterDays, hours: groups.map((g) => g.hours).join(', '), changes: what,
      before_days: first?.before.days ?? 0, after_days: first?.after.days ?? 0,
      boluses_per_meal_before: hb.bolusesPerMeal !== null ? Math.round(hb.bolusesPerMeal * 10) / 10 : null,
      boluses_per_meal_after: ha.bolusesPerMeal !== null ? Math.round(ha.bolusesPerMeal * 10) / 10 : null,
      carbs_per_day_before: hb.carbsPerDay !== null ? Math.round(hb.carbsPerDay) : null,
      carbs_per_day_after: ha.carbsPerDay !== null ? Math.round(ha.carbsPerDay) : null,
    },
    groups,
    episodes: [],
    lines: changes.map((c) => `${c.setting} ${hhmm(c.fromMinute)}–${c.toMinute >= 1440 ? '24:00' : hhmm(c.toMinute)}|${pl(c.before, c.digits)}|${pl(c.after, c.digits)}`),
  };
}
