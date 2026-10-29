import 'dotenv/config';
import 'reflect-metadata';
import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import { DatabaseModule } from '@infra/db/database.module';
import { DATABASE_POOL } from '@infra/db/database.tokens';
import { PostgresNightscoutRepository } from '@infra/db/postgres-nightscout.repository';
import { NightscoutSyncService } from './nightscout-sync.service';
import {
  NightscoutClient,
  NightscoutDeviceStatusDto,
  NightscoutEntryDto,
  NightscoutTreatmentDto,
} from './nightscout-client';
import { truncatePublicTablesForIntegrationTests } from '@infra/db/postgres-test-isolation';

const runPostgresIntegration = process.env.RUN_POSTGRES_INTEGRATION === '1';
const describePostgres = runPostgresIntegration ? describe.sequential : describe.skip;

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), DatabaseModule],
})
class CurrentStateEnrichmentPostgresModule {}

class ScriptedNightscoutClient implements NightscoutClient {
  public readonly entryCalls: Array<{ patient_id: string; cursor: string | null; limit: number }> = [];
  public readonly deviceStatusCalls: Array<{ patient_id: string; cursor: string | null; limit: number }> = [];
  public readonly treatmentCalls: Array<{ patient_id: string; cursor: string | null; limit: number }> = [];

  constructor(
    private readonly entriesPages: NightscoutEntryDto[][],
    private readonly deviceStatusesPages: NightscoutDeviceStatusDto[][],
    private readonly treatmentsPages: NightscoutTreatmentDto[][] = [[]],
  ) {}

  async fetchEntries(input: { patient_id: string; cursor: string | null; limit: number }): Promise<{ entries: NightscoutEntryDto[]; next_cursor: string | null }> {
    this.entryCalls.push(input);
    return {
      entries: this.entriesPages.shift() ?? [],
      next_cursor: input.cursor,
    };
  }

  async fetchTreatments(input: { patient_id: string; cursor: string | null; limit: number }): Promise<{ treatments: NightscoutTreatmentDto[]; next_cursor: string | null }> {
    this.treatmentCalls.push(input);
    return {
      treatments: this.treatmentsPages.shift() ?? [],
      next_cursor: input.cursor,
    };
  }

  async fetchDeviceStatuses(input: { patient_id: string; cursor: string | null; limit: number }): Promise<{ device_statuses: NightscoutDeviceStatusDto[]; next_cursor: string | null }> {
    this.deviceStatusCalls.push(input);
    return {
      device_statuses: this.deviceStatusesPages.shift() ?? [],
      next_cursor: input.cursor,
    };
  }
}

async function ensurePatient(pool: Pool, patientId: string): Promise<void> {
  await pool.query(
    `
      INSERT INTO patients (id, display_name)
      VALUES ($1::uuid, $2)
      ON CONFLICT (id)
      DO UPDATE SET updated_at = now()
    `,
    [patientId, `patient-${patientId.slice(0, 8)}`],
  );
}

async function getLatestCurrentStateSnapshot(pool: Pool, patientId: string): Promise<Record<string, unknown>> {
  const result = await pool.query<{ snapshot: Record<string, unknown> }>(
    `
      SELECT snapshot
      FROM current_states
      WHERE patient_id = $1::uuid
      ORDER BY as_of DESC, created_at DESC
      LIMIT 1
    `,
    [patientId],
  );

  if (!result.rows[0]) {
    throw new Error('Missing current_state snapshot');
  }

  return result.rows[0].snapshot;
}

async function countSourceRecordsByType(pool: Pool, patientId: string, recordType: string): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `
      SELECT count(*)::text AS count
      FROM source_records
      WHERE patient_id = $1::uuid
        AND record_type = $2
    `,
    [patientId, recordType],
  );
  return Number(result.rows[0].count);
}

async function countEventsByType(pool: Pool, patientId: string, type: string): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `
      SELECT count(*)::text AS count
      FROM events
      WHERE patient_id = $1::uuid
        AND type = $2
    `,
    [patientId, type],
  );
  return Number(result.rows[0].count);
}

function glucoseEntry(patientId: string, id: string, dateString: string, glucose: number, direction: string): NightscoutEntryDto {
  return {
    _id: id,
    patient: patientId,
    date: Date.parse(dateString),
    dateString,
    sgv: glucose,
    units: 'mg/dL',
    direction,
  };
}

