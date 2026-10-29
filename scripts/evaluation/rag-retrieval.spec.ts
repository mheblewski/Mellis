import { describe, expect, it, vi } from 'vitest';
import {
  RAG_INDEX_VERSION,
  RagIndexError,
  chunkDocument,
  chunkLabel,
  cosineSimilarity,
  decodeVector,
  embedTexts,
  embeddingBatches,
  encodeVector,
  isReferenceListChunk,
  bm25Scores,
  lexicalTokens,
  parseIndex,
  queryCacheKey,
  retrieveHybrid,
  retrieveTopK,
  glossaryExpansion,
  parseHeading,
  sectionHeading,
  splitPages,
  type RagIndexFile,
} from './rag-retrieval';

function line(word: string, count: number): string {
  return Array.from({ length: count }, (_value, index) => `${word}${index}`).join(' ');
}

describe('page splitting and headings', () => {
  it('splits on form feeds and page marker lines and drops a trailing empty page', () => {
    expect(splitPages('a\fb\f')).toEqual(['a', 'b']);
    expect(splitPages('a\n=====PAGE=====\nb\n=====PAGE=====\n')).toEqual(['a', 'b']);
    expect(splitPages('only')).toEqual(['only']);
  });

  it('recognises ISPAD numbered and Markdown headings', () => {
    expect(sectionHeading('7.4 | Immediately after planned activity: Insulin')).toBe('7.4 Immediately after planned activity: Insulin');
    expect(sectionHeading('4 | S I C K P R I N C I P L E S')).toBe('4 SICKPRINCIPLES');
    expect(sectionHeading('## Temporary targets')).toBe('Temporary targets');
    expect(sectionHeading('4.2 Posology and method of administration')).toBe('4.2 Posology and method of administration');
    expect(sectionHeading('0.2 to 0.4 units of insulin per kilogram')).toBeNull();
    expect(sectionHeading('B. PACKAGE LEAFLET')).toBe('B. PACKAGE LEAFLET');
    expect(sectionHeading('Frequent glucose monitoring facilitates optimal management')).toBeNull();
  });

  it('gives each heading its depth', () => {
    expect(parseHeading('8 | T R E A T M E N T')).toEqual({ title: '8 TREATMENT', level: 1, number: '8' });
    expect(parseHeading('8.3.2 | Percentage increase method')).toEqual({ title: '8.3.2 Percentage increase method', level: 3, number: '8.3.2' });
    expect(parseHeading('### Recommendations')).toEqual({ title: 'Recommendations', level: 3 });
    expect(parseHeading('ANNEX III')).toEqual({ title: 'ANNEX III', level: 0 });
  });

  it('reads letter-spaced two-digit numbers, PTD parts and Dexcom chapters, but not table rows', () => {
    expect(parseHeading('1 0 | M A N A G E M E N T O F M I X E D M E A L S')).toEqual({ title: '10 MANAGEMENTOFMIXEDMEALS', level: 1, number: '10' });
    expect(parseHeading('1 3 E X E R C I S E | N U T R I T I O N A L')).toMatchObject({ title: '13 EXERCISENUTRITIONAL', number: '13' });
    expect(parseHeading('10 F I G U R E 2 Hand measures to estimate amount of food')).toBeNull();
    expect(parseHeading('II. Cele leczenia cukrzycy')).toEqual({ title: 'II. Cele leczenia cukrzycy', level: 3 });
    expect(parseHeading('IX. Podróż:')).toMatchObject({ title: 'IX. Podróż' });
    expect(parseHeading('11 • Troubleshooting | Dexcom G7 User Guide 105Accuracy and calibration')).toEqual({ title: '11 Troubleshooting', level: 1, number: '11' });
    // Section numbers never start at 0: "0.05 U ..." prose and "0.2 | 0" table rows.
    expect(parseHeading('0.05 U is delivered prior to')).toBeNull();
    expect(parseHeading('0.2 | 0')).toBeNull();
    // In PDF text "#" is a table glyph, not Markdown.
    expect(parseHeading('# Decrease >30 mg/dl', { markdown: false })).toBeNull();
    expect(parseHeading('# Decrease >30 mg/dl')).toMatchObject({ title: 'Decrease >30 mg/dl' });
  });
});

