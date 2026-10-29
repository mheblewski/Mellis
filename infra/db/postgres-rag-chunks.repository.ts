/**
 * RAG knowledge index in Postgres (pgvector, migration 036). Loading replaces the whole corpus in one transaction;
 * search is read-only hybrid retrieval like the prototype in scripts/evaluation/rag-retrieval.ts: the top
 * `candidates` chunks by exact cosine distance for every query vector and by full-text rank for the keyword query,
 * merged by reciprocal rank fusion. The keyword list is Okapi BM25 computed in SQL over the English full-text index
 * (English stemming, any query word may match), as the prototype's bm25Scores; the assistant's search_knowledge uses it.
 * A corpus built without an OpenAI key (the shipped knowledge base, infra/db/knowledge-build.ts; migration 095) has no
 * vectors: its version has no embedding model and search uses the keyword list only. Chunks of the shipped knowledge
 * base carry their original's url, licence, mode and publisher, so an answer can link to the source.
 */
import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { isReferenceListChunk, type LoadedIndex, type RagChunk } from '../../scripts/evaluation/rag-retrieval';

/** vector(1536) in migration 036: text-embedding-3-small. */
export const RAG_EMBEDDING_DIMENSIONS = 1536;
/** Reciprocal rank fusion constant, as in the prototype (rank 1 adds 1/61). */
export const RAG_RRF_K = 60;
const INSERT_BATCH = 100;

export class RagStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RagStoreError';
  }
}

function assertStorableVector(vector: ArrayLike<number>): void {
  if (vector.length !== RAG_EMBEDDING_DIMENSIONS) throw new RagStoreError(`Vector has ${vector.length} dimensions, rag_chunks needs ${RAG_EMBEDDING_DIMENSIONS}.`);
  for (let index = 0; index < vector.length; index += 1) {
    if (!Number.isFinite(vector[index])) throw new RagStoreError('Vector has a non-finite value.');
  }
}

/** pgvector text input ("[0.1,-0.2,...]"); refuses wrong lengths and non-finite values instead of storing them. */
export function vectorLiteral(vector: ArrayLike<number>): string {
  assertStorableVector(vector);
  return `[${Array.from(vector, String).join(',')}]`;
}

export interface CorpusLoadResult {
  version: string;
  inserted: number;
  removed: number;
  previousVersion: string | null;
}

export interface RagSearchQuery {
  /** Query vectors, each its own candidate list (e.g. "pl" for the question, "en" for an English rewrite). */
  vectors: ReadonlyArray<{ name: string; embedding: ArrayLike<number> }>;
  /** Keyword candidate list: English text matched against the English full-text index. */
  keywords?: { name: string; text: string } | null;
  /** Candidates taken from each list before fusion. */
  candidates: number;
  /** Chunks returned after fusion. */
  k: number;
  includeReferenceLists?: boolean;
}

/** Where a shipped-knowledge chunk comes from (knowledge/ front matter); all null for a corpus loaded from rag-index.json. */
export interface RagChunkSourceMeta {
  url: string | null;
  licence: string | null;
  /** SHIP_TEXT (original text) or SUMMARY_ONLY (our summary of the original). */
  source_mode: 'SHIP_TEXT' | 'SUMMARY_ONLY' | null;
  publisher: string | null;
}

export type StoredRagChunk = Omit<RagChunk, 'tokens_estimate'> & { corpus_version: string } & Partial<RagChunkSourceMeta>;

/** One chunk to store: a RagChunk with its optional source metadata. */
export type StorableRagChunk = RagChunk & Partial<RagChunkSourceMeta>;

export type RagCorpusSource = 'index-file' | 'shipped-knowledge';

export interface ActiveRagCorpus {
  version: string;
  /** null: a full-text-only corpus (no vectors). */
  embeddingModel: string | null;
  chunkCount: number;
  loadedAt: Date;
  indexSha256: string;
  source: RagCorpusSource;
}

