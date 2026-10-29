import { describe, expect, it } from 'vitest';
import { ValidationError } from '@shared/errors/app-error';
import { RemoteCommandsService, type RemoteCommandRequest } from './application/remote-commands.service';
import type { NewRemoteCommand, RemoteCommandRecord, RemoteCommandStore } from './application/remote-command-record';
import {
  currentGlucose,
  glucoseRisingForSecondDose,
  parseBolusReminders,
  planBolusTabReminders,
  givenSinceMeal,
  doseAnsweringReminder,
  doseFitsReminder,
  doseGivenPushContent,
  secondDosePushContent,
  secondDoseReadiness,
  secondDoseTitle,
  trendArrow,
} from './application/bolus-reminders';
import { WBT_REMINDER_BODY_WITHOUT_MACROS, wbtReminderBodyFor } from '@modules/meal-wbt/application/wbt-policy';

const TZ = 'Europe/Warsaw';
const now = new Date('2026-10-25T16:30:00.000Z');
const minutesAgo = (minutes: number) => new Date(now.getTime() - minutes * 60_000).toISOString();

describe('the reminders field of a Bolus tab command', () => {
  it('accepts the three kinds, one WBT and one second dose', () => {
    expect(parseBolusReminders([{ kind: 'WBT' }, { kind: 'SECOND_DOSE', trigger: 'AFTER_MINUTES', minutes: 30 }])).toEqual([
      { kind: 'WBT' },
      { kind: 'SECOND_DOSE', trigger: 'AFTER_MINUTES', minutes: 30 },
    ]);
    expect(parseBolusReminders([{ kind: 'SECOND_DOSE', trigger: 'GLUCOSE_RISING' }])).toEqual([{ kind: 'SECOND_DOSE', trigger: 'GLUCOSE_RISING' }]);
    expect(parseBolusReminders(undefined)).toBeNull();
    expect(parseBolusReminders([])).toBeNull();
  });

  it('refuses anything else', () => {
    for (const bad of [
      { kind: 'WBT' },
      [{ kind: 'WBT' }, { kind: 'WBT' }],
      [{ kind: 'SECOND_DOSE', trigger: 'GLUCOSE_RISING' }, { kind: 'SECOND_DOSE', trigger: 'AFTER_MINUTES', minutes: 15 }],
      [{ kind: 'SECOND_DOSE', trigger: 'AFTER_MINUTES', minutes: 4 }],
      [{ kind: 'SECOND_DOSE', trigger: 'AFTER_MINUTES', minutes: 241 }],
      [{ kind: 'SECOND_DOSE', trigger: 'AFTER_MINUTES', minutes: 12.5 }],
      [{ kind: 'SECOND_DOSE', trigger: 'GLUCOSE_ABOVE' }],
      [{ kind: 'SECOND_DOSE' }],
      ['WBT'],
    ]) {
      expect(() => parseBolusReminders(bad), JSON.stringify(bad)).toThrow(ValidationError);
    }
  });
});

describe('planning a Bolus tab meal\'s reminders', () => {
  const base = { carbs_g: 45, insulin_u: 4.5, entry_at: '2026-10-25T16:05:00.000Z', set_at: '2026-10-25T16:04:30.000Z', now, time_zone: TZ };

  it('names the second dose by carbs, insulin and the entry time', () => {
    expect(secondDoseTitle(45, 4.5, '2026-10-25T16:05:00.000Z', TZ)).toBe('Druga dawka · 45 g · 4,5 j o 17:05');
    expect(secondDoseTitle(30, 3, '2026-10-25T16:05:00.000Z', TZ)).toBe('Druga dawka · 30 g · 3 j o 17:05');
  });

  it('times WBT at +150 min and a second dose after minutes from the loop entry', () => {
    const plan = planBolusTabReminders({ ...base, reminders: [{ kind: 'WBT' }, { kind: 'SECOND_DOSE', trigger: 'AFTER_MINUTES', minutes: 30 }] });
    expect(plan.wbt_remind_at).toBe('2026-10-25T18:35:00.000Z');
    expect(plan.second_dose).toEqual({ note: 'Druga dawka · 45 g · 4,5 j o 17:05', trigger: 'AT_TIME', due_at: '2026-10-25T16:35:00.000Z', wait_until: null });
  });

  it('watches rising glucose from now until an hour after it was set', () => {
    const plan = planBolusTabReminders({ ...base, reminders: [{ kind: 'SECOND_DOSE', trigger: 'GLUCOSE_RISING' }] });
    expect(plan.wbt_remind_at).toBeNull();
    expect(plan.second_dose).toMatchObject({ trigger: 'GLUCOSE_RISING', due_at: now.toISOString(), wait_until: '2026-10-25T17:04:30.000Z' });
  });
});

