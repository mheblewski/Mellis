/**
 * Backtest of the loop's stored forecasts (glucose-forecast.v1 input) against what the CGM showed afterwards.
 * Read-only (READ ONLY transaction), no writes, no jobs, no AI, no network beyond the local database.
 *
 * For every device status with oref predBGs since --since: the IOB/ZT/COB/UAM curves, the main curve (COB while
 * carbs absorb, else IOB), eventualBG and two baselines (glucose stays flat; the CGM trend glucose-forecast.v1 falls
 * back to) against the CGM at +15/+30/+60/+90/+120 min; lows (<70) and highs (>180, >250) forecast 15–30 min ahead
 * and false alarms; and the same split by context (carbs absorbing, an unexplained rise with no carbs).
 *
 * Usage: tsx scripts/evaluation/trio-forecast-backtest.ts --database-url postgresql:///glucomind_forecast_backtest \
 *          --output-dir ~/mellis-eval/forecast-backtest-2026-10 [--since 2026-10-15T00:00:00+02:00]
 * Only a local database whose name contains "backtest" is accepted (a restore of a backup, never production or a
 * shared dev database); DATABASE_URL and .env are ignored. The output directory must resolve outside every Git
 * working tree; it is validated before the database is opened. Outputs contain patient data: results.json, TABLES.md.
 */
import { Pool } from 'pg';
import { projectLinear, shortAverageSlope, type GlucosePoint } from '@modules/glucose-forecast/application/cgm-trend';
import { mainCurveName, type ForecastCurveName } from '@modules/glucose-forecast/application/glucose-forecast';
import { parseLoopPrediction, type LoopPrediction } from '@modules/loop-system/application/loop-prediction';
import { FITTED_V1_FORECAST_CALIBRATION, type ForecastCalibration } from '@modules/glucose-forecast/application/forecast-calibration';
import { decideRescueAlert, type RescueAlertRecord } from '@modules/rescue-carbs/application/rescue-alert-policy';
import { evaluateRescueNeed, evaluateRescueNeedV2, type RescueEvaluation, type RescueV2PolicyOverrides } from '@modules/rescue-carbs/application/rescue-detection';
import { describeErrorSafely, ensureEvaluationOutputDir, resolveEvaluationOutputDir, writeEvaluationOutputDirFile } from './evaluation-output-dir';

const MINUTE = 60_000;
export const HORIZONS = [15, 30, 60, 90, 120] as const;
const LOW = 70;
const HIGHS = [180, 250] as const;
/** A curve read 5 min per step; oref drops a flat tail, so the last value holds after the end. */
const STEP = 5;
/** Warnings that count as "ahead": issued 15–30 min before the threshold was crossed. */
const LEAD_MIN = 15;
const LEAD_MAX = 30;
/** How far a forecast is read for an alarm, and the grace after it for the CGM to confirm one. */
const ALARM_HORIZON = 30;
const CONFIRM_GRACE = 15;

export type Calibrated = 'SHRINK' | 'LINEAR';
export type Predictor = ForecastCurveName | 'MAIN' | 'EVENTUAL' | 'FLAT' | 'CGM_TREND' | Calibrated;
export const PREDICTORS: Predictor[] = ['IOB', 'ZT', 'COB', 'UAM', 'MAIN', 'EVENTUAL', 'CGM_TREND', 'FLAT', 'SHRINK', 'LINEAR'];
/** Calibrations are fitted for every 5 min up to this (alarms read 5–30 min, accuracy up to 120). */
const CALIBRATION_MAX = 120;

export interface Calculation {
  /** The time of the reading the calculation used (index 0 of the curves). */
  anchor_ms: number;
  bg: number;
  prediction: LoopPrediction;
  /** oref's deviation over 30 min (actual change minus the insulin's effect) from its reason text. */
  deviation: number | null;
  slope_per_min: number | null;
  context: Context;
  /** Leave-one-day-out calibrated forecasts, index = minutes / 5. */
  calibrated?: Partial<Record<Calibrated, Array<number | null>>>;
}

export type Context = 'CARBS_ABSORBING' | 'UNEXPLAINED_RISE' | 'OTHER';

/** The curve's value `minutes` after index 0; the last value after a trimmed (flat) tail; null without the curve. */
export function curveAt(values: number[] | undefined, minutes: number): number | null {
  if (!values || values.length === 0) return null;
  return values[Math.min(values.length - 1, Math.round(minutes / STEP))];
}

/** CGM at a time: linear between the readings around it (at most 11 min apart), else null. */
export function actualAt(readings: GlucosePoint[], times: number[], atMs: number): number | null {
  let lo = 0;
  let hi = times.length - 1;
  if (hi < 0 || atMs < times[0] || atMs > times[hi]) return null;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= atMs) lo = mid;
    else hi = mid;
  }
  if (times[lo] === atMs) return readings[lo].value;
  if (times[hi] === atMs) return readings[hi].value;
  if (times[hi] - times[lo] > 11 * MINUTE) return null;
  const share = (atMs - times[lo]) / (times[hi] - times[lo]);
  return readings[lo].value + share * (readings[hi].value - readings[lo].value);
}

