/**
 * Minimal RAG retrieval for the knowledge probe (prototype; production reuses its index format): chunking of extracted
 * source text with title / section / page metadata, a local vector index file (JSON, embeddings as base64 float32)
 * and brute-force cosine top-k. Embeddings come from a guarded transport (cost guard and budget ledger); this module
 * never constructs a client itself. Source text and the index stay outside the repository (copyright).
 *
 * Production keeps the index in Postgres with pgvector (stage 2, 2026-10-16): migration 036 (rag_chunks,
 * rag_corpus_versions), infra/db/postgres-rag-chunks.repository.ts (load + hybrid search with exact cosine and English
 * full-text BM25), infra/db/rag-index-load.ts loads a file built here.
 */
import { createHash } from 'node:crypto';
import type { OpenAiEmbeddingsTransport } from '@modules/ai-gateway/infrastructure/guarded-openai-client';

export const RAG_INDEX_VERSION = 'rag-index.v1' as const;
export const DEFAULT_EMBEDDING_MODEL = 'text-embedding-3-small';

export class RagIndexError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RagIndexError';
  }
}

export interface SourceDocument {
  source_file: string;
  title: string;
  /** Page texts in order; plain text without page markers is one page. */
  pages: string[];
  /** False for text without real page numbers (Markdown, HTML), so chunks carry no page. */
  paged: boolean;
}

export interface RagChunk {
  id: string;
  source_file: string;
  title: string;
  section: string | null;
  page: number | null;
  page_end: number | null;
  text: string;
  tokens_estimate: number;
  /** Set on a chunk cut out of a table (its caption is the section and the first line of every part). */
  kind?: 'table';
}

export interface IndexedChunk extends RagChunk {
  embedding_b64: string;
}

export interface RagIndexFile {
  version: typeof RAG_INDEX_VERSION;
  embedding_model: string;
  dimensions: number;
  created_at: string;
  chunking: { target_tokens: number; overlap_tokens: number };
  chunks: IndexedChunk[];
}

export interface RetrievedChunk {
  rank: number;
  score: number;
  chunk: RagChunk;
  /** Hybrid retrieval: the chunk's rank in each candidate list it appeared in (e.g. { pl: 3, en: 1, bm25: 2 }). */
  ranks?: Record<string, number>;
}

export interface ChunkingOptions {
  target_tokens: number;
  overlap_tokens: number;
}

export const DEFAULT_CHUNKING: ChunkingOptions = { target_tokens: 600, overlap_tokens: 100 };

/** Rough token count for English/Polish prose (about 4 characters per token); used for chunk sizes, not for cost. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

const PAGE_MARKER = /\f|\n?=====PAGE=====\n?/;

/** Splits extracted text on form feeds (PDF helper output) or "=====PAGE=====" lines. */
export function splitPages(text: string): string[] {
  const pages = text.split(PAGE_MARKER);
  while (pages.length > 1 && !pages[pages.length - 1].trim()) pages.pop();
  return pages;
}

/** "S I C K D A Y" style headings from PDF extraction lose word gaps either way; joined letters read better. */
function collapseLetterSpacing(title: string): string {
  return /^(?:\S )+\S$/.test(title) ? title.replace(/ /g, '') : title;
}

export interface Heading {
  title: string;
  /**
   * Nesting depth: 1 for "7 |", "# Title" or "4.2" without a parent number, 2 for "7.4" or "##", 3 for a Roman part
   * ("II. Pump therapy" under ISPAD 5.1, "III. Leczenie" under a PTD chapter); 0 for an EPAR annex part, which starts a new tree.
   */
  level: number;
  /** Section number of a numbered heading ("10.1"); a numbered sub-heading closes open headings that are not its numeric parents. */
  number?: string;
}

export interface HeadingOptions {
  /** Markdown "#" headings (default true); false for PDF text, where "#" and "##" are table glyphs ("# Decrease >30 mg/dl"). */
  markdown?: boolean;
}

/** "1 0 | M A N A G E M E N T O F M I X E D M E A L S": a two-digit ISPAD section number loses its gap like the title. */
function spacedNumberHeading(line: string): Heading | null {
  const match = /^([1-9]) (\d) (.+)$/.exec(line);
  if (!match) return null;
  const tokens = match[3].split(' ').filter((token) => token !== '|');
  if (tokens.length < 3 || !tokens.every((token) => /^[\p{L}\p{N},&()-]$/u.test(token)) || tokens.filter((token) => /\p{L}/u.test(token)).length < 3) return null;
  const number = `${match[1]}${match[2]}`;
  return { title: `${number} ${tokens.join('')}`, level: 1, number };
}