describe('rising glucose for a second dose', () => {
  const readings = (values: Array<[number, number]>) => values.map(([ago, value]) => ({ at: minutesAgo(ago), value }));

  it('needs three readings over 10 minutes, each higher, by 3 mg/dL in all', () => {
    expect(glucoseRisingForSecondDose(readings([[10, 120], [5, 122], [0, 124]]), now)).toBe(true);
    // Only +2 in all.
    expect(glucoseRisingForSecondDose(readings([[10, 120], [5, 121], [0, 122]]), now)).toBe(false);
    // Not each higher.
    expect(glucoseRisingForSecondDose(readings([[10, 120], [5, 126], [0, 125]]), now)).toBe(false);
    // Only two readings.
    expect(glucoseRisingForSecondDose(readings([[5, 120], [0, 130]]), now)).toBe(false);
    // The newest is not fresh.
    expect(glucoseRisingForSecondDose(readings([[30, 120], [25, 122], [20, 124]]), now)).toBe(false);
  });

  it('reads a 1-minute CGM like a 5-minute one', () => {
    const everyMinute = Array.from({ length: 11 }, (_, index) => [10 - index, 120 + index * 0.5] as [number, number]);
    expect(glucoseRisingForSecondDose(readings(everyMinute), now)).toBe(true);
  });

  it('fires when rising, waits, then lapses quietly after its watching time', () => {
    const reminder = { trigger: 'GLUCOSE_RISING', due_at: minutesAgo(20), wait_until: minutesAgo(-40) };
    expect(secondDoseReadiness({ now, reminder, readings: readings([[10, 120], [5, 122], [0, 124]]) })).toEqual({ state: 'READY' });
    expect(secondDoseReadiness({ now, reminder, readings: readings([[10, 124], [5, 122], [0, 120]]) })).toEqual({ state: 'WAIT' });
    expect(secondDoseReadiness({ now, reminder: { ...reminder, wait_until: minutesAgo(1) }, readings: [] })).toEqual({ state: 'EXPIRED' });
  });

  it('a timed second dose comes at its time', () => {
    expect(secondDoseReadiness({ now, reminder: { trigger: 'AT_TIME', due_at: minutesAgo(-1), wait_until: null }, readings: [] })).toEqual({ state: 'WAIT' });
    expect(secondDoseReadiness({ now, reminder: { trigger: 'AT_TIME', due_at: minutesAgo(0), wait_until: null }, readings: [] })).toEqual({ state: 'READY' });
    // Not sent in time (the worker was down, the loop's entry came late): it lapses rather than coming hours late.
    expect(secondDoseReadiness({ now, reminder: { trigger: 'AT_TIME', due_at: minutesAgo(29), wait_until: null }, readings: [] })).toEqual({ state: 'READY' });
    expect(secondDoseReadiness({ now, reminder: { trigger: 'AT_TIME', due_at: minutesAgo(31), wait_until: null }, readings: [] })).toEqual({ state: 'EXPIRED' });
  });
});

