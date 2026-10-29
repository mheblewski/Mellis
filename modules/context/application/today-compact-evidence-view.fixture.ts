import { createHash } from 'crypto';
import type { TimeRangeAnalysisContextRecord } from '@modules/ai-gateway/domain/ai-gateway';

/**
 * Provenance: SYNTHETIC. No patient data.
 * - Section counts default to the live TODAY audit documented in
 *   the evidence_layer_context_budget_v1 design note §2
 *   (190 glucose, 549 insulin/treatment, 11 meals, 0 activity, 0 hypo, 11 range facts).
 * - Event and payload key layout mirrors the worker's TODAY projection
 *   (apps/worker/src/worker.service.ts) and the key structure of a captured
 *   conversation-time-range-context.v1 request. All values are generated deterministically.
 */
export const SYNTHETIC_TODAY_FIXTURE_PROVENANCE = 'SYNTHETIC:live-today-audit-counts+capture-key-layout' as const;

export interface SyntheticTodayContextOptions {
  patientId?: string;
  glucoseCount?: number;
  insulinCounts?: Partial<Record<'BOLUS' | 'SMB' | 'TEMP_BASAL' | 'IOB_SNAPSHOT' | 'COB_SNAPSHOT', number>>;
  mealCount?: number;
  hypoEpisodeCount?: number;
  rangeFactCount?: number;
  withCurrentState?: boolean;
  historicalEvidence?: TimeRangeAnalysisContextRecord['historical_evidence'];
}

export const LIVE_AUDIT_INSULIN_COUNTS = {
  BOLUS: 9,
  SMB: 7,
  TEMP_BASAL: 101,
  IOB_SNAPSHOT: 216,
  COB_SNAPSHOT: 216,
} as const;

const RANGE_START = '2026-10-06T22:00:00.000Z';
const RANGE_END = '2026-10-07T21:59:59.999Z';
const REQUESTED_AT = '2026-10-07T20:00:00.000Z';

