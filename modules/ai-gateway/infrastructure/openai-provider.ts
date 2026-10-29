import {
  AiProvider,
  AiProviderInput,
  AiProviderResponse,
  type AiEvidenceDeliveryEnvelope,
  type AiRuntimeToolCall,
  type ProviderDiagnosticSnapshot,
} from '@modules/ai-gateway/domain/ai-gateway';
import { buildExactInputFingerprint, buildPricingEstimate, normalizeAIUsage } from '@modules/ai-gateway/application/ai-observability';
import { AiProviderError } from './ai-provider.error';
import { appendEvaluationCaptureLine, assertEvaluationCaptureOutsideRepository } from './evaluation-capture-path';
import { buildAiTaskIdentity } from '@modules/ai-gateway/application/ai-task';
import { CONVERSATION_OUTPUT_SCHEMA_NAME } from '@modules/ai-gateway/application/ai-contract.schema';
import { buildModelFacingDirectEnvelope, buildModelFacingTimeRangeEnvelope, createLocalTimeFormatter, isEvidenceToolName, stripEvidenceForModel } from '@modules/ai-gateway/application/model-facing-payload';
import type { AiCostGuardConfig } from '@modules/ai-gateway/application/ai-cost-guard';
import { createGuardedOpenAiClient, createGuardedOpenAiSdkClient, ON_OUTPUT_TEXT_OPTION, type OpenAiServiceTier } from './guarded-openai-client';
import type { ExperimentBudgetLedger } from './experiment-budget-ledger';
import { parseOpenAiReasoningEffort, type OpenAiReasoningEffort } from '@infra/config/environment';

export interface OpenAiProviderConfig {
  apiKey: string;
  /**
   * Name recorded on executions, costs and the budget ledger; default "openai". "anthropic" with the Claude transport
   * (anthropic-responses-transport), which takes the same Responses-shaped requests.
   */
  providerName?: string;
  model?: string;
  timeoutMs?: number;
  evaluationCaptureFilePath?: string | null;
  pricing?: {
    input_per_1k_tokens: number | null;
    output_per_1k_tokens: number | null;
    cached_input_per_1k_tokens: number | null;
    reasoning_per_1k_tokens: number | null;
    currency?: string | null;
    pricing_version?: string | null;
    cache_write_per_1k_tokens?: number | null;
    flex_price_multiplier?: number | null;
  } | null;
  /**
   * Hard per-call cost limit and durable experiment budget (see guarded-openai-client). Required with the real OpenAI
   * client: the provider cannot be built without them. With an injected transport (tests) they are optional; when a
   * cost guard is given the transport is wrapped by the same guard.
   */
  costGuard?: AiCostGuardConfig | null;
  /** Claude: prices of a refusal fallback's model (a response with fallback_model); null: the main prices. */
  fallbackPricing?: OpenAiProviderConfig['pricing'];
  budgetLedger?: ExperimentBudgetLedger | null;
  /** Sent as `reasoning: { effort }` when set; unset sends no `reasoning` field (provider default). No fallback. */
  reasoningEffort?: OpenAiReasoningEffort | null;
  /**
   * Explicit prompt-cache breakpoint at the end of the system message (gpt-5.6+). Without it the provider writes only
   * its one implicit breakpoint at the end of the whole request, so a new question may not reuse the cached system
   * prompt (measured 2026-10-16: 12% cached input on first calls). Off unless configured.
   */
  promptCacheBreakpoints?: boolean;
  /** "flex": every call goes to the flex tier first, with one standard-tier retry (see guarded-openai-client). */
  serviceTier?: OpenAiServiceTier | null;
  /** Longest wait for a flex answer before the standard-tier retry; unset: timeoutMs. */
  flexTimeoutMs?: number | null;
  /** Tool rounds chained on an earlier response are bounded locally, without the counting request (OPENAI_CHAINED_INPUT_BOUND). */
  localChainedInputBound?: boolean;
}

export interface OpenAiResponsesClient {
  responses: {
    create: (body: Record<string, unknown>, options?: Record<string, unknown>) => Promise<Record<string, unknown>>;
  };
}

export type OpenAiStructuredSchema = typeof directResponseJsonSchema;

