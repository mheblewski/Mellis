/**
 * Loads a rag-index.json (scripts/evaluation/rag-corpus-ingest.ts; outside the repository, copyrighted text) into
 * rag_chunks as one corpus version, replacing the previous one in a single transaction. No AI calls.
 *
 *   node dist/infra/db/rag-index-load.js <rag-index.json> --corpus-version <name> [--dry-run]
 *
 * On the server it runs inside a one-shot container of the app image, so Postgres stays on the compose network
 * (the knowledge base built by scripts/install-server.sh, or one built with scripts/evaluation/rag-retrieval.ts). --dry-run parses and checks the file without connecting.
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { parseIndex } from '../../scripts/evaluation/rag-retrieval';
import { indexFileSha256, PostgresRagChunkStore, RAG_EMBEDDING_DIMENSIONS } from './postgres-rag-chunks.repository';

export interface LoadArgs {
  indexPath: string;
  corpusVersion: string;
  dryRun: boolean;
}

export function parseLoadArgs(argv: readonly string[]): LoadArgs {
  let indexPath: string | null = null;
  let corpusVersion: string | null = null;
  let dryRun = false;
  for (let position = 0; position < argv.length; position += 1) {
    const arg = argv[position];
    if (arg === '--dry-run') dryRun = true;
    else if (arg === '--corpus-version') {
      corpusVersion = argv[position + 1] ?? null;
      position += 1;
    } else if (arg.startsWith('--')) throw new Error(`Unknown flag ${arg}.`);
    else if (indexPath) throw new Error('Only one index file.');
    else indexPath = arg;
  }
  if (!indexPath || !corpusVersion) throw new Error('Usage: rag-index-load <rag-index.json> --corpus-version <name> [--dry-run]');
  return { indexPath, corpusVersion, dryRun };
}

async function main(): Promise<void> {
  const args = parseLoadArgs(process.argv.slice(2));
  const raw = readFileSync(args.indexPath);
  const index = parseIndex(raw.toString('utf8'));
  const sha256 = indexFileSha256(raw);
  console.log(`index: ${index.file.chunks.length} chunks, ${index.file.embedding_model}, ${index.file.dimensions} dimensions, created ${index.file.created_at}, sha256 ${sha256.slice(0, 12)}`);
  if (index.file.dimensions !== RAG_EMBEDDING_DIMENSIONS) throw new Error(`rag_chunks needs ${RAG_EMBEDDING_DIMENSIONS} dimensions.`);
  if (args.dryRun) return;

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const result = await new PostgresRagChunkStore(pool).replaceCorpus({ version: args.corpusVersion, index, indexSha256: sha256 });
    console.log(`loaded corpus ${result.version}: ${result.inserted} chunks (removed ${result.removed} of ${result.previousVersion ?? 'no previous version'})`);
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
