import { describe, expect, it } from 'vitest';
import { careReminderPushContent, careReminderReadiness, CareReminderSession, describeReminder, localToUtc, parseReminderRequest, type CareReminderRecord, type NewCareReminder } from './application/care-reminders';

const now = new Date('2026-10-22T10:00:00.000Z'); // 12:00 in Warsaw
const zone = 'Europe/Warsaw';

describe('reminders the chat sets (care-reminders.v1)', () => {
  it('reads a time from now or a local time, and a glucose condition waited for 3 h unless said otherwise', () => {
    expect(parseReminderRequest({ note: 'Sprawdź glukozę po basenie', trigger: 'AT_TIME', in_minutes: 120, at_local: null, threshold_mgdl: null, wait_minutes: null }, now, zone))
      .toEqual({ note: 'Sprawdź glukozę po basenie', trigger: 'AT_TIME', due_at: '2026-10-22T12:00:00.000Z', threshold_mgdl: null, wait_until: null });
    expect(parseReminderRequest({ note: 'Zmiana wkłucia', trigger: 'AT_TIME', in_minutes: null, at_local: '2026-10-23T07:00', threshold_mgdl: null, wait_minutes: null }, now, zone))
      .toMatchObject({ due_at: '2026-10-23T05:00:00.000Z' });
    expect(parseReminderRequest({ note: 'Bolus na resztę obiadu', trigger: 'GLUCOSE_ABOVE', in_minutes: null, at_local: null, threshold_mgdl: 180, wait_minutes: null }, now, zone))
      .toEqual({ note: 'Bolus na resztę obiadu', trigger: 'GLUCOSE_ABOVE', due_at: now.toISOString(), threshold_mgdl: 180, wait_until: '2026-10-22T13:00:00.000Z' });
  });

  it('refuses only what cannot be a reminder', () => {
    const base = { note: 'x', trigger: 'AT_TIME', in_minutes: null, at_local: null, threshold_mgdl: null, wait_minutes: null };
    expect(parseReminderRequest(base, now, zone)).toMatchObject({ problem: expect.stringContaining('AT_TIME') });
    expect(parseReminderRequest({ ...base, at_local: '2026-10-22T11:00' }, now, zone)).toMatchObject({ problem: expect.stringContaining('past') });
    expect(parseReminderRequest({ ...base, trigger: 'GLUCOSE_BELOW' }, now, zone)).toMatchObject({ problem: expect.stringContaining('threshold_mgdl') });
    expect(parseReminderRequest({ ...base, note: ' ' , in_minutes: 10 }, now, zone)).toMatchObject({ problem: 'note is required' });
  });

  it('comes at its time, or when the glucose condition is met, or anyway once the waiting time is over', () => {
    const readings = (values: number[]) => values.map((value, index) => ({ at: new Date(now.getTime() - (values.length - 1 - index) * 5 * 60_000).toISOString(), value }));
    const reminder = (trigger: CareReminderRecord['trigger'], threshold: number | null = null, waitUntil = '2026-10-22T13:00:00.000Z') => ({ trigger, due_at: '2026-10-22T09:30:00.000Z', threshold_mgdl: threshold, wait_until: trigger === 'AT_TIME' ? null : waitUntil });
    expect(careReminderReadiness({ now, reminder: reminder('AT_TIME'), readings: [], loopStatus: null })).toEqual({ state: 'READY', glucose_mgdl: null });
    expect(careReminderReadiness({ now, reminder: { ...reminder('AT_TIME'), due_at: '2026-10-22T10:30:00.000Z' }, readings: [], loopStatus: null })).toEqual({ state: 'WAIT' });
    expect(careReminderReadiness({ now, reminder: reminder('GLUCOSE_RISING'), readings: readings([90, 90, 91, 92]), loopStatus: null })).toEqual({ state: 'WAIT' });
    expect(careReminderReadiness({ now, reminder: reminder('GLUCOSE_RISING'), readings: readings([90, 95, 101, 108]), loopStatus: null })).toEqual({ state: 'READY', glucose_mgdl: 108 });
    expect(careReminderReadiness({ now, reminder: reminder('GLUCOSE_BELOW', 80), readings: readings([92, 88, 84, 79]), loopStatus: null })).toEqual({ state: 'READY', glucose_mgdl: 79 });
    // A threshold is an alarm: never crossed, it lapses quietly; a rise not seen still reminds.
    expect(careReminderReadiness({ now, reminder: reminder('GLUCOSE_ABOVE', 180, '2026-10-22T09:59:00.000Z'), readings: readings([150, 151, 150, 152]), loopStatus: null })).toEqual({ state: 'EXPIRED' });
    expect(careReminderReadiness({ now, reminder: reminder('GLUCOSE_RISING', null, '2026-10-22T09:59:00.000Z'), readings: readings([90, 90, 91, 92]), loopStatus: null })).toEqual({ state: 'EXPIRED' });
  });

  it('writes the push and the card line in Polish', () => {
    expect(careReminderPushContent({ note: 'Zmiana wkłucia', trigger: 'AT_TIME', threshold_mgdl: null }, { state: 'READY', glucose_mgdl: null })).toEqual({ title: 'Przypomnienie', body: 'Zmiana wkłucia' });
    expect(careReminderPushContent({ note: 'Bolus na resztę obiadu', trigger: 'GLUCOSE_ABOVE', threshold_mgdl: 180 }, { state: 'READY', glucose_mgdl: 184 }).body).toBe('Bolus na resztę obiadu\nGlukoza 184 mg/dL: powyżej 180.');
    expect(careReminderPushContent({ note: 'Bolus', trigger: 'GLUCOSE_RISING', threshold_mgdl: null }, { state: 'FORCED', glucose_mgdl: 88 }).body).toBe('Bolus\nGlukoza 88 mg/dL: nie zaczęła rosnąć (minął czas oczekiwania).');
    expect(describeReminder({ trigger: 'GLUCOSE_RISING', due_at: now.toISOString(), threshold_mgdl: null, wait_until: '2026-10-22T13:00:00.000Z' }, zone)).toBe('gdy glukoza zacznie rosnąć (pilnuję do czw., 15:00)');
  });

  it('turns a local time into UTC across the DST change', () => {
    expect(new Date(localToUtc('2026-10-25T07:00', zone)!).toISOString()).toBe('2026-10-25T06:00:00.000Z');
    expect(new Date(localToUtc('2026-10-24T07:00', zone)!).toISOString()).toBe('2026-10-24T05:00:00.000Z');
    expect(localToUtc('jutro 7:00', zone)).toBeNull();
  });

  it('sets at most 3 reminders per answer, as the asking caregiver', async () => {
    const stored: NewCareReminder[] = [];
    const session = new CareReminderSession({
      patientId: 'p1', conversationId: 'c1', userMessageId: 'm1', authorUserId: 'u1', timeZone: zone, now: () => now,
      store: { insert: async (reminder) => { stored.push(reminder); return { ...reminder, id: `r${stored.length}`, status: 'ACTIVE', fired_at: null, fired_reason: null, fired_glucose_mgdl: null, cancelled_at: null, cancelled_by_user_id: null, created_at: now.toISOString() }; } },
    });
    const args = { note: 'Sprawdź glukozę', trigger: 'AT_TIME', in_minutes: 30, at_local: null, threshold_mgdl: null, wait_minutes: null };
    expect(await session.set(args)).toMatchObject({ status: 'SET', reminder: { note: 'Sprawdź glukozę', due_at: '2026-10-22T10:30:00.000Z', described: 'czw., 12:30' } });
    await session.set(args);
    await session.set(args);
    expect(await session.set(args)).toMatchObject({ status: 'LIMIT_REACHED' });
    expect(stored).toHaveLength(3);
    expect(stored[0]).toMatchObject({ patient_id: 'p1', conversation_id: 'c1', user_message_id: 'm1', created_by_user_id: 'u1' });
  });
});
