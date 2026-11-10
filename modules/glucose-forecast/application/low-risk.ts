import type { GlucosePoint } from './cgm-trend';
import { regressionSlope } from './simple-line';

/**
 * The low-warning model (research_notes/.../niskie_plan_testu.md, model C1): a logistic regression on CGM readings and
 * carb times, asking "a reading below 70 between 15 and 45 min from now?". Offline, 24 Oct-6 Nov, 27 lows: 17 warned at
 * least 15 min ahead against 16 for rescue-carbs.v2.1, with 2.6 false alarms a day against 4.1, on one patient and far
 * fewer lows than its gate asks. Experimental: it only pushes to listed people, and no dose or alert code reads it.
 */
export const LOW_RISK_MODEL_ID = 'low-risk.v1';

export const LOW_RISK_POLICY = {
  low_mgdl: 70,
  from_minutes: 15,
  to_minutes: 45,
  /** Fit data, oldest first. The offline test used all of its 53 days. */
  window_days: 90,
  min_days: 7,
  min_positives: 15,
  folds: 5,
  /** The threshold's budget: rescue-carbs.v2.1's false alarms a day on the days before the test. */
  false_alarms_per_day: 2.09,
  false_alarm_minutes: 60,
  /** Warnings within this of each other are one alarm. */
  quiet_minutes: 30,
  /** History the features read. */
  history_days: 8,
  /**
   * When the fit is given the times of pushed alerts (owner, 2026-11-09; research_notes/.../niskie_wlasne_alarmy_plan_testu.md):
   * a "no low" within this of a pushed alert may be a low somebody stopped with carbs, so it is neither learned from nor
   * counted as a false alarm. Offline, 26 Oct-8 Nov, 24 lows: 16 warned against 13, with 12% more alarms a day.
   */
  censor_minutes: 45,
  timezone: 'Europe/Warsaw',
} as const;

const FEATURE_COUNT = 12;
const MINUTE = 60_000;

export interface LowRiskParams {
  model_id: string;
  fitted_at: string;
  days: number;
  rows: number;
  positives: number;
  mean: number[];
  scale: number[];
  intercept: number;
  coef: number[];
  threshold: number;
  /** Rows left out for a pushed alert near them; absent when the fit was given no alert times. */
  censored_rows?: number;
}

export interface LowRiskRows {
  count: number;
  times: Float64Array;
  values: Float64Array;
  features: Float64Array[];
  /** 1, 0, or NaN with no reading in the target window. */
  target: Float64Array;
  days: string[];
}

const clip = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

