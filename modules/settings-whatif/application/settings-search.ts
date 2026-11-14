import { isfToMgdl } from '@modules/glucose-forecast/application/isf-units';
import type { WhatIfData, WhatIfTherapy } from './icr-whatif';
import {
  inBlock,
  localClock,
  replaySettingChange,
  scheduleAt,
  toMinutes,
  windowOutcome,
  type DayRun,
  type ReplaySetting,
  type ReplayWindow,
  type SettingChange,
  type SettingsReplayResult,
  type WindowOutcome,
} from './settings-replay';

/**
 * "Pod lupą" on the settings replay (settings-search.v1): where the last weeks were off the consensus goals (places)
 * and, for one place, the one-step change that smooths it without more lows. One engine with the chat card.
 *
 * Places (docs/product/settings-lupa-mockups-review-2.md, owner decision 2026-11-11):
 * - a place is a block of the current ICR schedule (a change on its card always fits the place);
 * - lows: a fixed 3-hour window over the goal (< 70 below 4 %, < 54 below 1 %) and over it on at least 5 of the days
 *   makes the block of that window a place, "lows mainly HH–HH";
 * - rises: the whole block above 1.2 × the goal (> 180 below 25 %, > 250 below 5 %);
 * - a block whose settings changed in the last `recent_change_days` waits for the comparison of that change.
 * Search, per place: one-step candidates only (ICR and ISF ±10 %, target ±10, each basal entry ±0.05 U/h); lows are a
 * hard limit (neither minutes nor days below 70 or 54 may grow, also with half the insulin effect and without the two
 * most-moved days); in a lows place no candidate that gives more insulin in those hours; rises may grow by at most
 * half (minutes and days above 180 and above 250, owner decision 2026-11-11: a change that moves the problem elsewhere
 * is not "found"). The winner reduces the place's problem most, its cost is always shown; under `min_gain_share` there
 * is no change. Any value can still be checked by hand (−/+ on the card, the chat) with the full numbers.
 */
export const SETTINGS_SEARCH_POLICY = {
  version: 'settings-search.v1',
  days: 27,
  goals: { below_70: 0.04, below_54: 0.01, above_180: 0.25, above_250: 0.05 },
  rise_margin: 1.2,
  lows_window_hours: 3,
  lows_min_days: 5,
  recent_change_days: 14,
  /** The outcome window runs this long after the place, so a late change still shows. */
  tail_hours: 4,
  icr_step: 0.1,
  isf_step: 0.1,
  target_step_mgdl: 10,
  basal_step_u_per_h: 0.05,
  min_gain_share: 0.1,
  /** Rises may grow by at most this share; from zero, by at most one day / one hour. */
  rise_cost_max_share: 0.5,
  rise_cost_floor_days: 1,
  rise_cost_floor_minutes: 60,
  robustness_insulin_scale: 0.5,
  robustness_drop_days: 2,
} as const;

const S = SETTINGS_SEARCH_POLICY;

export interface PlaceStats {
  days: number;
  below_70: number;
  below_54: number;
  above_180: number;
  above_250: number;
  days_below_70: number;
  days_below_54: number;
  days_above_180_over_1h: number;
}

export interface Place {
  /** Block of the current ICR schedule, "HH:MM". */
  from: string;
  to: string;
  kind: 'LOWS' | 'RISES';
  /** For LOWS: the 3-hour windows over the goal on enough days, joined ("12:00"–"18:00"). */
  lows_window: { from: string; to: string } | null;
  stats: PlaceStats;
  /** Settings of this block changed in the last weeks: the date and when its comparison is due. */
  changed_on: string | null;
  waits_until: string | null;
}

export interface PlacesResult {
  version: string;
  first_date: string;
  last_date: string;
  /** Lows first (by share over the goal), then rises. */
  places: Place[];
  /** Blocks with no goal exceeded. */
  within_goals: Array<{ from: string; to: string }>;
}

