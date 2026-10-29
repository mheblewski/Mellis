import { lstatSync, mkdirSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import {
  EvaluationCapturePathError,
  assertEvaluationCaptureOutsideRepository,
  findRepositoryRoot,
  writeEvaluationOutputFile,
} from '@modules/ai-gateway/infrastructure/evaluation-capture-path';

/**
 * Output directory for evaluation scripts that write provider captures and reports (both contain patient data).
 * It is required, must resolve outside this repository and every other Git working tree, and is validated before
 * the script does anything else. There is no default and no way to disable the check.
 */
export class EvaluationOutputDirError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EvaluationOutputDirError';
  }
}

const USAGE = 'Pass --output-dir <dir> with a directory outside every Git working tree, for example: --output-dir "$(mktemp -d)".';

/** The single `--output-dir <dir>` or `--output-dir=<dir>` value; anything missing, empty, repeated or flag-like is refused. */
export function parseOutputDirArgument(argv: readonly string[]): string {
  const values: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--output-dir') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('-')) throw new EvaluationOutputDirError(`Missing value for --output-dir. ${USAGE}`);
      values.push(value);
      index += 1;
    } else if (arg.startsWith('--output-dir=')) {
      values.push(arg.slice('--output-dir='.length));
    }
  }
  if (values.length === 0) throw new EvaluationOutputDirError(`Missing required --output-dir. ${USAGE}`);
  if (values.length > 1) throw new EvaluationOutputDirError(`--output-dir was given more than once. ${USAGE}`);
  const value = values[0];
  if (!value.trim() || value.includes('\0')) throw new EvaluationOutputDirError(`Invalid --output-dir value. ${USAGE}`);
  return value;
}

/** Validates the output directory without creating anything and returns its canonical path. */
export function resolveEvaluationOutputDir(argv: readonly string[], repositoryRoot: string | null = findRepositoryRoot(__dirname)): string {
  const requested = parseOutputDirArgument(argv);
  let directory: string;
  try {
    directory = assertEvaluationCaptureOutsideRepository(requested, repositoryRoot);
  } catch (error) {
    if (error instanceof EvaluationCapturePathError) throw new EvaluationOutputDirError(`${error.message} ${USAGE}`);
    throw error;
  }
  let stats;
  try {
    stats = statSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return directory;
    throw new EvaluationOutputDirError(`Cannot inspect --output-dir (${(error as NodeJS.ErrnoException).code ?? 'unknown error'}). ${USAGE}`);
  }
  if (!stats.isDirectory()) throw new EvaluationOutputDirError(`--output-dir is not a directory. ${USAGE}`);
  return directory;
}

/** Creates the validated directory (mode 0700 for new directories) and validates it again once it exists. */
export function ensureEvaluationOutputDir(directory: string, repositoryRoot: string | null = findRepositoryRoot(__dirname)): string {
  const validated = resolveEvaluationOutputDir(['--output-dir', directory], repositoryRoot);
  mkdirSync(validated, { recursive: true, mode: 0o700 });
  const created = resolveEvaluationOutputDir(['--output-dir', validated], repositoryRoot);
  if (created !== validated) throw new EvaluationOutputDirError(`--output-dir changed while it was created. ${USAGE}`);
  return created;
}

/**
 * Writes one file below a validated output directory (directories 0700, file 0600) through the capture guard, which
 * re-validates the destination immediately before the write. `relativePath` may contain subdirectories.
 */
export function writeEvaluationOutputDirFile(outputDir: string, relativePath: string, content: string, repositoryRoot: string | null = findRepositoryRoot(__dirname)): string {
  if (isAbsolute(relativePath) || relativePath.split(/[\\/]/).some((part) => part === '..' || part === '')) {
    throw new EvaluationOutputDirError('Output file names must stay inside --output-dir.');
  }
  const directory = ensureEvaluationOutputDir(outputDir, repositoryRoot);
  const filePath = join(directory, relativePath);
  try {
    writeEvaluationOutputFile(filePath, content, repositoryRoot);
  } catch (error) {
    if (error instanceof EvaluationCapturePathError) throw new EvaluationOutputDirError(`${error.message} ${USAGE}`);
    throw error;
  }
  return filePath;
}

