import type { NightscoutClient, NightscoutDeviceStatusDto, NightscoutEntryDto, NightscoutTreatmentDto } from './nightscout-client';
import { nightscoutEntryObservedAt, normalizeNightscoutEntry } from './nightscout-normalizer';
import { normalizeNightscoutTreatment } from './nightscout-treatment-normalizer';
import { normalizeNightscoutDeviceStatus } from './nightscout-devicestatus-normalizer';

/**
 * Nightscout history import (nightscout-history.v1). A new source used to get only the last 24 h (the live
 * sync's first cursor), so a fresh install answered "last week" from one day of data and read the empty days as a pump
 * that delivered only basal. Every source now gets a plan in its metadata (`history_backfill`): the last
 * NIGHTSCOUT_INITIAL_HISTORY_DAYS of treatments and CGM entries and NIGHTSCOUT_INITIAL_DEVICESTATUS_DAYS of device
 * statuses, read page by page in the background after the live sync (never before what an answer waits for), stored as
 * HISTORICAL (no loop actions, meals, hypo questions or pushes) and resumed from the stored progress after a restart.
 * A source whose live cursors fell more than a day behind (a restored backup, a long outage) has the gap added to the
 * plan instead of being read as LIVE.
 */
export const HISTORY_BACKFILL_METADATA_KEY = 'history_backfill';
export const HISTORY_BACKFILL_POLICY_VERSION = 'nightscout-history.v1';
export const DEFAULT_INITIAL_HISTORY_DAYS = 30;
/** Device statuses are big (Trio's predictions, ~2-5 kB each) and only the chart's IOB/COB and "as of" lookups read them. */
export const DEFAULT_INITIAL_DEVICESTATUS_DAYS = 7;
/** The live sync reads at most this far back; older cursors are clamped and the gap goes to the history import. */
export const LIVE_SYNC_MAX_CATCHUP_MS = 24 * 60 * 60 * 1000;
/** Records per Nightscout request: ~0.2 MB of entries or treatments, ~0.5 MB of device statuses. */
export const HISTORY_PAGE_SIZES = { treatments: 500, entries: 500, devicestatus: 100 } as const;
/** Pause between pages: the history never hogs a small Nightscout or the database the live sync uses. */
export const DEFAULT_HISTORY_PAGE_PAUSE_MS = 300;

export type HistoryStream = keyof typeof HISTORY_PAGE_SIZES;
/** Read in this order: insulin and carbs first (what totals and doses are read from), then CGM, then device statuses. */
export const HISTORY_STREAMS: readonly HistoryStream[] = ['treatments', 'entries', 'devicestatus'];

export interface HistoryBackfillPlan {
  policy_version: typeof HISTORY_BACKFILL_POLICY_VERSION;
  /** Bumped by every new plan or gap: a run holding an older revision stops instead of overwriting it. */
  revision: number;
  /** [from, to): the window to import. */
  from: string;
  to: string;
  devicestatus_from: string;
  /** The live sync holds everything from here on (its first cursor, or the clamped one after a gap). */
  live_from: string;
  planned_at: string;
  /** Next cursor per stream, or DONE. */
  progress: Record<HistoryStream, string>;
  completed_at: string | null;
  /** Oldest start of any plan of this source: the history held once every plan is complete. */
  history_from: string;
}

export const HISTORY_STREAM_DONE = 'DONE';

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function minIso(left: string, right: string): string {
  return Date.parse(left) <= Date.parse(right) ? left : right;
}

function maxIso(left: string, right: string): string {
  return Date.parse(left) >= Date.parse(right) ? left : right;
}

function validIso(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? iso(ms) : null;
}

