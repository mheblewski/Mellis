import { lstatSync, realpathSync } from 'node:fs';
import { basename, relative, isAbsolute, sep } from 'node:path';
import { EvaluationOutputDirError, resolveEvaluationOutputDir } from './evaluation-output-dir';

/**
 * Arguments of the live dual replay scripts (scripts/dual-time-range-*-replay.ts). Inputs (fresh capture reports and
 * the capture files they reference) and the output directory are separate and explicit; everything is validated
 * before credentials are read, the provider client is built or any capture is read. Inputs are only ever read.
 */
export class ReplayArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReplayArgumentError';
  }
}

export interface ReplayArguments {
  /** Canonical, validated (not yet created) output directory. */
  outputDir: string;
  /** Canonical paths of fresh-time-range-capture-report-*.json files. */
  captureReports: string[];
  /** Canonical paths of capture .ndjson files. */
  captures: string[];
}

const VALUE_OPTIONS = ['--output-dir', '--capture-report', '--capture'] as const;
type ValueOption = (typeof VALUE_OPTIONS)[number];

function usage(single: boolean): string {
  return single
    ? 'Usage: --capture-report <report.json> --capture <capture.ndjson> --output-dir <dir outside every Git working tree>.'
    : 'Usage: --capture-report <report.json> --capture <capture.ndjson> [repeat both per report] --output-dir <dir outside every Git working tree>.';
}

/** Canonical path of an existing regular input file; symlinks, directories and missing files are refused. */
function resolveInputFile(value: string, option: string): string {
  let stats;
  try {
    stats = lstatSync(value);
  } catch (error) {
    throw new ReplayArgumentError(`${option} ${JSON.stringify(basename(value))} cannot be read (${(error as NodeJS.ErrnoException).code ?? 'unknown error'}).`);
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new ReplayArgumentError(`${option} ${JSON.stringify(basename(value))} must be a regular file, not a symlink or directory.`);
  }
  return realpathSync.native(value);
}

function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

/**
 * Parses and validates the replay arguments. `single` requires exactly one report and one capture (full-vs-compact);
 * otherwise at least one of each. Positional arguments, unknown options, missing or flag-like values, duplicates and
 * inputs located inside the output directory are refused.
 */
export function parseReplayArguments(argv: readonly string[], options: { single: boolean }): ReplayArguments {
  const values: Record<ValueOption, string[]> = { '--output-dir': [], '--capture-report': [], '--capture': [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const exact = VALUE_OPTIONS.find((option) => option === arg);
    const inline = VALUE_OPTIONS.find((option) => arg.startsWith(`${option}=`));
    if (exact) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('-') || !value.trim()) throw new ReplayArgumentError(`Missing value for ${exact}. ${usage(options.single)}`);
      values[exact].push(value);
      index += 1;
    } else if (inline) {
      const value = arg.slice(inline.length + 1);
      if (!value.trim()) throw new ReplayArgumentError(`Missing value for ${inline}. ${usage(options.single)}`);
      values[inline].push(value);
    } else if (arg.startsWith('-')) {
      throw new ReplayArgumentError(`Unknown option ${JSON.stringify(arg.slice(0, 40))}. ${usage(options.single)}`);
    } else {
      throw new ReplayArgumentError(`Unexpected positional argument; inputs must be named with --capture-report and --capture. ${usage(options.single)}`);
    }
  }

  let outputDir: string;
  try {
    outputDir = resolveEvaluationOutputDir(values['--output-dir'].length === 0 ? [] : values['--output-dir'].flatMap((value) => ['--output-dir', value]));
  } catch (error) {
    if (error instanceof EvaluationOutputDirError) throw new ReplayArgumentError(error.message);
    throw error;
  }

  for (const option of ['--capture-report', '--capture'] as const) {
    const count = values[option].length;
    if (count === 0) throw new ReplayArgumentError(`Missing required ${option}; there is no default input. ${usage(options.single)}`);
    if (options.single && count > 1) throw new ReplayArgumentError(`${option} was given more than once. ${usage(options.single)}`);
  }

  const resolveAll = (option: '--capture-report' | '--capture') => {
    const paths = values[option].map((value) => resolveInputFile(value, option));
    if (new Set(paths).size !== paths.length) throw new ReplayArgumentError(`${option} lists the same file more than once.`);
    for (const path of paths) {
      if (isInside(path, outputDir)) throw new ReplayArgumentError(`${option} ${JSON.stringify(basename(path))} is inside --output-dir; keep inputs and outputs separate.`);
    }
    return paths;
  };
  const captureReports = resolveAll('--capture-report');
  const captures = resolveAll('--capture');
  const overlap = captureReports.filter((path) => captures.includes(path));
  if (overlap.length > 0) throw new ReplayArgumentError('The same file was given as --capture-report and --capture.');
  const captureNames = captures.map((path) => basename(path));
  if (new Set(captureNames).size !== captureNames.length) {
    throw new ReplayArgumentError('Two --capture files share a file name; reports reference captures by name, so this is ambiguous.');
  }
  const reportNames = captureReports.map((path) => basename(path));
  if (new Set(reportNames).size !== reportNames.length) {
    throw new ReplayArgumentError('Two --capture-report files share a file name; reports are ordered by name, so this is ambiguous.');
  }

  return { outputDir, captureReports, captures };
}

/**
 * The explicit --capture that a report refers to, matched by file name against the report's capture_file_path (the
 * absolute path recorded when it was produced). Exactly one match is required; the recorded path itself is never read.
 */
export function captureForReport(reportCaptureFilePath: unknown, captures: readonly string[], reportPath: string): string {
  const wanted = typeof reportCaptureFilePath === 'string' && reportCaptureFilePath.trim() ? basename(reportCaptureFilePath) : null;
  if (!wanted) throw new ReplayArgumentError(`Capture report ${JSON.stringify(basename(reportPath))} has no capture_file_path.`);
  const matches = captures.filter((path) => basename(path) === wanted);
  if (matches.length !== 1) {
    throw new ReplayArgumentError(`Capture report ${JSON.stringify(basename(reportPath))} refers to ${JSON.stringify(wanted)}, which was not given with --capture.`);
  }
  return matches[0];
}
