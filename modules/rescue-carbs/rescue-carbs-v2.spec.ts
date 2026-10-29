import { describe, expect, it } from 'vitest';
import { calibratedLoopCurve, FITTED_V1_FORECAST_CALIBRATION, forecastProfileFromEnv, NO_FORECAST_CALIBRATION, shrinkAt, type ForecastCalibration } from '@modules/glucose-forecast/application/forecast-calibration';
import { buildGlucoseForecast } from '@modules/glucose-forecast/application/glucose-forecast';
import { parseLoopPrediction } from '@modules/loop-system/application/loop-prediction';
import { decideRescueAlert, type RescueAlertRecord } from './application/rescue-alert-policy';
import { RescueCarbAlertService } from './application/rescue-carb-alert.service';
import type { RescueCarbsStore } from './application/rescue-carbs-store';
import { evaluateRescueNeed, evaluateRescueNeedV2, type RescueEvaluation, type RescueReading } from './application/rescue-detection';

const NOW = new Date('2026-10-21T12:00:00.000Z');
const minutes = (value: number) => new Date(NOW.getTime() + value * 60_000).toISOString();
function cgm(values: number[], endAt = -1): RescueReading[] {
  return values.map((value, index) => ({ at: minutes(endAt - (values.length - 1 - index) * 5), value }));
}
function trio(suggested: Record<string, unknown> = {}, at = minutes(-1)) {
  return {
    observed_at: at,
    raw_payload: { openaps: { suggested: { bg: 100, deliverAt: at, IOB: 1, COB: 0, ISF: 150, CR: 15, eventualBG: 90, ...suggested } } },
  };
}
const flat = (value: number, length = 8) => Array.from({ length }, () => value);
const HALF: ForecastCalibration = { ...FITTED_V1_FORECAST_CALIBRATION, version: 'test-half', shrink_by_minutes: { 5: 0.5 } };

describe('FORECAST_CALIBRATION', () => {
  it('is off unless fitted-v1 is named, and refuses an unknown value', () => {
    expect(forecastProfileFromEnv({}).id).toBe('none');
    expect(forecastProfileFromEnv({ FORECAST_CALIBRATION: ' None ' }).id).toBe('none');
    expect(forecastProfileFromEnv({ FORECAST_CALIBRATION: 'fitted-v1' }).id).toBe('fitted-v1');
    expect(() => forecastProfileFromEnv({ FORECAST_CALIBRATION: 'fitted' })).toThrow(/FORECAST_CALIBRATION/);
  });

  it('leaves the loop\'s curve as it is by default', () => {
    const forecast = buildGlucoseForecast({ now: NOW, readings: cgm([110, 105, 100]), prediction: parseLoopPrediction(trio({ predBGs: { IOB: [100, 90, 80] } })) });
    expect(shrinkAt(NO_FORECAST_CALIBRATION, 30)).toBe(1);
    expect(calibratedLoopCurve(forecast, 15).map((point) => point.value)).toEqual([100, 90, 80, 80]);
  });
});

describe('glucose-forecast-calibration.v1 (fitted-v1, opt-in)', () => {
  it('records its fit and scales the main curve per horizon, holding a trimmed tail', () => {
    expect(FITTED_V1_FORECAST_CALIBRATION).toMatchObject({ version: 'glucose-forecast-calibration.v1', method: 'SHRINK', source: 'OPENAPS' });
    expect(FITTED_V1_FORECAST_CALIBRATION.data_window).toEqual({ source: 'local backup', days: 6, calculations: 1700 });
    expect(shrinkAt(FITTED_V1_FORECAST_CALIBRATION, 30)).toBeLessThan(shrinkAt(FITTED_V1_FORECAST_CALIBRATION, 5));
    expect(shrinkAt(HALF, 120)).toBe(0.5);
    const forecast = buildGlucoseForecast({ now: NOW, readings: cgm([110, 105, 100]), prediction: parseLoopPrediction(trio({ predBGs: { IOB: [100, 90, 80] } })) });
    expect(calibratedLoopCurve(forecast, 15, HALF).map((point) => point.value)).toEqual([100, 95, 90, 90]);
    expect(calibratedLoopCurve(buildGlucoseForecast({ now: NOW, readings: cgm([110, 105, 100]), prediction: null }), 30)).toEqual([]);
  });
});

