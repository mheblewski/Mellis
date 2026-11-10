import { describe, expect, it } from 'vitest';
import { predict, predictionForApp } from './application/prediction-engine';
import { DEFAULT_SIMPLE_LINE, fitSimpleLine, LINE_HORIZONS, predictSimpleLine, regressionSlope } from './application/simple-line';

const NOW = new Date('2026-11-06T12:00:00.000Z');

function readings(values: number[], step = 5, end = NOW.getTime() - 60_000) {
  return values.map((value, index) => ({ at: new Date(end - (values.length - 1 - index) * step * 60_000).toISOString(), value }));
}

describe('regressionSlope', () => {
  it('reads a straight line and needs three points', () => {
    expect(regressionSlope([-10, -5, 0], [100, 110, 120], 0, 2)).toBeCloseTo(2);
    expect(regressionSlope([-5, 0], [100, 110], 0, 1)).toBeNull();
  });
});

describe('predictSimpleLine', () => {
  it('follows the formula at every horizon', () => {
    const made = predictSimpleLine({ readings: readings([150, 150, 150, 150]), params: DEFAULT_SIMPLE_LINE, after_carbs: false })!;
    expect(made.points).toHaveLength(LINE_HORIZONS.length);
    // No trend: 150 + reversion × 40 + constant.
    expect(made.points[3].value).toBe(Math.round(150 - 0.59 * 40 + 18.4));
    expect(made.points[3].high - made.points[3].value).toBe(45);
    expect(Date.parse(made.points[3].at) - (NOW.getTime() - 60_000)).toBe(60 * 60_000);
  });

  it('a rise lifts the line and a fall lowers it', () => {
    const flat = predictSimpleLine({ readings: readings([150, 150, 150, 150]), params: DEFAULT_SIMPLE_LINE, after_carbs: false })!;
    const up = predictSimpleLine({ readings: readings([120, 130, 140, 150]), params: DEFAULT_SIMPLE_LINE, after_carbs: false })!;
    const down = predictSimpleLine({ readings: readings([180, 170, 160, 150]), params: DEFAULT_SIMPLE_LINE, after_carbs: false })!;
    expect(up.points[1].value).toBeGreaterThan(flat.points[1].value);
    expect(down.points[1].value).toBeLessThan(flat.points[1].value);
  });

  it('the fan is wider after carbs', () => {
    const plain = predictSimpleLine({ readings: readings([150, 150, 150]), params: DEFAULT_SIMPLE_LINE, after_carbs: false })!;
    const meal = predictSimpleLine({ readings: readings([150, 150, 150]), params: DEFAULT_SIMPLE_LINE, after_carbs: true })!;
    expect(meal.points[3].high - meal.points[3].low).toBeGreaterThan(plain.points[3].high - plain.points[3].low);
  });

  it('stays in the range a sensor can read', () => {
    const made = predictSimpleLine({ readings: readings([395, 398, 400]), params: DEFAULT_SIMPLE_LINE, after_carbs: true })!;
    for (const point of made.points) {
      expect(point.high).toBeLessThanOrEqual(401);
      expect(point.low).toBeGreaterThanOrEqual(39);
    }
  });

  it('gives nothing without a reading', () => {
    expect(predictSimpleLine({ readings: [], params: DEFAULT_SIMPLE_LINE, after_carbs: false })).toBeNull();
  });
});

describe('fitSimpleLine', () => {
  /** A seeded series that truly reverts to 140, with noise. */
  function series(days: number) {
    let state = 7;
    const next = () => {
      state = (state * 1664525 + 1013904223) % 4294967296;
      return state / 4294967296;
    };
    const out: Array<{ at: string; value: number }> = [];
    const count = (days * 1440) / 5;
    let value = 140;
    for (let i = 0; i < count; i += 1) {
      value += 0.04 * (140 - value) + (next() - 0.5) * 16;
      out.push({ at: new Date(NOW.getTime() - (count - i) * 5 * 60_000).toISOString(), value: Math.round(value) });
    }
    return out;
  }

  it('keeps the defaults with too little data', () => {
    expect(fitSimpleLine({ readings: series(5), carb_times_ms: [], now: NOW })).toBe(DEFAULT_SIMPLE_LINE);
    expect(fitSimpleLine({ readings: [], carb_times_ms: [], now: NOW })).toBe(DEFAULT_SIMPLE_LINE);
  });

  it('learns the pull towards the usual glucose, and a fan that covers about 80%', () => {
    const data = series(40);
    const fit = fitSimpleLine({ readings: data, carb_times_ms: [], now: NOW });
    expect(fit.source).toBe('FITTED');
    expect(fit.horizons[90].reversion).toBeLessThan(fit.horizons[15].reversion);
    // The series' centre: 110 − constant / reversion.
    expect(110 - fit.horizons[60].constant / fit.horizons[60].reversion).toBeGreaterThan(125);
    expect(110 - fit.horizons[60].constant / fit.horizons[60].reversion).toBeLessThan(155);
    expect(fit.horizons[60].width_no_carbs).toBeGreaterThan(fit.horizons[15].width_no_carbs);
  });

  it('a horizon the data cannot fit keeps its default', () => {
    const fit = fitSimpleLine({ readings: series(40).map((reading, index) => ({ ...reading, value: 100 + (index % 2) * 300 })), carb_times_ms: [], now: NOW });
    for (const horizon of LINE_HORIZONS) {
      expect(fit.horizons[horizon].reversion).toBeLessThanOrEqual(0);
    }
  });
});

