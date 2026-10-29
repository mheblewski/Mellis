/**
 * Postgres full-text vs prototype BM25 in the knowledge search, offline and without paid calls. For every probe question
 * (rag-knowledge-probe.questions.json) it builds the fused top 16 the assistant's rerank chooses from three ways:
 *   offline  — the prototype (rag-retrieval.ts retrieveHybrid: cosine pl + en, BM25), as in the 2026-10-16 tuning run;
 *   ts_rank  — cosine lists + the stage 3 Postgres keyword list (ts_rank, no inverse document frequency);
 *   bm25_sql — cosine lists + the current PostgresRagChunkStore keyword list (KEYWORD_CANDIDATES_SQL, BM25 in SQL);
 * and counts how many of the 6 chunks the offline rerank picked (query-reranks.json) each top 16 still contains.
 * Rewrites, query vectors and rerank picks come from the probe's caches (--cache-dir); a missing entry stops the run.
 *
 *   npx tsx scripts/evaluation/rag-fulltext-compare.ts --output-dir <dir> --index <rag-index.json> --cache-dir <dir>
 *     --database-url <postgres> [--production <file>] [--export-queries]
 *
 * --database-url: any Postgres (no pgvector needed); the chunks go into a TEMP table of one session, nothing persists.
 * Use a scratch database, not the dev or production one. Cosine lists are computed in memory from the index vectors.
 * --production: top 16 per question measured on the production database ({ rows: [{ id, top16: [chunk ids] }] }),
 * reported as a fourth column. --export-queries writes rag-fulltext-queries.json (question id, English query, keyword
 * text, pl/en vectors) to the output dir for such a measurement. Reports: rag-fulltext-compare-<time>.{json,md}.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import { KEYWORD_CANDIDATES_SQL, fuseCandidateLists, type CandidateList } from '@infra/db/postgres-rag-chunks.repository';
import { RERANK_PROMPT_VERSION, REWRITE_PROMPT_VERSION, glossaryExpansion } from '@modules/knowledge/application/knowledge-query';
import { resolveEvaluationOutputDir, writeEvaluationOutputDirFile } from './evaluation-output-dir';
import { cosineSimilarity, isReferenceListChunk, parseIndex, queryCacheKey, retrieveHybrid, type LoadedIndex } from './rag-retrieval';
import questionSet from './rag-knowledge-probe.questions.json';

const CANDIDATES = 16;
const TOP_K = 6;

/** The keyword list of stage 3 (2026-10-16), kept as the baseline: ts_rank over an OR of the query lexemes. */
export const TS_RANK_KEYWORD_SQL = `
  WITH q AS (
    SELECT string_agg(quote_literal(lexeme), ' | ')::tsquery AS terms
    FROM unnest(tsvector_to_array(to_tsvector('english'::regconfig, $1))) AS lexeme
    WHERE strpos(lexeme, chr(92)) = 0
  )
  SELECT c.id, c.corpus_version, c.source_file, c.title, c.section, c.page, c.page_end, c.kind, c.text, ts_rank(c.search_tsv, q.terms, 1) AS score
  FROM rag_chunks c, q
  WHERE c.search_tsv @@ q.terms AND ($3::boolean OR NOT c.is_reference_list)
  ORDER BY score DESC, c.id
  LIMIT $2`;

// Same columns and generated full-text column as migration 036, without the vector (cosine is computed in memory).
const TEMP_TABLE_SQL = `
  CREATE TEMP TABLE rag_chunks (
    id text PRIMARY KEY, corpus_version text NOT NULL, source_file text NOT NULL, title text NOT NULL, section text,
    page integer, page_end integer, kind text, text text NOT NULL, tokens_estimate integer NOT NULL, is_reference_list boolean NOT NULL,
    search_tsv tsvector GENERATED ALWAYS AS (to_tsvector('english'::regconfig, title || ' ' || coalesce(section, '') || ' ' || text)) STORED
  )`;

interface VariantResult {
  top16: string[];
  picks_in_top16: number;
  missing_picks: string[];
}

interface CompareRow {
  id: string;
  english: string | null;
  keywords: string;
  offline_top16: string[];
  offline_picks: string[];
  offline_matches_cached_candidates: boolean;
  ts_rank: VariantResult & { keywords: string[]; ms: number };
  bm25_sql: VariantResult & { keywords: string[]; ms: number };
  production?: VariantResult;
}

interface Args {
  outputDir: string;
  index: string;
  cacheDir: string;
  databaseUrl: string;
  production: string | null;
  exportQueries: boolean;
}

