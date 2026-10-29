/**
 * Builds the local RAG index for the knowledge probe from a folder of source documents outside the repository
 * (ISPAD chapters, Trio / OpenAPS docs, Dexcom and SmPC text). Prototype on the Mac: nothing touches the server.
 *
 *   tsx scripts/evaluation/rag-corpus-ingest.ts --corpus-dir <dir> --output-dir <dir>          dry run: extract and chunk, no network
 *   tsx scripts/evaluation/rag-corpus-ingest.ts --corpus-dir <dir> --output-dir <dir> --live   also embed and write rag-index.json
 *     [--chunk-tokens 600] [--overlap-tokens 100] [--model text-embedding-3-small] [--reuse-index <old rag-index.json>]
 *
 * Supported files (recursively): .pdf (text via macOS PDFKit, rag-pdf-text.swift compiled into <output-dir>/tools),
 * .txt (pages split on form feeds or "=====PAGE=====" lines), .md, .html/.htm. An optional sources.json in the corpus
 * folder maps a relative file path to { "title": "...", "skip": true|false }; without it the file name is the title.
 * The dry run writes rag-chunks.json (chunks without vectors) for inspection. --live embeds through the guarded
 * embeddings client (cost guard and budget ledger from the environment, see createGuardedOpenAiEmbeddingsClientFromEnv).
 * --reuse-index takes the vectors of chunks whose text is unchanged from an earlier index of the same embedding model,
 * so after adding a file only its chunks are embedded (and the other chunks keep the vectors earlier runs were scored on).
 *
 *   tsx scripts/evaluation/rag-corpus-ingest.ts --shipped-knowledge --output-dir <dir> [--live]
 * reads the knowledge base shipped in this repository (knowledge/, licence-checked front matter) instead of a
 * --corpus-dir: front matter stripped, LINK_ONLY / index: false skipped, the chunks as `mellis-admin knowledge-build`
 * makes them on a server (infra/db/knowledge-build.ts). Only that folder is allowed inside the working tree: --corpus-dir
 * keeps refusing any folder inside a Git working tree.
 */
import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { createGuardedOpenAiEmbeddingsClientFromEnv, type OpenAiEmbeddingsTransport } from '@modules/ai-gateway/infrastructure/guarded-openai-client';
import { AiProviderError } from '@modules/ai-gateway/infrastructure/ai-provider.error';
import { assertEvaluationCaptureOutsideRepository, findRepositoryRoot } from '@modules/ai-gateway/infrastructure/evaluation-capture-path';
import { describeErrorSafely, ensureEvaluationOutputDir, resolveEvaluationOutputDir, writeEvaluationOutputDirFile } from './evaluation-output-dir';
import { buildKnowledgeChunks, readShippedKnowledge } from '../../infra/db/knowledge-build';
import {
  DEFAULT_CHUNKING,
  DEFAULT_EMBEDDING_MODEL,
  RAG_INDEX_VERSION,
  RagIndexError,
  chunkDocument,
  embedTexts,
  encodeVector,
  parseIndex,
  splitPages,
  type ChunkingOptions,
  type RagChunk,
  type RagIndexFile,
  type SourceDocument,
} from './rag-retrieval';

export class IngestArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IngestArgumentError';
  }
}

const SUPPORTED = new Set(['.pdf', '.txt', '.md', '.html', '.htm']);
const MANIFEST_FILE = 'sources.json';
const KNOWN_FLAGS = new Set(['--corpus-dir', '--shipped-knowledge', '--output-dir', '--live', '--chunk-tokens', '--overlap-tokens', '--model', '--reuse-index']);
const VALUE_FLAGS = new Set(['--corpus-dir', '--output-dir', '--chunk-tokens', '--overlap-tokens', '--model', '--reuse-index']);
/** text-embedding-3-small accepts 8191 tokens per input; chunks are far smaller, this only catches extraction junk. */
const MAX_CHUNK_TOKENS = 2000;

interface ManifestEntry {
  title?: string;
  skip?: boolean;
}

