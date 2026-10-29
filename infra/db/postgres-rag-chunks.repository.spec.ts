import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { encodeVector, parseIndex, RAG_INDEX_VERSION, type IndexedChunk } from '../../scripts/evaluation/rag-retrieval';
import { fuseCandidateLists, PostgresRagChunkStore, RAG_EMBEDDING_DIMENSIONS, vectorLiteral, type CandidateList } from './postgres-rag-chunks.repository';
import { parseLoadArgs } from './rag-index-load';
import { formatHits, parseQueryArgs, parseVectorFile } from './rag-query';

function unitVector(axis: number, dimensions = RAG_EMBEDDING_DIMENSIONS): number[] {
  const vector = new Array<number>(dimensions).fill(0);
  vector[axis] = 1;
  return vector;
}

function indexedChunk(id: string, axis: number, text = `Text of ${id}.`): IndexedChunk {
  return { id, source_file: 'guides/ispad.pdf', title: 'ISPAD sick days', section: '8.3 Ketones', page: 12, page_end: 13, text, tokens_estimate: 10, embedding_b64: encodeVector(unitVector(axis)) };
}

function loadedIndex(chunks: IndexedChunk[], dimensions = RAG_EMBEDDING_DIMENSIONS) {
  return parseIndex(JSON.stringify({
    version: RAG_INDEX_VERSION,
    embedding_model: 'text-embedding-3-small',
    dimensions,
    created_at: '2026-10-16T07:06:59.628Z',
    chunking: { target_tokens: 600, overlap_tokens: 100 },
    chunks,
  }));
}

const REFERENCE_LIST = 'Diabetes Care. 2021;44(10):2225-2230. Pediatr Diabetes. 2018;19:105. Lancet. 2019;393:1. doi:10.1000/x';

function fakePool(options: { storedCount?: number; failOn?: string; failRollback?: boolean } = {}) {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  const client = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      if (options.failOn && sql.includes(options.failOn)) throw new Error('insert failed');
      if (sql === 'ROLLBACK' && options.failRollback) throw new Error('connection terminated');
      if (sql.startsWith('SELECT version FROM rag_corpus_versions')) return { rows: [{ version: 'v2' }], rowCount: 1 };
      if (sql === 'DELETE FROM rag_chunks') return { rows: [], rowCount: 985 };
      if (sql.startsWith('SELECT count(*)')) return { rows: [{ count: String(options.storedCount ?? 0) }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    }),
    release: vi.fn(),
  };
  const pool = { connect: vi.fn(async () => client), query: vi.fn() };
  return { pool: pool as unknown as Pool, client, calls };
}

