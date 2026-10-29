import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OpenAiEmbeddingsTransport } from '@modules/ai-gateway/infrastructure/guarded-openai-client';
import { main as mellisAdmin } from '../../apps/api/src/cli/mellis-admin';
import { RAG_EMBEDDING_DIMENSIONS, type ActiveRagCorpus, type StorableRagChunk } from './postgres-rag-chunks.repository';
import {
  buildKnowledgeChunks,
  KNOWLEDGE_VERSION_PREFIX,
  readShippedKnowledge,
  resolveKnowledgeDir,
  runKnowledgeBuild,
  type KnowledgeBuildStore,
} from './knowledge-build';

const PROSE = 'Ketone levels of 0.6 to 1.4 mmol/L during a sick day call for extra rapid-acting insulin and fluids. '.repeat(4);

function frontMatter(fields: Record<string, string>): string {
  return `---\n${Object.entries(fields).map(([key, value]) => `${key}: ${value}`).join('\n')}\n---\n`;
}

const BASE = { language: 'en', retrieved: '2026-10-16', topics: '[sick-day, ketones]' };

/** A small shipped-knowledge folder: SUMMARY_ONLY, SHIP_TEXT, LINK_ONLY, index: false and one skipped by sources.json. */
function fixtureDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mellis-knowledge-'));
  mkdirSync(join(dir, 'ispad'));
  mkdirSync(join(dir, 'trio'));
  writeFileSync(join(dir, 'ispad', 'sick-day.md'), `${frontMatter({
    id: 'ispad-2022-sick-day', title: '"ISPAD 2022: Sick day management"', publisher: '"ISPAD / Pediatric Diabetes (John Wiley & Sons)"',
    url: 'https://doi.org/10.1111/pedi.13415', licence: '"© 2022 John Wiley & Sons A/S (all rights reserved)"', mode: 'SUMMARY_ONLY', ...BASE, index: 'true',
  })}\n*Our summary, in our own words.*\n\n# Ketones\n\n${PROSE}[Section 3.2]\n`);
  writeFileSync(join(dir, 'trio', 'overrides.md'), `${frontMatter({
    id: 'trio-overrides', title: '"Trio docs: overrides"', publisher: '"Trio documentation (nightscout/trio-docs)"', url: 'https://triodocs.org/overrides/',
    licence: '"AGPL-3.0"', mode: 'SHIP_TEXT', ...BASE, index: 'true', attribution: '"From the Trio documentation, AGPL-3.0."',
  })}\n*From the Trio documentation, AGPL-3.0.*\n\n# Overrides\n\nAn override changes the target and the insulin needs for a while. ${PROSE}\n`);
  writeFileSync(join(dir, 'ispad', 'link-only.md'), `${frontMatter({
    id: 'link-only', title: '"A paywalled book"', url: 'https://example.org/book', licence: '"all rights reserved"', mode: 'LINK_ONLY', ...BASE, index: 'false',
  })}`);
  writeFileSync(join(dir, 'ispad', 'not-indexed.md'), `${frontMatter({
    id: 'not-indexed', title: '"Screening"', url: 'https://example.org/screening', licence: '"CC BY 4.0"', mode: 'SUMMARY_ONLY', ...BASE, index: 'false',
  })}\n${PROSE}\n`);
  writeFileSync(join(dir, 'ispad', 'manifest-skip.md'), `${frontMatter({
    id: 'manifest-skip', title: '"Skipped by sources.json"', url: 'https://example.org/skip', licence: '"CC BY 4.0"', mode: 'SUMMARY_ONLY', ...BASE, index: 'true',
  })}\n${PROSE}\n`);
  writeFileSync(join(dir, 'README.md'), '# not a document\n');
  writeFileSync(join(dir, 'sources.json'), JSON.stringify({ 'ispad/manifest-skip.md': { title: 'Skipped by sources.json', skip: true } }));
  return dir;
}

class MemoryStore implements KnowledgeBuildStore {
  active: ActiveRagCorpus | null = null;
  loads: Array<{ version: string; embeddingModel: string | null; chunks: readonly StorableRagChunk[]; vectors: ReadonlyArray<ArrayLike<number>> | null }> = [];

  async activeVersion() {
    return this.active;
  }

