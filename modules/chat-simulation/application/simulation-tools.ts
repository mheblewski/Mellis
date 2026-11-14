import type { AiRuntimeToolDefinition } from '@modules/ai-gateway/domain/ai-gateway';
import type { WhatIfData } from '@modules/settings-whatif/application/icr-whatif';
import {
  inBlock,
  localClock,
  replaySettingChanges,
  scheduleAt,
  toMinutes,
  windowOutcome,
  type DayRun,
  type ReplaySetting,
  type SettingChange,
  type WindowOutcome,
} from '@modules/settings-whatif/application/settings-replay';
import { searchPlace, type Place } from '@modules/settings-whatif/application/settings-search';
import { settingsReplayCard } from '@modules/settings-whatif/application/settings-replay-service';
import type { SettingsReplayCard } from '@modules/settings-whatif/application/settings-replay-card';
import { profileChanges } from '@modules/clinic-report/application/profile-changes';
import { localInstant } from '@modules/settings-insights/application/settings-insights-common';

/**
 * Chat simulation (chat-simulation.v1): the tools the chat model calls itself, as many times as an answer needs —
 * a settings change (one or several at once), a dosing rule, two periods side by side, and the one-step search. Every
 * replay runs twice: with the full insulin effect of the model and with 0.6 of it (measured on this child's carb-free
 * hours: 0.44–0.78). Numbers come only from here; the chat never estimates them.
 */
export const CHAT_SIMULATION_VERSION = 'chat-simulation.v1';
export const CHAT_SIMULATION_POLICY = {
  version: CHAT_SIMULATION_VERSION,
  measuredEffect: 0.6,
  defaultDays: 28,
  minDays: 14,
  maxDays: 42,
  maxPeriodDays: 90,
  maxChanges: 4,
  /** A window after a change: its hours and this long after them (a meal dose and the loop's answer to it). */
  tailMinutes: 240,
  followUpGapMinutes: 45,
  mealBolusMinutes: 30,
  ranges: { BASAL: [0, 5], ICR: [2, 40], ISF: [20, 400], TARGET: [80, 160] } as Record<ReplaySetting, [number, number]>,
} as const;
const C = CHAT_SIMULATION_POLICY;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export type SimulationToolName = 'simulate_settings' | 'simulate_dose_rule' | 'compare_periods' | 'find_one_step';
export const SIMULATION_TOOL_NAMES: SimulationToolName[] = ['simulate_settings', 'simulate_dose_rule', 'compare_periods', 'find_one_step'];

const HHMM = '^([01]\\d|2[0-3]):[0-5]\\d$|^24:00$';
const DATE = '^\\d{4}-\\d{2}-\\d{2}$';
/** The same form as the other chat tools: a type list with null (a pattern applies to strings only). */
const nullable = (schema: Record<string, unknown>) => ({ ...schema, type: [schema.type, 'null'] });

