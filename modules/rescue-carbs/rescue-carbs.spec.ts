import { describe, expect, it } from 'vitest';
import { parseLoopPrediction } from '@modules/loop-system/application/loop-prediction';
import { evaluateRescueNeed, type RescueEvaluation, type RescueReading } from './application/rescue-detection';
import { computeRescueDose } from './application/rescue-dose';
import { computeRescueOutcome, decideRescueAlert, rescuePushToResend, type RescueAlertRecord } from './application/rescue-alert-policy';
import { buildRescuePushText, RescueCarbAlertService } from './application/rescue-carb-alert.service';
import type { RescueCarbsStore } from './application/rescue-carbs-store';
import { RESCUE_CARB_CHAT_INSTRUCTIONS, RESCUE_CARB_PROPOSAL_INSTRUCTIONS, RescueCarbProposalSession } from './application/rescue-carb-proposal-tool';
import { parseRescueCarbs, parseRescueGivenAt, toRescueCarbsView, withRescueCarbProposals } from './application/rescue-carbs-view';

const NOW = new Date('2026-10-20T12:00:00.000Z');
const minutes = (value: number) => new Date(NOW.getTime() + value * 60_000).toISOString();

/** CGM every 5 min ending at `endAt` minutes from NOW, values oldest first. */
function cgm(values: number[], endAt = -1): RescueReading[] {
  return values.map((value, index) => ({ at: minutes(endAt - (values.length - 1 - index) * 5), value }));
}

function openaps(overrides: Record<string, unknown> = {}, at = minutes(-1)) {
  return {
    observed_at: at,
    raw_payload: {
      openaps: {
        suggested: {
          bg: 95,
          deliverAt: at,
          IOB: 1.2,
          COB: 0,
          ISF: 150,
          CR: 15,
          eventualBG: 60,
          predBGs: { IOB: [95, 90, 85, 80, 76, 72, 68, 65], ZT: [95, 91, 87, 83, 79, 75, 69, 66] },
          ...overrides,
        },
      },
    },
  };
}

describe('parseLoopPrediction (rescue-carbs.v1)', () => {
  it('reads oref curves, carbsReq and the calculation settings', () => {
    const prediction = parseLoopPrediction(openaps({ carbsReq: 7 }))!;
    expect(prediction.source).toBe('OPENAPS');
    expect(prediction.carbs_req_g).toBe(7);
    expect(prediction.isf_mgdl_per_u).toBe(150);
    expect(prediction.icr_g_per_u).toBe(15);
    expect(prediction.curves.ZT?.[6]).toBe(69);
    expect(prediction.computed_at).toBe(minutes(-1));
  });

  it('reads Loop\'s single curve and ignores a device status without a loop', () => {
    const loop = parseLoopPrediction({ observed_at: minutes(-2), raw_payload: { loop: { predicted: { startDate: minutes(-2), values: [100, 96, 92] }, iob: { iob: 0.5 }, cob: { cob: 3 } } } })!;
    expect(loop.source).toBe('LOOP');
    expect(loop.curves.IOB).toEqual([100, 96, 92]);
    expect(loop.cob_g).toBe(3);
    expect(parseLoopPrediction({ observed_at: minutes(-1), raw_payload: { pump: { battery: { percent: 50 } } } })).toBeNull();
    expect(parseLoopPrediction(null)).toBeNull();
  });
});

describe('evaluateRescueNeed (rescue-carbs.v1)', () => {
  const steady = cgm([110, 108, 106, 104, 103, 102]);

  it('triggers on Trio\'s carbsReq', () => {
    const evaluation = evaluateRescueNeed({ now: NOW, readings: cgm([120, 112, 105, 99, 95]), prediction: parseLoopPrediction(openaps({ carbsReq: 6 })), last_carbs_at: null });
    expect(evaluation.status).toBe('TRIGGER');
    expect(evaluation.level).toBe('PREDICTED_LOW');
    expect(evaluation.trigger_source).toBe('TRIO_CARBS_REQ');
    expect(evaluation.carbs_req_g).toBe(6);
    expect(evaluation.predicted_low_at).toBe(minutes(29));
  });

  it('triggers when the zero-temp and the IOB curves both go below 70 within 30 min', () => {
    const evaluation = evaluateRescueNeed({ now: NOW, readings: cgm([120, 112, 105, 99, 95]), prediction: parseLoopPrediction(openaps()), last_carbs_at: null });
    expect(evaluation.trigger_source).toBe('TRIO_PREDICTION');
    expect(evaluation.predicted_min_mgdl).toBe(68);
    expect(evaluation.minutes_to_low).toBe(29);
  });

  it('does not trigger when suspending basal is enough (zero-temp curve stays above 70)', () => {
    const prediction = parseLoopPrediction(openaps({ predBGs: { IOB: [95, 90, 85, 80, 76, 72, 68], ZT: [95, 93, 91, 89, 87, 85, 84] } }));
    expect(evaluateRescueNeed({ now: NOW, readings: cgm([120, 112, 105, 99, 95]), prediction, last_carbs_at: null }).status).toBe('CLEAR');
  });

  it('falls back to the CGM trend without a fresh loop calculation', () => {
    const stale = parseLoopPrediction(openaps({ carbsReq: 10 }, minutes(-25)));
    const evaluation = evaluateRescueNeed({ now: NOW, readings: cgm([130, 121, 112, 103, 95]), prediction: stale, last_carbs_at: null });
    expect(evaluation.loop_used).toBe(false);
    expect(evaluation.trigger_source).toBe('CGM_TREND');
    expect(evaluation.predicted_min_mgdl).toBeLessThan(70);
  });

  it('flags a low now and an urgent low from the CGM value', () => {
    expect(evaluateRescueNeed({ now: NOW, readings: cgm([80, 75, 70, 66]), prediction: null, last_carbs_at: null }).level).toBe('LOW_NOW');
    expect(evaluateRescueNeed({ now: NOW, readings: cgm([70, 62, 57, 52]), prediction: null, last_carbs_at: null }).level).toBe('URGENT_LOW');
  });

  it('waits 15 min after carbs were logged and skips a forecast the readings no longer support', () => {
    const recent = evaluateRescueNeed({ now: NOW, readings: cgm([80, 75, 70, 66]), prediction: null, last_carbs_at: minutes(-8) });
    expect(recent.status).toBe('SUPPRESSED');
    expect(recent.suppressed_reason).toBe('RECENT_CARBS');
    const rising = evaluateRescueNeed({ now: NOW, readings: cgm([90, 86, 84, 87, 92]), prediction: parseLoopPrediction(openaps({ carbsReq: 4 })), last_carbs_at: null });
    expect(rising.status).toBe('SUPPRESSED');
    expect(rising.suppressed_reason).toBe('RISING');
  });

  it('holds back by the kind of the recent carbs: a predicted low any, a low now only rescue carbs, < 54 none (2026-10-26)', () => {
    const lowNow = { now: NOW, readings: cgm([80, 75, 70, 66]), prediction: null };
    const urgentNow = { now: NOW, readings: cgm([70, 62, 57, 52]), prediction: null };
    const predicted = { now: NOW, readings: cgm([120, 112, 105, 99, 95]), prediction: parseLoopPrediction(openaps({ carbsReq: 5 })) };
    const meal = { last_carbs_at: minutes(-8), last_hypo_treatment_at: null };
    const rescue = { last_carbs_at: minutes(-8), last_hypo_treatment_at: minutes(-8) };

    expect(evaluateRescueNeed({ ...lowNow, ...meal })).toMatchObject({ status: 'TRIGGER', level: 'LOW_NOW' });
    expect(evaluateRescueNeed({ ...lowNow, ...rescue })).toMatchObject({ status: 'SUPPRESSED', suppressed_reason: 'RECENT_CARBS' });
    expect(evaluateRescueNeed({ ...urgentNow, ...meal })).toMatchObject({ status: 'TRIGGER', level: 'URGENT_LOW' });
    expect(evaluateRescueNeed({ ...urgentNow, ...rescue })).toMatchObject({ status: 'TRIGGER', level: 'URGENT_LOW' });
    expect(evaluateRescueNeed({ ...predicted, ...meal })).toMatchObject({ status: 'SUPPRESSED', level: 'PREDICTED_LOW', suppressed_reason: 'RECENT_CARBS' });
    // Rescue carbs older than 15 min no longer hold a low now back; the kind unknown (backtest) counts as rescue carbs.
    expect(evaluateRescueNeed({ ...lowNow, last_carbs_at: minutes(-8), last_hypo_treatment_at: minutes(-16) }).status).toBe('TRIGGER');
    expect(evaluateRescueNeed({ ...lowNow, last_carbs_at: minutes(-8) }).status).toBe('SUPPRESSED');
    expect(evaluateRescueNeed({ ...urgentNow, last_carbs_at: minutes(-8) }).status).toBe('TRIGGER');
  });

  it('needs fresh and dense enough CGM data', () => {
    expect(evaluateRescueNeed({ now: NOW, readings: cgm([80, 75, 66], -16), prediction: null, last_carbs_at: null }).no_data_reason).toBe('STALE_READING');
    expect(evaluateRescueNeed({ now: NOW, readings: cgm([75, 66]), prediction: null, last_carbs_at: null }).no_data_reason).toBe('TOO_FEW_READINGS');
    expect(evaluateRescueNeed({ now: NOW, readings: [], prediction: null, last_carbs_at: null }).status).toBe('NO_DATA');
  });

  it('is clear above 80 with a flat forecast', () => {
    const evaluation = evaluateRescueNeed({ now: NOW, readings: steady, prediction: null, last_carbs_at: null });
    expect(evaluation.status).toBe('CLEAR');
    expect(evaluation.clear).toBe(true);
  });
});

