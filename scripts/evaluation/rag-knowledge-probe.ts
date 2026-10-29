/**
 * RAG knowledge probe: does a pasted source fragment improve the model's answers to general type 1 diabetes questions?
 * For each question in rag-knowledge-probe.questions.json the model answers
 *   A: without a source,
 *   B: with the fragment pasted for that question (ideal retrieval),
 *   C (--with-mismatch): with another question's fragment (wrong retrieval; the model should say it does not apply),
 *   R (--retrieved-index): instead of A/B/C, with the top-k chunks a real retriever returns from the local index built
 *     by rag-corpus-ingest.ts, pasted as [S1..Sk]. Retrieval takes the top --candidates chunks of every list (cosine
 *     for the Polish question; with --rewrite-query also cosine and BM25 for an English search query written by one
 *     cheap model call) and fuses them by reciprocal rank (rag-retrieval.ts retrieveHybrid). --expand-query adds English
 *     terms from modules/knowledge/domain/query-glossary.json (PL↔EN synonyms such as ketony → ketones/BOHB, WBT → FPU) to the BM25 query.
 *     After fusion, --max-per-source N keeps at most N chunks of one file, --diversity λ picks the top-k by maximal
 *     marginal relevance (near-duplicate pages of one guide make room for other sources), and --rerank lets one cheap
 *     model call per question choose the top-k from the fused --candidates (cached in <output-dir>/query-reranks.json).
 * The report puts the answers side by side with the question's key points and red flags for manual scoring. No patient
 * data is sent. Fragments come from published sources and stay outside the repository (copyright), in
 * <output-dir>/excerpts.json.
 *
 * Usage:
 *   tsx scripts/evaluation/rag-knowledge-probe.ts --output-dir <dir> --init-excerpts   writes the excerpts.json template
 *   tsx scripts/evaluation/rag-knowledge-probe.ts --output-dir <dir>                   dry run: validates, no network
 *   tsx scripts/evaluation/rag-knowledge-probe.ts --output-dir <dir> --live [--with-mismatch] [--only Q01,Q05] [--model <id>]
 *   tsx scripts/evaluation/rag-knowledge-probe.ts --output-dir <dir> --retrieved-index <rag-index.json> [--top-k 6]
 *     [--candidates 16] [--rewrite-query [--rewrite-model <id>]] [--expand-query] [--max-per-source N] [--diversity λ | --rerank
 *     [--rerank-model <id>]] [--retrieval-only] [--live] [--only ...] [--model <id>] [--repeat N]
 * --repeat N (with --only, retrieved mode) asks each selected question N times with the same fragments, to measure how
 * much the answers vary between identical calls (in v3, Q02 changed with unchanged retrieval).
 * In retrieved mode the questions (and their rewrites) are embedded once (guarded embeddings client; vectors cached in
 * <output-dir>/query-embeddings.json), rewrites are cached in <output-dir>/query-rewrites.json (per model and prompt
 * version), --retrieval-only writes the retrieval report without calling the chat model, and the dry run (without
 * --live) only reports what would be sent. The rewrite and rerank models default to OPENAI_LIGHT_MODEL with the
 * OPENAI_LIGHT_PRICING_* prices (same cost guard limits and ledger), else to the chat model.
 * Live calls go through the guarded client (cost guard and budget ledger from the worker's environment variables);
 * the model defaults to OPENAI_MODEL. The run stops at the first refused or failed call and still writes the report.
 */
import 'dotenv/config';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createGuardedOpenAiClientFromEnv,
  createGuardedOpenAiEmbeddingsClientFromEnv,
  type OpenAiEmbeddingsTransport,
  type OpenAiResponsesTransport,
} from '@modules/ai-gateway/infrastructure/guarded-openai-client';
import { AiProviderError } from '@modules/ai-gateway/infrastructure/ai-provider.error';
import { describeErrorSafely, resolveEvaluationOutputDir, writeEvaluationOutputDirFile } from './evaluation-output-dir';
import {
  RagIndexError,
  embedTexts,
  parseIndex,
  queryCacheKey,
  retrieveHybrid,
  type LoadedIndex,
  type RetrievedChunk,
} from './rag-retrieval';
import {
  QUERY_GLOSSARY,
  QUERY_GLOSSARY_VERSION,
  RERANK_PROMPT_VERSION,
  REWRITE_PROMPT_VERSION,
  applyRerank,
  buildRerankRequest,
  buildRewriteRequest,
  chunkLabel,
  glossaryExpansion,
  parseRerank,
  parseRewrite,
  responseOutputText as outputText,
  type GlossaryEntry,
} from '@modules/knowledge/application/knowledge-query';
import questionSet from './rag-knowledge-probe.questions.json';

// Query helpers live in the knowledge module (the assistant uses the same prompts); re-exported for the probe's tests.
export { RERANK_PROMPT_VERSION, REWRITE_PROMPT_VERSION, applyRerank, buildRerankRequest, buildRewriteRequest, parseRerank, parseRewrite };

export class ProbeArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProbeArgumentError';
  }
}

export interface ProbeQuestion {
  id: string;
  category: string;
  probe: string;
  question: string;
  excerpt_instruction?: string;
  key_points: string[];
  red_flags: string[];
  source_hint: string;
}

export interface ExcerptEntry {
  id: string;
  question: string;
  source_hint: string;
  excerpt_instruction?: string;
  source_label: string;
  excerpt: string;
}

type Variant = 'A_no_source' | 'B_matching_source' | 'C_mismatched_source' | 'R_retrieved_sources';

export interface RetrievalHit {
  rank: number;
  score: number;
  chunk_id: string;
  label: string;
  preview: string;
  ranks?: Record<string, number>;
}

interface VariantResult {
  variant: Variant;
  source_from: string | null;
  /** With --repeat: which of the identical calls this is (1-based). */
  repeat?: number;
  retrieved?: RetrievalHit[];
  answer: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  error: string | null;
}