export const SIMULATION_TOOL_DEFINITIONS: AiRuntimeToolDefinition[] = [
  {
    name: 'simulate_settings',
    description: 'Replays the last weeks with changed Trio settings: every logged Trio decision is decided again with the change (the loop\'s own rules, 98 % agreement with the real loop) and only the difference is added to what really happened. One to four changes at once (e.g. ICR in the evening and basal at night). Returns, for the counted window, the outcome with the current settings (now) and the outcome after the change, with the full insulin effect of the model and with 0.6 of it (what this child\'s data show), plus robustness without the two days the change moved most. A single change also puts its card with −/+ under the answer.',
    input_schema: {
      type: 'object', additionalProperties: false,
      properties: {
        changes: {
          type: 'array', minItems: 1, maxItems: C.maxChanges,
          items: {
            type: 'object', additionalProperties: false,
            properties: {
              setting: { type: 'string', enum: ['BASAL', 'ICR', 'ISF', 'TARGET'], description: 'BASAL U/h, ICR g/U, ISF mg/dL per U (profile ISF), TARGET mg/dL (the loop target).' },
              from: { type: 'string', pattern: HHMM, description: 'Local start of the block "HH:MM".' },
              to: { type: 'string', pattern: HHMM, description: 'Local end "HH:MM" (end exclusive; 00:00 or 24:00 = midnight; end before start wraps past midnight).' },
              value: { type: 'number', description: 'The new value for the whole block.' },
            },
            required: ['setting', 'from', 'to', 'value'],
          },
        },
        window_from: nullable({ type: 'string', pattern: HHMM }),
        window_to: nullable({ type: 'string', pattern: HHMM }),
        days: nullable({ type: 'integer', minimum: C.minDays, maximum: C.maxDays }),
      },
      required: ['changes', 'window_from', 'window_to', 'days'],
    },
  },
  {
    name: 'simulate_dose_rule',
    description: 'Replays the last weeks with a different way of dosing meal boluses (settings unchanged; the carbs stay, the loop reacts to the new doses as it would). Rules: FOLLOW_UP_SCALE (every bolus given within 45 min after a previous one is multiplied by factor), FOLLOW_UP_SKIP_WHEN_FALLING (such a bolus is skipped when glucose fell by at least falling_mgdl_per_15min in the 15 min before), FOLLOW_UP_MINUS_IOB (such a bolus is reduced by the insulin on board the loop reported), MEAL_SCALE (meal boluses multiplied by factor), MEAL_EARLIER (meal boluses given minutes earlier, the same dose). Optional hours and a minimum meal size. Same outcome format as simulate_settings, whole day unless hours are given.',
    input_schema: {
      type: 'object', additionalProperties: false,
      properties: {
        rule: { type: 'string', enum: ['FOLLOW_UP_SCALE', 'FOLLOW_UP_SKIP_WHEN_FALLING', 'FOLLOW_UP_MINUS_IOB', 'MEAL_SCALE', 'MEAL_EARLIER'] },
        factor: nullable({ type: 'number', minimum: 0, maximum: 1.5 }),
        minutes: nullable({ type: 'integer', minimum: 5, maximum: 30 }),
        falling_mgdl_per_15min: nullable({ type: 'number', minimum: 5, maximum: 40 }),
        hours_from: nullable({ type: 'string', pattern: HHMM }),
        hours_to: nullable({ type: 'string', pattern: HHMM }),
        min_grams: nullable({ type: 'number', minimum: 0, maximum: 150 }),
        days: nullable({ type: 'integer', minimum: C.minDays, maximum: C.maxDays }),
      },
      required: ['rule', 'factor', 'minutes', 'falling_mgdl_per_15min', 'hours_from', 'hours_to', 'min_grams', 'days'],
    },
  },
  {
    name: 'compare_periods',
    description: 'Two date ranges side by side (no replay, real data only), optionally for some hours: time in ranges, mean, CV, lows (15-min episodes) and days with them, and how the days were lived — meals per day and their size, boluses per meal (dose split into parts), bolus timing against the carbs, carbs and insulin per day (boluses, microboluses, basal given vs scheduled), rescue carbs — plus the Trio profile changes between them. Use it for "why was it better/worse", "what changed", "before/after".',
    input_schema: {
      type: 'object', additionalProperties: false,
      properties: {
        a_from: { type: 'string', pattern: DATE }, a_to: { type: 'string', pattern: DATE, description: 'Inclusive.' },
        b_from: { type: 'string', pattern: DATE }, b_to: { type: 'string', pattern: DATE, description: 'Inclusive.' },
        hours_from: nullable({ type: 'string', pattern: HHMM }),
        hours_to: nullable({ type: 'string', pattern: HHMM }),
      },
      required: ['a_from', 'a_to', 'b_from', 'b_to', 'hours_from', 'hours_to'],
    },
  },
  {
    name: 'find_one_step',
    description: 'Searches one-step changes (ICR, ISF, target, basal by one pump or schedule step) for given hours and replays each: which ones lower the lows (LOWS) or the highs (RISES) without making lows worse, also at half the insulin effect and without the two days moved most, with highs rising at most +50 %. Returns every candidate checked with its numbers and why it passed or not. Slow: a minute or more; use it when the caregiver asks what could be changed.',
    input_schema: {
      type: 'object', additionalProperties: false,
      properties: {
        hours_from: { type: 'string', pattern: HHMM }, hours_to: { type: 'string', pattern: HHMM },
        focus: { type: 'string', enum: ['LOWS', 'RISES'] },
        days: nullable({ type: 'integer', minimum: C.minDays, maximum: C.maxDays }),
      },
      required: ['hours_from', 'hours_to', 'focus', 'days'],
    },
  },
];

