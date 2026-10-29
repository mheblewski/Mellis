/**
 * Read-only sample query against rag_chunks (hybrid: cosine per query vector plus BM25 over the English full-text index, fused).
 * Query vectors come from a JSON file (free: e.g. vectors the knowledge probe already cached) or, with --embed, from
 * one guarded embeddings call (paid, needs OPENAI_API_KEY and the embedding cost-guard variables).
 *
 *   node dist/infra/db/rag-query.js [--vector-file <json>] [--embed <text>] [--keywords <english text>]
 *     [--k 6] [--candidates 16] [--include-reference-lists]
 *
 * The vector file holds a number array (list "query") or an object of named number arrays ({ "pl": [...], "en": [...] }).
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { createGuardedOpenAiEmbeddingsClientFromEnv } from '@modules/ai-gateway/infrastructure/guarded-openai-client';
import { embedTexts } from '../../scripts/evaluation/rag-retrieval';
import { PostgresRagChunkStore, type RagSearchHit, type RagSearchQuery } from './postgres-rag-chunks.repository';

export interface QueryArgs {
  vectorFile: string | null;
  embedText: string | null;
  keywords: string | null;
  k: number;
  candidates: number;
  includeReferenceLists: boolean;
}

const VALUE_FLAGS = new Set(['--vector-file', '--embed', '--keywords', '--k', '--candidates']);

export function parseQueryArgs(argv: readonly string[]): QueryArgs {
  const args: QueryArgs = { vectorFile: null, embedText: null, keywords: null, k: 6, candidates: 16, includeReferenceLists: false };
  for (let position = 0; position < argv.length; position += 1) {
    const flag = argv[position];
    if (flag === '--include-reference-lists') {
      args.includeReferenceLists = true;
      continue;
    }
    if (!VALUE_FLAGS.has(flag)) throw new Error(`Unknown argument ${flag}.`);
    const value = argv[position + 1];
    if (value === undefined) throw new Error(`${flag} needs a value.`);
    position += 1;
    if (flag === '--vector-file') args.vectorFile = value;
    if (flag === '--embed') args.embedText = value;
    if (flag === '--keywords') args.keywords = value;
    if (flag === '--k') args.k = Number(value);
    if (flag === '--candidates') args.candidates = Number(value);
  }
  if (!args.vectorFile && !args.embedText && !args.keywords) throw new Error('Give --vector-file, --embed or --keywords.');
  return args;
}

/** Named query vectors from a vector file: a number array, or an object of number arrays. */
export function parseVectorFile(raw: string): RagSearchQuery['vectors'] {
  const parsed: unknown = JSON.parse(raw);
  const isVector = (value: unknown): value is number[] => Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === 'number');
  if (isVector(parsed)) return [{ name: 'query', embedding: parsed }];
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const entries = Object.entries(parsed as Record<string, unknown>);
    if (entries.length && entries.every(([, value]) => isVector(value))) return entries.map(([name, value]) => ({ name, embedding: value as number[] }));
  }
  throw new Error('Vector file must hold a number array or an object of number arrays.');
}

export function formatHits(hits: readonly RagSearchHit[]): string {
  return hits
    .map((hit) => {
      const { chunk } = hit;
      const pages = chunk.page === null ? '' : chunk.page_end && chunk.page_end !== chunk.page ? `, p. ${chunk.page}-${chunk.page_end}` : `, p. ${chunk.page}`;
      const ranks = Object.entries(hit.ranks).map(([name, rank]) => `${name} ${rank}`).join(', ');
      const cosine = hit.cosine === null ? '' : `, cos ${hit.cosine.toFixed(3)}`;
      const preview = chunk.text.replace(/\s+/g, ' ').slice(0, 160);
      return `${hit.rank}. ${chunk.title}${chunk.section ? ` / ${chunk.section}` : ''}${pages} [${chunk.id}]\n   rrf ${hit.score.toFixed(4)} (${ranks}${cosine})\n   ${preview}`;
    })
    .join('\n');
}

async function main(): Promise<void> {
  const args = parseQueryArgs(process.argv.slice(2));
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const store = new PostgresRagChunkStore(pool);
    const active = await store.activeVersion();
    if (!active) throw new Error('No corpus loaded (rag_corpus_versions has no active version).');
    console.log(`corpus ${active.version}: ${active.chunkCount} chunks, ${active.embeddingModel ?? 'full text only (no vectors)'}`);

    const vectors = [...(args.vectorFile ? parseVectorFile(readFileSync(args.vectorFile, 'utf8')) : [])];
    if (args.embedText) {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) throw new Error('--embed needs OPENAI_API_KEY.');
      if (!active.embeddingModel) throw new Error('--embed: the active corpus has no vectors (full text only); use --keywords.');
      const client = createGuardedOpenAiEmbeddingsClientFromEnv(process.env, apiKey);
      const [embedding] = await embedTexts(client, active.embeddingModel, [args.embedText]);
      vectors.push({ name: 'embedded', embedding });
    }
    const hits = await store.search({
      vectors,
      keywords: args.keywords ? { name: 'keywords', text: args.keywords } : null,
      k: args.k,
      candidates: args.candidates,
      includeReferenceLists: args.includeReferenceLists,
    });
    console.log(formatHits(hits));
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