const EXCERPTS_FILE = 'excerpts.json';
/** A few retrieved chunks; a longer paste no longer simulates what a retriever would return. */
const MAX_EXCERPT_CHARS = 6000;
const RETRIEVED_FLAGS = [
  '--retrieved-index', '--top-k', '--candidates', '--retrieval-only', '--rewrite-query', '--rewrite-model', '--expand-query', '--repeat',
  '--max-per-source', '--diversity', '--rerank', '--rerank-model',
];
const KNOWN_FLAGS = new Set(['--output-dir', '--init-excerpts', '--live', '--with-mismatch', '--only', '--model', ...RETRIEVED_FLAGS]);
const VALUE_FLAGS = new Set(['--output-dir', '--only', '--model', '--retrieved-index', '--top-k', '--candidates', '--rewrite-model', '--repeat', '--max-per-source', '--diversity', '--rerank-model']);
/** Identical calls per question with --repeat; enough to see whether an answer flips, few enough to stay cheap. */
const MAX_REPEAT = 5;
export const GLOSSARY: readonly GlossaryEntry[] = QUERY_GLOSSARY;
/**
 * Chunks pasted into the prompt: a few more than one good chunk, few enough that off-target ones do not dominate. In the
 * v2 run (top-5) the answer chunks of Q06 (sick day 8.3.2) and Q09 (exercise 8.2) were 6th after fusion.
 */
const DEFAULT_TOP_K = 6;
const MAX_TOP_K = 6;
/** Candidates per list before fusion; the right chunk was at ranks 5–10 for 6 of 25 questions in the first run. */
const DEFAULT_CANDIDATES = 16;
const MAX_CANDIDATES = 32;
const QUERY_CACHE_FILE = 'query-embeddings.json';
const REWRITE_CACHE_FILE = 'query-rewrites.json';
const RERANK_CACHE_FILE = 'query-reranks.json';

const INSTRUCTIONS = [
  'Odpowiadasz rodzicom dziecka z cukrzycą typu 1 (pompa insulinowa z pętlą Trio, CGM Dexcom).',
  'Odpowiadaj po polsku, konkretnie, do ok. 250 słów. Podawaj liczby i progi, jeśli je znasz.',
  'Gdy nie masz pewności co do faktu (wartości, rejestracji, refundacji, ustawień urządzenia), napisz to wprost zamiast zgadywać.',
].join('\n');

const SOURCE_RULES = [
  'Dostajesz fragment źródła oznaczony [S1]. Korzystaj z niego, gdy dotyczy pytania, i oznaczaj takie informacje [S1].',
  'Jeśli fragment nie odpowiada na pytanie albo dotyczy innej populacji (np. dorosłych), powiedz to i nie przenoś liczb wprost.',
].join('\n');

// The first retrieved run (2026-10-16) showed that "use only the fragments" made the model withhold correct knowledge when
// retrieval missed (Q01, Q05, Q14) and apply a table outside its scope (Q06); hence the general-knowledge and table rules.
// In the second run the model still wrote "the fragments do not give" for guideline numbers (Q06 % TDD, Q09 bolus -25%),
// hence the sentence about numbers.
const RETRIEVED_SOURCE_RULES = [
  'Dostajesz fragmenty źródeł oznaczone [S1], [S2] itd., wybrane automatycznie przez wyszukiwarkę; część może nie dotyczyć pytania.',
  'Korzystaj z fragmentów, które dotyczą pytania, i oznaczaj takie informacje numerem fragmentu, np. [S2].',
  'Tabelę stosuj tylko do sytuacji z jej tytułu i nagłówków (np. tabela dla normoglikemii nie mówi nic o dawkach przy hiperglikemii).',
  'Jeśli fragmenty nie odpowiadają na pytanie lub jego część, nie odmawiaj: odpowiedz z ogólnej wiedzy medycznej i zaznacz to, np. „(wiedza ogólna, nie z fragmentów)”.',
  'Dotyczy to też liczb: jeśli pytanie prosi o dawki, procenty lub progi z wytycznych, których fragmenty nie podają, podaj je z wiedzy ogólnej (oznaczone jak wyżej) zamiast pisać tylko, że fragmenty ich nie zawierają.',
  'Jeśli fragment dotyczy innej populacji (np. dorosłych), powiedz to i nie przenoś jego liczb wprost.',
].join('\n');



export const QUESTIONS: readonly ProbeQuestion[] = questionSet.questions;

export function excerptTemplate(questions: readonly ProbeQuestion[] = QUESTIONS): ExcerptEntry[] {
  return questions.map((q) => ({
    id: q.id,
    question: q.question,
    source_hint: q.source_hint,
    ...(q.excerpt_instruction ? { excerpt_instruction: q.excerpt_instruction } : {}),
    source_label: '',
    excerpt: '',
  }));
}

export function parseExcerpts(raw: string, questions: readonly ProbeQuestion[] = QUESTIONS): Map<string, ExcerptEntry> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ProbeArgumentError(`${EXCERPTS_FILE} is not valid JSON.`);
  }
  if (!Array.isArray(parsed)) throw new ProbeArgumentError(`${EXCERPTS_FILE} must be an array (use --init-excerpts for the template).`);
  const known = new Set(questions.map((q) => q.id));
  const byId = new Map<string, ExcerptEntry>();
  for (const entry of parsed as ExcerptEntry[]) {
    if (!entry || typeof entry.id !== 'string' || !known.has(entry.id)) throw new ProbeArgumentError(`${EXCERPTS_FILE}: unknown question id ${String(entry?.id)}.`);
    if (byId.has(entry.id)) throw new ProbeArgumentError(`${EXCERPTS_FILE}: ${entry.id} appears more than once.`);
    if (typeof entry.excerpt !== 'string' || typeof entry.source_label !== 'string') throw new ProbeArgumentError(`${EXCERPTS_FILE}: ${entry.id} needs string excerpt and source_label.`);
    if (entry.excerpt.length > MAX_EXCERPT_CHARS) throw new ProbeArgumentError(`${EXCERPTS_FILE}: ${entry.id} excerpt has ${entry.excerpt.length} characters (max ${MAX_EXCERPT_CHARS}).`);
    if (entry.excerpt.trim() && !entry.source_label.trim()) throw new ProbeArgumentError(`${EXCERPTS_FILE}: ${entry.id} has an excerpt without source_label.`);
    byId.set(entry.id, entry);
  }
  return byId;
}

