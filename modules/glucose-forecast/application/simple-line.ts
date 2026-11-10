import type { GlucosePoint } from './cgm-trend';

/**
 * The simple line (prediction-engine stage 3): the last 15 min's trend, fading, plus a pull towards the patient's own
 * usual glucose, with no insulin or carbs in it. On the backtest (one patient, offline, 23 days of loop curves) it beat
 * the loop's main curve on every day at +30 and +60. It compresses extremes: when glucose really ends below 70 at +30 it
 * is about 30 mg/dL too high, so it is for looking at only, never for doses or alerts.
 *
 *   change at h = reversion_h × (glucose − 110) + trend_h × slope × gain_h + constant_h
 */
export const SIMPLE_LINE_MODEL_ID = 'simple-line.v1';
export const LINE_HORIZONS = [15, 30, 45, 60, 75, 90] as const;
export type LineHorizon = (typeof LINE_HORIZONS)[number];

const REFERENCE_MGDL = 110;
const TREND_FADE = 0.8;
const CLAMP = { low: 39, high: 401 };
/** A band that says "most of the time": the absolute error 80% of past predictions stayed within. */
const COVERAGE = 0.8;

export const SIMPLE_LINE_FIT = {
  window_days: 45,
  min_days: 14,
  min_rows: 2_000,
  /** Fan widths come from these last days, predicted with coefficients fitted before them. */
  width_days: 14,
  min_width_rows: 200,
  after_carbs_minutes: 240,
  max_target_gap_minutes: 10,
  /** Outside these the data says something odd about this patient: that horizon keeps the default. */
  reversion: { min: -1.2, max: 0 },
  trend: { min: 0, max: 1.2 },
  constant: { min: -60, max: 60 },
} as const;

export interface LineCoefficients {
  reversion: number;
  trend: number;
  constant: number;
  /** Half the fan's width, mg/dL: glucose stays within it about 80% of the time. */
  width_no_carbs: number;
  width_after_carbs: number;
}

export interface SimpleLineParams {
  model_id: string;
  source: 'DEFAULT' | 'FITTED';
  fitted_at: string | null;
  days: number | null;
  horizons: Record<LineHorizon, LineCoefficients>;
}

/** Until a patient has their own fit. From the offline backtest, rounded; the fans are wide on purpose. */
export const DEFAULT_SIMPLE_LINE: SimpleLineParams = {
  model_id: SIMPLE_LINE_MODEL_ID,
  source: 'DEFAULT',
  fitted_at: null,
  days: null,
  horizons: {
    15: { reversion: -0.11, trend: 0.69, constant: 3.3, width_no_carbs: 18, width_after_carbs: 22 },
    30: { reversion: -0.26, trend: 0.68, constant: 8.2, width_no_carbs: 28, width_after_carbs: 38 },
    45: { reversion: -0.43, trend: 0.61, constant: 13.5, width_no_carbs: 38, width_after_carbs: 50 },
    60: { reversion: -0.59, trend: 0.54, constant: 18.4, width_no_carbs: 45, width_after_carbs: 60 },
    75: { reversion: -0.71, trend: 0.42, constant: 22.2, width_no_carbs: 50, width_after_carbs: 66 },
    90: { reversion: -0.82, trend: 0.32, constant: 25.7, width_no_carbs: 55, width_after_carbs: 70 },
  },
};

function trendGain(horizon: number): number {
  return (5 * TREND_FADE * (1 - TREND_FADE ** (horizon / 5))) / (1 - TREND_FADE);
}

function clamp(value: number): number {
  return Math.min(CLAMP.high, Math.max(CLAMP.low, value));
}

/** mg/dL per minute: the straight line through the last 15 min's readings, oldest first; null with fewer than three. */
export function regressionSlope(minutes: ArrayLike<number>, values: ArrayLike<number>, from: number, to: number): number | null {
  const count = to - from + 1;
  if (count < 3) return null;
  let sumX = 0;
  let sumY = 0;
  for (let i = from; i <= to; i += 1) {
    sumX += minutes[i];
    sumY += values[i];
  }
  const meanX = sumX / count;
  const meanY = sumY / count;
  let top = 0;
  let bottom = 0;
  for (let i = from; i <= to; i += 1) {
    const dx = minutes[i] - meanX;
    top += dx * (values[i] - meanY);
    bottom += dx * dx;
  }
  return bottom > 0 ? top / bottom : null;
}

