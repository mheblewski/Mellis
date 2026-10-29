import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const MIGRATIONS_DIR = resolve(__dirname, 'migrations');
const manifest = JSON.parse(readFileSync(resolve(__dirname, 'migration-checksums.json'), 'utf8')) as {
  checksums: Record<string, string>;
};

function sha256(fileName: string): string {
  return createHash('sha256').update(readFileSync(resolve(MIGRATIONS_DIR, fileName))).digest('hex');
}

describe('migration immutability', () => {
  // infra/db/migrate.ts skips versions already recorded in schema_migrations, so editing an applied
  // migration never reaches existing databases (therapies.observed_at was lost this way).
  it('keeps every recorded migration file byte-identical', () => {
    const changed = Object.entries(manifest.checksums)
      .filter(([fileName, checksum]) => sha256(fileName) !== checksum)
      .map(([fileName]) => fileName);

    expect(changed, 'Applied migrations were edited; add a new numbered migration instead').toEqual([]);
  });

  it('records a checksum for every migration file', () => {
    const files = readdirSync(MIGRATIONS_DIR).filter((fileName) => fileName.endsWith('.sql')).sort();
    expect(files.filter((fileName) => !(fileName in manifest.checksums))).toEqual([]);
  });
});
