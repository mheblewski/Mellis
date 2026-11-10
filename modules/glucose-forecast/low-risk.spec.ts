import { describe, expect, it } from 'vitest';
import { buildLowRiskRows, firstOfRuns, fitLowRisk, lowRiskScore, LOW_RISK_MODEL_ID, type LowRiskParams } from './application/low-risk';
import { isLowRiskCensorEnabled, LowRiskAlertService, lowRiskPushText, type LowRiskScoreEntry } from './application/low-risk-alert.service';

const NOW = new Date('2026-11-07T12:00:00.000Z');
const P = '11111111-1111-4111-8111-111111111111';
const MINUTE = 60_000;

function series(values: number[], end = NOW.getTime() - MINUTE, step = 5) {
  return values.map((value, index) => ({ at: new Date(end - (values.length - 1 - index) * step * MINUTE).toISOString(), value }));
}

/** Days of readings with a slide below 70 every few hours, so a falling reading predicts the low. */
function history(days: number) {
  const values: number[] = [];
  let seed = 7;
  const noise = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed % 7) - 3;
  };
  for (let i = 0; i < days * 288; i += 1) {
    const phase = i % 60;
    values.push(phase < 40 ? 140 + noise() : phase < 50 ? 140 - (phase - 40) * 8 + noise() : 62 + (phase - 50) * 8 + noise());
  }
  return series(values);
}

describe('buildLowRiskRows', () => {
  it('reads the slope, the change, the hour and carbs, and takes only known values', () => {
    const rows = buildLowRiskRows(series([100, 110, 120, 130]), [NOW.getTime() - 30 * MINUTE]);
    const last = rows.features[3];
    expect(last[0]).toBe(130);
    expect(last[1]).toBeCloseTo(2);
    expect(last[3]).toBe(10);
    expect(last[10]).toBeCloseTo(29);
    expect(last[11]).toBe(1);
    expect(rows.days[3]).toBe('2026-11-07');
  });

  it('the target looks 15-45 min ahead and is unknown past the data', () => {
    const rows = buildLowRiskRows(series([120, 120, 120, 120, 60, 120, 120, 120, 120, 120, 120, 120, 120]), []);
    expect(rows.target[0]).toBe(1);
    expect(rows.target[1]).toBe(1);
    expect(rows.target[4]).toBe(0);
    expect(Number.isNaN(rows.target[12])).toBe(true);
    expect(Number.isNaN(rows.target[10])).toBe(true);
  });

  it('the fit does not change when later readings are added to the rows it may not use', () => {
    const all = history(10);
    const cut = new Date(NOW.getTime() - 2 * 86_400_000);
    const fullFit = fitLowRisk(buildLowRiskRows(all, []), cut);
    const shortFit = fitLowRisk(buildLowRiskRows(all.filter((reading) => Date.parse(reading.at) <= cut.getTime()), []), cut);
    expect(fullFit?.threshold).toBeCloseTo(shortFit?.threshold ?? 0, 6);
    expect(fullFit?.coef[0]).toBeCloseTo(shortFit?.coef[0] ?? 0, 6);
  });
});

describe('fitLowRisk', () => {
  it('needs enough days and lows', () => {
    expect(fitLowRisk(buildLowRiskRows(history(3), []), NOW)).toBeNull();
    expect(fitLowRisk(buildLowRiskRows(series(new Array(288 * 10).fill(130)), []), NOW)).toBeNull();
  });

  it('scores a fall towards a low above a steady moment', () => {
    const rows = buildLowRiskRows(history(12), []);
    const params = fitLowRisk(rows, NOW)!;
    expect(params.model_id).toBe(LOW_RISK_MODEL_ID);
    let falling = -1;
    let steady = -1;
    for (let i = rows.count - 200; i < rows.count; i += 1) {
      if (rows.target[i] === 1 && rows.values[i] > 100 && rows.features[i][1] < -1) falling = i;
      if (rows.target[i] === 0 && rows.values[i] > 130 && Math.abs(rows.features[i][1]) < 1) steady = i;
    }
    expect(lowRiskScore(params, rows.features[falling])).toBeGreaterThan(lowRiskScore(params, rows.features[steady]));
  });

  it('without alert times the fit is what it was; with them, a "no low" near a pushed alert is left out', () => {
    const rows = buildLowRiskRows(history(12), []);
    const plain = fitLowRisk(rows, NOW)!;
    expect(plain.censored_rows).toBeUndefined();
    expect(fitLowRisk(rows, NOW, { alert_times_ms: [] })).toEqual({ ...plain, censored_rows: 0 });
    // One alert in a steady stretch: only rows without a low within 45 min of it go, and none after `now`.
    const steady = rows.times[rows.count - 600 + 20];
    const censored = fitLowRisk(rows, NOW, { alert_times_ms: [steady, NOW.getTime() + 60 * MINUTE] })!;
    let expected = 0;
    for (let i = 0; i < rows.count; i += 1) {
      if (rows.values[i] >= 70 && rows.target[i] === 0 && Math.abs(rows.times[i] - steady) <= 45 * MINUTE) expected += 1;
    }
    expect(expected).toBeGreaterThan(0);
    expect(censored.censored_rows).toBe(expected);
    expect(censored.rows).toBe(plain.rows - expected);
    expect(censored.positives).toBe(plain.positives);
  });

  it('warnings close together are one alarm', () => {
    expect(firstOfRuns([0, 10 * MINUTE, 35 * MINUTE, 70 * MINUTE])).toEqual([0, 70 * MINUTE]);
  });
});

