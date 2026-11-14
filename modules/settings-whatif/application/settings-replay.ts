import { carbsAbsorbed, insulinCurveDiaMinutes, insulinOnBoard } from '@modules/glucose-forecast/application/bolus-forecast';
import { isfToMgdl } from '@modules/glucose-forecast/application/isf-units';
import type { WhatIfData } from './icr-whatif';
import {
  TRIO_REPLICA_POLICY,
  decide,
  lastBefore,
  loggedDecisionInput,
  maxBasalFromCycles,
  pumpSteps,
  readTrioCycle,
  smbCapFor,
  type DecisionInput,
  type TrioCycle,
} from './trio-replica';

/**
 * Settings replay (settings-replay.v1): what a changed basal, target, ISF or ICR would have done over the last weeks,
 * by perturbing Trio's own logged decisions. One engine for the chat card and "Pod lupą".
 *
 * Per day, in the chosen window, every Trio cycle is decided twice with the replica rules (trio-replica.ts): once from
 * the logged state (decision 0) and once from the changed state (decision 1). Only decision 1 − decision 0 is added to
 * what was really delivered, so "no change" reproduces reality exactly.
 *
 * Changed state at a cycle:
 * - glucose: Δbg(t) = −Σ extra insulin × ISF × used(t − at) (oref curve, the profile DIA and peak; ISF = Trio's
 *   effective ISF at the dose, the one from before any ISF change: a changed ISF changes the loop, not the body);
 *   `insulin_effect_scale` scales this for the robustness check (the effect per unit is not confirmed yet);
 * - Trio's net IOB counts insulin above the scheduled basal: Δnet = extra delivered − schedule change;
 * - Trio's forecast curves shift by Δbg now + the BGI of Δnet over the horizon + the deviation change projected the way
 *   oref does for the IOB curve (linear fade over 60 min);
 * - minGuardBG, minPredBG, eventualBG and the IOB curve minimum follow the shifted curves; insulinReq =
 *   (min(minPredBG, eventualBG) − target) / ISF moves with them, with the changed target and ISF;
 * - basal change: SMB cap and max temp follow the new schedule (cap = basal × 45 min in 0.1 U steps);
 * - ISF change: the loop's ISF × new/old profile ISF (Trio's dynamic ISF is clamped at its limit, so a profile change
 *   passes through 1 : 1); the insulin part of Trio's forecast scales the same way;
 * - target change: the loop's target moves by new − profile target; the low guard threshold is a separate setting;
 * - ICR change: the carb part of each meal bolus in the block scales by old/new ICR (as icr-whatif.v1); Trio's forecast
 *   sees less insulin but also fewer carbs per gram (its carb impact uses the ICR), so only the difference between the
 *   insulin curve and the carb absorption reaches it;
 * - rescue carbs (HYPO_TREATMENT, or up to 30 g eaten below 80 with no bolus around them — a meal eaten low is not a
 *   rescue) are taken off when the changed glucose there is ≥ 90. Their effect is the rise really seen in the hour after
 *   them, at most g × ISF / ICR. A new low is never treated: the replay shows it untreated, held at the CGM floor (39).
 * Not modelled: autosens/TDD drift from the extra insulin, a different temp duration, pump gaps, manual correction
 * boluses computed with a changed ISF.
 */
export const SETTINGS_REPLAY_POLICY = {
  version: 'settings-replay.v1',
  step_seconds: 300,
  reading_tolerance_seconds: 450,
  min_coverage: 0.75,
  /** Cycles further apart than this count as a pump or phone gap. */
  max_cycle_gap_seconds: 1800,
  /** Fade of the deviation change in the forecast, steps (oref's IOB curve: 60 min). */
  deviation_fade_steps: 12,
  rescue_below_mgdl: 80,
  rescue_not_needed_mgdl: 90,
  rescue_absorption_seconds: 3600,
  rescue_max_grams: 30,
  /** A bolus this close to carbs eaten low makes them a meal, not a rescue. */
  rescue_bolus_seconds: 1800,
  rescue_bolus_min_u: 0.3,
  cgm_floor_mgdl: 39,
  meal_min_grams: 5,
  meal_merge_seconds: 1200,
  bolus_window_seconds: 1800,
  /** Fewer usable days than this → no result. */
  min_days: 10,
  /** A real SMB this close to a status belongs to it. */
  smb_match_seconds: 60,
  high_minutes_per_day: 60,
} as const;