describe('vectorLiteral', () => {
  it('writes pgvector text input', () => {
    expect(vectorLiteral(unitVector(1)).slice(0, 8)).toBe('[0,1,0,0');
    expect(vectorLiteral(new Float32Array(unitVector(0)).map((value) => value / 4))).toMatch(/^\[0\.25,0,/);
  });

  it('refuses wrong lengths and non-finite values', () => {
    expect(() => vectorLiteral([1, 2, 3])).toThrow('needs 1536');
    const broken = unitVector(0);
    broken[5] = Number.NaN;
    expect(() => vectorLiteral(broken)).toThrow('non-finite');
  });
});

describe('PostgresRagChunkStore.replaceCorpus', () => {
  it('replaces the previous version in one transaction, in batches, and checks the stored count', async () => {
    const chunks = Array.from({ length: 150 }, (_, position) => indexedChunk(`doc.md#${position}`, position));
    chunks[3] = indexedChunk('doc.md#3', 3, REFERENCE_LIST);
    const { pool, client, calls } = fakePool({ storedCount: 150 });

    const result = await new PostgresRagChunkStore(pool).replaceCorpus({ version: 'v3-2026-10-16', index: loadedIndex(chunks), indexSha256: 'abc' });

    expect(result).toEqual({ version: 'v3-2026-10-16', inserted: 150, removed: 985, previousVersion: 'v2' });
    const statements = calls.map(({ sql }) => sql.trim().split(/\s+/).slice(0, 2).join(' '));
    expect(statements).toEqual(['BEGIN', 'LOCK TABLE', 'SELECT version', 'DELETE FROM', 'UPDATE rag_corpus_versions', 'INSERT INTO', 'INSERT INTO', 'INSERT INTO', 'SELECT count(*)', 'COMMIT']);
    const version = calls[5];
    expect(version.params).toEqual(['v3-2026-10-16', 'text-embedding-3-small', 1536, 150, 'abc', '2026-10-16T07:06:59.628Z', 'index-file']);
    const [firstBatch, secondBatch] = [calls[6].params!, calls[7].params!];
    expect((firstBatch[1] as string[]).length).toBe(100);
    expect((secondBatch[1] as string[]).length).toBe(50);
    expect((firstBatch[10] as boolean[]).filter(Boolean)).toHaveLength(1);
    expect((firstBatch[10] as boolean[])[3]).toBe(true);
    expect((firstBatch[11] as string[])[2]).toMatch(/^\[0,0,1,0/);
    expect(client.release).toHaveBeenCalledWith();
  });

  it('stores a full-text-only corpus (no vectors, no model) with source metadata, never casting to vector', async () => {
    const { pool, calls } = fakePool({ storedCount: 2 });
    const chunks = [
      { id: 'ispad/a.md#1', source_file: 'ispad/a.md', title: 'ISPAD', section: null, page: null, page_end: null, text: 'Ketones.', tokens_estimate: 2, url: 'https://doi.org/x', licence: '©', source_mode: 'SUMMARY_ONLY' as const, publisher: 'ISPAD' },
      { id: 'trio/b.md#1', source_file: 'trio/b.md', title: 'Trio', section: null, page: null, page_end: null, text: 'Overrides.', tokens_estimate: 2 },
    ];
    await new PostgresRagChunkStore(pool).replaceCorpusChunks({ version: 'mellis-knowledge-01', source: 'shipped-knowledge', embeddingModel: null, chunks, vectors: null, indexSha256: 'h', createdAt: null });
    expect(calls[5].params).toEqual(['mellis-knowledge-01', null, null, 2, 'h', null, 'shipped-knowledge']);
    expect(calls[6].sql).not.toContain('::vector');
    const batch = calls[6].params!;
    expect(batch[11]).toEqual([null, null]);
    expect(batch.slice(12)).toEqual([['https://doi.org/x', null], ['©', null], ['SUMMARY_ONLY', null], ['ISPAD', null]]);
  });

  it('refuses vectors without a model and a model without vectors', async () => {
    const { pool } = fakePool();
    const store = new PostgresRagChunkStore(pool);
    const chunk = { id: 'a', source_file: 'a.md', title: 'A', section: null, page: null, page_end: null, text: 'x', tokens_estimate: 1 };
    await expect(store.replaceCorpusChunks({ version: 'v', source: 'shipped-knowledge', embeddingModel: 'm', chunks: [chunk], vectors: null, indexSha256: 'h', createdAt: null })).rejects.toThrow('exactly when');
    await expect(store.replaceCorpusChunks({ version: 'v', source: 'shipped-knowledge', embeddingModel: null, chunks: [chunk], vectors: [unitVector(0)], indexSha256: 'h', createdAt: null })).rejects.toThrow('exactly when');
  });

  it('rolls back when the stored count differs, so the previous version stays', async () => {
    const { pool, client, calls } = fakePool({ storedCount: 1 });
    await expect(new PostgresRagChunkStore(pool).replaceCorpus({ version: 'v3', index: loadedIndex([indexedChunk('a', 0), indexedChunk('b', 1)]), indexSha256: 'abc' }))
      .rejects.toThrow('Stored 1 chunks, index has 2');
    expect(calls.at(-1)?.sql).toBe('ROLLBACK');
    expect(calls.map(({ sql }) => sql)).not.toContain('COMMIT');
    expect(client.release).toHaveBeenCalledWith();
  });

  it('rethrows the original error and destroys the client when the rollback fails', async () => {
    const { pool, client } = fakePool({ failOn: 'INSERT INTO rag_chunks', failRollback: true });
    await expect(new PostgresRagChunkStore(pool).replaceCorpus({ version: 'v3', index: loadedIndex([indexedChunk('a', 0)]), indexSha256: 'abc' })).rejects.toThrow('insert failed');
    expect(client.release).toHaveBeenCalledWith(expect.objectContaining({ message: 'connection terminated' }));
  });

  it('refuses bad input before connecting', async () => {
    const { pool } = fakePool();
    const store = new PostgresRagChunkStore(pool);
    await expect(store.replaceCorpus({ version: 'v3; drop', index: loadedIndex([indexedChunk('a', 0)]), indexSha256: 'x' })).rejects.toThrow('Corpus version');
    await expect(store.replaceCorpus({ version: 'v3', index: loadedIndex([indexedChunk('a', 0), indexedChunk('a', 1)]), indexSha256: 'x' })).rejects.toThrow('repeated chunk ids');
    const small = { ...indexedChunk('a', 0), embedding_b64: encodeVector([1, 0, 0]) };
    await expect(store.replaceCorpus({ version: 'v3', index: loadedIndex([small], 3), indexSha256: 'x' })).rejects.toThrow('needs 1536');
    expect(pool.connect).not.toHaveBeenCalled();
  });
});

function row(id: string, score: number) {
  return { id, corpus_version: 'v3', source_file: 'f', title: `T ${id}`, section: null, page: null, page_end: null, kind: null, text: `text ${id}`, score };
}

describe('fuseCandidateLists', () => {
  it('ranks chunks found by several lists first and keeps per-list ranks and the best cosine', () => {
    const lists: CandidateList[] = [
      { name: 'pl', kind: 'vector', rows: [row('a', 0.61), row('b', 0.55), row('c', 0.5)] },
      { name: 'en', kind: 'vector', rows: [row('b', 0.66), row('d', 0.6)] },
      { name: 'keywords', kind: 'keywords', rows: [row('c', 0.4), row('b', 0.2)] },
    ];
    const hits = fuseCandidateLists(lists, 3);
    expect(hits.map((hit) => hit.chunk.id)).toEqual(['b', 'c', 'a']);
    expect(hits[0]).toMatchObject({ rank: 1, ranks: { pl: 2, en: 1, keywords: 2 }, cosine: 0.66 });
    expect(hits[0].score).toBeCloseTo(1 / 62 + 1 / 61 + 1 / 62);
    expect(fuseCandidateLists([{ name: 'keywords', kind: 'keywords', rows: [row('z', 3)] }], 1)[0].cosine).toBeNull();
  });

  it('breaks equal fused scores by the best single-list rank, then by id', () => {
    const hits = fuseCandidateLists([
      { name: 'pl', kind: 'vector', rows: [row('y', 0.9), row('x', 0.8)] },
      { name: 'keywords', kind: 'keywords', rows: [row('x', 2), row('y', 1)] },
    ], 2);
    expect(hits.map((hit) => hit.chunk.id)).toEqual(['x', 'y']);
  });
});

describe('PostgresRagChunkStore.search', () => {
  it('queries one cosine list per vector and one keyword list, read-only, and fuses them', async () => {
    const query = vi.fn(async (sql: string) => ({ rows: sql.includes('tsquery') ? [row('k', 0.3)] : [row('v', 0.7), row('k', 0.6)] }));
    const store = new PostgresRagChunkStore({ connect: vi.fn(), query } as unknown as Pool);
    const hits = await store.search({ vectors: [{ name: 'pl', embedding: unitVector(0) }], keywords: { name: 'keywords', text: 'ketones sick day' }, k: 2, candidates: 16 });

    expect(hits.map((hit) => hit.chunk.id)).toEqual(['k', 'v']);
    expect(query).toHaveBeenCalledTimes(2);
    const [vectorSql, vectorParams] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(vectorSql).toContain('ORDER BY embedding <=> $1::vector');
    expect(vectorParams.slice(1)).toEqual([16, false]);
    const [keywordSql, keywordParams] = query.mock.calls[1] as unknown as [string, unknown[]];
    expect(keywordSql).toContain("to_tsvector('english'::regconfig, $1)");
    expect(keywordParams).toEqual(['ketones sick day', 16, false]);
    // BM25 like the prototype's bm25Scores: inverse document frequency, k1 1.2, b 0.75; not ts_rank (no IDF).
    expect(keywordSql).toContain('ln(1 + (s.n - t.df + 0.5) / (t.df + 0.5)) * m.tf * 2.2 / (m.tf + 1.2 * (0.25 + 0.75 * m.dl / s.avgdl))');
    expect(keywordSql).not.toContain('ts_rank');
    for (const [sql] of query.mock.calls as unknown as Array<[string]>) expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/);
  });

  it('skips a blank keyword query and refuses invalid searches', async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const store = new PostgresRagChunkStore({ connect: vi.fn(), query } as unknown as Pool);
    await store.search({ vectors: [{ name: 'q', embedding: unitVector(0) }], keywords: { name: 'keywords', text: '  ' }, k: 1, candidates: 1 });
    expect(query).toHaveBeenCalledTimes(1);
    await expect(store.search({ vectors: [], keywords: null, k: 1, candidates: 1 })).rejects.toThrow('query vector or keywords');
    await expect(store.search({ vectors: [{ name: 'q', embedding: unitVector(0) }], k: 6, candidates: 4 })).rejects.toThrow('k <= candidates');
    await expect(store.search({ vectors: [{ name: 'q', embedding: [1, 2] }], k: 1, candidates: 1 })).rejects.toThrow('needs 1536');
    await expect(store.search({ vectors: [{ name: 'q', embedding: unitVector(0) }], keywords: { name: 'q', text: 'x' }, k: 1, candidates: 1 })).rejects.toThrow('distinct');
  });
});

