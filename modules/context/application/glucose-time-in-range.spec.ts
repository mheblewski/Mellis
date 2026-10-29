import { describe, expect, it } from 'vitest';
import { computeGlucoseTimeInRange } from './glucose-time-in-range';

describe('computeGlucoseTimeInRange', () => {
  it('splits readings into the app\'s ranges (very low < 55, as on the dashboard) with 70 and 180 inside the target', () => {
    const result = computeGlucoseTimeInRange([50, 55, 69, 70, 120, 180, 181, 250, 251, 400]);

    expect(result).toMatchObject({
      target_mg_dl: { low: 70, high: 180 },
      readings_count: 10,
      very_low_percent: 10,
      low_percent: 20,
      in_range_percent: 30,
      high_percent: 20,
      very_high_percent: 20,
      below_range_percent: 30,
      above_range_percent: 40,
      cgm_coverage_percent: null,
    });
  });

  it('reports how much of the range the readings cover', () => {
    const day = { from: '2026-10-16T00:00:00.000Z', to: '2026-10-17T00:00:00.000Z' };
    expect(computeGlucoseTimeInRange(Array(144).fill(120), day)?.cgm_coverage_percent).toBe(50);
    expect(computeGlucoseTimeInRange(Array(300).fill(120), day)?.cgm_coverage_percent).toBe(100);
  });

  it('ignores unusable values and returns null without readings', () => {
    expect(computeGlucoseTimeInRange([])).toBeNull();
    expect(computeGlucoseTimeInRange([Number.NaN, 0])).toBeNull();
    expect(computeGlucoseTimeInRange([Number.NaN, 100])?.in_range_percent).toBe(100);
  });
});
