import { describe, expect, it, vi } from 'vitest';
import { SecretBox } from '@infra/security/secret-box';
import type { StoredNightscoutCredentials } from '@infra/db/postgres-nightscout-credentials.repository';
import { PatientNightscoutClients, type NightscoutCredentialStore } from './patient-nightscout-clients';
import type { HttpNightscoutClient } from './http-nightscout-client';

const box = SecretBox.fromKey(Buffer.alloc(32, 9));

function memoryStore(initial: Record<string, Partial<StoredNightscoutCredentials>> = {}) {
  const rows = new Map<string, StoredNightscoutCredentials>();
  for (const [patientId, row] of Object.entries(initial)) {
    rows.set(patientId, { source_id: `s-${patientId}`, patient_id: patientId, enabled: true, base_url: null, auth_mode: null, api_token_ciphertext: null, credentials_updated_at: null, ...row });
  }
  const store: NightscoutCredentialStore & { rows: typeof rows } = {
    rows,
    getNightscoutCredentials: vi.fn(async (patientId: string) => rows.get(patientId) ?? null),
    saveNightscoutCredentials: vi.fn(async (input) => {
      const existing = rows.get(input.patientId);
      if (input.onlyIfMissing && existing?.api_token_ciphertext) return null;
      const row: StoredNightscoutCredentials = {
        source_id: existing?.source_id ?? `s-${input.patientId}`,
        patient_id: input.patientId,
        enabled: existing?.enabled ?? true,
        base_url: new URL(input.baseUrl).origin,
        auth_mode: input.authMode,
        api_token_ciphertext: input.tokenCiphertext,
        credentials_updated_at: '2026-10-27T10:00:00.000Z',
      };
      rows.set(input.patientId, row);
      return row;
    }),
  };
  return store;
}

function fakeClientFactory() {
  const created: Array<{ baseUrl: string; token: string; authMode: string; client: HttpNightscoutClient }> = [];
  const createClient = (baseUrl: string, token: string, authMode: string) => {
    const client = {
      fetchEntries: vi.fn(async () => ({ entries: [{ sgv: 100, baseUrl }], next_cursor: null })),
      fetchTreatments: vi.fn(async () => ({ treatments: [], next_cursor: null })),
      fetchDeviceStatuses: vi.fn(async () => ({ device_statuses: [], next_cursor: null })),
      fetchProfiles: vi.fn(async () => ({ profiles: [], next_cursor: null })),
    } as unknown as HttpNightscoutClient;
    created.push({ baseUrl, token, authMode, client });
    return client;
  };
  return { created, createClient };
}

describe('PatientNightscoutClients', () => {
  it('routes each sync request to the Nightscout of the patient named in it', async () => {
    const store = memoryStore({
      a: { base_url: 'https://a.example', auth_mode: 'ACCESS_TOKEN_JWT', api_token_ciphertext: box.encrypt('token-a') },
      b: { base_url: 'https://b.example', auth_mode: 'BEARER', api_token_ciphertext: box.encrypt('token-b') },
    });
    const factory = fakeClientFactory();
    const clients = new PatientNightscoutClients(store, box, { createClient: factory.createClient });

    const a = await clients.fetchEntries({ patient_id: 'a', cursor: null, limit: 10 });
    const b = await clients.fetchEntries({ patient_id: 'b', cursor: null, limit: 10 });

    expect(a.entries[0]).toMatchObject({ baseUrl: 'https://a.example' });
    expect(b.entries[0]).toMatchObject({ baseUrl: 'https://b.example' });
    expect(factory.created.map(({ token, authMode }) => [token, authMode])).toEqual([['token-a', 'ACCESS_TOKEN_JWT'], ['token-b', 'BEARER']]);
  });

  it('refuses (not retryable) a patient without an enabled, complete source', async () => {
    const store = memoryStore({
      off: { enabled: false, base_url: 'https://off.example', api_token_ciphertext: box.encrypt('t') },
      empty: { base_url: 'https://empty.example' },
    });
    const clients = new PatientNightscoutClients(store, box, { createClient: fakeClientFactory().createClient });

    for (const patient_id of ['off', 'empty', 'missing']) {
      await expect(clients.fetchTreatments({ patient_id, cursor: null, limit: 1 })).rejects.toMatchObject({ message: 'NIGHTSCOUT_SOURCE_NOT_CONFIGURED', retryable: false });
    }
    expect(await clients.forPatient('off')).toBeNull();
  });

  it('keeps the client (and its exchanged JWT) while the stored source is unchanged and rebuilds it after a change', async () => {
    let now = 0;
    const store = memoryStore({ a: { base_url: 'https://a.example', auth_mode: 'BEARER', api_token_ciphertext: box.encrypt('old') } });
    const factory = fakeClientFactory();
    const clients = new PatientNightscoutClients(store, box, { createClient: factory.createClient, nowMs: () => now });

    const first = await clients.forPatient('a');
    now += 60_000;
    expect(await clients.forPatient('a')).toBe(first);
    expect(store.getNightscoutCredentials).toHaveBeenCalledTimes(2);

    store.rows.set('a', { ...store.rows.get('a')!, api_token_ciphertext: box.encrypt('new') });
    now += 60_000;
    const second = await clients.forPatient('a');
    expect(second).not.toBe(first);
    expect(factory.created.map((c) => c.token)).toEqual(['old', 'new']);
  });

  it('seeds the env patient once, never overrides a stored token and stores only ciphertext', async () => {
    const store = memoryStore();
    const factory = fakeClientFactory();
    const clients = new PatientNightscoutClients(store, box, { createClient: factory.createClient });
    const env = { NIGHTSCOUT_PATIENT_ID: 'a', NIGHTSCOUT_BASE_URL: 'https://a.example/', NIGHTSCOUT_API_TOKEN: 'env-token', NIGHTSCOUT_AUTH_MODE: 'access_token_jwt' };

    await expect(clients.seedFromEnv(env)).resolves.toEqual({ status: 'SEEDED', patient_id: 'a' });
    const stored = store.rows.get('a')!;
    expect(stored).toMatchObject({ base_url: 'https://a.example', auth_mode: 'ACCESS_TOKEN_JWT' });
    expect(stored.api_token_ciphertext).not.toContain('env-token');
    expect(box.decrypt(stored.api_token_ciphertext!)).toBe('env-token');

    await expect(clients.seedFromEnv({ ...env, NIGHTSCOUT_BASE_URL: 'https://other.example', NIGHTSCOUT_API_TOKEN: 'other' }))
      .resolves.toEqual({ status: 'ALREADY_STORED', patient_id: 'a', env_address_differs: true });
    expect(box.decrypt(store.rows.get('a')!.api_token_ciphertext!)).toBe('env-token');

    await expect(clients.seedFromEnv({})).resolves.toEqual({ status: 'NO_ENV_SOURCE' });
  });
});
