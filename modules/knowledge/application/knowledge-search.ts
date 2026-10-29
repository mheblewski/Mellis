/**
 * Knowledge search for the assistant's `search_knowledge` tool: hybrid retrieval over the guideline/manual corpus in
 * Postgres (rag_chunks, migration 036) with the configuration that scored best offline (2026-10-16):
 *   1. the light model writes one English search query for the (usually Polish) question (cached in memory);
 *   2. the question and the English query are embedded in one call (cached), with the active corpus's embedding model;
 *   3. cosine candidates for both vectors and full-text candidates for the English query plus PL↔EN glossary terms,
 *      16 per list, fused by reciprocal rank (PostgresRagChunkStore.search);
 *   4. the light model picks the 6 most useful of the 16 fused candidates (rerank; cached).
 * Without an embeddings client (a server with no OpenAI key) step 2 is skipped and the candidates are full text only
 * (BM25 mode): no embeddings call, no error. The light model is then the answer provider's (Claude). The same happens
 * when the active corpus has no vectors (the shipped knowledge base built without an OpenAI key): no query embeddings.
 * Every paid call goes through the guarded clients (cost guard + the worker's budget ledger) built by the factory.
 * Fails open: a failed rewrite searches with the question only, failed embeddings search full-text only, a failed rerank
 * keeps the fused order; when nothing can be searched (no corpus, timeout, database error) the outcome is UNAVAILABLE
 * and the assistant answers without sources and says so. Never throws.
 */
import { createHash } from 'node:crypto';
import type { PatientAge } from '@shared/primitives/patient-age';
import type { OpenAiEmbeddingsTransport, OpenAiResponsesTransport } from '@modules/ai-gateway/infrastructure/guarded-openai-client';
import type { AIPricingConfig } from '@modules/ai-gateway/domain/ai-gateway';
import { calculateProviderUsageCost, normalizeAIUsage } from '@modules/ai-gateway/application/ai-observability';
import type { RagSearchHit, RagSearchQuery } from '@infra/db/postgres-rag-chunks.repository';
import {
  QUERY_GLOSSARY_VERSION,
  RERANK_PROMPT_VERSION,
  REWRITE_PROMPT_VERSION,
  applyRerank,
  buildRerankRequest,
  buildRewriteRequest,
  glossaryExpansion,
  parseRerank,
  parseRewrite,
  responseOutputText,
} from './knowledge-query';

export const KNOWLEDGE_SEARCH_VERSION = 'knowledge-search.v1';

/** Fused candidates the rerank chooses from, and fragments returned (best configuration of the 2026-10-16 tuning). */
export const KNOWLEDGE_SEARCH_CANDIDATES = 16;
export const KNOWLEDGE_SEARCH_TOP_K = 6;
/** Whole search incl. the two light-model calls; on expiry the outcome is UNAVAILABLE (TIMEOUT). */
export const DEFAULT_KNOWLEDGE_SEARCH_TIMEOUT_MS = 25_000;
const MAX_QUERY_CHARS = 500;
const CACHE_ENTRIES = 256;
const ACTIVE_VERSION_TTL_MS = 5 * 60_000;

export interface KnowledgeFragment {
  chunk_id: string;
  source_file: string;
  title: string;
  section: string | null;
  page: number | null;
  page_end: number | null;
  /** 'table' for a chunk cut out of a table (its caption is the section). */
  kind: 'table' | null;
  text: string;
  /** Link to the original (shipped knowledge base); null for chunks of a corpus without source links. */
  url?: string | null;
  publisher?: string | null;
  /** SHIP_TEXT: original text; SUMMARY_ONLY: our summary of a guideline the reader opens through url. */
  source_mode?: 'SHIP_TEXT' | 'SUMMARY_ONLY' | null;
}

export type KnowledgeSearchStatus = 'FOUND' | 'NO_RESULTS' | 'UNAVAILABLE';
export type KnowledgeSearchUnavailableReason = 'TIMEOUT' | 'NO_CORPUS' | 'SEARCH_FAILED' | 'CANCELLED';
export type KnowledgeHelperStatus = 'OK' | 'CACHED' | 'FAILED' | 'UNUSABLE' | 'SKIPPED';

export interface KnowledgeSearchCost {
  amount: number;
  currency: string;
}