export interface RagSearchHit {
  rank: number;
  /** Fused score (sum of 1 / (60 + rank) over the lists the chunk appeared in). */
  score: number;
  chunk: StoredRagChunk;
  /** Rank in each candidate list the chunk appeared in, e.g. { pl: 2, keywords: 1 }. */
  ranks: Record<string, number>;
  /** Best cosine similarity over the vector lists it appeared in; null when only the keyword list found it. */
  cosine: number | null;
}

interface CandidateRow {
  id: string;
  corpus_version: string;
  source_file: string;
  title: string;
  section: string | null;
  page: number | null;
  page_end: number | null;
  kind: string | null;
  text: string;
  url?: string | null;
  licence?: string | null;
  source_mode?: string | null;
  publisher?: string | null;
  score: number | string;
}

export interface CandidateList {
  name: string;
  kind: 'vector' | 'keywords';
  rows: CandidateRow[];
}

const CHUNK_COLUMNS = 'id, corpus_version, source_file, title, section, page, page_end, kind, text, url, licence, source_mode, publisher';

// The cosine list orders by distance with the id as a tie-break so equal scores rank the same on every run.
const VECTOR_CANDIDATES_SQL = `
  SELECT ${CHUNK_COLUMNS}, 1 - (embedding <=> $1::vector) AS score
  FROM rag_chunks
  WHERE embedding IS NOT NULL AND ($3::boolean OR NOT is_reference_list)
  ORDER BY embedding <=> $1::vector, id
  LIMIT $2`;

// Okapi BM25 (k1 1.2, b 0.75, as bm25Scores in scripts/evaluation/rag-retrieval.ts) over search_tsv: any query lexeme
// may match (OR). ts_rank had no inverse document frequency, so common words ("glucose", "sensor", "low") outranked the
// rare ones that name the answer ("compression"); 2026-10-16 offline check on the 30 probe questions: the fused top 16
// kept 160 of the 180 chunks the offline rerank picked with ts_rank, 168 with this (production gave the same 160 with
// ts_rank). Cost: on the production server ~210 ms median, 480 ms max per keyword query vs ~25 ms (Mac: 40 vs 5 ms).
// Term frequency is the lexeme's position count; document length is the number of distinct lexemes (length()).
// Lexemes come from the same English configuration as search_tsv, so they are quoted and cast, not stemmed twice.
export const KEYWORD_CANDIDATES_SQL = `
  WITH q AS (
    SELECT DISTINCT lexeme
    FROM unnest(tsvector_to_array(to_tsvector('english'::regconfig, $1))) AS lexeme
    WHERE strpos(lexeme, chr(92)) = 0
  ),
  query AS (
    SELECT string_agg(quote_literal(lexeme), ' | ')::tsquery AS terms, array_agg(lexeme) AS lexemes FROM q
  ),
  stats AS MATERIALIZED (
    SELECT count(*)::float8 AS n, avg(length(search_tsv))::float8 AS avgdl
    FROM rag_chunks
    WHERE ($3::boolean OR NOT is_reference_list)
  ),
  terms AS MATERIALIZED (
    SELECT q.lexeme, (
      SELECT count(*) FROM rag_chunks c
      WHERE c.search_tsv @@ quote_literal(q.lexeme)::tsquery AND ($3::boolean OR NOT c.is_reference_list)
    )::float8 AS df
    FROM q
  ),
  matched AS (
    SELECT c.id, length(c.search_tsv)::float8 AS dl, u.lexeme, coalesce(array_length(u.positions, 1), 1)::float8 AS tf
    FROM rag_chunks c, query, LATERAL unnest(c.search_tsv) AS u
    WHERE c.search_tsv @@ query.terms AND ($3::boolean OR NOT c.is_reference_list) AND u.lexeme = ANY (query.lexemes)
  ),
  ranked AS (
    SELECT m.id, sum(ln(1 + (s.n - t.df + 0.5) / (t.df + 0.5)) * m.tf * 2.2 / (m.tf + 1.2 * (0.25 + 0.75 * m.dl / s.avgdl))) AS score
    FROM matched m JOIN terms t USING (lexeme), stats s
    GROUP BY m.id
    ORDER BY score DESC, m.id
    LIMIT $2
  )
  SELECT ${CHUNK_COLUMNS}, score
  FROM ranked JOIN rag_chunks USING (id)
  ORDER BY score DESC, id`;

