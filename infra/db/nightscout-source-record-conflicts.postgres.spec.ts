import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { PostgresNightscoutRepository } from './postgres-nightscout.repository';
import {
  assertPoolUsesIsolatedTestDatabase,
  configurePostgresIntegrationEnvironment,
  truncatePublicTablesForIntegrationTests,
} from './postgres-test-isolation';
import { normalizeNightscoutEntry } from '@modules/integrations/nightscout/application/nightscout-normalizer';
import { normalizeNightscoutTreatment } from '@modules/integrations/nightscout/application/nightscout-treatment-normalizer';
import { normalizeNightscoutDeviceStatus } from '@modules/integrations/nightscout/application/nightscout-devicestatus-normalizer';

const runPostgresIntegration = process.env.RUN_POSTGRES_INTEGRATION === '1';
const describePostgres = runPostgresIntegration ? describe.sequential : describe.skip;

configurePostgresIntegrationEnvironment(process.env);

type Source = Awaited<ReturnType<PostgresNightscoutRepository['ensureNightscoutSource']>>;

// source_records has a global unique key (source_system, source_record_id): one Nightscout `_id` can be stored once,
// whichever source fetched it first. Two patients pointing at the same Nightscout fetch the same records.
describePostgres('Nightscout records already imported by another source (postgres)', { timeout: 120_000 }, () => {
  let pool: Pool;
  let repository: PostgresNightscoutRepository;
  const importedAt = '2026-10-21T12:00:00.000Z';

  async function sourceFor(sourceKey: string): Promise<Source> {
    const patientId = randomUUID();
    await pool.query(`INSERT INTO patients (id, display_name) VALUES ($1::uuid, $2)`, [patientId, `patient-${patientId.slice(0, 8)}`]);
    return repository.ensureNightscoutSource({ patientId, sourceKey, sourceVersion: 'nightscout.v1', metadata: {} });
  }

  async function sameNightscoutSecondSource(first: Source): Promise<Source> {
    return repository.ensureNightscoutSource({ patientId: first.patient_id, sourceKey: `${first.source_key}-second`, sourceVersion: 'nightscout.v1', metadata: {} });
  }

  function importEntry(source: Source) {
    const normalized = normalizeNightscoutEntry({ _id: '6a1f00000000000000000001', sgv: 112, date: 1_792_581_600_000, dateString: '2026-10-21T11:20:00.000Z', type: 'sgv' }, source.patient_id, importedAt);
    if (normalized.status === 'REJECTED') throw new Error(`fixture rejected: ${normalized.reason}`);
    return repository.persistImportedGlucoseReading({
      source,
      reading: normalized.reading,
      jobDedupeKey: `triggering.hypo_detection:${source.id}:${normalized.reading.natural_key}`,
      correlationId: source.id,
      causationId: source.id,
      jobPayload: { patient_id: source.patient_id, source_id: source.id },
    });
  }

  function importTreatment(source: Source) {
    const normalized = normalizeNightscoutTreatment({ _id: '6a1f00000000000000000002', eventType: 'Carb Correction', carbs: 15, created_at: '2026-10-21T11:21:00.000Z' }, source.patient_id, importedAt);
    if (normalized.status === 'REJECTED') throw new Error(`fixture rejected: ${normalized.reason}`);
    return repository.persistImportedTreatment({
      source,
      treatment: normalized.treatment,
    });
  }

  function importDeviceStatus(source: Source) {
    const normalized = normalizeNightscoutDeviceStatus({ _id: '6a1f00000000000000000003', created_at: '2026-10-21T11:22:00.000Z', openaps: { iob: { iob: 1.4 }, enacted: { COB: 12 } } }, source.patient_id, importedAt);
    if (normalized.status === 'REJECTED') throw new Error(`fixture rejected: ${normalized.reason}`);
    return repository.persistImportedDeviceStatus({ source, status: normalized.statusSnapshot, correlationId: source.id, causationId: source.id });
  }

  async function sourceRecordsOf(patientId: string): Promise<number> {
    return Number((await pool.query(`SELECT count(*) FROM source_records WHERE patient_id = $1::uuid`, [patientId])).rows[0].count);
  }

  async function eventsOf(patientId: string): Promise<number> {
    return Number((await pool.query(`SELECT count(*) FROM events WHERE patient_id = $1::uuid`, [patientId])).rows[0].count);
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    await assertPoolUsesIsolatedTestDatabase(pool);
    repository = new PostgresNightscoutRepository(pool);
  });

  beforeEach(async () => {
    await truncatePublicTablesForIntegrationTests(pool);
  });

  afterAll(async () => {
    if (pool) {
      await truncatePublicTablesForIntegrationTests(pool);
      await pool.end();
    }
  });

  it('skips an entry, a treatment and a device status already stored for another patient instead of throwing', async () => {
    const owner = await sourceFor('owner');
    const other = await sourceFor('other');

    expect(await importEntry(owner)).toMatchObject({ source_record_created: true, event_created: true });
    expect(await importTreatment(owner)).toMatchObject({ source_record_created: true, event_created: true });
    expect(await importDeviceStatus(owner)).toMatchObject({ source_record_created: true });

    expect(await importEntry(other)).toEqual({
      source_record_id: null,
      event_id: null,
      source_record_created: false,
      event_created: false,
      job_created: false,
      current_state_created: false,
      skipped_reason: 'SOURCE_RECORD_OF_ANOTHER_PATIENT',
    });
    expect(await importTreatment(other)).toEqual({
      source_record_id: null,
      event_id: null,
      source_record_created: false,
      event_created: false,
      skipped_reason: 'SOURCE_RECORD_OF_ANOTHER_PATIENT',
    });
    expect(await importDeviceStatus(other)).toEqual({
      source_record_id: null,
      source_record_created: false,
      event_ids: [],
      current_state_updated: false,
      skipped_reason: 'SOURCE_RECORD_OF_ANOTHER_PATIENT',
    });

    expect(await sourceRecordsOf(other.patient_id)).toBe(0);
    expect(await eventsOf(other.patient_id)).toBe(0);
    expect(await sourceRecordsOf(owner.patient_id)).toBe(3);
    // The skipped records still move the other source's cursors forward.
    const metadata = (await pool.query(`SELECT metadata, sync_cursor FROM sources WHERE id = $1`, [other.id])).rows[0];
    expect(metadata.metadata.stream_cursors).toMatchObject({ treatments: '2026-10-21T11:21:00.000Z', devicestatus: '2026-10-21T11:22:00.000Z' });
  });

  it('reuses the record a second source of the same patient already imported', async () => {
    const first = await sourceFor('first');
    const second = await sameNightscoutSecondSource(first);

    const imported = await importEntry(first);
    const again = await importEntry(second);

    expect(again).toMatchObject({ source_record_id: imported.source_record_id, event_id: imported.event_id, source_record_created: false, event_created: false });
    expect(again.skipped_reason).toBeUndefined();
    expect(await sourceRecordsOf(first.patient_id)).toBe(1);
  });

  it('still finds its own record on a re-sync of the same source', async () => {
    const owner = await sourceFor('owner');

    const imported = await importTreatment(owner);
    const again = await importTreatment(owner);

    expect(again).toMatchObject({ source_record_id: imported.source_record_id, event_id: imported.event_id, source_record_created: false, event_created: false });
    expect(again.skipped_reason).toBeUndefined();
  });
});