export function predict(calc: Calculation, predictor: Predictor, minutes: number): number | null {
  const loop = calc.prediction;
  switch (predictor) {
    case 'FLAT':
      return calc.bg;
    case 'CGM_TREND':
      return calc.slope_per_min === null ? null : projectLinear(calc.bg, calc.slope_per_min, minutes);
    case 'EVENTUAL':
      return loop.eventual_bg;
    case 'SHRINK':
    case 'LINEAR':
      return calc.calibrated?.[predictor]?.[Math.round(minutes / STEP)] ?? null;
    case 'MAIN': {
      const name = mainCurveName(loop);
      return name ? curveAt(loop.curves[name], minutes) : null;
    }
    default:
      return curveAt(loop.curves[predictor], minutes);
  }
}

interface ErrorStats { n: number; mae: number | null; bias: number | null; rmse: number | null; p90_abs: number | null }

function errorStats(errors: number[]): ErrorStats {
  if (errors.length === 0) return { n: 0, mae: null, bias: null, rmse: null, p90_abs: null };
  const abs = errors.map(Math.abs).sort((a, b) => a - b);
  const round = (value: number) => Math.round(value * 10) / 10;
  return {
    n: errors.length,
    mae: round(abs.reduce((sum, value) => sum + value, 0) / abs.length),
    bias: round(errors.reduce((sum, value) => sum + value, 0) / errors.length),
    rmse: round(Math.sqrt(errors.reduce((sum, value) => sum + value * value, 0) / errors.length)),
    p90_abs: round(abs[Math.min(abs.length - 1, Math.floor(0.9 * (abs.length - 1)))]),
  };
}

/** Error = forecast − CGM (positive: the forecast was too high). */
export function accuracy(calcs: Calculation[], readings: GlucosePoint[], filter: (calc: Calculation) => boolean = () => true) {
  const times = readings.map((reading) => Date.parse(reading.at));
  const result: Record<string, Record<string, ErrorStats>> = {};
  for (const predictor of PREDICTORS) {
    result[predictor] = {};
    for (const horizon of HORIZONS) {
      const errors: number[] = [];
      for (const calc of calcs) {
        if (!filter(calc)) continue;
        const forecast = predict(calc, predictor, horizon);
        const actual = actualAt(readings, times, calc.anchor_ms + horizon * MINUTE);
        if (forecast !== null && actual !== null) errors.push(forecast - actual);
      }
      result[predictor][`+${horizon}`] = errorStats(errors);
    }
  }
  return result;
}

/** Threshold crossings in the CGM: a reading past it after ≥ 15 min on the other side; episodes 30 min apart. */
export function crossingEpisodes(readings: GlucosePoint[], past: (value: number) => boolean): number[] {
  const starts: number[] = [];
  let lastPastMs = -Infinity;
  let sideSinceMs: number | null = null;
  for (let index = 0; index < readings.length; index += 1) {
    const atMs = Date.parse(readings[index].at);
    const previousMs = index > 0 ? Date.parse(readings[index - 1].at) : null;
    if (previousMs === null || atMs - previousMs > 15 * MINUTE) sideSinceMs = null;
    if (past(readings[index].value)) {
      if (atMs - lastPastMs > 30 * MINUTE && sideSinceMs !== null && atMs - sideSinceMs >= 15 * MINUTE) starts.push(atMs);
      lastPastMs = atMs;
      sideSinceMs = null;
    } else if (sideSinceMs === null) {
      sideSinceMs = atMs;
    }
  }
  return starts;
}

export type Detector = { name: string; fires: (calc: Calculation) => boolean };

/** A forecast curve crossing the threshold within the alarm horizon while glucose is still on the safe side. */
export function curveDetector(predictor: Predictor, past: (value: number) => boolean): Detector {
  return {
    name: predictor,
    fires: (calc) => {
      if (past(calc.bg)) return false;
      if (predictor === 'EVENTUAL') return calc.prediction.eventual_bg !== null && past(calc.prediction.eventual_bg);
      for (let minutes = STEP; minutes <= ALARM_HORIZON; minutes += STEP) {
        const value = predict(calc, predictor, minutes);
        if (value !== null && past(value)) return true;
      }
      return false;
    },
  };
}

export interface EventScore {
  detector: string;
  episodes: number;
  /** Episodes with a warning 15–30 min before the crossing. */
  warned_15_30: number;
  /** Episodes with a warning 5–30 min before (any useful lead). */
  warned_5_30: number;
  alarms: number;
  false_alarms: number;
  false_alarms_per_day: number;
  /** Share of alarms the CGM confirmed within 30 + 15 min. */
  precision: number | null;
  /** Per episode: the longest lead (5–30 min) of a warning, null when none came 5+ min ahead. */
  lead_minutes: Array<number | null>;
}