describe('chunkDocument', () => {
  it('keeps chunks near the target, overlaps them and records section and pages', () => {
    const pages = [
      ['1 | Introduction', ...Array.from({ length: 30 }, (_v, i) => line(`p1l${i}w`, 10))].join('\n'),
      ['2 | Ketones', ...Array.from({ length: 30 }, (_v, i) => line(`p2l${i}w`, 10))].join('\n'),
    ];
    const chunks = chunkDocument({ source_file: 'sick.pdf', title: 'ISPAD Sick day', pages, paged: true }, { target_tokens: 200, overlap_tokens: 40 });

    expect(chunks.length).toBeGreaterThan(4);
    for (const chunk of chunks) expect(chunk.tokens_estimate).toBeLessThanOrEqual(240);
    expect(chunks[0]).toMatchObject({ id: 'sick.pdf#1', section: '1 Introduction', page: 1 });
    // Overlap: the second chunk starts with the last lines (about 40 tokens) of the first.
    const firstLines = chunks[0].text.split('\n');
    const secondLines = chunks[1].text.split('\n');
    const overlap = secondLines.findIndex((text) => !firstLines.includes(text));
    expect(overlap).toBeGreaterThanOrEqual(2);
    expect(secondLines.slice(0, overlap)).toEqual(firstLines.slice(-overlap));
    // The heading on page 2 starts a fresh chunk without overlap.
    const ketones = chunks.find((chunk) => chunk.section === '2 Ketones')!;
    expect(ketones.text.startsWith('2 | Ketones')).toBe(true);
    expect(ketones.page).toBe(2);
  });

  it('records the heading path as the section, closing headings at the same or a deeper level', () => {
    const page = [
      '8 | Treatment of ketosis', line('a', 20),
      '8.3 | Insulin adjustment', line('b', 20),
      '8.3.2 | Percentage increase method', line('c', 20),
      '8.4 | Fluids', line('d', 20),
      '9 | Pumps', line('e', 20),
    ].join('\n');
    const chunks = chunkDocument({ source_file: 'sick.pdf', title: 'ISPAD Sick day', pages: [page], paged: true }, { target_tokens: 30, overlap_tokens: 0 });
    expect(chunks.map((chunk) => chunk.section)).toEqual([
      '8 Treatment of ketosis',
      '8 Treatment of ketosis > 8.3 Insulin adjustment',
      '8 Treatment of ketosis > 8.3 Insulin adjustment > 8.3.2 Percentage increase method',
      '8 Treatment of ketosis > 8.4 Fluids',
      '9 Pumps',
    ]);
    // Metadata only: the chunk text still starts with the heading line itself.
    expect(chunks[2].text.startsWith('8.3.2 | Percentage increase method')).toBe(true);
  });

  it('closes numbered headings that are not the parents of a numbered sub-heading', () => {
    const page = ['9 | G L Y C E M I C L O A D', line('a', 20), '10.1 | Fat and protein', line('b', 20)].join('\n');
    const chunks = chunkDocument({ source_file: 'nutrition.txt', title: 'ISPAD Nutrition', pages: [page], paged: false }, { target_tokens: 30, overlap_tokens: 0 });
    expect(chunks.map((chunk) => chunk.section)).toEqual(['9 GLYCEMICLOAD', '10.1 Fat and protein']);
  });

  it('labels PTD chapters by their banner and Dexcom chapters by the running header without moving chunk boundaries', () => {
    const ptd = [
      'koniec poprzedniego rozdziału', line('a', 30),
      '23. Cukrzyca u dzieci i młodzieży', 'W rozdziale określenie dotyczy dowolnego typu.', 'NAJWAżNIEJSZE REKOmENDAcJE', line('b', 30),
      'II. Cele leczenia cukrzycy', line('c', 30),
      '7. Należy pamiętać o złożonej etiologii.', line('d', 30),
    ].join('\n');
    const chunks = chunkDocument({ source_file: 'ptd/zalecenia.txt', title: 'PTD 2026', pages: [ptd], paged: false }, { target_tokens: 60, overlap_tokens: 0 });
    // The first chunk has no section of its own and takes the first one inside it.
    expect(chunks.map((chunk) => chunk.section)).toEqual([
      '23 Cukrzyca u dzieci i młodzieży',
      '23 Cukrzyca u dzieci i młodzieży',
      '23 Cukrzyca u dzieci i młodzieży > II. Cele leczenia cukrzycy',
      '23 Cukrzyca u dzieci i młodzieży > II. Cele leczenia cukrzycy',
    ]);
    // These headings only label: the chunks split by size, as rag-index.v1 did (their texts keep stored embeddings valid).
    expect(chunks.map((chunk) => chunk.text.split('\n')[0])).toEqual(['koniec poprzedniego rozdziału', 'NAJWAżNIEJSZE REKOmENDAcJE', line('c', 30), line('d', 30)]);

    const guide = ['11 • Troubleshooting | Dexcom G7 User Guide 105Accuracy and calibration', 'l Pressure on sensor: relieve the pressure.'].join('\n');
    expect(chunkDocument({ source_file: 'dexcom/g7.txt', title: 'Dexcom G7', pages: [guide], paged: false })[0].section).toBe('11 Troubleshooting');
  });

  it('keeps chunk boundaries at Markdown-looking table glyphs in PDF text but does not label sections with them', () => {
    const page = ['7.3 | During the planned activity: Insulin', line('a', 20), '# Decrease >30 mg/dl', line('b', 20)].join('\n');
    const chunks = chunkDocument({ source_file: 'exercise.txt', title: 'ISPAD Exercise', pages: [page], paged: false }, { target_tokens: 30, overlap_tokens: 0 });
    expect(chunks.map((chunk) => chunk.text.split('\n')[0])).toEqual(['7.3 | During the planned activity: Insulin', '# Decrease >30 mg/dl']);
    expect(chunks.map((chunk) => chunk.section)).toEqual(['7.3 During the planned activity: Insulin', '7.3 During the planned activity: Insulin']);
  });

  it('splits an overlong line at sentence ends, joins hyphenated words and omits pages for unpaged text', () => {
    const sentence = 'Glucose should be checked every two hours during illness. ';
    const chunks = chunkDocument({ source_file: 'doc.md', title: 'Doc', pages: [`${sentence.repeat(40)}\nhyper-\nglycemia is common`], paged: false }, { target_tokens: 100, overlap_tokens: 0 });
    expect(chunks.length).toBeGreaterThan(3);
    for (const chunk of chunks) expect(chunk.page).toBeNull();
    expect(chunks.some((chunk) => chunk.text.includes('hyperglycemia is common'))).toBe(true);
  });

  it('refuses an overlap that is not smaller than the target', () => {
    expect(() => chunkDocument({ source_file: 'x', title: 'x', pages: ['a'], paged: false }, { target_tokens: 100, overlap_tokens: 100 })).toThrow(RagIndexError);
  });

  it('labels a chunk with title, section and page range', () => {
    expect(chunkLabel({ id: 'a#1', source_file: 'a', title: 'ISPAD Exercise', section: '7.5 Overnight', page: 12, page_end: 13, text: '', tokens_estimate: 0 })).toBe('ISPAD Exercise, sekcja 7.5 Overnight, s. 12–13');
    expect(chunkLabel({ id: 'a#1', source_file: 'a', title: 'Trio docs', section: null, page: null, page_end: null, text: '', tokens_estimate: 0 })).toBe('Trio docs');
  });
});

