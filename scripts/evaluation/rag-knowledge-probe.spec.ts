import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

vi.mock('dotenv/config', () => ({}));

import { EvaluationOutputDirError } from './evaluation-output-dir';
import {
  GLOSSARY,
  ProbeArgumentError,
  QUESTIONS,
  RERANK_PROMPT_VERSION,
  REWRITE_PROMPT_VERSION,
  applyRerank,
  buildRequest,
  buildRerankRequest,
  buildRetrievedRequest,
  excerptTemplate,
  lightPricingEnv,
  main,
  mismatchedSource,
  parseExcerpts,
  parseRerank,
  parseRewrite,
  type ExcerptEntry,
} from './rag-knowledge-probe';
import { RAG_INDEX_VERSION, encodeVector, type RagIndexFile, type RetrievedChunk } from './rag-retrieval';

const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'rag-knowledge-probe-')));
afterAll(() => rmSync(sandbox, { recursive: true, force: true }));

function filled(ids: string[]): ExcerptEntry[] {
  return excerptTemplate().map((entry) => (ids.includes(entry.id) ? { ...entry, source_label: `Źródło ${entry.id}`, excerpt: `Treść ${entry.id}` } : entry));
}

describe('question set', () => {
  it('has 30 questions with unique ids, key points and a source hint', () => {
    expect(QUESTIONS).toHaveLength(30);
    expect(new Set(QUESTIONS.map((q) => q.id)).size).toBe(30);
    for (const q of QUESTIONS) {
      expect(q.question.trim()).not.toBe('');
      expect(q.key_points.length).toBeGreaterThan(0);
      expect(q.source_hint.trim()).not.toBe('');
    }
  });

  it('includes control, population-mismatch and anomaly probes', () => {
    expect(QUESTIONS.filter((q) => q.probe === 'control').length).toBeGreaterThanOrEqual(2);
    expect(QUESTIONS.some((q) => q.probe === 'population_mismatch')).toBe(true);
    const anomalies = QUESTIONS.filter((q) => q.probe === 'anomaly');
    expect(anomalies.map((q) => q.id)).toEqual(['Q26', 'Q27', 'Q28', 'Q29', 'Q30']);
    for (const q of anomalies) expect(q.red_flags.length).toBeGreaterThan(0);
  });

  it('keeps the query glossary well formed', () => {
    for (const entry of GLOSSARY) {
      expect(entry.match.length).toBeGreaterThan(0);
      expect(entry.expand.length).toBeGreaterThan(0);
      for (const term of entry.match) expect(term).toBe(term.toLowerCase());
    }
  });
});

describe('excerpts', () => {
  it('accepts the template and a filled entry', () => {
    const map = parseExcerpts(JSON.stringify(filled(['Q01'])));
    expect(map.get('Q01')?.excerpt).toBe('Treść Q01');
    expect(map.get('Q02')?.excerpt).toBe('');
  });

  it('refuses unknown ids, duplicates, an excerpt without label and overlong excerpts', () => {
    expect(() => parseExcerpts(JSON.stringify([{ id: 'Q99', excerpt: '', source_label: '' }]))).toThrow(ProbeArgumentError);
    const one = filled(['Q01'])[0];
    expect(() => parseExcerpts(JSON.stringify([one, one]))).toThrow(ProbeArgumentError);
    expect(() => parseExcerpts(JSON.stringify([{ ...one, source_label: ' ' }]))).toThrow(ProbeArgumentError);
    expect(() => parseExcerpts(JSON.stringify([{ ...one, excerpt: 'x'.repeat(6001) }]))).toThrow(ProbeArgumentError);
  });

  it('picks the next question with a fragment for the mismatched variant, never its own', () => {
    const map = parseExcerpts(JSON.stringify(filled(['Q03', 'Q10'])));
    const ids = QUESTIONS.map((q) => q.id);
    expect(mismatchedSource('Q03', ids, map)?.id).toBe('Q10');
    expect(mismatchedSource('Q10', ids, map)?.id).toBe('Q03');
    expect(mismatchedSource('Q25', ids, map)?.id).toBe('Q03');
    expect(mismatchedSource('Q03', ids, parseExcerpts(JSON.stringify(filled(['Q03']))))).toBeNull();
  });

  it('puts the fragment and its label in the request only for the source variant', () => {
    const plain = buildRequest('model-x', 'Pytanie?', null);
    expect(String(plain.input)).toBe('Pytanie: Pytanie?');
    expect(String(plain.instructions)).not.toContain('[S1]');
    const withSource = buildRequest('model-x', 'Pytanie?', filled(['Q01'])[0]);
    expect(String(withSource.input)).toContain('Fragment źródła [S1] (Źródło Q01)');
    expect(String(withSource.input)).toContain('Treść Q01');
    expect(String(withSource.instructions)).toContain('[S1]');
  });
});