describe('rag CLIs', () => {
  it('parse loader arguments', () => {
    expect(parseLoadArgs(['/data/rag/rag-index.json', '--corpus-version', 'v3'])).toEqual({ indexPath: '/data/rag/rag-index.json', corpusVersion: 'v3', dryRun: false });
    expect(parseLoadArgs(['--dry-run', 'i.json', '--corpus-version', 'v3']).dryRun).toBe(true);
    expect(() => parseLoadArgs(['i.json'])).toThrow('Usage');
    expect(() => parseLoadArgs(['i.json', '--corpus-version', 'v3', '--force'])).toThrow('Unknown flag');
  });

  it('parse query arguments and vector files', () => {
    expect(parseQueryArgs(['--vector-file', 'q.json', '--keywords', 'ketones', '--k', '4'])).toMatchObject({ vectorFile: 'q.json', keywords: 'ketones', k: 4, candidates: 16, embedText: null });
    expect(() => parseQueryArgs([])).toThrow('Give --vector-file');
    expect(() => parseQueryArgs(['--k'])).toThrow('needs a value');
    expect(parseVectorFile('[0.1,0.2]')).toEqual([{ name: 'query', embedding: [0.1, 0.2] }]);
    expect(parseVectorFile('{"pl":[1],"en":[2]}').map(({ name }) => name)).toEqual(['pl', 'en']);
    expect(() => parseVectorFile('{"pl":"x"}')).toThrow('number array');
  });

  it('formats hits with source, ranks and a short preview', () => {
    const [hit] = fuseCandidateLists([{ name: 'pl', kind: 'vector', rows: [{ ...row('a', 0.61), section: '8.3 Ketones', page: 12, page_end: 13 }] }], 1);
    expect(formatHits([hit])).toBe('1. T a / 8.3 Ketones, p. 12-13 [a]\n   rrf 0.0164 (pl 1, cos 0.610)\n   text a');
  });
});

describe('migration 036', () => {
  const sql = readFileSync(resolve(__dirname, 'migrations/036_rag_knowledge_index.sql'), 'utf8');

  it('fails with a clear message before CREATE EXTENSION when pgvector is missing', () => {
    expect(sql.indexOf("pg_available_extensions WHERE name = 'vector'")).toBeGreaterThan(-1);
    expect(sql.indexOf('RAISE EXCEPTION')).toBeLessThan(sql.indexOf('CREATE EXTENSION IF NOT EXISTS vector'));
  });

  it('matches the store: vector(1536) and an English full-text column', () => {
    expect(sql).toContain(`embedding vector(${RAG_EMBEDDING_DIMENSIONS}) NOT NULL`);
    expect(sql).toContain("to_tsvector('english'::regconfig");
    expect(sql).not.toMatch(/USING (ivfflat|hnsw)/);
  });
});