export interface SimulationOutput { result: Record<string, unknown>; card: SettingsReplayCard | null }

const round = (x: number, k = 1) => Math.round(x * 10 ** k) / 10 ** k;
const hhmm = (m: number) => { const x = ((m % 1440) + 1440) % 1440; return `${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`; };
const normTime = (t: unknown) => (t === '24:00' ? '00:00' : String(t));

function summary(o: WindowOutcome) {
  return {
    days: o.days, mean_mgdl: Math.round(o.mean_mgdl),
    below_54_pct: round(100 * o.below_54), below_70_pct: round(100 * o.below_70), above_180_pct: round(100 * o.above_180), above_250_pct: round(100 * o.above_250),
    days_below_70: o.days_below_70, days_below_54: o.days_below_54, days_above_180_over_1h: o.days_above_180_over_1h, days_above_250: o.days_above_250,
    minutes_below_70: Math.round(o.minutes_below_70), minutes_below_54: Math.round(o.minutes_below_54), minutes_above_180: Math.round(o.minutes_above_180), minutes_above_250: Math.round(o.minutes_above_250),
    lowest_mgdl: Math.round(o.lowest_mgdl),
  };
}

/** A plain reading of now → after, so the model never has to compare numbers itself. */
function direction(now: WindowOutcome, after: WindowOutcome) {
  const dir = (a: number, b: number, tol: number) => (b < a - tol ? 'FEWER' : b > a + tol ? 'MORE' : 'SAME');
  return {
    lows: dir(now.minutes_below_70, after.minutes_below_70, Math.max(10, now.minutes_below_70 * 0.05)),
    severe_lows: after.days_below_54 > now.days_below_54 || after.minutes_below_54 > now.minutes_below_54 + 5 ? 'MORE' : after.minutes_below_54 < now.minutes_below_54 - 5 ? 'FEWER' : 'SAME',
    highs: dir(now.minutes_above_180, after.minutes_above_180, Math.max(15, now.minutes_above_180 * 0.03)),
    very_highs: dir(now.minutes_above_250, after.minutes_above_250, Math.max(10, now.minutes_above_250 * 0.05)),
  };
}

/** The same replay without the two days whose lows it moved most (one or two odd days must not carry the result). */
function withoutTwoDays(runs: DayRun[]) {
  const moved = (r: DayRun) => Math.abs(r.sim.filter((v) => v < 70).length - r.obs.filter((v) => v < 70).length) + Math.abs(r.sim.filter((v) => v > 180).length - r.obs.filter((v) => v > 180).length) / 4;
  const keep = [...runs].sort((a, b) => moved(b) - moved(a)).slice(2);
  const now = windowOutcome(keep, 'obs'); const after = windowOutcome(keep, 'sim');
  return { days: keep.length, direction: direction(now, after), minutes_below_70: [Math.round(now.minutes_below_70), Math.round(after.minutes_below_70)], minutes_above_180: [Math.round(now.minutes_above_180), Math.round(after.minutes_above_180)] };
}

/** The data of the last `days` days (and the hours before them a replay needs for insulin on board). */
export function lastDays(data: WhatIfData, days: number, nowMs: number): WhatIfData {
  const from = nowMs - days * DAY - 12 * HOUR;
  const keep = <T>(xs: T[], ms: (x: T) => number) => xs.filter((x) => ms(x) >= from && ms(x) <= nowMs);
  return {
    ...data,
    readings: keep(data.readings, ([t]) => t), carbs: keep(data.carbs, (c) => c.ms), boluses: keep(data.boluses, ([t]) => t),
    smbs: keep(data.smbs, ([t]) => t), temps: keep(data.temps, ([t]) => t), trio_cycles: data.trio_cycles ? keep(data.trio_cycles, (c) => c.ms) : data.trio_cycles,
  };
}