const P = SETTINGS_REPLAY_POLICY;
const STEP = P.step_seconds * 1000;

export type ReplaySetting = 'BASAL' | 'TARGET' | 'ISF' | 'ICR';

/** One setting in one time block ("HH:MM", end exclusive; end ≤ start wraps past midnight), new absolute value. */
export interface SettingChange {
  setting: ReplaySetting;
  from: string;
  to: string;
  /**
   * New value for the current schedule: BASAL U/h, TARGET mg/dL, ISF mg/dL per U (profile ISF), ICR g/U. BASAL and
   * TARGET are absolute on every day. ICR and ISF act as a ratio to the current value (new / now), applied to the value
   * in force on each day, so days before an earlier change keep their own starting point.
   */
  value: number;
}

/** The daily window the outcome is counted in ("HH:MM"; to ≤ from ends the next day). The replay runs over it. */
export interface ReplayWindow { from: string; to: string }

export interface ReplayOptions {
  /** Scale of the glucose effect of the extra insulin (robustness: 0.5). */
  insulin_effect_scale?: number;
  /**
   * Doses changed by a rule instead of a setting (e.g. a smaller follow-up bolus): du per bolus, U (negative: less).
   * The carbs stay, so Trio's forecast sees the whole change (unlike an ICR change, where its carb forecast moves too).
   */
  dose_changes?: Array<{ at: number; du: number }>;
}

export interface DayRun {
  /** Local date the window starts on. */
  date: string;
  obs: number[];
  sim: number[];
  /** 5-min step of each value from the window start (values exist only where there was a reading). */
  steps?: number[];
  extra_u: number;
  smb_count_change: number;
  rescues_removed: number;
}

export interface WindowOutcome {
  days: number;
  /** Shares of all 5-min values, 0–1. */
  below_54: number;
  below_70: number;
  above_180: number;
  above_250: number;
  mean_mgdl: number;
  days_below_70: number;
  days_below_54: number;
  /** Days with at least an hour above 180 in the window. */
  days_above_180_over_1h: number;
  days_above_250: number;
  minutes_below_54: number;
  minutes_below_70: number;
  minutes_above_180: number;
  minutes_above_250: number;
  /** Lowest value in the window over all days. */
  lowest_mgdl: number;
  lowest_date: string;
}

export type SkipReason = 'CLOCK_CHANGE' | 'LOW_COVERAGE';

export type SettingsReplayResult =
  | {
      status: 'OK';
      version: string;
      /** The first change (one-change callers); `changes` holds them all (none: only dose_changes). */
      change?: SettingChange;
      changes: SettingChange[];
      window: ReplayWindow;
      insulin_effect_scale: number;
      runs: DayRun[];
      skipped: Array<{ date: string; reason: SkipReason }>;
      now: WindowOutcome;
      after: WindowOutcome;
      /** Median extra insulin per day, U. */
      extra_u_median: number;
      /** ICR only: meals in the block and the mean change of their dose, U (negative: less). */
      meals: number;
      meal_dose_change_u: number | null;
    }
  | { status: 'NO_TRIO_CYCLES'; version: string }
  | { status: 'NO_SETTINGS'; version: string }
  | { status: 'TOO_FEW_DAYS'; version: string; days: number }
  /** Two changes of one setting over the same hours. */
  | { status: 'CONFLICTING_CHANGES'; version: string };

type Schedule = Array<[string, number]>;

export const toMinutes = (time: string) => {
  const [hour, minute] = time.split(':').map(Number);
  return (hour || 0) * 60 + (minute || 0);
};

export function scheduleAt(schedule: Schedule | null | undefined, minutesOfDay: number): number | null {
  if (!schedule || schedule.length === 0) return null;
  const sorted = [...schedule].sort((a, b) => toMinutes(a[0]) - toMinutes(b[0]));
  let value = sorted[sorted.length - 1][1];
  for (const [time, v] of sorted) if (toMinutes(time) <= minutesOfDay) value = v;
  return value;
}