function hasExcerpt(entry: ExcerptEntry | undefined): entry is ExcerptEntry {
  return Boolean(entry && entry.excerpt.trim());
}

/** For C: the next question (cyclically) that has a fragment, never the question's own. */
export function mismatchedSource(id: string, ids: readonly string[], excerpts: Map<string, ExcerptEntry>): ExcerptEntry | null {
  const start = ids.indexOf(id);
  for (let step = 1; step < ids.length; step += 1) {
    const candidate = excerpts.get(ids[(start + step) % ids.length]);
    if (hasExcerpt(candidate) && candidate.id !== id) return candidate;
  }
  return null;
}

export function buildRequest(model: string, question: string, source: ExcerptEntry | null): Record<string, unknown> {
  if (!source) return { model, instructions: INSTRUCTIONS, input: `Pytanie: ${question}` };
  return {
    model,
    instructions: `${INSTRUCTIONS}\n${SOURCE_RULES}`,
    input: `Fragment źródła [S1] (${source.source_label.trim()}):\n"""\n${source.excerpt.trim()}\n"""\n\nPytanie: ${question}`,
  };
}

/** R: the retrieved chunks as [S1..Sk], each with its title / section / page label. */
export function buildRetrievedRequest(model: string, question: string, retrieved: readonly RetrievedChunk[]): Record<string, unknown> {
  const fragments = retrieved.map((hit, position) => `Fragment źródła [S${position + 1}] (${chunkLabel(hit.chunk)}):\n"""\n${hit.chunk.text.trim()}\n"""`);
  return {
    model,
    instructions: `${INSTRUCTIONS}\n${RETRIEVED_SOURCE_RULES}`,
    input: `${fragments.join('\n\n')}\n\nPytanie: ${question}`,
  };
}

function retrievalHits(retrieved: readonly RetrievedChunk[]): RetrievalHit[] {
  return retrieved.map((hit) => ({
    rank: hit.rank,
    score: Math.round(hit.score * 10000) / 10000,
    chunk_id: hit.chunk.id,
    label: chunkLabel(hit.chunk),
    preview: hit.chunk.text.replace(/\s+/g, ' ').slice(0, 240),
    ...(hit.ranks ? { ranks: hit.ranks } : {}),
  }));
}





/**
 * The reranked top-k: the picked candidates first, then the unpicked ones in fused order to fill k (the prompt keeps k
 * chunks either way); each keeps its list ranks plus "rerank" (its pick position). A failed rerank keeps the fused order.
 */


function usageNumber(response: Record<string, unknown>, key: string): number | null {
  const value = (response.usage as Record<string, unknown> | undefined)?.[key];
  return typeof value === 'number' ? value : null;
}