/** Alarms are runs of firing calculations (≤ 15 min gaps); false when the CGM did not cross within 30 + 15 min. */
export function scoreEvents(calcs: Calculation[], readings: GlucosePoint[], past: (value: number) => boolean, detector: Detector, days: number): EventScore {
  const episodes = crossingEpisodes(readings, past);
  const firing = calcs.filter(detector.fires).map((calc) => calc.anchor_ms);
  const leads = episodes.map((start) => {
    const ahead = firing.map((atMs) => (start - atMs) / MINUTE).filter((lead) => lead >= 5 && lead <= LEAD_MAX);
    return ahead.length > 0 ? Math.round(Math.max(...ahead)) : null;
  });
  const warned = (minLead: number) => episodes.filter((start) => firing.some((atMs) => start - atMs >= minLead * MINUTE && start - atMs <= LEAD_MAX * MINUTE)).length;
  const runs: Array<{ start: number; end: number }> = [];
  for (const atMs of firing) {
    const last = runs.at(-1);
    if (last && atMs - last.end <= 15 * MINUTE) last.end = atMs;
    else runs.push({ start: atMs, end: atMs });
  }
  const pastTimes = readings.filter((reading) => past(reading.value)).map((reading) => Date.parse(reading.at));
  const confirmed = runs.filter((run) => pastTimes.some((atMs) => atMs >= run.start && atMs <= run.end + (ALARM_HORIZON + CONFIRM_GRACE) * MINUTE)).length;
  const falseAlarms = runs.length - confirmed;
  return {
    detector: detector.name,
    episodes: episodes.length,
    warned_15_30: warned(LEAD_MIN),
    warned_5_30: warned(5),
    alarms: runs.length,
    false_alarms: falseAlarms,
    false_alarms_per_day: Math.round((falseAlarms / days) * 10) / 10,
    precision: runs.length > 0 ? Math.round((confirmed / runs.length) * 100) / 100 : null,
    lead_minutes: leads,
  };
}

/**
 * Calibration candidates, fitted on the other days only (leave one day out):
 * - SHRINK: glucose + w × (the main curve's change), one w per horizon (w < 1 damps oref's extrapolation);
 * - LINEAR: least squares on the changes forecast by MAIN, ZT and UAM (IOB without one) and the CGM slope × minutes.
 */
export function calibrate(calcs: Calculation[], readings: GlucosePoint[]): Record<Calibrated, Record<string, number[]>> {
  const times = readings.map((reading) => Date.parse(reading.at));
  const firstMs = calcs[0]?.anchor_ms ?? 0;
  const fold = (calc: Calculation) => Math.floor((calc.anchor_ms - firstMs) / (24 * 60 * MINUTE));
  const folds = [...new Set(calcs.map(fold))];
  const features = (calc: Calculation, minutes: number): number[] | null => {
    const main = predict(calc, 'MAIN', minutes);
    const zt = predict(calc, 'ZT', minutes);
    const uam = predict(calc, 'UAM', minutes) ?? predict(calc, 'IOB', minutes);
    if (main === null || zt === null || uam === null) return null;
    return [1, main - calc.bg, zt - calc.bg, uam - calc.bg, (calc.slope_per_min ?? 0) * minutes];
  };
  const coefficients: Record<Calibrated, Record<string, number[]>> = { SHRINK: {}, LINEAR: {} };
  for (const calc of calcs) calc.calibrated = { SHRINK: [], LINEAR: [] };
  for (let minutes = STEP; minutes <= CALIBRATION_MAX; minutes += STEP) {
    const rows = calcs.map((calc) => {
      const x = features(calc, minutes);
      const actual = actualAt(readings, times, calc.anchor_ms + minutes * MINUTE);
      return { calc, x, y: actual === null ? null : actual - calc.bg };
    });
    for (const heldOut of folds) {
      const train = rows.filter((row) => fold(row.calc) !== heldOut && row.x !== null && row.y !== null) as Array<{ calc: Calculation; x: number[]; y: number }>;
      const shrink = train.reduce((sum, row) => sum + row.x[1] * row.y, 0) / Math.max(1e-9, train.reduce((sum, row) => sum + row.x[1] * row.x[1], 0));
      const beta = leastSquares(train.map((row) => row.x), train.map((row) => row.y));
      coefficients.SHRINK[`+${minutes} fold ${heldOut}`] = [round3(shrink)];
      coefficients.LINEAR[`+${minutes} fold ${heldOut}`] = beta.map(round3);
      for (const row of rows.filter((candidate) => fold(candidate.calc) === heldOut)) {
        const index = minutes / STEP;
        row.calc.calibrated!.SHRINK![index] = row.x ? row.calc.bg + shrink * row.x[1] : null;
        row.calc.calibrated!.LINEAR![index] = row.x ? row.calc.bg + row.x.reduce((sum, value, i) => sum + value * beta[i], 0) : null;
      }
    }
  }
  return coefficients;
}

const round3 = (value: number) => Math.round(value * 1000) / 1000;

/** Ordinary least squares by the normal equations (tiny ridge for stability). */
export function leastSquares(x: number[][], y: number[]): number[] {
  const k = x[0]?.length ?? 0;
  const a = Array.from({ length: k }, (_, i) => Array.from({ length: k + 1 }, (_, j) => (j === k ? x.reduce((sum, row, r) => sum + row[i] * y[r], 0) : x.reduce((sum, row) => sum + row[i] * row[j], 0) + (i === j ? 1e-6 : 0))));
  for (let col = 0; col < k; col += 1) {
    const pivot = a.slice(col).reduce((best, row, index) => (Math.abs(row[col]) > Math.abs(a[best][col]) ? index + col : best), col);
    [a[col], a[pivot]] = [a[pivot], a[col]];
    for (let row = 0; row < k; row += 1) {
      if (row === col || a[col][col] === 0) continue;
      const factor = a[row][col] / a[col][col];
      for (let j = col; j <= k; j += 1) a[row][j] -= factor * a[col][j];
    }
  }
  return a.map((row, i) => (row[i] === 0 ? 0 : row[k] / row[i]));
}

