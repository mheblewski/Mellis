import { insulinOnBoard, insulinCurveDiaMinutes } from '@modules/glucose-forecast/application/bolus-forecast';
import { isfToMgdl } from '@modules/glucose-forecast/application/isf-units';

/**
 * "Przeliczenie zmiany" (icr-whatif.v1): what a named ICR change would have done to the last weeks' meals, replayed on
 * the patient's own data. Deterministic, no AI. The model only writes the text under the card.
 *
 * Method, per meal, in 5-minute steps over 5 h:
 * 1. Only the carb part of the meal bolus follows the ICR: carb_u = min(bolus, g / ICR); the change is
 *    du = −carb_u × (1 − 1/ratio), ratio = new ICR / old ICR.
 * 2. Its glucose effect is du × ISF spread over oref's exponential insulin curve (the patient's DIA and peak).
 * 3. Rescue carbs eaten during a low that the shifted glucose no longer reaches (≥ 90 at that time) are taken off:
 *    g × ISF / ICR, absorbed linearly over 60 min.
 * 4. The loop is modelled as the difference from what it really did, using its response MEASURED on this patient's
 *    meals (mean SMB + temp basal above the schedule per 5 min, by glucose 30 min ahead). It does not see the meal change
 *    itself: with the new ICR its carb forecast drops by the same amount as the bolus. It may add at most this hour's
 *    largest real SMB minus what it gave, and take away at most what it gave at that step.
 *    Validated 2026-11-08: a textbook oref controller was 10–20× more aggressive than one child's real Trio after meals.
 * 5. Outcomes 0–5 h after each meal, observed vs shifted. The size of the effect is an estimate ("as the loop counts,
 *    with the ISF from the settings"); it has not been checked against a real change yet.
 */
export const ICR_WHATIF_POLICY = {
  version: 'icr-whatif.v1',
  step_seconds: 300,
  window_seconds: 5 * 3600,
  /** Readings within this distance of a step count for it. */
  reading_tolerance_seconds: 450,
  /** A window with fewer steps covered by CGM is left out. */
  min_coverage: 0.75,
  meal_min_grams: 5,
  /** Carb entries this close are one meal. */
  meal_merge_seconds: 1200,
  /** Manual boluses this far before or after the carbs belong to the meal. */
  bolus_window_seconds: 1800,
  /** Carbs eaten below this are rescue carbs, not a meal. */
  rescue_below_mgdl: 80,
  /** A rescue is no longer needed when the shifted glucose at that time is at least this. */
  rescue_not_needed_mgdl: 90,
  rescue_absorption_seconds: 3600,
  loop_forecast_steps: 6,
  loop_slope_steps: 3,
  loop_bin_mgdl: 20,
  loop_bin_min_samples: 30,
  loop_bin_min: 40,
  loop_bin_max: 320,
  /** Replays of more than this change either way are refused. */
  min_ratio: 0.5,
  max_ratio: 2,
  /** No card below this many meals; "mała próba" below small_sample_meals. */
  min_meals: 20,
  small_sample_meals: 50,
  /** Evening meals (from this hour) lead into the night line, which ends at night_end_hour next day. */
  evening_from_hour: 18,
  night_end_hour: 6,
  high_run_minutes: 60,
} as const;

type Schedule = Array<[string, number]>;

export interface WhatIfTherapy {
  /** Valid from (epoch ms); null for the oldest known. */
  from_ms: number | null;
  carb_ratio_g_per_u: Schedule | null;
  sensitivity_per_u: Schedule | null;
  basal_u_per_h: Schedule | null;
  units: string | null;
}

export type CarbKind = 'MEAL' | 'HYPO_TREATMENT' | 'CORRECTION_CARBS' | 'IGNORED' | 'FAT_PROTEIN_UNITS' | null;

