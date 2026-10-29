import { describe, expect, it } from 'vitest';
import {
  INPUT_TOKEN_FRAMING_ALLOWANCE,
  evaluatePostCallCost,
  evaluatePreCallCostBound,
  type AiCostGuardConfig,
} from './ai-cost-guard';
import { IMAGE_INPUT_TOKEN_ALLOWANCE, serializedRequestSizeForBound } from './ai-cost-guard';
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
    const bytes = 10_000;
    expect(evaluatePreCallCostBound({ guard: null, pricing: PRICING, serialized_request_bytes: bytes, counted_input_tokens: 5000 })).toMatchObject({ allowed: false, reason: 'GUARD_NOT_CONFIGURED' });
    expect(evaluatePreCallCostBound({ guard: { ...GUARD, max_cost: 0 }, pricing: PRICING, serialized_request_bytes: bytes, counted_input_tokens: 5000 })).toMatchObject({ allowed: false, reason: 'INVALID_LIMIT' });
    expect(evaluatePreCallCostBound({ guard: { ...GUARD, max_cost: Number.NaN }, pricing: PRICING, serialized_request_bytes: bytes, counted_input_tokens: 5000 })).toMatchObject({ allowed: false, reason: 'INVALID_LIMIT' });
    expect(evaluatePreCallCostBound({ guard: { ...GUARD, max_output_tokens: 0 }, pricing: PRICING, serialized_request_bytes: bytes, counted_input_tokens: 5000 })).toMatchObject({ allowed: false, reason: 'INVALID_LIMIT' });
    expect(evaluatePreCallCostBound({ guard: GUARD, pricing: null, serialized_request_bytes: bytes, counted_input_tokens: 5000 })).toMatchObject({ allowed: false, reason: 'PRICING_NOT_CONFIGURED' });
  });

  it('refuses when any price, the currency or the pricing version is missing, or the currency differs', () => {
    const bytes = 10_000;
    for (const key of ['input_per_1k_tokens', 'output_per_1k_tokens', 'cached_input_per_1k_tokens', 'reasoning_per_1k_tokens'] as const) {
      expect(evaluatePreCallCostBound({ guard: GUARD, pricing: { ...PRICING, [key]: null }, serialized_request_bytes: bytes, counted_input_tokens: 5000 }))
        .toMatchObject({ allowed: false, reason: 'INCOMPLETE_PRICING' });
    }
    expect(evaluatePreCallCostBound({ guard: GUARD, pricing: { ...PRICING, currency: null }, serialized_request_bytes: bytes, counted_input_tokens: 5000 })).toMatchObject({ allowed: false, reason: 'INCOMPLETE_PRICING' });
    expect(evaluatePreCallCostBound({ guard: GUARD, pricing: { ...PRICING, pricing_version: '' }, serialized_request_bytes: bytes, counted_input_tokens: 5000 })).toMatchObject({ allowed: false, reason: 'INCOMPLETE_PRICING' });
    expect(evaluatePreCallCostBound({ guard: GUARD, pricing: { ...PRICING, currency: 'EUR' }, serialized_request_bytes: bytes, counted_input_tokens: 5000 })).toMatchObject({ allowed: false, reason: 'CURRENCY_MISMATCH' });
    expect(evaluatePreCallCostBound({ guard: GUARD, pricing: PRICING, serialized_request_bytes: 0, counted_input_tokens: 5000 })).toMatchObject({ allowed: false, reason: 'INVALID_REQUEST_SIZE' });
  });

  it('bounds input by the larger of the provider count and the byte estimate, output by max_output_tokens', () => {
    const decision = evaluatePreCallCostBound({ guard: GUARD, pricing: PRICING, serialized_request_bytes: 20_000, counted_input_tokens: 6000 });
    const maxInputTokens = 20_000 + INPUT_TOKEN_FRAMING_ALLOWANCE;
    // The counted tokens at the highest price a token can be billed at (a cache write, 1.25x input when not configured);
    // the byte estimate (here the larger figure) at the higher of the input and cache read prices.
    const expected = Math.max((6000 / 1000) * 0.002 * 1.25, (maxInputTokens / 1000) * Math.max(0.002, 0.0005)) + (2000 / 1000) * (0.008 + 0.008);
    expect(decision).toMatchObject({ allowed: true, max_input_tokens: maxInputTokens, max_output_tokens: 2000, limit: 0.25, currency: 'USD' });
    expect(decision.max_cost).toBeCloseTo(expected, 12);
  });

  it('prices the exact count at the cache write price and the byte estimate at the input price', () => {
    // 22:56 regression (2026-10-18): a causal question with a long conversation was refused once the byte estimate was
    // priced as cache writes. For example 85,000 B x 0.002 + output 0.032 = 0.202 <= 0.25; 30,000 counted x 0.0025 = 0.075.
    const decision = evaluatePreCallCostBound({ guard: GUARD, pricing: PRICING, serialized_request_bytes: 85_000, counted_input_tokens: 30_000 });
    expect(decision).toMatchObject({ allowed: true });
    expect(decision.max_cost).toBeCloseTo(((85_000 + INPUT_TOKEN_FRAMING_ALLOWANCE) / 1000) * 0.002 + 2 * 0.016, 12);
    // When the provider counts more tokens than the byte estimate, the count decides at the cache write price.
    const counted = evaluatePreCallCostBound({ guard: GUARD, pricing: PRICING, serialized_request_bytes: 1_000, counted_input_tokens: 20_000 });
    expect(counted.max_cost).toBeCloseTo(20 * 0.0025 + 2 * 0.016, 12);
  });

  it('refuses when the worst-case cost exceeds the limit', () => {
    const decision = evaluatePreCallCostBound({ guard: { ...GUARD, max_cost: 0.01 }, pricing: PRICING, serialized_request_bytes: 20_000, counted_input_tokens: 6000 });
    expect(decision).toMatchObject({ allowed: false, reason: 'MAX_COST_EXCEEDS_LIMIT', limit: 0.01 });
    expect(decision.max_cost).toBeGreaterThan(0.01);
  });
});

