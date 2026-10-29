import { describe, expect, it } from 'vitest';
import { buildDailyInsulinTotals } from './daily-insulin-totals';
import { localDayWindows } from '@modules/context/application/time-range-normalization';

const timezone = 'Europe/Warsaw';
// Profile: 0.1 U/h 00:00-06:00, 0.2 U/h 06:00-24:00 => 0.6 + 3.6 = 4.2 U a day.
const schedule: Array<[string, number]> = [['00:00', 0.1], ['06:00', 0.2]];

function day(date: string, from: string, to: string, complete = true) {
  return { date, from, to, complete };
}

describe('buildDailyInsulinTotals', () => {
  // 2026-10-15 local day in Warsaw (UTC+2).
  const oct15 = day('2026-10-15', '2026-10-14T22:00:00.000Z', '2026-10-15T22:00:00.000Z');

  it('adds boluses, SMBs and the profile basal of a day without temp basals', () => {
    const totals = buildDailyInsulinTotals({
      days: [oct15],
      events: [
        { event_id: 'b1', type: 'BOLUS', occurred_at: '2026-10-15T06:00:00.000Z', payload: { insulin_units: 2.5 } },
        { event_id: 's1', type: 'SMB', occurred_at: '2026-10-15T07:00:00.000Z', payload: { insulin_units: 0.3 } },
        { event_id: 's1', type: 'SMB', occurred_at: '2026-10-15T07:00:00.000Z', payload: { insulin_units: 0.3 } },
      ],
      basalSchedule: schedule,
      profileTimezone: timezone,
    });
    expect(totals.days[0]).toMatchObject({ status: 'KNOWN', bolus_units: 2.5, smb_units: 0.3, basal_units: 4.2, total_units: 7, smb_count: 1 });
    expect(totals.complete_day_average).toMatchObject({ days: 1, total_units: 7 });
  });

  it('uses the delivered temp basals and the profile only in the gaps', () => {
    const totals = buildDailyInsulinTotals({
      days: [oct15],
      events: [
        // 10:00-11:00 local at 0 U/h (suspended), cut short at 10:30 by a 1.2 U/h temp for 30 min.
        { event_id: 't1', type: 'TEMP_BASAL', occurred_at: '2026-10-15T08:00:00.000Z', payload: { rate: 0, absolute: 0, duration_minutes: 60 } },
        { event_id: 't2', type: 'TEMP_BASAL', occurred_at: '2026-10-15T08:30:00.000Z', payload: { rate: 1.2, absolute: 1.2, duration_minutes: 30 } },
      ],
      basalSchedule: schedule,
      profileTimezone: timezone,
    });
    // 4.2 - 1 h of profile 0.2 + 0.5 h * 0 + 0.5 h * 1.2 = 4.6
    expect(totals.days[0]).toMatchObject({ status: 'KNOWN', basal_units: 4.6, total_units: 4.6, basal_minutes: { temp_basal: 60, profile: 1380, unknown: 0 } });
  });

  it('sees a temp basal that started before the day', () => {
    const totals = buildDailyInsulinTotals({
      days: [oct15],
      events: [{ event_id: 't0', type: 'TEMP_BASAL', occurred_at: '2026-10-14T21:30:00.000Z', payload: { absolute: 0.5, duration_minutes: 60 } }],
      basalSchedule: schedule,
      profileTimezone: timezone,
    });
    // First 30 min at 0.5 instead of 0.1: 4.2 + 0.5 * 0.4 = 4.4
    expect(totals.days[0].basal_units).toBe(4.4);
  });

  it('leaves basal and total unknown without a profile, never zero', () => {
    const totals = buildDailyInsulinTotals({
      days: [oct15],
      events: [{ event_id: 'b1', type: 'BOLUS', occurred_at: '2026-10-15T06:00:00.000Z', payload: { insulin_units: 2 } }],
      basalSchedule: null,
      profileTimezone: timezone,
    });
    expect(totals.days[0]).toMatchObject({ status: 'BASAL_UNKNOWN', bolus_units: 2, basal_units: null, total_units: null });
    expect(totals.complete_day_average).toBeNull();
  });

  it('averages only complete known days and keeps today as a partial day', () => {
    const today = day('2026-10-17', '2026-10-16T22:00:00.000Z', '2026-10-17T07:54:00.000Z', false);
    const oct16 = day('2026-10-16', '2026-10-15T22:00:00.000Z', '2026-10-16T22:00:00.000Z');
    const totals = buildDailyInsulinTotals({
      days: [oct15, oct16, today],
      events: [
        { event_id: 'b1', type: 'BOLUS', occurred_at: '2026-10-15T10:00:00.000Z', payload: { insulin_units: 10 } },
        { event_id: 'b2', type: 'BOLUS', occurred_at: '2026-10-16T10:00:00.000Z', payload: { insulin_units: 6 } },
        { event_id: 'b3', type: 'BOLUS', occurred_at: '2026-10-17T06:00:00.000Z', payload: { insulin_units: 3 } },
      ],
      basalSchedule: schedule,
      profileTimezone: timezone,
    });
    expect(totals.complete_day_average).toEqual({ days: 2, bolus_units: 8, smb_units: 0, basal_units: 4.2, total_units: 12.2 });
    expect(totals.days[2]).toMatchObject({ complete: false, bolus_units: 3 });
  });

  it('marks the days before a truncated selection (which keeps the newest events) as not selected', () => {
    const oct16 = day('2026-10-16', '2026-10-15T22:00:00.000Z', '2026-10-16T22:00:00.000Z');
    const oct17 = day('2026-10-17', '2026-10-16T22:00:00.000Z', '2026-10-17T22:00:00.000Z');
    const totals = buildDailyInsulinTotals({
      days: [oct15, oct16, oct17],
      events: [],
      basalSchedule: schedule,
      profileTimezone: timezone,
      // The selection starts mid-day on 16.10: that day is only partly selected.
      selectedFrom: '2026-10-16T05:00:00.000Z',
    });
    expect(totals.days.map((entry) => entry.status)).toEqual(['NOT_SELECTED', 'NOT_SELECTED', 'KNOWN']);
  });

  it('integrates the 25 h DST day with the profile on the local clock', () => {
    const [dstDay] = localDayWindows('2026-10-24T22:00:00.000Z', '2026-10-26T00:00:00.000Z', timezone);
    expect(dstDay).toMatchObject({ date: '2026-10-25', from: '2026-10-24T22:00:00.000Z', to: '2026-10-25T23:00:00.000Z', complete: true });
    const totals = buildDailyInsulinTotals({ days: [dstDay], events: [], basalSchedule: schedule, profileTimezone: timezone });
    // 7 h at 0.1 (00:00-06:00 local with the repeated hour) + 18 h at 0.2 = 4.3
    expect(totals.days[0].basal_units).toBe(4.3);
  });
});
