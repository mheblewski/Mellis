import 'dotenv/config';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import type { OpenAiEmbeddingsTransport } from '@modules/ai-gateway/infrastructure/guarded-openai-client';
import { assertPoolUsesIsolatedTestDatabase, configurePostgresIntegrationEnvironment, truncatePublicTablesForIntegrationTests } from './postgres-test-isolation';

const runPostgresIntegration = process.env.RUN_POSTGRES_INTEGRATION === '1';
const describePostgres = runPostgresIntegration ? describe.sequential : describe.skip;

configurePostgresIntegrationEnvironment(process.env);

const MIGRATIONS_DIR = resolve(__dirname, 'migrations');
const KNOWLEDGE_DIR = resolve(__dirname, '../../knowledge');
const RAG_MIGRATION = '036_rag_knowledge_index.sql';
const SHIPPED_MIGRATION = '095_knowledge_shipped_corpus.sql';
const SKIPPED_MIGRATIONS = new Set(['026_meal_supersession.sql']);

/**
 * Migrations as on a server. Without pgvector (local Homebrew Postgres) 036 cannot run: its tables are created from the
 * same file with `vector(1536)` as `real[]` (production-like apart from the column type; the vector search itself is
 * not exercised then) and 036 is marked applied, so 095 alters real tables. Other local specs mark 036 applied without
 * any table; then 095 was a no-op and is applied here by hand on the stand-in tables.
 */
async function migrate(pool: Pool): Promise<{ hasVector: boolean }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const hasVector = ((await client.query(`SELECT 1 FROM pg_available_extensions WHERE name = 'vector'`)).rowCount ?? 0) > 0;
    const hasTables = (await client.query<{ t: string | null }>(`SELECT to_regclass('rag_chunks')::text AS t`)).rows[0].t !== null;
    if (!hasVector && !hasTables) {
      const standIn = readFileSync(resolve(MIGRATIONS_DIR, RAG_MIGRATION), 'utf8')
        .replace(/DO \$\$[\s\S]*?\$\$;/, '')
        .replace('CREATE EXTENSION IF NOT EXISTS vector;', '')
        .replace('vector(1536)', 'real[]');
      await client.query(standIn);
      await client.query(`INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT DO NOTHING`, [RAG_MIGRATION]);
      const shippedApplied = ((await client.query('SELECT 1 FROM schema_migrations WHERE version = $1', [SHIPPED_MIGRATION])).rowCount ?? 0) > 0;
      if (shippedApplied) await client.query(readFileSync(resolve(MIGRATIONS_DIR, SHIPPED_MIGRATION), 'utf8'));
    }
    // The same loop as the other local Postgres specs (026 skipped there too, so they can share one database).
    for (const fileName of readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql')).sort()) {
      if (SKIPPED_MIGRATIONS.has(fileName)) continue;
      const applied = await client.query('SELECT 1 FROM schema_migrations WHERE version = $1', [fileName]);
      if ((applied.rowCount ?? 0) > 0) continue;
      await client.query(readFileSync(resolve(MIGRATIONS_DIR, fileName), 'utf8'));
      await client.query('INSERT INTO schema_migrations(version) VALUES ($1)', [fileName]);
    }
    await client.query('COMMIT');
    return { hasVector };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function stubEmbedder(): OpenAiEmbeddingsTransport {
  return {
    embeddings: {
      create: async (body: Record<string, unknown>) => ({
        data: (body.input as string[]).map((text, index) => {
          const vector = new Array<number>(1536).fill(0);
          vector[/keton/i.test(text) ? 0 : 1 + (text.length % 1000)] = 1;
          return { index, embedding: vector };
        }),
        usage: { prompt_tokens: 1 },
      }),
    },
  };
}

