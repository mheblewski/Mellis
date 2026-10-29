import { describe, expect, it, vi } from 'vitest';
import { ApiService } from './api.service';
import { ForbiddenError, ValidationError } from '@shared/errors/app-error';

const NOW = new Date('2026-10-17T12:41:00.000Z');
const PRINCIPAL = { user_id: 'user-1', auth_subject: 'sub-1' } as any;

function setup(options: { canRead?: boolean } = {}) {
  const repo = {
    getAccessRow: vi.fn(async () => (options.canRead === false ? null : { can_read_patient: true, can_write_patient: true })),
    insertAuditEvent: vi.fn(async () => undefined),
  };
  const pool = {
    query: vi.fn(async (sql: string) => {
      if (sql.includes('GLUCOSE_READING_AVAILABLE')) {
        return { rows: [
          { occurred_at: '2026-10-17T12:33:00.000Z', glucose_value: '120', direction: 'Flat' },
          { occurred_at: '2026-10-17T12:38:00.000Z', glucose_value: '124', direction: 'FortyFiveUp' },
        ] };
      }
      if (sql.includes('DEVICE_STATUS') && sql.includes('loop_payload')) {
        return { rows: [{ occurred_at: '2026-10-17T12:39:00.000Z', loop_payload: { openaps: { iob: { iob: 1.85 }, suggested: { COB: 23, IOB: null } } } }] };
      }
      if (sql.includes('DEVICE_STATUS')) {
        return { rows: [{ occurred_at: '2026-10-17T12:39:00.000Z', raw_payload: {
          pump: { clock: '2026-10-17T12:39:00.000Z', battery: { percent: 68 }, reservoir: 112 },
          openaps: { iob: { iob: 1.85 }, suggested: { COB: 23 } },
        } }] };
      }
      throw new Error(`unexpected query: ${sql}`);
    }),
  };
  const api = new ApiService(repo as any, pool as any);
  const careEvents = { latest: vi.fn(async () => ({ site_changed_at: '2026-10-16T09:10:00.000Z', sensor_started_at: null })) };
  (api as any).dashboards.careEvents = careEvents;
  (api as any).dashboards.nightscoutLive = null;
  return { api, pool, careEvents };
}