export function inBlock(minutesOfDay: number, from: string, to: string): boolean {
  const a = toMinutes(from);
  const b = toMinutes(to);
  return a < b ? minutesOfDay >= a && minutesOfDay < b : minutesOfDay >= a || minutesOfDay < b;
}

/** Local clock reader with a per-minute cache. */
export function localClock(timeZone: string) {
  const format = new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const cache = new Map<number, { date: string; hour: number; minute: number }>();
  return (ms: number) => {
    const key = Math.floor(ms / 60000);
    let hit = cache.get(key);
    if (!hit) {
      const parts = Object.fromEntries(format.formatToParts(new Date(key * 60000)).map((part) => [part.type, part.value]));
      hit = { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour), minute: Number(parts.minute) };
      cache.set(key, hit);
    }
    return hit;
  };
}

/** Epoch ms of local `minutes` after midnight of `date` (YYYY-MM-DD) in the zone; minutes may exceed a day. */
export function localMs(date: string, minutes: number, clock: ReturnType<typeof localClock>): number {
  const [y, m, d] = date.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d, 0, minutes);
  let ms = guess;
  for (let i = 0; i < 2; i += 1) {
    const local = clock(ms);
    const [ly, lm, ld] = local.date.split('-').map(Number);
    ms += guess - Date.UTC(ly, lm - 1, ld, local.hour, local.minute);
  }
  return ms;
}

function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
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

/** Parsing the logged cycles (reason text regexes) is the same for every replay of one data set: done once. */
const PARSED = new WeakMap<object, TrioCycle[]>();
function parsedCycles(data: WhatIfData): TrioCycle[] {
  const records = data.trio_cycles ?? [];
  let hit = PARSED.get(records);
  if (!hit) {
    hit = records.map(readTrioCycle).filter((c): c is TrioCycle => c !== null).sort((a, b) => a.ms - b.ms);
    PARSED.set(records, hit);
  }
  return hit;
}

interface Extra { at: number; u: number; sens: number; mealGrams?: number }
interface NetDose { at: number; u: number; mealGrams?: number }

export function replaySettingChange(data: WhatIfData, change: SettingChange, window: ReplayWindow, options: ReplayOptions = {}): SettingsReplayResult {
  return replaySettingChanges(data, [change], window, options);
}

/**
 * Several changes at once (any settings, any blocks; one setting may change in several blocks that do not overlap), or
 * none with `dose_changes` only (a dosing rule). Each change acts in its own block, as in a one-change replay.
 */
