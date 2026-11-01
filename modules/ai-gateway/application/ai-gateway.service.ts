import {
  MAX_PROPOSE_WBT_DOSE_CALLS_PER_ANSWER,
  PROPOSE_WBT_DOSE_TOOL_DEFINITION,
  PROPOSE_WBT_DOSE_TOOL_NAME,
  WBT_DOSE_PROPOSAL_POLICY_VERSION,
  type WbtDoseProposalTools,
} from '@modules/meal-wbt/application/wbt-dose-proposal-tool';
import {
  BOLUS_PROPOSAL_INSTRUCTIONS,
  BOLUS_SOURCES_INSTRUCTION,
  BOLUS_PROPOSAL_POLICY_VERSION,
  MAX_PROPOSE_BOLUS_CALLS_PER_ANSWER,
  PROPOSE_BOLUS_TOOL_DEFINITION,
  ESTIMATE_WBT_TOOL_DEFINITION,
  ESTIMATE_WBT_TOOL_NAME,
  PROPOSE_BOLUS_TOOL_NAME,
  type BolusProposalTools,
} from '@modules/remote-commands/application/bolus-proposal-tool';
import {
  MAX_PROPOSE_RESCUE_CARBS_CALLS_PER_ANSWER,
  PROPOSE_RESCUE_CARBS_TOOL_DEFINITION,
  PROPOSE_RESCUE_CARBS_TOOL_NAME,
  RESCUE_CARB_PROPOSAL_INSTRUCTIONS,
  RESCUE_CARB_PROPOSAL_POLICY_VERSION,
  type RescueCarbProposalTools,
} from '@modules/rescue-carbs/application/rescue-carb-proposal-tool';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { CARE_REMINDER_POLICY, SET_REMINDER_INSTRUCTIONS, SET_REMINDER_TOOL_DEFINITION, SET_REMINDER_TOOL_NAME, type CareReminderTools } from '@modules/care-reminders/application/care-reminders';
import { createHash } from 'crypto';
import { canonicalJson } from '@shared/utils/canonical-json';
import { AI_PROVIDER } from '@modules/ai-gateway/infrastructure/ai-provider.token';
import { AiProviderError } from '@modules/ai-gateway/infrastructure/ai-provider.error';
import {
  AiContextPackage,
  AiExecutionError,
  AiExecutionResult,
  AiGateway,
  AiModelTier,
  AiProvider,
  AiRuntimeToolCallAudit,
  AiRuntimeToolResult,
  AiTask,
  CONVERSATION_TIME_RANGE_ANALYSIS_TASK_TYPE,
  CONVERSATION_DIRECT_RESPONSE_TASK_TYPE,
  DirectResponseAiResult,
  DirectResponseContextRecord,
  TimeRangeAnalysisContextRecord,
} from '@modules/ai-gateway/domain/ai-gateway';
import { localDateKey, localDateKeyDiffDays, localDayWindows, namedFocusDates } from '@modules/context/application/time-range-normalization';
import { aiTaskSchema, directResponseAiResultSchema } from './ai-contract.schema';
import { buildDirectResponsePrompt } from './direct-response-prompt';
import { buildTimeRangeAnalysisEvidenceToolPrompt, buildTimeRangeAnalysisPrompt } from './time-range-analysis-prompt';
import { buildAiInputHash, buildAiTaskIdentity } from './ai-task';
import { buildContextPackageUsage } from './ai-observability';
import { ProviderCallLedger } from './provider-call-ledger';
import {
  attachCompactEvidenceShadowToUsage,
  evaluateTodayCompactEvidenceShadow,
} from '@modules/context/application/today-compact-evidence-view';
import {
  attachShadowToContextPackageUsage,
  evaluateEvidenceSelectionShadowSafe,
  finalizeShadowWithProviderMetrics,
} from '@modules/context/application/evidence-selection-shadow';
import { buildEvidenceProcessingStep, buildInitialEvidenceView, createEvidenceToolRegistry, type EvidenceProcessingStep } from '@modules/evidence-tools';
import { isCausalQuestion } from '@modules/context/application/conversation-context-resolver';
import { selectModelTier } from './model-routing';
import {
  KNOWLEDGE_ANSWER_RULES_VERSION,
  MAX_KNOWLEDGE_SEARCHES_PER_ANSWER,
  SEARCH_KNOWLEDGE_TOOL_DEFINITION,
  SEARCH_KNOWLEDGE_TOOL_NAME,
  buildKnowledgeInstructions,
  buildKnowledgeToolResult,
  citedKnowledgeSources,
} from './knowledge-answer-rules';
import { KNOWLEDGE_SERVICES, type KnowledgeServices } from '@modules/knowledge/infrastructure/knowledge-services.factory';
import {
  FOOD_SEARCH_INSTRUCTIONS,
  FOOD_SEARCH_POLICY_VERSION,
  MAX_FOOD_SEARCH_CALLS_PER_ANSWER,
  SEARCH_FOOD_TOOL_DEFINITION,
  SEARCH_FOOD_TOOL_NAME,
  buildFoodSearchToolResult,
  droppedFoodQueries, normalizeFoodQueries,
  runFoodSearch,
  type FoodSearchOutcome,
} from '@modules/meal-chat/application/food-search-tool';
import type { FoodSearch } from '@modules/meal-chat/infrastructure/diabcalc-mcp-client';
import {
  GET_MEALS_TOOL_DEFINITION,
  GET_MEALS_TOOL_NAME,
  MAX_GET_MEALS_CALLS_PER_ANSWER,
  MAX_PROPOSE_MEAL_CHANGE_CALLS_PER_ANSWER,
  MEAL_ACTIONS_INSTRUCTIONS,
  MEAL_ACTIONS_TOOL_POLICY_VERSION,
  PROPOSE_MEAL_CHANGE_TOOL_DEFINITION,
  PROPOSE_MEAL_CHANGE_TOOL_NAME,
  type MealActionsTools,
} from '@modules/meal-actions/application/meal-actions-tool';
import type { AiUserImage } from '@modules/ai-gateway/domain/ai-gateway';
import {
  KNOWLEDGE_SEARCH_VERSION,
  normalizeKnowledgeQuery,
  type KnowledgeFragment,
  type KnowledgeSearchCost,
  type KnowledgeSearchOutcome,
} from '@modules/knowledge/application/knowledge-search';
import { readStreamingJsonStringField } from './partial-json-field';
import { patientAge, patientAgeInstruction } from '@shared/primitives/patient-age';
import { userAiPreferencesInstruction, type UserAiPreferences } from '@shared/primitives/user-ai-preferences';

type ToolResultDelivery = 'FULL_RESEND' | 'NEW_ONLY_CHAINED' | 'FULL_RESEND_CHAIN_FALLBACK';

const modelRoutingLogger = new Logger('AiModelRouting');
const responseBoundaryLogger = new Logger('AiResponseBoundary');
const toolTimingLogger = new Logger('AiToolTiming');

export const OMIT_CHAINED_TOOL_RESULTS_FLAG = 'AI_EXPERIMENT_OMIT_CHAINED_TOOL_RESULTS';

/**
 * Default: do not resend the prompt and tool outputs already contained in an intact previous_response_id chain
 * (the system/user prompt and earlier function_call_output items are input items of the chained responses, which the
 * provider carries and bills again; resending them billed every turn twice). A broken chain falls back to a full
 * resend. Set the flag to 0/false/no/off to force the full resend on every turn.
 */
export function isChainedToolResultOmissionEnabled(env: Record<string, string | undefined>): boolean {
  const normalized = env[OMIT_CHAINED_TOOL_RESULTS_FLAG]?.trim().toLowerCase();
  return !(normalized !== undefined && ['0', 'false', 'no', 'off'].includes(normalized));
}

/** A prompt's question-dependent instructions (time-range: pre-hypo evidence), if any. */
function tailOf(prompt: unknown): string | null {
  const tail = (prompt as { system_instructions_tail?: unknown } | null)?.system_instructions_tail;
  return typeof tail === 'string' && tail.length > 0 ? tail : null;
}

/** ISO timestamp to minute precision ("2026-10-14T06:05Z"); other values are returned unchanged. */
function minuteIso(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}):\d{2}(?:\.\d+)?Z$/.exec(value);
  return match ? `${match[1]}Z` : value;
}

function refDigest(refs: string[]): Record<string, unknown> {
  return {
    count: refs.length,
    sha256: `sha256:${createHash('sha256').update(JSON.stringify(refs)).digest('hex')}`,
    first: refs[0] ?? null,
    last: refs[refs.length - 1] ?? null,
  };
}

/** Per-record fields the model does not use: ids (kept as a digest) and values that only repeat a default. */
const RECORD_ID_KEYS = ['event_id', 'provenance_ref', 'source_record_id', 'source_event_id'];

function compactRecordList(records: Array<Record<string, unknown>>): { records: Array<Record<string, unknown>>; refs: string[]; unit: unknown } {
  const units = new Set(records.map((record) => record.unit).filter((unit) => unit !== undefined));
  const sharedUnit = units.size === 1 ? [...units][0] : undefined;
  const refs: string[] = [];
  const compacted = records.map((record) => {
    const ref = record.provenance_ref ?? record.event_id ?? record.source_record_id;
    if (typeof ref === 'string') refs.push(ref);
    const entry: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) {
      if (RECORD_ID_KEYS.includes(key)) continue;
      if (key === 'kind' && value === record.event_type) continue;
      if (key === 'validity' && value === 'VALID') continue;
      if (key === 'relationship_to_meal' && value === 'UNKNOWN') continue;
      if (key === 'unit' && sharedUnit !== undefined) continue;
      entry[key] = key.endsWith('_at') || key === 'start' || key === 'end' ? minuteIso(value) : value;
    }
    return entry;
  });
  return { records: compacted, refs, unit: sharedUnit };
}

/**
 * Lossless-for-the-model compaction of record lists in a provider copy: glucose readings become [time, mg/dL] rows
 * (validity only when not VALID), insulin/meal/basal records lose ids and default-valued fields. Every dropped id list
 * is replaced by its count, hash and first/last id; the full records stay in the evidence session audit.
 */
export function compactRecordsForProvider<T extends Record<string, unknown>>(payload: T): T {
  const evidence = payload.evidence as Record<string, unknown> | undefined;
  if (!evidence || typeof evidence !== 'object') return payload;
  const next: Record<string, unknown> = { ...evidence };
  const detailWindow = evidence.detail_window as Record<string, unknown> | undefined;
  if (detailWindow && Array.isArray(detailWindow.observations)) {
    const observations = detailWindow.observations as Array<Record<string, unknown>>;
    const refs = observations.map((entry) => entry.provenance_ref).filter((ref): ref is string => typeof ref === 'string');
    const { observations: _rows, coverage: windowCoverage, ...rest } = detailWindow;
    next.detail_window = {
      ...rest,
      // Same as the top-level coverage of the result: sent once.
      ...(windowCoverage !== undefined && JSON.stringify(windowCoverage) !== JSON.stringify(payload.coverage) ? { coverage: windowCoverage } : {}),
      // observed_at carries its zone (Z, or the patient's offset after the model-facing format converts it).
      reading_columns: ['observed_at', 'glucose_mg_dl', 'validity_if_not_valid'],
      readings: observations.map((entry) => (entry.validity === undefined || entry.validity === 'VALID'
        ? [minuteIso(entry.observed_at), entry.glucose_value]
        : [minuteIso(entry.observed_at), entry.glucose_value, entry.validity])),
      reading_refs: refDigest(refs),
    };
  }
  for (const key of ['events', 'actual_temp_basal']) {
    if (Array.isArray(evidence[key]) && (evidence[key] as unknown[]).every((entry) => entry && typeof entry === 'object')) {
      const { records, refs, unit } = compactRecordList(evidence[key] as Array<Record<string, unknown>>);
      next[key] = records;
      if (refs.length > 0) next[`${key}_refs`] = refDigest(refs);
      if (unit !== undefined) next[`${key}_unit`] = unit;
    }
  }
  return { ...payload, evidence: next } as T;
}

/**
 * Largest tool result (UTF-8 bytes of the provider copy) sent to the model in one turn. A cost policy, not a clinical
 * one: about a day of glucose readings fits; a larger result would push the next call past the per-call cost guard
 * after earlier paid calls. Above it the model gets a bounded stand-in and is asked to narrow the request.
 */
export const PROVIDER_TOOL_RESULT_MAX_BYTES = 64 * 1024;

/**
 * Provider copy of a tool result: glucose readings are sent once (DETAIL and TRAJECTORY both carry the same readings
 * in detail_window.observations and trajectory.ordered_points) with one reference each, and a result that is still
 * larger than PROVIDER_TOOL_RESULT_MAX_BYTES becomes an explicit RESULT_TOO_LARGE stand-in keeping the summary,
 * significant periods and coverage. The full result stays in the evidence session audit and its content_hash.
 */
export function boundToolResultForProvider<T extends Record<string, unknown>>(payload: T): T {
  let evidence = payload.evidence as Record<string, unknown> | undefined;
  let reduced: Record<string, unknown> = payload;
  // significant_events repeats the first events of `events` (insulin, meals): send each event once.
  if (evidence && Array.isArray(evidence.events) && Array.isArray(evidence.significant_events)) {
    const eventIds = new Set((evidence.events as Array<Record<string, unknown>>).map((event) => event.event_id));
    if ((evidence.significant_events as Array<Record<string, unknown>>).every((event) => event.event_id !== undefined && eventIds.has(event.event_id))) {
      const { significant_events: _duplicate, ...rest } = evidence;
      evidence = rest;
      reduced = { ...payload, evidence: rest };
    }
  }
  const detailWindow = evidence?.detail_window as Record<string, unknown> | undefined;
  const trajectory = evidence?.trajectory as Record<string, unknown> | undefined;
  if (evidence && Array.isArray(detailWindow?.observations)) {
    const observations = (detailWindow!.observations as Array<Record<string, unknown>>);
    const units = new Set(observations.map((entry) => entry.unit).filter((unit) => unit !== undefined));
    reduced = {
      ...reduced,
      evidence: {
        ...evidence,
        detail_window: {
          ...detailWindow,
          ...(units.size === 1 ? { unit: [...units][0] } : {}),
          observations: observations.map(({ source_record_id: _sourceRecordId, unit, ...entry }) => (units.size === 1 ? entry : { ...entry, unit })),
        },
        ...(trajectory && Array.isArray(trajectory.ordered_points)
          ? {
            trajectory: {
              ...Object.fromEntries(Object.entries(trajectory).filter(([key]) => key !== 'ordered_points')),
              ordered_points_omitted: 'SAME_READINGS_AS_DETAIL_WINDOW_OBSERVATIONS',
            },
          }
          : {}),
      },
    };
  }
  reduced = compactRecordsForProvider(reduced);
  if (Buffer.byteLength(JSON.stringify(reduced), 'utf8') <= PROVIDER_TOOL_RESULT_MAX_BYTES) {
    return reduced as T;
  }
  const original = (reduced.evidence ?? {}) as Record<string, unknown>;
  // significant_events was dropped above as a copy of `events`; the stand-in has no `events`, so it keeps them (the
  // boluses of an insulin result) from the original result.
  const significantEvents = (payload.evidence as Record<string, unknown> | undefined)?.significant_events;
  const keptEvents = Array.isArray(significantEvents) && significantEvents.every((entry) => entry && typeof entry === 'object')
    ? (({ records, refs, unit }) => ({ significant_events: records, ...(refs.length > 0 ? { significant_events_refs: refDigest(refs) } : {}), ...(unit !== undefined ? { significant_events_unit: unit } : {}) }))(compactRecordList(significantEvents as Array<Record<string, unknown>>))
    : original.significant_events !== undefined ? { significant_events: original.significant_events } : {};
  return {
    tool: reduced.tool,
    status: 'RESULT_TOO_LARGE',
    original_status: reduced.status,
    evidence: {
      ...(original.summary !== undefined ? { summary: original.summary } : {}),
      ...(original.significant_periods !== undefined ? { significant_periods: original.significant_periods } : {}),
      ...keptEvents,
    },
    coverage: reduced.coverage,
    limitations: [
      ...(Array.isArray(reduced.limitations) ? reduced.limitations as unknown[] : []),
      'The detailed result was too large to send in full. Only its summary is included. Request a narrower time range (for example a few hours around the event) or a lower detail level to see individual records.',
    ],
    provenance: reduced.provenance,
    content_hash: reduced.content_hash,
  } as unknown as T;
}

/**
 * Replaces each `source_refs` array of strings with `source_ref_count` and `source_refs_sha256` (hash of the
 * canonical JSON list), recursively. Deterministic and lossless for audit: the list is recoverable from the evidence
 * session record and verifiable against the hash. Anything else is returned unchanged.
 */
export function compactSourceRefListsForProvider<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((entry) => compactSourceRefListsForProvider(entry)) as unknown as T;
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  const compacted: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'source_refs' && Array.isArray(entry) && entry.every((ref) => typeof ref === 'string')) {
      compacted.source_ref_count = entry.length;
      compacted.source_refs_sha256 = `sha256:${createHash('sha256').update(JSON.stringify(entry)).digest('hex')}`;
      continue;
    }
    compacted[key] = compactSourceRefListsForProvider(entry);
  }
  return compacted as T;
}

/** Tells the model that the caregiver's question comes with photos (sent as images after the evidence). */
function buildAttachedPhotosInstruction(count: number, withFoodSearch: boolean): string {
  return [
    `Attached photos: the caregiver attached ${count} photo${count === 1 ? '' : 's'} to the conversation (images after the evidence; the latest caregiver message with photos). They usually show a meal, a product label or a device screen.`,
    'Describe briefly what you recognise and answer the question about it. For a meal: the components and their estimated grams' + (withFoodSearch ? ', then their macros from search_food' : ', then their estimated macros') + '. When the photo is unreadable or does not show what the question is about, say so and ask for a description.',
  ].join(' ');
}

