import type { DashboardResponse } from '@modules/dashboard/application/dashboard-snapshot';
import { PushNotificationProviderError } from '@modules/notifications/infrastructure/push-notification-provider.error';
import { trendArrow } from '@modules/remote-commands/application/bolus-reminders';

/**
 * Glucose pushes (glucose-alerts.v1, owner 2026-11-02), "Powiadomienia o glikemii" in the phone's settings, off by
 * default. Each new reading is judged once, while it is under 10 minutes old:
 * - under 54: red "❗", "Glukoza poniżej 54 i spada.", at once and then every 5 minutes, whatever the low's interval
 *   (role review 2026-11-15: level 2 must not read like 68);
 * - under 70: red "❗", "Glukoza poniżej 70 i spada." (" i rośnie" / " i spada" by the 5-minute change);
 * - 70–79: yellow "⚠️", "Glukoza poniżej 80 i spada.", once when it crosses below 80, then while it falls by 5 or more in
 *   5 minutes (owner 2026-11-15: the arrow alone sat on "→" at 71–77 for an hour after a predicted-low alert);
 * - crossing 160 / 180 / 250 upward: yellow "⚠️", once each, "Glukoza powyżej 160 i rośnie." (180, 250 alike);
 * - above 180 (owner 2026-11-15: one push per change of course, not per reading): "Glukoza powyżej 180 i rośnie."
 *   every 15 minutes while it rose by 10 or more in them; "Glukoza spada. Najwyżej było 248." once
 *   the top is 15 minutes old and 10 or more above; "Glukoza od godziny powyżej 180 i nie spada." after an hour above
 *   180 without a fall of 10 in 30 minutes, then hourly;
 * - two arrows (⇈ / ⇊): yellow "⚠️", "Glukoza szybko rośnie." / "Glukoza szybko spada.", then every 15 minutes while they last;
 * - back in 70–180 after a phone was told about a low (under 70) or a high (over 180): "✅ 120 (+3)" as the title and
 *   "Glukoza wróciła do zakresu." in the body;
 * - no reading for 10 minutes: "Brak odczytów z sensora", again at 15, 20 and 30 minutes, then every 15 minutes; after a
 *   new sensor (Sensor Start / Change after the last reading, under 2 h ago) once "Nowy sensor się rozgrzewa" instead.
 Under 80 the 5-minute change decides, not the arrow; the two fast kinds follow the arrow. A phone gets at most one push
 * per reading (the first kind of PRIORITY it has on). Only a low repeats on the phone's own interval ("Niska glukoza —
 * powtarzaj co", 5–60 minutes, 15 by default); the other kinds keep the fixed rhythm above ("Pozostałe — powtarzaj co"
 * is gone, owner 2026-11-15). "Glukoza spada" stays quiet while a low was pushed in the low's interval.
 */
export const GLUCOSE_ALERT_POLICY = {
  version: 'glucose-alerts.v1',
  low_below: 70,
  falling_below: 80,
  rising_above: 160,
  high_above: 180,
  very_high_above: 250,
  /** Above 180: "i rośnie" again every this long while glucose rose by `still_rising_min` in it (owner 2026-11-15). */
  high_repeat_ms: 15 * 60_000,
  still_rising_min: 10,
  /** The top of a run above 180 is past when it is this old and glucose is `peak_drop` or more below it. */
  peak_quiet_ms: 15 * 60_000,
  peak_drop: 10,
  /** "Nie spada": this long above 180 without a fall of `stuck_drop` in the last `stuck_window_ms`; then this often. */
  stuck_after_ms: 60 * 60_000,
  stuck_window_ms: 30 * 60_000,
  stuck_drop: 10,
  /** Two arrows come again this often while they last. */
  fast_repeat_ms: 15 * 60_000,
  /**
   * A threshold crossed again counts only after glucose was this far back on the other side since the last push of it
   * (249 / 251 / 248 / 252 is one crossing, owner 2026-11-15).
   */
  crossing_reset: 10,
  /** A gap longer than this between readings ends a run above 180. */
  run_gap_ms: 15 * 60_000,
  /** Under 80 a push needs a fall of at least this much in 5 minutes (owner 2026-11-15), not an arrow. */
  falling_min_delta: -5,
  no_data_after_ms: 10 * 60_000,
  /**
   * After one skipped reading the gap reaches 10 minutes just as the next reading is due, and that reading needs a moment
   * to reach Nightscout: a tick in between warned about a gap that was already over (2026-11-05).
   */
  no_data_grace_ms: 30_000,
  /** A reading that reaches the server late (the loop's phone offline) is still judged up to this age. */
  late_reading_max_ms: 20 * 60_000,
  no_data_repeat_ms: 5 * 60_000,
  /** From this gap on "Brak odczytów" comes every `no_data_late_step_ms` (role review 2026-11-15). */
  no_data_slow_from_ms: 30 * 60_000,
  no_data_late_step_ms: 15 * 60_000,
  /** A sensor started after the last reading and this recently is warming up: one push, then quiet. */
  sensor_warmup_ms: 2 * 60 * 60_000,
  very_low_below: 54,
  very_low_repeat_ms: 5 * 60_000,
  /** "Nie spada" from this long on asks to check the site (and ketones over 250). */
  stuck_check_site_ms: 2 * 60 * 60_000,
  repeat_grace_ms: 90_000,
  tick_ms: 60_000,
  /**
   * A phone that also gets the rescue carb alert (the same low with a proposed dose) would hear two alarms for one
   * reading (role review 2026-11-09). A low, falling or fast-falling push to it waits until the reading is this old, so
   * the rescue alert (judged ~12 s after the reading is stored) goes first, and is left out when one reached the phone
   * from this much before the reading on. Only the minute tick waits: after a sync the rescue alert judges the reading
   * first and signals the glucose push straight after (glucoseReadingSignal, 2026-11-14).
   */
  rescue_wait_ms: 60_000,
  rescue_overlap_ms: 5 * 60_000,
} as const;

