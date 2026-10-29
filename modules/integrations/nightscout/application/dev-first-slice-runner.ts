import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { Pool } from 'pg';
import { DatabaseModule } from '@infra/db/database.module';
import { DATABASE_POOL } from '@infra/db/database.tokens';
import { PostgresGlucoMindRepository } from '@infra/db/postgres-glucomind.repository';
import { PostgresNightscoutRepository } from '@infra/db/postgres-nightscout.repository';
import { NightscoutSyncService } from './nightscout-sync.service';
import { NightscoutClient } from './nightscout-client';
import { AiGatewayService } from '@modules/ai-gateway/application/ai-gateway.service';
import { FakeAiProvider } from '@modules/ai-gateway/infrastructure/fake-ai-provider';
import { FakePushNotificationProvider } from '@modules/notifications/infrastructure/fake-push-notification-provider';
import { PushNotificationService } from '@modules/notifications/application/push-notification.service';
import { WorkerService } from '../../../../apps/worker/src/worker.service';
import { truncatePublicTablesForIntegrationTests } from '@infra/db/postgres-test-isolation';

const DEV_PATIENT_ID = '11111111-1111-4111-8111-111111111111';
const DEV_USER_ID = '22222222-2222-4222-8222-222222222222';
const DEFAULT_PATIENT_LABEL = 'patient-1';
const DEFAULT_USER_LABEL = 'dev-user-1';
const DEFAULT_NIGHTSCOUT_BASE_URL = 'https://nightscout.example.com';

interface SyntheticEntry {
  _id: string;
  date: number;
  dateString: string;
  patient: string;
  sgv: number;
  units: 'mg/dL';
}

class SyntheticNightscoutClient implements NightscoutClient {
  constructor(private readonly entries: SyntheticEntry[]) {}

  async fetchEntries(_input: { patient_id: string; cursor: string | null; limit: number }): Promise<{ entries: Record<string, unknown>[]; next_cursor: string | null }> {
    return {
      entries: this.entries as unknown as Record<string, unknown>[],
      next_cursor: null,
    };
  }

  async fetchTreatments(_input: { patient_id: string; cursor: string | null; limit: number }): Promise<{ treatments: Record<string, unknown>[]; next_cursor: string | null }> {
    return {
      treatments: [],
      next_cursor: null,
    };
  }

  async fetchDeviceStatuses(_input: { patient_id: string; cursor: string | null; limit: number }): Promise<{ device_statuses: Record<string, unknown>[]; next_cursor: string | null }> {
    return {
      device_statuses: [],
      next_cursor: null,
    };
  }

  async fetchProfiles(_input: { patient_id: string; cursor: string | null; limit: number }): Promise<{ profiles: Record<string, unknown>[]; next_cursor: string | null }> {
    return {
      profiles: [],
      next_cursor: null,
    };
  }
}

// Taken once per process, so repeated runs import the same readings (deduplicated) instead of a new hypo each time.
const SCENARIO_ANCHOR_MS = Date.now();

/**
 * A low reading and the recovery after it, both recent (readings younger than the 30-minute freshness guard): a LIVE
 * hypo episode opens and closes. Since 2026-10-25 (e3acc11) nothing is asked or pushed about it after the fact: no
 * conversation, no question card, no "Podsumowanie po hipo" push.
 */
function syntheticHypoEntries(patientId: string): SyntheticEntry[] {
  const entry = (id: string, minutesAgo: number, sgv: number): SyntheticEntry => {
    const date = SCENARIO_ANCHOR_MS - minutesAgo * 60_000;
    return { _id: id, date, dateString: new Date(date).toISOString(), patient: patientId, sgv, units: 'mg/dL' };
  };
  // The hypo ends 15 min after its last low reading (the consensus end of an episode): the recovery comes 19 min later.
  return [entry('dev-first-slice-entry-68', 22, 68), entry('dev-first-slice-entry-95', 3, 95)];
}

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), DatabaseModule],
})
class DevFirstSliceModule {}