describePostgres('shipped knowledge base: build and search (postgres)', { timeout: 180_000 }, () => {
  let pool: Pool;
  let hasVector = false;
  let build: typeof import('./knowledge-build');
  let StoreClass: typeof import('./postgres-rag-chunks.repository').PostgresRagChunkStore;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
    await assertPoolUsesIsolatedTestDatabase(pool);
    ({ hasVector } = await migrate(pool));
    build = await import('./knowledge-build');
    StoreClass = (await import('./postgres-rag-chunks.repository')).PostgresRagChunkStore;
  });

  beforeEach(async () => {
    await truncatePublicTablesForIntegrationTests(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it('migration 095: the embedding column is nullable and chunks have url, licence, mode, publisher', async () => {
    const columns = await pool.query<{ table_name: string; column_name: string; is_nullable: string }>(
      `SELECT table_name, column_name, is_nullable FROM information_schema.columns
       WHERE table_name IN ('rag_chunks', 'rag_corpus_versions') AND column_name IN ('embedding', 'url', 'licence', 'source_mode', 'publisher', 'embedding_model', 'dimensions', 'source')`,
    );
    const nullable = Object.fromEntries(columns.rows.map((row) => [`${row.table_name}.${row.column_name}`, row.is_nullable]));
    expect(nullable).toMatchObject({
      'rag_chunks.embedding': 'YES',
      'rag_chunks.url': 'YES',
      'rag_chunks.licence': 'YES',
      'rag_chunks.source_mode': 'YES',
      'rag_chunks.publisher': 'YES',
      'rag_corpus_versions.embedding_model': 'YES',
      'rag_corpus_versions.dimensions': 'YES',
      'rag_corpus_versions.source': 'NO',
    });
  });

  it('builds the real knowledge/ folder full-text only, idempotently, and finds sources with their links by BM25', async () => {
    const store = new StoreClass(pool);
    const first = await build.runKnowledgeBuild({ store, dir: KNOWLEDGE_DIR, embeddings: null });
    expect(first).toMatchObject({ status: 'BUILT', mode: 'bm25' });
    const knowledge = build.readShippedKnowledge(KNOWLEDGE_DIR);

    const version = (await pool.query('SELECT version, embedding_model, dimensions, chunk_count, source, index_sha256 FROM rag_corpus_versions WHERE active')).rows[0];
    expect(version).toMatchObject({ version: first.corpus_version, embedding_model: null, dimensions: null, chunk_count: first.chunks, source: 'shipped-knowledge', index_sha256: knowledge.sha256 });
    const stats = (await pool.query(`SELECT count(*)::int AS chunks, count(embedding)::int AS vectors, count(url)::int AS urls,
      count(*) FILTER (WHERE source_file = ANY($1))::int AS skipped, count(*) FILTER (WHERE text ~ '(^|\\n)(licence|mode|corpus_v7): ')::int AS front_matter FROM rag_chunks`, [knowledge.skipped])).rows[0];
    expect(stats).toEqual({ chunks: first.chunks, vectors: 0, urls: first.chunks, skipped: 0, front_matter: 0 });

    expect(await build.runKnowledgeBuild({ store, dir: KNOWLEDGE_DIR, embeddings: null })).toMatchObject({ status: 'UNCHANGED', mode: 'bm25' });

    const { KnowledgeSearchService } = await import('@modules/knowledge/application/knowledge-search');
    const { FakeEmbeddingsClient, FakeLightModelClient } = await import('@modules/knowledge/infrastructure/fake-knowledge-search');
    const embeddings = new FakeEmbeddingsClient();
    const search = new KnowledgeSearchService({
      store,
      // Rewrite as the light model would; the rerank fails, so the fused (BM25) order is kept.
      lightClient: new FakeLightModelClient({ rewrite: 'sick day ketones extra insulin children', rerank: new Error('offline') }),
      // A key exists, but the corpus has no vectors: no embeddings call.
      embeddingsClient: embeddings,
      lightModel: 'light-test',
    });
    const outcome = await search.search({ query: 'Ketony 1,2 mmol/L w czasie choroby: ile dodatkowej insuliny?' });
    expect(outcome.status).toBe('FOUND');
    expect(embeddings.requests).toEqual([]);
    expect(outcome.diagnostics.embedding_status).toBe('SKIPPED');
    expect(outcome.fragments.length).toBe(6);
    expect(outcome.fragments.every((fragment) => /^https?:\/\//.test(fragment.url ?? ''))).toBe(true);
    expect(outcome.fragments.some((fragment) => fragment.source_file === 'ispad/ispad-2022-sick-day.md')).toBe(true);
    const sickDay = outcome.fragments.find((fragment) => fragment.source_file === 'ispad/ispad-2022-sick-day.md')!;
    expect(sickDay).toMatchObject({ source_mode: 'SUMMARY_ONLY' });

    const { citedKnowledgeSources, sanitizeKnowledgeSources } = await import('@modules/ai-gateway/application/knowledge-answer-rules');
    const ref = `S${outcome.fragments.indexOf(sickDay) + 1}`;
    const byRef = new Map(outcome.fragments.map((fragment, index) => [`S${index + 1}`, { fragment, corpus_version: outcome.corpus_version }]));
    const shown = sanitizeKnowledgeSources(citedKnowledgeSources(`Dodatkowa insulina [${ref}].`, byRef));
    expect(shown).toEqual([expect.objectContaining({ ref, title: sickDay.title, url: sickDay.url })]);
  });

  it('keeps a corpus loaded from rag-index.json (production) and replaces it only when asked', async () => {
    await pool.query(
      `INSERT INTO rag_corpus_versions (version, embedding_model, dimensions, chunk_count, index_sha256, active) VALUES ('private-corpus-v7', 'text-embedding-3-small', 1536, 0, 'prod', true)`,
    );
    const store = new StoreClass(pool);
    expect(await store.activeVersion()).toMatchObject({ version: 'private-corpus-v7', source: 'index-file' });
    expect(await build.runKnowledgeBuild({ store, dir: KNOWLEDGE_DIR, embeddings: null })).toMatchObject({ status: 'FOREIGN_CORPUS_KEPT', kept_version: 'private-corpus-v7' });
    expect((await pool.query('SELECT version FROM rag_corpus_versions WHERE active')).rows[0].version).toBe('private-corpus-v7');
    expect(await build.runKnowledgeBuild({ store, dir: KNOWLEDGE_DIR, embeddings: null, replaceForeign: true })).toMatchObject({ status: 'BUILT' });
  });

  it('with pgvector: a stub-embedded build is searched by vectors too', async () => {
    if (!hasVector) {
      // Local Postgres without pgvector: the vector path is covered by the unit tests and the dress rehearsal only.
      return;
    }
    const store = new StoreClass(pool);
    const built = await build.runKnowledgeBuild({ store, dir: KNOWLEDGE_DIR, embeddings: stubEmbedder() });
    expect(built).toMatchObject({ status: 'BUILT', mode: 'hybrid' });
    const query = new Array<number>(1536).fill(0);
    query[0] = 1;
    const hits = await store.search({ vectors: [{ name: 'pl', embedding: query }], keywords: { name: 'bm25', text: 'ketones sick day' }, candidates: 16, k: 6 });
    expect(hits.some((hit) => hit.cosine !== null)).toBe(true);
  });
});
