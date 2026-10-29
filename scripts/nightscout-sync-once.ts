/**
 * Run a single Nightscout operation outside the worker job loop (no AI work is executed; any hypo-detection
 * jobs the import enqueues stay pending until a worker processes them).
 *
 *   tsx scripts/nightscout-sync-once.ts ensure-source
 *   tsx scripts/nightscout-sync-once.ts live
 *   tsx scripts/nightscout-sync-once.ts window <from-iso> <to-iso>
 *
 * `ensure-source` registers (or refreshes the configuration of) the Nightscout source for NIGHTSCOUT_PATIENT_ID with
 * the same NightscoutSyncService.ensureNightscoutSource the worker uses; it fetches nothing and enqueues nothing.
 * `live` runs the normal cursor-based job. `window` imports [from, to] with HISTORICAL ingestion origin
 * (idempotent per source record; HISTORICAL hypo episodes create no conversation and no analysis.follow_up job).
 * Prints counts only.
 */
import { Pool } from 'pg';
import { PostgresNightscoutRepository } from '@infra/db/postgres-nightscout.repository';
import { PostgresGlucoMindRepository } from '@infra/db/postgres-glucomind.repository';
import { NightscoutSyncService } from '@modules/integrations/nightscout/application/nightscout-sync.service';
import type { NightscoutClient } from '@modules/integrations/nightscout/application/nightscout-client';
import { HttpNightscoutClient } from '@modules/integrations/nightscout/infrastructure/http-nightscout-client';

export type SyncOnceCommand =
  | { mode: 'ensure-source' }
  | { mode: 'live' }
  | { mode: 'window'; fromIso: string; toIso: string };

const USAGE = 'Usage: nightscout-sync-once.ts ensure-source | live | window <from-iso> <to-iso>';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseSyncOnceArgs(argv: readonly string[]): SyncOnceCommand {
  const [mode, ...rest] = argv;
  if ((mode === 'ensure-source' || mode === 'live') && rest.length === 0) {
    return { mode };
  }
  if (mode === 'window' && rest.length === 2) {
    const [fromRaw, toRaw] = rest;
    const fromMs = Date.parse(fromRaw);
    const toMs = Date.parse(toRaw);
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs >= toMs) {
      throw new Error('window needs two valid ISO timestamps with <from-iso> before <to-iso>');
    }
    return { mode, fromIso: new Date(fromMs).toISOString(), toIso: new Date(toMs).toISOString() };
  }
  throw new Error(USAGE);
}

/** Stands in for the HTTP client where a mode must not reach Nightscout: any call fails instead of fetching. */
export const OFFLINE_NIGHTSCOUT_CLIENT: NightscoutClient = {
  fetchEntries: async () => {
    throw new Error('ensure-source must not fetch from Nightscout');
  },
  fetchTreatments: async () => {
    throw new Error('ensure-source must not fetch from Nightscout');
  },
  fetchDeviceStatuses: async () => {
    throw new Error('ensure-source must not fetch from Nightscout');
  },
  fetchProfiles: async () => {
    throw new Error('ensure-source must not fetch from Nightscout');
  },
};

type SyncOnceService = Pick<NightscoutSyncService, 'ensureNightscoutSource' | 'runNightscoutSyncJob' | 'runNightscoutSyncWindow'>;

export interface SyncOnceDependencies {
  env: NodeJS.ProcessEnv;
  createPool: (connectionString: string) => Pool;
  createService: (pool: Pool, client: NightscoutClient) => SyncOnceService;
  createHttpClient: (baseUrl: string, apiToken: string, authMode: string | undefined) => NightscoutClient;
  listSourceIds: (pool: Pool) => Promise<string[]>;
  now: () => string;
  out: (line: string) => void;
}

export const defaultSyncOnceDependencies = (env: NodeJS.ProcessEnv = process.env): SyncOnceDependencies => ({
  env,
  createPool: (connectionString) => new Pool({ connectionString }),
  createService: (pool, client) => new NightscoutSyncService(
    new PostgresNightscoutRepository(pool),
    new PostgresGlucoMindRepository(pool),
    client,
  ),
  createHttpClient: (baseUrl, apiToken, authMode) => new HttpNightscoutClient(baseUrl, apiToken, authMode as 'BEARER' | 'API_SECRET_SHA1' | 'ACCESS_TOKEN_JWT' | undefined),
  listSourceIds: async (pool) => (await new PostgresNightscoutRepository(pool).listNightscoutSources()).map((source) => source.id),
  now: () => new Date().toISOString(),
  out: (line) => console.log(line),
});

export async function runSyncOnce(argv: readonly string[], deps: SyncOnceDependencies): Promise<void> {
  // Arguments and configuration are validated before any database pool or client exists.
  const command = parseSyncOnceArgs(argv);
  const required = (name: string) => {
    const value = deps.env[name]?.trim();
    if (!value) throw new Error(`Missing required environment variable: ${name}`);
    return value;
  };
  const databaseUrl = required('DATABASE_URL');
  const baseUrl = required('NIGHTSCOUT_BASE_URL');

  if (command.mode === 'ensure-source') {
    const patientId = required('NIGHTSCOUT_PATIENT_ID');
    if (!UUID_PATTERN.test(patientId)) {
      throw new Error('NIGHTSCOUT_PATIENT_ID must be a UUID');
    }
    const pool = deps.createPool(databaseUrl);
    try {
      const source = await deps.createService(pool, OFFLINE_NIGHTSCOUT_CLIENT).ensureNightscoutSource(patientId, baseUrl);
      deps.out(JSON.stringify({ mode: command.mode, source: source.id.slice(0, 8), patient_matches: source.patient_id === patientId }));
    } finally {
      await pool.end();
    }
    return;
  }

  const client = deps.createHttpClient(baseUrl, required('NIGHTSCOUT_API_TOKEN'), deps.env.NIGHTSCOUT_AUTH_MODE);
  const pool = deps.createPool(databaseUrl);
  try {
    const service = deps.createService(pool, client);
    for (const sourceId of await deps.listSourceIds(pool)) {
      const nowIso = deps.now();
      const result = command.mode === 'live'
        ? await service.runNightscoutSyncJob(sourceId, nowIso)
        : await service.runNightscoutSyncWindow(sourceId, nowIso, command.fromIso, command.toIso);
      deps.out(JSON.stringify({ mode: command.mode, source: sourceId.slice(0, 8), result }));
    }
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  // Loaded only when run as a script, never on import (tests import this module).
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('dotenv').config();
  void runSyncOnce(process.argv.slice(2), defaultSyncOnceDependencies()).catch((error: unknown) => {
    console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
    process.exitCode = 1;
  });
}