describe('when the line hides', () => {
  const input = (values: number[], line: Partial<NonNullable<Parameters<typeof predict>[0]['line']>> = {}, now = NOW, prediction: any = null) => ({
    now,
    readings: readings(values, 5, now.getTime() - 60_000),
    prediction,
    line: { params: DEFAULT_SIMPLE_LINE, last_carbs_at: null, active_alert: false, ...line },
  });

  it('shows in the plain case and hides at the extremes', () => {
    expect(predict(input([130, 130, 130])).line?.hidden_reason).toBeNull();
    expect(predict(input([99, 99, 99])).line?.hidden_reason).toBe('LOW_RANGE');
    expect(predict(input([251, 251, 251])).line?.hidden_reason).toBe('HIGH_RANGE');
    expect(predict(input([156, 153, 150, 147])).line?.hidden_reason).toBeNull();
    expect(predict(input([200, 180, 160, 140])).line?.hidden_reason).toBe('FALLING_FAST');
  });

  it('labels an alert and no fresh reading, and not the night', () => {
    expect(predict(input([130, 130, 130], { active_alert: true })).line?.hidden_reason).toBe('ALERT_ACTIVE');
    expect(predict(input([130, 130, 130], {}, new Date('2026-11-06T02:00:00.000Z'))).line?.hidden_reason).toBeNull();
    const stale = { ...input([130, 130, 130]), readings: readings([130, 130, 130], 5, NOW.getTime() - 60 * 60_000) };
    expect(predict(stale).line?.hidden_reason).toBe('NO_FRESH_READING');
  });

  it('hides when the loop expects a low within 30 min', () => {
    const prediction = { source: 'OPENAPS', system: 'TRIO', computed_at: NOW.toISOString(), eventual_bg: 80, curves: { IOB: [130, 110, 95, 85, 75, 69, 65, 60, 60, 60, 60, 60, 60] } };
    expect(predict(input([130, 130, 130], {}, NOW, prediction)).line?.hidden_reason).toBe('LOW_EXPECTED');
  });

  it('the app gets the line at every risky moment, and the log keeps the label', () => {
    const risky = [input([99, 99, 99]), input([251, 251, 251]), input([200, 180, 160, 140]), input([130, 130, 130], { active_alert: true })];
    for (const moment of risky) {
      const set = predict(moment);
      expect(set.line?.hidden_reason).not.toBeNull();
      const sent = predictionForApp(set).line;
      expect(sent?.hidden_reason).toBeNull();
      expect(sent?.points.length).toBe(LINE_HORIZONS.length);
    }
    const stale = { ...input([130, 130, 130]), readings: readings([130, 130, 130], 5, NOW.getTime() - 60 * 60_000) };
    expect(predict(stale).line?.hidden_reason).toBe('NO_FRESH_READING');
    expect(predictionForApp(predict(stale)).line?.hidden_reason).toBeNull();
    const shown = predict(input([130, 130, 130]));
    expect(predictionForApp(shown).line?.points.length).toBe(LINE_HORIZONS.length);
  });

  it('after carbs within 4 hours it says so', () => {
    expect(predict(input([130, 130, 130], { last_carbs_at: new Date(NOW.getTime() - 60 * 60_000).toISOString() })).line?.after_carbs).toBe(true);
    expect(predict(input([130, 130, 130], { last_carbs_at: new Date(NOW.getTime() - 300 * 60_000).toISOString() })).line?.after_carbs).toBe(false);
  });
});