describe('computeRescueDose (rescue-dose.v3)', () => {
  const trigger = (overrides: Partial<RescueEvaluation> = {}): RescueEvaluation => ({
    ...evaluateRescueNeed({ now: NOW, readings: cgm([120, 112, 105, 99, 95]), prediction: parseLoopPrediction(openaps()), last_carbs_at: null }),
    ...overrides,
  });
  const loop = { isf_mgdl_per_u: 150, icr_g_per_u: 15, iob_u: 1.2, cob_g: 0 };
  const profile = { isf: 150, icr_g_per_u: 15, units: 'mg/dl' };

  it('aims the lowest forecast back to 90 with the child\'s CSF, from 3 g up to one 20 g portion', () => {
    const dose = computeRescueDose({ evaluation: trigger({ predicted_min_mgdl: 55 }), loop, profile });
    expect(dose.basis).toBe('FORMULA');
    expect(dose.csf_mgdl_per_g).toBe(10);
    expect([dose.min_g, dose.max_g]).toEqual([3, 20]);
    expect(dose.carbs_g).toBe(4);
    expect(dose.explanation.join(' ')).toContain('(90 − 55) / 10');
    expect(dose.explanation.join(' ')).not.toContain('zakres');
    expect(dose.warnings).toEqual([]);
  });

  it('does not take the loop\'s eventual glucose: it counts insulin on board but no COB (v3, 2026-11-01)', () => {
    const dose = computeRescueDose({ evaluation: trigger({ predicted_min_mgdl: 68 }), loop: { ...loop, eventual_bg: 20 }, profile });
    // (90 - 68) / 10 = 2.2 g → the 3 g minimum.
    expect(dose.carbs_g).toBe(3);
    expect(dose.explanation[0]).toMatch(/^Najniżej w prognozie na 30 min: 68 mg\/dL/);
  });

  it('shows Trio\'s carbsReq only for information, the dose comes from the 30-minute forecast (v3, 2026-11-01)', () => {
    // Glucose 85, IOB 1.7 U, COB 0, carbsReq 18 g: the 30-minute forecast needs (90 − 48) / 10 = 4 g.
    const evaluation = trigger({ carbs_req_g: 18, predicted_min_mgdl: 48, glucose: { at: minutes(-1), value: 85 } });
    const dose = computeRescueDose({ evaluation, loop: { system: 'TRIO', isf_mgdl_per_u: 150, icr_g_per_u: 15, iob_u: 1.7, cob_g: 0 }, profile });
    expect(dose.basis).toBe('FORMULA');
    expect(dose.carbs_g).toBe(4);
    expect(dose.trio_carbs_req_g).toBe(18);
    expect(dose.explanation.join(' ')).toContain('Trio liczy 18 g na całe działanie aktywnej insuliny; to zwykle więcej, niż potrzeba teraz.');
  });

  it('gives at most one 20 g portion and says more may be needed', () => {
    const dose = computeRescueDose({ evaluation: trigger({ predicted_min_mgdl: 39 }), loop, profile: { isf: 40, icr_g_per_u: 20, units: 'mg/dl' } });
    // Loop ISF/ICR 150/15 win: (90 - 39) / 10 = 5 g. With a CSF of 2 (40/20) the need is 26 g.
    expect(dose.carbs_g).toBe(5);
    const adult = computeRescueDose({ evaluation: trigger({ predicted_min_mgdl: 39, loop_used: false }), loop: null, profile: { isf: 40, icr_g_per_u: 20, units: 'mg/dl' } });
    expect(adult.carbs_g).toBe(20);
    expect(adult.explanation.join(' ')).toContain('Jednorazowo najwyżej 20 g');
    expect(adult.warnings[0]).toContain('więcej niż jedna porcja (26 g)');
  });

  it('keeps ISPAD\'s +70 mg/dL only for a low without a loop forecast, and gives it at least below 55', () => {
    const noLoop = { loop_used: false, carbs_req_g: null };
    const urgent = computeRescueDose({ evaluation: trigger({ ...noLoop, level: 'URGENT_LOW' }), loop: null, profile });
    expect([urgent.basis, urgent.carbs_g, urgent.max_g]).toEqual(['URGENT_MAX', 7, 7]);
    const adult = computeRescueDose({ evaluation: trigger({ ...noLoop, level: 'URGENT_LOW' }), loop: null, profile: { isf: 40, icr_g_per_u: 10, units: 'mg/dl' } });
    expect(adult.carbs_g).toBe(18);
    expect(adult.settings_source).toBe('PROFILE');
    const urgentWithLoop = computeRescueDose({ evaluation: trigger({ level: 'URGENT_LOW', predicted_min_mgdl: 80 }), loop, profile });
    expect(urgentWithLoop.max_g).toBe(20);
    expect(urgentWithLoop.carbs_g).toBe(7);
  });

  it('credits COB the forecast curve does not count', () => {
    const dose = computeRescueDose({ evaluation: trigger({ predicted_min_mgdl: 40 }), loop: { ...loop, cob_g: 2 }, profile });
    // (90 - 40) / 10 = 5 g minus 1.5 g of COB → 4 g (3.5 rounded).
    expect(dose.carbs_g).toBe(4);
  });

  it('reads mmol/L settings and refuses without a profile', () => {
    expect(computeRescueDose({ evaluation: trigger({ loop_used: false }), loop: null, profile: { isf: 8.3, icr_g_per_u: 15, units: 'mmol' } }).isf_mgdl_per_u).toBe(149);
    // The loop's ISF goes through the same rule: 8.3 under a mmol/L profile is 149, 150 stays 150 under either label.
    expect(computeRescueDose({ evaluation: trigger(), loop: { ...loop, isf_mgdl_per_u: 8.3 }, profile: { ...profile, units: 'mmol' } }).isf_mgdl_per_u).toBe(149);
    expect(computeRescueDose({ evaluation: trigger(), loop, profile: { ...profile, units: 'mmol' } }).isf_mgdl_per_u).toBe(150);
    // A mg/dL ISF of 20 is not taken as 20 mmol/L.
    expect(computeRescueDose({ evaluation: trigger({ loop_used: false }), loop: null, profile: { isf: 20, icr_g_per_u: 10, units: 'mg/dl' } }).isf_mgdl_per_u).toBe(20);
    const none = computeRescueDose({ evaluation: trigger({ loop_used: false }), loop: null, profile: { isf: null, icr_g_per_u: null, units: null } });
    expect(none.basis).toBe('NO_PROFILE');
    expect(none.carbs_g).toBeNull();
  });
});