const dayFormat = new Intl.DateTimeFormat('en-CA', { timeZone: LOW_RISK_POLICY.timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

function localParts(ms: number): { day: string; hour: number } {
  const part: Record<string, string> = {};
  for (const item of dayFormat.formatToParts(ms)) part[item.type] = item.value;
  return { day: `${part.year}-${part.month}-${part.day}`, hour: Number(part.hour) + Number(part.minute) / 60 };
}

/** Everything known at each reading: nothing here looks ahead except `target`. */
export function buildLowRiskRows(readings: GlucosePoint[], carbTimesMs: number[]): LowRiskRows {
  const seen = new Map<number, number>();
  for (const reading of readings) {
    const at = Date.parse(reading.at);
    if (Number.isFinite(at) && reading.value > 38 && !seen.has(at)) seen.set(at, reading.value);
  }
  const sorted = [...seen.entries()].sort((a, b) => a[0] - b[0]);
  const count = sorted.length;
  const times = new Float64Array(count);
  const values = new Float64Array(count);
  const minutes = new Float64Array(count);
  sorted.forEach(([at, value], index) => {
    times[index] = at;
    values[index] = value;
    minutes[index] = at / MINUTE;
  });
  const carbs = [...carbTimesMs].sort((a, b) => a - b);
  const features = Array.from({ length: count }, () => new Float64Array(FEATURE_COUNT));
  const days: string[] = new Array(count);
  const sums = new Float64Array(count + 1);
  const squares = new Float64Array(count + 1);
  for (let i = 0; i < count; i += 1) {
    sums[i + 1] = sums[i] + values[i];
    squares[i + 1] = squares[i] + values[i] * values[i];
  }
  let from15 = 0;
  let from60 = 0;
  let from7 = 0;
  let carbIndex = -1;
  for (let i = 0; i < count; i += 1) {
    while (minutes[i] - minutes[from15] > 15) from15 += 1;
    while (minutes[from60] <= minutes[i] - 60) from60 += 1;
    while (minutes[from7] < minutes[i] - 7 * 1_440) from7 += 1;
    const slope = regressionSlope(minutes, values, from15, i) ?? 0;
    const delta = i > 0 && minutes[i] - minutes[i - 1] <= 7 ? values[i] - values[i - 1] : 0;
    const hourCount = i - from60 + 1;
    const hourMean = (sums[i + 1] - sums[from60]) / hourCount;
    const hourSd = Math.sqrt(Math.max(0, (squares[i + 1] - squares[from60]) / hourCount - hourMean * hourMean));
    let hourMin = Infinity;
    for (let j = from60; j <= i; j += 1) if (values[j] < hourMin) hourMin = values[j];
    const weekMean = (sums[i + 1] - sums[from7]) / (i - from7 + 1);
    while (carbIndex + 1 < carbs.length && carbs[carbIndex + 1] <= times[i]) carbIndex += 1;
    const since = carbIndex >= 0 ? Math.min(240, (times[i] - carbs[carbIndex]) / MINUTE) : 240;
    const { day, hour } = localParts(times[i]);
    days[i] = day;
    const glucose = clip(values[i], 70, 180);
    features[i].set([
      glucose,
      slope,
      (glucose * slope) / 100,
      delta,
      clip(values[i] + slope * 30, 40, 180),
      hourSd,
      hourMin,
      weekMean,
      Math.sin((hour / 24) * 2 * Math.PI),
      Math.cos((hour / 24) * 2 * Math.PI),
      since,
      since <= 60 ? 1 : 0,
    ]);
  }
  const target = new Float64Array(count).fill(NaN);
  const lowsBefore = new Float64Array(count + 1);
  for (let i = 0; i < count; i += 1) lowsBefore[i + 1] = lowsBefore[i] + (values[i] < LOW_RISK_POLICY.low_mgdl ? 1 : 0);
  let start = 0;
  let end = 0;
  for (let i = 0; i < count; i += 1) {
    while (start < count && times[start] < times[i] + LOW_RISK_POLICY.from_minutes * MINUTE) start += 1;
    while (end < count && times[end] <= times[i] + LOW_RISK_POLICY.to_minutes * MINUTE) end += 1;
    if (end > start) target[i] = lowsBefore[end] - lowsBefore[start] > 0 ? 1 : 0;
  }
  return { count, times, values, features, target, days };
}

function solve(matrix: number[][], vector: number[]): number[] {
  const size = vector.length;
  const a = matrix.map((row, index) => [...row, vector[index]]);
  for (let column = 0; column < size; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < size; row += 1) if (Math.abs(a[row][column]) > Math.abs(a[pivot][column])) pivot = row;
    [a[column], a[pivot]] = [a[pivot], a[column]];
    for (let row = column + 1; row < size; row += 1) {
      const factor = a[row][column] / a[column][column];
      for (let k = column; k < size + 1; k += 1) a[row][k] -= factor * a[column][k];
    }
  }
  const out = new Array<number>(size).fill(0);
  for (let row = size - 1; row >= 0; row -= 1) {
    let sum = a[row][size];
    for (let k = row + 1; k < size; k += 1) sum -= a[row][k] * out[k];
    out[row] = sum / a[row][row];
  }
  return out;
}

interface Logistic {
  mean: number[];
  scale: number[];
  intercept: number;
  coef: number[];
}

/** Balanced classes, L2 of 1 on the standardised coefficients and none on the intercept: Newton's method. */
function fitLogistic(rows: LowRiskRows, indices: number[]): Logistic {
  const mean = new Array<number>(FEATURE_COUNT).fill(0);
  const scale = new Array<number>(FEATURE_COUNT).fill(0);
  for (const i of indices) for (let f = 0; f < FEATURE_COUNT; f += 1) mean[f] += rows.features[i][f];
  for (let f = 0; f < FEATURE_COUNT; f += 1) mean[f] /= indices.length;
  for (const i of indices) for (let f = 0; f < FEATURE_COUNT; f += 1) scale[f] += (rows.features[i][f] - mean[f]) ** 2;
  for (let f = 0; f < FEATURE_COUNT; f += 1) scale[f] = Math.sqrt(scale[f] / indices.length) || 1;
  const positives = indices.reduce((sum, i) => sum + rows.target[i], 0);
  const weightOne = indices.length / (2 * positives);
  const weightZero = indices.length / (2 * (indices.length - positives));
  const size = FEATURE_COUNT + 1;
  let beta = new Array<number>(size).fill(0);
  const x = new Float64Array(size);
  const objective = (b: number[]) => {
    let total = 0;
    for (let f = 0; f < FEATURE_COUNT; f += 1) total += 0.5 * b[f] * b[f];
    for (const i of indices) {
      let eta = b[FEATURE_COUNT];
      for (let f = 0; f < FEATURE_COUNT; f += 1) eta += b[f] * ((rows.features[i][f] - mean[f]) / scale[f]);
      total += (rows.target[i] === 1 ? weightOne : weightZero) * Math.log1p(Math.exp(rows.target[i] === 1 ? -eta : eta));
    }
    return total;
  };
  let best = objective(beta);
  for (let iteration = 0; iteration < 30; iteration += 1) {
    const gradient = new Array<number>(size).fill(0);
    const hessian = Array.from({ length: size }, () => new Array<number>(size).fill(0));
    for (const i of indices) {
      for (let f = 0; f < FEATURE_COUNT; f += 1) x[f] = (rows.features[i][f] - mean[f]) / scale[f];
      x[FEATURE_COUNT] = 1;
      let eta = 0;
      for (let f = 0; f < size; f += 1) eta += beta[f] * x[f];
      const p = 1 / (1 + Math.exp(-eta));
      const w = rows.target[i] === 1 ? weightOne : weightZero;
      const residual = w * (p - rows.target[i]);
      const curve = w * Math.max(p * (1 - p), 1e-10);
      for (let a = 0; a < size; a += 1) {
        gradient[a] += residual * x[a];
        for (let b = a; b < size; b += 1) hessian[a][b] += curve * x[a] * x[b];
      }
    }
    for (let f = 0; f < FEATURE_COUNT; f += 1) {
      gradient[f] += beta[f];
      hessian[f][f] += 1;
    }
    for (let a = 0; a < size; a += 1) for (let b = 0; b < a; b += 1) hessian[a][b] = hessian[b][a];
    const step = solve(hessian, gradient);
    let share = 1;
    let next = beta.map((value, index) => value - share * step[index]);
    let value = objective(next);
    while (value > best && share > 1e-3) {
      share /= 2;
      next = beta.map((item, index) => item - share * step[index]);
      value = objective(next);
    }
    const change = best - value;
    beta = next;
    best = value;
    if (Math.abs(change) < 1e-7) break;
  }
  return { mean, scale, intercept: beta[FEATURE_COUNT], coef: beta.slice(0, FEATURE_COUNT) };
}

function probability(model: Logistic, features: ArrayLike<number>): number {
  let eta = model.intercept;
  for (let f = 0; f < FEATURE_COUNT; f += 1) eta += model.coef[f] * ((features[f] - model.mean[f]) / model.scale[f]);
  return 1 / (1 + Math.exp(-eta));
}

/** Whole days in each fold, heaviest day first into the lightest fold. */
function foldsByDay(rows: LowRiskRows, indices: number[], folds: number): Map<string, number> {
  const sizes = new Map<string, number>();
  for (const i of indices) sizes.set(rows.days[i], (sizes.get(rows.days[i]) ?? 0) + 1);
  const load = new Array<number>(folds).fill(0);
  const out = new Map<string, number>();
  for (const [day, size] of [...sizes.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? 1 : -1))) {
    const lightest = load.indexOf(Math.min(...load));
    load[lightest] += size;
    out.set(day, lightest);
  }
  return out;
}

