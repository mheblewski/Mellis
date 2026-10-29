import { describe, expect, it, vi } from 'vitest';
import { PatientNightscoutReaders, type PatientNightscoutDirectory } from './patient-nightscout-readers';

function fakeClient(sgv: number) {
  return {
    fetchRecentEntries: vi.fn(async () => [{ sgv, date: Date.now(), dateString: new Date().toISOString() }]),
    fetchLatestDeviceStatus: vi.fn(async () => null),
    fetchLatestTreatmentOfType: vi.fn(async () => null),
    fetchDeviceStatusesBetween: vi.fn(async () => []),
  };
}

describe('PatientNightscoutReaders', () => {
  it('reads each patient from their own Nightscout and nothing for a patient without one', async () => {
    const clients: Record<string, ReturnType<typeof fakeClient>> = { a: fakeClient(101), b: fakeClient(202) };
    const directory: PatientNightscoutDirectory = { forPatient: vi.fn(async (id: string) => clients[id] ?? null) };
    const readers = new PatientNightscoutReaders(directory);

    await readers.live.latest('a');
    await readers.live.latest('b');
    expect(clients.a.fetchRecentEntries).toHaveBeenCalledTimes(1);
    expect(clients.b.fetchRecentEntries).toHaveBeenCalledTimes(1);
    await expect(readers.live.latest('c')).resolves.toBeNull();
    await expect(readers.careEvents.latest('c')).resolves.toBeNull();
  });

  it('falls back to the synced data when the directory fails (no key, unreadable token)', async () => {
    const readers = new PatientNightscoutReaders({ forPatient: vi.fn(async () => { throw new Error('SECRET_DECRYPT_FAILED'); }) });
    await expect(readers.live.latest('a')).resolves.toBeNull();
  });
});