/** Photos the caregiver attached that could not be loaded: never answered as if there were none. */
const UNREADABLE_PHOTOS_INSTRUCTION = (count: number) => `${count} photo${count === 1 ? '' : 's'} the caregiver attached could not be loaded for this answer: say so briefly and do not describe ${count === 1 ? 'it' : 'them'}.`;

function isTruthyEnvFlag(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized !== undefined && ['1', 'true', 'yes', 'on'].includes(normalized);
}

/** Default budget of a whole tool loop, in per-call limits: 3 × OPENAI_TIMEOUT_MS (90 s) stays under the 300 s job lease. */
const TOOL_LOOP_TIMEOUT_PER_CALL_TIMEOUTS = 3;

/**
 * Budget of a whole execution (a tool loop makes several provider calls, each limited by the per-call timeout):
 * AI_TOOL_LOOP_TIMEOUT_MS when set to a positive integer, else three per-call limits. Never below one call's limit.
 */
export function resolveToolLoopTimeoutMs(env: Record<string, string | undefined>, perCallTimeoutMs: number): number {
  const configured = Number(env.AI_TOOL_LOOP_TIMEOUT_MS?.trim() || Number.NaN);
  const budget = Number.isInteger(configured) && configured > 0 ? configured : perCallTimeoutMs * TOOL_LOOP_TIMEOUT_PER_CALL_TIMEOUTS;
  return Math.max(budget, perCallTimeoutMs);
}

/**
 * With the card tools, the card rules below win where the therapy suggestion rules above differ (audit 2026-10-23: the
 * model wrote "not enough data" and then prepared cards anyway).
 */
/** Data lookups (evidence tools) per answer, whatever the card tools add to the shared budget. */
export const MAX_EVIDENCE_TOOL_CALLS_PER_ANSWER = 4;
/** estimate_wbt calls per answer (one meal, maybe a corrected one). */
export const MAX_ESTIMATE_WBT_CALLS_PER_ANSWER = 2;

export const CARD_RULES_PRECEDENCE = 'DOSE CARDS: a dose to give now is a card (propose_bolus), and the card rules below win over the therapy suggestion rules above where they differ: no **Propozycja:** line (the card is the proposal); missing or uncertain data never block a card and you never write that you cannot estimate while you prepare cards (one stated assumption, the card\'s warnings show the risk); with falling or low glucose the standard plan is still one option, with its risk badge, next to the safer ones. The therapy suggestion rules still apply to settings changes and to explaining the arithmetic.';

@Injectable()
export class AiGatewayService implements AiGateway {
  constructor(
    @Inject(AI_PROVIDER) private readonly provider: AiProvider,
    /** Knowledge base for conversations (search_knowledge tool, protocol card); absent or empty: answers without sources. */
    @Optional() @Inject(KNOWLEDGE_SERVICES) private readonly knowledge: KnowledgeServices | null = null,
  ) {}

