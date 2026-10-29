import OpenAI, { toFile } from 'openai';
import type { AIPricingConfig } from '@modules/ai-gateway/domain/ai-gateway';
import { cacheWritePricePer1k, normalizeAIUsage } from '@modules/ai-gateway/application/ai-observability';
import type { AIUsage } from '@modules/ai-gateway/domain/ai-gateway';
import {
  checkCostGuardConfiguration,
  evaluatePostCallCost,
  evaluatePreCallCostBound,
  INPUT_TOKEN_FRAMING_ALLOWANCE,
  serializedRequestSizeForBound,
  type AiCostGuardConfig,
} from '@modules/ai-gateway/application/ai-cost-guard';
import { AiProviderError } from './ai-provider.error';
import { FileExperimentBudgetLedger, type ExperimentBudgetLedger } from './experiment-budget-ledger';

/**
 * The only place that constructs the OpenAI SDK client (a source test enforces it). Every request sent through the
 * returned client passes the cost guard:
 *   1. configuration (pricing, limit, currency, ledger) is checked and the experiment budget pre-checked, without traffic;
 *   2. max_output_tokens is forced to the guard's cap;
 *   3. the provider counts the input tokens of the exact request (a counting request, no model invocation);
 *   4. the worst-case cost must be within the per-call limit and is reserved in the durable experiment ledger;
 *   5. one HTTP request with SDK retries disabled;
 *   6. usage and actual cost are verified and settled in the ledger; unknown cost keeps the worst case charged.
 * Any refusal is a non-retryable AiProviderError.
 * With service_tier "flex" a call is first sent on the flex tier (same model, half price, slower, may be refused for
 * capacity); a 429 or a flex timeout re-sends it once on the standard tier, through the same guard.
 * With the `on_output_text` option a call is streamed: the callback gets the output text written so far after every
 * delta (starting again from "" on a flex retry), and the call still resolves to the complete response, settled by the
 * guard from the usage in its final event exactly like an unstreamed call.
 */