function syntheticId(patientTag: string, kind: string, index: number): string {
  const digest = createHash('sha256').update(`${patientTag}:${kind}:${index}`).digest('hex');
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

function hashOf(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function minutesAfterStart(minutes: number): string {
  return new Date(Date.parse(RANGE_START) + minutes * 60_000).toISOString();
}

export function createSyntheticTodayContext(options: SyntheticTodayContextOptions = {}): TimeRangeAnalysisContextRecord {
  const patientId = options.patientId ?? 'synthetic-patient-a';
  const glucoseCount = options.glucoseCount ?? 190;
  const insulinCounts = { ...LIVE_AUDIT_INSULIN_COUNTS, ...(options.insulinCounts ?? {}) };
  const mealCount = options.mealCount ?? 11;
  const hypoEpisodeCount = options.hypoEpisodeCount ?? 0;
  const rangeFactCount = options.rangeFactCount ?? 11;

  const glucoseEvents = Array.from({ length: glucoseCount }, (_, index) => {
    const occurredAt = minutesAfterStart(index * 5);
    const sgv = 110 + ((index * 37) % 120) - ((index * 11) % 45);
    const sourceId = syntheticId(patientId, 'ns-entry', index).replace(/-/g, '').slice(0, 24);
    return {
      event_id: syntheticId(patientId, 'glucose', index),
      type: 'GLUCOSE_READING',
      occurred_at: occurredAt,
      payload: {
        raw_payload: {
          id: sourceId,
          _id: sourceId,
          sgv,
          date: Date.parse(occurredAt),
          type: 'sgv',
          glucose: sgv,
          sysTime: occurredAt,
          filtered: sgv * 1000,
          direction: 'Flat',
          utcOffset: 120,
          dateString: occurredAt,
          unfiltered: sgv * 1000,
        },
        source_unit: 'mg/dL',
        glucose_unit: 'mg/dL',
        glucose_value: sgv,
        canonical_hash: hashOf(`${patientId}:glucose:${index}`),
        normalization_version: 'nightscout-entry-normalization.v1',
      },
      source_record_id: `nightscout:entries:${sourceId}`,
    };
  });

  const insulinEvents: Array<Record<string, unknown>> = [];
  let insulinIndex = 0;
  for (const [eventType, count] of Object.entries(insulinCounts)) {
    for (let index = 0; index < count; index += 1) {
      const occurredAt = minutesAfterStart((index * 7 + insulinIndex) % (24 * 60));
      const sourceId = syntheticId(patientId, `ns-treatment-${eventType}`, index).replace(/-/g, '').slice(0, 24);
      const base = {
        event_id: syntheticId(patientId, `insulin-${eventType}`, index),
        type: eventType,
        occurred_at: occurredAt,
        source_record_id: `nightscout:treatments:${sourceId}`,
      };
      insulinIndex += 1;

      if (eventType === 'IOB_SNAPSHOT') {
        insulinEvents.push({ ...base, payload: { iob: Number(((index % 40) / 10).toFixed(2)) } });
        continue;
      }
      if (eventType === 'COB_SNAPSHOT') {
        insulinEvents.push({ ...base, payload: { cob: index % 60 } });
        continue;
      }

      const rawPayload = {
        id: sourceId,
        _id: sourceId,
        carbs: null,
        insulin: eventType === 'TEMP_BASAL' ? null : Number((0.1 + (index % 30) / 10).toFixed(2)),
        enteredBy: 'synthetic-loop',
        eventType: eventType === 'TEMP_BASAL' ? 'Temp Basal' : eventType === 'SMB' ? 'SMB' : 'Correction Bolus',
        utcOffset: 120,
        created_at: occurredAt,
        ...(eventType === 'TEMP_BASAL' ? { rate: 0.85, absolute: 0.85, duration: 30 } : {}),
      };
      insulinEvents.push({
        ...base,
        payload: eventType === 'TEMP_BASAL'
          ? {
              rate: 0.85,
              absolute: 0.85,
              raw_payload: rawPayload,
              canonical_hash: hashOf(`${patientId}:${eventType}:${index}`),
              duration_minutes: 30,
              source_event_type: 'Temp Basal',
              normalization_version: 'nightscout-treatment-normalization.v1',
            }
          : {
              raw_payload: rawPayload,
              insulin_units: rawPayload.insulin,
              canonical_hash: hashOf(`${patientId}:${eventType}:${index}`),
              source_event_type: rawPayload.eventType,
              normalization_version: 'nightscout-treatment-normalization.v1',
            },
      });
    }
  }

  const mealEvents = Array.from({ length: mealCount }, (_, index) => {
    const occurredAt = minutesAfterStart(360 + index * 75);
    const sourceId = syntheticId(patientId, 'ns-meal', index).replace(/-/g, '').slice(0, 24);
    const carbs = 15 + (index * 7) % 50;
    return {
      event_id: syntheticId(patientId, 'meal', index),
      type: 'CARB_ENTRY',
      occurred_at: occurredAt,
      payload: {
        carbs,
        raw_payload: {
          id: sourceId,
          _id: sourceId,
          fat: 10,
          carbs,
          insulin: null,
          protein: 12,
          foodType: 'synthetic',
          enteredBy: 'synthetic-app',
          eventType: 'Carb Correction',
          utcOffset: 120,
          created_at: occurredAt,
        },
        canonical_hash: hashOf(`${patientId}:meal:${index}`),
        source_event_type: 'Carb Correction',
        normalization_version: 'nightscout-treatment-normalization.v1',
      },
      source_record_id: `nightscout:treatments:${sourceId}`,
    };
  });

  const hypoEpisodes = Array.from({ length: hypoEpisodeCount }, (_, index) => ({
    episode_id: syntheticId(patientId, 'hypo', index),
    state: 'RESOLVED',
    severity: 'LEVEL_1',
    started_at: minutesAfterStart(200 + index * 120),
    ended_at: minutesAfterStart(230 + index * 120),
    trigger_id: syntheticId(patientId, 'trigger', index),
  }));

  const rangeFacts = Array.from({ length: rangeFactCount }, (_, index) => ({
    fact_id: syntheticId(patientId, 'fact', index),
    fact_key: `synthetic_fact_${index}`,
    fact_name: 'synthetic_context_fact',
    value: index % 2 === 0 ? 'UNKNOWN' : 'REPORTED',
    value_type: 'STRING',
    knowledge_status: index % 2 === 0 ? 'UNKNOWN' : 'KNOWN',
    source_ref: `message:${syntheticId(patientId, 'fact-source', index)}`,
    source_event_id: null,
    source_conversation_id: null,
    recorded_at: minutesAfterStart(400 + index),
    created_at: minutesAfterStart(400 + index),
  }));

  // Same summary derivation as the worker TODAY projection.
  const glucoseValues = glucoseEvents.map((event) => event.payload.glucose_value);
  const missingSections: string[] = [];
  if (glucoseEvents.length === 0) missingSections.push('glucose_events');
  if (insulinEvents.length === 0) missingSections.push('insulin_treatment_events');
  if (mealEvents.length === 0) missingSections.push('meal_events');
  missingSections.push('activity_events');
  if (hypoEpisodes.length === 0) missingSections.push('hypo_episodes');

  const userMessageId = syntheticId(patientId, 'user-message', 0);
  const allEventIds = [...glucoseEvents, ...insulinEvents, ...mealEvents].map((event) => String(event.event_id));

  return {
    context_package_id: syntheticId(patientId, 'context-package', 0),
    context_package_version: 'conversation-time-range-context.v1',
    content_hash: hashOf(`${patientId}:context`),
    created_at: REQUESTED_AT,
    patient_ref: { patient_id: patientId },
    analysis_request_input: {
      user_message_id: userMessageId,
      user_message_text: 'Przeanalizuj mi dzisiejszy dzień',
      range_type: 'TODAY',
      timezone: 'Europe/Warsaw',
      range_start: RANGE_START,
      range_end: RANGE_END,
      requested_at: REQUESTED_AT,
    },
    conversation_context: {
      thread_id: syntheticId(patientId, 'conversation', 0),
      thread_state_version: 'conv-v1',
      awaiting_user_answer: false,
      messages: [{
        message_id: userMessageId,
        role: 'USER',
        created_at: REQUESTED_AT,
        content: 'Przeanalizuj mi dzisiejszy dzień',
        provenance_ref: `message:${userMessageId}`,
        message_type: 'USER_MESSAGE',
      }],
    },
    current_state_snapshot: options.withCurrentState === false
      ? null
      : { as_of: '2026-10-07T19:58:00.000Z', current_glucose: 132, trend: 'FLAT', iob: 1.25 },
    analytical_evidence: {
      glucose_events: glucoseEvents,
      insulin_treatment_events: insulinEvents,
      meal_events: mealEvents,
      activity_events: [],
      hypo_episodes: hypoEpisodes,
      range_event_facts: rangeFacts,
      summaries: {
        total_events: glucoseEvents.length + insulinEvents.length + mealEvents.length,
        glucose_count: glucoseEvents.length,
        insulin_treatment_count: insulinEvents.length,
        meal_count: mealEvents.length,
        activity_count: 0,
        hypo_episode_count: hypoEpisodes.length,
        glucose_min: glucoseValues.length > 0 ? Math.min(...glucoseValues) : null,
        glucose_max: glucoseValues.length > 0 ? Math.max(...glucoseValues) : null,
        glucose_avg: glucoseValues.length > 0
          ? Number((glucoseValues.reduce((sum, value) => sum + value, 0) / glucoseValues.length).toFixed(2))
          : null,
        missing_sections: missingSections,
      },
    },
    current_meal_reference: null,
    provenance: {
      source_refs: [userMessageId, `message:${userMessageId}`, ...allEventIds, ...rangeFacts.map((fact) => fact.source_ref)],
      selection_policy_version: 'conversation-time-range-context-selection.v1',
    },
    historical_evidence: options.historicalEvidence ?? null,
  };
}
