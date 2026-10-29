import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';

/**
 * Where evaluation specs write their reports. By default a directory outside the repository, so a normal test run
 * never touches the tracked reports in artifacts/evaluation; UPDATE_EVAL_ARTIFACTS=1 writes the tracked copies.
 */
export function resolveEvalArtifactPath(fileName: string, env: NodeJS.ProcessEnv = process.env): string {
  if (fileName !== basename(fileName)) {
    throw new Error(`Evaluation artifact name must be a plain file name: ${fileName}`);
  }
  const directory = env.UPDATE_EVAL_ARTIFACTS === '1'
    ? resolve(process.cwd(), 'artifacts/evaluation')
    : resolve(tmpdir(), 'glucomind-eval-artifacts');
  return resolve(directory, fileName);
}

// Masks only the value of a generated_at line (JSON `  "generated_at": "...",` or Markdown `generated_at: ...`);
// every other byte, including the line itself, still takes part in the comparison.
const GENERATED_AT_LINE = /^(\s*"generated_at": )"[^"]*"(,?)$|^(generated_at: ).*$/gm;

function withoutGeneratedAt(content: string): string {
  return content.replace(GENERATED_AT_LINE, (_line, jsonKey, comma, mdKey) => (mdKey ? `${mdKey}<masked>` : `${jsonKey}"<masked>"${comma}`));
}

/** Writes a report unless the existing file differs only in generated_at, so timestamps alone never produce a diff. */
export function writeEvalArtifact(path: string, content: string): void {
  if (existsSync(path) && withoutGeneratedAt(readFileSync(path, 'utf8')) === withoutGeneratedAt(content)) {
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
}