/**
 * The hours each change acts in, with the tail after them, on the 24-hour circle; the window starts after the longest
 * stretch no change reaches (ICR 18–24 and basal 0–2 → 18:00–06:00). No free stretch: the whole day.
 */
export function defaultWindow(changes: Array<Pick<SettingChange, 'from' | 'to'>>): { from: string; to: string } {
  if (changes.length === 0) return { from: '00:00', to: '00:00' };
  const covered = new Array<boolean>(288).fill(false);
  for (const c of changes) {
    const a = toMinutes(c.from); let b = toMinutes(c.to); if (b <= a) b += 1440;
    for (let m = a; m < b + C.tailMinutes; m += 5) covered[Math.floor((((m % 1440) + 1440) % 1440) / 5)] = true;
  }
  if (covered.every(Boolean)) return { from: '00:00', to: '00:00' };
  let bestStart = 0; let bestLen = 0;
  for (let i = 0; i < 288; i += 1) {
    if (covered[i] || !covered[(i + 287) % 288]) continue;
    let len = 0; while (len < 288 && !covered[(i + len) % 288]) len += 1;
    if (len > bestLen) { bestLen = len; bestStart = i; }
  }
  return { from: hhmm(((bestStart + bestLen) % 288) * 5), to: hhmm(bestStart * 5) };
}

function replayBoth(data: WhatIfData, changes: SettingChange[], window: { from: string; to: string }, doseChanges?: Array<{ at: number; du: number }>) {
  const full = replaySettingChanges(data, changes, window, { dose_changes: doseChanges });
  if (full.status !== 'OK') return { status: full.status } as const;
  const measured = replaySettingChanges(data, changes, window, { dose_changes: doseChanges, insulin_effect_scale: C.measuredEffect });
  if (measured.status !== 'OK') return { status: measured.status } as const;
  return {
    status: 'OK' as const,
    window,
    days_counted: full.now.days,
    days_skipped: full.skipped.length,
    now: summary(full.now),
    after_full_effect: summary(full.after),
    after_measured_effect: summary(measured.after),
    direction_full_effect: direction(full.now, full.after),
    direction_measured_effect: direction(measured.now, measured.after),
    without_two_most_moved_days: withoutTwoDays(full.runs),
    extra_insulin_u_per_day_median: round(full.extra_u_median, 2),
    meals_changed: full.meals,
    meal_dose_change_u: full.meal_dose_change_u === null ? null : round(full.meal_dose_change_u, 2),
    not_modelled: 'New lows are left untreated (no rescue carbs given); rescue carbs no longer needed are taken off. Autosens/TDD drift, manual corrections computed with a new ISF and pump gaps are not modelled.',
  };
}

function nowValueOf(data: WhatIfData, c: SettingChange): number | null {
  const t = [...data.therapies].sort((a, b) => (a.from_ms ?? 0) - (b.from_ms ?? 0)).pop();
  if (!t) return null;
  const sched = c.setting === 'BASAL' ? t.basal_u_per_h : c.setting === 'ICR' ? t.carb_ratio_g_per_u : c.setting === 'ISF' ? t.sensitivity_per_u : t.target_low_mgdl ?? null;
  return scheduleAt(sched, toMinutes(c.from));
}