/** The kinds a rescue carb alert says too (a low now or one coming). */
export const RESCUE_COVERED_KINDS: readonly GlucoseAlertKind[] = ['low', 'falling', 'fast_fall'];

export type GlucoseAlertKind = 'very_low' | 'low' | 'fast_fall' | 'fast_rise' | 'in_range' | 'very_high' | 'high' | 'still_rising' | 'stuck' | 'peak' | 'rising' | 'falling';

/** The switches inside the section; 'fast' covers both directions. */
export type GlucoseAlertSetting = 'low' | 'falling' | 'rising' | 'high' | 'very_high' | 'fast' | 'in_range' | 'no_data';
export const GLUCOSE_ALERT_SETTINGS: readonly GlucoseAlertSetting[] = ['low', 'falling', 'rising', 'high', 'very_high', 'fast', 'in_range', 'no_data'];

/** Which kind wins when several hold for one reading. */
const PRIORITY: GlucoseAlertKind[] = ['very_low', 'low', 'fast_fall', 'fast_rise', 'in_range', 'very_high', 'high', 'still_rising', 'stuck', 'peak', 'rising', 'falling'];

/** The pushes that tell a phone about a run above 180 (the top and "nie spada" come only after one of them). */
const HIGH_TOLD_KINDS: GlucoseAlertKind[] = ['high', 'very_high', 'still_rising', 'fast_rise'];

/** The range "Glukoza w zakresie" means (the dashboard's green band) and the pushes that start an excursion out of it. */
const IN_RANGE = { min: 70, max: 180 } as const;
const OUT_OF_RANGE_KINDS: GlucoseAlertKind[] = ['very_low', 'low', 'high', 'very_high'];


const SETTING_OF: Record<GlucoseAlertKind, GlucoseAlertSetting> = {
  very_low: 'low', low: 'low', falling: 'falling', rising: 'rising', high: 'high', very_high: 'very_high', fast_rise: 'fast', fast_fall: 'fast', in_range: 'in_range',
  still_rising: 'high', stuck: 'high', peak: 'high',
};

/** Repeat intervals a phone can pick ("Powtarzaj co"), in minutes. */
export const GLUCOSE_ALERT_REPEAT_MINUTES = [5, 10, 15, 20, 30, 60] as const;

export interface GlucoseAlertState {
  patient_id: string;
  last_reading_at: string | null;
  /** Per phone (push token): when each kind was last pushed to it. */
  sent: Record<string, Partial<Record<GlucoseAlertKind, string>>>;
  no_data_sent_at: string | null;
  revision: number;
}

export interface GlucoseAlertDevice {
  device_id: string;
  push_token: string;
  /** The section's kinds this phone turned off. */
  kinds_off: GlucoseAlertSetting[];
  /** "Niska glukoza — powtarzaj co" (minutes). */
  low_repeat_minutes: number;
  /** "Pozostałe — powtarzaj co" (minutes): no longer used (owner 2026-11-15), still stored for older apps. */
  repeat_minutes: number;
  /** The phone also has rescue carb alerts on. */
  rescue_on?: boolean;
}

export interface GlucoseObservation {
  value: number;
  observed_at: string;
  direction: string | null;
  /** mg/dL per 5 minutes. */
  delta: number | null;
  iob_units: number | null;
  cob_grams: number | null;
  /** Sensor Start / Change from Nightscout (the dashboard's), for the warm-up after a new sensor. */
  sensor_started_at?: string | null;
  /** Readings oldest first, the latest included (the dashboard's 24 h); without them no run above 180 is followed. */
  history?: Array<{ at: string; value: number }>;
}

/** What a push about a run above 180 says beside the reading. */
export interface GlucosePushDetail {
  /** The value 15 minutes before (decides the push, not said in it). */
  before?: number;
  /** "Najwyżej było 248." */
  top?: number;
  /** "od godziny" */
  minutes?: number;
}

type NextState = Omit<GlucoseAlertState, 'patient_id' | 'revision'>;

export type GlucoseAlertDecision =
  | { type: 'none'; next: NextState | null }
  | { type: 'glucose'; next: NextState; pushes: Array<{ device: GlucoseAlertDevice; kind: GlucoseAlertKind; detail?: GlucosePushDetail }> }
  | { type: 'no_data'; next: NextState; minutes: number; warmup?: boolean };

type Trend = 'rising' | 'falling' | 'flat' | null;

function trendOf(arrow: string | null): Trend {
  if (arrow === '⇈' || arrow === '↑' || arrow === '↗') return 'rising';
  if (arrow === '⇊' || arrow === '↓' || arrow === '↘') return 'falling';
  if (arrow === '→') return 'flat';
  return null;
}

