/**
 * Query-side helpers of the knowledge retrieval, shared by the assistant (knowledge-search.ts) and the offline probe
 * (scripts/evaluation/rag-knowledge-probe.ts) so both use the same prompts and prompt versions: the English search query
 * written by the light model, the PL↔EN glossary expansion of the full-text query, and the light-model rerank that picks
 * the top fragments from the fused candidates. Best offline/paid configuration so far (2026-10-16): fusion of 16
 * candidates, rerank to 6 (R≈B 18–19/25 in the knowledge probe).
 */
import queryGlossary from '../domain/query-glossary.json';
import type { PatientAge } from '@shared/primitives/patient-age';

export interface GlossaryEntry {
  /** Word beginnings in Polish or English ("keton" matches "ketony", "ketonów", "ketones"); matched at a word start, case-insensitive. */
  match: string[];
  /** English corpus terms added to the lexical (BM25) query when the entry matches. */
  expand: string[];
}

export const QUERY_GLOSSARY_VERSION: string = queryGlossary.version;
export const QUERY_GLOSSARY: readonly GlossaryEntry[] = queryGlossary.entries;

/** What a label and a rerank candidate need from a chunk. */
export interface KnowledgeChunkLabelFields {
  title: string;
  section: string | null;
  page: number | null;
  page_end: number | null;
}

export interface RerankCandidate {
  rank: number;
  chunk: KnowledgeChunkLabelFields & { text: string };
  ranks?: Record<string, number>;
}

export const REWRITE_PROMPT_VERSION = 'rag-query-rewrite.v5';
export const RERANK_PROMPT_VERSION = 'rag-rerank.v3';
const MAX_REWRITE_CHARS = 300;
const RERANK_CANDIDATE_CHARS = 1200;

/**
 * What the knowledge base holds, as the search tool and the query rewrite describe it (one list for both). The shipped
 * knowledge base (knowledge/) has guideline, manual and paywalled-article content only as summaries in our own words
 * with a link to the original (licences), and open documentation and open-access articles as original text.
 */
export const KNOWLEDGE_CORPUS_SOURCES = 'ISPAD 2022/2024 and EASD/ISPAD guidelines, PTD 2026 recommendations, CGM consensus papers, the Dexcom G7 user guide, insulin SmPCs and studies on fat/protein, bolus reduction and corrections (as summaries with a link to the original), Trio, OpenAPS and AndroidAPS documentation and open-access articles (original text)';

const REWRITE_INSTRUCTIONS = [
  'You turn a Polish question about a patient with type 1 diabetes (insulin pump with an automated insulin delivery loop, Dexcom CGM) into one English search query.',
  `The corpus: ${KNOWLEDGE_CORPUS_SOURCES}.`,
  'Use the terms these documents use (e.g. sick day, ketones, total daily dose, temporary target, override, prandial bolus reduction, time in range).',
  'Keep numbers, units and named methods from the question. Do not answer the question.',
  'Reply with the query only: one line, at most 30 words.',
].join('\n');

// Stage 1 (2026-10-16): new sources pushed the answer chunks of Q13, Q14 and Q20 out of the fused top-6; the rerank reads
// the candidates instead of counting list ranks.
const RERANK_INSTRUCTIONS = [
  'You choose source fragments for an assistant that answers Polish questions about a patient with type 1 diabetes (insulin pump with an automated insulin delivery loop, Dexcom G7 CGM).',
  'You get the question and numbered candidate fragments, each with its source and section.',
  'Pick the fragments that contain what the answer needs: the numbers, thresholds, device behaviour, settings or study results the question asks about, and the guideline the question names.',
  'Skip fragments on another topic even when they share words with the question, and near-duplicates of a fragment you already picked.',
  'Reply with the numbers of at most {k} fragments, the most useful first, comma-separated (e.g. 4, 1, 9). Nothing else.',
].join('\n');

