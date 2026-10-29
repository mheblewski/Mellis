import { describe, expect, it, vi } from 'vitest';
import type { DashboardResponse } from '@modules/dashboard/application/dashboard-snapshot';
import { reservoirStatus } from '@modules/dashboard/application/reservoir-level';
import { APP_LINK_ORIGIN } from '@modules/notifications/domain/push-notification';
import { PushNotificationService } from '@modules/notifications/application/push-notification.service';
import { PushNotificationProviderError } from '@modules/notifications/infrastructure/push-notification-provider.error';
import {
  decideReservoirAlert,
  reservoirPushText,
  ReservoirAlertService,
  type ReservoirAlertState,
  type ReservoirAlertStore,
  type ReservoirObservation,
} from './application/reservoir-alerts';

const NOW = new Date('2026-10-29T18:00:00.000Z');
const PATIENT = '11111111-1111-4111-8111-111111111111';

function observe(units: number | null, perDay: number | null = 24, extra: Partial<ReservoirObservation> = {}): ReservoirObservation {
  const status = reservoirStatus({ units, fullUnits: 200, averageDailyUnits: perDay });
  return { units, level: status?.level ?? null, hours_left: status?.hours_left ?? null, changed_at: null, read_at: new Date(NOW.getTime() - 2 * 60_000).toISOString(), ...extra };
}

function state(partial: Partial<ReservoirAlertState> = {}): ReservoirAlertState {
  return { patient_id: PATIENT, notified_level: null, notified_at: null, last_units: null, reservoir_changed_at: null, revision: 3, ...partial };
}

describe('decideReservoirAlert (reservoir-alerts.v1)', () => {
  it('pushes yellow once, then red once, and nothing more until a refill', () => {
    // 24 U a day = 1 U/h.
    const first = decideReservoirAlert(null, observe(20), NOW);
    expect(first.push).toBe('warning');
    expect(first.next).toMatchObject({ notified_level: 'warning', notified_at: NOW.toISOString(), last_units: 20 });

    const again = decideReservoirAlert(state({ notified_level: 'warning', notified_at: NOW.toISOString(), last_units: 20 }), observe(18), NOW);
    expect(again.push).toBeNull();

    const red = decideReservoirAlert(state({ notified_level: 'warning', notified_at: NOW.toISOString(), last_units: 9 }), observe(7.5), NOW);
    expect(red.push).toBe('alarm');

    const stillRed = decideReservoirAlert(state({ notified_level: 'alarm', notified_at: NOW.toISOString(), last_units: 7.5 }), observe(2), NOW);
    expect(stillRed.push).toBeNull();
    expect(stillRed.next).toMatchObject({ notified_level: 'alarm', last_units: 2 });
  });

  it('pushes only red for a reservoir first seen red, and nothing when it is fine', () => {
    expect(decideReservoirAlert(null, observe(5), NOW).push).toBe('alarm');
    const fine = decideReservoirAlert(null, observe(120), NOW);
    expect(fine.push).toBeNull();
    expect(fine.next).toMatchObject({ notified_level: null, last_units: 120 });
  });

  it('never pushes yellow after red, even when the estimate moves the level back', () => {
    expect(decideReservoirAlert(state({ notified_level: 'alarm', notified_at: NOW.toISOString(), last_units: 7 }), observe(7, 12), NOW).push).toBeNull();
  });

  it('starts over after a refill: a newer "Insulin Change" or a rise of 10 U or more', () => {
    const notifiedAt = '2026-10-29T08:00:00.000Z';
    const pushed = state({ notified_level: 'alarm', notified_at: notifiedAt, last_units: 4 });

    const refilled = decideReservoirAlert(pushed, observe(180, 24, { changed_at: '2026-10-29T17:30:00.000Z' }), NOW);
    expect(refilled).toMatchObject({ refilled: true, push: null, next: { notified_level: null, notified_at: null, last_units: 180, reservoir_changed_at: '2026-10-29T17:30:00.000Z' } });

    // An older change (before the push) is not a refill.
    expect(decideReservoirAlert(pushed, observe(3, 24, { changed_at: '2026-10-28T08:00:00.000Z' }), NOW).refilled).toBe(false);

    // A rise without a change event (Nightscout without one, or another patient's pump).
    expect(decideReservoirAlert(pushed, observe(14), NOW)).toMatchObject({ refilled: true, push: 'warning' });
    expect(decideReservoirAlert(pushed, observe(9), NOW).refilled).toBe(false);
  });

  it('acts on nothing without a reading or with a pump status older than 6 h', () => {
    expect(decideReservoirAlert(null, observe(null), NOW)).toEqual({ next: null, push: null, refilled: false });
    expect(decideReservoirAlert(null, observe(3, 24, { read_at: '2026-10-29T11:30:00.000Z' }), NOW).push).toBeNull();
  });

  it('keeps the last level after Omnipod "50+ U" (no reading) and sees the rise when the number comes back', () => {
    const pushed = state({ notified_level: 'alarm', notified_at: '2026-10-29T08:00:00.000Z', last_units: 4 });
    expect(decideReservoirAlert(pushed, observe(null), NOW).next).toBeNull();
    expect(decideReservoirAlert(pushed, observe(50), NOW).refilled).toBe(true);
  });
});

