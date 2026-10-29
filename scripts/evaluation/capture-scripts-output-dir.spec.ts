import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The capture scripts call live OpenAI, the database, the API and the worker. These tests only prove that an invalid
// --output-dir stops them first: every side-effecting dependency is replaced, so a regression cannot reach anything.
vi.mock('dotenv/config', () => ({}));
vi.mock('pg', () => ({ Pool: vi.fn() }));
vi.mock('@nestjs/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nestjs/core')>();
  return { ...actual, NestFactory: { create: vi.fn(), createApplicationContext: vi.fn() } };
});
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readFile: vi.fn(actual.readFile), rm: vi.fn(actual.rm), writeFile: vi.fn(actual.writeFile), mkdir: vi.fn(actual.mkdir) };
});

import { NestFactory } from '@nestjs/core';
import { Pool } from 'pg';
import * as fsPromises from 'node:fs/promises';
import { EvaluationOutputDirError } from './evaluation-output-dir';
import { main as timeRangeMain } from '../fresh-time-range-capture-eval';
import { main as multiRangeMain } from '../fresh-multi-range-capture-validation';

const repoRoot = resolve(__dirname, '../..');
const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'capture-scripts-')));
const otherWorktree = join(sandbox, 'other-worktree');
mkdirSync(join(otherWorktree, '.git'), { recursive: true });

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

const invalidArgvs: Array<[string, string[]]> = [
  ['missing --output-dir', []],
  ['--output-dir without a value', ['--output-dir']],
  ['the repository artifacts/ directory', ['--output-dir', join(repoRoot, 'artifacts', 'evaluation')]],
  ['the repository root', ['--output-dir', repoRoot]],
  ['another Git working tree', ['--output-dir', join(otherWorktree, 'runs')]],
];

describe.each([
  ['fresh-time-range-capture-eval', timeRangeMain],
  ['fresh-multi-range-capture-validation', multiRangeMain],
])('%s validates --output-dir before any side effect', (_name, main) => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(invalidArgvs)('stops on %s', async (_label, argv) => {
    const envBefore = { AI_PROVIDER: process.env.AI_PROVIDER, OPENAI_EVAL_CAPTURE_FILE_PATH: process.env.OPENAI_EVAL_CAPTURE_FILE_PATH, AUTH_MODE: process.env.AUTH_MODE };
    const artifactsExisted = existsSync(join(repoRoot, 'artifacts'));

    await expect(main(argv)).rejects.toBeInstanceOf(EvaluationOutputDirError);

    expect(Pool).not.toHaveBeenCalled();
    expect(NestFactory.create).not.toHaveBeenCalled();
    expect(NestFactory.createApplicationContext).not.toHaveBeenCalled();
    for (const fn of [fsPromises.mkdir, fsPromises.rm, fsPromises.writeFile, fsPromises.readFile]) expect(fn).not.toHaveBeenCalled();
    expect({ AI_PROVIDER: process.env.AI_PROVIDER, OPENAI_EVAL_CAPTURE_FILE_PATH: process.env.OPENAI_EVAL_CAPTURE_FILE_PATH, AUTH_MODE: process.env.AUTH_MODE }).toEqual(envBefore);
    expect(existsSync(join(repoRoot, 'artifacts'))).toBe(artifactsExisted);
    expect(existsSync(join(otherWorktree, 'runs'))).toBe(false);
  });
});