function alertRecord(overrides: Partial<RescueAlertRecord> = {}): RescueAlertRecord {
  const evaluation = evaluateRescueNeed({ now: NOW, readings: cgm([120, 112, 105, 99, 95]), prediction: parseLoopPrediction(openaps()), last_carbs_at: null });
  return {
    id: 'alert-1', patient_id: 'p1', status: 'NOTIFIED', level: 'PREDICTED_LOW', trigger_source: 'TRIO_PREDICTION',
    first_flag_at: minutes(-20), first_flag_reading_at: minutes(-21), notified_at: minutes(-16), notified_level: 'PREDICTED_LOW',
    reminder_sent_at: null, last_evaluated_at: minutes(-1), clear_since: null, evaluation, proposal: null, conversation_id: 'conv-1',
    treatment_event_id: null, treatment_carbs_g: null, treated_at: null, treated_by_user_id: null, treatment_source: null,
    treatment_proposal_id: null, declined_at: null, declined_by_user_id: null, outcome: null, resolved_at: null, created_at: minutes(-20),
    ...overrides,
  };
}

describe('decideRescueAlert (rescue-carbs.v1)', () => {
  const triggered = evaluateRescueNeed({ now: NOW, readings: cgm([120, 112, 105, 99, 95]), prediction: parseLoopPrediction(openaps()), last_carbs_at: null });
  const urgent = evaluateRescueNeed({ now: NOW, readings: cgm([70, 62, 57, 52]), prediction: null, last_carbs_at: null });
  const clear = evaluateRescueNeed({ now: NOW, readings: cgm([110, 108, 106, 104, 103, 102]), prediction: null, last_carbs_at: null });

  it('needs two flags in a row (urgent: one)', () => {
    expect(decideRescueAlert(null, triggered, NOW).action).toBe('START_PENDING');
    expect(decideRescueAlert(null, urgent, NOW).action).toBe('NOTIFY');
    const pending = alertRecord({ status: 'PENDING', notified_at: null, notified_level: null, first_flag_at: minutes(-5), first_flag_reading_at: minutes(-6) });
    expect(decideRescueAlert(pending, triggered, NOW).action).toBe('NOTIFY');
    expect(decideRescueAlert({ ...pending, first_flag_at: minutes(-2) }, triggered, NOW).action).toBe('NONE');
    expect(decideRescueAlert(pending, clear, NOW).action).toBe('CANCEL');
  });

  it('reminds once after 15 min, at once when it turns urgent', () => {
    expect(decideRescueAlert(alertRecord(), triggered, NOW).action).toBe('REMIND');
    expect(decideRescueAlert(alertRecord({ notified_at: minutes(-5) }), triggered, NOW).action).toBe('NONE');
    expect(decideRescueAlert(alertRecord({ notified_at: minutes(-5) }), urgent, NOW).action).toBe('REMIND');
    expect(decideRescueAlert(alertRecord({ reminder_sent_at: minutes(-1) }), triggered, NOW).action).toBe('NONE');
  });

  it('closes after 15 min clear and expires after 2 h without carbs', () => {
    expect(decideRescueAlert(alertRecord(), clear, NOW)).toEqual({ action: 'NONE', clear_since: NOW.toISOString() });
    expect(decideRescueAlert(alertRecord({ clear_since: minutes(-16) }), clear, NOW)).toMatchObject({ action: 'CLOSE', status: 'RESOLVED' });
    expect(decideRescueAlert(alertRecord({ notified_at: minutes(-121) }), triggered, NOW)).toMatchObject({ action: 'CLOSE', status: 'EXPIRED' });
  });

  it('starts the next alert when a low is still coming 15 min after the logged carbs', () => {
    const treated = alertRecord({ status: 'TREATED', treated_at: minutes(-16), treatment_carbs_g: 5, treatment_event_id: 'e1' });
    expect(decideRescueAlert(treated, triggered, NOW)).toMatchObject({ action: 'CLOSE', reason: 'RETRIGGERED_AFTER_TREATMENT', restart: 'PENDING' });
    expect(decideRescueAlert({ ...treated, treated_at: minutes(-5) }, triggered, NOW).action).toBe('NONE');
  });

  it('after the one reminder, only a worse level than it announced starts a new alert', () => {
    const reminded = alertRecord({ reminder_sent_at: minutes(-5) });
    expect(decideRescueAlert(reminded, triggered, NOW)).toEqual({ action: 'NONE', clear_since: null });
    const lowNow = evaluateRescueNeed({ now: NOW, readings: cgm([85, 80, 75, 71, 67, 66]), prediction: null, last_carbs_at: null });
    expect(decideRescueAlert(reminded, lowNow, NOW)).toMatchObject({ action: 'CLOSE', reason: 'ESCALATED_AFTER_REMINDER', restart: 'PENDING' });
    expect(decideRescueAlert(reminded, urgent, NOW)).toMatchObject({ action: 'CLOSE', reason: 'ESCALATED_AFTER_REMINDER', restart: 'NOTIFY' });
    // An urgent reminder already announced the urgent level: no second push for it.
    const remindedUrgent = alertRecord({ reminder_sent_at: minutes(-5), notified_level: 'URGENT_LOW' });
    expect(decideRescueAlert(remindedUrgent, urgent, NOW).action).toBe('NONE');
  });

  it('sends no reminder after "Nie podaję"; only a worse level starts a new alert', () => {
    const declined = alertRecord({ declined_at: minutes(-10) });
    expect(decideRescueAlert(declined, triggered, NOW)).toEqual({ action: 'NONE', clear_since: null });
    const lowNow = evaluateRescueNeed({ now: NOW, readings: cgm([85, 80, 75, 71, 67, 66]), prediction: null, last_carbs_at: null });
    expect(lowNow.level).toBe('LOW_NOW');
    expect(decideRescueAlert(declined, lowNow, NOW)).toMatchObject({ action: 'CLOSE', status: 'RESOLVED', reason: 'ESCALATED_AFTER_DECLINE', restart: 'PENDING' });
    expect(decideRescueAlert(declined, urgent, NOW)).toMatchObject({ action: 'CLOSE', reason: 'ESCALATED_AFTER_DECLINE', restart: 'NOTIFY' });
    // The same level that was declined stays quiet, also when it is urgent.
    const declinedUrgent = alertRecord({ declined_at: minutes(-10), level: 'URGENT_LOW', notified_level: 'URGENT_LOW' });
    expect(decideRescueAlert(declinedUrgent, urgent, NOW).action).toBe('NONE');
    expect(decideRescueAlert({ ...declined, clear_since: minutes(-16) }, clear, NOW)).toMatchObject({ action: 'CLOSE', status: 'RESOLVED', reason: 'CLEARED' });
    expect(decideRescueAlert({ ...declined, notified_at: minutes(-121) }, triggered, NOW)).toMatchObject({ action: 'CLOSE', status: 'EXPIRED', reason: 'DECLINED' });
  });

  it('resends only an undelivered push of a NOTIFIED alert, not declined or treated, every 45 s for 30 min', () => {
    const undelivered = alertRecord({ notified_at: minutes(-2), alert_push_attempts: 1, alert_last_push_attempt_at: minutes(-1), alert_delivered_at: null });
    expect(rescuePushToResend(undelivered, NOW)).toBe('ALERT');
    expect(rescuePushToResend({ ...undelivered, alert_last_push_attempt_at: new Date(NOW.getTime() - 30_000).toISOString() }, NOW)).toBeNull();
    expect(rescuePushToResend({ ...undelivered, alert_delivered_at: minutes(-1) }, NOW)).toBeNull();
    expect(rescuePushToResend({ ...undelivered, declined_at: minutes(-1) }, NOW)).toBeNull();
    expect(rescuePushToResend({ ...undelivered, status: 'TREATED', treatment_event_id: 'e1' }, NOW)).toBeNull();
    expect(rescuePushToResend({ ...undelivered, treatment_command_id: 'c1' }, NOW)).toBeNull();
    expect(rescuePushToResend({ ...undelivered, status: 'EXPIRED' }, NOW)).toBeNull();
    expect(rescuePushToResend({ ...undelivered, notified_at: minutes(-31) }, NOW)).toBeNull();
    // A record without delivery tracking (no attempt counted) is never resent.
    expect(rescuePushToResend(alertRecord({ notified_at: minutes(-2) }), NOW)).toBeNull();
    // Once the reminder went out, it is the push that is resent (the alert's own push no longer).
    const reminded = { ...undelivered, reminder_sent_at: minutes(-1), reminder_push_attempts: 1, reminder_last_push_attempt_at: minutes(-1), reminder_delivered_at: null };
    expect(rescuePushToResend(reminded, NOW)).toBe('REMINDER');
    expect(rescuePushToResend({ ...reminded, reminder_delivered_at: minutes(-1) }, NOW)).toBeNull();
  });

  it('pushes an urgent low after a meal at once, and keeps waiting for rescue carbs in an open alert', () => {
    const afterMeal = evaluateRescueNeed({ now: NOW, readings: cgm([70, 62, 57, 52]), prediction: null, last_carbs_at: minutes(-3), last_hypo_treatment_at: null });
    expect(decideRescueAlert(null, afterMeal, NOW).action).toBe('NOTIFY');
    // An alert that pushed a predicted low: < 54 right after a meal reminds at once instead of waiting.
    expect(decideRescueAlert(alertRecord({ notified_at: minutes(-3) }), afterMeal, NOW).action).toBe('REMIND');
    // A low now right after rescue carbs is held back: a PENDING alert is cancelled, a pushed one sends no reminder.
    const afterRescue = evaluateRescueNeed({ now: NOW, readings: cgm([80, 75, 70, 66]), prediction: null, last_carbs_at: minutes(-3), last_hypo_treatment_at: minutes(-3) });
    expect(afterRescue.status).toBe('SUPPRESSED');
    expect(decideRescueAlert(alertRecord({ status: 'PENDING', notified_at: null }), afterRescue, NOW).action).toBe('CANCEL');
    expect(decideRescueAlert(alertRecord({ notified_at: minutes(-16) }), afterRescue, NOW).action).toBe('NONE');
  });

  it('records the outcome: a false alarm is no carbs and no low', () => {
    const readings = cgm([95, 90, 86, 84, 85, 88, 92], 10);
    expect(computeRescueOutcome(alertRecord({ notified_at: minutes(-20) }), readings, 'CLEARED', NOW)).toMatchObject({ min_glucose_mgdl: 84, false_alarm: true, treated: false });
    const treated = computeRescueOutcome(alertRecord({ notified_at: minutes(-20), treated_at: minutes(-12), treatment_carbs_g: 5 }), readings, 'CLEARED', NOW);
    expect(treated).toMatchObject({ false_alarm: false, minutes_to_treatment: 8 });
    expect(computeRescueOutcome(alertRecord({ notified_at: minutes(-20), declined_at: minutes(-15) }), readings, 'CLEARED', NOW)).toMatchObject({ declined: true, treated: false, false_alarm: true });
  });
});

