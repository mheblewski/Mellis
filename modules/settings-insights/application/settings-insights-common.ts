/**
 * Shared helpers of the settings-insights analysis: local time of the patient, schedule lookups, the insulin curve,
 * pump-step rounding and simple statistics. Pure functions, no I/O.
 */
import type { Confidence, DayWindow, ScheduleEntry, SettingsInsightsInput, TherapyPeriod, TherapySchedules } from './settings-insights-types';
import type { SettingsInsightsThresholds } from './settings-insights-thresholds';

export const MINUTE_MS = 60_000;
export const SLOT_MS = 5 * MINUTE_MS;
export const DAY_MINUTES = 1440;

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timezone: string): Intl.DateTimeFormat {
  let found = formatters.get(timezone);
  if (!found) {
    found = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    formatters.set(timezone, found);
  }
  return found;
}

/** Local date (YYYY-MM-DD) and minute of the day (0–1439) of an instant in the patient's timezone (DST included). */
export function localParts(ms: number, timezone: string): { date: string; minute: number; weekday: number } {
  const parts = formatter(timezone).formatToParts(new Date(ms));
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '00';
  const date = `${get('year')}-${get('month')}-${get('day')}`;
  const minute = Number(get('hour')) * 60 + Number(get('minute'));
  // Weekday of the local date (0 = Sunday), computed from the date itself so it does not depend on the host zone.
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
  return { date, minute, weekday };
}

export function localMinute(ms: number, timezone: string): number { return localParts(ms, timezone).minute; }

/** The instant of a local wall-clock time (first match on a DST fold, next valid minute in a gap). */
export function localInstant(date: string, minute: number, timezone: string): number {
  const [year, month, day] = date.split('-').map(Number);
  let guess = Date.UTC(year, month - 1, day, Math.floor(minute / 60), minute % 60);
  // Two passes of offset correction converge for every real timezone.
  for (let pass = 0; pass < 3; pass += 1) {
    const local = localParts(guess, timezone);
    const [ly, lm, ld] = local.date.split('-').map(Number);
    const diffMinutes = (Date.UTC(ly, lm - 1, ld) - Date.UTC(year, month - 1, day)) / MINUTE_MS + (local.minute - minute);
    if (diffMinutes === 0) break;
    guess -= diffMinutes * MINUTE_MS;
  }
  return guess;
}

