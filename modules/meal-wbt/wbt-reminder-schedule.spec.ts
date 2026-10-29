import { describe, expect, it } from 'vitest';
import { nextWbtReminderSchedule, type WbtReminderSchedule } from './application/wbt-policy';

const now = new Date('2026-10-26T18:00:00.000Z');
const at = (minutesFromNow: number) => new Date(now.getTime() + minutesFromNow * 60_000).toISOString();
// The meal started this many minutes ago; its reminder is 150 min after.
const meal = (minutesAgo: number) => at(-minutesAgo);
const row = (overrides: Partial<WbtReminderSchedule> = {}): WbtReminderSchedule => ({
  enabled: true, source: 'AUTO', remind_at: at(90), status: 'SCHEDULED', not_before: null, ...overrides,
});

describe('WBT reminder schedule (audit 2026-10-26)', () => {
  it('a new AUTO reminder is 2.5 h after the meal', () => {
    expect(nextWbtReminderSchedule(null, { kind: 'AUTO', enabled: true, meal_started_at: meal(60) }, now))
      .toEqual({ enabled: true, source: 'AUTO', remind_at: at(90), status: 'SCHEDULED' });
  });

  it('moves earlier when the meal moved earlier, and later when it moved later', () => {
    expect(nextWbtReminderSchedule(row(), { kind: 'MEAL_MOVED', meal_started_at: meal(90) }, now)?.remind_at).toBe(at(60));
    expect(nextWbtReminderSchedule(row(), { kind: 'AUTO', enabled: true, meal_started_at: meal(30) }, now)?.remind_at).toBe(at(120));
  });

  it('a split part\'s postponement still holds when the meal moves earlier', () => {
    const postponed = row({ remind_at: at(200), not_before: at(200) });
    expect(nextWbtReminderSchedule(postponed, { kind: 'MEAL_MOVED', meal_started_at: meal(90) }, now)?.remind_at).toBe(at(200));
    // A meal that moved past the postponement takes over.
    expect(nextWbtReminderSchedule(postponed, { kind: 'MEAL_MOVED', meal_started_at: at(100) }, now)?.remind_at).toBe(at(250));
  });

  it('AUTO never switches a MANUAL choice, but its time follows the meal', () => {
    const manual = row({ source: 'MANUAL', enabled: true });
    expect(nextWbtReminderSchedule(manual, { kind: 'AUTO', enabled: false, meal_started_at: meal(90) }, now))
      .toEqual({ enabled: true, source: 'MANUAL', remind_at: at(60), status: 'SCHEDULED' });
  });

  it('a sent or skipped reminder keeps its time and state', () => {
    const sent = row({ status: 'SENT', remind_at: at(-10) });
    expect(nextWbtReminderSchedule(sent, { kind: 'MEAL_MOVED', meal_started_at: meal(90) }, now)).toEqual({ enabled: true, source: 'AUTO', remind_at: at(-10), status: 'SENT' });
    expect(nextWbtReminderSchedule(row({ status: 'SKIPPED' }), { kind: 'AUTO', enabled: false, meal_started_at: meal(60) }, now)?.status).toBe('SKIPPED');
  });

  it('protein or fat added beyond the stale window: MISSED, never a push', () => {
    const off = row({ enabled: false, remind_at: at(-150) });
    // Meal 300 min ago: reminder at -150 min, 150 > 120 min past it.
    expect(nextWbtReminderSchedule(off, { kind: 'AUTO', enabled: true, meal_started_at: meal(300) }, now)?.status).toBe('MISSED');
    expect(nextWbtReminderSchedule(null, { kind: 'AUTO', enabled: true, meal_started_at: meal(300) }, now)?.status).toBe('MISSED');
    // Within the window it is still sent (late).
    expect(nextWbtReminderSchedule(off, { kind: 'AUTO', enabled: true, meal_started_at: meal(200) }, now)?.status).toBe('SCHEDULED');
    // Switched off again: no longer missed, simply off.
    const missed = row({ status: 'MISSED', remind_at: at(-150) });
    expect(nextWbtReminderSchedule(missed, { kind: 'AUTO', enabled: false, meal_started_at: meal(300) }, now)).toMatchObject({ enabled: false, status: 'SCHEDULED' });
    // The meal moved later so the time is to come: scheduled again.
    expect(nextWbtReminderSchedule(missed, { kind: 'MEAL_MOVED', meal_started_at: meal(60) }, now)).toMatchObject({ status: 'SCHEDULED', remind_at: at(90) });
  });

  it('an unchanged scheduled reminder past the window is left for the worker (a server outage, not MISSED)', () => {
    const due = row({ remind_at: at(-150) });
    expect(nextWbtReminderSchedule(due, { kind: 'AUTO', enabled: true, meal_started_at: meal(300) }, now)?.status).toBe('SCHEDULED');
  });

  it('a meal move with no reminder writes nothing', () => {
    expect(nextWbtReminderSchedule(null, { kind: 'MEAL_MOVED', meal_started_at: meal(60) }, now)).toBeNull();
  });
});