describe('ApiService.getDashboard', () => {
  it('combines synced readings, the pump status and the Nightscout care events', async () => {
    const { api, pool, careEvents } = setup();

    const dashboard = await api.getDashboard(PRINCIPAL, 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001', NOW);

    expect(dashboard).toMatchObject({
      patient_id: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001',
      glucose: { value: 124, direction: 'FortyFiveUp', delta: 4, observed_at: '2026-10-17T12:38:00.000Z' },
      time_in_range: { readings_count: 2, in_range_percent: 100 },
      pump: { battery_percent: 68, reservoir_units: 112, last_read_at: '2026-10-17T12:39:00.000Z' },
      loop: { iob_units: 1.85, cob_grams: 23 },
      site_changed_at: '2026-10-16T09:10:00.000Z',
      sensor_started_at: null,
    });
    const readingsQuery = pool.query.mock.calls.find(([sql]) => String(sql).includes('GLUCOSE_READING_AVAILABLE'));
    expect(readingsQuery?.[1]).toEqual(['aaaaaaaa-aaaa-4aaa-8aaa-000000000001', '2026-10-16T12:41:00.000Z']);
    expect(careEvents.latest).toHaveBeenCalledWith('aaaaaaaa-aaaa-4aaa-8aaa-000000000001');
    const statusKeys = pool.query.mock.calls.filter(([sql]) => String(sql).includes('DEVICE_STATUS')).map(([, params]) => (params as unknown[])[1]);
    expect(statusKeys).toEqual([['pump'], ['openaps', 'loop']]);
  });

  it('shows a reading and pump status that are in Nightscout but not synced yet', async () => {
    const { api } = setup();
    const live = {
      latest: vi.fn(async () => ({
        readings: [{ at: '2026-10-17T12:40:30.000Z', value: 131, direction: 'SingleUp' }],
        deviceStatus: { observed_at: '2026-10-17T12:40:40.000Z', raw_payload: { pump: { clock: '2026-10-17T12:40:35.000Z', battery: { percent: 67 }, reservoir: 111 }, openaps: { iob: { iob: 2.1 } } } },
      })),
    };
    (api as any).dashboards.nightscoutLive = live;

    const dashboard = await api.getDashboard(PRINCIPAL, 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001', NOW);

    expect(dashboard.glucose).toMatchObject({ value: 131, direction: 'SingleUp', observed_at: '2026-10-17T12:40:30.000Z' });
    expect(dashboard.readings).toHaveLength(3);
    expect(dashboard.pump).toMatchObject({ battery_percent: 67, last_read_at: '2026-10-17T12:40:35.000Z' });
    expect(dashboard.loop).toMatchObject({ iob_units: 2.1 });
    expect(live.latest).toHaveBeenCalledWith('aaaaaaaa-aaaa-4aaa-8aaa-000000000001');
  });

  it('adds the last 24 h of insulin from the synced treatments and the profile basal', async () => {
    const { api } = setup();
    const repo = (api as any).repository;
    repo.listInsulinDeliveryEventsByRange = vi.fn(async () => ([
      { event_id: 'b1', type: 'BOLUS', occurred_at: '2026-10-17T11:00:00.000Z', payload: { insulin_units: 3.5 } },
      { event_id: 's1', type: 'SMB', occurred_at: '2026-10-17T11:30:00.000Z', payload: { insulin_units: 0.3 } },
    ]));
    repo.getTherapyProfileAt = vi.fn(async () => ({ status: 'KNOWN', timezone: 'Europe/Warsaw', basal_u_per_h: [['00:00', 0.6]] }));

    const dashboard = await api.getDashboard(PRINCIPAL, 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001', NOW);

    expect(dashboard.insulin?.boluses).toEqual([{ at: '2026-10-17T11:00:00.000Z', units: 3.5 }]);
    expect(dashboard.insulin?.smbs).toEqual([{ at: '2026-10-17T11:30:00.000Z', units: 0.3 }]);
    expect(dashboard.insulin?.basal).toEqual([{ start: '2026-10-16T12:41:00.000Z', end: '2026-10-17T12:41:00.000Z', rate: 0.6 }]);
    expect(repo.listInsulinDeliveryEventsByRange).toHaveBeenCalledWith({ patientId: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001', startAtIso: '2026-10-16T06:41:00.000Z', endAtIso: '2026-10-17T12:41:00.000Z' });
  });

  it('shows the dashboard without insulin when the insulin query fails', async () => {
    const { api } = setup();
    (api as any).repository.listInsulinDeliveryEventsByRange = vi.fn(async () => { throw new Error('db'); });

    const dashboard = await api.getDashboard(PRINCIPAL, 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001', NOW);

    expect(dashboard.insulin).toBeNull();
    expect(dashboard.glucose?.value).toBe(124);
  });

  it('refuses a caregiver without access before reading anything', async () => {
    const { api, pool, careEvents } = setup({ canRead: false });

    await expect(api.getDashboard(PRINCIPAL, 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001', NOW)).rejects.toBeInstanceOf(ForbiddenError);
    expect(pool.query).not.toHaveBeenCalled();
    expect(careEvents.latest).not.toHaveBeenCalled();
  });
});

describe('ApiService.getDashboardHistory', () => {
  const PATIENT = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001';

  it('reads the readings, the loop calculations and the insulin of the window', async () => {
    const { api, pool } = setup();
    const repo = (api as any).repository;
    repo.listInsulinDeliveryEventsByRange = vi.fn(async () => ([
      { event_id: 'b1', type: 'BOLUS', occurred_at: '2026-10-17T11:00:00.000Z', payload: { insulin_units: 2 } },
    ]));
    repo.getTherapyProfileAt = vi.fn(async () => ({ status: 'UNKNOWN' }));

    const history = await api.getDashboardHistory(PRINCIPAL, PATIENT, { from: '2026-10-17T10:00:00.000Z', to: '2026-10-17T13:00:00.000Z' }, NOW);

    expect(history).toMatchObject({
      patient_id: PATIENT,
      from: '2026-10-17T10:00:00.000Z',
      to: '2026-10-17T12:51:00.000Z',
      readings: [{ at: '2026-10-17T12:33:00.000Z', value: 120 }, { at: '2026-10-17T12:38:00.000Z', value: 124 }],
      loop: [{ at: '2026-10-17T12:39:00.000Z', iob_units: 1.85, cob_grams: 23 }],
      insulin: { boluses: [{ at: '2026-10-17T11:00:00.000Z', units: 2 }] },
    });
    const readingsQuery = pool.query.mock.calls.find(([sql]) => String(sql).includes('GLUCOSE_READING_AVAILABLE'));
    expect(readingsQuery?.[1]).toEqual([PATIENT, '2026-10-17T10:00:00.000Z', '2026-10-17T12:51:00.000Z']);
    const loopQuery = pool.query.mock.calls.find(([sql]) => String(sql).includes('DEVICE_STATUS'));
    expect(String(loopQuery?.[0])).toContain('jsonb_build_object');
  });

  it('rejects a bad window and a caregiver without access', async () => {
    const { api, pool } = setup();
    await expect(api.getDashboardHistory(PRINCIPAL, PATIENT, { from: 'x' }, NOW)).rejects.toBeInstanceOf(ValidationError);
    const denied = setup({ canRead: false });
    await expect(denied.api.getDashboardHistory(PRINCIPAL, PATIENT, { from: '2026-10-17T10:00:00.000Z' }, NOW)).rejects.toBeInstanceOf(ForbiddenError);
    expect(pool.query).not.toHaveBeenCalled();
    expect(denied.pool.query).not.toHaveBeenCalled();
  });
});

describe('ApiService.getDashboardTimeInRange', () => {
  const PATIENT = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001';

  it('reads the synced readings of the chosen period', async () => {
    const { api, pool } = setup();

    const tir = await api.getDashboardTimeInRange(PRINCIPAL, PATIENT, '14', NOW);

    expect(tir).toMatchObject({ patient_id: PATIENT, days: 14, readings_count: 2, counts: { in_range: 2 } });
    const readingsQuery = pool.query.mock.calls.find(([sql]) => String(sql).includes('GLUCOSE_READING_AVAILABLE'));
    expect(readingsQuery?.[1]).toEqual([PATIENT, '2026-10-03T12:41:00.000Z', '2026-10-17T12:41:00.001Z']);
  });

  it('rejects another period and a caregiver without access', async () => {
    const { api, pool } = setup();
    await expect(api.getDashboardTimeInRange(PRINCIPAL, PATIENT, '30', NOW)).rejects.toBeInstanceOf(ValidationError);
    const denied = setup({ canRead: false });
    await expect(denied.api.getDashboardTimeInRange(PRINCIPAL, PATIENT, '7', NOW)).rejects.toBeInstanceOf(ForbiddenError);
    expect(pool.query).not.toHaveBeenCalled();
    expect(denied.pool.query).not.toHaveBeenCalled();
  });
});
