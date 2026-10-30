import { Inject, Injectable, Logger } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import { randomUUID } from 'crypto';
import { DATABASE_POOL } from './database.tokens';
import { NormalizedGlucoseReading } from '@modules/integrations/nightscout/application/nightscout-normalizer';
import { NormalizedNightscoutTreatment } from '@modules/integrations/nightscout/application/nightscout-treatment-normalizer';
import { mapNightscoutTrendDirection, NormalizedNightscoutDeviceStatusSnapshot } from '@modules/integrations/nightscout/application/nightscout-devicestatus-normalizer';
import { detectHypo } from '@modules/triggering/application/hypo-detector';
import { HypoEpisodeView } from '@modules/triggering/domain/hypo-types';
import { PostgresTherapyContextEventRepository } from './postgres-therapy-context-events.repository';
import type { TherapyContextEvent } from '@modules/integrations/nightscout/application/therapy-context-events';
import { HISTORY_BACKFILL_METADATA_KEY, type HistoryBackfillPlan } from '@modules/integrations/nightscout/application/nightscout-history-backfill';

/** The loop's IOB / COB go with the newest reading only when computed within this time of it. */
const CURRENT_STATE_LOOP_MAX_GAP_MS = 15 * 60_000;

function toCanonicalTimestamp(value: unknown): string {
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

type EventIngestionOrigin = 'LIVE' | 'HISTORICAL';

interface NightscoutSourceRow {
  id: string;
  patient_id: string;
  source_system: string;
  source_key: string;
  sync_cursor: string | null;
  last_successful_observed_at: string | null;
  source_version: string | null;
  metadata: Record<string, unknown>;
}

/**
 * Why a fetched Nightscout record was not imported. SOURCE_RECORD_OF_ANOTHER_PATIENT: a Nightscout `_id` is unique
 * across all sources (source_records_source_system_record_id_unique), so a record already imported for another
 * patient (two patients pointing at the same Nightscout) is never written again; it is counted as deduplicated.
 */
export type NightscoutRecordSkipReason = 'SOURCE_RECORD_OF_ANOTHER_PATIENT';

export interface ImportedGlucosePersistenceResult {
  /** Null only when skipped_reason is set. */
  source_record_id: string | null;
  /** Null only when skipped_reason is set. */
  event_id: string | null;
  source_record_created: boolean;
  event_created: boolean;
  job_created: boolean;
  current_state_created: boolean;
  skipped_reason?: NightscoutRecordSkipReason;
}

export interface ImportedTreatmentPersistenceResult {
  /** Null only when skipped_reason is set. */
  source_record_id: string | null;
  /** Null only when skipped_reason is set. */
  event_id: string | null;
  source_record_created: boolean;
  event_created: boolean;
  /** Set when this Nightscout record is a second upload of an already imported treatment (event_id is that one's). */
  duplicate_of_event_id?: string;
  skipped_reason?: NightscoutRecordSkipReason;
}

export interface ImportedDeviceStatusPersistenceResult {
  /** Null only when skipped_reason is set. */
  source_record_id: string | null;
  source_record_created: boolean;
  event_ids: string[];
  current_state_updated: boolean;
  skipped_reason?: NightscoutRecordSkipReason;
}

export interface ImportedTherapyProfilePersistenceResult {
  therapy_id: string | null;
  patient_id: string;
  therapy_version: string;
  active_profile_id: string;
  observed_at: string;
  valid_from: string | null;
  valid_to: string | null;
  created: boolean;
}

@Injectable()
export class PostgresNightscoutRepository {
  private readonly logger = new Logger(PostgresNightscoutRepository.name);

  constructor(@Inject(DATABASE_POOL) private readonly pool: Pool) {}

  async withTransaction<T>(handler: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await handler(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /** therapy_context_events (migration 086): one Trio / Nightscout context treatment; true when this call stored it. */
  async storeTherapyContextEvent(patientId: string, event: TherapyContextEvent): Promise<boolean> {
    return new PostgresTherapyContextEventRepository(this.pool).insert(patientId, event);
  }

  /** Sets one top-level metadata key of a source (kept by ensureNightscoutSource's merge). */
  async setSourceMetadataValue(sourceId: string, key: string, value: string): Promise<void> {
    await this.pool.query(
      `UPDATE sources SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object($2::text, $3::text), updated_at = now() WHERE id = $1`,
      [sourceId, key, value],
    );
  }

  /**
   * Writes the source's history import plan (nightscout-history.v1) only when the stored one still has
   * `expectedRevision` (null: none stored yet); false when another run or a gap changed it meanwhile.
   */
  async writeHistoryBackfillPlan(sourceId: string, plan: HistoryBackfillPlan, expectedRevision: number | null): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE sources
       SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{${HISTORY_BACKFILL_METADATA_KEY}}', $2::jsonb, true), updated_at = now()
       WHERE id = $1
         AND (
           ($3::int IS NULL AND (metadata->'${HISTORY_BACKFILL_METADATA_KEY}') IS NULL)
           OR (metadata->'${HISTORY_BACKFILL_METADATA_KEY}'->>'revision')::int = $3::int
         )`,
      [sourceId, JSON.stringify(plan), expectedRevision],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /** Moves every stream cursor forward to `cursorIso` (never back): the live sync skipped what is behind it. */
  async advanceStreamCursors(sourceId: string, cursorIso: string): Promise<void> {
    await this.withTransaction(async (client) => {
      for (const stream of ['entries', 'treatments', 'devicestatus'] as const) await this.updateStreamCursor(client, sourceId, stream, cursorIso);
    });
  }

  async ensureNightscoutSource(args: { patientId: string; sourceKey: string; sourceVersion: string; metadata: Record<string, unknown> }): Promise<NightscoutSourceRow> {
    const result = await this.pool.query<NightscoutSourceRow>(
      `
        INSERT INTO sources (patient_id, source_system, source_key, source_version, metadata)
        VALUES ($1, 'NIGHTSCOUT', $2, $3, $4)
        ON CONFLICT (patient_id, source_system, source_key)
        DO UPDATE SET
          source_version = EXCLUDED.source_version,
          -- Merge configuration into existing metadata. Per-stream sync cursors are owned by the
          -- importer (updateStreamCursor) and must survive re-initialisation on worker start.
          metadata = COALESCE(sources.metadata, '{}'::jsonb) || (EXCLUDED.metadata - 'stream_cursors'),
          updated_at = now()
        RETURNING *
      `,
      [args.patientId, args.sourceKey, args.sourceVersion, args.metadata],
    );

    return result.rows[0];
  }

  async listNightscoutSources(): Promise<NightscoutSourceRow[]> {
    const result = await this.pool.query<NightscoutSourceRow>(
      `
        SELECT *
        FROM sources
        WHERE source_system = 'NIGHTSCOUT'
          AND enabled
        ORDER BY created_at ASC
      `,
    );

    return result.rows;
  }

  async getNightscoutSourceById(sourceId: string): Promise<NightscoutSourceRow | null> {
    const result = await this.pool.query<NightscoutSourceRow>(`SELECT * FROM sources WHERE id = $1 AND source_system = 'NIGHTSCOUT' LIMIT 1`, [sourceId]);
    return result.rows[0] ?? null;
  }

  async persistImportedGlucoseReading(args: {
    source: NightscoutSourceRow;
    reading: NormalizedGlucoseReading;
    ingestionOrigin?: EventIngestionOrigin;
    /**
     * The history import (nightscout-history.v1): no current state (the reading is old) and no queued hypo detection
     * (the import runs it itself, in time order, so thousands of old readings never queue ahead of a live one).
     */
    historyBackfill?: boolean;
    jobDedupeKey: string;
    correlationId: string;
    causationId: string;
    jobPayload: Record<string, unknown>;
  }): Promise<ImportedGlucosePersistenceResult> {
    return this.withTransaction(async (client) => {
      const sourceRecord = await this.insertSourceRecord(client, args.source, args.reading);
      if (!sourceRecord) {
        await this.updateSyncState(client, args.source.id, args.reading.observed_at);
        return {
          source_record_id: null,
          event_id: null,
          source_record_created: false,
          event_created: false,
          job_created: false,
          current_state_created: false,
          skipped_reason: 'SOURCE_RECORD_OF_ANOTHER_PATIENT',
        };
      }
      const event = await this.insertGlucoseEvent(client, args.source, sourceRecord.id, args.reading, args.ingestionOrigin ?? 'LIVE');
      const backfill = args.historyBackfill === true;
      const currentStateCreated = backfill ? false : await this.upsertCurrentState(client, args.source.patient_id, event.id, args.reading);
      const jobCreated = backfill ? false : await this.enqueueHypoDetectionJob(client, {
        jobType: 'triggering.hypo_detection',
        payloadVersion: 1,
        payload: {
          ...args.jobPayload,
          event_id: event.id,
        },
        dedupeKey: args.jobDedupeKey,
        correlationId: args.correlationId,
        causationId: args.causationId,
        patientId: args.source.patient_id,
        availableAt: args.reading.imported_at,
        maxAttempts: 5,
      });

      await this.updateSyncState(client, args.source.id, args.reading.observed_at);

      return {
        source_record_id: sourceRecord.id,
        event_id: event.id,
        source_record_created: sourceRecord.created,
        event_created: event.created,
        job_created: jobCreated,
        current_state_created: currentStateCreated,
      };
    });
  }

  async persistImportedTreatment(args: {
    source: NightscoutSourceRow;
    treatment: NormalizedNightscoutTreatment;
    ingestionOrigin?: EventIngestionOrigin;
  }): Promise<ImportedTreatmentPersistenceResult> {
    return this.withTransaction(async (client) => {
      const duplicateOf = await this.findSameTreatmentEvent(client, args.source, args.treatment);
      const sourceRecord = await this.insertSourceRecordFromTreatment(client, args.source, args.treatment, duplicateOf);
      if (!sourceRecord) {
        await this.updateStreamCursor(client, args.source.id, 'treatments', args.treatment.occurred_at);
        return {
          source_record_id: null,
          event_id: null,
          source_record_created: false,
          event_created: false,
          skipped_reason: 'SOURCE_RECORD_OF_ANOTHER_PATIENT',
        };
      }
      if (sourceRecord.duplicate_of_event_id) {
        // Kept as a DUPLICATE source record (the next sync finds it by natural key), with no event.
        await this.updateStreamCursor(client, args.source.id, 'treatments', args.treatment.occurred_at);
        return {
          source_record_id: sourceRecord.id,
          event_id: sourceRecord.duplicate_of_event_id,
          source_record_created: sourceRecord.created,
          event_created: false,
          duplicate_of_event_id: sourceRecord.duplicate_of_event_id,
        };
      }
      const event = await this.insertTreatmentEvent(client, args.source, sourceRecord.id, args.treatment, args.ingestionOrigin ?? 'LIVE');
      // Treatments queue no jobs: loop actions group carb entries and boluses on their own timer (the worker).
      await this.updateStreamCursor(client, args.source.id, 'treatments', args.treatment.occurred_at);

      return {
        source_record_id: sourceRecord.id,
        event_id: event.id,
        source_record_created: sourceRecord.created,
        event_created: event.created,
      };
    });
  }

  async persistImportedDeviceStatus(args: {
    source: NightscoutSourceRow;
    status: NormalizedNightscoutDeviceStatusSnapshot;
    ingestionOrigin?: EventIngestionOrigin;
    correlationId: string;
    causationId: string;
  }): Promise<ImportedDeviceStatusPersistenceResult> {
    return this.withTransaction(async (client) => {
      const sourceRecord = await this.insertSourceRecordFromDeviceStatus(client, args.source, args.status);
      if (!sourceRecord) {
        await this.updateStreamCursor(client, args.source.id, 'devicestatus', args.status.observed_at);
        return {
          source_record_id: null,
          source_record_created: false,
          event_ids: [],
          current_state_updated: false,
          skipped_reason: 'SOURCE_RECORD_OF_ANOTHER_PATIENT',
        };
      }
      const eventIds: string[] = [];

      if (args.status.iob !== null) {
        const event = await this.insertDeviceStatusEvent(client, args.source, sourceRecord.id, 'IOB_SNAPSHOT', { iob: args.status.iob }, args.status.observed_at, args.status.recorded_at, args.ingestionOrigin ?? 'LIVE');
        eventIds.push(event.id);
      }

      if (args.status.cob !== null) {
        const event = await this.insertDeviceStatusEvent(client, args.source, sourceRecord.id, 'COB_SNAPSHOT', { cob: args.status.cob }, args.status.observed_at, args.status.recorded_at, args.ingestionOrigin ?? 'LIVE');
        eventIds.push(event.id);
      }

      const glucoseContext = await this.getLatestGlucoseContext(client, args.source.patient_id);
      // The loop's IOB and COB belong to the newest reading only when they were computed near it: a device status synced
      // late (days old) must not pass for the insulin working now.
      const statusMatchesReading = glucoseContext !== null
        && Math.abs(Date.parse(String(args.status.observed_at)) - Date.parse(String(glucoseContext.observed_at))) <= CURRENT_STATE_LOOP_MAX_GAP_MS;
      // A status far from the newest reading leaves the current state as it is (it would reset a newer IOB otherwise).
      const currentStateUpdated = glucoseContext !== null && !statusMatchesReading ? false : await this.upsertCurrentState(client, args.source.patient_id, glucoseContext?.event_id ?? null, glucoseContext ? {
        glucose_value: glucoseContext.glucose_value,
        glucose_unit: 'mg/dL',
        source_unit: 'mg/dL',
        source_system: 'NIGHTSCOUT',
        source_record_id: glucoseContext.source_record_id,
        natural_key: glucoseContext.natural_key,
        record_type: 'CGM_ENTRY',
        patient_id: args.source.patient_id,
        observed_at: glucoseContext.observed_at,
        recorded_at: glucoseContext.recorded_at,
        imported_at: glucoseContext.imported_at,
        normalization_version: 'nightscout.entries.v1',
        canonical_hash: glucoseContext.canonical_hash,
        provenance: glucoseContext.provenance,
        raw_payload: glucoseContext.raw_payload,
      } : undefined, {
        trend: glucoseContext ? mapNightscoutTrendDirection(glucoseContext.direction) : 'UNKNOWN',
        iob: args.status.iob,
        cob: args.status.cob,
      });

      await this.updateStreamCursor(client, args.source.id, 'devicestatus', args.status.observed_at);

      return {
        source_record_id: sourceRecord.id,
        source_record_created: sourceRecord.created,
        event_ids: eventIds,
        current_state_updated: currentStateUpdated,
      };
    });
  }

  async persistImportedTherapyProfile(args: {
    source: NightscoutSourceRow;
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
  }): Promise<ImportedTherapyProfilePersistenceResult | null> {
    const profile = args.profile;
    if (!profile || !profile.snapshot || Object.keys(profile.snapshot).length === 0) {
      return null;
    }

    const observedAt = toCanonicalTimestamp(profile.observed_at) || new Date().toISOString();
    const validFrom = profile.valid_from ? toCanonicalTimestamp(profile.valid_from) : null;
    const validTo = profile.valid_to ? toCanonicalTimestamp(profile.valid_to) : null;
    const therapyVersion = String(profile.therapy_version ?? profile.profile_key);
    const activeProfileId = String(profile.active_profile_id ?? profile.profile_key ?? 'UNKNOWN');

    return this.withTransaction(async (client) => {
      const rows = await client.query<{ id: string; created: boolean }>(
        `
          INSERT INTO therapies (patient_id, therapy_version, active_profile_id, snapshot, valid_from, valid_to, observed_at)
          VALUES ($1, $2, $3, $4::jsonb, $5::timestamptz, $6::timestamptz, $7::timestamptz)
          ON CONFLICT (patient_id, therapy_version)
          DO UPDATE SET
            active_profile_id = EXCLUDED.active_profile_id,
            snapshot = EXCLUDED.snapshot,
            valid_from = EXCLUDED.valid_from,
            valid_to = EXCLUDED.valid_to,
            observed_at = EXCLUDED.observed_at,
            updated_at = now()
          RETURNING id, (xmax = 0) AS created
        `,
        [args.source.patient_id, therapyVersion, activeProfileId, JSON.stringify(profile.snapshot), validFrom, validTo, observedAt],
      );

      const therapyId = rows.rows[0]?.id ? String(rows.rows[0].id) : null;
      const rowCreated = rows.rows[0]?.created === true;
      const currentStateResult = await client.query<{ id: string; snapshot: Record<string, unknown> }>(
        `
          SELECT id, snapshot
          FROM current_states
          WHERE patient_id = $1
          ORDER BY as_of DESC, updated_at DESC
          LIMIT 1
        `,
        [args.source.patient_id],
      );

      if (currentStateResult.rows[0]) {
        const currentSnapshot = currentStateResult.rows[0].snapshot && typeof currentStateResult.rows[0].snapshot === 'object' && !Array.isArray(currentStateResult.rows[0].snapshot)
          ? currentStateResult.rows[0].snapshot as Record<string, unknown>
          : {};

        await client.query(
          `
            UPDATE current_states
            SET snapshot = $2::jsonb,
                updated_at = now()
            WHERE id = $1
          `,
          [currentStateResult.rows[0].id, JSON.stringify({ ...currentSnapshot, active_therapy: { therapy_id: activeProfileId, therapy_version: therapyVersion } })],
        );
      }

      return {
        therapy_id: therapyId,
        patient_id: args.source.patient_id,
        therapy_version: therapyVersion,
        active_profile_id: activeProfileId,
        observed_at: observedAt,
        valid_from: validFrom,
        valid_to: validTo,
        created: rowCreated,
      };
    });
  }

  async getImportedReadingForEvent(eventId: string): Promise<Record<string, unknown> | null> {
    const result = await this.pool.query(
      `
        SELECT
          e.id AS event_id,
          e.patient_id,
          e.occurred_at,
          e.recorded_at,
          e.payload,
          e.context,
          e.source,
          e.event_ingestion_origin,
          sr.id AS source_record_id,
          sr.natural_key,
          sr.raw_payload,
          sr.provenance,
          sr.source_system,
          sr.source_record_id AS source_identity,
          sr.normalization_version,
          sr.canonical_hash
        FROM events e
        JOIN source_records sr ON sr.id = e.source_record_id
        WHERE e.id = $1
        LIMIT 1
      `,
      [eventId],
    );

    return result.rows[0] ?? null;
  }

  /**
   * Latest open episode of the same ingestion origin as the reading being processed. An episode's origin is the origin
   * of its trigger's source event, so HISTORICAL readings never continue or close a LIVE episode and an open
   * HISTORICAL episode never absorbs a LIVE hypo.
   */
  /**
   * When glucose came back to >= 70 mg/dL in an open episode (up to `untilIso`, same origin): the first reading at or
   * above 70 after its last reading below 70 (`since`), and that last low reading (`last_low_at`).
   */
  async getHypoRecoveryStart(patientId: string, origin: 'LIVE' | 'HISTORICAL', episodeStartedAtIso: string, untilIso: string): Promise<{ since: string | null; last_low_at: string | null }> {
    const result = await this.pool.query(
      `
        WITH readings AS (
          SELECT occurred_at, (payload->>'glucose_value')::numeric AS value
          FROM events
          WHERE patient_id = $1 AND type = 'GLUCOSE_READING_AVAILABLE' AND event_ingestion_origin = $2
            AND occurred_at >= $3::timestamptz AND occurred_at <= $4::timestamptz
        ),
        last_low AS (SELECT max(occurred_at) AS at FROM readings WHERE value < 70)
        SELECT (SELECT min(r.occurred_at) FROM readings r WHERE r.value >= 70 AND r.occurred_at > COALESCE(last_low.at, $3::timestamptz - interval '1 second')) AS since,
               last_low.at AS last_low_at
        FROM last_low
      `,
      [patientId, origin, episodeStartedAtIso, untilIso],
    );
    const row = result.rows[0];
    return {
      since: row?.since ? toCanonicalTimestamp(row.since) : null,
      last_low_at: row?.last_low_at ? toCanonicalTimestamp(row.last_low_at) : null,
    };
  }

  async getLatestOpenHypoEpisode(patientId: string, origin: 'LIVE' | 'HISTORICAL'): Promise<HypoEpisodeView | null> {
    const result = await this.pool.query(
      `
        SELECT
          e.id AS episode_id,
          e.patient_id,
          e.state,
          e.severity,
          e.started_at,
          e.ended_at,
          e.latest_event_id,
          t.id AS trigger_id,
          t.rule_version AS trigger_rule_version,
          t.source_event_id,
          t.created_at AS trigger_created_at
        FROM hypo_episodes e
        JOIN triggers t ON t.id = e.trigger_id
        JOIN events se ON se.id = t.source_event_id
        WHERE e.patient_id = $1
          AND e.state = 'OPEN'
          AND se.event_ingestion_origin = $2
        ORDER BY e.started_at DESC
        LIMIT 1
      `,
      [patientId, origin],
    );

    const row = result.rows[0];
    if (!row) {
      return null;
    }

    return {
      episode_id: row.episode_id,
      state: row.state,
      severity: row.severity,
      started_at: row.started_at,
      ended_at: row.ended_at,
      latest_reading_id: row.latest_event_id,
      trigger_id: row.trigger_id,
      trigger_rule_version: row.trigger_rule_version,
      source_event_id: row.source_event_id,
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
    detection: ReturnType<typeof detectHypo>;
    existingEpisode: HypoEpisodeView | null;
    /** Ingestion origin of the reading (events.event_ingestion_origin); required, never defaulted. */
    origin: 'LIVE' | 'HISTORICAL';
    /** When a closing episode really ended (its first reading back at >= 70); defaults to the closing reading. */
    endedAt?: string | null;
  }): Promise<{ trigger_created: boolean; episode_created: boolean }> {
    if (args.origin !== 'LIVE' && args.origin !== 'HISTORICAL') {
      throw new Error('UNKNOWN_EVENT_INGESTION_ORIGIN');
    }
    return this.withTransaction(async (client) => {
      if (args.detection.status === 'INSUFFICIENT_DATA') {
        throw new Error('INSUFFICIENT_DATA_FOR_HYPO_PROCESSING');
      }

      if (args.detection.status === 'NO_HYPO') {
        if (args.existingEpisode && args.existingEpisode.state === 'OPEN') {
          await client.query(
            `
              UPDATE hypo_episodes
              SET state = 'CLOSED',
                  severity = $2,
                  ended_at = $3::timestamptz,
                  latest_event_id = $4,
                  updated_at = now()
              WHERE id = $1
            `,
            [args.existingEpisode.episode_id, args.existingEpisode.severity, args.endedAt ?? args.reading.observed_at, args.reading.reading_id],
          );
        }

        return { trigger_created: false, episode_created: false };
      }

      if (args.detection.status === 'HYPO_ONGOING' && args.existingEpisode) {
        await this.updateOpenHypoEpisode(client, {
          episodeId: args.existingEpisode.episode_id,
          severity: args.detection.severity ?? args.existingEpisode.severity,
          latestEventId: args.reading.reading_id,
        });

        return { trigger_created: false, episode_created: false };
      }

      const episodeId = randomUUID();
      const triggerId = randomUUID();

      const episode = await this.insertOpenHypoEpisode(client, {
        episodeId,
        triggerId,
        patientId: args.patientId,
        sourceEventId: args.reading.reading_id,
        severity: args.detection.severity ?? 'L1',
        startedAt: args.reading.observed_at,
        latestEventId: args.reading.reading_id,
      });

      const trigger = await this.insertTrigger(client, {
        triggerId,
        episodeId: episode.id,
        patientId: args.patientId,
        sourceEventId: args.reading.reading_id,
        ruleVersion: 'hypo.cgm.ada2026.v1',
        status: 'OPEN',
      });

      // An episode only stores the episode and its trigger: nobody is asked about it, nothing is pushed.
      return { trigger_created: trigger.created, episode_created: episode.created };
    });
  }

  /** Null when the record already belongs to another patient (see findConflictingSourceRecord): skip it. */
  private async insertSourceRecord(client: PoolClient, source: NightscoutSourceRow, reading: NormalizedGlucoseReading): Promise<{ id: string; created: boolean } | null> {
    const result = await client.query(
      `
        INSERT INTO source_records (
          patient_id, source_id, source_system, source_record_id, natural_key, record_type, occurred_at, recorded_at, imported_at,
          payload_version, normalization_version, validity, raw_payload, provenance, canonical_hash
        ) VALUES ($1,$2,$3,$4,$5,$6,$7::timestamptz,$8::timestamptz,$9::timestamptz,$10,$11,$12,$13::jsonb,$14::jsonb,$15)
        ON CONFLICT DO NOTHING
        RETURNING id
      `,
      [
        source.patient_id,
        source.id,
        reading.source_system,
        reading.source_record_id,
        reading.natural_key,
        reading.record_type,
        reading.observed_at,
        reading.recorded_at,
        reading.imported_at,
        1,
        reading.normalization_version,
        'VALID',
        JSON.stringify(reading.raw_payload),
        JSON.stringify(reading.provenance),
        reading.canonical_hash,
      ],
    );

    if (result.rows[0]) {
      return { id: String(result.rows[0].id), created: true };
    }

    const existing = await this.findConflictingSourceRecord(client, source, reading);
    return existing ? { id: existing.id, created: false } : null;
  }

  /**
   * The row an `INSERT INTO source_records ... ON CONFLICT DO NOTHING` collided with. Any of the table's unique keys
   * can be hit: (source_id, natural_key), (source_system, canonical_hash) and the global (source_system,
   * source_record_id) — a Nightscout `_id` is unique across all sources and patients. A row of the same patient
   * (this source first, then another one) is the already imported record. A row of another patient is not: null,
   * logged, and the caller skips the record as deduplicated.
   */
  private async findConflictingSourceRecord(
    client: PoolClient,
    source: NightscoutSourceRow,
    record: { source_system: string; source_record_id: string | null; natural_key: string; canonical_hash: string },
  ): Promise<{ id: string; validity: string; duplicate_of_event_id: string | null } | null> {
    const existing = await client.query<{ id: string; patient_id: string; source_id: string; validity: string; duplicate_of_event_id: string | null }>(
      `
        SELECT id, patient_id, source_id, validity, provenance->>'duplicate_of_event_id' AS duplicate_of_event_id
        FROM source_records
        WHERE (source_id = $1 AND natural_key = $2)
           OR (source_system = $3 AND canonical_hash = $4)
           OR ($5::text IS NOT NULL AND source_system = $3 AND source_record_id = $5)
        ORDER BY (source_id = $1) DESC, (patient_id = $6) DESC
        LIMIT 1
      `,
      [source.id, record.natural_key, record.source_system, record.canonical_hash, record.source_record_id, source.patient_id],
    );

    const row = existing.rows[0];
    if (!row) {
      // ON CONFLICT DO NOTHING found a conflicting row that none of the unique keys can see: a schema change.
      throw new Error('SOURCE_RECORD_CONFLICT_NOT_FOUND');
    }

    if (String(row.patient_id) !== source.patient_id) {
      this.logger.warn(JSON.stringify({
        event: 'source_record_owned_by_another_patient',
        source_id: source.id,
        patient_id: source.patient_id,
        conflicting_source_id: String(row.source_id),
        source_system: record.source_system,
        source_record_id: record.source_record_id,
        natural_key: record.natural_key,
      }));
      return null;
    }

    return {
      id: String(row.id),
      validity: String(row.validity),
      duplicate_of_event_id: row.duplicate_of_event_id == null ? null : String(row.duplicate_of_event_id),
    };
  }

  private async insertGlucoseEvent(
    client: PoolClient,
    source: NightscoutSourceRow,
    sourceRecordId: string,
    reading: NormalizedGlucoseReading,
    ingestionOrigin: EventIngestionOrigin,
  ): Promise<{ id: string; created: boolean }> {
    const result = await client.query(
      `
        INSERT INTO events (
          patient_id, source_record_id, type, occurred_at, recorded_at, source, context, payload, event_version, event_ingestion_origin
        ) VALUES ($1,$2,$3,$4::timestamptz,$5::timestamptz,$6::jsonb,$7::jsonb,$8::jsonb,$9,$10)
        ON CONFLICT (patient_id, source_record_id, type)
        DO NOTHING
        RETURNING id
      `,
      [
        source.patient_id,
        sourceRecordId,
        'GLUCOSE_READING_AVAILABLE',
        reading.observed_at,
        reading.recorded_at,
        JSON.stringify({ source_system: reading.source_system, source_record_id: reading.source_record_id, normalization_version: reading.normalization_version }),
        JSON.stringify({ source_id: source.id, source_key: source.source_key, provenance: reading.provenance }),
        JSON.stringify({
          glucose_value: reading.glucose_value,
          glucose_unit: reading.glucose_unit,
          source_unit: reading.source_unit,
          normalization_version: reading.normalization_version,
          canonical_hash: reading.canonical_hash,
          raw_payload: reading.raw_payload,
        }),
        1,
        ingestionOrigin,
      ],
    );

    if (result.rows[0]) {
      return { id: String(result.rows[0].id), created: true };
    }

    const existing = await client.query(
      `SELECT id FROM events WHERE patient_id = $1 AND source_record_id = $2 AND type = 'GLUCOSE_READING_AVAILABLE' LIMIT 1`,
      [source.patient_id, sourceRecordId],
    );

    return { id: String(existing.rows[0].id), created: false };
  }

  private async insertSourceRecordFromDeviceStatus(
    client: PoolClient,
    source: NightscoutSourceRow,
    status: NormalizedNightscoutDeviceStatusSnapshot,
  ): Promise<{ id: string; created: boolean } | null> {
    const result = await client.query(
      `
        INSERT INTO source_records (
          patient_id, source_id, source_system, source_record_id, natural_key, record_type, occurred_at, recorded_at, imported_at,
          payload_version, normalization_version, validity, raw_payload, provenance, canonical_hash
        ) VALUES ($1,$2,$3,$4,$5,$6,$7::timestamptz,$8::timestamptz,$9::timestamptz,$10,$11,$12,$13::jsonb,$14::jsonb,$15)
        ON CONFLICT DO NOTHING
        RETURNING id
      `,
      [
        source.patient_id,
        source.id,
        status.source_system,
        status.source_record_id,
        status.natural_key,
        status.record_type,
        status.observed_at,
        status.recorded_at,
        status.imported_at,
        1,
        status.normalization_version,
        'VALID',
        JSON.stringify(status.raw_payload),
        JSON.stringify(status.provenance),
        status.canonical_hash,
      ],
    );

    if (result.rows[0]) {
      return { id: String(result.rows[0].id), created: true };
    }

    const existing = await this.findConflictingSourceRecord(client, source, status);
    return existing ? { id: existing.id, created: false } : null;
  }

  private async insertDeviceStatusEvent(
    client: PoolClient,
    source: NightscoutSourceRow,
    sourceRecordId: string,
    type: 'IOB_SNAPSHOT' | 'COB_SNAPSHOT',
    payload: Record<string, number>,
    occurredAt: string,
    recordedAt: string,
    ingestionOrigin: EventIngestionOrigin,
  ): Promise<{ id: string; created: boolean }> {
    const result = await client.query(
      `
        INSERT INTO events (
          patient_id, source_record_id, type, occurred_at, recorded_at, source, context, payload, event_version, event_ingestion_origin
        ) VALUES ($1,$2,$3,$4::timestamptz,$5::timestamptz,$6::jsonb,$7::jsonb,$8::jsonb,$9,$10)
        ON CONFLICT (patient_id, source_record_id, type)
        DO NOTHING
        RETURNING id
      `,
      [
        source.patient_id,
        sourceRecordId,
        type,
        occurredAt,
        recordedAt,
        JSON.stringify({ source_system: 'NIGHTSCOUT', source_record_id: sourceRecordId }),
        JSON.stringify({ source_id: source.id, source_key: source.source_key }),
        JSON.stringify(payload),
        1,
        ingestionOrigin,
      ],
    );

    if (result.rows[0]) {
      return { id: String(result.rows[0].id), created: true };
    }

    const existing = await client.query(
      `SELECT id FROM events WHERE patient_id = $1 AND source_record_id = $2 AND type = $3 LIMIT 1`,
      [source.patient_id, sourceRecordId, type],
    );

    return { id: String(existing.rows[0].id), created: false };
  }

  private async getLatestGlucoseContext(client: PoolClient, patientId: string): Promise<null | {
    event_id: string;
    observed_at: string;
    recorded_at: string;
    imported_at: string;
    glucose_value: number;
    source_record_id: string | null;
    natural_key: string;
    canonical_hash: string;
    provenance: Record<string, unknown>;
    raw_payload: Record<string, unknown>;
    direction: string | null;
  }> {
    const result = await client.query(
      `
        SELECT e.id AS event_id,
               e.occurred_at AS observed_at,
               e.recorded_at AS recorded_at,
               sr.imported_at,
               (e.payload->>'glucose_value')::numeric AS glucose_value,
               sr.id AS source_record_id,
               sr.natural_key,
               sr.canonical_hash,
               sr.provenance,
               sr.raw_payload
        FROM events e
        INNER JOIN source_records sr ON sr.id = e.source_record_id
        WHERE e.patient_id = $1 AND e.type = 'GLUCOSE_READING_AVAILABLE'
        ORDER BY e.occurred_at DESC, e.id DESC
        LIMIT 1
      `,
      [patientId],
    );

    if (!result.rows[0]) {
      return null;
    }

    const row = result.rows[0];
    const direction = row.provenance && typeof row.provenance === 'object'
      ? (row.provenance as Record<string, unknown>).source_fields && typeof (row.provenance as Record<string, unknown>).source_fields === 'object'
        ? String(((row.provenance as Record<string, unknown>).source_fields as Record<string, unknown>).direction ?? '')
        : ''
      : '';

    return {
      event_id: String(row.event_id),
      observed_at: toCanonicalTimestamp(row.observed_at),
      recorded_at: toCanonicalTimestamp(row.recorded_at),
      imported_at: toCanonicalTimestamp(row.imported_at),
      glucose_value: Number(row.glucose_value),
      source_record_id: row.source_record_id ? String(row.source_record_id) : null,
      natural_key: String(row.natural_key),
      canonical_hash: String(row.canonical_hash),
      provenance: row.provenance ?? {},
      raw_payload: row.raw_payload ?? {},
      direction: direction || null,
    };
  }

  private async upsertCurrentState(
    client: PoolClient,
    patientId: string,
    eventId: string | null,
    reading: Partial<NormalizedGlucoseReading> | undefined,
    options: { trend?: 'UP' | 'DOWN' | 'FLAT' | 'DOUBLE_UP' | 'DOUBLE_DOWN' | 'UNKNOWN'; iob?: number | null; cob?: number | null } = {},
  ): Promise<boolean> {
    const baseEvent = eventId ? await this.getCurrentStateEvent(client, eventId) : await this.getLatestCurrentStateEvent(client, patientId);
    const glucose = reading ?? (baseEvent ? {
      glucose_value: Number(baseEvent.glucose_value),
      glucose_unit: 'mg/dL',
      source_unit: 'mg/dL',
      source_system: 'NIGHTSCOUT',
      source_record_id: baseEvent.source_record_id,
      natural_key: baseEvent.natural_key,
      record_type: 'CGM_ENTRY',
      patient_id: patientId,
      observed_at: toCanonicalTimestamp(baseEvent.observed_at),
      recorded_at: toCanonicalTimestamp(baseEvent.recorded_at),
      imported_at: toCanonicalTimestamp(baseEvent.imported_at),
      normalization_version: 'nightscout.entries.v1',
      canonical_hash: String(baseEvent.canonical_hash),
      provenance: baseEvent.provenance,
      raw_payload: baseEvent.raw_payload,
    } : null);

    if (!glucose || !glucose.observed_at) {
      return false;
    }

    const trend = options.trend ?? mapNightscoutTrendDirection((glucose.provenance as Record<string, unknown> | undefined)?.source_fields && typeof (glucose.provenance as Record<string, unknown>).source_fields === 'object'
      ? String(((glucose.provenance as Record<string, unknown>).source_fields as Record<string, unknown>).direction ?? '')
      : 'UNKNOWN');

    const snapshot = {
      patient_id: patientId,
      state_version: `nightscout:${eventId ?? baseEvent?.event_id ?? 'latest'}`,
      as_of: glucose.observed_at,
      glucose: {
        value: Number(glucose.glucose_value),
        unit: 'mg/dL' as const,
        trend,
        rate_of_change: 'UNKNOWN' as const,
      },
      iob: {
        value: options.iob === undefined || options.iob === null ? 'UNKNOWN' : options.iob,
        unit: 'U' as const,
      },
      cob: {
        value: options.cob === undefined || options.cob === null ? 'UNKNOWN' : options.cob,
        unit: 'g' as const,
      },
      recent_insulin: [],
      recent_meal: null,
      recent_activity: null,
      recent_sleep: null,
      recent_illness: null,
      active_therapy: {
        therapy_id: 'UNKNOWN',
        therapy_version: 'UNKNOWN',
      },
    };

    const result = await client.query(
      `
        INSERT INTO current_states (patient_id, state_version, as_of, snapshot)
        VALUES ($1,$2,$3::timestamptz,$4::jsonb)
        ON CONFLICT (patient_id, state_version)
        DO UPDATE SET
          as_of = EXCLUDED.as_of,
          snapshot = EXCLUDED.snapshot,
          updated_at = now()
        RETURNING id
      `,
      [patientId, snapshot.state_version, snapshot.as_of, JSON.stringify(snapshot)],
    );

    return Boolean(result.rows[0]);
  }

  private async getCurrentStateEvent(client: PoolClient, eventId: string): Promise<null | {
    event_id: string;
    observed_at: string;
    recorded_at: string;
    imported_at: string;
    glucose_value: number;
    source_record_id: string | null;
    natural_key: string;
    canonical_hash: string;
    provenance: Record<string, unknown>;
    raw_payload: Record<string, unknown>;
  }> {
    const result = await client.query(
      `
        SELECT e.id AS event_id,
               e.occurred_at AS observed_at,
               e.recorded_at AS recorded_at,
               sr.imported_at,
               (e.payload->>'glucose_value')::numeric AS glucose_value,
               sr.id AS source_record_id,
               sr.natural_key,
               sr.canonical_hash,
               sr.provenance,
               sr.raw_payload
        FROM events e
        INNER JOIN source_records sr ON sr.id = e.source_record_id
        WHERE e.id = $1 AND e.type = 'GLUCOSE_READING_AVAILABLE'
        LIMIT 1
      `,
      [eventId],
    );

    if (!result.rows[0]) {
      return null;
    }

    return {
      event_id: String(result.rows[0].event_id),
      observed_at: toCanonicalTimestamp(result.rows[0].observed_at),
      recorded_at: toCanonicalTimestamp(result.rows[0].recorded_at),
      imported_at: toCanonicalTimestamp(result.rows[0].imported_at),
      glucose_value: Number(result.rows[0].glucose_value),
      source_record_id: result.rows[0].source_record_id ? String(result.rows[0].source_record_id) : null,
      natural_key: String(result.rows[0].natural_key),
      canonical_hash: String(result.rows[0].canonical_hash),
      provenance: result.rows[0].provenance ?? {},
      raw_payload: result.rows[0].raw_payload ?? {},
    };
  }

  private async getLatestCurrentStateEvent(client: PoolClient, patientId: string): Promise<null | {
    event_id: string;
    observed_at: string;
    recorded_at: string;
    imported_at: string;
    glucose_value: number;
    source_record_id: string | null;
    natural_key: string;
    canonical_hash: string;
    provenance: Record<string, unknown>;
    raw_payload: Record<string, unknown>;
  }> {
    const result = await client.query(
      `
        SELECT e.id AS event_id,
               e.occurred_at AS observed_at,
               e.recorded_at AS recorded_at,
               sr.imported_at,
               (e.payload->>'glucose_value')::numeric AS glucose_value,
               sr.id AS source_record_id,
               sr.natural_key,
               sr.canonical_hash,
               sr.provenance,
               sr.raw_payload
        FROM events e
        INNER JOIN source_records sr ON sr.id = e.source_record_id
        WHERE e.patient_id = $1 AND e.type = 'GLUCOSE_READING_AVAILABLE'
        ORDER BY e.occurred_at DESC, e.id DESC
        LIMIT 1
      `,
      [patientId],
    );

    if (!result.rows[0]) {
      return null;
    }

    return {
      event_id: String(result.rows[0].event_id),
      observed_at: toCanonicalTimestamp(result.rows[0].observed_at),
      recorded_at: toCanonicalTimestamp(result.rows[0].recorded_at),
      imported_at: toCanonicalTimestamp(result.rows[0].imported_at),
      glucose_value: Number(result.rows[0].glucose_value),
      source_record_id: result.rows[0].source_record_id ? String(result.rows[0].source_record_id) : null,
      natural_key: String(result.rows[0].natural_key),
      canonical_hash: String(result.rows[0].canonical_hash),
      provenance: result.rows[0].provenance ?? {},
      raw_payload: result.rows[0].raw_payload ?? {},
    };
  }

  /**
   * Of the fetched records, the natural keys already imported from this source (by natural key, or by canonical hash
   * under another key). The sync's look-back window re-reads hours of records each run and imports only the rest.
   */
  async listImportedNaturalKeys(sourceId: string, records: Array<{ natural_key: string; canonical_hash: string }>): Promise<Set<string>> {
    if (records.length === 0) {
      return new Set();
    }
    const result = await this.pool.query<{ natural_key: string }>(
      `
        SELECT k.natural_key
        FROM unnest($2::text[], $3::text[]) AS k(natural_key, canonical_hash)
        WHERE EXISTS (SELECT 1 FROM source_records sr WHERE sr.source_id = $1 AND sr.natural_key = k.natural_key)
           OR EXISTS (SELECT 1 FROM source_records sr WHERE sr.source_system = 'NIGHTSCOUT' AND sr.canonical_hash = k.canonical_hash)
      `,
      [sourceId, records.map((record) => record.natural_key), records.map((record) => record.canonical_hash)],
    );
    return new Set(result.rows.map((row) => row.natural_key));
  }

  // Cursors only move forward: a late upload or a window backfill imports older records, and must not rewind the live
  // sync to them (the next sync would re-read everything since).
  private async updateSyncState(client: PoolClient, sourceId: string, observedAt: string): Promise<void> {
    await client.query(
      `
        UPDATE sources
        SET sync_cursor = CASE
              WHEN sync_cursor IS NULL OR sync_cursor::timestamptz < $3::timestamptz THEN $2::text
              ELSE sync_cursor
            END,
            last_successful_observed_at = GREATEST(COALESCE(last_successful_observed_at, $3::timestamptz), $3::timestamptz),
            updated_at = now()
        WHERE id = $1
      `,
      [sourceId, observedAt, observedAt],
    );

    await this.updateStreamCursor(client, sourceId, 'entries', observedAt);
  }

  private async updateStreamCursor(
    client: PoolClient,
    sourceId: string,
    stream: 'entries' | 'treatments' | 'devicestatus',
    cursorIso: string,
  ): Promise<void> {
    await client.query(
      `
        UPDATE sources
        SET metadata = jsonb_set(
              COALESCE(metadata, '{}'::jsonb),
              '{stream_cursors}',
              COALESCE(metadata->'stream_cursors', '{}'::jsonb) || jsonb_build_object($2::text, $3::text),
              true
            ),
            updated_at = now()
        WHERE id = $1
          AND (
            metadata->'stream_cursors'->>$2::text IS NULL
            OR (metadata->'stream_cursors'->>$2::text)::timestamptz < $4::timestamptz
          )
      `,
      [sourceId, stream, cursorIso, cursorIso],
    );
  }

  /**
   * Trio sometimes uploads one treatment twice: two Nightscout ids (seconds or an hour apart, with the same or a new Trio
   * id) for the same event time to the millisecond, the same dose, carbs or rate and the same enteredBy. Returns the
   * event already imported for it from this source under another Nightscout id, or null. Entries that differ by even
   * 1 ms stay separate (a caregiver can enter the same carbs twice). The advisory lock makes concurrent imports of the
   * two copies see each other.
   */
  private async findSameTreatmentEvent(
    client: PoolClient,
    source: NightscoutSourceRow,
    treatment: NormalizedNightscoutTreatment,
  ): Promise<string | null> {
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
      `nightscout-treatment:${source.patient_id}:${treatment.event_type}:${treatment.occurred_at}`,
    ]);
    const result = await client.query<{ id: string }>(
      `
        SELECT e.id::text
        FROM events e
        JOIN source_records sr ON sr.id = e.source_record_id
        WHERE e.patient_id = $1::uuid
          AND e.event_ingestion_origin = ANY(ARRAY['LIVE', 'HISTORICAL'])
          AND e.occurred_at = $2::timestamptz
          AND e.type = $3
          AND e.payload @> $4::jsonb
          AND e.payload->'raw_payload'->>'enteredBy' IS NOT DISTINCT FROM $5
          AND sr.source_id = $6
          AND sr.natural_key <> $7
        ORDER BY e.created_at, e.id
        LIMIT 1
      `,
      [
        source.patient_id,
        treatment.occurred_at,
        treatment.event_type,
        JSON.stringify(treatment.payload),
        treatment.raw_payload.enteredBy == null ? null : String(treatment.raw_payload.enteredBy),
        source.id,
        treatment.natural_key,
      ],
    );
    return result.rows[0]?.id ?? null;
  }

  private async insertSourceRecordFromTreatment(
    client: PoolClient,
    source: NightscoutSourceRow,
    treatment: NormalizedNightscoutTreatment,
    duplicateOfEventId: string | null,
  ): Promise<{ id: string; created: boolean; duplicate_of_event_id: string | null } | null> {
    const result = await client.query(
      `
        INSERT INTO source_records (
          patient_id, source_id, source_system, source_record_id, natural_key, record_type, occurred_at, recorded_at, imported_at,
          payload_version, normalization_version, validity, raw_payload, provenance, canonical_hash
        ) VALUES ($1,$2,$3,$4,$5,$6,$7::timestamptz,$8::timestamptz,$9::timestamptz,$10,$11,$12,$13::jsonb,$14::jsonb,$15)
        ON CONFLICT DO NOTHING
        RETURNING id
      `,
      [
        source.patient_id,
        source.id,
        treatment.source_system,
        treatment.source_record_id,
        treatment.natural_key,
        treatment.record_type,
        treatment.occurred_at,
        treatment.recorded_at,
        treatment.imported_at,
        1,
        treatment.normalization_version,
        duplicateOfEventId ? 'DUPLICATE' : 'VALID',
        JSON.stringify(treatment.raw_payload),
        JSON.stringify(duplicateOfEventId ? { ...treatment.provenance, duplicate_of_event_id: duplicateOfEventId } : treatment.provenance),
        treatment.canonical_hash,
      ],
    );

    if (result.rows[0]) {
      return { id: String(result.rows[0].id), created: true, duplicate_of_event_id: duplicateOfEventId };
    }

    // Already imported: a record stored as DUPLICATE stays one (and gets no event); any other keeps its own event.
    const row = await this.findConflictingSourceRecord(client, source, treatment);
    if (!row) {
      return null;
    }
    return {
      id: row.id,
      created: false,
      duplicate_of_event_id: row.validity === 'DUPLICATE' && row.duplicate_of_event_id ? String(row.duplicate_of_event_id) : null,
    };
  }

  private async insertTreatmentEvent(
    client: PoolClient,
    source: NightscoutSourceRow,
    sourceRecordId: string,
    treatment: NormalizedNightscoutTreatment,
    ingestionOrigin: EventIngestionOrigin,
  ): Promise<{ id: string; created: boolean }> {
    const result = await client.query(
      `
        INSERT INTO events (
          patient_id, source_record_id, type, occurred_at, recorded_at, source, context, payload, event_version, event_ingestion_origin
        ) VALUES ($1,$2,$3,$4::timestamptz,$5::timestamptz,$6::jsonb,$7::jsonb,$8::jsonb,$9,$10)
        ON CONFLICT (patient_id, source_record_id, type)
        DO NOTHING
        RETURNING id
      `,
      [
        source.patient_id,
        sourceRecordId,
        treatment.event_type,
        treatment.occurred_at,
        treatment.recorded_at,
        JSON.stringify({ source_system: treatment.source_system, source_record_id: treatment.source_record_id, normalization_version: treatment.normalization_version }),
        JSON.stringify({ source_id: source.id, source_key: source.source_key, provenance: treatment.provenance }),
        JSON.stringify({
          ...treatment.payload,
          normalization_version: treatment.normalization_version,
          canonical_hash: treatment.canonical_hash,
          raw_payload: treatment.raw_payload,
        }),
        1,
        ingestionOrigin,
      ],
    );

    if (result.rows[0]) {
      return { id: String(result.rows[0].id), created: true };
    }

    const existing = await client.query(
      `SELECT id FROM events WHERE patient_id = $1 AND source_record_id = $2 AND type = $3 LIMIT 1`,
      [source.patient_id, sourceRecordId, treatment.event_type],
    );

    return { id: String(existing.rows[0].id), created: false };
  }

  private async enqueueHypoDetectionJob(client: PoolClient, args: {
    jobType: string;
    payloadVersion: number;
    payload: Record<string, unknown>;
    dedupeKey: string;
    correlationId: string;
    causationId: string;
    patientId: string;
    availableAt: string;
    maxAttempts: number;
  }): Promise<boolean> {
    const result = await client.query(
      `
        INSERT INTO jobs (
          job_type, status, payload_version, payload, dedupe_key, correlation_id, causation_id, patient_id, available_at, max_attempts
        ) VALUES ($1,'queued',$2,$3::jsonb,$4,$5,$6,$7,$8::timestamptz,$9)
        ON CONFLICT (job_type, dedupe_key)
        DO NOTHING
        RETURNING id
      `,
      [
        args.jobType,
        args.payloadVersion,
        JSON.stringify(args.payload),
        args.dedupeKey,
        args.correlationId,
        args.causationId,
        args.patientId,
        args.availableAt,
        args.maxAttempts,
      ],
    );

    return Boolean(result.rows[0]);
  }

  private async insertTrigger(client: PoolClient, args: { triggerId: string; episodeId: string; patientId: string; sourceEventId: string; ruleVersion: string; status: string }): Promise<{ id: string; type: string; created: boolean }> {
    const triggerType = 'HYPO_DETECTED';
    const result = await client.query(
      `
        INSERT INTO triggers (id, patient_id, type, source_event_id, episode_id, rule_version, status, cooldown_seconds)
        VALUES ($1,$2,$3,$4,$5,$6,$7,0)
        ON CONFLICT (patient_id, type, source_event_id, rule_version)
        DO NOTHING
        RETURNING id
      `,
      [args.triggerId, args.patientId, triggerType, args.sourceEventId, args.episodeId, args.ruleVersion, args.status],
    );

    if (result.rows[0]) {
      return { id: String(result.rows[0].id), type: triggerType, created: true };
    }

    const existing = await client.query(
      `SELECT id FROM triggers WHERE patient_id = $1 AND type = $2 AND source_event_id = $3 AND rule_version = $4 LIMIT 1`,
      [args.patientId, triggerType, args.sourceEventId, args.ruleVersion],
    );

    return { id: String(existing.rows[0].id), type: triggerType, created: false };
  }

  private async insertOpenHypoEpisode(client: PoolClient, args: { episodeId: string; triggerId: string; patientId: string; sourceEventId: string; severity: 'L1' | 'L2'; startedAt: string; latestEventId: string }): Promise<{ id: string; created: boolean }> {
    const result = await client.query(
      `
        INSERT INTO hypo_episodes (
          id, patient_id, trigger_id, start_event_id, state, severity, started_at, latest_event_id, rule_version
        ) VALUES ($1,$2,$3,$4,'OPEN',$5,$6::timestamptz,$7,'hypo.cgm.ada2026.v1')
        ON CONFLICT (patient_id, start_event_id)
        DO NOTHING
        RETURNING id
      `,
      [args.episodeId, args.patientId, args.triggerId, args.sourceEventId, args.severity, args.startedAt, args.latestEventId],
    );

    if (result.rows[0]) {
      return { id: String(result.rows[0].id), created: true };
    }

    const existing = await client.query(`SELECT id FROM hypo_episodes WHERE patient_id = $1 AND start_event_id = $2 LIMIT 1`, [args.patientId, args.sourceEventId]);
    return { id: String(existing.rows[0].id), created: false };
  }

  private async updateOpenHypoEpisode(client: PoolClient, args: { episodeId: string; severity: 'L1' | 'L2'; latestEventId: string }): Promise<void> {
    await client.query(
      `
        UPDATE hypo_episodes
        SET severity = $2,
            latest_event_id = $3,
            updated_at = now()
        WHERE id = $1
      `,
      [args.episodeId, args.severity, args.latestEventId],
    );
  }
}