const directResponseJsonSchema = {
  name: CONVERSATION_OUTPUT_SCHEMA_NAME,
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      assistant_message: { type: 'string' },
      // Written after the answer: candidate questions with the model's own assessment; the worker selects which are
      // shown (selectFollowUpSuggestions). Strict mode needs the key; an empty array is valid.
      follow_up_candidates: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            question: { type: 'string' },
            kind: { type: 'string', enum: ['NOW', 'WHY', 'NEXT_TIME', 'PATTERN'] },
            repeats_answer: { type: 'boolean' },
            answerable: { type: 'boolean' },
            usefulness: { type: 'integer' },
          },
          required: ['question', 'kind', 'repeats_answer', 'answerable', 'usefulness'],
        },
      },
      // The conversation's name for the history list, only when conversation_context.needs_title; null otherwise.
      conversation_title: { type: ['string', 'null'] },
      // Options the app shows as a picker, each with the cards tagged with its key (answer-options.v1); usually empty.
      answer_options: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            key: { type: 'string', enum: ['A', 'B', 'C'] },
            title: { type: 'string' },
            detail: { type: 'string' },
            note: { type: 'string' },
            recommended: { type: 'boolean' },
          },
          required: ['key', 'title', 'detail', 'note', 'recommended'],
        },
      },
    },
    required: ['assistant_message', 'follow_up_candidates', 'conversation_title', 'answer_options'],
  },
} as const;

// Both conversation tasks share one output schema.
export function selectOpenAiStructuredSchema(_taskType: string): OpenAiStructuredSchema {
  return directResponseJsonSchema;
}

function ensureResponsesToolParametersRequired(inputSchema: Record<string, unknown>): Record<string, unknown> {
  const schema = { ...inputSchema };
  const properties = schema.properties;
  if (properties && typeof properties === 'object' && !Array.isArray(schema.required)) {
    schema.required = Object.keys(properties as Record<string, unknown>);
  }
  return schema;
}

function invalidAiEvidenceDeliveryPayload(taskType: string, reason: string): AiProviderError {
  return new AiProviderError(
    `AI evidence delivery validation failed for task ${taskType}: ${reason}`,
    false,
    'AI_EVIDENCE_DELIVERY_VALIDATION_FAILED',
    {
      stage: 'REQUEST_VALIDATION',
      http_status: 400,
      error_name: 'AiEvidenceDeliveryValidator',
      error_type: 'AI_EVIDENCE_DELIVERY_VALIDATION_FAILED',
      error_code: 'AI_EVIDENCE_DELIVERY_VALIDATION_FAILED',
      error_message: reason,
      retryable: false,
      response_id: null,
      output_item_types: [],
      function_call_names: [],
      function_call_arguments: [],
      function_call_count: 0,
      has_output_text: false,
    },
  );
}

const FORBIDDEN_PAYLOAD_KEYS = [
  'raw_payload',
  'context_package',
  'contextPackage',
  'source_records',
  'sourceRecords',
  'raw_source_objects',
  'rawSourceObjects',
  'source_object',
  'full_context_package',
  'fullContextPackage',
  'analytical_evidence',
  'analyticalEvidence',
  'analytical_evidence_raw',
] as const;

const COMMON_ALLOWED_TOP_LEVEL_KEYS = [
  'task',
  'patient_ref',
  'conversation_context',
  'current_state_snapshot',
  // The loop's state and the plans still open (therapy-now.v1).
  'therapy_now',
  'patient_local_time',
  'evidence_contract',
  'provenance_summary',
] as const;

const TIME_RANGE_ALLOWED_TOP_LEVEL_KEYS = [
  ...COMMON_ALLOWED_TOP_LEVEL_KEYS,
  'analysis_request_input',
  'current_meal_reference',
  'selected_evidence',
  // Optional: the default (tool-less) prompt's deterministic timeline; still subject to the forbidden-key checks.
  'temporal_evidence',
  'historical_evidence',
  'tool_loop_state',
  'historical_therapy_semantics_contract',
  // Compact therapy profile (ICR, ISF, basal, targets): the basis of dose and settings suggestions.
  'therapy_profile',
  // A rescue alert's conversation: the alert, its static dose and what was logged (rescue-carbs.v1).
  'rescue_carb_alert',
  // A meal's WBT conversation: the meal's WBT and the dose proposed now (wbt-chat.v1).
  'meal_wbt',
  // Bolus + SMB + delivered basal per local day (TDD), deterministic.
  'daily_insulin_totals',
  // Temporary targets, overrides, site / sensor changes, notes of the period (therapy-context-events.v1).
  'therapy_context_events',
] as const;

const DIRECT_ALLOWED_TOP_LEVEL_KEYS = [
  ...COMMON_ALLOWED_TOP_LEVEL_KEYS,
  'direct_response_input',
  'patient_facts',
  'allowed_response_contract',
] as const;

function hasForbiddenJsonKey(value: unknown, forbiddenKeys: readonly string[]): boolean {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const record = value as Record<string, unknown>;
  for (const key of forbiddenKeys) {
    if (key in record) {
      return true;
    }
  }

  for (const nested of Object.values(record)) {
    if (hasForbiddenJsonKey(nested, forbiddenKeys)) {
      return true;
    }
  }

  return false;
}

