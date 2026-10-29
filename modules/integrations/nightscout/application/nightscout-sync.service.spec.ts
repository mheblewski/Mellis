import { describe, expect, it, vi } from 'vitest';
import { NightscoutClientError } from '../infrastructure/http-nightscout-client';
import { NightscoutSyncService } from './nightscout-sync.service';
import { NightscoutClient, NightscoutEntryDto, NightscoutTreatmentDto } from './nightscout-client';

// Detection clock a few minutes after the fixture readings (2026-09-16T20:00Z), inside the 30-minute freshness window.
const FIXTURE_NOW = '2026-09-16T20:05:00.000Z';

type SourceRow = {
  id: string;
  patient_id: string;
  source_system: string;
  source_key: string;
  sync_cursor: string | null;
  last_successful_observed_at: string | null;
  source_version: string | null;
  metadata: Record<string, unknown>;
};

function entry(overrides: Partial<NightscoutEntryDto> = {}): NightscoutEntryDto {
  return {
    _id: 'entry-1',
    date: 1_767_100_000_000,
    dateString: '2026-09-16T20:00:00.000Z',
    patient: 'patient-1',
    device: 'dexcom',
    type: 'sgv',
    sgv: 68,
    units: 'mg/dL',
    ...overrides,
  };
}

class FakeNightscoutClient implements NightscoutClient {
  public entryCalls: Array<{ patient_id: string; cursor: string | null; limit: number }> = [];
  public treatmentCalls: Array<{ patient_id: string; cursor: string | null; limit: number }> = [];
  public profileCalls: Array<{ patient_id: string; cursor: string | null; limit: number }> = [];
  private readonly entryResponses: Array<NightscoutEntryDto[]> | ((cursor: string | null) => NightscoutEntryDto[] | Promise<NightscoutEntryDto[]>);
  private readonly treatmentResponses: Array<NightscoutTreatmentDto[]> | ((cursor: string | null) => NightscoutTreatmentDto[] | Promise<NightscoutTreatmentDto[]>);
  private readonly profileResponses: Array<Record<string, unknown>[]> | ((cursor: string | null) => Record<string, unknown>[] | Promise<Record<string, unknown>[]>);

  constructor(
    scriptedResponses:
      | Array<NightscoutEntryDto[]>
      | ((cursor: string | null) => NightscoutEntryDto[] | Promise<NightscoutEntryDto[]>)
      | {
        entries: Array<NightscoutEntryDto[]> | ((cursor: string | null) => NightscoutEntryDto[] | Promise<NightscoutEntryDto[]>);
        treatments?: Array<NightscoutTreatmentDto[]> | ((cursor: string | null) => NightscoutTreatmentDto[] | Promise<NightscoutTreatmentDto[]>);
        profiles?: Array<Record<string, unknown>[]> | ((cursor: string | null) => Record<string, unknown>[] | Promise<Record<string, unknown>[]>);
      },
  ) {
    if (Array.isArray(scriptedResponses) || typeof scriptedResponses === 'function') {
      this.entryResponses = scriptedResponses;
      this.treatmentResponses = [];
      this.profileResponses = [];
      return;
    }

    this.entryResponses = scriptedResponses.entries;
    this.treatmentResponses = scriptedResponses.treatments ?? [];
    this.profileResponses = scriptedResponses.profiles ?? [];
  }

  /** Look-back fetches ([cursor, before)) are answered from these, so scripted forward pages stay in order. */
  public lateEntries: NightscoutEntryDto[] = [];
  public lateTreatments: NightscoutTreatmentDto[] = [];
  public lookbackCalls: Array<{ stream: 'entries' | 'treatments'; cursor: string | null; before: string }> = [];

  private lookback<T>(stream: 'entries' | 'treatments', input: { cursor: string | null; before?: string | null }, records: T[], timeOf: (record: T) => string): T[] | null {
    if (!input.before) return null;
    const before = input.before;
    this.lookbackCalls.push({ stream, cursor: input.cursor, before });
    return records.filter((record) => (!input.cursor || timeOf(record) >= input.cursor) && timeOf(record) < before);
  }

  async fetchEntries(input: { patient_id: string; cursor: string | null; limit: number; before?: string | null }) {
    const late = this.lookback('entries', input, this.lateEntries, (entry) => new Date(String(entry.dateString)).toISOString());
    if (late) return { entries: late, next_cursor: input.cursor };
    this.entryCalls.push(input);
    const response = typeof this.entryResponses === 'function'
      ? await this.entryResponses(input.cursor)
      : this.entryResponses.shift() ?? [];

    return {
      entries: response,
      next_cursor: input.cursor,
    };
  }

  async fetchTreatments(input: { patient_id: string; cursor: string | null; limit: number; before?: string | null }) {
    const late = this.lookback('treatments', input, this.lateTreatments, (treatment) => new Date(String(treatment.created_at)).toISOString());
    if (late) return { treatments: late, next_cursor: input.cursor };
    this.treatmentCalls.push(input);
    const response = typeof this.treatmentResponses === 'function'
      ? await this.treatmentResponses(input.cursor)
      : this.treatmentResponses.shift() ?? [];

    return {
      treatments: response,
      next_cursor: input.cursor,
    };
  }

  async fetchProfiles(input: { patient_id: string; cursor: string | null; limit: number }) {
    this.profileCalls.push(input);
    const response = typeof this.profileResponses === 'function'
      ? await this.profileResponses(input.cursor)
      : this.profileResponses.shift() ?? [];

    return {
      profiles: response,
      next_cursor: input.cursor,
    };
  }

  async fetchDeviceStatuses(): Promise<{ device_statuses: never[]; next_cursor: null }> {
    return { device_statuses: [], next_cursor: null };
  }
}

class FakeGlucoMindRepository {
  public jobs: Array<{ job_type: string; dedupe_key: string; payload: Record<string, unknown> }> = [];

  async insertJob(input: { jobType: string; payloadVersion: number; payload: Record<string, unknown>; dedupeKey: string }): Promise<Record<string, unknown> | null> {
    if (this.jobs.some((job) => job.job_type === input.jobType && job.dedupe_key === input.dedupeKey)) {
      return null;
    }

    this.jobs.push({ job_type: input.jobType, dedupe_key: input.dedupeKey, payload: input.payload });
    return { id: `job-${this.jobs.length}` };
  }
}

class FakeNightscoutRepository {
  public sources = new Map<string, SourceRow>();
  public sourceRecords = new Map<string, { id: string; natural_key: string; canonical_hash: string; source_system: string; source_record_id: string | null; raw_payload: Record<string, unknown>; provenance: Record<string, unknown>; patient_id: string; occurred_at: string; recorded_at: string; imported_at: string; normalization_version: string }>();
  public events = new Map<string, { id: string; patient_id: string; source_record_id: string; payload: Record<string, unknown>; occurred_at: string; recorded_at: string; source: Record<string, unknown>; context: Record<string, unknown>; type?: string; event_ingestion_origin?: 'LIVE' | 'HISTORICAL' }>();
  public jobs: Array<{ job_type: string; dedupe_key: string; payload: Record<string, unknown> }> = [];
  public currentStates = new Map<string, Record<string, unknown>>();
  public triggers = new Map<string, { id: string; patient_id: string; source_event_id: string; episode_id: string; rule_version: string; status: string }>();
  public episodes = new Map<string, { id: string; patient_id: string; trigger_id: string; start_event_id: string; state: string; severity: 'L1' | 'L2'; started_at: string; ended_at: string | null; latest_event_id: string; rule_version: string }>();
  public conversations = new Map<string, { id: string; patient_id: string; episode_id: string; thread_state_version: string; awaiting_user_answer: boolean }>();
  public contextQuestions = new Map<string, { id: string; conversation_id: string; patient_id: string; question_id: string; status: string }>();
  public syncUpdates: Array<{ source_id: string; cursor: string }> = [];
  private recordSequence = 0;
  private eventSequence = 0;
  private triggerSequence = 0;
  private episodeSequence = 0;
  private conversationSequence = 0;
  private questionSequence = 0;

  async ensureNightscoutSource(args: { patientId: string; sourceKey: string; sourceVersion: string; metadata: Record<string, unknown> }): Promise<SourceRow> {
    const key = `${args.patientId}:NIGHTSCOUT:${args.sourceKey}`;
    const source = this.sources.get(key) ?? {
      id: `source-${this.sources.size + 1}`,
      patient_id: args.patientId,
      source_system: 'NIGHTSCOUT',
      source_key: args.sourceKey,
      sync_cursor: null,
      last_successful_observed_at: null,
      source_version: args.sourceVersion,
      metadata: args.metadata,
    };

    this.sources.set(key, source);
    return source;
  }

  async listNightscoutSources(): Promise<SourceRow[]> {
    return [...this.sources.values()];
  }

  async getNightscoutSourceById(sourceId: string): Promise<SourceRow | null> {
    return [...this.sources.values()].find((source) => source.id === sourceId) ?? null;
  }

  async listImportedNaturalKeys(_sourceId: string, records: Array<{ natural_key: string; canonical_hash: string }>): Promise<Set<string>> {
    const imported = [...this.sourceRecords.values()];
    return new Set(records
      .filter((record) => imported.some((row) => row.natural_key === record.natural_key || row.canonical_hash === record.canonical_hash))
      .map((record) => record.natural_key));
  }

