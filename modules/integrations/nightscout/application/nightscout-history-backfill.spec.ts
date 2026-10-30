import { describe, expect, it } from 'vitest';
import type { NightscoutClient, NightscoutDeviceStatusDto, NightscoutEntryDto, NightscoutTreatmentDto } from './nightscout-client';
import {
  HISTORY_PAGE_SIZES,
  HISTORY_STREAM_DONE,
  historyBackfillProgressPercent,
  newHistoryBackfillPlan,
  nightscoutHistoryCoverage,
  readHistoryBackfillPlan,
  runHistoryBackfill,
  withHistoryGap,
  type HistoryBackfillPlan,
} from './nightscout-history-backfill';

const NOW = '2026-10-30T10:00:00.000Z';
const DAY = 86_400_000;
const CONFIG = { historyDays: 30, deviceStatusDays: 7 };

/** A Nightscout with every 5-min CGM entry and device status, and a few treatments a day, over [fromMs, toMs). */
class FakeNightscout implements NightscoutClient {
  readonly entries: NightscoutEntryDto[] = [];
  readonly treatments: NightscoutTreatmentDto[] = [];
  readonly statuses: NightscoutDeviceStatusDto[] = [];
  readonly calls: Array<{ stream: string; cursor: string | null; before: string | null | undefined; limit: number }> = [];

  constructor(fromMs: number, toMs: number) {
    for (let at = fromMs; at < toMs; at += 5 * 60_000) {
      const iso = new Date(at).toISOString();
      this.entries.push({ _id: `sgv-${at}`, type: 'sgv', sgv: 100 + ((at / 300_000) % 40), date: at, dateString: iso });
      this.statuses.push({ _id: `ds-${at}`, created_at: iso, openaps: { iob: { iob: 1.2 }, suggested: { COB: 10 } } });
    }
    for (let at = fromMs + 3_600_000; at < toMs; at += 4 * 3_600_000) {
      const iso = (ms: number) => new Date(ms).toISOString();
      this.treatments.push({ _id: `bolus-${at}`, eventType: 'Bolus', created_at: iso(at), insulin: 1.5 });
      this.treatments.push({ _id: `carbs-${at}`, eventType: 'Carb Correction', created_at: iso(at + 60_000), carbs: 20 });
      this.treatments.push({ _id: `tb-${at}`, eventType: 'Temp Basal', created_at: iso(at + 120_000), rate: 0.2, absolute: 0.2, duration: 30 });
    }
    this.treatments.push({ _id: 'site-1', eventType: 'Site Change', created_at: new Date(fromMs + 2 * DAY).toISOString(), enteredBy: 'Trio' });
    this.treatments.push({ _id: 'note-1', eventType: 'Note', created_at: new Date(fromMs + 3 * DAY).toISOString(), notes: 'Błąd! Bolus nie powiódł się' });
    this.treatments.sort((left, right) => String(left.created_at).localeCompare(String(right.created_at)));
  }

  private page<T>(stream: string, records: T[], timeOf: (record: T) => string, input: { cursor: string | null; before?: string | null; limit: number }): T[] {
    this.calls.push({ stream, cursor: input.cursor, before: input.before, limit: input.limit });
    return records.filter((record) => (!input.cursor || timeOf(record) >= input.cursor) && (!input.before || timeOf(record) < input.before)).slice(0, input.limit);
  }

  async fetchEntries(input: { patient_id: string; cursor: string | null; limit: number; before?: string | null }) {
    return { entries: this.page('entries', this.entries, (entry) => String(entry.dateString), input), next_cursor: input.cursor };
  }

  async fetchTreatments(input: { patient_id: string; cursor: string | null; limit: number; before?: string | null }) {
    return { treatments: this.page('treatments', this.treatments, (treatment) => String(treatment.created_at), input), next_cursor: input.cursor };
  }

  async fetchDeviceStatuses(input: { patient_id: string; cursor: string | null; limit: number; before?: string | null }) {
    return { device_statuses: this.page('devicestatus', this.statuses, (status) => String(status.created_at), input), next_cursor: input.cursor };
  }

  async fetchProfiles() {
    return { profiles: [], next_cursor: null };
  }
}

class MemoryRepository {
  readonly records = new Map<string, { kind: string; origin: string; backfill: boolean; at: string }>();
  readonly jobs: string[] = [];
  readonly currentStates: string[] = [];
  plan: HistoryBackfillPlan | null = null;
  planWrites = 0;
  private events = 0;

