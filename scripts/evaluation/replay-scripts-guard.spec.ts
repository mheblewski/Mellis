import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The dual replay scripts make live, paid provider calls. Nothing here can reach a provider: the OpenAI SDK, dotenv and
// readFile are replaced, no credentials are set, and the inputs are synthetic files created below.
vi.mock('openai', () => ({ default: vi.fn() }));
vi.mock('dotenv', () => ({ config: vi.fn() }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readFile: vi.fn(actual.readFile), writeFile: vi.fn(actual.writeFile), mkdir: vi.fn(actual.mkdir), rm: vi.fn(actual.rm) };
});

import OpenAI from 'openai';
import { config as loadDotenv } from 'dotenv';
import * as fsPromises from 'node:fs/promises';
import { ReplayArgumentError } from './replay-cli';
import { main as fullVsCompact } from '../research/dual-time-range-full-vs-compact-replay';
import { main as expanded } from '../research/dual-time-range-expanded-replay';

// Recorded right after the imports: importing must not construct a client, load .env or read anything.
const callsAfterImport = {
  openai: vi.mocked(OpenAI).mock.calls.length,
  dotenv: vi.mocked(loadDotenv).mock.calls.length,
  readFile: vi.mocked(fsPromises.readFile).mock.calls.length,
};

const repoRoot = resolve(__dirname, '../..');
const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'replay-scripts-guard-')));
const inputs = join(sandbox, 'inputs');
mkdirSync(inputs);
const otherWorktree = join(sandbox, 'other-worktree');
mkdirSync(join(otherWorktree, '.git'), { recursive: true });
const aliasIntoRepo = join(sandbox, 'alias-into-repo');
symlinkSync(repoRoot, aliasIntoRepo);

// Synthetic inputs only.
const captureName = 'fresh-time-range-capture-synthetic.ndjson';
const capture = join(inputs, captureName);
writeFileSync(capture, `${JSON.stringify({ synthetic: true, task: { task_type: 'CONVERSATION_TIME_RANGE_ANALYSIS' } })}\n`);
const report = join(inputs, 'fresh-time-range-capture-report-synthetic.json');
writeFileSync(report, JSON.stringify({ status: 'FRESH_TIME_RANGE_CAPTURE_READY', run_id: 'synthetic', capture_file_path: `/recorded/elsewhere/${captureName}`, cases: [{ task_identity: 'a' }, { task_identity: 'b' }] }));
const captureLink = join(inputs, 'capture-link.ndjson');
symlinkSync(capture, captureLink);
const outputDir = join(sandbox, 'out');

const fingerprint = () => createHash('sha256').update(readFileSync(capture)).update(readFileSync(report)).digest('hex');
const inputsBefore = fingerprint();

afterAll(() => {
  expect(fingerprint()).toBe(inputsBefore);
  rmSync(sandbox, { recursive: true, force: true });
});

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.OPENAI_API_KEY;
});

const valid = ['--capture-report', report, '--capture', capture, '--output-dir', outputDir];
const without = (option: string) => {
  const index = valid.indexOf(option);
  return [...valid.slice(0, index), ...valid.slice(index + 2)];
};

const invalid: Array<[string, string[]]> = [
  ['no arguments', []],
  ['a missing --output-dir', without('--output-dir')],
  ['--output-dir without a value', [...without('--output-dir'), '--output-dir']],
  ['a missing --capture-report', without('--capture-report')],
  ['a missing --capture', without('--capture')],
  ['--capture without a value', ['--capture-report', report, '--output-dir', outputDir, '--capture']],
  ['a flag-like value', ['--capture-report', '--capture', capture, '--output-dir', outputDir]],
  ['an unknown option', [...valid, '--dry-run']],
  ['a mistyped option', [...without('--output-dir'), '--ouput-dir', outputDir]],
  ['a positional argument', [...valid, capture]],
  ['--output-dir given twice', [...valid, '--output-dir', join(sandbox, 'out-2')]],
  ['the repository as output', [...without('--output-dir'), '--output-dir', repoRoot]],
  ['artifacts/ as output', [...without('--output-dir'), '--output-dir', join(repoRoot, 'artifacts', 'evaluation')]],
  ['another Git working tree as output', [...without('--output-dir'), '--output-dir', join(otherWorktree, 'out')]],
  ['a symlink alias into the repository as output', [...without('--output-dir'), '--output-dir', join(aliasIntoRepo, 'out')]],
  ['inputs inside the output directory', [...without('--output-dir'), '--output-dir', inputs]],
  ['a symlinked capture', [...without('--capture'), '--capture', captureLink]],
  ['a directory as capture', [...without('--capture'), '--capture', inputs]],
  ['a missing capture file', [...without('--capture'), '--capture', join(inputs, 'missing.ndjson')]],
  ['the same file as report and capture', [...without('--capture'), '--capture', report]],
];

