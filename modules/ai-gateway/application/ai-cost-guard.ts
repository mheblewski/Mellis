import type { AIPricingConfig, AIUsage } from '@modules/ai-gateway/domain/ai-gateway';
import { cacheWritePricePer1k, calculateProviderUsageCost } from './ai-observability';

/**
 * Hard cost limit of one provider call.
 * No field has a default: a missing or invalid value refuses the call.
 */
export interface AiCostGuardConfig {
  max_cost: number;
  currency: string;
  /** Sent to the provider as max_output_tokens; it caps visible and reasoning output together. */
  max_output_tokens: number;
}

/**
 * Framing allowance added to the byte-based input estimate. The byte estimate (UTF-8 bytes of the exact request body
 * plus this allowance) is only a heuristic: it is not a proven bound for an unknown tokenizer or for framing the
 * provider adds. The authoritative input figure is the provider's own count of the exact request
 * (counted_input_tokens); the bound uses the larger of the two, and refuses the call without a count.
 */
export const INPUT_TOKEN_FRAMING_ALLOWANCE = 1024;

/**
 * Byte-estimate stand-in for one inline image (data URL). Its base64 bytes say nothing about its tokens: a photo of a
 * few hundred kB costs about a thousand input tokens (resized to 1280 px). The provider's count of the exact request,
 * images included, still enters the bound as its larger term, so this allowance never lowers the bound below it.
 */
export const IMAGE_INPUT_TOKEN_ALLOWANCE = 3000;

/**
 * UTF-8 size of the request body for the byte-based estimate, with every inline image data URL replaced by
 * IMAGE_INPUT_TOKEN_ALLOWANCE.
 */
export function serializedRequestSizeForBound(body: Record<string, unknown>): number {
  let images = 0;
  const serialized = JSON.stringify(body, (_key, value: unknown) => {
    if (typeof value === 'string' && /^data:image\/[a-z+.-]+;base64,/i.test(value)) {
      images += 1;
      return '';
    }
    return value;
  });
  return Buffer.byteLength(serialized, 'utf8') + images * IMAGE_INPUT_TOKEN_ALLOWANCE;
}

export type CostGuardRefusalReason =
  | 'GUARD_NOT_CONFIGURED'
  | 'INVALID_LIMIT'
  | 'PRICING_NOT_CONFIGURED'
  | 'INCOMPLETE_PRICING'
  | 'CURRENCY_MISMATCH'
  | 'INVALID_REQUEST_SIZE'
  | 'INPUT_TOKENS_UNCOUNTED'
  | 'LEDGER_NOT_CONFIGURED'
  | 'EXPERIMENT_CALL_LIMIT_REACHED'
  | 'EXPERIMENT_BUDGET_EXCEEDED'
  | 'LEDGER_UNAVAILABLE'
  | 'MAX_COST_EXCEEDS_LIMIT'
  | 'USAGE_MISSING'
  | 'COST_UNKNOWN'
  | 'OUTPUT_TOKENS_EXCEED_CAP'
  | 'INPUT_TOKENS_EXCEED_BOUND'
  | 'ACTUAL_COST_EXCEEDS_LIMIT';

export type PreCallCostDecision =
  | { allowed: true; max_cost: number; max_input_tokens: number; max_output_tokens: number; limit: number; currency: string }
  | { allowed: false; reason: CostGuardRefusalReason; max_cost: number | null; limit: number | null; currency: string | null };

export type PostCallCostDecision =
  | { allowed: true; actual_cost: number; limit: number; currency: string }
  | { allowed: false; reason: CostGuardRefusalReason; actual_cost: number | null; limit: number | null; currency: string | null };

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** Configuration check that needs no request: run it first so a misconfigured call is refused without any traffic. */
export function checkCostGuardConfiguration(guard: AiCostGuardConfig | null | undefined, pricing: AIPricingConfig | null | undefined): CostGuardRefusalReason | null {
  const validated = validateGuardAndPricing(guard, pricing);
  return validated.ok ? null : validated.reason;
}

