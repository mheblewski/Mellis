import { describe, expect, it } from 'vitest';
import {
  INPUT_TOKEN_FRAMING_ALLOWANCE,
  evaluatePostCallCost,
  evaluatePreCallCostBound,
  type AiCostGuardConfig,
} from './ai-cost-guard';
import type { AIPricingConfig } from '@modules/ai-gateway/domain/ai-gateway';

// Synthetic prices and limits only; offline.
const PRICING: AIPricingConfig = {
  input_per_1k_tokens: 0.002,
  output_per_1k_tokens: 0.008,
  cached_input_per_1k_tokens: 0.0005,
  reasoning_per_1k_tokens: 0.008,
  currency: 'USD',
  pricing_version: 'synthetic-pricing.v1',
};
const GUARD: AiCostGuardConfig = { max_cost: 0.25, currency: 'USD', max_output_tokens: 2000 };

describe('evaluatePreCallCostBound', () => {
  it('refuses without a guard, a valid limit or pricing', () => {
    expect(evaluatePreCallCostBound({ guard: null, pricing: PRICING, counted_input_tokens: 5000 })).toMatchObject({ allowed: false, reason: 'GUARD_NOT_CONFIGURED' });
    expect(evaluatePreCallCostBound({ guard: { ...GUARD, max_cost: 0 }, pricing: PRICING, counted_input_tokens: 5000 })).toMatchObject({ allowed: false, reason: 'INVALID_LIMIT' });
    expect(evaluatePreCallCostBound({ guard: { ...GUARD, max_cost: Number.NaN }, pricing: PRICING, counted_input_tokens: 5000 })).toMatchObject({ allowed: false, reason: 'INVALID_LIMIT' });
    expect(evaluatePreCallCostBound({ guard: { ...GUARD, max_output_tokens: 0 }, pricing: PRICING, counted_input_tokens: 5000 })).toMatchObject({ allowed: false, reason: 'INVALID_LIMIT' });
    expect(evaluatePreCallCostBound({ guard: GUARD, pricing: null, counted_input_tokens: 5000 })).toMatchObject({ allowed: false, reason: 'PRICING_NOT_CONFIGURED' });
  });

  it('refuses when any price, the currency or the pricing version is missing, or the currency differs', () => {
    for (const key of ['input_per_1k_tokens', 'output_per_1k_tokens', 'cached_input_per_1k_tokens', 'reasoning_per_1k_tokens'] as const) {
      expect(evaluatePreCallCostBound({ guard: GUARD, pricing: { ...PRICING, [key]: null }, counted_input_tokens: 5000 }))
        .toMatchObject({ allowed: false, reason: 'INCOMPLETE_PRICING' });
    }
    expect(evaluatePreCallCostBound({ guard: GUARD, pricing: { ...PRICING, currency: null }, counted_input_tokens: 5000 })).toMatchObject({ allowed: false, reason: 'INCOMPLETE_PRICING' });
    expect(evaluatePreCallCostBound({ guard: GUARD, pricing: { ...PRICING, pricing_version: '' }, counted_input_tokens: 5000 })).toMatchObject({ allowed: false, reason: 'INCOMPLETE_PRICING' });
    expect(evaluatePreCallCostBound({ guard: GUARD, pricing: { ...PRICING, currency: 'EUR' }, counted_input_tokens: 5000 })).toMatchObject({ allowed: false, reason: 'CURRENCY_MISMATCH' });
  });

  it('bounds input by the provider count plus the framing allowance at the cache write price, output by max_output_tokens', () => {
    const decision = evaluatePreCallCostBound({ guard: GUARD, pricing: PRICING, counted_input_tokens: 6000 });
    const maxInputTokens = 6000 + INPUT_TOKEN_FRAMING_ALLOWANCE;
    // The highest price an input token can be billed at: a cache write, 1.25x input when not configured.
    const expected = (maxInputTokens / 1000) * 0.002 * 1.25 + (2000 / 1000) * (0.008 + 0.008);
    expect(decision).toMatchObject({ allowed: true, max_input_tokens: maxInputTokens, max_output_tokens: 2000, limit: 0.25, currency: 'USD' });
    expect(decision.max_cost).toBeCloseTo(expected, 12);
  });

  it('allows a dose question on OpenAI at the 0.25 USD limit (2026-11-22)', () => {
    // A dose question of ~100 kB (bolus, simulation and food tools) counted at about 40k tokens was refused while the
    // request bytes were taken as tokens: 101,024 x 0.002 + 4000 x 0.012 = 0.25 > limit. Counted: 41,024 x 0.0025 + 0.048.
    const terra: AIPricingConfig = { ...PRICING, input_per_1k_tokens: 0.002, cached_input_per_1k_tokens: 0.0002, output_per_1k_tokens: 0.012, reasoning_per_1k_tokens: 0 };
    const decision = evaluatePreCallCostBound({ guard: { max_cost: 0.25, currency: 'USD', max_output_tokens: 4000 }, pricing: terra, counted_input_tokens: 40_000 });
    expect(decision).toMatchObject({ allowed: true });
    expect(decision.max_cost).toBeCloseTo((41_024 / 1000) * 0.0025 + 4 * 0.012, 12);
  });

  it('refuses when the worst-case cost exceeds the limit', () => {
    const decision = evaluatePreCallCostBound({ guard: { ...GUARD, max_cost: 0.01 }, pricing: PRICING, counted_input_tokens: 6000 });
    expect(decision).toMatchObject({ allowed: false, reason: 'MAX_COST_EXCEEDS_LIMIT', limit: 0.01 });
    expect(decision.max_cost).toBeGreaterThan(0.01);
  });
});

