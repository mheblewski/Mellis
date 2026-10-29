import { describe, expect, it, vi } from 'vitest';
import { PushNotificationProviderError } from '@modules/notifications/infrastructure/push-notification-provider.error';
import { PushOutbox, pushOutboxRetryDelayMs, type PushOutboxItem, type PushOutboxRequest, type PushOutboxStore } from './push-outbox';

const NOW = new Date('2026-10-26T12:00:00.000Z');
const REQUEST: PushOutboxRequest = { kind: 'planned_bolus', input: { patientId: 'p1', mealId: 'm1', plannedBolusId: 'b1', title: 'Druga część bolusa', body: 'Pizza: 30 g' } };

function memoryStore(): PushOutboxStore & { items: Map<string, PushOutboxItem & { next_attempt_at: string | null; completed: boolean; delivered: Set<string> }> } {
  const items = new Map<string, PushOutboxItem & { next_attempt_at: string | null; completed: boolean; delivered: Set<string> }>();
  return {
    items,
    async enqueue(args) {
      if ([...items.values()].some((item) => item.dedupe_key === args.dedupeKey)) return null;
      const item = { id: `o${items.size + 1}`, dedupe_key: args.dedupeKey, patient_id: args.patientId, request: args.request, exclude_user_id: args.excludeUserId, attempts: 0, expires_at: args.expiresAt, next_attempt_at: null, completed: false, delivered: new Set<string>() };
      items.set(item.id, item);
      return item;
    },
    async listDue(nowIso) {
      return [...items.values()].filter((item) => !item.completed && item.next_attempt_at !== null && item.next_attempt_at <= nowIso);
    },
    async deliveredTokens(id) {
      return new Set(items.get(id)!.delivered);
    },
    async markDelivered(id, token) {
      items.get(id)!.delivered.add(token);
    },
    async finishAttempt(id, args) {
      const item = items.get(id)!;
      item.attempts += 1;
      item.next_attempt_at = args.nextAttemptAt;
      item.completed = args.complete;
    },
  };
}

function setup(devices: Array<{ push_token: string; user_id?: string | null }>, store: PushOutboxStore | null = memoryStore()) {
  const push = {
    sendWbtReminder: vi.fn().mockResolvedValue(undefined),
    sendPlannedBolusReminder: vi.fn().mockResolvedValue(undefined),
    sendCareReminder: vi.fn().mockResolvedValue(undefined),
    sendDoseGiven: vi.fn().mockResolvedValue(undefined),
  };
  // A deactivated token is no longer listed (as in listActivePatientDevices).
  const deactivate = vi.fn(async (token: string) => {
    const index = devices.findIndex((device) => device.push_token === token);
    if (index >= 0) devices.splice(index, 1);
  });
  const list = vi.fn(async () => devices);
  const log = vi.fn();
  const outbox = new PushOutbox({ store, devices: { list, deactivate }, push, log });
  return { outbox, push, deactivate, list, log, store };
}

const transient = () => new PushNotificationProviderError('APNS_NETWORK', 'timeout', true);