class MemoryStore implements RescueCarbsStore {
  alerts: RescueAlertRecord[] = [];
  lastCarbsAt: string | null = null;
  lastHypoTreatmentAt: string | null = null;
  devices = [{ device_id: 'd1', push_token: 'token-1' }];
  listDevicesError: Error | null = null;
  async listPatientsWithAlertDevices() { return ['p1']; }
  async listAlertDevices() {
    if (this.listDevicesError) throw this.listDevicesError;
    return this.devices;
  }
  async getActiveAlert() { return this.alerts.find((alert) => ['PENDING', 'NOTIFIED', 'TREATED'].includes(alert.status)) ?? null; }
  async insertAlert(input: { patientId: string; status: 'PENDING' | 'NOTIFIED'; evaluation: RescueEvaluation; now: string }) {
    if (await this.getActiveAlert()) return null;
    const alert = alertRecord({ id: `alert-${this.alerts.length + 1}`, status: input.status, first_flag_at: input.now, first_flag_reading_at: input.evaluation.glucose?.at ?? null, notified_at: null, notified_level: null, evaluation: input.evaluation, conversation_id: null });
    this.alerts.push(alert);
    return alert;
  }
  async touchAlert(id: string, args: { clearSince: string | null }) { Object.assign(this.alerts.find((alert) => alert.id === id)!, { clear_since: args.clearSince }); }
  async markNotified(id: string, args: { evaluation: RescueEvaluation; proposal: RescueAlertRecord['proposal']; now: string; reminder: boolean }) {
    const alert = this.alerts.find((candidate) => candidate.id === id)!;
    // As the repository: the first push only from PENDING, the one reminder only from NOTIFIED.
    if (args.reminder ? alert.status !== 'NOTIFIED' || alert.reminder_sent_at || alert.declined_at : alert.status !== 'PENDING') return null;
    Object.assign(alert, {
      status: 'NOTIFIED', conversation_id: alert.conversation_id ?? `conv-${id}`, notified_at: alert.notified_at ?? args.now, notified_level: args.evaluation.level, evaluation: args.evaluation, proposal: args.proposal,
      ...(args.reminder
        ? { reminder_sent_at: args.now, reminder_push_attempts: (alert.reminder_push_attempts ?? 0) + 1, reminder_last_push_attempt_at: args.now, reminder_delivered_at: null }
        : { alert_push_attempts: (alert.alert_push_attempts ?? 0) + 1, alert_last_push_attempt_at: args.now, alert_delivered_at: null }),
    });
    return alert;
  }
  async claimPushResend(id: string, args: { reminder: boolean; now: string }) {
    const alert = this.alerts.find((candidate) => candidate.id === id)!;
    if (alert.status !== 'NOTIFIED' || alert.declined_at || alert.treatment_event_id) return null;
    if (args.reminder) {
      if (alert.reminder_delivered_at) return null;
      Object.assign(alert, { reminder_push_attempts: (alert.reminder_push_attempts ?? 0) + 1, reminder_last_push_attempt_at: args.now });
    } else {
      if (alert.alert_delivered_at) return null;
      Object.assign(alert, { alert_push_attempts: (alert.alert_push_attempts ?? 0) + 1, alert_last_push_attempt_at: args.now });
    }
    return alert;
  }
  async markPushDelivered(id: string, args: { reminder: boolean; now: string }) {
    const alert = this.alerts.find((candidate) => candidate.id === id)!;
    Object.assign(alert, args.reminder ? { reminder_delivered_at: alert.reminder_delivered_at ?? args.now } : { alert_delivered_at: alert.alert_delivered_at ?? args.now });
  }
  async closeAlert(id: string, args: { status: 'RESOLVED' | 'EXPIRED' | 'CANCELLED'; outcome: unknown }) { Object.assign(this.alerts.find((alert) => alert.id === id)!, { status: args.status, outcome: args.outcome }); }
  async getRecentEatenCarbs() { return { last_carbs_at: this.lastCarbsAt, last_hypo_treatment_at: this.lastHypoTreatmentAt }; }
}