const OUTPUT_FILE_USAGE = 'Pass an output file outside every Git working tree, for example "$(mktemp -d)/report.json".';

/**
 * Validates an explicit output file path (for tools that take one positionally) without creating anything: it must be
 * given, resolve outside this repository and every Git working tree, and must not be an existing symlink or non-file.
 * Returns the canonical path; write it with writeEvaluationOutputFile, which validates again.
 */
export function resolveEvaluationOutputFile(value: string | undefined, repositoryRoot: string | null = findRepositoryRoot(__dirname)): string {
  if (value === undefined || !value.trim() || value.startsWith('-') || value.includes('\0')) {
    throw new EvaluationOutputDirError(`Missing or invalid output file. ${OUTPUT_FILE_USAGE}`);
  }
  let filePath: string;
  try {
    filePath = assertEvaluationCaptureOutsideRepository(value, repositoryRoot);
  } catch (error) {
    if (error instanceof EvaluationCapturePathError) throw new EvaluationOutputDirError(`${error.message} ${OUTPUT_FILE_USAGE}`);
    throw error;
  }
  // assertEvaluationCaptureOutsideRepository resolves an existing symlink; refuse the requested path itself being one.
  for (const candidate of [value, filePath]) {
    try {
      const stats = lstatSync(candidate);
      if (stats.isSymbolicLink() || !stats.isFile()) throw new EvaluationOutputDirError(`The output file exists and is not a regular file. ${OUTPUT_FILE_USAGE}`);
    } catch (error) {
      if (error instanceof EvaluationOutputDirError) throw error;
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') throw new EvaluationOutputDirError(`Cannot inspect the output file (${code ?? 'unknown error'}). ${OUTPUT_FILE_USAGE}`);
    }
  }
  try {
    if (!statSync(dirname(filePath)).isDirectory()) throw new EvaluationOutputDirError(`The output file's parent is not a directory. ${OUTPUT_FILE_USAGE}`);
  } catch (error) {
    if (error instanceof EvaluationOutputDirError) throw error;
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new EvaluationOutputDirError(`Cannot inspect the output file's parent (${(error as NodeJS.ErrnoException).code ?? 'unknown error'}). ${OUTPUT_FILE_USAGE}`);
    }
  }
  return filePath;
}

/**
 * Positional arguments, with `--output-dir <dir>` / `--output-dir=<dir>` removed. Any other option is refused, so a
 * mistyped flag cannot be taken for a path.
 */
export function positionalArguments(argv: readonly string[], valueOptions: readonly string[] = ['--output-dir']): string[] {
  const positional: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (valueOptions.includes(arg)) {
      index += 1;
    } else if (valueOptions.some((option) => arg.startsWith(`${option}=`))) {
      continue;
    } else if (arg.startsWith('-')) {
      throw new EvaluationOutputDirError(`Unknown option ${JSON.stringify(arg.slice(0, 40))}.`);
    } else {
      positional.push(arg);
    }
  }
  return positional;
}

/** A required input file argument; there is no default, so no real capture is read unless named explicitly. */
export function requireInputFileArgument(value: string | undefined, label: string): string {
  if (value === undefined || !value.trim() || value.includes('\0')) {
    throw new EvaluationOutputDirError(`Missing required ${label}; there is no default input.`);
  }
  return value;
}

type ErrorClass = abstract new (...args: never[]) => Error;

/**
 * Error text safe to print: this module's and the capture guard's errors (written to exclude data) verbatim, plus any
 * class listed in `safeClasses`; anything else (driver, parse or file errors, which can quote rows, file content or
 * paths) as its class and code only.
 */
export function describeErrorSafely(error: unknown, safeClasses: readonly ErrorClass[] = []): string {
  if (error instanceof EvaluationOutputDirError || error instanceof EvaluationCapturePathError || safeClasses.some((cls) => error instanceof cls)) {
    return (error as Error).message;
  }
  const name = error instanceof Error ? error.name : 'Error';
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[A-Z0-9_]{1,12}$/i.test(code) ? `${name} (code ${code})` : name;
}
