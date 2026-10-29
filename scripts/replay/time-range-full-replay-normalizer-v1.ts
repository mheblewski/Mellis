import { buildAiInputHash } from '@modules/ai-gateway/application/ai-task';
import type { TimeRangeAnalysisContextRecord } from '@modules/ai-gateway/domain/ai-gateway';

export const TIME_RANGE_FULL_REPLAY_NORMALIZER_V1 = 'TIME_RANGE_FULL_REPLAY_NORMALIZER_V1' as const;

export interface LegacyTimeRangePayloadV1 {
  capability: 'ANALYSIS_REQUEST';
  range: {
    user_message_id: string;
    user_message_text: string;
    range_type: 'TODAY';
    timezone: string;
    range_start: string;
    range_end: string;
    requested_at: string;
  };
  selection_policy_version: string;
  evidence_sections: {
    glucose_events: number;
    insulin_treatment_events: number;
    meal_events: number;
    activity_events: number;
    hypo_episodes: number;
    range_event_facts: number;
  };
  source_refs: string[];
  context_package_id: string;
  context_package_version: 'conversation-time-range-context.v1';
  content_hash: string;
}

interface ConversationSnapshot {
  id: string;
  thread_state_version: string | null;
  awaiting_user_answer: boolean;
}

interface UserMessage {
  id: string;
  content: string;
  created_at: string;
  provenance_ref: string | null;
}

interface ConversationMessage {
  id: string;
  role: string | null;
  created_at: string;
  content: string | null;
  provenance_ref: string | null;
  message_type: string | null;
}

interface CurrentStateSnapshot {
  as_of?: string;
  glucose?: { value?: number; trend?: string };
  iob?: { value?: number };
}

interface EventRow {
  id: string;
  type: string;
  occurred_at: string;
  payload: Record<string, unknown>;
  source_record_id: string | null;
}

interface HypoEpisodeRow {
  id: string;
  state: string;
  severity: string;
  started_at: string;
  ended_at: string | null;
  trigger_id: string | null;
}

interface FactRow {
  id: string;
  fact_key: string;
  fact_name: string;
  value: unknown;
  value_type: string;
  knowledge_status: string;
  source_ref: string;
  source_event_id: string | null;
  source_conversation_id: string | null;
  recorded_at: string;
  created_at: string;
}

