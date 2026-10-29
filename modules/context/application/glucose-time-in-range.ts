import { TIR_VERY_LOW_BELOW_MGDL } from '@shared/primitives/glucose-rules';

/**
 * Time in ranges of CGM readings (mg/dL, the app's bands as on the dashboard): very low < 55, low 55-69, in range 70-180,
 * high 181-250, very high > 250. Percentages are shares of the readings, so gaps in the sensor data do not count;
 * `cgm_coverage_percent` says how much of the range the readings cover (one reading every 5 minutes is 100%).
 */
export const GLUCOSE_TIME_IN_RANGE_POLICY_VERSION = 'glucose-time-in-range.v2';

const VERY_LOW_BELOW_MG_DL = TIR_VERY_LOW_BELOW_MGDL;
const LOW_BELOW_MG_DL = 70;
const HIGH_ABOVE_MG_DL = 180;
const VERY_HIGH_ABOVE_MG_DL = 250;
const CGM_INTERVAL_MINUTES = 5;

export interface GlucoseTimeInRange {
  policy_version: string;
  target_mg_dl: { low: number; high: number };
  readings_count: number;
  /** Share of the range covered by readings; null when the range length is unknown. */
  cgm_coverage_percent: number | null;
  very_low_percent: number;
  low_percent: number;
  in_range_percent: number;
  high_percent: number;
  very_high_percent: number;
  /** below_range = very_low + low (TBR), above_range = high + very_high (TAR). */
  below_range_percent: number;
  above_range_percent: number;
}

export function computeGlucoseTimeInRange(
  values: readonly number[],
  range: { from: string; to: string } | null = null,
): GlucoseTimeInRange | null {
  const readings = values.filter((value) => Number.isFinite(value) && value > 0);
  const count = (predicate: (value: number) => boolean) => readings.filter(predicate).length;
  const veryLow = count((value) => value < VERY_LOW_BELOW_MG_DL);
  const low = count((value) => value >= VERY_LOW_BELOW_MG_DL && value < LOW_BELOW_MG_DL);
  const high = count((value) => value > HIGH_ABOVE_MG_DL && value <= VERY_HIGH_ABOVE_MG_DL);
  const veryHigh = count((value) => value > VERY_HIGH_ABOVE_MG_DL);
  return computeGlucoseTimeInRangeFromBands(
    { very_low: veryLow, low, in_range: readings.length - veryLow - low - high - veryHigh, high, very_high: veryHigh },
    range,
  );
}

/** The same from readings already counted per band (an aggregate over a whole range, e.g. in SQL). */
export function computeGlucoseTimeInRangeFromBands(
  bands: { very_low: number; low: number; in_range: number; high: number; very_high: number },
  range: { from: string; to: string } | null = null,
): GlucoseTimeInRange | null {
  const total = bands.very_low + bands.low + bands.in_range + bands.high + bands.very_high;
  if (!(total > 0)) {
    return null;
  }

  const percent = (part: number) => Math.round((part * 1000) / total) / 10;
  const rangeMinutes = range ? (Date.parse(range.to) - Date.parse(range.from)) / 60_000 : NaN;
  const coverage = Number.isFinite(rangeMinutes) && rangeMinutes > 0
    ? Math.min(100, Math.round((total * CGM_INTERVAL_MINUTES * 1000) / rangeMinutes) / 10)
    : null;

  return {
    policy_version: GLUCOSE_TIME_IN_RANGE_POLICY_VERSION,
    target_mg_dl: { low: LOW_BELOW_MG_DL, high: HIGH_ABOVE_MG_DL },
    readings_count: total,
    cgm_coverage_percent: coverage,
    very_low_percent: percent(bands.very_low),
    low_percent: percent(bands.low),
    in_range_percent: percent(bands.in_range),
    high_percent: percent(bands.high),
    very_high_percent: percent(bands.very_high),
    below_range_percent: percent(bands.very_low + bands.low),
    above_range_percent: percent(bands.high + bands.very_high),
  };
}