/**
 * A section heading with its depth: numbered ISPAD style ("7.4 | After activity", "1 0 | M E A L S"), SmPC style
 * ("4.2 Posology and method of administration"), PTD part ("II. Cele leczenia cukrzycy"), Dexcom guide chapter in the
 * running header ("11 • Troubleshooting | Dexcom G7 User Guide 105") or Markdown ("## Exercise"). Section numbers never
 * start at 0, so "0.05 U is delivered" or a "0.2 | 0" table row is no heading.
 */
export function parseHeading(line: string, options: HeadingOptions = {}): Heading | null {
  const trimmed = line.trim();
  const numbered = /^([1-9]\d*(?:\.\d+){0,3}) ?\| ?(\S.{1,118})$/.exec(trimmed);
  if (numbered) return { title: `${numbered[1]} ${collapseLetterSpacing(numbered[2].trim())}`, level: numbered[1].split('.').length, number: numbered[1] };
  const spaced = spacedNumberHeading(trimmed);
  if (spaced) return spaced;
  const smpc = /^([1-9]\d?\.\d{1,2})\.?\s+([A-Z][A-Za-z ,()-]{3,80})$/.exec(trimmed);
  if (smpc) return { title: `${smpc[1]} ${smpc[2].trim()}`, level: 2, number: smpc[1] };
  // EPAR annex parts ("ANNEX III", "B. PACKAGE LEAFLET") end the SmPC section that precedes them.
  const annex = /^(ANNEX [IVX]+|[A-D]\. [A-Z][A-Z ,]{3,80})$/.exec(trimmed);
  if (annex) return { title: annex[1], level: 0 };
  const roman = /^([IVX]{1,4})\. ([A-ZĄĆĘŁŃÓŚŹŻ][^.]{2,80}?):?$/.exec(trimmed);
  if (roman) return { title: `${roman[1]}. ${roman[2]}`, level: 3 };
  const guideChapter = /^([1-9]\d?) • ([A-Z][\w ,&'’-]{2,60}?)(?: \| .*)?$/.exec(trimmed);
  if (guideChapter) return { title: `${guideChapter[1]} ${guideChapter[2].trim()}`, level: 1, number: guideChapter[1] };
  const markdown = options.markdown === false ? null : /^(#{1,4})\s+(\S.{0,118})$/.exec(trimmed);
  if (markdown) return { title: markdown[2].replace(/[#*_`]+/g, '').trim(), level: markdown[1].length };
  return null;
}

export function sectionHeading(line: string, options: HeadingOptions = {}): string | null {
  return parseHeading(line, options)?.title ?? null;
}

/** PTD chapter banner under a chapter title ("NAJWAŻNIEJSZE REKOMENDACJE", PDF text keeps odd letter case). */
const CHAPTER_BANNER = /^NAJWA[ŻżZz]NIEJSZE REKOMENDACJE$/i;

/**
 * A PTD chapter title ("23. Cukrzyca u dzieci i młodzieży", "10. Ogólne zasady postępowania u osób" + "z cukrzycą typu 1")
 * is a numbered line with the chapter banner at most three lines below; a wrapped title continues on a lower-case line.
 * Numbered list items and references look the same on their own line, so the banner is the evidence.
 */
function bannerChapterHeading(lines: readonly string[], index: number): Heading | null {
  const match = /^([1-9]\d?)\. (\S.{2,80})$/.exec(lines[index]);
  if (!match) return null;
  const bannerOffset = [1, 2, 3].find((offset) => CHAPTER_BANNER.test(lines[index + offset] ?? ''));
  if (!bannerOffset) return null;
  const next = lines[index + 1] ?? '';
  const continued = bannerOffset > 1 && /^\p{Ll}/u.test(next) && next.length <= 80;
  // PDF text keeps stray control characters after the number ("7.\u0007 Zasady").
  const title = `${match[2]}${continued ? ` ${next}` : ''}`.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/ {2,}/g, ' ').trim();
  return { title: `${match[1]} ${title}`, level: 1, number: match[1] };
}

/**
 * Chunk boundaries of rag-index.v1, kept as they were when the indexed chunks were embedded: a line closes a chunk (and
 * ends a Wiley table block) only where these rules matched. Section labels use parseHeading, so better labels never move
 * a boundary, never change a chunk's text and never invalidate its stored embedding.
 */
function isChunkBoundary(line: string): boolean {
  const trimmed = line.trim();
  return /^(\d+(?:\.\d+){0,3}) ?\| ?(\S.{1,118})$/.test(trimmed)
    || /^(\d{1,2}\.\d{1,2})\.?\s+([A-Z][A-Za-z ,()-]{3,80})$/.test(trimmed)
    || /^(ANNEX [IVX]+|[A-D]\. [A-Z][A-Z ,]{3,80})$/.test(trimmed)
    || /^(#{1,4})\s+(\S.{0,118})$/.test(trimmed);
}

/** Parent headings kept in a section path ("8 Treatment of ketosis > 8.3 Insulin adjustment > 8.3.2 Percentage increase method"). */
const SECTION_PATH_DEPTH = 3;
const MAX_SECTION_CHARS = 200;

/**
 * Pushes a heading onto the open headings (closing those at its depth or deeper, and for a numbered sub-heading the
 * numbered ones that are not its parents: "10.1" closes "9") and returns the section path.
 */
function enterHeading(open: Heading[], heading: Heading): string {
  const isParent = (item: Heading): boolean => !heading.number || !heading.number.includes('.') || !item.number || heading.number.startsWith(`${item.number}.`);
  while (open.length && (open[open.length - 1].level >= heading.level || !isParent(open[open.length - 1]))) open.pop();
  open.push(heading);
  const path = open.slice(-SECTION_PATH_DEPTH).map((item) => item.title).join(' > ');
  return path.length > MAX_SECTION_CHARS ? `…${path.slice(-(MAX_SECTION_CHARS - 1))}` : path;
}

interface Unit {
  text: string;
  page: number;
  section: string | null;
  /** The line closes a chunk that is already long enough (isChunkBoundary). */
  boundary: boolean;
}

/** Splits a line longer than the chunk target at sentence ends (whole words as a fallback). */
function splitLongLine(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];
  const sentences = text.match(/[^.!?]+(?:[.!?]+\s*|$)/g) ?? [text];
  const parts: string[] = [];
  let current = '';
  for (const sentence of sentences) {
    if (current && current.length + sentence.length > maxChars) {
      parts.push(current.trim());
      current = '';
    }
    if (sentence.length > maxChars) {
      for (const word of sentence.split(/\s+/)) {
        if (current && current.length + word.length + 1 > maxChars) {
          parts.push(current.trim());
          current = '';
        }
        current += `${word} `;
      }
    } else {
      current += sentence;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function joinUnits(units: readonly Unit[]): string {
  // PDF line breaks inside hyphenated words ("hyper-\nglycemia").
  return units.map((unit) => unit.text).join('\n').replace(/(\p{L})-\n(\p{Ll})/gu, '$1$2').trim();
}

/** "T A B L E 2 Normoglycemia/hypoglycemia" (Wiley PDF text), "TABLE 2 ..." or "Table 2. ..." captions. */
const SPACED_TABLE_CAPTION = /^T A B L E (\d{1,2})\s+(\S.*)$/;
const PLAIN_TABLE_CAPTION = /^(?:TABLE|Table) (\d{1,2})[.:]?\s+(\S.*)$/;
/** Footnote under a PDF table: "aExtra carbohydrates if tolerated.", "*Adult data." */
const TABLE_FOOTNOTE = /^(?:[a-h]|[*†‡§¶])\s?[A-Z]/;
/** Publisher footer that ends a PDF page ("Downloaded from https://onlinelibrary.wiley.com/..."). */
const PAGE_FOOTER = /Downloaded from https?:\/\//;

interface TableBlock {
  number: string;
  caption: string;
  lines: string[];
  page: number;
  /** Markdown pipe table: its first row is the header repeated in every part. */
  pipe: boolean;
}

/**
 * Cuts tables out of a page's lines so they become their own chunks. A table is a caption followed by Markdown pipe
 * rows, or a spaced Wiley caption ("T A B L E 2") whose rows run until the page footer, the page end, a section
 * heading, another caption, or the first non-footnote line after its "Abbreviations:" line. A "Table 2 shows ..."
 * sentence without pipe rows stays prose.
 */
function extractTables(lines: readonly string[], page: number): { prose: string[]; tables: TableBlock[] } {
  const prose: string[] = [];
  const tables: TableBlock[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    const spaced = SPACED_TABLE_CAPTION.exec(line);
    const plain = spaced ? null : PLAIN_TABLE_CAPTION.exec(line);
    const pipe = Boolean(plain && lines[index + 1]?.startsWith('|'));
    if (!spaced && !pipe) {
      prose.push(line);
      index += 1;
      continue;
    }
    const match = (spaced ?? plain)!;
    const block: TableBlock = { number: match[1], caption: match[2].trim(), lines: [], page, pipe };
    index += 1;
    if (pipe) {
      while (index < lines.length && lines[index].startsWith('|')) block.lines.push(lines[(index += 1) - 1]);
    } else {
      let afterAbbreviations = false;
      while (index < lines.length) {
        const row = lines[index];
        if (PAGE_FOOTER.test(row) || isChunkBoundary(row) || SPACED_TABLE_CAPTION.test(row) || PLAIN_TABLE_CAPTION.test(row)) break;
        if (afterAbbreviations && !TABLE_FOOTNOTE.test(row)) break;
        if (/^Abbreviations?:/.test(row)) afterAbbreviations = true;
        block.lines.push(row);
        index += 1;
      }
    }
    tables.push(block);
  }
  return { prose, tables };
}

/** Table parts of at most the chunk target; each part starts with the caption (and the header row of a pipe table). */
function tableChunkTexts(table: TableBlock, options: ChunkingOptions): string[] {
  const caption = `Table ${table.number}: ${table.caption}`;
  const header = table.pipe && table.lines.length > 1 ? table.lines[0] : null;
  const rows = header ? table.lines.slice(1) : table.lines;
  const parts: string[][] = [];
  let current: string[] = [];
  let tokens = 0;
  const fixedTokens = estimateTokens(caption) + (header ? estimateTokens(header) : 0);
  for (const row of rows.flatMap((text) => splitLongLine(text, options.target_tokens * 4))) {
    const rowTokens = estimateTokens(row);
    if (current.length && fixedTokens + tokens + rowTokens > options.target_tokens) {
      parts.push(current);
      current = [];
      tokens = 0;
    }
    current.push(row);
    tokens += rowTokens;
  }
  if (current.length || !parts.length) parts.push(current);
  return parts.map((part, position) => {
    const title = parts.length > 1 ? `${caption} (part ${position + 1}/${parts.length})` : caption;
    return [title, ...(header ? [header] : []), ...part].join('\n').replace(/(\p{L})-\n(\p{Ll})/gu, '$1$2').trim();
  });
}

/**
 * Line-based chunking: lines are accumulated until the target size, a boundary line (isChunkBoundary) closes a chunk
 * that is already at least 40% of the target, and each chunk starts with the last lines of the previous one (overlap)
 * unless it starts at a boundary. Section and page refer to the chunk's first line; the section is the heading path (up
 * to three levels, e.g. "8 Treatment > 8.3 Insulin adjustment > 8.3.2 Percentage increase method"), so a sub-section
 * label still names its topic. Only metadata: the embedded chunk text is unchanged, also when labelling improves. Tables (see extractTables) become
 * separate chunks after the prose chunks, so a table's rows are never read without its caption.
 */
export function chunkDocument(document: SourceDocument, options: ChunkingOptions = DEFAULT_CHUNKING): RagChunk[] {
  if (!(options.target_tokens > 0) || !(options.overlap_tokens >= 0) || options.overlap_tokens >= options.target_tokens) {
    throw new RagIndexError('Chunking needs target_tokens > overlap_tokens >= 0.');
  }
  const maxChars = options.target_tokens * 4;
  const units: Unit[] = [];
  let section: string | null = null;
  const openHeadings: Heading[] = [];
  const tables: TableBlock[] = [];
  const headingOptions: HeadingOptions = { markdown: !/\.(?:txt|pdf)$/i.test(document.source_file) };
  document.pages.forEach((pageText, pageIndex) => {
    const lines = pageText.split('\n').map((rawLine) => rawLine.replace(/\s+/g, ' ').trim()).filter(Boolean);
    const extracted = extractTables(lines, pageIndex + 1);
    tables.push(...extracted.tables);
    extracted.prose.forEach((line, lineIndex) => {
      const heading = parseHeading(line, headingOptions) ?? bannerChapterHeading(extracted.prose, lineIndex);
      if (heading) section = enterHeading(openHeadings, heading);
      const boundary = isChunkBoundary(line);
      for (const part of splitLongLine(line, maxChars)) units.push({ text: part, page: pageIndex + 1, section, boundary });
    });
  });

  const chunks: RagChunk[] = [];
  let current: Unit[] = [];
  let currentTokens = 0;
  const emit = (): void => {
    const text = joinUnits(current);
    if (!text) return;
    const first = current[0];
    const last = current[current.length - 1];
    chunks.push({
      id: `${document.source_file}#${chunks.length + 1}`,
      source_file: document.source_file,
      title: document.title,
      section: first.section ?? current.find((unit) => unit.section)?.section ?? null,
      page: document.paged ? first.page : null,
      page_end: document.paged ? last.page : null,
      text,
      tokens_estimate: estimateTokens(text),
    });
  };
  const overlapTail = (): Unit[] => {
    const tail: Unit[] = [];
    let tokens = 0;
    for (let index = current.length - 1; index > 0 && tokens < options.overlap_tokens; index -= 1) {
      tail.unshift(current[index]);
      tokens += estimateTokens(current[index].text);
    }
    return tail;
  };

  for (const unit of units) {
    const unitTokens = estimateTokens(unit.text);
    const sectionBreak = unit.boundary && currentTokens >= options.target_tokens * 0.4;
    if (current.length && (sectionBreak || currentTokens + unitTokens > options.target_tokens)) {
      emit();
      current = sectionBreak ? [] : overlapTail();
      currentTokens = current.reduce((sum, item) => sum + estimateTokens(item.text), 0);
    }
    current.push(unit);
    currentTokens += unitTokens;
  }
  if (current.length) emit();
  for (const table of tables) {
    for (const text of tableChunkTexts(table, options)) {
      chunks.push({
        id: `${document.source_file}#${chunks.length + 1}`,
        source_file: document.source_file,
        title: document.title,
        section: `Table ${table.number}: ${table.caption}`.slice(0, 160),
        page: document.paged ? table.page : null,
        page_end: document.paged ? table.page : null,
        text,
        tokens_estimate: estimateTokens(text),
        kind: 'table',
      });
    }
  }
  return chunks;
}


export function encodeVector(vector: readonly number[]): string {
  return Buffer.from(new Float32Array(vector).buffer).toString('base64');
}

export function decodeVector(encoded: string): Float32Array {
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length % 4 !== 0) throw new RagIndexError('Embedding is not a float32 array.');
  return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length));
}

export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length || a.length === 0) throw new RagIndexError('Vectors must have the same, non-zero length.');
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < a.length; index += 1) {
    dot += a[index] * b[index];
    normA += a[index] * a[index];
    normB += b[index] * b[index];
  }
  return normA && normB ? dot / Math.sqrt(normA * normB) : 0;
}

export interface LoadedIndex {
  file: RagIndexFile;
  vectors: Float32Array[];
}

export function parseIndex(raw: string): LoadedIndex {
  let parsed: RagIndexFile;
  try {
    parsed = JSON.parse(raw) as RagIndexFile;
  } catch {
    throw new RagIndexError('Index is not valid JSON.');
  }
  if (!parsed || parsed.version !== RAG_INDEX_VERSION || !Array.isArray(parsed.chunks) || !(parsed.dimensions > 0) || typeof parsed.embedding_model !== 'string') {
    throw new RagIndexError(`Index must be a ${RAG_INDEX_VERSION} file.`);
  }
  const vectors = parsed.chunks.map((chunk) => {
    const vector = decodeVector(chunk.embedding_b64);
    if (vector.length !== parsed.dimensions) throw new RagIndexError(`Chunk ${chunk.id} has ${vector.length} dimensions, index says ${parsed.dimensions}.`);
    return vector;
  });
  if (!vectors.length) throw new RagIndexError('Index has no chunks.');
  return { file: parsed, vectors };
}

const CITATION = /\b(?:19|20)\d{2};\s?\d+(?:\(\d+\))?:\s?[A-Za-z]?\d+|doi:\s?10\.|\bdoi\.org\/10\./g;

/**
 * A chunk of a reference list ("Diabetes Care. 2021;44(10):2225-2230", "doi:10."): three or more full citations.
 * Such chunks match questions by topic words in paper titles but carry no answer; body text cites by number.
 */
export function isReferenceListChunk(text: string): boolean {
  return (text.match(CITATION)?.length ?? 0) >= 3;
}

/** Brute-force cosine top-k (a few thousand chunks need no ANN index); reference-list chunks are skipped by default. */
export function retrieveTopK(index: LoadedIndex, query: ArrayLike<number>, k: number, options: { includeReferenceLists?: boolean } = {}): RetrievedChunk[] {
  if (!(Number.isInteger(k) && k > 0)) throw new RagIndexError('k must be a positive integer.');
  return index.vectors
    .map((vector, position) => ({ position, score: cosineSimilarity(vector, query) }))
    .filter(({ position }) => options.includeReferenceLists || !isReferenceListChunk(index.file.chunks[position].text))
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map(({ position, score }, rank) => {
      const { embedding_b64: _embedding, ...chunk } = index.file.chunks[position];
      return { rank: rank + 1, score, chunk };
    });
}

const STOPWORDS = new Set(
  ('a an and are as at be by can do does for from has have how i if in into is it its my of on or should than that the their '
    + 'there these this to was what when which while who why will with within without your you').split(' '),
);

/** Crude English stemming so "ketones"/"ketone" and "reduced"/"reducing"/"reduce" meet; numbers stay as they are. */
function stem(token: string): string {
  if (/^\d/.test(token)) return token;
  let word = token;
  if (word.length > 4 && word.endsWith('ies')) word = `${word.slice(0, -3)}y`;
  else if (word.length > 3 && word.endsWith('s') && !/(?:ss|us|is)$/.test(word)) word = word.slice(0, -1);
  if (word.length > 5 && word.endsWith('ing')) word = word.slice(0, -3);
  else if (word.length > 4 && word.endsWith('ed')) word = word.slice(0, -2);
  return word.length > 4 && word.endsWith('e') ? word.slice(0, -1) : word;
}

/** Lower-cased word and number tokens without English stop words ("0.05", "tdd", "ketone"). */
export function lexicalTokens(text: string): string[] {
  return (text.toLowerCase().match(/\p{L}[\p{L}\p{N}]*|\d+(?:[.,]\d+)?/gu) ?? [])
    .filter((token) => (token.length > 1 || /\d/.test(token)) && !STOPWORDS.has(token))
    .map(stem);
}

interface LexicalIndex {
  terms: Array<Map<string, number>>;
  lengths: number[];
  averageLength: number;
  documentFrequency: Map<string, number>;
}

const lexicalIndexes = new WeakMap<LoadedIndex, LexicalIndex>();

function lexicalIndex(index: LoadedIndex): LexicalIndex {
  const cached = lexicalIndexes.get(index);
  if (cached) return cached;
  const documentFrequency = new Map<string, number>();
  const terms = index.file.chunks.map((chunk) => {
    const counts = new Map<string, number>();
    for (const token of lexicalTokens(`${chunk.title} ${chunk.section ?? ''} ${chunk.text}`)) counts.set(token, (counts.get(token) ?? 0) + 1);
    for (const token of counts.keys()) documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
    return counts;
  });
  const lengths = terms.map((counts) => [...counts.values()].reduce((sum, count) => sum + count, 0));
  const built = { terms, lengths, averageLength: lengths.reduce((sum, length) => sum + length, 0) / Math.max(1, lengths.length), documentFrequency };
  lexicalIndexes.set(index, built);
  return built;
}

/** Okapi BM25 (k1 1.2, b 0.75) of every chunk for the query text; 0 where no query term occurs. */
export function bm25Scores(index: LoadedIndex, query: string): number[] {
  const lexical = lexicalIndex(index);
  const total = lexical.terms.length;
  const queryTerms = [...new Set(lexicalTokens(query))];
  return lexical.terms.map((counts, position) => {
    let score = 0;
    for (const term of queryTerms) {
      const frequency = counts.get(term);
      if (!frequency) continue;
      const df = lexical.documentFrequency.get(term) ?? 0;
      const idf = Math.log(1 + (total - df + 0.5) / (df + 0.5));
      score += (idf * frequency * 2.2) / (frequency + 1.2 * (0.25 + (0.75 * lexical.lengths[position]) / lexical.averageLength));
    }
    return score;
  });
}

export interface HybridQuery {
  /** Query vectors, each a candidate list named for the report (e.g. "pl" for the question, "en" for its rewrite). */
  vectors: ReadonlyArray<{ name: string; vector: ArrayLike<number> }>;
  /** Optional BM25 candidate list (an English query matches the English corpus words). */
  lexical?: { name: string; text: string } | null;
  /** Candidates taken from each list before fusion. */
  candidates: number;
  /** Chunks returned after fusion. */
  k: number;
  /** At most this many chunks per source file, skipping the extra ones in fused order (unset: no limit). */
  maxPerSource?: number;
  /**
   * Maximal marginal relevance over the fused top `candidates` (unset: plain fused order): each next chunk maximises
   * λ · fused score / best fused score − (1 − λ) · its highest cosine to the chunks already chosen, with λ = diversity.
   */
  diversity?: number;
  includeReferenceLists?: boolean;
}

/** Reciprocal rank fusion constant (Cormack et al. 2009): rank 1 adds 1/61, rank 16 adds 1/76. */
const RRF_K = 60;

type FusedEntry = [position: number, fused: { score: number; ranks: Record<string, number> }];

function capPerSource(index: LoadedIndex, ordered: readonly FusedEntry[], max: number): FusedEntry[] {
  const taken = new Map<string, number>();
  return ordered.filter(([position]) => {
    const source = index.file.chunks[position].source_file;
    taken.set(source, (taken.get(source) ?? 0) + 1);
    return taken.get(source)! <= max;
  });
}

function maximalMarginalRelevance(index: LoadedIndex, candidates: readonly FusedEntry[], k: number, lambda: number): FusedEntry[] {
  const pool = [...candidates];
  const best = pool[0]?.[1].score || 1;
  const chosen: FusedEntry[] = [];
  while (chosen.length < k && pool.length) {
    let pick = 0;
    let pickValue = -Infinity;
    pool.forEach(([position, { score }], offset) => {
      const redundancy = chosen.reduce((max, [other]) => Math.max(max, cosineSimilarity(index.vectors[position], index.vectors[other])), 0);
      const value = lambda * (score / best) - (1 - lambda) * redundancy;
      if (value > pickValue) {
        pickValue = value;
        pick = offset;
      }
    });
    chosen.push(pool.splice(pick, 1)[0]);
  }
  return chosen;
}

/**
 * Hybrid retrieval: the top `candidates` chunks of every list (cosine per query vector, BM25 for the lexical query)
 * are merged by reciprocal rank fusion, so a chunk that several lists rank high beats one list's outlier; the best
 * `k` are returned with their per-list ranks. Reference-list chunks are skipped as in retrieveTopK. Optionally the
 * fused list keeps at most `maxPerSource` chunks of one file, and `diversity` picks the k by maximal marginal relevance
 * so near-duplicate pages of one guide (stage 1: five Dexcom G7 pages for Q20) leave room for other sources.
 */
export function retrieveHybrid(index: LoadedIndex, query: HybridQuery): RetrievedChunk[] {
  if (!(Number.isInteger(query.k) && query.k > 0) || !(Number.isInteger(query.candidates) && query.candidates >= query.k)) {
    throw new RagIndexError('Hybrid retrieval needs integers candidates >= k > 0.');
  }
  if (!query.vectors.length && !query.lexical) throw new RagIndexError('Hybrid retrieval needs a query vector or a lexical query.');
  if (query.maxPerSource !== undefined && !(Number.isInteger(query.maxPerSource) && query.maxPerSource > 0)) throw new RagIndexError('maxPerSource must be a positive integer.');
  if (query.diversity !== undefined && !(query.diversity >= 0 && query.diversity <= 1)) throw new RagIndexError('diversity must be between 0 and 1.');
  const eligible = index.file.chunks.map((chunk) => query.includeReferenceLists || !isReferenceListChunk(chunk.text));
  const lists: Array<{ name: string; scores: number[] }> = query.vectors.map(({ name, vector }) => {
    if (vector.length !== index.file.dimensions) throw new RagIndexError(`Query vector ${name} has ${vector.length} dimensions, index has ${index.file.dimensions}.`);
    return { name, scores: index.vectors.map((chunkVector) => cosineSimilarity(chunkVector, vector)) };
  });
  if (query.lexical) lists.push({ name: query.lexical.name, scores: bm25Scores(index, query.lexical.text) });

  const fused = new Map<number, { score: number; ranks: Record<string, number> }>();
  for (const { name, scores } of lists) {
    scores
      .map((score, position) => ({ position, score }))
      .filter(({ position, score }) => eligible[position] && score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, query.candidates)
      .forEach(({ position }, offset) => {
        const entry = fused.get(position) ?? { score: 0, ranks: {} };
        entry.score += 1 / (RRF_K + offset + 1);
        entry.ranks[name] = offset + 1;
        fused.set(position, entry);
      });
  }
  const ordered: FusedEntry[] = [...fused.entries()]
    .sort((a, b) => b[1].score - a[1].score || Math.min(...Object.values(a[1].ranks)) - Math.min(...Object.values(b[1].ranks)) || a[0] - b[0]);
  const pool = query.maxPerSource ? capPerSource(index, ordered, query.maxPerSource) : ordered;
  const chosen = query.diversity === undefined ? pool.slice(0, query.k) : maximalMarginalRelevance(index, pool.slice(0, query.candidates), query.k, query.diversity);
  return chosen.map(([position, { score, ranks }], rank) => {
    const { embedding_b64: _embedding, ...chunk } = index.file.chunks[position];
    return { rank: rank + 1, score, chunk, ranks };
  });
}

/** Batches by count and by bytes so one call stays far below the per-call cost limit and the request size limit. */
export function embeddingBatches(texts: readonly string[], maxItems = 128, maxBytes = 200_000): number[][] {
  const batches: number[][] = [];
  let current: number[] = [];
  let bytes = 0;
  texts.forEach((text, position) => {
    const size = Buffer.byteLength(text, 'utf8');
    if (current.length && (current.length >= maxItems || bytes + size > maxBytes)) {
      batches.push(current);
      current = [];
      bytes = 0;
    }
    current.push(position);
    bytes += size;
  });
  if (current.length) batches.push(current);
  return batches;
}

function parseEmbeddingResponse(response: Record<string, unknown>, expected: number): number[][] {
  const data = Array.isArray(response.data) ? (response.data as Array<Record<string, unknown>>) : [];
  if (data.length !== expected) throw new RagIndexError(`Embeddings response has ${data.length} vectors, expected ${expected}.`);
  const vectors: number[][] = new Array(expected);
  for (const item of data) {
    const position = item.index;
    if (!(typeof position === 'number' && Number.isInteger(position) && position >= 0 && position < expected) || vectors[position]) {
      throw new RagIndexError('Embeddings response has an invalid or repeated index.');
    }
    if (!Array.isArray(item.embedding) || !item.embedding.every((value) => typeof value === 'number')) throw new RagIndexError('Embeddings response has a non-numeric vector.');
    vectors[position] = item.embedding as number[];
  }
  return vectors;
}

/** Embeds texts in batches through the (guarded) transport; the first failed batch throws. */
export async function embedTexts(
  client: OpenAiEmbeddingsTransport,
  model: string,
  texts: readonly string[],
  onBatch?: (done: number, total: number) => void,
): Promise<number[][]> {
  const result: number[][] = new Array(texts.length);
  const batches = embeddingBatches(texts);
  for (const [batchNumber, batch] of batches.entries()) {
    const response = await client.embeddings.create({ model, input: batch.map((position) => texts[position]), encoding_format: 'float' });
    parseEmbeddingResponse(response, batch.length).forEach((vector, offset) => {
      result[batch[offset]] = vector;
    });
    onBatch?.(batchNumber + 1, batches.length);
  }
  const dimensions = result[0]?.length ?? 0;
  if (!dimensions || result.some((vector) => vector.length !== dimensions)) throw new RagIndexError('Embeddings have inconsistent dimensions.');
  return result;
}

/** Cache key of a query embedding: model and exact text. */
export function queryCacheKey(model: string, text: string): string {
  return createHash('sha256').update(`${model}\n${text}`).digest('hex');
}

// Query-side helpers (glossary expansion, labels) live in the knowledge module, which the assistant uses too.
export { chunkLabel, glossaryExpansion, type GlossaryEntry } from '@modules/knowledge/application/knowledge-query';