describe('the second dose push', () => {
  it('says it is time, with the current glucose and its arrow', () => {
    const glucose = currentGlucose([{ at: minutesAgo(5), value: 140, direction: null }, { at: minutesAgo(0), value: 141, direction: 'Flat' }], now);
    expect(secondDosePushContent('Druga dawka · 45 g · 4,5 j o 18:05', glucose)).toEqual({
      title: 'Druga dawka · 45 g · 4,5 j o 18:05',
      body: 'Glukoza 141 →. Dotknij, aby podać.',
    });
  });

  it('takes the arrow from the 5-minute change without a direction, and leaves glucose out without a fresh reading', () => {
    expect(currentGlucose([{ at: minutesAgo(5), value: 130 }, { at: minutesAgo(0), value: 142 }], now)).toEqual({ value: 142, arrow: '↑' });
    expect(currentGlucose([{ at: minutesAgo(20), value: 130 }], now)).toBeNull();
    expect(secondDosePushContent('Druga dawka', null).body).toBe('Dotknij, aby podać.');
    expect(trendArrow('FortyFiveDown', null)).toBe('↘');
    expect(trendArrow(null, 6)).toBe('↗');
  });
});

describe('the WBT push of a meal without macros', () => {
  it('asks to describe it or give the dose by hand; meals with macros keep today\'s text', () => {
    expect(wbtReminderBodyFor({ description: null, started_at: '2026-10-25T16:05:00.000Z', protein_g: null, fat_g: null }, TZ)).toBe(WBT_REMINDER_BODY_WITHOUT_MACROS);
    expect(WBT_REMINDER_BODY_WITHOUT_MACROS).toBe('Opisz posiłek, a policzę dawkę, albo podaj ją sam.');
    expect(wbtReminderBodyFor({ description: 'Pizza', started_at: '2026-10-25T16:05:00.000Z', protein_g: 20, fat_g: 25 }, TZ)).toBe('Pizza\nKliknij, aby ustalić dawkę insuliny');
  });
});

describe('authorizing a Bolus tab command with reminders', () => {
  class Store {
    rows: RemoteCommandRecord[] = [];
    async insert(command: NewRemoteCommand): Promise<RemoteCommandRecord> {
      const record = { ...command, id: `c${this.rows.length + 1}`, status: 'AUTHORIZED', trio_message: null, status_message: null, authorized_at: now.toISOString(), sent_at: null, answered_at: null, loop_action_id: null, meal_record_id: null, matched_at: null } as RemoteCommandRecord;
      this.rows.push(record);
      return record;
    }
    async get() { return null; }
    async list() { return this.rows; }
    async findInFlight() { return null; }
    async transition() { return null; }
    async recordSentAt() {}
    async findRecentWithInsulin() { return null; }
    async listForProposal() { return []; }
    async listForPlannedBolus() { return []; }
    async listWbtForMeal() { return []; }
  }
  const context = async () => ({
    now: now.toISOString(),
    glucose: { value: 140, observed_at: minutesAgo(2), delta: 1 },
    lowest_recent_glucose: 130,
    loop: { iob_units: 0, cob_grams: 0, observed_at: minutesAgo(3) },
    last_bolus: null,
    icr_g_per_u: 10,
    bolus_history_known: true,
  });
  const request = (overrides: Partial<RemoteCommandRequest> = {}): RemoteCommandRequest => ({
    source: 'BOLUS_SCREEN', carbs_g: 45, insulin_u: 4.5, bolus_step: 0.05, device_id: 'd1', acknowledged_warnings: [], ...overrides,
  });

  it('stores them and returns them with the command', async () => {
    const store = new Store();
    const service = new RemoteCommandsService(store as unknown as RemoteCommandStore, context as never);
    const reminders = [{ kind: 'WBT' as const }, { kind: 'SECOND_DOSE' as const, trigger: 'GLUCOSE_RISING' as const }];
    const view = await service.authorize('p1', 'u1', request({ reminders }), now);
    expect(store.rows[0].reminders).toEqual(reminders);
    expect(view.reminders).toEqual(reminders);
    const plain = await new RemoteCommandsService(new Store() as unknown as RemoteCommandStore, context as never).authorize('p1', 'u1', request(), now);
    expect(plain.reminders).toBeNull();
  });

  it('refuses them from any other source and without carbs', async () => {
    const service = new RemoteCommandsService(new Store() as unknown as RemoteCommandStore, context as never);
    await expect(service.authorize('p1', 'u1', request({ source: 'NEW_MEAL', reminders: [{ kind: 'WBT' }] }), now)).rejects.toThrow('Only BOLUS_SCREEN commands set reminders');
    await expect(service.authorize('p1', 'u1', request({ carbs_g: 0, reminders: [{ kind: 'WBT' }] }), now)).rejects.toThrow(ValidationError);
  });
});

