import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { PostgresNightscoutRepository } from './postgres-nightscout.repository';
import {
  assertPoolUsesIsolatedTestDatabase,
  configurePostgresIntegrationEnvironment,
  truncatePublicTablesForIntegrationTests,
} from './postgres-test-isolation';
import { NightscoutSyncService } from '@modules/integrations/nightscout/application/nightscout-sync.service';
import { normalizeNightscoutEntry } from '@modules/integrations/nightscout/application/nightscout-normalizer';
import { normalizeNightscoutTreatment } from '@modules/integrations/nightscout/application/nightscout-treatment-normalizer';

const runPostgresIntegration = process.env.RUN_POSTGRES_INTEGRATION === '1';
const describePostgres = runPostgresIntegration ? describe.sequential : describe.skip;

configurePostgresIntegrationEnvironment(process.env);

describePostgres('nightscout source cursors and historical provenance (postgres)', { timeout: 120_000 }, () => {
  let pool: Pool;
  let repository: PostgresNightscoutRepository;
  let service: NightscoutSyncService;

  async function ensurePatient(patientId: string) {
    await pool.query(`INSERT INTO patients (id, display_name) VALUES ($1::uuid, $2) ON CONFLICT (id) DO NOTHING`, [patientId, `patient-${patientId.slice(0, 8)}`]);
  }

  async function initSource(patientId: string, baseUrl = 'https://ns.example.test') {
    await ensurePatient(patientId);
    return service.ensureNightscoutSource(patientId, baseUrl);
  }

  async function setImporterState(sourceId: string) {
    // State the importer maintains via updateStreamCursor, plus unrelated metadata.
    await pool.query(
      `UPDATE sources SET metadata = metadata
         || jsonb_build_object('stream_cursors', jsonb_build_object('entries', '2026-10-09T08:00:00.000Z', 'treatments', '2026-10-09T08:44:13.000Z', 'devicestatus', '2026-10-09T08:01:00.000Z'))
         || jsonb_build_object('operator_note', 'keep-me')
       WHERE id = $1`,
      [sourceId],
    );
  }

  async function metadataOf(sourceId: string) {
    return (await pool.query(`SELECT metadata FROM sources WHERE id = $1`, [sourceId])).rows[0].metadata as Record<string, any>;
  }

  async function importReading(patientId: string, source: any, args: { id: string; sgv: number; at: string; origin: 'LIVE' | 'HISTORICAL' }) {
    const normalized = normalizeNightscoutEntry({ _id: args.id, sgv: args.sgv, date: Date.parse(args.at), dateString: args.at, type: 'sgv' } as any, patientId, '2026-10-12T12:00:00.000Z');
    if (normalized.status === 'REJECTED') throw new Error(`fixture rejected: ${normalized.reason}`);
    return repository.persistImportedGlucoseReading({
      source,
      reading: normalized.reading,
      ingestionOrigin: args.origin,
      jobDedupeKey: `triggering.hypo_detection:${normalized.reading.natural_key}`,
      correlationId: source.id,
      causationId: source.id,
      jobPayload: { patient_id: patientId, source_id: source.id, natural_key: normalized.reading.natural_key, event_type: 'GLUCOSE_READING_AVAILABLE' },
    });
  }

  async function count(sql: string, params: unknown[]) {
    return Number((await pool.query(sql, params)).rows[0].count);
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    await assertPoolUsesIsolatedTestDatabase(pool);
    repository = new PostgresNightscoutRepository(pool);
    service = new NightscoutSyncService(repository, {} as never, {} as never);
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

  it('initialises a new source with configuration metadata only', async () => {
    const patientId = randomUUID();
    const source = await initSource(patientId);

    expect(await metadataOf(source.id)).toEqual({ base_url: 'https://ns.example.test', source_patient_id: patientId });
  });

  it('keeps per-stream cursors and unrelated metadata across worker restarts while updating configuration', async () => {
    const patientId = randomUUID();
    const source = await initSource(patientId);
    await setImporterState(source.id);
    const before = (await pool.query(`SELECT sync_cursor, last_successful_observed_at FROM sources WHERE id = $1`, [source.id])).rows[0];

    const restarted = await initSource(patientId, 'https://moved-ns.example.test/path');

    expect(restarted.id).toBe(source.id);
    expect(await metadataOf(source.id)).toEqual({
      base_url: 'https://moved-ns.example.test',
      source_patient_id: patientId,
      operator_note: 'keep-me',
      stream_cursors: { entries: '2026-10-09T08:00:00.000Z', treatments: '2026-10-09T08:44:13.000Z', devicestatus: '2026-10-09T08:01:00.000Z' },
    });
    const after = (await pool.query(`SELECT sync_cursor, last_successful_observed_at FROM sources WHERE id = $1`, [source.id])).rows[0];
    expect(after).toEqual(before);
  });

  it('keeps cursors written by the importer through re-registration with a new source version', async () => {
    const patientId = randomUUID();
    await ensurePatient(patientId);
    const source = await repository.ensureNightscoutSource({ patientId, sourceKey: patientId, sourceVersion: 'nightscout.v1', metadata: { base_url: 'https://old.ns.example.test', source_patient_id: patientId } });
    const cursorWriter = repository as unknown as { updateStreamCursor(client: unknown, sourceId: string, stream: 'entries' | 'treatments' | 'devicestatus', cursorIso: string): Promise<void> };
    await repository.withTransaction(async (client) => {
      await cursorWriter.updateStreamCursor(client, source.id, 'entries', '2026-10-12T08:00:00.000Z');
      await cursorWriter.updateStreamCursor(client, source.id, 'treatments', '2026-10-12T07:15:00.000Z');
      await cursorWriter.updateStreamCursor(client, source.id, 'devicestatus', '2026-10-12T07:55:00.000Z');
    });

    const reRegistered = await repository.ensureNightscoutSource({ patientId, sourceKey: patientId, sourceVersion: 'nightscout.v2', metadata: { base_url: 'https://new.ns.example.test', source_patient_id: patientId } });

    expect(reRegistered.id).toBe(source.id);
    expect(reRegistered.source_version).toBe('nightscout.v2');
    expect((await repository.getNightscoutSourceById(source.id))?.metadata).toEqual({
      base_url: 'https://new.ns.example.test',
      source_patient_id: patientId,
      stream_cursors: { entries: '2026-10-12T08:00:00.000Z', treatments: '2026-10-12T07:15:00.000Z', devicestatus: '2026-10-12T07:55:00.000Z' },
    });
  });

  it('does not add stream_cursors when re-registering a source that has none', async () => {
    const patientId = randomUUID();
    const source = await initSource(patientId);
    await initSource(patientId);

    expect(await metadataOf(source.id)).toEqual({ base_url: 'https://ns.example.test', source_patient_id: patientId });
  });

  it('is idempotent and never lets configuration metadata overwrite cursors', async () => {
    const patientId = randomUUID();
    const source = await initSource(patientId);
    await setImporterState(source.id);

    await initSource(patientId);
    const once = await metadataOf(source.id);
    await initSource(patientId);
    expect(await metadataOf(source.id)).toEqual(once);

    await repository.ensureNightscoutSource({ patientId, sourceKey: patientId, sourceVersion: 'nightscout.v1', metadata: { stream_cursors: { treatments: '1970-01-01T00:00:00.000Z' } } });
    expect((await metadataOf(source.id)).stream_cursors.treatments).toBe('2026-10-09T08:44:13.000Z');
    expect(await count(`SELECT count(*) FROM sources WHERE patient_id = $1::uuid`, [patientId])).toBe(1);
  });

  it('isolates sources per patient', async () => {
    const patientA = randomUUID();
    const patientB = randomUUID();
    const sourceA = await initSource(patientA);
    const sourceB = await initSource(patientB);
    await setImporterState(sourceB.id);
    const metadataB = await metadataOf(sourceB.id);

    await initSource(patientA, 'https://other-ns.example.test');

    expect(sourceA.id).not.toBe(sourceB.id);
    expect(await metadataOf(sourceB.id)).toEqual(metadataB);
    expect((await metadataOf(sourceA.id)).stream_cursors).toBeUndefined();
  });

  it('keeps HISTORICAL provenance and processes backfilled readings analytically', async () => {
    const patientId = randomUUID();
    const source = await initSource(patientId);
    const historical = await importReading(patientId, source, { id: 'hist-48', sgv: 48, at: '2026-10-10T03:00:00.000Z', origin: 'HISTORICAL' });

    expect((await pool.query(`SELECT event_ingestion_origin FROM events WHERE id = $1`, [historical.event_id])).rows[0].event_ingestion_origin).toBe('HISTORICAL');
    // Days after the reading: the LIVE freshness guard must not apply to HISTORICAL readings.
    const result = await service.runHypoDetectionJob(historical.event_id, patientId, '2026-10-12T12:00:00.000Z');

    expect(result.skipped_reason).toBeUndefined();
    expect(await count(`SELECT count(*) FROM triggers WHERE patient_id = $1::uuid`, [patientId])).toBe(1);
    expect(await count(`SELECT count(*) FROM hypo_episodes WHERE patient_id = $1::uuid`, [patientId])).toBe(1);
    // Analytical only: a HISTORICAL episode gets no conversation and no analysis.follow_up job.
    expect(await count(`SELECT count(*) FROM conversations WHERE patient_id = $1::uuid`, [patientId])).toBe(0);
    expect(await count(`SELECT count(*) FROM jobs WHERE patient_id = $1::uuid AND job_type = 'analysis.follow_up'`, [patientId])).toBe(0);
    // Never user-facing here: detection itself enqueues no push.
    expect(await count(`SELECT count(*) FROM push_notifications WHERE patient_id = $1::uuid`, [patientId])).toBe(0);
  });

  it('still runs live hypo detection for LIVE readings', async () => {
    const patientId = randomUUID();
    const source = await initSource(patientId);
    const live = await importReading(patientId, source, { id: 'live-48', sgv: 48, at: '2026-10-12T11:55:00.000Z', origin: 'LIVE' });

    // Fixed clock 5 minutes after the reading, inside the 30-minute freshness guard.
    const result = await service.runHypoDetectionJob(live.event_id, patientId, '2026-10-12T12:00:00.000Z');

    expect(result.skipped_reason).toBeUndefined();
    expect(result.trigger_created).toBe(true);
    // Nobody is asked about a hypo, neither while it lasts nor after.
    expect(await count(`SELECT count(*) FROM conversations WHERE patient_id = $1::uuid`, [patientId])).toBe(0);
    expect(await count(`SELECT count(*) FROM jobs WHERE patient_id = $1::uuid AND job_type = 'analysis.follow_up'`, [patientId])).toBe(0);

    const recovered = await importReading(patientId, source, { id: 'live-95', sgv: 95, at: '2026-10-12T12:20:00.000Z', origin: 'LIVE' });
    const closing = await service.runHypoDetectionJob(recovered.event_id, patientId, '2026-10-12T12:21:00.000Z');

    expect(closing.trigger_created).toBe(false);
    expect(await count(`SELECT count(*) FROM hypo_episodes WHERE patient_id = $1::uuid AND state = 'CLOSED'`, [patientId])).toBe(1);
    // No conversation, no push, no question and no analysis job.
    expect(await count(`SELECT count(*) FROM conversations WHERE patient_id = $1::uuid`, [patientId])).toBe(0);
    expect(await count(`SELECT count(*) FROM jobs WHERE patient_id = $1::uuid AND job_type = 'notifications.push_conversation_question'`, [patientId])).toBe(0);
    expect(await count(`SELECT count(*) FROM push_notifications WHERE patient_id = $1::uuid`, [patientId])).toBe(0);
    expect(await count(`SELECT count(*) FROM jobs WHERE patient_id = $1::uuid AND job_type = 'analysis.follow_up'`, [patientId])).toBe(0);
    expect(await count(`SELECT count(*) FROM conversations WHERE patient_id = $1::uuid AND awaiting_user_answer`, [patientId])).toBe(0);
  });

  async function importCarbs(patientId: string, source: any, args: { id: string; carbs: number; at: string }) {
    const normalized = normalizeNightscoutTreatment({ _id: args.id, eventType: 'Carb Correction', created_at: args.at, carbs: args.carbs } as any, patientId, '2026-10-12T12:00:00.000Z');
    if (normalized.status === 'REJECTED') throw new Error(`fixture rejected: ${normalized.reason}`);
    await repository.persistImportedTreatment({
      source,
      treatment: normalized.treatment,
      ingestionOrigin: 'LIVE',
    });
    return normalized.treatment;
  }

  it('never moves the cursors back when an older reading or treatment is imported (late upload, window backfill)', async () => {
    const patientId = randomUUID();
    const source = await initSource(patientId);
    const cursors = async () => {
      const row = (await pool.query(`SELECT sync_cursor, last_successful_observed_at, metadata FROM sources WHERE id = $1`, [source.id])).rows[0];
      return { sync: row.sync_cursor, last: new Date(row.last_successful_observed_at).toISOString(), entries: row.metadata.stream_cursors?.entries, treatments: row.metadata.stream_cursors?.treatments };
    };

    await importReading(patientId, source, { id: 'live-1000', sgv: 120, at: '2026-10-11T10:00:00.000Z', origin: 'LIVE' });
    await importCarbs(patientId, source, { id: 'carbs-1000', carbs: 40, at: '2026-10-11T10:00:00.000Z' });
    const atTen = { sync: '2026-10-11T10:00:00.000Z', last: '2026-10-11T10:00:00.000Z', entries: '2026-10-11T10:00:00.000Z', treatments: '2026-10-11T10:00:00.000Z' };
    expect(await cursors()).toEqual(atTen);

    await importReading(patientId, source, { id: 'late-0940', sgv: 60, at: '2026-10-11T09:40:00.000Z', origin: 'LIVE' });
    await importReading(patientId, source, { id: 'window-0800', sgv: 90, at: '2026-10-11T08:00:00.000Z', origin: 'HISTORICAL' });
    await importCarbs(patientId, source, { id: 'carbs-0945', carbs: 30, at: '2026-10-11T09:45:00.000Z' });
    expect(await cursors()).toEqual(atTen);

    await importReading(patientId, source, { id: 'live-1005', sgv: 118, at: '2026-10-11T10:05:00.000Z', origin: 'LIVE' });
    expect(await cursors()).toMatchObject({ sync: '2026-10-11T10:05:00.000Z', entries: '2026-10-11T10:05:00.000Z', treatments: '2026-10-11T10:00:00.000Z' });
  });

  it('lists which fetched records are already imported, by natural key or canonical hash', async () => {
    const patientId = randomUUID();
    const source = await initSource(patientId);
    await importReading(patientId, source, { id: 'imported', sgv: 120, at: '2026-10-11T10:00:00.000Z', origin: 'LIVE' });
    const carbs = await importCarbs(patientId, source, { id: 'carbs-imported', carbs: 40, at: '2026-10-11T10:00:00.000Z' });
    const reading = (id: string, at: string) => {
      const normalized = normalizeNightscoutEntry({ _id: id, sgv: 120, date: Date.parse(at), dateString: at, type: 'sgv' } as any, patientId, '2026-10-12T12:00:00.000Z');
      if (normalized.status === 'REJECTED') throw new Error('fixture rejected');
      return normalized.reading;
    };
    const imported = reading('imported', '2026-10-11T10:00:00.000Z');
    const fresh = reading('not-yet', '2026-10-11T09:40:00.000Z');

    const keys = await repository.listImportedNaturalKeys(source.id, [imported, fresh, carbs, { natural_key: 'other-key', canonical_hash: imported.canonical_hash }]);

    expect([...keys].sort()).toEqual([imported.natural_key, carbs.natural_key, 'other-key'].sort());
    expect(await repository.listImportedNaturalKeys(source.id, [])).toEqual(new Set());
  });

  it('re-importing an already LIVE reading as HISTORICAL creates no duplicate record, event or job', async () => {
    const patientId = randomUUID();
    const source = await initSource(patientId);
    const live = await importReading(patientId, source, { id: 'dup-120', sgv: 120, at: '2026-10-11T10:00:00.000Z', origin: 'LIVE' });
    const again = await importReading(patientId, source, { id: 'dup-120', sgv: 120, at: '2026-10-11T10:00:00.000Z', origin: 'HISTORICAL' });

    expect(again.source_record_created).toBe(false);
    expect(again.event_created).toBe(false);
    expect(again.job_created).toBe(false);
    expect(again.event_id).toBe(live.event_id);
    expect((await pool.query(`SELECT event_ingestion_origin FROM events WHERE id = $1`, [live.event_id])).rows[0].event_ingestion_origin).toBe('LIVE');
    expect(await count(`SELECT count(*) FROM events WHERE patient_id = $1::uuid`, [patientId])).toBe(1);
  });
});
