import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

vi.mock('dotenv/config', () => ({}));

import { EvaluationOutputDirError } from './evaluation-output-dir';
import { IngestArgumentError, htmlToText, loadCorpus, main } from './rag-corpus-ingest';
import { decodeVector, parseIndex } from './rag-retrieval';

const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'rag-corpus-ingest-')));
afterAll(() => rmSync(sandbox, { recursive: true, force: true }));

function corpus(name: string): string {
  const dir = join(sandbox, name, 'corpus');
  mkdirSync(join(dir, 'trio'), { recursive: true });
  writeFileSync(join(dir, 'sick-day.pdf'), 'fake pdf bytes');
  writeFileSync(join(dir, 'targets.txt'), '1 | Targets\nTime in range above 70%.\n=====PAGE=====\n2 | GMI\nGMI formula.\n');
  writeFileSync(join(dir, 'trio', 'exercise.md'), '# Exercise\nSet a temporary target of 150 mg/dL.\n');
  writeFileSync(join(dir, 'dexcom.html'), '<html><head><style>x{}</style></head><body><h2>Interference</h2><p>Hydroxyurea &amp; paracetamol.</p></body></html>');
  writeFileSync(join(dir, 'notes.docx'), 'unsupported');
  writeFileSync(join(dir, 'sources.json'), JSON.stringify({ 'sick-day.pdf': { title: 'ISPAD 2022 Sick day' }, 'dexcom.html': { title: 'Dexcom G7 interference' } }));
  return dir;
}

const fakePdf = (path: string): string => `Extracted from ${path.split('/').pop()}\n4 | Ketones\nBlood ketones 0.6–1.4 mmol/L.\fPage two text.`;

describe('loadCorpus', () => {
  it('reads PDF (via the extractor), text with page markers, Markdown and HTML; skips unsupported files', () => {
    const { documents, skipped } = loadCorpus(corpus('load'), fakePdf);
    expect(documents.map((d) => d.source_file)).toEqual(['dexcom.html', 'sick-day.pdf', 'targets.txt', 'trio/exercise.md']);
    expect(skipped).toEqual(['notes.docx']);
    const pdf = documents.find((d) => d.source_file === 'sick-day.pdf')!;
    expect(pdf).toMatchObject({ title: 'ISPAD 2022 Sick day', paged: true });
    expect(pdf.pages).toHaveLength(2);
    expect(documents.find((d) => d.source_file === 'targets.txt')).toMatchObject({ title: 'targets', paged: true });
    expect(documents.find((d) => d.source_file === 'trio/exercise.md')).toMatchObject({ title: 'trio/exercise', paged: false });
    expect(documents.find((d) => d.source_file === 'dexcom.html')!.pages[0]).toContain('Hydroxyurea & paracetamol.');
  });

  it('turns HTML headings into Markdown headings and drops scripts and styles', () => {
    const text = htmlToText('<script>alert(1)</script><h3>Temp <b>targets</b></h3><p>One</p><p>Two&nbsp;&#8805; 3</p>');
    expect(text).toContain('### Temp targets');
    expect(text).not.toContain('alert');
    expect(text).toContain('Two ≥ 3');
  });
});

