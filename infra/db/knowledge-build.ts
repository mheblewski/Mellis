/**
 * Builds the search index of the knowledge base shipped in the app image (knowledge/, see knowledge/README.md) on the
 * user's own server: `mellis-admin knowledge-build`, run by install-server.sh after the setup and by `mellis update`.
 *
 *   - Reads only the shipped, licence-checked folder: every document needs valid front matter (knowledge-manifest.ts
 *     checks); LINK_ONLY and `index: false` documents (and those sources.json marks skip) are not indexed.
 *   - The front matter is stripped before chunking; each chunk keeps the document's title, url, licence, mode and
 *     publisher, so an answer's sources show the title and link to the original.
 *   - Without an OpenAI key: chunks without vectors, searched by full text (BM25) only, no AI call. With a key: the
 *     chunks are embedded with the user's key through the guarded embeddings client (cost guard + the server's budget
 *     ledger); a failed or refused embedding falls back to the full-text build.
 *   - Idempotent: the corpus hash (files + chunking + build version) is stored as the version's index_sha256; nothing is
 *     rebuilt while it is unchanged and the wanted mode is already there (a key added later embeds the same corpus).
 *   - Never replaces a corpus it did not build (rag_corpus_versions.source = 'index-file', e.g. production's own corpus
 *     loaded from rag-index.json) unless asked with replaceForeign.
 *
 * This is separate from scripts/evaluation/rag-corpus-ingest.ts, which keeps refusing corpora inside a Git working tree
 * (copyrighted probe sources); this path only accepts the shipped folder's own documents.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { OpenAiEmbeddingsTransport } from '@modules/ai-gateway/infrastructure/guarded-openai-client';
import { checkKnowledge, loadKnowledge, type KnowledgeDocument } from '../../scripts/knowledge/knowledge-manifest';
import { chunkDocument, DEFAULT_CHUNKING, DEFAULT_EMBEDDING_MODEL, embedTexts, type ChunkingOptions } from '../../scripts/evaluation/rag-retrieval';
import { RAG_EMBEDDING_DIMENSIONS, type ActiveRagCorpus, type CorpusLoadResult, type RagCorpusSource, type StorableRagChunk } from './postgres-rag-chunks.repository';

/** Bump when chunking or the stored metadata changes: every server then rebuilds once. */
export const KNOWLEDGE_BUILD_VERSION = 'knowledge-build.v1';
export const KNOWLEDGE_VERSION_PREFIX = 'mellis-knowledge-';
const MANIFEST_FILE = 'sources.json';

export class KnowledgeBuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KnowledgeBuildError';
  }
}

/** The shipped folder: MELLIS_KNOWLEDGE_DIR, else knowledge/ under the working directory (/app/knowledge in the image). */
export function resolveKnowledgeDir(env: Record<string, string | undefined>, cwd: string = process.cwd()): string {
  return resolve(env.MELLIS_KNOWLEDGE_DIR?.trim() || join(cwd, 'knowledge'));
}

