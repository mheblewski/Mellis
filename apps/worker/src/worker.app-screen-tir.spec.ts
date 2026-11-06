import { describe, expect, it, vi } from 'vitest';
import { WorkerService } from './worker.service';

const now = new Date('2026-11-05T16:19:00.000Z');
const minutesAgo = (minutes: number) => new Date(now.getTime() - minutes * 60_000).toISOString();

function workerWith(dashboards: unknown) {
  const worker = Object.create(WorkerService.prototype);
  Object.assign(worker, { bolusDashboardRepository: dashboards });
  return worker as { loadAppScreenTimeInRange(patientId: string, rangeType: string, at: Date): Promise<any> };
}

describe('time in range as on the app screen', () => {
  it('counts the last 14 days like the screen: 24-hour periods back from now, one reading per timestamp', async () => {
    const listGlucoseReadingsBetween = vi.fn().mockResolvedValue([
      { at: minutesAgo(10), value: 120 },
      { at: minutesAgo(10), value: 120 },
      { at: minutesAgo(20), value: 200 },
      { at: minutesAgo(30), value: 60 },
      { at: minutesAgo(40), value: 100 },
    ]);
    const result = await workerWith({ listGlucoseReadingsBetween }).loadAppScreenTimeInRange('p', 'LONG_RANGE', now);

    expect(listGlucoseReadingsBetween.mock.calls[0][1]).toBe('2026-10-22T16:19:00.000Z');
    expect(result.days).toBe(14);
    expect(result.time_in_range.readings_count).toBe(4);
    expect(result.time_in_range.in_range_percent).toBe(50);
    expect(result.time_in_range.low_percent).toBe(25);
  });

  it('is there only for the periods the screen offers, and never stops an answer', async () => {
    const listGlucoseReadingsBetween = vi.fn().mockResolvedValue([]);
    expect(await workerWith({ listGlucoseReadingsBetween }).loadAppScreenTimeInRange('p', 'TODAY', now)).toBeNull();
    expect(listGlucoseReadingsBetween).not.toHaveBeenCalled();
    expect(await workerWith(undefined).loadAppScreenTimeInRange('p', 'LONG_RANGE', now)).toBeNull();
    const failing = { listGlucoseReadingsBetween: vi.fn().mockRejectedValue(new Error('down')) };
    expect(await workerWith(failing).loadAppScreenTimeInRange('p', 'MEDIUM_RANGE', now)).toBeNull();
  });
});

describe('metric card above an answer', () => {
  const base = { patientId: 'p', rangeStartIso: '2026-11-05T00:00:00.000Z', timezone: 'UTC', now, insulinAverage: null, appScreen: null };
  const counts = { very_low: 0, low: 1, in_range: 8, high: 1, very_high: 0 };
  const build = (dashboards: unknown, args: Record<string, unknown>) =>
    (workerWith(dashboards) as any).buildMetricCard({ ...base, ...args });

  it('shows the screen\'s numbers for a question about its period', async () => {
    const card = await build(undefined, { question: 'Jaki TIR z ostatnich czternastu dni?', rangeType: 'LONG_RANGE', appScreen: { days: 14, counts } });
    expect(card).toEqual({ kind: 'TIME_IN_RANGE', period_label: 'ostatnie 14 dni', counts });
  });

  it('shows nothing for another period held in the same range', async () => {
    expect(await build(undefined, { question: 'Jaki TIR z 5 dni?', rangeType: 'MEDIUM_RANGE', appScreen: { days: 7, counts } })).toBeNull();
  });

  it('counts today from the readings of the range', async () => {
    const listGlucoseReadingsBetween = vi.fn().mockResolvedValue([{ at: minutesAgo(10), value: 120 }, { at: minutesAgo(20), value: 200 }]);
    const card = await build({ listGlucoseReadingsBetween }, { question: 'Jaki TIR dzisiaj?', rangeType: 'TODAY' });
    expect(card).toMatchObject({ period_label: 'dziś', counts: { in_range: 1, high: 1 } });
  });

  it('shows the average of complete days for daily insulin, and nothing without one', async () => {
    const average = { days: 14, bolus_units: 5.6, smb_units: 2.6, basal_units: 6, total_units: 14.2 };
    expect(await build(undefined, { question: 'Jakie DDI?', rangeType: 'LONG_RANGE', insulinAverage: average })).toMatchObject({ kind: 'DAILY_INSULIN', total_units: 14.2 });
    expect(await build(undefined, { question: 'Jakie DDI?', rangeType: 'TODAY' })).toBeNull();
  });

  it('adds nothing to other questions and never stops an answer', async () => {
    expect(await build(undefined, { question: 'Dlaczego rośnie?', rangeType: 'TODAY' })).toBeNull();
    const failing = { listGlucoseReadingsBetween: vi.fn().mockRejectedValue(new Error('down')) };
    expect(await build(failing, { question: 'Jaki TIR dzisiaj?', rangeType: 'TODAY' })).toBeNull();
  });
});
