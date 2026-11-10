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
import { normalizeNightscoutTreatment } from '@modules/integrations/nightscout/application/nightscout-treatment-normalizer';

const runPostgresIntegration = process.env.RUN_POSTGRES_INTEGRATION === '1';
const describePostgres = runPostgresIntegration ? describe.sequential : describe.skip;

configurePostgresIntegrationEnvironment(process.env);

describePostgres('temp basals rewritten or deleted in Nightscout after the import (postgres)', { timeout: 120_000 }, () => {
  let pool: Pool;
  let repository: PostgresNightscoutRepository;
  let service: NightscoutSyncService;

  const temp = (patientId: string, args: { id: string; at: string; rate: number; duration: number }) => {
    const normalized = normalizeNightscoutTreatment({
      _id: args.id, eventType: 'Temp Basal', created_at: args.at, rate: args.rate, absolute: args.rate, duration: args.duration,
    } as any, patientId, '2026-11-08T16:30:00.000Z');
    if (normalized.status === 'REJECTED') throw new Error(`fixture rejected: ${normalized.reason}`);
    return normalized.treatment;
  };

  async function setup() {
    const patientId = randomUUID();
    await pool.query(`INSERT INTO patients (id, display_name) VALUES ($1::uuid, 'p')`, [patientId]);
    const source = await service.ensureNightscoutSource(patientId, 'https://ns.example.test');
    return { patientId, source };
  }

  async function tempsOf(patientId: string) {
    return (await pool.query(
      `SELECT payload FROM events WHERE patient_id = $1::uuid AND type = 'TEMP_BASAL' ORDER BY occurred_at`,
      [patientId],
    )).rows.map((row) => row.payload as Record<string, unknown>);
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

  it('rewrites an imported temp basal whose Nightscout document now says what the pump delivered', async () => {
    const { patientId, source } = await setup();
    // Trio sent the zero temp while it ran (planned 30 min), then rewrote the same document: it ran 5 min.
    await repository.persistImportedTreatment({ source, treatment: temp(patientId, { id: 'tb-1', at: '2026-11-08T15:50:00.000Z', rate: 0, duration: 30 }) });

    const unchanged = await repository.reconcileTempBasals({ source, treatments: [temp(patientId, { id: 'tb-1', at: '2026-11-08T15:50:00.000Z', rate: 0, duration: 30 })], window: null });
    expect(unchanged).toEqual({ revised: 0, removed: 0 });

    const result = await repository.reconcileTempBasals({ source, treatments: [temp(patientId, { id: 'tb-1', at: '2026-11-08T15:50:00.000Z', rate: 0, duration: 5 })], window: null });

    expect(result).toEqual({ revised: 1, removed: 0 });
    const [payload] = await tempsOf(patientId);
    expect(payload).toMatchObject({ rate: 0, absolute: 0, duration_minutes: 5 });
    expect(payload.revised_at).toBeTruthy();
    expect((payload.raw_payload as Record<string, unknown>).duration).toBe(5);
  });

  it('marks removed a temp basal deleted in Nightscout, only inside a complete window and for events stored before the read', async () => {
    const { patientId, source } = await setup();
    await repository.persistImportedTreatment({ source, treatment: temp(patientId, { id: 'kept', at: '2026-11-08T15:40:00.000Z', rate: 0.2, duration: 30 }) });
    await repository.persistImportedTreatment({ source, treatment: temp(patientId, { id: 'deleted', at: '2026-11-08T15:50:00.000Z', rate: 0, duration: 30 }) });
    await repository.persistImportedTreatment({ source, treatment: temp(patientId, { id: 'before-window', at: '2026-11-08T09:00:00.000Z', rate: 0, duration: 30 }) });
    const readAt = new Date(Date.now() + 60_000).toISOString();
    const present = [temp(patientId, { id: 'kept', at: '2026-11-08T15:40:00.000Z', rate: 0.2, duration: 30 })];

    // No complete window: nothing is taken as removed.
    expect(await repository.reconcileTempBasals({ source, treatments: present, window: null })).toEqual({ revised: 0, removed: 0 });
    // Read before the events were stored: they may be newer than the read.
    expect(await repository.reconcileTempBasals({ source, treatments: present, window: { from: '2026-11-08T10:00:00.000Z', to: '2026-11-08T16:30:00.000Z', read_at: '2026-01-01T00:00:00.000Z' } }))
      .toEqual({ revised: 0, removed: 0 });

    const window = { from: '2026-11-08T10:00:00.000Z', to: '2026-11-08T16:30:00.000Z', read_at: readAt };
    expect(await repository.reconcileTempBasals({ source, treatments: present, window })).toEqual({ revised: 0, removed: 1 });
    expect(await repository.reconcileTempBasals({ source, treatments: present, window })).toEqual({ revised: 0, removed: 0 });

    const [before, kept, deleted] = await tempsOf(patientId);
    expect(before.removed_in_source_at).toBeUndefined();
    expect(kept.removed_in_source_at).toBeUndefined();
    expect(deleted).toMatchObject({ duration_minutes: 0 });
    expect(deleted.removed_in_source_at).toBeTruthy();

    // It comes back in Nightscout: restored as it is there.
    const back = temp(patientId, { id: 'deleted', at: '2026-11-08T15:50:00.000Z', rate: 0, duration: 10 });
    expect(await repository.reconcileTempBasals({ source, treatments: [...present, back], window })).toEqual({ revised: 1, removed: 0 });
    const restored = (await tempsOf(patientId))[2];
    expect(restored).toMatchObject({ duration_minutes: 10 });
    expect(restored.removed_in_source_at).toBeUndefined();
  });

  it('leaves another source\'s temp basals alone', async () => {
    const first = await setup();
    const second = await setup();
    await repository.persistImportedTreatment({ source: second.source, treatment: temp(second.patientId, { id: 'other', at: '2026-11-08T15:50:00.000Z', rate: 0, duration: 30 }) });

    const result = await repository.reconcileTempBasals({
      source: first.source,
      treatments: [],
      window: { from: '2026-11-08T10:00:00.000Z', to: '2026-11-08T16:30:00.000Z', read_at: new Date(Date.now() + 60_000).toISOString() },
    });

    expect(result).toEqual({ revised: 0, removed: 0 });
    expect((await tempsOf(second.patientId))[0].removed_in_source_at).toBeUndefined();
  });
});
