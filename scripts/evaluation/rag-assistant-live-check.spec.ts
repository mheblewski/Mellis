import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { InMemoryIndexStore, LiveCheckArgumentError, main, parseLiveCheckArgs, routeOf, selectedQuestions } from './rag-assistant-live-check';
import { encodeVector, parseIndex } from './rag-retrieval';

function indexJson(): string {
  const chunk = (id: string, text: string, vector: number[]) => ({ id, source_file: `${id}.txt`, title: `Title ${id}`, section: 'S', page: 1, page_end: null, text, tokens_estimate: 10, embedding_b64: encodeVector(vector) });
  return JSON.stringify({
    version: 'rag-index.v1', embedding_model: 'm', dimensions: 2, created_at: '2026-10-16T00:00:00Z', chunking: { target_tokens: 600, overlap_tokens: 100 },
    chunks: [chunk('a#1', 'ketones sick day insulin', [1, 0]), chunk('b#1', 'exercise temporary target', [0, 1])],
  });
}

describe('RAG assistant live check (offline parts)', () => {
  it('needs an index, refuses unknown flags and selects the default questions', () => {
    expect(() => parseLiveCheckArgs(['--output-dir', '/tmp/x'])).toThrow(LiveCheckArgumentError);
    expect(() => parseLiveCheckArgs(['--index', 'i.json', '--bogus'])).toThrow(LiveCheckArgumentError);
    expect(parseLiveCheckArgs(['--index', 'i.json', '--only', 'Q06, A1', '--live'])).toEqual({ index: 'i.json', only: new Set(['Q06', 'A1']), live: true });
    expect(selectedQuestions(null).map((question) => question.id)).toEqual(['Q05', 'Q06', 'Q07', 'Q09', 'Q10', 'Q14', 'Q16', 'Q20', 'Q26', 'Q27', 'A1', 'A2']);
    expect(selectedQuestions(new Set(['Q01', 'A2'])).map((question) => question.id)).toEqual(['Q01', 'A2']);
  });

  it('routes like the API: general questions to a direct reply, data questions to a time-range analysis', () => {
    expect(routeOf('Jak działa WBT?')).toBe('DIRECT_RESPONSE');
    expect(routeOf('Dlaczego wczoraj cukier spadł?')).toBe('TIME_RANGE_ANALYSIS');
  });

  it('searches the index in memory and returns rows shaped like rag_chunks', async () => {
    const store = new InMemoryIndexStore(parseIndex(indexJson()), 'local-test');
    expect(await store.activeVersion()).toEqual({ version: 'local-test', embeddingModel: 'm', chunkCount: 2 });
    const hits = await store.search({ vectors: [{ name: 'pl', embedding: [1, 0] }], keywords: { name: 'bm25', text: 'ketones' }, candidates: 2, k: 2 });
    expect(hits[0].chunk).toMatchObject({ id: 'a#1', corpus_version: 'local-test', title: 'Title a#1' });
    expect(hits[0].chunk).not.toHaveProperty('tokens_estimate');
  });

  it('dry run prints the plan and writes nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rag-live-check-'));
    const indexDir = mkdtempSync(join(tmpdir(), 'rag-live-check-index-'));
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(indexDir, 'index.json'), indexJson());
    await main(['--output-dir', dir, '--index', join(indexDir, 'index.json'), '--only', 'Q06']);
    expect(readdirSync(dir)).toEqual([]);
  });
});