interface ParsedArgs {
  initExcerpts: boolean;
  live: boolean;
  withMismatch: boolean;
  only: Set<string> | null;
  model: string | null;
  retrievedIndex: string | null;
  topK: number;
  candidates: number;
  retrievalOnly: boolean;
  rewriteQuery: boolean;
  rewriteModel: string | null;
  expandQuery: boolean;
  repeat: number;
  maxPerSource: number | null;
  diversity: number | null;
  rerank: boolean;
  rerankModel: string | null;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const args: ParsedArgs = {
    initExcerpts: false, live: false, withMismatch: false, only: null, model: null,
    retrievedIndex: null, topK: DEFAULT_TOP_K, candidates: DEFAULT_CANDIDATES, retrievalOnly: false, rewriteQuery: false, rewriteModel: null,
    expandQuery: false, repeat: 1, maxPerSource: null, diversity: null, rerank: false, rerankModel: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const flag = arg.split('=')[0];
    if (!KNOWN_FLAGS.has(flag)) throw new ProbeArgumentError(`Unknown argument ${arg}.`);
    const takesValue = VALUE_FLAGS.has(flag);
    let value: string | undefined;
    if (takesValue) {
      value = arg.includes('=') ? arg.slice(flag.length + 1) : argv[(index += 1)];
      if (!value) throw new ProbeArgumentError(`Missing value for ${flag}.`);
    }
    if (flag === '--init-excerpts') args.initExcerpts = true;
    if (flag === '--live') args.live = true;
    if (flag === '--with-mismatch') args.withMismatch = true;
    if (flag === '--model') args.model = value!;
    if (flag === '--retrieved-index') args.retrievedIndex = value!;
    if (flag === '--retrieval-only') args.retrievalOnly = true;
    if (flag === '--rewrite-query') args.rewriteQuery = true;
    if (flag === '--rewrite-model') args.rewriteModel = value!;
    if (flag === '--expand-query') args.expandQuery = true;
    if (flag === '--rerank') args.rerank = true;
    if (flag === '--rerank-model') args.rerankModel = value!;
    if (flag === '--max-per-source') {
      args.maxPerSource = Number(value);
      if (!(Number.isInteger(args.maxPerSource) && args.maxPerSource >= 1 && args.maxPerSource <= MAX_TOP_K)) throw new ProbeArgumentError(`--max-per-source must be an integer from 1 to ${MAX_TOP_K}.`);
    }
    if (flag === '--diversity') {
      args.diversity = Number(value);
      if (!(args.diversity >= 0 && args.diversity <= 1)) throw new ProbeArgumentError('--diversity must be a number from 0 to 1.');
    }
    if (flag === '--repeat') {
      args.repeat = Number(value);
      if (!(Number.isInteger(args.repeat) && args.repeat >= 1 && args.repeat <= MAX_REPEAT)) throw new ProbeArgumentError(`--repeat must be an integer from 1 to ${MAX_REPEAT}.`);
    }
    if (flag === '--candidates') {
      args.candidates = Number(value);
      if (!(Number.isInteger(args.candidates) && args.candidates >= 1 && args.candidates <= MAX_CANDIDATES)) throw new ProbeArgumentError(`--candidates must be an integer from 1 to ${MAX_CANDIDATES}.`);
    }
    if (flag === '--top-k') {
      args.topK = Number(value);
      if (!(Number.isInteger(args.topK) && args.topK >= 1 && args.topK <= MAX_TOP_K)) throw new ProbeArgumentError(`--top-k must be an integer from 1 to ${MAX_TOP_K}.`);
    }
    if (flag === '--only') {
      args.only = new Set(value!.split(',').map((id) => id.trim()).filter(Boolean));
      const unknown = [...args.only].filter((id) => !QUESTIONS.some((q) => q.id === id));
      if (unknown.length) throw new ProbeArgumentError(`--only: unknown question ids ${unknown.join(', ')}.`);
    }
  }
  if (args.initExcerpts && args.live) throw new ProbeArgumentError('--init-excerpts and --live cannot be combined.');
  if (args.retrievedIndex && (args.initExcerpts || args.withMismatch)) throw new ProbeArgumentError('--retrieved-index cannot be combined with --init-excerpts or --with-mismatch.');
  if (!args.retrievedIndex && argv.some((arg) => RETRIEVED_FLAGS.includes(arg.split('=')[0]))) throw new ProbeArgumentError(`${RETRIEVED_FLAGS.slice(1).join(', ')} need --retrieved-index.`);
  if (args.rewriteModel && !args.rewriteQuery) throw new ProbeArgumentError('--rewrite-model needs --rewrite-query.');
  if (args.rerankModel && !args.rerank) throw new ProbeArgumentError('--rerank-model needs --rerank.');
  if (args.rerank && args.diversity !== null) throw new ProbeArgumentError('--rerank and --diversity both choose the top-k; use one.');
  if (args.candidates < args.topK) throw new ProbeArgumentError('--candidates must not be below --top-k.');
  if (args.repeat > 1 && (!args.only || args.retrievalOnly)) throw new ProbeArgumentError('--repeat needs --only and chat calls (not --retrieval-only).');
  return args;
}

function plannedVariants(question: ProbeQuestion, ids: readonly string[], excerpts: Map<string, ExcerptEntry>, withMismatch: boolean): Array<{ variant: Variant; source: ExcerptEntry | null }> {
  const plan: Array<{ variant: Variant; source: ExcerptEntry | null }> = [{ variant: 'A_no_source', source: null }];
  const own = excerpts.get(question.id);
  if (hasExcerpt(own)) plan.push({ variant: 'B_matching_source', source: own });
  if (withMismatch) {
    const other = mismatchedSource(question.id, ids, excerpts);
    if (other) plan.push({ variant: 'C_mismatched_source', source: other });
  }
  return plan;
}

const VARIANT_LABEL: Record<Variant, string> = {
  A_no_source: 'A — bez źródła',
  B_matching_source: 'B — z pasującym fragmentem',
  C_mismatched_source: 'C — z niepasującym fragmentem',
  R_retrieved_sources: 'R — z fragmentami z wyszukiwania',
};

function renderHits(hits: readonly RetrievalHit[]): string[] {
  return hits.map((hit) => {
    const ranks = hit.ranks ? ` (${Object.entries(hit.ranks).map(([list, rank]) => `${list}#${rank}`).join(' ')})` : '';
    return `${hit.rank}. ${hit.score.toFixed(3)}${ranks} · ${hit.label} · \`${hit.chunk_id}\` — ${hit.preview}…`;
  });
}

export function renderMarkdown(meta: Record<string, unknown>, rows: Array<{ question: ProbeQuestion; results: VariantResult[] }>): string {
  const lines = [
    '# RAG knowledge probe',
    '',
    `Model: ${String(meta.model)} · ${String(meta.generated_at)} · pytań: ${rows.length} · wywołań: ${String(meta.calls)} · tokeny wej./wyj.: ${String(meta.input_tokens)} / ${String(meta.output_tokens)}`,
    '',
    'Ocena każdej odpowiedzi: poprawność 0–2 (względem key points, po sprawdzeniu punktów „sprawdź”), konkret 0–2, red flag tak/nie,',
    'korzystanie ze źródła (B: cytuje [S1] tam, gdzie trzeba; C: mówi, że fragment nie pasuje).',
    'Sugerowana reguła decyzji: RAG ma sens, jeśli B jest wyraźnie lepsze od A w co najmniej ok. 1/4 pytań niekontrolnych,',
    'bez pogorszenia w pytaniach kontrolnych i bez nowych red flagów w B lub C.',
    '',
    '| Pytanie | Typ | A popr. | A konkr. | B popr. | B konkr. | Red flag (A/B/C) | Uwagi |',
    '|---|---|---|---|---|---|---|---|',
    ...rows.map(({ question }) => `| ${question.id} | ${question.probe} |  |  |  |  |  |  |`),
    '',
  ];
  for (const { question, results } of rows) {
    lines.push(`## ${question.id} · ${question.category} · ${question.probe}`, '', `**Pytanie:** ${question.question}`, '');
    lines.push('**Key points:**', ...question.key_points.map((point) => `- ${point}`), '');
    lines.push('**Red flags:**', ...question.red_flags.map((flag) => `- ${flag}`), '', `**Źródło:** ${question.source_hint}`, '');
    for (const result of results) {
      const usage = result.input_tokens === null ? '' : ` (${result.input_tokens} / ${result.output_tokens} tok.)`;
      const from = result.source_from ? `, fragment z ${result.source_from}` : '';
      const repeat = result.repeat ? ` · powtórzenie ${result.repeat}` : '';
      lines.push(`### ${VARIANT_LABEL[result.variant]}${from}${repeat}${usage}`, '');
      // Repeated calls share the fragments; list them once.
      if (result.retrieved && (result.repeat ?? 1) === 1) lines.push('**Wyszukane fragmenty:**', ...renderHits(result.retrieved), '');
      lines.push(result.error ? `_Błąd: ${result.error}_` : (result.answer ?? '').trim() || '_Pusta odpowiedź._', '');
    }
  }
  return `${lines.join('\n')}\n`;
}