export function parseArgs(argv: readonly string[]): Args {
  const value = (flag: string) => {
    const position = argv.indexOf(flag);
    const found = position >= 0 ? argv[position + 1] : undefined;
    return found && !found.startsWith('--') ? found : null;
  };
  const index = value('--index');
  const cacheDir = value('--cache-dir');
  const databaseUrl = value('--database-url');
  if (!index || !cacheDir || !databaseUrl) throw new Error('Give --index <rag-index.json>, --cache-dir <probe output dir> and --database-url <scratch postgres>.');
  return { outputDir: resolveEvaluationOutputDir(argv), index, cacheDir, databaseUrl, production: value('--production'), exportQueries: argv.includes('--export-queries') };
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

/** The final 6 of the offline rerank: picked candidates first, then unpicked ones in fused order (as applyRerank). */
export function rerankFinal(candidates: readonly string[], picked: readonly number[] | null): string[] {
  const chosen = (picked ?? []).map((number) => candidates[number - 1]);
  return [...chosen, ...candidates.filter((id) => !chosen.includes(id))].slice(0, TOP_K);
}

async function loadTempTable(pool: Pool, index: LoadedIndex): Promise<void> {
  await pool.query(TEMP_TABLE_SQL);
  const chunks = index.file.chunks;
  for (let start = 0; start < chunks.length; start += 200) {
    const batch = chunks.slice(start, start + 200);
    await pool.query(
      `INSERT INTO rag_chunks (id, corpus_version, source_file, title, section, page, page_end, kind, text, tokens_estimate, is_reference_list)
       SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::int[], $7::int[], $8::text[], $9::text[], $10::int[], $11::boolean[])`,
      [
        batch.map((chunk) => chunk.id), batch.map(() => 'offline'), batch.map((chunk) => chunk.source_file), batch.map((chunk) => chunk.title),
        batch.map((chunk) => chunk.section), batch.map((chunk) => chunk.page), batch.map((chunk) => chunk.page_end), batch.map((chunk) => chunk.kind ?? null),
        batch.map((chunk) => chunk.text), batch.map((chunk) => chunk.tokens_estimate), batch.map((chunk) => isReferenceListChunk(chunk.text)),
      ],
    );
  }
  await pool.query('CREATE INDEX ON rag_chunks USING gin (search_tsv)');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const index = parseIndex(readFileSync(args.index, 'utf8'));
  const model = index.file.embedding_model;
  const vectors = readJson<Record<string, number[]>>(join(args.cacheDir, 'query-embeddings.json'));
  const rewrites = Object.values(readJson<Record<string, { question: string; prompt_version: string; query: string | null }>>(join(args.cacheDir, 'query-rewrites.json')))
    .filter((entry) => entry.prompt_version === REWRITE_PROMPT_VERSION);
  const reranks = Object.values(readJson<Record<string, { id: string; prompt_version: string; candidates: string[]; picked: number[] | null }>>(join(args.cacheDir, 'query-reranks.json')))
    .filter((entry) => entry.prompt_version === RERANK_PROMPT_VERSION);
  const production = args.production ? new Map(readJson<{ rows: Array<{ id: string; top16: string[] }> }>(args.production).rows.map((row) => [row.id, row.top16])) : null;
  const eligible = index.file.chunks.map((chunk) => !isReferenceListChunk(chunk.text));
  const positions = new Map(index.file.chunks.map((chunk, position) => [chunk.id, position]));
  const asRow = (position: number, score: number) => ({ ...index.file.chunks[position], corpus_version: 'offline', page_end: index.file.chunks[position].page_end, kind: index.file.chunks[position].kind ?? null, score });

  // One connection: the TEMP table lives in its session.
  const pool = new Pool({ connectionString: args.databaseUrl, max: 1 });
  const rows: CompareRow[] = [];
  const queries: unknown[] = [];
  try {
    await loadTempTable(pool, index);
    for (const question of questionSet.questions) {
      const english = rewrites.find((entry) => entry.question === question.question)?.query ?? null;
      const keywordText = [english ?? '', ...glossaryExpansion([question.question, english ?? ''])].join(' ').trim();
      const named = [{ name: 'pl', vector: vectors[queryCacheKey(model, question.question)] }, ...(english ? [{ name: 'en', vector: vectors[queryCacheKey(model, english)] }] : [])];
      if (named.some(({ vector }) => !Array.isArray(vector))) throw new Error(`${question.id}: query vector not cached in ${args.cacheDir}.`);
      const rerank = reranks.find((entry) => entry.id === question.id);
      if (!rerank) throw new Error(`${question.id}: no cached rerank in ${args.cacheDir}.`);
      if (args.exportQueries) queries.push({ id: question.id, english, keywords: keywordText, vectors: Object.fromEntries(named.map(({ name, vector }) => [name, vector])) });

      const offline = retrieveHybrid(index, { vectors: named, lexical: keywordText ? { name: 'bm25', text: keywordText } : null, candidates: CANDIDATES, k: CANDIDATES }).map((hit) => hit.chunk.id);
      const cosineLists: CandidateList[] = named.map(({ name, vector }) => ({
        name,
        kind: 'vector',
        rows: index.vectors
          .map((chunkVector, position) => ({ position, score: cosineSimilarity(chunkVector, vector) }))
          .filter(({ position }) => eligible[position])
          .sort((a, b) => b.score - a.score)
          .slice(0, CANDIDATES)
          .map(({ position, score }) => asRow(position, score)),
      }));
      const withKeywords = async (sql: string) => {
        const started = Date.now();
        const result = keywordText ? await pool.query<{ id: string; score: number }>(sql, [keywordText, CANDIDATES, false]) : { rows: [] };
        const keywordRows = result.rows.map((row) => asRow(positions.get(row.id)!, Number(row.score)));
        const top16 = fuseCandidateLists([...cosineLists, { name: 'bm25', kind: 'keywords', rows: keywordRows }], CANDIDATES).map((hit) => hit.chunk.id);
        return { top16, keywords: keywordRows.map((row) => row.id), ms: Date.now() - started };
      };
      const picks = rerankFinal(rerank.candidates, rerank.picked);
      const variants = { ts_rank: await withKeywords(TS_RANK_KEYWORD_SQL), bm25_sql: await withKeywords(KEYWORD_CANDIDATES_SQL) };
      const covered = (top16: readonly string[]) => picks.filter((id) => top16.includes(id)).length;
      rows.push({
        id: question.id,
        english,
        keywords: keywordText,
        offline_top16: offline,
        offline_picks: picks,
        offline_matches_cached_candidates: offline.join('\n') === rerank.candidates.join('\n'),
        ts_rank: { ...variants.ts_rank, picks_in_top16: covered(variants.ts_rank.top16), missing_picks: picks.filter((id) => !variants.ts_rank.top16.includes(id)) },
        bm25_sql: { ...variants.bm25_sql, picks_in_top16: covered(variants.bm25_sql.top16), missing_picks: picks.filter((id) => !variants.bm25_sql.top16.includes(id)) },
        ...(production?.has(question.id) ? { production: { top16: production.get(question.id)!, picks_in_top16: covered(production.get(question.id)!), missing_picks: picks.filter((id) => !production.get(question.id)!.includes(id)) } } : {}),
      });
    }
  } finally {
    await pool.end();
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const total = (key: 'ts_rank' | 'bm25_sql' | 'production') => rows.reduce((sum, row) => sum + (row[key]?.picks_in_top16 ?? 0), 0);
  const lines = [
    `# Full-text Postgres vs BM25: rerank picks in the fused top ${CANDIDATES} (${stamp})`,
    '',
    `Index ${args.index} (${index.file.chunks.length} chunks); offline picks = the cached rerank's final ${TOP_K}.`,
    '',
    `| Question | ts_rank | bm25_sql${production ? ' | production' : ''} | missing with ts_rank | missing with bm25_sql |`,
    `|---|---|---${production ? '|---' : ''}|---|---|`,
    ...rows.map((row) => `| ${row.id} | ${row.ts_rank.picks_in_top16}/${TOP_K} | ${row.bm25_sql.picks_in_top16}/${TOP_K}${production ? ` | ${row.production ? `${row.production.picks_in_top16}/${TOP_K}` : '–'}` : ''} | ${row.ts_rank.missing_picks.join(', ')} | ${row.bm25_sql.missing_picks.join(', ')} |`),
    `| **total** | ${total('ts_rank')}/${rows.length * TOP_K} | ${total('bm25_sql')}/${rows.length * TOP_K}${production ? ` | ${total('production')}/${rows.length * TOP_K}` : ''} | | |`,
    '',
  ];
  writeEvaluationOutputDirFile(args.outputDir, `rag-fulltext-compare-${stamp}.json`, `${JSON.stringify({ index: args.index, generated_at: stamp, rows }, null, 2)}\n`);
  writeEvaluationOutputDirFile(args.outputDir, `rag-fulltext-compare-${stamp}.md`, lines.join('\n'));
  if (args.exportQueries) writeEvaluationOutputDirFile(args.outputDir, 'rag-fulltext-queries.json', `${JSON.stringify({ rows: queries })}\n`);
  console.log(lines.slice(4).join('\n'));
  if (rows.some((row) => !row.offline_matches_cached_candidates)) console.log('Note: for some questions the offline top 16 differs from the cached rerank candidates (other index or glossary?).');
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
