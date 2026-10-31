import { describe, expect, it, vi } from 'vitest';
import { NightscoutCareEvents, type LatestTreatmentReader } from './nightscout-care-events';

const NOW_MS = Date.parse('2026-10-17T12:41:00.000Z');

function readerWith(byType: Record<string, string | null>, reservoirLevels: unknown[] = []) {
  return {
    fetchLatestTreatmentOfType: vi.fn(async (eventType: string) => {
      const createdAt = byType[eventType] ?? null;
      return createdAt ? { eventType, created_at: createdAt } : null;
    }),
    fetchDeviceStatusesBetween: vi.fn(async () => reservoirLevels.map((reservoir) => ({ pump: { reservoir } }))),
  } satisfies LatestTreatmentReader;
}

describe('NightscoutCareEvents', () => {
  it('takes the newest site change and the newer of sensor start and sensor change', async () => {
    const reader = readerWith({
      'Site Change': '2026-10-16T09:10:00.000Z',
      'Sensor Start': '2026-10-12T15:30:00.000Z',
      'Sensor Change': '2026-10-12T15:00:00.000Z',
    });
    const careEvents = new NightscoutCareEvents(reader, 'patient-1', () => NOW_MS);

    await expect(careEvents.latest('patient-1')).resolves.toEqual({
      site_changed_at: '2026-10-16T09:10:00.000Z',
      sensor_started_at: '2026-10-12T15:30:00.000Z',
      reservoir_changed_at: null,
      reservoir_filled_units: null,
    });
    expect(reader.fetchLatestTreatmentOfType).toHaveBeenCalledWith('Site Change', '2026-09-17T12:41:00.000Z');
  });

  it('caches the answer for 2 minutes', async () => {
    let now = NOW_MS;
    const reader = readerWith({ 'Site Change': '2026-10-16T09:10:00.000Z' });
    const careEvents = new NightscoutCareEvents(reader, 'patient-1', () => now);

    await careEvents.latest('patient-1');
    now += 60_000;
    await careEvents.latest('patient-1');
    expect(reader.fetchLatestTreatmentOfType).toHaveBeenCalledTimes(4);

    now += 61_000;
    await careEvents.latest('patient-1');
    expect(reader.fetchLatestTreatmentOfType).toHaveBeenCalledTimes(8);
  });

  it('answers null for another patient and when Nightscout fails, without caching the failure', async () => {
    const reader = readerWith({});
    reader.fetchLatestTreatmentOfType.mockRejectedValueOnce(new Error('timeout'));
    const careEvents = new NightscoutCareEvents(reader, 'patient-1', () => NOW_MS);

    await expect(careEvents.latest('patient-2')).resolves.toBeNull();
    await expect(careEvents.latest('patient-1')).resolves.toBeNull();
    await expect(careEvents.latest('patient-1')).resolves.toEqual({ site_changed_at: null, sensor_started_at: null, reservoir_changed_at: null, reservoir_filled_units: null });
  });

  it('reads the fill as the highest level in the hour after the last "Insulin Change", once per change', async () => {
    let now = NOW_MS;
    const reader = readerWith({ 'Insulin Change': '2026-10-14T10:51:44.000Z' }, [3995, 182.5, 180.2, 'n/a']);
    const careEvents = new NightscoutCareEvents(reader, 'patient-1', () => now);

    await expect(careEvents.latest('patient-1')).resolves.toMatchObject({ reservoir_changed_at: '2026-10-14T10:51:44.000Z', reservoir_filled_units: 182.5 });
    expect(reader.fetchDeviceStatusesBetween).toHaveBeenCalledWith('2026-10-14T10:51:44.000Z', '2026-10-14T11:51:44.000Z', 30);

    now += 3 * 60_000;
    await careEvents.latest('patient-1');
    expect(reader.fetchDeviceStatusesBetween).toHaveBeenCalledTimes(1);
  });

  it('leaves the fill unknown when Nightscout has no levels after the change', async () => {
    const careEvents = new NightscoutCareEvents(readerWith({ 'Insulin Change': '2026-10-14T10:51:44.000Z' }, []), 'patient-1', () => NOW_MS);

    await expect(careEvents.latest('patient-1')).resolves.toMatchObject({ reservoir_filled_units: null });
  });

  it('asks again for an unknown fill (a refresh right at the change) instead of keeping it for the whole reservoir', async () => {
    let now = NOW_MS;
    const levels: unknown[] = [];
    const reader = readerWith({ 'Insulin Change': '2026-10-17T12:40:00.000Z' }, levels);
    reader.fetchDeviceStatusesBetween.mockImplementation(async () => levels.map((reservoir) => ({ pump: { reservoir } })));
    const careEvents = new NightscoutCareEvents(reader, 'patient-1', () => now);

    await expect(careEvents.latest('patient-1')).resolves.toMatchObject({ reservoir_filled_units: null });
    levels.push(178.4);
    now += 3 * 60_000;
    await expect(careEvents.latest('patient-1')).resolves.toMatchObject({ reservoir_filled_units: null });
    now += 10 * 60_000;
    await expect(careEvents.latest('patient-1')).resolves.toMatchObject({ reservoir_filled_units: 178.4 });
    now += 60 * 60_000;
    await careEvents.latest('patient-1');
    expect(reader.fetchDeviceStatusesBetween).toHaveBeenCalledTimes(2);
  });
});
