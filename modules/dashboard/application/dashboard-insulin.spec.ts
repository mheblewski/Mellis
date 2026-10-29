import { describe, expect, it } from 'vitest';
import { buildDashboardInsulin } from './dashboard-insulin';

const event = (type: string, occurred_at: string, payload: Record<string, unknown>, event_id = `${type}-${occurred_at}`) => ({ event_id, type, occurred_at, payload });

describe('buildDashboardInsulin', () => {
  it('keeps boluses and SMBs of the window once each, oldest first', () => {
    const insulin = buildDashboardInsulin({
      from: '2026-10-18T10:00:00.000Z',
      to: '2026-10-18T13:00:00.000Z',
      events: [
        event('BOLUS', '2026-10-18T09:00:00.000Z', { insulin_units: 2 }),
        event('BOLUS', '2026-10-18T10:20:00.000Z', { insulin_units: 3.5 }),
        event('SMB', '2026-10-18T10:40:00.000Z', { insulin_units: 0.3 }, 'a'),
        event('SMB', '2026-10-18T10:40:00.000Z', { insulin_units: 0.3 }, 'b'),
        event('SMB', '2026-10-18T10:30:00.000Z', { insulin_units: 0.4 }),
        event('SMB', '2026-10-18T10:50:00.000Z', { insulin_units: 0 }),
      ],
      basalSchedule: [['00:00', 0.6]],
      profileTimezone: 'Europe/Warsaw',
    });

    expect(insulin.boluses).toEqual([{ at: '2026-10-18T10:20:00.000Z', units: 3.5 }]);
    expect(insulin.smbs).toEqual([
      { at: '2026-10-18T10:30:00.000Z', units: 0.4 },
      { at: '2026-10-18T10:40:00.000Z', units: 0.3 },
    ]);
  });

  it('draws temp basals and the profile basal in the gaps as runs of one rate', () => {
    const insulin = buildDashboardInsulin({
      from: '2026-10-18T10:00:00.000Z',
      to: '2026-10-18T13:00:00.000Z',
      events: [
        // Started before the window, cut short by the next one.
        event('TEMP_BASAL', '2026-10-18T09:30:00.000Z', { rate: 0, absolute: 0, duration_minutes: 120 }),
        event('TEMP_BASAL', '2026-10-18T10:30:00.000Z', { rate: 1.2, absolute: 1.2, duration_minutes: 30 }),
      ],
      basalSchedule: [['00:00', 0.6], ['12:30', 0.8]],
      profileTimezone: 'UTC',
    });

    expect(insulin.basal).toEqual([
      { start: '2026-10-18T10:00:00.000Z', end: '2026-10-18T10:30:00.000Z', rate: 0 },
      { start: '2026-10-18T10:30:00.000Z', end: '2026-10-18T11:00:00.000Z', rate: 1.2 },
      { start: '2026-10-18T11:00:00.000Z', end: '2026-10-18T12:30:00.000Z', rate: 0.6 },
      { start: '2026-10-18T12:30:00.000Z', end: '2026-10-18T13:00:00.000Z', rate: 0.8 },
    ]);
  });

  it('leaves the basal unknown without a profile outside temp basals', () => {
    const insulin = buildDashboardInsulin({
      from: '2026-10-18T10:00:00.000Z',
      to: '2026-10-18T11:00:00.000Z',
      events: [event('TEMP_BASAL', '2026-10-18T10:00:00.000Z', { rate: 0.5, duration_minutes: 30 })],
      basalSchedule: null,
      profileTimezone: 'UTC',
    });

    expect(insulin.basal).toEqual([
      { start: '2026-10-18T10:00:00.000Z', end: '2026-10-18T10:30:00.000Z', rate: 0.5 },
      { start: '2026-10-18T10:30:00.000Z', end: '2026-10-18T11:00:00.000Z', rate: null },
    ]);
  });
});
