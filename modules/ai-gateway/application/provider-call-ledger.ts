import { canonicalJson } from '@shared/utils/canonical-json';
import type { AICostEstimate, AIUsage, AiRuntimeToolResult } from '@modules/ai-gateway/domain/ai-gateway';

export const PROVIDER_CALL_LEDGER_VERSION = 'provider-call-ledger.v1' as const;

export type ProviderCallTurnKind = 'INITIAL' | 'TOOL_CONTINUATION' | 'FINALIZATION';

const TOKEN_FIELDS = ['input_tokens', 'output_tokens', 'total_tokens', 'cached_input_tokens', 'reasoning_tokens'] as const;
type TokenField = typeof TOKEN_FIELDS[number];
/** cache_write_tokens only when reported: Claude writes the prompt cache above the input price, so it is part of the cost. */
type TokenCounts = Record<TokenField, number | null> & { cache_write_tokens?: number };

/**
 * One provider request inside a single gateway attempt. Contains measurements and structural
 * metadata only: no prompt text, tool results or patient data.
 */
export interface ProviderCallLedgerEntry {
  call_index: number;
  turn_kind: ProviderCallTurnKind;
  outcome: 'RESPONDED' | 'FAILED';
  previous_response_id_sent: boolean;
  /** Values exactly as reported by the provider response; null when the provider did not report them. */
  provider_reported_usage: TokenCounts | null;
  usage_status: 'REPORTED' | 'MISSING' | 'UNKNOWN_CALL_FAILED';
  /** Local estimate from configured pricing (calculateProviderUsageCost), not a provider-reported cost. */
  local_cost_estimate: {
    amount: number;
    currency: string | null;
    pricing_version: string | null;
    input_cost: number | null;
    output_cost: number | null;
    cached_input_cost: number | null;
    cache_write_cost?: number | null;
    reasoning_cost: number | null;
  } | null;
  /** UTF-8 byte counts measured locally. */
  measured_bytes: {
    provider_request_body: number | null;
    system_instructions: number;
    user_payload: number;
    tool_definitions: number;
    tool_results_sent: number;
    tool_results_new: number;
    tool_results_resent: number;
  };
  tool_results_sent_count: number;
  tool_results_resent_count: number;
  /** How tool outputs were delivered; null outside the evidence tool loop. */
  tool_result_delivery: 'FULL_RESEND' | 'NEW_ONLY_CHAINED' | 'FULL_RESEND_CHAIN_FALLBACK' | null;
  /** Earlier tool outputs not sent because the previous_response_id chain already contains them. */
  tool_results_omitted_chained_count: number;
  tool_results_omitted_chained_bytes: number;
  /** CHAINED: system/user prompt not resent because the previous_response_id chain carries it. */
  prompt_delivery: 'FULL' | 'CHAINED';
  requested_tool_call_count: number | null;
  provider_latency_ms: number | null;
}

export interface ProviderCallLedgerAggregate {
  ledger_version: typeof PROVIDER_CALL_LEDGER_VERSION;
  /** One gateway execute() invocation (= one ai_execution_attempts row). Retries are separate attempts. */
  scope: 'GATEWAY_ATTEMPT';
  provider_call_count: number;
  responded_call_count: number;
  failed_call_count: number;
  tokens: {
    source: 'PROVIDER_REPORTED_SUM';
    /** True only when every provider call in the attempt returned usage. */
    complete: boolean;
    calls_with_usage: number;
    /** Sum over all calls; null when any call's usage is unknown. */
    totals: TokenCounts;
    /** Sum over calls that reported usage only; a lower bound when incomplete. */
    reported_sums: TokenCounts;
  };
  bytes: {
    source: 'LOCAL_MEASURED_UTF8';
    provider_request_body_total: number | null;
    system_instructions_total: number;
    user_payload_total: number;
    tool_definitions_total: number;
    tool_results_sent_total: number;
    tool_results_unique_total: number;
    tool_results_resent_total: number;
    tool_results_omitted_chained_total: number;
  };
  cost: {
    provider_reported: null;
    local_estimate_total: number | null;
    local_estimate_currency: string | null;
    local_estimate_pricing_version: string | null;
    local_estimate_kind: 'LOCAL_ESTIMATE_CONFIGURED_PRICING' | 'UNAVAILABLE';
  };
  /** Derived: call indices ordered by provider-reported input tokens, highest first. */
  calls_by_input_tokens_desc: number[];
  calls: ProviderCallLedgerEntry[];
}

