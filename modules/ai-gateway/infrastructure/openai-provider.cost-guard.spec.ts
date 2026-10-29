import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenAiProvider, buildOpenAiResponsesRequestBody } from './openai-provider';
import { buildTimeRangeAnalysisPrompt } from '@modules/ai-gateway/application/time-range-analysis-prompt';
import { AiProviderError } from './ai-provider.error';
import { FakeAiProvider } from './fake-ai-provider';
import { createGuardedOpenAiClient, type OpenAiResponsesTransport } from './guarded-openai-client';
import { FileExperimentBudgetLedger, initializeExperimentBudgetLedger, summarizeExperimentBudget } from './experiment-budget-ledger';
import { AiGatewayService } from '@modules/ai-gateway/application/ai-gateway.service';
import { createConversationTimeRangeAnalysisTask } from '@modules/ai-gateway/application/ai-task';
import type { AiCostGuardConfig } from '@modules/ai-gateway/application/ai-cost-guard';
import { AiExecutionError, type AIPricingConfig } from '@modules/ai-gateway/domain/ai-gateway';

// The real OpenAI provider, guarded transport and gateway with a fake HTTP transport and a ledger file in a temporary
// directory: offline, synthetic data, nothing billed, no database.

const openAiConstructor = vi.hoisted(() => vi.fn());
vi.mock('openai', () => ({
  default: class {
    readonly responses = { create: vi.fn(), inputTokens: { count: vi.fn() } };
    constructor(options: Record<string, unknown>) {
      openAiConstructor(options);
    }
  },
}));

// Approved experiment: 0.25 USD in total, one model call.
const PRICING: AIPricingConfig = {
  input_per_1k_tokens: 0.002,
  output_per_1k_tokens: 0.008,
  cached_input_per_1k_tokens: 0.0005,
  reasoning_per_1k_tokens: 0.008,
  currency: 'USD',
  pricing_version: 'synthetic-pricing.v1',
};
const GUARD: AiCostGuardConfig = { max_cost: 0.25, currency: 'USD', max_output_tokens: 1500 };
const USAGE = { input_tokens: 3000, output_tokens: 300, total_tokens: 3300, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 100 } };
const COUNTED_INPUT_TOKENS = 3000;

function createContext(): any {
  return {
    context_package_id: 'tr-guard-1',
    context_package_version: 'conversation-time-range-context.v1',
    content_hash: 'sha256:tr-guard-1',
    created_at: '2026-10-08T10:00:00.000Z',
    patient_ref: { patient_id: 'patient-1' },
    analysis_request_input: {
      user_message_id: 'msg-guard-1',
      user_message_text: 'Przeanalizuj mi dzisiejszy dzień',
      range_type: 'TODAY',
      timezone: 'Europe/Warsaw',
      range_start: '2026-10-08T00:00:00.000Z',
      range_end: '2026-10-08T23:59:59.999Z',
      requested_at: '2026-10-08T10:00:00.000Z',
    },
    conversation_context: { thread_id: 'conv-guard-1', thread_state_version: 'v1', awaiting_user_answer: false, messages: [] },
    current_state_snapshot: { as_of: '2026-10-08T10:00:00.000Z', current_glucose: 142, trend: 'FLAT', iob: 1.9 },
    analytical_evidence: {
      glucose_events: [
        { event_id: 'g-1', occurred_at: '2026-10-08T06:00:00.000Z', payload: { glucose_value: 91 }, provenance_ref: 'source-record/g-1' },
        { event_id: 'g-2', occurred_at: '2026-10-08T07:00:00.000Z', payload: { glucose_value: 122 }, provenance_ref: 'source-record/g-2' },
      ],
      insulin_treatment_events: [],
      meal_events: [],
      activity_events: [],
      hypo_episodes: [],
      range_event_facts: [],
      summaries: {
        total_events: 2, glucose_count: 2, insulin_treatment_count: 0, meal_count: 0, activity_count: 0, hypo_episode_count: 0,
        glucose_min: 91, glucose_max: 122, glucose_avg: 106.5, missing_sections: ['insulin_treatment_events', 'meal_events', 'activity_events', 'hypo_episodes'],
      },
    },
    provenance: { source_refs: ['msg-guard-1'], selection_policy_version: 'conversation-time-range-selector.v1' },
  };
}

