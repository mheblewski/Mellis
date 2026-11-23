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
 * Slack added to the provider's count of the exact request: the input the bound and the post-call check allow. The
 * count is the authoritative input figure (a call without one is refused); the slack covers framing the provider may
 * add on top of it. A chained round's local bound (guarded-openai-client chainedInputTokenBound) adds it as well.
 *
 * Until 2026-11-22 the bound also took the request's UTF-8 bytes as tokens (about 2.5x the real count of a JSON
 * request): a dose question on OpenAI (~100 kB, about 40k tokens, a few cents) was refused at the 0.25 USD limit.
 */
export const INPUT_TOKEN_FRAMING_ALLOWANCE = 1024;

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
 * Worst-case cost of one call, decided before the call. Input tokens: the provider's count of the exact request plus
 * INPUT_TOKEN_FRAMING_ALLOWANCE; without a count the call is refused. Output tokens: max_output_tokens, which the request
 * sends and the provider enforces (reasoning included).
 * A worst case equal to the limit is allowed; anything above it is refused. Each input token is billed by the post-call
 * calculation (calculateProviderUsageCost) at the input, cached-input or cache-write price, so input is bounded at the
 * highest of them; output tokens are billed at the output price plus the reasoning surcharge for reasoning tokens (a
 * subset of output), so output is bounded at their sum. The post-call check refuses input above the bound, so the actual
 * calculated cost can never exceed it.
 */
export function evaluatePreCallCostBound(args: {
  guard: AiCostGuardConfig | null | undefined;
  pricing: AIPricingConfig | null | undefined;
  counted_input_tokens: number | null | undefined;
}): PreCallCostDecision {
  const validated = validateGuardAndPricing(args.guard, args.pricing);
  if (!validated.ok) {
    return { allowed: false, reason: validated.reason, max_cost: null, limit: args.guard?.max_cost ?? null, currency: args.guard?.currency ?? null };
  }
  const { guard, pricing } = validated;
  const counted = args.counted_input_tokens;
  if (!(typeof counted === 'number' && Number.isInteger(counted) && counted > 0)) {
    return { allowed: false, reason: 'INPUT_TOKENS_UNCOUNTED', max_cost: null, limit: guard.max_cost, currency: guard.currency };
  }

  const maxInputTokens = counted + INPUT_TOKEN_FRAMING_ALLOWANCE;
  // Every input token may be billed as a cache write (gpt-5.6: 1.25x input), the highest input price.
  const inputPricePer1k = Math.max(pricing.input_per_1k_tokens as number, pricing.cached_input_per_1k_tokens as number, cacheWritePricePer1k(pricing) ?? 0);
  const inputCost = (maxInputTokens / 1000) * inputPricePer1k;
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