/** The kinds that hold for this reading, strongest first. */
export function activeGlucoseKinds(observation: Pick<GlucoseObservation, 'value' | 'direction' | 'delta'>): GlucoseAlertKind[] {
  const arrow = trendArrow(observation.direction, observation.delta);
  const value = observation.value;
  const p = GLUCOSE_ALERT_POLICY;
  const kinds: GlucoseAlertKind[] = [];
  if (value < p.very_low_below) kinds.push('very_low');
  if (value < p.low_below) kinds.push('low');
  if (arrow === '⇊') kinds.push('fast_fall');
  if (arrow === '⇈') kinds.push('fast_rise');
  // 160, 180 and 250 come once each as crossings (crossedGlucoseKinds); a run above 180 is followed by highRunKinds.
  if (observation.delta !== null && Number.isFinite(observation.delta) && observation.delta <= p.falling_min_delta
    && value >= p.low_below && value < p.falling_below) kinds.push('falling');
  return PRIORITY.filter((kind) => kinds.includes(kind));
}

/** A crossing is not pushed twice in this time (the same reading judged again after a failed send to another phone). */
const CROSSING_QUIET_MS = 5 * 60_000;

/**
 * The thresholds this reading went over since the previous one (value − its 5-minute change): crossing 180 is "high",
 * crossing 160 "rising", crossing 250 "very_high" (owner 2026-11-15), going under 80 (but not under 70, which is "low") "falling". Each crossing is pushed once,
 * whatever the trend and the repeat window (owner 2026-11-02; 80 owner 2026-11-15).
 */
export function crossedGlucoseKinds(observation: Pick<GlucoseObservation, 'value' | 'delta'>): GlucoseAlertKind[] {
  if (observation.delta === null || !Number.isFinite(observation.delta)) return [];
  const p = GLUCOSE_ALERT_POLICY;
  const previous = observation.value - observation.delta;
  const kinds: GlucoseAlertKind[] = [];
  if (previous <= p.very_high_above && observation.value > p.very_high_above) kinds.push('very_high');
  if (previous <= p.high_above && observation.value > p.high_above) kinds.push('high');
  if (previous <= p.rising_above && observation.value > p.rising_above) kinds.push('rising');
  if (previous >= p.falling_below && observation.value < p.falling_below && observation.value >= p.low_below) kinds.push('falling');
  return kinds;
}

/**
 * The phone's repeat window for a kind, less a minute and a half: readings come every 5 minutes but are judged on the
 * minute tick, so "every 5 minutes" must not miss a reading that was judged a few seconds early.
 */
function repeatMs(kind: GlucoseAlertKind, device: GlucoseAlertDevice): number {
  const p = GLUCOSE_ALERT_POLICY;
  // "Glukoza spada" under 80: each reading that falls by 5 or more; quiet for the low's interval after a low.
  const ms = kind === 'very_low' ? p.very_low_repeat_ms
    : kind === 'low' ? device.low_repeat_minutes * 60_000
    : kind === 'fast_fall' || kind === 'fast_rise' ? p.fast_repeat_ms
    : 5 * 60_000;
  return ms - p.repeat_grace_ms;
}

interface HighRun {
  started_at: number;
  top: number;
  top_at: number;
}

/**
 * The run of readings above 180 that the latest reading belongs to; null when it is not above 180. A dip to 171–180
 * does not end it (the same 10 as a crossing, role review 2026-11-15: 186 → 179 → 185 → 240 said nothing).
 */
export function highRunOf(history: Array<{ at: string; value: number }>): HighRun | null {
  const p = GLUCOSE_ALERT_POLICY;
  const points = history.map((r) => ({ at: Date.parse(r.at), value: r.value })).filter((r) => Number.isFinite(r.at));
  const last = points.at(-1);
  if (!last || last.value <= p.high_above) return null;
  let run: HighRun = { started_at: last.at, top: last.value, top_at: last.at };
  for (let i = points.length - 2; i >= 0; i -= 1) {
    const point = points[i]!;
    if (point.value <= p.high_above - p.crossing_reset || points[i + 1]!.at - point.at > p.run_gap_ms) break;
    // The run starts at its first reading above 180, not at a 171–180 reading before it.
    run = {
      started_at: point.value > p.high_above ? point.at : run.started_at,
      top: point.value > run.top ? point.value : run.top,
      top_at: point.value > run.top ? point.at : run.top_at,
    };
  }
  return run;
}

const CROSSING_THRESHOLD: Partial<Record<GlucoseAlertKind, { at: number; up: boolean }>> = {
  rising: { at: GLUCOSE_ALERT_POLICY.rising_above, up: true },
  high: { at: GLUCOSE_ALERT_POLICY.high_above, up: true },
  very_high: { at: GLUCOSE_ALERT_POLICY.very_high_above, up: true },
  falling: { at: GLUCOSE_ALERT_POLICY.falling_below, up: false },
};

/** Since this phone was last told about the crossing, glucose went 10 back beyond the threshold (or nothing says). */
function crossingReset(kind: GlucoseAlertKind, sent: Partial<Record<GlucoseAlertKind, string>>, history: GlucoseObservation['history']): boolean {
  const threshold = CROSSING_THRESHOLD[kind];
  const told = sentAt(sent, kind);
  if (!threshold || !history || !Number.isFinite(told)) return true;
  const reset = GLUCOSE_ALERT_POLICY.crossing_reset;
  const since = history.filter((r) => Date.parse(r.at) > told);
  // Readings older than the push are gone from the 24 h: nothing to hold it back.
  if (since.length === history.length) return true;
  return since.some((r) => (threshold.up ? r.value <= threshold.at - reset : r.value >= threshold.at + reset));
}