export function renderRetrievalMarkdown(meta: Record<string, unknown>, rows: Array<{ question: ProbeQuestion; hits: RetrievalHit[]; rewrite?: string | null; expansion?: string[] }>): string {
  const rewrite = meta.rewrite_model ? ` · zapytanie EN: ${String(meta.rewrite_model)} (${REWRITE_PROMPT_VERSION})` : '';
  const selection = [
    meta.max_per_source ? `max ${String(meta.max_per_source)} z jednego pliku` : '',
    meta.diversity !== null && meta.diversity !== undefined ? `MMR λ ${String(meta.diversity)}` : '',
    meta.rerank_model ? `rerank: ${String(meta.rerank_model)} (${RERANK_PROMPT_VERSION})` : '',
  ].filter(Boolean).map((part) => ` · ${part}`).join('');
  const lines = [
    '# RAG retrieval — wyszukane fragmenty',
    '',
    `Indeks: ${String(meta.embedding_model)}, fragmentów: ${String(meta.index_chunks)} · top-k ${String(meta.top_k)} z ${String(meta.candidates)} kandydatów na listę (RRF)${rewrite}${selection} · ${String(meta.generated_at)}`,
    '',
    'Do oceny: czy wśród fragmentów jest ten, który odpowiada na pytanie (porównaj z „Źródło” i key points). Listy: pl = pytanie, en = zapytanie EN, bm25 = słowa zapytania EN, rerank = pozycja wyboru modelu.',
    '',
  ];
  for (const { question, hits, rewrite: query, expansion } of rows) {
    lines.push(`## ${question.id} · ${question.category} · ${question.probe}`, '', `**Pytanie:** ${question.question}`, '');
    if (query !== undefined) lines.push(`**Zapytanie EN:** ${query ?? '_brak (tylko pytanie PL)_'}`, '');
    if (expansion) lines.push(`**Rozszerzenie BM25 (słowniczek):** ${expansion.length ? expansion.join(', ') : '_brak_'}`, '');
    lines.push(`**Źródło:** ${question.source_hint}`, '', ...renderHits(hits), '');
  }
  return `${lines.join('\n')}\n`;
}

function readJsonCache<T>(outputDir: string, file: string): Record<string, T> {
  const path = join(outputDir, file);
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, T>;
  } catch {
    throw new ProbeArgumentError(`${file} is not valid JSON; delete it to compute its entries again.`);
  }
}

/** Query vectors by cache key, read from and written to <output-dir>/query-embeddings.json; only missing ones are embedded (one call). */
async function queryVectors(
  outputDir: string,
  model: string,
  texts: readonly string[],
  embeddings: () => OpenAiEmbeddingsTransport,
): Promise<{ vectors: Map<string, number[]>; embeddedNow: number }> {
  const cache = readJsonCache<number[]>(outputDir, QUERY_CACHE_FILE);
  const missing = [...new Set(texts)].filter((text) => !Array.isArray(cache[queryCacheKey(model, text)]));
  if (missing.length) {
    const vectors = await embedTexts(embeddings(), model, missing);
    missing.forEach((text, position) => {
      cache[queryCacheKey(model, text)] = vectors[position];
    });
    writeEvaluationOutputDirFile(outputDir, QUERY_CACHE_FILE, `${JSON.stringify(cache)}\n`);
  }
  return { vectors: new Map(texts.map((text) => [text, cache[queryCacheKey(model, text)]])), embeddedNow: missing.length };
}

interface CachedRewrite {
  id: string;
  model: string;
  prompt_version: string;
  question: string;
  query: string | null;
}

function rewriteCacheKey(model: string, question: string): string {
  return queryCacheKey(`${model}|${REWRITE_PROMPT_VERSION}`, question);
}

/**
 * English search queries from <output-dir>/query-rewrites.json; missing ones cost one guarded call each and are saved
 * after every call, so a stopped run keeps what it paid for. A failed call stops the rewrites (and the run).
 */
async function queryRewrites(
  outputDir: string,
  model: string,
  questions: readonly ProbeQuestion[],
  client: () => OpenAiResponsesTransport,
): Promise<{ rewrites: Map<string, string | null>; rewrittenNow: number }> {
  const cache = readJsonCache<CachedRewrite>(outputDir, REWRITE_CACHE_FILE);
  let rewrittenNow = 0;
  for (const question of questions) {
    const key = rewriteCacheKey(model, question.question);
    if (cache[key]) continue;
    const response = await client().responses.create(buildRewriteRequest(model, question.question));
    cache[key] = { id: question.id, model, prompt_version: REWRITE_PROMPT_VERSION, question: question.question, query: parseRewrite(outputText(response)) };
    rewrittenNow += 1;
    writeEvaluationOutputDirFile(outputDir, REWRITE_CACHE_FILE, `${JSON.stringify(cache, null, 2)}\n`);
  }
  return { rewrites: new Map(questions.map((q) => [q.id, cache[rewriteCacheKey(model, q.question)].query])), rewrittenNow };
}

