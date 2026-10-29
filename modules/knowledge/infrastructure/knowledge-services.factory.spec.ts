import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { initializeExperimentBudgetLedger } from '@modules/ai-gateway/infrastructure/experiment-budget-ledger';
import { anthropicKnowledgeModel, buildKnowledgeSearch, lightPricingEnv, loadProtocolCard, missingKeywordSearchConfiguration, missingKnowledgeSearchConfiguration } from './knowledge-services.factory';

function logger() {
  const lines: string[] = [];
  return { lines, log: (message: string) => lines.push(message), warn: (message: string) => lines.push(message) };
}

const pool = { connect: async () => { throw new Error('not used'); }, query: async () => { throw new Error('not used'); } } as any;

function completeEnv(ledgerPath: string): Record<string, string> {
  return {
    AI_ENABLE_KNOWLEDGE_SEARCH: '1',
    AI_PROVIDER: 'openai',
    OPENAI_API_KEY: 'sk-test-not-used',
    OPENAI_LIGHT_MODEL: 'light-x',
    OPENAI_LIGHT_PRICING_INPUT_PER_1K_TOKENS: '0.0002',
    OPENAI_LIGHT_PRICING_CACHED_INPUT_PER_1K_TOKENS: '0.00002',
    OPENAI_LIGHT_PRICING_OUTPUT_PER_1K_TOKENS: '0.0012',
    OPENAI_LIGHT_PRICING_REASONING_PER_1K_TOKENS: '0',
    OPENAI_LIGHT_PRICING_CURRENCY: 'USD',
    OPENAI_LIGHT_PRICING_VERSION: 'light.v1',
    OPENAI_EMBEDDING_PRICING_INPUT_PER_1K_TOKENS: '0.00002',
    OPENAI_EMBEDDING_PRICING_VERSION: 'embedding.v1',
    OPENAI_PRICING_CURRENCY: 'USD',
    AI_EXPERIMENT_MAX_COST: '0.25',
    AI_EXPERIMENT_COST_CURRENCY: 'USD',
    AI_EXPERIMENT_MAX_OUTPUT_TOKENS: '4000',
    AI_EXPERIMENT_BUDGET_LEDGER_PATH: ledgerPath,
  };
}

function ledgerFile(): string {
  const path = join(mkdtempSync(join(tmpdir(), 'knowledge-factory-')), 'ledger.json');
  initializeExperimentBudgetLedger(path, { experiment_id: 'knowledge-factory-test', total_budget: 1, currency: 'USD', max_calls: 10 });
  return path;
}