describe('table chunks', () => {
  const wileyPage = [
    '7.3 | Consider mini-dose glucagon for persistent hypoglycemia',
    'If hypoglycemia persists with blood glucose levels <3.9 mmol/L a',
    'T A B L E 2 Normoglycemia/hypoglycemia',
    'Ketones (starvation) Blood glucose',
    '1.5–2.9 mmol/L Moderate/large • Do not reduce TDD insulin',
    '• Add +5% TDD or 0.05 U/kg to ordinary bolus',
    'Note:',
    '• Recalculate the ISF each day during illness.',
    'Abbreviations: BG, blood glucose; TDD, total daily dose.',
    'aExtra carbohydrates if tolerated.',
    'modified, smaller-than-usual dose of glucagon can be given.',
    '13995448, 2022, 7, Downloaded from https://onlinelibrary.wiley.com/doi/10.1111/pedi.13415 by someone',
  ].join('\n');

  it('cuts a PDF table out of the prose into its own chunk that starts with its caption', () => {
    const chunks = chunkDocument({ source_file: 'sick.txt', title: 'ISPAD Sick day', pages: ['Intro text.', wileyPage], paged: true });
    const table = chunks.filter((chunk) => chunk.kind === 'table');
    expect(table).toHaveLength(1);
    expect(table[0]).toMatchObject({ section: 'Table 2: Normoglycemia/hypoglycemia', page: 2, page_end: 2 });
    expect(table[0].text.split('\n')[0]).toBe('Table 2: Normoglycemia/hypoglycemia');
    expect(table[0].text).toContain('+5% TDD');
    expect(table[0].text).toContain('aExtra carbohydrates');
    expect(table[0].text).not.toContain('smaller-than-usual');
    // The prose around the table stays together and no longer contains table rows.
    const prose = chunks.filter((chunk) => !chunk.kind).map((chunk) => chunk.text).join('\n');
    expect(prose).toContain('levels <3.9 mmol/L a\nmodified, smaller-than-usual dose');
    expect(prose).not.toContain('+5% TDD');
  });

  it('splits a long table into parts that all carry the caption, and repeats the header row of a pipe table', () => {
    const rows = Array.from({ length: 60 }, (_v, i) => `| ${i} mg/dl | ${line(`cell${i}w`, 6)} |`);
    const markdown = ['Text before.', 'Table 3 Glucose targets for CGM', '', '| Glucose | Action |', ...rows, 'Text after the table.'].join('\n');
    const chunks = chunkDocument({ source_file: 'cgm.md', title: 'CGM', pages: [markdown], paged: false }, { target_tokens: 200, overlap_tokens: 20 });
    const parts = chunks.filter((chunk) => chunk.kind === 'table');
    expect(parts.length).toBeGreaterThan(2);
    parts.forEach((part, position) => {
      const [title, header] = part.text.split('\n');
      expect(title).toBe(`Table 3: Glucose targets for CGM (part ${position + 1}/${parts.length})`);
      expect(header).toBe('| Glucose | Action |');
      expect(part.tokens_estimate).toBeLessThanOrEqual(220);
      expect(part.page).toBeNull();
    });
    expect(parts.map((part) => part.text).join('\n')).toContain('| 59 mg/dl |');
    expect(chunks.filter((chunk) => !chunk.kind).map((chunk) => chunk.text).join('\n')).toBe('Text before.\nText after the table.');
  });

  it('keeps a sentence that only mentions a table as prose', () => {
    const chunks = chunkDocument({ source_file: 'gmi.md', title: 'GMI', pages: ['Table 2 provides key points for clinicians.\nMore prose.'], paged: false });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].kind).toBeUndefined();
  });
});