  async execute(input: {
    task: AiTask;
    context_package: AiContextPackage;
    /** Limit of one provider call. */
    timeout_ms?: number;
    /** Limit of the whole execution (every call and tool of a tool loop); default: see resolveToolLoopTimeoutMs. */
    loop_timeout_ms?: number;
    /** Cancels the execution: no further provider call starts and the in-flight HTTP request is aborted. */
    abort_signal?: AbortSignal;
    attempt_observer?: { onAttemptStarted: (args: { task_identity: string; provider: string; model: string; started_at: string; }) => Promise<{ attempt_id: string; attempt_number: number } | null>; onAttemptSucceeded: (args: { attempt_id: string; task_identity: string; provider: string; model: string; model_fingerprint?: string | null; input_fingerprint?: string | null; started_at: string; completed_at: string; provider_latency_ms?: number | null; usage?: { input_tokens: number | null; output_tokens: number | null; total_tokens: number | null; cached_input_tokens: number | null; reasoning_tokens: number | null } | null; estimated_cost?: { estimated_cost: number | null; currency: string | null; pricing_version: string | null; input_cost: number | null; output_cost: number | null; cached_input_cost: number | null; reasoning_cost: number | null } | null; }) => Promise<void>; onAttemptFailed: (args: { attempt_id?: string | null; task_identity: string; provider: string; model: string; started_at: string; completed_at: string; provider_latency_ms?: number | null; error_type: string; error_code?: string | null; usage?: { input_tokens: number | null; output_tokens: number | null; total_tokens: number | null; cached_input_tokens: number | null; reasoning_tokens: number | null } | null; estimated_cost?: { estimated_cost: number | null; currency: string | null; pricing_version: string | null; input_cost: number | null; output_cost: number | null; cached_input_cost: number | null; reasoning_cost: number | null } | null; }) => Promise<void>; };
    processing_observer?: { onStep: (step: EvidenceProcessingStep) => void | Promise<void> };
    /**
     * Conversation answers only: told the answer text written so far while the model writes it (streamed), and told ""
     * when a turn that wrote text ends in tool calls instead. The stored answer still comes from the validated result.
     */
    reply_draft_observer?: { onDraft: (assistantMessageSoFar: string) => void };
    /** DiabCalc product search (search_food tool) for conversation answers; absent: no product lookups. */
    food_search?: FoodSearch;
    /** The meals module (get_meals, propose_meal_change) for conversation answers; absent: the answer cannot change meals. */
    meal_actions?: MealActionsTools;
    /** Bolus cards (propose_bolus) for a caregiver allowed to send remote commands; absent: no card can be prepared. */
    bolus_proposals?: BolusProposalTools;
    /** Rescue carb dose cards (propose_rescue_carbs) in a rescue alert's conversation or an ordinary one; absent: no card. */
    rescue_carbs?: RescueCarbProposalTools;
    /** Reminders the chat sets (set_reminder, care-reminders.v1); absent: the answer cannot set one. */
    care_reminders?: CareReminderTools;
    /** A meal's WBT conversation: its WBT dose card (propose_wbt_dose, wbt-chat.v1); absent: no WBT card. */
    wbt_doses?: WbtDoseProposalTools;
    /** Conversation answers only: photos the caregiver attached to the question (JPEG). */
    user_images?: AiUserImage[];
    /** Photos of the caregiver's message that could not be read (left out of user_images). */
    user_images_unavailable?: number;
    evidence_session_observer?: {
      onSessionStarted: (args: {
        task_identity: string;
        patient_id: string;
        task_type: string;
        context_package_id: string;
        context_package_hash: string;
        initial_evidence_hash: string;
        initial_evidence_bytes: number;
        started_at: string;
      }) => Promise<void>;
      onToolCallRequested: (args: {
        task_identity: string;
        patient_id: string;
        sequence: number;
        call_id: string | null;
        tool_name: string;
        request_hash: string;
        normalized_arguments: Record<string, unknown>;
        time_range: { from: string; to: string } | null;
        detail_level: string | null;
        requested_at: string;
      }) => Promise<void>;
      onToolCallSucceeded: (args: {
        task_identity: string;
        patient_id: string;
        sequence: number;
        result_status: string;
        result_hash: string;
        result_bytes: number;
        compiler_version: string | null;
        evidence_version: string | null;
        provenance_refs: string[];
        completed_at: string;
      }) => Promise<void>;
      onToolCallFailed: (args: {
        task_identity: string;
        patient_id: string;
        sequence: number;
        completed_at: string;
        failure: Record<string, unknown>;
      }) => Promise<void>;
    };
  }): Promise<AiExecutionResult> {
    const task = Object.freeze({ ...input.task });
    const taskParse = aiTaskSchema.safeParse(task);
    if (!taskParse.success) {
      throw new AiExecutionError('AI task validation failed', 'AI_TASK_VALIDATION_FAILED', false, {
        issues: taskParse.error.issues,
      });
    }

    const contextPackage = input.context_package;
    validateTaskContextCompatibility(task, contextPackage);

    const evidenceToolRegistry = createEvidenceToolRegistry();
    const emitProcessingStep = async (step: EvidenceProcessingStep) => {
      if (input.processing_observer) {
        await input.processing_observer.onStep(step);
      }
    };
    await emitProcessingStep(buildEvidenceProcessingStep({
      executionId: task.task_id,
      sequence: 1,
      type: 'ANALYZING_REQUEST',
      status: 'STARTED',
      label: 'Analizuję pytanie',
      startedAt: new Date().toISOString(),
    }));
    const evidenceShadowView = (() => {
      const contextSource = contextPackage as unknown as Record<string, unknown>;
      const patientRef = contextSource.patient_ref as { patient_id?: string } | undefined;
      const currentState = contextSource.current_state_snapshot as { as_of?: string; current_glucose?: number | string; trend?: string } | undefined;
      const rangeSource = contextSource.analysis_request_input as { range_start?: string; range_end?: string } | undefined;

      return buildInitialEvidenceView({
        task_type: task.task_type,
        patient_id: patientRef?.patient_id ?? task.patient_id ?? 'unknown',
        range: rangeSource?.range_start && rangeSource.range_end
          ? { from: rangeSource.range_start, to: rangeSource.range_end }
          : null,
        current_state: currentState
          ? {
            as_of: typeof currentState.as_of === 'string' ? currentState.as_of : undefined,
            current_glucose: typeof currentState.current_glucose === 'number' ? currentState.current_glucose : null,
            trend: typeof currentState.trend === 'string' ? currentState.trend : null,
          }
          : null,
        significant_glucose_events: Array.isArray(contextSource.glucose_evidence)
          ? (contextSource.glucose_evidence as Array<Record<string, unknown>>).slice(0, 5).map((point) => ({
              label: 'glucose_event',
              start: String(point.observed_at ?? ''),
              end: String(point.observed_at ?? ''),
              minimum: Number(point.glucose_value ?? 0),
              maximum: Number(point.glucose_value ?? 0),
            }))
          : [],
        known_treatment_events: Array.isArray((currentState as { recent_insulin?: Array<Record<string, unknown>> } | undefined)?.recent_insulin)
          ? ((currentState as { recent_insulin?: Array<Record<string, unknown>> } | undefined)?.recent_insulin ?? []).slice(0, 3).map((event) => ({
              kind: String(event.kind ?? 'UNKNOWN'),
              occurred_at: String(event.occurred_at ?? ''),
              amount: Number(event.value ?? 0),
              unit: String(event.unit ?? 'U'),
            }))
          : [],
        evidence_capability_summary: evidenceToolRegistry.tools.map((tool) => tool.name),
        provenance: {
          source_context_package_version: contextPackage.context_package_version,
          source_task_identity: buildAiTaskIdentity(task),
        },
      });
    })();
    void evidenceShadowView;

    const providerIdentity = describeProvider(this.provider);
    // The model of the chosen tier once it is known: a failed attempt is recorded with it.
    let selectedProviderIdentity = providerIdentity;
    const taskIdentity = buildAiTaskIdentity(task);
    const initialEvidenceHash = `sha256:${createHash('sha256').update(canonicalJson(evidenceShadowView)).digest('hex')}`;
    const initialEvidenceBytes = Buffer.byteLength(JSON.stringify(evidenceShadowView), 'utf8');
    if (input.evidence_session_observer && task.task_type === CONVERSATION_TIME_RANGE_ANALYSIS_TASK_TYPE) {
      await input.evidence_session_observer.onSessionStarted({
        task_identity: taskIdentity,
        patient_id: task.patient_id ?? (contextPackage as { patient_ref?: { patient_id?: string } }).patient_ref?.patient_id ?? 'unknown',
        task_type: task.task_type,
        context_package_id: task.context_package_id,
        context_package_hash: task.context_package_hash,
        initial_evidence_hash: initialEvidenceHash,
        initial_evidence_bytes: initialEvidenceBytes,
        started_at: new Date().toISOString(),
      });
    }
    const shadowSelection = evaluateEvidenceSelectionShadowSafe({
      task,
      context_package: contextPackage,
    });
    const timeoutMs = input.timeout_ms ?? 15_000;
    const loopTimeoutMs = input.loop_timeout_ms ?? resolveToolLoopTimeoutMs(process.env, timeoutMs);
    const attemptStartedAt = new Date();
    const attemptRecord = input.attempt_observer
      ? await input.attempt_observer.onAttemptStarted({
        task_identity: taskIdentity,
        provider: providerIdentity.provider,
        model: providerIdentity.model,
        started_at: attemptStartedAt.toISOString(),
      })
      : null;

    // Measurement only: records every provider call of this attempt without touching requests.
    const callLedger = new ProviderCallLedger();
    const replyDraftObserver = input.reply_draft_observer
      && (task.task_type === CONVERSATION_DIRECT_RESPONSE_TASK_TYPE || task.task_type === CONVERSATION_TIME_RANGE_ANALYSIS_TASK_TYPE)
      ? input.reply_draft_observer
      : null;
    let lastDraft = '';
    const publishDraft = (text: string) => {
      if (!replyDraftObserver || text === lastDraft) return;
      lastDraft = text;
      notifyDraft(replyDraftObserver, text);
    };
    let providerResponse: Awaited<ReturnType<AiProvider['generate']>>;
    // Local estimates of the knowledge searches' paid calls (rewrite, embeddings, rerank), added to the attempt cost.
    const knowledgeCosts: KnowledgeSearchCost[] = [];
    // "Rok urodzenia" from the context package (patients.birth_year); null: the prompt says the age is not known.
    const promptPatientAge = patientAge((contextPackage as { patient_ref?: { birth_year?: number | null } }).patient_ref?.birth_year, new Date());
    const promptLoopSystem = (contextPackage as { therapy_now?: { loop?: { system?: string } | null } | null }).therapy_now?.loop?.system ?? null;
    try {
      const useEvidenceToolLoop = task.task_type === CONVERSATION_TIME_RANGE_ANALYSIS_TASK_TYPE
        && isTruthyEnvFlag(process.env.AI_ENABLE_TIME_RANGE_GLUCOSE_TOOL_CALLING);
      // Knowledge base in conversations: search_knowledge next to the data tools (time-range analyses) or alone (direct
      // replies). Hypo analyses and meal estimates never get it.
      const isConversationTask = task.task_type === CONVERSATION_DIRECT_RESPONSE_TASK_TYPE
        || task.task_type === CONVERSATION_TIME_RANGE_ANALYSIS_TASK_TYPE;
      const knowledgeSearch = isConversationTask ? this.knowledge?.search ?? null : null;
      const useKnowledgeTool = knowledgeSearch !== null;
      // Product macros (DiabCalc) for meals described in words or shown in a photo, in both conversation answers.
      const foodSearch = isConversationTask ? input.food_search ?? null : null;
      const useFoodTool = foodSearch !== null;
      const userImages = isConversationTask ? (input.user_images ?? []).slice(0, 3) : [];
      const unreadablePhotos = isConversationTask ? Math.max(0, Math.floor(Number(input.user_images_unavailable ?? 0)) || 0) : 0;
      // Reading and preparing meal changes (conversation-meal-actions.v1); a change is saved only from its card.
      const mealActions = isConversationTask ? input.meal_actions ?? null : null;
      const useMealActionTools = mealActions !== null;
      // Bolus cards the caregiver gives from the app (remote-bolus-trio-plan.md W7); nothing is sent by the tool.
      const bolusProposals = isConversationTask ? input.bolus_proposals ?? null : null;
      const useBolusTool = bolusProposals !== null;
      // Rescue carb cards in an alert's conversation (rescue-carbs.v1) or an ordinary one; nothing is logged by the tool.
      const rescueCarbs = isConversationTask ? input.rescue_carbs ?? null : null;
      const useRescueTool = rescueCarbs !== null;
      // The cards of an answer's options in one turn (answer-options.v1); AI_PARALLEL_CARD_TOOL_CALLS=0: one call per turn.
      const parallelCardCalls = (useBolusTool || useRescueTool) && process.env.AI_PARALLEL_CARD_TOOL_CALLS?.trim() !== '0';
      const careReminders = isConversationTask ? input.care_reminders ?? null : null;
      const useReminderTool = careReminders !== null;
      // The WBT dose card of a meal's WBT conversation (wbt-chat.v1); nothing is sent by the tool.
      const wbtDoses = isConversationTask ? input.wbt_doses ?? null : null;
      const useWbtTool = wbtDoses !== null;
      const useToolLoop = useEvidenceToolLoop || useKnowledgeTool || useFoodTool || useMealActionTools || useBolusTool || useRescueTool || useReminderTool || useWbtTool;

      const contextWithGlucose = useEvidenceToolLoop
        ? buildEvidenceToolContextFromTimeRangePackage(contextPackage as TimeRangeAnalysisContextRecord)
        : (contextPackage as unknown as Record<string, unknown>);
      const prefetch = useEvidenceToolLoop && isTimeRangePrefetchEnabled(process.env);
      const precomputedDailyEvidence = useEvidenceToolLoop
        ? buildPrecomputedDailyEvidence({
          task,
          context: contextPackage as TimeRangeAnalysisContextRecord,
          toolContext: contextWithGlucose,
          registry: evidenceToolRegistry,
          prefetch,
        })
        : null;
      // The chat of a hypo screen is about that hypo's causes, whatever the wording of the question. A causal question
      // that names only a rise or a high ("dlaczego rośnie po obiedzie?") does not get the insulin before the hypos.
      const requestInput = (contextPackage as TimeRangeAnalysisContextRecord).analysis_request_input;
      const questionText = requestInput?.user_message_text ?? '';
      const preHypoForCause = useEvidenceToolLoop
        && (Boolean(requestInput?.focus_hypo_episode_id)
          || (isCausalQuestion(questionText) && (isHypoTopicQuestion(questionText) || !isHighTopicQuestion(questionText))));
      // Prefetch: any question about lows gets the insulin before its episodes, when the range has any.
      const preHypoPrefetched = prefetch && !preHypoForCause && isHypoTopicQuestion(questionText)
        && (contextPackage as TimeRangeAnalysisContextRecord).analytical_evidence.hypo_episodes.length > 0;
      const preHypoEvidence = preHypoForCause || preHypoPrefetched
        ? buildPreHypoEvidence({
          task,
          context: contextPackage as TimeRangeAnalysisContextRecord,
          toolContext: contextWithGlucose,
          registry: evidenceToolRegistry,
        })
        : null;
      const basePrompt = useEvidenceToolLoop
        ? buildTimeRangeAnalysisEvidenceToolPrompt({
          task,
          context: contextPackage as TimeRangeAnalysisContextRecord,
          initialEvidenceView: evidenceShadowView,
          precomputedDailyEvidence,
          preHypoEvidence,
          preHypoReason: preHypoForCause ? 'CAUSE' : 'PREFETCH',
        })
        : task.task_type === CONVERSATION_DIRECT_RESPONSE_TASK_TYPE
          ? buildDirectResponsePrompt(task, contextPackage as DirectResponseContextRecord, { dose_card_tools: useBolusTool || useRescueTool })
          : buildTimeRangeAnalysisPrompt(task, contextPackage as TimeRangeAnalysisContextRecord);
      const withFoodTool = useFoodTool || userImages.length > 0 || unreadablePhotos > 0
        ? {
          ...basePrompt,
          system_instructions: [
            basePrompt.system_instructions,
            ...(useFoodTool ? [FOOD_SEARCH_INSTRUCTIONS] : []),
            ...(userImages.length > 0 ? [buildAttachedPhotosInstruction(userImages.length, useFoodTool)] : []),
            ...(unreadablePhotos > 0 ? [UNREADABLE_PHOTOS_INSTRUCTION(unreadablePhotos)] : []),
          ].join('\n'),
        }
        : basePrompt;
      const withKnowledgeTool = useKnowledgeTool
        ? {
          ...withFoodTool,
          system_instructions: `${withFoodTool.system_instructions}\n${buildKnowledgeInstructions({
            withEvidenceTools: useEvidenceToolLoop,
            directResponse: task.task_type === CONVERSATION_DIRECT_RESPONSE_TASK_TYPE,
            protocolCard: this.knowledge?.protocol_card ?? null,
            doseCardTools: useBolusTool || useRescueTool,
          })}`,
        }
        : withFoodTool;
      const withMealActions = useMealActionTools
        ? { ...withKnowledgeTool, system_instructions: `${withKnowledgeTool.system_instructions}\n${MEAL_ACTIONS_INSTRUCTIONS}` }
        : withKnowledgeTool;
      const withBolusTool = useBolusTool
        ? { ...withMealActions, system_instructions: `${withMealActions.system_instructions}\n${CARD_RULES_PRECEDENCE}\n${BOLUS_PROPOSAL_INSTRUCTIONS}${useKnowledgeTool ? `\n${BOLUS_SOURCES_INSTRUCTION}` : ''}` }
        : withMealActions;
      const withRescueCards = useRescueTool
        ? { ...withBolusTool, system_instructions: `${withBolusTool.system_instructions}\n${rescueCarbs?.instructions ?? RESCUE_CARB_PROPOSAL_INSTRUCTIONS}` }
        : withBolusTool;
      const withReminderTool = useReminderTool
        ? { ...withRescueCards, system_instructions: `${withRescueCards.system_instructions}\n${SET_REMINDER_INSTRUCTIONS}` }
        : withRescueCards;
      const withWbtTool = useWbtTool
        ? { ...withReminderTool, system_instructions: `${withReminderTool.system_instructions}\n${wbtDoses.instructions}` }
        : withReminderTool;
      // Last, so the instructions before it stay the same for every patient (prompt cache): portions, doses and
      // caution follow the patient's age instead of assuming a child.
      // The asking user's own preferences (role, tone) after it, below every rule, and only when set.
      const preferencesLine = userAiPreferencesInstruction((contextPackage as { user_preferences?: UserAiPreferences | null }).user_preferences);
      const providerPrompt = {
        ...withWbtTool,
        // The question-dependent part last (after the tools' instructions): everything before it is the same for every
        // question, so it is read from the prompt cache.
        system_instructions: [withWbtTool.system_instructions, patientAgeInstruction(promptPatientAge), ...(preferencesLine ? [preferencesLine] : []), ...(tailOf(basePrompt) ? [tailOf(basePrompt)!] : [])].join('\n'),
      };

      // One model for the whole execution (all turns of a tool loop share the response chain).
      const modelTierDecision = selectModelTier({
        task,
        userMessageText: task.task_type === CONVERSATION_DIRECT_RESPONSE_TASK_TYPE
          ? (contextPackage as DirectResponseContextRecord).direct_response_input?.user_message_text ?? null
          : (contextPackage as TimeRangeAnalysisContextRecord).analysis_request_input?.user_message_text ?? null,
        rangeType: (contextPackage as TimeRangeAnalysisContextRecord).analysis_request_input?.range_type ?? null,
        // Prefetched pre-hypo evidence does not make a question analytical: the tier stays what the question asks for.
        hasPreHypoEvidence: preHypoEvidence !== null && preHypoForCause,
        knowledgeToolAvailable: useKnowledgeTool,
        hasPhotos: userImages.length > 0,
        mealChangeRequested: mealActions?.meal_change_requested ?? false,
        // A rescue alert's chat validates a dose for a child going low: the main model. The cards alone (offered in every
        // ordinary chat) do not make a question a dose request.
        doseRequested: (bolusProposals?.dose_requested ?? false) || rescueCarbs?.for_alert === true,
      });
      selectedProviderIdentity = describeProvider(this.provider, modelTierDecision.tier);
      modelRoutingLogger.log(JSON.stringify({ event: 'ai_model_tier_selected', task_type: task.task_type, tier: modelTierDecision.tier, reason: modelTierDecision.reason }));

      const toolCallAudits: AiRuntimeToolCallAudit[] = [];
      // Audit sequence of every tool request, including those answered without running the tool.
      let toolRequestSequence = 0;
      const providerToolResults: AiRuntimeToolResult[] = [];
      const seenToolRequestHashes = new Set<string>();
      // One more call when a knowledge search may join the data tools.
      const maxToolCalls = (useEvidenceToolLoop && useKnowledgeTool ? 4 : 3)
        + (useFoodTool ? MAX_FOOD_SEARCH_CALLS_PER_ANSWER : 0)
        + (useMealActionTools ? MAX_GET_MEALS_CALLS_PER_ANSWER + MAX_PROPOSE_MEAL_CHANGE_CALLS_PER_ANSWER : 0)
        // Room for every card of a plan and for one search of the sources before them.
        + (useBolusTool ? MAX_PROPOSE_BOLUS_CALLS_PER_ANSWER + (useKnowledgeTool ? 1 : 0) + 1 : 0)
        + (useRescueTool ? MAX_PROPOSE_RESCUE_CARBS_CALLS_PER_ANSWER : 0)
        + (useReminderTool ? CARE_REMINDER_POLICY.max_per_answer : 0)
        + (useWbtTool ? MAX_PROPOSE_WBT_DOSE_CALLS_PER_ANSWER : 0);
      let getMealsCount = 0;
      let proposeMealChangeCount = 0;
      let proposeBolusCount = 0;
      let proposeRescueCount = 0;
      let proposeWbtCount = 0;
      const rescueOptionsCarded = new Set<string>();
      let foodSearchCount = 0;
      // The card tools add to the shared budget: the data lookups and the WBT estimate keep their own small caps.
      let evidenceToolCount = 0;
      let estimateWbtCount = 0;
      const seenFoodQueries = new Set<string>();
      // Knowledge searches of this answer: fragments by their global [S#] ref, audit entries, normalized queries.
      const knowledgeFragmentsByRef = new Map<string, { fragment: KnowledgeFragment; corpus_version: string | null }>();
      const knowledgeCalls: Array<Record<string, unknown>> = [];
      const seenKnowledgeQueries = new Set<string>();
      let knowledgeSearchCount = 0;
      let remainingToolCalls = maxToolCalls;
      let previousResponseId: string | undefined;
      // Chained request construction (default): see isChainedToolResultOmissionEnabled.
      const omitChainedToolResults = useToolLoop && isChainedToolResultOmissionEnabled(process.env);
      let deliveredToolResultCount = 0;
      let lastResponseHadId = false;
      let hasEmittedGeneratingResponse = false;
      let finalizationMode = false;
      const finalizationModeInstruction = [
        'FINALIZATION MODE: EVIDENCE_BUDGET_EXHAUSTED.',
        'Do not request additional evidence or tools.',
        'Answer now using only the evidence already retrieved.',
        'If some information is unavailable, represent it as UNKNOWN rather than assuming NO.',
      ].join(' ');

      const emitGeneratingResponseIfNeeded = async () => {
        if (hasEmittedGeneratingResponse) {
          return;
        }
        hasEmittedGeneratingResponse = true;
        await emitProcessingStep(buildEvidenceProcessingStep({
          executionId: task.task_id,
          sequence: 2,
          type: 'GENERATING_RESPONSE',
          status: 'STARTED',
          label: 'Przygotowuję odpowiedź',
          startedAt: new Date().toISOString(),
        }));
      };

      const runtimeToolDefinitions = [
        ...(!useEvidenceToolLoop ? [] : buildProgressiveRuntimeToolDefinitions()),
        ...(useFoodTool ? [SEARCH_FOOD_TOOL_DEFINITION] : []),
        ...(useKnowledgeTool ? [SEARCH_KNOWLEDGE_TOOL_DEFINITION] : []),
        ...(useMealActionTools ? [GET_MEALS_TOOL_DEFINITION, PROPOSE_MEAL_CHANGE_TOOL_DEFINITION] : []),
        ...(useBolusTool ? [PROPOSE_BOLUS_TOOL_DEFINITION] : []),
        ...(useBolusTool && bolusProposals?.estimateWbt ? [ESTIMATE_WBT_TOOL_DEFINITION] : []),
        ...(useRescueTool ? [PROPOSE_RESCUE_CARBS_TOOL_DEFINITION] : []),
        ...(useReminderTool ? [SET_REMINDER_TOOL_DEFINITION] : []),
        ...(useWbtTool ? [PROPOSE_WBT_DOSE_TOOL_DEFINITION] : []),
      ];
      const allowedToolNames = new Set(runtimeToolDefinitions.map((tool) => tool.name));

      // Small bounded loop: provider may request the glucose evidence tool, then must return final output.
      while (true) {
        if (Date.now() - attemptStartedAt.getTime() > loopTimeoutMs) {
          throw new AiExecutionError('AI tool loop timeout', 'AI_TIMEOUT', true, { timeout_ms: timeoutMs, loop_timeout_ms: loopTimeoutMs });
        }
        if (input.abort_signal?.aborted) {
          throw cancelledExecutionError();
        }

        const isFinalizationTurn = useToolLoop && finalizationMode;
        // Earlier tool outputs are inputs of the chained response, so with an intact chain only the
        // outputs answering the previous response's tool calls are new. Without an intact chain
        // (no response id on the previous turn) everything is resent, exactly as the default path.
        const chainCarriesDeliveredResults = previousResponseId !== undefined && lastResponseHadId;
        const toolResultDelivery: ToolResultDelivery = !omitChainedToolResults
          ? 'FULL_RESEND'
          : deliveredToolResultCount === 0 || chainCarriesDeliveredResults
            ? 'NEW_ONLY_CHAINED'
            : 'FULL_RESEND_CHAIN_FALLBACK';
        const toolResultsForCall = toolResultDelivery === 'NEW_ONLY_CHAINED'
          ? providerToolResults.slice(deliveredToolResultCount)
          : providerToolResults;
        const toolRuntime = useToolLoop
          ? {
            // Same definitions on every turn (cache prefix); the final turn forbids calls with tool_choice instead.
            available_tools: runtimeToolDefinitions,
            tool_results: toolResultsForCall,
            max_tool_calls_remaining: isFinalizationTurn ? 0 : remainingToolCalls,
            ...(parallelCardCalls ? { parallel_tool_calls: true } : {}),
            ...(isFinalizationTurn ? { tool_choice: 'none' as const } : {}),
          }
          : undefined;

        if (!useToolLoop || providerToolResults.length > 0) {
          await emitGeneratingResponseIfNeeded();
        }

        const systemInstructions = isFinalizationTurn
          ? `${providerPrompt.system_instructions}\n\n${finalizationModeInstruction}`
          : providerPrompt.system_instructions;
        // Same experiment, same intact-chain condition: the chained response already contains the prompt.
        const chainedPrompt = omitChainedToolResults && toolResultDelivery === 'NEW_ONLY_CHAINED' && chainCarriesDeliveredResults
          ? { additional_system_instructions: isFinalizationTurn ? finalizationModeInstruction : null }
          : null;
        const ledgerRequest = {
          turn_kind: isFinalizationTurn ? 'FINALIZATION' as const : callLedger.hasCalls() ? 'TOOL_CONTINUATION' as const : 'INITIAL' as const,
          previous_response_id: previousResponseId,
          // Measured as actually sent.
          system_instructions: chainedPrompt ? chainedPrompt.additional_system_instructions ?? '' : systemInstructions,
          user_payload: chainedPrompt ? '' : providerPrompt.user_payload,
          prompt_delivery: chainedPrompt ? 'CHAINED' as const : 'FULL' as const,
          available_tools: toolRuntime?.available_tools ?? [],
          tool_results: [...toolResultsForCall],
          tool_result_delivery: useToolLoop ? toolResultDelivery : undefined,
          omitted_chained_tool_results: toolResultDelivery === 'NEW_ONLY_CHAINED'
            ? providerToolResults.slice(0, deliveredToolResultCount)
            : [],
        };
        // Aborted when the caller cancels or when this call times out: a call the gateway gave up on must not keep
        // running (and billing) in the background.
        const callController = new AbortController();
        const abortCall = () => callController.abort();
        if (input.abort_signal?.aborted) callController.abort();
        else input.abort_signal?.addEventListener('abort', abortCall, { once: true });
        let turnWroteDraft = false;
        const onOutputText = replyDraftObserver
          ? (outputTextSoFar: string) => {
            const assistantMessage = readStreamingJsonStringField(outputTextSoFar, 'assistant_message');
            if (assistantMessage === null || (assistantMessage === '' && !turnWroteDraft)) return;
            turnWroteDraft = true;
            publishDraft(assistantMessage);
          }
          : null;
        try {
          providerResponse = await withTimeout(
            this.provider.generate({
              task,
              context_package: contextPackage,
              model_tier: modelTierDecision.tier,
              previous_response_id: previousResponseId,
              chained_prompt: chainedPrompt,
              abort_signal: callController.signal,
              ...(onOutputText ? { on_output_text: onOutputText } : {}),
              ...(userImages.length > 0 ? { user_images: userImages } : {}),
              prompt: {
                prompt_version: task.prompt_version,
                output_schema_version: task.output_schema_version,
                system_instructions: systemInstructions,
                user_payload: providerPrompt.user_payload,
              },
              tool_runtime: toolRuntime,
            }),
            // Each call gets its own limit, never past the end of the loop's budget.
            Math.max(1, Math.min(timeoutMs, attemptStartedAt.getTime() + loopTimeoutMs - Date.now())),
            input.abort_signal,
          );
        } catch (providerCallError) {
          callController.abort();
          callLedger.recordFailure(ledgerRequest);
          throw providerCallError;
        } finally {
          input.abort_signal?.removeEventListener('abort', abortCall);
        }
        callLedger.recordResponse(ledgerRequest, {
          usage: providerResponse.usage,
          estimated_cost: providerResponse.estimated_cost,
          serialized_input_bytes: providerResponse.serialized_input_bytes,
          provider_latency_ms: providerResponse.provider_latency_ms,
          requested_tool_call_count: (providerResponse.tool_calls ?? (providerResponse.tool_call ? [providerResponse.tool_call] : [])).length,
        });

        previousResponseId = providerResponse.response_id ?? previousResponseId;
        lastResponseHadId = typeof providerResponse.response_id === 'string' && providerResponse.response_id.length > 0;
        deliveredToolResultCount = providerToolResults.length;

        const requestedToolCalls = providerResponse.tool_calls
          ?? (providerResponse.tool_call ? [providerResponse.tool_call] : []);
        if (replyDraftObserver && turnWroteDraft && requestedToolCalls.length > 0) {
          // Text written before a tool call is not the answer: the next turn writes it again.
          publishDraft('');
        }

        if (isFinalizationTurn) {
          if (requestedToolCalls.length > 0) {
            throw new AiExecutionError('Evidence tool requested in finalization mode', 'AI_CONTRACT_VIOLATION', false);
          }
          break;
        }

        if (!useToolLoop || requestedToolCalls.length === 0) {
          break;
        }

        // How long each tool of this round took (they run one after another): ai_tool_round_timing.
        const toolTimings: Array<{ tool: string; ms: number }> = [];
        let timedTool: { tool: string; started_at: number } | null = null;
        const closeTimedTool = () => {
          if (timedTool) toolTimings.push({ tool: timedTool.tool, ms: Date.now() - timedTool.started_at });
          timedTool = null;
        };
        for (const toolCall of requestedToolCalls) {
          closeTimedTool();
          timedTool = { tool: toolCall.tool_name, started_at: Date.now() };
          if (remainingToolCalls <= 0) {
            // Several calls in one turn can go over the budget: each still gets an answer (the provider needs one per
            // call), and the next turn is the final one.
            finalizationMode = true;
            providerToolResults.push({ call_id: toolCall.call_id, tool_name: toolCall.tool_name, result: { tool: toolCall.tool_name, status: 'LIMIT_REACHED', note: 'No more tool calls in this answer: answer with what you have.' } });
            continue;
          }

          if (!allowedToolNames.has(toolCall.tool_name)) {
            throw new AiExecutionError(`Unsupported evidence tool requested: ${toolCall.tool_name}`, 'AI_CONTRACT_VIOLATION', false);
          }

          if (toolCall.tool_name === SEARCH_FOOD_TOOL_NAME && foodSearch) {
            for (const key of Object.keys(toolCall.arguments ?? {})) {
              if (key !== 'queries') throw new AiExecutionError(`Forbidden tool parameter: ${key}`, 'AI_CONTRACT_VIOLATION', false);
            }
            toolRequestSequence += 1;
            const sequence = toolRequestSequence;
            // Products already looked up in this answer are not searched again.
            const queries = normalizeFoodQueries(toolCall.arguments?.queries).filter((query) => !seenFoodQueries.has(query.toLowerCase()));
            let outcome: FoodSearchOutcome | null = null;
            let result: Record<string, unknown>;
            if (foodSearchCount >= MAX_FOOD_SEARCH_CALLS_PER_ANSWER) {
              result = { tool: SEARCH_FOOD_TOOL_NAME, status: 'LIMIT_REACHED', products: [], note: 'No more product lookups in this answer: use the products already returned or estimate (szacunek).' };
            } else if (queries.length === 0) {
              result = { tool: SEARCH_FOOD_TOOL_NAME, status: 'DUPLICATE_QUERY', products: [], note: 'These products were already looked up: use the earlier results.' };
            } else {
              foodSearchCount += 1;
              queries.forEach((query) => seenFoodQueries.add(query.toLowerCase()));
              await emitProcessingStep(buildEvidenceProcessingStep({
                executionId: task.task_id,
                sequence: 300 + foodSearchCount,
                type: 'REQUESTING_EVIDENCE',
                status: 'STARTED',
                label: 'Sprawdzam produkty w DiabCalc',
                startedAt: new Date().toISOString(),
              }));
              outcome = await runFoodSearch(foodSearch, queries);
              if (input.abort_signal?.aborted) {
                throw cancelledExecutionError();
              }
              result = buildFoodSearchToolResult(queries, outcome, droppedFoodQueries(toolCall.arguments?.queries));
            }
            const resultHash = `sha256:${createHash('sha256').update(canonicalJson(result)).digest('hex')}`;
            toolCallAudits.push({
              sequence,
              tool_name: SEARCH_FOOD_TOOL_NAME,
              normalized_request_hash: `sha256:${createHash('sha256').update(canonicalJson({ tool: SEARCH_FOOD_TOOL_NAME, queries, task_identity: taskIdentity })).digest('hex')}`,
              request_range: null,
              detail_level: null,
              result_status: String(result.status),
              result_hash: resultHash,
              compiler_version: FOOD_SEARCH_POLICY_VERSION,
              evidence_version: outcome ? `products:${outcome.results.reduce((total, entry) => total + entry.foods.length, 0)}` : 'none',
            });
            providerToolResults.push({ call_id: toolCall.call_id, tool_name: toolCall.tool_name, result });
            remainingToolCalls -= 1;
            if (remainingToolCalls <= 0) {
              finalizationMode = true;
            }
            continue;
          }

          if (toolCall.tool_name === PROPOSE_WBT_DOSE_TOOL_NAME && wbtDoses) {
            const allowedKeys = Object.keys((PROPOSE_WBT_DOSE_TOOL_DEFINITION.input_schema.properties ?? {}) as Record<string, unknown>);
            for (const key of Object.keys(toolCall.arguments ?? {})) {
              if (!allowedKeys.includes(key)) throw new AiExecutionError(`Forbidden tool parameter: ${key}`, 'AI_CONTRACT_VIOLATION', false);
            }
            toolRequestSequence += 1;
            const sequence = toolRequestSequence;
            let result: Record<string, unknown>;
            if (proposeWbtCount >= MAX_PROPOSE_WBT_DOSE_CALLS_PER_ANSWER) {
              result = { tool: PROPOSE_WBT_DOSE_TOOL_NAME, status: 'LIMIT_REACHED', note: 'The WBT card of this answer is ready: use it.' };
            } else {
              proposeWbtCount += 1;
              try {
                result = await wbtDoses.propose(toolCall.arguments ?? {});
              } catch {
                // Fail open: no card; the caregiver can still give the dose from the WBT screen.
                result = { tool: PROPOSE_WBT_DOSE_TOOL_NAME, status: 'UNAVAILABLE', note: 'The card could not be prepared now: give the dose as text and say it can be given from the WBT screen ("Insulina na WBT").' };
              }
              if (input.abort_signal?.aborted) {
                throw cancelledExecutionError();
              }
            }
            toolCallAudits.push({
              sequence,
              tool_name: PROPOSE_WBT_DOSE_TOOL_NAME,
              normalized_request_hash: `sha256:${createHash('sha256').update(canonicalJson({ tool: PROPOSE_WBT_DOSE_TOOL_NAME, arguments: toolCall.arguments ?? {}, task_identity: taskIdentity })).digest('hex')}`,
              request_range: null,
              detail_level: null,
              result_status: String(result.status),
              result_hash: `sha256:${createHash('sha256').update(canonicalJson(result)).digest('hex')}`,
              compiler_version: WBT_DOSE_PROPOSAL_POLICY_VERSION,
              evidence_version: String(result.status),
            });
            providerToolResults.push({ call_id: toolCall.call_id, tool_name: toolCall.tool_name, result });
            remainingToolCalls -= 1;
            if (remainingToolCalls <= 0) {
              finalizationMode = true;
            }
            continue;
          }

          if (toolCall.tool_name === PROPOSE_RESCUE_CARBS_TOOL_NAME && rescueCarbs) {
            const allowedKeys = Object.keys((PROPOSE_RESCUE_CARBS_TOOL_DEFINITION.input_schema.properties ?? {}) as Record<string, unknown>);
            for (const key of Object.keys(toolCall.arguments ?? {})) {
              if (!allowedKeys.includes(key)) throw new AiExecutionError(`Forbidden tool parameter: ${key}`, 'AI_CONTRACT_VIOLATION', false);
            }
            toolRequestSequence += 1;
            const sequence = toolRequestSequence;
            let result: Record<string, unknown>;
            // One card per option: a corrected card for an option that has one replaces it and counts once.
            const rescueOption = String(toolCall.arguments?.option ?? '');
            const replacesRescueCard = rescueOption !== '' && rescueOptionsCarded.has(rescueOption);
            if (!replacesRescueCard && proposeRescueCount >= MAX_PROPOSE_RESCUE_CARBS_CALLS_PER_ANSWER) {
              result = { tool: PROPOSE_RESCUE_CARBS_TOOL_NAME, status: 'LIMIT_REACHED', note: `At most ${MAX_PROPOSE_RESCUE_CARBS_CALLS_PER_ANSWER} rescue carb cards per answer (one per option): use the cards already prepared.` };
            } else {
              if (!replacesRescueCard) proposeRescueCount += 1;
              rescueOptionsCarded.add(rescueOption);
              try {
                result = await rescueCarbs.propose(toolCall.arguments ?? {});
              } catch {
                // Fail open: no card; the caregiver can still log any amount with the button above the chat.
                result = { tool: PROPOSE_RESCUE_CARBS_TOOL_NAME, status: 'UNAVAILABLE', note: 'The card could not be prepared now: give the dose as text and say it can be given in the loop or logged with "+" → "Dosłodzenie" in the meals tab.' };
              }
              if (input.abort_signal?.aborted) {
                throw cancelledExecutionError();
              }
            }
            toolCallAudits.push({
              sequence,
              tool_name: PROPOSE_RESCUE_CARBS_TOOL_NAME,
              normalized_request_hash: `sha256:${createHash('sha256').update(canonicalJson({ tool: PROPOSE_RESCUE_CARBS_TOOL_NAME, arguments: toolCall.arguments ?? {}, task_identity: taskIdentity })).digest('hex')}`,
              request_range: null,
              detail_level: null,
              result_status: String(result.status),
              result_hash: `sha256:${createHash('sha256').update(canonicalJson(result)).digest('hex')}`,
              compiler_version: RESCUE_CARB_PROPOSAL_POLICY_VERSION,
              evidence_version: String(result.status),
            });
            providerToolResults.push({ call_id: toolCall.call_id, tool_name: toolCall.tool_name, result });
            remainingToolCalls -= 1;
            if (remainingToolCalls <= 0) {
              finalizationMode = true;
            }
            continue;
          }

          if (toolCall.tool_name === ESTIMATE_WBT_TOOL_NAME && bolusProposals?.estimateWbt) {
            const allowedKeys = Object.keys((ESTIMATE_WBT_TOOL_DEFINITION.input_schema.properties ?? {}) as Record<string, unknown>);
            for (const key of Object.keys(toolCall.arguments ?? {})) {
              if (!allowedKeys.includes(key)) throw new AiExecutionError(`Forbidden tool parameter: ${key}`, 'AI_CONTRACT_VIOLATION', false);
            }
            toolRequestSequence += 1;
            const sequence = toolRequestSequence;
            let result: Record<string, unknown>;
            if (estimateWbtCount >= MAX_ESTIMATE_WBT_CALLS_PER_ANSWER) {
              result = { tool: ESTIMATE_WBT_TOOL_NAME, status: 'LIMIT_REACHED', note: 'Use the WBT estimates already returned.' };
            } else {
              estimateWbtCount += 1;
              try {
                result = await bolusProposals.estimateWbt(toolCall.arguments ?? {});
              } catch {
                result = { tool: ESTIMATE_WBT_TOOL_NAME, status: 'UNAVAILABLE', note: 'Give the WBT units and the app\'s rule (WBT × 10 / ICR × 30%) without a number of units.' };
              }
            }
            toolCallAudits.push({
              sequence,
              tool_name: ESTIMATE_WBT_TOOL_NAME,
              normalized_request_hash: `sha256:${createHash('sha256').update(canonicalJson({ tool: ESTIMATE_WBT_TOOL_NAME, arguments: toolCall.arguments ?? {}, task_identity: taskIdentity })).digest('hex')}`,
              request_range: null,
              detail_level: null,
              result_status: String(result.status),
              result_hash: `sha256:${createHash('sha256').update(canonicalJson(result)).digest('hex')}`,
              compiler_version: 'wbt-policy.v1',
              evidence_version: String(result.status),
            });
            providerToolResults.push({ call_id: toolCall.call_id, tool_name: toolCall.tool_name, result });
            remainingToolCalls -= 1;
            if (remainingToolCalls <= 0) {
              finalizationMode = true;
            }
            continue;
          }

          if (toolCall.tool_name === PROPOSE_BOLUS_TOOL_NAME && bolusProposals) {
            const allowedKeys = Object.keys((PROPOSE_BOLUS_TOOL_DEFINITION.input_schema.properties ?? {}) as Record<string, unknown>);
            for (const key of Object.keys(toolCall.arguments ?? {})) {
              if (!allowedKeys.includes(key)) throw new AiExecutionError(`Forbidden tool parameter: ${key}`, 'AI_CONTRACT_VIOLATION', false);
            }
            toolRequestSequence += 1;
            const sequence = toolRequestSequence;
            let result: Record<string, unknown>;
            if (proposeBolusCount >= MAX_PROPOSE_BOLUS_CALLS_PER_ANSWER) {
              result = { tool: PROPOSE_BOLUS_TOOL_NAME, status: 'LIMIT_REACHED', note: `At most ${MAX_PROPOSE_BOLUS_CALLS_PER_ANSWER} bolus cards per answer: use the cards already prepared.` };
            } else {
              proposeBolusCount += 1;
              await emitProcessingStep(buildEvidenceProcessingStep({
                executionId: task.task_id,
                sequence: 450 + proposeBolusCount,
                type: 'REQUESTING_EVIDENCE',
                status: 'STARTED',
                label: 'Przygotowuję kartę bolusa',
                startedAt: new Date().toISOString(),
              }));
              try {
                result = await bolusProposals.propose(toolCall.arguments ?? {});
              } catch {
                // Fail open: no card and no dose of the model's own (it never computes doses); the Bolus tab recomputes.
                result = { tool: PROPOSE_BOLUS_TOOL_NAME, status: 'UNAVAILABLE', note: 'The card could not be prepared now: write no dose number. Say the card cannot be prepared at the moment and that the Bolus tab computes the dose from the current data.' };
              }
              if (input.abort_signal?.aborted) {
                throw cancelledExecutionError();
              }
            }
            toolCallAudits.push({
              sequence,
              tool_name: PROPOSE_BOLUS_TOOL_NAME,
              normalized_request_hash: `sha256:${createHash('sha256').update(canonicalJson({ tool: PROPOSE_BOLUS_TOOL_NAME, arguments: toolCall.arguments ?? {}, task_identity: taskIdentity })).digest('hex')}`,
              request_range: null,
              detail_level: null,
              result_status: String(result.status),
              result_hash: `sha256:${createHash('sha256').update(canonicalJson(result)).digest('hex')}`,
              compiler_version: BOLUS_PROPOSAL_POLICY_VERSION,
              evidence_version: String(result.status),
            });
            providerToolResults.push({ call_id: toolCall.call_id, tool_name: toolCall.tool_name, result });
            remainingToolCalls -= 1;
            if (remainingToolCalls <= 0) {
              finalizationMode = true;
            }
            continue;
          }

          if (toolCall.tool_name === SET_REMINDER_TOOL_NAME && careReminders) {
            const allowedKeys = Object.keys((SET_REMINDER_TOOL_DEFINITION.input_schema.properties ?? {}) as Record<string, unknown>);
            for (const key of Object.keys(toolCall.arguments ?? {})) {
              if (!allowedKeys.includes(key)) throw new AiExecutionError(`Forbidden tool parameter: ${key}`, 'AI_CONTRACT_VIOLATION', false);
            }
            toolRequestSequence += 1;
            const sequence = toolRequestSequence;
            let result: Record<string, unknown>;
            try {
              result = await careReminders.set(toolCall.arguments ?? {});
            } catch {
              result = { tool: SET_REMINDER_TOOL_NAME, status: 'UNAVAILABLE', note: 'The reminder could not be set now: say so in one sentence.' };
            }
            if (input.abort_signal?.aborted) {
              throw cancelledExecutionError();
            }
            toolCallAudits.push({
              sequence,
              tool_name: SET_REMINDER_TOOL_NAME,
              normalized_request_hash: `sha256:${createHash('sha256').update(canonicalJson({ tool: SET_REMINDER_TOOL_NAME, arguments: toolCall.arguments ?? {}, task_identity: taskIdentity })).digest('hex')}`,
              request_range: null,
              detail_level: null,
              result_status: String(result.status),
              result_hash: `sha256:${createHash('sha256').update(canonicalJson(result)).digest('hex')}`,
              compiler_version: CARE_REMINDER_POLICY.version,
              evidence_version: String(result.status),
            });
            providerToolResults.push({ call_id: toolCall.call_id, tool_name: toolCall.tool_name, result });
            remainingToolCalls -= 1;
            if (remainingToolCalls <= 0) {
              finalizationMode = true;
            }
            continue;
          }

          if ((toolCall.tool_name === GET_MEALS_TOOL_NAME || toolCall.tool_name === PROPOSE_MEAL_CHANGE_TOOL_NAME) && mealActions) {
            const isListing = toolCall.tool_name === GET_MEALS_TOOL_NAME;
            const definition = isListing ? GET_MEALS_TOOL_DEFINITION : PROPOSE_MEAL_CHANGE_TOOL_DEFINITION;
            const allowedKeys = Object.keys((definition.input_schema.properties ?? {}) as Record<string, unknown>);
            for (const key of Object.keys(toolCall.arguments ?? {})) {
              if (!allowedKeys.includes(key)) throw new AiExecutionError(`Forbidden tool parameter: ${key}`, 'AI_CONTRACT_VIOLATION', false);
            }
            toolRequestSequence += 1;
            const sequence = toolRequestSequence;
            const used = isListing ? getMealsCount : proposeMealChangeCount;
            const limit = isListing ? MAX_GET_MEALS_CALLS_PER_ANSWER : MAX_PROPOSE_MEAL_CHANGE_CALLS_PER_ANSWER;
            let result: Record<string, unknown>;
            if (used >= limit) {
              result = { tool: toolCall.tool_name, status: 'LIMIT_REACHED', note: isListing ? 'Use the meals already returned.' : 'No more changes in this answer: describe what else should change and the caregiver can ask for it.' };
            } else {
              if (isListing) getMealsCount += 1;
              else proposeMealChangeCount += 1;
              await emitProcessingStep(buildEvidenceProcessingStep({
                executionId: task.task_id,
                sequence: 400 + getMealsCount + proposeMealChangeCount,
                type: 'REQUESTING_EVIDENCE',
                status: 'STARTED',
                label: isListing ? 'Sprawdzam posiłki' : 'Przygotowuję zmianę posiłku',
                startedAt: new Date().toISOString(),
              }));
              try {
                result = isListing ? await mealActions.getMeals(toolCall.arguments ?? {}) : await mealActions.proposeChange(toolCall.arguments ?? {});
              } catch {
                // Fail open: no card was stored, and the answer says the change could not be prepared now.
                result = { tool: toolCall.tool_name, status: 'UNAVAILABLE', note: 'The meals could not be read or changed now: tell the caregiver to try again or to change it in the meals tab (Posiłki).' };
              }
              if (input.abort_signal?.aborted) {
                throw cancelledExecutionError();
              }
            }
            const resultHash = `sha256:${createHash('sha256').update(canonicalJson(result)).digest('hex')}`;
            toolCallAudits.push({
              sequence,
              tool_name: toolCall.tool_name,
              normalized_request_hash: `sha256:${createHash('sha256').update(canonicalJson({ tool: toolCall.tool_name, arguments: toolCall.arguments ?? {}, task_identity: taskIdentity })).digest('hex')}`,
              request_range: null,
              detail_level: null,
              result_status: String(result.status),
              result_hash: resultHash,
              compiler_version: MEAL_ACTIONS_TOOL_POLICY_VERSION,
              evidence_version: isListing ? `meals:${Array.isArray(result.meals) ? result.meals.length : 0}` : String(result.status),
            });
            providerToolResults.push({ call_id: toolCall.call_id, tool_name: toolCall.tool_name, result });
            remainingToolCalls -= 1;
            if (remainingToolCalls <= 0) {
              finalizationMode = true;
            }
            continue;
          }

          if (toolCall.tool_name === SEARCH_KNOWLEDGE_TOOL_NAME && knowledgeSearch) {
            for (const key of Object.keys(toolCall.arguments ?? {})) {
              if (key !== 'query') throw new AiExecutionError(`Forbidden tool parameter: ${key}`, 'AI_CONTRACT_VIOLATION', false);
            }
            toolRequestSequence += 1;
            const sequence = toolRequestSequence;
            const query = normalizeKnowledgeQuery(String(toolCall.arguments?.query ?? ''));
            let outcome: KnowledgeSearchOutcome | null = null;
            let result: Record<string, unknown>;
            if (knowledgeSearchCount >= MAX_KNOWLEDGE_SEARCHES_PER_ANSWER) {
              result = { tool: SEARCH_KNOWLEDGE_TOOL_NAME, status: 'LIMIT_REACHED', query, fragments: [], note: 'No more knowledge searches in this answer: use the fragments already returned or general knowledge, marked as such.' };
            } else if (seenKnowledgeQueries.has(query)) {
              result = { tool: SEARCH_KNOWLEDGE_TOOL_NAME, status: 'DUPLICATE_QUERY', query, fragments: [], note: 'Same query as an earlier search: use the fragments it returned.' };
            } else {
              knowledgeSearchCount += 1;
              seenKnowledgeQueries.add(query);
              await emitProcessingStep(buildEvidenceProcessingStep({
                executionId: task.task_id,
                sequence: 100 + knowledgeSearchCount,
                type: 'REQUESTING_EVIDENCE',
                status: 'STARTED',
                label: 'Szukam w źródłach',
                startedAt: new Date().toISOString(),
              }));
              outcome = await knowledgeSearch.search({ query, patient_age: promptPatientAge, loop_system: promptLoopSystem, ...(input.abort_signal ? { abort_signal: input.abort_signal } : {}) });
              if (input.abort_signal?.aborted) {
                throw cancelledExecutionError();
              }
              const firstRefNumber = knowledgeFragmentsByRef.size + 1;
              outcome.fragments.forEach((fragment, offset) => {
                knowledgeFragmentsByRef.set(`S${firstRefNumber + offset}`, { fragment, corpus_version: outcome!.corpus_version });
              });
              if (outcome.diagnostics.estimated_cost) knowledgeCosts.push(outcome.diagnostics.estimated_cost);
              result = buildKnowledgeToolResult({ query, outcome, firstRefNumber });
            }
            const resultHash = `sha256:${createHash('sha256').update(canonicalJson(result)).digest('hex')}`;
            toolCallAudits.push({
              sequence,
              tool_name: SEARCH_KNOWLEDGE_TOOL_NAME,
              normalized_request_hash: `sha256:${createHash('sha256').update(canonicalJson({ tool: SEARCH_KNOWLEDGE_TOOL_NAME, query, task_identity: taskIdentity })).digest('hex')}`,
              request_range: null,
              detail_level: null,
              result_status: String(result.status),
              result_hash: resultHash,
              compiler_version: KNOWLEDGE_SEARCH_VERSION,
              evidence_version: outcome?.corpus_version ?? 'none',
            });
            knowledgeCalls.push({
              sequence,
              query,
              status: result.status,
              unavailable_reason: outcome?.unavailable_reason ?? null,
              corpus_version: outcome?.corpus_version ?? null,
              refs: Array.isArray(result.fragments) ? (result.fragments as Array<{ ref: string }>).map((fragment) => fragment.ref) : [],
              chunk_ids: outcome?.fragments.map((fragment) => fragment.chunk_id) ?? [],
              diagnostics: outcome?.diagnostics ?? null,
            });
            providerToolResults.push({ call_id: toolCall.call_id, tool_name: toolCall.tool_name, result });
            remainingToolCalls -= 1;
            if (remainingToolCalls <= 0) {
              finalizationMode = true;
            }
            continue;
          }

          if (evidenceToolCount >= MAX_EVIDENCE_TOOL_CALLS_PER_ANSWER) {
            providerToolResults.push({ call_id: toolCall.call_id, tool_name: toolCall.tool_name, result: { tool: toolCall.tool_name, status: 'LIMIT_REACHED', note: 'No more data lookups in this answer: answer with the data already returned.' } });
            remainingToolCalls -= 1;
            if (remainingToolCalls <= 0) {
              finalizationMode = true;
            }
            continue;
          }
          evidenceToolCount += 1;
          const normalizedRequest = normalizeEvidenceToolRequest({
            task,
            context: contextPackage as TimeRangeAnalysisContextRecord,
            toolName: toolCall.tool_name,
            toolCallArguments: toolCall.arguments,
          });
          const normalizedRequestHash = `sha256:${createHash('sha256').update(canonicalJson({
            tool: normalizedRequest.tool,
            patient_id: normalizedRequest.patient_id,
            detail_level: normalizedRequest.detail_level,
            time_range: normalizedRequest.time_range,
            task_identity: taskIdentity,
          })).digest('hex')}`;
          toolRequestSequence += 1;
          const sequence = toolRequestSequence;

          if (input.evidence_session_observer && task.task_type === CONVERSATION_TIME_RANGE_ANALYSIS_TASK_TYPE) {
            await input.evidence_session_observer.onToolCallRequested({
              task_identity: taskIdentity,
              patient_id: normalizedRequest.patient_id,
              sequence,
              call_id: toolCall.call_id ?? null,
              tool_name: toolCall.tool_name,
              request_hash: normalizedRequestHash,
              normalized_arguments: {
                tool: normalizedRequest.tool,
                time_range: normalizedRequest.time_range,
                detail_level: normalizedRequest.detail_level,
              },
              time_range: normalizedRequest.time_range,
              detail_level: normalizedRequest.detail_level,
              requested_at: new Date().toISOString(),
            });
          }

          if (seenToolRequestHashes.has(normalizedRequestHash)) {
            if (input.evidence_session_observer && task.task_type === CONVERSATION_TIME_RANGE_ANALYSIS_TASK_TYPE) {
              await input.evidence_session_observer.onToolCallFailed({
                task_identity: taskIdentity,
                patient_id: normalizedRequest.patient_id,
                sequence,
                completed_at: new Date().toISOString(),
                failure: {
                  reason: 'DUPLICATE_TOOL_REQUEST',
                },
              });
            }
            // Answered like the other tools' repeats (and counted against the budget) instead of failing the answer.
            providerToolResults.push({
              call_id: toolCall.call_id,
              tool_name: toolCall.tool_name,
              result: {
                tool: normalizedRequest.tool,
                status: 'DUPLICATE_QUERY',
                requested_range: normalizedRequest.time_range ?? null,
                limitations: ['Same request as an earlier one in this answer: use the evidence it returned.'],
              },
            });
            remainingToolCalls -= 1;
            if (remainingToolCalls <= 0) {
              finalizationMode = true;
            }
            continue;
          }
          seenToolRequestHashes.add(normalizedRequestHash);

          const shortCircuit = shortCircuitToolRequest(normalizedRequest, precomputedDailyEvidence);
          if (shortCircuit) {
            if (input.evidence_session_observer && task.task_type === CONVERSATION_TIME_RANGE_ANALYSIS_TASK_TYPE) {
              await input.evidence_session_observer.onToolCallFailed({
                task_identity: taskIdentity,
                patient_id: normalizedRequest.patient_id,
                sequence,
                completed_at: new Date().toISOString(),
                failure: { reason: shortCircuit.reason },
              });
            }
            providerToolResults.push({ call_id: toolCall.call_id, tool_name: toolCall.tool_name, result: shortCircuit.result as any });
            remainingToolCalls -= 1;
            if (remainingToolCalls <= 0) {
              finalizationMode = true;
            }
            continue;
          }

          const toolResponse = evidenceToolRegistry.execute(normalizedRequest, contextWithGlucose, {
            executionId: task.task_id,
            observer: {
              onStep: async (step) => {
                await emitProcessingStep(step);
              },
            },
          });

          if (toolResponse.status === 'INVALID_REQUEST' || toolResponse.status === 'UNAUTHORIZED' || toolResponse.status === 'OUT_OF_RANGE' || toolResponse.status === 'BUDGET_EXCEEDED' || toolResponse.status === 'FAILED') {
            if (input.evidence_session_observer && task.task_type === CONVERSATION_TIME_RANGE_ANALYSIS_TASK_TYPE) {
              await input.evidence_session_observer.onToolCallFailed({
                task_identity: taskIdentity,
                patient_id: normalizedRequest.patient_id,
                sequence,
                completed_at: new Date().toISOString(),
                failure: {
                  reason: 'TOOL_RESPONSE_REJECTED',
                  status: toolResponse.status,
                },
              });
            }
            // A request the model can correct (too wide, malformed, over budget) is answered with the reason instead of
            // failing the whole answer; an unauthorized request or a failing tool still stops it.
            if (toolResponse.status === 'UNAUTHORIZED' || toolResponse.status === 'FAILED') {
              throw new AiExecutionError(`Evidence tool request rejected: ${toolResponse.status}`, 'AI_CONTRACT_VIOLATION', false);
            }
            providerToolResults.push({
              call_id: toolCall.call_id,
              tool_name: toolCall.tool_name,
              result: {
                tool: toolResponse.tool,
                status: toolResponse.status,
                requested_range: normalizedRequest.time_range ?? null,
                limitations: [
                  ...(toolResponse.limitations ?? []),
                  'This request was not executed. Answer from the evidence you already have, or make a narrower request (DETAIL and TRAJECTORY: at most 6 hours around the event).',
                ],
              } as any,
            });
            remainingToolCalls -= 1;
            if (remainingToolCalls <= 0) {
              finalizationMode = true;
            }
            continue;
          }

          toolCallAudits.push({
            sequence,
            tool_name: toolResponse.tool,
            normalized_request_hash: normalizedRequestHash,
            request_range: toolResponse.provenance.request.time_range ?? null,
            detail_level: toolResponse.provenance.request.detail_level ?? null,
            result_status: toolResponse.status,
            result_hash: toolResponse.content_hash,
            compiler_version: toolResponse.compiler_version,
            evidence_version: toolResponse.provenance.evidence_version,
          });

          // Provider-facing copy: every source_refs list (one opaque id per reading/event, e.g. ~28 KB for a day of
          // CGM) becomes its count and hash. The full lists stay in the audit trail (observer below) and in
          // content_hash; per-event provenance_ref values, periods, coverage and limitations are sent unchanged.
          const resultPayload = boundToolResultForProvider(compactSourceRefListsForProvider({
            tool: toolResponse.tool,
            status: toolResponse.status,
            evidence: toolResponse.evidence,
            coverage: toolResponse.coverage,
            limitations: toolResponse.limitations,
            provenance: {
              request_hash: toolResponse.provenance.request_hash,
              compiler_version: toolResponse.provenance.compiler_version,
              evidence_version: toolResponse.provenance.evidence_version,
              source_refs: toolResponse.provenance.source_refs,
            },
            content_hash: toolResponse.content_hash,
          }));
          const resultBytes = Buffer.byteLength(JSON.stringify(resultPayload), 'utf8');

          if (input.evidence_session_observer && task.task_type === CONVERSATION_TIME_RANGE_ANALYSIS_TASK_TYPE) {
            await input.evidence_session_observer.onToolCallSucceeded({
              task_identity: taskIdentity,
              patient_id: normalizedRequest.patient_id,
              sequence,
              result_status: toolResponse.status,
              result_hash: toolResponse.content_hash,
              result_bytes: resultBytes,
              compiler_version: toolResponse.provenance.compiler_version,
              evidence_version: toolResponse.provenance.evidence_version,
              provenance_refs: toolResponse.provenance.source_refs,
              completed_at: new Date().toISOString(),
            });
          }

          providerToolResults.push({
            call_id: toolCall.call_id,
            tool_name: toolCall.tool_name,
            result: resultPayload,
          });
          remainingToolCalls -= 1;

          if (remainingToolCalls <= 0) {
            finalizationMode = true;
          }
        }
        closeTimedTool();
        toolTimingLogger.log(JSON.stringify({
          event: 'ai_tool_round_timing',
          task_type: task.task_type,
          provider_ms: providerResponse.provider_latency_ms ?? null,
          tools: toolTimings,
        }));

        // The next turn is the finalization turn, which always ends the loop.
        if (finalizationMode) {
          continue;
        }

        if (Date.now() - attemptStartedAt.getTime() > loopTimeoutMs) {
          throw new AiExecutionError('AI tool loop timeout', 'AI_TIMEOUT', true, { timeout_ms: timeoutMs, loop_timeout_ms: loopTimeoutMs });
        }
      }

      if (!hasEmittedGeneratingResponse) {
        await emitGeneratingResponseIfNeeded();
      }

      const parseResult = directResponseAiResultSchema.safeParse(providerResponse.raw_output);
      if (!parseResult.success) {
        throw new AiExecutionError('AI result validation failed', 'AI_CONTRACT_VIOLATION', false, {
          issues: parseResult.error.issues,
        });
      }

      const validatedResult: DirectResponseAiResult = parseResult.data;
      // Wording checks never discard a finished answer: a match is logged so its phrasing can be reviewed.
      for (const flag of findDirectResponseBoundaryFlags(validatedResult, task.task_type)) {
        responseBoundaryLogger.warn(JSON.stringify({ event: 'direct_response_boundary_flag', task_type: task.task_type, correlation_id: task.correlation_id, ...flag }));
      }

      await emitProcessingStep(buildEvidenceProcessingStep({
        executionId: task.task_id,
        sequence: 3,
        type: 'COMPLETED',
        status: 'SUCCEEDED',
        label: 'Zakończono analizę',
        startedAt: attemptStartedAt.toISOString(),
        completedAt: new Date().toISOString(),
      }));

      const completedAt = new Date();
      const contextPackageUsage = buildContextPackageUsage(contextPackage);
      const finalizedShadowSelection = finalizeShadowWithProviderMetrics({
        shadow: shadowSelection,
        current_payload_bytes: providerResponse.serialized_input_bytes ?? contextPackageUsage.total_serialized_bytes,
        current_payload_tokens: providerResponse.usage?.input_tokens ?? null,
      });
      const deliveryTelemetry = buildDeliveryTelemetry({
        task,
        providerResponse,
        contextPackage,
        useEvidenceToolLoop,
      });
      const contextPackageUsageWithShadow = attachShadowToContextPackageUsage({
        usage: contextPackageUsage,
        shadow: finalizedShadowSelection,
      });
      const contextPackageUsageWithDelivery = attachDeliveryTelemetry({
        usage: contextPackageUsageWithShadow,
        delivery: deliveryTelemetry,
      });
      // Shadow-only measurement: computed after the provider call, never part of the provider payload.
      const compactEvidenceShadow = evaluateTodayCompactEvidenceShadow({
        task_type: task.task_type,
        task_patient_id: task.patient_id,
        context: contextPackage,
        env: process.env,
        production_user_payload: providerPrompt.user_payload,
        provider_serialized_input_bytes: providerResponse.serialized_input_bytes,
        provider_input_tokens: providerResponse.usage?.input_tokens,
      });
      if (attemptRecord && input.attempt_observer) {
        await input.attempt_observer.onAttemptSucceeded({
          attempt_id: attemptRecord.attempt_id,
          task_identity: taskIdentity,
          provider: providerResponse.provider,
          model: providerResponse.model,
          model_fingerprint: `${providerResponse.provider}:${providerResponse.model}:${task.prompt_version}:${task.output_schema_version}`,
          input_fingerprint: providerResponse.input_fingerprint ?? null,
          started_at: attemptStartedAt.toISOString(),
          completed_at: completedAt.toISOString(),
          provider_latency_ms: providerResponse.provider_latency_ms ?? null,
          // Attempt-level totals across every provider call (tool-loop turns included), plus the knowledge searches.
          usage: callLedger.buildAttemptUsage(),
          estimated_cost: addKnowledgeSearchCost(callLedger.buildAttemptCostEstimate(), knowledgeCosts),
        });
      }

      const knowledgeMetadata = useKnowledgeTool
        ? {
          knowledge_sources: 'assistant_message' in validatedResult
            ? citedKnowledgeSources(String(validatedResult.assistant_message), knowledgeFragmentsByRef)
            : [],
          knowledge_search: {
            rules_version: KNOWLEDGE_ANSWER_RULES_VERSION,
            protocol_card: Boolean(this.knowledge?.protocol_card),
            calls: knowledgeCalls,
            estimated_cost: sumKnowledgeSearchCosts(knowledgeCosts),
          },
        }
        : {};

      return {
        task,
        input_hash: buildAiInputHash({ context_package: contextPackage }),
        input_fingerprint: providerResponse.input_fingerprint ?? null,
        task_identity: taskIdentity,
        metadata: {
          provider: providerResponse.provider,
          model: providerResponse.model,
          prompt_version: task.prompt_version,
          output_schema_version: task.output_schema_version,
          model_policy_version: task.model_policy_version,
          model_fingerprint: `${providerResponse.provider}:${providerResponse.model}:${task.prompt_version}:${task.output_schema_version}`,
          usage: providerResponse.usage ?? null,
          input_fingerprint: providerResponse.input_fingerprint ?? null,
          serialized_input_bytes: providerResponse.serialized_input_bytes ?? null,
          context_package_usage: attachProviderCallLedgerToUsage(attachCompactEvidenceShadowToUsage({
            usage: providerResponse.context_package_usage
              ? attachDeliveryTelemetry({
                  usage: attachShadowToContextPackageUsage({
                    usage: providerResponse.context_package_usage,
                    shadow: finalizedShadowSelection,
                  }),
                  delivery: deliveryTelemetry,
                })
              : contextPackageUsageWithDelivery,
            measurement: compactEvidenceShadow,
          }), callLedger),
          provider_latency_ms: providerResponse.provider_latency_ms ?? null,
          estimated_cost: providerResponse.estimated_cost ?? null,
          evidence_tool_calls: toolCallAudits,
          ...knowledgeMetadata,
        },
        result: validatedResult,
      };
    } catch (error) {
      const completedAt = new Date();
      const cancelled = input.abort_signal?.aborted === true;
      // A cancelled run is not a failure: no FAILED step (which would mark the execution failed) and no retry.
      if (!cancelled) await emitProcessingStep(buildEvidenceProcessingStep({
        executionId: task.task_id,
        sequence: 3,
        type: 'FAILED',
        status: 'FAILED',
        label: 'Nie udało się przygotować odpowiedzi',
        startedAt: attemptStartedAt.toISOString(),
        completedAt: completedAt.toISOString(),
      }));
      const classified = classifyAttemptFailure(error, selectedProviderIdentity, taskIdentity, attemptStartedAt.toISOString(), completedAt, attemptRecord?.attempt_id ?? null);

      if (attemptRecord && input.attempt_observer) {
        await input.attempt_observer.onAttemptFailed({
          ...classified,
          // Only calls that returned a response; usage of a call that failed is unknown.
          usage: callLedger.buildRespondedCallsUsage(),
          estimated_cost: addKnowledgeSearchCost(callLedger.buildAttemptCostEstimate(true), knowledgeCosts),
        });
      }

      if (cancelled) {
        throw cancelledExecutionError();
      }

      throw toAiExecutionError(error);
    }
  }
}

