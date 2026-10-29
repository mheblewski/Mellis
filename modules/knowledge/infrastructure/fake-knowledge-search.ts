/**
 * Offline stand-ins for the knowledge search's dependencies (tests only): an in-memory chunk store that returns its
 * chunks in a fixed order and records every query, a light-model client that answers rewrite and rerank requests with
 * scripted replies, and an embeddings client that returns small deterministic vectors. Nothing leaves the process.
 */
import type { OpenAiEmbeddingsTransport, OpenAiResponsesTransport } from '@modules/ai-gateway/infrastructure/guarded-openai-client';
import type { RagSearchHit, RagSearchQuery, StoredRagChunk } from '@infra/db/postgres-rag-chunks.repository';
import type { KnowledgeChunkStore } from '../application/knowledge-search';

export const FAKE_CORPUS_VERSION = 'fake-corpus.v1';

export function fakeKnowledgeChunk(id: string, overrides: Partial<StoredRagChunk> = {}): StoredRagChunk {
  return {
    id,
    corpus_version: FAKE_CORPUS_VERSION,
    source_file: `${id.split('#')[0]}.txt`,
    title: `Source ${id}`,
    section: null,
    page: null,
    page_end: null,
    text: `Text of ${id}.`,
    ...overrides,
  };
}

export class FakeKnowledgeChunkStore implements KnowledgeChunkStore {
  readonly queries: RagSearchQuery[] = [];
  activeVersionCalls = 0;
  failSearch: Error | null = null;
  /** Resolves the search only after this promise (to test timeouts). */
  delay: Promise<void> | null = null;

  constructor(private readonly chunks: StoredRagChunk[], private readonly active: { version: string; embeddingModel: string | null; chunkCount: number } | null = {
    version: FAKE_CORPUS_VERSION,
    embeddingModel: 'fake-embedding-model',
    chunkCount: chunks.length,
  }) {}

  async activeVersion() {
    this.activeVersionCalls += 1;
    return this.active;
  }

  async search(query: RagSearchQuery): Promise<RagSearchHit[]> {
    this.queries.push(query);
    if (this.delay) await this.delay;
    if (this.failSearch) throw this.failSearch;
    return this.chunks.slice(0, query.k).map((chunk, position) => ({
      rank: position + 1,
      score: 1 / (61 + position),
      chunk,
      ranks: { pl: position + 1 },
      cosine: 0.5,
    }));
  }
}

type ResponsesReply = string | Error;

/** Light model: requests whose instructions mention "search query" are rewrites, the others reranks. */
export class FakeLightModelClient implements OpenAiResponsesTransport {
  readonly requests: Array<Record<string, unknown>> = [];

  constructor(private readonly replies: { rewrite?: ResponsesReply; rerank?: ResponsesReply } = {}) {}

  readonly responses = {
    create: async (body: Record<string, unknown>) => {
      this.requests.push(body);
      const isRewrite = String(body.instructions ?? '').includes('English search query');
      const reply = isRewrite ? this.replies.rewrite ?? 'sick day ketones extra insulin' : this.replies.rerank ?? '2, 1';
      if (reply instanceof Error) throw reply;
      return { id: `fake-light-${this.requests.length}`, output_text: reply, usage: { input_tokens: 1000, output_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
    },
  };

  get rewriteCount(): number {
    return this.requests.filter((body) => String(body.instructions ?? '').includes('English search query')).length;
  }

  get rerankCount(): number {
    return this.requests.length - this.rewriteCount;
  }
}

export class FakeEmbeddingsClient implements OpenAiEmbeddingsTransport {
  readonly requests: Array<Record<string, unknown>> = [];
  fail: Error | null = null;

  readonly embeddings = {
    create: async (body: Record<string, unknown>) => {
      this.requests.push(body);
      if (this.fail) throw this.fail;
      const inputs = (Array.isArray(body.input) ? body.input : [body.input]) as string[];
      return {
        data: inputs.map((text, index) => ({ index, embedding: [text.length % 7, index + 1, 0.5] })),
        usage: { prompt_tokens: inputs.reduce((sum, text) => sum + Math.ceil(text.length / 4), 0) },
      };
    },
  };
}
