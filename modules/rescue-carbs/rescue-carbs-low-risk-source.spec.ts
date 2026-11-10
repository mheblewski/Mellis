import { describe, expect, it } from 'vitest';
import { isLowRiskRescueSource, lowRiskVerdictOf } from '@modules/glucose-forecast/application/low-risk-alert.service';
import { parseLoopPrediction } from '@modules/loop-system/application/loop-prediction';
import { decideRescueAlert } from './application/rescue-alert-policy';
import { evaluateRescueNeedV2, type LowRiskVerdict, type RescueReading } from './application/rescue-detection';

// Owner decision 2026-11-08: the low-risk model is the rescue alert's predicted low while the switch is on.
const NOW = new Date('2026-11-08T12:00:00.000Z');
const minutes = (value: number) => new Date(NOW.getTime() + value * 60_000).toISOString();
const cgm = (values: number[]): RescueReading[] => values.map((value, index) => ({ at: minutes(-1 - (values.length - 1 - index) * 5), value }));
const trio = (suggested: Record<string, unknown>) => parseLoopPrediction({
  observed_at: minutes(-1),
  raw_payload: { openaps: { suggested: { bg: 100, deliverAt: minutes(-1), IOB: 1, COB: 0, ISF: 150, CR: 15, eventualBG: 90, ...suggested } } },
});
const verdict = (alarm: boolean): LowRiskVerdict => ({ alarm, reading_at: minutes(-1), score: alarm ? 0.9 : 0.2, threshold: 0.85 });
const zeroTempLow = trio({ carbsReq: 6, predBGs: { IOB: [100, 99, 98, 97, 96, 95, 94], ZT: [100, 95, 90, 85, 80, 75, 68] } });

describe('the low-risk model as the predicted-low source', () => {
  it('is on only with RESCUE_PREDICTED_LOW_SOURCE=low-risk and the experiment and model push not switched off', () => {
    expect(isLowRiskRescueSource({})).toBe(false);
    expect(isLowRiskRescueSource({ RESCUE_PREDICTED_LOW_SOURCE: 'low-risk' })).toBe(true);
    expect(isLowRiskRescueSource({ RESCUE_PREDICTED_LOW_SOURCE: 'low-risk', PREDICTION_EXPERIMENT_ENABLED: 'false' })).toBe(false);
    expect(isLowRiskRescueSource({ RESCUE_PREDICTED_LOW_SOURCE: 'low-risk', PREDICTION_LOW_ALERT_ENABLED: '0' })).toBe(false);
  });

  it('uses a score only while its reading is at most 10 min old', () => {
    const row = { reading_at: minutes(-9), score: 0.9, threshold: 0.85, alarm: true };
    expect(lowRiskVerdictOf(row, NOW)).toMatchObject({ alarm: true });
    expect(lowRiskVerdictOf({ ...row, reading_at: minutes(-11) }, NOW)).toBeNull();
    expect(lowRiskVerdictOf(null, NOW)).toBeNull();
  });

  it("silences Trio's signals when the model sees no low (the meal case)", () => {
    const readings = cgm([130, 125, 120, 117]);
    const v2 = evaluateRescueNeedV2({ now: NOW, readings, prediction: zeroTempLow, last_carbs_at: null });
    expect(v2).toMatchObject({ status: 'TRIGGER', level: 'PREDICTED_LOW' });
    const model = evaluateRescueNeedV2({ now: NOW, readings, prediction: zeroTempLow, last_carbs_at: null, low_risk: verdict(false) });
    expect(model).toMatchObject({ status: 'CLEAR', level: null, signals: [], confirmed: false });
  });

  it('flags and confirms a predicted low from the model alone, pushed at once', () => {
    const evaluation = evaluateRescueNeedV2({ now: NOW, readings: cgm([100, 98, 96, 94]), prediction: trio({ predBGs: { IOB: [94, 94, 94, 94, 94, 94, 94] } }), last_carbs_at: null, low_risk: verdict(true) });
    expect(evaluation).toMatchObject({ status: 'TRIGGER', level: 'PREDICTED_LOW', trigger_source: 'LOW_RISK_MODEL', signals: ['LOW_RISK_MODEL'], confirmed: true, confirmation: 'LOW_RISK_MODEL' });
    expect(decideRescueAlert(null, evaluation, NOW)).toEqual({ action: 'NOTIFY' });
  });

  it('keeps lows now as they are, whatever the model says', () => {
    const evaluation = evaluateRescueNeedV2({ now: NOW, readings: cgm([80, 74, 70, 66]), prediction: null, last_carbs_at: null, low_risk: verdict(false) });
    expect(evaluation).toMatchObject({ status: 'TRIGGER', level: 'LOW_NOW' });
  });

  it('holds a model alarm right after carbs, as v2 does', () => {
    const evaluation = evaluateRescueNeedV2({ now: NOW, readings: cgm([100, 98, 96, 94]), prediction: null, last_carbs_at: minutes(-5), last_hypo_treatment_at: null, low_risk: verdict(true) });
    expect(evaluation.status).toBe('SUPPRESSED');
  });
});

describe('who the model decides for', () => {
  it('gives its verdict only for a patient with someone listed; others stay with the rules', async () => {
    const { lowRiskVerdictReader } = await import('@infra/db/postgres-low-risk-alert.repository');
    const listed = new Set(['listed']);
    const pool = {
      query: async (sql: string, args: unknown[]) => {
        if (sql.includes('prediction_low_alert_recipients')) return { rowCount: listed.has(String(args[0])) ? 1 : 0, rows: [] };
        return { rowCount: 1, rows: [{ reading_at: new Date(minutes(-2)), score: 0.9, threshold: 0.85, alarm: true }] };
      },
    };
    expect(lowRiskVerdictReader(pool as never, {})).toBeUndefined();
    const read = lowRiskVerdictReader(pool as never, { RESCUE_PREDICTED_LOW_SOURCE: 'low-risk' })!;
    expect(await read('listed', NOW)).toMatchObject({ alarm: true });
    expect(await read('background-only', NOW)).toBeNull();
  });
});