function toAiExecutionError(error: unknown): AiExecutionError {
  if (error instanceof AiExecutionError) {
    return error;
  }

  if (error instanceof AiProviderError) {
    return new AiExecutionError(
      error.message,
      error.retryable ? 'AI_PROVIDER_RETRYABLE' : 'AI_PROVIDER_NON_RETRYABLE',
      error.retryable,
      { provider_code: error.code ?? null },
    );
  }

  return new AiExecutionError(error instanceof Error ? error.message : 'AI provider invocation failed', 'AI_PROVIDER_RETRYABLE', true);
}

/** Sum of knowledge search costs in one currency; null without any (or with mixed currencies). */
function sumKnowledgeSearchCosts(costs: readonly KnowledgeSearchCost[]): KnowledgeSearchCost | null {
  if (!costs.length || new Set(costs.map((cost) => cost.currency.toUpperCase())).size !== 1) return null;
  return { amount: Math.round(costs.reduce((sum, cost) => sum + cost.amount, 0) * 1e6) / 1e6, currency: costs[0].currency };
}

/**
 * Attempt cost including the knowledge searches (their light-model and embedding calls are not provider calls of the
 * gateway's ledger). Only the total grows; the component costs stay those of the provider calls.
 */
export function addKnowledgeSearchCost<T extends { estimated_cost: number | null; currency: string | null }>(estimate: T | null, costs: readonly KnowledgeSearchCost[]): T | null {
  const knowledge = sumKnowledgeSearchCosts(costs);
  if (!estimate || !knowledge || estimate.estimated_cost === null) return estimate;
  if ((estimate.currency ?? '').toUpperCase() !== knowledge.currency.toUpperCase()) return estimate;
  return { ...estimate, estimated_cost: Math.round((estimate.estimated_cost + knowledge.amount) * 1e8) / 1e8 };
}

