import type { TherapyNow } from '@modules/context/application/therapy-now';
import type { UserAiPreferences } from '@shared/primitives/user-ai-preferences';
import type { MealContextSelection } from '@modules/meal-candidates/application/meal-record-trust';
import { ContextPackageRecord, type HistoricalContextEvidence } from '@modules/context/domain/context-package';
import type { ConversationTimeRangeType } from '@modules/context/application/time-range-normalization';
import type { DailyInsulinTotals } from '@modules/evidence-tools/daily-insulin-totals';
import type { GlucoseTimeInRange } from '@modules/context/application/glucose-time-in-range';

export const CONVERSATION_DIRECT_RESPONSE_TASK_TYPE = 'CONVERSATION_DIRECT_RESPONSE' as const;
export const CONVERSATION_TIME_RANGE_ANALYSIS_TASK_TYPE = 'CONVERSATION_TIME_RANGE_ANALYSIS' as const;

export type AiTaskType =
  | typeof CONVERSATION_DIRECT_RESPONSE_TASK_TYPE
  | typeof CONVERSATION_TIME_RANGE_ANALYSIS_TASK_TYPE;

export interface AiTask {
  task_id: string;
  task_type: AiTaskType;
  task_version: string;
  context_package_id: string;
  context_package_version: string;
  context_package_hash: string;
  prompt_version: string;
  output_schema_version: string;
  model_policy_version: string;
  correlation_id: string;
  created_at: string;
  patient_id?: string;
  trigger_id?: string;
  analysis_id?: string;
}

export interface DirectResponseContextRecord {
  context_package_id: string;
  context_package_version: 'conversation-context.v1';
  content_hash: string;
  created_at: string;
  patient_ref: {
    patient_id: string;
    /** "Rok urodzenia" (patients.birth_year): the prompt states the patient's age from it; null or absent = not set. */
    birth_year?: number | null;
  };
  /**
   * "Moje instrukcje dla AI" of the user who sent the message: one low-priority line last in the instructions. Not part
   * of the prompt payload; null or absent = nothing set (no line).
   */
  user_preferences?: UserAiPreferences | null;
  conversation_context: {
    thread_id: string;
    thread_state_version: string;
    awaiting_user_answer: boolean;
    messages: Array<{
      message_id: string;
      role: 'SYSTEM' | 'USER' | 'ASSISTANT';
      created_at: string;
      content: string;
      provenance_ref: string;
      message_type?: string;
    }>;
    /** Suggestions shown under earlier answers of the conversation; new ones must not repeat them. */
    already_suggested_follow_ups?: string[];
    /** True while the conversation has no name in the history list: the answer also names it (conversation_title). */
    needs_title?: boolean;
  };
  direct_response_input: {
    user_message_id: string;
    user_message_text: string;
  };
  current_state_snapshot?: {
    as_of: string;
    current_glucose: number | 'UNKNOWN';
    trend: string | 'UNKNOWN';
    iob: number | 'UNKNOWN';
    /** Carbs on board, when the source reports it. */
    cob?: number | 'UNKNOWN';
    age_minutes?: number | null;
  } | null;
  /** The loop's state and the plans still open (therapy-now.v1); absent when not loaded. */
  therapy_now?: TherapyNow | null;
  /** The patient's time zone (Trio profile, else the server's); absent: the server's. */
  patient_time_zone?: string;
  /** When the caregiver asked (patient_local_time is read from it); absent: created_at. */
  question_at?: string;
  patient_facts?: Array<{
    fact_key: string;
    fact_name: string;
    knowledge_status: string;
    value: unknown;
    value_type: string;
    source_ref: string;
    recorded_at: string;
  }>;
  provenance: {
    source_refs: string[];
  };
}

