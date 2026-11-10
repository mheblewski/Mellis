import { describe, expect, it } from 'vitest';
import { buildDashboardInsulin } from './dashboard-insulin';
import type { TherapyContextEvent } from '@modules/integrations/nightscout/application/therapy-context-events';

const temp = (occurred_at: string, rate: number, duration_minutes = 30) => ({ type: 'TEMP_BASAL', occurred_at, payload: { rate, absolute: rate, duration_minutes } });
const context = (kind: TherapyContextEvent['kind'], occurred_at: string, details: Record<string, unknown> = {}, duration_minutes: number | null = null): TherapyContextEvent =>
  ({ source_record_id: `${kind}-${occurred_at}`, kind, event_type: kind, occurred_at, duration_minutes, details });

const basalNow = (args: { events?: Array<{ type: string; occurred_at: string; payload: Record<string, unknown> }>; contextEvents?: TherapyContextEvent[]; schedule?: Array<[string, number]> | null }) =>
  buildDashboardInsulin({
    from: '2026-11-03T10:00:00.000Z',
    to: '2026-11-03T12:00:00.000Z',
    events: args.events ?? [],
    basalSchedule: args.schedule === undefined ? [['00:00', 0.2]] : args.schedule,
    profileTimezone: 'UTC',
    contextEvents: args.contextEvents,
  }).basal_now!;

describe('basal_now', () => {
  it('is the profile when no temp basal runs', () => {
    expect(basalNow({})).toMatchObject({ rate: 0.2, source: 'PROFILE', plan_rate: 0.2, profile_rate: 0.2, override: null });
  });

  it('counts a zero temp basal renewed every 5 minutes as one stretch', () => {
    const events = [0, 5, 10, 15, 20, 25].map((minute) => temp(`2026-11-03T11:${String(30 + minute).padStart(2, '0')}:00.000Z`, 0));
    expect(basalNow({ events })).toMatchObject({ rate: 0, source: 'TEMP', since: '2026-11-03T11:30:00.000Z', plan_rate: 0.2 });
  });

  it('ignores a short one-step nudge but not a longer change', () => {
    const nudge = [temp('2026-11-03T11:00:00.000Z', 0.3, 20), temp('2026-11-03T11:20:00.000Z', 0.35, 5), temp('2026-11-03T11:25:00.000Z', 0.3, 40)];
    expect(basalNow({ events: nudge }).since).toBe('2026-11-03T11:00:00.000Z');
    const change = [temp('2026-11-03T11:00:00.000Z', 0.3, 20), temp('2026-11-03T11:20:00.000Z', 0, 5), temp('2026-11-03T11:25:00.000Z', 0.3, 40)];
    expect(basalNow({ events: change }).since).toBe('2026-11-03T11:25:00.000Z');
  });

  it('falls back to the profile once a temp basal expired', () => {
    expect(basalNow({ events: [temp('2026-11-03T11:00:00.000Z', 0, 30)] })).toMatchObject({ rate: 0.2, source: 'PROFILE', since: '2026-11-03T11:30:00.000Z' });
  });

  it('skips a temp basal deleted in Nightscout after the import, also on the chart', () => {
    const deleted = { ...temp('2026-11-03T11:50:00.000Z', 0, 0), payload: { rate: 0, absolute: 0, duration_minutes: 0, removed_in_source_at: '2026-11-03T11:58:00.000Z' } };
    const events = [temp('2026-11-03T11:40:00.000Z', 0.1, 30), deleted];
    expect(basalNow({ events })).toMatchObject({ rate: 0.1, source: 'TEMP', since: '2026-11-03T11:40:00.000Z' });
    const insulin = buildDashboardInsulin({ from: '2026-11-03T10:00:00.000Z', to: '2026-11-03T12:00:00.000Z', events, basalSchedule: [['00:00', 0.2]], profileTimezone: 'UTC' });
    expect(insulin.basal.at(-1)).toMatchObject({ start: '2026-11-03T11:40:00.000Z', end: '2026-11-03T12:00:00.000Z', rate: 0.1 });
  });

  it('scales the plan by an override in force', () => {
    const contextEvents = [context('OVERRIDE', '2026-11-03T11:00:00.000Z', { reason: 'Aktywność', insulin_needs_scale: 0.8 }, 120)];
    expect(basalNow({ contextEvents })).toMatchObject({ plan_rate: 0.16, profile_rate: 0.2, override: { name: 'Aktywność', percentage: 80 } });
    const ended = [context('OVERRIDE', '2026-11-03T09:00:00.000Z', { insulin_needs_scale: 0.8 }, 60)];
    expect(basalNow({ contextEvents: ended })).toMatchObject({ plan_rate: 0.2, override: null });
  });

  it('shows a suspended pump until it is resumed', () => {
    const suspended = [context('PUMP_SUSPEND', '2026-11-03T11:20:00.000Z')];
    expect(basalNow({ contextEvents: suspended })).toMatchObject({ rate: 0, source: 'SUSPENDED', since: '2026-11-03T11:20:00.000Z' });
    const resumed = [...suspended, context('PUMP_RESUME', '2026-11-03T11:40:00.000Z')];
    expect(basalNow({ contextEvents: resumed }).source).toBe('PROFILE');
  });

  it('sums the SMBs of the last hour', () => {
    const events = [
      { type: 'SMB', occurred_at: '2026-11-03T10:50:00.000Z', payload: { insulin_units: 0.5 } },
      { type: 'SMB', occurred_at: '2026-11-03T11:10:00.000Z', payload: { insulin_units: 0.3 } },
      { type: 'SMB', occurred_at: '2026-11-03T11:40:00.000Z', payload: { insulin_units: 0.25 } },
    ];
    expect(basalNow({ events }).smb_last_hour_units).toBe(0.55);
  });

  it('has no plan without a profile', () => {
    expect(basalNow({ schedule: null, events: [temp('2026-11-03T11:50:00.000Z', 0.1)] })).toMatchObject({ rate: 0.1, plan_rate: null, profile_rate: null });
  });
});
