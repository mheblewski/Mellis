import { describe, expect, it } from 'vitest';
import { LowRiskAlertService } from './application/low-risk-alert.service';
import { LOW_RISK_MODEL_ID, type LowRiskParams } from './application/low-risk';
import { compareLowWarnings, lowComparisonPushText, type LowComparison, type LowComparisonRow } from './application/low-risk-comparison';

const MINUTE = 60_000;
const START = Date.parse('2026-11-10T00:00:00.000Z');

/** One reading every 5 min; `marks` says what happens at which minute. */
function rows(minutes: number, marks: { lows?: number[]; model?: number[]; rules?: number[]; unknown?: number[] } = {}): LowComparisonRow[] {
  const out: LowComparisonRow[] = [];
  for (let minute = 0; minute <= minutes; minute += 5) {
    out.push({
      reading_at: new Date(START + minute * MINUTE).toISOString(),
      glucose_mgdl: marks.lows?.includes(minute) ? 62 : 110,
      alarm: Boolean(marks.model?.includes(minute)),
      rules_warning: marks.unknown?.includes(minute) ? null : Boolean(marks.rules?.includes(minute)),
    });
  }
  return out;
}

describe('compareLowWarnings', () => {
  it('counts a low as warned by an alert 60-15 min before it, and alerts without a low', () => {
    // Lows at 02:00 and 06:00. The model alerts 30 min before the first and at 04:00 (no low after); the rules alert 10 min before the second (too late) and 20 min before the first.
    const result = compareLowWarnings({
      rows: rows(24 * 60, { lows: [120, 125, 360], model: [90, 95, 240], rules: [100, 350] }),
      live_source: 'RULES',
    });
    expect(result).toMatchObject({ days: 1, lows: 2, live_source: 'RULES', ready: false });
    expect(result.model).toEqual({ lows_warned: 1, alerts_per_day: 2, alerts_without_low_per_day: 1 });
    expect(result.rules).toEqual({ lows_warned: 1, alerts_per_day: 2, alerts_without_low_per_day: 0 });
  });

  it('uses only readings with both verdicts, and leaves out time in gaps and lows right after one', () => {
    const early = rows(60, { unknown: Array.from({ length: 13 }, (_, index) => index * 5) });
    const later = rows(24 * 60, { lows: [0, 600] }).map((row) => ({ ...row, reading_at: new Date(Date.parse(row.reading_at) + 3 * 86_400_000).toISOString() }));
    const result = compareLowWarnings({ rows: [...early, ...later], live_source: 'MODEL' });
    expect(result.from).toBe(later[0].reading_at);
    expect(result.days).toBe(1);
    // The low at the very start had nothing before it to warn from.
    expect(result.lows).toBe(1);
  });

  it('is ready with two weeks and 20 lows, or four weeks and 10', () => {
    const everyHours = (days: number, hours: number) => Array.from({ length: Math.floor((days * 24) / hours) }, (_, index) => (index + 1) * hours * 60);
    expect(compareLowWarnings({ rows: rows(14 * 1440 + 5, { lows: everyHours(14, 16) }), live_source: 'RULES' })).toMatchObject({ lows: 21, ready: true });
    expect(compareLowWarnings({ rows: rows(13 * 1440, { lows: everyHours(13, 12) }), live_source: 'RULES' }).ready).toBe(false);
    expect(compareLowWarnings({ rows: rows(20 * 1440, { lows: everyHours(20, 40) }), live_source: 'RULES' })).toMatchObject({ lows: 12, ready: false });
    expect(compareLowWarnings({ rows: rows(28 * 1440 + 5, { lows: everyHours(28, 60) }), live_source: 'RULES' })).toMatchObject({ lows: 11, ready: true });
    expect(compareLowWarnings({ rows: [], live_source: 'RULES' })).toMatchObject({ days: 0, lows: 0, from: null, ready: false });
  });
});

describe('the comparison in the worker', () => {
  const NOW = new Date('2026-11-24T12:00:00.000Z');
  const PARAMS: LowRiskParams = { model_id: LOW_RISK_MODEL_ID, fitted_at: NOW.toISOString(), days: 30, rows: 1000, positives: 50, mean: new Array(12).fill(0), scale: new Array(12).fill(1), intercept: -5, coef: new Array(12).fill(0), threshold: 0.5, censored_rows: 0 };

  function harness(options: { ready: boolean; tokens?: string[]; failPush?: boolean }) {
    const saved: LowComparison[] = [];
    const pushes: Array<{ pushToken: string; title: string; body: string }> = [];
    let notified = false;
    const everyHours = Array.from({ length: 21 }, (_, index) => (index + 1) * 16 * 60);
    const service = new LowRiskAlertService({
      scoreOnly: true,
      store: {
        listPatients: async () => ['p1'],
        listPushTokens: async () => [],
        getParams: async () => ({ params: PARAMS, stored_at: new Date(NOW.getTime() - 3_600_000).toISOString() }),
        saveParams: async () => {},
        lastScoredAt: async () => null,
        lastAlarmAt: async () => null,
        logScore: async () => true,
        markPushed: async () => {},
        prune: async () => {},
        comparison: {
          rows: async () => (options.ready ? rows(14 * 1440 + 5, { lows: everyHours }) : rows(1440)),
          save: async (_p, result) => {
            saved.push(result);
            return { notified };
          },
          listOwnerPushTokens: async () => options.tokens ?? ['owner-a', 'owner-b'],
          markNotified: async () => void (notified = true),
        },
      },
      readingsSince: async () => [],
      carbTimes: async () => [],
      alertTimes: async () => [],
      push: {
        sendGlucoseAlert: async () => {},
        sendPredictionComparison: async (input) => {
          if (options.failPush) throw new Error('apns');
          pushes.push(input);
        },
      },
    });
    return { service, saved, pushes, isNotified: () => notified };
  }

  it('works it out once a day and tells the owners once when it is ready', async () => {
    const h = harness({ ready: true });
    await h.service.tick(NOW);
    await h.service.tick(new Date(NOW.getTime() + MINUTE));
    expect(h.saved).toHaveLength(1);
    expect(h.saved[0]).toMatchObject({ ready: true, live_source: 'MODEL' });
    expect(h.pushes.map((push) => push.pushToken)).toEqual(['owner-a', 'owner-b']);
    expect(h.pushes[0]).toMatchObject(lowComparisonPushText());
    await h.service.tick(new Date(NOW.getTime() + 21 * 3_600_000));
    expect(h.saved).toHaveLength(2);
    expect(h.pushes).toHaveLength(2);
  });

  it('says nothing before it is ready, and tries again when no phone was reached', async () => {
    const early = harness({ ready: false });
    await early.service.tick(NOW);
    expect(early.saved[0].ready).toBe(false);
    expect(early.pushes).toEqual([]);
    const failed = harness({ ready: true, failPush: true });
    await failed.service.tick(NOW);
    expect(failed.isNotified()).toBe(false);
  });

  it('asks for the result to be passed on to Mateusz', () => {
    expect(lowComparisonPushText().body).toContain('Przekaż go Mateuszowi');
  });
});