function attachProviderCallLedgerToUsage<T extends { total_serialized_bytes: number }>(usage: T, ledger: ProviderCallLedger): T & { provider_call_ledger: Record<string, unknown> } {
  return {
    ...usage,
    provider_call_ledger: ledger.buildAggregate() as unknown as Record<string, unknown>,
  };
}

function buildDeliveryTelemetry(args: {
  task: AiTask;
  providerResponse: Awaited<ReturnType<AiProvider['generate']>>;
  contextPackage: AiContextPackage;
  useEvidenceToolLoop: boolean;
}): Record<string, unknown> {
  const taskIdentity = buildAiTaskIdentity(args.task);
  const actualBytes = args.providerResponse.serialized_input_bytes ?? null;
  const actualTokens = args.providerResponse.usage?.input_tokens ?? null;

  return {
    delivery_path: 'SINGLE_VALIDATED_ENVELOPE_V1',
    evidence_loop_enabled: args.useEvidenceToolLoop,
    evidence_selection_policy_version: 'evidence-selection-policy.v1',
    task_identity: taskIdentity,
    context_package_hash: args.contextPackage.content_hash ?? null,
    serialized_input_bytes: actualBytes,
    input_tokens: actualTokens,
  };
}

function attachDeliveryTelemetry(args: {
  usage: { total_serialized_bytes: number; sections: Array<{ section_name: string; serialized_bytes: number }>; shadow_selection?: Record<string, unknown> | null; delivery?: Record<string, unknown> | null };
  delivery: Record<string, unknown>;
}): { total_serialized_bytes: number; sections: Array<{ section_name: string; serialized_bytes: number }>; shadow_selection?: Record<string, unknown> | null; delivery?: Record<string, unknown> | null } {
  return {
    ...args.usage,
    delivery: {
      ...(args.usage.delivery ?? {}),
      ...args.delivery,
    },
  };
}