export interface DevFirstSliceConfig {
  databaseUrl: string;
  patientId: string;
  userId: string;
  patientLabel: string;
  userLabel: string;
  nightscoutBaseUrl: string;
  maxWaitMs: number;
  pollIntervalMs: number;
}

/** The scenario's closed hypo episode. */
export interface DevFirstSliceHypo {
  episode_id: string;
  started_at: string;
  ended_at: string;
}

export interface DevFirstSliceReadyState {
  patientId: string;
  hypo: DevFirstSliceHypo;
  /** What the caregiver is sent about it: always nothing since 2026-10-25 (checked, so a regression shows here). */
  conversations: number;
  queuedHypoPushes: number;
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value?.trim()) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer, got: ${value}`);
  }

  return parsed;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function getDevFirstSliceConfigFromEnv(): DevFirstSliceConfig {
  const databaseUrl = requireEnv('DATABASE_URL');
  const patientId = (process.env.DEV_FIRST_SLICE_PATIENT_ID ?? DEV_PATIENT_ID).trim();
  const userId = (process.env.DEV_FIRST_SLICE_USER_ID ?? DEV_USER_ID).trim();

  if (!isUuid(patientId)) {
    throw new Error(`DEV_FIRST_SLICE_PATIENT_ID must be a UUID. Received: ${patientId}`);
  }

  if (!isUuid(userId)) {
    throw new Error(`DEV_FIRST_SLICE_USER_ID must be a UUID. Received: ${userId}`);
  }

  return {
    databaseUrl,
    patientId,
    userId,
    patientLabel: (process.env.DEV_FIRST_SLICE_PATIENT_LABEL ?? DEFAULT_PATIENT_LABEL).trim(),
    userLabel: (process.env.DEV_FIRST_SLICE_USER_LABEL ?? DEFAULT_USER_LABEL).trim(),
    nightscoutBaseUrl: (process.env.NIGHTSCOUT_BASE_URL ?? DEFAULT_NIGHTSCOUT_BASE_URL).trim(),
    maxWaitMs: parsePositiveInt(process.env.DEV_FIRST_SLICE_MAX_WAIT_MS, 30_000),
    pollIntervalMs: parsePositiveInt(process.env.DEV_FIRST_SLICE_POLL_MS, 300),
  };
}

async function ensureDevActors(pool: Pool, config: DevFirstSliceConfig): Promise<void> {
  await pool.query(
    `
      INSERT INTO users (id, display_name)
      VALUES ($1::uuid, $2)
      ON CONFLICT (id)
      DO UPDATE SET
        display_name = EXCLUDED.display_name,
        updated_at = now()
    `,
    [config.userId, config.userLabel],
  );

  await pool.query(
    `
      INSERT INTO patients (id, display_name)
      VALUES ($1::uuid, $2)
      ON CONFLICT (id)
      DO UPDATE SET
        display_name = EXCLUDED.display_name,
        updated_at = now()
    `,
    [config.patientId, config.patientLabel],
  );

  await pool.query(
    `
      INSERT INTO caregiver_relationships (user_id, patient_id, relationship_type, permissions)
      VALUES ($1::uuid, $2::uuid, 'primary_caregiver', '{}'::jsonb)
      ON CONFLICT (user_id, patient_id, relationship_type)
      DO UPDATE SET
        updated_at = now()
    `,
    [config.userId, config.patientId],
  );
}

async function verifyDatabaseReady(pool: Pool): Promise<void> {
  try {
    await pool.query('SELECT 1 FROM schema_migrations LIMIT 1');
  } catch {
    throw new Error('Database is not migrated for GlucoMind. Run npm run migrate against the configured DATABASE_URL.');
  }
}

export async function resetDevFirstSliceScenario(config = getDevFirstSliceConfigFromEnv()): Promise<void> {
  const pool = new Pool({ connectionString: config.databaseUrl });
  try {
    if (process.env.RUN_POSTGRES_INTEGRATION === '1') {
      await truncatePublicTablesForIntegrationTests(pool);
      return;
    }

    const tablesResult = await pool.query<{ table_name: string }>(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name NOT IN ('schema_migrations')
      ORDER BY table_name
    `);

    const tableNames = tablesResult.rows.map((row) => `"${row.table_name}"`).join(', ');
    if (tableNames) {
      await pool.query(`TRUNCATE TABLE ${tableNames} CASCADE`);
    }
  } catch (error) {
    throw error;
  } finally {
    await pool.end();
  }
}

