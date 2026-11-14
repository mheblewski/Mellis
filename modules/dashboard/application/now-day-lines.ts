import { makeLocalMinuteOfDay } from '@modules/evidence-tools/daily-insulin-totals';

/**
 * "Linia dnia" (docs/product/teraz-situation-texts-review.md, section D): true numbers from the patient's own readings for
 * the quiet states, one line under the sentence. Pure. The server sends the list, each phone takes the next one. Nothing
 * here gives advice, compares with others or says that something got worse.
 */
export const NOW_DAY_LINES_POLICY = {
  version: 'now-day-lines.v2',
  max_chars: 46,
  /** Chosen by the owner, 2026-11-07. Only here: these say that it is calm. */
  calm_lines: ['Nudny wykres to najlepszy wykres.', 'Nic ciekawego. I bardzo dobrze.'],
  low_mgdl: 70,
  urgent_mgdl: 54,
  high_mgdl: 180,
  min_coverage: 0.7,
  min_time_in_range_percent: 70,
  min_week_gain_points: 5,
  max_gap_minutes: 15,
  /** Cheerful lines go away after a week with this many lows. */
  quiet_below_70_percent: 4,
  quiet_below_54_percent: 1,
  min_good_nights: 4,
  min_meals: 10,
  min_meal_share: 0.6,
  meal_peak_minutes: 180,
  today_after_minute: 12 * 60,
  night_from_minute: 22 * 60,
  night_to_minute: 6 * 60,
  history_days: 14,
} as const;

const POLICY = NOW_DAY_LINES_POLICY;
const MINUTE_MS = 60_000;
const READINGS_PER_MINUTE = 1 / 5;

export interface DayLinePoint { at: string; value: number }
export interface DayLineMeal { at: string; rescue_near: boolean }

interface Window { values: number[]; expected: number }

const percent = (part: number, whole: number) => (whole > 0 ? (part / whole) * 100 : 0);
const inRange = (value: number) => value >= POLICY.low_mgdl && value <= POLICY.high_mgdl;

function windowOf(points: Array<{ ms: number; value: number }>, fromMs: number, toMs: number): Window {
  return {
    values: points.filter((point) => point.ms >= fromMs && point.ms < toMs).map((point) => point.value),
    expected: ((toMs - fromMs) / MINUTE_MS) * READINGS_PER_MINUTE,
  };
}

const covered = (window: Window) => window.values.length >= window.expected * POLICY.min_coverage;
const rangePercent = (window: Window) => percent(window.values.filter(inRange).length, window.values.length);

