import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { main } from './mellis-admin';

describe('mellis-admin (compiled server commands)', () => {
  it('prints a fresh code for SETUP_CODE', async () => {
    const lines: string[] = [];
    expect(await main(['generate-code'], {}, (line) => lines.push(line))).toBe(0);
    expect(JSON.parse(lines[0]).code).toMatch(/^[0-9A-Z]{5}(-[0-9A-Z]{5}){3}$/);
  });

  it('creates the AI budget ledger once, without tsx or scripts', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'mellis-ledger-')), 'ledger.json');
    const lines: string[] = [];
    expect(await main(['ai-budget', '--total', '20', '--max-calls', '2000'], { AI_EXPERIMENT_BUDGET_LEDGER_PATH: path }, (line) => lines.push(line))).toBe(0);
    expect(JSON.parse(lines[0])).toMatchObject({ experiment_id: 'mellis', currency: 'USD', total_budget: 20, max_calls: 2000, remaining_budget: 20 });
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ total_budget: 20, reservations: [] });
    expect(await main(['ai-budget', '--total', '20', '--max-calls', '2000'], { AI_EXPERIMENT_BUDGET_LEDGER_PATH: path }, (line) => lines.push(line))).toBe(1);
    expect(JSON.parse(lines[1]).error).toBeTruthy();
  });

  it('explains its usage and needs a database for setup commands', async () => {
    const lines: string[] = [];
    expect(await main(['nope'], {}, (line) => lines.push(line))).toBe(2);
    expect(await main(['setup-status'], {}, (line) => lines.push(line))).toBe(2);
    expect(JSON.parse(lines[1]).error).toBe('DATABASE_URL is required');
    expect(JSON.parse(lines[0]).commands).toEqual(expect.arrayContaining(['owners', 'reset-owner [--name <first name> | --user <user_id>]', 'recovery-code [--user <user_id>]']));
    expect(await main(['owners'], {}, (line) => lines.push(line))).toBe(2);
    expect(JSON.parse(lines[2]).error).toBe('DATABASE_URL is required');
    // A new person or an existing owner, never both.
    expect(await main(['reset-owner', '--name', 'Ania', '--user', 'u1'], { DATABASE_URL: 'postgresql://unused/db' }, (line) => lines.push(line))).toBe(2);
    expect(JSON.parse(lines[3])).toMatchObject({ error: 'USAGE' });
  });

  it('checks the AI keys from the environment (no key on the command line)', async () => {
    const fetch = async (_url: string, init: { headers: Record<string, string> }) => ({ status: (init.headers['x-api-key'] ?? init.headers.Authorization ?? '').includes('good') ? 200 : 401 });
    const lines: string[] = [];
    expect(await main(['check-ai'], { AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'good-claude' }, (line) => lines.push(line), fetch)).toBe(0);
    expect(JSON.parse(lines[0])).toMatchObject({ ok: true, capabilities: { knowledge_search_mode: 'bm25' } });
    expect(lines[0]).not.toContain('good-claude');
    expect(await main(['check-ai'], { AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'good-claude', OPENAI_API_KEY: 'bad' }, (line) => lines.push(line), fetch)).toBe(1);
    expect(JSON.parse(lines[1])).toEqual({ ok: false, error: 'AI_KEY_INVALID: OPENAI_API_KEY' });
  });

  it('sets a monthly AI limit, changes it keeping the spending, and reports it', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'mellis-ledger-')), 'ledger.json');
    const env = { AI_EXPERIMENT_BUDGET_LEDGER_PATH: path, TZ: 'Europe/Warsaw', AI_EXPERIMENT_MAX_COST: '0.25' };
    const lines: string[] = [];
    expect(await main(['ai-limit', '--total', '15'], env, (line) => lines.push(line))).toBe(0);
    expect(JSON.parse(lines[0])).toMatchObject({ period: 'MONTHLY', total_budget: 15, max_calls: 7500, charged: 0, limit_reached: false });
    expect(JSON.parse(readFileSync(path, 'utf8')).period).toMatchObject({ kind: 'MONTHLY', time_zone: 'Europe/Warsaw' });
    expect(await main(['ai-limit', '--total', '0.2'], env, (line) => lines.push(line))).toBe(0);
    expect(JSON.parse(lines[1])).toMatchObject({ total_budget: 0.2, max_calls: 1000, limit_reached: true });
    expect(await main(['ai-status'], env, (line) => lines.push(line))).toBe(0);
    expect(JSON.parse(lines[2])).toMatchObject({ total_budget: 0.2, limit_reached: true });
    expect(JSON.parse(lines[2]).resets_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:00:00.000Z$/);
    expect(await main(['ai-limit', '--total', '0'], env, (line) => lines.push(line))).toBe(1);
  });

  it('creates a monthly ledger with ai-budget --monthly', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'mellis-ledger-')), 'ledger.json');
    const lines: string[] = [];
    expect(await main(['ai-budget', '--total', '10', '--max-calls', '100', '--monthly', '--time-zone', 'UTC'], { AI_EXPERIMENT_BUDGET_LEDGER_PATH: path }, (line) => lines.push(line))).toBe(0);
    expect(JSON.parse(lines[0]).period).toMatchObject({ kind: 'MONTHLY', time_zone: 'UTC' });
  });
});
