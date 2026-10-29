import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AIPricingConfig } from '@modules/ai-gateway/domain/ai-gateway';
import { INPUT_TOKEN_FRAMING_ALLOWANCE, type AiCostGuardConfig } from '@modules/ai-gateway/application/ai-cost-guard';
import { chainedInputTokenBound, createGuardedOpenAiClient, parseChainedInputBound, type OpenAiResponsesTransport } from './guarded-openai-client';
import { FileExperimentBudgetLedger, initializeExperimentBudgetLedger } from './experiment-budget-ledger';

// Offline: a fake transport and a ledger file in a temporary directory; nothing is sent or billed.

const PRICING: AIPricingConfig = {
  input_per_1k_tokens: 0.002,
  cached_input_per_1k_tokens: 0.0002,
  output_per_1k_tokens: 0.012,
  reasoning_per_1k_tokens: 0,
  currency: 'USD',
  pricing_version: 'synthetic-pricing.v1',
};
const GUARD: AiCostGuardConfig = { max_cost: 0.25, currency: 'USD', max_output_tokens: 1000 };

const toolOutput = { type: 'function_call_output', call_id: 'call-1', output: JSON.stringify({ foods: [{ name: 'bułka', carbs: 55 }] }) };

function response(id: string, input_tokens: number, output_tokens = 200): Record<string, unknown> {
  return { id, output_text: '{}', usage: { input_tokens, output_tokens, total_tokens: input_tokens + output_tokens, input_tokens_details: { cached_tokens: 0 } } };
}

function fakeTransport(responses: Record<string, unknown>[], counted = 12_000) {
  const create = vi.fn(async () => {
    const next = responses[create.mock.calls.length - 1];
    if (!next) throw new Error('unexpected extra provider call');
    return next;
  });
  const count = vi.fn(async () => ({ object: 'response.input_tokens', input_tokens: counted }));
  const transport: OpenAiResponsesTransport = { responses: { create, inputTokens: { count } } };
  return { transport, create, count };
}

let ledgerPath: string;
beforeEach(() => {
  ledgerPath = join(mkdtempSync(join(tmpdir(), 'glucomind-chained-bound-')), 'ledger.json');
  initializeExperimentBudgetLedger(ledgerPath, { experiment_id: 'synthetic-chained', currency: 'USD', total_budget: 5, max_calls: 20 });
});

function client(transport: OpenAiResponsesTransport, local_chained_input_bound: boolean, guard: AiCostGuardConfig = GUARD) {
  return createGuardedOpenAiClient({ transport, pricing: PRICING, costGuard: guard, ledger: new FileExperimentBudgetLedger(ledgerPath), local_chained_input_bound });
}

const first = { model: 'm', instructions: 'System.', input: [{ role: 'user', content: 'Ile insuliny na bułkę?' }], tools: [{ type: 'function', name: 'search_food' }] };
const chained = (previous: string, input: unknown[] = [toolOutput]) => ({ model: 'm', previous_response_id: previous, input, tools: first.tools });