describe('RescueCarbAlertService (rescue-carbs.v1)', () => {
  function setup(readings: () => RescueReading[], status: () => ReturnType<typeof openaps> | null, options: { fail?: () => boolean } = {}) {
    const store = new MemoryStore();
    const pushes: Array<{ title: string; body: string; reminder: boolean; conversationId: string; alertId: string }> = [];
    const logs: Array<Record<string, unknown>> = [];
    const service = new RescueCarbAlertService({
      store,
      data: {
        listGlucoseReadingsSince: async () => readings(),
        getLatestLoopStatus: async () => status(),
        getTherapyProfileAt: async () => ({ units: 'mg/dl', timezone: 'Europe/Warsaw', carb_ratio_g_per_u: [['00:00', 15]], sensitivity_per_u: [['00:00', 150]] }),
      },
      push: {
        sendRescueCarbAlert: async (input) => {
          if (options.fail?.()) throw Object.assign(new Error('BadDeviceToken'), { retryable: false });
          pushes.push(input);
        },
      },
      sleep: async () => undefined,
      log: (event) => logs.push(event),
      timezone: 'Europe/Warsaw',
    });
    return { store, pushes, logs, service };
  }

  it('pushes on the second flag with the static dose, then reminds once', async () => {
    let now = NOW;
    const at = (offset: number) => new Date(now.getTime() + offset * 60_000).toISOString();
    const readings = () => [120, 112, 105, 99, 95].map((value, index) => ({ at: at(-1 - (4 - index) * 5), value }));
    const { store, pushes, service } = setup(readings, () => ({ ...openaps({ deliverAt: at(-1) }, at(-1)) }));

    await service.run(now);
    expect(store.alerts[0].status).toBe('PENDING');
    expect(pushes).toHaveLength(0);

    now = new Date(NOW.getTime() + 5 * 60_000);
    await service.run(now);
    expect(store.alerts[0].status).toBe('NOTIFIED');
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toMatchObject({ title: 'Możliwe niedocukrzenie', reminder: false, conversationId: 'conv-alert-1' });
    expect(pushes[0].body).toMatch(/^Teraz \d+ mg\/dL, −\d+ w 5 min · ok\. \d\d:\d\d może spaść poniżej 70 · proponuję \d+ g$/);

    now = new Date(NOW.getTime() + 21 * 60_000);
    await service.run(now);
    expect(pushes).toHaveLength(2);
    expect(pushes[1]).toMatchObject({ title: 'Możliwe niedocukrzenie (przypomnienie)', reminder: true });

    now = new Date(NOW.getTime() + 27 * 60_000);
    await service.run(now);
    expect(pushes).toHaveLength(2);
  });

  it('retries a push that failed for a passing reason, not one the device refused', async () => {
    const store = new MemoryStore();
    let attempts = 0;
    const waits: number[] = [];
    const errors: unknown[] = [];
    const service = new RescueCarbAlertService({
      store,
      data: {
        listGlucoseReadingsSince: async () => cgm([70, 62, 57, 52]),
        getLatestLoopStatus: async () => null,
        getTherapyProfileAt: async () => ({ units: 'mg/dl', timezone: 'Europe/Warsaw', carb_ratio_g_per_u: [['00:00', 15]], sensitivity_per_u: [['00:00', 150]] }),
      },
      push: {
        sendRescueCarbAlert: async () => {
          attempts += 1;
          if (attempts < 3) throw Object.assign(new Error('socket hang up'), { retryable: true });
        },
      },
      onPushError: async (_token, error) => { errors.push(error); },
      sleep: async (ms) => { waits.push(ms); },
      timezone: 'Europe/Warsaw',
    });
    await service.run(NOW);
    expect(attempts).toBe(3);
    expect(waits).toEqual([1000, 4000]);
    expect(errors).toHaveLength(0);

    attempts = 0;
    const refused = Object.assign(new Error('BadDeviceToken'), { retryable: false });
    const once = new RescueCarbAlertService({
      store: new MemoryStore(),
      data: { listGlucoseReadingsSince: async () => cgm([70, 62, 57, 52]), getLatestLoopStatus: async () => null, getTherapyProfileAt: async () => ({ units: 'mg/dl', timezone: 'Europe/Warsaw', carb_ratio_g_per_u: [['00:00', 15]], sensitivity_per_u: [['00:00', 150]] }) },
      push: { sendRescueCarbAlert: async () => { attempts += 1; throw refused; } },
      onPushError: async (_token, error) => { errors.push(error); },
      sleep: async () => undefined,
      timezone: 'Europe/Warsaw',
    });
    await once.run(NOW);
    expect(attempts).toBe(1);
    expect(errors).toEqual([refused]);
  });

  it('sends no reminder once the caregiver chose "Nie podaję"', async () => {
    let now = NOW;
    const at = (offset: number) => new Date(now.getTime() + offset * 60_000).toISOString();
    const readings = () => [120, 112, 105, 99, 95].map((value, index) => ({ at: at(-1 - (4 - index) * 5), value }));
    const { store, pushes, service } = setup(readings, () => ({ ...openaps({ deliverAt: at(-1) }, at(-1)) }));
    await service.run(now);
    now = new Date(NOW.getTime() + 5 * 60_000);
    await service.run(now);
    expect(pushes).toHaveLength(1);
    store.alerts[0].declined_at = new Date(NOW.getTime() + 8 * 60_000).toISOString();
    for (const offset of [21, 30, 45]) {
      now = new Date(NOW.getTime() + offset * 60_000);
      await service.run(now);
    }
    expect(pushes).toHaveLength(1);
    expect(store.alerts[0].status).toBe('NOTIFIED');
  });

  it('holds back a low now only for rescue carbs of the last 15 min, an urgent low never (owner decision 2026-10-26)', async () => {
    // A meal 5 min ago: < 54 is pushed at once.
    const meal = setup(() => cgm([70, 62, 57, 52]), () => null);
    meal.store.lastCarbsAt = minutes(-5);
    await meal.service.run(NOW);
    expect(meal.pushes).toHaveLength(1);
    expect(meal.pushes[0].title).toBe('Pilne: niedocukrzenie');

    // Rescue carbs 5 min ago: a low now (< 70) waits for them.
    const rescue = setup(() => cgm([80, 75, 70, 66]), () => null);
    rescue.store.lastCarbsAt = minutes(-5);
    rescue.store.lastHypoTreatmentAt = minutes(-5);
    await rescue.service.run(NOW);
    expect(rescue.store.alerts).toHaveLength(0);
    expect(rescue.pushes).toHaveLength(0);
  });

  it('sends a push that reached no phone again on the next evaluations until one takes it', async () => {
    let failing = true;
    const { store, pushes, logs, service } = setup(() => cgm([70, 62, 57, 52]), () => null, { fail: () => failing });
    await service.run(NOW);
    expect(store.alerts[0]).toMatchObject({ status: 'NOTIFIED', alert_push_attempts: 1, alert_delivered_at: null });
    expect(logs.some((log) => log.event === 'rescue_carbs_push_undelivered')).toBe(true);

    // 30 s later: too soon for another try.
    await service.run(new Date(NOW.getTime() + 30_000));
    expect(store.alerts[0].alert_push_attempts).toBe(1);

    // The device list fails, then there is no device: still not delivered, tried again each time.
    store.listDevicesError = new Error('connection reset');
    await service.run(new Date(NOW.getTime() + 60_000));
    store.listDevicesError = null;
    store.devices = [];
    await service.run(new Date(NOW.getTime() + 120_000));
    expect(store.alerts[0]).toMatchObject({ alert_push_attempts: 3, alert_delivered_at: null });

    store.devices = [{ device_id: 'd1', push_token: 'token-1' }];
    failing = false;
    const summary = await service.run(new Date(NOW.getTime() + 180_000));
    expect(summary.resent).toBe(1);
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toMatchObject({ title: 'Pilne: niedocukrzenie', reminder: false, alertId: 'alert-1', conversationId: 'conv-alert-1' });
    expect(store.alerts[0].alert_delivered_at).toBe(new Date(NOW.getTime() + 180_000).toISOString());
    expect(logs.filter((log) => log.event === 'rescue_carbs_push_resent')).toHaveLength(3);

    // Delivered: no more resends.
    await service.run(new Date(NOW.getTime() + 240_000));
    expect(pushes).toHaveLength(1);
  });

  it('never resends a declined, treated or closed alert, nor after 30 min', async () => {
    const run = async (change: (alert: RescueAlertRecord) => void, at = 120_000) => {
      let failing = true;
      const { store, pushes, service } = setup(() => cgm([70, 62, 57, 52]), () => null, { fail: () => failing });
      await service.run(NOW);
      failing = false;
      expect(store.alerts[0].alert_delivered_at).toBeNull();
      change(store.alerts[0]);
      await service.run(new Date(NOW.getTime() + at));
      return pushes;
    };
    expect(await run(() => undefined)).toHaveLength(1);
    expect(await run((alert) => { alert.declined_at = minutes(1); })).toHaveLength(0);
    expect(await run((alert) => { Object.assign(alert, { status: 'TREATED', treatment_event_id: 'e1', treated_at: minutes(1) }); })).toHaveLength(0);
    // Closed: still < 54, so a new alert pushes, but alert-1 is not resent.
    expect((await run((alert) => { alert.status = 'RESOLVED'; })).map((push) => push.alertId)).toEqual(['alert-2']);
    expect(await run(() => undefined, 31 * 60_000)).toHaveLength(0);
  });

  it('pushes an urgent low at once', async () => {
    const { pushes, service } = setup(() => cgm([70, 62, 57, 52]), () => null);
    await service.run(NOW);
    expect(pushes).toHaveLength(1);
    expect(pushes[0].title).toBe('Pilne: niedocukrzenie');
    expect(pushes[0].body).toBe('Teraz 52 mg/dL, −5 w 5 min · proponuję 7 g');
  });
});