/** The stored plan, or null when the source has none (or an unreadable one: a new plan replaces it). */
export function readHistoryBackfillPlan(metadata: Record<string, unknown> | null | undefined): HistoryBackfillPlan | null {
  const raw = metadata && typeof metadata === 'object' ? (metadata as Record<string, unknown>)[HISTORY_BACKFILL_METADATA_KEY] : null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const plan = raw as Record<string, unknown>;
  const from = validIso(plan.from);
  const to = validIso(plan.to);
  const liveFrom = validIso(plan.live_from);
  const progress = plan.progress && typeof plan.progress === 'object' ? plan.progress as Record<string, unknown> : null;
  if (!from || !to || !liveFrom || !progress || typeof plan.revision !== 'number') return null;
  const streamProgress = {} as Record<HistoryStream, string>;
  for (const stream of HISTORY_STREAMS) {
    const value = progress[stream];
    const cursor = value === HISTORY_STREAM_DONE ? HISTORY_STREAM_DONE : validIso(value);
    if (!cursor) return null;
    streamProgress[stream] = cursor;
  }
  return {
    policy_version: HISTORY_BACKFILL_POLICY_VERSION,
    revision: plan.revision,
    from,
    to,
    devicestatus_from: validIso(plan.devicestatus_from) ?? from,
    live_from: liveFrom,
    planned_at: validIso(plan.planned_at) ?? to,
    progress: streamProgress,
    completed_at: validIso(plan.completed_at),
    history_from: validIso(plan.history_from) ?? from,
  };
}

export interface HistoryWindowConfig {
  historyDays: number;
  deviceStatusDays: number;
}

/** A source's first plan: the configured days before now; the live sync holds `liveFrom` on. */
export function newHistoryBackfillPlan(args: { nowIso: string; liveFrom: string; config: HistoryWindowConfig; revision?: number }): HistoryBackfillPlan {
  const nowMs = Date.parse(args.nowIso);
  const from = iso(nowMs - args.config.historyDays * 86_400_000);
  const devicestatusFrom = maxIso(from, iso(nowMs - Math.min(args.config.deviceStatusDays, args.config.historyDays) * 86_400_000));
  return {
    policy_version: HISTORY_BACKFILL_POLICY_VERSION,
    revision: args.revision ?? 1,
    from,
    to: iso(nowMs),
    devicestatus_from: devicestatusFrom,
    live_from: minIso(args.liveFrom, iso(nowMs)),
    planned_at: iso(nowMs),
    progress: { treatments: from, entries: from, devicestatus: devicestatusFrom },
    completed_at: null,
    history_from: from,
  };
}

/**
 * A gap [gapFrom, now) the live sync skipped (its cursors were older than a day): added to the plan. An unfinished plan
 * widens; a finished one gets a new window over the gap. Never narrower than the plan it extends.
 */
export function withHistoryGap(plan: HistoryBackfillPlan | null, args: { gapFrom: string; nowIso: string; liveFrom: string; config: HistoryWindowConfig }): HistoryBackfillPlan {
  // A gap older than the configured history is cut to it (a year-old backup does not import a year).
  const oldest = iso(Date.parse(args.nowIso) - args.config.historyDays * 86_400_000);
  const gapFrom = maxIso(args.gapFrom, oldest);
  const deviceStatusOldest = iso(Date.parse(args.nowIso) - Math.min(args.config.deviceStatusDays, args.config.historyDays) * 86_400_000);
  if (!plan) {
    return { ...newHistoryBackfillPlan({ nowIso: args.nowIso, liveFrom: args.liveFrom, config: args.config }), from: gapFrom, history_from: gapFrom, progress: { treatments: gapFrom, entries: gapFrom, devicestatus: maxIso(gapFrom, deviceStatusOldest) }, devicestatus_from: maxIso(gapFrom, deviceStatusOldest) };
  }
  const restart = (current: string, floor: string) => (current === HISTORY_STREAM_DONE ? floor : minIso(current, floor));
  const unfinished = plan.completed_at === null;
  const from = unfinished ? minIso(plan.from, gapFrom) : gapFrom;
  const devicestatusFrom = maxIso(from, deviceStatusOldest);
  return {
    ...plan,
    revision: plan.revision + 1,
    from,
    to: maxIso(plan.to, args.nowIso),
    devicestatus_from: unfinished ? minIso(plan.devicestatus_from, devicestatusFrom) : devicestatusFrom,
    live_from: args.liveFrom,
    planned_at: args.nowIso,
    progress: {
      treatments: unfinished ? restart(plan.progress.treatments, gapFrom) : gapFrom,
      entries: unfinished ? restart(plan.progress.entries, gapFrom) : gapFrom,
      devicestatus: unfinished ? restart(plan.progress.devicestatus, devicestatusFrom) : devicestatusFrom,
    },
    completed_at: null,
    history_from: minIso(plan.history_from, from),
  };
}