  async persistImportedGlucoseReading(args: { reading: { natural_key: string; observed_at: string }; ingestionOrigin: string; historyBackfill?: boolean; jobDedupeKey: string }) {
    const created = !this.records.has(args.reading.natural_key);
    if (created) this.records.set(args.reading.natural_key, { kind: 'CGM', origin: args.ingestionOrigin, backfill: args.historyBackfill === true, at: args.reading.observed_at });
    if (!args.historyBackfill) {
      this.jobs.push(args.jobDedupeKey);
      this.currentStates.push(args.reading.observed_at);
    }
    return { event_id: created ? `evt-${++this.events}` : null, source_record_created: created, event_created: created };
  }

  async persistImportedTreatment(args: { treatment: { natural_key: string; occurred_at: string; event_type: string }; ingestionOrigin: string }) {
    const created = !this.records.has(args.treatment.natural_key);
    if (created) this.records.set(args.treatment.natural_key, { kind: args.treatment.event_type, origin: args.ingestionOrigin, backfill: false, at: args.treatment.occurred_at });
    return { source_record_created: created, event_created: created };
  }

  async persistImportedDeviceStatus(args: { status: { natural_key: string; observed_at: string }; ingestionOrigin: string }) {
    const created = !this.records.has(args.status.natural_key);
    if (created) this.records.set(args.status.natural_key, { kind: 'DEVICE_STATUS', origin: args.ingestionOrigin, backfill: false, at: args.status.observed_at });
    return { source_record_created: created };
  }

  async listImportedNaturalKeys(_sourceId: string, records: Array<{ natural_key: string }>) {
    return new Set(records.map((record) => record.natural_key).filter((key) => this.records.has(key)));
  }

  async writeHistoryBackfillPlan(_sourceId: string, plan: HistoryBackfillPlan, expectedRevision: number | null) {
    if ((this.plan?.revision ?? null) !== expectedRevision) return false;
    this.plan = JSON.parse(JSON.stringify(plan));
    this.planWrites += 1;
    return true;
  }

  count(kind: string) {
    return [...this.records.values()].filter((record) => record.kind === kind).length;
  }
}

const SOURCE = { id: 'source-1', patient_id: 'patient-1' };

function setup(options: { days?: number } = {}) {
  const nowMs = Date.parse(NOW);
  const client = new FakeNightscout(nowMs - (options.days ?? 31) * DAY, nowMs);
  const repository = new MemoryRepository();
  const contextEvents: string[] = [];
  const hypoChecks: string[] = [];
  const plan = newHistoryBackfillPlan({ nowIso: NOW, liveFrom: new Date(nowMs - DAY).toISOString(), config: CONFIG });
  repository.plan = plan;
  let stopAfterPages: number | null = null;
  let pages = 0;
  const deps = () => ({
    client,
    repository: repository as never,
    storeContextEvent: async (treatment: NightscoutTreatmentDto) => {
      if (!['Site Change', 'Note'].includes(String(treatment.eventType))) return false;
      if (!contextEvents.includes(String(treatment._id))) contextEvents.push(String(treatment._id));
      return true;
    },
    detectHistoricalHypo: async (eventId: string) => {
      hypoChecks.push(eventId);
    },
    log: () => undefined,
    pauseMs: 0,
    now: () => NOW,
    shouldStop: () => {
      if (stopAfterPages === null) return false;
      pages += 1;
      return pages > stopAfterPages;
    },
  });
  return {
    client,
    repository,
    contextEvents,
    hypoChecks,
    plan,
    deps,
    stopAfter: (count: number | null) => {
      stopAfterPages = count;
      pages = 0;
    },
  };
}