describe('evaluateRescueNeedV2 (rescue-carbs.v2)', () => {
  const falling = cgm([130, 120, 110, 100]);

  it("flags Trio's raw signals and confirms by the falling CGM", () => {
    const evaluation = evaluateRescueNeedV2({ now: NOW, readings: falling, prediction: parseLoopPrediction(trio({ carbsReq: 6, predBGs: { IOB: flat(100), ZT: [100, 95, 90, 85, 80, 75, 68] } })), last_carbs_at: null, calibration: HALF });
    expect(evaluation).toMatchObject({
      policy_version: 'rescue-carbs.v2', status: 'TRIGGER', level: 'PREDICTED_LOW', trigger_source: 'TRIO_CARBS_REQ',
      signals: ['TRIO_CARBS_REQ', 'TRIO_ZT', 'CGM_TREND'], confirmed: true, confirmation: 'CGM_FALLING', calibration_version: 'test-half',
    });
  });

  it('leaves a raw Trio signal unconfirmed while the CGM is flat and the calibrated forecast stays above 70', () => {
    const evaluation = evaluateRescueNeedV2({ now: NOW, readings: cgm([101, 100, 100, 100]), prediction: parseLoopPrediction(trio({ predBGs: { IOB: [100, 95, 90, 84, 78, 72, 66], ZT: [100, 94, 88, 82, 76, 70, 64] } })), last_carbs_at: null, calibration: HALF });
    expect(evaluation).toMatchObject({ status: 'TRIGGER', level: 'PREDICTED_LOW', trigger_source: 'TRIO_PREDICTION', signals: ['TRIO_ZT'], confirmed: false, confirmation: null, calibrated_min_mgdl: 83 });
  });

  it('confirms by the calibrated forecast crossing 70 within 30 min', () => {
    const evaluation = evaluateRescueNeedV2({ now: NOW, readings: cgm([82, 81, 80, 80]), prediction: parseLoopPrediction(trio({ bg: 80, predBGs: { IOB: [80, 74, 68, 62, 56, 50, 46], ZT: flat(80) } })), last_carbs_at: null, calibration: HALF });
    expect(evaluation).toMatchObject({ signals: ['CALIBRATED_FORECAST'], confirmed: true, confirmation: 'CALIBRATED_FORECAST', trigger_source: 'TRIO_PREDICTION' });
    expect(evaluation.calibrated_low_at).toBe(minutes(19));
  });

  it("confirms on the loop's own curve by default (no calibration): earlier than on the shrunk one", () => {
    const evaluation = evaluateRescueNeedV2({ now: NOW, readings: cgm([82, 81, 80, 80]), prediction: parseLoopPrediction(trio({ bg: 80, predBGs: { IOB: [80, 74, 68, 62, 56, 50, 46], ZT: flat(80) } })), last_carbs_at: null });
    expect(evaluation).toMatchObject({ confirmed: true, confirmation: 'CALIBRATED_FORECAST', calibration_version: null });
    expect(evaluation.calibrated_low_at).toBe(minutes(9));
  });

  it("keeps v1's lows now, suppression, curve and predicted minimum", () => {
    const urgent = evaluateRescueNeedV2({ now: NOW, readings: cgm([70, 62, 57, 52]), prediction: null, last_carbs_at: null });
    expect(urgent).toMatchObject({ level: 'URGENT_LOW', trigger_source: 'CGM_LOW', confirmed: true, confirmation: null });
    const input = { now: NOW, readings: falling, prediction: parseLoopPrediction(trio({ carbsReq: 6 })), last_carbs_at: minutes(-5) };
    const v1 = evaluateRescueNeed(input);
    const v2 = evaluateRescueNeedV2(input);
    expect(v2).toMatchObject({ status: 'SUPPRESSED', suppressed_reason: 'RECENT_CARBS' });
    expect([v2.predicted_min_mgdl, v2.predicted_low_at, v2.curve]).toEqual([v1.predicted_min_mgdl, v1.predicted_low_at, v1.curve]);
    // A meal holds back only the predicted low; < 54 is never held back.
    expect(evaluateRescueNeedV2({ ...input, last_hypo_treatment_at: null })).toMatchObject({ status: 'SUPPRESSED', suppressed_reason: 'RECENT_CARBS' });
    expect(evaluateRescueNeedV2({ now: NOW, readings: cgm([70, 62, 57, 52]), prediction: null, last_carbs_at: minutes(-5), last_hypo_treatment_at: minutes(-5) })).toMatchObject({ status: 'TRIGGER', level: 'URGENT_LOW', confirmed: true });
    expect(evaluateRescueNeedV2({ now: NOW, readings: cgm([80, 75, 70, 66]), prediction: null, last_carbs_at: minutes(-5), last_hypo_treatment_at: null })).toMatchObject({ status: 'TRIGGER', level: 'LOW_NOW' });
  });
});