export interface KnowledgeSearchDiagnostics {
  search_version: string;
  rewrite_prompt_version: string;
  rerank_prompt_version: string;
  query_glossary_version: string;
  english_query: string | null;
  rewrite_status: KnowledgeHelperStatus;
  embedding_status: KnowledgeHelperStatus;
  rerank_status: KnowledgeHelperStatus;
  expansion_terms: string[];
  candidate_count: number;
  latency_ms: number;
  /** Paid calls this search attempted (cache hits send nothing; a call refused by the cost guard is counted too). */
  paid_calls: number;
  /** Local estimate of those calls from the configured prices; null when a price is unknown. */
  estimated_cost: KnowledgeSearchCost | null;
}

export interface KnowledgeSearchOutcome {
  status: KnowledgeSearchStatus;
  unavailable_reason: KnowledgeSearchUnavailableReason | null;
  corpus_version: string | null;
  fragments: KnowledgeFragment[];
  diagnostics: KnowledgeSearchDiagnostics;
}

export interface KnowledgeSearch {
  search(input: { query: string; patient_age?: PatientAge | null; loop_system?: string | null; abort_signal?: AbortSignal }): Promise<KnowledgeSearchOutcome>;
}

/** The read side of PostgresRagChunkStore. */
export interface KnowledgeChunkStore {
  /** embeddingModel null: the corpus has no vectors and is searched by full text only. */
  activeVersion(): Promise<{ version: string; embeddingModel: string | null; chunkCount: number } | null>;
  search(query: RagSearchQuery): Promise<RagSearchHit[]>;
}

/** Prices for the local cost estimate of a search (per 1K tokens, one currency). */
export interface KnowledgeSearchPricing {
  currency: string;
  /** The light model's prices as its guarded client has them (resolveOpenAiPricingFromEnv): cache writes and flex included. */
  light: AIPricingConfig;
  embedding_input_per_1k_tokens: number;
}

export interface KnowledgeSearchDependencies {
  store: KnowledgeChunkStore;
  /** Guarded clients: every request is cost-guarded and reserved in the budget ledger. */
  lightClient: OpenAiResponsesTransport;
  /** null: full-text (BM25) candidates only, no embeddings call (no OpenAI key). */
  embeddingsClient: OpenAiEmbeddingsTransport | null;
  lightModel: string;
  /** Provider label of the light model's cost estimate; default openai. */
  lightProvider?: string;
  timeoutMs?: number;
  pricing?: KnowledgeSearchPricing | null;
  now?: () => number;
  logger?: { warn: (message: string) => void };
}

class LruCache<V> {
  private readonly entries = new Map<string, V>();
  constructor(private readonly capacity: number) {}

  get(key: string): V | undefined {
    const value = this.entries.get(key);
    if (value !== undefined) {
      this.entries.delete(key);
      this.entries.set(key, value);
    }
    return value;
  }

  set(key: string, value: V): void {
    this.entries.delete(key);
    this.entries.set(key, value);
    if (this.entries.size > this.capacity) this.entries.delete(this.entries.keys().next().value as string);
  }
}

function cacheKey(...parts: string[]): string {
  return createHash('sha256').update(parts.join('\n')).digest('hex');
}

/** The question as searched: whitespace collapsed, at most 500 characters. */
export function normalizeKnowledgeQuery(query: string): string {
  return query.replace(/\s+/g, ' ').trim().slice(0, MAX_QUERY_CHARS);
}

class SearchAborted extends Error {
  constructor(readonly reason: 'TIMEOUT' | 'CANCELLED') {
    super(reason);
  }
}

/** Rejects as soon as the signal fires (the database query itself cannot be cancelled and finishes in the background). */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal, reason: () => 'TIMEOUT' | 'CANCELLED'): Promise<T> {
  if (signal.aborted) return Promise.reject(new SearchAborted(reason()));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new SearchAborted(reason()));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

/** A dropped connection (the SDK's APIConnectionError, not its timeout subclass): the request may never have arrived. */
export function isConnectionError(error: unknown): boolean {
  for (let proto = error ? Object.getPrototypeOf(error) : null; proto; proto = Object.getPrototypeOf(proto)) {
    const name = (proto as { constructor?: { name?: string } }).constructor?.name;
    if (name === 'APIConnectionTimeoutError') return false;
    if (name === 'APIConnectionError') return true;
  }
  return false;
}

/**
 * One retry after a dropped connection (live check 2026-10-16: 2 of 12 reranks lost to "Connection error."). The retry
 * is a new guarded call with its own reservation; the failed one stays charged at its worst case.
 */
