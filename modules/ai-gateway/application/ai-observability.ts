import { createHash } from 'crypto';
import { canonicalJson } from '@shared/utils/canonical-json';
import type { AiContextPackage } from '@modules/ai-gateway/domain/ai-gateway';
import type { AIUsage, AICostEstimate, AIPricingConfig, ContextPackageSectionUsage, ContextPackageUsage } from '@modules/ai-gateway/domain/ai-gateway';

export type ProviderCostCalculation =
  | {
      status: 'KNOWN';
      provider: string;
      model: string;
      amount: number;
      currency: string;
      pricing_version: string | null;
      input_cost: number | null;
      output_cost: number | null;
      cached_input_cost: number | null;
      reasoning_cost: number | null;
      cache_write_cost: number | null;
    }
  | {
      status: 'UNKNOWN';
      provider: string;
      model: string;
      reason: 'PRICING_NOT_CONFIGURED' | 'USAGE_MISSING' | 'USAGE_INCOMPLETE' | 'INVALID_USAGE' | 'MISSING_PRICE_FOR_BILLABLE_USAGE' | 'CURRENCY_NOT_CONFIGURED';
      pricing_version: string | null;
    };

/**
 * OpenAI bills prompt-cache writes at 1.25x the uncached input price (gpt-5.6 pricing, 2026-10). Used when no cache
 * write price is configured, so writes are never counted at the plain input price.
 */
export const CACHE_WRITE_INPUT_PRICE_MULTIPLIER = 1.25;

export function cacheWritePricePer1k(pricing: AIPricingConfig): number | null {
  if (typeof pricing.cache_write_per_1k_tokens === 'number') return pricing.cache_write_per_1k_tokens;
  return pricing.input_per_1k_tokens === null ? null : pricing.input_per_1k_tokens * CACHE_WRITE_INPUT_PRICE_MULTIPLIER;
}

/** `serviceTier` is the response's service_tier (not part of usage); kept so the cost reflects the tier that served. */
export function normalizeAIUsage(rawUsage: unknown, serviceTier?: unknown): AIUsage | null {
  if (!rawUsage || typeof rawUsage !== 'object') {
    return null;
  }

  const record = rawUsage as Record<string, unknown>;
  const inputTokens = toNullableInteger(record.input_tokens);
  const outputTokens = toNullableInteger(record.output_tokens);
  const totalTokens = toNullableInteger(record.total_tokens);
  const cachedInputTokens = toNullableInteger(
    (record.input_tokens_details as Record<string, unknown> | undefined)?.cached_tokens,
  );
  const reasoningTokens = toNullableInteger(
    (record.output_tokens_details as Record<string, unknown> | undefined)?.reasoning_tokens,
  );
  const cacheWriteTokens = toNullableInteger(
    (record.input_tokens_details as Record<string, unknown> | undefined)?.cache_write_tokens,
  );

  const usage: AIUsage = {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: totalTokens,
    cached_input_tokens: cachedInputTokens,
    reasoning_tokens: reasoningTokens,
    ...(cacheWriteTokens !== null ? { cache_write_tokens: cacheWriteTokens } : {}),
    ...(typeof serviceTier === 'string' && serviceTier ? { service_tier: serviceTier } : {}),
  };

  if (
    usage.input_tokens === null
    && usage.output_tokens === null
    && usage.total_tokens === null
    && usage.cached_input_tokens === null
    && usage.reasoning_tokens === null
  ) {
    return null;
  }

  return usage;
}