function pending(evaluation: RescueEvaluation, overrides: Partial<RescueAlertRecord> = {}): RescueAlertRecord {
  return {
    id: 'alert-1', patient_id: 'p1', status: 'PENDING', level: 'PREDICTED_LOW', trigger_source: 'TRIO_PREDICTION', first_flag_at: minutes(-5), first_flag_reading_at: minutes(-6),
    notified_at: null, notified_level: null, reminder_sent_at: null, last_evaluated_at: minutes(-1), clear_since: null, evaluation, proposal: null, conversation_id: null,
    treatment_event_id: null, treatment_carbs_g: null, treated_at: null, treated_by_user_id: null, treatment_source: null, treatment_proposal_id: null,
    declined_at: null, declined_by_user_id: null, outcome: null, resolved_at: null, created_at: minutes(-5), ...overrides,
  };
}

describe('decideRescueAlert with rescue-carbs.v2', () => {
  const unconfirmed = evaluateRescueNeedV2({ now: NOW, readings: cgm([101, 100, 100, 100]), prediction: parseLoopPrediction(trio({ predBGs: { IOB: [100, 95, 90, 84, 78, 72, 66], ZT: [100, 94, 88, 82, 76, 70, 64] } })), last_carbs_at: null, calibration: HALF });
  const confirmed = evaluateRescueNeedV2({ now: NOW, readings: cgm([130, 120, 110, 100]), prediction: parseLoopPrediction(trio({ carbsReq: 6 })), last_carbs_at: null, calibration: HALF });

  it('starts PENDING on a raw signal and pushes only once confirmed on a newer reading', () => {
    expect(decideRescueAlert(null, unconfirmed, NOW).action).toBe('START_PENDING');
    expect(decideRescueAlert(null, confirmed, NOW).action).toBe('START_PENDING');
    expect(decideRescueAlert(pending(unconfirmed), unconfirmed, NOW).action).toBe('NONE');
    expect(decideRescueAlert(pending(unconfirmed), confirmed, NOW).action).toBe('NOTIFY');
    expect(decideRescueAlert(pending(confirmed, { first_flag_reading_at: confirmed.glucose!.at }), confirmed, NOW).action).toBe('NONE');
    expect(decideRescueAlert(pending(unconfirmed, { first_flag_at: minutes(-16) }), confirmed, NOW).action).toBe('CANCEL');
  });

  it('reminds only while the low is still confirmed', () => {
    const notified = pending(confirmed, { status: 'NOTIFIED', notified_at: minutes(-16), notified_level: 'PREDICTED_LOW' });
    expect(decideRescueAlert(notified, confirmed, NOW).action).toBe('REMIND');
    expect(decideRescueAlert(notified, unconfirmed, NOW).action).toBe('NONE');
  });
});

