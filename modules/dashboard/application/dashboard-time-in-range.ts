import { TIR_VERY_LOW_BELOW_MGDL } from '@shared/primitives/glucose-rules';
/**
 * The time-in-range breakdown over several days (the dashboard's tile covers 24 h from its own readings): readings in
 * five bands and how much of the period the sensor delivered. The app turns the counts into percentages and targets.
 */
import type { DashboardGlucoseReading } from './dashboard-snapshot';

/** The periods the breakdown offers. */
export const DASHBOARD_TIME_IN_RANGE_DAYS = [1, 7, 14] as const;
export type DashboardTimeInRangeDays = typeof DASHBOARD_TIME_IN_RANGE_DAYS[number];

/** A sensor slot: one reading in it counts the slot as covered (1-minute and 5-minute CGMs alike). */
const SLOT_MS = 5 * 60_000;

export interface DashboardTimeInRangeResponse {
  patient_id: string;
  days: DashboardTimeInRangeDays;
  from: string;
  to: string;
  readings_count: number;
  /** mg/dL, as on the app's breakdown: < 55, 55–69, 70–180, 181–250, > 250. */
  counts: { very_low: number; low: number; in_range: number; high: number; very_high: number };
  /** Share of the period's 5-minute slots with a reading. */
  sensor_coverage_percent: number;
}

export function parseDashboardTimeInRangeDays(raw: unknown): DashboardTimeInRangeDays | string {
  const days = typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : NaN;
  return (DASHBOARD_TIME_IN_RANGE_DAYS as readonly number[]).includes(days)
    ? days as DashboardTimeInRangeDays
    : 'days must be 1, 7 or 14';
}

export function buildDashboardTimeInRange(input: {
  patientId: string;
  days: DashboardTimeInRangeDays;
  now: Date;
  readings: DashboardGlucoseReading[];
}): DashboardTimeInRangeResponse {
  const toMs = input.now.getTime();
  const fromMs = toMs - input.days * 24 * 3_600_000;
  const counts = { very_low: 0, low: 0, in_range: 0, high: 0, very_high: 0 };
  const seen = new Set<number>();
  const slots = new Set<number>();
  for (const reading of input.readings) {
    const time = Date.parse(reading.at);
    // Two uploaders (or a re-import) can store the same reading twice; one per timestamp counts.
    if (!Number.isFinite(time) || time < fromMs || time > toMs || seen.has(time)) continue;
    if (!Number.isFinite(reading.value) || reading.value <= 0) continue;
    seen.add(time);
    slots.add(Math.floor((time - fromMs) / SLOT_MS));
    const value = Math.round(reading.value);
    if (value < TIR_VERY_LOW_BELOW_MGDL) counts.very_low += 1;
    else if (value < 70) counts.low += 1;
    else if (value <= 180) counts.in_range += 1;
    else if (value <= 250) counts.high += 1;
    else counts.very_high += 1;
  }
  const totalSlots = Math.ceil((toMs - fromMs) / SLOT_MS);
  return {
    patient_id: input.patientId,
    days: input.days,
    from: new Date(fromMs).toISOString(),
    to: new Date(toMs).toISOString(),
    readings_count: seen.size,
    counts,
    sensor_coverage_percent: Math.min(100, Math.round((slots.size * 100) / totalSlots)),
  };
}