interface CachedRerank {
  id: string;
  model: string;
  prompt_version: string;
  candidates: string[];
  picked: number[] | null;
}

/** Keyed by model, prompt version, question and the candidate ids in order: other candidates mean another call. */
function rerankCacheKey(model: string, question: string, candidates: readonly RetrievedChunk[], k: number): string {
  return queryCacheKey(`${model}|${RERANK_PROMPT_VERSION}|k${k}`, `${question}\n${candidates.map((hit) => hit.chunk.id).join('\n')}`);
}

/**
 * Rerank picks from <output-dir>/query-reranks.json; missing ones cost one guarded call each and are saved after every
 * call. A failed call stops the reranks (and the run); an unusable reply is cached as null and keeps the fused order.
 */
async function queryReranks(
  outputDir: string,
  model: string,
  items: ReadonlyArray<{ question: ProbeQuestion; candidates: RetrievedChunk[] }>,
  k: number,
  client: () => OpenAiResponsesTransport,
): Promise<{ picks: Map<string, number[] | null>; rerankedNow: number }> {
  const cache = readJsonCache<CachedRerank>(outputDir, RERANK_CACHE_FILE);
  let rerankedNow = 0;
  for (const { question, candidates } of items) {
    const key = rerankCacheKey(model, question.question, candidates, k);
    if (cache[key]) continue;
    const response = await client().responses.create(buildRerankRequest(model, question.question, candidates, k));
    cache[key] = { id: question.id, model, prompt_version: RERANK_PROMPT_VERSION, candidates: candidates.map((hit) => hit.chunk.id), picked: parseRerank(outputText(response), candidates.length, k) };
    rerankedNow += 1;
    writeEvaluationOutputDirFile(outputDir, RERANK_CACHE_FILE, `${JSON.stringify(cache, null, 2)}\n`);
  }
  return { picks: new Map(items.map(({ question, candidates }) => [question.id, cache[rerankCacheKey(model, question.question, candidates, k)].picked])), rerankedNow };
}

function loadIndexFile(path: string): LoadedIndex {
  if (!existsSync(path)) throw new ProbeArgumentError('--retrieved-index: file not found (build it with rag-corpus-ingest.ts --live).');
  return parseIndex(readFileSync(path, 'utf8'));
}

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  transportOverride?: OpenAiResponsesTransport,
  embeddingsOverride?: OpenAiEmbeddingsTransport,
  rewriteOverride?: OpenAiResponsesTransport,
  rerankOverride?: OpenAiResponsesTransport,
): Promise<void> {
  // Validated before anything is read or written.
  const outputDir = resolveEvaluationOutputDir(argv);
  const args = parseArgs(argv);
  const excerptsPath = join(outputDir, EXCERPTS_FILE);
  if (args.retrievedIndex) {
    await runRetrieved(outputDir, args, transportOverride, embeddingsOverride, rewriteOverride, rerankOverride);
    return;
  }

  if (args.initExcerpts) {
    if (existsSync(excerptsPath)) throw new ProbeArgumentError(`${EXCERPTS_FILE} already exists in --output-dir; not overwriting it.`);
    writeEvaluationOutputDirFile(outputDir, EXCERPTS_FILE, `${JSON.stringify(excerptTemplate(), null, 2)}\n`);
    console.log(`Template written: ${EXCERPTS_FILE} (${QUESTIONS.length} questions). Fill source_label and excerpt; empty excerpts run only variant A.`);
    return;
  }

  const excerpts = existsSync(excerptsPath) ? parseExcerpts(readFileSync(excerptsPath, 'utf8')) : new Map<string, ExcerptEntry>();
  const ids = QUESTIONS.map((q) => q.id);
  const selected = QUESTIONS.filter((q) => !args.only || args.only.has(q.id));
  const plan = selected.map((question) => ({ question, variants: plannedVariants(question, ids, excerpts, args.withMismatch) }));
  const calls = plan.reduce((sum, row) => sum + row.variants.length, 0);
  const missing = selected.filter((q) => !hasExcerpt(excerpts.get(q.id))).map((q) => q.id);
  const estimatedInputTokens = Math.round(plan.reduce((sum, row) => sum + row.variants.reduce((inner, v) => inner + JSON.stringify(buildRequest('m', row.question.question, v.source)).length, 0), 0) / 3.5);

  console.log(`Questions: ${selected.length}, with fragment: ${selected.length - missing.length}, calls planned: ${calls}, input tokens ≈ ${estimatedInputTokens}.`);
  if (missing.length) console.log(`Without fragment (variant A only): ${missing.join(', ')}`);
  if (!args.live) {
    console.log('Dry run: nothing sent. Add --live to call the model.');
    return;
  }

  const model = chatModel(args);
  const client = transportOverride ?? guardedChatClient();

  const rows: Array<{ question: ProbeQuestion; results: VariantResult[] }> = [];
  let stopped = false;
  for (const { question, variants } of plan) {
    const results: VariantResult[] = [];
    for (const { variant, source } of variants) {
      if (stopped) break;
      const base = { variant, source_from: source ? source.id : null };
      try {
        const response = await client.responses.create(buildRequest(model, question.question, source));
        results.push({ ...base, answer: outputText(response), input_tokens: usageNumber(response, 'input_tokens'), output_tokens: usageNumber(response, 'output_tokens'), error: null });
      } catch (error) {
        results.push({ ...base, answer: null, input_tokens: null, output_tokens: null, error: describeErrorSafely(error, [AiProviderError]) });
        stopped = true;
      }
    }
    if (results.length) rows.push({ question, results });
    if (stopped) break;
  }

  writeProbeReport(outputDir, model, rows, stopped, {});
}