describe('main', () => {
  it('refuses an output directory inside the repository before writing anything', async () => {
    const repoRoot = resolve(__dirname, '../..');
    await expect(main(['--output-dir', join(repoRoot, 'artifacts', 'rag')])).rejects.toBeInstanceOf(EvaluationOutputDirError);
    await expect(main([])).rejects.toBeInstanceOf(EvaluationOutputDirError);
  });

  it('writes the template once and refuses to overwrite it', async () => {
    const dir = join(sandbox, 'init');
    await main(['--output-dir', dir, '--init-excerpts']);
    expect(JSON.parse(readFileSync(join(dir, 'excerpts.json'), 'utf8'))).toHaveLength(30);
    await expect(main(['--output-dir', dir, '--init-excerpts'])).rejects.toBeInstanceOf(ProbeArgumentError);
  });

  it('dry run sends nothing and writes no report', async () => {
    const dir = join(sandbox, 'dry');
    const create = vi.fn();
    await main(['--output-dir', dir], { responses: { create } });
    expect(create).not.toHaveBeenCalled();
  });

  it('live run asks A, B and C and writes JSON and Markdown reports', async () => {
    const dir = join(sandbox, 'live');
    await main(['--output-dir', dir, '--init-excerpts']);
    writeFileSync(join(dir, 'excerpts.json'), JSON.stringify(filled(['Q01', 'Q02'])));
    const create = vi.fn(async (body: Record<string, unknown>) => ({ output_text: `odp: ${String(body.input).slice(0, 20)}`, usage: { input_tokens: 100, output_tokens: 50 } }));
    await main(['--output-dir', dir, '--live', '--with-mismatch', '--only', 'Q01,Q03', '--model', 'model-x'], { responses: { create } });

    // Q01: A, B, C (fragment from Q02); Q03: A, C (no own fragment).
    expect(create).toHaveBeenCalledTimes(5);
    const reports = readdirSync(dir).filter((name) => name.startsWith('rag-probe-'));
    expect(reports.filter((name) => name.endsWith('.md'))).toHaveLength(1);
    const json = JSON.parse(readFileSync(join(dir, reports.find((name) => name.endsWith('.json'))!), 'utf8'));
    expect(json.calls).toBe(5);
    expect(json.input_tokens).toBe(500);
    expect(json.rows[0].results.map((r: { variant: string }) => r.variant)).toEqual(['A_no_source', 'B_matching_source', 'C_mismatched_source']);
    expect(json.rows[0].results[2].source_from).toBe('Q02');
    const md = readFileSync(join(dir, reports.find((name) => name.endsWith('.md'))!), 'utf8');
    expect(md).toContain('## Q01');
    expect(md).toContain('B — z pasującym fragmentem');
  });

  it('stops at the first failed call and still writes the report', async () => {
    const dir = join(sandbox, 'fail');
    const create = vi.fn().mockResolvedValueOnce({ output_text: 'ok' }).mockRejectedValueOnce(new Error('boom'));
    await main(['--output-dir', dir, '--live', '--only', 'Q01,Q02,Q03', '--model', 'model-x'], { responses: { create } });
    expect(create).toHaveBeenCalledTimes(2);
    const json = JSON.parse(readFileSync(join(dir, readdirSync(dir).find((name) => name.endsWith('.json'))!), 'utf8'));
    expect(json.stopped_early).toBe(true);
    expect(json.rows).toHaveLength(2);
  });

  it('refuses unknown arguments and unknown --only ids', async () => {
    const dir = join(sandbox, 'args');
    await expect(main(['--output-dir', dir, '--liv'])).rejects.toBeInstanceOf(ProbeArgumentError);
    await expect(main(['--output-dir', dir, '--only', 'Q77'])).rejects.toBeInstanceOf(ProbeArgumentError);
  });
});

// Fake embeddings: one dimension per keyword, so a question shares a direction with the chunk that uses its keywords.
const VOCABULARY = ['keton', 'glukagon', 'trio', 'trening'];
function fakeVector(text: string): number[] {
  const lower = text.toLowerCase();
  return [...VOCABULARY.map((word) => lower.split(word).length - 1), 0.01];
}