describe('vectors and top-k', () => {
  it('round-trips float32 vectors through base64', () => {
    expect(Array.from(decodeVector(encodeVector([0.5, -1, 2])))).toEqual([0.5, -1, 2]);
  });

  it('computes cosine similarity and refuses mismatched lengths', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
    expect(() => cosineSimilarity([1], [1, 2])).toThrow(RagIndexError);
  });

  it('parses an index and returns the k most similar chunks in order', () => {
    const chunk = (id: string, vector: number[]) => ({ id, source_file: 'f', title: 'T', section: null, page: null, page_end: null, text: id, tokens_estimate: 1, embedding_b64: encodeVector(vector) });
    const file: RagIndexFile = { version: RAG_INDEX_VERSION, embedding_model: 'm', dimensions: 2, created_at: 'now', chunking: { target_tokens: 600, overlap_tokens: 100 }, chunks: [chunk('a', [1, 0]), chunk('b', [0.7, 0.7]), chunk('c', [0, 1])] };
    const index = parseIndex(JSON.stringify(file));
    const top = retrieveTopK(index, [0, 1], 2);
    expect(top.map((hit) => hit.chunk.id)).toEqual(['c', 'b']);
    expect(top[0].rank).toBe(1);
    expect(top[0].chunk).not.toHaveProperty('embedding_b64');
    expect(() => parseIndex(JSON.stringify({ ...file, dimensions: 3 }))).toThrow(RagIndexError);

    const references = 'Smith A. Fat. Diabetes Care. 2021;44(10):2225-2230. Jones B. Protein. Diabet Med. 2017;34(6):851-854. doi:10.1111/dme.13347';
    const withReferences = parseIndex(JSON.stringify({ ...file, chunks: [...file.chunks, { ...chunk('refs', [0.1, 1]), text: references }] }));
    expect(retrieveTopK(withReferences, [0.1, 1], 1)[0].chunk.id).toBe('c');
    expect(retrieveTopK(withReferences, [0.1, 1], 1, { includeReferenceLists: true })[0].chunk.id).toBe('refs');
    expect(() => parseIndex('{}')).toThrow(RagIndexError);
  });
});