export interface LinePoint {
  at: string;
  value: number;
  low: number;
  high: number;
}

export function predictSimpleLine(input: { readings: GlucosePoint[]; params: SimpleLineParams; after_carbs: boolean }): { points: LinePoint[]; slope_per_min: number } | null {
  const readings = [...input.readings].filter((reading) => Number.isFinite(Date.parse(reading.at))).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const latest = readings.at(-1);
  if (!latest) return null;
  const latestMs = Date.parse(latest.at);
  const window = readings.filter((reading) => latestMs - Date.parse(reading.at) <= 15 * 60_000);
  const minutes = window.map((reading) => (Date.parse(reading.at) - latestMs) / 60_000);
  const slope = regressionSlope(minutes, window.map((reading) => reading.value), 0, window.length - 1) ?? 0;
  const points = LINE_HORIZONS.map((horizon) => {
    const row = input.params.horizons[horizon];
    const value = clamp(latest.value + row.reversion * (latest.value - REFERENCE_MGDL) + row.trend * slope * trendGain(horizon) + row.constant);
    const width = input.after_carbs ? row.width_after_carbs : row.width_no_carbs;
    return {
      at: new Date(latestMs + horizon * 60_000).toISOString(),
      value: Math.round(value),
      low: Math.round(clamp(value - width)),
      high: Math.round(clamp(value + width)),
    };
  });
  return { points, slope_per_min: slope };
}

interface Rows {
  count: number;
  /** Per row: glucose, slope, minutes since the newest carbs before it (Infinity when none). */
  glucose: Float64Array;
  slope: Float64Array;
  minutes: Float64Array;
  sinceCarbs: Float64Array;
}

function buildRows(readings: GlucosePoint[], carbTimesMs: number[]): Rows {
  const sorted = readings
    .map((reading) => ({ t: Date.parse(reading.at), value: reading.value }))
    .filter((reading) => Number.isFinite(reading.t) && reading.value > 38)
    .sort((a, b) => a.t - b.t);
  const count = sorted.length;
  const glucose = new Float64Array(count);
  const minutes = new Float64Array(count);
  const slope = new Float64Array(count);
  const sinceCarbs = new Float64Array(count);
  const carbs = [...carbTimesMs].sort((a, b) => a - b);
  const start = sorted[0]?.t ?? 0;
  for (let i = 0; i < count; i += 1) {
    glucose[i] = sorted[i].value;
    minutes[i] = (sorted[i].t - start) / 60_000;
  }
  let from = 0;
  let carbIndex = -1;
  for (let i = 0; i < count; i += 1) {
    while (minutes[i] - minutes[from] > 15) from += 1;
    slope[i] = regressionSlope(minutes, glucose, from, i) ?? 0;
    while (carbIndex + 1 < carbs.length && carbs[carbIndex + 1] <= sorted[i].t) carbIndex += 1;
    sinceCarbs[i] = carbIndex >= 0 ? (sorted[i].t - carbs[carbIndex]) / 60_000 : Infinity;
  }
  return { count, glucose, slope, minutes, sinceCarbs };
}

/** The glucose `horizon` minutes after each row, between the two readings around it; NaN across a gap. */
function targets(rows: Rows, horizon: number): Float64Array {
  const out = new Float64Array(rows.count).fill(NaN);
  let after = 0;
  for (let i = 0; i < rows.count; i += 1) {
    const wanted = rows.minutes[i] + horizon;
    while (after < rows.count && rows.minutes[after] < wanted) after += 1;
    if (after >= rows.count) break;
    const later = rows.minutes[after];
    if (later === wanted) {
      out[i] = rows.glucose[after];
      continue;
    }
    const earlier = rows.minutes[after - 1];
    if (later - earlier > SIMPLE_LINE_FIT.max_target_gap_minutes) continue;
    const share = (wanted - earlier) / (later - earlier);
    out[i] = rows.glucose[after - 1] + share * (rows.glucose[after] - rows.glucose[after - 1]);
  }
  return out;
}