describe('reservoirPushText', () => {
  it('says how long the insulin lasts, or how much is left without an estimate', () => {
    expect(reservoirPushText('alarm', 8.04, 8)).toEqual({ title: 'Wymień zbiornik insuliny', body: 'Insuliny w zbiorniku zostało na ok. 8 godz. (8 j).' });
    expect(reservoirPushText('warning', 18.5, 21.7)).toEqual({ title: 'Kończy się insulina w zbiorniku', body: 'Insuliny w zbiorniku zostało na ok. 21 godz. (18,5 j).' });
    expect(reservoirPushText('warning', 22, null).body).toBe('W zbiorniku zostało 22 j insuliny.');
  });
});

function dashboardWith(units: number | null, perDay: number | null): DashboardResponse {
  const status = reservoirStatus({ units, fullUnits: 200, averageDailyUnits: perDay });
  return {
    patient_id: PATIENT, generated_at: NOW.toISOString(), glucose: null, readings: [], time_in_range: null, loop: null, insulin: null, site_changed_at: null, sensor_started_at: null,
    pump: { battery_percent: 60, reservoir_units: units, reservoir_full_units: 200, reservoir_hours_left: status?.hours_left ?? null, reservoir_level: status?.level ?? null, last_read_at: new Date(NOW.getTime() - 60_000).toISOString() },
  };
}

class MemoryStore implements ReservoirAlertStore {
  state: ReservoirAlertState | null = null;
  devices = [{ device_id: 'phone-a', push_token: 'token-a' }, { device_id: 'phone-b', push_token: 'token-b' }];
  deactivated: string[] = [];
  /** Another worker stores in between: the claim fails. */
  conflict = false;
  async listPatientsWithReservoirDevices() { return this.devices.length ? [PATIENT] : []; }
  async listReservoirDevices() { return this.devices; }
  async getState() { return this.state ? { ...this.state } : null; }
  async saveState(patientId: string, revision: number, next: Parameters<ReservoirAlertStore['saveState']>[2]) {
    if (this.conflict || (this.state?.revision ?? -1) !== revision) return false;
    this.state = { patient_id: patientId, ...next, revision: revision + 1 };
    return true;
  }
  async deactivatePushToken(token: string) { this.deactivated.push(token); }
}

