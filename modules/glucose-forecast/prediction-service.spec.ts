import { describe, expect, it } from 'vitest';
import { PredictionService, type PredictionLogEntry, type PredictionSources, type StoredParams } from './application/prediction-service';
import { DEFAULT_SIMPLE_LINE, type SimpleLineParams } from './application/simple-line';
import { bolusChartBaseline, computeBolusForecast } from './application/bolus-forecast';

const NOW = new Date('2026-11-06T12:00:00.000Z');
const P = '11111111-1111-4111-8111-111111111111';

function harness(optedIn: string[] = [P]) {
  const logged: PredictionLogEntry[] = [];
  const saved: SimpleLineParams[] = [];
  let params: StoredParams | null = null;
  let fits = 0;
  let planReads = 0;
  const sources: PredictionSources = {
    store: {
      listOptedInPatients: async () => optedIn,
      isOptedIn: async () => true,
      getParams: async () => params,
      saveParams: async (_p, value, now) => {
        saved.push(value);
        params = { params: value, stored_at: now.toISOString() };
      },
      log: async (entry) => void logged.push(entry),
      pruneLog: async () => {},
      listPlan: async () => {
        planReads += 1;
        return { plan: [{ kind: 'WBT_INSULIN', at: '2026-11-06T14:00:00.000Z', title: null, state: 'PLANNED' }], late_rise: [] };
      },
    },
    live: async () => ({
      readings: [{ at: '2026-11-06T11:49:00.000Z', value: 130 }, { at: '2026-11-06T11:54:00.000Z', value: 132 }, { at: '2026-11-06T11:59:00.000Z', value: 134 }],
      loopStatus: null,
    }),
    readingsSince: async () => {
      fits += 1;
      return [];
    },
    carbTimes: async () => [],
    activeAlert: async () => false,
  };
  return { service: new PredictionService(sources), logged, saved, fits: () => fits, planReads: () => planReads, setParams: (value: StoredParams) => (params = value) };
}

describe('PredictionService', () => {
  it('does nothing for patients without the experiment', async () => {
    const h = harness([]);
    await h.service.tick(NOW);
    expect(h.logged).toEqual([]);
    expect(h.fits()).toBe(0);
  });

  it('logs the line with the patient on, using the defaults until there is a fit', async () => {
    const h = harness();
    await h.service.tick(NOW);
    expect(h.saved[0]).toBe(DEFAULT_SIMPLE_LINE);
    expect(h.logged).toHaveLength(1);
    expect(h.logged[0]).toMatchObject({ reading_at: '2026-11-06T11:59:00.000Z', glucose_mgdl: 134, loop_main: null, after_carbs: false, hidden_reason: null });
    expect(Object.keys(h.logged[0].points)).toEqual(['15', '30', '45', '60', '75', '90']);
  });

  it('logs the loop main curve moved to the reading, also when the loop computed just after it', async () => {
    const h = harness();
    (h.service as any).sources.live = async () => ({
      readings: [{ at: '2026-11-06T11:49:00.000Z', value: 130 }, { at: '2026-11-06T11:54:00.000Z', value: 132 }, { at: '2026-11-06T11:59:00.000Z', value: 134 }],
      loopStatus: {
        observed_at: '2026-11-06T11:59:40.000Z',
        raw_payload: { device: 'Trio', openaps: { suggested: { timestamp: '2026-11-06T11:59:40.000Z', deliverAt: '2026-11-06T11:59:40.000Z', COB: 0, predBGs: { IOB: Array.from({ length: 40 }, (_, index) => 136 + index) } } } },
      },
    });
    await h.service.tick(NOW);
    expect(h.logged[0].loop_main).toMatchObject({ 15: 137, 30: 140, 60: 146, 90: 152 });
  });

  it('refits about daily, not every tick', async () => {
    const h = harness();
    await h.service.tick(NOW);
    await h.service.tick(new Date(NOW.getTime() + 3_600_000));
    expect(h.fits()).toBe(1);
    await h.service.tick(new Date(NOW.getTime() + 21 * 3_600_000));
    expect(h.fits()).toBe(2);
  });

  it('reads the plan for the app, and not for the log', async () => {
    const h = harness();
    await h.service.tick(NOW);
    expect(h.planReads()).toBe(0);
    const set = await h.service.current(P, NOW, undefined, { with_plan: true });
    expect(set.plan).toHaveLength(1);
    expect(h.planReads()).toBe(1);
    expect((await h.service.current(P, NOW)).plan).toEqual([]);
  });

  it('a failed read of the plan draws no markers and keeps the line', async () => {
    const h = harness();
    (h.service as any).sources.store.listPlan = async () => {
      throw new Error('boom');
    };
    const set = await h.service.current(P, NOW, undefined, { with_plan: true });
    expect(set.plan).toEqual([]);
    expect(set.line?.points.length).toBeGreaterThan(0);
  });

  it('one patient failing does not stop the others', async () => {
    const h = harness(['bad', P]);
    const events: Array<Record<string, unknown>> = [];
    const original = (h.service as any).sources.live;
    (h.service as any).sources.live = async (id: string, now: Date) => {
      if (id === 'bad') throw new Error('boom');
      return original(id, now);
    };
    await h.service.tick(NOW, (event) => events.push(event));
    expect(events.filter((event) => event.event === 'prediction_tick_failed')).toHaveLength(1);
    expect(h.logged).toHaveLength(1);
  });

  it('sends the Bolus chart line to the app, while the worker still logs its own line', async () => {
    const h = harness();
    const sent = await h.service.forApp(P, NOW);
    const readings = [{ at: '2026-11-06T11:49:00.000Z', value: 130 }, { at: '2026-11-06T11:54:00.000Z', value: 132 }, { at: '2026-11-06T11:59:00.000Z', value: 134 }];
    const base = bolusChartBaseline({ now: NOW, readings, prediction: null, horizon_minutes: 90 })!;
    expect(sent.line?.model_id).toBe(`bolus-chart-base:${base.baseline_source}`);
    expect(sent.line?.points).toHaveLength(18);
    expect(sent.line?.points.map((point) => point.value)).toEqual(base.baseline.slice(1, 19).map((value) => Math.round(value)));
    // The Bolus chart's cloud: its band at 30 min, widening with the square root of time.
    const chart = computeBolusForecast({ now: NOW, readings, prediction: null, profile_isf: 150, profile_units: 'mg/dL', dia_hours: 6, carbs_g: 0, insulin_u: 0, icr_g_per_u: 15 })!;
    sent.line!.points.forEach((point, index) => {
      expect(point.high - point.value).toBe(chart.band[index + 1]);
      expect(point.value - point.low).toBe(chart.band[index + 1]);
    });
    expect(sent.line!.points[17].high - sent.line!.points[17].value).toBeGreaterThan(sent.line!.points[0].high - sent.line!.points[0].value);
    expect(sent.line?.points[0].at).toBe('2026-11-06T12:04:00.000Z');
    expect(sent.plan).toHaveLength(1);
    await h.service.tick(NOW);
    expect(h.logged[0].model_id).not.toMatch(/^bolus-chart-base/);
  });
});