function validateGuardAndPricing(guard: AiCostGuardConfig | null | undefined, pricing: AIPricingConfig | null | undefined):
  | { ok: true; guard: AiCostGuardConfig; pricing: AIPricingConfig & { currency: string } }
  | { ok: false; reason: CostGuardRefusalReason } {
  if (!guard) return { ok: false, reason: 'GUARD_NOT_CONFIGURED' };
  if (!(typeof guard.max_cost === 'number' && Number.isFinite(guard.max_cost) && guard.max_cost > 0)
    || !(Number.isInteger(guard.max_output_tokens) && guard.max_output_tokens > 0)
    || !guard.currency?.trim()) {
    return { ok: false, reason: 'INVALID_LIMIT' };
  }
  if (!pricing) return { ok: false, reason: 'PRICING_NOT_CONFIGURED' };
  const prices = [pricing.input_per_1k_tokens, pricing.output_per_1k_tokens, pricing.cached_input_per_1k_tokens, pricing.reasoning_per_1k_tokens];
  if (!prices.every(isNonNegativeFinite) || !pricing.currency?.trim() || !pricing.pricing_version?.trim()) {
    return { ok: false, reason: 'INCOMPLETE_PRICING' };
  }
  // Optional prices: when set they must be usable (a flex factor above 1 or at 0 would be a configuration mistake).
  if ((pricing.cache_write_per_1k_tokens != null && !isNonNegativeFinite(pricing.cache_write_per_1k_tokens))
    || (pricing.flex_price_multiplier != null && !(isNonNegativeFinite(pricing.flex_price_multiplier) && pricing.flex_price_multiplier > 0 && pricing.flex_price_multiplier <= 1))) {
    return { ok: false, reason: 'INCOMPLETE_PRICING' };
  }
  if (pricing.currency.trim().toUpperCase() !== guard.currency.trim().toUpperCase()) {
    return { ok: false, reason: 'CURRENCY_MISMATCH' };
  }
  return { ok: true, guard, pricing: pricing as AIPricingConfig & { currency: string } };
}

/**
 * Worst-case cost of one call, decided before the call. Input tokens: the larger of the provider's count of the exact
 * request and the byte-based estimate (see INPUT_TOKEN_FRAMING_ALLOWANCE); without a count the call is refused.
 * Output tokens: max_output_tokens, which the request sends and the provider enforces (reasoning included).
 * A worst case equal to the limit is allowed; anything above it is refused. Each input token is billed by the post-call
 * calculation (calculateProviderUsageCost) at either the input or the cached-input price, so input is bounded at the
 * higher of the two; output tokens are billed at the output price plus the reasoning surcharge for reasoning tokens (a
 * subset of output), so output is bounded at their sum. The actual calculated cost can never exceed this bound.
 */
