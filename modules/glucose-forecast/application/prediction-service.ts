import type { LoopPrediction } from '@modules/loop-system/application/loop-prediction';
import { parseLoopPrediction } from '@modules/loop-system/application/loop-prediction';
import type { GlucosePoint } from './cgm-trend';
import { bolusChartBaseline } from './bolus-forecast';
import { activeForecastProfile } from './forecast-calibration';
import { buildGlucoseForecast, loopCurve } from './glucose-forecast';
import { predict, predictionForApp, type PredictionLateRise, type PredictionPlanEvent, type PredictionSet } from './prediction-engine';
import { DEFAULT_SIMPLE_LINE, fitSimpleLine, LINE_HORIZONS, SIMPLE_LINE_FIT, SIMPLE_LINE_MODEL_ID, type SimpleLineParams } from './simple-line';

export const PREDICTION_SERVICE_POLICY = { refit_after_hours: 20, log_retention_days: 60, tick_ms: 120_000 } as const;

/** The marker horizon covers the Bolus chart's 3 hours and more; the late rise is the WBT policy's 3-5 h after a meal. */
export const PREDICTION_PLAN_POLICY = { horizon_hours: 6, past_minutes: 60, late_rise_from_minutes: 180, late_rise_to_minutes: 300 } as const;

export interface StoredParams {
  params: SimpleLineParams;
  stored_at: string;
}

export interface PredictionLogEntry {
  patient_id: string;
  reading_at: string;
  model_id: string;
  glucose_mgdl: number;
  /** horizon in minutes → [value, low, high]. */
  points: Record<string, [number, number, number]>;
  /** horizon in minutes → the loop's main curve, moved to this reading, as the Bolus chart does; null without a fresh loop. */
  loop_main: Record<string, number> | null;
  after_carbs: boolean;
  hidden_reason: string | null;
}

export interface PredictionStore {
  listOptedInPatients(): Promise<string[]>;
  isOptedIn(patientId: string): Promise<boolean>;
  getParams(patientId: string, modelId: string): Promise<StoredParams | null>;
  saveParams(patientId: string, params: SimpleLineParams, now: Date): Promise<void>;
  log(entry: PredictionLogEntry): Promise<void>;
  pruneLog(before: Date): Promise<void>;
  /** What is planned from a little before now to the horizon, and meals whose late-rise window is not over. */
  listPlan(patientId: string, now: Date): Promise<{ plan: PredictionPlanEvent[]; late_rise: PredictionLateRise[] }>;
}

export interface PredictionLive {
  readings: Array<{ at: string; value: number }>;
  loopStatus: { observed_at: string; raw_payload: Record<string, unknown> } | null;
}

export interface PredictionSources {
  store: PredictionStore;
  /** The readings and loop status the dashboard shows. */
  live(patientId: string, now: Date): Promise<PredictionLive>;
  /** Stored readings for a fit. */
  readingsSince(patientId: string, sinceIso: string): Promise<GlucosePoint[]>;
  /** Times of carbs really eaten, oldest first. */
  carbTimes(patientId: string, fromIso: string, toIso: string): Promise<string[]>;
  activeAlert(patientId: string): Promise<boolean>;
}

function loopMainAtHorizons(prediction: LoopPrediction | null, now: Date, readings: GlucosePoint[]): Record<string, number> | null {
  const forecast = buildGlucoseForecast({ now, readings, prediction });
  if (!forecast.main_curve || !forecast.glucose) return null;
  const curve = loopCurve(forecast, forecast.main_curve);
  if (curve.length < 2) return null;
  const startMs = Date.parse(curve[0].at);
  const readingMs = Date.parse(forecast.glucose.at);
  const valueAt = (minutes: number): number | null => {
    // The loop usually computes just after the reading: before its first point, its first value holds (as on the Bolus chart).
    const position = Math.max(0, minutes / 5);
    if (position > curve.length - 1) return null;
    const lower = Math.floor(position);
    const upper = Math.min(curve.length - 1, lower + 1);
    return curve[lower].value + (position - lower) * (curve[upper].value - curve[lower].value);
  };
  const lag = (readingMs - startMs) / 60_000;
  const base = valueAt(lag);
  if (base === null) return null;
  const out: Record<string, number> = {};
  for (const horizon of LINE_HORIZONS) {
    const value = valueAt(lag + horizon);
    if (value !== null) out[String(horizon)] = Math.round(forecast.glucose.value + value - base);
  }
  return out;
}

export class PredictionService {
  constructor(private readonly sources: PredictionSources) {}

  /** The engine's outputs now, with this patient's line (defaults until they have a fit). */
  async current(patientId: string, now: Date, known?: PredictionLive, options: { with_plan?: boolean } = {}): Promise<PredictionSet> {
    const [live, stored, carbs, activeAlert, planned] = await Promise.all([
      known ?? this.sources.live(patientId, now),
      this.sources.store.getParams(patientId, SIMPLE_LINE_MODEL_ID),
      this.sources.carbTimes(patientId, new Date(now.getTime() - SIMPLE_LINE_FIT.after_carbs_minutes * 60_000).toISOString(), new Date(now.getTime() + 60_000).toISOString()),
      this.sources.activeAlert(patientId),
      // A failed read of the plan draws no markers; the line does not depend on it.
      options.with_plan ? this.sources.store.listPlan(patientId, now).catch(() => null) : Promise.resolve(null),
    ]);
    return predict({
      now,
      readings: live.readings.map((reading) => ({ at: reading.at, value: reading.value })),
      prediction: parseLoopPrediction(live.loopStatus),
      plan: planned?.plan,
      late_rise: planned?.late_rise,
      line: { params: stored?.params ?? DEFAULT_SIMPLE_LINE, last_carbs_at: carbs.at(-1) ?? null, active_alert: activeAlert },
    });
  }