/** Share of the plan's time already read, over the three streams (0-100). */
export function historyBackfillProgressPercent(plan: HistoryBackfillPlan): number {
  if (plan.completed_at) return 100;
  const toMs = Date.parse(plan.to);
  let done = 0;
  let total = 0;
  for (const stream of HISTORY_STREAMS) {
    const fromMs = Date.parse(stream === 'devicestatus' ? plan.devicestatus_from : plan.from);
    const span = Math.max(0, toMs - fromMs);
    total += span;
    const cursor = plan.progress[stream];
    done += cursor === HISTORY_STREAM_DONE ? span : Math.min(span, Math.max(0, Date.parse(cursor) - fromMs));
  }
  return total === 0 ? 100 : Math.min(99, Math.floor((done / total) * 100));
}

export interface NightscoutHistoryCoverage {
  /** LOADING: the import still runs (or has not started); COMPLETE: every plan finished. */
  status: 'LOADING' | 'COMPLETE';
  /** CGM, insulin and carbs are complete in Mellis from here on (as far as Nightscout has them). */
  available_from: string;
  progress_percent: number | null;
}

/**
 * What the AI may rely on. COMPLETE: from the plan's history start, or the oldest reading imported before it (an older
 * install). LOADING: only the live sync's part is complete; without a plan (before the first sync), nothing older than
 * the newest day is.
 */
export function nightscoutHistoryCoverage(args: { metadata: Record<string, unknown> | null | undefined; oldestReadingAt: string | null; nowIso: string }): NightscoutHistoryCoverage {
  const plan = readHistoryBackfillPlan(args.metadata);
  if (!plan) {
    return { status: 'LOADING', available_from: iso(Date.parse(args.nowIso) - LIVE_SYNC_MAX_CATCHUP_MS), progress_percent: 0 };
  }
  if (plan.completed_at) {
    const oldest = validIso(args.oldestReadingAt);
    return { status: 'COMPLETE', available_from: oldest ? minIso(oldest, plan.history_from) : plan.history_from, progress_percent: null };
  }
  return { status: 'LOADING', available_from: plan.live_from, progress_percent: historyBackfillProgressPercent(plan) };
}

export interface HistoryBackfillSource {
  id: string;
  patient_id: string;
}

export interface HistoryBackfillRepository {
  persistImportedGlucoseReading(args: {
    source: never;
    reading: never;
    ingestionOrigin: 'HISTORICAL';
    historyBackfill: true;
    jobDedupeKey: string;
    correlationId: string;
    causationId: string;
    jobPayload: Record<string, unknown>;
  }): Promise<{ event_id: string | null; source_record_created: boolean; event_created: boolean }>;
  persistImportedTreatment(args: { source: never; treatment: never; ingestionOrigin: 'HISTORICAL' }): Promise<{ source_record_created: boolean; event_created: boolean; duplicate_of_event_id?: string | null }>;
  persistImportedDeviceStatus(args: { source: never; status: never; ingestionOrigin: 'HISTORICAL'; correlationId: string; causationId: string }): Promise<{ source_record_created: boolean }>;
  listImportedNaturalKeys(sourceId: string, records: Array<{ natural_key: string; canonical_hash: string }>): Promise<Set<string>>;
  /** Writes the plan when the stored one has `expectedRevision` (null: none stored); false when another run changed it. */
  writeHistoryBackfillPlan(sourceId: string, plan: HistoryBackfillPlan, expectedRevision: number | null): Promise<boolean>;
}

export interface HistoryBackfillDependencies {
  client: NightscoutClient;
  repository: HistoryBackfillRepository;
  /** A context treatment (site change, note, target…) kept for the AI; true when it is one. */
  storeContextEvent: (treatment: NightscoutTreatmentDto) => Promise<boolean>;
  /** The analytic (HISTORICAL) hypo detection of one imported reading, in time order. */
  detectHistoricalHypo: (eventId: string) => Promise<unknown>;
  log: (event: Record<string, unknown>) => void;
  pauseMs: number;
  sleep?: (ms: number) => Promise<void>;
  /** Asked before every page: true stops the run (the worker is stopping); the stored progress resumes it later. */
  shouldStop?: () => boolean;
  now?: () => string;
}