describe('RescueCarbAlertService: v2 decides, v1 is a logged shadow', () => {
  function setup(readings: () => RescueReading[], status: () => ReturnType<typeof trio>) {
    const alerts: RescueAlertRecord[] = [];
    const store: RescueCarbsStore = {
      listPatientsWithAlertDevices: async () => ['p1'],
      listAlertDevices: async () => [{ device_id: 'd1', push_token: 'token-1' }],
      getActiveAlert: async () => alerts.find((alert) => ['PENDING', 'NOTIFIED', 'TREATED'].includes(alert.status)) ?? null,
      insertAlert: async (input: { status: 'PENDING' | 'NOTIFIED'; evaluation: RescueEvaluation; now: string }) => {
        const alert = pending(input.evaluation, { id: `alert-${alerts.length + 1}`, status: input.status, first_flag_at: input.now, first_flag_reading_at: input.evaluation.glucose?.at ?? null });
        alerts.push(alert);
        return alert;
      },
      touchAlert: async () => undefined,
      markNotified: async (id: string, args: { now: string }) => Object.assign(alerts.find((alert) => alert.id === id)!, { status: 'NOTIFIED', notified_at: args.now, conversation_id: 'conv-1' }),
      closeAlert: async (id: string, args: { status: RescueAlertRecord['status'] }) => { Object.assign(alerts.find((alert) => alert.id === id)!, { status: args.status }); },
      markPushDelivered: async () => undefined,
      claimPushResend: async () => null,
      getRecentEatenCarbs: async () => ({ last_carbs_at: null, last_hypo_treatment_at: null }),
    } as unknown as RescueCarbsStore;
    const pushes: unknown[] = [];
    const logs: Array<Record<string, unknown>> = [];
    const service = new RescueCarbAlertService({
      store,
      data: {
        listGlucoseReadingsSince: async () => readings(),
        getLatestLoopStatus: async () => status(),
        getTherapyProfileAt: async () => ({ units: 'mg/dl', timezone: 'Europe/Warsaw', carb_ratio_g_per_u: [['00:00', 15]], sensitivity_per_u: [['00:00', 150]] }),
      },
      push: { sendRescueCarbAlert: async (input) => { pushes.push(input); } },
      log: (event) => logs.push(event),
      timezone: 'Europe/Warsaw',
    });
    return { alerts, pushes, logs, service };
  }

  it('does not push an unconfirmed Trio signal that v1 would have pushed, and logs where they differ', async () => {
    let now = NOW;
    const at = (offset: number) => new Date(now.getTime() + offset * 60_000).toISOString();
    // Flat at 100 while carbsReq says 6 g: v1 pushes on its second flag, v2 waits for a confirmation.
    const readings = () => [101, 100, 100, 100, 100].map((value, index) => ({ at: at(-1 - (4 - index) * 5), value }));
    const { alerts, pushes, logs, service } = setup(readings, () => trio({ carbsReq: 6, deliverAt: at(-1), predBGs: { IOB: flat(100), ZT: flat(100) } }, at(-1)));
    await service.run(now);
    now = new Date(NOW.getTime() + 5 * 60_000);
    await service.run(now);
    expect(alerts[0].status).toBe('PENDING');
    expect(pushes).toHaveLength(0);
    const shadow = logs.filter((log) => log.event === 'rescue_carbs_v1_shadow');
    expect(shadow.at(-1)).toMatchObject({ would_trigger: true, would_notify: true, trigger_source: 'TRIO_CARBS_REQ', v2_status: 'TRIGGER', v2_confirmed: false, v2_action: 'NONE', differs: true });
  });

  it('pushes a confirmed low on the second flag', async () => {
    let now = NOW;
    const at = (offset: number) => new Date(now.getTime() + offset * 60_000).toISOString();
    const readings = () => [140, 130, 120, 110, 100].map((value, index) => ({ at: at(-1 - (4 - index) * 5), value }));
    const { pushes, logs, service } = setup(readings, () => trio({ carbsReq: 6, deliverAt: at(-1) }, at(-1)));
    await service.run(now);
    now = new Date(NOW.getTime() + 5 * 60_000);
    await service.run(now);
    expect(pushes).toHaveLength(1);
    expect(logs.find((log) => log.event === 'rescue_carbs_decision' && log.action === 'NOTIFY')).toMatchObject({ signals: ['TRIO_CARBS_REQ', 'CGM_TREND'], confirmation: 'CGM_FALLING' });
  });
});