function hasUnexpectedTopLevelKeys(envelope: Record<string, unknown>, allowedKeys: readonly string[]): string[] {
  return Object.keys(envelope).filter((key) => !allowedKeys.includes(key));
}

function hasForbiddenSourceClass(value: unknown): boolean {
  if (!value || typeof value !== 'object') {
    return false;
  }

  if (Array.isArray(value)) {
    return value.some((entry) => hasForbiddenSourceClass(entry));
  }

  const record = value as Record<string, unknown>;

  const looksLikeNightscoutRaw =
    (typeof record.sgv === 'number' || typeof record.sgv === 'string')
    && (typeof record.date === 'number' || typeof record.dateString === 'string')
    && (record.type === 'sgv' || typeof record.sysTime === 'string');

  const looksLikeContextPackage =
    typeof record.context_package_id === 'string'
    && typeof record.context_package_version === 'string'
    && typeof record.content_hash === 'string';

  const looksLikeAnalyticalEvidence =
    Array.isArray(record.glucose_events)
    && Array.isArray(record.insulin_treatment_events)
    && Array.isArray(record.meal_events)
    && typeof record.summaries === 'object';

  if (looksLikeNightscoutRaw || looksLikeContextPackage || looksLikeAnalyticalEvidence) {
    return true;
  }

  return Object.values(record).some((entry) => hasForbiddenSourceClass(entry));
}

type ProviderToolResults = NonNullable<AiProviderInput['tool_runtime']>['tool_results'];

function validateToolResults(toolResults: ProviderToolResults): void {
  if (!Array.isArray(toolResults)) {
    return;
  }

  for (const result of toolResults) {
    if (!result || typeof result !== 'object') {
      throw invalidAiEvidenceDeliveryPayload('TOOL_RESULT_VALIDATION', 'Tool result must be an object.');
    }

    const record = result as unknown as Record<string, unknown>;
    if (hasForbiddenJsonKey(record, [...FORBIDDEN_PAYLOAD_KEYS])) {
      throw invalidAiEvidenceDeliveryPayload('TOOL_RESULT_VALIDATION', 'Tool result contains forbidden raw source objects.');
    }
    if (!record.call_id || typeof record.call_id !== 'string') {
      throw invalidAiEvidenceDeliveryPayload('TOOL_RESULT_VALIDATION', 'Tool result missing call_id.');
    }
    if (!record.result || typeof record.result !== 'object') {
      throw invalidAiEvidenceDeliveryPayload('TOOL_RESULT_VALIDATION', 'Tool result missing structured result payload.');
    }
  }
}

