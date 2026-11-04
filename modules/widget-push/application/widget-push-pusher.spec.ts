import { describe, expect, it } from 'vitest';
import type { DashboardResponse } from '@modules/dashboard/application/dashboard-snapshot';
import type { WidgetPushTarget } from '@infra/db/postgres-widget-push.repository';
import { PushNotificationProviderError } from '@modules/notifications/infrastructure/push-notification-provider.error';
import { WidgetPushPusher, shortTokenId, type WidgetPushStore } from './widget-push-pusher';

const PATIENT_A = '11111111-1111-4111-8111-111111111111';
const PATIENT_B = '22222222-2222-4222-8222-222222222222';
const NOW = new Date('2026-11-03T10:00:00.000Z');
const minutesAgo = (minutes: number): string => new Date(NOW.getTime() - minutes * 60_000).toISOString();

function dashboard(patientId: string, value: number, at = minutesAgo(1)): DashboardResponse {
  return {
    patient_id: patientId,
    generated_at: NOW.toISOString(),
    glucose: { value, unit: 'mg/dL', direction: 'Flat', observed_at: at, delta: 0 },
    readings: [],
    time_in_range: null,
    pump: null,
    loop: null,
    insulin: { boluses: [], smbs: [], basal: [] },
    site_changed_at: null,
    sensor_started_at: null,
  } as unknown as DashboardResponse;
}

function target(overrides: Partial<WidgetPushTarget> = {}): WidgetPushTarget {
  return {
    token: 'aa11', user_id: 'user', topic: 'pl.glucomind.ios.watchkitapp', environment: 'production', platform: 'watchos',
    token_last_pushed_at: null, patient_id: PATIENT_A, has_state: true,
    last_reading_at: minutesAgo(6), deferred_reading_at: null, last_pushed_at: minutesAgo(6), last_value: 120, last_level: 'in_range',
    ...overrides,
  };
}

function harness(rows: WidgetPushTarget[], values: Record<string, DashboardResponse | Error>, options: { failWith?: PushNotificationProviderError } = {}) {
  const sent: Array<{ token: string; topic: string; environment: string; priority?: number }> = [];
  const calls: string[] = [];
  const logs: Array<Record<string, unknown>> = [];
  let reads = 0;
  const store: WidgetPushStore = {
    listTargets: async () => rows,
    markPushed: async (args) => { calls.push(`pushed ${args.token} ${args.patientId.slice(0, 1)} ${args.value} ${args.level}`); },
    markEvaluated: async (args) => { calls.push(`evaluated ${args.token} ${args.patientId.slice(0, 1)}`); },
    markDeferred: async (args) => { calls.push(`deferred ${args.token} ${args.patientId.slice(0, 1)}`); },
    deleteToken: async (token) => { calls.push(`deleted ${token}`); },
  };
  const pusher = new WidgetPushPusher({
    store,
    sender: {
      sendWidgetUpdate: async (token, opts) => {
        if (options.failWith) throw options.failWith;
        sent.push({ token, ...opts });
      },
    },
    dashboard: async (patientId) => {
      reads += 1;
      const value = values[patientId];
      if (value instanceof Error) throw value;
      return value;
    },
    log: (event) => logs.push(event),
  });
  return { pusher, sent, calls, logs, reads: () => reads };
}