describe('PushOutbox (push-outbox.v1)', () => {
  it('sends to every phone at once and needs no retry when all got it', async () => {
    const { outbox, push, store } = setup([{ push_token: 'a' }, { push_token: 'b' }]);
    const result = await outbox.dispatch({ dedupeKey: 'planned-bolus:b1', patientId: 'p1', request: REQUEST, ttlMinutes: 60, now: NOW });
    expect(result).toEqual({ delivered: 2, devices: 2, retrying: false });
    expect(push.sendPlannedBolusReminder).toHaveBeenCalledWith({ ...REQUEST.input, pushToken: 'a' });
    expect([...(store as ReturnType<typeof memoryStore>).items.values()][0].completed).toBe(true);
  });

  it('never queues the same push twice', async () => {
    const { outbox, push } = setup([{ push_token: 'a' }]);
    await outbox.dispatch({ dedupeKey: 'k', patientId: 'p1', request: REQUEST, ttlMinutes: 60, now: NOW });
    expect(await outbox.dispatch({ dedupeKey: 'k', patientId: 'p1', request: REQUEST, ttlMinutes: 60, now: NOW })).toBeNull();
    expect(push.sendPlannedBolusReminder).toHaveBeenCalledTimes(1);
  });

  it('tries again only the phone that failed for a passing reason, until it gets the push', async () => {
    const { outbox, push } = setup([{ push_token: 'a' }, { push_token: 'b' }]);
    push.sendPlannedBolusReminder.mockImplementation(async ({ pushToken }: { pushToken: string }) => {
      if (pushToken === 'b') throw transient();
    });
    expect(await outbox.dispatch({ dedupeKey: 'k', patientId: 'p1', request: REQUEST, ttlMinutes: 60, now: NOW })).toEqual({ delivered: 1, devices: 2, retrying: true });

    // Not due yet: nothing is sent.
    await outbox.retryDue(new Date(NOW.getTime() + 10_000));
    expect(push.sendPlannedBolusReminder).toHaveBeenCalledTimes(2);

    push.sendPlannedBolusReminder.mockResolvedValue(undefined);
    await outbox.retryDue(new Date(NOW.getTime() + 31_000));
    expect(push.sendPlannedBolusReminder).toHaveBeenCalledTimes(3);
    expect(push.sendPlannedBolusReminder.mock.calls[2][0].pushToken).toBe('b');

    await outbox.retryDue(new Date(NOW.getTime() + 10 * 60_000));
    expect(push.sendPlannedBolusReminder).toHaveBeenCalledTimes(3);
  });

  it('keeps a push that found no phone and sends it to a phone registered later', async () => {
    const devices: Array<{ push_token: string }> = [];
    const { outbox, push } = setup(devices);
    expect(await outbox.dispatch({ dedupeKey: 'k', patientId: 'p1', request: REQUEST, ttlMinutes: 60, now: NOW })).toEqual({ delivered: 0, devices: 0, retrying: true });
    devices.push({ push_token: 'new-phone' });
    await outbox.retryDue(new Date(NOW.getTime() + 60_000));
    expect(push.sendPlannedBolusReminder).toHaveBeenCalledWith({ ...REQUEST.input, pushToken: 'new-phone' });
  });

  it('deactivates a dead token without retrying it, and gives up (logged) when the push expires', async () => {
    const { outbox, push, deactivate, log } = setup([{ push_token: 'dead' }, { push_token: 'flaky' }]);
    push.sendPlannedBolusReminder.mockImplementation(async ({ pushToken }: { pushToken: string }) => {
      throw pushToken === 'dead' ? new PushNotificationProviderError('DEVICE_TOKEN_UNREGISTERED', 'gone', false) : transient();
    });
    await outbox.dispatch({ dedupeKey: 'k', patientId: 'p1', request: REQUEST, ttlMinutes: 1, now: NOW });
    expect(deactivate).toHaveBeenCalledWith('dead');
    await outbox.retryDue(new Date(NOW.getTime() + 31_000));
    // The next wait (1 min) ends after the expiry: the outbox gives up.
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ event: 'push_outbox_gave_up', kind: 'planned_bolus' }));
    await outbox.retryDue(new Date(NOW.getTime() + 5 * 60_000));
    expect(push.sendPlannedBolusReminder).toHaveBeenCalledTimes(3);
  });

  it('sends "dawka podana" only to the other caregivers\' phones', async () => {
    const { outbox, push } = setup([{ push_token: 'sender', user_id: 'ewa' }, { push_token: 'other', user_id: 'piotr' }, { push_token: 'legacy', user_id: null }]);
    const request: PushOutboxRequest = { kind: 'dose_given', input: { patientId: 'p1', mealId: 'm1', reminderKey: 'r1', title: 'Druga dawka podana', body: 'Ewa · 1,5 j' } };
    await outbox.dispatch({ dedupeKey: 'dose-given:r1', patientId: 'p1', request, excludeUserId: 'ewa', ttlMinutes: 60, now: NOW });
    expect(push.sendDoseGiven.mock.calls.map(([input]) => input.pushToken)).toEqual(['other']);
  });

  it('sends once without the store, and when the store fails', async () => {
    const plain = setup([{ push_token: 'a' }], null);
    expect(await plain.outbox.dispatch({ dedupeKey: 'k', patientId: 'p1', request: REQUEST, ttlMinutes: 60, now: NOW })).toEqual({ delivered: 1, devices: 1, retrying: false });

    const broken = memoryStore();
    broken.enqueue = vi.fn().mockRejectedValue(new Error('relation "push_outbox" does not exist'));
    const down = setup([{ push_token: 'a' }], broken);
    expect(await down.outbox.dispatch({ dedupeKey: 'k', patientId: 'p1', request: REQUEST, ttlMinutes: 60, now: NOW })).toEqual({ delivered: 1, devices: 1, retrying: false });
    expect(down.log).toHaveBeenCalledWith(expect.objectContaining({ event: 'push_outbox_unavailable' }));
  });

  it('puts a queued push in the bell at once, even with no phone, and only once', async () => {
    const { outbox, push } = setup([]);
    const recordQueuedReminder = vi.fn().mockResolvedValue(undefined);
    Object.assign(push, { recordQueuedReminder });
    await outbox.dispatch({ dedupeKey: 'k', patientId: 'p1', request: REQUEST, ttlMinutes: 60, now: NOW });
    await outbox.dispatch({ dedupeKey: 'k', patientId: 'p1', request: REQUEST, ttlMinutes: 60, now: NOW });
    expect(recordQueuedReminder).toHaveBeenCalledTimes(1);
    expect(recordQueuedReminder).toHaveBeenCalledWith(REQUEST);
    // A retry adds nothing.
    await outbox.retryDue(new Date(NOW.getTime() + 31_000));
    expect(recordQueuedReminder).toHaveBeenCalledTimes(1);
  });

  it('waits 30 s, 1, 2, 4 min, then 5 min between attempts', () => {
    expect([1, 2, 3, 4, 5, 9].map(pushOutboxRetryDelayMs)).toEqual([30_000, 60_000, 120_000, 240_000, 300_000, 300_000]);
  });
});
