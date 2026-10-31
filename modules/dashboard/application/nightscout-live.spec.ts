import { describe, expect, it, vi } from 'vitest';
import { nightscoutEntryObservedAt } from '@modules/integrations/nightscout/application/nightscout-normalizer';
import { NightscoutLive, type LiveNightscoutReader } from './nightscout-live';

const NOW_MS = Date.parse('2026-10-17T18:09:00.000Z');

function reader(overrides: Partial<LiveNightscoutReader> = {}) {
  return {
    fetchRecentEntries: vi.fn(async () => ([
      { type: 'sgv', date: Date.parse('2026-10-17T18:08:39.000Z'), sgv: 124, direction: 'Flat' },
      { type: 'mbg', date: Date.parse('2026-10-17T18:05:00.000Z'), mbg: 130 },
      { type: 'sgv', date: Date.parse('2026-10-17T18:03:39.000Z'), sgv: 121, direction: 'FortyFiveUp' },
    ])),
    fetchLatestDeviceStatus: vi.fn(async () => ({ created_at: '2026-10-17T18:08:50.000Z', pump: { battery: { percent: 51 } } })),
    ...overrides,
  };
}

describe('NightscoutLive', () => {
  it('times a reading by the sensor (date/dateString), as the sync does, not by its upload (sysTime later)', async () => {
    // A Trio entry uploaded 2 min after the sensor read it: the dashboard (widgets and Live Activity alike) must use one time.
    const entry = { type: 'sgv', date: Date.parse('2026-10-17T18:03:39.000Z'), dateString: '2026-10-17T18:03:39.000Z', sysTime: '2026-10-17T18:05:41.000Z', sgv: 121, direction: 'Flat' };
    const live = new NightscoutLive(reader({ fetchRecentEntries: vi.fn(async () => [entry]) }), 'patient-1', () => NOW_MS);
    const data = await live.latest('patient-1');
    expect(data?.readings[0].at).toBe('2026-10-17T18:03:39.000Z');
    expect(nightscoutEntryObservedAt(entry)).toBe('2026-10-17T18:03:39.000Z');
  });

  it('maps CGM entries (sgv only) and the newest devicestatus, asking for the last 30 minutes', async () => {
    const source = reader();
    const live = new NightscoutLive(source, 'patient-1', () => NOW_MS);

    const data = await live.latest('patient-1');

    expect(data?.readings).toEqual([
      { at: '2026-10-17T18:08:39.000Z', value: 124, direction: 'Flat' },
      { at: '2026-10-17T18:03:39.000Z', value: 121, direction: 'FortyFiveUp' },
    ]);
    expect(data?.deviceStatus).toMatchObject({ observed_at: '2026-10-17T18:08:50.000Z', raw_payload: { pump: { battery: { percent: 51 } } } });
    expect(source.fetchRecentEntries).toHaveBeenCalledWith(NOW_MS - 30 * 60_000, 30);
  });

  it('shares one answer for 10 seconds', async () => {
    let now = NOW_MS;
    const source = reader();
    const live = new NightscoutLive(source, 'patient-1', () => now);

    await live.latest('patient-1');
    now += 9_000;
    await live.latest('patient-1');
    expect(source.fetchRecentEntries).toHaveBeenCalledTimes(1);

    now += 2_000;
    await live.latest('patient-1');
    expect(source.fetchRecentEntries).toHaveBeenCalledTimes(2);
  });

  it('gives up on a failing or slow Nightscout (the dashboard then shows synced data) and on another patient', async () => {
    const failing = new NightscoutLive(reader({ fetchLatestDeviceStatus: vi.fn(async () => { throw new Error('503'); }) }), 'patient-1', () => NOW_MS);
    await expect(failing.latest('patient-1')).resolves.toBeNull();

    const slow = new NightscoutLive(reader({ fetchRecentEntries: vi.fn(() => new Promise<never>(() => undefined)) }), 'patient-1', () => NOW_MS, 20);
    await expect(slow.latest('patient-1')).resolves.toBeNull();

    await expect(new NightscoutLive(reader(), 'patient-1', () => NOW_MS).latest('patient-2')).resolves.toBeNull();
  });
});