describe('ReservoirAlertService', () => {
  function service(store: MemoryStore, units: { value: number | null }, push = { sendReservoirAlert: vi.fn().mockResolvedValue(undefined) }) {
    const log = vi.fn();
    return { push, log, service: new ReservoirAlertService({ store, push, log, dashboard: async () => ({ dashboard: dashboardWith(units.value, 24), changedAt: null }) }) };
  }

  it('pushes each level once per fill to every phone with the switch on, also across restarts', async () => {
    const store = new MemoryStore();
    const units = { value: 20 };
    const first = service(store, units);
    await first.service.run(NOW);
    expect(first.push.sendReservoirAlert).toHaveBeenCalledTimes(2);
    expect(first.push.sendReservoirAlert).toHaveBeenCalledWith(expect.objectContaining({ patientId: PATIENT, pushToken: 'token-a', level: 'warning', body: 'Insuliny w zbiorniku zostało na ok. 20 godz. (20 j).' }));

    // A new worker (restart) with the stored state: nothing again.
    const restarted = service(store, units);
    await restarted.service.run(new Date(NOW.getTime() + 5 * 60_000));
    expect(restarted.push.sendReservoirAlert).not.toHaveBeenCalled();

    units.value = 6;
    await restarted.service.run(new Date(NOW.getTime() + 10 * 60_000));
    expect(restarted.push.sendReservoirAlert).toHaveBeenCalledTimes(2);
    expect(restarted.push.sendReservoirAlert).toHaveBeenLastCalledWith(expect.objectContaining({ level: 'alarm', title: 'Wymień zbiornik insuliny' }));
  });

  it('sends nothing when no phone has the switch on, and nothing when another worker claimed the push', async () => {
    const off = new MemoryStore();
    off.devices = [];
    const none = service(off, { value: 5 });
    await none.service.run(NOW);
    expect(none.push.sendReservoirAlert).not.toHaveBeenCalled();

    const raced = new MemoryStore();
    raced.conflict = true;
    const other = service(raced, { value: 5 });
    await other.service.run(NOW);
    expect(other.push.sendReservoirAlert).not.toHaveBeenCalled();
  });

  it('switches off a dead token and still reaches the other phone', async () => {
    const store = new MemoryStore();
    const push = { sendReservoirAlert: vi.fn().mockRejectedValueOnce(new PushNotificationProviderError('DEVICE_TOKEN_UNREGISTERED', 'gone', false)).mockResolvedValue(undefined) };
    const run = service(store, { value: 5 }, push);
    await run.service.run(NOW);
    expect(store.deactivated).toEqual(['token-a']);
    expect(run.log).toHaveBeenCalledWith(expect.objectContaining({ event: 'reservoir_alert_sent', devices: 2, delivered: 1 }));
  });
});

describe('PushNotificationService.sendReservoirAlert', () => {
  it('starts the title with the patient name on a phone of several patients and opens the equipment list', async () => {
    const provider = { send: vi.fn().mockResolvedValue(undefined) };
    const history = { record: vi.fn().mockResolvedValue(undefined) };
    const labels = { labelFor: vi.fn(async (token: string) => (token === 'shared-phone' ? 'Ala' : null)) };
    const push = new PushNotificationService(provider as any, history as any, labels);
    const input = { patientId: PATIENT, level: 'alarm' as const, notifiedAt: NOW.toISOString(), title: 'Wymień zbiornik insuliny', body: 'Insuliny w zbiorniku zostało na ok. 6 godz. (6 j).' };

    await push.sendReservoirAlert({ ...input, pushToken: 'shared-phone' });
    await push.sendReservoirAlert({ ...input, pushToken: 'own-phone' });

    expect(provider.send.mock.calls[0][0]).toMatchObject({
      title: 'Ala · Wymień zbiornik insuliny',
      collapseId: `reservoir-${PATIENT}`,
      payload: { type: 'reservoir_low', patientId: PATIENT, level: 'alarm', routePath: `/patients/${PATIENT}`, universalLink: `${APP_LINK_ORIGIN}/patients/${PATIENT}/equipment` },
    });
    expect(provider.send.mock.calls[1][0].title).toBe('Wymień zbiornik insuliny');
    // One bell entry per level and fill (same dedupe key for both phones), with the plain title.
    expect(history.record).toHaveBeenCalledWith(expect.objectContaining({ dedupeKey: `reservoir:${PATIENT}:alarm:${NOW.toISOString()}`, title: 'Wymień zbiornik insuliny', type: 'reservoir_low' }));
    expect(new Set(history.record.mock.calls.map((call) => call[0].dedupeKey)).size).toBe(1);
  });
});
