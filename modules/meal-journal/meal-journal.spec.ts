import { describe, expect, it } from 'vitest';
import type { CareReminderRecord } from '@modules/care-reminders/application/care-reminders';
import type { PlannedBolusRecord } from '@modules/remote-commands/application/split-bolus';
import {
  buildJournalItem,
  careReminderStatus,
  chartOtherBoluses,
  clampJournalLimit,
  journalBoluses,
  journalTimeline,
  likePattern,
  parseMealSearchQuery,
  plannedPartStatus,
  wbtReminderStatus,
  type JournalAction,
  type JournalFacts,
} from './application/meal-journal';

const now = new Date('2026-10-25T18:00:00.000Z');
const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000).toISOString();

const care = (overrides: Partial<CareReminderRecord> = {}): CareReminderRecord => ({
  id: 'r1', patient_id: 'p1', conversation_id: null, user_message_id: null, created_by_user_id: 'u1', note: 'Druga dawka · 45 g · 4,5 j o 18:05',
  trigger: 'AT_TIME', due_at: ago(-10), threshold_mgdl: null, wait_until: null, status: 'ACTIVE', fired_at: null, fired_reason: null,
  fired_glucose_mgdl: null, cancelled_at: null, cancelled_by_user_id: null, created_at: ago(20), kind: 'SECOND_DOSE', meal_record_id: 'm1', ...overrides,
});
const action = (overrides: Partial<JournalAction> = {}): JournalAction => ({ id: 'a1', purpose: 'NEW_MEAL', started_at: ago(30), carbs_g: 45, bolus_units: 4.5, assigned_by: null, ...overrides });
const facts = (overrides: Partial<JournalFacts> = {}): JournalFacts => ({
  meal_id: 'm1', started_at: ago(30), description: null, carbs_g: 45, protein_g: null, fat_g: null, actions: [action()], awaiting_units: new Map(),
  origin: { first_command_source: 'BOLUS_SCREEN', conversation_id: null }, wbt: null, care: [], parts: [], ...overrides,
});

describe('journal reminder states', () => {
  const wbt = { enabled: true, source: 'MANUAL' as const, remind_at: ago(-60), status: 'SCHEDULED' as const, sent_at: null };

  it('WBT: waiting, due now, sent, off, expired, and given wins', () => {
    expect(wbtReminderStatus(wbt, false, now)).toBe('WAITING');
    expect(wbtReminderStatus({ ...wbt, remind_at: ago(1) }, false, now)).toBe('DUE_NOW');
    expect(wbtReminderStatus({ ...wbt, status: 'SENT', sent_at: ago(10) }, false, now)).toBe('DUE_NOW');
    expect(wbtReminderStatus({ ...wbt, status: 'SENT', sent_at: ago(45) }, false, now)).toBe('SENT');
    expect(wbtReminderStatus({ ...wbt, enabled: false }, false, now)).toBe('OFF');
    expect(wbtReminderStatus({ ...wbt, status: 'SKIPPED' }, false, now)).toBe('EXPIRED');
    expect(wbtReminderStatus({ ...wbt, status: 'SENT', sent_at: ago(10) }, true, now)).toBe('GIVEN');
    // Given from the Bolus tab (no WBT action on the meal): the dose that answered it.
    expect(wbtReminderStatus({ ...wbt, status: 'SENT', sent_at: ago(10), dose_given_at: ago(2) }, false, now)).toBe('GIVEN');
  });

  it('second dose: a rising one is waiting, a lapsed one expired, a cancelled one off, a later bolus gives it', () => {
    expect(careReminderStatus(care(), [], new Map(), now)).toBe('WAITING');
    expect(careReminderStatus(care({ due_at: ago(1) }), [], new Map(), now)).toBe('DUE_NOW');
    expect(careReminderStatus(care({ trigger: 'GLUCOSE_RISING', due_at: ago(20), wait_until: ago(-40) }), [], new Map(), now)).toBe('WAITING');
    expect(careReminderStatus(care({ status: 'EXPIRED' }), [], new Map(), now)).toBe('EXPIRED');
    expect(careReminderStatus(care({ status: 'CANCELLED' }), [], new Map(), now)).toBe('OFF');
    expect(careReminderStatus(care({ status: 'FIRED', fired_at: ago(5) }), [], new Map(), now)).toBe('DUE_NOW');
    expect(careReminderStatus(care({ status: 'FIRED', fired_at: ago(60) }), [], new Map(), now)).toBe('SENT');
    const added = action({ id: 'a2', purpose: 'MEAL_ADDITION', started_at: ago(2), carbs_g: null, bolus_units: 2 });
    expect(careReminderStatus(care({ status: 'FIRED', fired_at: ago(5) }), [added], new Map(), now)).toBe('GIVEN');
    expect(careReminderStatus(care({ status: 'FIRED', fired_at: ago(5), dose_given_at: ago(2) }), [], new Map(), now)).toBe('GIVEN');
  });

  it('planned parts follow their plan', () => {
    const part = (status: PlannedBolusRecord['status'], dueAt = ago(-30)) => ({ status, due_at: dueAt });
    expect(plannedPartStatus(part('SCHEDULED'), now)).toBe('WAITING');
    expect(plannedPartStatus(part('SCHEDULED', ago(1)), now)).toBe('DUE_NOW');
    expect(plannedPartStatus(part('NOTIFIED'), now)).toBe('DUE_NOW');
    expect(plannedPartStatus(part('GIVEN'), now)).toBe('GIVEN');
    expect(plannedPartStatus(part('SKIPPED'), now)).toBe('OFF');
    expect(plannedPartStatus(part('EXPIRED'), now)).toBe('EXPIRED');
  });
});

