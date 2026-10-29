import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { PostgresGlucoMindRepository } from './postgres-glucomind.repository';
import { configurePostgresIntegrationEnvironment, truncatePublicTablesForIntegrationTests } from './postgres-test-isolation';

const runPostgresIntegration = process.env.RUN_POSTGRES_INTEGRATION === '1';
const describePostgres = runPostgresIntegration ? describe.sequential : describe.skip;

configurePostgresIntegrationEnvironment(process.env);

// Migration 083: one answer push per question and outcome, so a job rerun after a lost lease pushes nothing.
describePostgres('answer push claim (PostgreSQL)', () => {
  let pool: Pool;
  let repository: PostgresGlucoMindRepository;

  beforeAll(async () => {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) throw new Error('DATABASE_URL is required for answer push claim postgres tests');
    pool = new Pool({ connectionString: databaseUrl });
    repository = new PostgresGlucoMindRepository(pool);
  });

  beforeEach(async () => {
    await truncatePublicTablesForIntegrationTests(pool);
  });

  afterAll(async () => {
    await truncatePublicTablesForIntegrationTests(pool);
    await pool?.end();
  });

  it('lets only the first finish of a question push, per outcome', async () => {
    const patientId = randomUUID();
    await pool.query(`INSERT INTO patients (id, display_name) VALUES ($1::uuid, 'p')`, [patientId]);
    const questionMessageId = randomUUID();

    await expect(repository.claimAnswerPush({ patientId, questionMessageId, outcome: 'ready' })).resolves.toBe(true);
    await expect(repository.claimAnswerPush({ patientId, questionMessageId, outcome: 'ready' })).resolves.toBe(false);
    // A question retried after it failed for good may still be told its answer is ready.
    await expect(repository.claimAnswerPush({ patientId, questionMessageId, outcome: 'failed' })).resolves.toBe(true);
    await expect(repository.claimAnswerPush({ patientId, questionMessageId, outcome: 'failed' })).resolves.toBe(false);

    // Two finishes at the same moment: exactly one wins.
    const raced = randomUUID();
    const results = await Promise.all([1, 2, 3].map(() => repository.claimAnswerPush({ patientId, questionMessageId: raced, outcome: 'ready' })));
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('goes with the patient', async () => {
    const patientId = randomUUID();
    await pool.query(`INSERT INTO patients (id, display_name) VALUES ($1::uuid, 'p')`, [patientId]);
    await repository.claimAnswerPush({ patientId, questionMessageId: randomUUID(), outcome: 'ready' });
    await pool.query(`DELETE FROM patients WHERE id = $1::uuid`, [patientId]);
    const left = await pool.query(`SELECT count(*)::int AS n FROM answer_push_sent WHERE patient_id = $1::uuid`, [patientId]);
    expect(left.rows[0].n).toBe(0);
  });
});