function simulateSettings(data: WhatIfData, args: Record<string, unknown>, nowMs: number, checkDate: string | null): SimulationOutput {
  const raw = Array.isArray(args.changes) ? args.changes as Array<Record<string, unknown>> : [];
  const changes: SettingChange[] = [];
  for (const c of raw.slice(0, C.maxChanges)) {
    const setting = String(c.setting) as ReplaySetting;
    const value = Number(c.value);
    const range = C.ranges[setting];
    if (!range || !Number.isFinite(value) || value < range[0] || value > range[1]) return { result: { status: 'INVALID_VALUE', setting, allowed: range ?? null }, card: null };
    changes.push({ setting, from: normTime(c.from), to: normTime(c.to), value });
  }
  if (!changes.length) return { result: { status: 'INVALID_REQUEST', problem: 'No change.' }, card: null };
  const days = Number(args.days ?? C.defaultDays);
  const sliced = lastDays(data, days, nowMs);
  const window = args.window_from && args.window_to ? { from: normTime(args.window_from), to: normTime(args.window_to) } : defaultWindow(changes);
  const out = replayBoth(sliced, changes, window);
  if (out.status !== 'OK') return { result: { status: out.status }, card: null };
  const card = changes.length === 1 ? (() => { const r = settingsReplayCard(sliced, changes[0], { check_date: checkDate, window }); return r.status === 'OK' ? r.card : null; })() : null;
  return {
    result: { ...out, changes: changes.map((c) => ({ ...c, now_value: nowValueOf(data, c) })), card_shown: card !== null },
    card,
  };
}

/** Meal boluses and follow-ups: a bolus with non-rescue carbs within 30 min; a follow-up is any bolus ≥ 0.3 U within 45 min after the previous one. */
function doseRuleChanges(data: WhatIfData, args: Record<string, unknown>) {
  const clock = localClock(data.time_zone);
  const minuteOf = (ms: number) => { const c = clock(ms); return c.hour * 60 + c.minute; };
  const inHours = (ms: number) => (args.hours_from && args.hours_to ? inBlock(minuteOf(ms), normTime(args.hours_from), normTime(args.hours_to)) : true);
  const carbs = data.carbs.filter((c) => c.kind !== 'HYPO_TREATMENT' && c.g > 0);
  const gramsNear = (t: number) => carbs.filter((c) => Math.abs(c.ms - t) <= C.mealBolusMinutes * MIN).reduce((s, c) => s + c.g, 0);
  const boluses = [...data.boluses].filter(([, u]) => u > 0).sort((a, b) => a[0] - b[0]);
  const readings = [...data.readings].sort((a, b) => a[0] - b[0]);
  const bgAt = (t: number) => { let best: [number, number] | null = null; for (const r of readings) { if (Math.abs(r[0] - t) <= 7.5 * MIN && (!best || Math.abs(r[0] - t) < Math.abs(best[0] - t))) best = r; if (r[0] > t + 10 * MIN) break; } return best?.[1] ?? null; };
  const iobAt = (t: number) => {
    let best: { ms: number; iob: number } | null = null;
    for (const c of data.trio_cycles ?? []) { const iob = Number(c.suggested.IOB); if (Number.isFinite(iob) && Math.abs(c.ms - t) <= 10 * MIN && (!best || Math.abs(c.ms - t) < Math.abs(best.ms - t))) best = { ms: c.ms, iob }; }
    return best?.iob ?? null;
  };
  const rule = String(args.rule);
  const factor = args.factor === null || args.factor === undefined ? null : Number(args.factor);
  const minGrams = Number(args.min_grams ?? 0);
  const changes: Array<{ at: number; du: number }> = [];
  let affected = 0;
  boluses.forEach(([t, u], i) => {
    if (!inHours(t)) return;
    const prev = i > 0 ? boluses[i - 1] : null;
    const followUp = prev !== null && u >= 0.3 && t - prev[0] <= C.followUpGapMinutes * MIN;
    const grams = gramsNear(t);
    const meal = grams > 0 && grams >= minGrams;
    switch (rule) {
      case 'FOLLOW_UP_SCALE':
        if (followUp && factor !== null) { changes.push({ at: t, du: u * (factor - 1) }); affected += 1; }
        break;
      case 'FOLLOW_UP_SKIP_WHEN_FALLING': {
        if (!followUp) break;
        const a = bgAt(t - 15 * MIN); const b = bgAt(t);
        if (a !== null && b !== null && a - b >= Number(args.falling_mgdl_per_15min ?? 10)) { changes.push({ at: t, du: -u }); affected += 1; }
        break;
      }
      case 'FOLLOW_UP_MINUS_IOB': {
        if (!followUp) break;
        const iob = iobAt(t);
        if (iob !== null && iob > 0) { changes.push({ at: t, du: -Math.min(u, iob) }); affected += 1; }
        break;
      }
      case 'MEAL_SCALE':
        if (meal && factor !== null) { changes.push({ at: t, du: u * (factor - 1) }); affected += 1; }
        break;
      case 'MEAL_EARLIER': {
        const minutes = Number(args.minutes ?? 15);
        if (meal && !followUp) { changes.push({ at: t, du: -u }, { at: t - minutes * MIN, du: u }); affected += 1; }
        break;
      }
      default:
    }
  });
  return { changes, affected };
}