/** The reading nearest `at` within 3 minutes. */
function valueAround(history: Array<{ at: string; value: number }>, at: number): number | null {
  let best: { gap: number; value: number } | null = null;
  for (const reading of history) {
    const gap = Math.abs(Date.parse(reading.at) - at);
    if (gap <= 3 * 60_000 && (!best || gap < best.gap)) best = { gap, value: reading.value };
  }
  return best?.value ?? null;
}

function sentAt(sent: Partial<Record<GlucoseAlertKind, string>>, kind: GlucoseAlertKind): number {
  const at = sent[kind] ? Date.parse(sent[kind] as string) : Number.NaN;
  return Number.isFinite(at) ? at : Number.NEGATIVE_INFINITY;
}

/**
 * The run above 180 on this phone (owner 2026-11-15): "i rośnie" every 15 minutes while it rose by 10 in them, the
 * top once it is past, "nie spada" after an hour without a fall. Only after the phone was told about the run.
 */
function highRunKinds(observation: GlucoseObservation, sent: Partial<Record<GlucoseAlertKind, string>>, now: Date): Array<{ kind: GlucoseAlertKind; detail: GlucosePushDetail }> {
  const p = GLUCOSE_ALERT_POLICY;
  const history = observation.history;
  if (!history || history.length === 0) return [];
  const run = highRunOf(history);
  if (!run) return [];
  const readAt = Date.parse(observation.observed_at);
  const value = observation.value;
  const lastTold = Math.max(...HIGH_TOLD_KINDS.map((kind) => sentAt(sent, kind)));
  if (lastTold < run.started_at) return [];
  const kinds: Array<{ kind: GlucoseAlertKind; detail: GlucosePushDetail }> = [];
  const before = valueAround(history, readAt - p.high_repeat_ms);
  if (before !== null && value - before >= p.still_rising_min && (observation.delta ?? 0) > 0
    && now.getTime() - lastTold >= p.high_repeat_ms - p.repeat_grace_ms) kinds.push({ kind: 'still_rising', detail: { before } });
  if (readAt - run.top_at >= p.peak_quiet_ms && run.top - value >= p.peak_drop && sentAt(sent, 'peak') < run.top_at) {
    kinds.push({ kind: 'peak', detail: { top: run.top } });
  }
  const earlier = valueAround(history, readAt - p.stuck_window_ms);
  const lastStuck = Math.max(sentAt(sent, 'stuck'), run.started_at);
  if (readAt - run.started_at >= p.stuck_after_ms - p.repeat_grace_ms && earlier !== null && earlier - value < p.stuck_drop
    && now.getTime() - lastStuck >= p.stuck_after_ms - p.repeat_grace_ms) {
    kinds.push({ kind: 'stuck', detail: { minutes: Math.floor((readAt - run.started_at) / 300_000) * 5 } });
  }
  return kinds;
}

function sentWithin(sent: Partial<Record<GlucoseAlertKind, string>>, kind: GlucoseAlertKind, windowMs: number, now: Date): boolean {
  const at = sent[kind] ? Date.parse(sent[kind] as string) : Number.NaN;
  return Number.isFinite(at) && now.getTime() - at < windowMs;
}

/**
 * The last mark a gap reached (10, 15, 20, 30, 45, 60…), once its reading had half a minute to arrive; null under 10.
 * The push says this number on any tick, so a gap of 11 minutes reads "od 10 min" (owner 2026-11-06); from 30 minutes
 * the marks are 15 apart (role review 2026-11-15: every 5 minutes for a sensor warming up was 24 pushes per phone).
 */
function noDataMarkMs(ageMs: number): number | null {
  const p = GLUCOSE_ALERT_POLICY;
  const mark = Math.floor((ageMs - p.no_data_grace_ms) / p.no_data_repeat_ms) * p.no_data_repeat_ms;
  if (mark < p.no_data_after_ms) return null;
  if (mark >= p.no_data_slow_from_ms) {
    return p.no_data_slow_from_ms + Math.floor((mark - p.no_data_slow_from_ms) / p.no_data_late_step_ms) * p.no_data_late_step_ms;
  }
  return mark === 25 * 60_000 ? 20 * 60_000 : mark;
}