describe('evaluatePreCallCostBound with the approved 0.25 USD limit', () => {
  // Binary-exact prices so the boundary is compared without rounding: 2000 input tokens x 0.0625/1k = 0.125 and
  // 1000 output tokens x (0.0625 + 0.0625)/1k = 0.125, together exactly 0.25.
  const EXACT: AIPricingConfig = { ...PRICING, input_per_1k_tokens: 0.0625, cached_input_per_1k_tokens: 0, cache_write_per_1k_tokens: 0.0625, output_per_1k_tokens: 0.0625, reasoning_per_1k_tokens: 0.0625 };
  const LIMIT: AiCostGuardConfig = { max_cost: 0.25, currency: 'USD', max_output_tokens: 1000 };
  // Byte estimate (1 + 1024) stays below the count, so the count decides the input bound.
  const decide = (countedInputTokens: number) => evaluatePreCallCostBound({ guard: LIMIT, pricing: EXACT, serialized_request_bytes: 1, counted_input_tokens: countedInputTokens });

  it('allows a worst case below the limit', () => {
    expect(decide(1900)).toMatchObject({ allowed: true });
    expect(decide(1900).max_cost).toBeLessThan(0.25);
  });

  it('allows a worst case exactly equal to the limit', () => {
    expect(decide(2000)).toMatchObject({ allowed: true, max_cost: 0.25, limit: 0.25 });
  });

  it('refuses a worst case above the limit', () => {
    expect(decide(2001)).toMatchObject({ allowed: false, reason: 'MAX_COST_EXCEEDS_LIMIT', limit: 0.25 });
  });

  it('refuses without a provider token count, whatever the byte estimate says', () => {
    for (const counted of [null, undefined, 0, -1, 12.5, Number.NaN]) {
      expect(evaluatePreCallCostBound({ guard: LIMIT, pricing: EXACT, serialized_request_bytes: 1, counted_input_tokens: counted as number | null }))
        .toMatchObject({ allowed: false, reason: 'INPUT_TOKENS_UNCOUNTED' });
    }
  });

  it('uses the byte estimate when it exceeds the provider count', () => {
    const decision = evaluatePreCallCostBound({ guard: { ...LIMIT, max_cost: 10 }, pricing: EXACT, serialized_request_bytes: 5000, counted_input_tokens: 10 });
    expect(decision).toMatchObject({ allowed: true, max_input_tokens: 5000 + INPUT_TOKEN_FRAMING_ALLOWANCE });
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

describe('serializedRequestSizeForBound', () => {
  it('counts an inline image as a fixed allowance instead of its base64 bytes', () => {
    const photo = `data:image/jpeg;base64,${'A'.repeat(400_000)}`;
    const withImage = { model: 'm', input: [{ role: 'user', content: [{ type: 'input_text', text: 'Kanapka' }, { type: 'input_image', image_url: photo }] }] };
    const withoutImage = { model: 'm', input: [{ role: 'user', content: [{ type: 'input_text', text: 'Kanapka' }, { type: 'input_image', image_url: '' }] }] };

    expect(serializedRequestSizeForBound(withImage)).toBe(Buffer.byteLength(JSON.stringify(withoutImage), 'utf8') + IMAGE_INPUT_TOKEN_ALLOWANCE);
    expect(serializedRequestSizeForBound({ model: 'm', input: 'text only' })).toBe(Buffer.byteLength(JSON.stringify({ model: 'm', input: 'text only' }), 'utf8'));
  });
});