/** Local dates (YYYY-MM-DD) whose midnight falls in [fromMs, toMs). */
export function localDates(fromMs: number, toMs: number, timezone: string): string[] {
  const dates: string[] = [];
  let date = localParts(fromMs, timezone).date;
  for (let guard = 0; guard < 400; guard += 1) {
    const start = localInstant(date, 0, timezone);
    if (start >= toMs) break;
    if (start >= fromMs) dates.push(date);
    const next = new Date(`${date}T12:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    date = next.toISOString().slice(0, 10);
  }
  return dates;
}

export function scheduleValue(schedule: ScheduleEntry[], minute: number): number | null {
  if (schedule.length === 0) return null;
  const sorted = [...schedule].sort((a, b) => a.minute - b.minute);
  let value = sorted[0].value;
  for (const entry of sorted) if (minute >= entry.minute) value = entry.value;
  return value;
}

/** The schedule's blocks as day windows with their values (the last block ends at 1440). */
export function scheduleBlocks(schedule: ScheduleEntry[]): Array<DayWindow & { value: number }> {
  const sorted = [...schedule].sort((a, b) => a.minute - b.minute);
  if (sorted.length === 0) return [];
  if (sorted[0].minute !== 0) sorted.unshift({ minute: 0, value: sorted[sorted.length - 1].value });
  return sorted.map((entry, index) => ({ startMinute: entry.minute, endMinute: index + 1 < sorted.length ? sorted[index + 1].minute : DAY_MINUTES, value: entry.value }));
}

export function therapyAt(therapies: TherapyPeriod[], ms: number): TherapySchedules | null {
  let best: TherapyPeriod | null = null;
  for (const period of therapies) {
    if (period.fromMs <= ms && (period.toMs === null || period.toMs > ms) && (!best || period.fromMs > best.fromMs)) best = period;
  }
  return best?.schedules ?? null;
}

export function scheduledBasalAt(input: SettingsInsightsInput, ms: number): number | null {
  const therapy = therapyAt(input.therapies, ms);
  return therapy ? scheduleValue(therapy.basal, localMinute(ms, input.timezone)) : null;
}

/** The basal oref sized maxBolus from in a cycle: the profile basal × the cycle's autosens ratio. */
export function cycleBasal(input: SettingsInsightsInput, cycle: { ms: number; autosensRatio?: number | null }): number | null {
  const basal = scheduledBasalAt(input, cycle.ms);
  return basal === null ? null : basal * (cycle.autosensRatio && cycle.autosensRatio > 0 ? cycle.autosensRatio : 1);
}

export function inWindow(minute: number, window: DayWindow): boolean {
  return window.startMinute <= window.endMinute
    ? minute >= window.startMinute && minute < window.endMinute
    : minute >= window.startMinute || minute < window.endMinute;
}

/**
 * Minutes until `share` of a dose has acted on the oref exponential curve (Trio's "rapid-acting" peak 75 min) for the
 * profile's DIA. Owner decision 2026-10-31: the lows gate of a proposal reaches until 90 % of the extra insulin has acted
 * (DIA 5 h → 3.4 h), not a fixed 3 h, and follows a DIA change.
 */
export function insulinActionMinutes(diaHours: number, share = 0.9, peakMinutes = 75): number {
  const end = Math.max(diaHours * 60, 2 * peakMinutes + 1);
  const tau = (peakMinutes * (1 - peakMinutes / end)) / (1 - (2 * peakMinutes) / end);
  const a = (2 * tau) / end;
  const s = 1 / (1 - a + (1 + a) * Math.exp(-end / tau));
  // Insulin used by t: 1 − IOB(t) of the same curve.
  const used = (t: number) => 1 - (1 - s * (1 - a) * ((t * t / (tau * end * (1 - a)) - t / tau - 1) * Math.exp(-t / tau) + 1));
  for (let t = 0; t <= end; t += 1) if (used(t) >= share) return t;
  return Math.round(end);
}

/** A window grown by `minutes` after its end (wrapping past midnight). */
export function withBuffer(window: DayWindow, minutes: number): DayWindow {
  const end = window.endMinute + minutes;
  if (window.startMinute === 0 && window.endMinute === DAY_MINUTES) return window;
  return end - window.startMinute >= DAY_MINUTES ? { startMinute: 0, endMinute: DAY_MINUTES } : { startMinute: window.startMinute, endMinute: end % DAY_MINUTES === 0 ? DAY_MINUTES : end % DAY_MINUTES };
}

export function windowsOverlap(a: DayWindow, b: DayWindow): boolean {
  for (let minute = 0; minute < DAY_MINUTES; minute += 5) if (inWindow(minute, a) && inWindow(minute, b)) return true;
  return false;
}

/** Fraction of a dose still active after `minutes` (oref exponential curve, peak 75 min, DIA hours). */
export function insulinActiveFraction(minutes: number, diaHours = 6, peakMinutes = 75): number {
  const dia = diaHours * 60;
  if (minutes <= 0) return 1;
  if (minutes >= dia) return 0;
  const tau = (peakMinutes * (1 - peakMinutes / dia)) / (1 - (2 * peakMinutes) / dia);
  const a = (2 * tau) / dia;
  const s = 1 / (1 - a + (1 + a) * Math.exp(-dia / tau));
  return 1 - s * (1 - a) * (((minutes ** 2 / (tau * dia * (1 - a))) - minutes / tau - 1) * Math.exp(-minutes / tau) + 1);
}

/** Bolus + SMB insulin still active at `ms` (not net IOB: temp basals are left out on purpose, v5 §7.4). */
export function bolusSmbActiveAt(input: SettingsInsightsInput, ms: number, diaHours = 6): number {
  let total = 0;
  for (const dose of [...input.boluses, ...input.smbs]) {
    if (dose.ms > ms || dose.ms < ms - diaHours * 60 * MINUTE_MS) continue;
    total += dose.units * insulinActiveFraction((ms - dose.ms) / MINUTE_MS, diaHours);
  }
  return total;
}

export function bolusSmbBetween(input: SettingsInsightsInput, fromMs: number, toMs: number): number {
  let total = 0;
  for (const dose of [...input.boluses, ...input.smbs]) if (dose.ms >= fromMs && dose.ms < toMs) total += dose.units;
  return total;
}

/**
 * Basal the pump delivered vs the profile over [fromMs, toMs), in units, minute by minute: the latest temp basal runs
 * until its duration ends or the next temp replaces it; otherwise the profile basal.
 */
export function deliveredBasal(input: SettingsInsightsInput, fromMs: number, toMs: number): { delivered: number; scheduled: number; zeroMinutes: number; minutes: number } {
  const temps = input.tempBasals.filter((temp) => temp.ms < toMs && temp.ms + temp.durationMinutes * MINUTE_MS > fromMs - 6 * 60 * MINUTE_MS).sort((a, b) => a.ms - b.ms);
  let delivered = 0;
  let scheduled = 0;
  let zeroMinutes = 0;
  let minutes = 0;
  let index = 0;
  let active: typeof temps[number] | null = null;
  for (let ms = fromMs; ms < toMs; ms += MINUTE_MS) {
    while (index < temps.length && temps[index].ms <= ms) { active = temps[index]; index += 1; }
    const profile = scheduledBasalAt(input, ms);
    if (profile === null) continue;
    const rate = active && ms < active.ms + active.durationMinutes * MINUTE_MS ? active.rate : profile;
    delivered += rate / 60;
    scheduled += profile / 60;
    if (rate <= 0) zeroMinutes += 1;
    minutes += 1;
  }
  return { delivered, scheduled, zeroMinutes, minutes };
}

/** Round toward the current value (smaller change) to the pump step. */
export function roundTowards(value: number, current: number, step: number): number {
  const steps = value / step;
  const rounded = value < current ? Math.ceil(steps - 1e-9) : Math.floor(steps + 1e-9);
  return Math.round(rounded * step * 1000) / 1000;
}

/**
 * Trio's SMB cap of an hour as oref computes it: maxBolus = round(basal × minutes / 60, 0.1), then the dose is floored
 * to the pump step. 0.05 U/h × 30/60 = 0.025 → 0 (no SMB); × 60/60 = 0.05 → 0.1.
 */
export function smbCap(basal: number, maxSmbBasalMinutes: number, step: number): number {
  const maxBolus = Math.round((basal * maxSmbBasalMinutes) / 60 * 10 + 1e-9) / 10;
  return Math.round(Math.floor(maxBolus / step + 1e-9) * step * 1000) / 1000;
}

export function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const index = (sorted.length - 1) * p;
  const low = Math.floor(index);
  const high = Math.ceil(index);
  return sorted[low] + (sorted[high] - sorted[low]) * (index - low);
}

export function median(values: number[]): number | null {
  return percentile([...values].sort((a, b) => a - b), 0.5);
}

export function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** Minutes with readings below/above a limit in [fromMs, toMs) (each reading counts up to 5 minutes). */
export function minutesWhere(readings: Array<{ ms: number; value: number }>, fromMs: number, toMs: number, predicate: (value: number) => boolean): number {
  let minutes = 0;
  for (const reading of readings) if (reading.ms >= fromMs && reading.ms < toMs && predicate(reading.value)) minutes += 5;
  return minutes;
}

/** The longest run (minutes) of consecutive readings matching the predicate in [fromMs, toMs). */
export function longestRun(readings: Array<{ ms: number; value: number }>, fromMs: number, toMs: number, predicate: (value: number) => boolean): number {
  let best = 0;
  let runStart: number | null = null;
  let last: number | null = null;
  for (const reading of readings) {
    if (reading.ms < fromMs || reading.ms >= toMs) continue;
    if (predicate(reading.value)) {
      // A sensor gap over 15 minutes ends the run: missing data is never part of an event.
      if (runStart === null || (last !== null && reading.ms - last > 15 * MINUTE_MS)) runStart = reading.ms;
      best = Math.max(best, (reading.ms - runStart) / MINUTE_MS + 5);
    } else {
      runStart = null;
    }
    last = reading.ms;
  }
  return best;
}

/**
 * Confidence from n qualifying situations and the share pointing the same way (v5 §7.3): GOOD n ≥ 8 and ≥ 70 %,
 * MODERATE n 5–7 (or n ≥ 8 with lower consistency but still a majority), LOW otherwise.
 */
export function confidenceFor(n: number, consistency: number, thresholds: SettingsInsightsThresholds): Confidence {
  const { good, moderate } = thresholds.confidence;
  if (n >= good.minN && consistency >= good.minConsistency) return 'GOOD';
  if (n >= moderate.minN && consistency > 0.5) return 'MODERATE';
  return 'LOW';
}

/**
 * The value to propose: the wanted relative change capped by the confidence (GOOD up to 20 %, MODERATE exactly 10 %),
 * rounded to the step toward the current value. When rounding makes the change larger than allowed, or rounds it away,
 * null (the caller may then propose a half-block segment).
 */
export function proposedValue(current: number, wantedRelative: number, confidence: Confidence, step: number, thresholds: SettingsInsightsThresholds): { to: number; relative: number } | null {
  if (confidence === 'LOW' || current <= 0 || wantedRelative === 0) return null;
  const cap = confidence === 'GOOD' ? thresholds.confidence.good.maxStep : thresholds.confidence.moderate.step;
  const relative = confidence === 'GOOD' ? Math.sign(wantedRelative) * Math.min(Math.abs(wantedRelative), cap) : Math.sign(wantedRelative) * cap;
  const to = roundTowards(current * (1 + relative), current, step);
  if (to === current || to <= 0) return null;
  const actual = (to - current) / current;
  if (Math.abs(actual) > cap + 1e-9) return null;
  return { to, relative: round(actual, 3) };
}