export function decideGlucoseAlert(state: GlucoseAlertState | null, observation: GlucoseObservation | null, devices: GlucoseAlertDevice[], now: Date): GlucoseAlertDecision {
  const base: NextState = {
    last_reading_at: state?.last_reading_at ?? null,
    sent: state?.sent ?? {},
    no_data_sent_at: state?.no_data_sent_at ?? null,
  };
  // Nothing in the last 24 h: the patient has no sensor data at all, not a gap to warn about.
  if (!observation) return { type: 'none', next: null };

  const readAt = Date.parse(observation.observed_at);
  const age = now.getTime() - readAt;
  if (!Number.isFinite(readAt)) return { type: 'none', next: null };

  const lastJudged = base.last_reading_at ? Date.parse(base.last_reading_at) : Number.NaN;
  const judged = Number.isFinite(lastJudged) && readAt <= lastJudged;
  // A reading not judged yet is judged while it is under 20 minutes old (2026-11-02 audit: one uploaded 12 minutes late
  // gave only "Brak danych", never the low it showed); "Brak danych" waits until it is judged or too old.
  const late = !judged && age < GLUCOSE_ALERT_POLICY.late_reading_max_ms;
  const mark = noDataMarkMs(age);
  if (mark !== null && !late) {
    const lastNoData = base.no_data_sent_at ? Date.parse(base.no_data_sent_at) : Number.NaN;
    // A new sensor after the last reading: one "się rozgrzewa", then quiet until a reading or 2 h after the start.
    const sensorAt = observation.sensor_started_at ? Date.parse(observation.sensor_started_at) : Number.NaN;
    if (Number.isFinite(sensorAt) && sensorAt > readAt && now.getTime() - sensorAt < GLUCOSE_ALERT_POLICY.sensor_warmup_ms) {
      if (Number.isFinite(lastNoData) && lastNoData >= sensorAt) return { type: 'none', next: null };
      return { type: 'no_data', next: { ...base, no_data_sent_at: now.toISOString() }, minutes: mark / 60_000, warmup: true };
    }
    // A push for an older gap (before the reading we have) does not count.
    if (Number.isFinite(lastNoData) && lastNoData > readAt) {
      const toldThisMark = (noDataMarkMs(lastNoData - readAt) ?? 0) >= mark;
      // The first push came late (a reading judged at 14:50): the next one is not half a minute after it.
      const justTold = now.getTime() - lastNoData < GLUCOSE_ALERT_POLICY.no_data_repeat_ms - GLUCOSE_ALERT_POLICY.repeat_grace_ms;
      // After a warm-up push the gap is told from the 2 h on, not again at once for the marks it passed.
      if (toldThisMark || justTold) return { type: 'none', next: null };
    }
    return { type: 'no_data', next: { ...base, no_data_sent_at: now.toISOString() }, minutes: mark / 60_000 };
  }

  if (judged) return { type: 'none', next: null };

  const active = activeGlucoseKinds(observation);
  const crossed = crossedGlucoseKinds(observation);
  const sent: NextState['sent'] = {};
  const pushes: Array<{ device: GlucoseAlertDevice; kind: GlucoseAlertKind }> = [];
  for (const device of devices) {
    const own = { ...(base.sent[device.push_token] ?? {}) };
    // A low told after "Glukoza w zakresie" has no interval left: the next low is news (role review 2026-11-15:
    // 65 → 72 ✅ → 66 stayed quiet for the low's interval).
    const lowOpen = sentWithin(own, 'low', repeatMs('low', device), now) && !(sentAt(own, 'in_range') > sentAt(own, 'low'));
    const due = active.filter((kind) =>
      !device.kinds_off.includes(SETTING_OF[kind])
      && (kind === 'low' ? !lowOpen : !sentWithin(own, kind, repeatMs(kind, device), now))
      && !(kind === 'falling' && lowOpen));
    for (const kind of crossed) {
      if (!device.kinds_off.includes(SETTING_OF[kind]) && !due.includes(kind) && !sentWithin(own, kind, CROSSING_QUIET_MS, now)
        && crossingReset(kind, own, observation.history)) due.push(kind);
    }
    const details: Partial<Record<GlucoseAlertKind, GlucosePushDetail>> = {};
    for (const { kind, detail } of highRunKinds(observation, own, now)) {
      if (device.kinds_off.includes(SETTING_OF[kind]) || due.includes(kind)) continue;
      due.push(kind);
      details[kind] = detail;
    }
    due.sort((a, b) => PRIORITY.indexOf(a) - PRIORITY.indexOf(b));
    // Back in range: this phone was told about a low or a high after its last "Glukoza w zakresie" (no repeat window:
    // once per excursion).
    if (!device.kinds_off.includes('in_range') && backInRange(observation.value, own)) {
      due.push('in_range');
      due.sort((a, b) => PRIORITY.indexOf(a) - PRIORITY.indexOf(b));
    }
    if (due.length > 0) {
      pushes.push({ device, kind: due[0]!, ...(details[due[0]!] ? { detail: details[due[0]!] } : {}) });
      // Every kind due now counts as told: the push says the same, so the next reading does not repeat it. Not "back in
      // range" behind another push (a fast change): it comes on the next reading.
      for (const kind of due) if (kind !== 'in_range' || kind === due[0]) own[kind] = now.toISOString();
    }
    // Only phones still on keep an entry (a phone turned off starts afresh).
    if (Object.keys(own).length > 0) sent[device.push_token] = own;
  }
  const next = { ...base, last_reading_at: observation.observed_at, sent };
  return pushes.length > 0 ? { type: 'glucose', next, pushes } : { type: 'none', next };
}

/**
 * The title is the icon, the glucose (no unit, owner 2026-11-16) and the 5-minute change in brackets ("❗ 65 (−4)", "(0)" when
 * flat); the trend arrow only for a fast change ("⚠️ 140 ⇊ (−19)"). On a phone with several patients the name is the second line (the subtitle). The body
 * is one full sentence about what glucose does, with IOB/COB below: "Glukoza poniżej 70 i spada." +
 * "IOB 1,2 j · COB 15 g" (role review 2026-11-09, table A1–A8). Thresholds come from GLUCOSE_ALERT_POLICY.
 */