function buildProgressiveRuntimeToolDefinitions(): Array<{
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}> {
  const baseSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      time_range: {
        type: 'object',
        additionalProperties: false,
        properties: {
          from: { type: 'string' },
          to: { type: 'string' },
        },
        required: ['from', 'to'],
      },
      detail_level: {
        type: 'string',
      },
    },
  } as const;

  return [
    {
      name: 'get_glucose_evidence',
      description: 'Return deterministic semantic glucose evidence for a selected time range of at most 24 hours (whole-range aggregates are in selected_evidence). When precomputed_daily_evidence is present, daily SUMMARY/SIGNIFICANT_EVENTS are already there (do not request them again). DETAIL and TRAJECTORY return every reading: at most 6 hours per request, around the event of interest.',
      input_schema: {
        ...baseSchema,
        properties: {
          ...baseSchema.properties,
          detail_level: {
            type: 'string',
            enum: ['SUMMARY', 'SIGNIFICANT_EVENTS', 'DETAIL', 'TRAJECTORY'],
          },
        },
      },
    },
    {
      name: 'get_insulin_evidence',
      description: 'Return deterministic semantic insulin evidence for a selected time range.',
      input_schema: {
        ...baseSchema,
        properties: {
          ...baseSchema.properties,
          detail_level: {
            type: 'string',
            enum: ['SUMMARY', 'SIGNIFICANT_EVENTS', 'DETAIL'],
          },
        },
      },
    },
    {
      name: 'get_basal_evidence',
      description: 'Return deterministic semantic basal evidence for a selected time range.',
      input_schema: {
        ...baseSchema,
        properties: {
          ...baseSchema.properties,
          detail_level: {
            type: 'string',
            enum: ['SUMMARY', 'DETAIL'],
          },
        },
      },
    },
    {
      name: 'get_meal_evidence',
      description: 'Return deterministic semantic meal evidence for a selected time range.',
      input_schema: {
        ...baseSchema,
        properties: {
          ...baseSchema.properties,
          detail_level: {
            type: 'string',
            enum: ['SUMMARY', 'SIGNIFICANT_EVENTS', 'DETAIL'],
          },
        },
      },
    },
    {
      name: 'get_activity_evidence',
      description: 'Return deterministic semantic activity evidence for a selected time range.',
      input_schema: {
        ...baseSchema,
        properties: {
          ...baseSchema.properties,
          detail_level: {
            type: 'string',
            enum: ['SUMMARY', 'SIGNIFICANT_EVENTS', 'DETAIL'],
          },
        },
      },
    },
    {
      name: 'get_loop_evidence',
      description: 'Return deterministic semantic loop evidence for a selected time range.',
      input_schema: {
        ...baseSchema,
        properties: {
          ...baseSchema.properties,
          detail_level: {
            type: 'string',
            enum: ['SUMMARY', 'DETAIL'],
          },
        },
      },
    },
    {
      name: 'get_therapy_profile',
      description: 'Return deterministic semantic therapy profile evidence for a selected time range.',
      input_schema: {
        ...baseSchema,
        properties: {
          ...baseSchema.properties,
          detail_level: {
            type: 'string',
            enum: ['SUMMARY', 'DETAIL'],
          },
        },
      },
    },
  ];
}

/** Range types whose days are summarized up front (up to a week); longer ranges keep tool-only retrieval. */
const PRECOMPUTED_DAILY_EVIDENCE_RANGE_TYPES = new Set(['TODAY', 'SHORT_RANGE', 'MEDIUM_RANGE']);
/**
 * Ranges up to this many local days get full summaries for every day when no day is named; longer ones glucose only.
 * Four: "ostatnie 3 dni" is three complete days plus today so far.
 */
const PRECOMPUTED_FULL_DAYS_WITHOUT_FOCUS = 4;
const PRECOMPUTED_DAILY_EVIDENCE_TOOLS = ['get_glucose_evidence', 'get_insulin_evidence', 'get_meal_evidence'] as const;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * AI_TIME_RANGE_PREFETCH: give the first request what analyses almost always fetch next (A/B 2026-10-18: 3 of 4
 * analyses used the whole tool budget, ~0.009 USD and ~4 s per extra turn, each re-reading the whole context):
 * glucose significant events for the days in focus, and for hypo questions the days with an episode in focus plus
 * the insulin and basal before each episode (pre_hypo_evidence). Off unless set.
 */
export function isTimeRangePrefetchEnabled(env: Record<string, string | undefined>): boolean {
  const normalized = env.AI_TIME_RANGE_PREFETCH?.trim().toLowerCase();
  return normalized !== undefined && ['1', 'true', 'yes', 'on'].includes(normalized);
}

/** A question about lows: hypoglycaemia, drops, values below range. */
const HYPO_TOPIC_PATTERN = /hipo|hypo|niedocukr|spad|spadl|spadek|spadki|nisk|ponizej 70|poniżej 70|\blow/;

export function isHypoTopicQuestion(text: string): boolean {
  return HYPO_TOPIC_PATTERN.test(String(text ?? '').toLowerCase());
}

/** A question about a rise or a high glucose. */
const HIGH_TOPIC_PATTERN = /wzr[oó]s|ro[sś]n|r[oó]s[lł]|wysok|hiper|hyper|skok|skocz|w g[oó]r[eę]|szczyt|powy[zż]ej|\bhigh|\bris(?:e|ing)\b|\bpeak|\bspike/;

export function isHighTopicQuestion(text: string): boolean {
  return HIGH_TOPIC_PATTERN.test(String(text ?? '').toLowerCase());
}

export interface PrecomputedDailyEvidence {
  policy_version: 'precomputed-daily-evidence.v1';
  detail_level: 'SUMMARY' | 'SUMMARY_WITH_SIGNIFICANT_EVENTS';
  note: string;
  days: Array<{
    window: { from: string; to: string };
    /** false: only the glucose summary of this day is included (the question is about another day). */
    in_focus: boolean;
    domains: Array<{ tool: string; status: string; evidence: unknown; coverage: unknown; limitations: unknown }>;
  }>;
}

/**
 * Days the conversation is about, as offsets from the last day of the range (0 that day, -1 the day before), read from
 * the question and the last user messages: today, yesterday, a weekday, a calendar date ("w piątek", "15 października"),
 * each counted from when that message was sent. Empty when no day is named: then every day of the range is in focus.
 */
function focusDayOffsets(context: TimeRangeAnalysisContextRecord): Set<number> {
  const input = context.analysis_request_input;
  const timezone = String(input.timezone ?? '');
  const lastDay = localDateKey(String(input.range_end), timezone);
  const texts: Array<{ text: string; at: string }> = [
    { text: input.user_message_text, at: String(input.requested_at ?? input.range_end) },
    ...context.conversation_context.messages.filter((message) => message.role === 'USER').slice(-3).reverse()
      .map((message) => ({ text: message.content, at: message.created_at || String(input.requested_at ?? input.range_end) })),
  ];
  const offsets = new Set<number>();
  for (const { text: raw, at } of texts) {
    if (lastDay) {
      for (const date of namedFocusDates(String(raw ?? ''), at, timezone)) offsets.add(localDateKeyDiffDays(lastDay, date));
    } else {
      // No usable timezone: the day words alone, counted from the range end.
      const text = String(raw ?? '').toLowerCase();
      if (/przedwczoraj|day before yesterday/.test(text)) offsets.add(-2);
      if (/(^|[^a-ząćęłńóśźż])wczoraj|yesterday/.test(text.replace(/przedwczoraj/g, ''))) offsets.add(-1);
      if (/dzisiaj|dziś|dzis\b|today|teraz|rano dzi/.test(text)) offsets.add(0);
    }
    if (offsets.size > 0) break;
  }
  return offsets;
}

/**
 * Deterministic SUMMARY-level glucose, insulin and meal evidence for each day window of a short requested range, built
 * with the same evidence tools the model could call (same validation and compilers), so a typical question can be
 * answered in one provider call. Windows are the local calendar days of the range; the last one ends at the range end. Tool statuses (KNOWN, MISSING, ...) are passed through unchanged.
 */
export function buildPrecomputedDailyEvidence(args: {
  task: AiTask;
  context: TimeRangeAnalysisContextRecord;
  toolContext: Record<string, unknown>;
  registry: ReturnType<typeof createEvidenceToolRegistry>;
  /** See isTimeRangePrefetchEnabled. */
  prefetch?: boolean;
}): PrecomputedDailyEvidence | null {
  const input = args.context.analysis_request_input as { range_type?: string; range_start?: string; range_end?: string; timezone?: string } | undefined;
  if (!input?.range_type || !PRECOMPUTED_DAILY_EVIDENCE_RANGE_TYPES.has(input.range_type)) return null;
  const startMs = Date.parse(String(input.range_start));
  const endMs = Date.parse(String(input.range_end));
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null;

  // Local calendar days (23/25 h on DST changes); consecutive 24 h slices when the timezone is unusable.
  const localDays = localDayWindows(String(input.range_start), String(input.range_end), String(input.timezone ?? ''));
  const windows: Array<{ from: string; to: string }> = localDays.map((day) => ({ from: day.from, to: day.to }));
  if (windows.length === 0) {
    for (let fromMs = startMs; fromMs < endMs; fromMs += DAY_MS) {
      windows.push({ from: new Date(fromMs).toISOString(), to: new Date(Math.min(fromMs + DAY_MS, endMs)).toISOString() });
    }
  }
  // Windows are consecutive days ending today: the last one is offset 0, the one before -1, and so on.
  const focus = focusDayOffsets(args.context);
  const prefetch = args.prefetch === true;
  // Hypo questions over several days: the days with an episode are the ones the answer is about.
  const hypoDays = prefetch && isHypoTopicQuestion(args.context.analysis_request_input.user_message_text ?? '')
    ? new Set(windows.flatMap((window, index) => (args.context.analytical_evidence.hypo_episodes.some((episode) => {
      const startedMs = Date.parse(String(episode.started_at ?? ''));
      return startedMs >= Date.parse(window.from) && startedMs < Date.parse(window.to);
    }) ? [index] : [])))
    : new Set<number>();
  const days: PrecomputedDailyEvidence['days'] = [];
  for (const [index, window] of windows.entries()) {
    const inFocus = hypoDays.has(index)
      || (focus.size === 0 ? windows.length <= PRECOMPUTED_FULL_DAYS_WITHOUT_FOCUS : focus.has(index - (windows.length - 1)));
    // Basal is not prefetched per day: its summary lists every temp basal (~10 KB a day with Trio) and the delivered
    // basal of each day is already in daily_insulin_totals.
    const tools: readonly string[] = inFocus ? PRECOMPUTED_DAILY_EVIDENCE_TOOLS : ['get_glucose_evidence'];
    const domains = tools.map((toolName) => {
      const request = normalizeEvidenceToolRequest({
        task: args.task,
        context: args.context,
        toolName,
        // Glucose of a day in focus with its significant events (lows, highs, sharp changes) instead of the summary only.
        toolCallArguments: { time_range: window, detail_level: prefetch && inFocus && toolName === 'get_glucose_evidence' ? 'SIGNIFICANT_EVENTS' : 'SUMMARY' },
      });
      const response = args.registry.execute(request, args.toolContext);
      return boundToolResultForProvider(compactSourceRefListsForProvider({
        tool: response.tool,
        status: response.status,
        evidence: response.evidence,
        coverage: response.coverage,
        limitations: response.limitations,
      }));
    });
    days.push({ window, in_focus: inFocus, domains });
  }
  return {
    policy_version: 'precomputed-daily-evidence.v1',
    detail_level: prefetch ? 'SUMMARY_WITH_SIGNIFICANT_EVENTS' : 'SUMMARY',
    note: prefetch
      ? 'Deterministic evidence for each day of the requested range: for the days in focus glucose with its significant events, insulin and meals; glucose summary only for the others (their insulin and meals can be requested with the tools). Delivered basal per day is in daily_insulin_totals. A MISSING or UNKNOWN status means the data is unknown, not that no event happened.'
      : 'Deterministic summaries for each day of the requested range: glucose, insulin and meals for the days in focus, glucose only for the others (their insulin and meals can be requested with the tools). A MISSING or UNKNOWN status means the data is unknown, not that no event happened.',
    days,
  };
}

