import { describe, expect, it } from 'vitest';
import { journalReminders, WBT_REMINDER_MISSED_NOTE, WBT_REMINDER_STALE_NOTE, wbtReminderStatus, type JournalFacts } from './application/meal-journal';

const now = new Date('2026-10-26T18:00:00.000Z');
const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000).toISOString();
const wbt = (overrides: Partial<NonNullable<JournalFacts['wbt']>> = {}): NonNullable<JournalFacts['wbt']> => ({
  enabled: true, source: 'AUTO', remind_at: ago(150), status: 'SCHEDULED', sent_at: null, ...overrides,
});
const remindersOf = (row: NonNullable<JournalFacts['wbt']>) => journalReminders({ wbt: row, care: [], parts: [], actions: [], awaiting_units: new Map() }, now);

describe('WBT reminder that never came (audit 2026-10-26)', () => {
  it('MISSED is its own state with the check-WBT line, not "wygasło"', () => {
    expect(wbtReminderStatus(wbt({ status: 'MISSED' }), false, now)).toBe('MISSED');
    expect(remindersOf(wbt({ status: 'MISSED' }))[0]).toMatchObject({ status: 'MISSED', note: WBT_REMINDER_MISSED_NOTE });
    expect(WBT_REMINDER_MISSED_NOTE).toBe('Przypomnienie o WBT minęło — sprawdź, czy WBT jest jeszcze potrzebne.');
  });

  it('a WBT dose given still settles a missed one', () => {
    expect(wbtReminderStatus(wbt({ status: 'MISSED', dose_given_at: ago(5) }), false, now)).toBe('GIVEN');
  });

  it('skipped by the worker after an outage says so; skipped because WBT was logged does not', () => {
    expect(remindersOf(wbt({ status: 'SKIPPED', skip_reason: 'STALE' }))[0]).toMatchObject({ status: 'EXPIRED', note: WBT_REMINDER_STALE_NOTE });
    const logged = remindersOf(wbt({ status: 'SKIPPED', skip_reason: null }))[0];
    expect(logged.status).toBe('EXPIRED');
    expect(logged).not.toHaveProperty('note');
  });
});