function quantile(sorted: number[], share: number): number {
  const position = (sorted.length - 1) * share;
  const lower = Math.floor(position);
  const upper = Math.min(sorted.length - 1, lower + 1);
  return sorted[lower] + (position - lower) * (sorted[upper] - sorted[lower]);
}

/** Alarms from warnings: the first of each run with gaps of at most the quiet time. Times must be sorted. */
export function firstOfRuns(warnings: number[]): number[] {
  const out: number[] = [];
  let last = -Infinity;
  for (const at of warnings) {
    if (at - last > LOW_RISK_POLICY.quiet_minutes * MINUTE) out.push(at);
    last = at;
  }
  return out;
}

/** The lowest score cut whose past alarms stay within the budget, walking down from the top until it is first broken. */
function pickThreshold(rows: LowRiskRows, indices: number[], scores: number[]): number {
  const lowTimes: number[] = [];
  for (let i = 0; i < rows.count; i += 1) if (rows.values[i] < LOW_RISK_POLICY.low_mgdl) lowTimes.push(rows.times[i]);
  const dayCount = new Set(indices.map((i) => rows.days[i])).size;
  const sortedScores = [...scores].sort((a, b) => a - b);
  const order = indices.map((i, position) => ({ at: rows.times[i], score: scores[position] })).sort((a, b) => a.at - b.at);
  const steps = 90;
  let best = Infinity;
  for (let step = steps - 1; step >= 0; step -= 1) {
    const cut = quantile(sortedScores, 0.4 + ((0.9995 - 0.4) * step) / (steps - 1));
    const alarms = firstOfRuns(order.filter((row) => row.score >= cut).map((row) => row.at));
    let falseAlarms = 0;
    let cursor = 0;
    for (const at of alarms) {
      while (cursor < lowTimes.length && lowTimes[cursor] <= at) cursor += 1;
      if (cursor >= lowTimes.length || lowTimes[cursor] > at + LOW_RISK_POLICY.false_alarm_minutes * MINUTE) falseAlarms += 1;
    }
    if (best === Infinity) best = cut;
    if (falseAlarms / dayCount <= LOW_RISK_POLICY.false_alarms_per_day) best = cut;
    else break;
  }
  return best;
}