function simulateDoseRule(data: WhatIfData, args: Record<string, unknown>, nowMs: number): SimulationOutput {
  const rule = String(args.rule);
  if (['FOLLOW_UP_SCALE', 'MEAL_SCALE'].includes(rule) && (args.factor === null || args.factor === undefined)) return { result: { status: 'INVALID_REQUEST', problem: 'factor is needed for this rule.' }, card: null };
  const days = Number(args.days ?? C.defaultDays);
  const sliced = lastDays(data, days, nowMs);
  const { changes, affected } = doseRuleChanges(sliced, args);
  if (!changes.length) return { result: { status: 'NOTHING_TO_CHANGE', note: 'No bolus matches the rule in these days and hours.' }, card: null };
  const window = args.hours_from && args.hours_to
    ? (() => { const a = toMinutes(normTime(args.hours_from)); let b = toMinutes(normTime(args.hours_to)); if (b <= a) b += 1440; b = Math.min(a + 1440, b + C.tailMinutes); return b - a >= 1440 ? { from: '00:00', to: '00:00' } : { from: hhmm(a), to: hhmm(b) }; })()
    : { from: '00:00', to: '00:00' };
  const out = replayBoth(sliced, [], window, changes);
  if (out.status !== 'OK') return { result: { status: out.status }, card: null };
  const net = changes.reduce((s, c) => s + c.du, 0);
  return { result: { ...out, rule, boluses_changed: affected, boluses_changed_per_day: round(affected / Math.max(out.days_counted, 1)), insulin_change_u_per_day: round(net / Math.max(out.days_counted, 1), 2) }, card: null };
}