const hhmm = (minutes: number) => {
  const m = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};

function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

function blocksOf(schedule: Array<[string, number]>): Array<{ from: number; to: number }> {
  const starts = [...new Set(schedule.map(([t]) => toMinutes(t)))].sort((a, b) => a - b);
  if (starts[0] !== 0) starts.unshift(0);
  return starts.map((from, i) => ({ from, to: i + 1 < starts.length ? starts[i + 1] : 1440 }));
}

const sameSchedule = (a: Array<[string, number]> | null | undefined, b: Array<[string, number]> | null | undefined, from: number, to: number) => {
  for (let m = from; m < to; m += 5) if (scheduleAt(a, m) !== scheduleAt(b, m)) return false;
  return true;
};

/** Where the last `days` full days were off the goals. `todayIso` is the local date the analysis runs on. */
export function findPlaces(data: WhatIfData, todayIso: string): PlacesResult {
  const clock = localClock(data.time_zone);
  const therapies = [...data.therapies].sort((a, b) => (a.from_ms ?? 0) - (b.from_ms ?? 0));
  const current = therapies[therapies.length - 1];
  const lastDate = addDays(todayIso, -1);
  const firstDate = addDays(lastDate, -(S.days - 1));
  const byDay = new Map<string, Array<[number, number]>>();
  for (const [ms, v] of data.readings) {
    if (!(v > 0)) continue;
    const c = clock(ms);
    if (c.date < firstDate || c.date > lastDate) continue;
    const list = byDay.get(c.date) ?? [];
    list.push([c.hour * 60 + c.minute, v]);
    byDay.set(c.date, list);
  }
  const days = [...byDay.keys()].sort();

  const stats = (from: number, to: number): PlaceStats & { overDays: { below_70: number; below_54: number } } => {
    let n = 0;
    const c = { b70: 0, b54: 0, a180: 0, a250: 0 };
    let d70 = 0;
    let d54 = 0;
    let dHigh = 0;
    let over70 = 0;
    let over54 = 0;
    for (const day of days) {
      const values = byDay.get(day)!.filter(([m]) => m >= from && m < to).map(([, v]) => v);
      if (values.length === 0) continue;
      const b70 = values.filter((v) => v < 70).length;
      const b54 = values.filter((v) => v < 54).length;
      const a180 = values.filter((v) => v > 180).length;
      n += values.length;
      c.b70 += b70; c.b54 += b54; c.a180 += a180; c.a250 += values.filter((v) => v > 250).length;
      if (b70 > 0) d70 += 1;
      if (b54 > 0) d54 += 1;
      if (a180 * 5 >= 60) dHigh += 1;
      if (b70 / values.length > S.goals.below_70) over70 += 1;
      if (b54 / values.length > S.goals.below_54) over54 += 1;
    }
    const share = (x: number) => (n ? x / n : 0);
    return {
      days: days.length,
      below_70: share(c.b70), below_54: share(c.b54), above_180: share(c.a180), above_250: share(c.a250),
      days_below_70: d70, days_below_54: d54, days_above_180_over_1h: dHigh,
      overDays: { below_70: over70, below_54: over54 },
    };
  };

  const icrBlocks = blocksOf(current.carb_ratio_g_per_u ?? [['00:00', 0]]);
  // Lows in fixed 3-hour windows, each assigned to the ICR block it overlaps most.
  const lowsByBlock = new Map<number, Array<{ from: number; to: number; excess: number }>>();
  const w = S.lows_window_hours * 60;
  for (let from = 0; from < 1440; from += w) {
    const s = stats(from, from + w);
    const over70 = s.below_70 > S.goals.below_70 && s.overDays.below_70 >= S.lows_min_days;
    const over54 = s.below_54 > S.goals.below_54 && s.overDays.below_54 >= S.lows_min_days;
    if (!over70 && !over54) continue;
    let best = 0;
    let bestOverlap = -1;
    icrBlocks.forEach((b, i) => {
      const overlap = Math.max(0, Math.min(b.to, from + w) - Math.max(b.from, from));
      if (overlap > bestOverlap) { bestOverlap = overlap; best = i; }
    });
    const list = lowsByBlock.get(best) ?? [];
    list.push({ from, to: from + w, excess: Math.max(s.below_70 / S.goals.below_70, s.below_54 / S.goals.below_54) });
    lowsByBlock.set(best, list);
  }

  const places: Array<Place & { excess: number }> = [];
  const within: Array<{ from: string; to: string }> = [];
  icrBlocks.forEach((b, i) => {
    const s = stats(b.from, b.to);
    const lows = lowsByBlock.get(i) ?? [];
    const riseExcess = Math.max(s.above_180 / S.goals.above_180, s.above_250 / S.goals.above_250);
    const { changed_on: changed, waits_until: waits } = blockChange(data, b.from, b.to, todayIso);
    const { overDays: _, ...plain } = s;
    const base = { from: hhmm(b.from), to: hhmm(b.to), stats: plain, changed_on: changed, waits_until: waits };
    if (lows.length > 0) {
      places.push({ ...base, kind: 'LOWS', lows_window: { from: hhmm(Math.min(...lows.map((l) => l.from))), to: hhmm(Math.max(...lows.map((l) => l.to))) }, excess: Math.max(...lows.map((l) => l.excess)) });
    } else if (riseExcess > S.rise_margin) {
      places.push({ ...base, kind: 'RISES', lows_window: null, excess: riseExcess });
    } else {
      within.push({ from: base.from, to: base.to });
    }
  });
  places.sort((a, b) => (a.kind === b.kind ? b.excess - a.excess : a.kind === 'LOWS' ? -1 : 1));
  return { version: S.version, first_date: days[0] ?? firstDate, last_date: days[days.length - 1] ?? lastDate, places: places.map(({ excess: _, ...p }) => p), within_goals: within };
}

