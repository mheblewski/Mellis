import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OFFLINE_NIGHTSCOUT_CLIENT, parseSyncOnceArgs, runSyncOnce, type SyncOnceDependencies } from './nightscout-sync-once';

// Offline: every dependency is a fake; no pg pool, no HTTP client, no database or Nightscout traffic.

const PATIENT_ID = '11111111-1111-4111-8111-111111111111';
const SOURCE_ID = 'aaaaaaaa-0000-4000-8000-000000000001';

function setup(envOverrides: Record<string, string | undefined> = {}) {
  const env: NodeJS.ProcessEnv = {
    DATABASE_URL: 'postgresql://offline-test-invalid@127.0.0.1:1/offline_no_db',
    NIGHTSCOUT_BASE_URL: 'https://nightscout.example.invalid',
    NIGHTSCOUT_API_TOKEN: 'synthetic-test-token',
    NIGHTSCOUT_PATIENT_ID: PATIENT_ID,
    ...envOverrides,
  };
  const pool = { end: vi.fn(async () => undefined) };
  const service = {
    ensureNightscoutSource: vi.fn(async (patientId: string) => ({ id: SOURCE_ID, patient_id: patientId })),
    runNightscoutSyncJob: vi.fn(async () => ({ entries: {} })),
    runNightscoutSyncWindow: vi.fn(async () => ({ entries: {} })),
  };
  const httpClient = { fetchEntries: vi.fn(), fetchTreatments: vi.fn() };
  const lines: string[] = [];
  const deps = {
    env,
    createPool: vi.fn(() => pool),
    createService: vi.fn(() => service),
    createHttpClient: vi.fn(() => httpClient),
    listSourceIds: vi.fn(async () => [SOURCE_ID]),
    now: () => '2026-10-15T08:00:00.000Z',
    out: (line: string) => lines.push(line),
  } as unknown as SyncOnceDependencies;
  return { deps, pool, service, httpClient, lines, createPool: deps.createPool as ReturnType<typeof vi.fn>, createHttpClient: deps.createHttpClient as ReturnType<typeof vi.fn>, createService: deps.createService as ReturnType<typeof vi.fn> };
}

describe('nightscout-sync-once arguments', () => {
  it('accepts ensure-source, live and a valid window', () => {
    expect(parseSyncOnceArgs(['ensure-source'])).toEqual({ mode: 'ensure-source' });
    expect(parseSyncOnceArgs(['live'])).toEqual({ mode: 'live' });
    expect(parseSyncOnceArgs(['window', '2026-10-13T22:00:00Z', '2026-10-14T22:00:00Z']))
      .toEqual({ mode: 'window', fromIso: '2026-10-13T22:00:00.000Z', toIso: '2026-10-14T22:00:00.000Z' });
  });

  it('refuses unknown modes, extra arguments and invalid or inverted windows', () => {
    for (const argv of [[], ['sync'], ['ensure-source', 'extra'], ['live', 'x'], ['window'], ['window', 'not-a-date', '2026-10-14T00:00:00Z'], ['window', '2026-10-14T00:00:00Z', '2026-10-13T00:00:00Z'], ['window', '2026-10-14T00:00:00Z', '2026-10-14T00:00:00Z']]) {
      expect(() => parseSyncOnceArgs(argv)).toThrow();
    }
  });
});