function comparePeriods(data: WhatIfData, args: Record<string, unknown>): SimulationOutput {
  const clock = localClock(data.time_zone);
  const minuteOf = (ms: number) => { const c = clock(ms); return c.hour * 60 + c.minute; };
  const hours = args.hours_from && args.hours_to ? { from: normTime(args.hours_from), to: normTime(args.hours_to) } : null;
  const inHours = (ms: number) => (hours ? inBlock(minuteOf(ms), hours.from, hours.to) : true);
  const range = (from: unknown, to: unknown) => {
    const a = String(from); const b = String(to);
    return (ms: number) => { const d = clock(ms).date; return d >= a && d <= b; };
  };
  const therapies = [...data.therapies].sort((a, b) => (a.from_ms ?? 0) - (b.from_ms ?? 0));
  const schedAt = (ms: number) => { let t = therapies[0]; for (const x of therapies) if ((x.from_ms ?? 0) <= ms) t = x; return scheduleAt(t?.basal_u_per_h, minuteOf(ms)) ?? 0; };
  const temps = [...data.temps].sort((a, b) => a[0] - b[0]);
  const period = (inRange: (ms: number) => boolean, label: string) => {
    const readings = data.readings.filter(([t, v]) => v > 0 && inRange(t) && inHours(t)).sort((a, b) => a[0] - b[0]);
    const dates = new Set(data.readings.filter(([t]) => inRange(t)).map(([t]) => clock(t).date));
    const days = dates.size;
    if (!readings.length) return { period: label, status: 'NO_DATA' };
    const v = readings.map(([, x]) => x);
    const mean = v.reduce((s, x) => s + x, 0) / v.length;
    const sd = Math.sqrt(v.reduce((s, x) => s + (x - mean) ** 2, 0) / v.length);
    const pct = (f: (x: number) => boolean) => round((100 * v.filter(f).length) / v.length);
    // Lows: >= 15 min under 70.
    let run = 0; let episodes = 0; const lowDays = new Set<string>(); let prevT = 0;
    for (const [t, x] of readings) {
      if (t - prevT > 10 * MIN) run = 0;
      prevT = t;
      if (x < 70) { run += 1; if (run === 3) { episodes += 1; lowDays.add(clock(t).date); } } else run = 0;
    }
    const carbs = data.carbs.filter((c) => inRange(c.ms) && inHours(c.ms) && c.g > 0);
    const mealCarbs = carbs.filter((c) => c.kind !== 'HYPO_TREATMENT').sort((a, b) => a.ms - b.ms);
    const meals: Array<{ at: number; last: number; g: number }> = [];
    for (const c of mealCarbs) { const m = meals[meals.length - 1]; if (m && c.ms - m.last <= C.followUpGapMinutes * MIN) { m.g += c.g; m.last = c.ms; } else meals.push({ at: c.ms, last: c.ms, g: c.g }); }
    const boluses = data.boluses.filter(([t, u]) => u > 0 && inRange(t) && inHours(t));
    const perMeal = meals.map((m) => boluses.filter(([t]) => t >= m.at - C.mealBolusMinutes * MIN && t <= m.last + C.followUpGapMinutes * MIN));
    const timing = meals.map((m) => { const b = boluses.filter(([t]) => Math.abs(t - m.at) <= C.mealBolusMinutes * MIN).sort((x, y) => Math.abs(x[0] - m.at) - Math.abs(y[0] - m.at))[0]; return b ? (b[0] - m.at) / MIN : null; }).filter((x): x is number => x !== null).sort((a, b) => a - b);
    const gramsSorted = meals.map((m) => m.g).sort((a, b) => a - b);
    let basal = 0; let ti = 0;
    for (const date of [...dates].sort()) {
      const dayStart = localInstant(date, 0, data.time_zone);
      for (let m = 0; m < 1440; m += 5) {
        const t = dayStart + m * MIN;
        if (!inHours(t)) continue;
        while (ti + 1 < temps.length && temps[ti + 1][0] <= t) ti += 1;
        const tp = temps[ti];
        basal += (tp && tp[0] <= t && t < tp[0] + tp[2] * MIN ? tp[1] : schedAt(t)) / 12;
      }
    }
    const perDay = (x: number) => round(x / Math.max(days, 1), 1);
    return {
      period: label, days, mean_mgdl: Math.round(mean), cv_pct: round((100 * sd) / mean),
      below_54_pct: pct((x) => x < 54), below_70_pct: pct((x) => x < 70), in_range_pct: pct((x) => x >= 70 && x <= 180), above_180_pct: pct((x) => x > 180), above_250_pct: pct((x) => x > 250),
      low_episodes: episodes, low_episodes_per_day: perDay(episodes), days_with_low: lowDays.size,
      meals_per_day: perDay(meals.length), meal_grams_median: gramsSorted.length ? gramsSorted[Math.floor(gramsSorted.length / 2)] : null,
      boluses_per_meal: perMeal.length ? round(perMeal.reduce((s, b) => s + b.length, 0) / perMeal.length, 2) : null,
      meals_with_split_dose_pct: perMeal.length ? Math.round((100 * perMeal.filter((b) => b.length >= 2).length) / perMeal.length) : null,
      bolus_minus_meal_minutes_median: timing.length ? Math.round(timing[Math.floor(timing.length / 2)]) : null,
      carbs_g_per_day: perDay(mealCarbs.reduce((s, c) => s + c.g, 0)),
      bolus_u_per_day: perDay(boluses.reduce((s, [, u]) => s + u, 0)),
      smb_u_per_day: perDay(data.smbs.filter(([t]) => inRange(t) && inHours(t)).reduce((s, [, u]) => s + u, 0)),
      basal_given_u_per_day: perDay(basal),
      rescue_carbs_per_day: perDay(carbs.filter((c) => c.kind === 'HYPO_TREATMENT').length),
    };
  };
  const a = period(range(args.a_from, args.a_to), `${args.a_from}…${args.a_to}`);
  const b = period(range(args.b_from, args.b_to), `${args.b_from}…${args.b_to}`);
  const lo = [String(args.a_from), String(args.b_from)].sort()[0];
  const hi = [String(args.a_to), String(args.b_to)].sort()[1];
  const changes = profileChanges(data.therapies, Date.parse(`${lo}T00:00:00Z`) - DAY, Date.parse(`${hi}T23:59:59Z`) + DAY, (ms) => clock(ms).date)
    .map((c) => ({ date: clock(c.at).date, setting: c.setting, hours: `${hhmm(c.fromMinute)}–${c.toMinute >= 1440 ? '24:00' : hhmm(c.toMinute)}`, before: c.before, after: c.after }));
  return { result: { status: 'OK', hours, a, b, profile_changes: changes, note: 'Real data only: a difference between periods has many possible reasons; compare the habits as well as the settings.' }, card: null };
}