/** The last change of any setting inside a block (minutes of the day) and, within `recent_change_days`, until when it waits. */
export function blockChange(data: WhatIfData, from: number, to: number, todayIso: string): { changed_on: string | null; waits_until: string | null } {
  const clock = localClock(data.time_zone);
  const therapies = [...data.therapies].sort((a, b) => (a.from_ms ?? 0) - (b.from_ms ?? 0));
  for (let i = therapies.length - 1; i > 0; i -= 1) {
    const a = therapies[i - 1];
    const b = therapies[i];
    const same = (pick: (t: WhatIfTherapy) => Array<[string, number]> | null | undefined) => sameSchedule(pick(a), pick(b), from, to);
    if (!same((t) => t.carb_ratio_g_per_u) || !same((t) => t.sensitivity_per_u) || !same((t) => t.basal_u_per_h) || !same((t) => t.target_low_mgdl)) {
      const changed = b.from_ms === null ? null : clock(b.from_ms).date;
      const until = changed ? addDays(changed, S.recent_change_days) : null;
      return { changed_on: changed, waits_until: until && until > todayIso ? until : null };
    }
  }
  return { changed_on: null, waits_until: null };
}

/** The block of the current ICR schedule that ends where `from` starts (the evening before a night). */
export function icrBlockBefore(data: WhatIfData, from: string): { from: string; to: string } | null {
  const therapies = [...data.therapies].sort((a, b) => (a.from_ms ?? 0) - (b.from_ms ?? 0));
  const blocks = blocksOf(therapies[therapies.length - 1]?.carb_ratio_g_per_u ?? [['00:00', 0]]);
  if (blocks.length < 2) return null;
  const start = toMinutes(from);
  const before = blocks.find((b) => b.to % 1440 === start);
  return before ? { from: hhmm(before.from), to: hhmm(before.to) } : null;
}

