import { createHash } from 'crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';
import checksumManifest from './migration-checksums.json';

/**
 * Where the numbered SQL migrations are: next to this file (tsx from the repository), else infra/db/migrations under the
 * working directory (the compiled image runs dist/infra/db/*.js from /app, with the SQL files copied to
 * /app/infra/db/migrations). Null when neither exists.
 */
export function resolveMigrationsDir(candidates: string[] = defaultMigrationDirCandidates()): string | null {
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isDirectory() && listMigrationFiles(candidate).length > 0) {
      return candidate;
    }
  }
  return null;
}

function defaultMigrationDirCandidates(): string[] {
  return [path.resolve(__dirname, 'migrations'), path.resolve(process.cwd(), 'infra/db/migrations')];
}

/** The migration files of a directory in the order they apply (by name: 001_…, 002_…). */
export function listMigrationFiles(migrationsDir: string): string[] {
  return readdirSync(migrationsDir)
    .filter((fileName) => fileName.endsWith('.sql'))
    .sort();
}

/** The newest migration file of the directory (the schema the code expects); null for an empty directory. */
export function newestMigrationFile(migrationsDir: string): string | null {
  return listMigrationFiles(migrationsDir).at(-1) ?? null;
}

export function migrationFileChecksum(migrationsDir: string, fileName: string): string {
  return createHash('sha256').update(readFileSync(path.join(migrationsDir, fileName))).digest('hex');
}

/** sha256 of every recorded migration (migration-checksums.json, kept by migration-immutability.spec.ts). */
export const KNOWN_MIGRATION_CHECKSUMS: Readonly<Record<string, string>> = (checksumManifest as { checksums: Record<string, string> }).checksums;

/**
 * Migration files whose bytes differ from their recorded checksum. schema_migrations stores no checksums, so an edited
 * migration that was already applied would silently never reach existing databases; the runner refuses to start instead.
 */
export function findChecksumMismatches(migrationsDir: string, fileNames: string[], known: Readonly<Record<string, string>> = KNOWN_MIGRATION_CHECKSUMS): string[] {
  return fileNames.filter((fileName) => {
    const expected = known[fileName];
    return expected !== undefined && migrationFileChecksum(migrationsDir, fileName) !== expected;
  });
}