describe('nightscout-sync-once ensure-source', () => {
  it('registers the source through ensureNightscoutSource only: no sync, no HTTP client, no listing', async () => {
    const { deps, service, lines, pool, createHttpClient, createService } = setup();
    await runSyncOnce(['ensure-source'], deps);

    expect(service.ensureNightscoutSource).toHaveBeenCalledTimes(1);
    expect(service.ensureNightscoutSource).toHaveBeenCalledWith(PATIENT_ID, 'https://nightscout.example.invalid');
    expect(service.runNightscoutSyncJob).not.toHaveBeenCalled();
    expect(service.runNightscoutSyncWindow).not.toHaveBeenCalled();
    expect(createHttpClient).not.toHaveBeenCalled();
    expect(deps.listSourceIds).not.toHaveBeenCalled();
    // The service gets a client that cannot fetch.
    expect(createService.mock.calls[0][1]).toBe(OFFLINE_NIGHTSCOUT_CLIENT);
    expect(pool.end).toHaveBeenCalledTimes(1);
    expect(lines).toEqual([JSON.stringify({ mode: 'ensure-source', source: SOURCE_ID.slice(0, 8), patient_matches: true })]);
  });

  it('does not need the Nightscout API token', async () => {
    const { deps, service } = setup({ NIGHTSCOUT_API_TOKEN: undefined });
    await runSyncOnce(['ensure-source'], deps);
    expect(service.ensureNightscoutSource).toHaveBeenCalledTimes(1);
  });

  it('refuses missing or malformed configuration before creating a pool', async () => {
    for (const [overrides, message] of [
      [{ NIGHTSCOUT_PATIENT_ID: undefined }, 'NIGHTSCOUT_PATIENT_ID'],
      [{ NIGHTSCOUT_PATIENT_ID: 'patient-1' }, 'NIGHTSCOUT_PATIENT_ID must be a UUID'],
      [{ NIGHTSCOUT_BASE_URL: '' }, 'NIGHTSCOUT_BASE_URL'],
      [{ DATABASE_URL: undefined }, 'DATABASE_URL'],
    ] as const) {
      const { deps, createPool, service } = setup(overrides);
      await expect(runSyncOnce(['ensure-source'], deps)).rejects.toThrow(message);
      expect(createPool).not.toHaveBeenCalled();
      expect(service.ensureNightscoutSource).not.toHaveBeenCalled();
    }
  });

  it('prints no secrets or connection details', async () => {
    const { deps, lines } = setup();
    await runSyncOnce(['ensure-source'], deps);
    const output = lines.join('\n');
    for (const secret of ['synthetic-test-token', 'postgresql://', 'nightscout.example.invalid', PATIENT_ID]) {
      expect(output).not.toContain(secret);
    }
  });

  it('uses an offline client that refuses to fetch', async () => {
    await expect(OFFLINE_NIGHTSCOUT_CLIENT.fetchEntries({ patient_id: PATIENT_ID, cursor: null, limit: 1 })).rejects.toThrow('must not fetch');
    await expect(OFFLINE_NIGHTSCOUT_CLIENT.fetchTreatments({ patient_id: PATIENT_ID, cursor: null, limit: 1 })).rejects.toThrow('must not fetch');
    await expect(OFFLINE_NIGHTSCOUT_CLIENT.fetchDeviceStatuses!({ patient_id: PATIENT_ID, cursor: null, limit: 1 })).rejects.toThrow('must not fetch');
    await expect(OFFLINE_NIGHTSCOUT_CLIENT.fetchProfiles!({ patient_id: PATIENT_ID, cursor: null, limit: 1 })).rejects.toThrow('must not fetch');
  });
});

describe('nightscout-sync-once live and window (unchanged behaviour)', () => {
  it('window runs the historical window for each listed source and never ensures a source', async () => {
    const { deps, service, createHttpClient } = setup();
    await runSyncOnce(['window', '2026-10-13T22:00:00Z', '2026-10-14T22:00:00Z'], deps);
    expect(createHttpClient).toHaveBeenCalledTimes(1);
    expect(service.runNightscoutSyncWindow).toHaveBeenCalledWith(SOURCE_ID, '2026-10-15T08:00:00.000Z', '2026-10-13T22:00:00.000Z', '2026-10-14T22:00:00.000Z');
    expect(service.runNightscoutSyncJob).not.toHaveBeenCalled();
    expect(service.ensureNightscoutSource).not.toHaveBeenCalled();
  });

  it('live and window still require the Nightscout API token', async () => {
    for (const argv of [['live'], ['window', '2026-10-13T22:00:00Z', '2026-10-14T22:00:00Z']]) {
      const { deps, createPool } = setup({ NIGHTSCOUT_API_TOKEN: undefined });
      await expect(runSyncOnce(argv, deps)).rejects.toThrow('NIGHTSCOUT_API_TOKEN');
      expect(createPool).not.toHaveBeenCalled();
    }
  });

  it('loads dotenv only when run as a script, not on import', () => {
    const source = readFileSync(join(__dirname, 'nightscout-sync-once.ts'), 'utf8');
    expect(source).not.toMatch(/^import ['"]dotenv\/config['"]/m);
    const entry = source.slice(source.indexOf('if (require.main === module)'));
    expect(entry).toContain("require('dotenv').config()");
  });
});