/** The outcome window of a place: the place itself and `tail_hours` after it (night 0–6 → 0–10). */
export function placeWindow(place: { from: string; to: string }): ReplayWindow {
  const from = toMinutes(place.from);
  let to = toMinutes(place.to) || 1440;
  to = Math.min(to + S.tail_hours * 60, from + 1440 - 5);
  return { from: place.from, to: hhmm(to) };
}

export interface CheckedReplay {
  main: Extract<SettingsReplayResult, { status: 'OK' }>;
  /** Same change with half the insulin effect. */
  half_effect: { now: WindowOutcome; after: WindowOutcome } | null;
  /** Without the two days the change moved most. */
  without_two_days: { now: WindowOutcome; after: WindowOutcome };
}

/** One replay with the robustness checks the card and the search rely on. */
export function replayChecked(data: WhatIfData, change: SettingChange, window: ReplayWindow, options: { skipHalfUnless?: (main: Extract<SettingsReplayResult, { status: 'OK' }>) => boolean } = {}): CheckedReplay | Exclude<SettingsReplayResult, { status: 'OK' }> {
  const main = replaySettingChange(data, change, window);
  if (main.status !== 'OK') return main;
  const wantHalf = options.skipHalfUnless ? options.skipHalfUnless(main) : true;
  const half = wantHalf ? replaySettingChange(data, change, window, { insulin_effect_scale: S.robustness_insulin_scale }) : main;
  const moved = (r: DayRun) => {
    const below = (v: number[]) => v.filter((x) => x < 70).length;
    const above = (v: number[]) => v.filter((x) => x > 180).length;
    return Math.abs(below(r.sim) - below(r.obs)) * 1000 + Math.abs(above(r.sim) - above(r.obs));
  };
  const kept = [...main.runs].sort((a, b) => moved(b) - moved(a)).slice(S.robustness_drop_days);
  return {
    main,
    half_effect: wantHalf && half.status === 'OK' ? { now: half.now, after: half.after } : null,
    without_two_days: { now: windowOutcome(kept, 'obs'), after: windowOutcome(kept, 'sim') },
  };
}

/** Lows are a hard limit: neither minutes nor days below 70 or 54 may grow. */
export function lowsNotWorse(now: WindowOutcome, after: WindowOutcome): boolean {
  return after.minutes_below_54 <= now.minutes_below_54 && after.minutes_below_70 <= now.minutes_below_70
    && after.days_below_54 <= now.days_below_54 && after.days_below_70 <= now.days_below_70;
}

/** The cost limit: rises (minutes and days above 180 and above 250) may grow by at most half. */
export function risesCostLimited(now: WindowOutcome, after: WindowOutcome): boolean {
  const ok = (a: number, b: number, floor: number) => b <= a + Math.max(a * S.rise_cost_max_share, floor);
  return ok(now.minutes_above_180, after.minutes_above_180, S.rise_cost_floor_minutes)
    && ok(now.minutes_above_250, after.minutes_above_250, S.rise_cost_floor_minutes)
    && ok(now.days_above_180_over_1h, after.days_above_180_over_1h, S.rise_cost_floor_days)
    && ok(now.days_above_250, after.days_above_250, S.rise_cost_floor_days);
}

export interface Candidate extends SettingChange { now_value: number; more_insulin: boolean }

