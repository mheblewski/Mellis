import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { PostgresEvidenceExclusionRepository } from './postgres-evidence-exclusion.repository';
import { PostgresGlucoMindRepository } from './postgres-glucomind.repository';
import { EvidenceAuthoritativeEligibilityService } from '@modules/evidence-exclusion/application/evidence-authoritative-eligibility.service';
import { configurePostgresIntegrationEnvironment, truncatePublicTablesForIntegrationTests } from './postgres-test-isolation';

const runPostgresIntegration = process.env.RUN_POSTGRES_INTEGRATION === '1';
const describePostgres = runPostgresIntegration ? describe.sequential : describe.skip;

configurePostgresIntegrationEnvironment(process.env);

async function ensurePatient(pool: Pool, patientId: string): Promise<void> {
  await pool.query(
    `INSERT INTO patients (id, display_name) VALUES ($1::uuid, $2) ON CONFLICT (id) DO NOTHING`,
    [patientId, `patient-${patientId.slice(0, 8)}`],
  );
}

async function insertTargetScaffold(pool: Pool, patientId: string, args?: { sourceRecordPayload?: Record<string, unknown>; eventPayload?: Record<string, unknown> }): Promise<{ sourceRecordId: string; eventId: string }> {
  const sourceId = randomUUID();
  const sourceRecordId = randomUUID();
  const eventId = randomUUID();
  const nowIso = '2026-10-05T10:00:00.000Z';

  await ensurePatient(pool, patientId);

  await pool.query(
    `INSERT INTO sources (id, patient_id, source_system, source_key, metadata) VALUES ($1::uuid, $2::uuid, 'NIGHTSCOUT', $3, '{}'::jsonb)`,
    [sourceId, patientId, `nightscout-${patientId}-${sourceId}`],
  );

  await pool.query(
    `INSERT INTO source_records (
      id, patient_id, source_id, source_system, source_record_id, natural_key, record_type,
      occurred_at, recorded_at, imported_at, raw_payload, canonical_hash
    ) VALUES (
      $1::uuid,$2::uuid,$3::uuid,'NIGHTSCOUT',$4,$5,'cgm.entry',$6::timestamptz,$6::timestamptz,$6::timestamptz,$7::jsonb,$8
    )`,
    [
      sourceRecordId,
      patientId,
      sourceId,
      `record-${sourceRecordId}`,
      `nightscout:${patientId}:${sourceRecordId}`,
      nowIso,
      JSON.stringify(args?.sourceRecordPayload ?? { sgv: 66 }),
      `canonical-${sourceRecordId}`,
    ],
  );

  await pool.query(
    `INSERT INTO events (
      id, patient_id, source_record_id, type, occurred_at, recorded_at, source, context, payload
    ) VALUES (
      $1::uuid,$2::uuid,$3::uuid,'GLUCOSE_READING_AVAILABLE',$4::timestamptz,$4::timestamptz,$5::jsonb,$6::jsonb,$7::jsonb
    )`,
    [
      eventId,
      patientId,
      sourceRecordId,
      nowIso,
      JSON.stringify({ source: 'nightscout' }),
      JSON.stringify({ source: 'nightscout' }),
      JSON.stringify(args?.eventPayload ?? { glucose_value: 66 }),
    ],
  );

  return { sourceRecordId, eventId };
}

// Exclusions have no write path in the app (the table is filled by hand when needed); these specs cover the read
// and eligibility path every meal, pattern and historical read goes through.
async function insertExclusion(pool: Pool, args: { patientId: string; targetKind: 'EVENT' | 'SOURCE_RECORD'; targetId: string; status?: 'ACTIVE' | 'REVOKED' }): Promise<string> {
  const revoked = args.status === 'REVOKED';
  const result = await pool.query<{ evidence_exclusion_id: string }>(
    `INSERT INTO evidence_exclusions (patient_id, exclusion_identity, target_kind, target_id, reason_code, lifecycle_status, origin_type, origin_ref, actor_type, actor_id,
                                      revoked_at, revoked_by_actor_type, revoked_by_actor_id)
     VALUES ($1::uuid, $2, $3, $4::uuid, 'SENSOR_ERROR', $5, 'TEST', 'test', 'USER', 'caregiver',
             CASE WHEN $6 THEN now() END, CASE WHEN $6 THEN 'USER' END, CASE WHEN $6 THEN 'caregiver' END)
     RETURNING evidence_exclusion_id::text`,
    [args.patientId, `exclusion-${randomUUID()}`, args.targetKind, args.targetId, args.status ?? 'ACTIVE', revoked],
  );
  return result.rows[0].evidence_exclusion_id;
}