function deviationFromReason(reason: unknown): number | null {
  const match = typeof reason === 'string' ? /Dev: (-?\d+(?:\.\d+)?)/.exec(reason) : null;
  return match ? Number(match[1]) : null;
}

export class BacktestArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BacktestArgumentError';
  }
}

export function parseBacktestArgs(argv: readonly string[]): { databaseUrl: string; since: string } {
  const value = (name: string) => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : argv.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
  };
  const databaseUrl = value('--database-url');
  if (!databaseUrl) throw new BacktestArgumentError('Pass --database-url postgresql:///<local backtest database> (DATABASE_URL is ignored on purpose).');
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new BacktestArgumentError('--database-url is not a URL.');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!['', 'localhost', '127.0.0.1', '::1'].includes(host) || !/backtest/i.test(database)) {
    throw new BacktestArgumentError('Only a local database whose name contains "backtest" is accepted (restore a backup first).');
  }
  const since = value('--since') ?? '2026-10-15T00:00:00+02:00';
  if (!Number.isFinite(Date.parse(since))) throw new BacktestArgumentError('--since must be a date.');
  return { databaseUrl, since };
}

export interface SimulatedPush { at_ms: number; level: string; reminder: boolean; signals: string[]; confirmation: string | null; glucose: number | null; slope: number | null; calibrated_min: number | null; predicted_min: number | null }

/**
 * The rescue worker replayed once a minute: the newest 45 min of CGM, the newest device status that had arrived, carbs
 * entered in the last 15 min, and the real alert state machine (decideRescueAlert). Caregivers logging rescue carbs
 * in the app is not replayed, so alerts end by clearing or expiring and reminders are counted separately.
 */
export function simulateRescueAlerts(input: {
  patient: PatientData;
  fromMs: number;
  toMs: number;
  evaluate: (args: { now: Date; readings: GlucosePoint[]; prediction: LoopPrediction | null; last_carbs_at: string | null }) => RescueEvaluation;
}): SimulatedPush[] {
  const { readings, times, carbs, statuses } = input.patient;
  const pushes: SimulatedPush[] = [];
  let active: RescueAlertRecord | null = null;
  let readingIndex = 0;
  let statusIndex = -1;
  const startFrom = (index: number, nowMs: number) => {
    let first = index;
    while (first < times.length && times[first] < nowMs - 45 * MINUTE) first += 1;
    return first;
  };
  const record = (evaluation: RescueEvaluation, nowIso: string): RescueAlertRecord => ({
    id: `sim-${pushes.length}-${nowIso}`, patient_id: input.patient.patientId, status: 'PENDING', level: evaluation.level ?? 'PREDICTED_LOW', trigger_source: evaluation.trigger_source ?? 'TRIO_PREDICTION',
    first_flag_at: nowIso, first_flag_reading_at: evaluation.glucose?.at ?? null, notified_at: null, notified_level: null, reminder_sent_at: null, last_evaluated_at: nowIso,
    clear_since: null, evaluation, proposal: null, conversation_id: null, treatment_event_id: null, treatment_carbs_g: null, treated_at: null, treated_by_user_id: null,
    treatment_source: null, treatment_proposal_id: null, declined_at: null, declined_by_user_id: null, outcome: null, resolved_at: null, created_at: nowIso,
  });
  const notify = (alert: RescueAlertRecord, evaluation: RescueEvaluation, nowMs: number, nowIso: string, reminder: boolean) => {
    pushes.push({ at_ms: nowMs, level: evaluation.level ?? 'NONE', reminder, signals: evaluation.signals ?? [evaluation.trigger_source ?? ''], confirmation: evaluation.confirmation ?? null, glucose: evaluation.glucose?.value ?? null, slope: evaluation.slope_per_min, calibrated_min: evaluation.calibrated_min_mgdl ?? null, predicted_min: evaluation.predicted_min_mgdl });
    return reminder
      ? { ...alert, reminder_sent_at: nowIso, evaluation }
      : { ...alert, status: 'NOTIFIED' as const, notified_at: alert.notified_at ?? nowIso, notified_level: evaluation.level, evaluation };
  };
  for (let nowMs = input.fromMs; nowMs <= input.toMs; nowMs += MINUTE) {
    const now = new Date(nowMs);
    const nowIso = now.toISOString();
    readingIndex = startFrom(readingIndex, nowMs);
    let last = readingIndex;
    while (last < times.length && times[last] <= nowMs) last += 1;
    while (statusIndex + 1 < statuses.length && statuses[statusIndex + 1].observed_ms <= nowMs) statusIndex += 1;
    const lastCarbs = carbs.filter((atMs) => atMs <= nowMs && atMs >= nowMs - 15 * MINUTE).at(-1);
    const evaluation = input.evaluate({
      now,
      readings: readings.slice(readingIndex, last),
      prediction: statusIndex >= 0 ? statuses[statusIndex].prediction : null,
      last_carbs_at: lastCarbs === undefined ? null : new Date(lastCarbs).toISOString(),
    });
    const decision = decideRescueAlert(active, evaluation, now);
    switch (decision.action) {
      case 'NONE':
        if (active) {
          const current: RescueAlertRecord = active;
          active = { ...current, evaluation, last_evaluated_at: nowIso, clear_since: decision.clear_since === undefined ? current.clear_since : decision.clear_since };
        }
        break;
      case 'START_PENDING':
        active = record(evaluation, nowIso);
        break;
      case 'CANCEL':
        active = null;
        break;
      case 'NOTIFY':
        active = notify(active ?? record(evaluation, nowIso), evaluation, nowMs, nowIso, false);
        break;
      case 'REMIND':
        active = notify(active!, evaluation, nowMs, nowIso, true);
        break;
      case 'CLOSE':
        active = decision.restart === 'NONE' ? null : record(evaluation, nowIso);
        if (decision.restart === 'NOTIFY') active = notify(active!, evaluation, nowMs, nowIso, false);
        break;
    }
  }
  return pushes;
}