/** Reciprocal rank fusion of candidate lists (already ordered best first); ties go to the better single-list rank, then id. */
export function fuseCandidateLists(lists: readonly CandidateList[], k: number): RagSearchHit[] {
  const fused = new Map<string, { score: number; ranks: Record<string, number>; cosine: number | null; row: CandidateRow }>();
  for (const list of lists) {
    list.rows.forEach((row, offset) => {
      const entry = fused.get(row.id) ?? { score: 0, ranks: {}, cosine: null, row };
      entry.score += 1 / (RAG_RRF_K + offset + 1);
      entry.ranks[list.name] = offset + 1;
      if (list.kind === 'vector') entry.cosine = Math.max(entry.cosine ?? -Infinity, Number(row.score));
      fused.set(row.id, entry);
    });
  }
  const best = (ranks: Record<string, number>) => Math.min(...Object.values(ranks));
  return [...fused.values()]
    .sort((a, b) => b.score - a.score || best(a.ranks) - best(b.ranks) || (a.row.id < b.row.id ? -1 : a.row.id > b.row.id ? 1 : 0))
    .slice(0, k)
    .map(({ score, ranks, cosine, row }, position) => ({
      rank: position + 1,
      score,
      ranks,
      cosine,
      chunk: {
        id: row.id,
        corpus_version: row.corpus_version,
        source_file: row.source_file,
        title: row.title,
        section: row.section,
        page: row.page,
        page_end: row.page_end,
        text: row.text,
        ...(row.kind === 'table' ? { kind: 'table' as const } : {}),
        ...sourceMeta(row),
      },
    }));
}

function sourceMeta(row: CandidateRow): Partial<RagChunkSourceMeta> {
  if (row.url === undefined && row.licence === undefined && row.source_mode === undefined && row.publisher === undefined) return {};
  const mode = row.source_mode === 'SHIP_TEXT' || row.source_mode === 'SUMMARY_ONLY' ? row.source_mode : null;
  return { url: row.url ?? null, licence: row.licence ?? null, source_mode: mode, publisher: row.publisher ?? null };
}

export class PostgresRagChunkStore {
  constructor(private readonly pool: Pick<Pool, 'connect' | 'query'>) {}

  /**
   * Replaces the stored corpus with `index` as `version` in one transaction: readers keep seeing the previous
   * version until COMMIT, and a failure leaves it in place. Reloading the same version name replaces it too.
   */
  async replaceCorpus(input: { version: string; index: LoadedIndex; indexSha256: string }): Promise<CorpusLoadResult> {
    const { index } = input;
    if (index.file.dimensions !== RAG_EMBEDDING_DIMENSIONS) throw new RagStoreError(`Index has ${index.file.dimensions} dimensions, rag_chunks needs ${RAG_EMBEDDING_DIMENSIONS}.`);
    return this.replaceCorpusChunks({
      version: input.version,
      source: 'index-file',
      embeddingModel: index.file.embedding_model,
      chunks: index.file.chunks,
      vectors: index.vectors,
      indexSha256: input.indexSha256,
      createdAt: index.file.created_at || null,
    });
  }