describe('push text, chat card and API parsing', () => {
  it('says "sprawdź glukozę" without a dose', () => {
    const evaluation = evaluateRescueNeed({ now: NOW, readings: cgm([80, 75, 70, 66]), prediction: null, last_carbs_at: null });
    const proposal = computeRescueDose({ evaluation, loop: null, profile: { isf: null, icr_g_per_u: null, units: null } });
    expect(buildRescuePushText({ evaluation, proposal, reminder: false, timezone: 'Europe/Warsaw' })).toEqual({ title: 'Niedocukrzenie', body: 'Teraz 66 mg/dL, −4 w 5 min · sprawdź glukozę' });
    // Glucose now is in every push, the change only when known.
    expect(buildRescuePushText({ evaluation: { ...evaluation, delta_per_5min: null }, proposal, reminder: true, timezone: 'Europe/Warsaw' }).body).toBe('Teraz 66 mg/dL · sprawdź glukozę');
  });

  it('prepares a card only while nothing was logged', async () => {
    const inserted: unknown[] = [];
    let alert = alertRecord();
    const session = new RescueCarbProposalSession({
      patientId: 'p1', alertId: 'alert-1', conversationId: 'conv-1', userMessageId: 'm1',
      store: {
        getAlert: async () => alert,
        insertProposal: async (proposal) => { inserted.push(proposal); return { id: 'card-1', patient_id: 'p1', alert_id: 'alert-1', conversation_id: 'conv-1', user_message_id: 'm1', carbs_g: proposal.carbsG, reason: proposal.reason, status: 'PROPOSED', created_at: NOW.toISOString(), treatment: null }; },
      },
    });
    expect((await session.propose({ carbs_g: 0.3, reason: 'x' })).status).toBe('INVALID_REQUEST');
    expect(await session.propose({ carbs_g: 8, reason: 'Spada szybko po WF.' })).toMatchObject({ status: 'PROPOSED', card: { carbs_g: 8 } });
    alert = alertRecord({ treatment_event_id: 'e1', treatment_carbs_g: 6, treated_at: minutes(-2) });
    expect((await session.propose({ carbs_g: 8, reason: 'x' })).status).toBe('ALREADY_LOGGED');
    expect(inserted).toHaveLength(1);
  });

  it('prepares a card in an ordinary conversation without reading any alert, with the chat\'s rules', async () => {
    const inserted: Array<{ alertId: string | null }> = [];
    const session = new RescueCarbProposalSession({
      patientId: 'p1', alertId: null, conversationId: 'conv-1', userMessageId: 'm1',
      store: {
        getAlert: async () => { throw new Error('no alert to read'); },
        insertProposal: async (proposal) => { inserted.push(proposal); return { id: 'card-1', patient_id: 'p1', alert_id: null, conversation_id: 'conv-1', user_message_id: 'm1', carbs_g: proposal.carbsG, reason: proposal.reason, status: 'PROPOSED', created_at: NOW.toISOString(), treatment: null }; },
      },
    });
    expect(await session.propose({ carbs_g: 10, reason: 'Sok podany przy 65 mg/dL.' })).toMatchObject({ status: 'PROPOSED', card: { carbs_g: 10 } });
    expect(inserted).toEqual([expect.objectContaining({ alertId: null, carbsG: 10 })]);
    expect(session.instructions).toBe(RESCUE_CARB_CHAT_INSTRUCTIONS);
    expect(session.instructions).toContain('sent to the loop as a hypo treatment when the caregiver\'s phone sends remote commands');
    expect(session.instructions).toContain('never where they are logged');
    const alertSession = new RescueCarbProposalSession({ patientId: 'p1', alertId: 'alert-1', conversationId: 'conv-1', userMessageId: 'm1', store: { getAlert: async () => null, insertProposal: async () => { throw new Error('unused'); } } });
    expect(alertSession.instructions).toBe(RESCUE_CARB_PROPOSAL_INSTRUCTIONS);
    expect(alertSession.for_alert).toBe(true);
    expect(session.for_alert).toBe(false);
  });

  it('without advice on this phone, carbs_g null takes the alert\'s dose, and outside an alert asks for the grams', async () => {
    const insert = async (proposal: { carbsG: number }) => ({ id: 'card-1', patient_id: 'p1', alert_id: 'alert-1', conversation_id: 'conv-1', user_message_id: 'm1', carbs_g: proposal.carbsG, reason: null, status: 'PROPOSED', created_at: NOW.toISOString(), treatment: null });
    const forAlert = new RescueCarbProposalSession({
      patientId: 'p1', alertId: 'alert-1', conversationId: 'conv-1', userMessageId: 'm1',
      store: { getAlert: async () => alertRecord({ proposal: { carbs_g: 6 } as never }), insertProposal: insert as never },
    });
    expect(await forAlert.propose({ carbs_g: null, reason: '' })).toMatchObject({ status: 'PROPOSED', card: { carbs_g: 6 } });
    const inChat = new RescueCarbProposalSession({ patientId: 'p1', alertId: null, conversationId: 'conv-1', userMessageId: 'm1', store: { getAlert: async () => null, insertProposal: insert as never } });
    expect(await inChat.propose({ carbs_g: null, reason: '' })).toMatchObject({ status: 'INVALID_REQUEST', problem: expect.stringContaining('carbs_g is needed') });
  });

  it('prepares one card per option of the answer (answer-options.v1)', async () => {
    const inserted: Array<{ optionKey: string | null }> = [];
    const session = new RescueCarbProposalSession({
      patientId: 'p1', alertId: null, conversationId: 'conv-1', userMessageId: 'm1',
      store: {
        getAlert: async () => null,
        insertProposal: async (proposal) => { inserted.push(proposal); return { id: `card-${inserted.length}`, patient_id: 'p1', alert_id: null, conversation_id: 'conv-1', user_message_id: 'm1', carbs_g: proposal.carbsG, reason: proposal.reason, option_key: proposal.optionKey, status: 'PROPOSED', created_at: NOW.toISOString(), treatment: null }; },
      },
    });
    expect((await session.propose({ carbs_g: 3, option: 'A', reason: 'x' })).status).toBe('PROPOSED');
    expect((await session.propose({ carbs_g: 5, option: 'c', reason: 'x' })).status).toBe('PROPOSED');
    expect(await session.propose({ carbs_g: 4, option: 'A', reason: 'x' })).toMatchObject({ status: 'LIMIT_REACHED', note: 'Option A already has its rescue carb card: it is shown, do not call again.' });
    expect((await session.propose({ carbs_g: 4, option: null, reason: 'x' })).status).toBe('PROPOSED');
    expect((await session.propose({ carbs_g: 4, option: 'X', reason: 'x' })).status).toBe('LIMIT_REACHED');
    expect(inserted.map((card) => card.optionKey)).toEqual(['A', 'C', null]);
  });

  it('replaces an option\'s rescue card when the store can take the earlier one back', async () => {
    const discarded: string[] = [];
    let next = 0;
    const session = new RescueCarbProposalSession({
      patientId: 'p1', alertId: null, conversationId: 'conv-1', userMessageId: 'm1',
      store: {
        getAlert: async () => null,
        insertProposal: async (proposal) => ({ id: `card-${++next}`, patient_id: 'p1', alert_id: null, conversation_id: 'conv-1', user_message_id: 'm1', carbs_g: proposal.carbsG, reason: proposal.reason, option_key: proposal.optionKey, status: 'PROPOSED', created_at: NOW.toISOString(), treatment: null }),
        discardProposal: async (_patientId, id) => { discarded.push(id); },
      },
    });
    await session.propose({ carbs_g: 5, option: 'A', reason: 'x' });
    expect(await session.propose({ carbs_g: 10, option: 'A', reason: 'Trio chce 10 g.' })).toMatchObject({ status: 'PROPOSED', note: expect.stringContaining('replaces') });
    expect(discarded).toEqual(['card-1']);
    expect(session.proposed.map((card) => card.carbs_g)).toEqual([10]);
  });

  it('takes the advised fast carbs for carbs_g null (same turn as the meal cards)', async () => {
    let advised: number | null = 11.6;
    const inserted: number[] = [];
    const session = new RescueCarbProposalSession({
      patientId: 'p1', alertId: null, conversationId: 'conv-1', userMessageId: 'm1', advisedCarbs: async () => advised,
      store: {
        getAlert: async () => null,
        insertProposal: async (proposal) => { inserted.push(proposal.carbsG); return { id: `card-${inserted.length}`, patient_id: 'p1', alert_id: null, conversation_id: 'conv-1', user_message_id: 'm1', carbs_g: proposal.carbsG, reason: proposal.reason, option_key: proposal.optionKey, status: 'PROPOSED', created_at: NOW.toISOString(), treatment: null }; },
      },
    });
    expect(await session.propose({ carbs_g: null, option: 'A', reason: 'x' })).toMatchObject({ status: 'PROPOSED', card: { carbs_g: 12, option: 'A' } });
    advised = null;
    expect((await session.propose({ carbs_g: null, option: 'B', reason: 'x' })).status).toBe('NO_ADVICE');
    // No ISF/ICR: the advice has no grams, never a token 1 g card.
    advised = 0;
    expect((await session.propose({ carbs_g: null, option: 'C', reason: 'x' })).status).toBe('NO_ADVICE');
    expect(inserted).toEqual([12]);
  });

  it('an ordinary chat card says when carbs were logged in the last 15 min', async () => {
    const loggedAt = new Date(Date.now() - 6 * 60_000).toISOString();
    const session = new RescueCarbProposalSession({
      patientId: 'p1', alertId: null, conversationId: 'conv-1', userMessageId: 'm1',
      store: {
        getAlert: async () => null,
        getLastEatenCarbsAt: async () => loggedAt,
        insertProposal: async (proposal) => ({ id: 'card-1', patient_id: 'p1', alert_id: null, conversation_id: 'conv-1', user_message_id: 'm1', carbs_g: proposal.carbsG, reason: proposal.reason, option_key: proposal.optionKey, status: 'PROPOSED', created_at: loggedAt, treatment: null }),
      },
    });
    expect(await session.propose({ carbs_g: 15, option: null, reason: 'x' })).toMatchObject({ status: 'PROPOSED', recent_carbs: { at: loggedAt, minutes_ago: 6 } });
  });

  it('keeps every card of the newest answer live (one per option)', () => {
    const conversation = { messages: [{ id: 'u1', role: 'USER' }, { id: 'a1', role: 'ASSISTANT', metadata: { user_message_id: 'u1' } }] };
    const card = (id: string, option: 'A' | 'B') => ({ id, patient_id: 'p1', alert_id: null, conversation_id: 'c', user_message_id: 'u1', carbs_g: 3, reason: null, option_key: option, status: 'PROPOSED' as const, created_at: NOW.toISOString(), treatment: null });
    const result = withRescueCarbProposals(conversation, [card('c1', 'A'), card('c2', 'B')], null) as { messages: Array<Record<string, any>> };
    expect(result.messages[1].rescue_carb_proposals.map((entry: Record<string, unknown>) => [entry.option_key, entry.status])).toEqual([['A', 'PROPOSED'], ['B', 'PROPOSED']]);
  });

  it('shows what a confirmed card without an alert logged', () => {
    const conversation = { messages: [{ id: 'u1', role: 'USER' }, { id: 'a1', role: 'ASSISTANT', metadata: { user_message_id: 'u1' } }] };
    const card = { id: 'c1', patient_id: 'p1', alert_id: null, conversation_id: 'c', user_message_id: 'u1', carbs_g: 10, reason: null, status: 'ACCEPTED' as const, created_at: NOW.toISOString(), treatment: { event_id: 'e1', carbs_g: 8, given_at: minutes(-5), logged_by_user_id: 'u' } };
    const result = withRescueCarbProposals(conversation, [card], null) as { messages: Array<Record<string, any>> };
    expect(result.messages[1].rescue_carb_proposals[0]).toMatchObject({ status: 'ACCEPTED', carbs_g: 10, logged: { carbs_g: 8, given_at: minutes(-5) } });
  });

  it('puts the cards under the answer that prepared them, newest one live', () => {
    const conversation = { messages: [
      { id: 'u1', role: 'USER' },
      { id: 'a1', role: 'ASSISTANT', metadata: { user_message_id: 'u1' } },
      { id: 'u2', role: 'USER' },
      { id: 'a2', role: 'ASSISTANT', metadata: { user_message_id: 'u2' } },
    ] };
    const card = (id: string, user: string) => ({ id, patient_id: 'p1', alert_id: 'alert-1', conversation_id: 'c', user_message_id: user, carbs_g: 6, reason: null, status: 'PROPOSED' as const, created_at: NOW.toISOString(), treatment: null });
    const result = withRescueCarbProposals(conversation, [card('c1', 'u1'), card('c2', 'u2')], null) as { messages: Array<Record<string, any>> };
    expect(result.messages[1].rescue_carb_proposals[0].status).toBe('SUPERSEDED');
    expect(result.messages[3].rescue_carb_proposals[0].status).toBe('PROPOSED');
  });

  it('validates the logged amount and time', () => {
    expect(parseRescueCarbs(6)).toBe(6);
    expect(parseRescueCarbs(6.5)).toBe(6.5);
    expect(parseRescueCarbs(6.3)).toBeNull();
    expect(parseRescueCarbs(0)).toBeNull();
    expect(parseRescueCarbs('6')).toBeNull();
    expect(parseRescueGivenAt(undefined, NOW)).toBe(NOW.toISOString());
    expect(parseRescueGivenAt(minutes(-30), NOW)).toBe(minutes(-30));
    expect(parseRescueGivenAt(minutes(3), NOW)).toBe(NOW.toISOString());
    expect(parseRescueGivenAt(minutes(-180), NOW)).toBeNull();
  });

  it('shows "Nie podaję" with who chose it, until carbs are logged after all', () => {
    const declined = alertRecord({ declined_at: minutes(-4), declined_by_user_id: 'u1' });
    expect(toRescueCarbsView(declined, { readings: [], logged_by: null, declined_by: 'Piotr' }).declined).toEqual({ declined_at: minutes(-4), declined_by: 'Piotr' });
    expect(toRescueCarbsView(alertRecord(), { readings: [], logged_by: null }).declined).toBeNull();
    const treated = { ...declined, status: 'TREATED' as const, treatment_event_id: 'e1', treatment_carbs_g: 5, treated_at: minutes(-1) };
    expect(toRescueCarbsView(treated, { readings: [], logged_by: 'Ewa', declined_by: 'Piotr' }).declined).toBeNull();
  });

  it('shows the treatment with who logged it', () => {
    const view = toRescueCarbsView(alertRecord({ status: 'TREATED', treatment_event_id: 'e1', treatment_carbs_g: 5, treated_at: minutes(-3), treatment_source: 'ALERT' }), {
      readings: [{ observed_at: minutes(-1), glucose_mgdl: 78 }],
      logged_by: 'Ewa',
    });
    expect(view.treatment).toMatchObject({ carbs_g: 5, logged_by: 'Ewa', source: 'ALERT' });
    expect(view.latest_glucose).toEqual({ value: 78, observed_at: minutes(-1) });
    expect((view.prediction as unknown[]).length).toBeGreaterThan(0);
  });
});