async function withConnectionRetry<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (!isConnectionError(error)) throw error;
    return call();
  }
}

function usageNumber(response: Record<string, unknown>, ...path: string[]): number {
  let value: unknown = response.usage;
  for (const key of path) value = value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export class KnowledgeSearchService implements KnowledgeSearch {
  private readonly rewrites = new LruCache<string | null>(CACHE_ENTRIES);
  private readonly vectors = new LruCache<number[]>(CACHE_ENTRIES);
  private readonly reranks = new LruCache<number[] | null>(CACHE_ENTRIES);
  private active: { value: Awaited<ReturnType<KnowledgeChunkStore['activeVersion']>>; fetchedAt: number } | null = null;
  private readonly timeoutMs: number;
  private readonly now: () => number;

  constructor(private readonly deps: KnowledgeSearchDependencies) {
    this.timeoutMs = deps.timeoutMs && deps.timeoutMs > 0 ? deps.timeoutMs : DEFAULT_KNOWLEDGE_SEARCH_TIMEOUT_MS;
    this.now = deps.now ?? Date.now;
  }

  async search(input: { query: string; patient_age?: PatientAge | null; loop_system?: string | null; abort_signal?: AbortSignal }): Promise<KnowledgeSearchOutcome> {
    const startedAt = this.now();
    const query = normalizeKnowledgeQuery(input.query);
    const usage = { lightCost: 0, embeddingTokens: 0, paidCalls: 0 };
    const diagnostics: Omit<KnowledgeSearchDiagnostics, 'latency_ms' | 'paid_calls' | 'estimated_cost'> = {
      search_version: KNOWLEDGE_SEARCH_VERSION,
      rewrite_prompt_version: REWRITE_PROMPT_VERSION,
      rerank_prompt_version: RERANK_PROMPT_VERSION,
      query_glossary_version: QUERY_GLOSSARY_VERSION,
      english_query: null,
      rewrite_status: 'SKIPPED',
      embedding_status: 'SKIPPED',
      rerank_status: 'SKIPPED',
      expansion_terms: [],
      candidate_count: 0,
    };
    const finish = (outcome: Pick<KnowledgeSearchOutcome, 'status' | 'unavailable_reason' | 'corpus_version' | 'fragments'>): KnowledgeSearchOutcome => ({
      ...outcome,
      diagnostics: { ...diagnostics, latency_ms: this.now() - startedAt, paid_calls: usage.paidCalls, estimated_cost: this.estimateCost(usage) },
    });
    if (!query) return finish({ status: 'NO_RESULTS', unavailable_reason: null, corpus_version: null, fragments: [] });

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    const onParentAbort = () => controller.abort();
    input.abort_signal?.addEventListener('abort', onParentAbort, { once: true });
    if (input.abort_signal?.aborted) controller.abort();
    const signal = controller.signal;
    const abortReason = () => (timedOut ? 'TIMEOUT' as const : 'CANCELLED' as const);
    const guard = <T>(promise: Promise<T>) => untilAborted(promise, signal, abortReason);
    const remainingMs = () => Math.max(1, this.timeoutMs - (this.now() - startedAt));

    let corpusVersion: string | null = null;
    try {
      const active = await guard(this.activeCorpus());
      if (!active) return finish({ status: 'UNAVAILABLE', unavailable_reason: 'NO_CORPUS', corpus_version: null, fragments: [] });
      corpusVersion = active.version;

      // 1. English search query (light model).
      let english: string | null = null;
      // The age and the loop go into the prompt, so a cached query or pick is reused only for the same age and loop.
      const ageKey = `${input.patient_age ? `${input.patient_age.age_group}:${input.patient_age.age_years}` : 'unknown'}|${input.loop_system ?? 'unknown'}`;
      const rewriteKey = cacheKey(this.deps.lightModel, REWRITE_PROMPT_VERSION, ageKey, query);
      const cachedRewrite = this.rewrites.get(rewriteKey);
      if (cachedRewrite !== undefined) {
        english = cachedRewrite;
        diagnostics.rewrite_status = 'CACHED';
      } else {
        try {
          usage.paidCalls += 1;
          const response = await guard(withConnectionRetry(() => this.deps.lightClient.responses.create(buildRewriteRequest(this.deps.lightModel, query, input.patient_age ?? null, input.loop_system ?? null), { signal, timeout: remainingMs() })));
          this.addLightUsage(usage, response);
          english = parseRewrite(responseOutputText(response));
          this.rewrites.set(rewriteKey, english);
          diagnostics.rewrite_status = english ? 'OK' : 'UNUSABLE';
        } catch (error) {
          if (error instanceof SearchAborted) throw error;
          diagnostics.rewrite_status = 'FAILED';
          this.warn('knowledge_search_rewrite_failed', error);
        }
      }
      diagnostics.english_query = english;

      // 2. Query vectors (one embeddings call for the texts not cached yet); skipped in BM25 mode.
      // A corpus without vectors (built with no OpenAI key) is searched by full text even when a key exists now.
      const embeddingModel = active.embeddingModel;
      const embeddingsClient = embeddingModel ? this.deps.embeddingsClient : null;
      const texts = embeddingsClient ? [query, ...(english && english !== query ? [english] : [])] : [];
      const vectorKey = (text: string) => cacheKey(embeddingModel ?? '', text);
      const missing = texts.filter((text) => !this.vectors.get(vectorKey(text)));
      diagnostics.embedding_status = !embeddingsClient ? 'SKIPPED' : missing.length ? 'OK' : 'CACHED';
      if (embeddingsClient && missing.length) {
        try {
          usage.paidCalls += 1;
          const response = await guard(withConnectionRetry(() => embeddingsClient.embeddings.create(
            { model: embeddingModel as string, input: missing, encoding_format: 'float' },
            { signal, timeout: remainingMs() },
          )));
          usage.embeddingTokens += usageNumber(response, 'prompt_tokens');
          parseEmbeddings(response, missing.length).forEach((vector, position) => this.vectors.set(vectorKey(missing[position]), vector));
        } catch (error) {
          if (error instanceof SearchAborted) throw error;
          diagnostics.embedding_status = 'FAILED';
          this.warn('knowledge_search_embedding_failed', error);
        }
      }
      const vectors = texts
        .map((text, position) => ({ name: position === 0 ? 'pl' : 'en', embedding: this.vectors.get(vectorKey(text)) }))
        .filter((entry): entry is { name: string; embedding: number[] } => Array.isArray(entry.embedding));

      // 3. Hybrid candidates fused by reciprocal rank.
      diagnostics.expansion_terms = glossaryExpansion([query, english ?? '']);
      // BM25 mode without a usable English query: the question itself, so the search still has words to match.
      const keywordQuery = english ?? (embeddingsClient ? '' : query);
      const keywordText = [keywordQuery, ...diagnostics.expansion_terms].join(' ').trim();
      if (!vectors.length && !keywordText) {
        return finish({ status: 'UNAVAILABLE', unavailable_reason: 'SEARCH_FAILED', corpus_version: corpusVersion, fragments: [] });
      }
      const candidates = await guard(this.deps.store.search({
        vectors,
        keywords: keywordText ? { name: 'bm25', text: keywordText } : null,
        candidates: KNOWLEDGE_SEARCH_CANDIDATES,
        k: KNOWLEDGE_SEARCH_CANDIDATES,
      }));
      diagnostics.candidate_count = candidates.length;
      if (!candidates.length) return finish({ status: 'NO_RESULTS', unavailable_reason: null, corpus_version: corpusVersion, fragments: [] });

      // 4. Light-model rerank to the top 6 (only when there is something to choose).
      let picked: number[] | null = null;
      if (candidates.length > KNOWLEDGE_SEARCH_TOP_K) {
        const rerankKey = cacheKey(this.deps.lightModel, RERANK_PROMPT_VERSION, String(KNOWLEDGE_SEARCH_TOP_K), ageKey, query, ...candidates.map((hit) => hit.chunk.id));
        const cachedPick = this.reranks.get(rerankKey);
        if (cachedPick !== undefined) {
          picked = cachedPick;
          diagnostics.rerank_status = 'CACHED';
        } else {
          try {
            usage.paidCalls += 1;
            const response = await guard(withConnectionRetry(() => this.deps.lightClient.responses.create(
              buildRerankRequest(this.deps.lightModel, query, candidates, KNOWLEDGE_SEARCH_TOP_K, input.patient_age ?? null, input.loop_system ?? null),
              { signal, timeout: remainingMs() },
            )));
            this.addLightUsage(usage, response);
            picked = parseRerank(responseOutputText(response), candidates.length, KNOWLEDGE_SEARCH_TOP_K);
            this.reranks.set(rerankKey, picked);
            diagnostics.rerank_status = picked ? 'OK' : 'UNUSABLE';
          } catch (error) {
            if (error instanceof SearchAborted) throw error;
            diagnostics.rerank_status = 'FAILED';
            this.warn('knowledge_search_rerank_failed', error);
          }
        }
      }
      const top = applyRerank(candidates, picked, KNOWLEDGE_SEARCH_TOP_K);
      return finish({
        status: 'FOUND',
        unavailable_reason: null,
        corpus_version: corpusVersion,
        fragments: top.map(({ chunk }) => ({
          chunk_id: chunk.id,
          source_file: chunk.source_file,
          title: chunk.title,
          section: chunk.section,
          page: chunk.page,
          page_end: chunk.page_end,
          kind: chunk.kind === 'table' ? 'table' : null,
          text: chunk.text,
          ...(chunk.url !== undefined ? { url: chunk.url ?? null, publisher: chunk.publisher ?? null, source_mode: chunk.source_mode ?? null } : {}),
        })),
      });
    } catch (error) {
      if (error instanceof SearchAborted) {
        return finish({ status: 'UNAVAILABLE', unavailable_reason: error.reason, corpus_version: corpusVersion, fragments: [] });
      }
      this.warn('knowledge_search_failed', error);
      return finish({ status: 'UNAVAILABLE', unavailable_reason: 'SEARCH_FAILED', corpus_version: corpusVersion, fragments: [] });
    } finally {
      clearTimeout(timer);
      input.abort_signal?.removeEventListener('abort', onParentAbort);
    }
  }

  private async activeCorpus(): Promise<{ version: string; embeddingModel: string | null; chunkCount: number } | null> {
    if (this.active && this.now() - this.active.fetchedAt < ACTIVE_VERSION_TTL_MS) return this.active.value;
    const value = await this.deps.store.activeVersion();
    this.active = { value, fetchedAt: this.now() };
    return value;
  }

  /** One light call's cost, computed like the guarded client settles it (cache writes, the tier that served). */
  private addLightUsage(usage: { lightCost: number }, response: Record<string, unknown>): void {
    const pricing = this.deps.pricing;
    if (!pricing) return;
    const cost = calculateProviderUsageCost({
      provider: this.deps.lightProvider ?? 'openai',
      model: this.deps.lightModel,
      usage: normalizeAIUsage(response.usage ?? null, response.service_tier),
      pricing: pricing.light,
    });
    // A response without usage adds nothing (as before): the guarded client keeps its reservation for it.
    if (cost.status === 'KNOWN') usage.lightCost += cost.amount;
  }

  private estimateCost(usage: { lightCost: number; embeddingTokens: number }): KnowledgeSearchCost | null {
    const pricing = this.deps.pricing;
    if (!pricing) return null;
    const amount = usage.lightCost + (usage.embeddingTokens * pricing.embedding_input_per_1k_tokens) / 1000;
    return { amount: Math.round(amount * 1e6) / 1e6, currency: pricing.currency };
  }

  private warn(event: string, error: unknown): void {
    // Error class and code only: messages may echo request content.
    const details = error as { name?: unknown; code?: unknown; status?: unknown } | null;
    this.deps.logger?.warn(JSON.stringify({
      event,
      error_name: typeof details?.name === 'string' ? details.name : null,
      code: typeof details?.code === 'string' ? details.code : null,
      status: typeof details?.status === 'number' ? details.status : null,
    }));
  }
}

function parseEmbeddings(response: Record<string, unknown>, expected: number): number[][] {
  const data = Array.isArray(response.data) ? (response.data as Array<Record<string, unknown>>) : [];
  if (data.length !== expected) throw new Error(`Embeddings response has ${data.length} vectors, expected ${expected}.`);
  const vectors: number[][] = new Array(expected);
  data.forEach((item, position) => {
    const index = typeof item.index === 'number' ? item.index : position;
    if (!Array.isArray(item.embedding) || !item.embedding.every((value) => typeof value === 'number')) throw new Error('Embeddings response has a non-numeric vector.');
    vectors[index] = item.embedding as number[];
  });
  if (vectors.some((vector) => !vector)) throw new Error('Embeddings response is missing a vector.');
  return vectors;
}