/** Extracts the page texts of one PDF; injectable so tests need no PDFKit. */
export type PdfTextExtractor = (pdfPath: string) => string;

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|nav|header|footer)[\s\S]*?<\/\1>/gi, '')
    .replace(/<h([1-4])[^>]*>([\s\S]*?)<\/h\1>/gi, (_match, level: string, inner: string) => `\n${'#'.repeat(Number(level))} ${inner.replace(/<[^>]+>/g, '').trim()}\n`)
    .replace(/<(br|\/p|\/li|\/tr|\/div|\/h[1-6]|\/table)[^>]*>/gi, '\n')
    .replace(/<(td|th)[^>]*>/gi, ' | ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/\n{3,}/g, '\n\n');
}

function listFiles(dir: string, root: string = dir): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      if (entry.name.startsWith('.')) return [];
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return listFiles(path, root);
      return entry.isFile() ? [relative(root, path)] : [];
    });
}

function readManifest(corpusDir: string): Record<string, ManifestEntry> {
  const path = join(corpusDir, MANIFEST_FILE);
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    return parsed as Record<string, ManifestEntry>;
  } catch {
    throw new IngestArgumentError(`${MANIFEST_FILE} must be a JSON object mapping file paths to { "title", "skip" }.`);
  }
}

export function loadCorpus(corpusDir: string, extractPdf: PdfTextExtractor): { documents: SourceDocument[]; skipped: string[] } {
  const manifest = readManifest(corpusDir);
  const documents: SourceDocument[] = [];
  const skipped: string[] = [];
  for (const file of listFiles(corpusDir)) {
    if (file === MANIFEST_FILE) continue;
    const extension = extname(file).toLowerCase();
    const entry = manifest[file] ?? {};
    if (!SUPPORTED.has(extension) || entry.skip) {
      skipped.push(file);
      continue;
    }
    const path = join(corpusDir, file);
    const title = entry.title?.trim() || file.replace(/\.[^.]+$/, '');
    if (extension === '.pdf') {
      documents.push({ source_file: file, title, pages: splitPages(extractPdf(path)), paged: true });
    } else if (extension === '.txt') {
      const pages = splitPages(readFileSync(path, 'utf8'));
      documents.push({ source_file: file, title, pages, paged: pages.length > 1 });
    } else {
      const raw = readFileSync(path, 'utf8');
      documents.push({ source_file: file, title, pages: [extension === '.md' ? raw : htmlToText(raw)], paged: false });
    }
  }
  return { documents, skipped };
}

/** Compiles rag-pdf-text.swift once into <output-dir>/tools and returns an extractor that uses it. */
function pdfKitExtractor(outputDir: string): PdfTextExtractor {
  let binary: string | null = null;
  return (pdfPath) => {
    if (!binary) {
      const source = resolve(__dirname, 'rag-pdf-text.swift');
      const toolsDir = join(ensureEvaluationOutputDir(outputDir), 'tools');
      writeEvaluationOutputDirFile(outputDir, 'tools/.keep', '');
      binary = join(toolsDir, 'rag-pdf-text');
      if (!existsSync(binary) || statSync(binary).mtimeMs < statSync(source).mtimeMs) {
        execFileSync('swiftc', ['-O', '-o', binary, source], { stdio: 'ignore' });
      }
    }
    const target = join(outputDir, 'tools', 'extracted.txt');
    execFileSync(binary, [pdfPath, target], { stdio: 'ignore' });
    return readFileSync(target, 'utf8');
  };
}