function chatModel(args: ParsedArgs): string {
  const model = args.model ?? process.env.OPENAI_MODEL?.trim();
  if (!model) throw new ProbeArgumentError('Set OPENAI_MODEL or pass --model.');
  return model;
}

function requireApiKey(): string {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new ProbeArgumentError('OPENAI_API_KEY is required for --live.');
  return apiKey;
}

function guardedChatClient(): OpenAiResponsesTransport {
  try {
    // Same cost guard and budget ledger as the worker; refuses to start without them.
    return createGuardedOpenAiClientFromEnv(process.env, requireApiKey());
  } catch (error) {
    if (error instanceof ProbeArgumentError) throw error;
    throw new ProbeArgumentError(error instanceof Error ? error.message : 'OpenAI cost guard is not configured.');
  }
}

/** The light model's prices in place of the main ones; limits and ledger stay the same. */
export function lightPricingEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const light = { ...env };
  for (const key of ['INPUT_PER_1K_TOKENS', 'CACHED_INPUT_PER_1K_TOKENS', 'OUTPUT_PER_1K_TOKENS', 'REASONING_PER_1K_TOKENS', 'CURRENCY', 'VERSION']) {
    light[`OPENAI_PRICING_${key}`] = env[`OPENAI_LIGHT_PRICING_${key}`];
  }
  return light;
}

/** The model for a helper call (rewrite, rerank): the explicit one, else OPENAI_LIGHT_MODEL, else the chat model. */
function helperModel(explicit: string | null, args: ParsedArgs): { model: string; light: boolean } {
  if (explicit) return { model: explicit, light: explicit === process.env.OPENAI_LIGHT_MODEL?.trim() };
  const light = process.env.OPENAI_LIGHT_MODEL?.trim();
  return light ? { model: light, light: true } : { model: chatModel(args), light: false };
}

function guardedHelperClient(light: boolean): OpenAiResponsesTransport {
  try {
    return createGuardedOpenAiClientFromEnv(light ? lightPricingEnv(process.env) : process.env, requireApiKey());
  } catch (error) {
    if (error instanceof ProbeArgumentError) throw error;
    throw new ProbeArgumentError(error instanceof Error ? error.message : 'OpenAI cost guard is not configured for the helper model.');
  }
}

function guardedEmbeddingsClient(): OpenAiEmbeddingsTransport {
  try {
    return createGuardedOpenAiEmbeddingsClientFromEnv(process.env, requireApiKey());
  } catch (error) {
    if (error instanceof ProbeArgumentError) throw error;
    throw new ProbeArgumentError(error instanceof Error ? error.message : 'OpenAI embeddings cost guard is not configured.');
  }
}

function writeProbeReport(outputDir: string, model: string, rows: Array<{ question: ProbeQuestion; results: VariantResult[] }>, stopped: boolean, extra: Record<string, unknown>): void {
  const all = rows.flatMap((row) => row.results);
  const meta = {
    version: questionSet.version,
    model,
    generated_at: new Date().toISOString(),
    calls: all.length,
    failed_calls: all.filter((r) => r.error).length,
    stopped_early: stopped,
    input_tokens: all.reduce((sum, r) => sum + (r.input_tokens ?? 0), 0),
    output_tokens: all.reduce((sum, r) => sum + (r.output_tokens ?? 0), 0),
    ...extra,
  };
  const stamp = meta.generated_at.replace(/[:.]/g, '-');
  writeEvaluationOutputDirFile(outputDir, `rag-probe-${stamp}.json`, `${JSON.stringify({ ...meta, rows }, null, 2)}\n`);
  writeEvaluationOutputDirFile(outputDir, `rag-probe-${stamp}.md`, renderMarkdown(meta, rows));
  console.log(`Report: rag-probe-${stamp}.md (${meta.calls} calls, ${meta.failed_calls} failed${stopped ? ', stopped early' : ''}).`);
}

