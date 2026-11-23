import type { WhatIfData } from '@modules/settings-whatif/application/icr-whatif';
import { localClock, scheduleAt } from '@modules/settings-whatif/application/settings-replay';
import { readTrioCycle, smbCapFor, TRIO_REPLICA_POLICY, type TrioCycle } from '@modules/settings-whatif/application/trio-replica';
import { profileChanges } from '@modules/clinic-report/application/profile-changes';
import { localInstant } from '@modules/settings-insights/application/settings-insights-common';

/**
 * Therapy patterns (therapy-patterns.v1, stage 1 in the shadow; docs/product/patterns-and-chat-replay-review.md):
 * recurring situations found by code in the last 14 days, with the same thresholds for every patient. Nothing here
 * says what to dose; a pattern is a fact with a count, a comparison and possible causes to talk through.
 *
 * Shown only when it is not chance-like: enough episodes on enough days, seen in both weeks of the window and, where
 * there is a comparison, clearly above the patient's own comparison group (Wilson lower bound).
 */
export const THERAPY_PATTERNS_POLICY = {
  version: 'therapy-patterns.v1',
  window_days: 14,
  low_mgdl: 70,
  very_low_mgdl: 54,
  min_low_minutes: 15,
  series_gap_minutes: 45,
  bolus_min_u: 0.3,
  after_series_hours: 4,
  min_episodes: 6,
  min_days: 4,
  min_pp_above: 15,
  wilson_z: 1.6449, // 90 % two-sided lower bound (the shuffle test: 80 % let chance through in 16 % of windows)
  night_from_hour: 0,
  night_to_hour: 6,
  /** Back to 3 h (2026-11-13): the 4 h of B9 only served the retired lows-after-bolus pattern and dropped the 9–12 lows 3.5 h after breakfast. */
  night_no_carbs_hours: 3,
  night_min_nights: 3,
  /** Night time below 70 must also be above the consensus goal (4 %) over the 14 nights. */
  night_min_share_below_70: 0.04,
  night_min_very_low_nights: 2,
  /** Lows after a meal bolus (role review 2026-11-12): within 4 h, on ≥ 4 days, while lows are above the goal. */
  after_meal_hours: 4,
  after_meal_min_days: 4,
  after_meal_min_share_below_70: 0.04,
  after_meal_min_share_below_54: 0.01,
  /** The 4-hour windows must hold clearly more of the lows than of the day (share of lows / share of time). */
  after_meal_min_ratio: 1.3,
  /** Microboluses between the meal bolus and the low in each episode's note (set after the offline proof, plan 1.1). */
  after_meal_show_smb: false as boolean,
  /** A day (or night 0–6) counts in "z N dni" when it has this share of its CGM readings. */
  min_day_coverage: 0.7,
  day_no_food_hours: 3,
  day_min_days: 3,
  /** Same-time test: lows of one 3-hour window must stand out among the 6 daytime windows, p < 0.01 (shuffle 2026-11-13 with the 3 h window: 1.1 % of chance windows; 0.05 gave 6.0 %, 0.05/6 hid 4 of 6 lows at 9–12, p 0.0087). */
  day_concentration_p: 0.01,
  meal_min_grams: 5,
  meal_rise_peak_mgdl: 250,
  meal_rise_minutes_above_180: 120,
  meal_rise_hours: 3,
  /** A rise counts from a start in range and by at least this much (a meal eaten already high is not its rise). */
  meal_rise_max_start_mgdl: 180,
  meal_rise_min_delta_mgdl: 60,
  /** After counting each rise once (2026-11-11): a third of the meals, and three times the other times (shuffle: 33 % of windows vs 6 %). */
  meal_rise_min_share: 0.33,
  meal_rise_min_ratio: 3,
  meal_rise_min_meals: 6,
  rescue_below_mgdl: 80,
  rescue_rebound_mgdl: 250,
  rescue_rebound_hours: 2,
  rescue_min_cases: 4,
  rescue_min_share: 0.4,
  rescue_min_days: 3,
  dia_check_hours: 8,
  minimum_basal_hours: 6,
  /** An hour counts as blocking microboluses when the loop's own limit was 0 in this share of its decisions. */
  smb_zero_share: 0.5,
  /** Fast drop + return without carbs: a compression low, not a real one. */
  compression_drop_per_min: 2,
  compression_return_minutes: 30,
} as const;

const P = THERAPY_PATTERNS_POLICY;
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

/**
 * FOLLOW_UP_PORTIONS and LOOP_CANNOT_ADD are no longer run (role review 2026-11-12): dose splitting is deliberate since
 * 31 Oct and the series mixed causes; the loop's limit failed the shuffle test and now is one row of the settings card.
 * Their stored states are hidden by the API.
 */
export type PatternId = 'NIGHT_LOWS' | 'TIME_BELOW_GOAL' | 'LOWS_AFTER_MEAL_BOLUS' | 'DAY_LOWS_WITHOUT_FOOD' | 'FOLLOW_UP_PORTIONS' | 'MEAL_RISES_SAME_TIME' | 'RESCUE_REBOUND' | 'LOOP_CANNOT_ADD' | 'SETTING_CHECK' | 'CHANGE_CHECK';
/**
 * NIGHT_LOWS and TIME_BELOW_GOAL left the screen too (owner 2026-11-13, roles agreed): a night under 54 is already in the
 * night alarm, the 7:00 push and the chart; time below the goal over 14 days is in the TIR sheet (24 h / 7 / 14 days with
 * the goals) and the clinic report. No new pushes for them either ("cukrzycy są przebodźcowani powiadomieniami").
 */
export const RETIRED_PATTERNS: PatternId[] = ['FOLLOW_UP_PORTIONS', 'LOOP_CANNOT_ADD', 'LOWS_AFTER_MEAL_BOLUS', 'NIGHT_LOWS', 'TIME_BELOW_GOAL'];

export interface PatternEpisode {
  at: number;
  date: string;
  note: string;
  /** The day's glucose for the "Kiedy" mini chart: [minutes from the chart's start, mg/dL], every reading. */
  trace?: Array<[number, number]>;
  /** The meal with a bolus before the low (minutes from the chart's start), when there was one in the chart. */
  meal_minute?: number | null;
  nadir?: number;
  nadir_at?: number;
  /** Minutes under 70 of this low only (not of the whole chart). */
  low_minutes?: number;
  /** Boluses ([minute, U]) and carbs ([minute, g]) in the chart, drawn as on Teraz: a blue triangle with units, an orange dot with grams. */
  boluses?: Array<[number, number]>;
  carbs?: Array<[number, number]>;
}

/** The "Kiedy" mini charts of a pattern of one time of day (docs/product/wzorce-chart-review.md, checked on real data). */
export interface PatternChart {
  /** Local minutes of the day the charts span, and the pattern's own hours (shaded). */
  from_minute: number;
  to_minute: number;
  band_from_minute: number;
  band_to_minute: number;
  /** Counted from the data: the other days at the same hours, and the meal with a bolus before them. */
  comparison: string;
}

