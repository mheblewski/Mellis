/**
 * CGM readings and their short-term trend (glucose-forecast.v1): cleaning, oref's deltas, and the linear projection
 * used when the loop's own forecast is missing or stale.
 */

export interface GlucosePoint {
  at: string;
  value: number;
}

/** Readings at or below this are sensor errors (CGMs report 39 / "LOW" as the floor). */
const MIN_VALID_MGDL = 38;
/** Readings up to this far in the future are kept (clock skew between the phone and the server). */
const FUTURE_TOLERANCE_MS = 60_000;
/** A projection is never taken lower than this (CGM floor). */
export const CGM_FLOOR_MGDL = 39;

/**
 * Valid readings at or before now, oldest first. By default one reading per timestamp (the first one given);
 * `keep_duplicates` keeps them all in a stable sort, as the meal card has since meal-dose-forecast.v2.
 */
export function cleanReadings(readings: GlucosePoint[], now: Date, options: { keep_duplicates?: boolean } = {}): GlucosePoint[] {
  const limitMs = now.getTime() + FUTURE_TOLERANCE_MS;
  if (options.keep_duplicates) {
    return [...readings]
      .filter((reading) => Number.isFinite(Date.parse(reading.at)) && Date.parse(reading.at) <= limitMs && reading.value > MIN_VALID_MGDL)
      .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  }
  return dedupeReadings(readings).filter((reading) => Date.parse(reading.at) <= limitMs && reading.value > MIN_VALID_MGDL);
}

function dedupeReadings(readings: GlucosePoint[]): GlucosePoint[] {
  const byTime = new Map<number, GlucosePoint>();
  for (const reading of readings) {
    const time = Date.parse(reading.at);
    if (Number.isFinite(time) && Number.isFinite(reading.value) && !byTime.has(time)) byTime.set(time, { at: new Date(time).toISOString(), value: reading.value });
  }
  return [...byTime.entries()].sort((a, b) => a[0] - b[0]).map(([, reading]) => reading);
}

/** Against the reading closest to 5 min earlier (3–8 min), scaled to 5 min. */
export function deltaPerFiveMinutes(readings: GlucosePoint[]): number | null {
  const latest = readings.at(-1);
  if (!latest) return null;
  const latestMs = Date.parse(latest.at);
  let best: { reading: GlucosePoint; minutes: number } | null = null;
  for (const reading of readings.slice(0, -1)) {
    const minutes = (latestMs - Date.parse(reading.at)) / 60_000;
    if (minutes < 3 || minutes > 8) continue;
    if (!best || Math.abs(minutes - 5) < Math.abs(best.minutes - 5)) best = { reading, minutes };
  }
  return best ? Math.round(((latest.value - best.reading.value) * 5) / best.minutes) : null;
}

/** oref's short_avgdelta: the average change per minute against each reading 2.5–17.5 min before the newest one. */
export function shortAverageSlope(readings: GlucosePoint[]): number | null {
  const latest = readings.at(-1);
  if (!latest) return null;
  const latestMs = Date.parse(latest.at);
  const slopes = readings.slice(0, -1)
    .map((reading) => ({ reading, minutes: (latestMs - Date.parse(reading.at)) / 60_000 }))
    .filter(({ minutes }) => minutes >= 2.5 && minutes <= 17.5)
    .map(({ reading, minutes }) => (latest.value - reading.value) / minutes);
  return slopes.length > 0 ? slopes.reduce((sum, value) => sum + value, 0) / slopes.length : null;
}

/** The last two reading-to-reading changes are both negative (needs three readings). */
export function lastTwoFalling(readings: GlucosePoint[]): boolean {
  const last = readings.slice(-3);
  return last.length === 3 && last.slice(1).every((reading, index) => reading.value < last[index].value);
}

/** Glucose + slope × minutes, rounded, never below the CGM floor. */
export function projectLinear(glucose: number, slopePerMinute: number, minutes: number): number {
  return Math.max(CGM_FLOOR_MGDL, Math.round(glucose + slopePerMinute * minutes));
}