describe('knowledge search factory', () => {
  it('is off without the flag, with the fake provider and with incomplete configuration (logged, never thrown)', () => {
    const log = logger();
    expect(buildKnowledgeSearch({}, pool, log)).toBeNull();
    expect(log.lines).toEqual([]);

    expect(buildKnowledgeSearch({ AI_ENABLE_KNOWLEDGE_SEARCH: '1', AI_PROVIDER: 'fake' }, pool, log)).toBeNull();
    expect(JSON.parse(log.lines[0])).toEqual({ event: 'knowledge_search_disabled', reason: 'AI_PROVIDER_FAKE' });

    const env = completeEnv('/nonexistent/ledger.json');
    delete (env as Record<string, string | undefined>).OPENAI_EMBEDDING_PRICING_VERSION;
    expect(buildKnowledgeSearch(env, pool, log)).toBeNull();
    expect(JSON.parse(log.lines[1])).toMatchObject({ reason: 'MISSING_CONFIGURATION', missing: ['OPENAI_EMBEDDING_PRICING_VERSION'] });
  });

  it('refuses to start without a readable budget ledger, and builds the guarded search with one', () => {
    const log = logger();
    expect(buildKnowledgeSearch(completeEnv('/nonexistent/ledger.json'), pool, log)).toBeNull();
    expect(JSON.parse(log.lines[0])).toMatchObject({ event: 'knowledge_search_disabled', reason: 'CONFIGURATION_REFUSED' });
    // The key never appears in the log.
    expect(log.lines.join('\n')).not.toContain('sk-test');

    const ready = logger();
    expect(buildKnowledgeSearch(completeEnv(ledgerFile()), pool, ready)).not.toBeNull();
    expect(JSON.parse(ready.lines[0])).toEqual({ event: 'knowledge_search_enabled', mode: 'hybrid', light_model: 'light-x' });
  });

  it('builds under the Anthropic answer provider too (the search keeps its own OpenAI clients)', () => {
    const ready = logger();
    expect(buildKnowledgeSearch({ ...completeEnv(ledgerFile()), AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'sk-ant-x' }, pool, ready)).not.toBeNull();
    expect(JSON.parse(ready.lines[0])).toEqual({ event: 'knowledge_search_enabled', mode: 'hybrid', light_model: 'light-x' });
  });

  it('builds the BM25 mode on Claude alone (no OpenAI key): no embeddings client, mode logged once', () => {
    const ledger = ledgerFile();
    const env: Record<string, string> = {
      AI_ENABLE_KNOWLEDGE_SEARCH: '1',
      AI_PROVIDER: 'anthropic',
      ANTHROPIC_API_KEY: 'sk-ant-test-not-used',
      ANTHROPIC_MODEL: 'claude-opus-5-5',
      ANTHROPIC_LIGHT_MODEL: 'claude-haiku-5-5',
      ANTHROPIC_LIGHT_PRICING_INPUT_PER_1K_TOKENS: '0.0001',
      ANTHROPIC_LIGHT_PRICING_CACHED_INPUT_PER_1K_TOKENS: '0.00001',
      ANTHROPIC_LIGHT_PRICING_OUTPUT_PER_1K_TOKENS: '0.0005',
      ANTHROPIC_LIGHT_PRICING_REASONING_PER_1K_TOKENS: '0',
      ANTHROPIC_LIGHT_PRICING_CURRENCY: 'USD',
      ANTHROPIC_LIGHT_PRICING_VERSION: 'haiku.v1',
      AI_EXPERIMENT_MAX_COST: '0.25',
      AI_EXPERIMENT_COST_CURRENCY: 'USD',
      AI_EXPERIMENT_MAX_OUTPUT_TOKENS: '4000',
      AI_EXPERIMENT_BUDGET_LEDGER_PATH: ledger,
    };
    const ready = logger();
    const search = buildKnowledgeSearch(env, pool, ready);
    expect(search).not.toBeNull();
    expect((search as unknown as { deps: { embeddingsClient: unknown } }).deps.embeddingsClient).toBeNull();
    expect(ready.lines.map((line) => JSON.parse(line))).toEqual([{ event: 'knowledge_search_enabled', mode: 'bm25', light_model: 'claude-haiku-5-5' }]);
    expect(ready.lines.join('\n')).not.toContain('sk-ant');

    // Without a light model the main model and its prices are used; a missing price is named.
    const { ANTHROPIC_LIGHT_MODEL: _light, ...withoutLight } = env;
    expect(anthropicKnowledgeModel(withoutLight)).toEqual({ model: 'claude-opus-5-5', pricingPrefix: 'ANTHROPIC_PRICING' });
    const missing = logger();
    expect(buildKnowledgeSearch(withoutLight, pool, missing)).toBeNull();
    expect(JSON.parse(missing.lines[0])).toMatchObject({ event: 'knowledge_search_disabled', mode: 'bm25', reason: 'MISSING_CONFIGURATION' });
    expect(missingKeywordSearchConfiguration(withoutLight)).toContain('ANTHROPIC_PRICING_INPUT_PER_1K_TOKENS');
  });

  it('keeps the hybrid search whenever an OpenAI key is there, and refuses a provider without its key', () => {
    const ready = logger();
    // Production: Claude answers, OpenAI key present -> unchanged hybrid search on OpenAI.
    expect(buildKnowledgeSearch({ ...completeEnv(ledgerFile()), AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'sk-ant-x' }, pool, ready)).not.toBeNull();
    expect(JSON.parse(ready.lines[0])).toMatchObject({ mode: 'hybrid', light_model: 'light-x' });

    const refused = logger();
    expect(buildKnowledgeSearch({ AI_ENABLE_KNOWLEDGE_SEARCH: '1', AI_PROVIDER: 'anthropic' }, pool, refused)).toBeNull();
    expect(JSON.parse(refused.lines[0])).toMatchObject({ event: 'knowledge_search_disabled', reason: 'CONFIGURATION_REFUSED' });
  });

  it('prices helper calls with the light model and names every missing key', () => {
    const env = lightPricingEnv({ OPENAI_PRICING_INPUT_PER_1K_TOKENS: '0.002', OPENAI_LIGHT_PRICING_INPUT_PER_1K_TOKENS: '0.0002' });
    expect(env.OPENAI_PRICING_INPUT_PER_1K_TOKENS).toBe('0.0002');
    expect(missingKnowledgeSearchConfiguration({})).toContain('OPENAI_LIGHT_MODEL');
  });
});

describe('protocol card', () => {
  const dir = mkdtempSync(join(tmpdir(), 'protocol-card-'));
  const approved = join(dir, 'approved.md');
  const draft = join(dir, 'draft.md');
  writeFileSync(approved, '# Karta protokołów\nKetony ≥ 0,6 mmol/L: metoda A.\n');
  writeFileSync(draft, '# Karta protokołów GlucoMind (WERSJA ROBOCZA)\n');

  it('is off by default even when a path is set', () => {
    const log = logger();
    expect(loadProtocolCard({ AI_KNOWLEDGE_PROTOCOL_CARD_PATH: approved }, log)).toBeNull();
    expect(log.lines).toEqual([]);
  });

  it('loads an approved card when enabled and refuses the draft, a missing path or an unreadable file', () => {
    const log = logger();
    expect(loadProtocolCard({ AI_ENABLE_KNOWLEDGE_PROTOCOL_CARD: '1', AI_KNOWLEDGE_PROTOCOL_CARD_PATH: approved }, log)).toContain('metoda A');
    expect(loadProtocolCard({ AI_ENABLE_KNOWLEDGE_PROTOCOL_CARD: '1', AI_KNOWLEDGE_PROTOCOL_CARD_PATH: draft }, log)).toBeNull();
    expect(loadProtocolCard({ AI_ENABLE_KNOWLEDGE_PROTOCOL_CARD: '1' }, log)).toBeNull();
    expect(loadProtocolCard({ AI_ENABLE_KNOWLEDGE_PROTOCOL_CARD: '1', AI_KNOWLEDGE_PROTOCOL_CARD_PATH: join(dir, 'missing.md') }, log)).toBeNull();
    expect(log.lines.map((line) => JSON.parse(line).reason ?? JSON.parse(line).event)).toEqual([
      'knowledge_protocol_card_loaded', 'DRAFT_NOT_APPROVED', 'PATH_NOT_SET', 'UNREADABLE',
    ]);
  });
});
