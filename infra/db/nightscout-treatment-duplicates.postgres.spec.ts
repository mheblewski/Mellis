import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import {
  assertPoolUsesIsolatedTestDatabase,
  configurePostgresIntegrationEnvironment,
  truncatePublicTablesForIntegrationTests,
} from './postgres-test-isolation';
import { PostgresNightscoutRepository } from './postgres-nightscout.repository';
import { PostgresLoopActionRepository } from './postgres-loop-actions.repository';
import { normalizeNightscoutTreatment } from '@modules/integrations/nightscout/application/nightscout-treatment-normalizer';
import type { NightscoutTreatmentDto } from '@modules/integrations/nightscout/application/nightscout-client';

const runPostgresIntegration = process.env.RUN_POSTGRES_INTEGRATION === '1';
const describePostgres = runPostgresIntegration ? describe.sequential : describe.skip;

configurePostgresIntegrationEnvironment(process.env);

const MIGRATIONS_DIR = resolve(__dirname, 'migrations');
const SKIPPED_MIGRATIONS = new Set(['026_meal_supersession.sql']);

async function applyMigrations(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    // Local Homebrew Postgres has no pgvector; the RAG index (036) is not needed here.
    const hasVector = ((await client.query(`SELECT 1 FROM pg_available_extensions WHERE name = 'vector'`)).rowCount ?? 0) > 0;
    for (const fileName of readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql')).sort()) {
      if (SKIPPED_MIGRATIONS.has(fileName) || (!hasVector && fileName.startsWith('036_'))) continue;
      const applied = await client.query('SELECT 1 FROM schema_migrations WHERE version = $1', [fileName]);
      if ((applied.rowCount ?? 0) > 0) continue;
      await client.query(readFileSync(resolve(MIGRATIONS_DIR, fileName), 'utf8'));
      await client.query('INSERT INTO schema_migrations(version) VALUES ($1)', [fileName]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

// Loop actions only take events created after their epoch, so the fixtures live just before now.
const BASE_MS = Date.now() - 60 * 60_000;
const at = (minutes: number, ms = 0) => new Date(BASE_MS + minutes * 60_000 + ms).toISOString();

describePostgres('Nightscout treatments Trio uploaded twice (postgres)', { timeout: 120_000 }, () => {
  let pool: Pool;
  let nightscout: PostgresNightscoutRepository;
  let loopActions: PostgresLoopActionRepository;
  let patientId: string;
  let source: Awaited<ReturnType<PostgresNightscoutRepository['ensureNightscoutSource']>>;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
    await assertPoolUsesIsolatedTestDatabase(pool);
    await applyMigrations(pool);
    nightscout = new PostgresNightscoutRepository(pool);
    loopActions = new PostgresLoopActionRepository(pool);
  });

  beforeEach(async () => {
    await truncatePublicTablesForIntegrationTests(pool);
    patientId = randomUUID();
    await pool.query(`INSERT INTO patients (id, display_name) VALUES ($1::uuid, 'trio-duplicates-test')`, [patientId]);
    source = await nightscout.ensureNightscoutSource({ patientId, sourceKey: patientId, sourceVersion: 'nightscout.v1', metadata: { base_url: 'https://ns.example.test' } });
  });

  afterAll(async () => {
    if (pool) {
      await truncatePublicTablesForIntegrationTests(pool);
      await pool.end();
    }
  });

  async function persist(treatment: NightscoutTreatmentDto, ingestionOrigin: 'LIVE' | 'HISTORICAL' = 'LIVE') {
    const normalized = normalizeNightscoutTreatment(treatment, patientId, new Date().toISOString());
    if (normalized.status === 'REJECTED') throw new Error(`fixture rejected: ${normalized.reason}`);
    return nightscout.persistImportedTreatment({
      source,
      treatment: normalized.treatment,
      ingestionOrigin,
    });
  }

  const bolus = (id: string, overrides: Partial<NightscoutTreatmentDto> = {}): NightscoutTreatmentDto => ({
    _id: id, id: randomUUID().toUpperCase(), eventType: 'Bolus', insulin: 1.2, enteredBy: 'Trio', created_at: at(3, 371), ...overrides,
  });

  async function events(type: string) {
    return (await pool.query(`SELECT id::text FROM events WHERE patient_id = $1::uuid AND type = $2 ORDER BY created_at`, [patientId, type])).rows.map((row) => row.id as string);
  }

  async function jobCount() {
    return (await pool.query(`SELECT count(*)::int AS n FROM jobs WHERE patient_id = $1::uuid`, [patientId])).rows[0].n as number;
  }

  it('keeps a second Nightscout id for the same bolus as a DUPLICATE record with no event, also on re-sync', async () => {
    const original = bolus('6ad65b5510af24e091cfac72');
    const copy = bolus('6ad66b9310af24e091cfb648');
    const first = await persist(original);
    expect(first).toMatchObject({ source_record_created: true, event_created: true });
    expect(first.duplicate_of_event_id).toBeUndefined();

    const second = await persist(copy);
    expect(second).toEqual({
      source_record_id: expect.any(String),
      event_id: first.event_id,
      source_record_created: true,
      event_created: false,
      duplicate_of_event_id: first.event_id,
    });
    const record = (await pool.query(`SELECT validity, provenance, raw_payload->>'_id' AS ns_id FROM source_records WHERE id = $1::uuid`, [second.source_record_id])).rows[0];
    expect(record).toMatchObject({ validity: 'DUPLICATE', ns_id: '6ad66b9310af24e091cfb648', provenance: expect.objectContaining({ duplicate_of_event_id: first.event_id }) });

    // The next syncs see both Nightscout ids again: nothing changes.
    expect(await persist(copy)).toMatchObject({ source_record_id: second.source_record_id, source_record_created: false, event_created: false, duplicate_of_event_id: first.event_id });
    const again = await persist(original);
    expect(again).toMatchObject({ event_id: first.event_id, source_record_created: false, event_created: false });
    expect(again.duplicate_of_event_id).toBeUndefined();

    expect(await events('BOLUS')).toEqual([first.event_id]);
    // Treatments queue no jobs (loop actions group them on the worker's timer).
    expect(await jobCount()).toBe(0);
  });

  it('a copied meal bolus does not become a second, unassigned loop action', async () => {
    await pool.query(`INSERT INTO loop_action_epochs (patient_id, starts_at) VALUES ($1::uuid, $2::timestamptz)`, [patientId, at(-60)]);
    await persist({ _id: 'carbs-1', id: 'C1', eventType: 'Carb Correction', carbs: 10, enteredBy: 'Trio', created_at: at(2, 783) });
    await persist(bolus('bolus-1'));
    await persist(bolus('bolus-1-copy'));

    expect(await loopActions.groupNewEvents(patientId)).toBe(2);
    const actions = (await pool.query(
      `SELECT a.purpose, array_agg(lae.event_type ORDER BY lae.event_type) AS types
       FROM loop_actions a JOIN loop_action_events lae ON lae.loop_action_id = a.id
       WHERE a.patient_id = $1::uuid GROUP BY a.id`,
      [patientId],
    )).rows;
    expect(actions).toEqual([{ purpose: null, types: ['BOLUS', 'CARB_ENTRY'] }]);
  });

  it('keeps entries that differ in time, dose, type or enteredBy as separate events', async () => {
    await persist(bolus('a'));
    expect(await persist(bolus('b', { created_at: at(3, 372) }))).toMatchObject({ event_created: true });
    expect(await persist(bolus('c', { insulin: 1.25 }))).toMatchObject({ event_created: true });
    expect(await persist(bolus('d', { enteredBy: 'Nightscout careportal' }))).toMatchObject({ event_created: true });
    expect(await persist(bolus('e', { eventType: 'SMB' }))).toMatchObject({ event_created: true });

    expect(await events('BOLUS')).toHaveLength(4);
    expect(await events('SMB')).toHaveLength(1);
  });

  it('deduplicates copied carb entries, SMBs and temp basals, LIVE or HISTORICAL', async () => {
    const carbs = { eventType: 'Carb Correction', carbs: 4, enteredBy: 'Trio', created_at: at(10, 663), id: 'CDB3C48C' };
    expect(await persist({ _id: 'carb-a', ...carbs })).toMatchObject({ event_created: true });
    expect(await persist({ _id: 'carb-b', ...carbs })).toMatchObject({ event_created: false, duplicate_of_event_id: expect.any(String) });

    const smb = { eventType: 'SMB', insulin: 0.1, enteredBy: 'Trio', created_at: at(20, 287), id: '3AD1B631' };
    await persist({ _id: 'smb-a', ...smb }, 'HISTORICAL');
    expect(await persist({ _id: 'smb-b', ...smb }, 'HISTORICAL')).toMatchObject({ event_created: false, duplicate_of_event_id: expect.any(String) });

    const tempBasal = { eventType: 'Temp Basal', rate: 0.35, absolute: 0.35, duration: 30, enteredBy: 'Trio', created_at: at(25, 12) };
    await persist({ _id: 'tb-a', ...tempBasal });
    expect(await persist({ _id: 'tb-b', ...tempBasal })).toMatchObject({ event_created: false, duplicate_of_event_id: expect.any(String) });
    expect(await persist({ _id: 'tb-c', ...tempBasal, rate: 0.4, absolute: 0.4 })).toMatchObject({ event_created: true });

    expect(await events('CARB_ENTRY')).toHaveLength(1);
    expect(await events('SMB')).toHaveLength(1);
    expect(await events('TEMP_BASAL')).toHaveLength(2);
    expect(await jobCount()).toBe(0);
  });

  it('imports one event when both copies arrive at the same time', async () => {
    const results = await Promise.all([persist(bolus('race-a')), persist(bolus('race-b'))]);

    expect(results.filter((result) => result.event_created)).toHaveLength(1);
    expect(results.filter((result) => result.duplicate_of_event_id)).toHaveLength(1);
    expect(await events('BOLUS')).toHaveLength(1);
  });
});