  async replaceCorpusChunks(input: Parameters<KnowledgeBuildStore['replaceCorpusChunks']>[0]) {
    this.loads.push(input);
    const previous = this.active?.version ?? null;
    this.active = { version: input.version, embeddingModel: input.embeddingModel, chunkCount: input.chunks.length, loadedAt: new Date(), indexSha256: input.indexSha256, source: input.source };
    return { version: input.version, inserted: input.chunks.length, removed: 0, previousVersion: previous };
  }
}

/** Stub embedder: a deterministic 1536-dimension vector per text, no network. */
function stubEmbedder(options: { fail?: boolean } = {}) {
  const create = vi.fn(async (body: Record<string, unknown>) => {
    if (options.fail) throw Object.assign(new Error('refused'), { name: 'AiProviderError', code: 'PRE_CALL_BUDGET_GUARD' });
    const inputs = body.input as string[];
    return {
      data: inputs.map((text, index) => {
        const vector = new Array<number>(RAG_EMBEDDING_DIMENSIONS).fill(0);
        vector[text.length % RAG_EMBEDDING_DIMENSIONS] = 1;
        return { index, embedding: vector };
      }),
      usage: { prompt_tokens: 10 },
    };
  });
  return { client: { embeddings: { create } } as unknown as OpenAiEmbeddingsTransport, create };
}