/** One-step candidates for a place from the current settings. */
export function candidatesFor(data: WhatIfData, place: Pick<Place, 'from' | 'to' | 'kind'>): Candidate[] {
  const clock = localClock(data.time_zone);
  const minuteOf = (ms: number) => { const c = clock(ms); return c.hour * 60 + c.minute; };
  const therapies = [...data.therapies].sort((a, b) => (a.from_ms ?? 0) - (b.from_ms ?? 0));
  const current = therapies[therapies.length - 1];
  const from = toMinutes(place.from);
  const to = toMinutes(place.to) || 1440;
  const out: Candidate[] = [];
  const push = (setting: ReplaySetting, a: number, b: number, now: number, value: number, moreInsulin: boolean) => {
    if (!(value > 0) || Math.abs(value - now) < 1e-9) return;
    out.push({ setting, from: hhmm(a), to: hhmm(b), value, now_value: now, more_insulin: moreInsulin });
  };
  const round = (v: number, step: number) => Number((Math.round(v / step) * step).toFixed(2));
  const icr = scheduleAt(current.carb_ratio_g_per_u, from);
  // An ICR step changes nothing in a block without meals (a night): not counted at all.
  const mealsInBlock = data.carbs.some((c) => c.kind === 'MEAL' && inBlock(minuteOf(c.ms), place.from, place.to));
  if (icr && mealsInBlock) {
    push('ICR', from, to, icr, round(icr * (1 + S.icr_step), 0.1), false);
    push('ICR', from, to, icr, round(icr * (1 - S.icr_step), 0.1), true);
  }
  for (const b of blocksOf(current.sensitivity_per_u ?? [])) {
    const a = Math.max(b.from, from);
    const z = Math.min(b.to, to);
    const isf = isfToMgdl(scheduleAt(current.sensitivity_per_u, b.from), current.units);
    if (z <= a || !isf) continue;
    push('ISF', a, z, isf, round(isf * (1 + S.isf_step), 5), false);
    push('ISF', a, z, isf, round(isf * (1 - S.isf_step), 5), true);
  }
  const target = scheduleAt(current.target_low_mgdl ?? null, from);
  if (target) {
    push('TARGET', from, to, target, target + S.target_step_mgdl, false);
    push('TARGET', from, to, target, target - S.target_step_mgdl, true);
  }
  for (const b of blocksOf(current.basal_u_per_h ?? [])) {
    const a = Math.max(b.from, from);
    const z = Math.min(b.to, to);
    if (z <= a) continue;
    const now = scheduleAt(current.basal_u_per_h, b.from) ?? 0;
    push('BASAL', a, z, now, round(now + S.basal_step_u_per_h, 0.05), true);
    push('BASAL', a, z, now, round(now - S.basal_step_u_per_h, 0.05), false);
  }
  return place.kind === 'LOWS' ? out.filter((c) => !c.more_insulin) : out;
}

export interface SearchedCandidate {
  change: Candidate;
  now: WindowOutcome;
  after: WindowOutcome;
  /** Reduction of the place's problem, minutes in the window (positive = better). */
  gain_minutes: number;
  passes: { lows: boolean; half_effect: boolean; without_two_days: boolean; rises_cost_limited: boolean };
  /** The candidate's block waits for the comparison of a recent change until this date (only with includeWaiting). */
  waits_until: string | null;
}

export type SearchResult =
  | { status: 'FOUND'; version: string; window: ReplayWindow; best: SearchedCandidate; checked: SearchedCandidate[]; not_counted: ReplaySetting[] }
  | { status: 'NONE'; version: string; window: ReplayWindow; checked: SearchedCandidate[]; not_counted: ReplaySetting[] }
  | { status: 'WAITS'; version: string; changed_on: string; waits_until: string }
  | { status: 'NO_DATA'; version: string; reason: string };

/**
 * The one-step change that smooths the place most without more lows, or an honest "none".
 * Lows at the very start of a block (night 0–3) are mostly the tail of the block before (owner check 2026-11-11: night
 * lows move with evening ISF, not with night settings): its less-insulin steps are tried too, counted over both blocks.
 * `includeWaiting`: blocks that wait for a recent change are searched as well and their candidates carry the date
 * (a preview to check after the comparison, never a change to make now).
 */