async function runRetrieved(
  outputDir: string,
  args: ParsedArgs,
  transportOverride: OpenAiResponsesTransport | undefined,
  embeddingsOverride: OpenAiEmbeddingsTransport | undefined,
  rewriteOverride: OpenAiResponsesTransport | undefined,
  rerankOverride: OpenAiResponsesTransport | undefined,
): Promise<void> {
  const index = loadIndexFile(args.retrievedIndex!);
  const selected = QUESTIONS.filter((q) => !args.only || args.only.has(q.id));
  const embeddingModel = index.file.embedding_model;
  const chatCalls = args.retrievalOnly ? 0 : selected.length * args.repeat;
  const rewrite = args.rewriteQuery ? helperModel(args.rewriteModel, args) : null;
  const rerank = args.rerank ? helperModel(args.rerankModel, args) : null;
  const cachedRewrites = rewrite ? readJsonCache<CachedRewrite>(outputDir, REWRITE_CACHE_FILE) : {};
  const rewriteCalls = rewrite ? selected.filter((q) => !cachedRewrites[rewriteCacheKey(rewrite.model, q.question)]).length : 0;
  const cachedVectors = readJsonCache<number[]>(outputDir, QUERY_CACHE_FILE);
  const uncachedQuestions = selected.filter((q) => !cachedVectors[queryCacheKey(embeddingModel, q.question)]).length;
  console.log(
    `Index: ${index.file.chunks.length} chunks (${embeddingModel}), ${index.file.chunks.filter((chunk) => chunk.kind === 'table').length} table chunks. Questions: ${selected.length}, top-k ${args.topK} of ${args.candidates} candidates per list.`,
  );
  console.log(
    `Calls planned: rewrites ${rewriteCalls}${rewrite ? ` (${rewrite.model})` : ' (off)'}, query embeddings 1 unless cached (${uncachedQuestions} questions not cached${rewrite ? ' + uncached rewrites' : ''}), reranks ${rerank ? `up to ${selected.length} (${rerank.model}, cached ones skipped)` : 'off'}, chat ${chatCalls}.`,
  );
  if (!args.live) {
    console.log('Dry run: nothing sent. Add --live to rewrite and embed the questions and call the model.');
    return;
  }

  let rewrites = new Map<string, string | null>();
  if (rewrite) {
    const result = await queryRewrites(outputDir, rewrite.model, selected, () => rewriteOverride ?? guardedHelperClient(rewrite.light));
    rewrites = result.rewrites;
    console.log(`Rewrites: ${selected.length} (${result.rewrittenNow} now, ${selected.length - result.rewrittenNow} from cache, ${[...rewrites.values()].filter((query) => !query).length} unusable).`);
  }
  const texts = [...selected.map((q) => q.question), ...[...rewrites.values()].filter((query): query is string => Boolean(query))];
  const { vectors, embeddedNow } = await queryVectors(outputDir, embeddingModel, texts, () => embeddingsOverride ?? guardedEmbeddingsClient());
  console.log(`Query vectors: ${new Set(texts).size} (${embeddedNow} embedded now).`);
  const retrieval = selected.map((question) => {
    const english = rewrites.get(question.id) ?? null;
    const expansion = args.expandQuery ? glossaryExpansion([question.question, english ?? ''], GLOSSARY) : undefined;
    const lexicalText = [english ?? '', ...(expansion ?? [])].join(' ').trim();
    const retrieved = retrieveHybrid(index, {
      vectors: [{ name: 'pl', vector: vectors.get(question.question)! }, ...(english ? [{ name: 'en', vector: vectors.get(english)! }] : [])],
      lexical: lexicalText ? { name: 'bm25', text: lexicalText } : null,
      candidates: args.candidates,
      // The rerank chooses from all fused candidates.
      k: rerank ? args.candidates : args.topK,
      ...(args.maxPerSource ? { maxPerSource: args.maxPerSource } : {}),
      ...(args.diversity !== null ? { diversity: args.diversity } : {}),
    });
    return { question, rewrite: rewrite ? english : undefined, expansion, retrieved };
  });
  if (rerank) {
    const result = await queryReranks(outputDir, rerank.model, retrieval.map(({ question, retrieved }) => ({ question, candidates: retrieved })), args.topK, () => rerankOverride ?? guardedHelperClient(rerank.light));
    for (const row of retrieval) row.retrieved = applyRerank(row.retrieved, result.picks.get(row.question.id) ?? null, args.topK);
    console.log(`Reranks: ${retrieval.length} (${result.rerankedNow} now, ${retrieval.length - result.rerankedNow} from cache, ${[...result.picks.values()].filter((picked) => !picked).length} unusable).`);
  }

  const retrievalMeta = {
    embedding_model: embeddingModel,
    index_chunks: index.file.chunks.length,
    top_k: args.topK,
    candidates: args.candidates,
    rewrite_model: rewrite?.model ?? null,
    rewrite_prompt_version: rewrite ? REWRITE_PROMPT_VERSION : null,
    query_glossary: args.expandQuery ? QUERY_GLOSSARY_VERSION : null,
    max_per_source: args.maxPerSource,
    diversity: args.diversity,
    rerank_model: rerank?.model ?? null,
    rerank_prompt_version: rerank ? RERANK_PROMPT_VERSION : null,
    repeat: args.repeat,
    generated_at: new Date().toISOString(),
  };
  const retrievalRows = retrieval.map(({ question, rewrite: query, expansion, retrieved }) => ({ question, rewrite: query, expansion, hits: retrievalHits(retrieved) }));
  const stamp = retrievalMeta.generated_at.replace(/[:.]/g, '-');
  writeEvaluationOutputDirFile(
    outputDir,
    `rag-retrieval-${stamp}.json`,
    `${JSON.stringify({ ...retrievalMeta, rows: retrievalRows.map(({ question, rewrite: query, expansion, hits }) => ({ id: question.id, ...(query !== undefined ? { rewrite: query } : {}), ...(expansion ? { expansion } : {}), hits })) }, null, 2)}\n`,
  );
  writeEvaluationOutputDirFile(outputDir, `rag-retrieval-${stamp}.md`, renderRetrievalMarkdown(retrievalMeta, retrievalRows));
  console.log(`Retrieval report: rag-retrieval-${stamp}.md.`);
  if (args.retrievalOnly) return;

  const model = chatModel(args);
  const client = transportOverride ?? guardedChatClient();
  const rows: Array<{ question: ProbeQuestion; results: VariantResult[] }> = [];
  let stopped = false;
  for (const { question, retrieved } of retrieval) {
    const results: VariantResult[] = [];
    for (let repeat = 1; repeat <= args.repeat && !stopped; repeat += 1) {
      const base = { variant: 'R_retrieved_sources' as const, source_from: `top-${args.topK}`, ...(args.repeat > 1 ? { repeat } : {}), retrieved: retrievalHits(retrieved) };
      try {
        const response = await client.responses.create(buildRetrievedRequest(model, question.question, retrieved));
        results.push({ ...base, answer: outputText(response), input_tokens: usageNumber(response, 'input_tokens'), output_tokens: usageNumber(response, 'output_tokens'), error: null });
      } catch (error) {
        results.push({ ...base, answer: null, input_tokens: null, output_tokens: null, error: describeErrorSafely(error, [AiProviderError]) });
        stopped = true;
      }
    }
    rows.push({ question, results });
    if (stopped) break;
  }
  const { generated_at: _generated, ...settings } = retrievalMeta;
  writeProbeReport(outputDir, model, rows, stopped, { mode: 'retrieved', ...settings });
}

if (require.main === module) {
  void main().catch((error) => {
    console.error(describeErrorSafely(error, [ProbeArgumentError, RagIndexError, AiProviderError]));
    process.exitCode = 1;
  });
}