describe('chained tool rounds bounded without the counting request', () => {
  it('counts the first call and bounds the chained round from the previous usage', async () => {
    const { transport, create, count } = fakeTransport([response('resp-1', 12_000, 300), response('resp-2', 12_400)]);
    const guarded = client(transport, true);
    await guarded.responses.create(first);
    await guarded.responses.create(chained('resp-1'));
    expect(count).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(2);
    const reservations = new FileExperimentBudgetLedger(ledgerPath).read().reservations;
    expect(reservations).toHaveLength(2);
    expect(reservations.every((reservation) => reservation.status === 'SETTLED')).toBe(true);
  });

  it('counts every call when the option is off', async () => {
    const { transport, count } = fakeTransport([response('resp-1', 12_000), response('resp-2', 12_000)]);
    const guarded = client(transport, false);
    await guarded.responses.create(first);
    await guarded.responses.create(chained('resp-1'));
    expect(count).toHaveBeenCalledTimes(2);
  });

  it('counts a chained round whose previous response it did not see, or whose input carries a photo', async () => {
    const { transport, count } = fakeTransport([response('resp-1', 12_000), response('resp-2', 12_000), response('resp-3', 12_000)]);
    const guarded = client(transport, true);
    await guarded.responses.create(first);
    await guarded.responses.create(chained('resp-unknown'));
    await guarded.responses.create(chained('resp-1', [{ role: 'user', content: [{ type: 'input_image', image_url: 'data:image/jpeg;base64,AAAA' }] }]));
    expect(count).toHaveBeenCalledTimes(3);
  });

  it('falls back to the exact count when the local bound is over the limit, and still refuses when the count is too', async () => {
    // Limit 0.06 USD, output 0.012 of it: the local bound (~20.2k tokens at the cache-write price, 0.0625) is over,
    // the count (18k tokens, 0.057) fits.
    const tight: AiCostGuardConfig = { ...GUARD, max_cost: 0.06 };
    const { transport, count, create } = fakeTransport([response('resp-1', 18_000, 900), response('resp-2', 18_000)], 18_000);
    const guarded = client(transport, true, tight);
    await guarded.responses.create(first);
    await guarded.responses.create(chained('resp-1'));
    expect(count).toHaveBeenCalledTimes(2);
    expect(create).toHaveBeenCalledTimes(2);

    const over = fakeTransport([response('resp-1', 18_000, 900)], 40_000);
    const refusing = client(over.transport, true, tight);
    await expect(refusing.responses.create(first)).rejects.toThrow('MAX_COST_EXCEEDS_LIMIT');
    expect(over.create).not.toHaveBeenCalled();
  });

  it('rejects a chained round whose reported input exceeds the local bound', async () => {
    const { transport } = fakeTransport([response('resp-1', 12_000, 300), response('resp-2', 500_000)]);
    const guarded = client(transport, true);
    await guarded.responses.create(first);
    await expect(guarded.responses.create(chained('resp-1'))).rejects.toThrow('INPUT_TOKENS_EXCEED_BOUND');
  });
});

describe('chainedInputTokenBound', () => {
  it('is the previous input and output plus the new request bytes and the framing allowance', () => {
    const body = chained('resp-1');
    expect(chainedInputTokenBound(body, { input_tokens: 14_755, output_tokens: 189 }))
      .toBe(14_755 + 189 + Buffer.byteLength(JSON.stringify(body), 'utf8') + INPUT_TOKEN_FRAMING_ALLOWANCE);
  });

  it('is never below the provider-reported input of a recorded tool loop (2026-10-22, 4 rounds)', () => {
    // Usage of a real chained loop (input, output) and the request bytes of each continuation.
    const rounds = [[14_755, 189], [15_310, 349], [15_949, 975], [17_663, 830]] as const;
    const continuationBytes = [20_508, 20_246, 22_003];
    for (let index = 1; index < rounds.length; index += 1) {
      const [previousInput, previousOutput] = rounds[index - 1];
      const bound = previousInput + previousOutput + continuationBytes[index - 1] + INPUT_TOKEN_FRAMING_ALLOWANCE;
      expect(bound).toBeGreaterThanOrEqual(rounds[index][0]);
    }
  });

  it('gives no bound without a previous usage, without a chain, with a photo or with server-side state', () => {
    const usage = { input_tokens: 10, output_tokens: 10 };
    expect(chainedInputTokenBound(chained('resp-1'), undefined)).toBeNull();
    expect(chainedInputTokenBound(first, usage)).toBeNull();
    expect(chainedInputTokenBound(chained('resp-1', [{ role: 'user', content: [{ type: 'input_image', image_url: 'https://example.test/a.jpg' }] }]), usage)).toBeNull();
    expect(chainedInputTokenBound(chained('resp-1', [{ role: 'user', content: [{ type: 'input_file', file_id: 'file-1' }] }]), usage)).toBeNull();
    expect(chainedInputTokenBound({ ...chained('resp-1'), truncation: 'auto' }, usage)).toBeNull();
    expect(chainedInputTokenBound({ ...chained('resp-1'), conversation: 'conv-1' }, usage)).toBeNull();
  });
});

describe('OPENAI_CHAINED_INPUT_BOUND', () => {
  it('is on when unset or true-like, off when false-like, and refuses anything else', () => {
    expect(parseChainedInputBound(undefined)).toBe(true);
    expect(parseChainedInputBound('')).toBe(true);
    expect(parseChainedInputBound('true')).toBe(true);
    expect(parseChainedInputBound('1')).toBe(true);
    expect(parseChainedInputBound('0')).toBe(false);
    expect(parseChainedInputBound('false')).toBe(false);
    expect(parseChainedInputBound(false)).toBe(false);
    expect(() => parseChainedInputBound('maybe')).toThrow('OPENAI_CHAINED_INPUT_BOUND');
  });
});