const dirs: string[] = [];
function freshDir(): string {
  const dir = fixtureDir();
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('shipped knowledge loader', () => {
  it('strips the front matter, skips LINK_ONLY / index: false / sources.json skip, keeps the metadata on every chunk', () => {
    const knowledge = readShippedKnowledge(freshDir());
    expect(knowledge.documents.map((document) => document.path).sort()).toEqual(['ispad/link-only.md', 'ispad/manifest-skip.md', 'ispad/not-indexed.md', 'ispad/sick-day.md', 'trio/overrides.md']);
    expect(knowledge.indexed.map((document) => document.path).sort()).toEqual(['ispad/sick-day.md', 'trio/overrides.md']);
    expect(knowledge.skipped.sort()).toEqual(['ispad/link-only.md', 'ispad/manifest-skip.md', 'ispad/not-indexed.md']);

    const chunks = buildKnowledgeChunks(knowledge);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    for (const chunk of chunks) {
      expect(chunk.text).not.toMatch(/^(id|mode|licence|url):/m);
      expect(chunk.text).not.toContain('---');
    }
    const summary = chunks.find((chunk) => chunk.source_file === 'ispad/sick-day.md')!;
    expect(summary).toMatchObject({
      title: 'ISPAD 2022: Sick day management',
      url: 'https://doi.org/10.1111/pedi.13415',
      licence: '© 2022 John Wiley & Sons A/S (all rights reserved)',
      source_mode: 'SUMMARY_ONLY',
      publisher: 'ISPAD / Pediatric Diabetes (John Wiley & Sons)',
      section: 'Ketones',
    });
    expect(chunks.find((chunk) => chunk.source_file === 'trio/overrides.md')).toMatchObject({ source_mode: 'SHIP_TEXT', url: 'https://triodocs.org/overrides/' });
  });

  it('refuses a folder with an invalid document', () => {
    const dir = freshDir();
    writeFileSync(join(dir, 'ispad', 'broken.md'), `${frontMatter({ id: 'broken', title: '"No url"', mode: 'SUMMARY_ONLY' })}\n${PROSE}`);
    expect(() => readShippedKnowledge(dir)).toThrow(/broken\.md: missing url/);
  });

  it('changes the corpus hash when a document changes', () => {
    const dir = freshDir();
    const before = readShippedKnowledge(dir).sha256;
    expect(readShippedKnowledge(dir).sha256).toBe(before);
    writeFileSync(join(dir, 'trio', 'overrides.md'), `${frontMatter({
      id: 'trio-overrides', title: '"Trio docs: overrides"', url: 'https://triodocs.org/overrides/', licence: '"AGPL-3.0"', mode: 'SHIP_TEXT', ...BASE, index: 'true', attribution: '"AGPL"',
    })}\nChanged text. ${PROSE}`);
    expect(readShippedKnowledge(dir).sha256).not.toBe(before);
  });

  it('the real knowledge/ folder loads: no front matter in chunks, every chunk has a link', () => {
    const knowledge = readShippedKnowledge(resolve(__dirname, '../../knowledge'));
    const chunks = buildKnowledgeChunks(knowledge);
    expect(knowledge.skipped.length).toBeGreaterThan(0);
    expect(chunks.length).toBeGreaterThan(500);
    expect(chunks.filter((chunk) => /^(id|licence|mode|corpus_v7): /m.test(chunk.text))).toEqual([]);
    expect(chunks.every((chunk) => /^https?:\/\//.test(chunk.url ?? ''))).toBe(true);
    expect(chunks.some((chunk) => knowledge.skipped.includes(chunk.source_file))).toBe(false);
  });

  it('finds the folder from MELLIS_KNOWLEDGE_DIR or the working directory', () => {
    expect(resolveKnowledgeDir({ MELLIS_KNOWLEDGE_DIR: '/srv/kb' })).toBe('/srv/kb');
    expect(resolveKnowledgeDir({}, '/app')).toBe('/app/knowledge');
  });
});

describe('runKnowledgeBuild', () => {
  it('without an embedder builds a full-text corpus, then does nothing while it is unchanged', async () => {
    const store = new MemoryStore();
    const dir = freshDir();
    const first = await runKnowledgeBuild({ store, dir, embeddings: null });
    expect(first).toMatchObject({ status: 'BUILT', mode: 'bm25', indexed_documents: 2, skipped_documents: 3, embedding_error: null });
    expect(first.corpus_version.startsWith(KNOWLEDGE_VERSION_PREFIX)).toBe(true);
    expect(store.loads[0]).toMatchObject({ embeddingModel: null, vectors: null, source: 'shipped-knowledge' });

    expect(await runKnowledgeBuild({ store, dir, embeddings: null })).toMatchObject({ status: 'UNCHANGED', mode: 'bm25' });
    expect(store.loads).toHaveLength(1);
    expect(await runKnowledgeBuild({ store, dir, embeddings: null, force: true })).toMatchObject({ status: 'BUILT' });
    expect(store.loads).toHaveLength(2);
  });

  it('with a (stub) embedder embeds every chunk; a key added later embeds the same corpus once', async () => {
    const store = new MemoryStore();
    const dir = freshDir();
    await runKnowledgeBuild({ store, dir, embeddings: null });
    const { client, create } = stubEmbedder();
    const built = await runKnowledgeBuild({ store, dir, embeddings: client });
    expect(built).toMatchObject({ status: 'BUILT', mode: 'hybrid' });
    const load = store.loads.at(-1)!;
    expect(load.embeddingModel).toBe('text-embedding-3-small');
    expect(load.vectors).toHaveLength(load.chunks.length);
    expect(create).toHaveBeenCalled();
    expect(create.mock.calls[0][0]).toMatchObject({ model: 'text-embedding-3-small', encoding_format: 'float' });

    const calls = create.mock.calls.length;
    expect(await runKnowledgeBuild({ store, dir, embeddings: client })).toMatchObject({ status: 'UNCHANGED', mode: 'hybrid' });
    // Vectors stay useful when the key is removed later: no rebuild to full text.
    expect(await runKnowledgeBuild({ store, dir, embeddings: null })).toMatchObject({ status: 'UNCHANGED', mode: 'hybrid' });
    expect(create.mock.calls.length).toBe(calls);
  });

  it('a refused embedding falls back to full text; a repeat failure on the same corpus keeps it', async () => {
    const store = new MemoryStore();
    const dir = freshDir();
    const { client } = stubEmbedder({ fail: true });
    const first = await runKnowledgeBuild({ store, dir, embeddings: client });
    expect(first).toMatchObject({ status: 'BUILT', mode: 'bm25', embedding_error: 'AiProviderError: PRE_CALL_BUDGET_GUARD' });
    expect(store.loads.at(-1)!.vectors).toBeNull();
    expect(await runKnowledgeBuild({ store, dir, embeddings: client })).toMatchObject({ status: 'UNCHANGED', mode: 'bm25', embedding_error: 'AiProviderError: PRE_CALL_BUDGET_GUARD' });
    expect(store.loads).toHaveLength(1);
  });

  it('rebuilds when the shipped corpus changed', async () => {
    const store = new MemoryStore();
    const dir = freshDir();
    const first = await runKnowledgeBuild({ store, dir, embeddings: null });
    writeFileSync(join(dir, 'ispad', 'manifest-skip.md'), `${frontMatter({
      id: 'manifest-skip', title: '"Now changed"', url: 'https://example.org/skip', licence: '"CC BY 4.0"', mode: 'SUMMARY_ONLY', ...BASE, index: 'true',
    })}\n${PROSE}\n`);
    const second = await runKnowledgeBuild({ store, dir, embeddings: null });
    expect(second.status).toBe('BUILT');
    expect(second.corpus_version).not.toBe(first.corpus_version);
  });

  it('keeps a corpus it did not build (production\'s own index) unless asked to replace it', async () => {
    const store = new MemoryStore();
    store.active = { version: 'private-corpus-v7', embeddingModel: 'text-embedding-3-small', chunkCount: 1100, loadedAt: new Date(), indexSha256: 'abc', source: 'index-file' };
    const kept = await runKnowledgeBuild({ store, dir: freshDir(), embeddings: stubEmbedder().client });
    expect(kept).toMatchObject({ status: 'FOREIGN_CORPUS_KEPT', kept_version: 'private-corpus-v7', mode: 'hybrid' });
    expect(store.loads).toHaveLength(0);
    expect(await runKnowledgeBuild({ store, dir: freshDir(), embeddings: null, replaceForeign: true })).toMatchObject({ status: 'BUILT' });
  });
});

describe('mellis-admin knowledge-build', () => {
  it('builds full text without OPENAI_API_KEY and prints one JSON line', async () => {
    const store = new MemoryStore();
    const lines: string[] = [];
    const code = await mellisAdmin(['knowledge-build'], { MELLIS_KNOWLEDGE_DIR: freshDir() }, (line) => lines.push(line), undefined, { knowledgeStore: store });
    expect(code).toBe(0);
    expect(JSON.parse(lines[0])).toMatchObject({ ok: true, status: 'BUILT', mode: 'bm25' });
  });

  it('uses the embedder only with an OpenAI key, and never without the cost guard', async () => {
    const dir = freshDir();
    const { client, create } = stubEmbedder();
    const lines: string[] = [];
    await mellisAdmin(['knowledge-build'], { MELLIS_KNOWLEDGE_DIR: dir, OPENAI_API_KEY: 'sk-test' }, (line) => lines.push(line), undefined, { knowledgeStore: new MemoryStore(), embeddings: client });
    expect(JSON.parse(lines[0])).toMatchObject({ ok: true, mode: 'hybrid' });
    expect(create).toHaveBeenCalled();

    // No override: the guarded client from the environment, which refuses without prices / ledger → full text.
    lines.length = 0;
    await mellisAdmin(['knowledge-build'], { MELLIS_KNOWLEDGE_DIR: dir, OPENAI_API_KEY: 'sk-test' }, (line) => lines.push(line), undefined, { knowledgeStore: new MemoryStore() });
    const unguarded = JSON.parse(lines[0]) as Record<string, unknown>;
    expect(unguarded).toMatchObject({ ok: true, mode: 'bm25' });
    expect(String(unguarded.embedding_error)).toContain('cost guard is not configured');

    lines.length = 0;
    await mellisAdmin(['knowledge-build', '--no-embeddings'], { MELLIS_KNOWLEDGE_DIR: dir, OPENAI_API_KEY: 'sk-test' }, (line) => lines.push(line), undefined, { knowledgeStore: new MemoryStore(), embeddings: client });
    expect(JSON.parse(lines[0])).toMatchObject({ ok: true, mode: 'bm25' });
  });

  it('reports a missing folder as ok: false', async () => {
    const lines: string[] = [];
    const code = await mellisAdmin(['knowledge-build'], { MELLIS_KNOWLEDGE_DIR: '/nonexistent/knowledge' }, (line) => lines.push(line), undefined, { knowledgeStore: new MemoryStore() });
    expect(code).toBe(1);
    expect(JSON.parse(lines[0])).toMatchObject({ ok: false });
  });
});