export interface WhatIfData {
  time_zone: string;
  /** [epoch ms, mg/dL], any order. */
  readings: Array<[number, number]>;
  carbs: Array<{ ms: number; g: number; kind: CarbKind }>;
  /** Manual boluses [epoch ms, U]. */
  boluses: Array<[number, number]>;
  smbs: Array<[number, number]>;
  /** [start epoch ms, U/h, duration minutes]. */
  temps: Array<[number, number, number]>;
  therapies: WhatIfTherapy[];
  dia_hours: number | null;
  peak_minutes: number;
}

export type WhatIfScope = { kind: 'ALL' } | { kind: 'BLOCK'; start: string } | { kind: 'BLOCKS'; starts: string[] };

export interface BandShares {
  below_54: number;
  from_54_to_70: number;
  in_range: number;
  from_180_to_250: number;
  above_250: number;
}

export interface OutcomeSummary {
  meals: number;
  bands: BandShares;
  /** Shares of all minutes, 0–1. */
  time_below_70: number;
  time_above_180: number;
  mean_mgdl: number;
  meals_with_drop_below_70: number;
  meals_with_drop_below_54: number;
  meals_above_180_over_1h: number;
  meals_above_250: number;
}

export interface WhatIfGroup {
  /** "ALL" or the block start ("06:00"). */
  key: string;
  icr_now: number | null;
  icr_after: number | null;
  meals: number;
  dose_change_u_per_meal: number;
  loop_change_u_per_meal: number;
  rescues_removed: number;
  now: OutcomeSummary;
  after: OutcomeSummary;
  /** Certain fact from the data: meals that went above 180 and later below 70 in the window. */
  meals_high_then_low: number;
}

export interface NightSummary {
  nights: number;
  now: { with_drop_below_70: number; with_drop_below_54: number; above_180_over_1h: number };
  after: { with_drop_below_70: number; with_drop_below_54: number; above_180_over_1h: number };
}

export type WhatIfResult =
  | { status: 'OK'; version: string; ratio: number; scope: WhatIfScope; total: WhatIfGroup; blocks: WhatIfGroup[]; night: NightSummary | null; small_sample: boolean; first_meal_ms: number; last_meal_ms: number }
  | { status: 'TOO_FEW_MEALS'; version: string; meals: number }
  | { status: 'RATIO_OUT_OF_RANGE'; version: string; ratio: number }
  | { status: 'NO_SETTINGS'; version: string };

const P = ICR_WHATIF_POLICY;

const toMinutes = (time: string) => {
  const [hour, minute] = time.split(':').map(Number);
  return (hour || 0) * 60 + (minute || 0);
};

/** Local clock reader with a per-minute cache (a replay asks for the same minutes many times). */
function localClock(timeZone: string) {
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

/** Epoch ms of local `hour`:00 on the day after `date` (YYYY-MM-DD) in the zone. */
function nextDayAt(date: string, hour: number, timeZone: string): number {
  const [y, m, d] = date.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d + 1, hour, 0);
  const clock = localClock(timeZone);
  // Shift by the zone offset at that moment (two passes cover a DST change).
  let ms = guess;
  for (let i = 0; i < 2; i += 1) {
    const local = clock(ms);
    const [ly, lm, ld] = local.date.split('-').map(Number);
    const asUtc = Date.UTC(ly, lm - 1, ld, local.hour, local.minute);
    ms += guess - asUtc;
  }
  return ms;
}

function scheduleAt(schedule: Schedule | null, minutesOfDay: number): number | null {
  if (!schedule || schedule.length === 0) return null;
  const sorted = [...schedule].sort((a, b) => toMinutes(a[0]) - toMinutes(b[0]));
  let value = sorted[sorted.length - 1][1];
  for (const [time, v] of sorted) if (toMinutes(time) <= minutesOfDay) value = v;
  return value;
}