/** Widest window of one glucose DETAIL/TRAJECTORY request (every reading is sent). A cost bound, not a clinical one. */
export const GLUCOSE_DETAIL_MAX_RANGE_MS = 6 * 60 * 60 * 1000;
const SAME_WINDOW_TOLERANCE_MS = 60 * 1000;

/**
 * Answers a tool request without running it when it would only cost tokens: a glucose DETAIL/TRAJECTORY request wider
 * than GLUCOSE_DETAIL_MAX_RANGE_MS (the model is asked to narrow it), or a summary that precomputed_daily_evidence
 * already holds for exactly that day. Null when the request should run normally.
 */
export function shortCircuitToolRequest(
  request: { tool: string; time_range: { from: string; to: string }; detail_level: string },
  precomputed: PrecomputedDailyEvidence | null,
): { reason: 'REQUEST_TOO_WIDE' | 'ALREADY_PROVIDED'; result: Record<string, unknown> } | null {
  const fromMs = Date.parse(request.time_range.from);
  const toMs = Date.parse(request.time_range.to);
  if (request.tool === 'get_glucose_evidence' && (request.detail_level === 'DETAIL' || request.detail_level === 'TRAJECTORY')
    && toMs - fromMs > GLUCOSE_DETAIL_MAX_RANGE_MS) {
    return {
      reason: 'REQUEST_TOO_WIDE',
      result: {
        tool: request.tool,
        status: 'REQUEST_TOO_WIDE',
        requested_range: request.time_range,
        limitations: ['DETAIL and TRAJECTORY return every reading, so one request may cover at most 6 hours. Request a narrower window around the event of interest; for a whole day use SIGNIFICANT_EVENTS or the daily summaries.'],
      },
    };
  }
  // A whole 14- or 30-day range in one request would be rejected by the tool and fail the answer.
  if (toMs - fromMs > EVIDENCE_TOOL_REQUEST_MAX_MS) {
    return {
      reason: 'REQUEST_TOO_WIDE',
      result: {
        tool: request.tool,
        status: 'REQUEST_TOO_WIDE',
        requested_range: request.time_range,
        limitations: ['One request may cover at most 24 hours. For the whole range use the aggregates already in selected_evidence; request single days only where a day needs more detail.'],
      },
    };
  }
  const isSummaryLevel = request.detail_level === 'SUMMARY' || (request.tool === 'get_glucose_evidence' && request.detail_level === 'SIGNIFICANT_EVENTS');
  if (precomputed && isSummaryLevel) {
    const day = precomputed.days.find((entry) => Math.abs(Date.parse(entry.window.from) - fromMs) <= SAME_WINDOW_TOLERANCE_MS
      && Math.abs(Date.parse(entry.window.to) - toMs) <= SAME_WINDOW_TOLERANCE_MS
      && entry.domains.some((domain) => domain.tool === request.tool));
    if (day) {
      return {
        reason: 'ALREADY_PROVIDED',
        result: {
          tool: request.tool,
          status: 'ALREADY_PROVIDED',
          requested_range: request.time_range,
          limitations: [`This is the same evidence as tool_loop_state.precomputed_daily_evidence for the day ${day.window.from} - ${day.window.to}: use it from there. Request DETAIL for a narrower window if you need individual records.`],
        },
      };
    }
  }
  return null;
}

const PRE_HYPO_EVIDENCE_TOOLS = ['get_insulin_evidence', 'get_basal_evidence'] as const;
/** Upper bound of one evidence tool request (the tools' own max_range_ms), not a clinical window. */
const EVIDENCE_TOOL_MAX_RANGE_MS = 24 * 60 * 60 * 1000;
/**
 * What a single request may actually span: one local day, which is 25 h on the autumn DST change (the daily summaries
 * are cut at local midnights, and the model asks for whole days).
 */
const EVIDENCE_TOOL_REQUEST_MAX_MS = EVIDENCE_TOOL_MAX_RANGE_MS + 60 * 60 * 1000;

export type PreHypoDataAvailability =
  | 'RECORDS_FOUND'
  | 'NO_RECORDS_IN_SOURCE_FOR_WINDOW'
  | 'NOT_SELECTED'
  | 'NOT_ACCESSIBLE';

export interface PreHypoEvidence {
  policy_version: 'pre-hypo-evidence.v1';
  status: 'KNOWN' | 'NO_HYPO_EPISODES_IN_RANGE' | 'DIA_MISSING' | 'DIA_UNAVAILABLE';
  dia_hours: number | null;
  note: string;
  windows: Array<{
    window: { from: string; to: string };
    episode_ids: string[];
    clipped_to_range_start: boolean;
    capped_to_tool_max_range: boolean;
    /** The conversation names a time within 30 min of one of its episodes (these windows are included first). */
    mentioned_in_conversation: boolean;
    /** false: left out by the size budget; its evidence can be requested with the insulin/basal tools. */
    included: boolean;
    domains: Array<{ tool: string; status: string; availability: PreHypoDataAvailability; evidence: unknown; coverage: unknown; limitations: unknown }>;
  }>;
}

/**
 * Size budget of the whole pre-hypo block in the first request (UTF-8 bytes). A cost policy: the per-call cost guard
 * bounds input tokens by request bytes, so the first request (prompt, daily summaries and this block) must stay well
 * under its limit. Windows that do not fit are listed as not included, never silently dropped.
 */
export const PRE_HYPO_EVIDENCE_MAX_BYTES = 32 * 1024;
/** How close a time named in the conversation must be to an episode start to count as a mention. */
const PRE_HYPO_MENTION_TOLERANCE_MINUTES = 30;

function minutesOfDayIn(timezone: string, iso: string): number | null {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(iso));
    const hour = Number(parts.find((part) => part.type === 'hour')?.value);
    const minute = Number(parts.find((part) => part.type === 'minute')?.value);
    return Number.isFinite(hour) && Number.isFinite(minute) ? hour * 60 + minute : null;
  } catch {
    return null;
  }
}

/** Clock times ("10:28", "16.18") in the question and the last few messages of the conversation, as minutes of day. */
function mentionedClockMinutes(context: TimeRangeAnalysisContextRecord): number[] {
  const texts = [context.analysis_request_input.user_message_text, ...context.conversation_context.messages.slice(-4).map((message) => message.content)];
  const minutes: number[] = [];
  for (const text of texts) {
    for (const match of String(text ?? '').matchAll(/\b([01]?\d|2[0-3])[:.]([0-5]\d)\b/g)) {
      minutes.push(Number(match[1]) * 60 + Number(match[2]));
    }
  }
  return minutes;
}

/**
 * Number of records a tool response holds, or null when the shape is not recognised. The insulin tool reports KNOWN
 * with event_count 0 for an empty window, so the status alone cannot tell "no records" from "records found".
 */
function countPreHypoRecords(evidence: unknown): number | null {
  const record = (evidence ?? {}) as Record<string, unknown>;
  const summary = record.summary as Record<string, unknown> | undefined;
  if (typeof summary?.event_count === 'number') return summary.event_count;
  if (Array.isArray(record.actual_temp_basal)) return record.actual_temp_basal.length;
  if (Array.isArray(record.events)) return record.events.length;
  return null;
}

function preHypoAvailability(status: string, partlyNotSelected: boolean, recordCount: number | null): PreHypoDataAvailability {
  switch (status) {
    case 'KNOWN':
    case 'PARTIAL_DATA':
    case 'UNKNOWN':
    case 'INSUFFICIENT_DATA':
      if (recordCount === 0) return partlyNotSelected ? 'NOT_SELECTED' : 'NO_RECORDS_IN_SOURCE_FOR_WINDOW';
      return 'RECORDS_FOUND';
    case 'MISSING':
      return partlyNotSelected ? 'NOT_SELECTED' : 'NO_RECORDS_IN_SOURCE_FOR_WINDOW';
    case 'NOT_SELECTED':
    case 'EXCLUDED':
      return 'NOT_SELECTED';
    default:
      return 'NOT_ACCESSIBLE';
  }
}

/**
 * For causal questions: insulin (bolus/SMB) and basal evidence at DETAIL level for the look-back window before each hypo
 * episode of the range, the window being the patient's own duration of insulin action (therapy profile DIA), never a
 * default. Overlapping windows are merged so no event is sent twice. Each domain states why data is absent:
 * NO_RECORDS_IN_SOURCE_FOR_WINDOW (selection complete, nothing recorded), NOT_SELECTED (outside the analysed range or
 * the selection hit its row limit), NOT_ACCESSIBLE (the tool refused or failed).
 */
export function buildPreHypoEvidence(args: {
  task: AiTask;
  context: TimeRangeAnalysisContextRecord;
  toolContext: Record<string, unknown>;
  registry: ReturnType<typeof createEvidenceToolRegistry>;
}): PreHypoEvidence {
  const therapy = args.context.therapy_context;
  const rangeStartMs = Date.parse(args.context.analysis_request_input.range_start);
  const episodes = (args.context.analytical_evidence.hypo_episodes ?? [])
    .map((episode) => ({ id: String((episode as Record<string, unknown>).episode_id ?? ''), startMs: Date.parse(String((episode as Record<string, unknown>).started_at ?? '')) }))
    .filter((episode) => Number.isFinite(episode.startMs))
    .sort((left, right) => left.startMs - right.startMs);
  const base = { policy_version: 'pre-hypo-evidence.v1' as const, dia_hours: therapy?.dia_hours ?? null, windows: [] };
  if (!therapy || therapy.status === 'UNAVAILABLE') {
    return { ...base, status: 'DIA_UNAVAILABLE', note: 'The therapy profile could not be read, so the insulin look-back window before the hypoglycaemia could not be determined (no access), not because no insulin was given.' };
  }
  if (therapy.status !== 'KNOWN' || !(typeof therapy.dia_hours === 'number' && therapy.dia_hours > 0)) {
    return { ...base, status: 'DIA_MISSING', note: 'No duration of insulin action is recorded in the therapy profile, so the insulin look-back window before the hypoglycaemia could not be determined.' };
  }
  if (episodes.length === 0) {
    return { ...base, status: 'NO_HYPO_EPISODES_IN_RANGE', note: 'No hypoglycaemia episode was recorded in the analysed range.' };
  }

  const diaMs = therapy.dia_hours * 60 * 60 * 1000;
  const lookBackMs = Math.min(diaMs, EVIDENCE_TOOL_MAX_RANGE_MS);
  const merged: Array<{ fromMs: number; toMs: number; episodeIds: string[]; clipped: boolean }> = [];
  for (const episode of episodes) {
    const wantedFromMs = episode.startMs - lookBackMs;
    const fromMs = Math.max(wantedFromMs, rangeStartMs);
    const toMs = episode.startMs;
    if (toMs <= fromMs) {
      merged.push({ fromMs: toMs, toMs, episodeIds: [episode.id], clipped: true });
      continue;
    }
    const last = merged[merged.length - 1];
    if (last && fromMs <= last.toMs && toMs - last.fromMs <= EVIDENCE_TOOL_MAX_RANGE_MS) {
      last.toMs = Math.max(last.toMs, toMs);
      last.episodeIds.push(episode.id);
      last.clipped = last.clipped || wantedFromMs < rangeStartMs;
    } else {
      merged.push({ fromMs, toMs, episodeIds: [episode.id], clipped: wantedFromMs < rangeStartMs });
    }
  }

  const windows = merged.map((entry) => {
    const window = { from: new Date(entry.fromMs).toISOString(), to: new Date(entry.toMs).toISOString() };
    const domains = PRE_HYPO_EVIDENCE_TOOLS.map((toolName) => {
      if (entry.toMs <= entry.fromMs) {
        return { tool: toolName, status: 'NOT_SELECTED', availability: 'NOT_SELECTED' as const, evidence: null, coverage: null, limitations: ['The look-back window lies before the analysed range, so its events were not selected.'] };
      }
      let response: ReturnType<typeof args.registry.execute>;
      try {
        response = args.registry.execute(normalizeEvidenceToolRequest({
          task: args.task,
          context: args.context,
          toolName,
          toolCallArguments: { time_range: window, detail_level: 'DETAIL' },
        }), args.toolContext);
      } catch (error) {
        return { tool: toolName, status: 'FAILED', availability: 'NOT_ACCESSIBLE' as const, evidence: null, coverage: null, limitations: ['The evidence tool failed for this window: the data could not be accessed.'] };
      }
      // Part of the window outside the loaded events (the tools list it in not_selected_ranges): no records is not "none".
      const partlyNotSelected = Array.isArray((response.evidence as Record<string, unknown>)?.not_selected_ranges);
      const availability = preHypoAvailability(response.status, partlyNotSelected, countPreHypoRecords(response.evidence));
      return boundToolResultForProvider(compactSourceRefListsForProvider({
        tool: response.tool,
        status: response.status,
        availability,
        evidence: response.evidence,
        coverage: response.coverage,
        limitations: response.limitations,
      }));
    });
    return {
      window,
      episode_ids: entry.episodeIds,
      clipped_to_range_start: entry.clipped,
      capped_to_tool_max_range: diaMs > EVIDENCE_TOOL_MAX_RANGE_MS,
      mentioned_in_conversation: false,
      included: true,
      domains,
    };
  });

  // Windows of episodes the conversation talks about come first, then the most recent; whatever does not fit the
  // size budget is listed (window and episodes) without its records.
  const timezone = args.context.analysis_request_input.timezone || 'UTC';
  const mentioned = mentionedClockMinutes(args.context);
  const episodeStartById = new Map(episodes.map((episode) => [episode.id, new Date(episode.startMs).toISOString()]));
  for (const window of windows) {
    window.mentioned_in_conversation = mentioned.length > 0 && window.episode_ids.some((id) => {
      const start = episodeStartById.get(id);
      const startMinutes = start ? minutesOfDayIn(timezone, start) : null;
      return startMinutes !== null && mentioned.some((minute) => {
        const distance = Math.abs(minute - startMinutes);
        return Math.min(distance, 24 * 60 - distance) <= PRE_HYPO_MENTION_TOLERANCE_MINUTES;
      });
    });
  }
  const prioritized = [...windows].sort((left, right) => Number(right.mentioned_in_conversation) - Number(left.mentioned_in_conversation)
    || Date.parse(right.window.to) - Date.parse(left.window.to));
  let usedBytes = 0;
  const budgeted = prioritized.map((window) => {
    const size = Buffer.byteLength(JSON.stringify(window), 'utf8');
    if (usedBytes + size <= PRE_HYPO_EVIDENCE_MAX_BYTES) {
      usedBytes += size;
      return window;
    }
    return { ...window, included: false, domains: [] };
  });
  const omitted = budgeted.filter((window) => !window.included).length;
  return {
    ...base,
    status: 'KNOWN',
    note: `Insulin and basal evidence for the duration of insulin action before each hypoglycaemia episode, episodes named in the conversation first. clipped_to_range_start: the earlier part of the window was not selected.${omitted > 0 ? ` ${omitted} window(s) have included=false because of the size budget: their records were not loaded here (not absent) and can be requested with get_insulin_evidence / get_basal_evidence for that window.` : ''}`,
    windows: budgeted,
  };
}

/**
 * The model may echo local times with an offset ("2026-10-18T11:20+02:00"); the tools work in UTC ISO. A time without
 * an offset or Z is the patient's local time (the range's zone), never the server's.
 */
export function toUtcIsoIfParseable(value: string, timeZone?: string | null): string {
  const naive = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/.exec(value.trim());
  if (naive && timeZone) {
    const [, y, mo, d, h, mi, sec] = naive.map(Number);
    const wall = Date.UTC(y, mo - 1, d, h, mi, Number.isFinite(sec) ? sec : 0);
    // The zone's offset at that wall time (twice: the first guess may sit across a DST change).
    let utc = wall - zoneOffsetMs(wall, timeZone);
    utc = wall - zoneOffsetMs(utc, timeZone);
    return Number.isFinite(utc) ? new Date(utc).toISOString() : value;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : value;
}

function zoneOffsetMs(utcMs: number, timeZone: string): number {
  try {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(new Date(utcMs)).filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)]));
    return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - Math.floor(utcMs / 1000) * 1000;
  } catch {
    return 0;
  }
}

