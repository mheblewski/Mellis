import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { PostgresNightscoutRepository } from './postgres-nightscout.repository';
import { PostgresGlucoMindRepository } from './postgres-glucomind.repository';
import {
  assertPoolUsesIsolatedTestDatabase,
  configurePostgresIntegrationEnvironment,
  truncatePublicTablesForIntegrationTests,
} from './postgres-test-isolation';
import { NightscoutSyncService } from '@modules/integrations/nightscout/application/nightscout-sync.service';
import { nightscoutHistoryCoverage, readHistoryBackfillPlan } from '@modules/integrations/nightscout/application/nightscout-history-backfill';
import type { NightscoutClient, NightscoutEntryDto, NightscoutTreatmentDto, NightscoutDeviceStatusDto } from '@modules/integrations/nightscout/application/nightscout-client';

const runPostgresIntegration = process.env.RUN_POSTGRES_INTEGRATION === '1';
const describePostgres = runPostgresIntegration ? describe.sequential : describe.skip;

configurePostgresIntegrationEnvironment(process.env);

const DAY_MS = 86_400_000;

/** Nightscout with 6 days of 5-min CGM (one 30-min low 3 days ago), a bolus every 6 h, a site change and statuses. */
class SixDayNightscout implements NightscoutClient {
  readonly entries: NightscoutEntryDto[] = [];
  readonly treatments: NightscoutTreatmentDto[] = [];
  readonly statuses: NightscoutDeviceStatusDto[] = [];
  constructor(nowMs: number) {
    const start = nowMs - 6 * DAY_MS;
    const lowAt = nowMs - 3 * DAY_MS;
    for (let at = start; at < nowMs; at += 5 * 60_000) {
      const iso = new Date(at).toISOString();
      this.entries.push({ _id: `sgv-${at}`, type: 'sgv', sgv: at >= lowAt && at < lowAt + 30 * 60_000 ? 55 : 125, date: at, dateString: iso, device: 'dexcom' });
      if ((at / 300_000) % 3 === 0) this.statuses.push({ _id: `ds-${at}`, created_at: iso, openaps: { iob: { iob: 0.8 }, suggested: { COB: 0 } } });
    }
    for (let at = start + 3_600_000; at < nowMs; at += 6 * 3_600_000) {
      this.treatments.push({ _id: `bolus-${at}`, eventType: 'Correction Bolus', created_at: new Date(at).toISOString(), insulin: 1, enteredBy: 'Trio' });
    }
    this.treatments.push({ _id: 'site-change-1', eventType: 'Site Change', created_at: new Date(start + DAY_MS).toISOString(), enteredBy: 'Trio' });
    this.treatments.sort((left, right) => String(left.created_at).localeCompare(String(right.created_at)));
  }
  private read<T>(records: T[], timeOf: (record: T) => string, input: { cursor: string | null; before?: string | null; limit: number }): T[] {
    return records.filter((record) => (!input.cursor || timeOf(record) >= input.cursor) && (!input.before || timeOf(record) < input.before)).slice(0, input.limit);
  }
  async fetchEntries(input: { patient_id: string; cursor: string | null; limit: number; before?: string | null }) {
    return { entries: this.read(this.entries, (entry) => String(entry.dateString), input), next_cursor: input.cursor };
  }
  async fetchTreatments(input: { patient_id: string; cursor: string | null; limit: number; before?: string | null }) {
    return { treatments: this.read(this.treatments, (treatment) => String(treatment.created_at), input), next_cursor: input.cursor };
  }
  async fetchDeviceStatuses(input: { patient_id: string; cursor: string | null; limit: number; before?: string | null }) {
    return { device_statuses: this.read(this.statuses, (status) => String(status.created_at), input), next_cursor: input.cursor };
  }
  async fetchProfiles() {
    return { profiles: [], next_cursor: null };
  }
}

