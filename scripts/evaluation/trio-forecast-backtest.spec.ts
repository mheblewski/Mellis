import { mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

// The script reads a database; the tests only use its pure parts and prove that bad arguments stop it before pg.
vi.mock('pg', () => ({ Pool: vi.fn() }));

import { Pool } from 'pg';
import type { LoopPrediction } from '@modules/loop-system/application/loop-prediction';
import { evaluateRescueNeed } from '@modules/rescue-carbs/application/rescue-detection';
import { fitShrink } from './glucose-forecast-calibration-fit';
import { actualAt, crossingEpisodes, curveAt, curveDetector, heldOutCalibration, leastSquares, main, predict, scoreEvents, scorePushes, simulateRescueAlerts, type Calculation, type PatientData } from './trio-forecast-backtest';

const T0 = Date.parse('2026-10-16T12:00:00.000Z');
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();
const cgm = (values: number[]) => values.map((value, index) => ({ at: at(index * 5), value }));

function calc(minutes: number, bg: number, iob: number[]): Calculation {
  const prediction: LoopPrediction = {
    source: 'OPENAPS', system: 'TRIO', computed_at: at(minutes), bg, carbs_req_g: null, iob_u: 1, cob_g: 0, isf_mgdl_per_u: 100, icr_g_per_u: 10, eventual_bg: iob.at(-1) ?? null, curves: { IOB: iob, ZT: iob },
  };
  return { anchor_ms: Date.parse(at(minutes)), bg, prediction, deviation: 0, slope_per_min: 0, context: 'OTHER' };
}

const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'trio-forecast-backtest-')));
afterAll(() => rmSync(sandbox, { recursive: true, force: true }));

describe('trio forecast backtest', () => {
  it("holds a trimmed curve's last value and reads the CGM between readings", () => {
    expect(curveAt([100, 95, 90], 5)).toBe(95);
    expect(curveAt([100, 95, 90], 60)).toBe(90);
    expect(curveAt(undefined, 5)).toBeNull();
    const readings = cgm([100, 110]);
    const times = readings.map((reading) => Date.parse(reading.at));
    expect(actualAt(readings, times, T0 + 2.5 * 60_000)).toBe(105);
    expect(actualAt(readings, times, T0 + 10 * 60_000)).toBeNull();
    const gap = [{ at: at(0), value: 100 }, { at: at(20), value: 120 }];
    expect(actualAt(gap, gap.map((reading) => Date.parse(reading.at)), T0 + 10 * 60_000)).toBeNull();
  });

  it('counts a low episode only after 15 min above 70, and episodes 30 min apart', () => {
    const readings = cgm([90, 85, 80, 75, 68, 66, 72, 69, 80, 85, 90, 95, 100, 95, 90, 85, 80, 75, 72, 69]);
    expect(crossingEpisodes(readings, (value) => value < 70).map((ms) => (ms - T0) / 60_000)).toEqual([20, 95]);
  });

  it('scores warnings 15–30 min ahead and false alarms the CGM never confirms', () => {
    const readings = cgm([100, 96, 92, 88, 84, 80, 76, 72, 68, 66, 70, 74, 78, 82, 86, 90, 94, 98, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100]);
    const warning = calc(15, 88, [88, 80, 72, 65]);
    const falseAlarm = calc(100, 100, [100, 90, 80, 68]);
    const quiet = calc(50, 70, [70, 72, 75]);
    const score = scoreEvents([warning, quiet, falseAlarm], readings, (value) => value < 70, curveDetector('IOB', (value) => value < 70), 1);
    expect(score).toMatchObject({ episodes: 1, warned_15_30: 1, warned_5_30: 1, alarms: 2, false_alarms: 1, false_alarms_per_day: 1, precision: 0.5, lead_minutes: [25] });
    expect(predict(warning, 'FLAT', 30)).toBe(88);
  });

  it('solves least squares', () => {
    const x = [[1, 0], [1, 1], [1, 2], [1, 3]];
    const beta = leastSquares(x, [1, 3, 5, 7]);
    expect(beta[0]).toBeCloseTo(1);
    expect(beta[1]).toBeCloseTo(2);
  });

  it('fits the share of the main curve change that happened', () => {
    const readings = cgm(Array.from({ length: 20 }, (_, index) => 150 - index * 2));
    const calcs = [0, 10, 20].map((minutes) => {
      const bg = 150 - (minutes / 5) * 2;
      // Trio forecasts 4 mg/dL per 5 min, the CGM fell 2: w = 0.5.
      return calc(minutes, bg, Array.from({ length: 13 }, (_, index) => bg - index * 4));
    });
    expect(fitShrink(calcs, readings)[15]).toBeCloseTo(0.5);
    expect(heldOutCalibration({ '+5 fold 1': [0.6], '+10 fold 1': [0.5], '+5 fold 2': [0.9] }, 1).shrink_by_minutes).toEqual({ 5: 0.6, 10: 0.5 });
  });

  it('replays the alert state machine minute by minute and scores its pushes', () => {
    const readings = cgm([120, 112, 105, 99, 94, 89, 84, 79, 74, 69, 66, 64, 66, 70, 76, 82, 88, 94, 100, 104]);
    const status = (minutes: number) => ({
      observed_ms: T0 + minutes * 60_000,
      prediction: { ...calc(minutes, 0, []).prediction, computed_at: at(minutes), carbs_req_g: 8, curves: {} } as LoopPrediction,
    });
    const patient: PatientData = { patientId: 'p1', readings, times: readings.map((reading) => Date.parse(reading.at)), carbs: [], calcs: [], statuses: [0, 5, 10, 15, 20, 25, 30].map(status), noAnchor: 0, trimmedTails: 0 };
    const pushes = simulateRescueAlerts({ patient, fromMs: T0 + 20 * 60_000, toMs: T0 + 90 * 60_000, evaluate: evaluateRescueNeed });
    expect(pushes[0]).toMatchObject({ level: 'PREDICTED_LOW', reminder: false, at_ms: T0 + 25 * 60_000 });
    const score = scorePushes('v1', pushes, readings, 1);
    expect(score).toMatchObject({ episodes: 1, warned_15_30: 1, warned_5_30: 1, false_pushes: 0, lead_minutes: [20] });
  });

  it('refuses a database that is not a local backtest restore, before connecting', async () => {
    const out = join(sandbox, 'out');
    await expect(main(['--output-dir', out, '--database-url', 'postgresql://db.example.com/glucomind'])).rejects.toThrow(/local database whose name contains "backtest"/);
    await expect(main(['--output-dir', out, '--database-url', 'postgresql:///gluco_mind'])).rejects.toThrow(/backtest/);
    await expect(main(['--output-dir', out])).rejects.toThrow(/--database-url/);
    await expect(main(['--database-url', 'postgresql:///glucomind_forecast_backtest'])).rejects.toThrow(/--output-dir/);
    expect(Pool).not.toHaveBeenCalled();
    expect(readdirSync(sandbox)).toEqual([]);
  });
});