function createService(
  nightscoutRepository: PostgresNightscoutRepository,
  entriesPages: NightscoutEntryDto[][],
  deviceStatusesPages: NightscoutDeviceStatusDto[][],
): NightscoutSyncService {
  return new NightscoutSyncService(
    nightscoutRepository,
    { insertJob: async () => null } as any,
    new ScriptedNightscoutClient(entriesPages, deviceStatusesPages) as any,
  );
}

describePostgres('current-state enrichment v1 (postgres)', { timeout: 60_000 }, () => {
  let app: Awaited<ReturnType<typeof NestFactory.createApplicationContext>>;
  let pool: Pool;
  let nightscoutRepository: PostgresNightscoutRepository;

  beforeAll(async () => {
    app = await NestFactory.createApplicationContext(CurrentStateEnrichmentPostgresModule, { logger: ['error', 'warn'] });
    pool = app.get<Pool>(DATABASE_POOL);
    nightscoutRepository = app.get(PostgresNightscoutRepository, { strict: false });
  });

  beforeEach(async () => {
    await truncatePublicTablesForIntegrationTests(pool);
  });

  afterAll(async () => {
    await truncatePublicTablesForIntegrationTests(pool);
    await app.close();
  });

  it('persists devicestatus and enriches current_state with FLAT trend + IOB + COB', async () => {
    const patientId = randomUUID();
    await ensurePatient(pool, patientId);

    const service = createService(
      nightscoutRepository,
      [[glucoseEntry(patientId, 'entry-1', '2026-10-05T19:19:00.000Z', 103, 'Flat')]],
      [[{
        _id: 'status-1',
        patient: patientId,
        created_at: '2026-10-05T19:19:25.472Z',
        openaps: {
          iob: { iob: 1.358 },
          suggested: { COB: 9 },
          enacted: { COB: 10 },
        },
      }]],
    );

    const source = await service.ensureNightscoutSource(patientId, 'https://nightscout.example.com');
    await service.runNightscoutSyncJob(source.id, '2026-10-05T19:20:00.000Z');

    expect(await countSourceRecordsByType(pool, patientId, 'DEVICE_STATUS')).toBe(1);
    expect(await countEventsByType(pool, patientId, 'IOB_SNAPSHOT')).toBe(1);
    expect(await countEventsByType(pool, patientId, 'COB_SNAPSHOT')).toBe(1);

    const snapshot = await getLatestCurrentStateSnapshot(pool, patientId);
    const glucose = (snapshot.glucose ?? {}) as Record<string, unknown>;
    const iob = (snapshot.iob ?? {}) as Record<string, unknown>;
    const cob = (snapshot.cob ?? {}) as Record<string, unknown>;

    expect(glucose.trend).toBe('FLAT');
    expect(iob.value).toBe(1.358);
    // The newer suggestion wins over the last enacted calculation (loop-status.ts, since 2026-10-28): 9, not 10.
    expect(cob.value).toBe(9);
  });

  it('keeps IOB/COB as UNKNOWN when devicestatus has no usable values', async () => {
    const patientId = randomUUID();
    await ensurePatient(pool, patientId);

    const service = createService(
      nightscoutRepository,
      [[glucoseEntry(patientId, 'entry-2', '2026-10-05T20:19:00.000Z', 97, 'Flat')]],
      [[{
        _id: 'status-missing',
        patient: patientId,
        created_at: '2026-10-05T20:19:25.472Z',
        openaps: {},
      }]],
    );

    const source = await service.ensureNightscoutSource(patientId, 'https://nightscout.example.com');
    await service.runNightscoutSyncJob(source.id, '2026-10-05T20:20:00.000Z');

    expect(await countEventsByType(pool, patientId, 'IOB_SNAPSHOT')).toBe(0);
    expect(await countEventsByType(pool, patientId, 'COB_SNAPSHOT')).toBe(0);

    const snapshot = await getLatestCurrentStateSnapshot(pool, patientId);
    const glucose = (snapshot.glucose ?? {}) as Record<string, unknown>;
    const iob = (snapshot.iob ?? {}) as Record<string, unknown>;
    const cob = (snapshot.cob ?? {}) as Record<string, unknown>;

    expect(glucose.trend).toBe('FLAT');
    expect(iob.value).toBe('UNKNOWN');
    expect(cob.value).toBe('UNKNOWN');
  });

  it('keeps IOB as UNKNOWN when only COB is present', async () => {
    const patientId = randomUUID();
    await ensurePatient(pool, patientId);

    const service = createService(
      nightscoutRepository,
      [[glucoseEntry(patientId, 'entry-no-iob', '2026-10-05T20:29:00.000Z', 95, 'Flat')]],
      [[{
        _id: 'status-no-iob',
        patient: patientId,
        created_at: '2026-10-05T20:29:25.472Z',
        openaps: { suggested: { COB: 11 } },
      }]],
    );

    const source = await service.ensureNightscoutSource(patientId, 'https://nightscout.example.com');
    await service.runNightscoutSyncJob(source.id, '2026-10-05T20:30:00.000Z');

    const snapshot = await getLatestCurrentStateSnapshot(pool, patientId);
    const iob = (snapshot.iob ?? {}) as Record<string, unknown>;
    const cob = (snapshot.cob ?? {}) as Record<string, unknown>;
    expect(iob.value).toBe('UNKNOWN');
    expect(cob.value).toBe(11);
  });

  it('keeps COB as UNKNOWN when only IOB is present', async () => {
    const patientId = randomUUID();
    await ensurePatient(pool, patientId);

    const service = createService(
      nightscoutRepository,
      [[glucoseEntry(patientId, 'entry-no-cob', '2026-10-05T20:39:00.000Z', 101, 'Flat')]],
      [[{
        _id: 'status-no-cob',
        patient: patientId,
        created_at: '2026-10-05T20:39:25.472Z',
        openaps: { iob: { iob: 1.22 } },
      }]],
    );

    const source = await service.ensureNightscoutSource(patientId, 'https://nightscout.example.com');
    await service.runNightscoutSyncJob(source.id, '2026-10-05T20:40:00.000Z');

    const snapshot = await getLatestCurrentStateSnapshot(pool, patientId);
    const iob = (snapshot.iob ?? {}) as Record<string, unknown>;
    const cob = (snapshot.cob ?? {}) as Record<string, unknown>;
    expect(iob.value).toBe(1.22);
    expect(cob.value).toBe('UNKNOWN');
  });

  it('keeps IOB/COB UNKNOWN when values are malformed', async () => {
    const patientId = randomUUID();
    await ensurePatient(pool, patientId);

    const service = createService(
      nightscoutRepository,
      [[glucoseEntry(patientId, 'entry-malformed', '2026-10-05T20:49:00.000Z', 99, 'Flat')]],
      [[{
        _id: 'status-malformed',
        patient: patientId,
        created_at: '2026-10-05T20:49:25.472Z',
        openaps: { iob: { iob: 'bad' }, suggested: { COB: 'bad' } },
      }]],
    );

    const source = await service.ensureNightscoutSource(patientId, 'https://nightscout.example.com');
    await service.runNightscoutSyncJob(source.id, '2026-10-05T20:50:00.000Z');

    expect(await countEventsByType(pool, patientId, 'IOB_SNAPSHOT')).toBe(0);
    expect(await countEventsByType(pool, patientId, 'COB_SNAPSHOT')).toBe(0);

    const snapshot = await getLatestCurrentStateSnapshot(pool, patientId);
    const iob = (snapshot.iob ?? {}) as Record<string, unknown>;
    const cob = (snapshot.cob ?? {}) as Record<string, unknown>;
    expect(iob.value).toBe('UNKNOWN');
    expect(cob.value).toBe('UNKNOWN');
  });

  it('accepts timestamp variants: Z, +02:00 offset, and GMT+0200 string', async () => {
    const patientId = randomUUID();
    await ensurePatient(pool, patientId);

    const service = createService(
      nightscoutRepository,
      [[glucoseEntry(patientId, 'entry-ts', '2026-10-05T21:19:00.000Z', 100, 'Flat')]],
      [[
        { _id: 'status-z', patient: patientId, created_at: '2026-10-05T21:19:25.472Z', openaps: { iob: { iob: 1.0 } } },
        { _id: 'status-offset', patient: patientId, created_at: '2026-10-05T23:19:26.472+02:00', openaps: { suggested: { COB: 8 } } },
        { _id: 'status-gmt', patient: patientId, created_at: 'Mon Oct 05 2026 23:19:27 GMT+0200 (Central European Summer Time)', openaps: { enacted: { COB: 9, IOB: 1.5 } } },
      ]],
    );

    const source = await service.ensureNightscoutSource(patientId, 'https://nightscout.example.com');
    await service.runNightscoutSyncJob(source.id, '2026-10-05T21:20:00.000Z');

    const snapshot = await getLatestCurrentStateSnapshot(pool, patientId);
    const iob = (snapshot.iob ?? {}) as Record<string, unknown>;
    const cob = (snapshot.cob ?? {}) as Record<string, unknown>;
    expect(iob.value).toBe(1.5);
    expect(cob.value).toBe(9);
  });

  it('deduplicates duplicate devicestatus rows in one sync run', async () => {
    const patientId = randomUUID();
    await ensurePatient(pool, patientId);

    const duplicate = {
      _id: 'status-dup',
      patient: patientId,
      created_at: '2026-10-05T21:29:25.472Z',
      openaps: { iob: { iob: 1.41 }, suggested: { COB: 13 } },
    };
    const service = createService(
      nightscoutRepository,
      [[glucoseEntry(patientId, 'entry-dup', '2026-10-05T21:29:00.000Z', 102, 'Flat')]],
      [[duplicate, duplicate]],
    );

    const source = await service.ensureNightscoutSource(patientId, 'https://nightscout.example.com');
    await service.runNightscoutSyncJob(source.id, '2026-10-05T21:30:00.000Z');

    expect(await countSourceRecordsByType(pool, patientId, 'DEVICE_STATUS')).toBe(1);
    expect(await countEventsByType(pool, patientId, 'IOB_SNAPSHOT')).toBe(1);
    expect(await countEventsByType(pool, patientId, 'COB_SNAPSHOT')).toBe(1);
  });

  it('is idempotent when replaying the same devicestatus in another sync run', async () => {
    const patientId = randomUUID();
    await ensurePatient(pool, patientId);

    const status = {
      _id: 'status-replay',
      patient: patientId,
      created_at: '2026-10-05T21:39:25.472Z',
      openaps: { iob: { iob: 1.09 }, enacted: { COB: 7 } },
    };
    const service = createService(
      nightscoutRepository,
      [
        [glucoseEntry(patientId, 'entry-replay', '2026-10-05T21:39:00.000Z', 98, 'Flat')],
        [glucoseEntry(patientId, 'entry-replay', '2026-10-05T21:39:00.000Z', 98, 'Flat')],
      ],
      [[status], [status]],
    );

    const source = await service.ensureNightscoutSource(patientId, 'https://nightscout.example.com');
    await service.runNightscoutSyncJob(source.id, '2026-10-05T21:40:00.000Z');
    await service.runNightscoutSyncJob(source.id, '2026-10-05T21:41:00.000Z');

    expect(await countSourceRecordsByType(pool, patientId, 'DEVICE_STATUS')).toBe(1);
    expect(await countEventsByType(pool, patientId, 'IOB_SNAPSHOT')).toBe(1);
    expect(await countEventsByType(pool, patientId, 'COB_SNAPSHOT')).toBe(1);
  });

  it('enforces patient isolation for devicestatus projection', async () => {
    const patientA = randomUUID();
    const patientB = randomUUID();
    await ensurePatient(pool, patientA);
    await ensurePatient(pool, patientB);

    const serviceA = createService(
      nightscoutRepository,
      [[glucoseEntry(patientA, 'entry-a', '2026-10-05T22:19:00.000Z', 105, 'Flat')]],
      [[{ _id: 'status-a', patient: patientA, created_at: '2026-10-05T22:19:25.472Z', openaps: { iob: { iob: 1.11 }, suggested: { COB: 6 } } }]],
    );
    const serviceB = createService(
      nightscoutRepository,
      [[glucoseEntry(patientB, 'entry-b', '2026-10-05T22:19:00.000Z', 88, 'Flat')]],
      [[{ _id: 'status-b', patient: patientB, created_at: '2026-10-05T22:19:30.472Z', openaps: { iob: { iob: 2.22 }, suggested: { COB: 12 } } }]],
    );

    const sourceA = await serviceA.ensureNightscoutSource(patientA, 'https://nightscout.example.com');
    const sourceB = await serviceB.ensureNightscoutSource(patientB, 'https://nightscout.example.com');
    await serviceA.runNightscoutSyncJob(sourceA.id, '2026-10-05T22:20:00.000Z');
    await serviceB.runNightscoutSyncJob(sourceB.id, '2026-10-05T22:20:05.000Z');

    const snapshotA = await getLatestCurrentStateSnapshot(pool, patientA);
    const snapshotB = await getLatestCurrentStateSnapshot(pool, patientB);
    expect(((snapshotA.iob ?? {}) as Record<string, unknown>).value).toBe(1.11);
    expect(((snapshotA.cob ?? {}) as Record<string, unknown>).value).toBe(6);
    expect(((snapshotB.iob ?? {}) as Record<string, unknown>).value).toBe(2.22);
    expect(((snapshotB.cob ?? {}) as Record<string, unknown>).value).toBe(12);
  });
});