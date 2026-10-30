import { Injectable, Logger } from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import { ConfigService } from '@nestjs/config';
import { PostgresGlucoMindRepository } from '@infra/db/postgres-glucomind.repository';
import { PostgresNightscoutRepository } from '@infra/db/postgres-nightscout.repository';
import { isNightscoutSourceSeeder, type NightscoutSeedResult } from '../infrastructure/patient-nightscout-clients';
import { NIGHTSCOUT_CLIENT, NightscoutClient, NightscoutEntryDto, NightscoutProfileDto, NightscoutTreatmentDto } from './nightscout-client';
import { nightscoutEntryObservedAt, normalizeNightscoutEntry } from './nightscout-normalizer';
import { normalizeNightscoutTreatment } from './nightscout-treatment-normalizer';
import { toTherapyContextEvent } from './therapy-context-events';
import { normalizeNightscoutDeviceStatus } from './nightscout-devicestatus-normalizer';
import { Inject } from '@nestjs/common';
import { NightscoutClientError } from '../infrastructure/http-nightscout-client';
import { detectHypo, isReadingTooStaleToStartHypoFlow } from '@modules/triggering/application/hypo-detector';
import { canonicalJson } from '@shared/utils/canonical-json';
import {
  DEFAULT_HISTORY_PAGE_PAUSE_MS,
  DEFAULT_INITIAL_DEVICESTATUS_DAYS,
  DEFAULT_INITIAL_HISTORY_DAYS,
  LIVE_SYNC_MAX_CATCHUP_MS,
  newHistoryBackfillPlan,
  readHistoryBackfillPlan,
  runHistoryBackfill,
  withHistoryGap,
  type HistoryBackfillStats,
  type HistoryWindowConfig,
} from './nightscout-history-backfill';

function toIsoTimestamp(value: unknown): string {
  if (value instanceof Date) {
    return value.toISOString();
  }

  const asString = String(value ?? '');
  const parsed = new Date(asString);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toISOString();
  }

  return asString;
}

interface SyncSourceRecord {
  id: string;
  patient_id: string;
  source_system: string;
  source_key: string;
  sync_cursor: string | null;
  last_successful_observed_at: string | null;
  source_version: string | null;
  metadata: Record<string, unknown>;
}

export interface NightscoutSyncStreamStats {
  fetched: number;
  imported: number;
  deduplicated: number;
  rejected: number;
  events_created: number;
  jobs_enqueued: number;
}

export interface NightscoutSyncResult {
  entries: NightscoutSyncStreamStats;
  treatments: NightscoutSyncStreamStats;
  records_fetched: number;
  records_imported: number;
  records_deduplicated: number;
  records_rejected: number;
  events_created: number;
  jobs_enqueued: number;
}

interface StreamImportResult {
  fetched: number;
  imported: number;
  deduplicated: number;
  rejected: number;
  eventsCreated: number;
  jobsEnqueued: number;
}

const ENTRIES_PAGE_SIZE = 500;
const DEFAULT_MAX_ENTRY_PAGES = 24;
/**
 * Each sync also re-reads this far behind the entries and treatments cursors: a record uploaded late with an older time
 * (carbs entered in Trio at 10:07 for 09:45, CGM backfill after a signal loss) is behind the cursor and was never read.
 * Records already imported are skipped by natural key. NIGHTSCOUT_SYNC_LOOKBACK_MINUTES overrides it; 0 turns it off.
 */
export const DEFAULT_SYNC_LOOKBACK_MINUTES = 360;
/** A hypo episode ends after this long back at >= 70 mg/dL (International Consensus on Time in Range). */
export const HYPO_RECOVERY_CONFIRM_MINUTES = 15;
const TREATMENTS_PAGE_SIZE = 500;
/** therapy-context-events.v1 back-fill: this many days, at most this many pages of treatments. */
const CONTEXT_BACKFILL_DAYS = 30;
const CONTEXT_BACKFILL_MAX_PAGES = 60;

function parseNightscoutTimestampLoose(value: unknown): string | null {
  const at = Date.parse(String(value ?? ''));
  return Number.isFinite(at) ? new Date(at).toISOString() : null;
}

/** A cursor as a canonical ISO time (a fallback cursor may come from a timestamptz column as a Date), or null. */
function toCursorIso(value: unknown): string | null {
  const ms = value instanceof Date ? value.getTime() : Date.parse(String(value ?? ''));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** Oldest first by observed time (entries without a readable time last), then by Nightscout id. */
function sortEntriesAscending(left: NightscoutEntryDto, right: NightscoutEntryDto): number {
  const leftObserved = entryObservedAtIso(left);
  const rightObserved = entryObservedAtIso(right);
  if (leftObserved !== rightObserved) {
    if (leftObserved === null) return 1;
    if (rightObserved === null) return -1;
    return leftObserved < rightObserved ? -1 : 1;
  }

  const leftKey = String(left._id ?? left.id ?? left.eventId ?? '');
  const rightKey = String(right._id ?? right.id ?? right.eventId ?? '');
  return leftKey.localeCompare(rightKey);
}

function entryObservedAtIso(entry: NightscoutEntryDto): string | null {
  return nightscoutEntryObservedAt(entry);
}

/**
 * Window pages ask for records $gte the previous page's newest time, so records sharing that millisecond come
 * again on the next page. False when the record (by Nightscout id, else its whole content) was already taken.
 */
function markFirstSeen(seen: Set<string>, record: { _id?: unknown; id?: unknown; eventId?: unknown }): boolean {
  const key = String(record._id ?? record.id ?? record.eventId ?? canonicalJson(record));
  if (seen.has(key)) {
    return false;
  }
  seen.add(key);
  return true;
}

function parseProfileDate(value: unknown): string | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const asNumber = typeof value === 'number' ? value : Number(value);
  if (Number.isFinite(asNumber)) {
    return new Date(asNumber).toISOString();
  }

  const asDate = new Date(String(value));
  if (!Number.isNaN(asDate.getTime())) {
    return asDate.toISOString();
  }

  return null;
}