function fakeEmbeddings() {
  return vi.fn(async (body: Record<string, unknown>) => ({
    data: (body.input as string[]).map((text, index) => ({ index, embedding: fakeVector(text) })),
    usage: { prompt_tokens: 5 },
  }));
}

/** `fillers` adds chunks without keywords (they still score above 0) so a test can tell how many chunks are taken. */
function writeIndex(dir: string, fillers = 0): string {
  const texts = [
    ['sick.pdf#1', 'ISPAD Sick day', '8.1 Ketone monitoring', 'Ketony 0,6–1,4 mmol/L: dodatkowo 5–10% TDD. keton keton'],
    ['sick.pdf#2', 'ISPAD Sick day', '7.3 Mini-dose glucagon', 'Mini-dawka glukagonu: 20 µg na rok życia. glukagon'],
    ['trio.md#1', 'Trio docs', 'Temporary targets', 'Trio: tymczasowy cel przed treningiem. trio trening'],
    ...Array.from({ length: fillers }, (_, position) => [`other.md#${position + 1}`, 'Other', null, `Inny tekst ${position + 1}`]),
  ] as Array<[string, string, string | null, string]>;
  const file: RagIndexFile = {
    version: RAG_INDEX_VERSION,
    embedding_model: 'fake-embedding',
    dimensions: VOCABULARY.length + 1,
    created_at: '2026-10-16T00:00:00.000Z',
    chunking: { target_tokens: 600, overlap_tokens: 100 },
    chunks: texts.map(([id, title, section, text]) => ({ id, source_file: id.split('#')[0], title, section, page: 3, page_end: 3, text, tokens_estimate: 20, embedding_b64: encodeVector(fakeVector(text)) })),
  };
  const path = join(dir, 'rag-index.json');
  writeFileSync(path, JSON.stringify(file));
  return path;
}