export interface OpenAiResponsesTransport {
  responses: {
    create: (body: Record<string, unknown>, options?: Record<string, unknown>) => Promise<Record<string, unknown>>;
    inputTokens?: {
      count: (body: Record<string, unknown>, options?: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
  };
}

export interface GuardedOpenAiClientConfig {
  transport: OpenAiResponsesTransport;
  pricing: AIPricingConfig | null | undefined;
  costGuard: AiCostGuardConfig | null | undefined;
  ledger: ExperimentBudgetLedger | null | undefined;
  /** Used for the ledger entry label and the post-call cost calculation. */
  provider_label?: string;
  /** "flex": try the flex tier first (see above); unset or null: the standard tier only. */
  service_tier?: OpenAiServiceTier | null;
  /** Longest wait for a flex answer before re-sending on the standard tier; unset: the call's own timeout. */
  flex_timeout_ms?: number | null;
  /**
   * A tool round chained on an earlier response of this client is bounded locally (see chainedInputTokenBound) instead
   * of by the counting request: one HTTP round trip less per round. Unset or false: every call is counted.
   */
  local_chained_input_bound?: boolean;
  /** Prices of the model a Claude refusal fallback may answer with (a response with fallback_model); null: the main ones. */
  fallback_pricing?: AIPricingConfig | null;
  /** Told after each paid call (also a failed one): what it used and cost, for callers outside the AI gateway's records. */
  on_call_settled?: (call: SettledAiCall) => void;
}

/** One paid call as the guard settled it (no prompt or answer text). */
export interface SettledAiCall {
  provider: string;
  model: string;
  outcome: 'OK' | 'FAILED' | 'REFUSED_AFTER_CALL';
  usage: AIUsage | null;
  /** Actual cost from the usage and pricing; null when unknown (failed call, missing usage). */
  cost: number | null;
  currency: string | null;
  latency_ms: number;
  error_code: string | null;
}

/**
 * OPENAI_CHAINED_INPUT_BOUND: unset or true-like = on (the bound is exact-or-higher, see chainedInputTokenBound),
 * false-like = every call counted by the provider; anything else is refused at startup.
 */
export function parseChainedInputBound(value: unknown): boolean {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : value === undefined || value === null ? '' : String(value).toLowerCase();
  if (!normalized || /^(1|true|yes|on)$/.test(normalized)) return true;
  if (/^(0|false|no|off)$/.test(normalized)) return false;
  throw new Error(`OPENAI_CHAINED_INPUT_BOUND must be true or false, got ${normalized}`);
}

/** Responses whose usage a later chained round may build its bound on (the newest ones; a tool loop needs the last). */
const CHAINED_USAGE_MEMORY = 256;

/**
 * Upper bound of the input tokens of a request chained on `previous` (previous_response_id), without asking the
 * provider. The chained input is the previous request's input plus the previous output items plus this request's own
 * fields; the previous input and output are known exactly from the previous response's usage, and this request's
 * fields are bounded by their UTF-8 bytes (byte-level BPE: a token covers at least one byte) plus the framing allowance.
 * Fields counted twice (tools and instructions sent again) only raise the bound. Null when the bound would not be
 * exact-or-higher: inline images in the new input (their bytes say nothing about their tokens) or server-side state
 * other than the chain (conversation, truncation).
 */
export function chainedInputTokenBound(body: Record<string, unknown>, previous: { input_tokens: number; output_tokens: number } | undefined): number | null {
  if (!previous || typeof body.previous_response_id !== 'string') return null;
  if (body.conversation !== undefined || body.truncation !== undefined) return null;
  const serialized = JSON.stringify(body);
  // An image or file, inline or by reference: its tokens are unknown.
  if (/"type":"input_(image|file)"|data:image\//i.test(serialized)) return null;
  return previous.input_tokens + previous.output_tokens + Buffer.byteLength(serialized, 'utf8') + INPUT_TOKEN_FRAMING_ALLOWANCE;
}

export type OpenAiServiceTier = 'flex';

/** Request option of the guarded client (never sent to OpenAI): stream the call and report the output text so far. */
export const ON_OUTPUT_TEXT_OPTION = 'on_output_text';
export type OnOutputText = (outputTextSoFar: string) => void;

/** OPENAI_SERVICE_TIER: "flex" or unset (standard); anything else is refused at startup. */
export function parseOpenAiServiceTier(value: unknown): OpenAiServiceTier | null {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!normalized || normalized === 'default' || normalized === 'standard') return null;
  if (normalized === 'flex') return 'flex';
  throw new Error(`OPENAI_SERVICE_TIER must be flex or unset, got ${normalized}`);
}

/**
 * Flex capacity refusal (not billed), a flex call that did not answer in time, or a dropped flex connection (seen twice
 * on long flex calls in the 2026-10-18 A/B; the standard tier answered at once): worth one standard-tier attempt, so the
 * caregiver's answer does not fail. The flex attempt's reservation stays at its worst case when billing is unknown.
 */
function isFlexFallbackError(error: unknown): boolean {
  const details = error as { status?: unknown } | null;
  if (details?.status === 429 || details?.status === 408) return true;
  for (let proto = error ? Object.getPrototypeOf(error) : null; proto; proto = Object.getPrototypeOf(proto)) {
    const name = (proto as { constructor?: { name?: string } }).constructor?.name;
    if (name === 'APIConnectionTimeoutError' || name === 'APIConnectionError') return true;
  }
  return false;
}

/** Request fields the input-token counting endpoint accepts; everything else (max_output_tokens) is not sent there. */
const COUNTABLE_FIELDS = ['model', 'input', 'instructions', 'tools', 'text', 'previous_response_id', 'parallel_tool_calls', 'reasoning', 'tool_choice', 'truncation', 'conversation'] as const;

/** Embeddings endpoint (string inputs only); used by offline retrieval scripts, never by the worker. */
export interface OpenAiEmbeddingsTransport {
  embeddings: {
    create: (body: Record<string, unknown>, options?: Record<string, unknown>) => Promise<Record<string, unknown>>;
  };
}

// Not exported: the raw SDK client never leaves this module unguarded.
function createSdkTransport(apiKey: string): OpenAiResponsesTransport & OpenAiEmbeddingsTransport & OpenAiTranscriptionsTransport {
  // maxRetries 0: one call is one HTTP request; the SDK default would retry up to twice.
  return new OpenAI({ apiKey, maxRetries: 0 }) as unknown as OpenAiResponsesTransport & OpenAiEmbeddingsTransport & OpenAiTranscriptionsTransport;
}

/** The real OpenAI client, always wrapped by the cost guard. */
export function createGuardedOpenAiSdkClient(args: {
  apiKey: string;
  pricing: AIPricingConfig | null | undefined;
  costGuard: AiCostGuardConfig | null | undefined;
  ledger: ExperimentBudgetLedger | null | undefined;
  service_tier?: OpenAiServiceTier | null;
  flex_timeout_ms?: number | null;
  local_chained_input_bound?: boolean;
  provider_label?: string;
  on_call_settled?: (call: SettledAiCall) => void;
  fallback_pricing?: AIPricingConfig | null;
}): OpenAiResponsesTransport {
  return createGuardedOpenAiClient({
    transport: createSdkTransport(args.apiKey),
    provider_label: args.provider_label,
    on_call_settled: args.on_call_settled,
    fallback_pricing: args.fallback_pricing ?? null,
    pricing: args.pricing,
    costGuard: args.costGuard,
    ledger: args.ledger,
    service_tier: args.service_tier ?? null,
    flex_timeout_ms: args.flex_timeout_ms ?? null,
    local_chained_input_bound: args.local_chained_input_bound === true,
  });
}

/**
 * Delays before re-sending the input token count after a transient failure. The count is free and sends nothing that is
 * billed, so retrying it does not weaken the cost guard; a single rate-limit or server error would otherwise refuse the
 * paid call (and fail a multi-call job after its earlier paid calls).
 */
const INPUT_TOKEN_COUNT_RETRY_DELAYS_MS = [250, 750] as const;

function isTransientCountError(error: unknown): boolean {
  // The SDK's connection errors (incl. its timeout subclass) carry no status and keep the default name "Error":
  // match the class by name along the prototype chain (works with the real SDK and without importing its classes).
  for (let proto = error ? Object.getPrototypeOf(error) : null; proto; proto = Object.getPrototypeOf(proto)) {
    if ((proto as { constructor?: { name?: string } }).constructor?.name === 'APIConnectionError') return true;
  }
  const details = error as { status?: unknown };
  const status = typeof details?.status === 'number' ? details.status : null;
  return status !== null && (status === 408 || status === 409 || status === 429 || status >= 500);
}

async function countInputTokensWithTransientRetry(
  inputTokens: NonNullable<OpenAiResponsesTransport['responses']['inputTokens']>,
  body: Record<string, unknown>,
  options: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await inputTokens.count(body, options);
    } catch (error) {
      const delay = INPUT_TOKEN_COUNT_RETRY_DELAYS_MS[attempt];
      if (delay === undefined || !isTransientCountError(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

/**
 * The input without prompt_cache_breakpoint markers: they do not change the token count, and a counting request the
 * endpoint rejects would refuse the paid call.
 */
function withoutPromptCacheBreakpoints(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutPromptCacheBreakpoints);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => key !== 'prompt_cache_breakpoint')
    .map(([key, entry]) => [key, withoutPromptCacheBreakpoints(entry)]));
}

function refusal(reason: string, stage: string, code: 'AI_COST_LIMIT_REFUSED' | 'AI_COST_LIMIT_EXCEEDED' = 'AI_COST_LIMIT_REFUSED'): AiProviderError {
  const message = code === 'AI_COST_LIMIT_REFUSED'
    ? `OpenAI call refused by the cost guard: ${reason}`
    : `OpenAI response rejected by the cost guard: ${reason}`;
  // A busy or unreadable ledger is momentary: the job is retried. Every other refusal would refuse again.
  const retryable = reason === 'LEDGER_UNAVAILABLE';
  return new AiProviderError(message, retryable, code, {
    stage,
    error_name: 'OpenAiCostGuard',
    error_type: reason,
    error_code: code,
    error_message: message,
    retryable,
  });
}

/** The provider's count of the exact request; null (the call is then refused) when it cannot be counted. */
async function countRequestInputTokens(transport: OpenAiResponsesTransport, requestBody: Record<string, unknown>, requestOptions: Record<string, unknown>, model: string): Promise<number | null> {
  try {
    if (!transport.responses.inputTokens) throw new Error('input token counting unavailable');
    const countBody = Object.fromEntries(COUNTABLE_FIELDS.filter((key) => requestBody[key] !== undefined).map((key) => [key, key === 'input' ? withoutPromptCacheBreakpoints(requestBody[key]) : requestBody[key]]));
    const counted = await countInputTokensWithTransientRetry(transport.responses.inputTokens, countBody, requestOptions);
    return typeof counted.input_tokens === 'number' ? counted.input_tokens : null;
  } catch (countError) {
    // An expired Claude chain is retryable (the job starts again without it), not an uncountable request.
    if ((countError as { code?: unknown } | null)?.code === 'ANTHROPIC_CHAIN_NOT_FOUND') throw countError;
    // Error metadata only (never the message, which may echo request content): the call is refused by the caller.
    const details = countError as { status?: unknown; code?: unknown; type?: unknown; param?: unknown; name?: unknown };
    console.warn(JSON.stringify({
      event: 'openai_input_token_count_failed',
      model,
      status: typeof details?.status === 'number' ? details.status : null,
      code: typeof details?.code === 'string' ? details.code : null,
      type: typeof details?.type === 'string' ? details.type : null,
      param: typeof details?.param === 'string' ? details.param : null,
      error_name: typeof details?.name === 'string' ? details.name : null,
      error_class: (countError as { constructor?: { name?: unknown } } | null)?.constructor?.name ?? null,
    }));
    return null;
  }
}

export function createGuardedOpenAiClient(config: GuardedOpenAiClientConfig): OpenAiResponsesTransport {
  const providerLabel = config.provider_label ?? 'openai';
  // Exact usage of this client's recent responses, by id: the base of a chained round's local bound.
  const usageById = new Map<string, { input_tokens: number; output_tokens: number }>();
  const rememberUsage = (response: Record<string, unknown>) => {
    if (!config.local_chained_input_bound || typeof response.id !== 'string') return;
    const usage = response.usage as { input_tokens?: unknown; output_tokens?: unknown } | undefined;
    const input = usage?.input_tokens;
    const output = usage?.output_tokens;
    if (!(typeof input === 'number' && Number.isInteger(input) && input >= 0 && typeof output === 'number' && Number.isInteger(output) && output >= 0)) return;
    usageById.set(response.id, { input_tokens: input, output_tokens: output });
    if (usageById.size > CHAINED_USAGE_MEMORY) usageById.delete(usageById.keys().next().value as string);
  };
  const guardedCall = async (body: Record<string, unknown>, options: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
        const configurationRefusal = checkCostGuardConfiguration(config.costGuard, config.pricing);
        if (configurationRefusal) throw refusal(configurationRefusal, 'PRE_CALL_COST_GUARD');
        const guard = config.costGuard as AiCostGuardConfig;
        if (!config.ledger) throw refusal('LEDGER_NOT_CONFIGURED', 'PRE_CALL_COST_GUARD');
        const precheck = config.ledger.precheck({ currency: guard.currency });
        if (!precheck.allowed) throw refusal(precheck.reason, 'PRE_CALL_BUDGET_GUARD');

        const requestBody: Record<string, unknown> = { ...body, max_output_tokens: guard.max_output_tokens };
        const model = typeof requestBody.model === 'string' ? requestBody.model : 'unknown';
        const requestOptions: Record<string, unknown> = { ...options, maxRetries: 0 };
        // Ours, not the SDK's: never part of the count request or the call options.
        const onOutputText = typeof requestOptions[ON_OUTPUT_TEXT_OPTION] === 'function' ? requestOptions[ON_OUTPUT_TEXT_OPTION] as OnOutputText : null;
        delete requestOptions[ON_OUTPUT_TEXT_OPTION];

        // A flex attempt is billed at flex prices or refused unbilled (429), so its worst case is at flex prices; the
        // standard-tier retry is bounded at standard prices. The post-call check still prices what was actually served.
        const boundPricing = requestBody.service_tier === 'flex' ? flexPricing(config.pricing) : config.pricing;
        const localBound = config.local_chained_input_bound
          ? chainedInputTokenBound(requestBody, typeof requestBody.previous_response_id === 'string' ? usageById.get(requestBody.previous_response_id) : undefined)
          : null;
        const localDecision = localBound === null ? null : evaluatePreCallCostBound({
          guard,
          pricing: boundPricing,
          serialized_request_bytes: serializedRequestSizeForBound(requestBody),
          counted_input_tokens: localBound,
        });

        const countedBound = async () => evaluatePreCallCostBound({
          guard,
          pricing: boundPricing,
          serialized_request_bytes: serializedRequestSizeForBound(requestBody),
          counted_input_tokens: await countRequestInputTokens(config.transport, requestBody, requestOptions, model),
        });
        const reserve = (decision: { max_cost: number }) => config.ledger!.reserve({ max_cost: decision.max_cost, currency: guard.currency, label: `${providerLabel}:${model}` });
        // A local bound the limit or the budget cannot take is not a refusal: the provider's exact count may still fit.
        type AllowedBound = Extract<typeof localDecision & {}, { allowed: true }>;
        let bound: AllowedBound | null = localDecision?.allowed ? localDecision : null;
        let reservation = bound ? reserve(bound) : null;
        if (!bound || !reservation?.allowed) {
          const counted = await countedBound();
          if (!counted.allowed) throw refusal(counted.reason, 'PRE_CALL_COST_GUARD');
          bound = counted;
          reservation = reserve(counted);
        }
        if (!reservation.allowed) throw refusal(reservation.reason, 'PRE_CALL_BUDGET_GUARD');

        let response: Record<string, unknown>;
        const startedAt = Date.now();
        const tell = (call: Omit<SettledAiCall, 'provider' | 'model' | 'latency_ms'> & { model?: string }) => {
          try {
            config.on_call_settled?.({ provider: providerLabel, model, latency_ms: Date.now() - startedAt, ...call });
          } catch {
            // A record that cannot be written never fails the call.
          }
        };
        try {
          response = onOutputText
            ? await streamResponse(config.transport, requestBody, requestOptions, onOutputText)
            : await config.transport.responses.create(requestBody, requestOptions);
        } catch (error) {
          // A flex capacity refusal (429) is not billed (OpenAI flex processing docs); for anything else billed or not is
          // unknown, so the reservation stays charged at its worst case.
          const flexRefused = requestBody.service_tier === 'flex' && (error as { status?: unknown } | null)?.status === 429;
          settleQuietly(config.ledger, reservation.reservation_id, flexRefused ? 0 : null);
          const code = (error as { code?: unknown } | null)?.code;
          tell({ outcome: 'FAILED', usage: null, cost: flexRefused ? 0 : null, currency: guard.currency, error_code: typeof code === 'string' ? code.slice(0, 60) : null });
          throw error;
        }

        const servedBy = typeof response.fallback_model === 'string' ? response.fallback_model : null;
        if (servedBy && !config.fallback_pricing) console.warn(JSON.stringify({ event: 'ai_fallback_priced_as_primary', model, served_by: servedBy }));
        const postCall = evaluatePostCallCost({
          provider: providerLabel,
          model: servedBy ?? model,
          guard,
          pricing: servedBy && config.fallback_pricing ? config.fallback_pricing : config.pricing,
          usage: normalizeAIUsage(response.usage ?? null, response.service_tier),
          max_input_tokens: bound.max_input_tokens,
        });
        settleQuietly(config.ledger, reservation.reservation_id, postCall.allowed ? postCall.actual_cost : postCall.actual_cost ?? null);
        tell({
          model: servedBy ?? model,
          outcome: postCall.allowed ? 'OK' : 'REFUSED_AFTER_CALL',
          usage: normalizeAIUsage(response.usage ?? null, response.service_tier),
          cost: postCall.actual_cost ?? null,
          currency: postCall.currency ?? guard.currency,
          error_code: postCall.allowed ? null : postCall.reason,
        });
        if (!postCall.allowed) throw refusal(postCall.reason, 'POST_CALL_COST_GUARD', 'AI_COST_LIMIT_EXCEEDED');
        rememberUsage(response);
        return response;
  };
  return {
    responses: {
      create: async (body, options = {}) => {
        // A caller that names its own tier (or the standard tier) is sent as asked.
        if (config.service_tier !== 'flex' || body.service_tier !== undefined) return guardedCall(body, options);
        const flexTimeout = typeof config.flex_timeout_ms === 'number' && config.flex_timeout_ms > 0
          ? Math.min(config.flex_timeout_ms, typeof options.timeout === 'number' ? options.timeout : Number.POSITIVE_INFINITY)
          : options.timeout;
        try {
          return await guardedCall({ ...body, service_tier: 'flex' }, flexTimeout === undefined ? options : { ...options, timeout: flexTimeout });
        } catch (error) {
          if ((options.signal as AbortSignal | undefined)?.aborted || !isFlexFallbackError(error)) throw error;
          const details = error as { status?: unknown };
          console.warn(JSON.stringify({ event: 'openai_flex_fallback', model: typeof body.model === 'string' ? body.model : 'unknown', status: typeof details?.status === 'number' ? details.status : null, reason: details?.status === 429 ? 'CAPACITY' : details?.status === 408 ? 'TIMEOUT' : 'CONNECTION' }));
          return guardedCall(body, options);
        }
      },
    },
  };
}

/**
 * One streamed call: reports the output text after every delta and resolves to the response from the final event
 * (completed or incomplete, the same object an unstreamed call returns). A failed response, an error event or a stream
 * that ends without a final event throws, so the guard settles it like a failed call.
 */
async function streamResponse(
  transport: OpenAiResponsesTransport,
  body: Record<string, unknown>,
  options: Record<string, unknown>,
  onOutputText: OnOutputText,
): Promise<Record<string, unknown>> {
  // The SDK's timeout ends when the response headers arrive, which for a stream is almost at once: here `timeout` bounds
  // the whole call, as it does for an unstreamed one, and the stream is aborted (not left running and billing) when it
  // fires or when the caller's signal does.
  const controller = new AbortController();
  const callerSignal = options.signal as AbortSignal | undefined;
  const abortFromCaller = () => controller.abort();
  if (callerSignal?.aborted) controller.abort();
  else callerSignal?.addEventListener('abort', abortFromCaller, { once: true });
  let timedOut = false;
  const timeoutMs = typeof options.timeout === 'number' && options.timeout > 0 ? options.timeout : null;
  const timer = timeoutMs === null ? null : setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    return await readStream(transport, body, { ...options, signal: controller.signal }, onOutputText);
  } catch (error) {
    // 408: the same "took too long" the flex fallback and the job retry already understand.
    if (timedOut) throw Object.assign(new Error(`OpenAI stream timed out after ${timeoutMs} ms`), { status: 408, code: 'STREAM_TIMEOUT' });
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    callerSignal?.removeEventListener('abort', abortFromCaller);
  }
}

async function readStream(
  transport: OpenAiResponsesTransport,
  body: Record<string, unknown>,
  options: Record<string, unknown>,
  onOutputText: OnOutputText,
): Promise<Record<string, unknown>> {
  const stream = await transport.responses.create({ ...body, stream: true }, options) as unknown as AsyncIterable<Record<string, unknown>>;
  let text = '';
  report(onOutputText, text);
  for await (const event of stream) {
    switch (event.type) {
      case 'response.output_text.delta':
        if (typeof event.delta === 'string' && event.delta.length > 0) {
          text += event.delta;
          report(onOutputText, text);
        }
        break;
      case 'response.completed':
      case 'response.incomplete':
        return event.response as Record<string, unknown>;
      case 'response.failed': {
        const failure = (event.response as { error?: { code?: unknown; message?: unknown } } | undefined)?.error;
        throw Object.assign(new Error(`OpenAI response failed: ${typeof failure?.code === 'string' ? failure.code : 'unknown'}`), { code: failure?.code ?? null });
      }
      case 'error':
        throw Object.assign(new Error(`OpenAI stream error: ${typeof event.code === 'string' ? event.code : 'unknown'}`), { code: event.code ?? null });
      default:
        break;
    }
  }
  throw Object.assign(new Error('OpenAI stream ended without a final response'), { code: 'STREAM_ENDED_EARLY' });
}

/** A failing listener must never fail the paid call it watches. */
function report(onOutputText: OnOutputText, text: string): void {
  try {
    onOutputText(text);
  } catch {
    // Ignored: the answer is still stored when the call completes.
  }
}

/** Every price scaled by the configured flex factor; without one the pricing is returned unchanged (standard). */
function flexPricing(pricing: AIPricingConfig | null | undefined): AIPricingConfig | null | undefined {
  const factor = pricing?.flex_price_multiplier;
  if (!pricing || typeof factor !== 'number') return pricing;
  const scale = (price: number | null) => (price === null ? null : price * factor);
  return {
    ...pricing,
    input_per_1k_tokens: scale(pricing.input_per_1k_tokens),
    output_per_1k_tokens: scale(pricing.output_per_1k_tokens),
    cached_input_per_1k_tokens: scale(pricing.cached_input_per_1k_tokens),
    reasoning_per_1k_tokens: scale(pricing.reasoning_per_1k_tokens),
    cache_write_per_1k_tokens: (() => {
      const write = cacheWritePricePer1k(pricing);
      return write === null ? null : write * factor;
    })(),
  };
}

/** A failed settlement leaves the reservation at its worst case, which over-counts and is therefore safe. */
function settleQuietly(ledger: ExperimentBudgetLedger, reservationId: string, actualCost: number | null): void {
  try {
    ledger.settle({ reservation_id: reservationId, actual_cost: actualCost });
  } catch {
    // Keep the worst-case charge.
  }
}

function envPrice(env: NodeJS.ProcessEnv, key: string): number | null {
  const raw = env[key]?.trim();
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function envText(env: NodeJS.ProcessEnv, key: string): string | null {
  return env[key]?.trim() || null;
}

/**
 * Pricing, cost guard and ledger from the same environment variables the worker uses (OPENAI_PRICING_*,
 * AI_EXPERIMENT_*). Missing or invalid values throw; there are no defaults.
 */
/** The prices a guarded client reserves and settles a call with (OPENAI_PRICING_*, cache write, flex factor). */
export function resolveOpenAiPricingFromEnv(env: NodeJS.ProcessEnv, prefix = 'OPENAI_PRICING'): AIPricingConfig {
  return {
    input_per_1k_tokens: envPrice(env, `${prefix}_INPUT_PER_1K_TOKENS`),
    output_per_1k_tokens: envPrice(env, `${prefix}_OUTPUT_PER_1K_TOKENS`),
    cached_input_per_1k_tokens: envPrice(env, `${prefix}_CACHED_INPUT_PER_1K_TOKENS`),
    reasoning_per_1k_tokens: envPrice(env, `${prefix}_REASONING_PER_1K_TOKENS`),
    currency: envText(env, `${prefix}_CURRENCY`),
    pricing_version: envText(env, `${prefix}_VERSION`),

    // Optional: cache write price (default 1.25x input) and the flex price factor (default 1, priced as standard).
    ...(envPrice(env, `${prefix}_CACHE_WRITE_PER_1K_TOKENS`) !== null ? { cache_write_per_1k_tokens: envPrice(env, `${prefix}_CACHE_WRITE_PER_1K_TOKENS`) } : {}),
    // Flex is an OpenAI tier only.
    ...(prefix.startsWith('OPENAI_') && envPrice(env, 'OPENAI_FLEX_PRICE_MULTIPLIER') !== null ? { flex_price_multiplier: envPrice(env, 'OPENAI_FLEX_PRICE_MULTIPLIER') } : {}),
  };
}

/** Pricing prefix ANTHROPIC_PRICING for Claude (createGuardedAnthropicClientFromEnv); OPENAI_PRICING by default. */
export function resolveOpenAiCostGuardFromEnv(env: NodeJS.ProcessEnv, pricingPrefix = 'OPENAI_PRICING'): { pricing: AIPricingConfig; costGuard: AiCostGuardConfig; budgetLedger: FileExperimentBudgetLedger } {
  const pricing = resolveOpenAiPricingFromEnv(env, pricingPrefix);
  const costGuard: AiCostGuardConfig = {
    max_cost: Number(env.AI_EXPERIMENT_MAX_COST),
    currency: envText(env, 'AI_EXPERIMENT_COST_CURRENCY') ?? '',
    max_output_tokens: Number(env.AI_EXPERIMENT_MAX_OUTPUT_TOKENS),
  };
  const configurationRefusal = checkCostGuardConfiguration(costGuard, pricing);
  if (configurationRefusal) {
    throw new Error(`AI cost guard is not configured (${configurationRefusal}): ${pricingPrefix}_*, AI_EXPERIMENT_MAX_COST, AI_EXPERIMENT_COST_CURRENCY and AI_EXPERIMENT_MAX_OUTPUT_TOKENS are required`);
  }
  const ledgerPath = envText(env, 'AI_EXPERIMENT_BUDGET_LEDGER_PATH');
  if (!ledgerPath) {
    throw new Error('OpenAI cost guard is not configured: AI_EXPERIMENT_BUDGET_LEDGER_PATH is required');
  }
  const budgetLedger = new FileExperimentBudgetLedger(ledgerPath);
  budgetLedger.read();
  return { pricing, costGuard, budgetLedger };
}

/** Guarded SDK client for scripts that build their own requests (live replay scripts). */
export function createGuardedOpenAiClientFromEnv(env: NodeJS.ProcessEnv, apiKey: string, onCallSettled?: (call: SettledAiCall) => void): OpenAiResponsesTransport {
  const { pricing, costGuard, budgetLedger } = resolveOpenAiCostGuardFromEnv(env);
  return createGuardedOpenAiSdkClient({
    apiKey,
    on_call_settled: onCallSettled,
    pricing,
    costGuard,
    ledger: budgetLedger,
    service_tier: parseOpenAiServiceTier(env.OPENAI_SERVICE_TIER),
    flex_timeout_ms: envPrice(env, 'OPENAI_FLEX_TIMEOUT_MS'),
    local_chained_input_bound: parseChainedInputBound(env.OPENAI_CHAINED_INPUT_BOUND),
  });
}

/** Price of an embeddings model: input tokens only. */
export interface EmbeddingPricingConfig {
  input_per_1k_tokens: number;
  currency: string;
  pricing_version: string;
}

export interface EmbeddingCostGuardConfig {
  max_cost: number;
  currency: string;
}

export interface GuardedOpenAiEmbeddingsClientConfig {
  transport: OpenAiEmbeddingsTransport;
  pricing: EmbeddingPricingConfig | null | undefined;
  costGuard: EmbeddingCostGuardConfig | null | undefined;
  ledger: ExperimentBudgetLedger | null | undefined;
  provider_label?: string;
}

/** Added per input string to the byte bound; embeddings add no framing today, this only keeps the bound conservative. */
const EMBEDDING_INPUT_TOKEN_ALLOWANCE = 16;

function embeddingConfigurationRefusal(guard: EmbeddingCostGuardConfig | null | undefined, pricing: EmbeddingPricingConfig | null | undefined): string | null {
  if (!guard) return 'GUARD_NOT_CONFIGURED';
  if (!(typeof guard.max_cost === 'number' && Number.isFinite(guard.max_cost) && guard.max_cost > 0) || !guard.currency?.trim()) return 'INVALID_LIMIT';
  if (!pricing) return 'PRICING_NOT_CONFIGURED';
  const price = pricing.input_per_1k_tokens;
  if (!(typeof price === 'number' && Number.isFinite(price) && price >= 0) || !pricing.currency?.trim() || !pricing.pricing_version?.trim()) return 'INCOMPLETE_PRICING';
  if (pricing.currency.trim().toUpperCase() !== guard.currency.trim().toUpperCase()) return 'CURRENCY_MISMATCH';
  return null;
}

/**
 * Embeddings through the same guard and ledger as the Responses client. There is no input-token counting endpoint for
 * embeddings, so the worst case is the UTF-8 byte length of the input strings: the tokenizer is byte-level BPE, every
 * token covers at least one byte, so tokens never exceed bytes. That bound is reserved in the ledger, the call is sent
 * once without retries, and the reported prompt_tokens settle the actual cost. Token-array inputs are refused.
 */
export function createGuardedOpenAiEmbeddingsClient(config: GuardedOpenAiEmbeddingsClientConfig): OpenAiEmbeddingsTransport {
  const providerLabel = config.provider_label ?? 'openai';
  return {
    embeddings: {
      create: async (body, options = {}) => {
        const configurationRefusal = embeddingConfigurationRefusal(config.costGuard, config.pricing);
        if (configurationRefusal) throw refusal(configurationRefusal, 'PRE_CALL_COST_GUARD');
        const guard = config.costGuard as EmbeddingCostGuardConfig;
        const pricing = config.pricing as EmbeddingPricingConfig;
        if (!config.ledger) throw refusal('LEDGER_NOT_CONFIGURED', 'PRE_CALL_COST_GUARD');
        const precheck = config.ledger.precheck({ currency: guard.currency });
        if (!precheck.allowed) throw refusal(precheck.reason, 'PRE_CALL_BUDGET_GUARD');

        const inputs = typeof body.input === 'string' ? [body.input] : body.input;
        if (!Array.isArray(inputs) || inputs.length === 0 || !inputs.every((item) => typeof item === 'string' && item.length > 0)) {
          throw refusal('INVALID_REQUEST_SIZE', 'PRE_CALL_COST_GUARD');
        }
        const maxInputTokens = (inputs as string[]).reduce((sum, item) => sum + Buffer.byteLength(item, 'utf8') + EMBEDDING_INPUT_TOKEN_ALLOWANCE, 0);
        const maxCost = (maxInputTokens / 1000) * pricing.input_per_1k_tokens;
        if (!Number.isFinite(maxCost) || maxCost > guard.max_cost) throw refusal('MAX_COST_EXCEEDS_LIMIT', 'PRE_CALL_COST_GUARD');

        const model = typeof body.model === 'string' ? body.model : 'unknown';
        // A zero-price model still takes a ledger slot; the ledger only accepts positive reservations.
        const reservation = config.ledger.reserve({ max_cost: Math.max(maxCost, Number.EPSILON), currency: guard.currency, label: `${providerLabel}:${model}` });
        if (!reservation.allowed) throw refusal(reservation.reason, 'PRE_CALL_BUDGET_GUARD');

        let response: Record<string, unknown>;
        try {
          response = await config.transport.embeddings.create(body, { ...options, maxRetries: 0 });
        } catch (error) {
          settleQuietly(config.ledger, reservation.reservation_id, null);
          throw error;
        }

        const promptTokens = (response.usage as Record<string, unknown> | undefined)?.prompt_tokens;
        if (!(typeof promptTokens === 'number' && Number.isFinite(promptTokens) && promptTokens >= 0)) {
          settleQuietly(config.ledger, reservation.reservation_id, null);
          throw refusal('USAGE_MISSING', 'POST_CALL_COST_GUARD', 'AI_COST_LIMIT_EXCEEDED');
        }
        const actualCost = (promptTokens / 1000) * pricing.input_per_1k_tokens;
        settleQuietly(config.ledger, reservation.reservation_id, actualCost);
        if (promptTokens > maxInputTokens) throw refusal('INPUT_TOKENS_EXCEED_BOUND', 'POST_CALL_COST_GUARD', 'AI_COST_LIMIT_EXCEEDED');
        if (actualCost > guard.max_cost) throw refusal('ACTUAL_COST_EXCEEDS_LIMIT', 'POST_CALL_COST_GUARD', 'AI_COST_LIMIT_EXCEEDED');
        return response;
      },
    },
  };
}

/**
 * Guarded embeddings client from the environment: OPENAI_EMBEDDING_PRICING_INPUT_PER_1K_TOKENS and
 * OPENAI_EMBEDDING_PRICING_VERSION for the price (currency OPENAI_PRICING_CURRENCY), and the experiment limit and
 * ledger the Responses client uses (AI_EXPERIMENT_MAX_COST, AI_EXPERIMENT_COST_CURRENCY,
 * AI_EXPERIMENT_BUDGET_LEDGER_PATH). Missing or invalid values throw; there are no defaults.
 */
export function createGuardedOpenAiEmbeddingsClientFromEnv(env: NodeJS.ProcessEnv, apiKey: string): OpenAiEmbeddingsTransport {
  const pricing: EmbeddingPricingConfig = {
    input_per_1k_tokens: envPrice(env, 'OPENAI_EMBEDDING_PRICING_INPUT_PER_1K_TOKENS') ?? Number.NaN,
    currency: envText(env, 'OPENAI_PRICING_CURRENCY') ?? '',
    pricing_version: envText(env, 'OPENAI_EMBEDDING_PRICING_VERSION') ?? '',
  };
  const costGuard: EmbeddingCostGuardConfig = {
    max_cost: Number(env.AI_EXPERIMENT_MAX_COST),
    currency: envText(env, 'AI_EXPERIMENT_COST_CURRENCY') ?? '',
  };
  const configurationRefusal = embeddingConfigurationRefusal(costGuard, pricing);
  if (configurationRefusal) {
    throw new Error(`OpenAI embeddings cost guard is not configured (${configurationRefusal}): OPENAI_EMBEDDING_PRICING_INPUT_PER_1K_TOKENS, OPENAI_EMBEDDING_PRICING_VERSION, OPENAI_PRICING_CURRENCY, AI_EXPERIMENT_MAX_COST and AI_EXPERIMENT_COST_CURRENCY are required`);
  }
  const ledgerPath = envText(env, 'AI_EXPERIMENT_BUDGET_LEDGER_PATH');
  if (!ledgerPath) throw new Error('OpenAI embeddings cost guard is not configured: AI_EXPERIMENT_BUDGET_LEDGER_PATH is required');
  const ledger = new FileExperimentBudgetLedger(ledgerPath);
  ledger.read();
  return createGuardedOpenAiEmbeddingsClient({ transport: createSdkTransport(apiKey), pricing, costGuard, ledger });
}

/** Speech to text (POST /v1/audio/transcriptions); the guarded transcriber below is its only user. */
export interface OpenAiTranscriptionsTransport {
  audio: {
    transcriptions: {
      create: (body: Record<string, unknown>, options?: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
  };
}

/** Price of a transcription model billed by audio length (gpt-transcribe). */
export interface TranscriptionPricingConfig {
  per_minute: number;
  currency: string;
  pricing_version: string;
}

export interface GuardedTranscriptionRequest {
  model: string;
  audio: Buffer;
  /** The file name OpenAI reads the format from (voice.m4a). */
  filename: string;
  /** Length of the recording read from the file itself by the caller, never taken from the client's word. */
  duration_seconds: number;
  languages?: string[];
  prompt?: string;
}

export interface GuardedTranscriptionResult {
  text: string;
  /** Seconds OpenAI billed (usage of type "duration"); null when it reported none. */
  billed_seconds: number | null;
  /** Cost settled in the ledger: from the billed seconds, or the reserved worst case when none were reported. */
  cost: number;
}

export interface GuardedOpenAiTranscriber {
  transcribe(request: GuardedTranscriptionRequest, options?: { timeout?: number; signal?: AbortSignal }): Promise<GuardedTranscriptionResult>;
}

export interface GuardedOpenAiTranscriberConfig {
  transport: OpenAiTranscriptionsTransport;
  pricing: TranscriptionPricingConfig | null | undefined;
  costGuard: EmbeddingCostGuardConfig | null | undefined;
  ledger: ExperimentBudgetLedger | null | undefined;
  provider_label?: string;
}

/** Billed seconds may round up the measured length; the bound allows 10% and two seconds more. */
const TRANSCRIPTION_BOUND_FACTOR = 1.1;
const TRANSCRIPTION_BOUND_EXTRA_SECONDS = 2;

function transcriptionConfigurationRefusal(guard: EmbeddingCostGuardConfig | null | undefined, pricing: TranscriptionPricingConfig | null | undefined): string | null {
  if (!guard) return 'GUARD_NOT_CONFIGURED';
  if (!(typeof guard.max_cost === 'number' && Number.isFinite(guard.max_cost) && guard.max_cost > 0) || !guard.currency?.trim()) return 'INVALID_LIMIT';
  if (!pricing) return 'PRICING_NOT_CONFIGURED';
  const price = pricing.per_minute;
  if (!(typeof price === 'number' && Number.isFinite(price) && price >= 0) || !pricing.currency?.trim() || !pricing.pricing_version?.trim()) return 'INCOMPLETE_PRICING';
  if (pricing.currency.trim().toUpperCase() !== guard.currency.trim().toUpperCase()) return 'CURRENCY_MISMATCH';
  return null;
}

/**
 * Transcriptions through the same guard and ledger as the Responses client. A model billed by audio length costs at
 * most the measured length (plus the rounding allowance) times the price per minute: that bound is reserved, the call
 * is sent once without retries and the billed seconds (usage of type "duration") settle the actual cost. A response
 * without billed seconds keeps the worst case charged. The text is returned even when the billed seconds exceed the
 * bound (it is paid for already); only a cost above the per-call limit is refused.
 */
export function createGuardedOpenAiTranscriber(config: GuardedOpenAiTranscriberConfig): GuardedOpenAiTranscriber {
  const providerLabel = config.provider_label ?? 'openai';
  return {
    transcribe: async (request, options = {}) => {
      const configurationRefusal = transcriptionConfigurationRefusal(config.costGuard, config.pricing);
      if (configurationRefusal) throw refusal(configurationRefusal, 'PRE_CALL_COST_GUARD');
      const guard = config.costGuard as EmbeddingCostGuardConfig;
      const pricing = config.pricing as TranscriptionPricingConfig;
      if (!config.ledger) throw refusal('LEDGER_NOT_CONFIGURED', 'PRE_CALL_COST_GUARD');
      const precheck = config.ledger.precheck({ currency: guard.currency });
      if (!precheck.allowed) throw refusal(precheck.reason, 'PRE_CALL_BUDGET_GUARD');

      if (!(Number.isFinite(request.duration_seconds) && request.duration_seconds > 0) || request.audio.length === 0) {
        throw refusal('INVALID_REQUEST_SIZE', 'PRE_CALL_COST_GUARD');
      }
      const maxSeconds = request.duration_seconds * TRANSCRIPTION_BOUND_FACTOR + TRANSCRIPTION_BOUND_EXTRA_SECONDS;
      const maxCost = (maxSeconds / 60) * pricing.per_minute;
      if (!Number.isFinite(maxCost) || maxCost > guard.max_cost) throw refusal('MAX_COST_EXCEEDS_LIMIT', 'PRE_CALL_COST_GUARD');

      const reservation = config.ledger.reserve({ max_cost: Math.max(maxCost, Number.EPSILON), currency: guard.currency, label: `${providerLabel}:${request.model}` });
      if (!reservation.allowed) throw refusal(reservation.reason, 'PRE_CALL_BUDGET_GUARD');

      let response: Record<string, unknown>;
      try {
        const body: Record<string, unknown> = {
          model: request.model,
          file: await toFile(request.audio, request.filename),
          response_format: 'json',
          ...(request.languages?.length ? { languages: request.languages } : {}),
          ...(request.prompt ? { prompt: request.prompt } : {}),
        };
        response = await config.transport.audio.transcriptions.create(body, { ...options, maxRetries: 0 });
      } catch (error) {
        settleQuietly(config.ledger, reservation.reservation_id, null);
        throw error;
      }

      const usage = response.usage as Record<string, unknown> | undefined;
      const seconds = usage?.type === 'duration' && typeof usage.seconds === 'number' && Number.isFinite(usage.seconds) && usage.seconds >= 0 ? usage.seconds : null;
      const actualCost = seconds === null ? maxCost : (seconds / 60) * pricing.per_minute;
      settleQuietly(config.ledger, reservation.reservation_id, actualCost);
      if (actualCost > guard.max_cost) throw refusal('ACTUAL_COST_EXCEEDS_LIMIT', 'POST_CALL_COST_GUARD', 'AI_COST_LIMIT_EXCEEDED');
      return { text: typeof response.text === 'string' ? response.text : '', billed_seconds: seconds, cost: actualCost };
    },
  };
}

/**
 * Guarded transcriber from the environment: OPENAI_TRANSCRIPTION_PRICING_PER_MINUTE and
 * OPENAI_TRANSCRIPTION_PRICING_VERSION for the price (currency OPENAI_PRICING_CURRENCY), and the experiment limit and
 * ledger the Responses client uses. Missing or invalid values throw; there are no defaults.
 */
export function createGuardedOpenAiTranscriberFromEnv(env: NodeJS.ProcessEnv, apiKey: string): GuardedOpenAiTranscriber {
  const pricing: TranscriptionPricingConfig = {
    per_minute: envPrice(env, 'OPENAI_TRANSCRIPTION_PRICING_PER_MINUTE') ?? Number.NaN,
    currency: envText(env, 'OPENAI_PRICING_CURRENCY') ?? '',
    pricing_version: envText(env, 'OPENAI_TRANSCRIPTION_PRICING_VERSION') ?? '',
  };
  const costGuard: EmbeddingCostGuardConfig = {
    max_cost: Number(env.AI_EXPERIMENT_MAX_COST),
    currency: envText(env, 'AI_EXPERIMENT_COST_CURRENCY') ?? '',
  };
  const configurationRefusal = transcriptionConfigurationRefusal(costGuard, pricing);
  if (configurationRefusal) {
    throw new Error(`OpenAI transcription cost guard is not configured (${configurationRefusal}): OPENAI_TRANSCRIPTION_PRICING_PER_MINUTE, OPENAI_TRANSCRIPTION_PRICING_VERSION, OPENAI_PRICING_CURRENCY, AI_EXPERIMENT_MAX_COST and AI_EXPERIMENT_COST_CURRENCY are required`);
  }
  const ledgerPath = envText(env, 'AI_EXPERIMENT_BUDGET_LEDGER_PATH');
  if (!ledgerPath) throw new Error('OpenAI transcription cost guard is not configured: AI_EXPERIMENT_BUDGET_LEDGER_PATH is required');
  const ledger = new FileExperimentBudgetLedger(ledgerPath);
  ledger.read();
  return createGuardedOpenAiTranscriber({ transport: createSdkTransport(apiKey), pricing, costGuard, ledger });
}