export function glucosePushText(kind: GlucoseAlertKind, observation: GlucoseObservation, detail: GlucosePushDetail = {}): { title: string; body: string } {
  const arrow = trendArrow(observation.direction, observation.delta);
  const fastArrow = kind === 'fast_rise' || kind === 'fast_fall' ? arrow : null;
  const delta = formatDelta(observation.delta);
  const reading = [String(Math.round(observation.value)), fastArrow, delta ? `(${delta})` : null].filter(Boolean).join(' ');
  const direction = directionWord(observation.delta, arrow);
  const loop = loopLine(observation);
  const lines = (first: string) => [first, loop].filter(Boolean).join('\n');
  const p = GLUCOSE_ALERT_POLICY;
  switch (kind) {
    case 'fast_rise': return { title: `⚠️ ${reading}`, body: lines('Glukoza szybko rośnie.') };
    case 'fast_fall': return { title: `⚠️ ${reading}`, body: lines('Glukoza szybko spada.') };
    case 'very_low': return { title: `❗ ${reading}`, body: lines(`Glukoza poniżej ${p.very_low_below}${direction ? ` i ${direction}` : ''}.`) };
    case 'low': return { title: `❗ ${reading}`, body: lines(`Glukoza poniżej ${p.low_below}${direction ? ` i ${direction}` : ''}.`) };
    case 'in_range': return { title: `✅ ${reading}`, body: lines('Glukoza wróciła do zakresu.') };
    case 'falling': return { title: `⚠️ ${reading}`, body: lines(`Glukoza poniżej ${p.falling_below} i spada.`) };
    case 'rising': return { title: `⚠️ ${reading}`, body: lines(`Glukoza powyżej ${p.rising_above} i rośnie.`) };
    case 'high': return { title: `⚠️ ${reading}`, body: lines(`Glukoza powyżej ${p.high_above} i rośnie.`) };
    case 'very_high': return { title: `⚠️ ${reading}`, body: lines(`Glukoza powyżej ${p.very_high_above} i rośnie.`) };
    case 'still_rising': {
      const above = observation.value > p.very_high_above ? p.very_high_above : p.high_above;
      // No "15 min temu było 194.": the title's change already says it rises (owner 2026-11-16).
      return { title: `⚠️ ${reading}`, body: lines(`Glukoza powyżej ${above} i rośnie.`) };
    }
    // No icon: good news, and an arrow would read as the trend (owner 2026-11-15).
    case 'peak': return { title: reading, body: lines(`Glukoza spada.${detail.top !== undefined ? ` Najwyżej było ${Math.round(detail.top)}.` : ''}`) };
    case 'stuck': {
      const minutes = detail.minutes ?? 60;
      const check = minutes * 60_000 >= p.stuck_check_site_ms
        ? (observation.value > p.very_high_above ? ' Sprawdź wkłucie i ketony.' : ' Sprawdź wkłucie.')
        : '';
      return { title: `⚠️ ${reading}`, body: lines(`Glukoza ${sinceWords(minutes)} powyżej ${p.high_above} i nie spada.${check}`) };
    }
  }
}

/** "od godziny", "od 1 godz. 15 min", "od 2 godz." */
function sinceWords(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 1 && rest === 0) return 'od godziny';
  if (hours === 0) return `od ${minutes} min`;
  return rest === 0 ? `od ${hours} godz.` : `od ${hours} godz. ${rest} min`;
}

function backInRange(value: number, sent: Partial<Record<GlucoseAlertKind, string>>): boolean {
  if (value < IN_RANGE.min || value > IN_RANGE.max) return false;
  const lastOut = Math.max(...OUT_OF_RANGE_KINDS.map((kind) => (sent[kind] ? Date.parse(sent[kind] as string) : Number.NEGATIVE_INFINITY)));
  if (!Number.isFinite(lastOut)) return false;
  const lastIn = sent.in_range ? Date.parse(sent.in_range) : Number.NEGATIVE_INFINITY;
  return lastOut > lastIn;
}

/** "rośnie" / "spada" by the 5-minute change; with no change (0) by the arrow; null when nothing says. */
function directionWord(delta: number | null, arrow: string | null): 'rośnie' | 'spada' | null {
  const rounded = delta === null || !Number.isFinite(delta) ? 0 : Math.round(delta);
  if (rounded > 0) return 'rośnie';
  if (rounded < 0) return 'spada';
  const trend = trendOf(arrow);
  return trend === 'rising' ? 'rośnie' : trend === 'falling' ? 'spada' : null;
}

/** After a new sensor, instead of "Brak odczytów" (role review 2026-11-15). */
export function sensorWarmupPushText(): { title: string; body: string } {
  return { title: 'Nowy sensor się rozgrzewa', body: 'Powiadomienia o glikemii wrócą z pierwszym odczytem.' };
}

/** Minutes from which the no-data push also asks for a meter reading. */
const NO_DATA_METER_FROM_MINUTES = 30;

/**
 * "Brak odczytów z sensora" + "Ostatni odczyt 15 min temu. Sprawdź sensor i telefon, który odbiera odczyty." (table A9); from 30
 * minutes on also "Zmierz glukozę glukometrem."
 */
export function noDataPushText(minutes: number): { title: string; body: string } {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  const span = hours === 0 ? `${minutes} min` : rest === 0 ? `${hours} godz.` : `${hours} godz. ${rest} min`;
  const sentences = [`Ostatni odczyt ${span} temu.`, 'Sprawdź sensor i telefon, który odbiera odczyty.'];
  if (minutes >= NO_DATA_METER_FROM_MINUTES) sentences.push('Zmierz glukozę glukometrem.');
  return { title: 'Brak odczytów z sensora', body: sentences.join(' ') };
}