describePostgres('Nightscout history import (postgres, nightscout-history.v1)', { timeout: 180_000 }, () => {
  let pool: Pool;
  let repository: PostgresNightscoutRepository;
  let glucoMind: PostgresGlucoMindRepository;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    await assertPoolUsesIsolatedTestDatabase(pool);
    repository = new PostgresNightscoutRepository(pool);
    glucoMind = new PostgresGlucoMindRepository(pool);
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

  async function setup() {
    const patientId = randomUUID();
    await pool.query(`INSERT INTO patients (id, display_name) VALUES ($1::uuid, 'history-patient')`, [patientId]);
    const nowMs = Date.now();
    const client = new SixDayNightscout(nowMs);
    const service = new NightscoutSyncService(repository, glucoMind, client, { get: (key: string) => (key === 'NIGHTSCOUT_INITIAL_DEVICESTATUS_DAYS' ? 2 : undefined) } as never);
    service.historyPagePauseMs = 0;
    const source = await service.ensureNightscoutSource(patientId, 'https://ns.example.test');
    // The context-events back-fill of the first sync is not what this spec is about.
    await repository.setSourceMetadataValue(source.id, 'context_events_backfilled_v2_at', new Date(nowMs).toISOString());
    return { patientId, nowMs, client, service, source };
  }

  const count = async (sql: string, params: unknown[]) => Number((await pool.query(sql, params)).rows[0].count);

  it('a fresh source gets its week as HISTORICAL after the live day: no hypo jobs, no current states, a HISTORICAL episode', async () => {
    const { patientId, nowMs, service, source } = await setup();

    await service.runNightscoutSyncJob(source.id, new Date(nowMs).toISOString());
    const liveReadings = await count(`SELECT count(*) FROM events WHERE patient_id = $1 AND type = 'GLUCOSE_READING_AVAILABLE' AND event_ingestion_origin = 'LIVE'`, [patientId]);
    const jobsAfterLive = await count(`SELECT count(*) FROM jobs WHERE patient_id = $1`, [patientId]);
    const statesAfterLive = await count(`SELECT count(*) FROM current_states WHERE patient_id = $1`, [patientId]);
    expect(liveReadings).toBeGreaterThanOrEqual(287); // the last day (the first cursor is taken a few ms after nowMs)

    const stats = await service.startHistoryBackfill(source.id);

    expect(stats?.outcome).toBe('COMPLETED');
    expect(await count(`SELECT count(*) FROM events WHERE patient_id = $1 AND type = 'GLUCOSE_READING_AVAILABLE'`, [patientId])).toBe(6 * 288);
    expect(await count(`SELECT count(*) FROM source_records WHERE patient_id = $1 AND record_type = 'CGM_ENTRY'`, [patientId])).toBe(6 * 288);
    expect(await count(`SELECT count(*) FROM events WHERE patient_id = $1 AND type = 'BOLUS'`, [patientId])).toBe(24);
    expect(await count(`SELECT count(*) FROM events WHERE patient_id = $1 AND type = 'BOLUS' AND event_ingestion_origin = 'HISTORICAL'`, [patientId])).toBeGreaterThanOrEqual(18);
    // Device statuses only for the configured 2 days (and the live day already there).
    expect(await count(`SELECT count(*) FROM source_records WHERE patient_id = $1 AND record_type = 'DEVICE_STATUS' AND occurred_at < now() - interval '2 days 1 hour'`, [patientId])).toBe(0);
    expect(await count(`SELECT count(*) FROM therapy_context_events WHERE patient_id = $1 AND kind = 'SITE_CHANGE'`, [patientId])).toBe(1);
    // No job and no current state from history: nothing it imports can alert, push or open a chat.
    expect(await count(`SELECT count(*) FROM jobs WHERE patient_id = $1`, [patientId])).toBe(jobsAfterLive);
    expect(await count(`SELECT count(*) FROM current_states WHERE patient_id = $1`, [patientId])).toBe(statesAfterLive);
    const episodes = (await pool.query(`SELECT h.state, e.event_ingestion_origin FROM hypo_episodes h JOIN events e ON e.id = h.start_event_id WHERE h.patient_id = $1`, [patientId])).rows;
    expect(episodes).toEqual([{ state: 'CLOSED', event_ingestion_origin: 'HISTORICAL' }]);
    expect(await count(`SELECT count(*) FROM conversations WHERE patient_id = $1`, [patientId])).toBe(0);

    // The plan is complete, and what the AI is told follows from it.
    const state = await glucoMind.getNightscoutHistoryState(patientId);
    const plan = readHistoryBackfillPlan(state!.metadata);
    expect(plan?.completed_at).not.toBeNull();
    expect(nightscoutHistoryCoverage({ metadata: state!.metadata, oldestReadingAt: state!.oldest_reading_at, nowIso: new Date().toISOString() })).toMatchObject({ status: 'COMPLETE' });

    // A worker restart re-registers the source: the plan stays, and nothing runs again.
    await service.ensureNightscoutSource(patientId, 'https://ns.example.test');
    expect(readHistoryBackfillPlan((await repository.getNightscoutSourceById(source.id))!.metadata)?.completed_at).toBe(plan?.completed_at);
    expect(await service.startHistoryBackfill(source.id)).toBeNull();
  });

  it('is idempotent and resumable: a replanned import over the same data stores nothing new', async () => {
    const { patientId, nowMs, service, source } = await setup();
    await service.runNightscoutSyncJob(source.id, new Date(nowMs).toISOString());
    await service.startHistoryBackfill(source.id);
    const records = await count(`SELECT count(*) FROM source_records WHERE patient_id = $1`, [patientId]);
    const events = await count(`SELECT count(*) FROM events WHERE patient_id = $1`, [patientId]);

    // An unreadable stored plan (or a source from before the import) is planned again.
    await pool.query(`UPDATE sources SET metadata = metadata || jsonb_build_object('history_backfill', jsonb_build_object('revision', 4)) WHERE id = $1`, [source.id]);
    const again = await service.startHistoryBackfill(source.id);

    expect(again?.outcome).toBe('COMPLETED');
    expect(again?.imported).toEqual({ treatments: 0, entries: 0, devicestatus: 0 });
    expect(await count(`SELECT count(*) FROM source_records WHERE patient_id = $1`, [patientId])).toBe(records);
    expect(await count(`SELECT count(*) FROM events WHERE patient_id = $1`, [patientId])).toBe(events);
    expect(readHistoryBackfillPlan((await repository.getNightscoutSourceById(source.id))!.metadata)?.revision).toBe(5);
  });

  it('refuses a plan write from a run whose revision is no longer stored', async () => {
    const { source } = await setup();
    const plan = { policy_version: 'nightscout-history.v1' as const, revision: 1, from: '2026-10-01T00:00:00.000Z', to: '2026-10-30T00:00:00.000Z', devicestatus_from: '2026-10-23T00:00:00.000Z', live_from: '2026-10-29T00:00:00.000Z', planned_at: '2026-10-30T00:00:00.000Z', progress: { treatments: '2026-10-01T00:00:00.000Z', entries: '2026-10-01T00:00:00.000Z', devicestatus: '2026-10-23T00:00:00.000Z' }, completed_at: null, history_from: '2026-10-01T00:00:00.000Z' };
    expect(await repository.writeHistoryBackfillPlan(source.id, plan, null)).toBe(true);
    expect(await repository.writeHistoryBackfillPlan(source.id, plan, null)).toBe(false);
    expect(await repository.writeHistoryBackfillPlan(source.id, { ...plan, revision: 2 }, 1)).toBe(true);
    expect(await repository.writeHistoryBackfillPlan(source.id, { ...plan, completed_at: '2026-10-30T00:05:00.000Z' }, 1)).toBe(false);
    expect(readHistoryBackfillPlan((await repository.getNightscoutSourceById(source.id))!.metadata)).toMatchObject({ revision: 2, completed_at: null });
  });

  it('moves stream cursors forward only', async () => {
    const { source } = await setup();
    await repository.advanceStreamCursors(source.id, '2026-10-29T10:00:00.000Z');
    await repository.advanceStreamCursors(source.id, '2026-10-20T10:00:00.000Z');
    expect((await repository.getNightscoutSourceById(source.id))!.metadata.stream_cursors).toEqual({ entries: '2026-10-29T10:00:00.000Z', treatments: '2026-10-29T10:00:00.000Z', devicestatus: '2026-10-29T10:00:00.000Z' });
  });
});
