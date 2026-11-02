import { describe, expect, it, vi } from 'vitest';
import type { DashboardResponse } from '@modules/dashboard/application/dashboard-snapshot';
import { BatteryAlertService, batteryPushText, decideBatteryAlert, type BatteryAlertState, type BatteryAlertStore } from './application/battery-alerts';

const NOW = new Date('2026-11-02T18:00:00.000Z');
const PATIENT = '11111111-1111-4111-8111-111111111111';
const READ_AT = new Date(NOW.getTime() - 2 * 60_000).toISOString();

function saved(next: BatteryAlertState | Omit<BatteryAlertState, 'patient_id' | 'revision'> | null, previous: BatteryAlertState | null = null): BatteryAlertState {
  return { patient_id: PATIENT, revision: (previous?.revision ?? -1) + 1, ...(next ?? previous)! } as BatteryAlertState;
}

describe('decideBatteryAlert (battery-alerts.v1)', () => {
  it('pushes under 25% once, then under 15% once, and nothing more until a charge', () => {
    expect(decideBatteryAlert(null, { percent: 40, read_at: READ_AT }, NOW)).toMatchObject({ push: null });
    const warning = decideBatteryAlert(null, { percent: 24, read_at: READ_AT }, NOW);
    expect(warning.push).toBe('warning');
    let state = saved(warning.next);
    expect(decideBatteryAlert(state, { percent: 20, read_at: READ_AT }, NOW).push).toBeNull();
    const critical = decideBatteryAlert(state, { percent: 14, read_at: READ_AT }, NOW);
    expect(critical.push).toBe('critical');
    state = saved(critical.next, state);
    expect(decideBatteryAlert(state, { percent: 10, read_at: READ_AT }, NOW).push).toBeNull();

    // A small drift up is not a charge; a rise of 10 points from the lowest reading is.
    state = saved(decideBatteryAlert(state, { percent: 10, read_at: READ_AT }, NOW).next, state);
    expect(decideBatteryAlert(state, { percent: 18, read_at: READ_AT }, NOW)).toMatchObject({ push: null, recharged: false });
    const charged = decideBatteryAlert(state, { percent: 100, read_at: READ_AT }, NOW);
    expect(charged).toMatchObject({ push: null, recharged: true, next: { notified_level: null } });
    state = saved(charged.next, state);
    expect(decideBatteryAlert(state, { percent: 24, read_at: READ_AT }, NOW).push).toBe('warning');
  });

  it('gives a battery first seen under 15% only the critical push', () => {
    expect(decideBatteryAlert(null, { percent: 9, read_at: READ_AT }, NOW).push).toBe('critical');
  });

  it('does nothing without a percent or with a pump status older than 6 h', () => {
    expect(decideBatteryAlert(null, { percent: null, read_at: READ_AT }, NOW)).toEqual({ next: null, push: null, recharged: false });
    const old = new Date(NOW.getTime() - 7 * 60 * 60_000).toISOString();
    expect(decideBatteryAlert(null, { percent: 10, read_at: old }, NOW)).toEqual({ next: null, push: null, recharged: false });
  });

  it('says how much is left', () => {
    expect(batteryPushText('warning', 22)).toEqual({ title: 'Słaba bateria pompy', body: 'Bateria pompy: 22%. Naładuj lub wymień baterię.' });
    expect(batteryPushText('critical', 12.4)).toEqual({ title: 'Bateria pompy prawie pusta', body: 'Bateria pompy: 12%. Naładuj lub wymień baterię jak najszybciej.' });
  });
});

describe('BatteryAlertService', () => {
  it('pushes each phone once and not again on the next tick', async () => {
    let state: BatteryAlertState | null = null;
    const store: BatteryAlertStore = {
      listPatientsWithBatteryDevices: vi.fn(async () => [PATIENT]),
      listBatteryDevices: vi.fn(async () => [{ device_id: 'a', push_token: 'ta' }, { device_id: 'b', push_token: 'tb' }]),
      getBatteryState: vi.fn(async () => state),
      saveBatteryState: vi.fn(async (_patientId, _revision, next) => {
        state = saved(next, state);
        return true;
      }),
      deactivatePushToken: vi.fn(async () => undefined),
    };
    const push = { sendBatteryAlert: vi.fn(async () => undefined) };
    const dashboard = { pump: { battery_percent: 21, reservoir_units: 50, reservoir_full_units: 200, last_read_at: READ_AT } } as unknown as DashboardResponse;
    const service = new BatteryAlertService({ store, push, dashboard: async () => dashboard, log: vi.fn() });
    await service.run(NOW);
    await service.run(NOW);
    expect(push.sendBatteryAlert).toHaveBeenCalledTimes(2);
    expect(push.sendBatteryAlert).toHaveBeenCalledWith(expect.objectContaining({ pushToken: 'ta', level: 'warning', title: 'Słaba bateria pompy' }));
  });
});