function formatDelta(delta: number | null): string | null {
  if (delta === null || !Number.isFinite(delta)) return null;
  const rounded = Math.round(delta);
  if (rounded === 0) return '0';
  return rounded > 0 ? `+${rounded}` : `−${Math.abs(rounded)}`;
}

function loopLine(observation: GlucoseObservation): string | null {
  const parts: string[] = [];
  if (observation.iob_units !== null) parts.push(`IOB ${formatDecimal(observation.iob_units)} j`);
  if (observation.cob_grams !== null) parts.push(`COB ${Math.round(observation.cob_grams)} g`);
  return parts.length ? parts.join(' · ') : null;
}

function formatDecimal(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return (Object.is(rounded, -0) ? 0 : rounded).toFixed(1).replace('.', ',');
}

export interface GlucoseAlertStore {
  listPatientsWithGlucoseAlertDevices(): Promise<string[]>;
  listGlucoseAlertDevices(patientId: string): Promise<GlucoseAlertDevice[]>;
  getState(patientId: string): Promise<GlucoseAlertState | null>;
  /** Stores the state if nobody changed it since `revision` was read (-1: no row yet); false when someone did. */
  saveState(patientId: string, revision: number, next: Omit<GlucoseAlertState, 'patient_id' | 'revision'>): Promise<boolean>;
  deactivatePushToken(pushToken: string): Promise<void>;
  /** A rescue carb alert (or its reminder) for the patient reached a phone at or after `sinceIso`. */
  rescuePushedSince?(patientId: string, sinceIso: string): Promise<boolean>;
}

export interface GlucoseAlertPush {
  sendGlucoseAlert(input: { patientId: string; pushToken: string; kind: string; title: string; body: string }): Promise<void>;
}

function rescueMayCover(device: GlucoseAlertDevice, kind: GlucoseAlertKind): boolean {
  return device.rescue_on === true && RESCUE_COVERED_KINDS.includes(kind);
}

export function observationFromDashboard(dashboard: DashboardResponse): GlucoseObservation | null {
  const glucose = dashboard.glucose;
  if (!glucose) return null;
  return {
    value: glucose.value,
    observed_at: glucose.observed_at,
    direction: glucose.direction,
    delta: glucose.delta,
    iob_units: dashboard.loop?.iob_units ?? null,
    cob_grams: dashboard.loop?.cob_grams ?? null,
    history: dashboard.readings,
    sensor_started_at: dashboard.sensor_started_at,
  };
}

export interface GlucoseAlertRunOptions {
  rescueJudgedAt?: Date;
}

export class GlucoseAlertService {
  constructor(private readonly deps: {
    store: GlucoseAlertStore;
    push: GlucoseAlertPush;
    dashboard: (patientId: string, now: Date) => Promise<DashboardResponse>;
    log: (event: Record<string, unknown>) => void;
  }) {}

  /**
   * `rescueJudgedAt`: the rescue carb alert has judged every reading observed up to then (glucoseReadingSignal), so a
   * low/falling push for such a reading need not wait `rescue_wait_ms`.
   */
  async run(now: Date, options: GlucoseAlertRunOptions = {}): Promise<void> {
    let patients: string[];
    try {
      patients = await this.deps.store.listPatientsWithGlucoseAlertDevices();
    } catch (error) {
      this.deps.log({ event: 'glucose_alerts_unavailable', error_code: errorCode(error) });
      return;
    }
    for (const patientId of patients) {
      try {
        await this.evaluate(patientId, now, options);
      } catch (error) {
        this.deps.log({ event: 'glucose_alert_failed', patient_id: patientId, error_code: errorCode(error) });
      }
    }
  }

