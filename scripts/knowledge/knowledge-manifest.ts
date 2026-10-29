/**
 * Checks the front matter of the shipped knowledge base (knowledge/, see knowledge/README.md) and writes
 * knowledge/sources.json, the { "<path>": { "title", "skip" } } manifest the ingest script reads. No network, no AI.
 *
 *   tsx scripts/knowledge/knowledge-manifest.ts            check and write knowledge/sources.json
 *   tsx scripts/knowledge/knowledge-manifest.ts --check    check only; fails when sources.json is out of date
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

export const KNOWLEDGE_MODES = ['SHIP_TEXT', 'SUMMARY_ONLY', 'LINK_ONLY'] as const;
export type KnowledgeMode = (typeof KNOWLEDGE_MODES)[number];

const REQUIRED = ['id', 'title', 'url', 'licence', 'mode', 'language', 'retrieved', 'topics', 'index'] as const;
const NOT_DOCUMENTS = new Set(['README.md', 'SOURCES.md', 'LICENSES.md']);

export type FrontMatterValue = string | number | boolean | string[];

export interface KnowledgeDocument {
  path: string;
  meta: Record<string, FrontMatterValue>;
  body: string;
}

function parseValue(raw: string): FrontMatterValue {
  const value = raw.trim();
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^-?\d+$/.test(value)) return Number(value);
  if (value.startsWith('[') && value.endsWith(']')) {
    const inner = value.slice(1, -1).trim();
    return inner ? inner.split(',').map((item) => item.trim()) : [];
  }
  if (value.startsWith('"') && value.endsWith('"')) return JSON.parse(value) as string;
  return value;
}

/** Parses the one-line-per-key YAML subset the knowledge files use; throws on anything else. */
export function parseFrontMatter(text: string): { meta: Record<string, FrontMatterValue>; body: string } {
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!match) throw new Error('missing front matter');
  const meta: Record<string, FrontMatterValue> = {};
  for (const line of match[1].split('\n')) {
    if (!line.trim()) continue;
    const pair = /^([a-z_0-9]+):\s?(.*)$/.exec(line);
    if (!pair) throw new Error(`bad front matter line: ${line.slice(0, 60)}`);
    meta[pair[1]] = parseValue(pair[2]);
  }
  return { meta, body: text.slice(match[0].length) };
}

/** Problems with one document's metadata; empty when it is valid. */
export function validateDocument(document: KnowledgeDocument): string[] {
  const problems: string[] = [];
  const { meta } = document;
  for (const key of REQUIRED) if (meta[key] === undefined || meta[key] === '') problems.push(`missing ${key}`);
  if (meta.mode !== undefined && !KNOWLEDGE_MODES.includes(meta.mode as KnowledgeMode)) problems.push(`unknown mode ${String(meta.mode)}`);
  if (typeof meta.id === 'string' && !/^[a-z0-9][a-z0-9-]*$/.test(meta.id)) problems.push('id must be lowercase [a-z0-9-]');
  if (typeof meta.url === 'string' && !/^https?:\/\//.test(meta.url)) problems.push('url must be http(s)');
  if (meta.topics !== undefined && !Array.isArray(meta.topics)) problems.push('topics must be a list');
  if (meta.index !== undefined && typeof meta.index !== 'boolean') problems.push('index must be true or false');
  if (meta.mode === 'SHIP_TEXT' && !meta.attribution) problems.push('SHIP_TEXT needs attribution');
  if (meta.mode === 'LINK_ONLY' && meta.index === true) problems.push('LINK_ONLY must have index: false');
  if (meta.mode !== 'LINK_ONLY' && document.body.trim().length < 200) problems.push('body too short');
  return problems;
}

function listMarkdown(dir: string, root: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      if (entry.name.startsWith('.')) return [];
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return listMarkdown(path, root);
      const rel = relative(root, path);
      return entry.isFile() && rel.endsWith('.md') && !NOT_DOCUMENTS.has(rel) ? [rel] : [];
    });
}

export function loadKnowledge(dir: string): KnowledgeDocument[] {
  return listMarkdown(dir, dir).map((path) => {
    try {
      return { path, ...parseFrontMatter(readFileSync(join(dir, path), 'utf8')) };
    } catch (error) {
      throw new Error(`${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
}

/** The ingest manifest: every document, skipped when LINK_ONLY or index: false. */
export function buildManifest(documents: readonly KnowledgeDocument[]): Record<string, { title: string; skip: boolean }> {
  const manifest: Record<string, { title: string; skip: boolean }> = {};
  for (const document of documents) {
    manifest[document.path] = {
      title: String(document.meta.title),
      skip: document.meta.mode === 'LINK_ONLY' || document.meta.index === false,
    };
  }
  return manifest;
}

export function checkKnowledge(documents: readonly KnowledgeDocument[]): string[] {
  const problems = documents.flatMap((document) => validateDocument(document).map((problem) => `${document.path}: ${problem}`));
  const seen = new Map<string, string>();
  for (const document of documents) {
    const id = String(document.meta.id);
    if (seen.has(id)) problems.push(`${document.path}: id ${id} also used by ${seen.get(id)}`);
    seen.set(id, document.path);
  }
  return problems;
}

function main(argv: readonly string[]): void {
  const dir = resolve(__dirname, '../../knowledge');
  const documents = loadKnowledge(dir);
  const problems = checkKnowledge(documents);
  if (problems.length) {
    console.error(problems.join('\n'));
    process.exitCode = 1;
    return;
  }
  const manifestText = `${JSON.stringify(buildManifest(documents), null, 2)}\n`;
  const manifestPath = join(dir, 'sources.json');
  const counts = documents.reduce<Record<string, number>>((sum, document) => ({ ...sum, [String(document.meta.mode)]: (sum[String(document.meta.mode)] ?? 0) + 1 }), {});
  if (argv.includes('--check')) {
    if (!existsSync(manifestPath) || readFileSync(manifestPath, 'utf8') !== manifestText) {
      console.error('knowledge/sources.json is out of date: run tsx scripts/knowledge/knowledge-manifest.ts');
      process.exitCode = 1;
      return;
    }
  } else {
    writeFileSync(manifestPath, manifestText);
  }
  console.log(`${documents.length} documents: ${Object.entries(counts).map(([mode, count]) => `${mode} ${count}`).join(', ')}`);
}

if (require.main === module) main(process.argv.slice(2));