describe('retrieved mode', () => {
  it('labels every retrieved chunk [S1..Sk] with title, section and page and uses the multi-source rules', () => {
    const chunk = { id: 'a#1', source_file: 'a', title: 'ISPAD Sick day', section: '8.1 Ketone monitoring', page: 3, page_end: 3, text: 'Treść A', tokens_estimate: 2 };
    const request = buildRetrievedRequest('model-x', 'Pytanie?', [{ rank: 1, score: 0.9, chunk }, { rank: 2, score: 0.5, chunk: { ...chunk, id: 'a#2', text: 'Treść B', section: null, page: null, page_end: null } }]);
    expect(String(request.input)).toContain('Fragment źródła [S1] (ISPAD Sick day, sekcja 8.1 Ketone monitoring, s. 3):');
    expect(String(request.input)).toContain('Fragment źródła [S2] (ISPAD Sick day):');
    expect(String(request.input).endsWith('Pytanie: Pytanie?')).toBe(true);
    expect(String(request.instructions)).toContain('wybrane automatycznie');
  });

  it('tells the model to answer from general knowledge when the fragments miss and to keep tables within their caption', () => {
    const instructions = String(buildRetrievedRequest('model-x', 'Pytanie?', []).instructions);
    expect(instructions).toContain('nie odmawiaj: odpowiedz z ogólnej wiedzy medycznej i zaznacz to');
    expect(instructions).toContain('Tabelę stosuj tylko do sytuacji z jej tytułu i nagłówków');
    expect(instructions).not.toContain('Korzystaj tylko z fragmentów');
  });

  it('asks for guideline doses and percentages missing from the fragments from general knowledge, marked', () => {
    const instructions = String(buildRetrievedRequest('model-x', 'Pytanie?', []).instructions);
    expect(instructions).toContain('dawki, procenty lub progi z wytycznych, których fragmenty nie podają, podaj je z wiedzy ogólnej (oznaczone jak wyżej)');
  });

  it('pastes six fused chunks by default', async () => {
    const dir = join(sandbox, 'retrieved-default-k');
    mkdirSync(dir, { recursive: true });
    const index = writeIndex(dir, 5);
    const create = vi.fn(async (_body: Record<string, unknown>) => ({ output_text: 'odp', usage: { input_tokens: 10, output_tokens: 2 } }));
    await main(['--output-dir', dir, '--retrieved-index', index, '--live', '--only', 'Q06', '--candidates', '8', '--model', 'model-x'], { responses: { create } }, { embeddings: { create: fakeEmbeddings() } });
    const json = JSON.parse(readFileSync(join(dir, readdirSync(dir).find((name) => name.startsWith('rag-probe-') && name.endsWith('.json'))!), 'utf8'));
    expect(json).toMatchObject({ top_k: 6 });
    expect(json.rows[0].results[0]).toMatchObject({ source_from: 'top-6' });
    expect(json.rows[0].results[0].retrieved).toHaveLength(6);
    expect(json.rows[0].results[0].retrieved[0]).toMatchObject({ chunk_id: 'sick.pdf#1' });
    expect(String(create.mock.calls[0][0].input).match(/Fragment źródła \[S\d\]/g)).toHaveLength(6);
  });

  it('cleans the rewrite reply and maps the light model prices onto the guarded client variables', () => {
    expect(parseRewrite('\nQuery: "sick day ketones total daily dose"\nWhy: ...')).toBe('sick day ketones total daily dose');
    expect(parseRewrite('   ')).toBeNull();
    expect(parseRewrite('Ąę 12')).toBeNull();
    const env = lightPricingEnv({ OPENAI_PRICING_INPUT_PER_1K_TOKENS: '0.002', OPENAI_LIGHT_PRICING_INPUT_PER_1K_TOKENS: '0.0002', OPENAI_LIGHT_PRICING_VERSION: 'luna', AI_EXPERIMENT_MAX_COST: '0.25' });
    expect(env).toMatchObject({ OPENAI_PRICING_INPUT_PER_1K_TOKENS: '0.0002', OPENAI_PRICING_VERSION: 'luna', AI_EXPERIMENT_MAX_COST: '0.25' });
  });

  it('rewrites the question once with the rewrite model, caches it and fuses Polish, English and BM25 candidates', async () => {
    const dir = join(sandbox, 'retrieved-rewrite');
    mkdirSync(dir, { recursive: true });
    const index = writeIndex(dir);
    const chat = vi.fn();
    const rewrite = vi.fn(async (_body: Record<string, unknown>) => ({ output_text: 'Query: "ketone monitoring keton"', usage: { input_tokens: 120, output_tokens: 8 } }));
    const embed = fakeEmbeddings();
    const argv = ['--output-dir', dir, '--retrieved-index', index, '--retrieval-only', '--live', '--only', 'Q14', '--top-k', '1', '--candidates', '3', '--rewrite-query', '--rewrite-model', 'light-x'];
    await main(argv, { responses: { create: chat } }, { embeddings: { create: embed } }, { responses: { create: rewrite } });

    expect(chat).not.toHaveBeenCalled();
    expect(rewrite).toHaveBeenCalledTimes(1);
    expect(rewrite.mock.calls[0][0]).toMatchObject({ model: 'light-x', input: QUESTIONS.find((q) => q.id === 'Q14')!.question });
    expect(String(rewrite.mock.calls[0][0].instructions)).toContain('English search query');
    expect(embed).toHaveBeenCalledTimes(1);
    expect((embed.mock.calls[0][0] as { input: string[] }).input).toEqual([QUESTIONS.find((q) => q.id === 'Q14')!.question, 'ketone monitoring keton']);

    const report = readdirSync(dir).find((name) => name.startsWith('rag-retrieval-') && name.endsWith('.json'))!;
    const json = JSON.parse(readFileSync(join(dir, report), 'utf8'));
    expect(json).toMatchObject({ top_k: 1, candidates: 3, rewrite_model: 'light-x', rewrite_prompt_version: REWRITE_PROMPT_VERSION });
    expect(json.rows[0]).toMatchObject({ id: 'Q14', rewrite: 'ketone monitoring keton' });
    expect(json.rows[0].hits[0]).toMatchObject({ chunk_id: 'sick.pdf#1', ranks: { pl: 3, en: 1, bm25: 1 } });
    const cached = JSON.parse(readFileSync(join(dir, 'query-rewrites.json'), 'utf8'));
    expect(Object.values(cached)).toEqual([expect.objectContaining({ id: 'Q14', model: 'light-x', prompt_version: REWRITE_PROMPT_VERSION, query: 'ketone monitoring keton' })]);
    const md = readFileSync(join(dir, report.replace(/\.json$/, '.md')), 'utf8');
    expect(md).toContain('**Zapytanie EN:** ketone monitoring keton');
    expect(md).toContain('(pl#3 en#1 bm25#1)');

    // Second run: the rewrite and both vectors come from the caches.
    await main(argv, { responses: { create: chat } }, { embeddings: { create: embed } }, { responses: { create: rewrite } });
    expect(rewrite).toHaveBeenCalledTimes(1);
    expect(embed).toHaveBeenCalledTimes(1);
  });

  it('stops before any chat call when a rewrite fails', async () => {
    const dir = join(sandbox, 'retrieved-rewrite-fail');
    mkdirSync(dir, { recursive: true });
    const index = writeIndex(dir);
    const chat = vi.fn();
    const rewrite = vi.fn().mockRejectedValueOnce(new Error('refused'));
    await expect(main(['--output-dir', dir, '--retrieved-index', index, '--live', '--only', 'Q06,Q07', '--rewrite-query', '--rewrite-model', 'light-x', '--model', 'model-x'], { responses: { create: chat } }, { embeddings: { create: fakeEmbeddings() } }, { responses: { create: rewrite } })).rejects.toThrow('refused');
    expect(rewrite).toHaveBeenCalledTimes(1);
    expect(chat).not.toHaveBeenCalled();
    expect(readdirSync(dir).some((name) => name.startsWith('rag-probe-'))).toBe(false);
  });

  it('dry run reads the index and sends nothing', async () => {
    const dir = join(sandbox, 'retrieved-dry');
    mkdirSync(dir, { recursive: true });
    const index = writeIndex(dir);
    const create = vi.fn();
    const embed = fakeEmbeddings();
    await main(['--output-dir', dir, '--retrieved-index', index], { responses: { create } }, { embeddings: { create: embed } });
    expect(create).not.toHaveBeenCalled();
    expect(embed).not.toHaveBeenCalled();
  });

  it('retrieval-only embeds the questions once, caches them and writes the retrieval report without chat calls', async () => {
    const dir = join(sandbox, 'retrieved-only');
    mkdirSync(dir, { recursive: true });
    const index = writeIndex(dir);
    const create = vi.fn();
    const embed = fakeEmbeddings();
    const argv = ['--output-dir', dir, '--retrieved-index', index, '--retrieval-only', '--live', '--only', 'Q06,Q07,Q09', '--top-k', '2'];
    await main(argv, { responses: { create } }, { embeddings: { create: embed } });
    expect(create).not.toHaveBeenCalled();
    expect(embed).toHaveBeenCalledTimes(1);
    expect((embed.mock.calls[0][0] as { input: string[] }).input).toHaveLength(3);

    const report = readdirSync(dir).find((name) => name.startsWith('rag-retrieval-') && name.endsWith('.json'))!;
    const json = JSON.parse(readFileSync(join(dir, report), 'utf8'));
    expect(json.rows.map((row: { id: string; hits: Array<{ chunk_id: string }> }) => [row.id, row.hits[0].chunk_id])).toEqual([
      ['Q06', 'sick.pdf#1'],
      ['Q07', 'sick.pdf#2'],
      ['Q09', 'trio.md#1'],
    ]);
    expect(json.rows[0].hits).toHaveLength(2);
    expect(readdirSync(dir).some((name) => name.startsWith('rag-probe-'))).toBe(false);

    // Second run: query vectors come from query-embeddings.json.
    await main(argv, { responses: { create } }, { embeddings: { create: embed } });
    expect(embed).toHaveBeenCalledTimes(1);
  });

  it('live run asks only R with the retrieved chunks and records them in the report', async () => {
    const dir = join(sandbox, 'retrieved-live');
    mkdirSync(dir, { recursive: true });
    const index = writeIndex(dir);
    const create = vi.fn(async (_body: Record<string, unknown>) => ({ output_text: 'odp [S1]', usage: { input_tokens: 300, output_tokens: 60 } }));
    await main(['--output-dir', dir, '--retrieved-index', index, '--live', '--only', 'Q06,Q09', '--top-k', '1', '--model', 'model-x'], { responses: { create } }, { embeddings: { create: fakeEmbeddings() } });

    expect(create).toHaveBeenCalledTimes(2);
    expect(String(create.mock.calls[0][0].input)).toContain('Ketony 0,6–1,4 mmol/L');
    const reports = readdirSync(dir).filter((name) => name.startsWith('rag-probe-'));
    const json = JSON.parse(readFileSync(join(dir, reports.find((name) => name.endsWith('.json'))!), 'utf8'));
    expect(json).toMatchObject({ mode: 'retrieved', top_k: 1, calls: 2, input_tokens: 600, embedding_model: 'fake-embedding' });
    expect(json.rows[0].results[0]).toMatchObject({ variant: 'R_retrieved_sources', source_from: 'top-1', answer: 'odp [S1]' });
    expect(json.rows[0].results[0].retrieved[0]).toMatchObject({ rank: 1, chunk_id: 'sick.pdf#1', label: 'ISPAD Sick day, sekcja 8.1 Ketone monitoring, s. 3' });
    const md = readFileSync(join(dir, reports.find((name) => name.endsWith('.md'))!), 'utf8');
    expect(md).toContain('R — z fragmentami z wyszukiwania');
    expect(md).toContain('**Wyszukane fragmenty:**');
  });

  it('stops at the first failed chat call and still writes the report', async () => {
    const dir = join(sandbox, 'retrieved-fail');
    mkdirSync(dir, { recursive: true });
    const index = writeIndex(dir);
    const create = vi.fn().mockRejectedValueOnce(new Error('boom'));
    await main(['--output-dir', dir, '--retrieved-index', index, '--live', '--only', 'Q06,Q07', '--model', 'model-x'], { responses: { create } }, { embeddings: { create: fakeEmbeddings() } });
    expect(create).toHaveBeenCalledTimes(1);
    const json = JSON.parse(readFileSync(join(dir, readdirSync(dir).find((name) => name.startsWith('rag-probe-') && name.endsWith('.json'))!), 'utf8'));
    expect(json.stopped_early).toBe(true);
    expect(json.rows[0].results[0].error).toBe('Error');
  });

  it('refuses a missing index, bad --top-k and incompatible flags', async () => {
    const dir = join(sandbox, 'retrieved-args');
    mkdirSync(dir, { recursive: true });
    const index = writeIndex(dir);
    await expect(main(['--output-dir', dir, '--retrieved-index', join(dir, 'missing.json')])).rejects.toBeInstanceOf(ProbeArgumentError);
    await expect(main(['--output-dir', dir, '--retrieved-index', index, '--top-k', '0'])).rejects.toBeInstanceOf(ProbeArgumentError);
    await expect(main(['--output-dir', dir, '--retrieved-index', index, '--with-mismatch'])).rejects.toBeInstanceOf(ProbeArgumentError);
    await expect(main(['--output-dir', dir, '--retrieval-only'])).rejects.toBeInstanceOf(ProbeArgumentError);
    await expect(main(['--output-dir', dir, '--rewrite-query'])).rejects.toBeInstanceOf(ProbeArgumentError);
    await expect(main(['--output-dir', dir, '--retrieved-index', index, '--top-k', '7'])).rejects.toBeInstanceOf(ProbeArgumentError);
    await expect(main(['--output-dir', dir, '--retrieved-index', index, '--candidates', '3'])).rejects.toBeInstanceOf(ProbeArgumentError);
    await expect(main(['--output-dir', dir, '--retrieved-index', index, '--rewrite-model', 'light-x'])).rejects.toBeInstanceOf(ProbeArgumentError);
    await expect(main(['--output-dir', dir, '--expand-query'])).rejects.toBeInstanceOf(ProbeArgumentError);
    await expect(main(['--output-dir', dir, '--retrieved-index', index, '--repeat', '3'])).rejects.toBeInstanceOf(ProbeArgumentError);
    await expect(main(['--output-dir', dir, '--retrieved-index', index, '--only', 'Q06', '--repeat', '6'])).rejects.toBeInstanceOf(ProbeArgumentError);
    await expect(main(['--output-dir', dir, '--retrieved-index', index, '--only', 'Q06', '--repeat', '2', '--retrieval-only'])).rejects.toBeInstanceOf(ProbeArgumentError);
    await expect(main(['--output-dir', dir, '--retrieved-index', index, '--max-per-source', '0'])).rejects.toBeInstanceOf(ProbeArgumentError);
    await expect(main(['--output-dir', dir, '--retrieved-index', index, '--diversity', '2'])).rejects.toBeInstanceOf(ProbeArgumentError);
    await expect(main(['--output-dir', dir, '--retrieved-index', index, '--rerank-model', 'light-x'])).rejects.toBeInstanceOf(ProbeArgumentError);
    await expect(main(['--output-dir', dir, '--retrieved-index', index, '--rerank', '--diversity', '0.7'])).rejects.toBeInstanceOf(ProbeArgumentError);
    await expect(main(['--output-dir', dir, '--rerank'])).rejects.toBeInstanceOf(ProbeArgumentError);
  });

  it('records the source cap and diversity in the retrieval report', async () => {
    const dir = join(sandbox, 'retrieved-diversity');
    mkdirSync(dir, { recursive: true });
    const index = writeIndex(dir, 3);
    await main(['--output-dir', dir, '--retrieved-index', index, '--retrieval-only', '--live', '--only', 'Q06', '--top-k', '3', '--candidates', '6', '--max-per-source', '2', '--diversity', '0.7'], { responses: { create: vi.fn() } }, { embeddings: { create: fakeEmbeddings() } });
    const report = readdirSync(dir).find((name) => name.startsWith('rag-retrieval-') && name.endsWith('.json'))!;
    const json = JSON.parse(readFileSync(join(dir, report), 'utf8'));
    expect(json).toMatchObject({ max_per_source: 2, diversity: 0.7, rerank_model: null });
    expect(json.rows[0].hits).toHaveLength(3);
    expect(readFileSync(join(dir, report.replace(/\.json$/, '.md')), 'utf8')).toContain('max 2 z jednego pliku · MMR λ 0.7');
  });

  it('numbers the rerank candidates and reads the picked numbers back', () => {
    const chunk = (id: string, text: string) => ({ id, source_file: id.split('#')[0], title: 'ISPAD Nutrition', section: '10.1 Fat and protein', page: 11, page_end: 11, text, tokens_estimate: 2 });
    const candidates: RetrievedChunk[] = [{ rank: 1, score: 0.03, chunk: chunk('a#1', 'Pierwszy'), ranks: { pl: 1 } }, { rank: 2, score: 0.02, chunk: chunk('a#2', 'x'.repeat(2000)), ranks: { bm25: 2 } }];
    const request = buildRerankRequest('light-x', 'Pytanie?', candidates, 6);
    expect(String(request.input)).toContain('[1] ISPAD Nutrition, sekcja 10.1 Fat and protein, s. 11\nPierwszy');
    expect(String(request.input)).toContain(`[2] ISPAD Nutrition, sekcja 10.1 Fat and protein, s. 11\n${'x'.repeat(1200)}…`);
    expect(String(request.instructions)).toContain('at most 6 fragments');
    expect(parseRerank('4, 1, 9, 1, 0', 5, 6)).toEqual([4, 1]);
    expect(parseRerank('[3] then [2]', 5, 1)).toEqual([3]);
    expect(parseRerank('none', 5, 6)).toBeNull();
    // Picked first, then the fused order fills k; a failed rerank keeps the fused order.
    expect(applyRerank(candidates, [2], 2).map((hit) => [hit.chunk.id, hit.rank, hit.ranks])).toEqual([['a#2', 1, { bm25: 2, rerank: 1 }], ['a#1', 2, { pl: 1 }]]);
    expect(applyRerank(candidates, null, 1).map((hit) => hit.chunk.id)).toEqual(['a#1']);
  });

  it('reranks the fused candidates once per question with the rerank model, caches the pick and pastes the picked chunks', async () => {
    const dir = join(sandbox, 'retrieved-rerank');
    mkdirSync(dir, { recursive: true });
    const index = writeIndex(dir, 2);
    const chat = vi.fn(async (_body: Record<string, unknown>) => ({ output_text: 'odp', usage: { input_tokens: 10, output_tokens: 2 } }));
    const rerank = vi.fn(async (body: Record<string, unknown>) => {
      // Picks the candidate about glucagon wherever fusion put it.
      const number = /\[(\d+)\][^[]*glukagon/i.exec(String(body.input))![1];
      return { output_text: number, usage: { input_tokens: 500, output_tokens: 2 } };
    });
    const argv = ['--output-dir', dir, '--retrieved-index', index, '--live', '--only', 'Q06', '--top-k', '2', '--candidates', '5', '--rerank', '--rerank-model', 'light-x', '--model', 'model-x'];
    await main(argv, { responses: { create: chat } }, { embeddings: { create: fakeEmbeddings() } }, undefined, { responses: { create: rerank } });

    expect(rerank).toHaveBeenCalledTimes(1);
    expect(rerank.mock.calls[0][0]).toMatchObject({ model: 'light-x' });
    expect(String(rerank.mock.calls[0][0].input).match(/^\[\d+\] /gm)).toHaveLength(5);
    expect(String(chat.mock.calls[0][0].input)).toMatch(/\[S1\] \(ISPAD Sick day, sekcja 7\.3 Mini-dose glucagon/);
    const report = readdirSync(dir).find((name) => name.startsWith('rag-retrieval-') && name.endsWith('.json'))!;
    const json = JSON.parse(readFileSync(join(dir, report), 'utf8'));
    expect(json).toMatchObject({ rerank_model: 'light-x', rerank_prompt_version: RERANK_PROMPT_VERSION });
    expect(json.rows[0].hits.map((hit: { chunk_id: string }) => hit.chunk_id)).toEqual(['sick.pdf#2', 'sick.pdf#1']);
    expect(json.rows[0].hits[0].ranks).toMatchObject({ rerank: 1 });
    const cached = JSON.parse(readFileSync(join(dir, 'query-reranks.json'), 'utf8'));
    expect(Object.values(cached)).toEqual([expect.objectContaining({ id: 'Q06', model: 'light-x', prompt_version: RERANK_PROMPT_VERSION, picked: [expect.any(Number)] })]);

    // Second run: the pick comes from query-reranks.json.
    await main(argv, { responses: { create: chat } }, { embeddings: { create: fakeEmbeddings() } }, undefined, { responses: { create: rerank } });
    expect(rerank).toHaveBeenCalledTimes(1);
  });

  it('stops before any chat call when a rerank fails', async () => {
    const dir = join(sandbox, 'retrieved-rerank-fail');
    mkdirSync(dir, { recursive: true });
    const index = writeIndex(dir);
    const chat = vi.fn();
    const rerank = vi.fn().mockRejectedValueOnce(new Error('refused'));
    await expect(main(['--output-dir', dir, '--retrieved-index', index, '--live', '--only', 'Q06', '--top-k', '1', '--candidates', '3', '--rerank', '--rerank-model', 'light-x', '--model', 'model-x'], { responses: { create: chat } }, { embeddings: { create: fakeEmbeddings() } }, undefined, { responses: { create: rerank } })).rejects.toThrow('refused');
    expect(chat).not.toHaveBeenCalled();
    expect(readdirSync(dir).some((name) => name.startsWith('rag-probe-') || name.startsWith('rag-retrieval-'))).toBe(false);
  });

  it('adds glossary terms to the BM25 query with --expand-query and records them', async () => {
    const dir = join(sandbox, 'retrieved-expand');
    mkdirSync(dir, { recursive: true });
    const index = writeIndex(dir);
    const embed = fakeEmbeddings();
    // Q06 (ketones on a sick day) has no rewrite here, so BM25 runs on the glossary terms alone.
    await main(['--output-dir', dir, '--retrieved-index', index, '--retrieval-only', '--live', '--only', 'Q06', '--top-k', '1', '--candidates', '3', '--expand-query'], { responses: { create: vi.fn() } }, { embeddings: { create: embed } });
    const report = readdirSync(dir).find((name) => name.startsWith('rag-retrieval-') && name.endsWith('.json'))!;
    const json = JSON.parse(readFileSync(join(dir, report), 'utf8'));
    expect(json.query_glossary).toBe('rag-query-glossary.v2');
    expect(json.rows[0].expansion).toEqual(expect.arrayContaining(['ketones', 'BOHB', 'sick day', 'total daily dose']));
    expect(json.rows[0].hits[0].ranks).toHaveProperty('bm25');
    expect(readFileSync(join(dir, report.replace(/\.json$/, '.md')), 'utf8')).toContain('**Rozszerzenie BM25 (słowniczek):** ketones');
  });

  it('asks a question N times with the same fragments with --repeat and lists the fragments once', async () => {
    const dir = join(sandbox, 'retrieved-repeat');
    mkdirSync(dir, { recursive: true });
    const index = writeIndex(dir);
    let call = 0;
    const create = vi.fn(async (_body: Record<string, unknown>) => ({ output_text: `odp ${(call += 1)}`, usage: { input_tokens: 100, output_tokens: 10 } }));
    await main(['--output-dir', dir, '--retrieved-index', index, '--live', '--only', 'Q02,Q06', '--top-k', '1', '--repeat', '3', '--model', 'model-x'], { responses: { create } }, { embeddings: { create: fakeEmbeddings() } });
    expect(create).toHaveBeenCalledTimes(6);
    expect(create.mock.calls[0][0]).toEqual(create.mock.calls[2][0]);
    const reports = readdirSync(dir).filter((name) => name.startsWith('rag-probe-'));
    const json = JSON.parse(readFileSync(join(dir, reports.find((name) => name.endsWith('.json'))!), 'utf8'));
    expect(json).toMatchObject({ repeat: 3, calls: 6 });
    expect(json.rows[1].results.map((result: { repeat: number; answer: string }) => [result.repeat, result.answer])).toEqual([[1, 'odp 4'], [2, 'odp 5'], [3, 'odp 6']]);
    const md = readFileSync(join(dir, reports.find((name) => name.endsWith('.md'))!), 'utf8');
    expect(md).toContain('powtórzenie 3');
    expect(md.split('**Wyszukane fragmenty:**')).toHaveLength(3);
  });
});