function normalizeNightscoutProfile(profile: NightscoutProfileDto, patientId: string, observedAt: string): {
  source_system: 'NIGHTSCOUT';
  source_record_id: string | null;
  profile_key: string;
  active_profile_id: string;
  therapy_version: string;
  observed_at: string;
  valid_from: string | null;
  valid_to: string | null;
  snapshot: Record<string, unknown>;
  provenance: Record<string, unknown>;
  completeness: 'COMPLETE' | 'PARTIAL' | 'UNKNOWN';
} | null {
  if (!profile || typeof profile !== 'object') {
    return null;
  }

  const explicitPatient = typeof profile.patient === 'string'
    ? profile.patient
    : typeof profile.patientId === 'string'
      ? profile.patientId
      : null;

  if (explicitPatient && explicitPatient !== patientId) {
    return null;
  }

  const store = profile.store && typeof profile.store === 'object' ? profile.store as Record<string, unknown> : null;
  const hasStoreEntries = !!store && Object.keys(store).length > 0;
  const activeProfileName = typeof profile.defaultProfile === 'string' && profile.defaultProfile.trim()
    ? profile.defaultProfile.trim()
    : store && Object.keys(store).length === 1
      ? Object.keys(store)[0]
      : null;

  const selectedProfile = profile.profile && typeof profile.profile === 'object'
    ? (profile.profile as Record<string, unknown>)
    : activeProfileName && store && store[activeProfileName] && typeof store[activeProfileName] === 'object'
      ? (store[activeProfileName] as Record<string, unknown>)
      : null;

  const selectedProfileKeys = selectedProfile ? Object.keys(selectedProfile).length : 0;
  const hasTherapyContent = selectedProfileKeys > 0 || hasStoreEntries;
  if (!hasTherapyContent) {
    return null;
  }

  const profileKey = activeProfileName ?? `nightscout-profile-${String(profile._id ?? profile.id ?? 'default')}`;
  const profileId = String(profile._id ?? profile.id ?? activeProfileName ?? profileKey);
  const snapshot = {
    source_system: 'NIGHTSCOUT',
    source_profile_id: profileId,
    patient_id: patientId,
    active_profile_id: activeProfileName ?? profileKey,
    default_profile: activeProfileName ?? profileKey,
    profile_key: profileKey,
    timezone: typeof profile.timezone === 'string' ? profile.timezone : null,
    units: typeof profile.units === 'string' ? profile.units : null,
    default_profile_source: profile.store ? 'store' : 'profile',
    profile: selectedProfile,
    store,
    raw_profile: profile,
  };

  const rawHash = createHash('sha256').update(canonicalJson(snapshot)).digest('hex');
  const therapyVersion = `${profileId}:${rawHash}`;

  const selectedProfileStartDate = selectedProfile && (typeof selectedProfile.startDate === 'string' || typeof selectedProfile.startDate === 'number')
    ? selectedProfile.startDate
    : null;
  const selectedProfileEndDate = selectedProfile && (typeof selectedProfile.endDate === 'string' || typeof selectedProfile.endDate === 'number')
    ? selectedProfile.endDate
    : null;

  const validFrom = parseProfileDate(profile.startDate ?? selectedProfileStartDate);
  const validTo = parseProfileDate(profile.endDate ?? selectedProfileEndDate);

  return {
    source_system: 'NIGHTSCOUT',
    source_record_id: profileId || null,
    profile_key: profileKey,
    active_profile_id: activeProfileName ?? profileKey,
    therapy_version: therapyVersion,
    observed_at: observedAt,
    valid_from: validFrom,
    valid_to: validTo,
    snapshot,
    provenance: {
      source: 'NIGHTSCOUT',
      source_profile_id: profileId,
      source_patient_id: explicitPatient ?? patientId,
      source_observed_at: observedAt,
      source_valid_from: validFrom,
      source_valid_to: validTo,
      default_profile_name: activeProfileName,
      completeness: 'COMPLETE',
    },
    completeness: 'COMPLETE',
  };
}

@Injectable()
export class NightscoutSyncService {
  private readonly logger = new Logger(NightscoutSyncService.name);

  constructor(
    @Inject(PostgresNightscoutRepository)
    private readonly nightscoutRepository: PostgresNightscoutRepository,
    @Inject(PostgresGlucoMindRepository)
    private readonly repository: PostgresGlucoMindRepository,
    @Inject(NIGHTSCOUT_CLIENT) private readonly client: NightscoutClient,
    @Inject(ConfigService) private readonly configService?: ConfigService,
  ) {}

  async ensureNightscoutSource(patientId: string, baseUrl: string): Promise<SyncSourceRecord> {
    return this.nightscoutRepository.ensureNightscoutSource({
      patientId,
      sourceKey: patientId,
      sourceVersion: 'nightscout.v1',
      metadata: {
        base_url: new URL(baseUrl).origin,
        source_patient_id: patientId,
      },
    });
  }

  /**
   * At worker start: the one-time seed of the env patient's Nightscout into its stored source (migration 090), then
   * the number of enabled sources the worker syncs. A client without stored sources (tests, scripts) seeds nothing.
   */
  async prepareNightscoutSources(env: Record<string, string | undefined> = process.env): Promise<{ seed: NightscoutSeedResult | null; sources: number }> {
    const seed = isNightscoutSourceSeeder(this.client) ? await this.client.seedFromEnv(env) : null;
    return { seed, sources: (await this.nightscoutRepository.listNightscoutSources()).length };
  }

  /** The Nightscout sources to sync (the worker's due-reading poll and the refresh before an answer). */
  async listNightscoutSources(): Promise<Array<{ id: string; patient_id: string }>> {
    return (await this.nightscoutRepository.listNightscoutSources()).map((source) => ({ id: source.id, patient_id: source.patient_id }));
  }

  async getNightscoutSourceById(sourceId: string): Promise<SyncSourceRecord | null> {
    return this.nightscoutRepository.getNightscoutSourceById(sourceId);
  }

  async getImportedReadingForEvent(eventId: string): Promise<Record<string, unknown> | null> {
    return this.nightscoutRepository.getImportedReadingForEvent(eventId);
  }

  async enqueueRecurringSyncJobs(nowIso: string): Promise<{ sources: number; jobs_enqueued: number }> {
    const sources = await this.nightscoutRepository.listNightscoutSources();
    const bucket = new Date(Math.floor(Date.parse(nowIso) / 60000) * 60000).toISOString();
    let jobsEnqueued = 0;

    for (const source of sources) {
      const job = await this.repository.insertJob({
        jobType: 'nightscout.sync',
        payloadVersion: 1,
        payload: {
          source_id: source.id,
        },
        dedupeKey: `nightscout.sync:${source.id}:${bucket}`,
        correlationId: source.id,
        causationId: null,
        patientId: source.patient_id,
        availableAt: nowIso,
        maxAttempts: 5,
      });

      if (job) {
        jobsEnqueued += 1;
      }
    }

    return { sources: sources.length, jobs_enqueued: jobsEnqueued };
  }

  private syncLookbackMs(): number {
    const configured = Number(this.configService?.get<number | string>('NIGHTSCOUT_SYNC_LOOKBACK_MINUTES') ?? DEFAULT_SYNC_LOOKBACK_MINUTES);
    return Number.isInteger(configured) && configured >= 0 ? configured * 60_000 : DEFAULT_SYNC_LOOKBACK_MINUTES * 60_000;
  }

