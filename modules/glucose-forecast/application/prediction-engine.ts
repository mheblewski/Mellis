import { parseBoolean } from '@infra/config/environment';
import type { LoopPrediction } from '@modules/loop-system/application/loop-prediction';
import type { GlucosePoint } from './cgm-trend';
import { buildGlucoseForecast, loopCurve, type GlucoseForecast } from './glucose-forecast';
import { predictSimpleLine, type LinePoint, type SimpleLineParams } from './simple-line';

/**
 * The prediction engine: one place that produces predictions, with separate
 * named outputs, because no single line can serve every use. Experimental: an owner turns it on per
 * patient, and it stays beside the dose and alert code. Those do not read it (prediction-engine.spec.ts holds that).
 *
 * v2 fills `loop`, the forecast every other module already reads, `line`, `plan` and `late_rise`. `risk` comes later.
 */
export const PREDICTION_ENGINE_POLICY = {
  version: 'prediction-engine.v2',
  /** Moments where the line may mislead most, labelled in the log for scoring. The app always draws the line (owner, 2026-11-07). */
  hide: { below_mgdl: 100, above_mgdl: 250, falling_per_min: -1, loop_low_mgdl: 70, loop_low_minutes: 30, loop_silent_from_minutes: 15, loop_silent_to_minutes: 180 },
} as const;

export type LineHiddenReason = 'NO_FRESH_READING' | 'LOW_RANGE' | 'HIGH_RANGE' | 'FALLING_FAST' | 'LOW_EXPECTED' | 'ALERT_ACTIVE' | 'LOOP_SILENT';

export interface PredictionContext {
  now: Date;
  readings: GlucosePoint[];
  prediction: LoopPrediction | null;
  /** What is planned and possible late rises, read for the app; absent for the worker's log. */
  plan?: PredictionPlanEvent[];
  late_rise?: PredictionLateRise[];
  /** Absent: no line is worked out (`loop` alone). */
  line?: {
    params: SimpleLineParams;
    /** The newest carbs of the last 4 hours, or null: after a meal the fan is wider. */
    last_carbs_at: string | null;
    active_alert: boolean;
  };
}

export type PredictionLinePoint = LinePoint;

export type PredictionPlanKind = 'BOLUS_PART' | 'WBT_INSULIN' | 'PLANNED_MEAL' | 'PLANNED_MOVEMENT' | 'LATER_CARBS' | 'REMINDER';

export interface PredictionPlanEvent {
  kind: PredictionPlanKind;
  at: string;
  /** A planned meal's or movement's own title; null: the app names the kind. */
  title: string | null;
  state: 'PLANNED' | 'DONE_EARLY' | 'SKIPPED';
}

/** A time window with no number: fat and protein may raise glucose then. How much is not known (poprawka_wbt.md). */
export interface PredictionLateRise {
  meal_id: string;
  from: string;
  to: string;
  /** WBT insulin is planned for this meal. */
  insulin_planned: boolean;
  /** WBT insulin was given for this meal. */
  insulin_given: boolean;
}

export interface PredictionSet {
  engine_version: string;
  computed_at: string;
  input_quality: { reading_age_minutes: number | null; loop_age_minutes: number | null };
  /** What the loop itself says, untouched. */
  loop: GlucoseForecast;
  /** What will probably happen: for looking at and for the AI model, never for doses or alerts. Null until stage 3. */
  line: { model_id: string; source: SimpleLineParams['source']; after_carbs: boolean; points: PredictionLinePoint[]; hidden_reason: LineHiddenReason | null } | null;
  /** Whether an extreme value is coming: for alerts, after its own gate. Null until stage 6. */
  risk: { model_id: string; low_30: number | null; low_60: number | null; high_60: number | null } | null;
  /** What is planned: facts, not forecasts. Not on the line: a plan can change, and the line does not know doses. */
  plan: PredictionPlanEvent[];
  /** A possible late rise after a meal. */
  late_rise: PredictionLateRise[];
}

