import { PushNotificationProviderError } from '@modules/notifications/infrastructure/push-notification-provider.error';
import type { PushNotificationService } from './push-notification.service';

type WithoutToken<T> = Omit<T, 'pushToken'>;

/**
 * A reminder push the outbox can send again (push-outbox.v1): the PushNotificationService method and its input without
 * the device token. Stored as JSON, so a retry rebuilds the same notification.
 */
export type PushOutboxRequest =
  | { kind: 'wbt_reminder'; input: WithoutToken<Parameters<PushNotificationService['sendWbtReminder']>[0]> }
  | { kind: 'planned_bolus'; input: WithoutToken<Parameters<PushNotificationService['sendPlannedBolusReminder']>[0]> }
  | { kind: 'care_reminder'; input: WithoutToken<Parameters<PushNotificationService['sendCareReminder']>[0]> }
  | { kind: 'dose_given'; input: WithoutToken<Parameters<PushNotificationService['sendDoseGiven']>[0]> }
  /** A remote settings package for one person (1.0.5): only that person's phones get it (to_user_id). */
  | { kind: 'remote_settings_handoff'; to_user_id: string; input: WithoutToken<Parameters<PushNotificationService['sendRemoteSettingsHandoff']>[0]> };

export interface PushOutboxItem {
  id: string;
  dedupe_key: string;
  patient_id: string;
  request: PushOutboxRequest;
  /** Only the other caregivers' phones (a phone without a caregiver is left out: it may be this one's). */
  exclude_user_id: string | null;
  attempts: number;
  expires_at: string;
}

export interface PushOutboxStore {
  /** Null when a push with this key was queued already (it is not sent twice). */
  /** nextAttemptAt: the worker sends it then (a push queued by the API); absent: the caller sends it at once. */
  enqueue(args: { dedupeKey: string; patientId: string; request: PushOutboxRequest; excludeUserId: string | null; expiresAt: string; nextAttemptAt?: string | null }): Promise<PushOutboxItem | null>;
  listDue(nowIso: string, limit: number): Promise<PushOutboxItem[]>;
  deliveredTokens(id: string): Promise<Set<string>>;
  markDelivered(id: string, pushToken: string): Promise<void>;
  finishAttempt(id: string, args: { complete: boolean; nextAttemptAt: string | null; errorCode: string | null }): Promise<void>;
}

export interface PushOutboxDevice {
  push_token: string;
  user_id?: string | null;
}

export type PushOutboxSender = Pick<PushNotificationService, 'sendWbtReminder' | 'sendPlannedBolusReminder' | 'sendCareReminder' | 'sendDoseGiven'>
  & Partial<Pick<PushNotificationService, 'sendRemoteSettingsHandoff'>>
  & Partial<Pick<PushNotificationService, 'recordQueuedReminder'>>;

export interface PushOutboxResult {
  /** Phones the push reached in this attempt. */
  delivered: number;
  /** Phones it was meant for. */
  devices: number;
  /** Another attempt is scheduled (a phone failed for a passing reason, or none was registered yet). */
  retrying: boolean;
}

/** Waits between attempts: 30 s, 1, 2, 4 min, then every 5 min until the push expires. */
export function pushOutboxRetryDelayMs(attempts: number): number {
  return Math.min(5 * 60_000, 30_000 * 2 ** Math.max(0, attempts - 1));
}

/**
 * Reminder pushes that must reach the caregiver (push-outbox.v1, audit 2026-10-26): a reminder is marked sent before
 * its push goes out (that mark stops a second send), so a push that failed for a passing reason (APNs 5xx, a timeout,
 * no phone registered at that minute) used to be lost for good. The outbox keeps it and tries again, per phone, until
 * every phone has it or it expires. Without the store (migration 079 not applied) it sends once, as before.
 */
export class PushOutbox {
  constructor(private readonly deps: {
    store: PushOutboxStore | null;
    devices: { list(patientId: string): Promise<PushOutboxDevice[]>; deactivate(pushToken: string): Promise<void> };
    push: PushOutboxSender;
    log: (event: Record<string, unknown>) => void;
  }) {}

  /** Queues the push and makes its first attempt at once. Null when it was queued before (a duplicate dispatch). */
  async dispatch(args: { dedupeKey: string; patientId: string; request: PushOutboxRequest; excludeUserId?: string | null; ttlMinutes: number; now?: Date }): Promise<PushOutboxResult | null> {
    const now = args.now ?? new Date();
    const excludeUserId = args.excludeUserId ?? null;
    let item: PushOutboxItem | null;
    try {
      item = this.deps.store
        ? await this.deps.store.enqueue({ dedupeKey: args.dedupeKey, patientId: args.patientId, request: args.request, excludeUserId, expiresAt: new Date(now.getTime() + args.ttlMinutes * 60_000).toISOString() })
        : null;
      if (this.deps.store && !item) return null;
    } catch (error) {
      // The outbox is unavailable: one attempt without a retry is better than none.
      this.deps.log({ event: 'push_outbox_unavailable', kind: args.request.kind, error_code: errorCode(error) });
      item = null;
    }
    if (item) {
      // In the bell at once, even before any phone has it (a phone registered later still gets the push).
      await this.deps.push.recordQueuedReminder?.(args.request).catch(() => undefined);
    }
    const target = item ?? { id: '', dedupe_key: args.dedupeKey, patient_id: args.patientId, request: args.request, exclude_user_id: excludeUserId, attempts: 0, expires_at: now.toISOString() };
    return this.attempt(target, now, item !== null);
  }