  async persistImportedGlucoseReading(args: {
    source: SourceRow;
    reading: {
      source_system: 'NIGHTSCOUT';
      source_record_id: string | null;
      natural_key: string;
      record_type: 'CGM_ENTRY';
      patient_id: string;
      observed_at: string;
      recorded_at: string;
      imported_at: string;
      glucose_value: number;
      glucose_unit: 'mg/dL';
      source_unit: 'mg/dL' | 'mmol/L' | 'UNKNOWN';
      normalization_version: string;
      canonical_hash: string;
      provenance: Record<string, unknown>;
      raw_payload: Record<string, unknown>;
    };
    jobDedupeKey: string;
    correlationId: string;
    causationId: string;
    jobPayload: Record<string, unknown>;
  }): Promise<{ source_record_id: string; event_id: string; source_record_created: boolean; event_created: boolean; job_created: boolean; current_state_created: boolean }> {
    const existingRecord = [...this.sourceRecords.values()].find((record) => record.natural_key === args.reading.natural_key || (record.source_system === args.reading.source_system && record.canonical_hash === args.reading.canonical_hash));
    const sourceRecordCreated = !existingRecord;
    const sourceRecord = existingRecord ?? {
      id: `src-${++this.recordSequence}`,
      natural_key: args.reading.natural_key,
      canonical_hash: args.reading.canonical_hash,
      source_system: args.reading.source_system,
      source_record_id: args.reading.source_record_id,
      raw_payload: args.reading.raw_payload,
      provenance: args.reading.provenance,
      patient_id: args.reading.patient_id,
      occurred_at: args.reading.observed_at,
      recorded_at: args.reading.recorded_at,
      imported_at: args.reading.imported_at,
      normalization_version: args.reading.normalization_version,
    };
    this.sourceRecords.set(sourceRecord.id, sourceRecord);

    const existingEvent = [...this.events.values()].find((event) => event.patient_id === args.reading.patient_id && event.source_record_id === sourceRecord.id);
    const eventCreated = !existingEvent;
    const event = existingEvent ?? {
      id: `evt-${++this.eventSequence}`,
      patient_id: args.reading.patient_id,
      source_record_id: sourceRecord.id,
      payload: {
        glucose_value: args.reading.glucose_value,
        glucose_unit: args.reading.glucose_unit,
        source_unit: args.reading.source_unit,
      },
      occurred_at: args.reading.observed_at,
      recorded_at: args.reading.recorded_at,
      source: {},
      context: {},
    };
    this.events.set(event.id, event);

    const currentStateKey = `${args.reading.patient_id}:${event.id}`;
    const currentStateCreated = !this.currentStates.has(currentStateKey);
    this.currentStates.set(currentStateKey, {
      patient_id: args.reading.patient_id,
      state_version: `nightscout:${event.id}`,
      as_of: args.reading.observed_at,
      glucose: {
        value: args.reading.glucose_value,
        unit: 'mg/dL',
        trend: 'UNKNOWN',
        rate_of_change: 'UNKNOWN',
      },
    });

    const jobCreated = !this.jobs.some((job) => job.job_type === 'triggering.hypo_detection' && job.dedupe_key === args.jobDedupeKey);
    if (jobCreated) {
      this.jobs.push({ job_type: 'triggering.hypo_detection', dedupe_key: args.jobDedupeKey, payload: args.jobPayload });
    }

    const sourceKey = `${args.source.id}:sync_cursor`;
    this.sources.set(`${args.source.patient_id}:NIGHTSCOUT:${args.source.source_key}`, {
      ...args.source,
      sync_cursor: args.reading.observed_at,
      last_successful_observed_at: args.reading.observed_at,
    });
    this.syncUpdates.push({ source_id: args.source.id, cursor: args.reading.observed_at });

    return {
      source_record_id: sourceRecord.id,
      event_id: event.id,
      source_record_created: sourceRecordCreated,
      event_created: eventCreated,
      job_created: jobCreated,
      current_state_created: currentStateCreated,
    };
  }

  public therapySnapshots: Array<{ patient_id: string; therapy_version: string; active_profile_id: string; observed_at: string; valid_from: string | null; valid_to: string | null; snapshot: Record<string, unknown> }> = [];

  async persistImportedTherapyProfile(args: {
    source: SourceRow;
    profile: {
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
    };
  }): Promise<{ created: boolean; therapy_id: string | null; patient_id: string; therapy_version: string; active_profile_id: string; observed_at: string; valid_from: string | null; valid_to: string | null }> {
    const existing = this.therapySnapshots.find((row) => row.patient_id === args.source.patient_id && row.therapy_version === args.profile.therapy_version);
    const created = !existing;
    const row = {
      patient_id: args.source.patient_id,
      therapy_version: args.profile.therapy_version,
      active_profile_id: args.profile.active_profile_id,
      observed_at: args.profile.observed_at,
      valid_from: args.profile.valid_from,
      valid_to: args.profile.valid_to,
      snapshot: args.profile.snapshot,
    };
    if (created) {
      this.therapySnapshots.push(row);
    } else {
      Object.assign(existing, row);
    }
    return { created, therapy_id: created ? `therapy-${this.therapySnapshots.length}` : `therapy-${this.therapySnapshots.indexOf(existing ?? row) + 1}`, patient_id: args.source.patient_id, therapy_version: args.profile.therapy_version, active_profile_id: args.profile.active_profile_id, observed_at: args.profile.observed_at, valid_from: args.profile.valid_from, valid_to: args.profile.valid_to };
  }

  async persistImportedTreatment(args: {
    source: SourceRow;
    treatment: {
      source_system: 'NIGHTSCOUT';
      source_record_id: string;
      natural_key: string;
      record_type: 'TREATMENT';
      patient_id: string;
      occurred_at: string;
      recorded_at: string;
      imported_at: string;
      event_type: string;
      normalization_version: string;
      canonical_hash: string;
      payload: Record<string, unknown>;
      provenance: Record<string, unknown>;
      raw_payload: Record<string, unknown>;
    };
  }): Promise<{ source_record_id: string; event_id: string; source_record_created: boolean; event_created: boolean }> {
    const existingRecord = [...this.sourceRecords.values()].find((record) => record.natural_key === args.treatment.natural_key || (record.source_system === args.treatment.source_system && record.canonical_hash === args.treatment.canonical_hash));
    const sourceRecordCreated = !existingRecord;
    const sourceRecord = existingRecord ?? {
      id: `src-${++this.recordSequence}`,
      natural_key: args.treatment.natural_key,
      canonical_hash: args.treatment.canonical_hash,
      source_system: args.treatment.source_system,
      source_record_id: args.treatment.source_record_id,
      raw_payload: args.treatment.raw_payload,
      provenance: args.treatment.provenance,
      patient_id: args.treatment.patient_id,
      occurred_at: args.treatment.occurred_at,
      recorded_at: args.treatment.recorded_at,
      imported_at: args.treatment.imported_at,
      normalization_version: args.treatment.normalization_version,
    };
    this.sourceRecords.set(sourceRecord.id, sourceRecord);

    const existingEvent = [...this.events.values()].find((event) => event.patient_id === args.treatment.patient_id && event.source_record_id === sourceRecord.id && String(event.type ?? '') === args.treatment.event_type);
    const eventCreated = !existingEvent;
    const event = existingEvent ?? {
      id: `evt-${++this.eventSequence}`,
      patient_id: args.treatment.patient_id,
      source_record_id: sourceRecord.id,
      payload: args.treatment.payload,
      occurred_at: args.treatment.occurred_at,
      recorded_at: args.treatment.recorded_at,
      source: {},
      context: {},
      type: args.treatment.event_type,
    };
    this.events.set(event.id, event);

    return {
      source_record_id: sourceRecord.id,
      event_id: event.id,
      source_record_created: sourceRecordCreated,
      event_created: eventCreated,
    };
  }

  async getImportedReadingForEvent(eventId: string): Promise<Record<string, unknown> | null> {
    const event = this.events.get(eventId);
    if (!event) {
      return null;
    }

    const sourceRecord = this.sourceRecords.get(event.source_record_id);
    if (!sourceRecord) {
      return null;
    }

    return {
      event_id: event.id,
      patient_id: event.patient_id,
      occurred_at: event.occurred_at,
      recorded_at: event.recorded_at,
      payload: event.payload,
      context: event.context,
      source: event.source,
      event_ingestion_origin: event.event_ingestion_origin ?? 'LIVE',
      source_record_id: sourceRecord.id,
      source_identity: sourceRecord.source_record_id,
      raw_payload: sourceRecord.raw_payload,
      provenance: sourceRecord.provenance,
      source_system: sourceRecord.source_system,
      normalization_version: sourceRecord.normalization_version,
      canonical_hash: sourceRecord.canonical_hash,
    };
  }

  async getHypoRecoveryStart(patientId: string, origin: 'LIVE' | 'HISTORICAL', fromIso: string, untilIso: string): Promise<{ since: string | null; last_low_at: string | null }> {
    // Mirrors the SQL: the first reading >= 70 after the last one below 70 in the episode.
    const readings = [...this.events.values()]
      .filter((event) => event.patient_id === patientId && (event.type ?? 'GLUCOSE_READING_AVAILABLE') === 'GLUCOSE_READING_AVAILABLE' && typeof event.payload.glucose_value !== 'undefined' && (event.event_ingestion_origin ?? 'LIVE') === origin)
      .filter((event) => event.occurred_at >= fromIso && event.occurred_at <= untilIso)
      .map((event) => ({ at: event.occurred_at, value: Number((event.payload as Record<string, unknown>).glucose_value) }))
      .sort((a, b) => a.at.localeCompare(b.at));
    const lastLow = readings.filter((reading) => reading.value < 70).at(-1)?.at ?? null;
    return { since: readings.find((reading) => reading.value >= 70 && (lastLow === null || reading.at > lastLow))?.at ?? null, last_low_at: lastLow };
  }

  async getLatestOpenHypoEpisode(patientId: string, origin: 'LIVE' | 'HISTORICAL'): Promise<Record<string, unknown> | null> {
    // Mirrors the SQL: an episode's origin is the origin of its trigger's source event.
    const episode = [...this.episodes.values()].reverse().find((candidate) => candidate.patient_id === patientId
      && candidate.state === 'OPEN'
      && (this.events.get(candidate.start_event_id)?.event_ingestion_origin ?? 'LIVE') === origin);
    if (!episode) {
      return null;
    }

    return {
      episode_id: episode.id,
      state: episode.state,
      severity: episode.severity,
      started_at: episode.started_at,
      ended_at: episode.ended_at,
      latest_reading_id: episode.latest_event_id,
      trigger_id: episode.trigger_id,
      trigger_rule_version: episode.rule_version,
      source_event_id: episode.start_event_id,
    };
  }