export function validateAiEvidenceDeliveryEnvelope(payload: string | Record<string, unknown>, taskType: string): AiEvidenceDeliveryEnvelope {
  let parsed: unknown;
  if (typeof payload === 'string') {
    try {
      parsed = JSON.parse(payload);
    } catch {
      throw invalidAiEvidenceDeliveryPayload(taskType, 'Payload is not valid JSON.');
    }
  } else {
    parsed = payload;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw invalidAiEvidenceDeliveryPayload(taskType, 'Payload must be a JSON object.');
  }

  const envelope = parsed as Record<string, unknown>;
  if (hasForbiddenJsonKey(envelope, [...FORBIDDEN_PAYLOAD_KEYS])) {
    throw invalidAiEvidenceDeliveryPayload(taskType, 'Payload contains forbidden raw or canonical context objects.');
  }
  if (hasForbiddenSourceClass(envelope)) {
    throw invalidAiEvidenceDeliveryPayload(taskType, 'Payload contains forbidden source-class structures.');
  }

  const task = envelope.task && typeof envelope.task === 'object' ? envelope.task as Record<string, unknown> : {};
  const taskTypeFromEnvelope = typeof task.task_type === 'string' ? task.task_type : null;

  if (!taskTypeFromEnvelope || taskTypeFromEnvelope !== taskType) {
    throw invalidAiEvidenceDeliveryPayload(taskType, 'Payload task_type does not match the request task.');
  }

  if (taskType === 'CONVERSATION_TIME_RANGE_ANALYSIS') {
    const unexpected = hasUnexpectedTopLevelKeys(envelope, TIME_RANGE_ALLOWED_TOP_LEVEL_KEYS);
    if (unexpected.length > 0) {
      throw invalidAiEvidenceDeliveryPayload(taskType, `Unexpected top-level keys for time-range payload: ${unexpected.join(', ')}`);
    }
    if (!envelope.patient_ref || typeof envelope.patient_ref !== 'object') {
      throw invalidAiEvidenceDeliveryPayload(taskType, 'Missing patient_ref for time-range analysis payload.');
    }
    if (!envelope.analysis_request_input || typeof envelope.analysis_request_input !== 'object') {
      throw invalidAiEvidenceDeliveryPayload(taskType, 'Missing analysis_request_input.');
    }
    if (!envelope.conversation_context || typeof envelope.conversation_context !== 'object') {
      throw invalidAiEvidenceDeliveryPayload(taskType, 'Missing conversation_context.');
    }
    if (!envelope.selected_evidence || typeof envelope.selected_evidence !== 'object') {
      throw invalidAiEvidenceDeliveryPayload(taskType, 'Missing selected_evidence for time-range analysis payload.');
    }
    if (!envelope.provenance_summary || typeof envelope.provenance_summary !== 'object') {
      throw invalidAiEvidenceDeliveryPayload(taskType, 'Missing provenance_summary.');
    }
    if (!envelope.evidence_contract || typeof envelope.evidence_contract !== 'object') {
      throw invalidAiEvidenceDeliveryPayload(taskType, 'Missing evidence_contract.');
    }
  }

  if (taskType === 'CONVERSATION_DIRECT_RESPONSE') {
    const unexpected = hasUnexpectedTopLevelKeys(envelope, DIRECT_ALLOWED_TOP_LEVEL_KEYS);
    if (unexpected.length > 0) {
      throw invalidAiEvidenceDeliveryPayload(taskType, `Unexpected top-level keys for direct response payload: ${unexpected.join(', ')}`);
    }
    if (!envelope.patient_ref || typeof envelope.patient_ref !== 'object') {
      throw invalidAiEvidenceDeliveryPayload(taskType, 'Missing patient_ref for direct response payload.');
    }
    if (!envelope.conversation_context || typeof envelope.conversation_context !== 'object') {
      throw invalidAiEvidenceDeliveryPayload(taskType, 'Missing conversation_context for direct response payload.');
    }
    if (!envelope.direct_response_input || typeof envelope.direct_response_input !== 'object') {
      throw invalidAiEvidenceDeliveryPayload(taskType, 'Missing direct_response_input.');
    }
    if (!envelope.evidence_contract || typeof envelope.evidence_contract !== 'object') {
      throw invalidAiEvidenceDeliveryPayload(taskType, 'Missing evidence_contract.');
    }
  }

  return envelope as unknown as AiEvidenceDeliveryEnvelope;
}

