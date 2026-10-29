import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** Runs the offline shell tests of the installer and the `mellis` tool (stubbed docker/curl, no network, no root). */
function hasTools(): boolean {
  try {
    for (const tool of ['bash', 'jq', 'openssl', 'perl', 'tar']) execFileSync('which', [tool], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe.runIf(hasTools())('scripts/install-server.sh', () => {
  it('passes its shell tests', { timeout: 300_000 }, () => {
    const output = execFileSync('bash', [join(__dirname, 'install-server.test.sh')], { encoding: 'utf8', env: { ...process.env, KEEP_WORK: '' } });
    expect(output).toMatch(/\d+ passed, 0 failed/);
  });
});

describe('one version number (scripts/sync-version.sh)', () => {
  it('package.json, apps/ios/Version.xcconfig and the installer agree', () => {
    expect(() => execFileSync('bash', [join(__dirname, '..', 'sync-version.sh'), '--check'], { stdio: 'pipe' })).not.toThrow();
  });
});
