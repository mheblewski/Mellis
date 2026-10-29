import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AiProviderError } from './ai-provider.error';
import { FileExperimentBudgetLedger, initializeExperimentBudgetLedger, summarizeExperimentBudget } from './experiment-budget-ledger';
import { createGuardedOpenAiEmbeddingsClient, createGuardedOpenAiEmbeddingsClientFromEnv, type EmbeddingPricingConfig } from './guarded-openai-client';

// Guarded embeddings with a fake transport and a ledger file in a temporary directory: offline, nothing billed.

vi.mock('openai', () => ({
  default: class {
    readonly embeddings = { create: vi.fn() };
    readonly responses = { create: vi.fn() };
  },
}));

const PRICING: EmbeddingPricingConfig = { input_per_1k_tokens: 0.00002, currency: 'USD', pricing_version: 'synthetic-embedding.v1' };
const GUARD = { max_cost: 0.01, currency: 'USD' };

let dir: string;
let ledgerPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'guarded-embeddings-'));
  ledgerPath = join(dir, 'ledger.json');
  initializeExperimentBudgetLedger(ledgerPath, { experiment_id: 'embeddings-test', currency: 'USD', total_budget: 0.05, max_calls: 3 });
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

function client(create: ReturnType<typeof vi.fn>, overrides: Partial<Parameters<typeof createGuardedOpenAiEmbeddingsClient>[0]> = {}) {
  return createGuardedOpenAiEmbeddingsClient({ transport: { embeddings: { create } }, pricing: PRICING, costGuard: GUARD, ledger: new FileExperimentBudgetLedger(ledgerPath), ...overrides });
}

function ledgerSummary() {
  return summarizeExperimentBudget(new FileExperimentBudgetLedger(ledgerPath).read());
}

describe('guarded embeddings', () => {
  it('reserves the byte bound, sends once without retries and settles the reported tokens', async () => {
    const create = vi.fn(async (_body: Record<string, unknown>, _options?: Record<string, unknown>) => ({ data: [{ index: 0, embedding: [0.1] }, { index: 1, embedding: [0.2] }], usage: { prompt_tokens: 3, total_tokens: 3 } }));
    await client(create).embeddings.create({ model: 'text-embedding-3-small', input: ['abcd', 'efgh'] });

    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][1]).toMatchObject({ maxRetries: 0 });
    const ledger = new FileExperimentBudgetLedger(ledgerPath).read();
    expect(ledger.reservations).toHaveLength(1);
    // (4 + 16) bytes per input, two inputs.
    expect(ledger.reservations[0].max_cost).toBeCloseTo((40 / 1000) * 0.00002, 12);
    expect(ledger.reservations[0].status).toBe('SETTLED');
    expect(ledger.reservations[0].actual_cost).toBeCloseTo((3 / 1000) * 0.00002, 12);
  });

  it('refuses without pricing, guard or ledger and with a currency mismatch, before any traffic', async () => {
    const create = vi.fn();
    await expect(client(create, { pricing: null }).embeddings.create({ model: 'm', input: 'x' })).rejects.toBeInstanceOf(AiProviderError);
    await expect(client(create, { costGuard: null }).embeddings.create({ model: 'm', input: 'x' })).rejects.toBeInstanceOf(AiProviderError);
    await expect(client(create, { ledger: null }).embeddings.create({ model: 'm', input: 'x' })).rejects.toBeInstanceOf(AiProviderError);
    await expect(client(create, { pricing: { ...PRICING, currency: 'EUR' } }).embeddings.create({ model: 'm', input: 'x' })).rejects.toThrow(/CURRENCY_MISMATCH/);
    expect(create).not.toHaveBeenCalled();
    expect(ledgerSummary().calls).toBe(0);
  });

  it('refuses token-array or empty inputs and a worst case above the per-call limit', async () => {
    const create = vi.fn();
    await expect(client(create).embeddings.create({ model: 'm', input: [[1, 2, 3]] })).rejects.toThrow(/INVALID_REQUEST_SIZE/);
    await expect(client(create).embeddings.create({ model: 'm', input: [] })).rejects.toThrow(/INVALID_REQUEST_SIZE/);
    await expect(client(create, { costGuard: { max_cost: 1e-9, currency: 'USD' } }).embeddings.create({ model: 'm', input: 'x'.repeat(1000) })).rejects.toThrow(/MAX_COST_EXCEEDS_LIMIT/);
    expect(create).not.toHaveBeenCalled();
  });

  it('keeps the worst case charged when the call fails or usage is missing', async () => {
    await expect(client(vi.fn().mockRejectedValue(new Error('network'))).embeddings.create({ model: 'm', input: 'abcd' })).rejects.toThrow('network');
    await expect(client(vi.fn(async () => ({ data: [] }))).embeddings.create({ model: 'm', input: 'abcd' })).rejects.toThrow(/USAGE_MISSING/);
    const ledger = new FileExperimentBudgetLedger(ledgerPath).read();
    expect(ledger.reservations.map((entry) => entry.status)).toEqual(['OUTCOME_UNKNOWN', 'OUTCOME_UNKNOWN']);
  });

  it('rejects reported tokens above the byte bound', async () => {
    const create = vi.fn(async () => ({ data: [], usage: { prompt_tokens: 1000 } }));
    await expect(client(create).embeddings.create({ model: 'm', input: 'abcd' })).rejects.toThrow(/INPUT_TOKENS_EXCEED_BOUND/);
  });

  it('stops at the ledger call limit', async () => {
    const create = vi.fn(async () => ({ data: [{ index: 0, embedding: [1] }], usage: { prompt_tokens: 1 } }));
    const guarded = client(create);
    for (let call = 0; call < 3; call += 1) await guarded.embeddings.create({ model: 'm', input: 'abcd' });
    await expect(guarded.embeddings.create({ model: 'm', input: 'abcd' })).rejects.toThrow(/EXPERIMENT_CALL_LIMIT_REACHED/);
    expect(create).toHaveBeenCalledTimes(3);
  });

  it('builds from the environment only with embedding pricing, limit and ledger', () => {
    const env = {
      OPENAI_EMBEDDING_PRICING_INPUT_PER_1K_TOKENS: '0.00002',
      OPENAI_EMBEDDING_PRICING_VERSION: 'synthetic-embedding.v1',
      OPENAI_PRICING_CURRENCY: 'USD',
      AI_EXPERIMENT_MAX_COST: '0.01',
      AI_EXPERIMENT_COST_CURRENCY: 'USD',
      AI_EXPERIMENT_BUDGET_LEDGER_PATH: ledgerPath,
    };
    expect(createGuardedOpenAiEmbeddingsClientFromEnv(env, 'sk-test').embeddings.create).toBeTypeOf('function');
    expect(() => createGuardedOpenAiEmbeddingsClientFromEnv({ ...env, OPENAI_EMBEDDING_PRICING_INPUT_PER_1K_TOKENS: '' }, 'sk-test')).toThrow(/not configured/);
    expect(() => createGuardedOpenAiEmbeddingsClientFromEnv({ ...env, AI_EXPERIMENT_BUDGET_LEDGER_PATH: '' }, 'sk-test')).toThrow(/LEDGER_PATH/);
  });
});