interface ParsedArgs {
  /** null with shippedKnowledge. */
  corpusDir: string | null;
  shippedKnowledge: boolean;
  live: boolean;
  chunking: ChunkingOptions;
  model: string;
  reuseIndex: string | null;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  let corpusDir: string | null = null;
  let live = false;
  let shippedKnowledge = false;
  const chunking = { ...DEFAULT_CHUNKING };
  let model = DEFAULT_EMBEDDING_MODEL;
  let reuseIndex: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const flag = arg.split('=')[0];
    if (!KNOWN_FLAGS.has(flag)) throw new IngestArgumentError(`Unknown argument ${arg.slice(0, 40)}.`);
    let value: string | undefined;
    if (VALUE_FLAGS.has(flag)) {
      value = arg.includes('=') ? arg.slice(flag.length + 1) : argv[(index += 1)];
      if (!value) throw new IngestArgumentError(`Missing value for ${flag}.`);
    }
    if (flag === '--corpus-dir') corpusDir = value!;
    if (flag === '--live') live = true;
    if (flag === '--shipped-knowledge') shippedKnowledge = true;
    if (flag === '--model') model = value!;
    if (flag === '--reuse-index') reuseIndex = value!;
    if (flag === '--chunk-tokens') chunking.target_tokens = Number(value);
    if (flag === '--overlap-tokens') chunking.overlap_tokens = Number(value);
  }
  if (shippedKnowledge && corpusDir) throw new IngestArgumentError('Use --corpus-dir or --shipped-knowledge, not both.');
  if (!corpusDir && !shippedKnowledge) throw new IngestArgumentError('Missing --corpus-dir (a folder outside the repository) or --shipped-knowledge.');
  if (!(Number.isInteger(chunking.target_tokens) && chunking.target_tokens >= 100 && chunking.target_tokens <= MAX_CHUNK_TOKENS)) {
    throw new IngestArgumentError(`--chunk-tokens must be an integer between 100 and ${MAX_CHUNK_TOKENS}.`);
  }
  if (!(Number.isInteger(chunking.overlap_tokens) && chunking.overlap_tokens >= 0 && chunking.overlap_tokens < chunking.target_tokens / 2)) {
    throw new IngestArgumentError('--overlap-tokens must be an integer below half of --chunk-tokens.');
  }
  return { corpusDir, shippedKnowledge, live, chunking, model, reuseIndex };
}

/** Vectors of an earlier index by chunk text; refuses an index of another embedding model. */
function reusableVectors(path: string, model: string): Map<string, string> {
  if (!existsSync(path)) throw new IngestArgumentError('--reuse-index: file not found.');
  const old = parseIndex(readFileSync(path, 'utf8'));
  if (old.file.embedding_model !== model) throw new IngestArgumentError(`--reuse-index was built with ${old.file.embedding_model}, not ${model}.`);
  return new Map(old.file.chunks.map((chunk) => [chunk.text, chunk.embedding_b64]));
}