describe('history import plan (nightscout-history.v1)', () => {
  it('plans 30 days of treatments and CGM and 7 days of device statuses before now', () => {
    const plan = newHistoryBackfillPlan({ nowIso: NOW, liveFrom: '2026-10-29T10:00:00.000Z', config: CONFIG });
    expect(plan).toMatchObject({
      revision: 1,
      from: '2026-09-30T10:00:00.000Z',
      to: NOW,
      devicestatus_from: '2026-10-23T10:00:00.000Z',
      live_from: '2026-10-29T10:00:00.000Z',
      progress: { treatments: '2026-09-30T10:00:00.000Z', entries: '2026-09-30T10:00:00.000Z', devicestatus: '2026-10-23T10:00:00.000Z' },
      completed_at: null,
    });
    expect(readHistoryBackfillPlan({ history_backfill: plan })).toEqual(plan);
    expect(readHistoryBackfillPlan({ history_backfill: { from: 'nonsense' } })).toBeNull();
    expect(readHistoryBackfillPlan({})).toBeNull();
  });

  it('adds a restored backup\'s gap to a finished plan as a new window, cut to the configured days', () => {
    const finished = { ...newHistoryBackfillPlan({ nowIso: '2026-09-01T00:00:00.000Z', liveFrom: '2026-08-31T00:00:00.000Z', config: CONFIG }), completed_at: '2026-09-01T00:10:00.000Z' };
    const gap = withHistoryGap(finished, { gapFrom: '2026-10-20T04:00:00.000Z', nowIso: NOW, liveFrom: '2026-10-29T10:00:00.000Z', config: CONFIG });
    expect(gap).toMatchObject({
      revision: 2,
      from: '2026-10-20T04:00:00.000Z',
      to: NOW,
      devicestatus_from: '2026-10-23T10:00:00.000Z',
      live_from: '2026-10-29T10:00:00.000Z',
      completed_at: null,
      history_from: '2026-08-02T00:00:00.000Z',
    });
    const yearOld = withHistoryGap(finished, { gapFrom: '2025-10-30T10:00:00.000Z', nowIso: NOW, liveFrom: '2026-10-29T10:00:00.000Z', config: CONFIG });
    expect(yearOld.from).toBe('2026-09-30T10:00:00.000Z');
  });

  it('widens an unfinished plan by a gap without losing its earlier start', () => {
    const plan = newHistoryBackfillPlan({ nowIso: '2026-10-28T10:00:00.000Z', liveFrom: '2026-10-27T10:00:00.000Z', config: CONFIG });
    const halfway = { ...plan, progress: { treatments: HISTORY_STREAM_DONE, entries: '2026-10-10T00:00:00.000Z', devicestatus: plan.devicestatus_from } };
    const gap = withHistoryGap(halfway, { gapFrom: '2026-10-27T12:00:00.000Z', nowIso: NOW, liveFrom: '2026-10-29T10:00:00.000Z', config: CONFIG });
    expect(gap.from).toBe(plan.from);
    expect(gap.to).toBe(NOW);
    expect(gap.progress).toEqual({ treatments: '2026-10-27T12:00:00.000Z', entries: '2026-10-10T00:00:00.000Z', devicestatus: plan.devicestatus_from });
  });

  it('reports coverage: LOADING from the live part with a percentage, COMPLETE from the history start', () => {
    const plan = newHistoryBackfillPlan({ nowIso: NOW, liveFrom: '2026-10-29T10:00:00.000Z', config: CONFIG });
    expect(nightscoutHistoryCoverage({ metadata: {}, oldestReadingAt: null, nowIso: NOW })).toEqual({ status: 'LOADING', available_from: '2026-10-29T10:00:00.000Z', progress_percent: 0 });
    const half = { ...plan, progress: { treatments: HISTORY_STREAM_DONE, entries: '2026-10-15T10:00:00.000Z', devicestatus: plan.devicestatus_from } };
    expect(historyBackfillProgressPercent(half)).toBe(67); // (30 + 15) of 67 stream-days
    expect(nightscoutHistoryCoverage({ metadata: { history_backfill: half }, oldestReadingAt: '2026-09-30T10:00:00.000Z', nowIso: NOW })).toEqual({ status: 'LOADING', available_from: '2026-10-29T10:00:00.000Z', progress_percent: 67 });
    const done = { ...plan, completed_at: NOW };
    expect(nightscoutHistoryCoverage({ metadata: { history_backfill: done }, oldestReadingAt: '2026-10-01T08:00:00.000Z', nowIso: NOW })).toEqual({ status: 'COMPLETE', available_from: '2026-09-30T10:00:00.000Z', progress_percent: null });
    // An older install holds readings from before its plan.
    expect(nightscoutHistoryCoverage({ metadata: { history_backfill: done }, oldestReadingAt: '2026-06-01T00:00:00.000Z', nowIso: NOW }).available_from).toBe('2026-06-01T00:00:00.000Z');
  });
});