function expectNothingHappened() {
  expect(loadDotenv).not.toHaveBeenCalled();
  expect(OpenAI).not.toHaveBeenCalled();
  for (const fn of [fsPromises.readFile, fsPromises.writeFile, fsPromises.mkdir, fsPromises.rm]) expect(fn).not.toHaveBeenCalled();
  expect(existsSync(outputDir)).toBe(false);
  expect(existsSync(join(sandbox, 'out-2'))).toBe(false);
  expect(readdirSync(otherWorktree)).toEqual(['.git']);
  expect(readdirSync(inputs).sort()).toEqual(['capture-link.ndjson', captureName, 'fresh-time-range-capture-report-synthetic.json'].sort());
  expect(process.env.OPENAI_API_KEY).toBeUndefined();
}

describe('importing the replay modules', () => {
  it('constructs no client, loads no .env and reads no file', () => {
    expect(callsAfterImport).toEqual({ openai: 0, dotenv: 0, readFile: 0 });
  });
});

describe.each([
  ['dual-time-range-full-vs-compact-replay', fullVsCompact],
  ['dual-time-range-expanded-replay', expanded],
] as const)('%s', (_name, main) => {
  it.each(invalid)('refuses %s before .env, credentials, the client or any read', async (_label, argv) => {
    await expect(main(argv)).rejects.toBeInstanceOf(ReplayArgumentError);
    expectNothingHappened();
  });

  it('with valid paths, loads .env and checks credentials only after validation, and reads nothing without them', async () => {
    await expect(main(valid)).rejects.toThrow(/OPENAI_API_KEY is required/);
    expect(loadDotenv).toHaveBeenCalledTimes(1);
    expect(OpenAI).not.toHaveBeenCalled();
    expect(fsPromises.readFile).not.toHaveBeenCalled();
    expect(existsSync(outputDir)).toBe(false);
  });
});

describe('dual-time-range-full-vs-compact-replay', () => {
  it('takes exactly one report and one capture', async () => {
    const second = join(inputs, 'second.ndjson');
    writeFileSync(second, '{}\n');
    try {
      await expect(fullVsCompact([...valid, '--capture', second])).rejects.toBeInstanceOf(ReplayArgumentError);
    } finally {
      rmSync(second);
    }
    expectNothingHappened();
  });
});

describe('dual-time-range-expanded-replay', () => {
  it('refuses captures that share a file name (reports reference captures by name)', async () => {
    const elsewhere = join(sandbox, 'elsewhere');
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, captureName), '{}\n');
    try {
      await expect(expanded([...valid, '--capture', join(elsewhere, captureName)])).rejects.toBeInstanceOf(ReplayArgumentError);
    } finally {
      rmSync(elsewhere, { recursive: true });
    }
    expectNothingHappened();
  });
});

describe('replay script sources', () => {
  it.each([
    // The first call in main() that reads an input file.
    ['scripts/research/dual-time-range-full-vs-compact-replay.ts', 'loadReadyCaptureReport('],
    ['scripts/research/dual-time-range-expanded-replay.ts', 'loadReadyCaptures('],
  ])('%s validates paths before .env, credentials, the client and reads, and has no default or unguarded output', (file, firstRead) => {
    const source = readFileSync(join(repoRoot, file), 'utf8');
    expect(source).not.toMatch(/['"`]artifacts['"`/]/);
    expect(source).not.toContain("import 'dotenv/config'");
    expect(source).not.toMatch(/\b(writeFileSync|mkdirSync|readdir)\b|await (writeFile|mkdir|rm)\(/);
    expect(source).not.toMatch(/\.stack\b/);
    expect(source).toContain('require.main === module');
    const mainBody = source.slice(source.indexOf('export async function main('));
    const order = ['parseReplayArguments(argv', 'loadDotenv()', 'process.env.OPENAI_API_KEY', firstRead, 'createGuardedOpenAiClientFromEnv('].map((marker) => mainBody.indexOf(marker));
    expect(order.every((position) => position >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
});
