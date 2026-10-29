import { describe, expect, it } from 'vitest';
import {
  FakeEmbeddingsClient,
  FakeKnowledgeChunkStore,
  FakeLightModelClient,
  fakeKnowledgeChunk,
} from '../infrastructure/fake-knowledge-search';
import { KNOWLEDGE_SEARCH_CANDIDATES, KnowledgeSearchService, isConnectionError, normalizeKnowledgeQuery, type KnowledgeSearchPricing } from './knowledge-search';

const CHUNKS = Array.from({ length: 10 }, (_unused, index) => fakeKnowledgeChunk(`doc#${index + 1}`, { title: `Guideline ${index + 1}`, section: `Section ${index + 1}`, page: index + 1 }));
const PRICING: KnowledgeSearchPricing = {
  currency: 'USD',
  light: { input_per_1k_tokens: 0.0002, cached_input_per_1k_tokens: 0.00002, output_per_1k_tokens: 0.0012, reasoning_per_1k_tokens: 0, currency: 'USD', pricing_version: 'light-test' },
  embedding_input_per_1k_tokens: 0.00002,
};

function setup(options: { chunks?: typeof CHUNKS; rewrite?: string | Error; rerank?: string | Error; timeoutMs?: number; active?: null; noEmbeddings?: boolean } = {}) {
  const store = new FakeKnowledgeChunkStore(options.chunks ?? CHUNKS, options.active === null ? null : undefined);
  const light = new FakeLightModelClient({ rewrite: options.rewrite, rerank: options.rerank });
  const embeddings = new FakeEmbeddingsClient();
  const warnings: string[] = [];
  const search = new KnowledgeSearchService({
    store,
    lightClient: light,
    embeddingsClient: options.noEmbeddings ? null : embeddings,
    lightModel: 'light-x',
    timeoutMs: options.timeoutMs,
    pricing: PRICING,
    logger: { warn: (message) => warnings.push(message) },
  });
  return { store, light, embeddings, search, warnings };
}