export interface ProviderCallRequestShape {
  turn_kind: ProviderCallTurnKind;
  previous_response_id: string | null | undefined;
  system_instructions: string;
  user_payload: string;
  available_tools: unknown[];
  tool_results: AiRuntimeToolResult[];
  tool_result_delivery?: ProviderCallLedgerEntry['tool_result_delivery'];
  omitted_chained_tool_results?: AiRuntimeToolResult[];
  prompt_delivery?: ProviderCallLedgerEntry['prompt_delivery'];
}

export class ProviderCallLedger {
  private readonly entries: ProviderCallLedgerEntry[] = [];
  private readonly sentToolResultCallIds = new Set<string>();

  recordResponse(request: ProviderCallRequestShape, response: {
    usage?: AIUsage | null;
    estimated_cost?: AICostEstimate | null;
    serialized_input_bytes?: number | null;
    provider_latency_ms?: number | null;
    requested_tool_call_count: number;
  }): void {
    const usage = toTokenCounts(response.usage ?? null);
    const cost = response.estimated_cost && isFiniteNumber(response.estimated_cost.estimated_cost)
      ? {
          amount: response.estimated_cost.estimated_cost,
          currency: response.estimated_cost.currency ?? null,
          pricing_version: response.estimated_cost.pricing_version ?? null,
          input_cost: response.estimated_cost.input_cost ?? null,
          output_cost: response.estimated_cost.output_cost ?? null,
          cached_input_cost: response.estimated_cost.cached_input_cost ?? null,
          ...(isFiniteNumber(response.estimated_cost.cache_write_cost) ? { cache_write_cost: response.estimated_cost.cache_write_cost } : {}),
          reasoning_cost: response.estimated_cost.reasoning_cost ?? null,
        }
      : null;

    this.entries.push({
      ...this.measureRequest(request),
      outcome: 'RESPONDED',
      provider_reported_usage: usage,
      usage_status: usage ? 'REPORTED' : 'MISSING',
      local_cost_estimate: cost,
      measured_bytes: {
        ...this.measureRequestBytes(request),
        provider_request_body: isFiniteNumber(response.serialized_input_bytes) ? response.serialized_input_bytes : null,
      },
      requested_tool_call_count: response.requested_tool_call_count,
      provider_latency_ms: isFiniteNumber(response.provider_latency_ms) ? response.provider_latency_ms : null,
    });
    this.markToolResultsSent(request.tool_results);
  }

  recordFailure(request: ProviderCallRequestShape): void {
    this.entries.push({
      ...this.measureRequest(request),
      outcome: 'FAILED',
      provider_reported_usage: null,
      usage_status: 'UNKNOWN_CALL_FAILED',
      local_cost_estimate: null,
      measured_bytes: {
        ...this.measureRequestBytes(request),
        provider_request_body: null,
      },
      requested_tool_call_count: null,
      provider_latency_ms: null,
    });
    this.markToolResultsSent(request.tool_results);
  }

  hasCalls(): boolean {
    return this.entries.length > 0;
  }