export interface PushScore {
  variant: string;
  episodes: number;
  /** Episodes with a predicted-low push or reminder 15–30 / 5–30 min before glucose went below 70. */
  warned_15_30: number;
  warned_5_30: number;
  /** Episodes with any push or reminder (also "low now") from 30 min before to 10 min after the start. */
  covered_by_push: number;
  pushes: number;
  predicted_low_pushes: number;
  /** Predicted-low pushes the CGM did not confirm (< 70) within 45 min. */
  false_pushes: number;
  false_pushes_per_day: number;
  reminders: number;
  lead_minutes: Array<number | null>;
}

export function scorePushes(variant: string, pushes: SimulatedPush[], readings: GlucosePoint[], days: number): PushScore {
  const episodes = crossingEpisodes(readings, (value) => value < LOW);
  const first = pushes.filter((push) => !push.reminder);
  const predicted = first.filter((push) => push.level === 'PREDICTED_LOW');
  const lowTimes = readings.filter((reading) => reading.value < LOW).map((reading) => Date.parse(reading.at));
  const falsePushes = predicted.filter((push) => !lowTimes.some((atMs) => atMs >= push.at_ms && atMs <= push.at_ms + (ALARM_HORIZON + CONFIRM_GRACE) * MINUTE)).length;
  // A reminder of a predicted low also warns: it is a push about a low still coming.
  const warnings = pushes.filter((push) => push.level === 'PREDICTED_LOW');
  const lead = (start: number) => {
    const ahead = warnings.map((push) => (start - push.at_ms) / MINUTE).filter((minutes) => minutes >= 5 && minutes <= LEAD_MAX);
    return ahead.length > 0 ? Math.round(Math.max(...ahead)) : null;
  };
  const leads = episodes.map(lead);
  return {
    variant,
    episodes: episodes.length,
    warned_15_30: leads.filter((value) => value !== null && value >= LEAD_MIN).length,
    warned_5_30: leads.filter((value) => value !== null).length,
    covered_by_push: episodes.filter((start) => pushes.some((push) => push.at_ms >= start - LEAD_MAX * MINUTE && push.at_ms <= start + 10 * MINUTE)).length,
    pushes: first.length,
    predicted_low_pushes: predicted.length,
    false_pushes: falsePushes,
    false_pushes_per_day: Math.round((falsePushes / days) * 10) / 10,
    reminders: pushes.length - first.length,
    lead_minutes: leads,
  };
}

/** The leave-one-day-out SHRINK fit of calibrate() as the calibration v2 reads for a given day. */
export function heldOutCalibration(coefficients: Record<string, number[]>, fold: number): ForecastCalibration {
  const shrink: Record<number, number> = {};
  for (const [key, [w]] of Object.entries(coefficients)) {
    const match = /^\+(\d+) fold (\d+)$/.exec(key);
    if (match && Number(match[2]) === fold) shrink[Number(match[1])] = w;
  }
  return { ...FITTED_V1_FORECAST_CALIBRATION, version: `held-out-day-${fold}`, shrink_by_minutes: shrink };
}

type StatusRow = { patient_id: string; occurred_at: Date; raw_payload: Record<string, unknown> };
type ReadingRow = { patient_id: string; occurred_at: Date; value: string };
type CarbRow = { patient_id: string; occurred_at: Date; carbs: string };

/** Everything the backtest reads, in one READ ONLY transaction. */
export async function loadBacktestRows(client: { query: Pool['query'] }, since: string): Promise<{ statuses: StatusRow[]; readingRows: ReadingRow[]; carbRows: CarbRow[] }> {
  await client.query('BEGIN READ ONLY');
  const statuses = (await client.query<StatusRow>(
    `SELECT patient_id, occurred_at, raw_payload FROM source_records
     WHERE record_type = 'DEVICE_STATUS' AND raw_payload ?| ARRAY['openaps', 'loop'] AND occurred_at >= $1::timestamptz
     ORDER BY occurred_at`, [since])).rows;
  const readingRows = (await client.query<ReadingRow>(
    `SELECT patient_id, occurred_at, payload->>'glucose_value' AS value FROM events
     WHERE type = 'GLUCOSE_READING_AVAILABLE' AND occurred_at >= $1::timestamptz - interval '3 hours' ORDER BY occurred_at`, [since])).rows;
  const carbRows = (await client.query<CarbRow>(
    `SELECT patient_id, occurred_at, payload->>'carbs' AS carbs FROM events
     WHERE type = 'CARB_ENTRY' AND occurred_at >= $1::timestamptz - interval '6 hours' ORDER BY occurred_at`, [since])).rows;
  await client.query('COMMIT');
  return { statuses, readingRows, carbRows };
}