  /** The look-back window [cursor - lookback, cursor): records uploaded after the cursor passed them. */
  private async fetchLookbackWindow(source: SyncSourceRecord, entriesCursor: string, treatmentsCursor: string): Promise<{ entries: NightscoutEntryDto[]; treatments: NightscoutTreatmentDto[] }> {
    const lookbackMs = this.syncLookbackMs();
    const windowStart = (cursor: string) => new Date(Date.parse(cursor) - lookbackMs).toISOString();
    if (lookbackMs === 0) {
      return { entries: [], treatments: [] };
    }
    const entriesFrom = windowStart(entriesCursor);
    const treatmentsFrom = windowStart(treatmentsCursor);
    const [entries, treatments] = await Promise.all([
      this.client.fetchEntries({ patient_id: source.patient_id, cursor: entriesFrom, before: entriesCursor, limit: ENTRIES_PAGE_SIZE }),
      this.client.fetchTreatments({ patient_id: source.patient_id, cursor: treatmentsFrom, before: treatmentsCursor, limit: TREATMENTS_PAGE_SIZE }),
    ]);
    return { entries: entries.entries, treatments: treatments.treatments };
  }

  /**
   * Of the look-back window, the records not imported yet (by natural key or canonical hash). Rejected ones are dropped
   * silently: they would be logged again on every sync.
   */
  private async dropImportedRecords(
    source: SyncSourceRecord,
    window: { entries: NightscoutEntryDto[]; treatments: NightscoutTreatmentDto[] },
    entriesCursor: string,
    treatmentsCursor: string,
    nowIso: string,
  ): Promise<{ entries: NightscoutEntryDto[]; treatments: NightscoutTreatmentDto[] }> {
    const entries = window.entries.flatMap((entry) => {
      const normalized = normalizeNightscoutEntry(entry, source.patient_id, nowIso);
      return normalized.status === 'REJECTED' || normalized.reading.observed_at >= entriesCursor
        ? []
        : [{ dto: entry, natural_key: normalized.reading.natural_key, canonical_hash: normalized.reading.canonical_hash }];
    });
    const lateContext: NightscoutTreatmentDto[] = [];
    const treatments = window.treatments.flatMap((treatment) => {
      const normalized = normalizeNightscoutTreatment(treatment, source.patient_id, nowIso);
      if (normalized.status === 'REJECTED') {
        // A site / sensor / reservoir change or target uploaded after the cursor passed it (Trio uploads them minutes
        // late): the import rejects it, but it is a context event (2026-10-29: a site change missing from the chat).
        if (normalized.reason === 'unsupported_event_type') lateContext.push(treatment);
        return [];
      }
      return normalized.treatment.occurred_at >= treatmentsCursor
        ? []
        : [{ dto: treatment, natural_key: normalized.treatment.natural_key, canonical_hash: normalized.treatment.canonical_hash }];
    });
    for (const treatment of lateContext) {
      const event = toTherapyContextEvent(treatment);
      if (!event || this.lateContextSeen.has(`${source.id}:${event.source_record_id}`)) continue;
      if (await this.storeContextEvent(source, treatment)) this.lateContextSeen.add(`${source.id}:${event.source_record_id}`);
    }
    if (entries.length === 0 && treatments.length === 0) {
      return { entries: [], treatments: [] };
    }
    const imported = await this.nightscoutRepository.listImportedNaturalKeys(source.id, [...entries, ...treatments]);
    return {
      entries: entries.filter((entry) => !imported.has(entry.natural_key)).map((entry) => entry.dto),
      treatments: treatments.filter((treatment) => !imported.has(treatment.natural_key)).map((treatment) => treatment.dto),
    };
  }

  /**
   * Stores a Trio / Nightscout context treatment (therapy-context-events.v1); true when it is one (stored now or
   * before). A failure is logged and the treatment counted as rejected, as before.
   */
  private async storeContextEvent(source: SyncSourceRecord, treatment: NightscoutTreatmentDto): Promise<boolean> {
    const event = toTherapyContextEvent(treatment);
    if (!event) return false;
    try {
      await this.nightscoutRepository.storeTherapyContextEvent(source.patient_id, event);
      return true;
    } catch (error) {
      this.logger.warn(JSON.stringify({ event: 'therapy_context_event_failed', source_id: source.id, kind: event.kind, error: error instanceof Error ? error.message.slice(0, 120) : 'UNKNOWN' }));
      return false;
    }
  }

  private readonly contextBackfills = new Set<string>();
  /** Context events of the look-back window already stored by this process: not written again on every sync. */
  private readonly lateContextSeen = new Set<string>();

  /**
   * Once per source (metadata.context_events_backfilled_v2_at; v2 re-runs it once for the context events the look-back
   * window dropped before 2026-10-29): the context treatments of the last 30 days, which the import
   * used to reject. In the background, so it never delays the sync that a chat answer waits for.
   */
  private backfillContextEvents(source: SyncSourceRecord): void {
    if (this.contextBackfills.has(source.id)) return;
    this.contextBackfills.add(source.id);
    void (async () => {
      let stored = 0;
      let cursor = new Date(Date.now() - CONTEXT_BACKFILL_DAYS * 86_400_000).toISOString();
      for (let page = 0; page < CONTEXT_BACKFILL_MAX_PAGES; page += 1) {
        const { treatments } = await this.client.fetchTreatments({ patient_id: source.patient_id, cursor, limit: TREATMENTS_PAGE_SIZE });
        for (const treatment of treatments) {
          if (toTherapyContextEvent(treatment) && await this.storeContextEvent(source, treatment)) stored += 1;
        }
        const last = treatments.at(-1);
        const next = last ? parseNightscoutTimestampLoose(last.created_at ?? last.timestamp) : null;
        if (treatments.length < TREATMENTS_PAGE_SIZE || !next || next <= cursor) break;
        cursor = next;
      }
      await this.nightscoutRepository.setSourceMetadataValue(source.id, 'context_events_backfilled_v2_at', new Date().toISOString());
      this.logger.log(JSON.stringify({ event: 'therapy_context_backfill_finished', source_id: source.id, stored }));
    })().catch((error: unknown) => {
      this.contextBackfills.delete(source.id);
      this.logger.warn(JSON.stringify({ event: 'therapy_context_backfill_failed', source_id: source.id, error: error instanceof Error ? error.message.slice(0, 120) : 'UNKNOWN' }));
    });
  }

  /** NIGHTSCOUT_INITIAL_HISTORY_DAYS (default 30) and NIGHTSCOUT_INITIAL_DEVICESTATUS_DAYS (default 7). */
  private historyWindowConfig(): HistoryWindowConfig {
    const read = (key: string, fallback: number) => {
      const value = Number(this.configService?.get<number | string>(key) ?? fallback);
      return Number.isInteger(value) && value >= 1 && value <= 365 ? value : fallback;
    };
    return { historyDays: read('NIGHTSCOUT_INITIAL_HISTORY_DAYS', DEFAULT_INITIAL_HISTORY_DAYS), deviceStatusDays: read('NIGHTSCOUT_INITIAL_DEVICESTATUS_DAYS', DEFAULT_INITIAL_DEVICESTATUS_DAYS) };
  }