describe('lowRiskPushText', () => {
  it('states the reading and that the model is often wrong', () => {
    expect(lowRiskPushText(92, -6)).toEqual({ title: 'Test modelu: możliwy spadek', body: '92, −6 w 5 min. To prognoza testowa, porównaj ją z wykresem.' });
    expect(lowRiskPushText(92, null).body).toBe('92. To prognoza testowa, porównaj ją z wykresem.');
  });
});

const ALWAYS: LowRiskParams = { model_id: LOW_RISK_MODEL_ID, fitted_at: NOW.toISOString(), days: 30, rows: 1000, positives: 50, mean: new Array(12).fill(0), scale: new Array(12).fill(1), intercept: 5, coef: new Array(12).fill(0), threshold: 0.5 };

function harness(options: { patients?: string[]; tokens?: string[]; params?: LowRiskParams | null; readings?: Array<{ at: string; value: number }>; failPush?: boolean } = {}) {
  const logged: LowRiskScoreEntry[] = [];
  const pushes: Array<{ pushToken: string; title: string; kind: string }> = [];
  const pushedTo: number[] = [];
  const params = options.params === undefined ? ALWAYS : options.params;
  let readings = options.readings ?? series([120, 110, 100]);
  const service = new LowRiskAlertService({
    store: {
      listPatients: async () => options.patients ?? [P],
      listPushTokens: async () => options.tokens ?? ['token-a'],
      getParams: async () => (params ? { params, stored_at: new Date(NOW.getTime() - 3_600_000).toISOString() } : null),
      saveParams: async () => {},
      lastScoredAt: async () => logged.at(-1)?.reading_at ?? null,
      lastAlarmAt: async () => [...logged].reverse().find((entry) => entry.alarm)?.reading_at ?? null,
      logScore: async (entry) => {
        if (logged.some((row) => row.reading_at === entry.reading_at)) return false;
        logged.push(entry);
        return true;
      },
      markPushed: async (_entry, count) => void pushedTo.push(count),
      prune: async () => {},
    },
    readingsSince: async (_p, since) => readings.filter((reading) => reading.at >= since),
    carbTimes: async () => [],
    push: {
      sendGlucoseAlert: async (input) => {
        if (options.failPush) throw new Error('apns');
        pushes.push(input);
      },
    },
  });
  return { service, logged, pushes, pushedTo, setReadings: (next: typeof readings) => (readings = next) };
}

