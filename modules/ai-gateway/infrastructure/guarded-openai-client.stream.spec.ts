import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AIPricingConfig } from '@modules/ai-gateway/domain/ai-gateway';
import type { AiCostGuardConfig } from '@modules/ai-gateway/application/ai-cost-guard';
import { createGuardedOpenAiClient, ON_OUTPUT_TEXT_OPTION, type OpenAiResponsesTransport } from './guarded-openai-client';
import { FileExperimentBudgetLedger, initializeExperimentBudgetLedger } from './experiment-budget-ledger';

const PRICING: AIPricingConfig = {
  input_per_1k_tokens: 0.002,
  cached_input_per_1k_tokens: 0.0002,
  output_per_1k_tokens: 0.012,
  reasoning_per_1k_tokens: 0,
  currency: 'USD',
  pricing_version: 'synthetic-pricing.v1',
  flex_price_multiplier: 0.5,
};
const GUARD: AiCostGuardConfig = { max_cost: 0.25, currency: 'USD', max_output_tokens: 1000 };

const finalResponse = (tier = 'default') => ({
  id: 'resp-1',
  status: 'completed',
  service_tier: tier,
  output: [{ type: 'message', content: [{ type: 'output_text', text: '{"reply":"Dwa kawałki"}' }] }],
  usage: { input_tokens: 1000, output_tokens: 10, total_tokens: 1010, input_tokens_details: { cached_tokens: 0 } },
});

async function* events(list: Array<Record<string, unknown> | Error>): AsyncGenerator<Record<string, unknown>> {
  for (const item of list) {
    if (item instanceof Error) throw item;
    yield item;
  }
}

describe('streamed calls through the cost guard', () => {
  let ledgerPath: string;
  beforeEach(() => {
    ledgerPath = join(mkdtempSync(join(tmpdir(), 'glucomind-stream-test-')), 'ledger.json');
    initializeExperimentBudgetLedger(ledgerPath, { experiment_id: 'synthetic-stream', currency: 'USD', total_budget: 1, max_calls: 10 });
  });

  function client(streams: Array<Array<Record<string, unknown> | Error> | Error>, serviceTier: 'flex' | null = null) {
    const create = vi.fn(async (body: Record<string, unknown>, _options?: Record<string, unknown>) => {
      const next = streams[create.mock.calls.length - 1];
      if (next instanceof Error) throw next;
      return body.stream === true ? events(next ?? []) as unknown as Record<string, unknown> : finalResponse();
    });
    const count = vi.fn(async (_body: Record<string, unknown>, _options?: Record<string, unknown>) => ({ input_tokens: 1000 }));
    const transport: OpenAiResponsesTransport = { responses: { create, inputTokens: { count } } };
    const ledger = new FileExperimentBudgetLedger(ledgerPath);
    return { guarded: createGuardedOpenAiClient({ transport, pricing: PRICING, costGuard: GUARD, ledger, service_tier: serviceTier }), create, count, ledger };
  }

  it('reports the text after every delta and resolves to the final response, settled from its usage', async () => {
    const { guarded, create, count, ledger } = client([[
      { type: 'response.created' },
      { type: 'response.output_text.delta', delta: '{"reply":"Dwa' },
      { type: 'response.output_text.delta', delta: ' kawałki"}' },
      { type: 'response.completed', response: finalResponse() },
    ]]);
    const texts: string[] = [];
    const response = await guarded.responses.create({ model: 'm', input: 'x' }, { timeout: 1000, [ON_OUTPUT_TEXT_OPTION]: (text: string) => texts.push(text) });

    expect(response).toEqual(finalResponse());
    expect(texts).toEqual(['', '{"reply":"Dwa', '{"reply":"Dwa kawałki"}']);
    expect(create.mock.calls[0][0]).toMatchObject({ stream: true, max_output_tokens: 1000 });
    // The listener is ours: never sent to the SDK or the counting endpoint.
    expect(create.mock.calls[0][1]).not.toHaveProperty(ON_OUTPUT_TEXT_OPTION);
    expect(count.mock.calls[0][1]).not.toHaveProperty(ON_OUTPUT_TEXT_OPTION);
    expect(count.mock.calls[0][0]).not.toHaveProperty('stream');
    const [reservation] = ledger.read().reservations;
    expect(reservation?.status).toBe('SETTLED');
    expect(reservation?.actual_cost).toBeCloseTo(0.002 + 0.01 * 0.012, 12);
  });

  it('does not stream without the listener', async () => {
    const { guarded, create } = client([[]]);
    await guarded.responses.create({ model: 'm', input: 'x' });
    expect(create.mock.calls[0][0]).not.toHaveProperty('stream');
  });

  it('throws on a failed response or a stream that ends early, keeping the worst case charged', async () => {
    const failed = client([[{ type: 'response.failed', response: { error: { code: 'server_error' } } }]]);
    await expect(failed.guarded.responses.create({ model: 'm', input: 'x' }, { [ON_OUTPUT_TEXT_OPTION]: () => {} })).rejects.toThrow('server_error');
    expect(failed.ledger.read().reservations[0]?.status).toBe('OUTCOME_UNKNOWN');

    const early = client([[{ type: 'response.output_text.delta', delta: '{"re' }]]);
    await expect(early.guarded.responses.create({ model: 'm', input: 'x' }, { [ON_OUTPUT_TEXT_OPTION]: () => {} })).rejects.toThrow('without a final response');
  });

  it('starts the text again on the standard-tier retry after a dropped flex stream', async () => {
    const dropped = Object.assign(new Error('status 429'), { status: 429 });
    const { guarded, create } = client([
      [{ type: 'response.output_text.delta', delta: '{"reply":"Stary' }, dropped],
      [{ type: 'response.output_text.delta', delta: '{"reply":"Nowy"}' }, { type: 'response.completed', response: finalResponse() }],
    ], 'flex');
    const texts: string[] = [];
    await guarded.responses.create({ model: 'm', input: 'x' }, { [ON_OUTPUT_TEXT_OPTION]: (text: string) => texts.push(text) });
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[1][0]).not.toHaveProperty('service_tier');
    expect(texts).toEqual(['', '{"reply":"Stary', '', '{"reply":"Nowy"}']);
  });

  it('a throwing listener does not fail the call', async () => {
    const { guarded } = client([[{ type: 'response.output_text.delta', delta: 'x' }, { type: 'response.completed', response: finalResponse() }]]);
    await expect(guarded.responses.create({ model: 'm', input: 'x' }, { [ON_OUTPUT_TEXT_OPTION]: () => { throw new Error('listener'); } })).resolves.toEqual(finalResponse());
  });
});