export interface PatternResult {
  id: PatternId;
  /** Passes every threshold: would be shown (and may push). */
  shown: boolean;
  /** Why it is not shown (empty when shown, or when there is nothing to see). */
  failed: string[];
  /** One sentence of fact for the card / log. */
  sentence: string;
  /** Counts behind it. */
  stats: Record<string, number | string | null>;
  episodes: PatternEpisode[];
  /** Rows of a card that lists facts instead of one sentence (the settings card). */
  lines?: string[];
  /** More facts for the pattern's own card, under its one or two sentences (the list shows only the sentence). */
  details?: string[];
  chart?: PatternChart;
  /** The change card: one before/after comparison per direction of the change (never merged across directions). */
  groups?: ChangeGroup[];
}

export interface ChangeGroup {
  /** "więcej insuliny" / "mniej insuliny" (what the new values do in these hours). */
  direction: 'MORE' | 'LESS';
  hours: string;
  before: ChangePeriod;
  after: ChangePeriod;
  /** The compared hours as minutes from local midnight (results from before 2026-11-23 have none). */
  windows?: Array<[number, number]>;
  /** The chart's smoothed mean lines, [minute from local midnight, mg/dL] (results from before 2026-11-23 have none). */
  profile?: { before: Array<[number, number]>; after: Array<[number, number]> };
}

export interface ChangePeriod {
  days: number;
  very_low_days: number;
  /** % of the time under 54, under 70, over 180 and over 250 in the compared hours (very_low and tar250 since 2026-11-23). */
  very_low?: number;
  tbr: number;
  tar: number;
  tar250?: number;
}

/** Polish plural: 1 bolus, 2–4 bolusy, 5+ bolusów (12–14 take the last form). */
export function plural(n: number, one: string, few: string, many: string): string {
  if (n === 1) return one;
  const last = n % 10;
  const lastTwo = n % 100;
  return last >= 2 && last <= 4 && (lastTwo < 12 || lastTwo > 14) ? few : many;
}

/** A number with a Polish decimal comma. */
export function num(value: number, digits = 1): string {
  return value.toFixed(digits).replace('.', ',');
}