describe('WidgetPushPusher', () => {
  it('reads each patient once and pushes a worthwhile reading to every token, logging it', async () => {
    const h = harness([target({ token: 'aa11' }), target({ token: 'bb22', environment: 'sandbox' })], { [PATIENT_A]: dashboard(PATIENT_A, 190) });
    await h.pusher.tick(NOW);

    expect(h.reads()).toBe(1);
    expect(h.sent).toEqual([
      { token: 'aa11', topic: 'pl.glucomind.ios.watchkitapp', environment: 'production', priority: 5 },
      { token: 'bb22', topic: 'pl.glucomind.ios.watchkitapp', environment: 'sandbox', priority: 5 },
    ]);
    expect(h.calls).toEqual(['pushed aa11 1 190 high', 'pushed bb22 1 190 high']);
    expect(h.logs[0]).toEqual({
      event: 'widget_push_sent', token: shortTokenId('aa11'), patient: '11111111', platform: 'watchos', environment: 'production',
      level: 'high', reading_age_s: 60, reason: 'level_change', priority: 5,
    });
    expect(JSON.stringify(h.logs)).not.toContain('190');
  });

  it('pushes a small change and stays quiet for a reading already decided on', async () => {
    const h = harness([target(), target({ token: 'bb22', last_reading_at: minutesAgo(1) })], { [PATIENT_A]: dashboard(PATIENT_A, 124) });
    await h.pusher.tick(NOW);
    expect(h.sent).toHaveLength(1);
    expect(h.logs).toEqual([expect.objectContaining({ event: 'widget_push_sent', reason: 'new_reading', token: shortTokenId('aa11') })]);
  });

  it('pushes one patient per token per 4 min, defers the other once, and lets entering <54 through', async () => {
    const rows = [
      target({ patient_id: PATIENT_A }),
      target({ patient_id: PATIENT_B }),
    ];
    const h = harness(rows, { [PATIENT_A]: dashboard(PATIENT_A, 200), [PATIENT_B]: dashboard(PATIENT_B, 150) });
    await h.pusher.tick(NOW);
    expect(h.sent).toHaveLength(1);
    expect(h.calls).toEqual(['pushed aa11 1 200 high', 'deferred aa11 2']);
    expect(h.logs[1]).toMatchObject({ event: 'widget_push_skipped', reason: 'token_cap', patient: '22222222' });

    // The next tick sees the reading already deferred: no new log line, no write.
    const again = harness([target({ patient_id: PATIENT_B, token_last_pushed_at: minutesAgo(0.25), deferred_reading_at: minutesAgo(1) })], { [PATIENT_B]: dashboard(PATIENT_B, 150) });
    await again.pusher.tick(NOW);
    expect(again.calls).toEqual([]);
    expect(again.logs).toEqual([]);

    const urgent = harness(rows, { [PATIENT_A]: dashboard(PATIENT_A, 200), [PATIENT_B]: dashboard(PATIENT_B, 50) });
    await urgent.pusher.tick(NOW);
    expect(urgent.sent.map((s) => s.priority)).toEqual([5, 10]);
    expect(urgent.logs[1]).toMatchObject({ event: 'widget_push_sent', reason: 'urgent_low', level: 'urgent_low' });
  });

  it('deletes a token APNs calls gone and skips its other patients', async () => {
    const h = harness(
      [target({ patient_id: PATIENT_A }), target({ patient_id: PATIENT_B })],
      { [PATIENT_A]: dashboard(PATIENT_A, 50), [PATIENT_B]: dashboard(PATIENT_B, 50) },
      { failWith: new PushNotificationProviderError('DEVICE_TOKEN_UNREGISTERED', 'gone', false) },
    );
    await h.pusher.tick(NOW);
    expect(h.calls).toEqual(['deleted aa11']);
    expect(h.logs).toEqual([expect.objectContaining({ event: 'widget_push_token_deleted', error: 'DEVICE_TOKEN_UNREGISTERED' })]);
  });

  it('does not retry a reading whose push failed for another reason', async () => {
    const h = harness([target()], { [PATIENT_A]: dashboard(PATIENT_A, 200) }, { failWith: new PushNotificationProviderError('APNS_RETRYABLE', 'busy', true) });
    await h.pusher.tick(NOW);
    expect(h.calls).toEqual(['evaluated aa11 1']);
    expect(h.logs).toEqual([expect.objectContaining({ event: 'widget_push_failed', error: 'APNS_RETRYABLE', reason: 'level_change' })]);
  });

  it('never throws: a failed dashboard skips the patient, a failed store is logged', async () => {
    const h = harness([target()], { [PATIENT_A]: new Error('nightscout down') });
    await expect(h.pusher.tick(NOW)).resolves.toBeUndefined();
    expect(h.sent).toEqual([]);

    const broken = new WidgetPushPusher({
      store: { listTargets: async () => { throw new Error('db'); } } as unknown as WidgetPushStore,
      sender: { sendWidgetUpdate: async () => undefined },
      dashboard: async () => dashboard(PATIENT_A, 100),
      log: (event) => logs.push(event),
    });
    const logs: Array<Record<string, unknown>> = [];
    await expect(broken.tick(NOW)).resolves.toBeUndefined();
    expect(logs).toEqual([{ event: 'widget_push_tick_failed', error: 'Error' }]);
  });

  it('skips a patient without a reading', async () => {
    const empty = { ...dashboard(PATIENT_A, 100), glucose: null } as DashboardResponse;
    const h = harness([target()], { [PATIENT_A]: empty });
    await h.pusher.tick(NOW);
    expect(h.calls).toEqual([]);
    expect(h.logs).toEqual([]);
  });
});