describe('evaluatePreCallCostBound with the approved 0.25 USD limit', () => {
  // Binary-exact prices so the boundary is compared without rounding: 2000 input tokens (976 counted + the 1024
  // allowance) x 0.0625/1k = 0.125 and 1000 output tokens x (0.0625 + 0.0625)/1k = 0.125, together exactly 0.25.
  const EXACT: AIPricingConfig = { ...PRICING, input_per_1k_tokens: 0.0625, cached_input_per_1k_tokens: 0, cache_write_per_1k_tokens: 0.0625, output_per_1k_tokens: 0.0625, reasoning_per_1k_tokens: 0.0625 };
  const LIMIT: AiCostGuardConfig = { max_cost: 0.25, currency: 'USD', max_output_tokens: 1000 };
  const decide = (countedInputTokens: number) => evaluatePreCallCostBound({ guard: LIMIT, pricing: EXACT, counted_input_tokens: countedInputTokens });

  it('allows a worst case below the limit', () => {
    expect(decide(900)).toMatchObject({ allowed: true });
    expect(decide(900).max_cost).toBeLessThan(0.25);
  });

  it('allows a worst case exactly equal to the limit', () => {
    expect(decide(976)).toMatchObject({ allowed: true, max_cost: 0.25, limit: 0.25 });
  });

  it('refuses a worst case above the limit', () => {
    expect(decide(977)).toMatchObject({ allowed: false, reason: 'MAX_COST_EXCEEDS_LIMIT', limit: 0.25 });
  });

  it('refuses without a provider token count', () => {
    for (const counted of [null, undefined, 0, -1, 12.5, Number.NaN]) {
      expect(evaluatePreCallCostBound({ guard: LIMIT, pricing: EXACT, counted_input_tokens: counted as number | null }))
        .toMatchObject({ allowed: false, reason: 'INPUT_TOKENS_UNCOUNTED' });
    }
  });
});

describe('evaluatePostCallCost', () => {
  const base = { provider: 'openai', model: 'synthetic-model', guard: GUARD, pricing: PRICING, max_input_tokens: 21_024 };
  const usage = { input_tokens: 5000, output_tokens: 400, total_tokens: 5400, cached_input_tokens: 1000, reasoning_tokens: 200 };

  it('accepts a known cost within the limit', () => {
    const decision = evaluatePostCallCost({ ...base, usage });
    expect(decision.allowed).toBe(true);
    // Cached tokens are part of input_tokens: only the uncached remainder is billed at the input price.
    expect(decision.actual_cost).toBeCloseTo((5 - 1) * 0.002 + 0.4 * 0.008 + 1 * 0.0005 + 0.2 * 0.008, 12);
  });

  it('never treats missing usage or unknown cost as zero', () => {
    expect(evaluatePostCallCost({ ...base, usage: null })).toMatchObject({ allowed: false, reason: 'USAGE_MISSING', actual_cost: null });
    expect(evaluatePostCallCost({ ...base, usage: { ...usage, output_tokens: null } })).toMatchObject({ allowed: false, reason: 'USAGE_MISSING' });
    expect(evaluatePostCallCost({ ...base, pricing: null, usage })).toMatchObject({ allowed: false, reason: 'PRICING_NOT_CONFIGURED' });
  });

  it('rejects usage outside the assumed bounds and a cost over the limit', () => {
    expect(evaluatePostCallCost({ ...base, usage: { ...usage, output_tokens: 2001 } })).toMatchObject({ allowed: false, reason: 'OUTPUT_TOKENS_EXCEED_CAP' });
    expect(evaluatePostCallCost({ ...base, usage: { ...usage, input_tokens: 21_025 } })).toMatchObject({ allowed: false, reason: 'INPUT_TOKENS_EXCEED_BOUND' });
    expect(evaluatePostCallCost({ ...base, guard: { ...GUARD, max_cost: 0.001 }, usage })).toMatchObject({ allowed: false, reason: 'ACTUAL_COST_EXCEEDS_LIMIT' });
  });
});