export interface TimeRangeAnalysisContextRecord {
  context_package_id: string;
  context_package_version: 'conversation-time-range-context.v1';
  content_hash: string;
  created_at: string;
  patient_ref: {
    patient_id: string;
    /** "Rok urodzenia" (patients.birth_year): the prompt states the patient's age from it; null or absent = not set. */
    birth_year?: number | null;
  };
  /**
   * "Moje instrukcje dla AI" of the user who sent the message: one low-priority line last in the instructions. Not part
   * of the prompt payload; null or absent = nothing set (no line).
   */
  user_preferences?: UserAiPreferences | null;
  analysis_request_input: {
    user_message_id: string;
    user_message_text: string;
    range_type: ConversationTimeRangeType;
    timezone: string;
    range_start: string;
    range_end: string;
    requested_at: string;
    normalization_policy_version?: string;
    /** Set in the chat of a hypo screen: the answer is about this hypo episode. */
    focus_hypo_episode_id?: string;
  };
  conversation_context: {
    thread_id: string;
    thread_state_version: string;
    awaiting_user_answer: boolean;
    messages: Array<{
      message_id: string;
      role: 'SYSTEM' | 'USER' | 'ASSISTANT';
      created_at: string;
      content: string;
      provenance_ref: string;
      message_type?: string;
    }>;
    /** Suggestions shown under earlier answers of the conversation; new ones must not repeat them. */
    already_suggested_follow_ups?: string[];
    /** True while the conversation has no name in the history list: the answer also names it (conversation_title). */
    needs_title?: boolean;
  };
  current_state_snapshot?: {
    as_of: string;
    current_glucose: number | 'UNKNOWN';
    trend: string | 'UNKNOWN';
    iob: number | 'UNKNOWN';
    /** Carbs on board, when the source reports it. */
    cob?: number | 'UNKNOWN';
    /** Minutes between as_of and the analysis request (freshness of the current values). */
    age_minutes?: number | null;
  } | null;
  /** The loop's state and the plans still open (therapy-now.v1); absent when not loaded. */
  therapy_now?: TherapyNow | null;
  /** Temporary targets, overrides, site / sensor changes, notes of the analysed period (therapy-context-events.v1). */
  therapy_context_events?: Array<Record<string, unknown>> | null;
  /**
   * Duration of insulin action of the therapy profile valid at the range end, used as the look-back window of the
   * pre-hypo insulin/basal evidence. MISSING: no profile/DIA recorded for the patient; UNAVAILABLE: the lookup failed
   * or is not possible (no access). Absent in older contexts.
   */
  therapy_context?: {
    status: 'KNOWN' | 'MISSING' | 'UNAVAILABLE';
    dia_hours: number | null;
    therapy_id: string | null;
    valid_from: string | null;
  };
  /** Bolus + SMB + delivered basal per local day of the range (TDD), computed deterministically. Absent in older contexts. */
  daily_insulin_totals?: DailyInsulinTotals | null;
  /**
   * Therapy profile valid at the range end (ICR, ISF, basal, targets as [HH:MM, value] schedules), the basis of dose and
   * settings suggestions. UNAVAILABLE: the lookup failed or is not possible. Absent in older contexts.
   */
  therapy_profile?: {
    status: 'KNOWN' | 'MISSING' | 'UNAVAILABLE';
    therapy_id: string | null;
    valid_from: string | null;
    units: string | null;
    timezone: string | null;
    dia_hours: number | null;
    carb_ratio_g_per_u: Array<[string, number]> | null;
    sensitivity_per_u: Array<[string, number]> | null;
    basal_u_per_h: Array<[string, number]> | null;
    target_low: Array<[string, number]> | null;
    target_high: Array<[string, number]> | null;
  };
  analytical_evidence: {
    /**
     * Whether the event selection hit its row limit. The most recent events are kept, so a truncated selection holds the
     * range from `selected_from` (its oldest selected event) on; earlier events were not selected.
     */
    selection?: { event_limit: number; events_selected: number; truncated: boolean; selected_from?: string | null };
    glucose_events: Array<Record<string, unknown>>;
    insulin_treatment_events: Array<Record<string, unknown>>;
    meal_events: Array<Record<string, unknown>>;
    /** Carb entries the caregiver marked as correction carbs: logged for the loop only, never eaten. */
    virtual_correction_carb_events?: Array<Record<string, unknown>>;
    /** Carb entries logged for the protein and fat of a meal (WBT/FPU): insulin dosing aid, not carbohydrates eaten. */
    fat_protein_unit_carb_events?: Array<Record<string, unknown>>;
    /**
     * The rescue carb alert of this conversation (rescue-carbs.v1): what was detected, the static dose with its
     * arithmetic and what was logged. Present only in an alert's conversation.
     */
    rescue_carb_alert?: Record<string, unknown>;
    /** A meal's WBT conversation: the meal's WBT, the dose proposed now and the history (wbt-chat.v1). */
    meal_wbt?: Record<string, unknown>;
    activity_events: Array<Record<string, unknown>>;
    hypo_episodes: Array<Record<string, unknown>>;
    range_event_facts: Array<Record<string, unknown>>;
    /**
     * New-history meals started in the range (meal-record-trust.v1): `trusted` are caregiver-confirmed/corrected
     * facts, `unconfirmed` keep unknown macros. Absent when the new meal history has no meals in the range.
     */
    meal_records?: MealContextSelection;
    summaries: {
      total_events: number;
      glucose_count: number;
      insulin_treatment_count: number;
      meal_count: number;
      activity_count: number;
      hypo_episode_count: number;
      glucose_min: number | null;
      glucose_max: number | null;
      glucose_avg: number | null;
      /** Time in ranges of the selected readings (glucose-time-in-range.v1); null without readings. */
      glucose_time_in_range?: GlucoseTimeInRange | null;
      /**
       * When the event selection was cut: glucose aggregates of every reading of the whole range (computed in SQL), so
       * they do not describe only the selected days. Absent otherwise, or when they could not be computed.
       */
      glucose_whole_range?: {
        readings_count: number;
        min: number | null;
        max: number | null;
        avg: number | null;
        time_in_range: GlucoseTimeInRange | null;
      } | null;
      /** Hypo episodes of the range when more than the listed (most recent) ones. */
      hypo_episodes_total?: number;
      /** Facts recorded in the range when more than the listed (most recent) ones. */
      range_event_facts_total?: number;
      missing_sections: string[];
    };
  };
  current_meal_reference?: {
    status: 'RESOLVED' | 'AMBIGUOUS' | 'UNRESOLVED';
    reference_type: 'EVENT' | 'USER_REPORTED' | 'CURRENT_STATE_RECENT_MEAL' | 'NONE';
    confidence: 'HIGH' | 'MEDIUM' | 'LOW';
    source: 'NIGHTSCOUT_EVENT' | 'USER_MESSAGE' | 'CURRENT_STATE' | 'UNAVAILABLE';
    meal_event_id: string | null;
    occurred_at: string | null;
    description: string | null;
    carbs: {
      value: number | null;
      knowledge_status: 'KNOWN' | 'UNKNOWN' | 'MISSING';
      origin: 'OBSERVED' | 'REPORTED' | 'INFERRED';
    };
    protein_grams: {
      value: number | null;
      knowledge_status: 'KNOWN' | 'UNKNOWN' | 'MISSING';
      origin: 'OBSERVED' | 'REPORTED' | 'INFERRED';
    };
    fat_grams: {
      value: number | null;
      knowledge_status: 'KNOWN' | 'UNKNOWN' | 'MISSING';
      origin: 'OBSERVED' | 'REPORTED' | 'INFERRED';
    };
    fiber_grams: {
      value: number | null;
      knowledge_status: 'KNOWN' | 'UNKNOWN' | 'MISSING';
      origin: 'OBSERVED' | 'REPORTED' | 'INFERRED';
    };
    candidate_meal_event_ids: string[];
    planned_meal_source_available: boolean;
    notes: string[];
  } | null;
  provenance: {
    source_refs: string[];
    selection_policy_version: string;
  };
  historical_evidence?: HistoricalContextEvidence | null;
}