export interface PatientData {
  patientId: string;
  readings: GlucosePoint[];
  times: number[];
  carbs: number[];
  calcs: Calculation[];
  /** Every device status as the worker would have read it: when it arrived and what it said. */
  statuses: Array<{ observed_ms: number; prediction: LoopPrediction }>;
  noAnchor: number;
  trimmedTails: number;
}

/** Per patient: readings, carb entries and one Calculation per distinct oref calculation. */
export function buildPatients(statuses: StatusRow[], readingRows: ReadingRow[], carbRows: CarbRow[]): PatientData[] {
  const patients: PatientData[] = [];
  for (const patientId of [...new Set(statuses.map((row) => row.patient_id))]) {
    const readings = readingRows
      .filter((row) => row.patient_id === patientId)
      .map((row) => ({ at: new Date(row.occurred_at).toISOString(), value: Number(row.value) }))
      .filter((reading) => Number.isFinite(reading.value) && reading.value > 38);
    const carbs = carbRows.filter((row) => row.patient_id === patientId && Number(row.carbs) > 0).map((row) => new Date(row.occurred_at).getTime());
    const times = readings.map((reading) => Date.parse(reading.at));

    const seen = new Set<string>();
    const calcs: Calculation[] = [];
    let noAnchor = 0;
    let trimmedTails = 0;
    for (const row of statuses.filter((status) => status.patient_id === patientId)) {
      const prediction = parseLoopPrediction({ observed_at: new Date(row.occurred_at).toISOString(), raw_payload: row.raw_payload });
      if (!prediction || prediction.source !== 'OPENAPS' || !prediction.curves.IOB || seen.has(prediction.computed_at)) continue;
      seen.add(prediction.computed_at);
      const computedMs = Date.parse(prediction.computed_at);
      // The reading the calculation used: the newest one up to a minute after it, at most 7 min before.
      let index = times.length - 1;
      while (index >= 0 && times[index] > computedMs + MINUTE) index -= 1;
      if (index < 0 || computedMs - times[index] > 7 * MINUTE) { noAnchor += 1; continue; }
      const anchorMs = times[index];
      if (prediction.curves.IOB.length < 1 + 120 / STEP) trimmedTails += 1;
      const decision = (row.raw_payload.openaps as Record<string, unknown>).suggested as Record<string, unknown> | undefined;
      const deviation = deviationFromReason(decision?.reason);
      const history = readings.slice(Math.max(0, index - 12), index + 1);
      const carbsNear = carbs.some((atMs) => atMs >= anchorMs - 180 * MINUTE && atMs <= anchorMs + 30 * MINUTE);
      const context: Context = (prediction.cob_g ?? 0) > 0
        ? 'CARBS_ABSORBING'
        : !carbsNear && deviation !== null && deviation >= 15
          ? 'UNEXPLAINED_RISE'
          : 'OTHER';
      calcs.push({ anchor_ms: anchorMs, bg: prediction.bg ?? readings[index].value, prediction, deviation, slope_per_min: shortAverageSlope(history), context });
    }
    const parsed = statuses
      .filter((status) => status.patient_id === patientId)
      .map((row) => ({ observed_ms: new Date(row.occurred_at).getTime(), prediction: parseLoopPrediction({ observed_at: new Date(row.occurred_at).toISOString(), raw_payload: row.raw_payload }) }))
      .filter((status): status is { observed_ms: number; prediction: LoopPrediction } => status.prediction !== null);
    if (calcs.length > 0) patients.push({ patientId, readings, times, carbs, calcs, statuses: parsed, noAnchor, trimmedTails });
  }
  return patients;
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  // Validated before any database access.
  const requestedDir = resolveEvaluationOutputDir(argv);
  const { databaseUrl, since } = parseBacktestArgs(argv);
  const outputDir = ensureEvaluationOutputDir(requestedDir);
  const pool = new Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  try {
    const { statuses, readingRows, carbRows } = await loadBacktestRows(client, since);

    const report: Record<string, unknown> = { generated_at: new Date().toISOString(), since, patients: [] as unknown[] };
    const tables: string[] = [];
    for (const patient of buildPatients(statuses, readingRows, carbRows)) {
      const { readings, carbs, times, calcs, noAnchor, trimmedTails } = patient;
      const firstMs = calcs[0].anchor_ms;
      const lastMs = calcs.at(-1)!.anchor_ms;
      const days = (lastMs - firstMs) / (24 * 60 * MINUTE);
      const window = readings.filter((reading) => Date.parse(reading.at) >= firstMs && Date.parse(reading.at) <= lastMs + 120 * MINUTE);

      // Rises seen afterwards (+40 mg/dL within 60 min) with no carbs entered 3 h before to 1 h after: selected by the
      // outcome, so the worst case for an unannounced meal.
      const uncoveredRise = (calc: Calculation) => {
        const actual = actualAt(readings, times, calc.anchor_ms + 60 * MINUTE);
        const carbsNear = carbs.some((atMs) => atMs >= calc.anchor_ms - 180 * MINUTE && atMs <= calc.anchor_ms + 60 * MINUTE);
        return actual !== null && actual - calc.bg >= 40 && !carbsNear;
      };
      const coveredRise = (calc: Calculation) => {
        const actual = actualAt(readings, times, calc.anchor_ms + 60 * MINUTE);
        return actual !== null && actual - calc.bg >= 40 && (calc.prediction.cob_g ?? 0) > 0;
      };

      const calibration = calibrate(calcs, readings);
      const contexts = {
        all: accuracy(calcs, readings),
        carbs_absorbing: accuracy(calcs, readings, (calc) => calc.context === 'CARBS_ABSORBING'),
        unexplained_rise_now: accuracy(calcs, readings, (calc) => calc.context === 'UNEXPLAINED_RISE'),
        other: accuracy(calcs, readings, (calc) => calc.context === 'OTHER'),
        rise_without_carbs_seen_after: accuracy(calcs, readings, uncoveredRise),
        rise_with_carbs_seen_after: accuracy(calcs, readings, coveredRise),
        below_100_now: accuracy(calcs, readings, (calc) => calc.bg < 100),
        above_180_now: accuracy(calcs, readings, (calc) => calc.bg > 180),
      };

      const below = (value: number) => value < LOW;
      const rescueTrigger = (calc: Calculation) => {
        // The worker evaluates once a minute: the first run after Trio's calculation.
        const now = new Date(Math.max(calc.anchor_ms, Date.parse(calc.prediction.computed_at)) + MINUTE);
        const recent = readings.filter((reading) => Date.parse(reading.at) <= now.getTime() && Date.parse(reading.at) >= now.getTime() - 45 * MINUTE);
        const lastCarbs = carbs.filter((atMs) => atMs <= now.getTime()).at(-1);
        const evaluation = evaluateRescueNeed({ now, readings: recent, prediction: calc.prediction, last_carbs_at: lastCarbs ? new Date(lastCarbs).toISOString() : null });
        return evaluation.status === 'TRIGGER' && evaluation.level === 'PREDICTED_LOW';
      };
      const rescueTriggered = new Set(calcs.filter(rescueTrigger).map((calc) => calc.anchor_ms));
      const lowDetectors: Detector[] = [
        ...(['IOB', 'ZT', 'COB', 'UAM', 'MAIN', 'CGM_TREND', 'SHRINK', 'LINEAR'] as Predictor[]).map((predictor) => curveDetector(predictor, below)),
        { name: 'ZT_AND_MAIN', fires: (calc) => curveDetector('ZT', below).fires(calc) && curveDetector('MAIN', below).fires(calc) },
        { name: 'CARBS_REQ_3G', fires: (calc) => calc.bg >= LOW && (calc.prediction.carbs_req_g ?? 0) >= 3 },
        { name: 'RESCUE_V1', fires: (calc) => rescueTriggered.has(calc.anchor_ms) },
        {
          // The push needs a second flag on a newer reading 4–15 min after the first (rescue-alert-policy, PENDING).
          name: 'RESCUE_V1_PUSH',
          fires: (calc) => rescueTriggered.has(calc.anchor_ms)
            && [...rescueTriggered].some((atMs) => calc.anchor_ms - atMs >= 4 * MINUTE && calc.anchor_ms - atMs <= 15 * MINUTE),
        },
      ];
      const highDetectors = (threshold: number) => {
        const above = (value: number) => value > threshold;
        return (['IOB', 'COB', 'UAM', 'MAIN', 'EVENTUAL', 'CGM_TREND', 'SHRINK', 'LINEAR'] as Predictor[]).map((predictor) => curveDetector(predictor, above));
      };
      const events = {
        low_70: lowDetectors.map((detector) => scoreEvents(calcs, window, below, detector, days)),
        ...Object.fromEntries(HIGHS.map((threshold) => [`high_${threshold}`, highDetectors(threshold).map((detector) => scoreEvents(calcs, window, (value) => value > threshold, detector, days))])),
      };

      // rescue-carbs v1 vs v2 replayed minute by minute through the alert state machine. v2 reads the calibration
      // fitted without the day it is scored on (the production coefficients come from all days).
      const firstDay = calcs[0].anchor_ms;
      const foldOf = (ms: number) => Math.floor((ms - firstDay) / (24 * 60 * MINUTE));
      const heldOut = new Map<number, ForecastCalibration>();
      const calibrationAt = (ms: number) => {
        const fold = Math.max(0, foldOf(ms));
        if (!heldOut.has(fold)) heldOut.set(fold, heldOutCalibration(calibration.SHRINK, fold));
        return heldOut.get(fold)!;
      };
      const v2 = (policy: RescueV2PolicyOverrides = {}, inSample = false) =>
        (args: Parameters<typeof evaluateRescueNeed>[0]) => evaluateRescueNeedV2({ ...args, policy, calibration: inSample ? FITTED_V1_FORECAST_CALIBRATION : calibrationAt(args.now.getTime()) });
      const replay = (variant: string, evaluate: Parameters<typeof simulateRescueAlerts>[0]['evaluate']) =>
        scorePushes(variant, simulateRescueAlerts({ patient, fromMs: firstMs, toMs: lastMs, evaluate }), window, days);
      const alerts = [
        replay('rescue-carbs.v1 (production until now)', evaluateRescueNeed),
        replay('rescue-carbs.v2', v2()),
        replay('v2, CGM confirms when < 70 within 20 min', v2({ cgm_confirm_minutes: 20 })),
        replay('v2, CGM confirms when < 70 within 45 min', v2({ cgm_confirm_minutes: 45 })),
        replay('v2, CGM trend flags only without a loop forecast', v2({ cgm_trend_with_loop: false })),
        replay('v2, confirmed only by the calibrated forecast', v2({ calibrated_only: true })),
        replay('v2, confirmed only by the calibrated forecast < 80 (hybrid, objective-jones)', v2({ calibrated_only: true, calibrated_confirm_mgdl: 80 })),
        replay('v2, calibrated < 80 or the CGM falling', v2({ calibrated_confirm_mgdl: 80 })),
      ];
      if (FITTED_V1_FORECAST_CALIBRATION.validation.mae_main_30 > 0) alerts.push(replay('v2 with the fitted-v1 calibration (in sample)', v2({}, true)));

      const contextCounts = { CARBS_ABSORBING: 0, UNEXPLAINED_RISE: 0, OTHER: 0 } as Record<Context, number>;
      for (const calc of calcs) contextCounts[calc.context] += 1;
      const summary = {
        patient: `patient-${(report.patients as unknown[]).length + 1}`,
        from: new Date(firstMs).toISOString(),
        to: new Date(lastMs).toISOString(),
        days: Math.round(days * 100) / 100,
        calculations: calcs.length,
        skipped_without_reading: noAnchor,
        iob_curves_shorter_than_120_min: trimmedTails,
        readings: window.length,
        carb_entries: carbs.filter((atMs) => atMs >= firstMs && atMs <= lastMs).length,
        contexts: contextCounts,
        rise_without_carbs_seen_after: calcs.filter(uncoveredRise).length,
        rise_with_carbs_seen_after: calcs.filter(coveredRise).length,
        curve_present: Object.fromEntries((['IOB', 'ZT', 'COB', 'UAM'] as ForecastCurveName[]).map((name) => [name, calcs.filter((calc) => calc.prediction.curves[name]).length])),
        carbs_req_positive: calcs.filter((calc) => (calc.prediction.carbs_req_g ?? 0) > 0).length,
        low_readings: window.filter((reading) => reading.value < LOW).length,
        high_180_readings: window.filter((reading) => reading.value > 180).length,
        high_250_readings: window.filter((reading) => reading.value > 250).length,
      };
      (report.patients as unknown[]).push({ summary, accuracy: contexts, events, alerts, calibration });
      tables.push(renderTables(summary, contexts, events, alerts));
    }
    writeEvaluationOutputDirFile(outputDir, 'results.json', JSON.stringify(report, null, 2));
    writeEvaluationOutputDirFile(outputDir, 'TABLES.md', tables.join('\n\n'));
    console.log(`Wrote results.json and TABLES.md to ${outputDir}`);
  } finally {
    client.release();
    await pool.end();
  }
}