function normalizeEvidenceToolRequest(args: {
  task: AiTask;
  context: TimeRangeAnalysisContextRecord;
  toolName: string;
  toolCallArguments: Record<string, unknown>;
}): {
  tool:
    | 'get_glucose_evidence'
    | 'get_insulin_evidence'
    | 'get_basal_evidence'
    | 'get_meal_evidence'
    | 'get_activity_evidence'
    | 'get_loop_evidence'
    | 'get_therapy_profile';
  patient_id: string;
  time_range: { from: string; to: string };
  detail_level: 'SUMMARY' | 'SIGNIFICANT_EVENTS' | 'DETAIL' | 'TRAJECTORY';
  task_context: { task_type: string };
  constraints: { max_range_ms: number };
} {
  const allowedKeys = new Set(['time_range', 'detail_level']);
  for (const key of Object.keys(args.toolCallArguments)) {
    if (!allowedKeys.has(key)) {
      throw new AiExecutionError(`Forbidden tool parameter: ${key}`, 'AI_CONTRACT_VIOLATION', false);
    }
  }

  const patientId = args.context.patient_ref.patient_id;
  const fallbackRange = {
    from: args.context.analysis_request_input.range_start,
    to: args.context.analysis_request_input.range_end,
  };

  const timeRangeArg = args.toolCallArguments.time_range;
  const timeRange = (
    timeRangeArg
    && typeof timeRangeArg === 'object'
    && !Array.isArray(timeRangeArg)
    && typeof (timeRangeArg as Record<string, unknown>).from === 'string'
    && typeof (timeRangeArg as Record<string, unknown>).to === 'string'
  )
    ? {
      from: toUtcIsoIfParseable(String((timeRangeArg as Record<string, unknown>).from), args.context.analysis_request_input.timezone),
      to: toUtcIsoIfParseable(String((timeRangeArg as Record<string, unknown>).to), args.context.analysis_request_input.timezone),
    }
    : fallbackRange;

  const detailRaw = typeof args.toolCallArguments.detail_level === 'string'
    ? args.toolCallArguments.detail_level
    : 'SUMMARY';
  const allowedDetails = args.toolName === 'get_glucose_evidence'
    ? new Set(['SUMMARY', 'SIGNIFICANT_EVENTS', 'DETAIL', 'TRAJECTORY'])
    : args.toolName === 'get_insulin_evidence'
      ? new Set(['SUMMARY', 'SIGNIFICANT_EVENTS', 'DETAIL'])
      : args.toolName === 'get_basal_evidence'
        ? new Set(['SUMMARY', 'DETAIL'])
    : args.toolName === 'get_meal_evidence'
      ? new Set(['SUMMARY', 'SIGNIFICANT_EVENTS', 'DETAIL'])
    : args.toolName === 'get_activity_evidence'
      ? new Set(['SUMMARY', 'SIGNIFICANT_EVENTS', 'DETAIL'])
    : args.toolName === 'get_loop_evidence'
      ? new Set(['SUMMARY', 'DETAIL'])
    : args.toolName === 'get_therapy_profile'
      ? new Set(['SUMMARY', 'DETAIL'])
        : null;
  if (!allowedDetails || !allowedDetails.has(detailRaw)) {
    throw new AiExecutionError(`Unsupported detail level: ${String(detailRaw)}`, 'AI_CONTRACT_VIOLATION', false);
  }

  if (
    args.toolName !== 'get_glucose_evidence'
    && args.toolName !== 'get_insulin_evidence'
    && args.toolName !== 'get_basal_evidence'
    && args.toolName !== 'get_meal_evidence'
    && args.toolName !== 'get_activity_evidence'
    && args.toolName !== 'get_loop_evidence'
    && args.toolName !== 'get_therapy_profile'
  ) {
    throw new AiExecutionError(`Unsupported evidence tool requested: ${args.toolName}`, 'AI_CONTRACT_VIOLATION', false);
  }

  return {
    tool: args.toolName,
    patient_id: patientId,
    time_range: timeRange,
    detail_level: detailRaw as 'SUMMARY' | 'SIGNIFICANT_EVENTS' | 'DETAIL' | 'TRAJECTORY',
    task_context: { task_type: args.task.task_type },
    constraints: { max_range_ms: EVIDENCE_TOOL_REQUEST_MAX_MS },
  };
}

function buildEvidenceToolContextFromTimeRangePackage(context: TimeRangeAnalysisContextRecord): Record<string, unknown> {
  const glucoseRows = context.analytical_evidence.glucose_events.map((event, index) => {
    const record = event as Record<string, unknown>;
    const payload = (record.payload ?? {}) as Record<string, unknown>;
    const rawPayload = (payload.raw_payload ?? {}) as Record<string, unknown>;
    const glucoseCandidate = [
      payload.glucose_value,
      payload.glucose,
      rawPayload.sgv,
      rawPayload.glucose,
    ].find((value) => typeof value === 'number');
    const glucoseValue = typeof glucoseCandidate === 'number' && Number.isFinite(glucoseCandidate)
      ? glucoseCandidate
      : null;

    return {
      reading_id: `time-range-glucose-${index + 1}`,
      source_record_id: typeof record.source_record_id === 'string' ? record.source_record_id : `time-range-source-${index + 1}`,
      observed_at: typeof record.occurred_at === 'string' ? record.occurred_at : context.analysis_request_input.range_start,
      recorded_at: typeof record.occurred_at === 'string' ? record.occurred_at : context.analysis_request_input.range_start,
      glucose_value: glucoseValue,
      glucose_unit: 'mg/dL',
      classification: 'UNKNOWN',
      relation_to_episode: 'ONGOING',
      validity: 'VALID',
      provenance_ref: typeof record.event_id === 'string' ? `event/${record.event_id}` : `event/time-range-${index + 1}`,
    };
  }).filter((row) => typeof row.glucose_value === 'number');

  return {
    patient_ref: { patient_id: context.patient_ref.patient_id },
    glucose_evidence: glucoseRows,
    insulin_treatment_events: context.analytical_evidence.insulin_treatment_events,
    treatment_events: context.analytical_evidence.insulin_treatment_events,
    temp_basal_events: context.analytical_evidence.insulin_treatment_events,
    meal_events: context.analytical_evidence.meal_events,
    meal_records: context.analytical_evidence.meal_records ?? null,
    fat_protein_unit_carb_events: context.analytical_evidence.fat_protein_unit_carb_events ?? [],
    activity_events: context.analytical_evidence.activity_events,
    event_context_facts: context.analytical_evidence.range_event_facts,
    current_state_snapshot: context.current_state_snapshot ?? null,
    // Profile valid at the range end; null (tools report it MISSING, or UNKNOWN when it could not be read) without one.
    active_therapy_snapshot: therapySnapshotFromProfile(context.therapy_profile, context.analysis_request_input.timezone),
    ...(context.therapy_profile?.status === 'UNAVAILABLE' ? { therapy_profile_status: 'UNAVAILABLE' } : {}),
    loaded_range: loadedRangeOfTimeRangeContext(context),
  };
}

/**
 * The window whose events the context holds: the analysed range, or from its oldest selected event when the selection
 * was cut by its row limit (the most recent events are kept). Tools answer NOT_SELECTED outside it.
 */
export function loadedRangeOfTimeRangeContext(context: TimeRangeAnalysisContextRecord): { from: string; to: string } {
  const range = { from: context.analysis_request_input.range_start, to: context.analysis_request_input.range_end };
  const selection = context.analytical_evidence.selection;
  if (!selection?.truncated) return range;
  const evidence = context.analytical_evidence;
  const oldestSelectedMs = selection.selected_from
    ? Date.parse(selection.selected_from)
    : Math.min(...[evidence.glucose_events, evidence.insulin_treatment_events, evidence.meal_events, evidence.activity_events]
      .flat()
      .map((event) => Date.parse(String((event as Record<string, unknown>).occurred_at ?? '')))
      .filter(Number.isFinite));
  return Number.isFinite(oldestSelectedMs) && oldestSelectedMs > Date.parse(range.from)
    ? { from: new Date(oldestSelectedMs).toISOString(), to: range.to }
    : range;
}

/** The context's therapy profile in the shape the evidence tools read; null unless it is KNOWN. */
function therapySnapshotFromProfile(profile: TimeRangeAnalysisContextRecord['therapy_profile'], requestTimezone: string): Record<string, unknown> | null {
  if (!profile || profile.status !== 'KNOWN') return null;
  // [["00:00", 0.4], ...] -> { "00:00": 0.4, ... }
  const schedule = (entries: Array<[string, number]> | null) => (entries
    ? Object.fromEntries(entries.map(([time, value]) => [/^(\d{1,2}:\d{2})/.exec(String(time))?.[1] ?? String(time), value]))
    : null);
  return {
    therapy_id: profile.therapy_id,
    therapy_version: profile.valid_from ?? profile.therapy_id,
    active_profile_id: profile.therapy_id,
    valid_from: profile.valid_from,
    units: profile.units,
    timezone: profile.timezone ?? requestTimezone,
    basal_schedule: schedule(profile.basal_u_per_h) ?? {},
    icr_schedule: schedule(profile.carb_ratio_g_per_u),
    isf_schedule: schedule(profile.sensitivity_per_u),
    target_schedule: profile.target_low || profile.target_high ? { low: schedule(profile.target_low), high: schedule(profile.target_high) } : null,
    dia: profile.dia_hours,
  };
}

function validateTaskContextCompatibility(
  task: AiTask,
  contextPackage: AiContextPackage,
): void {
  if (
    contextPackage.context_package_id !== task.context_package_id
    || contextPackage.context_package_version !== task.context_package_version
    || contextPackage.content_hash !== task.context_package_hash
  ) {
    throw new AiExecutionError('AI context package validation failed', 'AI_CONTEXT_VALIDATION_FAILED', false, {
      reason: 'task_context_mismatch',
    });
  }

  if (task.task_type === CONVERSATION_DIRECT_RESPONSE_TASK_TYPE) {
    const direct = contextPackage as DirectResponseContextRecord;
    if (!direct.direct_response_input?.user_message_id || !direct.direct_response_input?.user_message_text) {
      throw new AiExecutionError('AI context package validation failed', 'AI_CONTEXT_VALIDATION_FAILED', false, {
        reason: 'direct_response_context_missing_user_message',
      });
    }

    return;
  }

  if (task.task_type === CONVERSATION_TIME_RANGE_ANALYSIS_TASK_TYPE) {
    const timeRangeContext = contextPackage as TimeRangeAnalysisContextRecord;
    if (!timeRangeContext.analysis_request_input?.user_message_id || !timeRangeContext.analysis_request_input?.range_start || !timeRangeContext.analysis_request_input?.range_end) {
      throw new AiExecutionError('AI context package validation failed', 'AI_CONTEXT_VALIDATION_FAILED', false, {
        reason: 'time_range_context_missing_request_fields',
      });
    }

    return;
  }
}

function describeProvider(provider: AiProvider, tier?: AiModelTier): { provider: string; model: string } {
  const maybe = provider as Partial<{ providerName: string; provider_name: string; model: string; model_name: string; describeTier: (tier: AiModelTier | undefined) => { provider: string; model: string } }>;
  // A tiered provider names the model of the chosen tier.
  if (tier && typeof maybe.describeTier === 'function') return maybe.describeTier(tier);
  return {
    provider: maybe.providerName ?? maybe.provider_name ?? 'unknown',
    model: maybe.model ?? maybe.model_name ?? 'unknown',
  };
}

function classifyAttemptFailure(
  error: unknown,
  providerIdentity: { provider: string; model: string },
  taskIdentity: string,
  startedAt: string,
  completedAt: Date,
  attemptId: string | null,
): {
  attempt_id: string | null;
  task_identity: string;
  provider: string;
  model: string;
  started_at: string;
  completed_at: string;
  provider_latency_ms: number | null;
  error_type: string;
  error_code?: string | null;
} {
  if (error instanceof AiExecutionError) {
    return {
      attempt_id: attemptId,
      task_identity: taskIdentity,
      provider: providerIdentity.provider,
      model: providerIdentity.model,
      started_at: startedAt,
      completed_at: completedAt.toISOString(),
      provider_latency_ms: Math.max(0, completedAt.getTime() - new Date(startedAt).getTime()),
      error_type: error.code,
      error_code: (error.details as { provider_code?: string } | undefined)?.provider_code ?? null,
    };
  }

  if (error instanceof AiProviderError) {
    return {
      attempt_id: attemptId,
      task_identity: taskIdentity,
      provider: providerIdentity.provider,
      model: providerIdentity.model,
      started_at: startedAt,
      completed_at: completedAt.toISOString(),
      provider_latency_ms: Math.max(0, completedAt.getTime() - new Date(startedAt).getTime()),
      error_type: error.retryable ? 'AI_PROVIDER_RETRYABLE' : 'AI_PROVIDER_NON_RETRYABLE',
      error_code: error.code ?? null,
    };
  }

  return {
    attempt_id: attemptId,
    task_identity: taskIdentity,
    provider: providerIdentity.provider,
    model: providerIdentity.model,
    started_at: startedAt,
    completed_at: completedAt.toISOString(),
    provider_latency_ms: Math.max(0, completedAt.getTime() - new Date(startedAt).getTime()),
    error_type: 'AI_PROVIDER_RETRYABLE',
    error_code: null,
  };
}

function cancelledExecutionError(): AiExecutionError {
  return new AiExecutionError('AI execution cancelled', 'AI_CANCELLED', false);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  let timeoutHandle: NodeJS.Timeout | null = null;
  let onAbort: (() => void) | null = null;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new AiExecutionError('AI provider timeout', 'AI_TIMEOUT', true, { timeout_ms: timeoutMs }));
    }, timeoutMs);
  });
  // Stop waiting at once even if a provider ignores the signal; the HTTP request itself is aborted by the provider.
  const abortPromise = new Promise<never>((_, reject) => {
    if (!signal) return;
    onAbort = () => reject(cancelledExecutionError());
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });

  try {
    return await Promise.race(signal ? [promise, timeoutPromise, abortPromise] : [promise, timeoutPromise]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
    if (signal && onAbort) {
      signal.removeEventListener('abort', onAbort);
    }
  }
}

export interface DirectResponseBoundaryFlag {
  rule: 'INTERNAL_CONTEXT_EXPOSURE' | 'HISTORICAL_AS_TODAY' | 'NO_ACTIVITY_INSTEAD_OF_MISSING';
  /** The matched text, at most 160 characters. */
  fragment: string;
}

/**
 * Wording a time-range answer should avoid (internal machinery, history presented as today, "no activity" instead of
 * missing activity data). Each match is reported once per rule; the answer itself is kept.
 */
export function findDirectResponseBoundaryFlags(
  result: DirectResponseAiResult,
  taskType: typeof CONVERSATION_DIRECT_RESPONSE_TASK_TYPE | typeof CONVERSATION_TIME_RANGE_ANALYSIS_TASK_TYPE,
): DirectResponseBoundaryFlag[] {
  // Dose and settings suggestions are allowed in conversations (therapy-suggestion-policy.ts): no dosing-language gate.
  if (taskType !== CONVERSATION_TIME_RANGE_ANALYSIS_TASK_TYPE) {
    return [];
  }
  const text = result.assistant_message.toLowerCase();

  const rules: Array<{ rule: DirectResponseBoundaryFlag['rule']; patterns: RegExp[] }> = [
    {
      rule: 'INTERNAL_CONTEXT_EXPOSURE',
      patterns: [
        /odnotowano\s+w\s+opisach\s+kontekstowych/i,
        /w\s+opisach\s+kontekstowych/i,
        /wcze(?:ś|s)niej\s+odpowiedzia(?:łeś|las|łaś)/i,
        /w\s+poprzednim\s+pytaniu\s+poda(?:łeś|las|łaś)/i,
        /odpowiedzia(?:łeś|las|łaś),\s*(?:ż|z)e/i,
        /zebrany\s+kontekst\s+wskazuje/i,
        /(?:^|\s)(?:fakt|aktywno(?:ść|sc)|spadek|hipo|posi(?:ł|l)ek|insulin(?:a|y|ę))[^.]{0,90}(?:by(?:ł|l|ła|la|ło|lo|li)?\s+)?zgłoszon(?:a|e|y)?(?:\s|[.,;:]|$)/i,
        /\b(?:stored\s+as\s+context|contextual\s+descriptions|remembered\s+by\s+the\s+system)\b/i,
        /\b(?:reported|recorded|collected|answered|provided)\b[^.]{0,100}\b(?:in|from|via|through)\b[^.]{0,100}\b(?:context|contextual\s+descriptions?|previous\s+answers?|previous\s+questions?|questionnaire|investigation\s+flow|memory)\b/i,
      ],
    },
    {
      rule: 'HISTORICAL_AS_TODAY',
      patterns: [
        /(?:dzisiaj|dzisiejsz\w*)[^.]{0,140}(?:bo|poniewa(?:ż|z)|na\s+podstawie)[^.]{0,140}(?:wcze(?:ś|s)niej|podobn\w*|historyczn\w*)/i,
      ],
    },
    {
      rule: 'NO_ACTIVITY_INSTEAD_OF_MISSING',
      patterns: [
        /^\s*brak\s+aktywno(?:ś|s)ci(?:\s+w\s+danych)?[.!?]?\s*$/i,
        /\bbrak\s+aktywno(?:ś|s)ci(?:\s+(?:zosta(?:ł|la|ło)|by(?:ł|ła|ło))?\s*(?:odnotowan(?:a|e|y)?|zaobserwowan(?:a|e|y)?|zgłoszon(?:a|e|y)?))\b/i,
        /^\s*no\s+activity[.!?]?\s*$/i,
        /\bno\s+activity(?:\s+(?:was|were|is|has\s+been)\s+(?:recorded|observed|reported|detected|seen)|\s+events?\s+(?:were|was)\s+(?:recorded|observed|reported))\b/i,
      ],
    },
  ];

  const flags: DirectResponseBoundaryFlag[] = [];
  for (const { rule, patterns } of rules) {
    for (const pattern of patterns) {
      const match = pattern.exec(text);
      if (match) {
        flags.push({ rule, fragment: match[0].trim().slice(0, 160) });
        break;
      }
    }
  }
  return flags;
}

/** A draft listener that throws must never fail the answer. */
function notifyDraft(observer: { onDraft: (assistantMessageSoFar: string) => void }, text: string): void {
  try {
    observer.onDraft(text);
  } catch {
    // Ignored: the caregiver still gets the stored answer.
  }
}