export interface DirectResponseAiResult {
  assistant_message: string;
}

export type AiContextPackage =
  | ContextPackageRecord
  | DirectResponseContextRecord
  | TimeRangeAnalysisContextRecord;

export interface AIUsage {
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  cached_input_tokens: number | null;
  reasoning_tokens: number | null;
  /** Input tokens written to the prompt cache (gpt-5.6+: billed above the input price); absent when not reported. */
  cache_write_tokens?: number | null;
  /** Processing tier that served the call ("default", "flex"); absent when not reported. */
  service_tier?: string | null;
}

export interface ContextPackageSectionUsage {
  section_name: string;
  serialized_bytes: number;
}

export interface ContextPackageUsage {
  total_serialized_bytes: number;
  sections: ContextPackageSectionUsage[];
  shadow_selection?: Record<string, unknown> | null;
  delivery?: Record<string, unknown> | null;
  compact_evidence_shadow?: Record<string, unknown> | null;
  provider_call_ledger?: Record<string, unknown> | null;
}

export interface AICostEstimate {
  estimated_cost: number | null;
  currency: string | null;
  pricing_version: string | null;
  input_cost: number | null;
  output_cost: number | null;
  cached_input_cost: number | null;
  reasoning_cost: number | null;
  cache_write_cost?: number | null;
}