describe('streamed call timeout', () => {
  it('bounds the whole stream, aborts it and reports a 408 the flex fallback understands', async () => {
    const ledgerPath = join(mkdtempSync(join(tmpdir(), 'glucomind-stream-timeout-')), 'ledger.json');
    initializeExperimentBudgetLedger(ledgerPath, { experiment_id: 'synthetic-stream-timeout', currency: 'USD', total_budget: 1, max_calls: 10 });
    let seenSignal: AbortSignal | undefined;
    const create = vi.fn(async (_body: Record<string, unknown>, options?: Record<string, unknown>) => {
      seenSignal = options?.signal as AbortSignal;
      const signal = seenSignal;
      return (async function* slow() {
        yield { type: 'response.output_text.delta', delta: '{"reply":"Wol' };
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, 5_000);
          signal.addEventListener('abort', () => { clearTimeout(timer); reject(Object.assign(new Error('aborted'), { name: 'APIUserAbortError' })); });
        });
        yield { type: 'response.completed', response: finalResponse() };
      })() as unknown as Record<string, unknown>;
    });
    const transport: OpenAiResponsesTransport = { responses: { create, inputTokens: { count: vi.fn(async () => ({ input_tokens: 1000 })) } } };
    const guarded = createGuardedOpenAiClient({ transport, pricing: PRICING, costGuard: GUARD, ledger: new FileExperimentBudgetLedger(ledgerPath) });
    await expect(guarded.responses.create({ model: 'm', input: 'x' }, { timeout: 50, [ON_OUTPUT_TEXT_OPTION]: () => {} }))
      .rejects.toMatchObject({ status: 408, code: 'STREAM_TIMEOUT' });
    expect(seenSignal?.aborted).toBe(true);
  });

  it('aborts the stream when the caller gives up', async () => {
    const ledgerPath = join(mkdtempSync(join(tmpdir(), 'glucomind-stream-abort-')), 'ledger.json');
    initializeExperimentBudgetLedger(ledgerPath, { experiment_id: 'synthetic-stream-abort', currency: 'USD', total_budget: 1, max_calls: 10 });
    let seenSignal: AbortSignal | undefined;
    const caller = new AbortController();
    const create = vi.fn(async (_body: Record<string, unknown>, options?: Record<string, unknown>) => {
      seenSignal = options?.signal as AbortSignal;
      const signal = seenSignal;
      return (async function* slow() {
        await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
        yield {};
      })() as unknown as Record<string, unknown>;
    });
    const transport: OpenAiResponsesTransport = { responses: { create, inputTokens: { count: vi.fn(async () => ({ input_tokens: 1000 })) } } };
    const guarded = createGuardedOpenAiClient({ transport, pricing: PRICING, costGuard: GUARD, ledger: new FileExperimentBudgetLedger(ledgerPath) });
    const call = guarded.responses.create({ model: 'm', input: 'x' }, { signal: caller.signal, [ON_OUTPUT_TEXT_OPTION]: () => {} });
    await vi.waitFor(() => expect(seenSignal).toBeDefined());
    caller.abort();
    await expect(call).rejects.toThrow('aborted');
    expect(seenSignal?.aborted).toBe(true);
  });
});