export function replaySettingChanges(data: WhatIfData, changes: SettingChange[], window: ReplayWindow, options: ReplayOptions = {}): SettingsReplayResult {
  const version = P.version;
  for (let i = 0; i < changes.length; i += 1) {
    for (let j = i + 1; j < changes.length; j += 1) {
      const a = changes[i]; const b = changes[j];
      if (a.setting !== b.setting) continue;
      for (let m = 0; m < 1440; m += 5) if (inBlock(m, a.from, a.to) && inBlock(m, b.from, b.to)) return { status: 'CONFLICTING_CHANGES', version };
    }
  }
  const scale = options.insulin_effect_scale ?? 1;
  const therapies = [...data.therapies].sort((a, b) => (a.from_ms ?? 0) - (b.from_ms ?? 0));
  if (therapies.length === 0 || !therapies[therapies.length - 1].basal_u_per_h) return { status: 'NO_SETTINGS', version };
  const cycles = parsedCycles(data);
  if (cycles.length === 0) return { status: 'NO_TRIO_CYCLES', version };

  const clock = localClock(data.time_zone);
  const minuteOfDay = (ms: number) => { const c = clock(ms); return c.hour * 60 + c.minute; };
  const therapyAt = (ms: number) => {
    let found = therapies[0];
    for (const t of therapies) if ((t.from_ms ?? 0) <= ms) found = t;
    return found;
  };
  const sched = (ms: number) => scheduleAt(therapyAt(ms).basal_u_per_h, minuteOfDay(ms)) ?? 0;
  const covering = (setting: ReplaySetting, ms: number) => {
    const m = minuteOfDay(ms);
    return changes.find((c) => c.setting === setting && inBlock(m, c.from, c.to)) ?? null;
  };
  const schedNew = (ms: number) => covering('BASAL', ms)?.value ?? sched(ms);
  const current = therapies[therapies.length - 1];
  // ICR and ISF: the ratio new / current value at the start of the block, applied to the value in force at each time.
  const isfRatioOf = new Map(changes.filter((c) => c.setting === 'ISF').map((c) => {
    const now = isfToMgdl(scheduleAt(current.sensitivity_per_u, toMinutes(c.from)), current.units);
    return [c, now && now > 0 ? c.value / now : 1] as const;
  }));
  const isfFactor = (ms: number) => { const c = covering('ISF', ms); return c ? isfRatioOf.get(c) ?? 1 : 1; };
  const targetShift = (ms: number, loggedTarget: number) => {
    const c = covering('TARGET', ms);
    if (!c) return 0;
    const t = therapyAt(ms);
    const profile = scheduleAt(t.target_low_mgdl ?? null, minuteOfDay(ms));
    return c.value - (profile ?? loggedTarget);
  };
  const icrAt = (ms: number) => scheduleAt(therapyAt(ms).carb_ratio_g_per_u, minuteOfDay(ms));

  const diaMinutes = insulinCurveDiaMinutes(data.dia_hours);
  // The oref curve is read millions of times per replay: a table every 0.25 min with linear steps between.
  const usedTable = Float64Array.from({ length: Math.ceil(diaMinutes * 4) + 2 }, (_, i) => 1 - insulinOnBoard(i / 4, diaMinutes, data.peak_minutes));
  const used = (minutes: number) => {
    if (minutes <= 0) return 0;
    if (minutes >= diaMinutes) return 1;
    const x = minutes * 4;
    const i = Math.floor(x);
    return usedTable[i] + (usedTable[i + 1] - usedTable[i]) * (x - i);
  };
  const diaMs = diaMinutes * 60000;

  const readings = [...data.readings].filter(([, v]) => Number.isFinite(v) && v > 0).sort((a, b) => a[0] - b[0]);
  const readingMs = readings.map(([ms]) => ms);
  const tolerance = P.reading_tolerance_seconds * 1000;
  const bgAt = (ms: number): number | null => {
    const i = lowerBound(readingMs, ms);
    let best: [number, number] | null = null;
    for (const j of [i - 1, i]) {
      if (j >= 0 && j < readings.length && Math.abs(readings[j][0] - ms) <= tolerance && (!best || Math.abs(readings[j][0] - ms) < Math.abs(best[0] - ms))) best = readings[j];
    }
    return best ? best[1] : null;
  };

  const bolusTimes = [...data.smbs, ...data.boluses].filter(([, u]) => u > 0).map(([ms]) => ms).sort((a, b) => a - b);
  const rescues: Array<[number, number]> = [];
  const bolusNear = (ms: number) => data.boluses.some(([at, u]) => u >= P.rescue_bolus_min_u && Math.abs(at - ms) <= P.rescue_bolus_seconds * 1000);
  for (const c of data.carbs) {
    if (!(c.g > 0)) continue;
    const bg = bgAt(c.ms);
    const eatenLow = (c.kind === null || c.kind === 'CORRECTION_CARBS') && bg !== null && bg < P.rescue_below_mgdl && c.g <= P.rescue_max_grams && !bolusNear(c.ms);
    if (c.kind === 'HYPO_TREATMENT' || eatenLow) rescues.push([c.ms, c.g]);
  }
  /** The rise really seen in the hour after a rescue, mg/dL (≥ 0). */
  const riseAfter = (ms: number) => {
    const start = bgAt(ms);
    if (start === null) return 0;
    let peak = start;
    for (let i = lowerBound(readingMs, ms + 1); i < readings.length && readings[i][0] <= ms + P.rescue_absorption_seconds * 1000; i += 1) peak = Math.max(peak, readings[i][1]);
    return peak - start;
  };
  rescues.sort((a, b) => a[0] - b[0]);
  const rescueMs = rescues.map(([ms]) => ms);
  const maxBasal = maxBasalFromCycles(cycles);
  const cycleMs = cycles.map((c) => c.ms);

  // ICR: meal dose changes in the block (as icr-whatif.v1: only the carb part of the bolus follows the ICR).
  const mealDoses: Array<{ at: number; du: number; grams: number }> = [];
  if (changes.some((c) => c.setting === 'ICR')) {
    const meals: Array<{ ms: number; lastMs: number; g: number }> = [];
    for (const c of [...data.carbs].sort((a, b) => a.ms - b.ms)) {
      if (!(c.g > 0) || rescues.some(([ms]) => ms === c.ms)) continue;
      if ((c.kind !== null && c.kind !== 'MEAL') || c.g < P.meal_min_grams) continue;
      const last = meals[meals.length - 1];
      if (last && c.ms - last.lastMs <= P.meal_merge_seconds * 1000) { last.g += c.g; last.lastMs = c.ms; continue; }
      meals.push({ ms: c.ms, lastMs: c.ms, g: c.g });
    }
    for (const m of meals) {
      const c = covering('ICR', m.ms);
      if (!c || (bgAt(m.ms) ?? 0) < P.rescue_below_mgdl) continue;
      const icr = icrAt(m.ms);
      const icrNow = scheduleAt(current.carb_ratio_g_per_u, toMinutes(c.from));
      if (!icr || icr <= 0 || !icrNow || !(c.value > 0)) continue;
      const ratio = c.value / icrNow;
      const bolus = data.boluses.reduce((sum, [ms, u]) => (u > 0 && Math.abs(ms - m.ms) <= P.bolus_window_seconds * 1000 ? sum + u : sum), 0);
      const carbU = Math.min(bolus, m.g / icr);
      const du = -carbU * (1 - 1 / ratio);
      if (Math.abs(du) > 1e-9) mealDoses.push({ at: m.ms, du, grams: m.g });
    }
  }

  // ISF: Trio's own net insulin (boluses, SMBs, temps above the schedule), for the insulin part of its forecast.
  const trioNet: Array<[number, number]> = [];
  if (changes.some((c) => c.setting === 'ISF')) {
    for (const [ms, u] of [...data.boluses, ...data.smbs]) if (u > 0) trioNet.push([ms, u]);
    const temps = [...data.temps].sort((a, b) => a[0] - b[0]);
    const tempMs = temps.map(([ms]) => ms);
    const start = Math.max(cycles[0].ms - diaMs, readings[0]?.[0] ?? cycles[0].ms);
    const end = cycles[cycles.length - 1].ms;
    for (let t = Math.floor(start / STEP) * STEP; t < end; t += STEP) {
      const i = lowerBound(tempMs, t + 1) - 1;
      let rate = sched(t);
      if (i >= 0) { const [s0, r0, d0] = temps[i]; if (Number.isFinite(r0) && d0 > 0 && t < s0 + d0 * 60000) rate = r0; }
      const net = ((rate - sched(t)) * P.step_seconds) / 3600;
      if (Math.abs(net) > 1e-9) trioNet.push([t, net]);
    }
    trioNet.sort((a, b) => a[0] - b[0]);
  }
  const trioNetMs = trioNet.map(([ms]) => ms);

  const wFrom = toMinutes(window.from);
  let wTo = toMinutes(window.to);
  if (wTo <= wFrom) wTo += 1440;

  const runs: DayRun[] = [];
  const skipped: Array<{ date: string; reason: SkipReason }> = [];

  const runDay = (date: string): DayRun | SkipReason => {
    const t0 = localMs(date, wFrom, clock);
    const t1 = localMs(date, wTo, clock);
    if (t1 - t0 !== (wTo - wFrom) * 60000) return 'CLOCK_CHANGE';
    const lo = lowerBound(cycleMs, t0);
    const hi = lowerBound(cycleMs, t1);
    const dayCycles = cycles.slice(lo, hi);
    const steps = Math.floor((t1 - t0) / STEP);
    if (dayCycles.length < P.min_coverage * steps) return 'LOW_COVERAGE';
    const obsSteps = Array.from({ length: steps + 1 }, (_, k) => bgAt(t0 + k * STEP));
    if (obsSteps.filter((v) => v !== null).length < P.min_coverage * obsSteps.length) return 'LOW_COVERAGE';

    const extra: Extra[] = [];
    const schedDiff: Array<[number, number]> = [];
    const removed: Array<{ at: number; rise: number }> = [];
    const addedSmb: number[] = [];
    const removedSmb: number[] = [];
    const mealsLeft = [...mealDoses, ...(options.dose_changes ?? []).map((x) => ({ at: x.at, du: x.du, grams: 0 }))]
      .sort((a, b) => a.at - b.at)
      .filter((m) => m.at >= t0 - 6 * 3600000 && m.at < t1);
    let smbChange = 0;

    const dbg = (t: number) => {
      let e = 0;
      for (const x of extra) if (x.at <= t) e -= x.u * x.sens * used((t - x.at) / 60000);
      e *= scale;
      for (const r of removed) if (r.at <= t) e -= r.rise * Math.min(1, (t - r.at) / (P.rescue_absorption_seconds * 1000));
      return e;
    };

    for (let idx = 0; idx < dayCycles.length; idx += 1) {
      const c = dayCycles[idx];
      const t = c.ms;
      const next = idx + 1 < dayCycles.length ? dayCycles[idx + 1].ms : t + STEP;
      const dt = Math.max(0, Math.min(next - t, P.max_cycle_gap_seconds * 1000));
      const sens = c.sens;
      // ICR meal changes reach the body at the meal.
      while (mealsLeft.length > 0 && mealsLeft[0].at <= t) {
        const m = mealsLeft.shift()!;
        extra.push({ at: m.at, u: m.du, sens, mealGrams: m.grams });
      }
      const ds = ((schedNew(t) - sched(t)) * dt) / 3600000;
      if (Math.abs(ds) > 1e-12) schedDiff.push([t, ds]);

      const last0 = lastBefore(bolusTimes, t - TRIO_REPLICA_POLICY.own_cycle_bolus_seconds * 1000);
      const base = loggedDecisionInput(c, sched(t), last0, maxBasal);
      const d0 = decide(base);

      // Changed state.
      const k = isfFactor(t);
      const sens1 = sens * k;
      const dNow = dbg(t);
      const schedNet: NetDose[] = schedDiff.map(([at, u]) => ({ at, u: -u }));
      const net: NetDose[] = [...extra, ...schedNet];
      let dIob = 0;
      for (const n of net) if (n.at <= t) dIob += n.u * (1 - used((t - n.at) / 60000));
      const bgiOf = (list: NetDose[], h: number, isf: number) => {
        let s = 0;
        for (const n of list) {
          if (n.at > t) continue;
          s -= n.u * (used((t + h - n.at) / 60000) - used((t - n.at) / 60000)) * isf;
          if (n.mealGrams) s += n.u * (carbsAbsorbed((t + h - n.at) / 60000) - carbsAbsorbed((t - n.at) / 60000)) * isf;
        }
        return s;
      };
      const bgiSched = bgiOf(schedNet, STEP, sens1);
      const trioInsulinPart = (h: number) => {
        if (k === 1) return 0;
        let s = 0;
        for (let i = lowerBound(trioNetMs, t - diaMs); i < trioNet.length && trioNet[i][0] <= t; i += 1) {
          const [at, u] = trioNet[i];
          s -= u * (used((t + h - at) / 60000) - used((t - at) / 60000));
        }
        return s * sens;
      };
      const curveLen = Math.max(0, ...Object.values(c.predictions).map((v) => v?.length ?? 0));
      const delta = (i: number) => {
        const h = i * STEP;
        let fade = 0;
        for (let j = 1; j <= Math.min(i, P.deviation_fade_steps); j += 1) fade += Math.max(0, 1 - j / P.deviation_fade_steps);
        return dNow + bgiOf(net, h, sens1) + bgiSched * fade + (k - 1) * trioInsulinPart(h);
      };
      const shifts = curveLen > 0 ? Array.from({ length: curveLen }, (_, i) => delta(i)) : [dNow];
      const lastShift = shifts[shifts.length - 1];
      const shiftedMinDelta = (curve: number[]) => {
        let shifted = Infinity;
        let orig = Infinity;
        for (let i = 1; i < curve.length; i += 1) {
          shifted = Math.min(shifted, curve[i] + shifts[Math.min(i, shifts.length - 1)]);
          orig = Math.min(orig, curve[i]);
        }
        return shifted - orig;
      };
      let guardSource: number[] | null = null;
      for (const name of ['UAM', 'IOB', 'COB', 'ZT'] as const) {
        const curve = c.predictions[name];
        if (curve && curve.length > 1 && Math.abs(Math.min(...curve.slice(1)) - c.minGuardBG) <= 1) { guardSource = curve; break; }
      }
      const newGuard = guardSource ? c.minGuardBG + shiftedMinDelta(guardSource) : c.minGuardBG + Math.min(...shifts);
      const newMinPred = c.minPredBG + lastShift;
      const newEv = c.eventualBG === null ? null : c.eventualBG + lastShift;
      const iobCurve = c.predictions.IOB;
      const newMinIob = iobCurve && iobCurve.length > 1 ? c.minIobPredBG + shiftedMinDelta(iobCurve) : c.minIobPredBG + dNow;
      const newBg = c.bg + dNow;
      const newIob = c.iob + dIob;
      const target1 = c.target + targetShift(t, c.target);
      const oldM = c.eventualBG !== null ? Math.min(c.minPredBG, c.eventualBG) : c.minPredBG;
      const newM = newEv !== null ? Math.min(newMinPred, newEv) : newMinPred;
      let newIreq = sens && sens1 ? c.insulinReq + (newM - target1) / sens1 - (oldM - c.target) / sens : c.insulinReq;
      if (c.reason.maxIob !== null) newIreq = Math.min(newIreq, c.reason.maxIob - newIob);

      // SMB interval: real boluses unless the replay took that SMB away, plus the replay's own SMBs.
      const lastIdx = lowerBound(bolusTimes, t - TRIO_REPLICA_POLICY.own_cycle_bolus_seconds * 1000) - 1;
      const reals = bolusTimes.slice(Math.max(0, lastIdx - 6), lastIdx + 1).filter((x) => !removedSmb.some((y) => Math.abs(x - y) < P.smb_match_seconds * 1000));
      const candidates = [...reals.slice(-1), ...addedSmb].filter((x) => x < t - TRIO_REPLICA_POLICY.own_cycle_bolus_seconds * 1000);
      const waiting1 = candidates.length > 0 && t - Math.max(...candidates) < TRIO_REPLICA_POLICY.smb_interval_seconds * 1000;
      const basalChanged = Math.abs(schedNew(t) - sched(t)) > 1e-9;
      const dSlope = dNow - dbg(t - STEP);
      const bgiNetNow = bgiOf(net, STEP, sens1);
      const ratio = c.reason.basalRatio ?? 1;
      const pert: DecisionInput = {
        ...base,
        bg: newBg,
        target: target1,
        sens: sens1,
        eventualBG: newEv,
        minDelta: base.minDelta + dSlope,
        expectedDelta: base.expectedDelta + bgiNetNow,
        insulinReq: newIreq,
        minGuardBG: newGuard,
        minIobPredBG: newMinIob,
        naiveEventualBG: Math.round(newBg - newIob * sens1),
        basal: schedNew(t) * ratio,
        waiting: waiting1,
      };
      if (basalChanged) { pert.maxBolus = smbCapFor(schedNew(t)); pert.maxSafeBasal = Math.min(TRIO_REPLICA_POLICY.max_temp_multiplier * schedNew(t), maxBasal); }
      const d1 = decide(pert);

      let newRate = Math.max(0, c.realRate + (d1.rate - d0.rate));
      if (basalChanged || d1.rate !== d0.rate) newRate = Math.min(newRate, pert.maxSafeBasal);
      let newSmb = Math.max(0, c.realSmb + (d1.smb - d0.smb));
      if (basalChanged) newSmb = Math.min(newSmb, pumpSteps(pert.maxBolus));
      const du = ((newRate - c.realRate) * dt) / 3600000 + (newSmb - c.realSmb);
      if (newSmb > 0 && c.realSmb === 0) addedSmb.push(t);
      if (newSmb === 0 && c.realSmb > 0) removedSmb.push(t);
      smbChange += Number(newSmb > 0) - Number(c.realSmb > 0);
      if (Math.abs(du) > 1e-9) extra.push({ at: t, u: du, sens });

      // Rescue carbs no longer needed.
      for (let i = lowerBound(rescueMs, t); i < rescues.length && rescues[i][0] < next; i += 1) {
        const [at, g] = rescues[i];
        const o = bgAt(at);
        if (o !== null && o < P.rescue_not_needed_mgdl && o + dbg(at) >= P.rescue_not_needed_mgdl) {
          const icr = icrAt(at);
          removed.push({ at, rise: Math.min(riseAfter(at), icr ? (g * sens) / icr : 0) });
        }
      }
    }

    const obs: number[] = [];
    const sim: number[] = [];
    const stepIndex: number[] = [];
    obsSteps.forEach((v, k) => {
      if (v === null) return;
      obs.push(v);
      stepIndex.push(k);
      sim.push(Math.max(P.cgm_floor_mgdl, v + dbg(t0 + k * STEP)));
    });
    return { date, obs, sim, steps: stepIndex, extra_u: extra.reduce((s, x) => s + x.u, 0), smb_count_change: smbChange, rescues_removed: removed.length };
  };

  const firstDate = addDays(clock(cycles[0].ms).date, 1);
  const lastDate = clock(cycles[cycles.length - 1].ms).date;
  for (let date = firstDate; date <= lastDate; date = addDays(date, 1)) {
    const out = runDay(date);
    if (typeof out === 'string') skipped.push({ date, reason: out });
    else runs.push(out);
  }
  if (runs.length < P.min_days) return { status: 'TOO_FEW_DAYS', version, days: runs.length };
  const extras = runs.map((r) => r.extra_u).sort((a, b) => a - b);
  return {
    status: 'OK',
    version,
    ...(changes[0] ? { change: changes[0] } : {}),
    changes,
    window,
    insulin_effect_scale: scale,
    runs,
    skipped,
    now: windowOutcome(runs, 'obs'),
    after: windowOutcome(runs, 'sim'),
    extra_u_median: extras[Math.floor(extras.length / 2)],
    meals: mealDoses.length,
    meal_dose_change_u: mealDoses.length > 0 ? mealDoses.reduce((sum, m) => sum + m.du, 0) / mealDoses.length : null,
  };
}