function findOneStep(data: WhatIfData, args: Record<string, unknown>, nowMs: number): SimulationOutput {
  const days = Number(args.days ?? C.defaultDays);
  const sliced = lastDays(data, days, nowMs);
  const from = normTime(args.hours_from); const to = normTime(args.hours_to);
  const focus = args.focus === 'RISES' ? 'RISES' : 'LOWS';
  const place: Place = { from, to, kind: focus, lows_window: focus === 'LOWS' ? { from, to } : null, stats: { days: 0, below_70: 0, below_54: 0, above_180: 0, above_250: 0, days_below_70: 0, days_below_54: 0, days_above_180_over_1h: 0 }, changed_on: null, waits_until: null };
  const r = searchPlace(sliced, place, { includeWaiting: true });
  if (r.status === 'NO_DATA') return { result: { status: 'NO_DATA', reason: r.reason }, card: null };
  if (r.status === 'WAITS') return { result: { status: 'WAITS' }, card: null };
  const row = (x: (typeof r.checked)[number]) => ({
    setting: x.change.setting, from: x.change.from, to: x.change.to, now_value: x.change.now_value, value: x.change.value,
    minutes_below_70: [Math.round(x.now.minutes_below_70), Math.round(x.after.minutes_below_70)], days_below_54: [x.now.days_below_54, x.after.days_below_54],
    minutes_above_180: [Math.round(x.now.minutes_above_180), Math.round(x.after.minutes_above_180)], days_above_180_over_1h: [x.now.days_above_180_over_1h, x.after.days_above_180_over_1h],
    passes: x.passes,
  });
  return {
    result: {
      status: r.status, focus, window: r.window, days_counted: r.checked[0]?.now.days ?? null,
      best: r.status === 'FOUND' ? row(r.best) : null,
      checked: r.checked.map(row), not_counted: r.not_counted,
      rules: 'A candidate passes when lows are not worse (minutes <70 and <54 days), also at half the insulin effect and without the two days moved most, and highs rise at most +50 %.',
    },
    card: null,
  };
}

/** One tool call on loaded data. Pure and synchronous: the caller runs it off the main thread. */
export function runSimulationTool(name: SimulationToolName, args: Record<string, unknown>, data: WhatIfData, nowMs: number, checkDate: string | null): SimulationOutput {
  switch (name) {
    case 'simulate_settings': return simulateSettings(data, args, nowMs, checkDate);
    case 'simulate_dose_rule': return simulateDoseRule(data, args, nowMs);
    case 'compare_periods': return comparePeriods(data, args);
    case 'find_one_step': return findOneStep(data, args, nowMs);
    default: return { result: { status: 'INVALID_REQUEST', problem: 'Unknown tool.' }, card: null };
  }
}