  buildAggregate(): ProviderCallLedgerAggregate {
    const calls = this.entries.map((entry) => ({ ...entry }));
    const withUsage = calls.filter((entry) => entry.provider_reported_usage !== null);
    const complete = calls.length > 0 && withUsage.length === calls.length;

    const reportedSums = Object.fromEntries(TOKEN_FIELDS.map((field) => {
      const values = withUsage
        .map((entry) => entry.provider_reported_usage?.[field])
        .filter(isFiniteNumber);
      return [field, values.length > 0 ? values.reduce((sum, value) => sum + value, 0) : null];
    })) as TokenCounts;

    const totals = Object.fromEntries(TOKEN_FIELDS.map((field) => {
      const everyCallReported = complete && withUsage.every((entry) => isFiniteNumber(entry.provider_reported_usage?.[field]));
      return [field, everyCallReported ? reportedSums[field] : null];
    })) as TokenCounts;

    const requestBodies = calls.map((entry) => entry.measured_bytes.provider_request_body);
    const sumBytes = (pick: (entry: ProviderCallLedgerEntry) => number) => calls.reduce((sum, entry) => sum + pick(entry), 0);

    const billableCalls = calls.filter((entry) => entry.provider_reported_usage !== null);
    const costs = billableCalls.map((entry) => entry.local_cost_estimate);
    const costComplete = billableCalls.length > 0 && costs.every((cost) => cost !== null);
    const currencies = new Set(costs.map((cost) => cost?.currency ?? null));
    const pricingVersions = new Set(costs.map((cost) => cost?.pricing_version ?? null));

    return {
      ledger_version: PROVIDER_CALL_LEDGER_VERSION,
      scope: 'GATEWAY_ATTEMPT',
      provider_call_count: calls.length,
      responded_call_count: calls.filter((entry) => entry.outcome === 'RESPONDED').length,
      failed_call_count: calls.filter((entry) => entry.outcome === 'FAILED').length,
      tokens: {
        source: 'PROVIDER_REPORTED_SUM',
        complete,
        calls_with_usage: withUsage.length,
        totals,
        reported_sums: reportedSums,
      },
      bytes: {
        source: 'LOCAL_MEASURED_UTF8',
        provider_request_body_total: requestBodies.every(isFiniteNumber) && requestBodies.length > 0
          ? (requestBodies as number[]).reduce((sum, value) => sum + value, 0)
          : null,
        system_instructions_total: sumBytes((entry) => entry.measured_bytes.system_instructions),
        user_payload_total: sumBytes((entry) => entry.measured_bytes.user_payload),
        tool_definitions_total: sumBytes((entry) => entry.measured_bytes.tool_definitions),
        tool_results_sent_total: sumBytes((entry) => entry.measured_bytes.tool_results_sent),
        tool_results_unique_total: sumBytes((entry) => entry.measured_bytes.tool_results_new),
        tool_results_resent_total: sumBytes((entry) => entry.measured_bytes.tool_results_resent),
        tool_results_omitted_chained_total: calls.reduce((sum, entry) => sum + entry.tool_results_omitted_chained_bytes, 0),
      },
      cost: costComplete && currencies.size === 1
        ? {
            provider_reported: null,
            local_estimate_total: costs.reduce((sum, cost) => sum + (cost?.amount ?? 0), 0),
            local_estimate_currency: costs[0]?.currency ?? null,
            local_estimate_pricing_version: pricingVersions.size === 1 ? (costs[0]?.pricing_version ?? null) : null,
            local_estimate_kind: 'LOCAL_ESTIMATE_CONFIGURED_PRICING',
          }
        : {
            provider_reported: null,
            local_estimate_total: null,
            local_estimate_currency: null,
            local_estimate_pricing_version: null,
            local_estimate_kind: 'UNAVAILABLE',
          },
      calls_by_input_tokens_desc: withUsage
        .filter((entry) => isFiniteNumber(entry.provider_reported_usage?.input_tokens))
        .sort((left, right) => (right.provider_reported_usage?.input_tokens ?? 0) - (left.provider_reported_usage?.input_tokens ?? 0)
          || left.call_index - right.call_index)
        .map((entry) => entry.call_index),
      calls,
    };
  }

  /**
   * Attempt-level usage for the existing attempt observer: summed across every provider call.
   * A field is null when any call did not report it, matching the repository's null-propagation rule.
   */
  buildAttemptUsage(): AIUsage | null {
    if (!this.hasCalls()) {
      return null;
    }

    const aggregate = this.buildAggregate();
    if (aggregate.tokens.calls_with_usage === 0) {
      return null;
    }

    return { ...aggregate.tokens.totals };
  }

  /** Usage of provider calls that returned a response; used for failed attempts (lower bound). */
  buildRespondedCallsUsage(): AIUsage | null {
    const aggregate = this.buildAggregate();
    return aggregate.tokens.calls_with_usage > 0 ? { ...aggregate.tokens.reported_sums } : null;
  }