describePostgres('evidence exclusion read path (postgres)', { timeout: 120_000 }, () => {
  let pool: Pool;
  let repository: PostgresEvidenceExclusionRepository;
  let eligibility: EvidenceAuthoritativeEligibilityService;

  beforeAll(async () => {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      throw new Error('DATABASE_URL is required for Evidence Exclusion postgres tests');
    }

    pool = new Pool({ connectionString: databaseUrl });
    repository = new PostgresEvidenceExclusionRepository(pool as any);
    eligibility = new EvidenceAuthoritativeEligibilityService(repository);
  });

  beforeEach(async () => {
    await truncatePublicTablesForIntegrationTests(pool);
  });

  afterAll(async () => {
    await truncatePublicTablesForIntegrationTests(pool);
    await pool?.end();
  });

  it('resolves one target as USABLE without an exclusion and EXCLUDED with an active one', async () => {
    const patientId = randomUUID();
    const { sourceRecordId } = await insertTargetScaffold(pool, patientId);

    const before = await repository.resolveAuthoritativeEligibility({ patient_id: patientId, target_kind: 'SOURCE_RECORD', target_id: sourceRecordId });
    expect(before).toMatchObject({ authoritative_eligibility: 'USABLE', active_exclusion_id: null });

    const exclusionId = await insertExclusion(pool, { patientId, targetKind: 'SOURCE_RECORD', targetId: sourceRecordId });
    const after = await repository.resolveAuthoritativeEligibility({ patient_id: patientId, target_kind: 'SOURCE_RECORD', target_id: sourceRecordId });
    expect(after).toMatchObject({ authoritative_eligibility: 'EXCLUDED', active_exclusion_id: exclusionId });
  });

  it('leaves readings marked as sensor errors out of the analysis events and the glucose aggregates', async () => {
    const patientId = randomUUID();
    const kept = await insertTargetScaffold(pool, patientId, { eventPayload: { glucose_value: 120 } });
    const byEvent = await insertTargetScaffold(pool, patientId, { eventPayload: { glucose_value: 40 } });
    const byRecord = await insertTargetScaffold(pool, patientId, { eventPayload: { glucose_value: 45 } });
    const revoked = await insertTargetScaffold(pool, patientId, { eventPayload: { glucose_value: 130 } });
    await insertExclusion(pool, { patientId, targetKind: 'EVENT', targetId: byEvent.eventId });
    await insertExclusion(pool, { patientId, targetKind: 'SOURCE_RECORD', targetId: byRecord.sourceRecordId });
    await insertExclusion(pool, { patientId, targetKind: 'EVENT', targetId: revoked.eventId, status: 'REVOKED' });

    const glucoMind = new PostgresGlucoMindRepository(pool as any);
    const range = { patientId, startAtIso: '2026-10-05T00:00:00.000Z', endAtIso: '2026-10-06T00:00:00.000Z' };
    const events = await glucoMind.listPatientEventsByRange({ ...range, limit: 100 });
    expect(events.map((event) => String(event.id)).sort()).toEqual([kept.eventId, revoked.eventId].sort());
    expect(await glucoMind.getGlucoseAggregatesByRange(range)).toMatchObject({ count: 2, min: 120, max: 130 });
  });

  it('treats a revoked exclusion as usable evidence', async () => {
    const patientId = randomUUID();
    const { eventId } = await insertTargetScaffold(pool, patientId);
    await insertExclusion(pool, { patientId, targetKind: 'EVENT', targetId: eventId, status: 'REVOKED' });

    const resolved = await eligibility.resolve({ patient_id: patientId, event_ids: [eventId] });

    expect(resolved).toMatchObject({ excluded_event_ids: [], excluded_source_record_ids: [] });
  });

  it('excludes an event through its own exclusion or the exclusion of its source record', async () => {
    const patientId = randomUUID();
    const direct = await insertTargetScaffold(pool, patientId);
    const viaRecord = await insertTargetScaffold(pool, patientId);
    const usable = await insertTargetScaffold(pool, patientId);
    await insertExclusion(pool, { patientId, targetKind: 'EVENT', targetId: direct.eventId });
    await insertExclusion(pool, { patientId, targetKind: 'SOURCE_RECORD', targetId: viaRecord.sourceRecordId });

    const resolved = await eligibility.resolve({ patient_id: patientId, event_ids: [direct.eventId, viaRecord.eventId, usable.eventId] });

    expect(resolved.excluded_event_ids).toEqual([direct.eventId, viaRecord.eventId].sort());
    expect(resolved.excluded_source_record_ids).toEqual([viaRecord.sourceRecordId]);
  });

  it('never applies another patient\'s exclusion', async () => {
    const patientId = randomUUID();
    const otherPatientId = randomUUID();
    const { eventId } = await insertTargetScaffold(pool, patientId);
    await ensurePatient(pool, otherPatientId);
    await insertExclusion(pool, { patientId: otherPatientId, targetKind: 'EVENT', targetId: eventId });

    expect((await eligibility.resolve({ patient_id: patientId, event_ids: [eventId] })).excluded_event_ids).toEqual([]);
    expect(await repository.listEventSourceRecordLinks({ patient_id: otherPatientId, event_ids: [eventId] })).toEqual([]);
  });

  it('leaves raw evidence readable and unchanged under an exclusion', async () => {
    const patientId = randomUUID();
    const { sourceRecordId, eventId } = await insertTargetScaffold(pool, patientId, {
      sourceRecordPayload: { sgv: 62, note: 'raw-payload-preserved' },
      eventPayload: { glucose_value: 62, quality: 'questionable' },
    });
    await insertExclusion(pool, { patientId, targetKind: 'EVENT', targetId: eventId });

    const rawRead = await pool.query<{ raw_payload: Record<string, unknown>; payload: Record<string, unknown> }>(
      `SELECT sr.raw_payload, e.payload FROM source_records sr JOIN events e ON e.source_record_id = sr.id WHERE sr.id = $1::uuid AND e.id = $2::uuid`,
      [sourceRecordId, eventId],
    );

    expect(rawRead.rows).toEqual([{ raw_payload: { sgv: 62, note: 'raw-payload-preserved' }, payload: { glucose_value: 62, quality: 'questionable' } }]);
  });
});
