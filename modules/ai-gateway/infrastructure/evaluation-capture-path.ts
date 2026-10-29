import { closeSync, constants, existsSync, fchmodSync, fstatSync, ftruncateSync, lstatSync, mkdirSync, openSync, realpathSync, statSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/**
 * Evaluation captures hold complete provider requests, including patient health data. They must never be written
 * inside this repository or any other Git working tree (artifacts/ included), where they could be committed.
 * Fails closed: a path that cannot be resolved or classified, or an unknown repository root, is refused.
 */
export class EvaluationCapturePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EvaluationCapturePathError';
  }
}

/** Nearest ancestor of `start` (inclusive) that contains package.json, or null when there is none. */
export function findRepositoryRoot(start: string = __dirname): string | null {
  let current = resolve(start);
  for (;;) {
    if (existsSync(join(current, 'package.json'))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/** Path for messages: the home directory (and with it the local username) is shown as `~`. */
export function describePath(path: string): string {
  const home = homedir();
  return path === home || path.startsWith(`${home}${sep}`) ? `~${path.slice(home.length)}` : path;
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

/**
 * Absolute path with every existing component resolved through symlinks (realpath of the nearest existing ancestor);
 * components that do not exist yet are appended unchanged. A dangling symlink, or any error other than "does not
 * exist", is refused because the eventual write target cannot be known.
 */
function canonicalize(target: string): string {
  const absolute = resolve(target);
  const missing: string[] = [];
  let current = absolute;
  for (;;) {
    try {
      const real = realpathSync.native(current);
      return missing.length > 0 ? join(real, ...missing.reverse()) : real;
    } catch (error) {
      const code = errorCode(error);
      let isEntry = false;
      try {
        lstatSync(current);
        isEntry = true;
      } catch {
        isEntry = false;
      }
      if (code !== 'ENOENT' || isEntry) {
        throw new EvaluationCapturePathError(`Cannot safely resolve evaluation capture path ${describePath(absolute)} (${code ?? 'unknown error'}${isEntry ? ', dangling symlink' : ''}).`);
      }
      const parent = dirname(current);
      if (parent === current) {
        throw new EvaluationCapturePathError(`Cannot safely resolve evaluation capture path ${describePath(absolute)}.`);
      }
      missing.push(basename(current));
      current = parent;
    }
  }
}

/** `path` and its ancestors, from the path itself up to the filesystem root. */
function selfAndAncestors(path: string): string[] {
  const chain = [path];
  for (let current = path; dirname(current) !== current; current = dirname(current)) chain.push(dirname(current));
  return chain;
}

/**
 * Identity check (device + inode) against the repository root for every existing component of the destination, so
 * aliases that realpath does not normalise (for example macOS firmlinks such as /System/Volumes/Data/...) still match.
 */
function isWithinByIdentity(destination: string, root: { dev: number; ino: number }): boolean {
  for (const candidate of selfAndAncestors(destination)) {
    let stats;
    try {
      stats = statSync(candidate);
    } catch (error) {
      const code = errorCode(error);
      if (code === 'ENOENT' || code === 'ENOTDIR') continue;
      throw new EvaluationCapturePathError(`Cannot classify evaluation capture path ${describePath(destination)} (${code ?? 'unknown error'}).`);
    }
    if (stats.dev === root.dev && stats.ino === root.ino) return true;
  }
  return false;
}

/** Nearest directory at or above `destination` that holds a `.git` entry (directory, or file for worktrees). */
function containingGitWorkingTree(destination: string): string | null {
  for (const candidate of selfAndAncestors(destination)) {
    try {
      lstatSync(join(candidate, '.git'));
      return candidate;
    } catch (error) {
      const code = errorCode(error);
      if (code === 'ENOENT' || code === 'ENOTDIR') continue;
      throw new EvaluationCapturePathError(`Cannot classify evaluation capture path ${describePath(destination)} (${code ?? 'unknown error'}).`);
    }
  }
  return null;
}

/**
 * Throws unless `filePath` resolves outside this repository and outside every Git working tree. Does not create,
 * move or redirect anything. Returns the canonical destination.
 */
export function assertEvaluationCaptureOutsideRepository(filePath: string, repositoryRoot: string | null = findRepositoryRoot()): string {
  if (!repositoryRoot) {
    throw new EvaluationCapturePathError('Cannot determine the repository root; refusing to write evaluation captures.');
  }
  const root = canonicalize(repositoryRoot);
  let rootStats;
  try {
    rootStats = statSync(root);
  } catch (error) {
    throw new EvaluationCapturePathError(`Cannot inspect the repository root (${errorCode(error) ?? 'unknown error'}); refusing to write evaluation captures.`);
  }
  const destination = canonicalize(filePath);
  const rel = relative(root, destination);
  const outsideByPath = rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);
  if (!outsideByPath || isWithinByIdentity(destination, rootStats)) {
    const shown = outsideByPath ? basename(destination) : `<repository>/${rel || '.'}`;
    throw new EvaluationCapturePathError(
      `Refusing evaluation capture inside the repository (${shown}). Use a directory outside every Git working tree, for example one created with mktemp -d.`,
    );
  }
  const workingTree = containingGitWorkingTree(destination);
  if (workingTree) {
    throw new EvaluationCapturePathError(
      `Refusing evaluation capture inside a Git working tree (${describePath(workingTree)}). Use a directory outside every Git working tree, for example one created with mktemp -d.`,
    );
  }
  return destination;
}

/**
 * Appends one capture line, validating the destination immediately before the write:
 * the path is re-classified, the parent directory is canonicalised, created (mode 0700) and re-checked, the final
 * component is never resolved (an existing symlink there is refused, and the file is opened with O_NOFOLLOW) and is
 * created with mode 0600, and the opened file must be a regular, single-link file that the path still names.
 * Any doubt fails closed.
 */
export function appendEvaluationCaptureLine(filePath: string, line: string, repositoryRoot: string | null = findRepositoryRoot()): void {
  writeGuarded(filePath, line, 'append', repositoryRoot);
}

/**
 * Writes (creates or replaces) one evaluation output file with the same checks as appendEvaluationCaptureLine.
 * An existing file is truncated only after every check has passed, and its mode is reset to 0600.
 */
export function writeEvaluationOutputFile(filePath: string, content: string, repositoryRoot: string | null = findRepositoryRoot()): void {
  writeGuarded(filePath, content, 'replace', repositoryRoot);
}

function writeGuarded(filePath: string, content: string, mode: 'append' | 'replace', repositoryRoot: string | null): void {
  const noFollow = constants.O_NOFOLLOW;
  if (typeof noFollow !== 'number' || noFollow === 0) {
    throw new EvaluationCapturePathError('O_NOFOLLOW is not available; refusing to write evaluation captures.');
  }
  // Classify where the requested path leads (a symlinked leaf included), then write to the canonical parent plus the
  // requested name: the leaf itself is never resolved, so an existing symlink there cannot redirect the write.
  const requested = resolve(filePath);
  assertEvaluationCaptureOutsideRepository(requested, repositoryRoot);
  const directory = canonicalize(dirname(requested));
  const destination = join(directory, basename(requested));
  assertEvaluationCaptureOutsideRepository(destination, repositoryRoot);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (canonicalize(directory) !== directory) {
    throw new EvaluationCapturePathError(`Evaluation capture directory changed while it was created (${basename(directory)}); refusing to write.`);
  }
  assertEvaluationCaptureOutsideRepository(directory, repositoryRoot);
  try {
    if (lstatSync(destination).isSymbolicLink()) {
      throw new EvaluationCapturePathError(`Refusing evaluation capture through a symlink (${basename(destination)}).`);
    }
  } catch (error) {
    if (error instanceof EvaluationCapturePathError) throw error;
    if (errorCode(error) !== 'ENOENT') {
      throw new EvaluationCapturePathError(`Cannot inspect evaluation capture file ${basename(destination)} (${errorCode(error) ?? 'unknown error'}).`);
    }
  }

  // O_TRUNC is deliberately not used: truncating happens only after the opened file has been verified.
  const flags = constants.O_WRONLY | constants.O_CREAT | noFollow | (mode === 'append' ? constants.O_APPEND : 0);
  let fd: number;
  try {
    fd = openSync(destination, flags, 0o600);
  } catch (error) {
    const code = errorCode(error);
    throw new EvaluationCapturePathError(
      code === 'ELOOP'
        ? `Refusing evaluation capture through a symlink (${basename(destination)}).`
        : `Cannot open evaluation capture file ${basename(destination)} (${code ?? 'unknown error'}).`,
    );
  }
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1) {
      throw new EvaluationCapturePathError(`Refusing evaluation capture into a file that is not a single-link regular file (${basename(destination)}).`);
    }
    const named = lstatSync(destination);
    if (named.dev !== opened.dev || named.ino !== opened.ino || canonicalize(directory) !== directory) {
      throw new EvaluationCapturePathError(`Evaluation capture destination changed during the write (${basename(destination)}); refusing to write.`);
    }
    if (mode === 'replace') {
      ftruncateSync(fd, 0);
      fchmodSync(fd, 0o600);
    }
    const bytes = Buffer.from(content, 'utf8');
    let written = 0;
    while (written < bytes.length) written += writeSync(fd, bytes, written, bytes.length - written, mode === 'replace' ? written : null);
  } finally {
    closeSync(fd);
  }
}