  async persistHypoDetection(args: {
    patientId: string;
    reading: {
      reading_id: string;
      source_record_id: string;
      observed_at: string;
      recorded_at: string;
      glucose_value: number;
      glucose_unit: 'mg/dL';
      classification: 'UNKNOWN';
      relation_to_episode: 'LATEST';
      validity: 'VALID';
      provenance_ref: string;
    };
    detection: { status: string; severity: 'L1' | 'L2' | null };
    existingEpisode: Record<string, unknown> | null;
    origin: 'LIVE' | 'HISTORICAL';
  }): Promise<{ trigger_created: boolean; episode_created: boolean }> {
    // Mirrors PostgresNightscoutRepository.persistHypoDetection: origin is required and never defaulted.
    if (args.origin !== 'LIVE' && args.origin !== 'HISTORICAL') {
      throw new Error('UNKNOWN_EVENT_INGESTION_ORIGIN');
    }
    if (args.detection.status === 'NO_HYPO') {
      if (args.existingEpisode) {
        const episode = this.episodes.get(String(args.existingEpisode.episode_id));
        if (episode) {
          episode.state = 'CLOSED';
          episode.ended_at = args.endedAt ?? args.reading.observed_at;
          episode.latest_event_id = args.reading.reading_id;
        }
      }

      return { trigger_created: false, episode_created: false };
    }

    if (args.detection.status === 'HYPO_ONGOING' && args.existingEpisode) {
      const episode = this.episodes.get(String(args.existingEpisode.episode_id));
      if (episode) {
        episode.severity = args.detection.severity ?? episode.severity;
        episode.latest_event_id = args.reading.reading_id;
      }

      return { trigger_created: false, episode_created: false };
    }

    const existingTrigger = [...this.triggers.values()].find((trigger) => trigger.patient_id === args.patientId && trigger.source_event_id === args.reading.reading_id);
    const triggerId = existingTrigger?.id ?? `trg-${++this.triggerSequence}`;
    const episodeId = [...this.episodes.values()].find((episode) => episode.start_event_id === args.reading.reading_id)?.id ?? `ep-${++this.episodeSequence}`;

    if (!existingTrigger) {
      this.triggers.set(triggerId, {
        id: triggerId,
        patient_id: args.patientId,
        source_event_id: args.reading.reading_id,
        episode_id: episodeId,
        rule_version: 'hypo.cgm.ada2026.v1',
        status: 'OPEN',
      });
    }

    const existingEpisode = this.episodes.get(episodeId);
    if (!existingEpisode) {
      this.episodes.set(episodeId, {
        id: episodeId,
        patient_id: args.patientId,
        trigger_id: triggerId,
        start_event_id: args.reading.reading_id,
        state: 'OPEN',
        severity: args.detection.severity ?? 'L1',
        started_at: args.reading.observed_at,
        ended_at: null,
        latest_event_id: args.reading.reading_id,
        rule_version: 'hypo.cgm.ada2026.v1',
      });
    }

    // Nobody is asked about a hypo: no conversation, no question, no analysis, no push.
    return { trigger_created: !existingTrigger, episode_created: !existingEpisode };
  }
}