  /**
   * replaceCorpus for chunks with or without vectors: `vectors` null (and `embeddingModel` null) stores a full-text-only
   * corpus. Same single transaction: readers keep the previous version until COMMIT.
   */
  async replaceCorpusChunks(input: {
    version: string;
    source: RagCorpusSource;
    embeddingModel: string | null;
    chunks: readonly StorableRagChunk[];
    vectors: ReadonlyArray<ArrayLike<number>> | null;
    indexSha256: string;
    createdAt: string | null;
  }): Promise<CorpusLoadResult> {
    const { version, chunks, vectors } = input;
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(version)) throw new RagStoreError('Corpus version must be 1-100 characters: letters, digits, ".", "_", "-".');
    if ((input.embeddingModel === null) !== (vectors === null)) throw new RagStoreError('A corpus has an embedding model exactly when it has vectors.');
    if (vectors && vectors.length !== chunks.length) throw new RagStoreError(`Corpus has ${chunks.length} chunks but ${vectors.length} vectors.`);
    const ids = new Set(chunks.map((chunk) => chunk.id));
    if (ids.size !== chunks.length) throw new RagStoreError('Index has repeated chunk ids.');
    // Checked up front, but written as text one batch at a time: all ~1000 literals at once would be ~30 MB of strings
    // in the migrate container (192 MB limit).
    vectors?.forEach(assertStorableVector);
    const dimensions = vectors ? RAG_EMBEDDING_DIMENSIONS : null;

    const client = await this.pool.connect();
    let releaseError: Error | undefined;
    try {
      await client.query('BEGIN');
      // Self-conflicting lock: a second loader waits, readers (ACCESS SHARE) do not.
      await client.query('LOCK TABLE rag_corpus_versions, rag_chunks IN SHARE ROW EXCLUSIVE MODE');
      const previous = await client.query<{ version: string }>('SELECT version FROM rag_corpus_versions WHERE active');
      const removed = await client.query('DELETE FROM rag_chunks');
      await client.query('UPDATE rag_corpus_versions SET active = false WHERE active');
      await client.query(
        `INSERT INTO rag_corpus_versions (version, embedding_model, dimensions, chunk_count, index_sha256, index_created_at, active, source)
         VALUES ($1, $2, $3, $4, $5, $6, true, $7)
         ON CONFLICT (version) DO UPDATE SET embedding_model = EXCLUDED.embedding_model, dimensions = EXCLUDED.dimensions,
           chunk_count = EXCLUDED.chunk_count, index_sha256 = EXCLUDED.index_sha256, index_created_at = EXCLUDED.index_created_at,
           loaded_at = now(), active = true, source = EXCLUDED.source`,
        [version, input.embeddingModel, dimensions, chunks.length, input.indexSha256, input.createdAt, input.source],
      );
      for (let start = 0; start < chunks.length; start += INSERT_BATCH) {
        const batchVectors = vectors ? vectors.slice(start, start + INSERT_BATCH).map(vectorLiteral) : chunks.slice(start, start + INSERT_BATCH).map(() => null);
        await insertBatch(client, version, chunks.slice(start, start + INSERT_BATCH), batchVectors);
      }
      const stored = await client.query<{ count: string }>('SELECT count(*) AS count FROM rag_chunks WHERE corpus_version = $1', [version]);
      if (Number(stored.rows[0]?.count) !== chunks.length) {
        throw new RagStoreError(`Stored ${String(stored.rows[0]?.count)} chunks, index has ${chunks.length}.`);
      }
      await client.query('COMMIT');
      return { version, inserted: chunks.length, removed: removed.rowCount ?? 0, previousVersion: previous.rows[0]?.version ?? null };
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        releaseError = rollbackError as Error;
      }
      throw error;
    } finally {
      // A client whose rollback failed is in an unknown state: destroy it instead of returning it to the pool.
      if (releaseError) client.release(releaseError);
      else client.release();
    }
  }

  /**
   * The loaded corpus version (its embedding model is the one query vectors must come from; null: full text only);
   * null before any load.
   */
  async activeVersion(): Promise<ActiveRagCorpus | null> {
    const result = await this.pool.query<{ version: string; embedding_model: string | null; chunk_count: number; loaded_at: Date; index_sha256: string; source: string }>(
      'SELECT version, embedding_model, chunk_count, loaded_at, index_sha256, source FROM rag_corpus_versions WHERE active',
    );
    const row = result.rows[0];
    return row
      ? {
        version: row.version,
        embeddingModel: row.embedding_model,
        chunkCount: row.chunk_count,
        loadedAt: row.loaded_at,
        indexSha256: row.index_sha256,
        source: row.source === 'shipped-knowledge' ? 'shipped-knowledge' : 'index-file',
      }
      : null;
  }

  /** Read-only hybrid search over the stored corpus. */
  async search(query: RagSearchQuery): Promise<RagSearchHit[]> {
    if (!(Number.isInteger(query.k) && query.k > 0) || !(Number.isInteger(query.candidates) && query.candidates >= query.k && query.candidates <= 100)) {
      throw new RagStoreError('Search needs integers 0 < k <= candidates <= 100.');
    }
    const keywords = query.keywords?.text.trim() ? query.keywords : null;
    if (!query.vectors.length && !keywords) throw new RagStoreError('Search needs a query vector or keywords.');
    const names = [...query.vectors.map(({ name }) => name), ...(keywords ? [keywords.name] : [])];
    if (new Set(names).size !== names.length) throw new RagStoreError('Candidate list names must be distinct.');
    const includeReferenceLists = query.includeReferenceLists ?? false;

    const lists: CandidateList[] = [];
    for (const { name, embedding } of query.vectors) {
      const result = await this.pool.query<CandidateRow>(VECTOR_CANDIDATES_SQL, [vectorLiteral(embedding), query.candidates, includeReferenceLists]);
      lists.push({ name, kind: 'vector', rows: result.rows });
    }
    if (keywords) {
      const result = await this.pool.query<CandidateRow>(KEYWORD_CANDIDATES_SQL, [keywords.text, query.candidates, includeReferenceLists]);
      lists.push({ name: keywords.name, kind: 'keywords', rows: result.rows });
    }
    return fuseCandidateLists(lists, query.k);
  }
}