/** Lines that may stand only when the week had few lows; the rest are facts about what did not happen. */
export function dayLines(input: { now: Date; time_zone: string; readings: DayLinePoint[]; meals?: DayLineMeal[] }): { during_meal: string[]; any: string[] } {
  const nowMs = input.now.getTime();
  const points = input.readings.map((reading) => ({ ms: Date.parse(reading.at), value: reading.value })).sort((a, b) => a.ms - b.ms);
  const minuteOf = makeLocalMinuteOfDay(input.time_zone) as (ms: number) => number;
  const minute = minuteOf(nowMs);
  const midnightMs = nowMs - minute * MINUTE_MS;
  const dayMs = 24 * 60 * MINUTE_MS;
  const any: string[] = [...POLICY.calm_lines];
  const duringMeal: string[] = [];

  const week = windowOf(points, nowMs - 7 * dayMs, nowMs);
  const weekBefore = windowOf(points, nowMs - 14 * dayMs, nowMs - 7 * dayMs);
  const below70 = percent(week.values.filter((value) => value < POLICY.low_mgdl).length, week.values.length);
  const below54 = percent(week.values.filter((value) => value < POLICY.urgent_mgdl).length, week.values.length);
  const quietWeek = !covered(week) || below70 >= POLICY.quiet_below_70_percent || below54 >= POLICY.quiet_below_54_percent;

  if (!quietWeek) {
    // Texts review (2026-11-09): no plain week percentage, no longest run, no "tej nocy" percentage.
    const weekRange = Math.round(rangePercent(week));
    if (covered(weekBefore)) {
      const beforeRange = Math.round(rangePercent(weekBefore));
      const beforeBelow = percent(weekBefore.values.filter((value) => value < POLICY.low_mgdl).length, weekBefore.values.length);
      if (weekRange - beforeRange >= POLICY.min_week_gain_points && below70 <= beforeBelow) any.push(`Czas w zakresie wzrósł w tydzień z ${beforeRange}% do ${weekRange}%.`);
    }
  }

  // The last weekend, only on Monday and Tuesday: then "w weekend" can mean only that one.
  const weekday = new Intl.DateTimeFormat('en-GB', { timeZone: input.time_zone, weekday: 'short' }).format(input.now);
  if (weekday === 'Mon' || weekday === 'Tue') {
    const weekendEnd = midnightMs - (weekday === 'Tue' ? dayMs : 0);
    const weekend = windowOf(points, weekendEnd - 2 * dayMs, weekendEnd);
    if (covered(weekend)) {
      const range = rangePercent(weekend);
      if (!quietWeek && range >= POLICY.min_time_in_range_percent) any.push(`W weekend w zakresie było ${Math.round(range * 48 / 100)} z 48 godzin.`);
      if (weekend.values.every((value) => value >= POLICY.low_mgdl)) any.push('W weekend glukoza nie spadła poniżej 70.');
    }
  }

  // Nights end at 6:00 local time; the one ending today counts only once it is over.
  const lastNightEnd = midnightMs + POLICY.night_to_minute * MINUTE_MS - (minute < POLICY.night_to_minute ? dayMs : 0);
  const nightLength = (24 * 60 - POLICY.night_from_minute + POLICY.night_to_minute) * MINUTE_MS;
  let goodNights = 0;
  let coveredNights = 0;
  for (let index = 0; index < 7; index += 1) {
    const toMs = lastNightEnd - index * dayMs;
    const night = windowOf(points, toMs - nightLength, toMs);
    if (!covered(night)) continue;
    coveredNights += 1;
    if (night.values.every((value) => value >= POLICY.low_mgdl)) goodNights += 1;
  }
  if (coveredNights === 7 && goodNights >= POLICY.min_good_nights) any.push(`W ${goodNights} z 7 nocy glukoza nie spadła poniżej 70.`);

  if (minute >= POLICY.today_after_minute) {
    const today = windowOf(points, midnightMs, nowMs);
    if (covered(today) && today.values.every((value) => value >= POLICY.low_mgdl && value <= POLICY.high_mgdl)) any.push('Dziś glukoza ani razu nie przekroczyła 180.');
  }

  // Only meals with no rescue carbs and no low around them are counted.
  const meals = (input.meals ?? []).map((meal) => ({ ...meal, ms: Date.parse(meal.at) })).filter((meal) => meal.ms >= nowMs - 14 * dayMs && meal.ms + POLICY.meal_peak_minutes * MINUTE_MS <= nowMs && !meal.rescue_near);
  const judged = meals.map((meal) => windowOf(points, meal.ms, meal.ms + POLICY.meal_peak_minutes * MINUTE_MS)).filter((window) => covered(window) && window.values.every((value) => value >= POLICY.low_mgdl));
  const last = judged.slice(-12);
  const good = last.filter((window) => window.values.every((value) => value < POLICY.high_mgdl)).length;
  if (last.length >= POLICY.min_meals && good / last.length >= POLICY.min_meal_share) duringMeal.push(`Po ${good} z ${last.length} posiłków glukoza była poniżej 180.`);

  const fits = (line: string) => line.length <= POLICY.max_chars;
  return { any: any.filter(fits), during_meal: duringMeal.filter(fits) };
}