export function buildOpenAiResponsesRequestBody(args: {
  model: string;
  task_type: string;
  system_instructions: string;
  user_payload: string;
  previous_response_id?: string | null;
  tool_runtime?: AiProviderInput['tool_runtime'];
  chained_prompt?: AiProviderInput['chained_prompt'];
  reasoning_effort?: OpenAiReasoningEffort | null;
  user_images?: AiProviderInput['user_images'];
  /** Routes requests of one task type to the same prompt cache. */
  prompt_cache_key?: string | null;
  /** See OpenAiProviderConfig.promptCacheBreakpoints. */
  prompt_cache_breakpoint?: boolean;
  /** Evidence in the compact format: local timestamps, long record lists as columns (AI_MODEL_FACING_COMPACT_FORMAT). */
  model_facing_compact_format?: boolean;
}): Record<string, unknown> {
  const validatedEnvelope = validateAiEvidenceDeliveryEnvelope(args.user_payload, args.task_type);
  if (args.tool_runtime) {
    validateToolResults(args.tool_runtime.tool_results);
  }
  // Time-range analyses: ids, hashes and version labels the model cannot use are left out of what it reads.
  const isTimeRange = args.task_type === 'CONVERSATION_TIME_RANGE_ANALYSIS';
  const format = isTimeRange && args.model_facing_compact_format
    ? {
      localTime: createLocalTimeFormatter(((validatedEnvelope as unknown as Record<string, unknown>).analysis_request_input as Record<string, unknown> | undefined)?.timezone),
      columnar: true,
    }
    : null;
  const envelope = isTimeRange
    ? buildModelFacingTimeRangeEnvelope(validatedEnvelope as unknown as Record<string, unknown>, format)
    : args.task_type === 'CONVERSATION_DIRECT_RESPONSE'
      ? buildModelFacingDirectEnvelope(validatedEnvelope as unknown as Record<string, unknown>)
      : validatedEnvelope;

  const schema = selectOpenAiStructuredSchema(args.task_type);

  // With an intact previous_response_id chain the provider already holds the system and user messages; repeating
  // them would bill and show the same prompt twice. Only additional instructions (finalization) are sent then.
  const promptInChain = Boolean(args.chained_prompt) && typeof args.previous_response_id === 'string' && args.previous_response_id.length > 0;
  const additionalInstructions = args.chained_prompt?.additional_system_instructions ?? null;
  const input: Array<Record<string, unknown>> = promptInChain
    ? (additionalInstructions ? [{ role: 'system', content: additionalInstructions }] : [])
    : [
      {
        role: 'system',
        content: args.prompt_cache_breakpoint
          ? [{ type: 'input_text', text: args.system_instructions, prompt_cache_breakpoint: { mode: 'explicit' } }]
          : args.system_instructions,
      },
      {
        role: 'user',
        // Attached photos go next to the evidence envelope as images; without photos the request is unchanged.
        content: (args.user_images?.length ?? 0) > 0
          ? [
            { type: 'input_text', text: JSON.stringify(envelope) },
            ...args.user_images!.map((image) => ({ type: 'input_image', image_url: `data:${image.media_type};base64,${image.data_base64}`, detail: 'auto' })),
          ]
          : JSON.stringify(envelope),
      },
    ];

  for (const toolResult of args.tool_runtime?.tool_results ?? []) {
    if (hasForbiddenSourceClass(toolResult.result)) {
      throw invalidAiEvidenceDeliveryPayload(args.task_type, 'Tool result payload contains forbidden source-class structures.');
    }
    input.push({
      type: 'function_call_output',
      call_id: toolResult.call_id,
      output: JSON.stringify(isTimeRange && isEvidenceToolName(toolResult.tool_name) ? stripEvidenceForModel(toolResult.result, format) : toolResult.result),
    });
  }

  const tools = (args.tool_runtime?.available_tools ?? []).map((tool) => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: ensureResponsesToolParametersRequired(tool.input_schema),
    strict: true,
  }));

  return {
    model: args.model,
    previous_response_id: args.previous_response_id ?? undefined,
    // One tool call per turn, except an answer that prepares cards (the gateway asks for it): the cards of its options are
    // independent, so they come in one turn instead of one turn each, each re-reading the whole context.
    parallel_tool_calls: args.tool_runtime?.parallel_tool_calls === true && tools.length > 0
      ? true
      : args.task_type === 'CONVERSATION_TIME_RANGE_ANALYSIS' || (args.task_type === 'CONVERSATION_DIRECT_RESPONSE' && tools.length > 0) ? false : undefined,
    input,
    text: {
      format: {
        type: 'json_schema',
        name: schema.name,
        strict: schema.strict,
        schema: schema.schema,
      },
    },
    tools: tools.length > 0 ? tools : undefined,
    ...(tools.length > 0 && args.tool_runtime?.tool_choice === 'none' ? { tool_choice: 'none' } : {}),
    // Only when configured: without it the request is exactly what it was before.
    ...(args.reasoning_effort ? { reasoning: { effort: args.reasoning_effort } } : {}),
    // Cache routing only: the model reads the same request with or without it.
    ...(args.prompt_cache_key ? { prompt_cache_key: args.prompt_cache_key } : {}),
  };
}

export class OpenAiProvider implements AiProvider {
  readonly providerName: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly pricing: OpenAiProviderConfig['pricing'];
  private readonly fallbackPricing: OpenAiProviderConfig['pricing'];
  private readonly evaluationCaptureFilePath: string | null;
  private readonly client: OpenAiResponsesClient;
  private readonly reasoningEffort: OpenAiReasoningEffort | null;
  private readonly promptCacheBreakpoints: boolean;

  /** A Claude refusal fallback's answer is priced at the fallback's prices when they are set. */
  private pricingFor(response: Record<string, unknown>): NonNullable<OpenAiProviderConfig['pricing']> | null {
    return (typeof response.fallback_model === 'string' && this.fallbackPricing ? this.fallbackPricing : this.pricing) ?? null;
  }

