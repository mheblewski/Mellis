import { describe, expect, it, vi } from 'vitest';
import { estimateDailyInsulinUsage, RESERVOIR_USAGE_POLICY, ReservoirUsageEstimator, usageWindow } from './reservoir-usage';

const NOW = new Date('2026-10-29T10:00:00.000Z');
const SCHEDULE: Array<[string, number]> = [['00:00', 0.5]];

/** A day of a loop: a 1 U/h temp basal every 2 h (24 U) and one 6 U bolus, 30 U in all; `skipHours` leaves hours empty. */
function day(date: string, options: { skipFrom?: number; skipTo?: number; bolus?: number | null } = {}) {
  const events: Array<{ event_id: string; type: string; occurred_at: string; payload: Record<string, unknown> }> = [];
  for (let hour = 0; hour < 24; hour += 2) {
    if (options.skipFrom !== undefined && hour >= options.skipFrom && hour < (options.skipTo ?? 24)) continue;
    events.push({ event_id: `${date}-t${hour}`, type: 'TEMP_BASAL', occurred_at: `${date}T${String(hour).padStart(2, '0')}:00:00.000Z`, payload: { rate: 1, duration_minutes: 120 } });
  }
  events.push({ event_id: `${date}-b`, type: 'BOLUS', occurred_at: `${date}T12:30:00.000Z`, payload: { insulin_units: options.bolus === undefined ? 6 : options.bolus } });
  return events;
}

describe('estimateDailyInsulinUsage (reservoir-usage.v1)', () => {
  it('averages the last 7 full days and never today', () => {
    const window = usageWindow(NOW, 'UTC');
    expect(window?.days.map((d) => d.date)).toEqual(['2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25', '2026-10-26', '2026-10-27', '2026-10-28']);
    const events = ['2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25', '2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29'].flatMap((date) => day(date, { bolus: date === '2026-10-29' ? 50 : 6 }));
    const usage = estimateDailyInsulinUsage({ now: NOW, timezone: 'UTC', events, basalSchedule: SCHEDULE });
    expect(usage).toEqual({ average_daily_units: 30, dates: window!.days.map((d) => d.date), days_considered: 7 });
  });

  it('skips a day with a data gap longer than 6 h and a day with an unknown dose', () => {
    const events = [
      ...day('2026-10-26', { bolus: 10 }), // 34 U
      ...day('2026-10-27', { skipFrom: 2, skipTo: 10 }), // nothing 02:00-10:00: the profile filled it in, not counted
      ...day('2026-10-28', { bolus: 2 }), // 26 U
      ...day('2026-10-25', { bolus: null }), // a bolus without an amount
    ];
    const usage = estimateDailyInsulinUsage({ now: NOW, timezone: 'UTC', events, basalSchedule: SCHEDULE });
    expect(usage?.dates).toEqual(['2026-10-26', '2026-10-28']);
    expect(usage?.average_daily_units).toBe(30);
  });

  it('needs at least 2 valid days', () => {
    const usage = estimateDailyInsulinUsage({ now: NOW, timezone: 'UTC', events: day('2026-10-28'), basalSchedule: SCHEDULE });
    expect(RESERVOIR_USAGE_POLICY.min_valid_days).toBe(2);
    expect(usage).toBeNull();
  });

  it('counts the gap from the day start and to its end', () => {
    // The last event of the day at 16:00 (temp basal to 18:00): 8 h to midnight with nothing recorded.
    const events = [...day('2026-10-27'), ...day('2026-10-28', { skipFrom: 17 })];
    expect(estimateDailyInsulinUsage({ now: NOW, timezone: 'UTC', events, basalSchedule: SCHEDULE })).toBeNull();
  });
});

describe('ReservoirUsageEstimator', () => {
  it('reads once an hour per patient and fails open', async () => {
    const source = {
      getTherapyProfileAt: vi.fn().mockResolvedValue({ status: 'KNOWN', basal_u_per_h: SCHEDULE, timezone: 'UTC' }),
      listInsulinDeliveryEventsByRange: vi.fn().mockResolvedValue([...day('2026-10-27'), ...day('2026-10-28')]),
    };
    const estimator = new ReservoirUsageEstimator(source);
    expect((await estimator.usage('p1', NOW))?.average_daily_units).toBe(30);
    await estimator.usage('p1', new Date(NOW.getTime() + 59 * 60_000));
    expect(source.listInsulinDeliveryEventsByRange).toHaveBeenCalledTimes(1);
    expect(source.listInsulinDeliveryEventsByRange).toHaveBeenCalledWith({ patientId: 'p1', startAtIso: '2026-10-21T18:00:00.000Z', endAtIso: '2026-10-29T00:00:00.000Z' });
    await estimator.usage('p1', new Date(NOW.getTime() + 61 * 60_000));
    expect(source.listInsulinDeliveryEventsByRange).toHaveBeenCalledTimes(2);

    source.listInsulinDeliveryEventsByRange.mockRejectedValueOnce(new Error('db down'));
    expect(await estimator.usage('p2', NOW)).toBeNull();
  });
});