describe('the fit without moments near pushed alerts', () => {
  function fitting(options: { stored: LowRiskParams | null; alertTimes?: string[] }) {
    const saved: LowRiskParams[] = [];
    const asked: string[] = [];
    const readings = history(12);
    const service = new LowRiskAlertService({
      scoreOnly: true,
      store: {
        listPatients: async () => [P],
        listPushTokens: async () => [],
        getParams: async () => (saved.at(-1) ?? options.stored ? { params: (saved.at(-1) ?? options.stored)!, stored_at: new Date(NOW.getTime() - 3_600_000).toISOString() } : null),
        saveParams: async (_p, params) => void saved.push(params),
        lastScoredAt: async () => null,
        lastAlarmAt: async () => null,
        logScore: async () => true,
        markPushed: async () => {},
        prune: async () => {},
      },
      readingsSince: async (_p, since) => readings.filter((reading) => reading.at >= since),
      carbTimes: async () => [],
      alertTimes: options.alertTimes ? async (_p, since) => (asked.push(since), options.alertTimes!) : undefined,
      push: { sendGlucoseAlert: async () => {} },
    });
    return { service, saved, asked };
  }

  it('is on unless PREDICTION_LOW_CENSOR_ALERTS says no', () => {
    expect(isLowRiskCensorEnabled({})).toBe(true);
    expect(isLowRiskCensorEnabled({ PREDICTION_LOW_CENSOR_ALERTS: 'false' })).toBe(false);
    expect(isLowRiskCensorEnabled({ PREDICTION_LOW_CENSOR_ALERTS: '0' })).toBe(false);
  });

  it('replaces a fresh fit made the other way at once, then waits the usual time', async () => {
    const alert = new Date(NOW.getTime() - 26 * 60 * MINUTE).toISOString();
    const on = fitting({ stored: ALWAYS, alertTimes: [alert] });
    await on.service.tick(NOW);
    expect(on.saved).toHaveLength(1);
    expect(on.saved[0].censored_rows).toBeGreaterThan(0);
    expect(on.asked).toHaveLength(1);
    await on.service.tick(new Date(NOW.getTime() + MINUTE));
    expect(on.saved).toHaveLength(1);

    const off = fitting({ stored: { ...ALWAYS, censored_rows: 5 } });
    await off.service.tick(NOW);
    expect(off.saved).toHaveLength(1);
    expect(off.saved[0].censored_rows).toBeUndefined();

    const same = fitting({ stored: { ...ALWAYS, censored_rows: 5 }, alertTimes: [alert] });
    await same.service.tick(NOW);
    expect(same.saved).toEqual([]);
  });

  it('tries once when the fit cannot be made, and keeps the stored one', async () => {
    const h = fitting({ stored: ALWAYS, alertTimes: [] });
    // Too little history for a fit.
    const short = new LowRiskAlertService({ ...(h.service as unknown as { deps: ConstructorParameters<typeof LowRiskAlertService>[0] }).deps, readingsSince: async () => series([120, 110, 100]) });
    await short.tick(NOW);
    await short.tick(new Date(NOW.getTime() + MINUTE));
    expect(h.asked).toHaveLength(1);
    expect(h.saved).toEqual([]);
  });
});

describe('LowRiskAlertService', () => {
  it('does nothing with nobody listed', async () => {
    const h = harness({ patients: [] });
    await h.service.tick(NOW);
    expect(h.logged).toEqual([]);
    expect(h.pushes).toEqual([]);
  });

  it('pushes the listed phones once per reading, with its own kind', async () => {
    const h = harness({ tokens: ['a', 'b'] });
    await h.service.tick(NOW);
    await h.service.tick(new Date(NOW.getTime() + 60_000));
    expect(h.pushes.map((push) => push.pushToken)).toEqual(['a', 'b']);
    expect(h.pushes[0].kind).toBe('prediction_low');
    expect(h.logged).toHaveLength(1);
    expect(h.pushedTo).toEqual([2]);
  });

  it('stays quiet for 30 min after an alarm while the warnings go on, then pushes again', async () => {
    const h = harness();
    await h.service.tick(NOW);
    const later = series([120, 110, 100, 95], NOW.getTime() + 4 * MINUTE);
    h.setReadings(later);
    await h.service.tick(new Date(NOW.getTime() + 5 * MINUTE));
    expect(h.pushes).toHaveLength(1);
    expect(h.logged).toHaveLength(2);
    h.setReadings(series([120, 110, 100, 95], NOW.getTime() + 45 * MINUTE));
    await h.service.tick(new Date(NOW.getTime() + 46 * MINUTE));
    expect(h.pushes).toHaveLength(2);
  });

  it('does not push below 70, or from a score under the threshold', async () => {
    const low = harness({ readings: series([80, 72, 65]) });
    await low.service.tick(NOW);
    expect(low.logged[0].alarm).toBe(false);
    expect(low.pushes).toEqual([]);
    const under = harness({ params: { ...ALWAYS, intercept: -5 } });
    await under.service.tick(NOW);
    expect(under.logged[0].alarm).toBe(false);
    expect(under.pushes).toEqual([]);
  });

  it('does not alarm without a fit, and survives a failed push', async () => {
    const none = harness({ params: null, readings: series([120, 110, 100]) });
    await none.service.tick(NOW);
    expect(none.logged).toEqual([]);
    const failed = harness({ failPush: true });
    await failed.service.tick(NOW);
    expect(failed.pushedTo).toEqual([0]);
  });
});