export interface ShippedKnowledge {
  dir: string;
  documents: KnowledgeDocument[];
  /** Documents that go into the index. */
  indexed: KnowledgeDocument[];
  /** Paths left out: LINK_ONLY, index: false, or skip in sources.json. */
  skipped: string[];
  /** sha256 over the build version, the chunking and every file of the folder that matters. */
  sha256: string;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** Reads and checks the shipped folder; throws KnowledgeBuildError naming every problem. */
export function readShippedKnowledge(dir: string, chunking: ChunkingOptions = DEFAULT_CHUNKING): ShippedKnowledge {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new KnowledgeBuildError(`Knowledge folder not found: ${dir}`);
  let documents: KnowledgeDocument[];
  try {
    documents = loadKnowledge(dir);
  } catch (error) {
    throw new KnowledgeBuildError(`Knowledge folder is not readable: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!documents.length) throw new KnowledgeBuildError(`No knowledge documents in ${dir}`);
  const problems = checkKnowledge(documents);
  if (problems.length) throw new KnowledgeBuildError(`Knowledge documents with problems:\n${problems.slice(0, 20).join('\n')}`);

  const manifestPath = join(dir, MANIFEST_FILE);
  const manifestRaw = existsSync(manifestPath) ? readFileSync(manifestPath, 'utf8') : '';
  let manifest: Record<string, { skip?: boolean }> = {};
  if (manifestRaw) {
    try {
      manifest = JSON.parse(manifestRaw) as Record<string, { skip?: boolean }>;
    } catch {
      throw new KnowledgeBuildError(`${MANIFEST_FILE} is not valid JSON`);
    }
  }
  const skippedByMeta = (document: KnowledgeDocument) => document.meta.mode === 'LINK_ONLY' || document.meta.index === false || manifest[document.path]?.skip === true;
  const indexed = documents.filter((document) => !skippedByMeta(document));
  const skipped = documents.filter(skippedByMeta).map((document) => document.path);

  const hash = createHash('sha256').update(`${KNOWLEDGE_BUILD_VERSION}\n${JSON.stringify(chunking)}\n`);
  for (const document of documents) hash.update(`${document.path}\0${readFileSync(join(dir, document.path))}\0`);
  hash.update(manifestRaw);
  return { dir, documents, indexed, skipped, sha256: hash.digest('hex') };
}

/** The chunks of the indexed documents: front matter stripped (body only), source metadata on every chunk. */
export function buildKnowledgeChunks(knowledge: Pick<ShippedKnowledge, 'indexed'>, chunking: ChunkingOptions = DEFAULT_CHUNKING): StorableRagChunk[] {
  return knowledge.indexed.flatMap((document) => {
    const mode: 'SHIP_TEXT' | 'SUMMARY_ONLY' | null = document.meta.mode === 'SHIP_TEXT' || document.meta.mode === 'SUMMARY_ONLY' ? document.meta.mode : null;
    const meta = {
      url: text(document.meta.url),
      licence: text(document.meta.licence),
      source_mode: mode,
      publisher: text(document.meta.publisher),
    };
    return chunkDocument({ source_file: document.path, title: String(document.meta.title), pages: [document.body], paged: false }, chunking)
      .map((chunk) => ({ ...chunk, ...meta }));
  });
}

export function knowledgeCorpusVersion(sha256: string): string {
  return `${KNOWLEDGE_VERSION_PREFIX}${sha256.slice(0, 16)}`;
}

/** What the build needs from PostgresRagChunkStore. */
export interface KnowledgeBuildStore {
  activeVersion(): Promise<ActiveRagCorpus | null>;
  replaceCorpusChunks(input: {
    version: string;
    source: RagCorpusSource;
    embeddingModel: string | null;
    chunks: readonly StorableRagChunk[];
    vectors: ReadonlyArray<ArrayLike<number>> | null;
    indexSha256: string;
    createdAt: string | null;
  }): Promise<CorpusLoadResult>;
}

export type KnowledgeBuildStatus = 'BUILT' | 'UNCHANGED' | 'FOREIGN_CORPUS_KEPT';
export type KnowledgeSearchMode = 'hybrid' | 'bm25';

export interface KnowledgeBuildResult {
  status: KnowledgeBuildStatus;
  corpus_version: string;
  /** The search mode of the corpus that is active after the build. */
  mode: KnowledgeSearchMode;
  documents: number;
  indexed_documents: number;
  skipped_documents: number;
  chunks: number | null;
  /** Why the build fell back to full text although an embeddings client was given (refused, failed). */
  embedding_error: string | null;
  /** The active corpus that was kept (FOREIGN_CORPUS_KEPT, UNCHANGED). */
  kept_version: string | null;
}

export interface KnowledgeBuildInput {
  store: KnowledgeBuildStore;
  dir: string;
  /** null: full-text build (no OpenAI key). */
  embeddings: OpenAiEmbeddingsTransport | null;
  embeddingModel?: string;
  /** Rebuild even when nothing changed. */
  force?: boolean;
  /** Replace a corpus this command did not build (production's own index). */
  replaceForeign?: boolean;
  chunking?: ChunkingOptions;
  now?: () => Date;
  log?: (line: string) => void;
}

export async function runKnowledgeBuild(input: KnowledgeBuildInput): Promise<KnowledgeBuildResult> {
  const chunking = input.chunking ?? DEFAULT_CHUNKING;
  const log = input.log ?? (() => undefined);
  const knowledge = readShippedKnowledge(input.dir, chunking);
  const version = knowledgeCorpusVersion(knowledge.sha256);
  const counts = { documents: knowledge.documents.length, indexed_documents: knowledge.indexed.length, skipped_documents: knowledge.skipped.length };
  const active = await input.store.activeVersion();

  if (active && active.source !== 'shipped-knowledge' && !input.replaceForeign) {
    log(`kept corpus ${active.version}: not built by knowledge-build (pass --replace-foreign to replace it)`);
    return { status: 'FOREIGN_CORPUS_KEPT', corpus_version: version, mode: active.embeddingModel ? 'hybrid' : 'bm25', ...counts, chunks: null, embedding_error: null, kept_version: active.version };
  }
  const wantVectors = input.embeddings !== null;
  const activeHasVectors = !!active?.embeddingModel;
  if (!input.force && active && active.source === 'shipped-knowledge' && active.indexSha256 === knowledge.sha256 && (activeHasVectors || !wantVectors)) {
    return { status: 'UNCHANGED', corpus_version: active.version, mode: activeHasVectors ? 'hybrid' : 'bm25', ...counts, chunks: active.chunkCount, embedding_error: null, kept_version: active.version };
  }

  const chunks = buildKnowledgeChunks(knowledge, chunking);
  if (!chunks.length) throw new KnowledgeBuildError('The knowledge documents produced no chunks.');
  log(`${knowledge.indexed.length} documents (${knowledge.skipped.length} not indexed), ${chunks.length} chunks`);

  const model = input.embeddingModel ?? DEFAULT_EMBEDDING_MODEL;
  let vectors: number[][] | null = null;
  let embeddingError: string | null = null;
  if (input.embeddings) {
    try {
      vectors = await embedTexts(input.embeddings, model, chunks.map((chunk) => chunk.text), (done, total) => log(`embedded batch ${done}/${total}`));
      if (vectors[0]?.length !== RAG_EMBEDDING_DIMENSIONS) throw new KnowledgeBuildError(`${model} returned ${vectors[0]?.length} dimensions, rag_chunks needs ${RAG_EMBEDDING_DIMENSIONS}.`);
    } catch (error) {
      vectors = null;
      // Class and code only: provider messages may echo request content.
      const details = error as { name?: unknown; code?: unknown; message?: unknown } | null;
      embeddingError = [typeof details?.name === 'string' ? details.name : 'Error', typeof details?.code === 'string' ? details.code : null].filter(Boolean).join(': ');
      if (error instanceof KnowledgeBuildError) embeddingError = error.message;
      log(`embeddings failed (${embeddingError}): full-text build`);
    }
  }

  // The same corpus already searchable by full text and the embedding failed again: keep it, nothing to gain.
  if (!vectors && !input.force && active?.source === 'shipped-knowledge' && active.indexSha256 === knowledge.sha256) {
    return { status: 'UNCHANGED', corpus_version: active.version, mode: activeHasVectors ? 'hybrid' : 'bm25', ...counts, chunks: active.chunkCount, embedding_error: embeddingError, kept_version: active.version };
  }

  const result = await input.store.replaceCorpusChunks({
    version,
    source: 'shipped-knowledge',
    embeddingModel: vectors ? model : null,
    chunks,
    vectors,
    indexSha256: knowledge.sha256,
    createdAt: (input.now?.() ?? new Date()).toISOString(),
  });
  log(`loaded corpus ${result.version}: ${result.inserted} chunks (removed ${result.removed} of ${result.previousVersion ?? 'no previous version'})`);
  return { status: 'BUILT', corpus_version: version, mode: vectors ? 'hybrid' : 'bm25', ...counts, chunks: result.inserted, embedding_error: embeddingError, kept_version: null };
}