describe('Nightscout sync service', () => {
  it('imports a hypo reading into the full downstream flow', async () => {
    const nightscoutRepository = new FakeNightscoutRepository();
    const repository = new FakeGlucoMindRepository();
    const client = new FakeNightscoutClient([[
      entry({ _id: 'entry-68', sgv: 68 }),
    ]]);
    const service = new NightscoutSyncService(nightscoutRepository as never, repository as never, client as never);

    await service.ensureNightscoutSource('patient-1', 'https://nightscout.example.com');
    const syncResult = await service.runNightscoutSyncJob('source-1', '2026-09-16T20:00:00.000Z');

    expect(syncResult.entries.imported).toBe(1);
    expect(syncResult.entries.events_created).toBe(1);
    expect(syncResult.entries.jobs_enqueued).toBe(1);

    const hypoJob = nightscoutRepository.jobs.find((job) => job.job_type === 'triggering.hypo_detection');
    expect(hypoJob).toBeDefined();

    const createdEvent = [...nightscoutRepository.events.values()][0];
    const hypoResult = await service.runHypoDetectionJob(createdEvent.id, 'patient-1', FIXTURE_NOW);

    expect(hypoResult.trigger_created).toBe(true);
    expect(nightscoutRepository.triggers.size).toBe(1);
    expect(nightscoutRepository.episodes.size).toBe(1);
    expect(nightscoutRepository.conversations.size).toBe(0);
    expect(nightscoutRepository.jobs.some((job) => job.job_type === 'analysis.follow_up')).toBe(false);
  });

  it('processes HISTORICAL readings analytically, without the LIVE freshness guard', async () => {
    async function detectBackfilled(origin: 'LIVE' | 'HISTORICAL') {
      const nightscoutRepository = new FakeNightscoutRepository();
      const service = new NightscoutSyncService(nightscoutRepository as never, new FakeGlucoMindRepository() as never, new FakeNightscoutClient([[
        entry({ _id: 'entry-backfilled-50', sgv: 50, date: Date.parse('2026-09-16T19:30:00.000Z'), dateString: '2026-09-16T19:30:00.000Z' }),
      ]]) as never);
      await service.ensureNightscoutSource('patient-1', 'https://nightscout.example.com');
      await service.runNightscoutSyncJob('source-1', '2026-09-16T20:00:00.000Z');
      const event = [...nightscoutRepository.events.values()][0];
      event.event_ingestion_origin = origin;
      // Hours after the reading: far beyond the 30-minute guard for starting a new LIVE flow.
      const result = await service.runHypoDetectionJob(event.id, 'patient-1', '2026-09-17T08:00:00.000Z');
      return { nightscoutRepository, result };
    }

    const historical = await detectBackfilled('HISTORICAL');
    expect(historical.result.skipped_reason).toBeUndefined();
    expect(historical.result.trigger_created).toBe(true);
    expect(historical.nightscoutRepository.triggers.size).toBe(1);
    expect(historical.nightscoutRepository.episodes.size).toBe(1);
    // Analytical only: no conversation and no analysis.follow_up for a backfilled episode.
        expect(historical.nightscoutRepository.conversations.size).toBe(0);
    expect(historical.nightscoutRepository.jobs.some((job) => job.job_type === 'analysis.follow_up')).toBe(false);

    // The same reading arriving LIVE that late is still stopped by the freshness guard.
    const live = await detectBackfilled('LIVE');
    expect(live.result.skipped_reason).toBe('STALE_READING_FOR_NEW_HYPO');
    expect(live.nightscoutRepository.triggers.size).toBe(0);
    expect(live.nightscoutRepository.episodes.size).toBe(0);
  });

  describe('LIVE and HISTORICAL episode isolation', () => {
    const at = (time: string) => ({ date: Date.parse(`2026-09-16T${time}:00.000Z`), dateString: `2026-09-16T${time}:00.000Z` });

    async function importWithOrigins(readings: Array<{ id: string; sgv: number; time: string; origin: 'LIVE' | 'HISTORICAL' }>) {
      const nightscoutRepository = new FakeNightscoutRepository();
      const service = new NightscoutSyncService(nightscoutRepository as never, new FakeGlucoMindRepository() as never, new FakeNightscoutClient([
        readings.map((reading) => entry({ _id: reading.id, sgv: reading.sgv, ...at(reading.time) })),
      ]) as never);
      await service.ensureNightscoutSource('patient-1', 'https://nightscout.example.com');
      await service.runNightscoutSyncJob('source-1', '2026-09-16T21:00:00.000Z');
      const events = [...nightscoutRepository.events.values()];
      const byValue = (sgv: number) => {
        const event = events.find((candidate) => candidate.payload.glucose_value === sgv)!;
        event.event_ingestion_origin = readings.find((reading) => reading.sgv === sgv)!.origin;
        return event.id;
      };
      const episodeOf = (eventId: string) => [...nightscoutRepository.episodes.values()].find((episode) => episode.start_event_id === eventId);
      return { nightscoutRepository, service, byValue, episodeOf };
    }

    it('never closes or modifies a LIVE episode from HISTORICAL readings', async () => {
      const { nightscoutRepository, service, byValue, episodeOf } = await importWithOrigins([
        { id: 'live-60', sgv: 60, time: '20:00', origin: 'LIVE' },
        { id: 'hist-95', sgv: 95, time: '19:00', origin: 'HISTORICAL' },
        { id: 'hist-45', sgv: 45, time: '20:02', origin: 'HISTORICAL' },
      ]);
      const liveId = byValue(60);
      await service.runHypoDetectionJob(liveId, 'patient-1', '2026-09-16T20:05:00.000Z');
      const liveBefore = JSON.stringify(episodeOf(liveId));

      await service.runHypoDetectionJob(byValue(95), 'patient-1', '2026-09-16T20:06:00.000Z');
      await service.runHypoDetectionJob(byValue(45), 'patient-1', '2026-09-16T20:07:00.000Z');

      // Neither the normal reading (would close) nor the lower one (would raise severity) touched the LIVE episode.
      expect(JSON.stringify(episodeOf(liveId))).toBe(liveBefore);
      expect(episodeOf(liveId)).toMatchObject({ state: 'OPEN', severity: 'L1', ended_at: null, latest_event_id: liveId });
      // The HISTORICAL hypo is its own episode, analytical only: only the LIVE episode has a conversation.
      expect(episodeOf(byValue(45))).toMatchObject({ state: 'OPEN', severity: 'L2' });
      expect(nightscoutRepository.conversations.size).toBe(0);
    });

    it('does not let an open HISTORICAL episode absorb a new LIVE hypo', async () => {
      const { nightscoutRepository, service, byValue, episodeOf } = await importWithOrigins([
        { id: 'hist-50', sgv: 50, time: '19:00', origin: 'HISTORICAL' },
        { id: 'live-62', sgv: 62, time: '20:00', origin: 'LIVE' },
      ]);
      const historicalId = byValue(50);
      await service.runHypoDetectionJob(historicalId, 'patient-1', '2026-09-16T20:05:00.000Z');
      const historicalBefore = JSON.stringify(episodeOf(historicalId));

      const live = await service.runHypoDetectionJob(byValue(62), 'patient-1', '2026-09-16T20:05:00.000Z');

      expect(live).toMatchObject({ trigger_created: true, episode_created: true });
      expect(live.skipped_reason).toBeUndefined();
      expect(episodeOf(byValue(62))).toMatchObject({ state: 'OPEN', started_at: '2026-09-16T20:00:00.000Z' });
      expect(JSON.stringify(episodeOf(historicalId))).toBe(historicalBefore);
      // Neither episode gets an analysis.follow_up job: nobody is asked about a hypo.
      expect(nightscoutRepository.jobs.filter((job) => job.job_type === 'analysis.follow_up')).toHaveLength(0);
    });

    it('still continues and closes a LIVE episode from LIVE readings', async () => {
      const { service, byValue, episodeOf } = await importWithOrigins([
        { id: 'live-60', sgv: 60, time: '20:00', origin: 'LIVE' },
        { id: 'live-50', sgv: 50, time: '20:05', origin: 'LIVE' },
        { id: 'live-95', sgv: 95, time: '20:10', origin: 'LIVE' },
        { id: 'live-98', sgv: 98, time: '20:25', origin: 'LIVE' },
      ]);
      const startId = byValue(60);
      await service.runHypoDetectionJob(startId, 'patient-1', '2026-09-16T20:01:00.000Z');
      await service.runHypoDetectionJob(byValue(50), 'patient-1', '2026-09-16T20:06:00.000Z');
      expect(episodeOf(startId)).toMatchObject({ state: 'OPEN', severity: 'L2', latest_event_id: byValue(50) });

      // One reading back at >= 70 is not the end yet; 15 min later it is, and it ended at the first one.
      const early = await service.runHypoDetectionJob(byValue(95), 'patient-1', '2026-09-16T20:11:00.000Z');
      expect(early.skipped_reason).toBe('RECOVERY_NOT_CONFIRMED');
      expect(episodeOf(startId)).toMatchObject({ state: 'OPEN' });
      await service.runHypoDetectionJob(byValue(98), 'patient-1', '2026-09-16T20:26:00.000Z');
      expect(episodeOf(startId)).toMatchObject({ state: 'CLOSED', ended_at: '2026-09-16T20:10:00.000Z', latest_event_id: byValue(98) });
    });

    it('ignores a HISTORICAL reading older than the open HISTORICAL episode start', async () => {
      const { nightscoutRepository, service, byValue, episodeOf } = await importWithOrigins([
        { id: 'hist-60', sgv: 60, time: '19:00', origin: 'HISTORICAL' },
        { id: 'hist-95', sgv: 95, time: '18:30', origin: 'HISTORICAL' },
        { id: 'hist-45', sgv: 45, time: '18:40', origin: 'HISTORICAL' },
      ]);
      const startId = byValue(60);
      await service.runHypoDetectionJob(startId, 'patient-1', '2026-09-17T08:00:00.000Z');
      const before = JSON.stringify(episodeOf(startId));

      const normal = await service.runHypoDetectionJob(byValue(95), 'patient-1', '2026-09-17T08:00:00.000Z');
      const lower = await service.runHypoDetectionJob(byValue(45), 'patient-1', '2026-09-17T08:00:00.000Z');

      expect(normal.skipped_reason).toBe('HISTORICAL_READING_BEFORE_EPISODE_START');
      expect(lower.skipped_reason).toBe('HISTORICAL_READING_BEFORE_EPISODE_START');
      expect(JSON.stringify(episodeOf(startId))).toBe(before);
      expect(episodeOf(startId)).toMatchObject({ state: 'OPEN', severity: 'L1', ended_at: null, latest_event_id: startId });
      expect(nightscoutRepository.episodes.size).toBe(1);
    });
  });

  describe('freshness guard for starting a new hypo flow', () => {
    async function importReadings(entries: NightscoutEntryDto[]) {
      const nightscoutRepository = new FakeNightscoutRepository();
      const repository = new FakeGlucoMindRepository();
      const service = new NightscoutSyncService(nightscoutRepository as never, repository as never, new FakeNightscoutClient([entries]) as never);
      await service.ensureNightscoutSource('patient-1', 'https://nightscout.example.com');
      await service.runNightscoutSyncJob('source-1', '2026-09-16T21:00:00.000Z');
      const events = [...nightscoutRepository.events.values()] as Array<{ id: string; payload: Record<string, unknown> }>;
      const byValue = (value: number) => events.find((event) => event.payload.glucose_value === value)!.id;
      return { nightscoutRepository, service, byValue };
    }

    it('does not open an episode, conversation, analysis or push from a LIVE reading older than 30 minutes', async () => {
      const { nightscoutRepository, service, byValue } = await importReadings([entry({ _id: 'old-55', sgv: 55 })]);

      const result = await service.runHypoDetectionJob(byValue(55), 'patient-1', '2026-09-16T20:31:00.000Z');

      expect(result).toEqual({ trigger_created: false, episode_created: false, skipped_reason: 'STALE_READING_FOR_NEW_HYPO' });
      expect(nightscoutRepository.triggers.size).toBe(0);
      expect(nightscoutRepository.episodes.size).toBe(0);
      expect(nightscoutRepository.conversations.size).toBe(0);
      expect(nightscoutRepository.jobs.filter((job) => job.job_type !== 'triggering.hypo_detection')).toHaveLength(0);
    });

    it('still starts the flow from a fresh reading that arrives in the same backlog after a skipped stale one', async () => {
      const { nightscoutRepository, service, byValue } = await importReadings([
        entry({ _id: 'old-55', sgv: 55, date: Date.parse('2026-09-16T19:00:00.000Z'), dateString: '2026-09-16T19:00:00.000Z' }),
        entry({ _id: 'fresh-62', sgv: 62, date: Date.parse('2026-09-16T20:00:00.000Z'), dateString: '2026-09-16T20:00:00.000Z' }),
      ]);

      expect((await service.runHypoDetectionJob(byValue(55), 'patient-1', FIXTURE_NOW)).skipped_reason).toBe('STALE_READING_FOR_NEW_HYPO');
      const fresh = await service.runHypoDetectionJob(byValue(62), 'patient-1', FIXTURE_NOW);

      expect(fresh.trigger_created).toBe(true);
      expect(nightscoutRepository.episodes.size).toBe(1);
      expect([...nightscoutRepository.episodes.values()][0].started_at).toBe('2026-09-16T20:00:00.000Z');
      expect(nightscoutRepository.conversations.size).toBe(0);
    });

    it('lets stale readings continue and close an already open episode, so none is left open', async () => {
      const { nightscoutRepository, service, byValue } = await importReadings([
        entry({ _id: 'start-60', sgv: 60, date: Date.parse('2026-09-16T20:00:00.000Z'), dateString: '2026-09-16T20:00:00.000Z' }),
        entry({ _id: 'later-50', sgv: 50, date: Date.parse('2026-09-16T20:05:00.000Z'), dateString: '2026-09-16T20:05:00.000Z' }),
        entry({ _id: 'later-95', sgv: 95, date: Date.parse('2026-09-16T20:10:00.000Z'), dateString: '2026-09-16T20:10:00.000Z' }),
        entry({ _id: 'later-99', sgv: 99, date: Date.parse('2026-09-16T20:25:00.000Z'), dateString: '2026-09-16T20:25:00.000Z' }),
      ]);
      await service.runHypoDetectionJob(byValue(60), 'patient-1', FIXTURE_NOW);
      const muchLater = '2026-09-16T22:00:00.000Z';

      const ongoing = await service.runHypoDetectionJob(byValue(50), 'patient-1', muchLater);
      expect(ongoing.skipped_reason).toBeUndefined();
      expect([...nightscoutRepository.episodes.values()][0]).toMatchObject({ state: 'OPEN', severity: 'L2' });

      await service.runHypoDetectionJob(byValue(95), 'patient-1', muchLater);
      const closing = await service.runHypoDetectionJob(byValue(99), 'patient-1', muchLater);
      expect(closing.skipped_reason).toBeUndefined();
      expect(nightscoutRepository.episodes.size).toBe(1);
      expect([...nightscoutRepository.episodes.values()][0]).toMatchObject({ state: 'CLOSED', ended_at: '2026-09-16T20:10:00.000Z' });
      expect(nightscoutRepository.triggers.size).toBe(1);
      expect(nightscoutRepository.conversations.size).toBe(0);
    });
  });

  it('imports normal glucose without creating a hypo trigger', async () => {
    const nightscoutRepository = new FakeNightscoutRepository();
    const repository = new FakeGlucoMindRepository();
    const client = new FakeNightscoutClient([[
      entry({ _id: 'entry-110', sgv: 110 }),
    ]]);
    const service = new NightscoutSyncService(nightscoutRepository as never, repository as never, client as never);

    await service.ensureNightscoutSource('patient-1', 'https://nightscout.example.com');
    await service.runNightscoutSyncJob('source-1', '2026-09-16T20:00:00.000Z');
    const createdEvent = [...nightscoutRepository.events.values()][0];

    const hypoResult = await service.runHypoDetectionJob(createdEvent.id, 'patient-1', FIXTURE_NOW);

    expect(hypoResult.trigger_created).toBe(false);
    expect(nightscoutRepository.triggers.size).toBe(0);
    expect(nightscoutRepository.episodes.size).toBe(0);
  });

  it('stores a fetched Nightscout profile as an observed therapy snapshot without inventing valid_from', async () => {
    const nightscoutRepository = new FakeNightscoutRepository();
    const repository = new FakeGlucoMindRepository();
    const client = new FakeNightscoutClient({
      entries: [[entry({ _id: 'entry-68', sgv: 68 })]],
      treatments: [[{ _id: 'tx-1', eventType: 'Bolus', created_at: '2026-09-16T20:00:00.000Z', insulin: 0.5 }]],
    });
    const service = new NightscoutSyncService(nightscoutRepository as never, repository as never, client as never);

    await service.ensureNightscoutSource('patient-1', 'https://nightscout.example.com');

    const profile = {
      _id: 'profile-1',
      defaultProfile: 'Default',
      store: { Default: { dia: 6, carbratio: [{ time: '00:00', value: 10 }] } },
      timezone: 'Europe/Warsaw',
    };

    // @ts-expect-error runtime test hook for profile sync contract
    client.fetchProfiles = async () => ({ profiles: [profile], next_cursor: null });

    await service.runNightscoutSyncJob('source-1', '2026-09-16T20:00:00.000Z');

    expect(nightscoutRepository.therapySnapshots).toHaveLength(1);
    expect(nightscoutRepository.therapySnapshots[0].active_profile_id).toBe('Default');
    expect(nightscoutRepository.therapySnapshots[0].valid_from).toBeNull();
    expect(nightscoutRepository.therapySnapshots[0].observed_at).toBe('2026-09-16T20:00:00.000Z');
  });

  it('rejects empty or incomplete Nightscout profile payloads without creating a therapy snapshot', async () => {
    const nightscoutRepository = new FakeNightscoutRepository();
    const repository = new FakeGlucoMindRepository();
    const client = new FakeNightscoutClient({
      entries: [[entry({ _id: 'entry-68', sgv: 68 })]],
      treatments: [],
      profiles: [[{}]],
    });
    const service = new NightscoutSyncService(nightscoutRepository as never, repository as never, client as never);

    await service.ensureNightscoutSource('patient-1', 'https://nightscout.example.com');
    await service.runNightscoutSyncJob('source-1', '2026-09-16T20:00:00.000Z');

    expect(nightscoutRepository.therapySnapshots).toHaveLength(0);
  });

  it('keeps a single therapy snapshot for repeated syncs of the same profile version', async () => {
    const nightscoutRepository = new FakeNightscoutRepository();
    const repository = new FakeGlucoMindRepository();
    const client = new FakeNightscoutClient({
      entries: [[entry({ _id: 'entry-68', sgv: 68 })]],
      treatments: [],
      profiles: [[{
        _id: 'profile-1',
        defaultProfile: 'Default',
        store: {
          Default: { dia: 6, carbratio: [{ time: '00:00', value: 10 }] },
        },
      }]],
    });
    const service = new NightscoutSyncService(nightscoutRepository as never, repository as never, client as never);

    await service.ensureNightscoutSource('patient-1', 'https://nightscout.example.com');
    await service.runNightscoutSyncJob('source-1', '2026-09-16T20:00:00.000Z');
    await service.runNightscoutSyncJob('source-1', '2026-09-16T20:10:00.000Z');

    expect(nightscoutRepository.therapySnapshots).toHaveLength(1);
    expect(nightscoutRepository.therapySnapshots[0].therapy_version).toMatch(/^profile-1(?:[:]|$)/);
  });

  it('creates a new therapy snapshot when the same Nightscout profile id changes configuration', async () => {
    const nightscoutRepository = new FakeNightscoutRepository();
    const repository = new FakeGlucoMindRepository();
    const client = new FakeNightscoutClient({
      entries: [[entry({ _id: 'entry-68', sgv: 68 })]],
      treatments: [],
      profiles: [[{
        _id: 'profile-1',
        defaultProfile: 'Default',
        store: {
          Default: { dia: 6, carbratio: [{ time: '00:00', value: 10 }] },
        },
      }], [{
        _id: 'profile-1',
        defaultProfile: 'Default',
        store: {
          Default: { dia: 6, carbratio: [{ time: '00:00', value: 12 }] },
        },
      }]],
    });
    const service = new NightscoutSyncService(nightscoutRepository as never, repository as never, client as never);

    await service.ensureNightscoutSource('patient-1', 'https://nightscout.example.com');
    await service.runNightscoutSyncJob('source-1', '2026-09-16T20:00:00.000Z');
    await service.runNightscoutSyncJob('source-1', '2026-09-16T20:10:00.000Z');

    expect(nightscoutRepository.therapySnapshots).toHaveLength(2);
    expect(nightscoutRepository.therapySnapshots[0].therapy_version).not.toBe(nightscoutRepository.therapySnapshots[1].therapy_version);
  });

  it('classifies 53 mg/dL as L2', async () => {
    const nightscoutRepository = new FakeNightscoutRepository();
    const repository = new FakeGlucoMindRepository();
    const client = new FakeNightscoutClient([[
      entry({ _id: 'entry-53', sgv: 53 }),
    ]]);
    const service = new NightscoutSyncService(nightscoutRepository as never, repository as never, client as never);

    await service.ensureNightscoutSource('patient-1', 'https://nightscout.example.com');
    await service.runNightscoutSyncJob('source-1', '2026-09-16T20:00:00.000Z');
    const createdEvent = [...nightscoutRepository.events.values()][0];

    await service.runHypoDetectionJob(createdEvent.id, 'patient-1', FIXTURE_NOW);

    const episode = [...nightscoutRepository.episodes.values()][0];
    expect(episode.severity).toBe('L2');
  });

  it('deduplicates repeated imports of the same record and overlapping windows', async () => {
    const nightscoutRepository = new FakeNightscoutRepository();
    const repository = new FakeGlucoMindRepository();
    const client = new FakeNightscoutClient([[
      entry({ _id: 'entry-dup', sgv: 68 }),
    ], [
      entry({ _id: 'entry-dup', sgv: 68 }),
    ]]);
    const service = new NightscoutSyncService(nightscoutRepository as never, repository as never, client as never);

    await service.ensureNightscoutSource('patient-1', 'https://nightscout.example.com');
    await service.runNightscoutSyncJob('source-1', '2026-09-16T20:00:00.000Z');
    await service.runNightscoutSyncJob('source-1', '2026-09-16T20:01:00.000Z');

    expect(nightscoutRepository.sourceRecords.size).toBe(1);
    expect(nightscoutRepository.events.size).toBe(1);

    const createdEvent = [...nightscoutRepository.events.values()][0];
    await service.runHypoDetectionJob(createdEvent.id, 'patient-1', FIXTURE_NOW);
    await service.runHypoDetectionJob(createdEvent.id, 'patient-1', FIXTURE_NOW);

    expect(nightscoutRepository.triggers.size).toBe(1);
    expect(nightscoutRepository.episodes.size).toBe(1);
    expect(nightscoutRepository.jobs.filter((job) => job.job_type === 'analysis.follow_up')).toHaveLength(0);
  });

  it('imports entries with the same timestamp but different source IDs', async () => {
    const nightscoutRepository = new FakeNightscoutRepository();
    const repository = new FakeGlucoMindRepository();
    const client = new FakeNightscoutClient([[
      entry({ _id: 'entry-a', sgv: 68 }),
      entry({ _id: 'entry-b', sgv: 62 }),
    ]]);
    const service = new NightscoutSyncService(nightscoutRepository as never, repository as never, client as never);

    await service.ensureNightscoutSource('patient-1', 'https://nightscout.example.com');
    await service.runNightscoutSyncJob('source-1', '2026-09-16T20:00:00.000Z');

    expect(nightscoutRepository.sourceRecords.size).toBe(2);
    expect(nightscoutRepository.events.size).toBe(2);
  });

  it('uses a fallback identity when the source id is missing', async () => {
    const nightscoutRepository = new FakeNightscoutRepository();
    const repository = new FakeGlucoMindRepository();
    const client = new FakeNightscoutClient([[
      entry({ _id: undefined, id: undefined, eventId: undefined, sgv: 68 }),
      entry({ _id: undefined, id: undefined, eventId: undefined, sgv: 68 }),
    ]]);
    const service = new NightscoutSyncService(nightscoutRepository as never, repository as never, client as never);

    await service.ensureNightscoutSource('patient-1', 'https://nightscout.example.com');
    await service.runNightscoutSyncJob('source-1', '2026-09-16T20:00:00.000Z');

    expect(nightscoutRepository.sourceRecords.size).toBe(1);
    expect(nightscoutRepository.events.size).toBe(1);
  });

  it('converts mmol/L deterministically', async () => {
    const nightscoutRepository = new FakeNightscoutRepository();
    const repository = new FakeGlucoMindRepository();
    const client = new FakeNightscoutClient([[
      entry({ _id: 'mmol-1', sgv: 3.8, units: 'mmol/L' }),
    ]]);
    const service = new NightscoutSyncService(nightscoutRepository as never, repository as never, client as never);

    await service.ensureNightscoutSource('patient-1', 'https://nightscout.example.com');
    await service.runNightscoutSyncJob('source-1', '2026-09-16T20:00:00.000Z');

    const event = [...nightscoutRepository.events.values()][0];
    expect(event.payload.glucose_value).toBe(68.5);
  });

  it('rejects records for another patient', async () => {
    const nightscoutRepository = new FakeNightscoutRepository();
    const repository = new FakeGlucoMindRepository();
    const client = new FakeNightscoutClient([[
      entry({ _id: 'wrong-patient', patient: 'someone-else' }),
    ]]);
    const service = new NightscoutSyncService(nightscoutRepository as never, repository as never, client as never);

    await service.ensureNightscoutSource('patient-1', 'https://nightscout.example.com');
    const result = await service.runNightscoutSyncJob('source-1', '2026-09-16T20:00:00.000Z');

    expect(result.records_rejected).toBe(1);
    expect(nightscoutRepository.sourceRecords.size).toBe(0);
    expect(nightscoutRepository.events.size).toBe(0);
  });

  it('resumes from the persisted cursor after a restart', async () => {
    const nightscoutRepository = new FakeNightscoutRepository();
    const repository = new FakeGlucoMindRepository();
    const client = new FakeNightscoutClient((cursor) => {
      if (!cursor) {
        return [entry({ _id: 'cursor-1', sgv: 68, dateString: '2026-09-16T20:00:00.000Z' })];
      }

      return [entry({ _id: 'cursor-2', sgv: 62, dateString: '2026-09-16T20:05:00.000Z' })];
    });
    const service = new NightscoutSyncService(nightscoutRepository as never, repository as never, client as never);

    await service.ensureNightscoutSource('patient-1', 'https://nightscout.example.com');
    await service.runNightscoutSyncJob('source-1', '2026-09-16T20:00:00.000Z');
    await service.runNightscoutSyncJob('source-1', '2026-09-16T20:10:00.000Z');

    expect(client.entryCalls[0]?.cursor).toBeDefined();
    expect(client.entryCalls[1]?.cursor).toBe('2026-09-16T20:05:00.000Z');
  });

  it('paginates entries in one sync job and keeps same-timestamp boundary safe', async () => {
    const nightscoutRepository = new FakeNightscoutRepository();
    const repository = new FakeGlucoMindRepository();
    const boundaryIso = '2026-09-16T20:10:00.000Z';
    const boundaryMs = Date.parse(boundaryIso);

    const pageOne = [
      ...Array.from({ length: 499 }, (_, index) => {
        const observedAt = new Date(boundaryMs - (500 - index) * 60_000).toISOString();
        return entry({
          _id: `page-1-${index}`,
          sgv: 70 + (index % 15),
          date: Date.parse(observedAt),
          dateString: observedAt,
        });
      }),
      entry({ _id: 'boundary-a', sgv: 81, date: boundaryMs, dateString: boundaryIso }),
    ];

    const pageTwo = [
      entry({ _id: 'boundary-b', sgv: 82, date: boundaryMs, dateString: boundaryIso }),
      entry({ _id: 'after-boundary', sgv: 83, date: boundaryMs + 60_000, dateString: new Date(boundaryMs + 60_000).toISOString() }),
    ];

    const client = new FakeNightscoutClient({ entries: [pageOne, pageTwo], treatments: [[]] });
    const service = new NightscoutSyncService(nightscoutRepository as never, repository as never, client as never);

    const source = await service.ensureNightscoutSource('patient-1', 'https://nightscout.example.com');
    nightscoutRepository.sources.set('patient-1:NIGHTSCOUT:patient-1', {
      ...source,
      metadata: {
        ...source.metadata,
        stream_cursors: {
          entries: '2026-09-16T18:00:00.000Z',
        },
      },
    });
    const result = await service.runNightscoutSyncJob('source-1', '2026-09-16T21:00:00.000Z');

    expect(client.entryCalls).toHaveLength(2);
    expect(client.entryCalls[1]?.cursor).toBe(boundaryIso);
    expect(result.entries.fetched).toBe(502);
    expect(result.entries.imported).toBe(502);
  });

  it('imports a live page oldest first when entries carry only a numeric date', async () => {
    const nightscoutRepository = new FakeNightscoutRepository();
    const repository = new FakeGlucoMindRepository();
    const at = (time: string) => Date.parse(`2026-09-16T${time}:00.000Z`);
    const client = new FakeNightscoutClient({
      entries: [[
        entry({ _id: 'c', sgv: 90, dateString: undefined, date: at('20:10') }),
        entry({ _id: 'a', sgv: 80, dateString: undefined, date: String(at('20:00')) }),
        entry({ _id: 'b', sgv: 85, dateString: undefined, date: at('20:05') }),
      ]],
      treatments: [[]],
    });
    const service = new NightscoutSyncService(nightscoutRepository as never, repository as never, client as never);
    await service.ensureNightscoutSource('patient-1', 'https://nightscout.example.com');
    const persist = vi.spyOn(nightscoutRepository, 'persistImportedGlucoseReading');

    const result = await service.runNightscoutSyncJob('source-1', '2026-09-16T20:12:00.000Z');

    expect(result.entries).toMatchObject({ fetched: 3, imported: 3, rejected: 0 });
    expect(persist.mock.calls.map(([args]) => (args as { reading: { source_record_id: string } }).reading.source_record_id)).toEqual(['a', 'b', 'c']);
  });

  it('stops entry pagination at configured page cap and leaves continuation for next run', async () => {
    const nightscoutRepository = new FakeNightscoutRepository();
    const repository = new FakeGlucoMindRepository();
    const baseMs = Date.parse('2026-09-16T20:00:00.000Z');

    const pageOne = Array.from({ length: 500 }, (_, index) => {
      const observedAt = new Date(baseMs + index * 60_000).toISOString();
      return entry({
        _id: `cap-${index}`,
        sgv: 90 + (index % 10),
        date: Date.parse(observedAt),
        dateString: observedAt,
      });
    });
    const pageTwo = [entry({ _id: 'cap-next', sgv: 101, date: baseMs + 501 * 60_000, dateString: new Date(baseMs + 501 * 60_000).toISOString() })];

    const client = new FakeNightscoutClient({ entries: [pageOne, pageTwo], treatments: [[]] });
    const configService = {
      get: (key: string) => (key === 'NIGHTSCOUT_SYNC_MAX_ENTRY_PAGES' ? 1 : undefined),
    };
    const service = new NightscoutSyncService(
      nightscoutRepository as never,
      repository as never,
      client as never,
      configService as never,
    );

    const source = await service.ensureNightscoutSource('patient-1', 'https://nightscout.example.com');
    nightscoutRepository.sources.set('patient-1:NIGHTSCOUT:patient-1', {
      ...source,
      metadata: {
        ...source.metadata,
        stream_cursors: {
          entries: '2026-09-16T18:00:00.000Z',
        },
      },
    });
    const result = await service.runNightscoutSyncJob('source-1', '2026-09-16T21:00:00.000Z');

    expect(client.entryCalls).toHaveLength(1);
    expect(result.entries.fetched).toBe(500);
    expect(result.entries.imported).toBe(500);
  });

  it('distinguishes retryable and non-retryable Nightscout failures', async () => {
    const nightscoutRepository = new FakeNightscoutRepository();
    const repository = new FakeGlucoMindRepository();
    const retryableClient = new FakeNightscoutClient(async () => {
      throw new NightscoutClientError('timeout', true);
    });
    const retryableService = new NightscoutSyncService(nightscoutRepository as never, repository as never, retryableClient as never);

    await retryableService.ensureNightscoutSource('patient-1', 'https://nightscout.example.com');
    await expect(retryableService.runNightscoutSyncJob('source-1', '2026-09-16T20:00:00.000Z')).rejects.toMatchObject({ retryable: true });

    const unauthorizedClient = new FakeNightscoutClient(async () => {
      throw new NightscoutClientError('unauthorized', false, 401);
    });
    const unauthorizedService = new NightscoutSyncService(nightscoutRepository as never, repository as never, unauthorizedClient as never);
    await unauthorizedService.ensureNightscoutSource('patient-1', 'https://nightscout.example.com');
    await expect(unauthorizedService.runNightscoutSyncJob('source-1', '2026-09-16T20:00:00.000Z')).rejects.toMatchObject({ retryable: false });
  });

  it('imports supported treatment signals without queueing jobs for them', async () => {
    const nightscoutRepository = new FakeNightscoutRepository();
    const repository = new FakeGlucoMindRepository();
    const client = new FakeNightscoutClient({
      entries: [[]],
      treatments: [[
        { _id: 'tx-carb-1', eventType: 'Carb Correction', created_at: '2026-09-16T19:00:00.000Z', carbs: 40 },
        { _id: 'tx-bolus-1', eventType: 'Bolus', created_at: '2026-09-16T19:01:00.000Z', insulin: 3 },
        { _id: 'tx-smb-1', eventType: 'SMB', created_at: '2026-09-16T19:10:00.000Z', insulin: 0.6 },
        { _id: 'tx-temp-1', eventType: 'Temp Basal', created_at: '2026-09-16T19:12:00.000Z', rate: 0.8, duration: 30 },
      ]],
    });
    const service = new NightscoutSyncService(nightscoutRepository as never, repository as never, client as never);

    await service.ensureNightscoutSource('patient-1', 'https://nightscout.example.com');
    const result = await service.runNightscoutSyncJob('source-1', '2026-09-16T20:00:00.000Z');

    expect(result.treatments.imported).toBe(4);
    expect(result.treatments.rejected).toBe(0);
    expect(result.treatments.events_created).toBe(4);
    // Loop actions group carb entries and boluses on the worker's own timer: treatments queue nothing.
    expect(result.treatments.jobs_enqueued).toBe(0);
    expect(nightscoutRepository.jobs).toHaveLength(0);
  });

  it('rejects unsupported or malformed treatment events deterministically', async () => {
    const nightscoutRepository = new FakeNightscoutRepository();
    const repository = new FakeGlucoMindRepository();
    const client = new FakeNightscoutClient({
      entries: [[]],
      treatments: [[
        { _id: 'tx-note', eventType: 'Note', created_at: '2026-09-16T19:00:00.000Z' },
        { _id: 'tx-bolus-zero', eventType: 'Bolus', created_at: '2026-09-16T19:00:00.000Z', insulin: 0 },
        { _id: undefined, eventType: 'SMB', created_at: '2026-09-16T19:01:00.000Z', insulin: 0.4 },
      ]],
    });
    const service = new NightscoutSyncService(nightscoutRepository as never, repository as never, client as never);

    await service.ensureNightscoutSource('patient-1', 'https://nightscout.example.com');
    const result = await service.runNightscoutSyncJob('source-1', '2026-09-16T20:00:00.000Z');

    expect(result.treatments.imported).toBe(0);
    expect(result.treatments.rejected).toBe(3);
    expect(result.treatments.events_created).toBe(0);
  });

  it('deduplicates repeated treatment imports', async () => {
    const nightscoutRepository = new FakeNightscoutRepository();
    const repository = new FakeGlucoMindRepository();
    const treatments = [{ _id: 'tx-dup-1', eventType: 'Bolus', created_at: '2026-09-16T19:00:00.000Z', insulin: 2.5 }];
    const client = new FakeNightscoutClient({ entries: [[], []], treatments: [treatments, treatments] });
    const service = new NightscoutSyncService(nightscoutRepository as never, repository as never, client as never);

    await service.ensureNightscoutSource('patient-1', 'https://nightscout.example.com');
    await service.runNightscoutSyncJob('source-1', '2026-09-16T20:00:00.000Z');
    await service.runNightscoutSyncJob('source-1', '2026-09-16T20:10:00.000Z');

    expect(nightscoutRepository.sourceRecords.size).toBe(1);
    expect(nightscoutRepository.events.size).toBe(1);
  });

  it('imports treatments with same timestamp when source ids differ', async () => {
    const nightscoutRepository = new FakeNightscoutRepository();
    const repository = new FakeGlucoMindRepository();
    const client = new FakeNightscoutClient({
      entries: [[]],
      treatments: [[
        { _id: 'tx-same-ts-a', eventType: 'Bolus', created_at: '2026-09-16T19:00:00.000Z', insulin: 1.5 },
        { _id: 'tx-same-ts-b', eventType: 'Bolus', created_at: '2026-09-16T19:00:00.000Z', insulin: 2.0 },
      ]],
    });
    const service = new NightscoutSyncService(nightscoutRepository as never, repository as never, client as never);

    await service.ensureNightscoutSource('patient-1', 'https://nightscout.example.com');
    const result = await service.runNightscoutSyncJob('source-1', '2026-09-16T20:00:00.000Z');

    expect(result.treatments.imported).toBe(2);
    expect(result.treatments.events_created).toBe(2);
  });

  it('counts a treatment Trio uploaded twice as deduplicated, not imported', async () => {
    const nightscoutRepository = new FakeNightscoutRepository();
    const repository = new FakeGlucoMindRepository();
    const client = new FakeNightscoutClient({
      entries: [[]],
      treatments: [[
        { _id: 'tx-trio-a', eventType: 'Bolus', created_at: '2026-09-16T19:00:00.371Z', insulin: 1.2, enteredBy: 'Trio' },
        { _id: 'tx-trio-b', eventType: 'Bolus', created_at: '2026-09-16T19:00:00.371Z', insulin: 1.2, enteredBy: 'Trio' },
      ]],
    });
    // The repository recognises the copy (postgres spec: nightscout-treatment-duplicates); here only its answer matters.
    const persist = nightscoutRepository.persistImportedTreatment.bind(nightscoutRepository);
    nightscoutRepository.persistImportedTreatment = async (args) => {
      const first = await persist(args);
      return args.treatment.source_record_id === 'tx-trio-b'
        ? { ...first, event_id: 'evt-1', event_created: false, duplicate_of_event_id: 'evt-1' }
        : first;
    };
    const service = new NightscoutSyncService(nightscoutRepository as never, repository as never, client as never);

    await service.ensureNightscoutSource('patient-1', 'https://nightscout.example.com');
    const result = await service.runNightscoutSyncJob('source-1', '2026-09-16T20:00:00.000Z');

    expect(result.treatments).toMatchObject({ fetched: 2, imported: 1, deduplicated: 1, events_created: 1 });
  });

  it('rejects treatment rows with foreign patient identifier', async () => {
    const nightscoutRepository = new FakeNightscoutRepository();
    const repository = new FakeGlucoMindRepository();
    const client = new FakeNightscoutClient({
      entries: [[]],
      treatments: [[
        { _id: 'tx-foreign', eventType: 'Carb Correction', created_at: '2026-09-16T19:00:00.000Z', carbs: 20, patient: 'another-patient' },
      ]],
    });
    const service = new NightscoutSyncService(nightscoutRepository as never, repository as never, client as never);

    await service.ensureNightscoutSource('patient-1', 'https://nightscout.example.com');
    const result = await service.runNightscoutSyncJob('source-1', '2026-09-16T20:00:00.000Z');

    expect(result.treatments.imported).toBe(0);
    expect(result.treatments.rejected).toBe(1);
  });
});
describe('historical window import side effects (current behaviour, pinned)', () => {
  const WINDOW_START = '2026-09-16T00:00:00.000Z';
  const WINDOW_END = '2026-09-16T23:59:59.999Z';
  const inWindow = (time: string, sgv: number, id: string) => entry({ _id: id, sgv, date: Date.parse(`2026-09-16T${time}:00.000Z`), dateString: `2026-09-16T${time}:00.000Z` });

  async function importWindow(pages: Array<NightscoutEntryDto[]>) {
    const nightscoutRepository = new FakeNightscoutRepository();
    const repository = new FakeGlucoMindRepository();
    const service = new NightscoutSyncService(nightscoutRepository as never, repository as never, new FakeNightscoutClient({ entries: pages, treatments: [[]] }) as never);
    await service.ensureNightscoutSource('patient-1', 'https://nightscout.example.com');
    const persist = vi.spyOn(nightscoutRepository, 'persistImportedGlucoseReading');
    const detect = vi.spyOn(nightscoutRepository, 'persistHypoDetection');
    const result = await service.runNightscoutSyncWindow('source-1', '2026-09-17T08:00:00.000Z', WINDOW_START, WINDOW_END);
    return { nightscoutRepository, repository, service, result, persist, detect };
  }

  it('stores readings as HISTORICAL and only enqueues hypo-detection jobs: no episode, conversation or analysis by itself', async () => {
    const { nightscoutRepository, repository, result, persist, detect } = await importWindow([[
      inWindow('10:00', 110, 'entry-110'),
      inWindow('10:05', 50, 'entry-50'),
      inWindow('10:10', 112, 'entry-112'),
    ]]);

    expect(result.entries).toMatchObject({ fetched: 3, imported: 3, deduplicated: 0, rejected: 0, events_created: 3, jobs_enqueued: 3 });
    expect(persist.mock.calls.every(([args]) => (args as { ingestionOrigin?: string }).ingestionOrigin === 'HISTORICAL')).toBe(true);
    expect(new Set(nightscoutRepository.jobs.map((job) => job.job_type))).toEqual(new Set(['triggering.hypo_detection']));
    expect(repository.jobs).toEqual([]);
    expect(detect).not.toHaveBeenCalled();
    expect(nightscoutRepository.triggers.size).toBe(0);
    expect(nightscoutRepository.episodes.size).toBe(0);
    expect(nightscoutRepository.conversations.size).toBe(0);
    expect(nightscoutRepository.jobs.some((job) => job.job_type === 'analysis.follow_up')).toBe(false);
  });

  it('is idempotent on re-import of the same window: nothing new is stored or enqueued', async () => {
    const page = [inWindow('10:00', 110, 'entry-110'), inWindow('10:05', 50, 'entry-50')];
    const { nightscoutRepository, service } = await importWindow([page, page]);
    const again = await service.runNightscoutSyncWindow('source-1', '2026-09-17T08:00:00.000Z', WINDOW_START, WINDOW_END);

    expect(again.entries).toMatchObject({ fetched: 2, imported: 0, deduplicated: 2, events_created: 0, jobs_enqueued: 0 });
    expect(nightscoutRepository.events.size).toBe(2);
    expect(nightscoutRepository.jobs.filter((job) => job.job_type === 'triggering.hypo_detection')).toHaveLength(2);
  });

  it('counts readings after the window end as fetched but neither imported, deduplicated nor rejected', async () => {
    const { result, nightscoutRepository } = await importWindow([[
      inWindow('23:55', 110, 'entry-in'),
      entry({ _id: 'entry-after', sgv: 120, date: Date.parse('2026-09-17T00:05:00.000Z'), dateString: '2026-09-17T00:05:00.000Z' }),
    ]]);

    expect(result.entries).toMatchObject({ fetched: 2, imported: 1, deduplicated: 0, rejected: 0 });
    expect(nightscoutRepository.events.size).toBe(1);
  });

  it('processing the queued hypo-detection job stores the HISTORICAL episode without a conversation or analysis.follow_up', async () => {
    const { nightscoutRepository, service } = await importWindow([[inWindow('10:05', 50, 'entry-50')]]);
    const event = [...nightscoutRepository.events.values()][0];
    event.event_ingestion_origin = 'HISTORICAL';

    await service.runHypoDetectionJob(event.id, 'patient-1', '2026-09-17T08:00:00.000Z');

    expect(nightscoutRepository.episodes.size).toBe(1);
    expect(nightscoutRepository.triggers.size).toBe(1);
    expect(nightscoutRepository.conversations.size).toBe(0);
    expect(nightscoutRepository.jobs.filter((job) => job.job_type === 'analysis.follow_up')).toHaveLength(0);
  });

  it('reads an entry time given only as numeric date (epoch ms, also as a string), as the normalizer does', async () => {
    const { result, nightscoutRepository } = await importWindow([[
      entry({ _id: 'numeric-date', sgv: 110, dateString: undefined, date: Date.parse('2026-09-16T10:00:00.000Z') }),
      entry({ _id: 'numeric-string-date', sgv: 112, dateString: undefined, date: String(Date.parse('2026-09-16T10:05:00.000Z')) }),
      entry({ _id: 'numeric-date-after', sgv: 120, dateString: undefined, date: Date.parse('2026-09-17T00:05:00.000Z') }),
    ]]);

    expect(result.entries).toMatchObject({ fetched: 3, imported: 2, deduplicated: 0, rejected: 0 });
    expect([...nightscoutRepository.events.values()].map((event) => event.occurred_at).sort()).toEqual(['2026-09-16T10:00:00.000Z', '2026-09-16T10:05:00.000Z']);
  });

  describe('window pages', () => {
    // A Nightscout stand-in: the oldest `limit` records at or after the cursor ($gte), like the HTTP client asks.
    function pagedFrom<T>(records: T[], timeOf: (record: T) => string) {
      return (cursor: string | null) => records.filter((record) => !cursor || Date.parse(timeOf(record)) >= Date.parse(cursor)).slice(0, 500);
    }

    async function importWindowFrom(entries: NightscoutEntryDto[], treatments: NightscoutTreatmentDto[] = []) {
      const nightscoutRepository = new FakeNightscoutRepository();
      const client = new FakeNightscoutClient({
        entries: pagedFrom(entries, (record) => String(record.dateString)),
        treatments: pagedFrom(treatments, (record) => String(record.created_at)),
      });
      const service = new NightscoutSyncService(nightscoutRepository as never, new FakeGlucoMindRepository() as never, client as never);
      await service.ensureNightscoutSource('patient-1', 'https://nightscout.example.com');
      const result = await service.runNightscoutSyncWindow('source-1', '2026-09-17T08:00:00.000Z', WINDOW_START, WINDOW_END);
      return { client, result, nightscoutRepository };
    }

    const minute = (index: number) => new Date(Date.parse('2026-09-16T01:00:00.000Z') + index * 60_000).toISOString();
    const reading = (id: string, time: string) => entry({ _id: id, sgv: 110, date: Date.parse(time), dateString: time });
    const carbs = (id: string, time: string): NightscoutTreatmentDto => ({ _id: id, eventType: 'Carb Correction', carbs: 10, created_at: time });

    it('keeps every record that shares the page boundary millisecond, each imported once', async () => {
      const boundary = minute(499);
      const entries = [
        ...Array.from({ length: 499 }, (_, index) => reading(`entry-${index}`, minute(index))),
        reading('boundary-a', boundary), reading('boundary-b', boundary), reading('boundary-c', boundary),
        reading('after', minute(500)),
      ];
      const treatments = [
        ...Array.from({ length: 499 }, (_, index) => carbs(`carbs-${index}`, minute(index))),
        carbs('carbs-boundary-a', boundary), carbs('carbs-boundary-b', boundary),
      ];

      const { client, result, nightscoutRepository } = await importWindowFrom(entries, treatments);

      expect(client.entryCalls.map((call) => call.cursor)).toEqual([WINDOW_START, boundary]);
      expect(client.treatmentCalls.map((call) => call.cursor)).toEqual([WINDOW_START, boundary]);
      expect(result.entries).toMatchObject({ fetched: 503, imported: 503, deduplicated: 0, rejected: 0 });
      expect(result.treatments).toMatchObject({ fetched: 501, imported: 501, deduplicated: 0, rejected: 0 });
      expect(nightscoutRepository.events.size).toBe(503 + 501);
    });

    it('stops when a full page cannot move the cursor (one shared timestamp) instead of asking forever', async () => {
      const same = '2026-09-16T05:00:00.000Z';
      const entries = Array.from({ length: 600 }, (_, index) => reading(`same-${index}`, same));

      const { client, result } = await importWindowFrom(entries);

      expect(client.entryCalls.map((call) => call.cursor)).toEqual([WINDOW_START, same]);
      expect(result.entries).toMatchObject({ fetched: 500, imported: 500 });
    });
  });

  it('throws before fetching when the source does not exist', async () => {
    const client = new FakeNightscoutClient([[inWindow('10:00', 110, 'entry-110')]]);
    const service = new NightscoutSyncService(new FakeNightscoutRepository() as never, new FakeGlucoMindRepository() as never, client as never);
    await expect(service.runNightscoutSyncWindow('missing-source', '2026-09-17T08:00:00.000Z', WINDOW_START, WINDOW_END)).rejects.toThrow('NIGHTSCOUT_SOURCE_NOT_FOUND');
    expect(client.entryCalls).toHaveLength(0);
  });
});