describe('KnowledgeSearchService', () => {
  it('rewrites to English, embeds both queries in one call, fuses 16 candidates with glossary terms and reranks to 6', async () => {
    const { store, light, embeddings, search } = setup({ rerank: '3, 1, 9' });
    const outcome = await search.search({ query: '  Ile insuliny przy ketonach 1,2 w czasie choroby?  ' });

    expect(outcome.status).toBe('FOUND');
    expect(outcome.corpus_version).toBe('fake-corpus.v1');
    expect(light.rewriteCount).toBe(1);
    expect(light.requests[0]).toMatchObject({ model: 'light-x', input: 'Ile insuliny przy ketonach 1,2 w czasie choroby?' });
    expect(embeddings.requests).toEqual([{ model: 'fake-embedding-model', input: ['Ile insuliny przy ketonach 1,2 w czasie choroby?', 'sick day ketones extra insulin'], encoding_format: 'float' }]);
    expect(store.queries).toHaveLength(1);
    const [query] = store.queries;
    expect(query.vectors.map((vector) => vector.name)).toEqual(['pl', 'en']);
    expect(query).toMatchObject({ candidates: KNOWLEDGE_SEARCH_CANDIDATES, k: KNOWLEDGE_SEARCH_CANDIDATES });
    // English query plus the glossary terms of "ketonach" for the full-text list.
    expect(query.keywords?.text).toContain('sick day ketones extra insulin');
    expect(query.keywords?.text).toContain('beta-hydroxybutyrate');
    expect(outcome.diagnostics.expansion_terms).toContain('BOHB');

    // Picked candidates first, then the fused order fills up to 6.
    expect(outcome.fragments.map((fragment) => fragment.chunk_id)).toEqual(['doc#3', 'doc#1', 'doc#9', 'doc#2', 'doc#4', 'doc#5']);
    expect(outcome.fragments[0]).toMatchObject({ title: 'Guideline 3', section: 'Section 3', page: 3, text: 'Text of doc#3.' });
    expect(outcome.diagnostics).toMatchObject({ english_query: 'sick day ketones extra insulin', rewrite_status: 'OK', embedding_status: 'OK', rerank_status: 'OK', candidate_count: 10, paid_calls: 3 });
    expect(outcome.diagnostics.estimated_cost?.currency).toBe('USD');
    expect(outcome.diagnostics.estimated_cost?.amount).toBeGreaterThan(0);
  });

  it('prices the light calls like the guarded client: cache writes at their price and flex at its factor', async () => {
    const fake = new FakeLightModelClient({ rerank: '3, 1, 9' });
    // 1000 input tokens: 200 cached, 400 written to the cache; served by the flex tier at half price.
    const light = { responses: { create: async (body: Record<string, unknown>) => ({
      ...(await fake.responses.create(body)),
      service_tier: 'flex',
      usage: { input_tokens: 1000, output_tokens: 10, input_tokens_details: { cached_tokens: 200, cache_write_tokens: 400 }, output_tokens_details: { reasoning_tokens: 0 } },
    }) } };
    const embeddings = new FakeEmbeddingsClient();
    const search = new KnowledgeSearchService({
      store: new FakeKnowledgeChunkStore(CHUNKS), lightClient: light, embeddingsClient: embeddings, lightModel: 'light-x',
      pricing: { ...PRICING, light: { ...PRICING.light, cache_write_per_1k_tokens: 0.0005, flex_price_multiplier: 0.5 } },
    });
    const outcome = await search.search({ query: 'Ile insuliny przy ketonach?' });

    // Per light call: (400 × 0.0002 + 200 × 0.00002 + 400 × 0.0005 + 10 × 0.0012) / 1000 × 0.5.
    const perLightCall = ((400 * 0.0002 + 200 * 0.00002 + 400 * 0.0005 + 10 * 0.0012) / 1000) * 0.5;
    const embedding = (Math.ceil('Ile insuliny przy ketonach?'.length / 4) + Math.ceil('sick day ketones extra insulin'.length / 4)) * 0.00002 / 1000;
    expect(outcome.diagnostics.paid_calls).toBe(3);
    expect(outcome.diagnostics.estimated_cost?.amount).toBeCloseTo(2 * perLightCall + embedding, 6);
  });

  it('answers the same question again from its caches without any paid call', async () => {
    const { light, embeddings, store, search } = setup();
    await search.search({ query: 'Jak działa WBT?' });
    const second = await search.search({ query: 'Jak  działa WBT?' });

    expect(light.requests).toHaveLength(2);
    expect(embeddings.requests).toHaveLength(1);
    expect(store.queries).toHaveLength(2);
    expect(store.activeVersionCalls).toBe(1);
    expect(second.diagnostics).toMatchObject({ rewrite_status: 'CACHED', embedding_status: 'CACHED', rerank_status: 'CACHED', paid_calls: 0, estimated_cost: { amount: 0, currency: 'USD' } });
  });

  it('searches with the question only when the rewrite fails, and keeps the fused order when the rerank fails', async () => {
    const { store, search, warnings } = setup({ rewrite: new Error('boom'), rerank: new Error('boom') });
    const outcome = await search.search({ query: 'Ucisk sensora w nocy' });

    expect(outcome.status).toBe('FOUND');
    expect(store.queries[0].vectors.map((vector) => vector.name)).toEqual(['pl']);
    expect(outcome.fragments.map((fragment) => fragment.chunk_id)).toEqual(['doc#1', 'doc#2', 'doc#3', 'doc#4', 'doc#5', 'doc#6']);
    expect(outcome.diagnostics).toMatchObject({ rewrite_status: 'FAILED', rerank_status: 'FAILED' });
    expect(warnings.map((line) => JSON.parse(line).event)).toEqual(['knowledge_search_rewrite_failed', 'knowledge_search_rerank_failed']);
    // Logs carry the error class only, never request content.
    expect(warnings.join('\n')).not.toContain('Ucisk');
  });

  it('falls back to the full-text list when the embeddings fail', async () => {
    const { store, embeddings, search } = setup();
    embeddings.fail = new Error('down');
    const outcome = await search.search({ query: 'ketony w chorobie' });

    expect(outcome.status).toBe('FOUND');
    expect(store.queries[0].vectors).toEqual([]);
    expect(store.queries[0].keywords?.name).toBe('bm25');
    expect(outcome.diagnostics.embedding_status).toBe('FAILED');
  });

  it('BM25 mode (no OpenAI key): no embeddings call, full-text candidates, rewrite and rerank as usual', async () => {
    const { store, light, embeddings, search, warnings } = setup({ noEmbeddings: true, rerank: '2, 1' });
    const outcome = await search.search({ query: 'Ile insuliny przy ketonach 1,2 w czasie choroby?' });

    expect(outcome.status).toBe('FOUND');
    expect(embeddings.requests).toEqual([]);
    expect(store.queries[0].vectors).toEqual([]);
    expect(store.queries[0].keywords?.name).toBe('bm25');
    expect(store.queries[0].keywords?.text).toContain('sick day ketones extra insulin');
    expect(light.rewriteCount).toBe(1);
    expect(outcome.fragments.map((fragment) => fragment.chunk_id).slice(0, 2)).toEqual(['doc#2', 'doc#1']);
    expect(outcome.diagnostics).toMatchObject({ embedding_status: 'SKIPPED', rewrite_status: 'OK', rerank_status: 'OK', paid_calls: 2 });
    expect(warnings).toEqual([]);

    // The same question again: cached, no paid call and still no embeddings.
    const again = await search.search({ query: 'Ile insuliny przy ketonach 1,2 w czasie choroby?' });
    expect(again.diagnostics).toMatchObject({ embedding_status: 'SKIPPED', paid_calls: 0 });
    expect(embeddings.requests).toEqual([]);
  });

  it('BM25 mode searches the question itself when the rewrite fails', async () => {
    const { store, search } = setup({ noEmbeddings: true, rewrite: new Error('boom') });
    const outcome = await search.search({ query: 'Ucisk sensora w nocy' });

    expect(outcome.status).toBe('FOUND');
    expect(store.queries[0].vectors).toEqual([]);
    expect(store.queries[0].keywords?.text).toContain('Ucisk sensora w nocy');
    expect(outcome.diagnostics).toMatchObject({ rewrite_status: 'FAILED', embedding_status: 'SKIPPED' });
  });

  it('a corpus without vectors (shipped knowledge built with no OpenAI key) is searched by full text even with a key; fragments carry the link', async () => {
    const chunks = CHUNKS.map((chunk, index) => ({ ...chunk, url: `https://doi.org/10.1/${index}`, publisher: 'ISPAD', source_mode: 'SUMMARY_ONLY' as const, licence: '©' }));
    const store = new FakeKnowledgeChunkStore(chunks, { version: 'mellis-knowledge-0123', embeddingModel: null, chunkCount: chunks.length });
    const embeddings = new FakeEmbeddingsClient();
    const search = new KnowledgeSearchService({ store, lightClient: new FakeLightModelClient({ rerank: '1' }), embeddingsClient: embeddings, lightModel: 'light-x' });
    const outcome = await search.search({ query: 'Ketony w czasie choroby' });

    expect(outcome.status).toBe('FOUND');
    expect(embeddings.requests).toEqual([]);
    expect(store.queries[0].vectors).toEqual([]);
    expect(outcome.diagnostics.embedding_status).toBe('SKIPPED');
    expect(outcome.fragments[0]).toMatchObject({ url: 'https://doi.org/10.1/0', publisher: 'ISPAD', source_mode: 'SUMMARY_ONLY' });
  });

  it('skips the rerank when there are no more candidates than fragments', async () => {
    const { light, search } = setup({ chunks: CHUNKS.slice(0, 4) });
    const outcome = await search.search({ query: 'Dexcom G7 rozgrzewka' });

    expect(outcome.fragments).toHaveLength(4);
    expect(light.rerankCount).toBe(0);
    expect(outcome.diagnostics.rerank_status).toBe('SKIPPED');
  });

  it('fails open: no corpus, a database error or a timeout give UNAVAILABLE and never throw', async () => {
    const noCorpus = setup({ active: null });
    await expect(noCorpus.search.search({ query: 'ketony' })).resolves.toMatchObject({ status: 'UNAVAILABLE', unavailable_reason: 'NO_CORPUS', fragments: [] });
    expect(noCorpus.light.requests).toHaveLength(0);

    const failing = setup();
    failing.store.failSearch = new Error('connection refused');
    await expect(failing.search.search({ query: 'ketony' })).resolves.toMatchObject({ status: 'UNAVAILABLE', unavailable_reason: 'SEARCH_FAILED', corpus_version: 'fake-corpus.v1' });

    const slow = setup({ timeoutMs: 20 });
    slow.store.delay = new Promise(() => undefined);
    await expect(slow.search.search({ query: 'ketony' })).resolves.toMatchObject({ status: 'UNAVAILABLE', unavailable_reason: 'TIMEOUT', fragments: [] });
  });

  it('stops when the caller cancels and reports CANCELLED', async () => {
    const { store, search } = setup();
    store.delay = new Promise(() => undefined);
    const controller = new AbortController();
    const pending = search.search({ query: 'ketony', abort_signal: controller.signal });
    setTimeout(() => controller.abort(), 5);
    await expect(pending).resolves.toMatchObject({ status: 'UNAVAILABLE', unavailable_reason: 'CANCELLED' });
  });

  it('returns NO_RESULTS for an empty query or an empty candidate list', async () => {
    const empty = setup();
    await expect(empty.search.search({ query: '   ' })).resolves.toMatchObject({ status: 'NO_RESULTS', fragments: [] });
    expect(empty.store.queries).toHaveLength(0);

    const none = setup({ chunks: [] });
    await expect(none.search.search({ query: 'coś' })).resolves.toMatchObject({ status: 'NO_RESULTS', corpus_version: 'fake-corpus.v1' });
  });

  it('retries a helper call once after a dropped connection, never after other errors', async () => {
    class APIConnectionError extends Error {}
    class APIConnectionTimeoutError extends APIConnectionError {}
    const { light, search } = setup();
    let failures = 1;
    const original = light.responses.create;
    (light.responses as { create: typeof original }).create = async (body) => {
      if (failures-- > 0) throw new APIConnectionError('Connection error.');
      return original(body);
    };
    const outcome = await search.search({ query: 'ketony' });
    expect(outcome.diagnostics.rewrite_status).toBe('OK');
    expect(isConnectionError(new APIConnectionError('x'))).toBe(true);
    expect(isConnectionError(new APIConnectionTimeoutError('x'))).toBe(false);
    expect(isConnectionError(new Error('x'))).toBe(false);
  });

  it('normalizes whitespace and bounds the query length', () => {
    expect(normalizeKnowledgeQuery(' a \n b ')).toBe('a b');
    expect(normalizeKnowledgeQuery('x'.repeat(900))).toHaveLength(500);
  });
});