describe('hybrid retrieval', () => {
  const chunk = (id: string, vector: number[], text: string) => ({ id, source_file: 'f', title: 'T', section: null, page: null, page_end: null, text, tokens_estimate: 1, embedding_b64: encodeVector(vector) });
  const file: RagIndexFile = {
    version: RAG_INDEX_VERSION,
    embedding_model: 'm',
    dimensions: 2,
    created_at: 'now',
    chunking: { target_tokens: 600, overlap_tokens: 100 },
    chunks: [
      chunk('pl-only', [1, 0], 'Unrelated words about pumps.'),
      chunk('both', [0.8, 0.6], 'Reduce the prandial bolus by 25% before exercise.'),
      chunk('en-only', [0, 1], 'Exercise overnight basal reduction of 20% for 6 h.'),
      chunk('none', [-1, 0], 'Ketones and sick days.'),
    ],
  };

  it('tokenises words and numbers, drops stop words and stems plurals', () => {
    expect(lexicalTokens('The ketones of 0.05 U/kg in reduced doses')).toEqual(['keton', '0.05', 'kg', 'reduc', 'dose']);
    expect(lexicalTokens('ketone reduce reducing glucose')).toEqual(['keton', 'reduc', 'reduc', 'glucos']);
  });

  it('scores BM25 higher for rarer matching terms', () => {
    const scores = bm25Scores(parseIndex(JSON.stringify(file)), 'prandial bolus exercise');
    expect(scores[1]).toBeGreaterThan(scores[2]);
    expect(scores[2]).toBeGreaterThan(0);
    expect(scores[0]).toBe(0);
  });

  it('fuses candidate lists by reciprocal rank and records each list rank', () => {
    const index = parseIndex(JSON.stringify(file));
    const hits = retrieveHybrid(index, { vectors: [{ name: 'pl', vector: [1, 0] }, { name: 'en', vector: [0, 1] }], lexical: { name: 'bm25', text: 'prandial bolus before exercise' }, candidates: 3, k: 2 });
    expect(hits.map((hit) => hit.chunk.id)).toEqual(['both', 'en-only']);
    expect(hits[0]).toMatchObject({ rank: 1, ranks: { pl: 2, en: 2, bm25: 1 } });
    expect(hits[0].chunk).not.toHaveProperty('embedding_b64');
    // A single vector list keeps plain cosine order.
    expect(retrieveHybrid(index, { vectors: [{ name: 'pl', vector: [1, 0] }], candidates: 4, k: 2 }).map((hit) => hit.chunk.id)).toEqual(['pl-only', 'both']);
  });

  it('refuses k above candidates, no query, a wrong vector length and bad cap or diversity values', () => {
    const index = parseIndex(JSON.stringify(file));
    expect(() => retrieveHybrid(index, { vectors: [{ name: 'pl', vector: [1, 0] }], candidates: 2, k: 3 })).toThrow(RagIndexError);
    expect(() => retrieveHybrid(index, { vectors: [], candidates: 2, k: 1 })).toThrow(RagIndexError);
    expect(() => retrieveHybrid(index, { vectors: [{ name: 'pl', vector: [1, 0, 0] }], candidates: 2, k: 1 })).toThrow(RagIndexError);
    expect(() => retrieveHybrid(index, { vectors: [{ name: 'pl', vector: [1, 0] }], candidates: 2, k: 1, maxPerSource: 0 })).toThrow(RagIndexError);
    expect(() => retrieveHybrid(index, { vectors: [{ name: 'pl', vector: [1, 0] }], candidates: 2, k: 1, diversity: 1.5 })).toThrow(RagIndexError);
  });

  describe('source cap and diversity', () => {
    const guide = (id: string, vector: number[]) => ({ ...chunk(id, vector, 'guide page'), source_file: 'guide' });
    const mixed: RagIndexFile = {
      ...file,
      chunks: [guide('g1', [1, 0]), guide('g2', [0.99, 0.14]), guide('g3', [0.98, 0.2]), { ...chunk('other', [0.6, 0.8], 'guideline'), source_file: 'ispad' }],
    };
    const query = { vectors: [{ name: 'pl', vector: [1, 0] }], candidates: 4, k: 2 };

    it('keeps the fused order without options', () => {
      expect(retrieveHybrid(parseIndex(JSON.stringify(mixed)), query).map((hit) => hit.chunk.id)).toEqual(['g1', 'g2']);
    });

    it('keeps at most maxPerSource chunks of one file', () => {
      expect(retrieveHybrid(parseIndex(JSON.stringify(mixed)), { ...query, maxPerSource: 1 }).map((hit) => hit.chunk.id)).toEqual(['g1', 'other']);
    });

    it('skips near-duplicates by maximal marginal relevance and keeps fused order at diversity 1', () => {
      const index = parseIndex(JSON.stringify(mixed));
      expect(retrieveHybrid(index, { ...query, diversity: 0.5 }).map((hit) => hit.chunk.id)).toEqual(['g1', 'other']);
      expect(retrieveHybrid(index, { ...query, diversity: 1 }).map((hit) => hit.chunk.id)).toEqual(['g1', 'g2']);
    });
  });
});