/** "2 h 20 min", "45 min". */
function duration(minutes: number): string {
  const m = Math.round(minutes / 5) * 5;
  return m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}` : `${m} min`;
}

/** P(X ≥ k) for X ~ Binomial(n, p). */
export function binomialTail(k: number, n: number, p: number): number {
  let total = 0;
  for (let i = k; i <= n; i += 1) {
    let c = 1;
    for (let j = 0; j < i; j += 1) c = (c * (n - j)) / (j + 1);
    total += c * p ** i * (1 - p) ** (n - i);
  }
  return Math.min(1, total);
}

/** Wilson lower bound of k / n at z. */
export function wilsonLower(k: number, n: number, z: number = P.wilson_z): number {
  if (n === 0) return 0;
  const p = k / n;
  const den = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return (centre - margin) / den;
}

interface Ctx {
  data: WhatIfData;
  from: number;
  to: number;
  clock: ReturnType<typeof localClock>;
  readings: Array<[number, number]>;
  readingMs: number[];
  carbs: Array<{ ms: number; g: number; kind: string | null }>;
  boluses: Array<[number, number]>;
  half: number;
  /** Days of the window with enough CGM data, and nights (0–6). */
  dataDays: number;
  dataNights: number;
}

/** "z 14 dni" when every day has data, else "z 12 dni z danymi" (review 2026-11-12: a missing sensor day is not a good day). */
function ofDays(n: number, nights = false): string {
  const word = nights ? 'nocy' : 'dni';
  return n >= THERAPY_PATTERNS_POLICY.window_days ? `z ${n} ${word}` : `z ${n} ${word} z danymi`;
}

function lowerBound(sorted: number[], value: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function values(ctx: Ctx, a: number, b: number): Array<[number, number]> {
  return ctx.readings.slice(lowerBound(ctx.readingMs, a), lowerBound(ctx.readingMs, b));
}

function bgAt(ctx: Ctx, ms: number): number | null {
  const i = lowerBound(ctx.readingMs, ms);
  let best: [number, number] | null = null;
  for (const j of [i - 1, i]) {
    const r = ctx.readings[j];
    if (r && Math.abs(r[0] - ms) <= 7.5 * MIN && (!best || Math.abs(r[0] - ms) < Math.abs(best[0] - ms))) best = r;
  }
  return best ? best[1] : null;
}

/** Low episodes (first reading < 70 after ≥ 30 min at or above 70), without compression lows. */
function lowEpisodes(ctx: Ctx): Array<{ start: number; end: number; nadir: number; minutes: number }> {
  const out: Array<{ start: number; end: number; nadir: number; minutes: number }> = [];
  let current: { start: number; end: number; nadir: number } | null = null;
  let lastLow = -Infinity;
  for (const [ms, v] of values(ctx, ctx.from, ctx.to)) {
    if (v < P.low_mgdl) {
      if (!current || ms - lastLow > 30 * MIN) {
        if (current) out.push({ ...current, minutes: (current.end - current.start) / MIN + 5 });
        current = { start: ms, end: ms, nadir: v };
      } else {
        current.end = ms;
        current.nadir = Math.min(current.nadir, v);
      }
      lastLow = ms;
    }
  }
  if (current) out.push({ ...current, minutes: (current.end - current.start) / MIN + 5 });
  return out.filter((e) => {
    // compression: a fast drop into it and a return above 70 within 30 min without carbs
    const before = bgAt(ctx, e.start - 10 * MIN);
    const fast = before !== null && (before - e.nadir) / 10 >= P.compression_drop_per_min;
    const back = e.end - e.start <= P.compression_return_minutes * MIN;
    const carbs = ctx.carbs.some((c) => c.ms >= e.start - 5 * MIN && c.ms <= e.end + 15 * MIN);
    return !(fast && back && !carbs);
  });
}

const bothWeeks = (ctx: Ctx, times: number[]) => times.some((t) => t < ctx.half) && times.some((t) => t >= ctx.half);

/** W1: night lows without carbs in the 3 h before. */
/** Not run since 2026-11-13 (see RETIRED_PATTERNS); kept for the offline ledger. */
export function nightLows(ctx: Ctx): PatternResult {
  // Nights under 54 (any food before): a fact the family should see, not a pattern. The pattern of nights under 70
  // failed the shuffle test with shifted times (9.9 % of chance windows, offline proof 2026-11-12) and is not run. The
  // nights are counted exactly as the morning push counts them (nightVeryLows).
  const nights = new Map<string, { minutes: number; nadir: number; at: number }>();
  for (let k = 0; k < P.window_days; k += 1) {
    const date = ctx.clock(ctx.from + k * DAY + 12 * HOUR).date;
    for (const r of nightVeryLows(ctx.data, date)) {
      const prev = nights.get(date);
      if (!prev || r.nadir < prev.nadir) nights.set(date, { minutes: r.minutes, nadir: r.nadir, at: r.startMs });
    }
  }
  const list = [...nights.entries()].sort((x, y) => x[1].at - y[1].at);
  const veryLow = list.length;
  const last = list[list.length - 1];
  const day = (iso: string) => `${Number(iso.slice(8))}.${iso.slice(5, 7)}`;
  return {
    id: 'NIGHT_LOWS',
    shown: veryLow > 0,
    failed: veryLow ? [] : ['no night under 54'],
    sentence: veryLow === 1
      ? `W nocy ${day(last[0])} glukoza spadła poniżej 54. To jedyna taka noc w ostatnich 14.`
      : `W ${veryLow} ${plural(veryLow, 'nocy', 'nocach', 'nocach')} ${ofDays(ctx.dataNights, true)} glukoza spadła poniżej 54, ostatnio ${day(last?.[0] ?? '0000-00-00')}.`,
    stats: { very_low_nights: veryLow, ...(veryLow === 1 ? { single: 1 } : {}), last_very_low_at: last ? last[1].at : null },
    episodes: list.map(([date, n]) => ({ at: n.at, date, note: `najniżej ${Math.round(n.nadir)} · ${duration(n.minutes)} poniżej 54` })),
  };
}

/**
 * Time below the consensus goal (Battelino 2019: < 70 under 4 %, < 54 under 1 %) over the 14 days: a fact, not a
 * pattern — "lows after a meal bolus" was shown as often on shuffled data as on real (68 % vs 68 %, offline proof
 * 2026-11-12), so no cause or time is claimed; only where most of the time below 70 was. Never hidden.
 */
/** Not run since 2026-11-13 (see RETIRED_PATTERNS); kept for the offline ledger. */
export function timeBelowGoal(ctx: Ctx): PatternResult {
  const all = values(ctx, ctx.from, ctx.to);
  const below70 = all.filter(([, v]) => v < P.low_mgdl);
  const share70 = all.length ? below70.length / all.length : 0;
  const share54 = all.length ? all.filter(([, v]) => v < P.very_low_mgdl).length / all.length : 0;
  const days = new Map<string, { at: number; nadir: number; minutes: number }>();
  for (const e of lowEpisodes(ctx)) {
    if (e.minutes < P.min_low_minutes) continue;
    const date = ctx.clock(e.start).date;
    const prev = days.get(date);
    if (!prev || e.nadir < prev.nadir) days.set(date, { at: e.start, nadir: e.nadir, minutes: e.minutes });
  }
  const blocks = new Map<number, number>();
  for (const [ms] of below70) { const b = Math.floor(ctx.clock(ms).hour / 3) * 3; blocks.set(b, (blocks.get(b) ?? 0) + 1); }
  const top = [...blocks.entries()].sort((x, y) => y[1] - x[1])[0];
  const block = top && below70.length && top[1] / below70.length >= 1 / 3 ? top[0] : null;
  const pct = (x: number) => num(x * 100);
  const failed = share70 <= P.after_meal_min_share_below_70 && share54 <= P.after_meal_min_share_below_54 ? [`time < 70 ${pct(share70)}% ≤ 4% and < 54 ${pct(share54)}% ≤ 1%`] : [];
  return {
    id: 'TIME_BELOW_GOAL',
    shown: failed.length === 0,
    failed,
    sentence: `Glukoza była poniżej 70 przez ${pct(share70)}% czasu (cel: poniżej 4%), poniżej 54 przez ${pct(share54)}% (cel: poniżej 1%).`,
    // No hours on the card: "most of it between 18 and 21" did not pass a chance test and read as "change that ratio"
    // (role review round 3). The hours stay in the clinic report's table of the day.
    details: [
      `Dni ze spadkiem poniżej 70: ${days.size} ${ofDays(ctx.dataDays)}.`,
      ...(ctx.dataDays < 10 ? [`Tylko ${ctx.dataDays} dni z danymi CGM: to za mało na pewny wynik.`] : []),
    ],
    stats: { share_below_70: Math.round(share70 * 1000) / 10, share_below_54: Math.round(share54 * 1000) / 10, days: days.size, block, data_days: ctx.dataDays },
    episodes: [...days.entries()].sort((x, y) => x[1].at - y[1].at).map(([date, d]) => ({ at: d.at, date, note: `najniżej ${Math.round(d.nadir)} · ${duration(d.minutes)} poniżej 70` })),
  };
}

/** Bolus series: boluses ≥ 0.3 U with gaps ≤ 45 min (outside rescue carbs). */
function bolusSeries(ctx: Ctx): Array<{ first: number; last: number; boluses: Array<[number, number]> }> {
  const out: Array<{ first: number; last: number; boluses: Array<[number, number]> }> = [];
  for (const b of ctx.boluses) {
    if (b[0] < ctx.from || b[0] >= ctx.to || b[1] < P.bolus_min_u) continue;
    const last = out[out.length - 1];
    if (last && b[0] - last.last <= P.series_gap_minutes * MIN) { last.boluses.push(b); last.last = b[0]; } else out.push({ first: b[0], last: b[0], boluses: [b] });
  }
  return out;
}

/** W3 (not run since 2026-11-12, kept for the offline ledger): lows after series of 2+ boluses vs after a single bolus. */
export function followUpPortions(ctx: Ctx): PatternResult {
  const series = bolusSeries(ctx);
  const lowAfter = (t: number) => values(ctx, t, t + P.after_series_hours * HOUR).some(([, v]) => v < P.low_mgdl);
  const multi = series.filter((s) => s.boluses.length >= 2);
  const single = series.filter((s) => s.boluses.length === 1);
  const multiLow = multi.filter((s) => lowAfter(s.last));
  const singleLow = single.filter((s) => lowAfter(s.last)).length;
  const rate = multi.length ? multiLow.length / multi.length : 0;
  // Expected rate for the series from single boluses at the same time of day (3-hour blocks): series happen at meal
  // times, and the shuffle test showed an unmatched comparison lets chance through.
  const block = (ms: number) => Math.floor(ctx.clock(ms).hour / 3);
  const overall = single.length ? singleLow / single.length : 0;
  const blockRate = new Map<number, number>();
  for (let b = 0; b < 8; b += 1) {
    const inBlock = single.filter((s) => block(s.last) === b);
    blockRate.set(b, inBlock.length >= 4 ? inBlock.filter((s) => lowAfter(s.last)).length / inBlock.length : overall);
  }
  const base = multi.length ? multi.reduce((sum, s) => sum + (blockRate.get(block(s.last)) ?? overall), 0) / multi.length : overall;
  const lower = wilsonLower(multiLow.length, multi.length);
  const days = new Set(multiLow.map((s) => ctx.clock(s.last).date));
  const failed: string[] = [];
  if (multiLow.length < P.min_episodes) failed.push(`episodes ${multiLow.length} < ${P.min_episodes}`);
  if (days.size < P.min_days) failed.push(`days ${days.size} < ${P.min_days}`);
  if (!bothWeeks(ctx, multiLow.map((s) => s.last))) failed.push('not in both weeks');
  if ((rate - base) * 100 < P.min_pp_above) failed.push(`+${Math.round((rate - base) * 100)} pp < ${P.min_pp_above}`);
  if (lower <= base) failed.push(`Wilson ${lower.toFixed(2)} ≤ ${base.toFixed(2)}`);
  return {
    id: 'FOLLOW_UP_PORTIONS',
    shown: failed.length === 0,
    failed,
    sentence: `Gdy w 45 minut były 2 bolusy lub więcej, w ciągu ${P.after_series_hours} godzin glukoza spadła poniżej 70 w ${multiLow.length} z ${multi.length} przypadków (${Math.round(rate * 100)}%). Po jednym bolusie o tych porach: ${Math.round(base * 100)}%.`,
    stats: { series: multi.length, series_low: multiLow.length, single: single.length, single_low: singleLow, rate: Math.round(rate * 100), base: Math.round(base * 100), wilson: Math.round(lower * 100) },
    episodes: multiLow.map((s) => ({ at: s.last, date: ctx.clock(s.last).date, note: `${s.boluses.length} ${plural(s.boluses.length, 'bolus', 'bolusy', 'bolusów')} w ${Math.round((s.last - s.first) / MIN)} min, razem ${num(s.boluses.reduce((a, b) => a + b[1], 0))} j` })),
  };
}

/**
 * W2: daytime lows (6–24) without carbs or a bolus in the 3 h before, in one 3-hour window on ≥ 3 days. The window
 * slides by an hour (6–9, 7–10, … 21–24), so lows at 11:55 and 12:15 are not split by a fixed edge at 12:00 (offline
 * proof 2026-11-13, scripts/wzorce-proofs/sliding-window.ts: the 9–12 lows moved 15–45 min later were lost by fixed
 * blocks, kept by the sliding window; chance 2.5 % of shuffled windows vs 1.3 %, under the 5 % rule).
 */
function dayLowsWithoutFood(ctx: Ctx): PatternResult {
  type Low = { at: number; date: string; minute: number; nadir: number; minutes: number };
  const lows: Low[] = [];
  for (const e of lowEpisodes(ctx)) {
    const c = ctx.clock(e.start);
    if (c.hour < P.night_to_hour || e.minutes < P.min_low_minutes) continue;
    const since = e.start - P.day_no_food_hours * HOUR;
    // Food = a meal (≥ 5 g, not carbs that treated an earlier dip: 4 g at 10:08 hid the 11:22 low, 2026-11-13).
    if (ctx.carbs.some((x) => x.ms >= since && x.ms < e.start && x.g >= P.meal_min_grams && x.kind !== 'HYPO_TREATMENT') || ctx.boluses.some(([b]) => b >= since && b < e.start)) continue;
    lows.push({ at: e.start, date: c.date, minute: c.hour * 60 + c.minute, nadir: e.nadir, minutes: e.minutes });
  }
  /** One low per day in the hours [from, from + 3). */
  const daysIn = (fromHour: number) => {
    const list: Low[] = [];
    for (const l of lows) if (l.minute >= fromHour * 60 && l.minute < (fromHour + 3) * 60 && !list.some((x) => x.date === l.date)) list.push(l);
    return list;
  };
  // The chance test compares with the six fixed blocks of the day: days summed over 6–9, 9–12, … (as before the slide).
  const all = [0, 1, 2, 3, 4, 5].reduce((n, i) => n + daysIn(6 + i * 3).length, 0);
  let best: [number, Low[]] | undefined;
  let bestGap = Infinity;
  for (let h = P.night_to_hour; h <= 21; h += 1) {
    const list = daysIn(h);
    if (!list.length) continue;
    // A tie goes to the window centred on the lows (11:12–11:47 → 10–13, not 9–12 with them at its edge).
    const mid = [...list.map((l) => l.minute)].sort((a, b) => a - b)[Math.floor(list.length / 2)];
    const gap = Math.abs(h * 60 + 90 - mid);
    if (!best || list.length > best[1].length || (list.length === best[1].length && gap < bestGap)) { best = [h, list]; bestGap = gap; }
  }
  const failed: string[] = [];
  if (!best || best[1].length < P.day_min_days) failed.push(`days in one window ${best ? best[1].length : 0} < ${P.day_min_days}`);
  else if (!bothWeeks(ctx, best[1].map((x) => x.at))) failed.push('not in both weeks');
  // Lows spread over the day also pile up in some window by chance: the window must stand out among the six.
  const tail = best ? binomialTail(best[1].length, all, 1 / 6) : 1;
  if (best && tail >= P.day_concentration_p) failed.push(`${best[1].length} of ${all} in one window, chance p=${tail.toFixed(2)}`);
  const hours = best ? `${best[0]}:00 a ${best[0] + 3}:00` : '';
  const chart = best ? dayLowsChart(ctx, best[0], best[1]) : null;
  return {
    id: 'DAY_LOWS_WITHOUT_FOOD',
    shown: failed.length === 0,
    failed,
    sentence: best ? `W ${best[1].length} ${ofDays(ctx.dataDays)} między ${hours} glukoza spadła poniżej 70, choć przez ${P.day_no_food_hours} ${plural(P.day_no_food_hours, 'godzinę', 'godziny', 'godzin')} wcześniej nie było jedzenia ani bolusa.` : '',
    stats: { block: best ? best[0] : null, days: best ? best[1].length : 0 },
    episodes: (best?.[1] ?? []).map((x, i) => ({ at: x.at, date: x.date, note: `najniżej ${Math.round(x.nadir)} · ${duration(x.minutes)} poniżej 70`, ...(chart ? chart.episodes[i] : {}) })),
    ...(chart ? { chart: chart.chart } : {}),
  };
}

/**
 * The mini charts of the day lows: each day from 3 h before the pattern's hours to 1 h after (9–12 → 6–13), its
 * meal with a bolus as a mark (no "N h after": the shuffle test did not tie the lows to the bolus), the low's own
 * minutes, and one sentence counted from the data about the other days (2026-11-13: "nie spadła poniżej 70" was false
 * on real data, 3.11 had a low after a snack).
 */
function dayLowsChart(ctx: Ctx, block: number, days: Array<{ at: number; date: string; nadir: number; minutes: number }>): { chart: PatternChart; episodes: Array<Partial<PatternEpisode>> } {
  const from = Math.max(0, (block - 3) * 60);
  const to = Math.min(1440, (block + 4) * 60);
  const dayStart = (date: string) => localInstant(date, 0, ctx.data.time_zone);
  const meal = (a: number, b: number) => ctx.carbs.filter((c) => c.ms >= a && c.ms < b && c.g >= P.meal_min_grams && c.kind !== 'HYPO_TREATMENT' && ctx.boluses.some(([t]) => Math.abs(t - c.ms) <= 30 * MIN)).pop();
  const episodes = days.map((x) => {
    const start = dayStart(x.date);
    const trace = values(ctx, start + from * MIN, start + to * MIN).map(([ms, v]) => [Math.round((ms - start) / MIN) - from, Math.round(v)] as [number, number]);
    const lowReadings = values(ctx, x.at, x.at + x.minutes * MIN + 30 * MIN);
    const nadir = lowReadings.reduce((m, r) => (r[1] < m[1] ? r : m), lowReadings[0] ?? [x.at, x.nadir]);
    const m = meal(start + from * MIN, x.at);
    const a = start + from * MIN; const b = start + to * MIN;
    const boluses = ctx.boluses.filter(([t, u]) => t >= a && t < b && u >= 0.05).map(([t, u]) => [Math.round((t - start) / MIN) - from, Math.round(u * 100) / 100] as [number, number]);
    const carbs = ctx.carbs.filter((c) => c.ms >= a && c.ms < b && c.g > 0).map((c) => [Math.round((c.ms - start) / MIN) - from, Math.round(c.g)] as [number, number]);
    return { trace, meal_minute: m ? Math.round((m.ms - start) / MIN) - from : null, nadir: Math.round(nadir[1]), nadir_at: nadir[0], low_minutes: Math.round(x.minutes), boluses, carbs };
  });
  // The other days with data: any reading under 70 in the same hours, and whether food or a bolus came before it.
  const lowDates = new Set(days.map((d) => d.date));
  const others: Array<{ date: string; withFood: boolean }> = [];
  let otherDays = 0; let mealDays = 0;
  for (let k = 0; k < P.window_days; k += 1) {
    const date = ctx.clock(ctx.from + k * DAY + 12 * HOUR).date;
    const start = dayStart(date);
    if (meal(start + from * MIN, start + block * 60 * MIN)) mealDays += 1;
    if (lowDates.has(date)) continue;
    const inBand = values(ctx, start + block * 60 * MIN, start + (block + 3) * 60 * MIN);
    if (!inBand.length) continue;
    otherDays += 1;
    const firstLow = inBand.find(([, v]) => v < P.low_mgdl);
    if (firstLow) {
      const since = firstLow[0] - P.day_no_food_hours * HOUR;
      const withFood = ctx.carbs.some((c) => c.ms >= since && c.ms < firstLow[0] && c.kind !== 'HYPO_TREATMENT') || ctx.boluses.some(([t]) => t >= since && t < firstLow[0]);
      others.push({ date, withFood });
    }
  }
  const dm = (iso: string) => `${Number(iso.slice(8))}.${iso.slice(5, 7)}`;
  const hours = `${block} a ${block + 3}`;
  const lows = others.length === 0
    ? `W pozostałych ${otherDays} dniach między ${hours} glukoza nie spadła poniżej 70.`
    : `W pozostałych ${otherDays} dniach między ${hours} glukoza spadła poniżej 70 ${others.length === 1 ? 'raz' : `${others.length} razy`} (${others.map((o) => dm(o.date)).join(', ')})${others.every((o) => o.withFood) ? `, ale wtedy wcześniej było jedzenie albo bolus` : ''}.`;
  const total = Math.min(P.window_days, ctx.dataDays);
  const meals = mealDays >= total ? `Posiłek z bolusem przed ${block}:00 był we wszystkich ${total} dniach.` : `Posiłek z bolusem przed ${block}:00 był w ${mealDays} z ${total} dni.`;
  return { chart: { from_minute: from, to_minute: to, band_from_minute: block * 60, band_to_minute: (block + 3) * 60, comparison: `${lows} ${meals}` }, episodes };
}

/** "wieczorem", "rano"… from the middle of the hours. */
export function dayPart(fromMinute: number, toMinute: number): string {
  const mid = (fromMinute + toMinute) / 120;
  if (mid < 5) return 'w nocy';
  if (mid < 10) return 'rano';
  if (mid < 14) return 'w południe';
  if (mid < 18) return 'po południu';
  return 'wieczorem';
}

/** Meals: carbs ≥ 5 g (merged within 45 min) with a bolus within 30 min, not eaten low. */
function meals(ctx: Ctx): Array<{ at: number; g: number; bolusOffsetMin: number }> {
  const out: Array<{ at: number; g: number; last: number }> = [];
  for (const c of ctx.carbs) {
    if (c.ms < ctx.from || c.ms >= ctx.to || c.kind === 'HYPO_TREATMENT' || c.g < 1) continue;
    const last = out[out.length - 1];
    // Portions eaten within 45 min are one meal (the same gap as a bolus series): their rises are one rise.
    if (last && c.ms - last.last <= P.series_gap_minutes * MIN) { last.g += c.g; last.last = c.ms; continue; }
    out.push({ at: c.ms, g: c.g, last: c.ms });
  }
  return out
    .filter((m) => m.g >= P.meal_min_grams && (bgAt(ctx, m.at) ?? 0) >= P.rescue_below_mgdl && ctx.boluses.some(([b]) => Math.abs(b - m.at) <= 30 * MIN))
    .map((m) => {
      const near = ctx.boluses.filter(([b]) => Math.abs(b - m.at) <= 30 * MIN).sort((a, b) => Math.abs(a[0] - m.at) - Math.abs(b[0] - m.at))[0];
      return { at: m.at, g: m.g, bolusOffsetMin: Math.round((near[0] - m.at) / MIN) };
    });
}

function bolusTiming(offset: number): string {
  if (offset <= -1) return `bolus ${-offset} min przed`;
  if (offset >= 1) return `bolus ${offset} min po`;
  return 'bolus razem z jedzeniem';
}

/**
 * W5: rises after meals at one time of day — peak > 250 or > 180 for over 2 h within 3 h — in ≥ 50 % of the meals of
 * one block of the current ICR schedule and clearly more often than in the other blocks (so a patient whose every meal
 * rises does not see it forever).
 */
function mealRisesSameTime(ctx: Ctx): PatternResult {
  const therapies = [...ctx.data.therapies].sort((a, b) => (a.from_ms ?? 0) - (b.from_ms ?? 0));
  const icr = therapies[therapies.length - 1]?.carb_ratio_g_per_u ?? [['00:00', 0]];
  const starts = [...new Set(icr.map(([t]) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; }))].sort((a, b) => a - b);
  if (starts[0] !== 0) starts.unshift(0);
  const blockOf = (ms: number) => { const c = ctx.clock(ms); const m = c.hour * 60 + c.minute; let i = 0; starts.forEach((s, k) => { if (s <= m) i = k; }); return i; };
  const label = (i: number) => { const a = starts[i]; const b = i + 1 < starts.length ? starts[i + 1] : 1440; const f = (x: number) => `${Math.floor(x / 60)}:${String(x % 60).padStart(2, '0')}`; return `${f(a)}–${f(b)}`; };
  const list = meals(ctx);
  const rows = list.map((m, i) => {
    // Up to 3 h, but not past the next meal: one rise is counted once.
    const end = Math.min(m.at + P.meal_rise_hours * HOUR, list[i + 1]?.at ?? Infinity);
    const w = values(ctx, m.at, end);
    const start = bgAt(ctx, m.at) ?? w[0]?.[1] ?? 0;
    const peak = Math.max(0, ...w.map(([, v]) => v));
    const above = w.filter(([, v]) => v > 180).length * 5;
    const rise = peak - start >= P.meal_rise_min_delta_mgdl && (peak > P.meal_rise_peak_mgdl || above > P.meal_rise_minutes_above_180);
    return { ...m, block: blockOf(m.at), rise, peak, above, start };
  })
    // Eaten already high (often the second part of a split meal): its peak is not this meal's rise.
    .filter((r) => r.start > 0 && r.start <= P.meal_rise_max_start_mgdl);
  let best: { i: number; k: number; n: number; base: number } | null = null;
  for (let i = 0; i < starts.length; i += 1) {
    const inB = rows.filter((r) => r.block === i);
    const out = rows.filter((r) => r.block !== i);
    if (inB.length < P.meal_rise_min_meals) continue;
    const k = inB.filter((r) => r.rise).length;
    const base = out.length ? out.filter((r) => r.rise).length / out.length : 0;
    if (!best || k / inB.length - base > best.k / best.n - best.base) best = { i, k, n: inB.length, base };
  }
  const failed: string[] = [];
  if (!best) failed.push('no block with enough meals');
  else {
    const share = best.k / best.n;
    if (share < P.meal_rise_min_share) failed.push(`share ${Math.round(share * 100)}% < 33%`);
    if (share < best.base * P.meal_rise_min_ratio) failed.push(`share ${Math.round(share * 100)}% < 3 × ${Math.round(best.base * 100)}%`);
    if ((share - best.base) * 100 < P.min_pp_above) failed.push(`+${Math.round((share - best.base) * 100)} pp < ${P.min_pp_above}`);
    if (wilsonLower(best.k, best.n) <= best.base) failed.push('Wilson ≤ other times');
    const days = new Set(rows.filter((r) => r.block === best!.i && r.rise).map((r) => ctx.clock(r.at).date));
    if (days.size < P.min_days) failed.push(`days ${days.size} < ${P.min_days}`);
    if (!bothWeeks(ctx, rows.filter((r) => r.block === best!.i && r.rise).map((r) => r.at))) failed.push('not in both weeks');
  }
  const hits = best ? rows.filter((r) => r.block === best!.i && r.rise) : [];
  const fromMinute = best ? starts[best.i] : 0;
  const toMinute = best ? (best.i + 1 < starts.length ? starts[best.i + 1] : 1440) : 0;
  // A carb ratio change of these hours inside the window: the rises before and after it are counted together.
  const change = best ? profileChanges(ctx.data.therapies, ctx.from, ctx.to, (ms) => ctx.clock(ms).date)
    .filter((c) => c.setting === 'ICR' && c.fromMinute < toMinute && c.toMinute > fromMinute).sort((a, b) => b.at - a.at)[0] : undefined;
  const changeDate = change ? ctx.clock(change.at).date : null;
  // Lows of the same hours (role review 2026-11-12): said on the card, so a stronger ratio is not read as the answer.
  const lowDays = best ? new Set(lowEpisodes(ctx).filter((e) => { const c = ctx.clock(e.start); const m = c.hour * 60 + c.minute; return e.minutes >= P.min_low_minutes && m >= fromMinute && m < Math.min(toMinute + 180, 1440); }).map((e) => ctx.clock(e.start).date)).size : 0;
  const day = (iso: string) => `${Number(iso.slice(8))}.${iso.slice(5, 7)}`;
  return {
    id: 'MEAL_RISES_SAME_TIME',
    shown: failed.length === 0,
    failed,
    // Two sentences at most on the list (plan to 9/10); the definition and the context on the card.
    sentence: best ? [
      `Po ${best.k} z ${best.n} posiłków ${dayPart(fromMinute, toMinute)} glukoza mocno wzrosła (o innych porach ${Math.round(best.base * 100)}%).`,
      ...(lowDays >= P.min_days ? ['W tych godzinach były też spadki.'] : []),
    ].join(' ') : '',
    details: best ? [
      'Mocno: o co najmniej 60, do ponad 250 albo ponad 180 dłużej niż 2 godziny. Liczone są posiłki zaczęte poniżej 180.',
      ...(lowDays >= P.min_days ? [`Spadki poniżej 70 w tych godzinach: ${lowDays} ${ofDays(ctx.dataDays)}.`] : []),
      ...(changeDate ? [`Te dni obejmują zmianę przelicznika z ${day(changeDate)}.`] : []),
    ] : [],
    stats: best ? { block: label(best.i), from_minute: fromMinute, to_minute: toMinute, meals: best.n, rises: best.k, base: Math.round(best.base * 100), low_days: lowDays, change_date: changeDate } : {},
    episodes: hits.map((r) => ({
      at: r.at,
      date: ctx.clock(r.at).date,
      note: `${Math.round(r.g)} g · ${bolusTiming(r.bolusOffsetMin)} · start ${Math.round(r.start)} · ${r.peak > P.meal_rise_peak_mgdl ? `najwyżej ${Math.round(r.peak)}` : `ponad 180 przez ${duration(r.above)}`}`,
    })),
  };
}

/** W6: above 250 within 2 h after treating a low (rescue carbs) in ≥ 40 % of treated lows, ≥ 4 cases. */
function rescueRebound(ctx: Ctx): PatternResult {
  const rescues: Array<{ at: number; g: number }> = [];
  for (const c of ctx.carbs) {
    if (c.ms < ctx.from || c.ms >= ctx.to) continue;
    const bg = bgAt(ctx, c.ms);
    const eatenLow = (c.kind === null || c.kind === 'CORRECTION_CARBS') && bg !== null && bg < P.rescue_below_mgdl && !ctx.boluses.some(([b]) => Math.abs(b - c.ms) <= 30 * MIN);
    if (c.kind !== 'HYPO_TREATMENT' && !eatenLow) continue;
    const last = rescues[rescues.length - 1];
    if (last && c.ms - last.at <= 30 * MIN) { last.g += c.g; continue; }
    rescues.push({ at: c.ms, g: c.g });
  }
  const cases = rescues.map((r) => ({ ...r, peak: Math.max(0, ...values(ctx, r.at, r.at + P.rescue_rebound_hours * HOUR).map(([, v]) => v)) }));
  const rebound = cases.filter((c) => c.peak > P.rescue_rebound_mgdl);
  const share = cases.length ? rebound.length / cases.length : 0;
  const grams = cases.map((c) => c.g).sort((a, b) => a - b);
  const median = grams.length ? grams[Math.floor(grams.length / 2)] : null;
  const failed: string[] = [];
  if (cases.length < P.rescue_min_cases) failed.push(`treated lows ${cases.length} < ${P.rescue_min_cases}`);
  if (share < P.rescue_min_share) failed.push(`share ${Math.round(share * 100)}% < 40%`);
  const reboundDays = new Set(rebound.map((c) => ctx.clock(c.at).date)).size;
  if (reboundDays < P.rescue_min_days) failed.push(`days ${reboundDays} < ${P.rescue_min_days}`);
  if (!bothWeeks(ctx, rebound.map((c) => c.at))) failed.push('not in both weeks');
  return {
    id: 'RESCUE_REBOUND',
    shown: failed.length === 0,
    failed,
    sentence: `Po ${rebound.length} z ${cases.length} zapisanych leczeń spadku glukoza przekroczyła 250 w ciągu 2 godzin.`,
    stats: { treated: cases.length, rebound: rebound.length, median_g: median },
    episodes: rebound.map((c) => ({ at: c.at, date: ctx.clock(c.at).date, note: `${Math.round(c.g)} g · potem najwyżej ${Math.round(c.peak)}` })),
  };
}

/**
 * W9 (not run since the offline proof 2026-11-12: as often on shuffled data as on real; kept for the ledger): lows within 4 h after a meal bolus, on ≥ 4 days in both weeks, while time below 70 (> 4 %) or below 54 (> 1 %)
 * is above the consensus goal (role review 2026-11-12: the patient's biggest risk had no pattern). Never hidden.
 */
export function lowsAfterMealBolus(ctx: Ctx): PatternResult {
  const mealBoluses = meals(ctx).map((m) => ({ ...m, bolusAt: m.at + m.bolusOffsetMin * MIN }));
  const hits: Array<{ at: number; date: string; nadir: number; minutes: number; g: number; meal: number; after: number }> = [];
  for (const e of lowEpisodes(ctx)) {
    if (e.minutes < P.min_low_minutes) continue;
    const m = [...mealBoluses].reverse().find((x) => x.bolusAt <= e.start && e.start - x.bolusAt <= P.after_meal_hours * HOUR);
    if (!m) continue;
    hits.push({ at: e.start, date: ctx.clock(e.start).date, nadir: e.nadir, minutes: e.minutes, g: m.g, meal: m.at, after: (e.start - m.bolusAt) / MIN });
  }
  const byDay = new Map<string, (typeof hits)[number]>();
  for (const h of hits) { const prev = byDay.get(h.date); if (!prev || h.nadir < prev.nadir) byDay.set(h.date, h); }
  const days = [...byDay.values()];
  const veryLowDays = days.filter((h) => h.nadir < P.very_low_mgdl).length;
  const all = values(ctx, ctx.from, ctx.to);
  const below70 = all.length ? all.filter(([, v]) => v < P.low_mgdl).length / all.length : 0;
  const below54 = all.length ? all.filter(([, v]) => v < P.very_low_mgdl).length / all.length : 0;
  const failed: string[] = [];
  if (below70 <= P.after_meal_min_share_below_70 && below54 <= P.after_meal_min_share_below_54) failed.push(`time < 70 ${(below70 * 100).toFixed(1)}% ≤ 4% and < 54 ${(below54 * 100).toFixed(1)}% ≤ 1%`);
  if (days.length < P.after_meal_min_days) failed.push(`days ${days.length} < ${P.after_meal_min_days}`);
  if (!bothWeeks(ctx, days.map((h) => h.at))) failed.push('not in both weeks');
  // The meal hours most of them follow (3-hour blocks), when one holds at least half.
  // Is it about the bolus? The 4-hour windows after meal boluses must hold clearly more of the lows than of the day
  // (with five meals a day they cover most of it: review 2026-11-12, B8).
  const windows = mealBoluses.map((m) => [Math.max(m.bolusAt, ctx.from), Math.min(m.bolusAt + P.after_meal_hours * HOUR, ctx.to)] as [number, number]).filter(([x, y]) => y > x).sort((x, y) => x[0] - y[0]);
  let covered = 0; let end = -Infinity;
  for (const [x, y] of windows) { if (y <= end) continue; covered += y - Math.max(x, end); end = y; }
  const timeShare = covered / (ctx.to - ctx.from);
  const allLows = lowEpisodes(ctx).filter((e) => e.minutes >= P.min_low_minutes);
  const lowShare = allLows.length ? hits.length / allLows.length : 0;
  const ratio = timeShare > 0 ? lowShare / timeShare : 0;
  const aboutBolus = ratio >= P.after_meal_min_ratio;
  // The meal hours most of them follow (3-hour blocks), when one holds at least half.
  const blocks = new Map<number, number>();
  for (const h of days) { const b = Math.floor(ctx.clock(h.meal).hour / 3) * 3; blocks.set(b, (blocks.get(b) ?? 0) + 1); }
  const top = [...blocks.entries()].sort((x, y) => y[1] - x[1])[0];
  const block = aboutBolus && top && top[1] * 2 >= days.length ? top[0] : null;
  const afters = days.map((h) => h.after).sort((x, y) => x - y);
  const medianAfter = afters.length ? afters[Math.floor(afters.length / 2)] : null;
  // The loop's microboluses between the meal bolus and the low (a fact from the log; shown when the offline proof holds).
  const smbBetween = (h: (typeof hits)[number]) => (ctx.data.smbs ?? []).filter(([ms]) => ms >= h.meal - 30 * MIN && ms < h.at).reduce((sum, [, u]) => sum + u, 0);
  const hhmm = (ms: number) => { const c = ctx.clock(ms); return `${c.hour}:${String(c.minute).padStart(2, '0')}`; };
  const veryLow = veryLowDays === 1 ? ', raz poniżej 54' : veryLowDays > 1 ? `, w ${veryLowDays} z nich poniżej 54` : '';
  return {
    id: 'LOWS_AFTER_MEAL_BOLUS',
    shown: failed.length === 0,
    failed,
    sentence: aboutBolus
      ? `W ${days.length} ${ofDays(ctx.dataDays)} glukoza spadła poniżej 70 w ciągu ${P.after_meal_hours} godzin po bolusie do posiłku${veryLow}.`
      : `W ${days.length} ${ofDays(ctx.dataDays)} glukoza spadła poniżej 70 w ciągu dnia${veryLow}.`,
    details: [
      ...(aboutBolus && medianAfter !== null ? [`Zwykle ${duration(medianAfter)} po bolusie${block !== null ? `, najczęściej po posiłkach między ${block} a ${block + 3}` : ''}.`] : []),
      `Godziny po bolusach do posiłków to ${Math.round(timeShare * 100)}% doby, a było w nich ${Math.round(lowShare * 100)}% spadków.`,
    ],
    stats: {
      days: days.length, very_low_days: veryLowDays, block, about_bolus: aboutBolus ? 1 : 0,
      share_of_time_after_meal: Math.round(timeShare * 100), share_of_lows_after_meal: Math.round(lowShare * 100), ratio: Math.round(ratio * 100) / 100,
      median_after_minutes: medianAfter !== null ? Math.round(medianAfter) : null,
      share_below_70: Math.round(below70 * 1000) / 10, share_below_54: Math.round(below54 * 1000) / 10,
    },
    episodes: days.sort((x, y) => x.at - y.at).map((h) => {
      const smb = P.after_meal_show_smb ? smbBetween(h) : 0;
      return { at: h.at, date: h.date, note: `posiłek ${Math.round(h.g)} g o ${hhmm(h.meal)} · ${duration(h.after)} po bolusie${smb >= 0.1 ? ` · pętla dodała ${num(smb)} j` : ''} · najniżej ${Math.round(h.nadir)}` };
    }),
  };
}

/** W8: settings to check (facts only): long DIA, hours where the loop's own microbolus limit was 0. */
function settingCheck(ctx: Ctx): PatternResult {
  const therapies = [...ctx.data.therapies].sort((a, b) => (a.from_ms ?? 0) - (b.from_ms ?? 0));
  const current = therapies[therapies.length - 1];
  const facts: string[] = [];
  const stats: Record<string, number | string | null> = {};
  if (ctx.data.dia_hours !== null && ctx.data.dia_hours >= P.dia_check_hours) {
    facts.push(`Czas działania insuliny (DIA) w Trio: ${num(ctx.data.dia_hours, Number.isInteger(ctx.data.dia_hours) ? 0 : 1)} ${plural(ctx.data.dia_hours, 'godzina', 'godziny', 'godzin')}.`);
    stats.dia_hours = ctx.data.dia_hours;
  }
  // The loop's own limit from its logged decisions (reason.maxBolus); the basal formula only without a Trio log.
  const cycles = (ctx.data.trio_cycles ?? []).filter((r) => r.ms >= ctx.from && r.ms < ctx.to).map(readTrioCycle).filter((c): c is TrioCycle => c !== null);
  let blockedHours = 0;
  if (cycles.length > 100) {
    const byHour = Array.from({ length: 24 }, () => ({ n: 0, zero: 0 }));
    for (const c of cycles) {
      if (c.reason.maxBolus === null || c.reason.maxBolus === undefined) continue;
      const h = byHour[ctx.clock(c.ms).hour];
      h.n += 1;
      if (c.reason.maxBolus < TRIO_REPLICA_POLICY.smb_step_u) h.zero += 1;
    }
    blockedHours = byHour.filter((h) => h.n >= 10 && h.zero / h.n >= P.smb_zero_share).length;
    stats.smb_blocked_source = 'decisions';
  } else {
    let blockedMinutes = 0;
    for (let m = 0; m < 1440; m += 5) if (smbCapFor(scheduleAt(current?.basal_u_per_h, m) ?? 0) < TRIO_REPLICA_POLICY.smb_step_u) blockedMinutes += 5;
    blockedHours = Math.round(blockedMinutes / 60);
    stats.smb_blocked_source = 'basal';
  }
  if (blockedHours >= P.minimum_basal_hours) {
    const hours = `${blockedHours} ${plural(blockedHours, 'godzinę', 'godziny', 'godzin')}`;
    facts.push(stats.smb_blocked_source === 'decisions'
      ? `Przez ${hours} doby limit mikrobolusa w decyzjach pętli wynosił 0 j: pętla nie mogła dać mikrobolusa, mogła tylko podnieść bazę.`
      : `Przez ${hours} doby baza jest tak niska, że pętla nie może dać mikrobolusa (może tylko podnieść bazę).`);
    stats.smb_blocked_hours = blockedHours;
  }
  // Dynamic ISF at its limit is not listed until the lower limit is read from autosens min (role review 2026-11-12).
  stats.facts = facts.length;
  return {
    id: 'SETTING_CHECK',
    shown: facts.length > 0,
    failed: facts.length ? [] : ['nothing to check'],
    // The card's title already says it is for the clinic: one row per fact.
    sentence: facts.join(' '),
    stats,
    episodes: [],
    lines: facts,
  };
}

export interface NightVeryLowRun { date: string; startMs: number; nadir: number; nadirMs: number; minutes: number; maybeCompression: boolean }

/**
 * The night of `dateIso` (22:00 the day before to 6:00) and its lows under 54: runs of ≥ 15 min (3 readings) under 54,
 * any food before. One definition for the morning push and the card. A run that looks like sensor compression (fast
 * into 54 and out within 30 min, no carbs) is KEPT and only marked: dropping it also dropped real deep lows treated with
 * juice nobody entered (role review round 4, 2026-11-12).
 */
export function nightVeryLows(data: WhatIfData, dateIso: string): NightVeryLowRun[] {
  const readings = data.readings.filter(([, v]) => v > 0).sort((a, b) => a[0] - b[0]);
  const prev = new Date(Date.parse(`${dateIso}T12:00:00Z`) - DAY).toISOString().slice(0, 10);
  const nightStart = localInstant(prev, 22 * 60, data.time_zone);
  const nightEnd = localInstant(dateIso, P.night_to_hour * 60, data.time_zone);
  const near = readings.filter(([ms]) => ms >= nightStart - HOUR && ms < nightEnd + 2 * HOUR);
  const runs: Array<Array<[number, number]>> = [];
  let run: Array<[number, number]> = [];
  for (const r of near) {
    const gap = run.length ? r[0] - run[run.length - 1][0] : 0;
    if (r[1] < P.very_low_mgdl && gap <= 11 * MIN) run.push(r);
    else { if (run.length) runs.push(run); run = r[1] < P.very_low_mgdl ? [r] : []; }
  }
  if (run.length) runs.push(run);
  const before = (ms: number) => { let best: [number, number] | null = null; for (const r of near) if (r[0] <= ms - 8 * MIN && r[0] >= ms - 13 * MIN) best = r; return best; };
  return runs
    .filter((r) => r.length >= 3 && r[0][0] >= nightStart && r[0][0] < nightEnd)
    .map((r) => {
      const nadir = r.reduce((x, y) => (y[1] < x[1] ? y : x));
      // speed into the run: from ~10 min before to its FIRST reading under 54 (not to the nadir)
      const b = before(r[0][0]);
      const fast = b !== null && (b[1] - r[0][1]) / ((r[0][0] - b[0]) / MIN) >= P.compression_drop_per_min;
      const short = r[r.length - 1][0] - r[0][0] <= P.compression_return_minutes * MIN;
      const carbs = data.carbs.some((c) => c.g > 0 && c.ms >= r[0][0] - 5 * MIN && c.ms <= r[r.length - 1][0] + 15 * MIN);
      return { date: dateIso, startMs: r[0][0], nadir: nadir[1], nadirMs: nadir[0], minutes: (r[r.length - 1][0] - r[0][0]) / MIN + 5, maybeCompression: fast && short && !carbs && nadir[1] >= 50 };
    });
}

/** Last night's lows under 54, for the morning push. */
export function lastNightVeryLows(data: WhatIfData, todayIso: string): NightVeryLowRun[] {
  return nightVeryLows(data, todayIso);
}

/** All patterns for the 14 full days before `todayIso` (local date of the run). */
export function detectPatterns(data: WhatIfData, todayIso: string): PatternResult[] {
  const clock = localClock(data.time_zone);
  const [y, m, d] = todayIso.split('-').map(Number);
  // local midnight of today, then 14 days back
  const guess = Date.UTC(y, m - 1, d);
  let to = guess;
  for (let i = 0; i < 2; i += 1) { const c = clock(to); const [ly, lm, ld] = c.date.split('-').map(Number); to += guess - Date.UTC(ly, lm - 1, ld, c.hour, c.minute); }
  // Local midnight 14 days back (not 14 × 24 h: across a DST change the window started at 01:00).
  const back = new Date(Date.UTC(y, m - 1, d) - P.window_days * DAY).toISOString().slice(0, 10);
  const from = localInstant(back, 0, data.time_zone);
  const readings = data.readings.filter(([, v]) => v > 0).sort((a, b) => a[0] - b[0]);
  const ctx: Ctx = {
    data, from, to, clock,
    readings, readingMs: readings.map(([ms]) => ms),
    carbs: [...data.carbs].filter((c) => c.g > 0).sort((a, b) => a.ms - b.ms),
    boluses: [...data.boluses].filter(([, u]) => u > 0).sort((a, b) => a[0] - b[0]),
    half: from + (P.window_days / 2) * DAY,
    dataDays: P.window_days,
    dataNights: P.window_days,
  };
  // Days (and nights 0–6) with at least 70 % of their 5-minute readings.
  const perDay = new Map<string, { all: number; night: number }>();
  for (const [ms] of values(ctx, from, to)) {
    const c = clock(ms);
    const d = perDay.get(c.date) ?? { all: 0, night: 0 };
    d.all += 1;
    if (c.hour < P.night_to_hour) d.night += 1;
    perDay.set(c.date, d);
  }
  ctx.dataDays = Math.min(P.window_days, [...perDay.values()].filter((d) => d.all >= 288 * P.min_day_coverage).length);
  ctx.dataNights = Math.min(P.window_days, [...perDay.values()].filter((d) => d.night >= 72 * P.min_day_coverage).length);
  return [dayLowsWithoutFood(ctx), mealRisesSameTime(ctx), rescueRebound(ctx), settingCheck(ctx)];
}