/** Label shown to the model and in reports: title, section, pages; "(summary)" for a summary of the original. */
export function chunkLabel(chunk: KnowledgeChunkLabelFields & { source_mode?: string | null }): string {
  const pages = chunk.page === null ? '' : chunk.page_end && chunk.page_end !== chunk.page ? `, s. ${chunk.page}–${chunk.page_end}` : `, s. ${chunk.page}`;
  return `${chunk.title}${chunk.section ? `, sekcja ${chunk.section}` : ''}${pages}${chunk.source_mode === 'SUMMARY_ONLY' ? ' (summary)' : ''}`;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Query expansion for BM25: the English terms of every glossary entry whose match term starts a word in one of the
 * texts (the Polish question, its English rewrite). Returns the terms in glossary order without duplicates; the query
 * vectors are not touched, so cached embeddings stay valid.
 */
export function glossaryExpansion(texts: readonly string[], glossary: readonly GlossaryEntry[] = QUERY_GLOSSARY): string[] {
  const haystack = texts.join('\n').toLowerCase();
  const terms: string[] = [];
  for (const entry of glossary) {
    const hit = entry.match.some((term) => new RegExp(`(?:^|[^\\p{L}\\p{N}])${escapeRegExp(term.toLowerCase())}`, 'u').test(haystack));
    if (!hit) continue;
    for (const term of entry.expand) if (!terms.includes(term)) terms.push(term);
  }
  return terms;
}

/** The patient's age for the search: guidance for children and adults differs (ISPAD covers children and teenagers). */
function patientAgeHint(age: PatientAge | null): string {
  if (!age) return 'The patient\'s age is not known.';
  const group = age.age_group === 'CHILD' ? 'a child' : age.age_group === 'TEEN' ? 'a teenager' : 'an adult';
  return `The patient is ${group} of about ${age.age_years}: prefer guidance for that age group.`;
}

/** The patient's loop (therapy_now.loop.system): Trio's and OpenAPS's documents answer for oref, not for Loop. */
function loopSystemHint(loopSystem: string | null): string {
  return loopSystem ? `The patient's loop is ${loopSystem}.` : 'The patient\'s loop system is not known.';
}

export function buildRewriteRequest(model: string, question: string, age: PatientAge | null = null, loopSystem: string | null = null): Record<string, unknown> {
  return { model, instructions: `${REWRITE_INSTRUCTIONS}\n${patientAgeHint(age)}\n${loopSystemHint(loopSystem)}`, input: question };
}

/** First non-empty line without quotes or a "Query:" prefix; null when nothing usable (no Latin letters) is left. */
export function parseRewrite(text: string): string | null {
  const line = text.split('\n').map((part) => part.trim()).find(Boolean) ?? '';
  const query = line.replace(/^(?:search )?query:\s*/i, '').replace(/^["'„“]+|["'”]+$/g, '').replace(/\s+/g, ' ').trim().slice(0, MAX_REWRITE_CHARS);
  return /[A-Za-z]{3}/.test(query) ? query : null;
}

/** The fused candidates as [1..n] with label and the start of their text; the model returns the numbers to keep. */
export function buildRerankRequest(model: string, question: string, candidates: readonly RerankCandidate[], k: number, age: PatientAge | null = null, loopSystem: string | null = null): Record<string, unknown> {
  const fragments = candidates.map((hit, position) => {
    const text = hit.chunk.text.replace(/\s+/g, ' ').trim();
    return `[${position + 1}] ${chunkLabel(hit.chunk)}\n${text.length > RERANK_CANDIDATE_CHARS ? `${text.slice(0, RERANK_CANDIDATE_CHARS)}…` : text}`;
  });
  return { model, instructions: `${RERANK_INSTRUCTIONS.replace('{k}', String(k))}\n${patientAgeHint(age)}\n${loopSystemHint(loopSystem)}`, input: `Question: ${question}\n\nCandidates:\n\n${fragments.join('\n\n')}` };
}

/** Candidate numbers (1-based) in the reply's order, without repeats or numbers outside 1..count; null when none is left. */
export function parseRerank(text: string, count: number, k: number): number[] | null {
  const picked: number[] = [];
  for (const match of text.matchAll(/\d+/g)) {
    const number = Number(match[0]);
    if (number >= 1 && number <= count && !picked.includes(number)) picked.push(number);
    if (picked.length === k) break;
  }
  return picked.length ? picked : null;
}

/**
 * The reranked top-k: the picked candidates first, then the unpicked ones in fused order to fill k (the prompt keeps k
 * chunks either way); each keeps its list ranks plus "rerank" (its pick position). A failed rerank keeps the fused order.
 */
export function applyRerank<T extends RerankCandidate>(candidates: readonly T[], picked: readonly number[] | null, k: number): T[] {
  const order = [...(picked ?? []).map((number) => number - 1), ...candidates.map((_hit, position) => position).filter((position) => !picked?.includes(position + 1))];
  return order.slice(0, k).map((position, rank) => {
    const hit = candidates[position];
    const pick = picked?.indexOf(position + 1) ?? -1;
    return { ...hit, rank: rank + 1, ranks: { ...hit.ranks, ...(pick >= 0 ? { rerank: pick + 1 } : {}) } };
  });
}

/** Text of a Responses API reply (output_text, else the message parts). */
export function responseOutputText(response: Record<string, unknown>): string {
  if (typeof response.output_text === 'string' && response.output_text) return response.output_text;
  const output = Array.isArray(response.output) ? (response.output as Array<Record<string, unknown>>) : [];
  return output
    .filter((item) => item.type === 'message')
    .flatMap((item) => (Array.isArray(item.content) ? (item.content as Array<Record<string, unknown>>) : []))
    .filter((part) => part.type === 'output_text')
    .map((part) => String(part.text ?? ''))
    .join('');
}