function resolveCorpusDir(value: string): string {
  // Copyrighted sources stay out of every Git working tree, like the probe's excerpts.
  let dir: string;
  try {
    dir = assertEvaluationCaptureOutsideRepository(resolve(value), findRepositoryRoot(__dirname));
  } catch (error) {
    throw new IngestArgumentError(`--corpus-dir must be outside every Git working tree (${describeErrorSafely(error)}).`);
  }
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new IngestArgumentError('--corpus-dir is not a directory.');
  return dir;
}

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  overrides: { embeddings?: OpenAiEmbeddingsTransport; extractPdf?: PdfTextExtractor; now?: () => Date } = {},
): Promise<void> {
  const outputDir = resolveEvaluationOutputDir(argv);
  const args = parseArgs(argv);
  let documents: Array<{ source_file: string; pages: string[] }>;
  let skipped: string[];
  let chunks: RagChunk[];
  if (args.shippedKnowledge) {
    // The repository's own knowledge/ only (never a path from the command line): its licences allow it in the tree.
    const root = findRepositoryRoot(__dirname);
    if (!root) throw new IngestArgumentError('--shipped-knowledge runs from a checkout of the repository.');
    const knowledge = readShippedKnowledge(resolve(root, 'knowledge'), args.chunking);
    documents = knowledge.indexed.map((document) => ({ source_file: document.path, pages: [document.body] }));
    skipped = knowledge.skipped;
    chunks = buildKnowledgeChunks(knowledge, args.chunking);
  } else {
    const corpusDir = resolveCorpusDir(args.corpusDir as string);
    const loaded = loadCorpus(corpusDir, overrides.extractPdf ?? pdfKitExtractor(outputDir));
    documents = loaded.documents;
    skipped = loaded.skipped;
    chunks = loaded.documents.flatMap((document) => chunkDocument(document, args.chunking));
  }
  if (!chunks.length) throw new IngestArgumentError('No text found in --corpus-dir.');
  const bytes = chunks.reduce((sum, chunk) => sum + Buffer.byteLength(chunk.text, 'utf8'), 0);
  const tokens = chunks.reduce((sum, chunk) => sum + chunk.tokens_estimate, 0);

  writeEvaluationOutputDirFile(outputDir, 'rag-chunks.json', `${JSON.stringify({ chunking: args.chunking, chunks }, null, 2)}\n`);
  for (const document of documents) {
    const own = chunks.filter((chunk) => chunk.source_file === document.source_file);
    console.log(`${document.source_file}: ${document.pages.length} page(s), ${own.length} chunk(s)`);
  }
  if (skipped.length) console.log(`Skipped: ${skipped.join(', ')}`);
  console.log(`Documents: ${documents.length}, chunks: ${chunks.length}, tokens ≈ ${tokens}, worst-case embedding tokens (bytes): ${bytes}. Chunks written: rag-chunks.json.`);
  const reused = args.reuseIndex ? reusableVectors(args.reuseIndex, args.model) : new Map<string, string>();
  const missing = chunks.filter((chunk) => !reused.has(chunk.text));
  if (args.reuseIndex) {
    const missingBytes = missing.reduce((sum, chunk) => sum + Buffer.byteLength(chunk.text, 'utf8'), 0);
    console.log(`Reused vectors: ${chunks.length - missing.length}; to embed: ${missing.length} chunk(s), ${missingBytes} bytes.`);
  }
  if (!args.live) {
    console.log('Dry run: nothing sent. Add --live to embed and write rag-index.json.');
    return;
  }

  let client = overrides.embeddings;
  if (!client && missing.length) {
    const apiKey = process.env.OPENAI_API_KEY?.trim();
    if (!apiKey) throw new IngestArgumentError('OPENAI_API_KEY is required for --live.');
    try {
      client = createGuardedOpenAiEmbeddingsClientFromEnv(process.env, apiKey);
    } catch (error) {
      throw new IngestArgumentError(error instanceof Error ? error.message : 'OpenAI embeddings cost guard is not configured.');
    }
  }
  const embedded = missing.length
    ? await embedTexts(client!, args.model, missing.map((chunk) => chunk.text), (done, total) => console.log(`Embedded batch ${done}/${total}.`))
    : [];
  const vectors = new Map(reused);
  missing.forEach((chunk, position) => vectors.set(chunk.text, encodeVector(embedded[position])));
  const encoded = chunks.map((chunk) => vectors.get(chunk.text)!);
  const dimensions = Buffer.from(encoded[0], 'base64').length / 4;
  if (encoded.some((vector) => Buffer.from(vector, 'base64').length / 4 !== dimensions)) throw new RagIndexError('Reused and new embeddings have different dimensions.');
  const index: RagIndexFile = {
    version: RAG_INDEX_VERSION,
    embedding_model: args.model,
    dimensions,
    created_at: (overrides.now?.() ?? new Date()).toISOString(),
    chunking: args.chunking,
    chunks: chunks.map((chunk, position) => ({ ...chunk, embedding_b64: encoded[position] })),
  };
  writeEvaluationOutputDirFile(outputDir, 'rag-index.json', `${JSON.stringify(index)}\n`);
  console.log(`Index written: rag-index.json (${chunks.length} chunks, ${index.dimensions} dimensions).`);
}

if (require.main === module) {
  void main().catch((error) => {
    console.error(describeErrorSafely(error, [IngestArgumentError, RagIndexError, AiProviderError]));
    process.exitCode = 1;
  });
}