export interface HistoryBackfillStats {
  pages: number;
  fetched: Record<HistoryStream, number>;
  imported: Record<HistoryStream, number>;
  skipped_already_imported: number;
  context_events: number;
  rejected: number;
  outcome: 'COMPLETED' | 'STOPPED' | 'SUPERSEDED';
}

type PageRecord = { at: string | null; natural_key: string | null; canonical_hash: string | null; persist: (() => Promise<boolean>) | null; context: NightscoutTreatmentDto | null };

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Runs a plan to its end, page by page: each page's records not imported yet are stored as HISTORICAL, then the plan's
 * progress is written (so a restart resumes at the next page). Pages are read [cursor, to) oldest first; a record at the
 * cursor's millisecond comes again on the next page and is skipped by natural key.
 */
export async function runHistoryBackfill(deps: HistoryBackfillDependencies, source: HistoryBackfillSource, initialPlan: HistoryBackfillPlan): Promise<{ plan: HistoryBackfillPlan; stats: HistoryBackfillStats }> {
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? (() => new Date().toISOString());
  let plan = initialPlan;
  const stats: HistoryBackfillStats = {
    pages: 0,
    fetched: { treatments: 0, entries: 0, devicestatus: 0 },
    imported: { treatments: 0, entries: 0, devicestatus: 0 },
    skipped_already_imported: 0,
    context_events: 0,
    rejected: 0,
    outcome: 'COMPLETED',
  };

  for (const stream of HISTORY_STREAMS) {
    while (plan.progress[stream] !== HISTORY_STREAM_DONE) {
      if (deps.shouldStop?.()) return { plan, stats: { ...stats, outcome: 'STOPPED' } };
      const cursor = plan.progress[stream];
      const limit = HISTORY_PAGE_SIZES[stream];
      const importedAt = now();
      const page = await fetchPage(deps.client, stream, source.patient_id, cursor, plan.to, limit);
      stats.pages += 1;
      stats.fetched[stream] += page.length;
      const records = page.map((record) => toPageRecord(deps, stream, source, record, importedAt));

      const keyed = records.filter((record): record is PageRecord & { natural_key: string; canonical_hash: string } => record.natural_key !== null && record.canonical_hash !== null);
      const imported = keyed.length > 0 ? await deps.repository.listImportedNaturalKeys(source.id, keyed.map(({ natural_key, canonical_hash }) => ({ natural_key, canonical_hash }))) : new Set<string>();
      for (const record of records) {
        if (record.context) {
          if (await deps.storeContextEvent(record.context)) stats.context_events += 1;
          else stats.rejected += 1;
          continue;
        }
        if (!record.persist) {
          stats.rejected += 1;
          continue;
        }
        if (record.natural_key && imported.has(record.natural_key)) {
          stats.skipped_already_imported += 1;
          continue;
        }
        if (await record.persist()) stats.imported[stream] += 1;
      }

      const newest = records.reduce<string | null>((max, record) => (record.at && (!max || record.at > max) ? record.at : max), null);
      let next: string;
      if (page.length < limit || !newest) {
        next = HISTORY_STREAM_DONE;
      } else if (newest <= cursor) {
        // A full page within one millisecond: the next request would return it again.
        deps.log({ event: 'nightscout_history_page_not_advancing', source_id: source.id, stream, cursor });
        next = HISTORY_STREAM_DONE;
      } else {
        next = newest;
      }
      const updated: HistoryBackfillPlan = { ...plan, progress: { ...plan.progress, [stream]: next } };
      if (!(await deps.repository.writeHistoryBackfillPlan(source.id, updated, plan.revision))) {
        // A gap widened the plan meanwhile: the next run starts from the new one.
        return { plan, stats: { ...stats, outcome: 'SUPERSEDED' } };
      }
      plan = updated;
      if (next !== HISTORY_STREAM_DONE && deps.pauseMs > 0) await sleep(deps.pauseMs);
    }
  }

  const completed: HistoryBackfillPlan = { ...plan, completed_at: now() };
  if (!(await deps.repository.writeHistoryBackfillPlan(source.id, completed, plan.revision))) {
    return { plan, stats: { ...stats, outcome: 'SUPERSEDED' } };
  }
  return { plan: completed, stats };
}