describe('history import pager (nightscout-history.v1)', () => {
  it('imports 30 days of treatments and CGM and 7 days of device statuses as HISTORICAL, page by page, oldest first', async () => {
    const { client, repository, contextEvents, hypoChecks, deps, plan } = setup();

    const { plan: finished, stats } = await runHistoryBackfill(deps(), SOURCE, plan);

    expect(stats.outcome).toBe('COMPLETED');
    expect(finished.completed_at).toBe(NOW);
    expect(finished.progress).toEqual({ treatments: HISTORY_STREAM_DONE, entries: HISTORY_STREAM_DONE, devicestatus: HISTORY_STREAM_DONE });
    expect(repository.plan?.completed_at).toBe(NOW);
    // 30 days of 5-minute readings, 6 boluses / carbs / temp basals a day, 7 days of statuses.
    expect(repository.count('CGM')).toBe(30 * 288);
    expect(repository.count('BOLUS')).toBe(30 * 6);
    expect(repository.count('CARB_ENTRY')).toBe(30 * 6);
    expect(repository.count('TEMP_BASAL')).toBe(30 * 6);
    expect(repository.count('DEVICE_STATUS')).toBe(7 * 288);
    expect([...repository.records.values()].every((record) => record.origin === 'HISTORICAL')).toBe(true);
    expect([...repository.records.values()].every((record) => record.at >= plan.from && record.at < plan.to)).toBe(true);
    // Context treatments of the window (a site change, a Trio note) are kept for the AI.
    expect(contextEvents).toEqual(['site-1', 'note-1']);
    // No current state and no queued hypo jobs (no alert or push can follow); hypo episodes analytically, in time order.
    expect(repository.jobs).toEqual([]);
    expect(repository.currentStates).toEqual([]);
    expect(hypoChecks).toHaveLength(30 * 288);
    expect(hypoChecks.slice(0, 3)).toEqual(['evt-1', 'evt-2', 'evt-3']);
    // Every request bounded by [cursor, to) and the stream's page size; cursors move forward.
    expect(client.calls.every((call) => call.before === NOW && call.limit === HISTORY_PAGE_SIZES[call.stream as keyof typeof HISTORY_PAGE_SIZES])).toBe(true);
    for (const stream of ['treatments', 'entries', 'devicestatus']) {
      const cursors = client.calls.filter((call) => call.stream === stream).map((call) => String(call.cursor));
      expect([...cursors].sort()).toEqual(cursors);
    }
    // 8640 readings, 499 new per full page (the cursor's own reading comes again and is skipped): 18 requests.
    expect(client.calls.filter((call) => call.stream === 'entries')).toHaveLength(18);
  });

  it('resumes after a stop from the stored progress, importing nothing twice', async () => {
    const { repository, hypoChecks, deps, plan, stopAfter } = setup();
    stopAfter(5);
    const first = await runHistoryBackfill(deps(), SOURCE, plan);
    expect(first.stats.outcome).toBe('STOPPED');
    expect(repository.plan?.completed_at).toBeNull();
    const afterFirst = repository.count('CGM');
    expect(afterFirst).toBeGreaterThan(0);
    expect(afterFirst).toBeLessThan(30 * 288);

    // A restarted worker reads the stored plan back.
    stopAfter(null);
    const stored = readHistoryBackfillPlan({ history_backfill: repository.plan });
    const second = await runHistoryBackfill(deps(), SOURCE, stored!);
    expect(second.stats.outcome).toBe('COMPLETED');
    expect(repository.count('CGM')).toBe(30 * 288);
    expect(new Set(hypoChecks).size).toBe(hypoChecks.length);
    expect(hypoChecks).toHaveLength(30 * 288);
  });

  it('is idempotent: a second run over imported data stores nothing and only reads', async () => {
    const { repository, deps, plan } = setup();
    await runHistoryBackfill(deps(), SOURCE, plan);
    const size = repository.records.size;

    repository.plan = { ...plan, revision: 2 };
    const again = await runHistoryBackfill(deps(), SOURCE, { ...plan, revision: 2 });

    expect(again.stats.outcome).toBe('COMPLETED');
    expect(repository.records.size).toBe(size);
    expect(again.stats.imported).toEqual({ treatments: 0, entries: 0, devicestatus: 0 });
    // Each page boundary's record is read twice.
    expect(again.stats.skipped_already_imported).toBeGreaterThanOrEqual(size);
  });

  it('skips what the live sync already imported (the last day overlaps)', async () => {
    const { repository, deps, plan } = setup();
    const liveKeys = await runHistoryBackfill(deps(), SOURCE, { ...plan, from: '2026-10-29T10:00:00.000Z', progress: { treatments: '2026-10-29T10:00:00.000Z', entries: '2026-10-29T10:00:00.000Z', devicestatus: '2026-10-29T10:00:00.000Z' } });
    expect(liveKeys.stats.imported.entries).toBe(288);
    repository.plan = plan;

    const { stats } = await runHistoryBackfill(deps(), SOURCE, plan);

    expect(stats.imported.entries).toBe(29 * 288);
    expect(repository.count('CGM')).toBe(30 * 288);
  });

  it('stops without overwriting when a gap replaced the plan meanwhile', async () => {
    const { repository, deps, plan } = setup();
    repository.plan = { ...plan, revision: 7 };

    const { stats } = await runHistoryBackfill(deps(), SOURCE, plan);

    expect(stats.outcome).toBe('SUPERSEDED');
    expect(repository.plan?.revision).toBe(7);
    expect(repository.planWrites).toBe(0);
  });
});