async function insertBatch(client: PoolClient, version: string, chunks: readonly StorableRagChunk[], embeddings: Array<string | null>): Promise<void> {
  // A full-text-only batch never casts to vector, so it also runs where the column is not a pgvector type.
  const embeddingValue = embeddings.some((value) => value !== null) ? 'embedding::vector' : 'NULL';
  await client.query(
    `INSERT INTO rag_chunks (id, corpus_version, source_file, title, section, page, page_end, kind, text, tokens_estimate, is_reference_list, embedding,
                             url, licence, source_mode, publisher)
     SELECT id, $1, source_file, title, section, page, page_end, kind, text, tokens_estimate, is_reference_list, ${embeddingValue},
            url, licence, source_mode, publisher
     FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::int[], $7::int[], $8::text[], $9::text[], $10::int[], $11::boolean[], $12::text[],
                 $13::text[], $14::text[], $15::text[], $16::text[])
       AS t(id, source_file, title, section, page, page_end, kind, text, tokens_estimate, is_reference_list, embedding, url, licence, source_mode, publisher)`,
    [
      version,
      chunks.map((chunk) => chunk.id),
      chunks.map((chunk) => chunk.source_file),
      chunks.map((chunk) => chunk.title),
      chunks.map((chunk) => chunk.section),
      chunks.map((chunk) => chunk.page),
      chunks.map((chunk) => chunk.page_end),
      chunks.map((chunk) => chunk.kind ?? null),
      chunks.map((chunk) => chunk.text),
      chunks.map((chunk) => chunk.tokens_estimate),
      chunks.map((chunk) => isReferenceListChunk(chunk.text)),
      embeddings,
      chunks.map((chunk) => chunk.url ?? null),
      chunks.map((chunk) => chunk.licence ?? null),
      chunks.map((chunk) => chunk.source_mode ?? null),
      chunks.map((chunk) => chunk.publisher ?? null),
    ],
  );
}

/** sha256 of the raw index file, stored with the version. */
export function indexFileSha256(raw: string | Buffer): string {
  return createHash('sha256').update(raw).digest('hex');
}