function solveThree(m: number[][], v: number[]): [number, number, number] | null {
  const a = m.map((row, index) => [...row, v[index]]);
  for (let column = 0; column < 3; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < 3; row += 1) if (Math.abs(a[row][column]) > Math.abs(a[pivot][column])) pivot = row;
    if (Math.abs(a[pivot][column]) < 1e-9) return null;
    [a[column], a[pivot]] = [a[pivot], a[column]];
    for (let row = 0; row < 3; row += 1) {
      if (row === column) continue;
      const factor = a[row][column] / a[column][column];
      for (let k = column; k < 4; k += 1) a[row][k] -= factor * a[column][k];
    }
  }
  return [a[0][3] / a[0][0], a[1][3] / a[1][1], a[2][3] / a[2][2]];
}

function fitHorizon(rows: Rows, target: Float64Array, horizon: number, upToMinutes: number): { reversion: number; trend: number; constant: number; count: number } | null {
  const gain = trendGain(horizon);
  const m = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const v = [0, 0, 0];
  let count = 0;
  for (let i = 0; i < rows.count; i += 1) {
    const y = target[i];
    if (Number.isNaN(y) || rows.minutes[i] + horizon > upToMinutes) continue;
    const x = [rows.glucose[i] - REFERENCE_MGDL, rows.slope[i] * gain, 1];
    const change = y - rows.glucose[i];
    for (let a = 0; a < 3; a += 1) {
      v[a] += x[a] * change;
      for (let b = 0; b < 3; b += 1) m[a][b] += x[a] * x[b];
    }
    count += 1;
  }
  if (count < SIMPLE_LINE_FIT.min_rows) return null;
  const solved = solveThree(m, v);
  if (!solved) return null;
  const [reversion, trend, constant] = solved;
  const { reversion: rb, trend: tb, constant: cb } = SIMPLE_LINE_FIT;
  if (reversion < rb.min || reversion > rb.max || trend < tb.min || trend > tb.max || constant < cb.min || constant > cb.max) return null;
  return { reversion, trend, constant, count };
}

function quantile(values: number[], share: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * share;
  const lower = Math.floor(position);
  const upper = Math.min(sorted.length - 1, lower + 1);
  return sorted[lower] + (position - lower) * (sorted[upper] - sorted[lower]);
}

/** Per horizon, keeping the default where this patient's data is too short or says something odd. */
export function fitSimpleLine(input: { readings: GlucosePoint[]; carb_times_ms: number[]; now: Date; defaults?: SimpleLineParams }): SimpleLineParams {
  const defaults = input.defaults ?? DEFAULT_SIMPLE_LINE;
  const rows = buildRows(input.readings, input.carb_times_ms);
  if (rows.count === 0) return defaults;
  const days = rows.minutes[rows.count - 1] / 1_440;
  if (days < SIMPLE_LINE_FIT.min_days) return defaults;
  const end = rows.minutes[rows.count - 1];
  const widthStart = end - SIMPLE_LINE_FIT.width_days * 1_440;
  const horizons = { ...defaults.horizons };
  let fitted = 0;
  for (const horizon of LINE_HORIZONS) {
    const target = targets(rows, horizon);
    const all = fitHorizon(rows, target, horizon, end);
    if (!all) continue;
    const before = fitHorizon(rows, target, horizon, widthStart);
    const row = { ...defaults.horizons[horizon], reversion: all.reversion, trend: all.trend, constant: all.constant };
    if (before) {
      const gain = trendGain(horizon);
      const noCarbs: number[] = [];
      const afterCarbs: number[] = [];
      for (let i = 0; i < rows.count; i += 1) {
        if (rows.minutes[i] < widthStart || Number.isNaN(target[i])) continue;
        const change = before.reversion * (rows.glucose[i] - REFERENCE_MGDL) + before.trend * rows.slope[i] * gain + before.constant;
        const error = Math.abs(rows.glucose[i] + change - target[i]);
        (rows.sinceCarbs[i] <= SIMPLE_LINE_FIT.after_carbs_minutes ? afterCarbs : noCarbs).push(error);
      }
      if (noCarbs.length >= SIMPLE_LINE_FIT.min_width_rows) row.width_no_carbs = Math.round(quantile(noCarbs, COVERAGE));
      if (afterCarbs.length >= SIMPLE_LINE_FIT.min_width_rows) row.width_after_carbs = Math.round(quantile(afterCarbs, COVERAGE));
    }
    horizons[horizon] = row;
    fitted += 1;
  }
  if (fitted === 0) return defaults;
  return { model_id: SIMPLE_LINE_MODEL_ID, source: 'FITTED', fitted_at: input.now.toISOString(), days: Math.round(days * 10) / 10, horizons };
}