export function evaluatePreCallCostBound(args: {
  guard: AiCostGuardConfig | null | undefined;
  pricing: AIPricingConfig | null | undefined;
  serialized_request_bytes: number;
  counted_input_tokens: number | null | undefined;
}): PreCallCostDecision {
  const validated = validateGuardAndPricing(args.guard, args.pricing);
  if (!validated.ok) {
    return { allowed: false, reason: validated.reason, max_cost: null, limit: args.guard?.max_cost ?? null, currency: args.guard?.currency ?? null };
  }
  const { guard, pricing } = validated;
  if (!(Number.isInteger(args.serialized_request_bytes) && args.serialized_request_bytes > 0)) {
    return { allowed: false, reason: 'INVALID_REQUEST_SIZE', max_cost: null, limit: guard.max_cost, currency: guard.currency };
  }

  const counted = args.counted_input_tokens;
  if (!(typeof counted === 'number' && Number.isInteger(counted) && counted > 0)) {
    return { allowed: false, reason: 'INPUT_TOKENS_UNCOUNTED', max_cost: null, limit: guard.max_cost, currency: guard.currency };
  }

  const byteEstimateTokens = args.serialized_request_bytes + INPUT_TOKEN_FRAMING_ALLOWANCE;
  const maxInputTokens = Math.max(counted, byteEstimateTokens);
  // Every counted token may be billed as a cache write (gpt-5.6: 1.25x input), the highest input price, so the exact
  // count is bounded at that price. The byte estimate is a heuristic cushion (UTF-8 bytes, ~2.5x the tokens of a JSON
  // request) kept at the higher of the input and cache read prices, as before cache writes were priced: applying the
  // write price to it too refused a 22:56 causal question (2026-10-18) whose real worst case was far below the limit.
  const inputCost = Math.max(
    (counted / 1000) * Math.max(pricing.input_per_1k_tokens as number, pricing.cached_input_per_1k_tokens as number, cacheWritePricePer1k(pricing) ?? 0),
    (byteEstimateTokens / 1000) * Math.max(pricing.input_per_1k_tokens as number, pricing.cached_input_per_1k_tokens as number),
  );
  const outputPricePer1k = (pricing.output_per_1k_tokens as number) + (pricing.reasoning_per_1k_tokens as number);
  const maxCost = inputCost + (guard.max_output_tokens / 1000) * outputPricePer1k;

  if (!Number.isFinite(maxCost) || maxCost > guard.max_cost) {
    return { allowed: false, reason: 'MAX_COST_EXCEEDS_LIMIT', max_cost: maxCost, limit: guard.max_cost, currency: guard.currency };
  }
  return {
    allowed: true,
    max_cost: maxCost,
    max_input_tokens: maxInputTokens,
    max_output_tokens: guard.max_output_tokens,
    limit: guard.max_cost,
    currency: guard.currency,
  };
}

/**
 * Verifies the reported usage after the call: it must be present, within the bounds the pre-call decision assumed,
 * and its calculated cost must be known and within the limit. Unknown cost is never treated as zero.
 */
export function evaluatePostCallCost(args: {
  provider: string;
  model: string;
  guard: AiCostGuardConfig | null | undefined;
  pricing: AIPricingConfig | null | undefined;
  usage: AIUsage | null | undefined;
  max_input_tokens: number;
}): PostCallCostDecision {
  const validated = validateGuardAndPricing(args.guard, args.pricing);
  if (!validated.ok) {
    return { allowed: false, reason: validated.reason, actual_cost: null, limit: args.guard?.max_cost ?? null, currency: args.guard?.currency ?? null };
  }
  const { guard, pricing } = validated;
  const refuse = (reason: CostGuardRefusalReason, actualCost: number | null = null): PostCallCostDecision => ({
    allowed: false, reason, actual_cost: actualCost, limit: guard.max_cost, currency: guard.currency,
  });

  const usage = args.usage;
  if (!usage || !isNonNegativeFinite(usage.input_tokens) || !isNonNegativeFinite(usage.output_tokens)) {
    return refuse('USAGE_MISSING');
  }
  if (usage.output_tokens > guard.max_output_tokens) {
    return refuse('OUTPUT_TOKENS_EXCEED_CAP');
  }
  if (usage.input_tokens > args.max_input_tokens) {
    return refuse('INPUT_TOKENS_EXCEED_BOUND');
  }

  const calculation = calculateProviderUsageCost({ provider: args.provider, model: args.model, usage, pricing });
  if (calculation.status !== 'KNOWN') {
    return refuse('COST_UNKNOWN');
  }
  if (!Number.isFinite(calculation.amount) || calculation.amount > guard.max_cost) {
    return refuse('ACTUAL_COST_EXCEEDS_LIMIT', calculation.amount);
  }
  return { allowed: true, actual_cost: calculation.amount, limit: guard.max_cost, currency: guard.currency };
}
