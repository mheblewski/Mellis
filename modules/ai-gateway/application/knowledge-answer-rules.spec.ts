import { describe, expect, it } from 'vitest';
import {
  SEARCH_KNOWLEDGE_TOOL_DEFINITION,
  buildKnowledgeInstructions,
  citedKnowledgeSources,
  extractCitedRefs,
  sanitizeKnowledgeSources,
} from './knowledge-answer-rules';
import { buildRewriteRequest } from '@modules/knowledge/application/knowledge-query';

describe('knowledge answer rules', () => {
  it('finds cited fragment numbers in citation order in the usual citation forms', () => {
    expect(extractCitedRefs('A [S2]. B [S1, S3] i [S2][S4]. Tabela [S5, s. 12].')).toEqual(['S2', 'S1', 'S3', 'S4', 'S5']);
    expect(extractCitedRefs('Bez źródeł [1], [Karta], [wiedza ogólna], S3 bez nawiasu.')).toEqual([]);
  });

  it('maps cited numbers to the returned fragments and ignores numbers no search returned', () => {
    const fragment = { chunk_id: 'c#1', source_file: 'c.txt', title: 'ISPAD 2022', section: '8.3', page: 5, page_end: 6, kind: null, text: 'x' };
    const sources = citedKnowledgeSources('Zob. [S9] i [S1].', new Map([['S1', { fragment, corpus_version: 'v1' }]]));
    expect(sources).toEqual([{ ref: 'S1', title: 'ISPAD 2022', section: '8.3', page: 5, page_end: 6, chunk_id: 'c#1', corpus_version: 'v1' }]);
  });

  it('passes the link to the original through to the stored source, http(s) only', () => {
    const fragment = { chunk_id: 'k#1', source_file: 'ispad/sick-day.md', title: 'ISPAD 2022', section: null, page: null, page_end: null, kind: null, text: 'x', url: 'https://doi.org/10.1111/pedi.13415', publisher: 'ISPAD', source_mode: 'SUMMARY_ONLY' as const };
    const bad = { ...fragment, chunk_id: 'k#2', url: 'javascript:alert(1)' };
    const sources = citedKnowledgeSources('[S1] [S2]', new Map([['S1', { fragment, corpus_version: 'v' }], ['S2', { fragment: bad, corpus_version: 'v' }]]));
    expect(sources[0].url).toBe('https://doi.org/10.1111/pedi.13415');
    expect(sources[1]).not.toHaveProperty('url');
    expect(sanitizeKnowledgeSources(sources)).toEqual([
      { ref: 'S1', title: 'ISPAD 2022', section: null, page: null, page_end: null, url: 'https://doi.org/10.1111/pedi.13415' },
      { ref: 'S2', title: 'ISPAD 2022', section: null, page: null, page_end: null },
    ]);
    expect(sanitizeKnowledgeSources([{ ref: 'S1', title: 't', url: 'ftp://x' }, { ref: 'S2', title: 't', url: `https://x/${'a'.repeat(600)}` }])).toEqual([
      { ref: 'S1', title: 't', section: null, page: null, page_end: null },
      { ref: 'S2', title: 't', section: null, page: null, page_end: null },
    ]);
  });

  it('marks summaries for the model and says the corpus holds summaries with links', () => {
    expect(buildKnowledgeInstructions({ withEvidenceTools: true, directResponse: false, protocolCard: null })).toContain('"(summary)"');
    expect(SEARCH_KNOWLEDGE_TOOL_DEFINITION.description).toContain('as summaries with a link to the original');
  });

  it('stores and returns only well-formed sources, without chunk ids', () => {
    expect(sanitizeKnowledgeSources([
      { ref: 'S1', title: ' ISPAD ', section: '', page: 3, page_end: 2.5, chunk_id: 'x', corpus_version: 'v' },
      { ref: 'S1', title: 'duplicate' },
      { ref: 'X1', title: 'bad ref' },
      { ref: 'S2' },
      'junk',
    ])).toEqual([{ ref: 'S1', title: 'ISPAD', section: null, page: 3, page_end: null }]);
    expect(sanitizeKnowledgeSources(null)).toEqual([]);
    expect(sanitizeKnowledgeSources(Array.from({ length: 20 }, (_unused, index) => ({ ref: `S${index + 1}`, title: 't' })))).toHaveLength(12);
  });

  it('keeps the child, conservative and caregiver-decides rules in both conversation kinds', () => {
    for (const directResponse of [true, false]) {
      const text = buildKnowledgeInstructions({ withEvidenceTools: !directResponse, directResponse, protocolCard: null });
      expect(text).toContain('child');
      expect(text).toContain('conservative');
      expect(text).toContain('caregiver decides');
      expect(text).toContain('never add their results together');
      expect(text).toContain('adults');
      expect(text).not.toContain('Protocol card');
    }
  });

  it('defines WW and WBT as food units in every conversation prompt (the shared style, once)', async () => {
    const { CONVERSATION_STYLE_INSTRUCTIONS } = await import('./conversation-style');
    for (const directResponse of [true, false]) {
      expect(buildKnowledgeInstructions({ withEvidenceTools: !directResponse, directResponse, protocolCard: null })).not.toContain('Terminology (Polish diabetes practice)');
      const text = CONVERSATION_STYLE_INSTRUCTIONS.join('\n');
      expect(text).toContain('WBT (wymiennik białkowo-tłuszczowy, fat-protein unit, Warsaw method) = 100 kcal from the protein and fat of FOOD');
      expect(text).toContain('Never describe WBT as insulin or a dose and never say WBT do not raise glucose');
      expect(text).toContain('WW (wymiennik węglowodanowy) = 10 g of carbohydrate');
    }
  });

  it('defines a strict tool with a single query parameter', () => {
    expect(SEARCH_KNOWLEDGE_TOOL_DEFINITION.input_schema).toMatchObject({ additionalProperties: false, required: ['query'] });
    expect(Object.keys((SEARCH_KNOWLEDGE_TOOL_DEFINITION.input_schema as any).properties)).toEqual(['query']);
  });

  it('describes the same corpus to the answering model and to the query rewrite, PTD 2026 and EASD included', () => {
    const rewrite = String(buildRewriteRequest('light-x', 'Ketony w chorobie').instructions);
    for (const source of ['PTD 2026', 'EASD/ISPAD', 'ISPAD 2022/2024', 'Dexcom G7 user guide', 'insulin SmPCs']) {
      expect(SEARCH_KNOWLEDGE_TOOL_DEFINITION.description).toContain(source);
      expect(rewrite).toContain(source);
    }
  });
});