describe('insulin given since the meal (bolus-reminders.v1)', () => {
  const start = '2026-10-25T17:05:00.000Z'; // 18:05 in Warsaw
  const now = new Date('2026-10-25T17:35:00.000Z');
  const base = { mealStartedAt: start, now, timeZone: 'Europe/Warsaw', loopName: 'Trio' };

  it('says no caregiver gave it when only the meal\'s own bolus is there, only to several caregivers', () => {
    const own = { actions: [{ id: 'own', started_at: '2026-10-25T17:05:30.000Z', bolus_units: 4.5 }], senders: new Map([['own', 'Piotr']]) };
    const given = givenSinceMeal({ ...base, ...own, caregiverCount: 2 });
    expect(given.doses).toEqual([]);
    expect(given.line).toBe('Żaden z opiekunów nie podał jeszcze tej dawki.');
    expect(secondDosePushContent('Druga dawka · 45 g · 4,5 j o 18:05', { value: 141, arrow: '→' }, given).body)
      .toBe('Glukoza 141 →. Żaden z opiekunów nie podał jeszcze tej dawki. Dotknij, aby podać.');
    const alone = givenSinceMeal({ ...base, ...own, caregiverCount: 1 });
    expect(alone.line).toBe('');
    expect(secondDosePushContent('Druga dawka', { value: 141, arrow: '→' }, alone).body).toBe('Glukoza 141 →. Dotknij, aby podać.');
  });

  it('finds the caregiver\'s dose that answered a reminder and says it to the others', () => {
    const fired = '2026-10-25T17:35:00.000Z';
    const doses = [
      { at: '2026-10-25T17:30:00.000Z', insulin_u: 1, user_id: 'u1', name: 'Piotr' },
      { at: '2026-10-25T17:50:00.000Z', insulin_u: 1.5, user_id: 'u2', name: 'Ewa' },
      { at: '2026-10-25T18:10:00.000Z', insulin_u: 0.5, user_id: 'u1', name: 'Piotr' },
    ];
    const later = new Date('2026-10-25T18:20:00.000Z');
    expect(doseAnsweringReminder({ kind: 'SECOND_DOSE', mealRecordId: 'meal-1', firedAt: fired, until: null, now: later, doses })).toEqual(doses[1]);
    // Before the reminder came, after the meal's WBT reminder came, or too late: not the dose it asked for.
    expect(doseAnsweringReminder({ kind: 'SECOND_DOSE', mealRecordId: 'meal-1', firedAt: fired, until: '2026-10-25T17:45:00.000Z', now: later, doses })).toBeNull();
    expect(doseAnsweringReminder({ kind: 'SECOND_DOSE', mealRecordId: 'meal-1', firedAt: fired, until: null, now: new Date('2026-10-25T21:00:00.000Z'), doses: [{ ...doses[0], at: '2026-10-25T20:40:00.000Z' }] })).toBeNull();
    // Another meal's bolus (carbs) or WBT, a meal's own bolus: not a second dose; WBT only for its meal.
    const meal = { ...doses[1], purpose: 'NEW_MEAL', meal_record_id: 'meal-2', carbs_g: 40 };
    expect(doseAnsweringReminder({ kind: 'SECOND_DOSE', mealRecordId: 'meal-1', firedAt: fired, until: null, now: later, doses: [meal] })).toBeNull();
    expect(doseFitsReminder('SECOND_DOSE', 'meal-1', { ...doses[1], purpose: 'CORRECTION', meal_record_id: 'meal-1' })).toBe(true);
    expect(doseFitsReminder('SECOND_DOSE', 'meal-1', { ...doses[1], purpose: 'WBT', meal_record_id: 'meal-1' })).toBe(false);
    expect(doseFitsReminder('WBT', 'meal-1', { ...doses[1], purpose: 'WBT', meal_record_id: 'meal-1' })).toBe(true);
    expect(doseFitsReminder('WBT', 'meal-1', { ...doses[1], purpose: 'WBT', meal_record_id: 'meal-2' })).toBe(false);
    expect(doseFitsReminder('WBT', 'meal-1', { ...doses[1], carbs_g: 10 })).toBe(false);
    expect(doseGivenPushContent({ kind: 'SECOND_DOSE', dose: doses[1], mealStartedAt: start, timeZone: 'Europe/Warsaw' }))
      .toEqual({ title: 'Druga dawka podana', body: 'Opiekun Ewa podał drugą dawkę (1,5 j) na posiłek o 18:05' });
    expect(doseGivenPushContent({ kind: 'WBT', dose: { ...doses[1], name: null }, mealStartedAt: start, timeZone: 'Europe/Warsaw' }))
      .toEqual({ title: 'WBT podane', body: 'Inny opiekun podał 1,5 j na WBT po posiłku o 18:05' });
  });

  it('warns about a dose the other caregiver gave, and one entered in Trio', () => {
    const one = givenSinceMeal({ ...base, actions: [{ id: 'ewa', started_at: '2026-10-25T17:20:00.000Z', bolus_units: 1.2 }], senders: new Map([['ewa', 'Ewa']]) });
    expect(one.line).toBe('⚠️ Od 18:05 podano już 1,2 j (18:20, Ewa).');
    expect(secondDosePushContent('Druga dawka', null, one).body).toBe('⚠️ Od 18:05 podano już 1,2 j (18:20, Ewa). Sprawdź, zanim podasz.');

    const two = givenSinceMeal({
      ...base,
      actions: [
        { id: 'trio', started_at: '2026-10-25T17:30:00.000Z', bolus_units: 0.5 },
        { id: 'ewa', started_at: '2026-10-25T17:20:00.000Z', bolus_units: 1.2 },
        { id: 'carbs-only', started_at: '2026-10-25T17:25:00.000Z', bolus_units: null },
        { id: 'later', started_at: '2026-10-25T18:00:00.000Z', bolus_units: 1 },
      ],
      senders: new Map([['ewa', 'Ewa']]),
    });
    expect(two.total_u).toBe(1.7);
    expect(two.line).toBe('⚠️ Od 18:05 podano już 1,7 j (18:20 1,2 j Ewa, 18:30 0,5 j Trio).');
    // A dose entered in Loop is named after Loop.
    expect(givenSinceMeal({ ...base, actions: [{ id: 'x', started_at: '2026-10-25T17:30:00.000Z', bolus_units: 0.5 }], senders: new Map(), loopName: 'Loop' }).line)
      .toBe('⚠️ Od 18:05 podano już 0,5 j (18:30, Loop).');
  });

  it('puts the warning above the WBT push text only when insulin was given', () => {
    const meal = { description: null, started_at: start, protein_g: null, fat_g: null };
    expect(wbtReminderBodyFor(meal, 'Europe/Warsaw')).toBe('Opisz posiłek, a policzę dawkę, albo podaj ją sam.');
    expect(wbtReminderBodyFor(meal, 'Europe/Warsaw', '⚠️ Od 18:05 podano już 1,2 j (18:20, Ewa).'))
      .toBe('⚠️ Od 18:05 podano już 1,2 j (18:20, Ewa).\nOpisz posiłek, a policzę dawkę, albo podaj ją sam.');
  });
});

describe('insulin given since the meal: window and length', () => {
  it('counts only the meal\'s own 6 hours and names at most three doses', () => {
    const start = '2026-10-25T10:00:00.000Z';
    const at = (minutes: number) => new Date(Date.parse(start) + minutes * 60_000).toISOString();
    const given = givenSinceMeal({
      mealStartedAt: start,
      now: new Date('2026-10-27T10:00:00.000Z'),
      timeZone: 'UTC',
      actions: [10, 20, 30, 40, 7 * 60].map((minutes, index) => ({ id: `a${index}`, started_at: at(minutes), bolus_units: 1 })),
      senders: new Map(),
      loopName: 'Trio',
    });
    expect(given.doses).toHaveLength(4);
    expect(given.line).toBe('⚠️ Od 10:00 podano już 4 j (10:10 1 j Trio, 10:20 1 j Trio, 10:30 1 j Trio i 1 inna).');
  });
});