export function normalizeTimeRangeFullReplayInputV1(args: {
  patient_id: string;
  conversation: ConversationSnapshot;
  user_message: UserMessage;
  conversation_messages: ConversationMessage[];
  current_state: CurrentStateSnapshot | null;
  events: EventRow[];
  hypo_episodes: HypoEpisodeRow[];
  range_facts: FactRow[];
  legacy_payload: LegacyTimeRangePayloadV1;
}): TimeRangeAnalysisContextRecord {
  const requestAtIso = args.legacy_payload.range.requested_at;
  const requestAt = new Date(requestAtIso);

  const projectedEvents = args.events.map((event) => ({
    event_id: String(event.id ?? ''),
    type: String(event.type ?? ''),
    occurred_at: String(event.occurred_at ?? ''),
    payload: event.payload ?? {},
    source_record_id: event.source_record_id ? String(event.source_record_id) : null,
  }));

  const glucoseEvents = projectedEvents.filter((event) => ['GLUCOSE_READING_AVAILABLE', 'GLUCOSE_READING', 'GLUCOSE'].includes(event.type));
  const insulinTreatmentEvents = projectedEvents.filter((event) => ['BOLUS', 'SMB', 'TEMP_BASAL', 'IOB_SNAPSHOT', 'COB_SNAPSHOT', 'THERAPY_CONTEXT', 'PROFILE_CHANGE', 'BASAL_PROFILE_SNAPSHOT'].includes(event.type));
  const mealEvents = projectedEvents.filter((event) => event.type === 'CARB_ENTRY');
  const activityEvents = projectedEvents.filter((event) => event.type === 'ACTIVITY');

  const glucoseValues = glucoseEvents
    .map((event) => {
      const payloadValue = (event.payload as Record<string, unknown>)?.glucose_value;
      const directValue = (event.payload as Record<string, unknown>)?.glucose;
      const rawPayload = (event.payload as Record<string, unknown>)?.raw_payload as Record<string, unknown> | undefined;
      const rawSgv = rawPayload?.sgv;
      const candidate = [payloadValue, directValue, rawSgv].find((value) => typeof value === 'number');
      return typeof candidate === 'number' && Number.isFinite(candidate) ? candidate : null;
    })
    .filter((value): value is number => value !== null);

  const glucoseMin = glucoseValues.length > 0 ? Math.min(...glucoseValues) : null;
  const glucoseMax = glucoseValues.length > 0 ? Math.max(...glucoseValues) : null;
  const glucoseAvg = glucoseValues.length > 0
    ? Number((glucoseValues.reduce((sum, value) => sum + value, 0) / glucoseValues.length).toFixed(2))
    : null;

  const missingSections: string[] = [];
  if (glucoseEvents.length === 0) missingSections.push('glucose_events');
  if (insulinTreatmentEvents.length === 0) missingSections.push('insulin_treatment_events');
  if (mealEvents.length === 0) missingSections.push('meal_events');
  if (activityEvents.length === 0) missingSections.push('activity_events');
  if (args.hypo_episodes.length === 0) missingSections.push('hypo_episodes');

  const contextBase: TimeRangeAnalysisContextRecord = {
    context_package_id: args.legacy_payload.context_package_id,
    context_package_version: 'conversation-time-range-context.v1',
    content_hash: '',
    created_at: requestAtIso,
    patient_ref: {
      patient_id: args.patient_id,
    },
    analysis_request_input: {
      user_message_id: args.legacy_payload.range.user_message_id,
      user_message_text: args.legacy_payload.range.user_message_text,
      range_type: 'TODAY',
      timezone: args.legacy_payload.range.timezone,
      range_start: args.legacy_payload.range.range_start,
      range_end: args.legacy_payload.range.range_end,
      requested_at: args.legacy_payload.range.requested_at,
    },
    conversation_context: {
      thread_id: args.conversation.id,
      thread_state_version: args.conversation.thread_state_version ?? 'conv-v1',
      awaiting_user_answer: args.conversation.awaiting_user_answer,
      messages: args.conversation_messages
        .filter((message) => new Date(String(message.created_at ?? requestAtIso)).getTime() <= requestAt.getTime())
        .slice(-12)
        .map((message) => ({
          message_id: String(message.id),
          role: String(message.role ?? 'SYSTEM') as 'SYSTEM' | 'USER' | 'ASSISTANT',
          created_at: String(message.created_at ?? requestAtIso),
          content: String(message.content ?? ''),
          provenance_ref: String(message.provenance_ref ?? ''),
          message_type: typeof message.message_type === 'string' ? message.message_type : 'OTHER',
        })),
    },
    current_state_snapshot: args.current_state
      ? {
          as_of: String(args.current_state.as_of ?? requestAtIso),
          current_glucose: typeof args.current_state.glucose?.value === 'number' ? Number(args.current_state.glucose.value) : 'UNKNOWN',
          trend: typeof args.current_state.glucose?.trend === 'string' ? String(args.current_state.glucose.trend) : 'UNKNOWN',
          iob: typeof args.current_state.iob?.value === 'number' ? Number(args.current_state.iob.value) : 'UNKNOWN',
        }
      : null,
    analytical_evidence: {
      glucose_events: glucoseEvents,
      insulin_treatment_events: insulinTreatmentEvents,
      meal_events: mealEvents,
      activity_events: activityEvents,
      hypo_episodes: args.hypo_episodes.map((episode) => ({
        episode_id: String(episode.id ?? ''),
        state: String(episode.state ?? ''),
        severity: String(episode.severity ?? ''),
        started_at: String(episode.started_at ?? ''),
        ended_at: episode.ended_at ? String(episode.ended_at) : null,
        trigger_id: episode.trigger_id ? String(episode.trigger_id) : null,
      })),
      range_event_facts: args.range_facts.map((fact) => ({
        fact_id: String(fact.id ?? ''),
        fact_key: String(fact.fact_key ?? ''),
        fact_name: String(fact.fact_name ?? ''),
        value: fact.value,
        value_type: String(fact.value_type ?? ''),
        knowledge_status: String(fact.knowledge_status ?? ''),
        source_ref: String(fact.source_ref ?? ''),
        source_event_id: fact.source_event_id ? String(fact.source_event_id) : null,
        source_conversation_id: fact.source_conversation_id ? String(fact.source_conversation_id) : null,
        recorded_at: String(fact.recorded_at ?? ''),
        created_at: String(fact.created_at ?? ''),
      })),
      summaries: {
        total_events: projectedEvents.length,
        glucose_count: glucoseEvents.length,
        insulin_treatment_count: insulinTreatmentEvents.length,
        meal_count: mealEvents.length,
        activity_count: activityEvents.length,
        hypo_episode_count: args.hypo_episodes.length,
        glucose_min: glucoseMin,
        glucose_max: glucoseMax,
        glucose_avg: glucoseAvg,
        missing_sections: missingSections,
      },
    },
    provenance: {
      source_refs: [
        String(args.user_message.id),
        String(args.user_message.provenance_ref ?? ''),
        ...projectedEvents.map((event) => event.event_id),
        ...args.range_facts.map((fact) => String(fact.source_ref ?? '')),
      ].filter((ref) => ref.length > 0),
      selection_policy_version: args.legacy_payload.selection_policy_version,
    },
  };

  const contextHash = buildAiInputHash({ context_package: contextBase });
  return {
    ...contextBase,
    content_hash: contextHash,
  };
}