export function predict(context: PredictionContext): PredictionSet {
  const loop = buildGlucoseForecast({ now: context.now, readings: context.readings, prediction: context.prediction });
  return {
    engine_version: PREDICTION_ENGINE_POLICY.version,
    computed_at: context.now.toISOString(),
    input_quality: { reading_age_minutes: loop.reading_age_minutes, loop_age_minutes: loop.loop_age_minutes },
    loop,
    line: context.line ? lineOf(context, loop, context.line) : null,
    risk: null,
    plan: context.plan ?? [],
    late_rise: context.late_rise ?? [],
  };
}

function lineOf(context: PredictionContext, loop: GlucoseForecast, input: NonNullable<PredictionContext['line']>): PredictionSet['line'] {
  const afterCarbs = input.last_carbs_at !== null && context.now.getTime() - Date.parse(input.last_carbs_at) <= 240 * 60_000;
  const made = predictSimpleLine({ readings: loop.readings, params: input.params, after_carbs: afterCarbs });
  return {
    model_id: input.params.model_id,
    source: input.params.source,
    after_carbs: afterCarbs,
    points: made?.points ?? [],
    hidden_reason: hiddenReason(loop, input, made?.slope_per_min ?? null),
  };
}

/** Which risky moment this is, for the log only: the owner tests the line at every moment, so the app is not told. */
function hiddenReason(loop: GlucoseForecast, input: NonNullable<PredictionContext['line']>, slope: number | null): LineHiddenReason | null {
  const hide = PREDICTION_ENGINE_POLICY.hide;
  const glucose = loop.glucose?.value;
  if (glucose === undefined || !loop.reading_fresh) return 'NO_FRESH_READING';
  if (input.active_alert) return 'ALERT_ACTIVE';
  if (glucose < hide.below_mgdl) return 'LOW_RANGE';
  if (glucose > hide.above_mgdl) return 'HIGH_RANGE';
  if (slope !== null && slope <= hide.falling_per_min) return 'FALLING_FAST';
  if (loop.main_curve) {
    const soon = Math.floor(hide.loop_low_minutes / 5) + 1;
    if (loopCurve(loop, loop.main_curve).slice(0, soon).some((point) => point.value < hide.loop_low_mgdl)) return 'LOW_EXPECTED';
  }
  const loopAge = loop.loop_age_minutes;
  if (loopAge !== null && loopAge > hide.loop_silent_from_minutes && loopAge <= hide.loop_silent_to_minutes) return 'LOOP_SILENT';
  return null;
}

/** What leaves the server: the line with its points at every moment. The label stays in the log. */
export function predictionForApp(set: PredictionSet): PredictionSet {
  return set.line?.hidden_reason ? { ...set, line: { ...set.line, hidden_reason: null } } : set;
}

/**
 * A prediction switch that is on unless set: parseBoolean's values (true/false, 1/0, spaces ignored). A value it does
 * not know ("off", a typo) turns the feature off, so an operator who meant to switch it off is never left with it on.
 */
export function predictionFlagOn(env: Record<string, string | undefined>, key: string): boolean {
  try {
    return parseBoolean(env, key, true);
  } catch {
    return false;
  }
}

/**
 * The forecast line on the charts (the loop's curve, its cloud and the plan markers): on for every patient by default,
 * no longer part of the experiment. PREDICTION_LINE_ENABLED=false (or 0) turns it off on the server.
 */
export function isPredictionLineEnabled(env: Record<string, string | undefined>): boolean {
  return predictionFlagOn(env, 'PREDICTION_LINE_ENABLED');
}

/** The server's kill switch: PREDICTION_EXPERIMENT_ENABLED=false (or 0) turns the feature off for every patient. */
export function isPredictionExperimentEnabled(env: Record<string, string | undefined>): boolean {
  return predictionFlagOn(env, 'PREDICTION_EXPERIMENT_ENABLED');
}