export interface AIPricingConfig {
  input_per_1k_tokens: number | null;
  output_per_1k_tokens: number | null;
  cached_input_per_1k_tokens: number | null;
  reasoning_per_1k_tokens: number | null;
  /** Price of input tokens written to the prompt cache; unset = CACHE_WRITE_INPUT_PRICE_MULTIPLIER x the input price. */
  cache_write_per_1k_tokens?: number | null;
  /** Price factor of calls served by the flex tier (OpenAI: 0.5 for gpt-5.6); unset = 1, never an undercount. */
  flex_price_multiplier?: number | null;
  currency?: string | null;
  pricing_version?: string | null;
}

export interface AiEvidenceEnvelopeTaskIdentity {
  task_type: AiTaskType;
  task_version?: string;
  prompt_version?: string;
  output_schema_version?: string;
  correlation_id?: string;
}

export interface AiEvidenceEnvelopeBase {
  task: AiEvidenceEnvelopeTaskIdentity;
  patient_ref: { patient_id?: string };
  conversation_context: {
    thread_id?: string;
    recent_messages?: Array<Record<string, unknown>>;
  };
  current_state_snapshot?: Record<string, unknown> | null;
  evidence_contract: Record<string, unknown>;
  provenance_summary?: Record<string, unknown> | null;
}

export interface TimeRangeEvidenceDeliveryEnvelope extends AiEvidenceEnvelopeBase {
  task: AiEvidenceEnvelopeTaskIdentity & { task_type: typeof CONVERSATION_TIME_RANGE_ANALYSIS_TASK_TYPE };
  analysis_request_input: Record<string, unknown>;
  current_meal_reference?: Record<string, unknown> | null;
  selected_evidence: Record<string, unknown>;
  historical_evidence?: Record<string, unknown> | null;
  tool_loop_state?: Record<string, unknown> | null;
  historical_therapy_semantics_contract?: Record<string, unknown> | null;
}

export interface DirectResponseEvidenceDeliveryEnvelope extends AiEvidenceEnvelopeBase {
  task: AiEvidenceEnvelopeTaskIdentity & { task_type: typeof CONVERSATION_DIRECT_RESPONSE_TASK_TYPE };
  direct_response_input: Record<string, unknown>;
  patient_facts?: Array<Record<string, unknown>> | null;
}

export type AiEvidenceDeliveryEnvelope =
  | TimeRangeEvidenceDeliveryEnvelope
  | DirectResponseEvidenceDeliveryEnvelope;

export type AiModelTier = 'DEEP' | 'LIGHT';

export interface AiProviderInput {
  task: AiTask;
  context_package: AiContextPackage;
  /** Which model tier answers this execution (see model-routing.ts); absent means DEEP. Same for all its turns. */
  model_tier?: AiModelTier;
  previous_response_id?: string | null;
  /**
   * Set only when the previous_response_id chain already carries the system and user messages (dev-only
   * AI_EXPERIMENT_OMIT_CHAINED_TOOL_RESULTS): the provider sends just the additional instructions (if any) and the
   * new tool outputs instead of repeating the full prompt. `prompt` stays complete for validation and audit.
   */
  chained_prompt?: { additional_system_instructions: string | null } | null;
  /** Aborted when the caller cancels the analysis; providers pass it to their HTTP client. */
  abort_signal?: AbortSignal;
  /**
   * Set when the caregiver watches the answer being written: a provider that can stream calls it with the raw output
   * text written so far (structured JSON) after every delta; others ignore it. Never changes the request or result.
   */
  on_output_text?: (outputTextSoFar: string) => void;
  /**
   * Conversation answers only: photos the caregiver attached (JPEG, base64), sent as images next to the user message.
   * Not part of the context package or its hash (the prompt says how many are attached).
   */
  user_images?: AiUserImage[];
  prompt: {
    prompt_version: string;
    output_schema_version: string;
    system_instructions: string;
    user_payload: string;
  };
  tool_runtime?: {
    available_tools: AiRuntimeToolDefinition[];
    tool_results: AiRuntimeToolResult[];
    max_tool_calls_remaining: number;
    /**
     * 'none' forbids tool calls while keeping the same tool definitions in the request: the definitions are part of the
     * provider's cached prompt prefix, so removing them for the final turn would bill the whole chain uncached.
     */
    tool_choice?: 'none';
    /** Several tool calls in one turn (the cards of an answer's options); absent: one call per turn. */
    parallel_tool_calls?: boolean;
  };
}

export interface AiUserImage {
  media_type: 'image/jpeg';
  data_base64: string;
}

export interface AiRuntimeToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface AiRuntimeToolCall {
  call_id: string;
  tool_name: string;
  arguments: Record<string, unknown>;
}