  /**
   * Sum of per-call local cost estimates. With `respondedOnly = false` every call must have reported
   * usage; with `true` only calls that responded are summed (lower bound for failed attempts).
   * Returns null when any summed call lacks an estimate or currencies differ.
   */
  buildAttemptCostEstimate(respondedOnly = false): AICostEstimate | null {
    const calls = this.entries.filter((entry) => entry.provider_reported_usage !== null);
    if (calls.length === 0 || (!respondedOnly && calls.length !== this.entries.length)) {
      return null;
    }
    if (calls.some((entry) => entry.local_cost_estimate === null)) {
      return null;
    }

    const currencies = new Set(calls.map((entry) => entry.local_cost_estimate?.currency ?? null));
    if (currencies.size !== 1) {
      return null;
    }
    const pricingVersions = new Set(calls.map((entry) => entry.local_cost_estimate?.pricing_version ?? null));

    return {
      estimated_cost: calls.reduce((sum, entry) => sum + (entry.local_cost_estimate?.amount ?? 0), 0),
      currency: calls[0].local_cost_estimate?.currency ?? null,
      pricing_version: pricingVersions.size === 1 ? (calls[0].local_cost_estimate?.pricing_version ?? null) : null,
      input_cost: sumComponent(calls, 'input_cost'),
      output_cost: sumComponent(calls, 'output_cost'),
      cached_input_cost: sumComponent(calls, 'cached_input_cost'),
      ...(calls.some((entry) => isFiniteNumber(entry.local_cost_estimate?.cache_write_cost)) ? { cache_write_cost: calls.reduce((sum, entry) => sum + (entry.local_cost_estimate?.cache_write_cost ?? 0), 0) } : {}),
      reasoning_cost: sumComponent(calls, 'reasoning_cost'),
    };
  }

  private measureRequest(request: ProviderCallRequestShape): Pick<ProviderCallLedgerEntry, 'call_index' | 'turn_kind' | 'previous_response_id_sent' | 'tool_results_sent_count' | 'tool_results_resent_count' | 'tool_result_delivery' | 'tool_results_omitted_chained_count' | 'tool_results_omitted_chained_bytes' | 'prompt_delivery'> {
    const omitted = request.omitted_chained_tool_results ?? [];
    return {
      prompt_delivery: request.prompt_delivery ?? 'FULL',
      tool_result_delivery: request.tool_result_delivery ?? null,
      tool_results_omitted_chained_count: omitted.length,
      tool_results_omitted_chained_bytes: omitted.reduce((sum, result) => sum + utf8Bytes(canonicalJson(result.result)), 0),
      call_index: this.entries.length + 1,
      turn_kind: request.turn_kind,
      previous_response_id_sent: typeof request.previous_response_id === 'string' && request.previous_response_id.length > 0,
      tool_results_sent_count: request.tool_results.length,
      tool_results_resent_count: request.tool_results.filter((result) => this.sentToolResultCallIds.has(toolResultKey(result))).length,
    };
  }

  private measureRequestBytes(request: ProviderCallRequestShape): Omit<ProviderCallLedgerEntry['measured_bytes'], 'provider_request_body'> {
    let sent = 0;
    let fresh = 0;
    let resent = 0;
    for (const result of request.tool_results) {
      const bytes = utf8Bytes(canonicalJson(result.result));
      sent += bytes;
      if (this.sentToolResultCallIds.has(toolResultKey(result))) {
        resent += bytes;
      } else {
        fresh += bytes;
      }
    }

    return {
      system_instructions: utf8Bytes(request.system_instructions),
      user_payload: utf8Bytes(request.user_payload),
      tool_definitions: request.available_tools.length > 0 ? utf8Bytes(canonicalJson(request.available_tools)) : 0,
      tool_results_sent: sent,
      tool_results_new: fresh,
      tool_results_resent: resent,
    };
  }

  private markToolResultsSent(results: AiRuntimeToolResult[]): void {
    for (const result of results) {
      this.sentToolResultCallIds.add(toolResultKey(result));
    }
  }
}

function sumComponent(
  calls: ProviderCallLedgerEntry[],
  field: 'input_cost' | 'output_cost' | 'cached_input_cost' | 'reasoning_cost',
): number | null {
  const values = calls.map((entry) => entry.local_cost_estimate?.[field] ?? null);
  return values.every(isFiniteNumber) ? (values as number[]).reduce((sum, value) => sum + value, 0) : null;
}

function toolResultKey(result: AiRuntimeToolResult): string {
  return `${result.call_id ?? ''}:${result.tool_name}`;
}

function toTokenCounts(usage: AIUsage | null): TokenCounts | null {
  if (!usage) {
    return null;
  }

  const counts = Object.fromEntries(TOKEN_FIELDS.map((field) => [field, isFiniteNumber(usage[field]) ? usage[field] : null])) as TokenCounts;
  if (isFiniteNumber(usage.cache_write_tokens)) counts.cache_write_tokens = usage.cache_write_tokens;
  return TOKEN_FIELDS.some((field) => counts[field] !== null) ? counts : null;
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