function createTask(context: any) {
  return createConversationTimeRangeAnalysisTask({
    task_id: 'guard-task-1',
    context_package_id: context.context_package_id,
    context_package_version: context.context_package_version,
    context_package_hash: context.content_hash,
    correlation_id: 'conv-guard-1',
    created_at: '2026-10-08T10:00:00.000Z',
    patient_id: 'patient-1',
  });
}

function finalResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'resp-guard-1',
    output_text: JSON.stringify({ assistant_message: 'Glikemia była dziś stabilna. Brak danych o posiłkach, więc ich wpływ pozostaje UNKNOWN.' }),
    usage: USAGE,
    ...overrides,
  };
}

type Step = Record<string, unknown> | Error | 'HANG';

function fakeTransport(script: Step[], options: { count?: number | Error | null } = {}) {
  const create = vi.fn(async (_body: Record<string, unknown>, _options?: Record<string, unknown>) => {
    const next = script[create.mock.calls.length - 1];
    if (next === 'HANG') return new Promise<Record<string, unknown>>(() => undefined);
    if (next instanceof Error) throw next;
    if (!next) throw new Error('unexpected extra provider call');
    return next;
  });
  const countValue = 'count' in options ? options.count : COUNTED_INPUT_TOKENS;
  const count = vi.fn(async (_body: Record<string, unknown>, _options?: Record<string, unknown>) => {
    if (countValue instanceof Error) throw countValue;
    return { object: 'response.input_tokens', input_tokens: countValue };
  });
  const transport: OpenAiResponsesTransport = { responses: { create, inputTokens: { count } } };
  return { transport, create, count };
}

let ledgerDir: string;
let ledgerPath: string;
const ledger = () => new FileExperimentBudgetLedger(ledgerPath);

beforeEach(() => {
  ledgerDir = mkdtempSync(join(tmpdir(), 'glucomind-guard-test-'));
  ledgerPath = join(ledgerDir, 'ledger.json');
  initializeExperimentBudgetLedger(ledgerPath, { experiment_id: 'synthetic-first-experiment', currency: 'USD', total_budget: 0.25, max_calls: 1 });
});

