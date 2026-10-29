import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AIPricingConfig } from '@modules/ai-gateway/domain/ai-gateway';
import { calculateProviderUsageCost, normalizeAIUsage } from '@modules/ai-gateway/application/ai-observability';
import type { AiCostGuardConfig } from '@modules/ai-gateway/application/ai-cost-guard';
import { createGuardedOpenAiClient, parseOpenAiServiceTier, type OpenAiResponsesTransport } from './guarded-openai-client';
import { FileExperimentBudgetLedger, initializeExperimentBudgetLedger } from './experiment-budget-ledger';

// gpt-5.6-terra list prices (2026-10) per 1k tokens.
const PRICING: AIPricingConfig = {
  input_per_1k_tokens: 0.002,
  cached_input_per_1k_tokens: 0.0002,
  output_per_1k_tokens: 0.012,
  reasoning_per_1k_tokens: 0,
  currency: 'USD',
  pricing_version: 'synthetic-pricing.v1',
};
const GUARD: AiCostGuardConfig = { max_cost: 0.25, currency: 'USD', max_output_tokens: 1000 };

describe('cache writes and the flex tier in the cost', () => {
  it('reads cache_write_tokens and the serving tier from the response', () => {
    expect(normalizeAIUsage({ input_tokens: 1939, output_tokens: 5, total_tokens: 1944, input_tokens_details: { cache_write_tokens: 1936, cached_tokens: 0 } }, 'flex'))
      .toEqual({ input_tokens: 1939, output_tokens: 5, total_tokens: 1944, cached_input_tokens: 0, reasoning_tokens: null, cache_write_tokens: 1936, service_tier: 'flex' });
    expect(normalizeAIUsage({ input_tokens: 10, output_tokens: 1, total_tokens: 11 })).not.toHaveProperty('cache_write_tokens');
  });

  it('bills cache writes at 1.25x input when no write price is configured', () => {
    const usage = { input_tokens: 10_000, output_tokens: 500, total_tokens: 10_500, cached_input_tokens: 4_000, reasoning_tokens: 200, cache_write_tokens: 5_000 };
    const result = calculateProviderUsageCost({ provider: 'openai', model: 'm', usage, pricing: PRICING });
    expect(result).toMatchObject({ status: 'KNOWN' });
    if (result.status !== 'KNOWN') return;
    expect(result.input_cost).toBeCloseTo(1 * 0.002, 12); // 1,000 plain input tokens
    expect(result.cached_input_cost).toBeCloseTo(4 * 0.0002, 12);
    expect(result.cache_write_cost).toBeCloseTo(5 * 0.0025, 12);
    expect(result.amount).toBeCloseTo(0.002 + 0.0008 + 0.0125 + 0.5 * 0.012, 12);
  });

  it('uses a configured cache write price', () => {
    const usage = { input_tokens: 1000, output_tokens: 0, total_tokens: 1000, cached_input_tokens: 0, reasoning_tokens: 0, cache_write_tokens: 1000 };
    const result = calculateProviderUsageCost({ provider: 'openai', model: 'm', usage, pricing: { ...PRICING, cache_write_per_1k_tokens: 0.003 } });
    expect(result.status === 'KNOWN' && result.cache_write_cost).toBeCloseTo(0.003, 12);
  });

  it('refuses usage whose reads and writes exceed the input', () => {
    const usage = { input_tokens: 100, output_tokens: 0, total_tokens: 100, cached_input_tokens: 60, reasoning_tokens: 0, cache_write_tokens: 50 };
    expect(calculateProviderUsageCost({ provider: 'openai', model: 'm', usage, pricing: PRICING })).toMatchObject({ status: 'UNKNOWN', reason: 'INVALID_USAGE' });
  });

  it('prices flex calls at the configured factor and as standard without one', () => {
    const usage = { input_tokens: 1000, output_tokens: 100, total_tokens: 1100, cached_input_tokens: 0, reasoning_tokens: 0, service_tier: 'flex' };
    const standard = 0.002 + 0.1 * 0.012;
    const priced = (pricing: AIPricingConfig) => {
      const result = calculateProviderUsageCost({ provider: 'openai', model: 'm', usage, pricing });
      return result.status === 'KNOWN' ? result.amount : null;
    };
    expect(priced({ ...PRICING, flex_price_multiplier: 0.5 })).toBeCloseTo(standard / 2, 12);
    expect(priced(PRICING)).toBeCloseTo(standard, 12);
    expect(calculateProviderUsageCost({ provider: 'openai', model: 'm', usage: { ...usage, service_tier: 'default' }, pricing: { ...PRICING, flex_price_multiplier: 0.5 } }))
      .toMatchObject({ amount: expect.closeTo(standard, 12) });
  });
});