async function findClosedHypo(pool: Pool, patientId: string): Promise<DevFirstSliceHypo | null> {
  const result = await pool.query<{ id: string; started_at: Date; ended_at: Date }>(
    `SELECT id::text AS id, started_at, ended_at FROM hypo_episodes
     WHERE patient_id = $1::uuid AND ended_at IS NOT NULL ORDER BY started_at DESC LIMIT 1`,
    [patientId],
  );
  const row = result.rows[0];
  return row ? { episode_id: row.id, started_at: new Date(row.started_at).toISOString(), ended_at: new Date(row.ended_at).toISOString() } : null;
}

/** What reached the caregiver about the scenario's hypos: conversations and queued hypo pushes. */
async function caregiverOutreach(pool: Pool, patientId: string): Promise<{ conversations: number; queuedHypoPushes: number }> {
  const conversations = await pool.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM conversations WHERE patient_id = $1::uuid AND episode_id IS NOT NULL',
    [patientId],
  );
  const pushes = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM jobs WHERE job_type LIKE 'notifications.%' AND patient_id = $1::uuid`,
    [patientId],
  );
  return { conversations: Number(conversations.rows[0].count), queuedHypoPushes: Number(pushes.rows[0].count) };
}

export async function runDevFirstSliceScenario(config = getDevFirstSliceConfigFromEnv()): Promise<DevFirstSliceReadyState> {
  if (!config.nightscoutBaseUrl) {
    throw new Error('NIGHTSCOUT_BASE_URL is required');
  }

  const app = await NestFactory.createApplicationContext(DevFirstSliceModule, {
    logger: ['error', 'warn'],
  });

  try {
    const pool = app.get<Pool>(DATABASE_POOL);
    await verifyDatabaseReady(pool);
    await ensureDevActors(pool, config);

    const repository = app.get(PostgresGlucoMindRepository, { strict: false });
    const nightscoutRepository = app.get(PostgresNightscoutRepository, { strict: false });
    const configService = app.get(ConfigService);
    if (!repository || !nightscoutRepository) {
      throw new Error('Database repositories are unavailable. Ensure migrations are up to date and DatabaseModule is configured.');
    }

    const nightscoutClient = new SyntheticNightscoutClient(syntheticHypoEntries(config.patientId));
    const nightscoutSyncService = new NightscoutSyncService(nightscoutRepository, repository, nightscoutClient);
    const aiGateway = new AiGatewayService(new FakeAiProvider());
    const pushNotificationService = new PushNotificationService(new FakePushNotificationProvider());
    const worker = new WorkerService(repository, nightscoutSyncService, configService, aiGateway, pushNotificationService);

    await nightscoutSyncService.ensureNightscoutSource(config.patientId, config.nightscoutBaseUrl);
    await nightscoutSyncService.enqueueRecurringSyncJobs(new Date().toISOString());

    const deadline = Date.now() + config.maxWaitMs;
    let found: DevFirstSliceHypo | null = null;

    while (Date.now() < deadline) {
      // Syncs run on their own lane (fresh-glucose.v1): both lanes, one step each.
      await worker.processSyncLaneOnce();
      await worker.processOnce();
      found = await findClosedHypo(pool, config.patientId);
      if (found) {
        break;
      }

      await new Promise((resolve) => setTimeout(resolve, config.pollIntervalMs));
    }

    if (!found) {
      throw new Error('Timed out waiting for the closed hypo episode from first-slice workflow');
    }

    return { patientId: config.patientId, hypo: found, ...(await caregiverOutreach(pool, config.patientId)) };
  } finally {
    await app.close();
  }
}