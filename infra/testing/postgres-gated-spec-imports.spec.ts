import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Nest app modules validate their environment (DATABASE_URL, NIGHTSCOUT_*) as soon as they are imported. A spec that
// is skipped unless RUN_POSTGRES_INTEGRATION=1 must therefore load them lazily, inside the gated tests, so the offline
// suite runs without any database or Nightscout configuration.
const repoRoot = resolve(__dirname, '../..');
const SKIPPED_DIRECTORIES = new Set(['node_modules', '.git', '.claude', 'dist', 'build', 'artifacts']);
const STATIC_APP_MODULE_IMPORT = /^import\s+(?!type\b)[^;]*?from\s+['"][^'"]*apps\/[^'"/]+\/src\/app\.module['"]/m;

function specFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) return SKIPPED_DIRECTORIES.has(entry.name) ? [] : specFiles(join(directory, entry.name));
    return entry.isFile() && entry.name.endsWith('.spec.ts') ? [join(directory, entry.name)] : [];
  });
}

describe('Postgres-gated specs', () => {
  it('do not import Nest app modules at module load time', () => {
    const gated = specFiles(repoRoot).filter((file) => readFileSync(file, 'utf8').includes('RUN_POSTGRES_INTEGRATION'));
    expect(gated.length).toBeGreaterThan(0);
    const offenders = gated.filter((file) => STATIC_APP_MODULE_IMPORT.test(readFileSync(file, 'utf8'))).map((file) => relative(repoRoot, file));
    expect(offenders).toEqual([]);
  });

  it('detects a static app module import and ignores type-only imports', () => {
    expect(STATIC_APP_MODULE_IMPORT.test("import { WorkerAppModule } from '../../../apps/worker/src/app.module';")).toBe(true);
    expect(STATIC_APP_MODULE_IMPORT.test("import type { WorkerAppModule } from '../../../apps/worker/src/app.module';")).toBe(false);
    expect(STATIC_APP_MODULE_IMPORT.test("  const { WorkerAppModule } = await import('../../../apps/worker/src/app.module');")).toBe(false);
  });
});