describe('flex tier with one standard-tier retry', () => {
  let ledgerPath: string;
  beforeEach(() => {
    ledgerPath = join(mkdtempSync(join(tmpdir(), 'glucomind-flex-test-')), 'ledger.json');
    initializeExperimentBudgetLedger(ledgerPath, { experiment_id: 'synthetic-flex', currency: 'USD', total_budget: 1, max_calls: 10 });
  });

  const ok = (tier: string) => ({ id: 'resp', service_tier: tier, output_text: '{}', usage: { input_tokens: 1000, output_tokens: 10, total_tokens: 1010, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 1000 } } });
  const status = (code: number) => Object.assign(new Error(`status ${code}`), { status: code });
  function client(steps: Array<Record<string, unknown> | Error>, serviceTier: 'flex' | null, flexTimeoutMs: number | null = null) {
    const create = vi.fn(async (_body: Record<string, unknown>, _options?: Record<string, unknown>) => {
      const next = steps[create.mock.calls.length - 1];
      if (next instanceof Error) throw next;
      return next;
    });
    const count = vi.fn(async () => ({ input_tokens: 1000 }));
    const transport: OpenAiResponsesTransport = { responses: { create, inputTokens: { count } } };
    const guarded = createGuardedOpenAiClient({ transport, pricing: { ...PRICING, flex_price_multiplier: 0.5 }, costGuard: GUARD, ledger: new FileExperimentBudgetLedger(ledgerPath), service_tier: serviceTier, flex_timeout_ms: flexTimeoutMs });
    return { guarded, create, count };
  }

  it('sends flex and keeps it out of the token count', async () => {
    const { guarded, create, count } = client([ok('flex')], 'flex');
    await guarded.responses.create({ model: 'm', input: 'x' }, { timeout: 90_000 });
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0]).toMatchObject({ service_tier: 'flex' });
    expect(count.mock.calls[0][0]).not.toHaveProperty('service_tier');
  });

  it('re-sends once on the standard tier after a 429, and settles the refused call at zero', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { guarded, create } = client([status(429), ok('default')], 'flex');
    const response = await guarded.responses.create({ model: 'm', input: 'x' }, { timeout: 90_000 });
    expect(response.service_tier).toBe('default');
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[1][0]).not.toHaveProperty('service_tier');
    expect(warn.mock.calls.map((call) => String(call[0])).join()).toContain('openai_flex_fallback');
    // Refused flex call settled at 0; the standard call at its actual cost (1,000 cache-write tokens, 10 output).
    const reservations = new FileExperimentBudgetLedger(ledgerPath).read().reservations;
    expect(reservations.map((entry) => entry.actual_cost)).toEqual([0, expect.closeTo(1 * 0.0025 + 0.01 * 0.012, 12)]);
    warn.mockRestore();
  });

  it('gives flex at most flex_timeout_ms and the retry the full timeout', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { guarded, create } = client([status(408), ok('default')], 'flex', 20_000);
    await guarded.responses.create({ model: 'm', input: 'x' }, { timeout: 90_000 });
    expect(create.mock.calls[0][1]).toMatchObject({ timeout: 20_000 });
    expect(create.mock.calls[1][1]).toMatchObject({ timeout: 90_000 });
  });

  it('re-sends on the standard tier after a dropped flex connection', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    class APIConnectionError extends Error {}
    const { guarded, create } = client([new APIConnectionError('Connection error.'), ok('default')], 'flex');
    const response = await guarded.responses.create({ model: 'm', input: 'x' }, { timeout: 90_000 });
    expect(response.service_tier).toBe('default');
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('does not retry other errors or a cancelled call', async () => {
    const { guarded, create } = client([status(400)], 'flex');
    await expect(guarded.responses.create({ model: 'm', input: 'x' }, {})).rejects.toThrow('status 400');
    expect(create).toHaveBeenCalledTimes(1);

    const controller = new AbortController();
    controller.abort();
    const cancelled = client([status(429)], 'flex');
    await expect(cancelled.guarded.responses.create({ model: 'm', input: 'x' }, { signal: controller.signal })).rejects.toThrow('status 429');
    expect(cancelled.create).toHaveBeenCalledTimes(1);
  });

  it('leaves requests unchanged without flex or when the caller names a tier', async () => {
    const standard = client([ok('default')], null);
    await standard.guarded.responses.create({ model: 'm', input: 'x' }, {});
    expect(standard.create.mock.calls[0][0]).not.toHaveProperty('service_tier');

    const named = client([ok('default')], 'flex');
    await named.guarded.responses.create({ model: 'm', input: 'x', service_tier: 'default' }, {});
    expect(named.create.mock.calls[0][0]).toMatchObject({ service_tier: 'default' });
  });

  it('bounds a flex attempt at flex prices, and its standard retry at standard prices', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    // 100 kB request, limit 0.25: standard worst case 101,024 x 0.002 + 1,000 x 0.012 = 0.214; at flex half of it.
    const body = { model: 'm', input: 'x'.repeat(100_000) };
    const { guarded, create } = client([status(429), ok('default')], 'flex');
    await guarded.responses.create(body, {});
    const reservations = new FileExperimentBudgetLedger(ledgerPath).read().reservations;
    expect(reservations[0].max_cost).toBeCloseTo(((100_000 + 2 * 1000 + 1024) / 1000) * 0.002 * 0.5 + 0.012 * 0.5, 2);
    expect(reservations[1].max_cost).toBeGreaterThan(reservations[0].max_cost * 1.9);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('parses OPENAI_SERVICE_TIER', () => {
    expect(parseOpenAiServiceTier('flex')).toBe('flex');
    expect(parseOpenAiServiceTier(' FLEX ')).toBe('flex');
    for (const value of [undefined, '', 'default', 'standard']) expect(parseOpenAiServiceTier(value)).toBeNull();
    expect(() => parseOpenAiServiceTier('priority')).toThrow('OPENAI_SERVICE_TIER');
  });
});