  /**
   * What the app draws on Teraz (owner, 2026-11-08: one line on every screen). The line is the Bolus chart's own line
   * without a dose (bolusChartBaseline, the loop's forecast), so Teraz and Bolus never show two different futures. The
   * engine's simple line is still logged by the worker for its gate; it is not sent while it does not lead.
   */
  async forApp(patientId: string, now: Date): Promise<PredictionSet> {
    const live = await this.sources.live(patientId, now);
    const set = predictionForApp(await this.current(patientId, now, live, { with_plan: true }));
    return { ...set, line: bolusLineForApp(now, live) };
  }

  /** The worker: for every patient with the experiment on, refit about daily and log the line at each new reading. */
  async tick(now: Date, log: (event: Record<string, unknown>) => void = () => {}): Promise<void> {
    const patients = await this.sources.store.listOptedInPatients();
    for (const patientId of patients) {
      try {
        await this.refitIfDue(patientId, now, log);
        await this.logCurrent(patientId, now);
      } catch (error) {
        log({ event: 'prediction_tick_failed', patient_id: patientId, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  async refitIfDue(patientId: string, now: Date, log: (event: Record<string, unknown>) => void = () => {}): Promise<void> {
    const stored = await this.sources.store.getParams(patientId, SIMPLE_LINE_MODEL_ID);
    const ageMs = stored ? now.getTime() - Date.parse(stored.stored_at) : Infinity;
    if (ageMs < PREDICTION_SERVICE_POLICY.refit_after_hours * 3_600_000) return;
    const sinceIso = new Date(now.getTime() - SIMPLE_LINE_FIT.window_days * 86_400_000).toISOString();
    const [readings, carbs] = await Promise.all([
      this.sources.readingsSince(patientId, sinceIso),
      this.sources.carbTimes(patientId, sinceIso, now.toISOString()),
    ]);
    const params = fitSimpleLine({ readings, carb_times_ms: carbs.map((at) => Date.parse(at)), now });
    await this.sources.store.saveParams(patientId, params, now);
    await this.sources.store.pruneLog(new Date(now.getTime() - PREDICTION_SERVICE_POLICY.log_retention_days * 86_400_000));
    log({ event: 'prediction_refit', patient_id: patientId, source: params.source, days: params.days });
  }

  private async logCurrent(patientId: string, now: Date): Promise<void> {
    const live = await this.sources.live(patientId, now);
    const set = await this.current(patientId, now, live);
    const line = set.line;
    const glucose = set.loop.glucose;
    if (!line || !glucose || line.points.length === 0 || !set.loop.reading_fresh) return;
    const points: PredictionLogEntry['points'] = {};
    LINE_HORIZONS.forEach((horizon, index) => {
      const point = line.points[index];
      if (point) points[String(horizon)] = [point.value, point.low, point.high];
    });
    await this.sources.store.log({
      patient_id: patientId,
      reading_at: glucose.at,
      model_id: line.model_id,
      glucose_mgdl: glucose.value,
      points,
      loop_main: loopMainAtHorizons(parseLoopPrediction(live.loopStatus), now, set.loop.readings),
      after_carbs: line.after_carbs,
      hidden_reason: line.hidden_reason,
    });
  }
}

/**
 * The Bolus chart's line without a dose, 90 min ahead, with the Bolus chart's own cloud (the error at 30 min, widening
 * with the square root of time), so Teraz draws exactly what Bolus draws before a dose. Null without a fresh reading.
 */
export function bolusLineForApp(now: Date, live: PredictionLive): PredictionSet['line'] {
  const base = bolusChartBaseline({ now, readings: live.readings.map((reading) => ({ at: reading.at, value: reading.value })), prediction: parseLoopPrediction(live.loopStatus), horizon_minutes: BOLUS_LINE_ON_TERAZ_MINUTES });
  if (!base) return null;
  const step = 5;
  const band30 = activeForecastProfile().bolus_chart.band_mae_30_mgdl;
  const points = base.baseline.slice(1, Math.floor(BOLUS_LINE_ON_TERAZ_MINUTES / step) + 1).map((value, index) => {
    const rounded = Math.round(value);
    const band = Math.round(band30 * Math.sqrt(((index + 1) * step) / 30));
    return { at: new Date(base.start_ms + (index + 1) * step * 60_000).toISOString(), value: rounded, low: Math.max(39, rounded - band), high: Math.min(401, rounded + band) };
  });
  return { model_id: `bolus-chart-base:${base.baseline_source}`, source: 'DEFAULT', after_carbs: false, points, hidden_reason: null };
}

export const BOLUS_LINE_ON_TERAZ_MINUTES = 90;
