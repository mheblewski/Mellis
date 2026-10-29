import { resolve } from 'node:path';
import { buildManifest, checkKnowledge, loadKnowledge, parseFrontMatter, validateDocument } from './knowledge-manifest';

const body = 'x'.repeat(250);

describe('knowledge front matter', () => {
  it('parses strings, numbers, booleans and lists', () => {
    const { meta, body: rest } = parseFrontMatter('---\nid: a-b\ntitle: "A \\"quoted\\" title"\nyear: 2022\nindex: false\ntopics: [cgm, exercise]\n---\n\nText');
    expect(meta).toEqual({ id: 'a-b', title: 'A "quoted" title', year: 2022, index: false, topics: ['cgm', 'exercise'] });
    expect(rest.trim()).toBe('Text');
  });

  it('rejects a file without front matter', () => {
    expect(() => parseFrontMatter('# Title')).toThrow('missing front matter');
  });

  it('flags missing keys, an unknown mode and SHIP_TEXT without attribution', () => {
    const problems = validateDocument({ path: 'a.md', meta: { id: 'a', title: 't', url: 'https://x', licence: 'MIT', mode: 'SHIP_TEXT', language: 'en', retrieved: '2026-10-16', topics: [], index: true }, body });
    expect(problems).toEqual(['SHIP_TEXT needs attribution']);
    expect(validateDocument({ path: 'b.md', meta: { mode: 'COPY' }, body })).toContain('unknown mode COPY');
  });

  it('skips LINK_ONLY and index: false documents in the ingest manifest', () => {
    const meta = { id: 'a', title: 'T', url: 'https://x', licence: 'L', language: 'en', retrieved: '2026-10-16', topics: [] };
    const manifest = buildManifest([
      { path: 'a.md', meta: { ...meta, mode: 'SUMMARY_ONLY', index: true }, body },
      { path: 'b.md', meta: { ...meta, mode: 'LINK_ONLY', index: false }, body: '' },
      { path: 'c.md', meta: { ...meta, mode: 'SHIP_TEXT', index: false }, body },
    ]);
    expect(manifest).toEqual({ 'a.md': { title: 'T', skip: false }, 'b.md': { title: 'T', skip: true }, 'c.md': { title: 'T', skip: true } });
  });

  it('every shipped knowledge file is valid and ids are unique', () => {
    const documents = loadKnowledge(resolve(__dirname, '../../knowledge'));
    expect(documents.length).toBeGreaterThan(100);
    expect(checkKnowledge(documents)).toEqual([]);
  });
});