async function fetchPage(client: NightscoutClient, stream: HistoryStream, patientId: string, cursor: string, before: string, limit: number): Promise<unknown[]> {
  switch (stream) {
    case 'treatments':
      return (await client.fetchTreatments({ patient_id: patientId, cursor, before, limit })).treatments;
    case 'entries':
      return (await client.fetchEntries({ patient_id: patientId, cursor, before, limit })).entries;
    case 'devicestatus':
      return (await client.fetchDeviceStatuses({ patient_id: patientId, cursor, before, limit })).device_statuses;
  }
}

function deviceStatusAt(status: NightscoutDeviceStatusDto): string | null {
  return validIso(status.created_at ?? status.timestamp ?? status.dateString ?? status.sysTime ?? (typeof status.date === 'number' ? new Date(status.date).toISOString() : status.date));
}

function toPageRecord(deps: HistoryBackfillDependencies, stream: HistoryStream, source: HistoryBackfillSource, record: unknown, importedAt: string): PageRecord {
  const sourceArg = source as never;
  if (stream === 'entries') {
    const entry = record as NightscoutEntryDto;
    const at = nightscoutEntryObservedAt(entry);
    const normalized = normalizeNightscoutEntry(entry, source.patient_id, importedAt);
    if (normalized.status === 'REJECTED') return { at, natural_key: null, canonical_hash: null, persist: null, context: null };
    const reading = normalized.reading;
    return {
      at,
      natural_key: reading.natural_key,
      canonical_hash: reading.canonical_hash,
      context: null,
      persist: async () => {
        const persisted = await deps.repository.persistImportedGlucoseReading({
          source: sourceArg,
          reading: reading as never,
          ingestionOrigin: 'HISTORICAL',
          historyBackfill: true,
          jobDedupeKey: `triggering.hypo_detection:${reading.natural_key}`,
          correlationId: source.id,
          causationId: source.id,
          jobPayload: { patient_id: source.patient_id, source_id: source.id, source_record_id: reading.source_record_id, natural_key: reading.natural_key, event_type: 'GLUCOSE_READING_AVAILABLE' },
        });
        if (persisted.event_created && persisted.event_id) {
          // Episodes for range analyses only: HISTORICAL never asks, pushes or opens a chat.
          await deps.detectHistoricalHypo(persisted.event_id).catch((error: unknown) => {
            deps.log({ event: 'nightscout_history_hypo_detection_failed', source_id: source.id, error: error instanceof Error ? error.message.slice(0, 120) : 'UNKNOWN' });
          });
        }
        return persisted.source_record_created;
      },
    };
  }
  if (stream === 'treatments') {
    const treatment = record as NightscoutTreatmentDto;
    const at = validIso(treatment.created_at ?? treatment.timestamp);
    const normalized = normalizeNightscoutTreatment(treatment, source.patient_id, importedAt);
    if (normalized.status === 'REJECTED') {
      return { at, natural_key: null, canonical_hash: null, persist: null, context: normalized.reason === 'unsupported_event_type' ? treatment : null };
    }
    return {
      at,
      natural_key: normalized.treatment.natural_key,
      canonical_hash: normalized.treatment.canonical_hash,
      context: null,
      persist: async () => {
        const persisted = await deps.repository.persistImportedTreatment({ source: sourceArg, treatment: normalized.treatment as never, ingestionOrigin: 'HISTORICAL' });
        return persisted.source_record_created && !persisted.duplicate_of_event_id;
      },
    };
  }
  const status = record as NightscoutDeviceStatusDto;
  const at = deviceStatusAt(status);
  const normalized = normalizeNightscoutDeviceStatus(status, source.patient_id, importedAt);
  if (normalized.status === 'REJECTED') return { at, natural_key: null, canonical_hash: null, persist: null, context: null };
  return {
    at,
    natural_key: normalized.statusSnapshot.natural_key,
    canonical_hash: normalized.statusSnapshot.canonical_hash,
    context: null,
    persist: async () => (await deps.repository.persistImportedDeviceStatus({ source: sourceArg, status: normalized.statusSnapshot as never, ingestionOrigin: 'HISTORICAL', correlationId: source.id, causationId: source.id })).source_record_created,
  };
}