export interface AiRuntimeToolResult {
  call_id: string;
  tool_name: string;
  result: Record<string, unknown>;
}

export interface AiRuntimeToolCallAudit {
  sequence: number;
  tool_name: string;
  normalized_request_hash: string;
  request_range: { from: string; to: string } | null;
  detail_level: string | null;
  result_status: string;
  result_hash: string;
  compiler_version: string;
  evidence_version: string;
}

export interface ProviderDiagnosticSnapshot {
  response_id: string | null;
  output_item_types: string[];
  function_call_names: string[];
  function_call_arguments: Array<Record<string, unknown>>;
  function_call_count: number;
  has_output_text: boolean;
  http_status: number | null;
  error_name: string | null;
  error_type: string | null;
  error_code: string | null;
  error_message: string | null;
  retryable: boolean | null;
  stage: string | null;
}

export interface AiProviderResponse {
  provider: string;
  model: string;
  response_id?: string | null;
  raw_output: unknown;
  tool_call?: AiRuntimeToolCall | null;
  tool_calls?: AiRuntimeToolCall[] | null;
  received_at: string;
  usage?: AIUsage | null;
  input_fingerprint?: string | null;
  serialized_input_bytes?: number | null;
  context_package_usage?: ContextPackageUsage | null;
  provider_latency_ms?: number | null;
  estimated_cost?: AICostEstimate | null;
  diagnostics?: ProviderDiagnosticSnapshot | null;
}

export interface AiProvider {
  generate(input: AiProviderInput): Promise<AiProviderResponse>;
}

export interface AiExecutionMetadata {
  provider: string;
  model: string;
  prompt_version: string;
  output_schema_version: string;
  model_policy_version: string;
  model_fingerprint: string;
  usage?: AIUsage | null;
  input_fingerprint?: string | null;
  serialized_input_bytes?: number | null;
  context_package_usage?: ContextPackageUsage | null;
  provider_latency_ms?: number | null;
  estimated_cost?: AICostEstimate | null;
  evidence_tool_calls?: AiRuntimeToolCallAudit[];
  /** Conversations with the knowledge base: the fragments the answer cites, shown under it (no fragment text). */
  knowledge_sources?: Array<{
    ref: string;
    title: string;
    section: string | null;
    page: number | null;
    page_end: number | null;
    url?: string;
    chunk_id: string;
    corpus_version: string | null;
  }>;
  /** Audit of the knowledge searches of this execution (queries, statuses, chunk ids, diagnostics, local cost). */
  knowledge_search?: Record<string, unknown>;
}

export interface AiExecutionResult {
  task: AiTask;
  input_hash: string;
  input_fingerprint?: string | null;
  task_identity: string;
  metadata: AiExecutionMetadata;
  result: DirectResponseAiResult;
}

export interface ProviderAttemptObserver {
  onAttemptStarted(args: {
    task_identity: string;
    provider: string;
    model: string;
    started_at: string;
  }): Promise<{ attempt_id: string; attempt_number: number } | null>;

  onAttemptSucceeded(args: {
    attempt_id: string;
    task_identity: string;
    provider: string;
    model: string;
    model_fingerprint?: string | null;
    input_fingerprint?: string | null;
    started_at: string;
    completed_at: string;
    provider_latency_ms?: number | null;
    usage?: AIUsage | null;
    estimated_cost?: AICostEstimate | null;
  }): Promise<void>;

  onAttemptFailed(args: {
    attempt_id?: string | null;
    task_identity: string;
    provider: string;
    model: string;
    started_at: string;
    completed_at: string;
    provider_latency_ms?: number | null;
    error_type: string;
    error_code?: string | null;
    usage?: AIUsage | null;
    estimated_cost?: AICostEstimate | null;
  }): Promise<void>;
}

export class AiExecutionError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'AI_TIMEOUT'
      | 'AI_CANCELLED'
      | 'AI_PROVIDER_RETRYABLE'
      | 'AI_PROVIDER_NON_RETRYABLE'
      | 'AI_CONTRACT_VIOLATION'
      | 'AI_TASK_VALIDATION_FAILED'
      | 'AI_CONTEXT_VALIDATION_FAILED',
    public readonly retryable: boolean,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AiExecutionError';
  }
}

export interface AiGateway {
  execute(input: {
    task: AiTask;
    context_package: AiContextPackage;
    timeout_ms?: number;
    attempt_observer?: ProviderAttemptObserver;
  }): Promise<AiExecutionResult>;
}