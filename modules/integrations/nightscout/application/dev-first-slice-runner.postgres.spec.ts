import 'dotenv/config';
import { describe, expect, it, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { Pool } from 'pg';
import {
  resetDevFirstSliceScenario,
  runDevFirstSliceScenario,
} from './dev-first-slice-runner';

const runPostgresIntegration = process.env.RUN_POSTGRES_INTEGRATION === '1';
const describePostgres = runPostgresIntegration ? describe.sequential : describe.skip;

describePostgres('dev first-slice runner (postgres)', { timeout: 60_000 }, () => {
  beforeAll(async () => {
    await resetDevFirstSliceScenario();
  });

  afterAll(async () => {
    await resetDevFirstSliceScenario();
  });

  it('turns the synthetic Nightscout low into a closed hypo episode and sends the caregiver nothing about it', async () => {
    const result = await runDevFirstSliceScenario();

    expect(result.patientId).toBe('11111111-1111-4111-8111-111111111111');
    expect(result.hypo.episode_id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(result.hypo.ended_at).toBeTruthy();
    // Nothing is asked or pushed about a hypo after the fact (2026-10-25).
    expect(result).toMatchObject({ conversations: 0, queuedHypoPushes: 0 });
  });

  it('running the scenario twice keeps one episode', async () => {
    const first = await runDevFirstSliceScenario();
    const second = await runDevFirstSliceScenario();
    expect(second.hypo.episode_id).toBe(first.hypo.episode_id);

    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    try {
      const episodes = await pool.query<{ count: string }>('SELECT count(*)::text AS count FROM hypo_episodes WHERE patient_id = $1::uuid', [first.patientId]);
      expect(Number(episodes.rows[0].count)).toBe(1);
    } finally {
      await pool.end();
    }
  });
});