  constructor(config: OpenAiProviderConfig, transport?: OpenAiResponsesClient) {
    if (!transport && !(config.pricing && config.costGuard && config.budgetLedger)) {
      throw new Error('OpenAiProvider with the real OpenAI client requires pricing, costGuard and budgetLedger');
    }
    this.providerName = config.providerName?.trim() || 'openai';
    const guard = {
      provider_label: this.providerName,
      pricing: config.pricing ?? null,
      costGuard: config.costGuard ?? null,
      ledger: config.budgetLedger ?? null,
      service_tier: config.serviceTier ?? null,
      flex_timeout_ms: config.flexTimeoutMs ?? null,
      local_chained_input_bound: config.localChainedInputBound === true,
      fallback_pricing: config.fallbackPricing ?? null,
    };
    // The real SDK client exists only guarded; an injected transport (offline tests) is wrapped when a guard is given.
    this.client = !transport
      ? createGuardedOpenAiSdkClient({ apiKey: config.apiKey, ...guard })
      : config.costGuard ? createGuardedOpenAiClient({ transport, ...guard }) : transport;
    this.model = config.model ?? 'gpt-5.6-terra';
    this.timeoutMs = config.timeoutMs ?? 15_000;
    this.pricing = config.pricing ?? null;
    this.fallbackPricing = config.fallbackPricing ?? null;
    // Re-validated here so a value that bypassed environment validation cannot reach the request.
    this.reasoningEffort = config.reasoningEffort == null ? null : parseOpenAiReasoningEffort(String(config.reasoningEffort)) ?? null;
    this.promptCacheBreakpoints = config.promptCacheBreakpoints === true;
    this.evaluationCaptureFilePath = config.evaluationCaptureFilePath?.trim() || null;
    if (this.evaluationCaptureFilePath) {
      // Captures contain patient data: fail fast instead of writing them into the repository working tree.
      assertEvaluationCaptureOutsideRepository(this.evaluationCaptureFilePath);
    }
  }

  async generate(input: AiProviderInput): Promise<AiProviderResponse> {
    const startedAt = Date.now();
    validateAiEvidenceDeliveryEnvelope(input.prompt.user_payload, input.task.task_type);
    const requestBody = buildOpenAiResponsesRequestBody({
      model: this.model,
      task_type: input.task.task_type,
      system_instructions: input.prompt.system_instructions,
      user_payload: input.prompt.user_payload,
      previous_response_id: input.previous_response_id,
      tool_runtime: input.tool_runtime,
      chained_prompt: input.chained_prompt,
      reasoning_effort: this.reasoningEffort,
      user_images: input.user_images,
      prompt_cache_key: `glucomind:${input.task.task_type}`,
      prompt_cache_breakpoint: this.promptCacheBreakpoints,
      model_facing_compact_format: ['1', 'true', 'yes', 'on'].includes(String(process.env.AI_MODEL_FACING_COMPACT_FORMAT ?? '').trim().toLowerCase()),
    });
    const requestFingerprint = buildExactInputFingerprint(requestBody);
    const requestBytes = Buffer.byteLength(JSON.stringify(requestBody), 'utf8');

    if (this.evaluationCaptureFilePath) {
      await writeEvaluationCaptureRecord(this.evaluationCaptureFilePath, {
        captured_at: new Date().toISOString(),
        capture_version: 'openai-request-capture.v1',
        task_identity: buildAiTaskIdentity(input.task),
        task: {
          task_id: input.task.task_id,
          task_type: input.task.task_type,
          task_version: input.task.task_version,
          prompt_version: input.task.prompt_version,
          output_schema_version: input.task.output_schema_version,
          model_policy_version: input.task.model_policy_version,
          context_package_id: input.task.context_package_id,
          context_package_version: input.task.context_package_version,
          context_package_hash: input.task.context_package_hash,
          correlation_id: input.task.correlation_id,
          created_at: input.task.created_at,
        },
        provider: this.providerName,
        model: this.model,
        model_fingerprint: `${this.providerName}:${this.model}:${input.task.prompt_version}:${input.task.output_schema_version}`,
        prompt: {
          system_instructions: input.prompt.system_instructions,
          user_payload: input.prompt.user_payload,
        },
        context_package: input.context_package,
        request_representation: requestBody,
        serialized_input_bytes: requestBytes,
        input_fingerprint: requestFingerprint,
      });
    }

    try {
      // The SDK aborts the HTTP request when the signal fires (analysis cancelled by the user).
      const response = await this.client.responses.create(
        requestBody as Record<string, unknown>,
        {
          timeout: this.timeoutMs,
          ...(input.abort_signal ? { signal: input.abort_signal } : {}),
          // Streams the call through the guarded client (same request, same final response).
          ...(input.on_output_text ? { [ON_OUTPUT_TEXT_OPTION]: input.on_output_text } : {}),
        },
      );
      const responseId = typeof (response as Record<string, unknown>).id === 'string'
        ? String((response as Record<string, unknown>).id)
        : null;
      const diagnostics = summarizeOpenAiResponseDiagnostics(response as Record<string, unknown>, 'PROVIDER_RESPONSE');

      const toolCalls = extractToolCalls(response);
      if (toolCalls.length > 0) {
        const usage = normalizeAIUsage((response as Record<string, unknown>).usage ?? null, (response as Record<string, unknown>).service_tier);
        const estimatedCost = usage
          ? buildPricingEstimate({
            provider: this.providerName,
            model: this.model,
            usage,
            pricing: this.pricingFor(response as Record<string, unknown>),
          })
          : null;

        return {
          provider: this.providerName,
          model: this.model,
          response_id: responseId,
          raw_output: {},
          tool_call: toolCalls[0] ?? null,
          tool_calls: toolCalls,
          received_at: new Date().toISOString(),
          usage,
          estimated_cost: estimatedCost,
          input_fingerprint: requestFingerprint,
          serialized_input_bytes: requestBytes,
          provider_latency_ms: Date.now() - startedAt,
          diagnostics,
        };
      }

      const rawText = extractOutputText(response);
      if (!rawText) {
        throw new AiProviderError('OpenAI response did not include structured output text', false, 'MALFORMED_RESPONSE', {
          ...diagnostics,
          stage: 'OUTPUT_VALIDATION',
          error_name: 'OpenAiProvider',
          error_type: 'MALFORMED_RESPONSE',
          error_code: 'MALFORMED_RESPONSE',
          error_message: 'OpenAI response did not include structured output text',
          retryable: false,
        });
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(rawText);
      } catch {
        throw new AiProviderError('OpenAI structured output is not valid JSON', false, 'MALFORMED_RESPONSE', {
          ...diagnostics,
          stage: 'OUTPUT_VALIDATION',
          error_name: 'OpenAiProvider',
          error_type: 'MALFORMED_RESPONSE',
          error_code: 'MALFORMED_RESPONSE',
          error_message: 'OpenAI structured output is not valid JSON',
          retryable: false,
        });
      }

      const usage = normalizeAIUsage((response as Record<string, unknown>).usage ?? null, (response as Record<string, unknown>).service_tier);
      const estimatedCost = usage
        ? buildPricingEstimate({
          provider: this.providerName,
          model: this.model,
          usage,
          pricing: this.pricingFor(response as Record<string, unknown>),
        })
        : null;
      return {
        provider: this.providerName,
        model: this.model,
        response_id: responseId,
        raw_output: parsed,
        received_at: new Date().toISOString(),
        usage,
        estimated_cost: estimatedCost,
        input_fingerprint: requestFingerprint,
        serialized_input_bytes: requestBytes,
        provider_latency_ms: Date.now() - startedAt,
        diagnostics,
      };
    } catch (error) {
      if (error instanceof AiProviderError) {
        throw error;
      }

      throw mapOpenAiError(error, 'PROVIDER_REQUEST');
    }
  }
}