/** Whether any of the sorted times lies within [from, to]. */
function anyWithin(sorted: number[], from: number, to: number): boolean {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (sorted[middle] < from) low = middle + 1;
    else high = middle;
  }
  return low < sorted.length && sorted[low] <= to;
}

/**
 * The fit: on rows whose target window ended by `now`; null with too little history. The threshold comes from out-of-fold scores.
 * With `alert_times_ms` (pushed alerts; the server gives them unless PREDICTION_LOW_CENSOR_ALERTS=false), rows without a low near a pushed alert are left out
 * of the fit and of the threshold's false alarms: the low may have been stopped by the carbs the alert asked for.
 */
export function fitLowRisk(rows: LowRiskRows, now: Date, options: { alert_times_ms?: number[] } = {}): LowRiskParams | null {
  const nowMs = now.getTime();
  const windowStart = nowMs - LOW_RISK_POLICY.window_days * 86_400_000;
  const alerts = options.alert_times_ms ? options.alert_times_ms.filter((at) => Number.isFinite(at) && at <= nowMs).sort((a, b) => a - b) : null;
  const reach = LOW_RISK_POLICY.censor_minutes * MINUTE;
  let censored = 0;
  const indices: number[] = [];
  for (let i = 0; i < rows.count; i += 1) {
    if (rows.times[i] < windowStart || rows.times[i] + LOW_RISK_POLICY.to_minutes * MINUTE > nowMs) continue;
    if (rows.values[i] < LOW_RISK_POLICY.low_mgdl || Number.isNaN(rows.target[i])) continue;
    if (alerts && rows.target[i] === 0 && anyWithin(alerts, rows.times[i] - reach, rows.times[i] + reach)) {
      censored += 1;
      continue;
    }
    indices.push(i);
  }
  const positives = indices.reduce((sum, i) => sum + rows.target[i], 0);
  const days = new Set(indices.map((i) => rows.days[i])).size;
  if (days < LOW_RISK_POLICY.min_days || positives < LOW_RISK_POLICY.min_positives) return null;
  const foldOf = foldsByDay(rows, indices, LOW_RISK_POLICY.folds);
  const scores = new Array<number>(indices.length).fill(0);
  for (let fold = 0; fold < LOW_RISK_POLICY.folds; fold += 1) {
    const train = indices.filter((i) => foldOf.get(rows.days[i]) !== fold);
    const model = fitLogistic(rows, train);
    indices.forEach((i, position) => {
      if (foldOf.get(rows.days[i]) === fold) scores[position] = probability(model, rows.features[i]);
    });
  }
  const model = fitLogistic(rows, indices);
  return { model_id: LOW_RISK_MODEL_ID, fitted_at: now.toISOString(), days, rows: indices.length, positives, ...model, threshold: pickThreshold(rows, indices, scores), ...(alerts ? { censored_rows: censored } : {}) };
}

export function lowRiskScore(params: LowRiskParams, features: ArrayLike<number>): number {
  return probability(params, features);
}