describe('main', () => {
  it('refuses an output or corpus directory inside the repository', async () => {
    const repoRoot = resolve(__dirname, '../..');
    await expect(main(['--corpus-dir', corpus('repo'), '--output-dir', join(repoRoot, 'artifacts', 'rag')], { extractPdf: fakePdf })).rejects.toBeInstanceOf(EvaluationOutputDirError);
    await expect(main(['--corpus-dir', join(repoRoot, 'docs'), '--output-dir', join(sandbox, 'repo', 'out')], { extractPdf: fakePdf })).rejects.toBeInstanceOf(IngestArgumentError);
  });

  it('dry run writes the chunks and sends nothing', async () => {
    const out = join(sandbox, 'dry', 'out');
    const create = vi.fn();
    await main(['--corpus-dir', corpus('dry'), '--output-dir', out], { embeddings: { embeddings: { create } }, extractPdf: fakePdf });
    expect(create).not.toHaveBeenCalled();
    const { chunks } = JSON.parse(readFileSync(join(out, 'rag-chunks.json'), 'utf8'));
    expect(chunks.find((c: { source_file: string }) => c.source_file === 'sick-day.pdf')).toMatchObject({ title: 'ISPAD 2022 Sick day', page: 1 });
    // Short sections stay together: one chunk spanning both pages, labelled with the first section.
    expect(chunks.find((c: { source_file: string }) => c.source_file === 'targets.txt')).toMatchObject({ section: '1 Targets', page: 1, page_end: 2 });
  });

  it('live run embeds every chunk and writes a loadable index', async () => {
    const out = join(sandbox, 'live', 'out');
    const create = vi.fn(async (body: Record<string, unknown>) => ({
      data: (body.input as string[]).map((text, index) => ({ index, embedding: [text.length, 1, 0] })),
      usage: { prompt_tokens: 10 },
    }));
    await main(['--corpus-dir', corpus('live'), '--output-dir', out, '--live', '--chunk-tokens', '200', '--overlap-tokens', '20'], {
      embeddings: { embeddings: { create } },
      extractPdf: fakePdf,
      now: () => new Date('2026-10-16T10:00:00.000Z'),
    });
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0]).toMatchObject({ model: 'text-embedding-3-small' });
    const index = parseIndex(readFileSync(join(out, 'rag-index.json'), 'utf8'));
    expect(index.file).toMatchObject({ dimensions: 3, created_at: '2026-10-16T10:00:00.000Z', chunking: { target_tokens: 200, overlap_tokens: 20 } });
    expect(index.file.chunks).toHaveLength((create.mock.calls[0][0].input as string[]).length);
    expect(Array.from(decodeVector(index.file.chunks[0].embedding_b64))).toEqual([index.file.chunks[0].text.length, 1, 0]);
  });

  it('--reuse-index embeds only new chunks and keeps the vectors of unchanged ones', async () => {
    const dir = corpus('reuse');
    const out = join(sandbox, 'reuse', 'out');
    const first = vi.fn(async (body: Record<string, unknown>) => ({ data: (body.input as string[]).map((text, index) => ({ index, embedding: [text.length, 1, 0] })), usage: { prompt_tokens: 10 } }));
    await main(['--corpus-dir', dir, '--output-dir', out, '--live'], { embeddings: { embeddings: { create: first } }, extractPdf: fakePdf });
    const oldIndexPath = join(sandbox, 'reuse', 'old-index.json');
    writeFileSync(oldIndexPath, readFileSync(join(out, 'rag-index.json')));
    const oldIndex = parseIndex(readFileSync(oldIndexPath, 'utf8'));

    writeFileSync(join(dir, 'figures.md'), 'Table 3: Ketosis at home\n| Ketones | Extra insulin |\n|---|---|\n| 0.6–1.5 | 10% TDD |\n');
    const second = vi.fn(async (body: Record<string, unknown>) => ({ data: (body.input as string[]).map((_text, index) => ({ index, embedding: [9, 9, 9] })), usage: { prompt_tokens: 3 } }));
    await main(['--corpus-dir', dir, '--output-dir', out, '--live', '--reuse-index', oldIndexPath], { embeddings: { embeddings: { create: second } }, extractPdf: fakePdf });
    expect(second).toHaveBeenCalledTimes(1);
    expect((second.mock.calls[0][0].input as string[]).every((text) => text.includes('Ketosis at home'))).toBe(true);
    const index = parseIndex(readFileSync(join(out, 'rag-index.json'), 'utf8'));
    expect(index.file.chunks).toHaveLength(oldIndex.file.chunks.length + (second.mock.calls[0][0].input as string[]).length);
    for (const chunk of oldIndex.file.chunks) expect(index.file.chunks.find((c) => c.id === chunk.id)?.embedding_b64).toBe(chunk.embedding_b64);
    expect(Array.from(decodeVector(index.file.chunks.find((c) => c.kind === 'table')!.embedding_b64))).toEqual([9, 9, 9]);

    // Nothing new: no call and no client (no API key needed).
    writeFileSync(oldIndexPath, readFileSync(join(out, 'rag-index.json')));
    await main(['--corpus-dir', dir, '--output-dir', out, '--live', '--reuse-index', oldIndexPath], { extractPdf: fakePdf });
    expect(parseIndex(readFileSync(join(out, 'rag-index.json'), 'utf8')).file.chunks).toHaveLength(index.file.chunks.length);
  });

  it('refuses a missing reuse index or one built with another embedding model', async () => {
    const dir = corpus('reuse-args');
    const out = join(sandbox, 'reuse-args', 'out');
    await expect(main(['--corpus-dir', dir, '--output-dir', out, '--reuse-index', join(out, 'missing.json')], { extractPdf: fakePdf })).rejects.toBeInstanceOf(IngestArgumentError);
    const create = vi.fn(async (body: Record<string, unknown>) => ({ data: (body.input as string[]).map((_text, index) => ({ index, embedding: [1, 0] })), usage: { prompt_tokens: 1 } }));
    await main(['--corpus-dir', dir, '--output-dir', out, '--live', '--model', 'other-embedding'], { embeddings: { embeddings: { create } }, extractPdf: fakePdf });
    await expect(main(['--corpus-dir', dir, '--output-dir', out, '--reuse-index', join(out, 'rag-index.json')], { extractPdf: fakePdf })).rejects.toThrow('built with other-embedding');
  });

  it('refuses bad chunking values and unknown arguments', async () => {
    const dir = corpus('args');
    const out = join(sandbox, 'args', 'out');
    await expect(main(['--corpus-dir', dir, '--output-dir', out, '--chunk-tokens', '50'], { extractPdf: fakePdf })).rejects.toBeInstanceOf(IngestArgumentError);
    await expect(main(['--corpus-dir', dir, '--output-dir', out, '--chunk-tokens', '600', '--overlap-tokens', '400'], { extractPdf: fakePdf })).rejects.toBeInstanceOf(IngestArgumentError);
    await expect(main(['--corpus-dir', dir, '--output-dir', out, '--embed'], { extractPdf: fakePdf })).rejects.toBeInstanceOf(IngestArgumentError);
    await expect(main(['--output-dir', out], { extractPdf: fakePdf })).rejects.toBeInstanceOf(IngestArgumentError);
  });
});