export function summarizeOpenAiResponseDiagnostics(response: Record<string, unknown>, stage: string | null = 'PROVIDER_RESPONSE'): ProviderDiagnosticSnapshot {
  const output = Array.isArray(response.output) ? response.output : [];
  const outputItemTypes = output.map((item) => {
    if (!item || typeof item !== 'object') {
      return 'unknown';
    }
    return typeof (item as Record<string, unknown>).type === 'string' ? String((item as Record<string, unknown>).type) : 'unknown';
  });
  const functionCalls = output.filter((item) => !!item && typeof item === 'object' && (item as Record<string, unknown>).type === 'function_call');
  const functionCallNames = functionCalls.map((call) => {
    const record = call as Record<string, unknown>;
    return typeof record.name === 'string' ? record.name : 'unknown';
  });
  const functionCallArguments = functionCalls.map((call) => {
    const record = call as Record<string, unknown>;
    const args = typeof record.arguments === 'string' ? record.arguments : '{}';
    try {
      const parsed = JSON.parse(args);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  });
  const responseId = typeof response.id === 'string' ? response.id : null;
  const outputText = extractOutputText(response);

  return {
    response_id: responseId,
    output_item_types: outputItemTypes,
    function_call_names: functionCallNames,
    function_call_arguments: functionCallArguments,
    function_call_count: functionCalls.length,
    has_output_text: Boolean(outputText),
    http_status: typeof response.status === 'number' ? response.status : null,
    error_name: null,
    error_type: null,
    error_code: null,
    error_message: null,
    retryable: null,
    stage,
  };
}

function extractToolCalls(response: Record<string, unknown>): AiRuntimeToolCall[] {
  const output = response.output;
  if (!Array.isArray(output)) {
    return [];
  }

  const calls: AiRuntimeToolCall[] = [];

  for (const item of output) {
    if (!item || typeof item !== 'object') {
      continue;
    }

    const record = item as Record<string, unknown>;
    if (record.type !== 'function_call') {
      continue;
    }

    const callId = typeof record.call_id === 'string' && record.call_id.length > 0
      ? record.call_id
      : typeof record.id === 'string' && record.id.length > 0
        ? record.id
        : null;
    const toolName = typeof record.name === 'string' ? record.name : null;
    if (!callId || !toolName) {
      continue;
    }

    // Unreadable arguments still make a call (with none): every call of a turn needs an output, or the next chained
    // request is refused; the tool then answers that the request is invalid.
    let parsed: unknown = null;
    try {
      parsed = typeof record.arguments === 'string' ? JSON.parse(record.arguments) : null;
    } catch {
      parsed = null;
    }
    calls.push({
      call_id: callId,
      tool_name: toolName,
      arguments: parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {},
    });
  }

  return calls;
}

async function writeEvaluationCaptureRecord(filePath: string, payload: Record<string, unknown>): Promise<void> {
  // Re-validated on every write (not only at construction): see appendEvaluationCaptureLine.
  appendEvaluationCaptureLine(filePath, `${JSON.stringify(payload)}\n`);
}

function extractOutputText(response: Record<string, unknown>): string | null {
  const outputText = response.output_text;
  if (typeof outputText === 'string' && outputText.trim()) {
    return outputText;
  }

  const output = response.output;
  if (!Array.isArray(output)) {
    return null;
  }

  for (const item of output) {
    if (!item || typeof item !== 'object') {
      continue;
    }

    const content = (item as Record<string, unknown>).content;
    if (!Array.isArray(content)) {
      continue;
    }

    for (const part of content) {
      if (!part || typeof part !== 'object') {
        continue;
      }

      const record = part as Record<string, unknown>;
      if (typeof record.text === 'string' && record.text.trim()) {
        return record.text;
      }
    }
  }

  return null;
}

export function mapOpenAiError(error: unknown, stage: string = 'PROVIDER_REQUEST'): AiProviderError {
  const status = typeof error === 'object' && error !== null && 'status' in error ? Number((error as { status: unknown }).status) : null;
  const rawCode = typeof error === 'object' && error !== null && 'code' in error ? (error as { code: unknown }).code : undefined;
  const code = typeof rawCode === 'string' && rawCode.length > 0 ? rawCode : undefined;
  const errorName = typeof error === 'object' && error !== null && 'name' in error && typeof (error as { name: unknown }).name === 'string'
    ? String((error as { name: unknown }).name)
    : error instanceof Error
      ? error.name
      : 'OpenAIError';
  const errorType = typeof error === 'object' && error !== null && 'type' in error && typeof (error as { type: unknown }).type === 'string'
    ? String((error as { type: unknown }).type)
    : undefined;
  const rawMessage = error instanceof Error
    ? error.message
    : typeof error === 'object' && error !== null && 'message' in error && typeof (error as { message: unknown }).message === 'string'
      ? String((error as { message: unknown }).message)
      : 'OpenAI request failed';
  const message = sanitizeErrorMessage(rawMessage);

  const diagnostics: Partial<ProviderDiagnosticSnapshot> = {
    stage,
    http_status: status,
    error_name: errorName,
    error_type: errorType ?? null,
    error_code: code ?? null,
    error_message: message,
    retryable: null,
    response_id: null,
    output_item_types: [],
    function_call_names: [],
    function_call_arguments: [],
    function_call_count: 0,
    has_output_text: false,
  };

  // A request the provider refuses as it is (bad model 404, too large 413, unprocessable 422, auth) refuses again:
  // only timeouts, conflicts and rate limits among the 4xx are worth a new attempt.
  if (typeof status === 'number' && status >= 400 && status < 500 && status !== 408 && status !== 409 && status !== 429) {
    return new AiProviderError(message, false, code, { ...diagnostics, retryable: false });
  }

  if (status === 429) {
    return new AiProviderError('OpenAI rate limit reached', true, code ?? 'rate_limit', { ...diagnostics, retryable: true });
  }

  if (typeof status === 'number' && status >= 500) {
    return new AiProviderError('OpenAI server error', true, code ?? 'server_error', { ...diagnostics, retryable: true });
  }

  if (code && ['ETIMEDOUT', 'ECONNRESET', 'ENOTFOUND', 'ECONNREFUSED', 'EAI_AGAIN'].includes(code)) {
    return new AiProviderError('OpenAI network failure', true, code, { ...diagnostics, retryable: true });
  }

  return new AiProviderError(message, true, code, { ...diagnostics, retryable: true });
}

function sanitizeErrorMessage(message: string): string {
  return message.replace(/sk-[A-Za-z0-9-_]+/g, '[REDACTED_API_KEY]');
}
