import { describe, expect, it, vi } from 'vitest';
import { QuietHoursService, type QuietHeldPush, type QuietPhone } from './application/quiet-hours-service';
import type { EquipmentNow } from './application/quiet-equipment';
import type { QuietHoursSettings } from '@modules/notifications/application/quiet-hours';

const PATIENT = '11111111-1111-4111-8111-111111111111';
const night: QuietHoursSettings = { enabled: true, start_minute: 22 * 60, end_minute: 7 * 60, time_zone: 'Europe/Warsaw', low_warnings: true };
const equipment: EquipmentNow = {
  reservoir_units: 6, reservoir_level: 'alarm', reservoir_hours_left: 4.2, reservoir_changed_at: null,
  battery_percent: 12, pump_read_at: '2026-11-23T06:58:00+01:00', site_changed_at: '2026-11-21T19:00:00+01:00',
};

function held(type: string, overrides: Partial<QuietHeldPush> = {}): QuietHeldPush {
  return {
    id: `${type}-id`, push_token: 'tok', patient_id: PATIENT, notification_type: type, held_at: '2026-11-23T01:00:00+01:00', release_after: '2026-11-23T07:00:00+01:00',
    envelope: { platform: 'ios', pushToken: 'tok', title: `${type} title`, body: `${type} body`, payload: { type, patientId: PATIENT } as never },
    ...overrides,
  };
}

function setup(rows: QuietHeldPush[], settings: QuietHoursSettings | null = night, phones: QuietPhone[] = []) {
  const deliver = vi.fn(async () => undefined);
  const store = {
    listWaiting: vi.fn(async () => rows),
    markReleased: vi.fn(async () => true),
    listQuietPhones: vi.fn(async () => phones),
    claimPreCheck: vi.fn(async () => true),
  };
  const service = new QuietHoursService({
    store, deliver, settingsFor: async () => settings, equipment: async () => equipment, homeTimeZone: 'Europe/Warsaw', log: vi.fn(),
  });
  return { service, deliver, store };
}

describe('QuietHoursService release', () => {
  it('waits while the phone is still in quiet hours', async () => {
    const { service, deliver, store } = setup([held('reservoir_low')]);
    await service.release(new Date('2026-11-23T06:59:00+01:00'));
    expect(deliver).not.toHaveBeenCalled();
    expect(store.markReleased).not.toHaveBeenCalled();
  });

  it('after the end gathers the equipment into one push with fresh numbers and sends information as it was', async () => {
    const { service, deliver, store } = setup([held('reservoir_low'), held('battery_low'), held('therapy_pattern')]);
    await service.release(new Date('2026-11-23T07:00:30+01:00'));
    expect(store.markReleased).toHaveBeenCalledWith(['reservoir_low-id', 'battery_low-id', 'therapy_pattern-id'], 'released');
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(deliver).toHaveBeenCalledWith(expect.objectContaining({ title: 'therapy_pattern title' }));
    expect(deliver).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Po godzinach ciszy',
      body: 'Zbiornik: zostało 6 j, wystarczy na ok. 4 godz.\nBateria pompy: 12%.',
      threadId: `equipment-${PATIENT}`,
    }));
  });

  it('releases at once when quiet hours are turned off, and drops information older than 2 h after the end', async () => {
    const off = setup([held('reservoir_low')], null);
    await off.service.release(new Date('2026-11-23T03:00:00+01:00'));
    expect(off.deliver).toHaveBeenCalledTimes(1);
    const late = setup([held('app_update')]);
    await late.service.release(new Date('2026-11-23T09:30:00+01:00'));
    expect(late.deliver).not.toHaveBeenCalled();
  });

  it('sends an empty reservoir on its own, time-sensitive', async () => {
    const { service, deliver } = setup([held('reservoir_low')]);
    (service as unknown as { deps: { equipment: () => Promise<EquipmentNow> } }).deps.equipment = async () => ({ ...equipment, reservoir_units: 0 });
    await service.release(new Date('2026-11-23T07:00:30+01:00'));
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledWith(expect.objectContaining({ title: 'Zbiornik jest pusty', interruptionLevel: 'time-sensitive' }));
  });

  it('sends nothing when another worker released them first', async () => {
    const { service, deliver, store } = setup([held('reservoir_low')]);
    store.markReleased.mockResolvedValue(false);
    await service.release(new Date('2026-11-23T07:00:30+01:00'));
    expect(deliver).not.toHaveBeenCalled();
  });
});

describe('QuietHoursService before quiet hours', () => {
  const phone: QuietPhone = { ...night, device_id: 'dev', push_token: 'tok', patient_id: PATIENT, reservoir_on: true, battery_on: true, site_on: false };
  const evening = { ...equipment, pump_read_at: '2026-11-22T21:28:00+01:00', reservoir_units: 9, reservoir_hours_left: 5.5, battery_percent: 80 };

  it('checks once, half an hour before the start, and pushes what runs out at night', async () => {
    const { service, deliver, store } = setup([], night, [phone]);
    (service as unknown as { deps: { equipment: () => Promise<EquipmentNow> } }).deps.equipment = async () => evening;
    await service.beforeQuiet(new Date('2026-11-22T21:20:00+01:00'));
    expect(deliver).not.toHaveBeenCalled();
    await service.beforeQuiet(new Date('2026-11-22T21:30:00+01:00'));
    expect(store.claimPreCheck).toHaveBeenCalledWith('dev', '2026-11-22');
    expect(deliver).toHaveBeenCalledWith(expect.objectContaining({ title: 'Zbiornik może się skończyć ok. 3:00', body: 'Zostało 9 j. Godziny ciszy trwają do 7:00.' }));
    store.claimPreCheck.mockResolvedValue(false);
    await service.beforeQuiet(new Date('2026-11-22T21:31:00+01:00'));
    expect(deliver).toHaveBeenCalledTimes(1);
  });
});
