/**
 * One knowledge search exactly as the assistant runs it (rewrite, embeddings, Postgres hybrid search, rerank), for
 * checking a deployment. Paid: up to three guarded calls (light model twice, embeddings once, ~0.002 USD) against the
 * budget ledger of the environment. Prints the outcome, diagnostics and fragment labels (no fragment text).
 *
 *   docker compose exec worker node dist/infra/db/knowledge-search-check.js "<question>"
 *
 * Needs the same environment as the worker with AI_ENABLE_KNOWLEDGE_SEARCH=1 (deploy/.env.production.example).
 */
import 'dotenv/config';
import { Pool } from 'pg';
import { chunkLabel } from '@modules/knowledge/application/knowledge-query';
import { buildKnowledgeSearch } from '@modules/knowledge/infrastructure/knowledge-services.factory';

async function main(): Promise<void> {
  const question = process.argv.slice(2).join(' ').trim();
  if (!question) throw new Error('Usage: knowledge-search-check "<question>"');
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const logger = { log: (message: string) => console.log(message), warn: (message: string) => console.warn(message) };
    const search = buildKnowledgeSearch(process.env, pool, logger);
    if (!search) throw new Error('Knowledge search is off or not configured (see the log line above).');
    const outcome = await search.search({ query: question });
    console.log(JSON.stringify({ status: outcome.status, unavailable_reason: outcome.unavailable_reason, corpus_version: outcome.corpus_version, diagnostics: outcome.diagnostics }, null, 2));
    outcome.fragments.forEach((fragment, position) => console.log(`[S${position + 1}] ${chunkLabel(fragment)} (${fragment.chunk_id})`));
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