function renderTables(summary: Record<string, unknown>, contexts: Record<string, ReturnType<typeof accuracy>>, events: Record<string, EventScore[]>, alerts: PushScore[]): string {
  const lines: string[] = [`## ${summary.patient}`, '', '```json', JSON.stringify(summary, null, 2), '```', ''];
  lines.push('### Rescue alerts replayed minute by minute (pushes; false = predicted-low push without CGM < 70 within 45 min)', '');
  lines.push('| variant | lows | warned 15–30 min | warned 5–30 min | any push −30..+10 min | pushes | predicted-low pushes | false | false/day | reminders | lead per low (min) |', '|---|---|---|---|---|---|---|---|---|---|---|');
  for (const score of alerts) {
    lines.push(`| ${score.variant} | ${score.episodes} | ${score.warned_15_30} | ${score.warned_5_30} | ${score.covered_by_push} | ${score.pushes} | ${score.predicted_low_pushes} | ${score.false_pushes} | ${score.false_pushes_per_day} | ${score.reminders} | ${score.lead_minutes.map((lead) => lead ?? '–').join(', ')} |`);
  }
  lines.push('');
  for (const [name, table] of Object.entries(contexts)) {
    lines.push(`### Accuracy: ${name} (MAE / bias mg/dL, bias = forecast − CGM; n)`, '');
    lines.push(`| predictor | ${HORIZONS.map((horizon) => `+${horizon}`).join(' | ')} |`, `|---|${HORIZONS.map(() => '---').join('|')}|`);
    for (const predictor of PREDICTORS) {
      const cells = HORIZONS.map((horizon) => {
        const stats = table[predictor][`+${horizon}`];
        return stats.n === 0 ? '–' : `${stats.mae} / ${stats.bias! > 0 ? '+' : ''}${stats.bias} (${stats.n})`;
      });
      lines.push(`| ${predictor} | ${cells.join(' | ')} |`);
    }
    lines.push('');
  }
  for (const [name, scores] of Object.entries(events)) {
    lines.push(`### Events: ${name} (alarm = forecast crosses within 30 min; false = CGM did not cross within 45 min)`, '');
    lines.push('| detector | episodes | warned 15–30 min | warned 5–30 min | alarms | false | false/day | precision | lead per episode (min) |', '|---|---|---|---|---|---|---|---|---|');
    for (const score of scores) {
      lines.push(`| ${score.detector} | ${score.episodes} | ${score.warned_15_30} | ${score.warned_5_30} | ${score.alarms} | ${score.false_alarms} | ${score.false_alarms_per_day} | ${score.precision ?? '–'} | ${score.lead_minutes.map((lead) => lead ?? '–').join(', ')} |`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

if (require.main === module) {
  main().catch((error) => {
    console.error(describeErrorSafely(error, [BacktestArgumentError]));
    process.exitCode = 1;
  });
}
