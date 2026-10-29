import { calibratedLoopCurve } from '@modules/glucose-forecast/application/forecast-calibration';
import { buildGlucoseForecast, lowestWithin } from '@modules/glucose-forecast/application/glucose-forecast';
import { parseLoopPrediction } from '@modules/loop-system/application/loop-prediction';
import { glucoseRisingForSecondDose } from './bolus-reminders';
import { plannedBolusForceAt, plannedBolusReadiness, planTrigger, type PlannedBolusReadiness, type PlannedBolusRecord } from './split-bolus';

/** How far ahead the loop's forecast (calibrated only with FORECAST_CALIBRATION) must stay above the readiness limit. */
const READY_FORECAST_HORIZON_MINUTES = 30;

/**
 * Whether a planned part's reminder should come now (deferred-bolus.v1, later-plan.v1), from the synced readings and
 * the loop's newest calculation.
 */
export function plannedBolusReadinessFrom(input: {
  now: Date;
  plan: Pick<PlannedBolusRecord, 'kind' | 'trigger' | 'wait_until' | 'due_at' | 'threshold_mgdl'>;
  meal_started_at: string;
  readings: Array<{ at: string; value: number }>;
  loopStatus: { observed_at: string; raw_payload: Record<string, unknown> } | null;
}): PlannedBolusReadiness & { forecast_min_mgdl: number | null; slope_per_min: number | null } {
  const forecast = buildGlucoseForecast({ now: input.now, readings: input.readings, prediction: parseLoopPrediction(input.loopStatus) });
  const calibrated = calibratedLoopCurve(forecast, READY_FORECAST_HORIZON_MINUTES);
  const forecastMin = calibrated.length > 1 ? lowestWithin(calibrated)?.value ?? null : null;
  const readiness = plannedBolusReadiness({
    now: input.now,
    trigger: planTrigger(input.plan),
    due_at: input.plan.due_at,
    force_at: plannedBolusForceAt(input.plan, input.meal_started_at),
    glucose: forecast.glucose ? { value: forecast.glucose.value, at: forecast.glucose.at } : null,
    slope_per_min: forecast.slope_per_min,
    forecast_min_mgdl: forecastMin,
    threshold_mgdl: input.plan.threshold_mgdl,
    rising: glucoseRisingForSecondDose(input.readings, input.now),
  });
  return { ...readiness, forecast_min_mgdl: forecastMin, slope_per_min: forecast.slope_per_min === null ? null : Math.round(forecast.slope_per_min * 100) / 100 };
}