describe('embedding batches', () => {
  it('splits by count and bytes', () => {
    expect(embeddingBatches(['a', 'b', 'c'], 2)).toEqual([[0, 1], [2]]);
    expect(embeddingBatches(['aaaa', 'bbbb', 'cc'], 10, 6)).toEqual([[0], [1, 2]]);
  });

  it('embeds through the transport, reorders by index and validates the response', async () => {
    const create = vi.fn(async (body: Record<string, unknown>) => {
      const input = body.input as string[];
      return { data: input.map((text, index) => ({ index, embedding: [text.length, 1] })).reverse(), usage: { prompt_tokens: 1 } };
    });
    const vectors = await embedTexts({ embeddings: { create } }, 'm', ['a', 'bbb']);
    expect(vectors).toEqual([[1, 1], [3, 1]]);
    expect(create.mock.calls[0][0]).toMatchObject({ model: 'm', input: ['a', 'bbb'] });

    const short = vi.fn(async () => ({ data: [{ index: 0, embedding: [1] }] }));
    await expect(embedTexts({ embeddings: { create: short } }, 'm', ['a', 'b'])).rejects.toThrow(RagIndexError);
  });

  it('recognises reference-list text but not body text with numbered citations', () => {
    expect(isReferenceListChunk('Ketone levels above 1.5 mmol/L require extra insulin.12,13 See Table 2.')).toBe(false);
  });

  it('expands a query with glossary terms matched at word starts in Polish or English', () => {
    const glossary = [
      { match: ['keton', 'bohb'], expand: ['ketones', 'BOHB'] },
      { match: ['wbt', 'fpu'], expand: ['fat protein units', 'FPU'] },
      { match: ['aid'], expand: ['automated insulin delivery'] },
    ];
    expect(glossaryExpansion(['Ile insuliny przy ketonach 1,2?', ''], glossary)).toEqual(['ketones', 'BOHB']);
    expect(glossaryExpansion(['Jak liczyć WBT?', 'fat protein units FPU bolus'], glossary)).toEqual(['fat protein units', 'FPU']);
    // "aid" must start a word: "said" does not match.
    expect(glossaryExpansion(['he said so'], glossary)).toEqual([]);
    expect(glossaryExpansion(['AID and ketones'], glossary)).toEqual(['ketones', 'BOHB', 'automated insulin delivery']);
  });

  it('keys query cache entries by model and text', () => {
    expect(queryCacheKey('m', 'q')).toBe(queryCacheKey('m', 'q'));
    expect(queryCacheKey('m', 'q')).not.toBe(queryCacheKey('n', 'q'));
  });
});