describe('hypo detection by ingestion origin', () => {
  const at = (time: string) => ({ date: Date.parse(`2026-09-16T${time}:00.000Z`), dateString: `2026-09-16T${time}:00.000Z` });

  async function importReadings(readings: Array<{ id: string; sgv: number; time: string }>, origin: 'LIVE' | 'HISTORICAL' | null | undefined | string) {
    const nightscoutRepository = new FakeNightscoutRepository();
    const service = new NightscoutSyncService(nightscoutRepository as never, new FakeGlucoMindRepository() as never, new FakeNightscoutClient([
      readings.map((reading) => entry({ _id: reading.id, sgv: reading.sgv, ...at(reading.time) })),
    ]) as never);
    await service.ensureNightscoutSource('patient-1', 'https://nightscout.example.com');
    await service.runNightscoutSyncJob('source-1', '2026-09-16T00:00:00.000Z');
    for (const event of nightscoutRepository.events.values()) {
      event.event_ingestion_origin = origin as 'LIVE' | 'HISTORICAL';
    }
    const events = [...nightscoutRepository.events.values()].sort((a, b) => a.occurred_at.localeCompare(b.occurred_at));
    return { nightscoutRepository, service, events };
  }

  it('stores a HISTORICAL episode with its trigger, start and closing readings, without conversation or follow-up', async () => {
    const { nightscoutRepository, service, events } = await importReadings([
      { id: 'h-60', sgv: 60, time: '10:00' },
      { id: 'h-52', sgv: 52, time: '10:05' },
      { id: 'h-80', sgv: 80, time: '10:10' },
      { id: 'h-85', sgv: 85, time: '10:25' },
    ], 'HISTORICAL');
    for (const event of events) {
      await service.runHypoDetectionJob(event.id, 'patient-1', '2026-09-17T08:00:00.000Z');
    }

    const [episode] = [...nightscoutRepository.episodes.values()];
    expect(nightscoutRepository.episodes.size).toBe(1);
    expect(episode).toMatchObject({ state: 'CLOSED', severity: 'L2', start_event_id: events[0].id, latest_event_id: events[3].id, started_at: events[0].occurred_at, ended_at: events[2].occurred_at });
    expect(nightscoutRepository.triggers.size).toBe(1);
    expect(nightscoutRepository.conversations.size).toBe(0);
    expect(nightscoutRepository.jobs.filter((job) => job.job_type === 'analysis.follow_up')).toHaveLength(0);
  });

  it('keeps LIVE unchanged: a fresh LIVE hypo creates its episode and trigger, and no conversation or analysis', async () => {
    const { nightscoutRepository, service, events } = await importReadings([{ id: 'l-60', sgv: 60, time: '20:00' }], 'LIVE');
    const result = await service.runHypoDetectionJob(events[0].id, 'patient-1', FIXTURE_NOW);

    expect(result).toMatchObject({ trigger_created: true, episode_created: true });
    expect(nightscoutRepository.conversations.size).toBe(0);
    expect(nightscoutRepository.jobs.filter((job) => job.job_type === 'analysis.follow_up')).toHaveLength(0);
  });

  it('does not duplicate a HISTORICAL episode or trigger when the same reading is processed again', async () => {
    const { nightscoutRepository, service, events } = await importReadings([{ id: 'h-55', sgv: 55, time: '09:00' }], 'HISTORICAL');
    await service.runHypoDetectionJob(events[0].id, 'patient-1', '2026-09-17T08:00:00.000Z');
    const again = await service.runHypoDetectionJob(events[0].id, 'patient-1', '2026-09-17T08:05:00.000Z');

    expect(again).toMatchObject({ trigger_created: false, episode_created: false });
    expect(nightscoutRepository.episodes.size).toBe(1);
    expect(nightscoutRepository.triggers.size).toBe(1);
    expect(nightscoutRepository.conversations.size).toBe(0);
    expect(nightscoutRepository.jobs.filter((job) => job.job_type === 'analysis.follow_up')).toHaveLength(0);
  });

  it('refuses a reading whose origin is missing or unknown instead of treating it as LIVE or HISTORICAL', async () => {
    for (const origin of [null, undefined, '', 'REPLAY', 'historical']) {
      const { nightscoutRepository, service, events } = await importReadings([{ id: 'x-55', sgv: 55, time: '20:00' }], origin);
      vi.spyOn(nightscoutRepository, 'getImportedReadingForEvent').mockImplementation(async () => ({
        event_id: events[0].id,
        source_record_id: events[0].source_record_id,
        occurred_at: events[0].occurred_at,
        recorded_at: events[0].recorded_at,
        payload: events[0].payload,
        event_ingestion_origin: origin,
      }));
      const persist = vi.spyOn(nightscoutRepository, 'persistHypoDetection');

      await expect(service.runHypoDetectionJob(events[0].id, 'patient-1', FIXTURE_NOW)).rejects.toThrow('UNKNOWN_EVENT_INGESTION_ORIGIN');
      expect(persist).not.toHaveBeenCalled();
      expect(nightscoutRepository.episodes.size).toBe(0);
      expect(nightscoutRepository.conversations.size).toBe(0);
      expect(nightscoutRepository.jobs.filter((job) => job.job_type === 'analysis.follow_up')).toHaveLength(0);
    }
  });
});