  private readonly historyBackfills = new Map<string, Promise<HistoryBackfillStats | null>>();
  private backgroundStopped = false;
  /** Pause between history pages; tests set 0. */
  historyPagePauseMs = DEFAULT_HISTORY_PAGE_PAUSE_MS;

  /** The worker is stopping: history imports stop before their next page (the stored progress resumes them). */
  stopBackgroundWork(): void {
    this.backgroundStopped = true;
  }

  /**
   * The source's history import (nightscout-history.v1), in the background: started after a live sync, at most one per
   * source in this process, a no-op once the plan is complete. A source without a plan (a new one, one added in the
   * app, one from before the import existed) gets one first. Resolves to null when nothing ran.
   */
  startHistoryBackfill(sourceId: string): Promise<HistoryBackfillStats | null> {
    const running = this.historyBackfills.get(sourceId);
    if (running) return running;
    const run = this.runHistoryBackfillOnce(sourceId).catch((error: unknown) => {
      this.logger.warn(JSON.stringify({ event: 'nightscout_history_failed', source_id: sourceId, error: error instanceof Error ? error.message.slice(0, 120) : 'UNKNOWN' }));
      return null;
    }).finally(() => {
      this.historyBackfills.delete(sourceId);
    });
    this.historyBackfills.set(sourceId, run);
    return run;
  }

  private async runHistoryBackfillOnce(sourceId: string): Promise<HistoryBackfillStats | null> {
    if (this.backgroundStopped) return null;
    const source = await this.nightscoutRepository.getNightscoutSourceById(sourceId);
    if (!source) return null;
    let plan = readHistoryBackfillPlan(source.metadata);
    if (!plan) {
      const nowIso = new Date().toISOString();
      plan = newHistoryBackfillPlan({ nowIso, liveFrom: new Date(Date.parse(nowIso) - LIVE_SYNC_MAX_CATCHUP_MS).toISOString(), config: this.historyWindowConfig() });
      const stored = source.metadata?.history_backfill;
      const storedRevision = stored && typeof stored === 'object' && typeof (stored as Record<string, unknown>).revision === 'number' ? (stored as { revision: number }).revision : null;
      // An unreadable stored plan is replaced (its revision kept in step).
      if (storedRevision !== null) plan = { ...plan, revision: storedRevision + 1 };
      if (!(await this.nightscoutRepository.writeHistoryBackfillPlan(source.id, plan, storedRevision))) return null;
      this.logger.log(JSON.stringify({ event: 'nightscout_history_planned', source_id: source.id, from: plan.from, to: plan.to, devicestatus_from: plan.devicestatus_from }));
    }
    if (plan.completed_at) return null;
    const startedAtMs = Date.now();
    const { plan: finished, stats } = await runHistoryBackfill({
      client: this.client,
      repository: this.nightscoutRepository as never,
      storeContextEvent: (treatment) => this.storeContextEvent(source, treatment),
      detectHistoricalHypo: (eventId) => this.runHypoDetectionJob(eventId, source.patient_id, new Date().toISOString()),
      log: (event) => this.logger.warn(JSON.stringify(event)),
      pauseMs: this.historyPagePauseMs,
      shouldStop: () => this.backgroundStopped,
    }, source, plan);
    this.logger.log(JSON.stringify({
      event: 'nightscout_history_run_finished',
      source_id: source.id,
      outcome: stats.outcome,
      completed: finished.completed_at !== null,
      pages: stats.pages,
      fetched: stats.fetched,
      imported: stats.imported,
      skipped_already_imported: stats.skipped_already_imported,
      context_events: stats.context_events,
      rejected: stats.rejected,
      duration_ms: Date.now() - startedAtMs,
      heap_used_mb: Math.round(process.memoryUsage().heapUsed / 1_048_576),
    }));
    return stats;
  }