describe('journal items', () => {
  it('a Bolus tab meal: no title, its loop carbs and every bolus, its reminders', () => {
    const item = buildJournalItem(facts({
      actions: [action(), action({ id: 'w1', purpose: 'WBT', started_at: ago(-120), carbs_g: 10, bolus_units: null }), action({ id: 'x', purpose: 'IGNORED', bolus_units: 9 })],
      awaiting_units: new Map([['w1', 1.2]]),
      wbt: { enabled: true, source: 'MANUAL', remind_at: ago(-120), status: 'SCHEDULED', sent_at: null },
      care: [care()],
    }), now);
    expect(item).toMatchObject({ meal_id: 'm1', title: null, carbs_g: 45, insulin_total_u: 5.7, source: 'BOLUS_SCREEN', conversation_id: null, has_macros: false });
    expect(item.reminders.map((reminder) => [reminder.id, reminder.kind, reminder.trigger, reminder.status])).toEqual([
      ['r1', 'SECOND_DOSE', 'AFTER_MINUTES', 'WAITING'],
      ['wbt', 'WBT', 'AFTER_MINUTES', 'GIVEN'],
    ]);
  });

  it('a chat meal: its description, conversation and macros; an AUTO WBT reminder switched off is none', () => {
    const item = buildJournalItem(facts({
      description: '  Pizza  ', protein_g: 20, fat_g: 25,
      origin: { first_command_source: 'CHAT_CARD', conversation_id: 'conv-1' },
      wbt: { enabled: false, source: 'AUTO', remind_at: ago(-120), status: 'SCHEDULED', sent_at: null },
    }), now);
    expect(item).toMatchObject({ title: 'Pizza', source: 'CHAT', conversation_id: 'conv-1', has_macros: true, reminders: [] });
    expect(buildJournalItem(facts({ origin: { first_command_source: null, conversation_id: null }, actions: [] }), now)).toMatchObject({ source: 'OTHER', insulin_total_u: null });
  });

  it('boluses name their kind and who sent them from the app; the time line mixes them with reminders in order', () => {
    const boluses = journalBoluses(
      [action(), action({ id: 'w1', purpose: 'WBT', started_at: ago(5), carbs_g: 10, bolus_units: 1.2, assigned_by: 'Ewa' })],
      new Map(),
      new Map([['a1', 'Piotr']]),
    );
    expect(boluses).toEqual([
      { at: ago(30), insulin_u: 4.5, carbs_g: 45, kind: 'MEAL', source: 'GLUCOMIND', author_name: 'Piotr' },
      { at: ago(5), insulin_u: 1.2, carbs_g: 10, kind: 'WBT', source: 'LOOP', author_name: 'Ewa' },
    ]);
    const reminder = buildJournalItem(facts({ care: [care({ status: 'FIRED', fired_at: ago(10) })] }), now).reminders[0];
    expect(journalTimeline(boluses, [reminder]).map((event) => event.type)).toEqual(['BOLUS', 'REMINDER', 'BOLUS']);
  });

  it('the chart also shows boluses on no meal, but not the meal\'s own, other meals\' or carbs alone', () => {
    const other = chartOtherBoluses(
      [
        { ...action({ id: 'x2', purpose: null, started_at: ago(10), carbs_g: null, bolus_units: 1 }), meal_record_id: null },
        { ...action({ id: 'x1', purpose: 'CORRECTION', started_at: ago(20), carbs_g: null, bolus_units: 0.8 }), meal_record_id: null },
        { ...action({ id: 'a1' }), meal_record_id: null },
        { ...action({ id: 'm2', bolus_units: 2 }), meal_record_id: 'm2' },
        { ...action({ id: 'c1', purpose: null, bolus_units: null, carbs_g: 15 }), meal_record_id: null },
      ],
      new Set(['a1']),
      new Map([['x1', 'Ewa']]),
    );
    expect(other).toEqual([
      { at: ago(20), insulin_u: 0.8, carbs_g: null, kind: 'OTHER', source: 'GLUCOMIND', author_name: 'Ewa' },
      { at: ago(10), insulin_u: 1, carbs_g: null, kind: 'OTHER', source: 'LOOP', author_name: null },
    ]);
  });
});

describe('journal queries', () => {
  it('limits pages to 1-50 and searches 1-100 characters taken literally', () => {
    expect(clampJournalLimit(undefined)).toBe(20);
    expect(clampJournalLimit('500')).toBe(50);
    expect(clampJournalLimit('0')).toBe(1);
    expect(clampJournalLimit('abc')).toBe(20);
    expect(parseMealSearchQuery('  naleśniki  z serem ')).toBe('naleśniki z serem');
    expect(parseMealSearchQuery('   ')).toBeNull();
    expect(parseMealSearchQuery('x'.repeat(101))).toBeNull();
    expect(likePattern('50%_a\\')).toBe('%50\\%\\_a\\\\%');
  });
});