export function buildExactInputFingerprint(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

export function buildContextPackageUsage(
  contextPackage: AiContextPackage,
): ContextPackageUsage {
  const record = contextPackage as unknown as Record<string, unknown>;
  const sectionPairs: Array<[string, unknown]> = [
    ['task', record.task],
    ['trigger', record.trigger],
    ['hypo_episode', record.hypo_episode],
    ['analysis_request_input', record.analysis_request_input],
    ['glucose_evidence', record.glucose_evidence],
    ['analytical_evidence', record.analytical_evidence],
    ['current_state_snapshot', record.current_state_snapshot],
    ['active_therapy_snapshot', record.active_therapy_snapshot],
    ['conversation_context', record.conversation_context],
    ['event_context_facts', record.event_context_facts],
    ['patient_facts', record.patient_facts],
    ['historical_evidence', record.historical_evidence ?? null],
    ['pattern_evidence', record.pattern_evidence ?? null],
    ['memory_evidence', record.memory_evidence ?? null],
    ['provenance', record.provenance],
    ['source_versions', record.source_versions],
  ];

  const sections: ContextPackageSectionUsage[] = [];
  for (const [sectionName, sectionValue] of sectionPairs) {
    if (sectionValue === null || sectionValue === undefined) {
      continue;
    }

    sections.push({
      section_name: sectionName,
      serialized_bytes: Buffer.byteLength(canonicalJson(sectionValue), 'utf8'),
    });
  }

  const total_serialized_bytes = sections.reduce((sum, section) => sum + section.serialized_bytes, 0);
  return { total_serialized_bytes, sections };
}

export function buildPricingEstimate(args: {
  provider: string;
  model: string;
  usage: AIUsage;
  pricing: AIPricingConfig | null;
}): AICostEstimate | null {
  const calculation = calculateProviderUsageCost(args);
  if (calculation.status !== 'KNOWN') {
    return null;
  }

  return {
    estimated_cost: calculation.amount,
    currency: calculation.currency,
    pricing_version: calculation.pricing_version,
    input_cost: calculation.input_cost,
    output_cost: calculation.output_cost,
    cached_input_cost: calculation.cached_input_cost,
    reasoning_cost: calculation.reasoning_cost,
    ...(calculation.cache_write_cost !== null ? { cache_write_cost: calculation.cache_write_cost } : {}),
  };
}

export function calculateProviderUsageCost(args: {
  provider: string;
  model: string;
  usage: AIUsage | null;
  pricing: AIPricingConfig | null;
}): ProviderCostCalculation {
  if (!args.usage) {
    return {
      status: 'UNKNOWN',
      provider: args.provider,
      model: args.model,
      reason: 'USAGE_MISSING',
      pricing_version: args.pricing?.pricing_version ?? null,
    };
  }

  if (!args.pricing) {
    return {
      status: 'UNKNOWN',
      provider: args.provider,
      model: args.model,
      reason: 'PRICING_NOT_CONFIGURED',
      pricing_version: null,
    };
  }

  const currency = args.pricing.currency?.trim() ?? '';
  if (!currency) {
    return {
      status: 'UNKNOWN',
      provider: args.provider,
      model: args.model,
      reason: 'CURRENCY_NOT_CONFIGURED',
      pricing_version: args.pricing.pricing_version ?? null,
    };
  }

  // Responses API usage contract: input_tokens INCLUDES input_tokens_details.cached_tokens, and output_tokens INCLUDES
  // output_tokens_details.reasoning_tokens. Cached tokens are billed only at the cache price; the remaining input at
  // the input price. Output (reasoning included) is billed at the output price; reasoning_per_1k_tokens is an extra
  // per-reasoning-token charge on top (0 for OpenAI models, where reasoning is billed as output).
  // Without input or output counts the cost is unknown: a partial sum would silently undercount.
  if (args.usage.input_tokens === null || args.usage.output_tokens === null) {
    const anyUsage = [args.usage.input_tokens, args.usage.output_tokens, args.usage.cached_input_tokens, args.usage.reasoning_tokens]
      .some((value) => value !== null);
    return {
      status: 'UNKNOWN',
      provider: args.provider,
      model: args.model,
      reason: anyUsage ? 'USAGE_INCOMPLETE' : 'USAGE_MISSING',
      pricing_version: args.pricing.pricing_version ?? null,
    };
  }
  const cachedTokens = args.usage.cached_input_tokens;
  const reasoningTokens = args.usage.reasoning_tokens;
  // gpt-5.6+: input = cached reads + cache writes + plain input; writes are billed at the cache write price.
  const cacheWriteTokens = args.usage.cache_write_tokens ?? null;
  if ((cachedTokens !== null && cachedTokens > args.usage.input_tokens) || (reasoningTokens !== null && reasoningTokens > args.usage.output_tokens)
    || (cacheWriteTokens !== null && cacheWriteTokens + (cachedTokens ?? 0) > args.usage.input_tokens)) {
    return {
      status: 'UNKNOWN',
      provider: args.provider,
      model: args.model,
      reason: 'INVALID_USAGE',
      pricing_version: args.pricing.pricing_version ?? null,
    };
  }
  // Unknown cached count: all input is billed at the full input price (an upper bound, never an undercount).
  const uncachedInputTokens = args.usage.input_tokens - (cachedTokens ?? 0) - (cacheWriteTokens ?? 0);
  // Flex is billed at a fraction of every price; without a configured factor it is priced as standard (an upper bound).
  const tierFactor = args.usage.service_tier === 'flex' && typeof args.pricing.flex_price_multiplier === 'number'
    ? args.pricing.flex_price_multiplier
    : 1;
  const scaled = (price: number | null) => (price === null ? null : price * tierFactor);

  const inputCost = computeComponentCost(uncachedInputTokens, scaled(args.pricing.input_per_1k_tokens));
  const outputCost = computeComponentCost(args.usage.output_tokens, scaled(args.pricing.output_per_1k_tokens));
  const cachedInputCost = computeComponentCost(cachedTokens, scaled(args.pricing.cached_input_per_1k_tokens));
  const reasoningCost = computeComponentCost(reasoningTokens, scaled(args.pricing.reasoning_per_1k_tokens));
  const cacheWriteCost = computeComponentCost(cacheWriteTokens, scaled(cacheWritePricePer1k(args.pricing)));

  const hasMissingPriceForUsage = [inputCost, outputCost, cachedInputCost, reasoningCost, cacheWriteCost].some((component) => component.status === 'MISSING_PRICE');
  if (hasMissingPriceForUsage) {
    return {
      status: 'UNKNOWN',
      provider: args.provider,
      model: args.model,
      reason: 'MISSING_PRICE_FOR_BILLABLE_USAGE',
      pricing_version: args.pricing.pricing_version ?? null,
    };
  }

  const componentValues = [inputCost, outputCost, cachedInputCost, reasoningCost, cacheWriteCost]
    .map((component) => component.value)
    .filter((value): value is number => value !== null);

  if (componentValues.length === 0) {
    return {
      status: 'UNKNOWN',
      provider: args.provider,
      model: args.model,
      reason: 'USAGE_MISSING',
      pricing_version: args.pricing.pricing_version ?? null,
    };
  }

  const amount = componentValues.reduce((sum, value) => sum + value, 0);

  return {
    status: 'KNOWN',
    provider: args.provider,
    model: args.model,
    amount,
    currency,
    pricing_version: args.pricing.pricing_version ?? null,
    input_cost: inputCost.value,
    output_cost: outputCost.value,
    cached_input_cost: cachedInputCost.value,
    reasoning_cost: reasoningCost.value,
    cache_write_cost: cacheWriteCost.value,
  };
}

function computeComponentCost(
  usageTokens: number | null,
  pricePer1kTokens: number | null,
): { status: 'ABSENT' | 'MISSING_PRICE' | 'KNOWN'; value: number | null } {
  if (usageTokens === null) {
    return { status: 'ABSENT', value: null };
  }

  if (pricePer1kTokens === null) {
    return { status: 'MISSING_PRICE', value: null };
  }

  return {
    status: 'KNOWN',
    value: (usageTokens / 1000) * pricePer1kTokens,
  };
}

function toNullableInteger(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return null;
}
