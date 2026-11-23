import { describe, expect, it, vi } from 'vitest';
import { PushNotificationService } from './push-notification.service';
import { FakePushNotificationProvider } from '@modules/notifications/infrastructure/fake-push-notification-provider';
import type { QuietHoursSettings } from './quiet-hours';

const PATIENT = '11111111-1111-4111-8111-111111111111';
const MEAL = '33333333-3333-4333-8333-333333333333';
const night: QuietHoursSettings = { enabled: true, start_minute: 22 * 60, end_minute: 7 * 60, time_zone: 'Europe/Warsaw', low_warnings: true };
const at2am = () => new Date('2026-11-22T02:00:00+01:00');

function setup(settings: QuietHoursSettings | null, clock = at2am, lookupFails = false, holdFails = false) {
  const provider = new FakePushNotificationProvider();
  const record = vi.fn().mockResolvedValue(undefined);
  const events = vi.fn();
  const hold = vi.fn(async () => { if (holdFails) throw new Error('db down'); });
  const lookup = { forPushToken: vi.fn(async (token: string) => { if (lookupFails) throw new Error('db down'); return token === 'quiet' ? settings : null; }), hold };
  const service = new PushNotificationService(provider, { record }, null, lookup, events, clock);
  return { provider, record, events, hold, service };
}

describe('PushNotificationService quiet hours (quiet-hours.v1)', () => {
  it('keeps a glucose push off a phone in quiet hours and sends it to a phone without them', async () => {
    const { provider, events, service } = setup(night);
    await service.sendGlucoseAlert({ patientId: PATIENT, pushToken: 'quiet', kind: 'high', title: '⚠️ 190 (+6)', body: 'Glukoza powyżej 180 i rośnie.' });
    await service.sendGlucoseAlert({ patientId: PATIENT, pushToken: 'awake', kind: 'high', title: '⚠️ 190 (+6)', body: 'Glukoza powyżej 180 i rośnie.' });
    expect(provider.sent.map((push) => push.pushToken)).toEqual(['awake']);
    expect(events).toHaveBeenCalledWith({ decision: 'drop', type: 'glucose_alert', kind: 'high', patientId: PATIENT });
  });

  it('lets below 54 for 20 minutes through, time-sensitive', async () => {
    const { provider, service } = setup({ ...night, low_warnings: false });
    await service.sendGlucoseAlert({ patientId: PATIENT, pushToken: 'quiet', kind: 'very_low', title: '❗ 48 (−2)', body: 'Glukoza poniżej 54 i spada.' });
    await service.sendGlucoseAlert({ patientId: PATIENT, pushToken: 'quiet', kind: 'very_low', title: '❗ 47 (−1)', body: 'Glukoza poniżej 54 i spada.', quiet: { urgentLowSustained: true } });
    expect(provider.sent).toHaveLength(1);
    expect(provider.sent[0]).toMatchObject({ title: '❗ 47 (−1)', interruptionLevel: 'time-sensitive' });
  });

  it('sends the carbs proposal time-sensitive with the low warnings on, and keeps it off with them off', async () => {
    const rescue = { patientId: PATIENT, pushToken: 'quiet', conversationId: 'c', alertId: 'a', title: 'Możliwe niedocukrzenie', body: 'b', reminder: false };
    const on = setup(night);
    await on.service.sendRescueCarbAlert(rescue);
    expect(on.provider.sent[0]).toMatchObject({ interruptionLevel: 'time-sensitive' });
    const off = setup({ ...night, low_warnings: false });
    await off.service.sendRescueCarbAlert(rescue);
    expect(off.provider.sent).toHaveLength(0);
  });

  it('keeps the bell entry of a push it keeps off the phone', async () => {
    const { provider, record, service } = setup(night);
    await service.sendDoseGiven({ patientId: PATIENT, pushToken: 'quiet', mealId: MEAL, reminderKey: 'k', title: 'Druga dawka podana', body: 'Opiekun Ewa podał drugą dawkę' });
    expect(provider.sent).toHaveLength(0);
    expect(record).toHaveBeenCalledTimes(1);
  });

  it('sends as before outside quiet hours, for pushes it does not touch, and when the lookup fails', async () => {
    const noon = setup(night, () => new Date('2026-11-22T12:00:00+01:00'));
    await noon.service.sendGlucoseAlert({ patientId: PATIENT, pushToken: 'quiet', kind: 'high', title: 't', body: 'b' });
    expect(noon.provider.sent).toHaveLength(1);
    expect(noon.provider.sent[0]!.interruptionLevel).toBeUndefined();
    const wbt = setup(night);
    await wbt.service.sendWbtReminder({ patientId: PATIENT, pushToken: 'quiet', mealId: MEAL, body: 'Pizza o 18:00' });
    expect(wbt.provider.sent).toHaveLength(1);
    const failing = setup(night, at2am, true);
    await failing.service.sendGlucoseAlert({ patientId: PATIENT, pushToken: 'quiet', kind: 'high', title: 't', body: 'b' });
    expect(failing.provider.sent).toHaveLength(1);
  });

  it('holds equipment until the end of quiet hours, one item per kind, and sends it when it cannot hold', async () => {
    const { provider, hold, record, service } = setup(night);
    await service.sendReservoirAlert({ patientId: PATIENT, pushToken: 'quiet', level: 'alarm', notifiedAt: '2026-11-22T01:00:00.000Z', title: 'Wymień zbiornik insuliny', body: 'Zostało 8 j' });
    expect(provider.sent).toHaveLength(0);
    expect(record).toHaveBeenCalledTimes(1);
    expect(hold).toHaveBeenCalledWith(expect.objectContaining({ pushToken: 'quiet', patientId: PATIENT, itemKey: 'reservoir_low', type: 'reservoir_low', releaseAfter: new Date('2026-11-22T06:00:00.000Z') }));
    const failing = setup(night, at2am, false, true);
    await failing.service.sendReservoirAlert({ patientId: PATIENT, pushToken: 'quiet', level: 'alarm', notifiedAt: 'x', title: 't', body: 'b' });
    expect(failing.provider.sent).toHaveLength(1);
  });

  it('delivers a held push straight to the phone, past quiet hours', async () => {
    const { provider, service } = setup(night);
    await service.deliverQuietHoursPush({ platform: 'ios', pushToken: 'quiet', title: 'Po godzinach ciszy', body: 'b', payload: { type: 'reservoir_low', patientId: PATIENT, level: 'alarm', routePath: '/', universalLink: 'u' } as never });
    expect(provider.sent).toHaveLength(1);
  });
});