export function windowOutcome(runs: DayRun[], key: 'obs' | 'sim'): WindowOutcome {
  const minutes = P.step_seconds / 60;
  let n = 0;
  let sum = 0;
  const count = { b54: 0, b70: 0, a180: 0, a250: 0 };
  let daysB70 = 0;
  let daysB54 = 0;
  let daysHigh = 0;
  let days250 = 0;
  let lowest = Infinity;
  let lowestDate = '';
  for (const run of runs) {
    const values = run[key];
    let b70 = 0;
    let b54 = 0;
    let a180 = 0;
    let a250 = 0;
    for (const v of values) {
      n += 1;
      sum += v;
      if (v < 54) b54 += 1;
      if (v < 70) b70 += 1;
      if (v > 180) a180 += 1;
      if (v > 250) a250 += 1;
      if (v < lowest) { lowest = v; lowestDate = run.date; }
    }
    count.b54 += b54; count.b70 += b70; count.a180 += a180; count.a250 += a250;
    if (b70 > 0) daysB70 += 1;
    if (b54 > 0) daysB54 += 1;
    if (a180 * minutes >= P.high_minutes_per_day) daysHigh += 1;
    if (a250 > 0) days250 += 1;
  }
  const share = (x: number) => (n ? x / n : 0);
  return {
    days: runs.length,
    below_54: share(count.b54),
    below_70: share(count.b70),
    above_180: share(count.a180),
    above_250: share(count.a250),
    mean_mgdl: n ? sum / n : 0,
    days_below_70: daysB70,
    days_below_54: daysB54,
    days_above_180_over_1h: daysHigh,
    days_above_250: days250,
    minutes_below_54: count.b54 * minutes,
    minutes_below_70: count.b70 * minutes,
    minutes_above_180: count.a180 * minutes,
    minutes_above_250: count.a250 * minutes,
    lowest_mgdl: lowest === Infinity ? 0 : lowest,
    lowest_date: lowestDate,
  };
}