afterEach(() => {
  rmSync(ledgerDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

function provider(transport: OpenAiResponsesTransport, config: { pricing?: AIPricingConfig | null; costGuard?: AiCostGuardConfig | null; withLedger?: boolean } = {}) {
  return new OpenAiProvider({
    apiKey: 'synthetic-test-key',
    model: 'synthetic-model',
    timeoutMs: 5000,
    pricing: 'pricing' in config ? config.pricing : PRICING,
    costGuard: 'costGuard' in config ? config.costGuard : GUARD,
    budgetLedger: config.withLedger === false ? null : ledger(),
  }, transport);
}

async function execute(gatewayProvider: OpenAiProvider | FakeAiProvider, timeoutMs = 5000, taskId = 'guard-task-1') {
  const context = createContext();
  const task = { ...createTask(context), task_id: taskId };
  return new AiGatewayService(gatewayProvider).execute({ task, context_package: context, timeout_ms: timeoutMs });
}

const refusedBefore = (error: unknown, reason: string) => {
  expect(error).toBeInstanceOf(AiExecutionError);
  expect(error).toMatchObject({ code: 'AI_PROVIDER_NON_RETRYABLE', retryable: false, details: { provider_code: 'AI_COST_LIMIT_REFUSED' } });
  expect((error as Error).message).toContain(reason);
};

describe('guarded OpenAI transport: refusals before any traffic', () => {
  it('refuses without pricing, with incomplete pricing, without a limit or currency, or without a ledger', async () => {
    const cases: Array<[Parameters<typeof provider>[1], string]> = [
      [{ pricing: null }, 'PRICING_NOT_CONFIGURED'],
      [{ pricing: { ...PRICING, reasoning_per_1k_tokens: null } }, 'INCOMPLETE_PRICING'],
      [{ pricing: { ...PRICING, currency: null } }, 'INCOMPLETE_PRICING'],
      [{ costGuard: { ...GUARD, max_cost: Number.NaN } }, 'INVALID_LIMIT'],
      [{ costGuard: { ...GUARD, currency: '' } }, 'INVALID_LIMIT'],
      [{ withLedger: false }, 'LEDGER_NOT_CONFIGURED'],
    ];
    for (const [config, reason] of cases) {
      const { transport, create, count } = fakeTransport([finalResponse()]);
      refusedBefore(await execute(provider(transport, config)).catch((caught) => caught), reason);
      expect(count).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
    }
  });

  it('refuses when the provider cannot count the input tokens', async () => {
    for (const countResult of [new Error('count failed'), null]) {
      const { transport, create } = fakeTransport([finalResponse()], { count: countResult });
      refusedBefore(await execute(provider(transport)).catch((caught) => caught), 'INPUT_TOKENS_UNCOUNTED');
      expect(create).not.toHaveBeenCalled();
    }
    expect(summarizeExperimentBudget(ledger().read()).calls).toBe(0);
  });

  it('retries only the free token count after a transient error, then makes the paid call once', async () => {
    const { transport, create, count } = fakeTransport([finalResponse()]);
    const rateLimited = Object.assign(new Error('rate limited'), { status: 429 });
    count.mockRejectedValueOnce(rateLimited);
    await execute(provider(transport));
    expect(count).toHaveBeenCalledTimes(2);
    expect(create).toHaveBeenCalledTimes(1);
    expect(summarizeExperimentBudget(ledger().read()).calls).toBe(1);
  });

  it('retries the token count after an SDK connection error, which has no status and the default name "Error"', async () => {
    // Same shape as the SDK class (the SDK module is mocked in this file): no status, name left as "Error".
    class APIConnectionError extends Error {}
    class APIConnectionTimeoutError extends APIConnectionError {}
    const { transport, create, count } = fakeTransport([finalResponse()]);
    const connectionError = new APIConnectionTimeoutError('Request timed out.');
    expect(connectionError.name).toBe('Error');
    count.mockRejectedValueOnce(connectionError);
    await execute(provider(transport));
    expect(count).toHaveBeenCalledTimes(2);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('does not retry the token count after a non-transient error and still refuses', async () => {
    const badRequest = Object.assign(new Error('bad request'), { status: 400 });
    const { transport, create, count } = fakeTransport([finalResponse()], { count: badRequest });
    refusedBefore(await execute(provider(transport)).catch((caught) => caught), 'INPUT_TOKENS_UNCOUNTED');
    expect(count).toHaveBeenCalledTimes(1);
    expect(create).not.toHaveBeenCalled();
  });

  it('refuses when the counted worst case exceeds 0.25 USD and reserves nothing', async () => {
    const { transport, create } = fakeTransport([finalResponse()], { count: 200_000 });
    refusedBefore(await execute(provider(transport)).catch((caught) => caught), 'MAX_COST_EXCEEDS_LIMIT');
    expect(create).not.toHaveBeenCalled();
    expect(summarizeExperimentBudget(ledger().read()).calls).toBe(0);
  });
});

describe('guarded OpenAI transport: the single paid call', () => {
  it('sends one request with max_output_tokens and no SDK retries, counts the same request, and settles the cost', async () => {
    const { transport, create, count } = fakeTransport([finalResponse()]);
    const execution = await execute(provider(transport));
    expect(count).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(1);
    const [body, options] = create.mock.calls[0];
    expect(body.max_output_tokens).toBe(1500);
    expect(options).toMatchObject({ maxRetries: 0 });
    const [countBody] = count.mock.calls[0];
    expect(countBody).not.toHaveProperty('max_output_tokens');
    expect(countBody.input).toEqual(body.input);
    expect(countBody.text).toEqual(body.text);
    const expectedCost = 3 * 0.002 + 0.3 * 0.008 + 0.1 * 0.008;
    expect(execution.metadata.estimated_cost?.estimated_cost).toBeCloseTo(expectedCost, 12);
    const stored = ledger().read();
    expect(stored.reservations).toHaveLength(1);
    expect(stored.reservations[0]).toMatchObject({ status: 'SETTLED' });
    expect(stored.reservations[0].actual_cost).toBeCloseTo(expectedCost, 12);
  });

  it('refuses a second, new job of the same experiment before any traffic', async () => {
    const first = fakeTransport([finalResponse()]);
    await execute(provider(first.transport), 5000, 'job-a');
    // New job, new provider instance (as after a worker restart), same durable ledger.
    const second = fakeTransport([finalResponse()]);
    refusedBefore(await execute(provider(second.transport), 5000, 'job-b').catch((caught) => caught), 'EXPERIMENT_CALL_LIMIT_REACHED');
    expect(second.count).not.toHaveBeenCalled();
    expect(second.create).not.toHaveBeenCalled();
  });

  it('builds the real SDK client with maxRetries 0, and refuses to build it without the guard', () => {
    openAiConstructor.mockClear();
    new OpenAiProvider({ apiKey: 'synthetic-test-key', pricing: PRICING, costGuard: GUARD, budgetLedger: ledger() });
    expect(openAiConstructor).toHaveBeenLastCalledWith({ apiKey: 'synthetic-test-key', maxRetries: 0 });
    openAiConstructor.mockClear();
    expect(() => new OpenAiProvider({ apiKey: 'synthetic-test-key' })).toThrow('requires pricing, costGuard and budgetLedger');
    expect(() => new OpenAiProvider({ apiKey: 'synthetic-test-key', pricing: PRICING, costGuard: GUARD })).toThrow('requires pricing, costGuard and budgetLedger');
    expect(openAiConstructor).not.toHaveBeenCalled();
  });

  it('rejects a response with unknown usage and keeps the worst case charged', async () => {
    const { transport, create } = fakeTransport([finalResponse({ usage: undefined })]);
    const error = await execute(provider(transport)).catch((caught) => caught);
    expect(error).toMatchObject({ retryable: false, details: { provider_code: 'AI_COST_LIMIT_EXCEEDED' } });
    expect(error.message).toContain('USAGE_MISSING');
    expect(create).toHaveBeenCalledTimes(1);
    const [reservation] = ledger().read().reservations;
    expect(reservation).toMatchObject({ status: 'OUTCOME_UNKNOWN', actual_cost: null });
    expect(summarizeExperimentBudget(ledger().read()).charged).toBe(reservation.max_cost);
  });

  it('rejects a response whose reported input exceeds the counted bound', async () => {
    const { transport } = fakeTransport([finalResponse({ usage: { ...USAGE, input_tokens: 1_000_000 } })]);
    const error = await execute(provider(transport)).catch((caught) => caught);
    expect(error).toMatchObject({ retryable: false, details: { provider_code: 'AI_COST_LIMIT_EXCEEDED' } });
    expect(error.message).toContain('INPUT_TOKENS_EXCEED_BOUND');
  });

  it('guards a script that builds its own requests with the same transport wrapper', async () => {
    const { transport, create } = fakeTransport([finalResponse(), finalResponse()]);
    const client = createGuardedOpenAiClient({ transport, pricing: PRICING, costGuard: GUARD, ledger: ledger() });
    const body = { model: 'synthetic-model', input: [{ role: 'user', content: 'synthetic' }], max_output_tokens: 100_000 };
    await client.responses.create(body, { timeout: 1000 });
    expect(create.mock.calls[0][0].max_output_tokens).toBe(1500);
    await expect(client.responses.create(body, { timeout: 1000 })).rejects.toThrow('EXPERIMENT_CALL_LIMIT_REACHED');
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('tells the caller what each paid call used and cost (meal chat and WBT records)', async () => {
    const { transport } = fakeTransport([finalResponse()]);
    const calls: any[] = [];
    const client = createGuardedOpenAiClient({ transport, pricing: PRICING, costGuard: GUARD, ledger: ledger(), on_call_settled: (call) => calls.push(call) });
    await client.responses.create({ model: 'synthetic-model', input: [{ role: 'user', content: 'synthetic' }] }, { timeout: 1000 });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ provider: 'openai', model: 'synthetic-model', outcome: 'OK', currency: 'USD', error_code: null });
    expect(calls[0].cost).toBeCloseTo(3 * 0.002 + 0.3 * 0.008 + 0.1 * 0.008, 12);
    expect(calls[0].usage).toMatchObject({ input_tokens: expect.any(Number) });
  });

  it('prices an answer a refusal fallback served at the fallback\'s prices when they are set', async () => {
    const { transport } = fakeTransport([{ ...finalResponse(), fallback_model: 'claude-opus-5' }, { ...finalResponse(), fallback_model: 'claude-opus-5' }]);
    const calls: any[] = [];
    const doubled = { ...PRICING, input_per_1k_tokens: PRICING.input_per_1k_tokens! * 2, output_per_1k_tokens: PRICING.output_per_1k_tokens! * 2, reasoning_per_1k_tokens: PRICING.reasoning_per_1k_tokens! * 2 };
    const client = createGuardedOpenAiClient({ transport, pricing: PRICING, fallback_pricing: doubled, costGuard: { ...GUARD, max_cost: 1 }, ledger: ledger(), on_call_settled: (call) => calls.push(call) });
    await client.responses.create({ model: 'claude-opus-5-5', input: [{ role: 'user', content: 'synthetic' }] }, { timeout: 1000 });
    expect(calls[0].model).toBe('claude-opus-5');
    expect(calls[0].cost).toBeCloseTo(2 * (3 * 0.002 + 0.3 * 0.008 + 0.1 * 0.008), 12);
  });

  it('keeps an injected, unguarded transport unchanged (offline tests only): no max_output_tokens, no maxRetries', async () => {
    const { transport, create, count } = fakeTransport([finalResponse()]);
    await execute(provider(transport, { costGuard: null, withLedger: false }));
    const [body, options] = create.mock.calls[0];
    expect(body).not.toHaveProperty('max_output_tokens');
    expect(options).not.toHaveProperty('maxRetries');
    expect(count).not.toHaveBeenCalled();
  });
});

describe('gateway retryability (offline)', () => {
  it('keeps a retryable provider error retryable', async () => {
    const serverError = Object.assign(new Error('synthetic server error'), { status: 503 });
    const { transport } = fakeTransport([serverError]);
    const error = await execute(provider(transport, { costGuard: null, withLedger: false })).catch((caught) => caught);
    expect(error).toMatchObject({ code: 'AI_PROVIDER_RETRYABLE', retryable: true });
    expect(error).not.toBeInstanceOf(AiProviderError);
  });
});

describe('OPENAI_REASONING_EFFORT in the request body (offline)', () => {
  const guardedProvider = (transport: OpenAiResponsesTransport, reasoningEffort?: 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null) => new OpenAiProvider({
    apiKey: 'synthetic-test-key',
    model: 'synthetic-model',
    timeoutMs: 5000,
    pricing: PRICING,
    costGuard: GUARD,
    budgetLedger: ledger(),
    reasoningEffort,
  }, transport);

  it('adds reasoning.effort only when configured; otherwise the body is exactly as before', () => {
    const context = createContext();
    const prompt = buildTimeRangeAnalysisPrompt(createTask(context), context);
    const base = { model: 'synthetic-model', task_type: 'CONVERSATION_TIME_RANGE_ANALYSIS', system_instructions: prompt.system_instructions, user_payload: prompt.user_payload };
    const without = buildOpenAiResponsesRequestBody(base);
    const withLow = buildOpenAiResponsesRequestBody({ ...base, reasoning_effort: 'low' });

    expect(without).not.toHaveProperty('reasoning');
    expect(buildOpenAiResponsesRequestBody({ ...base, reasoning_effort: null })).toEqual(without);
    expect(Object.keys(buildOpenAiResponsesRequestBody({ ...base, reasoning_effort: null }))).toEqual(Object.keys(without));
    expect(withLow).toEqual({ ...without, reasoning: { effort: 'low' } });
  });

  it('sends the configured effort to the model and counts exactly the same request body', async () => {
    for (const effort of ['none', 'low', 'medium', 'high', 'xhigh', 'max'] as const) {
      rmSync(ledgerPath, { force: true });
      initializeExperimentBudgetLedger(ledgerPath, { experiment_id: `synthetic-${effort}`, currency: 'USD', total_budget: 0.25, max_calls: 1 });
      const { transport, create, count } = fakeTransport([finalResponse()]);
      await execute(guardedProvider(transport, effort));

      const [modelBody] = create.mock.calls[0];
      const [countBody] = count.mock.calls[0];
      expect(modelBody.reasoning).toEqual({ effort });
      // The counting request is the model request minus max_output_tokens (not accepted by the counting endpoint) and
      // prompt_cache_key (routing only, no tokens).
      const { max_output_tokens: _maxOutputTokens, prompt_cache_key: _promptCacheKey, ...modelBodyWithoutCap } = modelBody;
      expect(countBody).toEqual(Object.fromEntries(Object.entries(modelBodyWithoutCap).filter(([, value]) => value !== undefined)));
      expect(countBody.reasoning).toEqual({ effort });
    }
  });

  it('sends no reasoning field when not configured, to the model or the counting request', async () => {
    const { transport, create, count } = fakeTransport([finalResponse()]);
    await execute(guardedProvider(transport, null));
    expect(create.mock.calls[0][0]).not.toHaveProperty('reasoning');
    expect(count.mock.calls[0][0]).not.toHaveProperty('reasoning');
  });

  it('rejects an invalid effort when the provider is built, with no fallback value', () => {
    for (const effort of ['minimal', 'LOW', 'auto']) {
      const { transport } = fakeTransport([]);
      expect(() => guardedProvider(transport, effort as never)).toThrow('OPENAI_REASONING_EFFORT must be one of');
    }
  });

  it('keeps the budget guard: with an effort set, an uncountable or over-limit request is still refused before the model', async () => {
    const uncountable = fakeTransport([finalResponse()], { count: null });
    refusedBefore(await execute(guardedProvider(uncountable.transport, 'low')).catch((caught) => caught), 'INPUT_TOKENS_UNCOUNTED');
    expect(uncountable.create).not.toHaveBeenCalled();

    const overLimit = fakeTransport([finalResponse()], { count: 200_000 });
    refusedBefore(await execute(guardedProvider(overLimit.transport, 'low')).catch((caught) => caught), 'MAX_COST_EXCEEDS_LIMIT');
    expect(overLimit.create).not.toHaveBeenCalled();

    const unknownUsage = fakeTransport([finalResponse({ usage: undefined })]);
    const error = await execute(guardedProvider(unknownUsage.transport, 'low')).catch((caught) => caught);
    expect(error).toMatchObject({ retryable: false, details: { provider_code: 'AI_COST_LIMIT_EXCEEDED' } });
  });
});

describe('prompt cache: key and explicit breakpoint', () => {
  function cachingProvider(transport: OpenAiResponsesTransport, promptCacheBreakpoints: boolean) {
    return new OpenAiProvider({
      apiKey: 'synthetic-test-key',
      model: 'synthetic-model',
      timeoutMs: 5000,
      pricing: PRICING,
      costGuard: GUARD,
      budgetLedger: ledger(),
      promptCacheBreakpoints,
    }, transport);
  }

  it('marks the end of the system message as a breakpoint, sends the cache key, and counts tokens without either', async () => {
    const { transport, create, count } = fakeTransport([finalResponse()]);
    await execute(cachingProvider(transport, true));

    const body = create.mock.calls[0][0] as Record<string, any>;
    expect(body.prompt_cache_key).toBe('glucomind:CONVERSATION_TIME_RANGE_ANALYSIS');
    expect(body.input[0].role).toBe('system');
    expect(body.input[0].content).toEqual([
      { type: 'input_text', text: expect.stringContaining('diabetes conversational assistant'), prompt_cache_breakpoint: { mode: 'explicit' } },
    ]);
    expect(typeof body.input[1].content).toBe('string');

    const countBody = count.mock.calls[0][0] as Record<string, any>;
    expect(JSON.stringify(countBody)).not.toContain('prompt_cache_breakpoint');
    expect(countBody.prompt_cache_key).toBeUndefined();
    expect(countBody.input[0].content).toEqual([{ type: 'input_text', text: body.input[0].content[0].text }]);
  });

  it('keeps the plain system message when breakpoints are off', async () => {
    const { transport, create } = fakeTransport([finalResponse()]);
    await execute(cachingProvider(transport, false));
    const body = create.mock.calls[0][0] as Record<string, any>;
    expect(typeof body.input[0].content).toBe('string');
    expect(body.prompt_cache_key).toBe('glucomind:CONVERSATION_TIME_RANGE_ANALYSIS');
  });
});