describe('late uploads behind the cursor (look-back window)', () => {
  async function setupLate(options: { lateEntries?: NightscoutEntryDto[]; lateTreatments?: NightscoutTreatmentDto[]; entries?: NightscoutEntryDto[]; lookbackMinutes?: number } = {}) {
    const nightscoutRepository = new FakeNightscoutRepository();
    const client = new FakeNightscoutClient({ entries: () => options.entries ?? [], treatments: () => [] });
    client.lateEntries = options.lateEntries ?? [];
    client.lateTreatments = options.lateTreatments ?? [];
    const config = options.lookbackMinutes === undefined
      ? undefined
      : { get: (key: string) => (key === 'NIGHTSCOUT_SYNC_LOOKBACK_MINUTES' ? options.lookbackMinutes : undefined) };
    const service = new NightscoutSyncService(nightscoutRepository as never, new FakeGlucoMindRepository() as never, client as never, config as never);
    const source = await service.ensureNightscoutSource('patient-1', 'https://nightscout.example.com');
    source.metadata = { ...source.metadata, stream_cursors: { entries: '2026-09-16T10:00:00.000Z', treatments: '2026-09-16T10:00:00.000Z' } };
    return { nightscoutRepository, client, service };
  }

  it('imports carbs entered at 10:07 for 09:45 (behind the 10:00 cursor) as LIVE, and only once', async () => {
    const { nightscoutRepository, client, service } = await setupLate({
      lateTreatments: [{ _id: 'tx-late-carbs', eventType: 'Carb Correction', created_at: '2026-09-16T09:45:00.000Z', carbs: 30 }],
    });
    const persist = vi.spyOn(nightscoutRepository, 'persistImportedTreatment');

    const first = await service.runNightscoutSyncJob('source-1', '2026-09-16T10:07:30.000Z');

    expect(client.lookbackCalls).toContainEqual({ stream: 'treatments', cursor: '2026-09-16T04:00:00.000Z', before: '2026-09-16T10:00:00.000Z' });
    expect(first.treatments.imported).toBe(1);
    expect(persist).toHaveBeenCalledTimes(1);
    expect((persist.mock.calls[0]![0] as { ingestionOrigin?: string }).ingestionOrigin).toBe('LIVE');
    expect(nightscoutRepository.events.size).toBe(1);

    // The next sync reads the window again and skips what is already imported.
    const second = await service.runNightscoutSyncJob('source-1', '2026-09-16T10:08:30.000Z');
    expect(second.treatments.imported).toBe(0);
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it('imports a CGM reading backfilled behind the cursor as HISTORICAL, before the live readings', async () => {
    const { nightscoutRepository, service } = await setupLate({
      lateEntries: [entry({ _id: 'late-sgv', sgv: 60, date: Date.parse('2026-09-16T09:40:00.000Z'), dateString: '2026-09-16T09:40:00.000Z' })],
      entries: [entry({ _id: 'live-sgv', sgv: 120, date: Date.parse('2026-09-16T10:05:00.000Z'), dateString: '2026-09-16T10:05:00.000Z' })],
    });
    const persist = vi.spyOn(nightscoutRepository, 'persistImportedGlucoseReading');

    const result = await service.runNightscoutSyncJob('source-1', '2026-09-16T10:06:00.000Z');

    expect(result.entries.imported).toBe(2);
    expect(persist.mock.calls.map(([args]) => [(args as { reading: { observed_at: string } }).reading.observed_at, (args as { ingestionOrigin?: string }).ingestionOrigin])).toEqual([
      ['2026-09-16T09:40:00.000Z', 'HISTORICAL'],
      ['2026-09-16T10:05:00.000Z', 'LIVE'],
    ]);
  });

  it('reads no look-back window with NIGHTSCOUT_SYNC_LOOKBACK_MINUTES=0', async () => {
    const { client, service } = await setupLate({
      lookbackMinutes: 0,
      lateTreatments: [{ _id: 'tx-late-carbs', eventType: 'Carb Correction', created_at: '2026-09-16T09:45:00.000Z', carbs: 30 }],
    });

    const result = await service.runNightscoutSyncJob('source-1', '2026-09-16T10:07:30.000Z');

    expect(client.lookbackCalls).toEqual([]);
    expect(result.treatments.imported).toBe(0);
  });
});