export function searchPlace(data: WhatIfData, place: Place, options: { includeWaiting?: boolean; todayIso?: string } = {}): SearchResult {
  if (place.waits_until && place.changed_on && !options.includeWaiting) return { status: 'WAITS', version: S.version, changed_on: place.changed_on, waits_until: place.waits_until };
  // Only a night: its lows at the start are the evening's tail (the evening's own lows are the evening's business).
  const before = place.kind === 'LOWS' && place.from === '00:00' && place.lows_window?.from === place.from ? icrBlockBefore(data, place.from) : null;
  // With the block before, the night part of the window must hold the limits on its own (a long window would dilute
  // a night cost), and the gain is counted there.
  const offset = before ? ((toMinutes(place.from) - toMinutes(before.from) + 1440) % 1440) / 5 : 0;
  const part = (runs: DayRun[]) => runs.map((r) => {
    const keep = (r.steps ?? r.obs.map((_, i) => i)).map((k, i) => (k >= offset ? i : -1)).filter((i) => i >= 0);
    return { ...r, obs: keep.map((i) => r.obs[i]), sim: keep.map((i) => r.sim[i]) };
  });
  const ownWindow = placeWindow(place);
  const window = before ? { from: before.from, to: ownWindow.to } : ownWindow;
  const candidates = [
    ...candidatesFor(data, place),
    ...(before ? candidatesFor(data, { ...before, kind: 'LOWS' }) : []),
  ];
  const waitsFor = (c: Candidate) => (options.todayIso ? blockChange(data, toMinutes(c.from), toMinutes(c.to) || 1440, options.todayIso).waits_until : null);
  const checked: SearchedCandidate[] = [];
  const notCounted = new Set<ReplaySetting>();
  let ownProblem = 0;
  for (const c of candidates) {
    // The half-effect replay only for a candidate that already passes on the full effect (it cannot win otherwise).
    const r = replayChecked(data, c, window, { skipHalfUnless: (m) => lowsNotWorse(m.now, m.after) && risesCostLimited(m.now, m.after) });
    if (!('main' in r)) {
      if (r.status === 'NO_TRIO_CYCLES' || r.status === 'NO_SETTINGS' || r.status === 'TOO_FEW_DAYS') return { status: 'NO_DATA', version: S.version, reason: r.status };
      notCounted.add(c.setting);
      continue;
    }
    if (r.main.runs.every((run) => run.sim.every((v, i) => v === run.obs[i]))) continue; // nothing to change here (an ICR with no meals)
    const metric = (o: WindowOutcome) => (place.kind === 'LOWS' ? o.minutes_below_70 : o.minutes_above_180);
    const own = before ? { now: windowOutcome(part(r.main.runs), 'obs'), after: windowOutcome(part(r.main.runs), 'sim') } : { now: r.main.now, after: r.main.after };
    ownProblem = metric(own.now);
    checked.push({
      change: c,
      now: r.main.now,
      after: r.main.after,
      gain_minutes: metric(own.now) - metric(own.after),
      passes: {
        lows: lowsNotWorse(r.main.now, r.main.after) && lowsNotWorse(own.now, own.after),
        half_effect: r.half_effect ? lowsNotWorse(r.half_effect.now, r.half_effect.after) : false,
        without_two_days: lowsNotWorse(r.without_two_days.now, r.without_two_days.after),
        rises_cost_limited: risesCostLimited(r.main.now, r.main.after) && risesCostLimited(own.now, own.after),
      },
      waits_until: waitsFor(c),
    });
  }
  const problemNow = ownProblem;
  const ok = checked
    .filter((x) => x.passes.lows && x.passes.half_effect && x.passes.without_two_days && x.passes.rises_cost_limited && x.gain_minutes >= S.min_gain_share * problemNow && x.gain_minutes > 0)
    .sort((a, b) => b.gain_minutes - a.gain_minutes);
  const not_counted = [...notCounted];
  return ok.length > 0
    ? { status: 'FOUND', version: S.version, window, best: ok[0], checked, not_counted }
    : { status: 'NONE', version: S.version, window, checked, not_counted };
}