  /** Sends again the queued pushes whose next attempt is due. Never throws. */
  async retryDue(now = new Date()): Promise<void> {
    const store = this.deps.store;
    if (!store) return;
    let due: PushOutboxItem[];
    try {
      due = await store.listDue(now.toISOString(), 50);
    } catch (error) {
      this.deps.log({ event: 'push_outbox_unavailable', error_code: errorCode(error) });
      return;
    }
    for (const item of due) {
      try {
        // Queued by the API (a meal excess warning): its first attempt is here, so is its bell entry.
        if (item.attempts === 0) await this.deps.push.recordQueuedReminder?.(item.request).catch(() => undefined);
        const result = await this.attempt(item, now, true);
        this.deps.log({ event: 'push_outbox_retried', kind: item.request.kind, dedupe_key: item.dedupe_key, attempt: item.attempts + 1, ...result });
      } catch (error) {
        this.deps.log({ event: 'push_outbox_retry_failed', kind: item.request.kind, dedupe_key: item.dedupe_key, error_code: errorCode(error) });
      }
    }
  }

  private async attempt(item: PushOutboxItem, now: Date, stored: boolean): Promise<PushOutboxResult> {
    const store = stored ? this.deps.store : null;
    const devices = (await this.deps.devices.list(item.patient_id))
      .filter((device) => item.exclude_user_id === null || (device.user_id && device.user_id !== item.exclude_user_id))
      // A push for one person (a remote settings package): only the phones that person registered.
      .filter((device) => item.request.kind !== 'remote_settings_handoff' || (!!device.user_id && device.user_id === item.request.to_user_id));
    const already = store ? await store.deliveredTokens(item.id) : new Set<string>();
    let delivered = 0;
    let failed = 0;
    let lastError: string | null = null;
    for (const device of devices) {
      if (already.has(device.push_token)) continue;
      try {
        await this.send(item.request, device.push_token);
        delivered += 1;
        await store?.markDelivered(item.id, device.push_token).catch(() => undefined);
      } catch (error) {
        lastError = errorCode(error);
        if (error instanceof PushNotificationProviderError && (error.code === 'DEVICE_TOKEN_INVALID' || error.code === 'DEVICE_TOKEN_UNREGISTERED')) {
          // A dead token is no longer one of the patient's phones: nothing to try again for it.
          await this.deps.devices.deactivate(device.push_token).catch(() => undefined);
        } else {
          failed += 1;
        }
        this.deps.log({ event: 'push_outbox_send_failed', kind: item.request.kind, dedupe_key: item.dedupe_key, error_code: lastError });
      }
    }
    const reached = already.size + delivered;
    // No phone at all yet counts as not delivered: a phone registered before the push expires still gets it.
    const pending = failed > 0 || (devices.length === 0 && reached === 0);
    const nextAttemptMs = now.getTime() + pushOutboxRetryDelayMs(item.attempts + 1);
    const retrying = pending && store !== null && nextAttemptMs < Date.parse(item.expires_at);
    if (store) {
      await store.finishAttempt(item.id, { complete: !retrying, nextAttemptAt: retrying ? new Date(nextAttemptMs).toISOString() : null, errorCode: lastError ?? (devices.length === 0 ? 'NO_ACTIVE_DEVICE' : null) })
        .catch((error) => this.deps.log({ event: 'push_outbox_unavailable', error_code: errorCode(error) }));
    }
    if (pending && !retrying) {
      this.deps.log({ event: 'push_outbox_gave_up', kind: item.request.kind, dedupe_key: item.dedupe_key, devices: devices.length, reached, error_code: lastError ?? 'NO_ACTIVE_DEVICE' });
    }
    return { delivered, devices: devices.length, retrying };
  }

  private send(request: PushOutboxRequest, pushToken: string): Promise<void> {
    switch (request.kind) {
      case 'wbt_reminder':
        return this.deps.push.sendWbtReminder({ ...request.input, pushToken });
      case 'planned_bolus':
        return this.deps.push.sendPlannedBolusReminder({ ...request.input, pushToken });
      case 'care_reminder':
        return this.deps.push.sendCareReminder({ ...request.input, pushToken });
      case 'dose_given':
        return this.deps.push.sendDoseGiven({ ...request.input, pushToken });
      case 'remote_settings_handoff':
        if (!this.deps.push.sendRemoteSettingsHandoff) return Promise.resolve();
        return this.deps.push.sendRemoteSettingsHandoff({ ...request.input, pushToken });
    }
  }
}

function errorCode(error: unknown): string {
  if (error instanceof PushNotificationProviderError) return error.code;
  if (error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string') return (error as { code: string }).code;
  return 'UNKNOWN';
}