  /**
   * A live cursor more than a day old (a restored backup, a long outage): the live sync starts a day back instead, and
   * the skipped time goes to the history import as HISTORICAL (no loop actions or pushes for days-old records).
   */
  private async recordHistoryGap(source: SyncSourceRecord, gapFromIso: string, nowIso: string, liveFromIso: string): Promise<void> {
    const config = this.historyWindowConfig();
    // A gap older than the configured history is cut to it (as withHistoryGap does).
    const oldestIso = new Date(Date.parse(nowIso) - config.historyDays * 86_400_000).toISOString();
    if (gapFromIso < oldestIso) gapFromIso = oldestIso;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const current = attempt === 0 ? source : await this.nightscoutRepository.getNightscoutSourceById(source.id);
      if (!current) return;
      const plan = readHistoryBackfillPlan(current.metadata);
      // Already planned (the cursors stay old until a record moves them): nothing to add.
      if (plan && Date.parse(plan.from) <= Date.parse(gapFromIso) && Date.parse(plan.to) >= Date.parse(liveFromIso)) return;
      const stored = current.metadata?.history_backfill;
      const storedRevision = stored && typeof stored === 'object' && typeof (stored as Record<string, unknown>).revision === 'number' ? (stored as { revision: number }).revision : null;
      const next = withHistoryGap(plan, { gapFrom: gapFromIso, nowIso, liveFrom: liveFromIso, config });
      const withRevision = storedRevision !== null && storedRevision >= next.revision ? { ...next, revision: storedRevision + 1 } : next;
      if (await this.nightscoutRepository.writeHistoryBackfillPlan(source.id, withRevision, storedRevision)) {
        await this.nightscoutRepository.advanceStreamCursors(source.id, liveFromIso);
        this.logger.warn(JSON.stringify({ event: 'nightscout_history_gap_added', source_id: source.id, gap_from: gapFromIso, live_from: liveFromIso }));
        return;
      }
    }
  }

  async runNightscoutSyncJob(sourceId: string, nowIso: string): Promise<NightscoutSyncResult> {
    const source = await this.nightscoutRepository.getNightscoutSourceById(sourceId);
    if (!source) {
      throw new Error('NIGHTSCOUT_SOURCE_NOT_FOUND');
    }

    this.logger.log(JSON.stringify({ event: 'sync_started', correlation_id: source.id, source_id: source.id, patient_id: source.patient_id, sync_run_id: randomUUID() }));

    const metadata = source.metadata && typeof source.metadata === 'object' ? source.metadata : {};
    const streamCursors = metadata.stream_cursors && typeof metadata.stream_cursors === 'object'
      ? metadata.stream_cursors as Record<string, unknown>
      : {};
    const storedEntriesCursor = typeof streamCursors.entries === 'string'
      ? streamCursors.entries
      : source.sync_cursor ?? source.last_successful_observed_at ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const storedTreatmentsCursor = typeof streamCursors.treatments === 'string'
      ? streamCursors.treatments
      : source.last_successful_observed_at ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const storedDeviceStatusCursor = typeof streamCursors.devicestatus === 'string'
      ? streamCursors.devicestatus
      : source.last_successful_observed_at ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    // Cursors more than a day old: the live sync reads the last day, the history import the rest (nightscout-history.v1).
    const nowMs = Number.isFinite(Date.parse(nowIso)) ? Date.parse(nowIso) : Date.now();
    const liveFloorIso = new Date(nowMs - LIVE_SYNC_MAX_CATCHUP_MS).toISOString();
    let gapFromIso: string | null = null;
    const clampToLiveFloor = (cursor: string): string => {
      const at = toCursorIso(cursor);
      if (!at || at >= liveFloorIso) return cursor;
      if (!gapFromIso || at < gapFromIso) gapFromIso = at;
      return liveFloorIso;
    };
    const entriesCursor = clampToLiveFloor(storedEntriesCursor);
    const treatmentsCursor = clampToLiveFloor(storedTreatmentsCursor);
    const deviceStatusCursor = clampToLiveFloor(storedDeviceStatusCursor);
    if (gapFromIso) {
      // The look-back of late uploads is part of the gap too.
      await this.recordHistoryGap(source, new Date(Date.parse(gapFromIso) - this.syncLookbackMs()).toISOString(), new Date(nowMs).toISOString(), liveFloorIso);
    }

    const configuredEntryPages = Number(this.configService?.get<number>('NIGHTSCOUT_SYNC_MAX_ENTRY_PAGES') ?? DEFAULT_MAX_ENTRY_PAGES);
    const maxEntryPages = Number.isInteger(configuredEntryPages) && configuredEntryPages > 0
      ? configuredEntryPages
      : DEFAULT_MAX_ENTRY_PAGES;

    let orderedEntries: NightscoutEntryDto[] = [];
    let entryPagesFetched = 0;
    let entryPageLimitReached = false;
    let treatmentsResult: Awaited<ReturnType<NightscoutClient['fetchTreatments']>>;
    let deviceStatusesResult: Awaited<ReturnType<NightscoutClient['fetchDeviceStatuses']>>;
    let profilesResult: Awaited<ReturnType<NightscoutClient['fetchProfiles']>> = { profiles: [], next_cursor: null };
    let lookbackWindow: { entries: NightscoutEntryDto[]; treatments: NightscoutTreatmentDto[] } = { entries: [], treatments: [] };
    // Read beside the forward fetches, so the look-back never delays a fresh reading (the refresh before an answer).
    const entriesLookbackEnd = toCursorIso(entriesCursor);
    const treatmentsLookbackEnd = toCursorIso(treatmentsCursor);
    const lookbackFetch = (entriesLookbackEnd && treatmentsLookbackEnd
      ? this.fetchLookbackWindow(source, entriesLookbackEnd, treatmentsLookbackEnd)
      : Promise.resolve({ entries: [], treatments: [] }))
      .then((value) => ({ value }), (error: unknown) => ({ error }));
    try {
      let nextEntriesCursor = entriesCursor;
      while (entryPagesFetched < maxEntryPages) {
        const entriesResult = await this.client.fetchEntries({
          patient_id: source.patient_id,
          cursor: nextEntriesCursor,
          limit: ENTRIES_PAGE_SIZE,
        });

        entryPagesFetched += 1;
        const orderedPage = [...entriesResult.entries].sort(sortEntriesAscending);
        if (orderedPage.length === 0) {
          break;
        }

        orderedEntries = orderedEntries.concat(orderedPage);

        if (orderedPage.length < ENTRIES_PAGE_SIZE) {
          break;
        }

        let pageMaxObserved = nextEntriesCursor;
        for (const pageEntry of orderedPage) {
          const observedAt = entryObservedAtIso(pageEntry);
          if (!observedAt) {
            continue;
          }

          if (!pageMaxObserved || observedAt > pageMaxObserved) {
            pageMaxObserved = observedAt;
          }
        }

        if (!pageMaxObserved || pageMaxObserved <= String(nextEntriesCursor ?? '')) {
          break;
        }

        nextEntriesCursor = pageMaxObserved;

        if (entryPagesFetched >= maxEntryPages) {
          entryPageLimitReached = true;
        }
      }

      treatmentsResult = await this.client.fetchTreatments({
        patient_id: source.patient_id,
        cursor: treatmentsCursor,
        limit: TREATMENTS_PAGE_SIZE,
      });

      const lookback = await lookbackFetch;
      if ('error' in lookback) {
        throw lookback.error;
      }
      lookbackWindow = lookback.value;

      if (typeof this.client.fetchDeviceStatuses === 'function') {
        deviceStatusesResult = await this.client.fetchDeviceStatuses({
          patient_id: source.patient_id,
          cursor: deviceStatusCursor,
          limit: 200,
        });
      } else {
        deviceStatusesResult = { device_statuses: [], next_cursor: null };
      }

      if (typeof this.client.fetchProfiles === 'function') {
        profilesResult = await this.client.fetchProfiles({
          patient_id: source.patient_id,
          cursor: null,
          limit: 25,
        });
      }
    } catch (error) {
      if (error instanceof NightscoutClientError) {
        throw error;
      }

      throw new NightscoutClientError(error instanceof Error ? error.message : 'Nightscout sync failed', true);
    }

    const lateRecords = entriesLookbackEnd && treatmentsLookbackEnd
      ? await this.dropImportedRecords(source, lookbackWindow, entriesLookbackEnd, treatmentsLookbackEnd, nowIso)
      : lookbackWindow;

    // Late treatments are LIVE like any new one: late carbs still become a loop action (and a meal, when the app's
    // command or the chat says so).
    const orderedTreatments = [...lateRecords.treatments, ...treatmentsResult.treatments].sort((left, right) => {
      const leftObserved = Date.parse(String(left.created_at ?? left.timestamp ?? ''));
      const rightObserved = Date.parse(String(right.created_at ?? right.timestamp ?? ''));
      if (leftObserved !== rightObserved) {
        return leftObserved - rightObserved;
      }

      const leftKey = String(left._id ?? left.id ?? left.eventId ?? '');
      const rightKey = String(right._id ?? right.id ?? right.eventId ?? '');
      return leftKey.localeCompare(rightKey);
    });

    let entryImported = 0;
    let entryRejected = 0;
    let entryDeduplicated = 0;
    let entryEventsCreated = 0;
    let entryJobsEnqueued = 0;
    // Late readings are older than readings already imported: HISTORICAL, so they never reach the live hypo flow out of
    // time order (a reading before the open episode's start would close it). Imported first, oldest first.
    const lateEntries = [...lateRecords.entries].sort(sortEntriesAscending);
    const entriesToImport = [
      ...lateEntries.map((entry) => ({ entry, origin: 'HISTORICAL' as const })),
      ...orderedEntries.map((entry) => ({ entry, origin: 'LIVE' as const })),
    ];
    for (const { entry, origin } of entriesToImport) {
      const importedAt = nowIso;
      const normalized = normalizeNightscoutEntry(entry, source.patient_id, importedAt);

      if (normalized.status === 'REJECTED') {
        entryRejected += 1;
        this.logger.warn(JSON.stringify({ event: 'record_rejected', source_id: source.id, patient_id: source.patient_id, reason: normalized.reason, canonical_hash: normalized.canonical_hash }));
        continue;
      }

      const persisted = await this.nightscoutRepository.persistImportedGlucoseReading({
        source,
        reading: normalized.reading,
        ingestionOrigin: origin,
        jobDedupeKey: `triggering.hypo_detection:${normalized.reading.natural_key}`,
        correlationId: source.id,
        causationId: source.id,
        jobPayload: {
          patient_id: source.patient_id,
          source_id: source.id,
          source_record_id: normalized.reading.source_record_id,
          natural_key: normalized.reading.natural_key,
          event_type: 'GLUCOSE_READING_AVAILABLE',
        },
      });

      if (persisted.source_record_created) {
        entryImported += 1;
      } else {
        entryDeduplicated += 1;
      }

      if (persisted.event_created) {
        entryEventsCreated += 1;
      }

      if (persisted.job_created) {
        entryJobsEnqueued += 1;
      }
    }

    const orderedDeviceStatuses = [...(deviceStatusesResult?.device_statuses ?? [])].sort((left, right) => {
      const leftObserved = Date.parse(String(left.created_at ?? left.timestamp ?? left.dateString ?? left.sysTime ?? left.date ?? ''));
      const rightObserved = Date.parse(String(right.created_at ?? right.timestamp ?? right.dateString ?? right.sysTime ?? right.date ?? ''));
      if (leftObserved !== rightObserved) {
        return leftObserved - rightObserved;
      }

      const leftKey = String(left._id ?? left.id ?? left.eventId ?? '');
      const rightKey = String(right._id ?? right.id ?? right.eventId ?? '');
      return leftKey.localeCompare(rightKey);
    });

    let deviceStatusImported = 0;
    let deviceStatusRejected = 0;
    let deviceStatusCurrentStateUpdates = 0;

    for (const devicestatus of orderedDeviceStatuses) {
      const importedAt = nowIso;
      const normalized = normalizeNightscoutDeviceStatus(devicestatus, source.patient_id, importedAt);
      if (normalized.status === 'REJECTED') {
        deviceStatusRejected += 1;
        this.logger.warn(JSON.stringify({
          event: 'devicestatus_rejected',
          source_id: source.id,
          patient_id: source.patient_id,
          reason: normalized.reason,
          canonical_hash: normalized.canonical_hash,
        }));
        continue;
      }

      const persisted = await this.nightscoutRepository.persistImportedDeviceStatus({
        source,
        status: normalized.statusSnapshot,
        ingestionOrigin: 'LIVE',
        correlationId: source.id,
        causationId: source.id,
      });

      if (persisted.source_record_created) {
        deviceStatusImported += 1;
      }

      if (persisted.current_state_updated) {
        deviceStatusCurrentStateUpdates += 1;
      }
    }

    let treatmentImported = 0;
    let treatmentRejected = 0;
    let treatmentDeduplicated = 0;
    let treatmentEventsCreated = 0;
    let therapyProfilesPersisted = 0;
    let therapyProfilesSkipped = 0;

    for (const profile of profilesResult.profiles) {
      const normalized = normalizeNightscoutProfile(profile, source.patient_id, nowIso);
      if (!normalized) {
        therapyProfilesSkipped += 1;
        this.logger.warn(JSON.stringify({
          event: 'therapy_profile_rejected',
          source_id: source.id,
          patient_id: source.patient_id,
          reason: 'incomplete_or_foreign_profile',
          source_profile_id: String(profile._id ?? profile.id ?? 'unknown'),
        }));
        continue;
      }

      const persisted = await this.nightscoutRepository.persistImportedTherapyProfile({
        source,
        profile: normalized,
      });

      if (persisted && persisted.created) {
        therapyProfilesPersisted += 1;
      }
    }

    for (const treatment of orderedTreatments) {
      const importedAt = nowIso;
      const normalized = normalizeNightscoutTreatment(treatment, source.patient_id, importedAt);

      if (normalized.status === 'REJECTED') {
        // A temporary target, override, site change, note…: kept apart for the AI (therapy-context-events.v1).
        if (normalized.reason === 'unsupported_event_type' && await this.storeContextEvent(source, treatment)) continue;
        treatmentRejected += 1;
        this.logger.warn(JSON.stringify({
          event: 'treatment_rejected',
          source_id: source.id,
          patient_id: source.patient_id,
          reason: normalized.reason,
          canonical_hash: normalized.canonical_hash,
        }));
        continue;
      }

      const persisted = await this.nightscoutRepository.persistImportedTreatment({
        source,
        treatment: normalized.treatment,
        ingestionOrigin: 'LIVE',
      });

      if (persisted.duplicate_of_event_id && persisted.source_record_created) {
        this.logger.warn(JSON.stringify({
          event: 'treatment_duplicate_upload',
          source_id: source.id,
          patient_id: source.patient_id,
          event_type: normalized.treatment.event_type,
          source_record_id: normalized.treatment.source_record_id,
          duplicate_of_event_id: persisted.duplicate_of_event_id,
        }));
      }

      if (persisted.source_record_created && !persisted.duplicate_of_event_id) {
        treatmentImported += 1;
      } else {
        treatmentDeduplicated += 1;
      }

      if (persisted.event_created) {
        treatmentEventsCreated += 1;
      }
    }

    const result: NightscoutSyncResult = {
      entries: {
        fetched: orderedEntries.length + lateEntries.length,
        imported: entryImported,
        deduplicated: entryDeduplicated,
        rejected: entryRejected,
        events_created: entryEventsCreated,
        jobs_enqueued: entryJobsEnqueued,
      },
      treatments: {
        fetched: orderedTreatments.length,
        imported: treatmentImported,
        deduplicated: treatmentDeduplicated,
        rejected: treatmentRejected,
        events_created: treatmentEventsCreated,
        // Treatments queue no jobs (loop actions group them on the worker's own timer).
        jobs_enqueued: 0,
      },
      records_fetched: orderedEntries.length + lateEntries.length,
      records_imported: entryImported,
      records_deduplicated: entryDeduplicated,
      records_rejected: entryRejected,
      events_created: entryEventsCreated,
      jobs_enqueued: entryJobsEnqueued,
    };

    this.logger.log(JSON.stringify({
      event: 'sync_completed',
      correlation_id: source.id,
      source_id: source.id,
      patient_id: source.patient_id,
      entries_fetched: result.entries.fetched,
      entries_imported: result.entries.imported,
      entries_deduplicated: result.entries.deduplicated,
      entries_rejected: result.entries.rejected,
      entries_events_created: result.entries.events_created,
      entries_jobs_enqueued: result.entries.jobs_enqueued,
      entries_pages_fetched: entryPagesFetched,
      late_entries: lateEntries.length,
      late_treatments: lateRecords.treatments.length,
      entries_page_size: ENTRIES_PAGE_SIZE,
      entries_page_limit: maxEntryPages,
      entries_page_limit_reached: entryPageLimitReached,
      treatments_fetched: result.treatments.fetched,
      treatments_imported: result.treatments.imported,
      treatments_deduplicated: result.treatments.deduplicated,
      treatments_rejected: result.treatments.rejected,
      treatments_events_created: result.treatments.events_created,
      treatments_jobs_enqueued: result.treatments.jobs_enqueued,
    }));

    // After the sync (never before what an answer waits for): the context treatments of the last 30 days, once.
    const sourceMetadata = (source.metadata && typeof source.metadata === 'object' ? source.metadata : {}) as Record<string, unknown>;
    if (typeof sourceMetadata.context_events_backfilled_v2_at !== 'string') this.backfillContextEvents(source);

    return result;
  }

  async runNightscoutSyncWindow(sourceId: string, nowIso: string, windowStartIso: string, windowEndIso: string): Promise<NightscoutSyncResult> {
    const source = await this.nightscoutRepository.getNightscoutSourceById(sourceId);
    if (!source) {
      throw new Error('NIGHTSCOUT_SOURCE_NOT_FOUND');
    }

    const toResult = (entries: StreamImportResult, treatments: StreamImportResult): NightscoutSyncResult => ({
      entries: {
        fetched: entries.fetched,
        imported: entries.imported,
        deduplicated: entries.deduplicated,
        rejected: entries.rejected,
        events_created: entries.eventsCreated,
        jobs_enqueued: entries.jobsEnqueued,
      },
      treatments: {
        fetched: treatments.fetched,
        imported: treatments.imported,
        deduplicated: treatments.deduplicated,
        rejected: treatments.rejected,
        events_created: treatments.eventsCreated,
        jobs_enqueued: treatments.jobsEnqueued,
      },
      records_fetched: entries.fetched,
      records_imported: entries.imported,
      records_deduplicated: entries.deduplicated,
      records_rejected: entries.rejected,
      events_created: entries.eventsCreated,
      jobs_enqueued: entries.jobsEnqueued,
    });

    const importEntries = async (): Promise<StreamImportResult> => {
      const result: StreamImportResult = {
        fetched: 0,
        imported: 0,
        deduplicated: 0,
        rejected: 0,
        eventsCreated: 0,
        jobsEnqueued: 0,
      };
      let cursor = windowStartIso;
      const seen = new Set<string>();

      while (true) {
        const page = await this.client.fetchEntries({
          patient_id: source.patient_id,
          cursor,
          limit: 500,
        });

        const ordered = [...page.entries].sort(sortEntriesAscending);

        if (ordered.length === 0) {
          break;
        }

        const fresh = ordered.filter((record) => markFirstSeen(seen, record));
        result.fetched += fresh.length;

        let observedBeyondWindow = false;
        let pageMaxObserved = cursor;
        for (const entry of fresh) {
          const observedAt = entryObservedAtIso(entry);
          if (!observedAt) {
            result.rejected += 1;
            continue;
          }
          if (observedAt > windowEndIso) {
            observedBeyondWindow = true;
            continue;
          }

          if (observedAt > pageMaxObserved) {
            pageMaxObserved = observedAt;
          }

          const normalized = normalizeNightscoutEntry(entry, source.patient_id, nowIso);
          if (normalized.status === 'REJECTED') {
            result.rejected += 1;
            continue;
          }

          const persisted = await this.nightscoutRepository.persistImportedGlucoseReading({
            source,
            reading: normalized.reading,
            ingestionOrigin: 'HISTORICAL',
            jobDedupeKey: `triggering.hypo_detection:${normalized.reading.natural_key}`,
            correlationId: source.id,
            causationId: source.id,
            jobPayload: {
              patient_id: source.patient_id,
              source_id: source.id,
              source_record_id: normalized.reading.source_record_id,
              natural_key: normalized.reading.natural_key,
              event_type: 'GLUCOSE_READING_AVAILABLE',
            },
          });

          if (persisted.source_record_created) {
            result.imported += 1;
          } else {
            result.deduplicated += 1;
          }
          if (persisted.event_created) {
            result.eventsCreated += 1;
          }
          if (persisted.job_created) {
            result.jobsEnqueued += 1;
          }
        }

        if (observedBeyondWindow || ordered.length < 500) {
          break;
        }

        if (pageMaxObserved <= cursor) {
          // A full page with nothing newer than the cursor's millisecond: the next request would return it again.
          this.logger.warn(JSON.stringify({ event: 'sync_window_page_not_advancing', stream: 'entries', source_id: source.id, patient_id: source.patient_id, cursor }));
          break;
        }

        cursor = pageMaxObserved;
      }

      return result;
    };

    const importTreatments = async (): Promise<StreamImportResult> => {
      const result: StreamImportResult = {
        fetched: 0,
        imported: 0,
        deduplicated: 0,
        rejected: 0,
        eventsCreated: 0,
        jobsEnqueued: 0,
      };
      let cursor = windowStartIso;
      const seen = new Set<string>();

      while (true) {
        const page = await this.client.fetchTreatments({
          patient_id: source.patient_id,
          cursor,
          limit: 500,
        });

        const ordered = [...page.treatments].sort((left, right) => {
          const leftObserved = Date.parse(String(left.created_at ?? left.timestamp ?? ''));
          const rightObserved = Date.parse(String(right.created_at ?? right.timestamp ?? ''));
          if (leftObserved !== rightObserved) {
            return leftObserved - rightObserved;
          }
          const leftKey = String(left._id ?? left.id ?? left.eventId ?? '');
          const rightKey = String(right._id ?? right.id ?? right.eventId ?? '');
          return leftKey.localeCompare(rightKey);
        });

        if (ordered.length === 0) {
          break;
        }

        const fresh = ordered.filter((record) => markFirstSeen(seen, record));
        result.fetched += fresh.length;

        let observedBeyondWindow = false;
        let pageMaxObserved = cursor;
        for (const treatment of fresh) {
          const observedCandidate = String(treatment.created_at ?? treatment.timestamp ?? '');
          const observedMs = Date.parse(observedCandidate);
          if (!Number.isFinite(observedMs)) {
            result.rejected += 1;
            continue;
          }
          const observedAt = new Date(observedMs).toISOString();
          if (observedAt > windowEndIso) {
            observedBeyondWindow = true;
            continue;
          }

          if (observedAt > pageMaxObserved) {
            pageMaxObserved = observedAt;
          }

          const normalized = normalizeNightscoutTreatment(treatment, source.patient_id, nowIso);
          if (normalized.status === 'REJECTED') {
            if (normalized.reason === 'unsupported_event_type' && await this.storeContextEvent(source, treatment)) continue;
            result.rejected += 1;
            continue;
          }

          const persisted = await this.nightscoutRepository.persistImportedTreatment({
            source,
            treatment: normalized.treatment,
            ingestionOrigin: 'HISTORICAL',
          });

          if (persisted.source_record_created && !persisted.duplicate_of_event_id) {
            result.imported += 1;
          } else {
            result.deduplicated += 1;
          }
          if (persisted.event_created) {
            result.eventsCreated += 1;
          }
        }

        if (observedBeyondWindow || ordered.length < 500) {
          break;
        }

        if (pageMaxObserved <= cursor) {
          // A full page with nothing newer than the cursor's millisecond: the next request would return it again.
          this.logger.warn(JSON.stringify({ event: 'sync_window_page_not_advancing', stream: 'treatments', source_id: source.id, patient_id: source.patient_id, cursor }));
          break;
        }

        cursor = pageMaxObserved;
      }

      return result;
    };

    const [entries, treatments] = await Promise.all([
      importEntries(),
      importTreatments(),
    ]);

    const result = toResult(entries, treatments);
    this.logger.log(JSON.stringify({
      event: 'sync_window_completed',
      source_id: source.id,
      patient_id: source.patient_id,
      window_start: windowStartIso,
      window_end: windowEndIso,
      entries_fetched: result.entries.fetched,
      entries_imported: result.entries.imported,
      entries_deduplicated: result.entries.deduplicated,
      entries_rejected: result.entries.rejected,
      entries_events_created: result.entries.events_created,
      entries_jobs_enqueued: result.entries.jobs_enqueued,
      treatments_fetched: result.treatments.fetched,
      treatments_imported: result.treatments.imported,
      treatments_deduplicated: result.treatments.deduplicated,
      treatments_rejected: result.treatments.rejected,
      treatments_events_created: result.treatments.events_created,
      treatments_jobs_enqueued: result.treatments.jobs_enqueued,
    }));

    return result;
  }

  async runHypoDetectionJob(eventId: string, patientId: string, now: string = new Date().toISOString()): Promise<{ trigger_created: boolean; episode_created: boolean; skipped_reason?: 'STALE_READING_FOR_NEW_HYPO' | 'HISTORICAL_READING_BEFORE_EPISODE_START' | 'RECOVERY_NOT_CONFIRMED' }> {
    const imported = await this.nightscoutRepository.getImportedReadingForEvent(eventId);
    if (!imported) {
      throw new Error('IMPORTED_READING_NOT_FOUND');
    }

    // HISTORICAL (backfilled) readings are processed analytically: they create triggers and episodes for later
    // range analysis, but no conversation and no analysis.follow_up job (see persistHypoDetection). Episodes are
    // kept apart by origin, so a backfill never continues or closes a LIVE episode and never absorbs a LIVE hypo.
    // The origin is never guessed: anything other than LIVE or HISTORICAL stops the job before any write.
    const rawOrigin = imported.event_ingestion_origin;
    if (rawOrigin !== 'LIVE' && rawOrigin !== 'HISTORICAL') {
      throw new Error('UNKNOWN_EVENT_INGESTION_ORIGIN');
    }
    const origin: 'LIVE' | 'HISTORICAL' = rawOrigin;
    const isLive = origin === 'LIVE';

    const reading = {
      reading_id: String(imported.event_id),
      source_record_id: String(imported.source_identity ?? imported.source_record_id),
      observed_at: toIsoTimestamp(imported.occurred_at),
      recorded_at: toIsoTimestamp(imported.recorded_at),
      glucose_value: Number((imported.payload as Record<string, unknown>).glucose_value),
      glucose_unit: 'mg/dL' as const,
      classification: 'UNKNOWN' as const,
      relation_to_episode: 'LATEST' as const,
      validity: 'VALID' as const,
      provenance_ref: `source-record/${imported.source_record_id}`,
    };

    const existingEpisode = await this.nightscoutRepository.getLatestOpenHypoEpisode(patientId, origin);

    // Backfills are not processed in time order: a HISTORICAL reading older than the open episode's start must not
    // close it (negative duration) or change its severity or latest reading.
    if (!isLive && existingEpisode && new Date(reading.observed_at).getTime() < new Date(existingEpisode.started_at).getTime()) {
      return {
        trigger_created: false,
        episode_created: false,
        skipped_reason: 'HISTORICAL_READING_BEFORE_EPISODE_START',
      };
    }

    const detection = detectHypo({
      patient_id: patientId,
      rule_version: 'hypo.cgm.ada2026.v1',
      existing_episode: existingEpisode,
      reading,
    });

    // A stale LIVE reading (backlog after downtime) must not open a new episode and its question/analysis/push.
    // It still continues or closes an existing episode, so no episode is left open by skipping it. HISTORICAL
    // readings are old by definition and never user-facing, so the guard does not apply to them.
    if (isLive && detection.status === 'HYPO_DETECTED_NEW' && isReadingTooStaleToStartHypoFlow(reading, now)) {
      this.logger.warn(JSON.stringify({ event: 'hypo_new_flow_skipped_stale_reading', patient_id: patientId, event_id: reading.reading_id, observed_at: reading.observed_at, now }));
      return {
        trigger_created: false,
        episode_created: false,
        skipped_reason: 'STALE_READING_FOR_NEW_HYPO',
      };
    }

    // A hypo is over only 15 min after its last reading below 70 mg/dL, every reading since at >= 70 (the consensus end
    // of an episode): glucose hovering around 70 (68, 71, 69, 72) stays one episode with one report, not one per dip.
    // It ended at the first reading back at >= 70.
    const closesOpenEpisode = detection.status === 'NO_HYPO' && existingEpisode?.state === 'OPEN';
    let endedAt: string | null = null;
    if (closesOpenEpisode && existingEpisode) {
      const recovery = await this.nightscoutRepository.getHypoRecoveryStart(patientId, origin, existingEpisode.started_at, reading.observed_at);
      const lastLowMs = new Date(recovery.last_low_at ?? existingEpisode.started_at).getTime();
      if (new Date(reading.observed_at).getTime() - lastLowMs < HYPO_RECOVERY_CONFIRM_MINUTES * 60_000) {
        return { trigger_created: false, episode_created: false, skipped_reason: 'RECOVERY_NOT_CONFIRMED' };
      }
      endedAt = recovery.since ?? reading.observed_at;
    }

    return this.nightscoutRepository.persistHypoDetection({
      patientId,
      reading,
      detection,
      existingEpisode,
      origin,
      endedAt,
    });
  }
}