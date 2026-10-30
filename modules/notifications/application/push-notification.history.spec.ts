import { describe, expect, it, vi } from 'vitest';
import { PushNotificationService } from './push-notification.service';
import { FakePushNotificationProvider } from '@modules/notifications/infrastructure/fake-push-notification-provider';

const PATIENT = '11111111-1111-4111-8111-111111111111';
const CONVERSATION = '22222222-2222-4222-8222-222222222222';
const MEAL = '33333333-3333-4333-8333-333333333333';

describe('PushNotificationService bell history', () => {
  it('records each sent notification with one dedupe key for all devices of the patient', async () => {
    const record = vi.fn().mockResolvedValue(undefined);
    const service = new PushNotificationService(new FakePushNotificationProvider(), { record });

    for (const pushToken of ['token-1', 'token-2']) {
      await service.sendConversationQuestion({ patientId: PATIENT, pushToken, conversationId: CONVERSATION, questionId: 'activity_before_drop', title: 'Hipo o 10:00', body: 'Czy był ruch przed spadkiem?' });
    }
    await service.sendWbtReminder({ patientId: PATIENT, pushToken: 'token-1', mealId: MEAL, body: 'Pizza o 18:00' });

    expect(record.mock.calls.map(([entry]) => entry.dedupeKey)).toEqual([
      `conversation-question:${PATIENT}:${CONVERSATION}:activity_before_drop`,
      `conversation-question:${PATIENT}:${CONVERSATION}:activity_before_drop`,
      `wbt-reminder:${MEAL}`,
    ]);
    expect(record.mock.calls[0][0]).toMatchObject({
      patientId: PATIENT,
      type: 'conversation_question',
      title: 'Hipo o 10:00',
      body: 'Czy był ruch przed spadkiem?',
      payload: { type: 'conversation_question', conversationId: CONVERSATION, questionId: 'activity_before_drop' },
    });
    expect(record.mock.calls[2][0]).toMatchObject({ type: 'wbt_reminder', title: 'Przypomnienie o WBT', payload: { mealId: MEAL } });
  });

  it('still sends the push when the history write fails, and keeps the bell entry when the send fails', async () => {
    const provider = new FakePushNotificationProvider();
    const failingHistory = { record: vi.fn().mockRejectedValue(new Error('db down')) };
    await expect(
      new PushNotificationService(provider, failingHistory).sendWbtReminder({ patientId: PATIENT, pushToken: 't', mealId: MEAL, body: 'b' }),
    ).resolves.toBeUndefined();
    expect(provider.sent).toHaveLength(1);

    const record = vi.fn();
    const rejecting = { send: vi.fn().mockRejectedValue(new Error('APNs down')) };
    await expect(
      new PushNotificationService(rejecting, { record }).sendWbtReminder({ patientId: PATIENT, pushToken: 't', mealId: MEAL, body: 'b' }),
    ).rejects.toThrow('APNs down');
    // Audit 2026-10-26: a push APNs refused is still in the bell.
    expect(record).toHaveBeenCalledTimes(1);
  });
  it('starts the title with the patient\'s name only on a phone with several patients; the bell keeps the plain title', async () => {
    const sent: Array<{ pushToken: string; title: string }> = [];
    const provider = { send: vi.fn(async (envelope: { pushToken: string; title: string }) => { sent.push({ pushToken: envelope.pushToken, title: envelope.title }); }) };
    const record = vi.fn().mockResolvedValue(undefined);
    const labels = { labelFor: vi.fn(async (pushToken: string) => (pushToken === 'two-patients' ? 'Janek' : null)) };
    const service = new PushNotificationService(provider as any, { record }, labels);

    for (const pushToken of ['one-patient', 'two-patients']) {
      await service.sendRescueCarbAlert({ patientId: PATIENT, pushToken, conversationId: CONVERSATION, alertId: 'alert-1', title: 'Możliwe niedocukrzenie', body: 'Ok. 12:25 może spaść poniżej 70 · proponuję 4 g', reminder: false });
    }

    expect(sent).toEqual([
      { pushToken: 'one-patient', title: 'Możliwe niedocukrzenie' },
      { pushToken: 'two-patients', title: 'Janek · Możliwe niedocukrzenie' },
    ]);
    expect(labels.labelFor).toHaveBeenCalledWith('two-patients', PATIENT);
    expect(record.mock.calls.map(([entry]) => entry.title)).toEqual(['Możliwe niedocukrzenie', 'Możliwe niedocukrzenie']);

    // A failed lookup sends the plain title.
    labels.labelFor.mockRejectedValueOnce(new Error('db down'));
    await service.sendWbtReminder({ patientId: PATIENT, pushToken: 'two-patients', mealId: MEAL, body: 'Pizza o 18:00' });
    expect(sent.at(-1)?.title).toBe('Przypomnienie o WBT');
  });

  it('records a queued reminder in the bell without sending it', async () => {
    const provider = new FakePushNotificationProvider();
    const record = vi.fn().mockResolvedValue(undefined);
    await new PushNotificationService(provider, { record }).recordQueuedReminder({ kind: 'planned_bolus', input: { patientId: PATIENT, mealId: MEAL, plannedBolusId: 'b1', title: 'Druga część bolusa', body: 'Pizza: 30 g' } });
    expect(provider.sent).toHaveLength(0);
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ dedupeKey: 'planned-bolus:b1', type: 'planned_bolus', title: 'Druga część bolusa' }));
  });

  it('sends a remote settings hand-off push that opens the patient and stays out of the bell', async () => {
    const record = vi.fn().mockResolvedValue(undefined);
    const provider = new FakePushNotificationProvider();
    await new PushNotificationService(provider, { record }).sendRemoteSettingsHandoff({ patientId: PATIENT, pushToken: 't', handoffId: 'h1', title: 'Przekazane ustawienia', body: 'Tomek przekazał Ci ustawienia Trio dla: Zosia' });
    expect(record).not.toHaveBeenCalled();
    expect(provider.sent).toEqual([expect.objectContaining({
      title: 'Przekazane ustawienia',
      body: 'Tomek przekazał Ci ustawienia Trio dla: Zosia',
      collapseId: 'handoff-h1',
      payload: { type: 'remote_settings_handoff', patientId: PATIENT, handoffId: 'h1', routePath: `/patients/${PATIENT}`, universalLink: `https://app.mellis.invalid/patients/${PATIENT}` },
    })]);
  });
});