  async evaluate(patientId: string, now: Date, options: GlucoseAlertRunOptions = {}): Promise<GlucoseAlertDecision['type']> {
    const observation = observationFromDashboard(await this.deps.dashboard(patientId, now));
    const [state, devices] = await Promise.all([this.deps.store.getState(patientId), this.deps.store.listGlucoseAlertDevices(patientId)]);
    const decision = decideGlucoseAlert(state, observation, devices, now);
    if (!decision.next) return 'none';
    // Judged on a later tick (nothing claimed): the rescue alert for this reading goes first. Once the rescue alert has
    // judged the reading (signal after the sync), there is nothing left to wait for (glucose-push-fast, 2026-11-14).
    const rescueJudged = Boolean(observation && options.rescueJudgedAt
      && options.rescueJudgedAt.getTime() >= Date.parse(observation.observed_at));
    if (decision.type === 'glucose' && observation && !rescueJudged && decision.pushes.some(({ device, kind }) => rescueMayCover(device, kind))
      && now.getTime() - Date.parse(observation.observed_at) < GLUCOSE_ALERT_POLICY.rescue_wait_ms) return 'none';
    // The claim comes first: a second worker (or this one after a restart) sees the reading as judged already.
    if (!(await this.deps.store.saveState(patientId, state?.revision ?? -1, decision.next))) return 'none';
    if (decision.type === 'none') return 'none';

    const mayCover = decision.type === 'glucose' ? decision.pushes.filter(({ device, kind }) => rescueMayCover(device, kind)) : [];
    const readAt = observation ? Date.parse(observation.observed_at) : Number.NaN;
    const rescueSent = mayCover.length > 0
      ? await this.rescuePushedSince(patientId, new Date(readAt - GLUCOSE_ALERT_POLICY.rescue_overlap_ms).toISOString())
      : false;
    // "Poniżej 80" is left out only for the rescue alert of this very reading: one from a reading before says a low may
    // come, not where glucose is now (owner 2026-11-15: 85 → 74 four minutes after a predicted-low alert said nothing).
    const rescueSentForReading = rescueSent && mayCover.some(({ kind }) => kind === 'falling')
      ? await this.rescuePushedSince(patientId, new Date(readAt).toISOString())
      : false;
    const covered = rescueSent ? mayCover.filter(({ kind }) => kind !== 'falling' || rescueSentForReading) : [];
    if (covered.length > 0) this.deps.log({ event: 'glucose_alert_left_to_rescue', patient_id: patientId, devices: covered.map(({ device, kind }) => ({ device_id: device.device_id, kind })) });
    const pushes = decision.type === 'no_data'
      ? devices.filter((device) => !device.kinds_off.includes('no_data')).map((device) => ({ device, kind: 'no_data', text: decision.warmup ? sensorWarmupPushText() : noDataPushText(decision.minutes) }))
      : decision.pushes.filter((push) => !covered.includes(push)).map(({ device, kind, detail }) => ({ device, kind, text: withReadingAge(glucosePushText(kind, observation as GlucoseObservation, detail), observation as GlucoseObservation, now) }));
    const sent: Array<{ device_id: string; kind: string }> = [];
    const failed: GlucoseAlertDevice[] = [];
    for (const { device, kind, text } of pushes) {
      try {
        await this.deps.push.sendGlucoseAlert({ patientId, pushToken: device.push_token, kind, ...text });
        sent.push({ device_id: device.device_id, kind });
      } catch (error) {
        // Only Apple's "this token is gone" (410) stops the phone; a 400 can be this server's setup (wrong topic) and
        // the phone would get nothing until its app is opened again (audit 2026-11-02).
        const gone = error instanceof PushNotificationProviderError && error.code === 'DEVICE_TOKEN_UNREGISTERED';
        if (gone) await this.deps.store.deactivatePushToken(device.push_token).catch(() => undefined);
        else failed.push(device);
        this.deps.log({ event: 'glucose_alert_send_failed', patient_id: patientId, device_id: device.device_id, kind, error_code: errorCode(error) });
      }
    }
    // A failed send is tried again on the next minute while the reading is fresh: the claim is taken back for the phones
    // it did not reach (2026-11-02 audit: the claim came first and a lost low waited for the repeat window).
    if (failed.length > 0) await this.releaseClaim(patientId, state, decision.next, failed);
    this.deps.log({
      event: 'glucose_alert_sent',
      patient_id: patientId,
      type: decision.type,
      ...(decision.type === 'glucose' ? { value: observation?.value, direction: observation?.direction } : { minutes: decision.minutes }),
      devices: devices.length,
      sent,
    });
    return decision.type;
  }

  /** A failed read sends the glucose push: two alarms are better than none. */
  private async rescuePushedSince(patientId: string, sinceIso: string): Promise<boolean> {
    if (!this.deps.store.rescuePushedSince) return false;
    try {
      return await this.deps.store.rescuePushedSince(patientId, sinceIso);
    } catch (error) {
      this.deps.log({ event: 'glucose_alert_rescue_read_failed', patient_id: patientId, error_code: errorCode(error) });
      return false;
    }
  }

  /** Gives the failed phones their previous state back and leaves the reading unjudged, so the next tick retries them. */
  private async releaseClaim(patientId: string, state: GlucoseAlertState | null, claimed: NonNullable<GlucoseAlertDecision['next']>, failed: GlucoseAlertDevice[]): Promise<void> {
    const sent = { ...claimed.sent };
    for (const device of failed) {
      const previous = state?.sent[device.push_token];
      if (previous) sent[device.push_token] = previous;
      else delete sent[device.push_token];
    }
    // The phones that got it keep their times, so the retry repeats nothing to them (repeat window, crossing quiet time).
    const next = { ...claimed, sent, last_reading_at: state?.last_reading_at ?? null, no_data_sent_at: state?.no_data_sent_at ?? null };
    const revision = state ? state.revision + 1 : 0;
    const saved = await this.deps.store.saveState(patientId, revision, next).catch(() => false);
    if (!saved) this.deps.log({ event: 'glucose_alert_retry_not_saved', patient_id: patientId });
  }
}

/** "Pomiar sprzed 12 min." under a reading that reached the server late. */
export function withReadingAge(text: { title: string; body: string }, observation: GlucoseObservation, now: Date): { title: string; body: string } {
  const minutes = Math.floor((now.getTime() - Date.parse(observation.observed_at)) / 60_000);
  if (!Number.isFinite(minutes) || minutes < GLUCOSE_ALERT_POLICY.no_data_after_ms / 60_000) return text;
  return { ...text, body: `${text.body}\nPomiar sprzed ${minutes} min.` };
}

function errorCode(error: unknown): string {
  if (error instanceof PushNotificationProviderError) return error.code;
  if (error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string') return (error as { code: string }).code;
  return 'UNKNOWN';
}