function blockStartAt(schedule: Schedule, minutesOfDay: number): string {
  const sorted = [...schedule].sort((a, b) => toMinutes(a[0]) - toMinutes(b[0]));
  let start = sorted[sorted.length - 1][0];
  for (const [time] of sorted) if (toMinutes(time) <= minutesOfDay) start = time;
  return start;
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

interface Meal { ms: number; lastMs: number; g: number; bolus: number; carbU: number; block: string; touched: boolean; du: number }
interface Traj { ms: number[]; obs: number[]; sim: number[] }

export function replayIcrChange(data: WhatIfData, scope: WhatIfScope, ratio: number): WhatIfResult {
  const version = P.version;
  if (!(ratio >= P.min_ratio && ratio <= P.max_ratio)) return { status: 'RATIO_OUT_OF_RANGE', version, ratio };
  const therapies = [...data.therapies].sort((a, b) => (a.from_ms ?? 0) - (b.from_ms ?? 0));
  const current = therapies[therapies.length - 1];
  if (!current?.carb_ratio_g_per_u || !current.sensitivity_per_u) return { status: 'NO_SETTINGS', version };

  const clock = localClock(data.time_zone);
  const minutesOfDay = (ms: number) => { const c = clock(ms); return c.hour * 60 + c.minute; };
  const therapyAt = (ms: number) => {
    let found = therapies[0];
    for (const t of therapies) if ((t.from_ms ?? 0) <= ms) found = t;
    return found;
  };
  const icrAt = (ms: number) => scheduleAt(therapyAt(ms).carb_ratio_g_per_u, minutesOfDay(ms));
  const isfAt = (ms: number) => { const t = therapyAt(ms); return isfToMgdl(scheduleAt(t.sensitivity_per_u, minutesOfDay(ms)), t.units); };
  const scheduledBasalAt = (ms: number) => scheduleAt(therapyAt(ms).basal_u_per_h, minutesOfDay(ms)) ?? 0;

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

  const smbs = [...data.smbs].filter(([, u]) => u > 0).sort((a, b) => a[0] - b[0]);
  const smbMs = smbs.map(([ms]) => ms);
  const smbIn = (from: number, to: number) => {
    let sum = 0;
    for (let i = lowerBound(smbMs, from); i < smbs.length && smbs[i][0] < to; i += 1) sum += smbs[i][1];
    return sum;
  };
  const temps = [...data.temps].sort((a, b) => a[0] - b[0]);
  const tempMs = temps.map(([ms]) => ms);
  const basalRateAt = (ms: number) => {
    const i = lowerBound(tempMs, ms + 1) - 1;
    if (i >= 0) {
      const [start, rate, duration] = temps[i];
      if (Number.isFinite(rate) && duration > 0 && ms < start + duration * 60000) return rate;
    }
    return scheduledBasalAt(ms);
  };
  const capByHour = new Map<number, number>();
  for (const [ms, u] of smbs) { const h = clock(ms).hour; capByHour.set(h, Math.max(capByHour.get(h) ?? 0, u)); }
  const capAt = (ms: number) => capByHour.get(clock(ms).hour) || Math.max(0.1, Math.round((scheduledBasalAt(ms) + 0.049) * 10) / 10);

  // Meals and rescue carbs.
  const rescues: Array<[number, number]> = [];
  const meals: Meal[] = [];
  for (const c of [...data.carbs].sort((a, b) => a.ms - b.ms)) {
    if (!(c.g > 0)) continue;
    const bg = bgAt(c.ms);
    if (c.kind === 'HYPO_TREATMENT' || ((c.kind === null || c.kind === 'CORRECTION_CARBS') && bg !== null && bg < P.rescue_below_mgdl)) { rescues.push([c.ms, c.g]); continue; }
    if ((c.kind !== null && c.kind !== 'MEAL') || c.g < P.meal_min_grams) continue;
    const last = meals[meals.length - 1];
    if (last && c.ms - last.lastMs <= P.meal_merge_seconds * 1000) { last.g += c.g; last.lastMs = c.ms; continue; }
    meals.push({ ms: c.ms, lastMs: c.ms, g: c.g, bolus: 0, carbU: 0, block: '', touched: false, du: 0 });
  }
  const firstReading = readings[0]?.[0] ?? Infinity;
  const usable = meals.filter((m) => m.ms >= firstReading && (bgAt(m.ms) ?? 0) >= P.rescue_below_mgdl);
  const currentRatios = current.carb_ratio_g_per_u;
  for (const m of usable) {
    m.bolus = data.boluses.reduce((sum, [ms, u]) => (u > 0 && ms >= m.ms - P.bolus_window_seconds * 1000 && ms <= m.ms + P.bolus_window_seconds * 1000 ? sum + u : sum), 0);
    const icr = icrAt(m.ms);
    m.carbU = icr && icr > 0 ? Math.min(m.bolus, m.g / icr) : 0;
    m.block = blockStartAt(currentRatios, minutesOfDay(m.ms));
    m.touched = scope.kind === 'ALL' || (scope.kind === 'BLOCK' ? m.block === scope.start : scope.starts.includes(m.block));
    m.du = m.touched ? -m.carbU * (1 - 1 / ratio) : 0;
  }

  // The loop's response measured on this patient's meals.
  const step = P.step_seconds * 1000;
  const bins = new Map<number, number[]>();
  for (const m of usable) {
    for (let k = P.loop_slope_steps; k <= P.window_seconds / P.step_seconds; k += 1) {
      const t = m.ms + k * step;
      const b0 = bgAt(t);
      const b3 = bgAt(t - P.loop_slope_steps * step);
      if (b0 === null || b3 === null) continue;
      const ev = b0 + P.loop_forecast_steps * (b0 - b3) / P.loop_slope_steps;
      const bin = Math.max(P.loop_bin_min, Math.min(P.loop_bin_max, Math.floor(ev / P.loop_bin_mgdl) * P.loop_bin_mgdl + P.loop_bin_mgdl / 2));
      const extra = smbIn(t, t + step) + (basalRateAt(t) - scheduledBasalAt(t)) * P.step_seconds / 3600;
      const list = bins.get(bin) ?? [];
      list.push(extra);
      bins.set(bin, list);
    }
  }
  const response = [...bins.entries()].filter(([, v]) => v.length >= P.loop_bin_min_samples)
    .map(([x, v]) => [x, v.reduce((a, b) => a + b, 0) / v.length] as [number, number]).sort((a, b) => a[0] - b[0]);
  const loopResponse = (ev: number) => {
    if (response.length === 0) return 0;
    if (ev <= response[0][0]) return response[0][1];
    for (let i = 1; i < response.length; i += 1) {
      const [x0, y0] = response[i - 1];
      const [x1, y1] = response[i];
      if (ev <= x1) return y0 + (y1 - y0) * (ev - x0) / (x1 - x0);
    }
    return response[response.length - 1][1];
  };

  const diaMinutes = insulinCurveDiaMinutes(data.dia_hours);
  const used = (minutes: number) => 1 - insulinOnBoard(minutes, diaMinutes, data.peak_minutes);

  const simulate = (t0: number, tEnd: number, doses: Array<[number, number]>, withLoop: boolean): { traj: Traj; loopU: number; rescued: number } | null => {
    const steps = Math.floor((tEnd - t0) / step) + 1;
    const raw = Array.from({ length: steps }, (_, k) => bgAt(t0 + k * step));
    if (raw.filter((v) => v !== null).length < P.min_coverage * steps) return null;
    const firstKnown = raw.find((v) => v !== null) as number;
    const obs: number[] = [];
    for (let k = 0; k < steps; k += 1) obs.push(raw[k] ?? (k > 0 ? obs[k - 1] : firstKnown));
    const ms = Array.from({ length: steps }, (_, k) => t0 + k * step);
    const isf = ms.map((t) => isfAt(t) ?? 0);
    const icr = ms.map((t) => icrAt(t) ?? 0);
    const extra: Array<[number, number]> = [...doses];
    const removed: Array<{ at: number; g: number; icr: number; isf: number }> = [];
    const sim: number[] = new Array(steps).fill(0);
    for (let k = 0; k < steps; k += 1) {
      const t = ms[k];
      let effect = 0;
      for (const [at, du] of extra) if (at <= t) effect += -du * isf[k] * used((t - at) / 60000);
      for (const r of removed) if (r.at <= t && r.icr > 0) effect -= r.g * r.isf / r.icr * Math.min(1, (t - r.at) / (P.rescue_absorption_seconds * 1000));
      sim[k] = obs[k] + effect;
      for (const [at, g] of rescues) {
        if (t - step < at && at <= t && obs[k] < P.rescue_not_needed_mgdl && sim[k] >= P.rescue_not_needed_mgdl) removed.push({ at, g, icr: icr[k], isf: isf[k] });
      }
      if (!withLoop || k < P.loop_slope_steps) continue;
      const slopeObs = (obs[k] - obs[k - P.loop_slope_steps]) / P.loop_slope_steps;
      const slopeSim = (sim[k] - sim[k - P.loop_slope_steps]) / P.loop_slope_steps;
      // Only the loop's own extra insulin still to act; the meal change itself is invisible to the loop.
      let remaining = 0;
      for (let i = doses.length; i < extra.length; i += 1) if (extra[i][0] <= t) remaining += extra[i][1] * (1 - used((t - extra[i][0]) / 60000));
      const evObs = obs[k] + P.loop_forecast_steps * slopeObs;
      const evSim = sim[k] + P.loop_forecast_steps * slopeSim - remaining * isf[k];
      let delta = loopResponse(evSim) - loopResponse(evObs);
      const smbNow = smbIn(t, t + step);
      const given = smbNow + basalRateAt(t) * P.step_seconds / 3600;
      delta = Math.max(-given, Math.min(delta, Math.max(0, capAt(t) - smbNow)));
      if (Math.abs(delta) > 1e-4) extra.push([t + 1, delta]);
    }
    let loopU = 0;
    for (let i = doses.length; i < extra.length; i += 1) loopU += extra[i][1];
    return { traj: { ms, obs, sim }, loopU, rescued: removed.length };
  };

  interface MealRun { meal: Meal; obs: number[]; sim: number[]; loopU: number; rescued: number }
  const runs: MealRun[] = [];
  for (const m of usable) {
    if (!m.touched) continue;
    const out = simulate(m.ms, m.ms + P.window_seconds * 1000, [[m.ms, m.du]], true);
    if (out) runs.push({ meal: m, obs: out.traj.obs, sim: out.traj.sim, loopU: out.loopU, rescued: out.rescued });
  }
  if (runs.length < P.min_meals) return { status: 'TOO_FEW_MEALS', version, meals: runs.length };

  const highRunSteps = P.high_run_minutes * 60 / P.step_seconds;
  const perMeal = (values: number[]) => {
    let run = 0;
    let best = 0;
    for (const v of values) { run = v > 180 ? run + 1 : 0; best = Math.max(best, run); }
    const n = values.length;
    const share = (f: (v: number) => boolean) => values.filter(f).length / n;
    return {
      bands: { below_54: share((v) => v < 54), from_54_to_70: share((v) => v >= 54 && v < 70), in_range: share((v) => v >= 70 && v <= 180), from_180_to_250: share((v) => v > 180 && v <= 250), above_250: share((v) => v > 250) },
      mean: values.reduce((a, b) => a + b, 0) / n,
      min: Math.min(...values),
      max: Math.max(...values),
      highOver1h: best >= highRunSteps,
    };
  };
  const summarize = (list: number[][]): OutcomeSummary => {
    const stats = list.map(perMeal);
    const n = stats.length;
    const avg = (f: (s: ReturnType<typeof perMeal>) => number) => stats.reduce((sum, s) => sum + f(s), 0) / n;
    const bands: BandShares = {
      below_54: avg((s) => s.bands.below_54), from_54_to_70: avg((s) => s.bands.from_54_to_70), in_range: avg((s) => s.bands.in_range),
      from_180_to_250: avg((s) => s.bands.from_180_to_250), above_250: avg((s) => s.bands.above_250),
    };
    return {
      meals: n,
      bands,
      time_below_70: bands.below_54 + bands.from_54_to_70,
      time_above_180: bands.from_180_to_250 + bands.above_250,
      mean_mgdl: avg((s) => s.mean),
      meals_with_drop_below_70: stats.filter((s) => s.min < 70).length,
      meals_with_drop_below_54: stats.filter((s) => s.min < 54).length,
      meals_above_180_over_1h: stats.filter((s) => s.highOver1h).length,
      meals_above_250: stats.filter((s) => s.max > 250).length,
    };
  };
  const group = (key: string, list: MealRun[], icrNow: number | null): WhatIfGroup => ({
    key,
    icr_now: icrNow,
    icr_after: icrNow === null ? null : Math.round(icrNow * ratio * 10) / 10,
    meals: list.length,
    dose_change_u_per_meal: list.reduce((s, r) => s + r.meal.du, 0) / list.length,
    loop_change_u_per_meal: list.reduce((s, r) => s + r.loopU, 0) / list.length,
    rescues_removed: list.reduce((s, r) => s + r.rescued, 0),
    now: summarize(list.map((r) => r.obs)),
    after: summarize(list.map((r) => r.sim)),
    meals_high_then_low: list.filter((r) => Math.max(...r.obs) > 180 && Math.min(...r.obs) < 70).length,
  });

  const blockStarts = [...new Set(runs.map((r) => r.meal.block))].sort((a, b) => toMinutes(a) - toMinutes(b));
  const blocks = blockStarts.map((start) => group(start, runs.filter((r) => r.meal.block === start), currentRatios.find(([time]) => time === start)?.[1] ?? null));
  const total = scope.kind === 'ALL' ? group('ALL', runs, null)
    : scope.kind === 'BLOCK' ? blocks.find((b) => b.key === scope.start) ?? group(scope.start, runs, null)
      : blocks.length === 1 ? blocks[0] : group(scope.starts.join('+'), runs, null);

  // Night after dinner: last evening meal → 06:00 next day, evening or all-day changes only.
  let night: NightSummary | null = null;
  const eveningByDay = new Map<string, Meal[]>();
  for (const m of usable) {
    const c = clock(m.ms);
    if (c.hour >= P.evening_from_hour) eveningByDay.set(c.date, [...(eveningByDay.get(c.date) ?? []), m]);
  }
  const nights: Traj[] = [];
  for (const [date, list] of [...eveningByDay.entries()].sort()) {
    if (!list.some((m) => m.touched)) continue;
    const out = simulate(list[list.length - 1].ms, nextDayAt(date, P.night_end_hour, data.time_zone), list.filter((m) => m.touched).map((m) => [m.ms, m.du] as [number, number]), true);
    if (out) nights.push(out.traj);
  }
  if (nights.length > 0) {
    const count = (pick: (t: Traj) => number[]) => ({
      with_drop_below_70: nights.filter((t) => Math.min(...pick(t)) < 70).length,
      with_drop_below_54: nights.filter((t) => Math.min(...pick(t)) < 54).length,
      above_180_over_1h: nights.filter((t) => pick(t).filter((v) => v > 180).length * P.step_seconds >= P.high_run_minutes * 60).length,
    });
    night = { nights: nights.length, now: count((t) => t.obs), after: count((t) => t.sim) };
  }

  return {
    status: 'OK',
    version,
    ratio,
    scope,
    total,
    blocks,
    night,
    small_sample: total.meals < P.small_sample_meals,
    first_meal_ms: runs[0].meal.ms,
    last_meal_ms: runs[runs.length - 1].meal.ms,
  };
}
