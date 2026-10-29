import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { PostgresGlucoMindRepository } from './postgres-glucomind.repository';
import { configurePostgresIntegrationEnvironment, truncatePublicTablesForIntegrationTests } from './postgres-test-isolation';

const runPostgresIntegration = process.env.RUN_POSTGRES_INTEGRATION === '1';
const describePostgres = runPostgresIntegration ? describe.sequential : describe.skip;

configurePostgresIntegrationEnvironment(process.env);

async function ensurePatient(pool: Pool, patientId: string): Promise<void> {
  await pool.query(
    `INSERT INTO patients (id, display_name) VALUES ($1::uuid, $2) ON CONFLICT (id) DO NOTHING`,
    [patientId, `patient-${patientId.slice(0, 8)}`],
  );
}

async function insertAnalysisScaffold(pool: Pool, patientId: string): Promise<{ episodeId: string; triggerId: string; eventId: string }> {
  const sourceId = randomUUID();
  const sourceRecordId = randomUUID();
  const eventId = randomUUID();
  const episodeId = randomUUID();
  const triggerId = randomUUID();
  const nowIso = new Date().toISOString();

  await ensurePatient(pool, patientId);

  await pool.query(
    `INSERT INTO sources (id, patient_id, source_system, source_key, metadata) VALUES ($1::uuid, $2::uuid, 'NIGHTSCOUT', $3, '{}'::jsonb)`,
    [sourceId, patientId, `nightscout-${patientId}`],
  );

  await pool.query(
    `INSERT INTO source_records (
      id, patient_id, source_id, source_system, source_record_id, natural_key, record_type,
      occurred_at, recorded_at, imported_at, raw_payload, canonical_hash
    ) VALUES (
      $1::uuid,$2::uuid,$3::uuid,'NIGHTSCOUT',$4,$5,'cgm.entry',$6::timestamptz,$6::timestamptz,$6::timestamptz,$7::jsonb,$8
    )`,
    [
      sourceRecordId,
      patientId,
      sourceId,
      `record-${sourceRecordId}`,
      `nightscout:${patientId}:${sourceRecordId}`,
      nowIso,
      JSON.stringify({ sgv: 64 }),
      `canonical-${sourceRecordId}`,
    ],
  );

  await pool.query(
    `INSERT INTO events (
      id, patient_id, source_record_id, type, occurred_at, recorded_at, source, context, payload
    ) VALUES (
      $1::uuid,$2::uuid,$3::uuid,'GLUCOSE_READING_AVAILABLE',$4::timestamptz,$4::timestamptz,$5::jsonb,$6::jsonb,$7::jsonb
    )`,
    [
      eventId,
      patientId,
      sourceRecordId,
      nowIso,
      JSON.stringify({ source_id: sourceId }),
      JSON.stringify({ source_id: sourceId }),
      JSON.stringify({ glucose_value: 64 }),
    ],
  );

  await pool.query(
    `INSERT INTO hypo_episodes (
      id, patient_id, trigger_id, start_event_id, analysis_id, recommendation_id, state, severity,
      started_at, ended_at, latest_event_id, rule_version
    ) VALUES (
      $1::uuid,$2::uuid,$3::uuid,$4::uuid,NULL,NULL,'OPEN','L1',$5::timestamptz,NULL,$4::uuid,'hypo.cgm.ada2026.v1'
    )`,
    [episodeId, patientId, triggerId, eventId, nowIso],
  );

  await pool.query(
    `INSERT INTO triggers (
      id, patient_id, type, source_event_id, episode_id, rule_version, status, cooldown_seconds
    ) VALUES (
      $1::uuid,$2::uuid,'HYPO_DETECTED',$3::uuid,$4::uuid,'hypo.cgm.ada2026.v1','OPEN',0
    )`,
    [triggerId, patientId, eventId, episodeId],
  );

  return { episodeId, triggerId, eventId };
}

describePostgres('PostgresGlucoMindRepository analysis persistence (postgres)', { timeout: 120_000 }, () => {
  let pool: Pool;
  let repository: PostgresGlucoMindRepository;

  beforeAll(async () => {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      throw new Error('DATABASE_URL is required for PostgresGlucoMindRepository postgres tests');
    }

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

  it('enforces patient access through caregiver_relationships and revokes access immediately', async () => {
    const userA = randomUUID();
    const userB = randomUUID();
    const patientA = randomUUID();
    const patientB = randomUUID();

    await pool.query(
      `INSERT INTO users (id, display_name) VALUES ($1::uuid, $2), ($3::uuid, $4)`,
      [userA, 'user-a', userB, 'user-b'],
    );

    await pool.query(
      `INSERT INTO patients (id, display_name) VALUES ($1::uuid, $2), ($3::uuid, $4)`,
      [patientA, 'patient-a', patientB, 'patient-b'],
    );

    await pool.query(
      `INSERT INTO caregiver_relationships (id, user_id, patient_id, relationship_type, permissions)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'CAREGIVER', '{}'::jsonb),
              ($4::uuid, $2::uuid, $5::uuid, 'CAREGIVER', '{}'::jsonb),
              ($6::uuid, $7::uuid, $3::uuid, 'CAREGIVER', '{}'::jsonb)`,
      [randomUUID(), userA, patientA, randomUUID(), patientB, randomUUID(), userB],
    );

    const allowedA = await repository.getAccessRow(userA, patientA);
    const allowedB = await repository.getAccessRow(userB, patientA);
    const denied = await repository.getAccessRow(userA, randomUUID());
    const accessiblePatients = await repository.listAccessiblePatients(userA);

    expect(allowedA).toMatchObject({ user_id: userA, patient_id: patientA, can_read_patient: true, can_write_patient: true });
    expect(allowedB).toMatchObject({ user_id: userB, patient_id: patientA, can_read_patient: true, can_write_patient: true });
    expect(denied).toBeNull();
    expect(accessiblePatients.map((row) => row.patient_id)).toEqual(expect.arrayContaining([patientA, patientB]));
    expect(accessiblePatients.find((row) => row.patient_id === patientA)?.birth_year).toBeNull();

    expect(await repository.setPatientBirthYear(patientA, 2016)).toBe(true);
    expect(await repository.getPatientBirthYear(patientA)).toBe(2016);
    expect((await repository.listAccessiblePatients(userA)).find((row) => row.patient_id === patientA)?.birth_year).toBe(2016);
    expect(await repository.getPatientBirthYear(patientB)).toBeNull();
    expect(await repository.setPatientBirthYear(randomUUID(), 2016)).toBe(false);

    expect(await repository.getUserAiPreferences(userA)).toEqual({ ai_role: null, ai_instructions: null });
    expect(await repository.setUserAiPreferences(userA, { ai_role: 'PATIENT_SELF', ai_instructions: 'Mów do mnie po imieniu.' })).toBe(true);
    expect(await repository.getUserAiPreferences(userA)).toEqual({ ai_role: 'PATIENT_SELF', ai_instructions: 'Mów do mnie po imieniu.' });
    expect(await repository.getUserAiPreferences(userB)).toEqual({ ai_role: null, ai_instructions: null });
    expect(await repository.setUserAiPreferences(userA, { ai_role: null, ai_instructions: null })).toBe(true);
    expect(await repository.getUserAiPreferences(userA)).toEqual({ ai_role: null, ai_instructions: null });
    expect(await repository.setUserAiPreferences(randomUUID(), { ai_role: 'PARENT', ai_instructions: null })).toBe(false);
    await expect(pool.query(`UPDATE users SET ai_role = 'BOSS' WHERE id = $1`, [userA])).rejects.toThrow();
    await expect(pool.query(`UPDATE users SET ai_instructions = repeat('a', 501) WHERE id = $1`, [userA])).rejects.toThrow();

    await pool.query(
      `DELETE FROM caregiver_relationships WHERE user_id = $1::uuid AND patient_id = $2::uuid`,
      [userA, patientB],
    );

    const revoked = await repository.getAccessRow(userA, patientB);
    expect(revoked).toBeNull();
  });

  it('persists question and proposal in analyses and returns them through getAnalysis', async () => {
    const patientId = randomUUID();
    const scaffold = await insertAnalysisScaffold(pool, patientId);

    const expectedQuestion = {
      question_id: 'activity_before_drop',
      text: 'Was there physical activity before the drop?',
      expected_answer_types: ['YES', 'NO', 'UNKNOWN'],
      reason: 'Need event context.',
      expected_information_gain: 'HIGH',
    };

    const expectedProposal = {
      type: 'FOLLOW_UP_QUESTION',
      title: 'Clarify context',
      text: 'Ask for missing activity context.',
    };

    const inserted = await repository.insertAnalysis({
      patientId,
      episodeId: scaffold.episodeId,
      triggerId: scaffold.triggerId,
      taskType: 'USER_INVESTIGATION_FOLLOW_UP',
      status: 'COMPLETED',
      facts: [{ fact_id: 'fact-1', statement: 'Hypo detected.', source_refs: [scaffold.eventId] }],
      unknowns: [],
      calculations: [],
      hypotheses: [],
      assumptions: [],
      uncertainty: { level: 'LOW', summary: 'bounded' },
      question: expectedQuestion,
      proposal: expectedProposal,
      rationale: 'Need a deterministic follow-up clarification.',
      analysisVersion: 'analysis.v1.1',
      contextPackageId: randomUUID(),
      contextPackageVersion: 'context-package.v1',
      contextPackageHash: 'sha256:analysis-context-1',
      inputHash: 'sha256:input-1',
      promptVersion: 'hypo-analysis.v1',
      modelFingerprint: 'test:model',
    });

    const readBack = await repository.getAnalysis(patientId, String(inserted.id));
    expect(readBack).toBeTruthy();
    expect(readBack?.question).toEqual(expectedQuestion);
    expect(readBack?.proposal).toEqual(expectedProposal);
  });

  it('updates stale null question/proposal on conflict replay without creating duplicate analysis rows', async () => {
    const patientId = randomUUID();
    const scaffold = await insertAnalysisScaffold(pool, patientId);
    const contextPackageHash = 'sha256:analysis-context-replay';

    const first = await repository.insertAnalysis({
      patientId,
      episodeId: scaffold.episodeId,
      triggerId: scaffold.triggerId,
      taskType: 'USER_INVESTIGATION_FOLLOW_UP',
      status: 'COMPLETED',
      facts: [{ fact_id: 'fact-1', statement: 'Hypo detected.', source_refs: [scaffold.eventId] }],
      unknowns: [],
      calculations: [],
      hypotheses: [],
      assumptions: [],
      uncertainty: { level: 'LOW', summary: 'bounded' },
      question: null,
      proposal: null,
      rationale: 'Replay candidate.',
      analysisVersion: 'analysis.v1.1',
      contextPackageId: randomUUID(),
      contextPackageVersion: 'context-package.v1',
      contextPackageHash,
      inputHash: 'sha256:input-replay',
      promptVersion: 'hypo-analysis.v1',
      modelFingerprint: 'test:model',
    });

    const replayQuestion = {
      question_id: 'activity_before_drop',
      text: 'Was there physical activity before the glucose drop?',
      expected_answer_types: ['YES', 'NO', 'UNKNOWN'],
      reason: 'Clarify trigger context.',
      expected_information_gain: 'HIGH',
    };

    const replayProposal = {
      type: 'FOLLOW_UP_QUESTION',
      title: 'Clarify context',
      text: 'Ask for missing activity context.',
    };

    const second = await repository.insertAnalysis({
      patientId,
      episodeId: scaffold.episodeId,
      triggerId: scaffold.triggerId,
      taskType: 'USER_INVESTIGATION_FOLLOW_UP',
      status: 'COMPLETED',
      facts: [{ fact_id: 'fact-1', statement: 'Hypo detected.', source_refs: [scaffold.eventId] }],
      unknowns: [],
      calculations: [],
      hypotheses: [],
      assumptions: [],
      uncertainty: { level: 'LOW', summary: 'bounded' },
      question: replayQuestion,
      proposal: replayProposal,
      rationale: 'Replay candidate.',
      analysisVersion: 'analysis.v1.1',
      contextPackageId: randomUUID(),
      contextPackageVersion: 'context-package.v1',
      contextPackageHash,
      inputHash: 'sha256:input-replay',
      promptVersion: 'hypo-analysis.v1',
      modelFingerprint: 'test:model',
    });

    expect(String(second.id)).toBe(String(first.id));

    const count = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM analyses WHERE patient_id = $1::uuid AND episode_id = $2::uuid AND task_type = $3 AND context_package_hash = $4`,
      [patientId, scaffold.episodeId, 'USER_INVESTIGATION_FOLLOW_UP', contextPackageHash],
    );
    expect(Number(count.rows[0].count)).toBe(1);

    const readBack = await repository.getAnalysis(patientId, String(first.id));
    expect(readBack).toBeTruthy();
    expect(readBack?.question).toEqual(replayQuestion);
    expect(readBack?.proposal).toEqual(replayProposal);
    expect(String(readBack?.patient_id ?? '')).toBe(patientId);
    expect(String(readBack?.episode_id ?? '')).toBe(scaffold.episodeId);
    expect(String(readBack?.task_type ?? '')).toBe('USER_INVESTIGATION_FOLLOW_UP');
    expect(String(readBack?.context_package_hash ?? '')).toBe(contextPackageHash);
  });

  it('aggregates execution cost across failed and successful billable attempts', async () => {
    const patientId = randomUUID();
    await ensurePatient(pool, patientId);

    const taskIdentity = `task:${randomUUID()}`;
    const task = {
      task_id: randomUUID(),
      task_type: 'CONVERSATION_DIRECT_RESPONSE',
      task_version: 'conversation-direct-response.v1',
      context_package_id: randomUUID(),
      context_package_version: 'conversation-context.v1',
      context_package_hash: `sha256:${randomUUID()}`,
      prompt_version: 'conversation-direct-response.v1',
      output_schema_version: 'conversation-direct-response-output.v1',
      model_policy_version: 'model-policy.v1',
      correlation_id: randomUUID(),
      created_at: new Date().toISOString(),
      patient_id: patientId,
    } as const;

    await repository.markAiExecutionRunning({
      task,
      taskIdentity,
      inputHash: `sha256:${randomUUID()}`,
      nowIso: new Date().toISOString(),
    });

    const firstAttempt = await repository.createAiExecutionAttempt({
      taskIdentity,
      provider: 'openai',
      model: 'gpt-5.6-terra',
      startedAt: new Date().toISOString(),
    });
    await repository.updateAiExecutionAttempt({
      attemptId: firstAttempt.id,
      provider: 'openai',
      model: 'gpt-5.6-terra',
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      status: 'FAILED',
      usage: {
        input_tokens: 140,
        output_tokens: 10,
        total_tokens: 150,
        cached_input_tokens: null,
        reasoning_tokens: null,
      },
      estimatedCost: {
        estimated_cost: 0.0015,
        currency: 'USD',
        pricing_version: 'openai.pricing.v1',
        input_cost: 0.0012,
        output_cost: 0.0003,
        cached_input_cost: null,
        reasoning_cost: null,
      },
      errorType: 'AI_PROVIDER_RETRYABLE',
      errorCode: 'timeout',
    });

    const secondAttempt = await repository.createAiExecutionAttempt({
      taskIdentity,
      provider: 'openai',
      model: 'gpt-5.6-terra',
      startedAt: new Date().toISOString(),
    });
    await repository.updateAiExecutionAttempt({
      attemptId: secondAttempt.id,
      provider: 'openai',
      model: 'gpt-5.6-terra',
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      status: 'SUCCEEDED',
      usage: {
        input_tokens: 200,
        output_tokens: 40,
        total_tokens: 240,
        cached_input_tokens: null,
        reasoning_tokens: null,
      },
      estimatedCost: {
        estimated_cost: 0.003,
        currency: 'USD',
        pricing_version: 'openai.pricing.v1',
        input_cost: 0.002,
        output_cost: 0.001,
        cached_input_cost: null,
        reasoning_cost: null,
      },
    });

    await repository.markAiExecutionSucceeded({
      taskIdentity,
      nowIso: new Date().toISOString(),
      result: {
        task,
        input_hash: `sha256:${randomUUID()}`,
        task_identity: taskIdentity,
        metadata: {
          provider: 'openai',
          model: 'gpt-5.6-terra',
          prompt_version: task.prompt_version,
          output_schema_version: task.output_schema_version,
          model_policy_version: task.model_policy_version,
          model_fingerprint: 'openai:gpt-5.6-terra:prompt:schema',
          usage: {
            input_tokens: 200,
            output_tokens: 40,
            total_tokens: 240,
            cached_input_tokens: null,
            reasoning_tokens: null,
          },
          estimated_cost: {
            estimated_cost: 0.003,
            currency: 'USD',
            pricing_version: 'openai.pricing.v1',
            input_cost: 0.002,
            output_cost: 0.001,
            cached_input_cost: null,
            reasoning_cost: null,
          },
        },
        result: { assistant_message: 'ok' },
      } as any,
    });

    const row = await pool.query<{ estimated_cost: string | null; cost_currency: string | null; pricing_version: string | null }>(
      `SELECT estimated_cost::text, cost_currency, pricing_version FROM ai_executions WHERE task_identity = $1 LIMIT 1`,
      [taskIdentity],
    );

    expect(Number(row.rows[0].estimated_cost ?? '0')).toBeCloseTo(0.0045, 12);
    expect(row.rows[0].cost_currency).toBe('USD');
    expect(row.rows[0].pricing_version).toBe('openai.pricing.v1');
  });

  it('keeps execution cost known when a failed attempt had no billable usage', async () => {
    const patientId = randomUUID();
    await ensurePatient(pool, patientId);

    const taskIdentity = `task:${randomUUID()}`;
    const task = {
      task_id: randomUUID(),
      task_type: 'CONVERSATION_DIRECT_RESPONSE',
      task_version: 'conversation-direct-response.v1',
      context_package_id: randomUUID(),
      context_package_version: 'conversation-context.v1',
      context_package_hash: `sha256:${randomUUID()}`,
      prompt_version: 'conversation-direct-response.v1',
      output_schema_version: 'conversation-direct-response-output.v1',
      model_policy_version: 'model-policy.v1',
      correlation_id: randomUUID(),
      created_at: new Date().toISOString(),
      patient_id: patientId,
    } as const;

    await repository.markAiExecutionRunning({
      task,
      taskIdentity,
      inputHash: `sha256:${randomUUID()}`,
      nowIso: new Date().toISOString(),
    });

    const firstAttempt = await repository.createAiExecutionAttempt({
      taskIdentity,
      provider: 'openai',
      model: 'gpt-5.6-terra',
      startedAt: new Date().toISOString(),
    });
    await repository.updateAiExecutionAttempt({
      attemptId: firstAttempt.id,
      provider: 'openai',
      model: 'gpt-5.6-terra',
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      status: 'FAILED',
      usage: null,
      estimatedCost: null,
      errorType: 'AI_PROVIDER_RETRYABLE',
      errorCode: 'network',
    });

    const secondAttempt = await repository.createAiExecutionAttempt({
      taskIdentity,
      provider: 'openai',
      model: 'gpt-5.6-terra',
      startedAt: new Date().toISOString(),
    });
    await repository.updateAiExecutionAttempt({
      attemptId: secondAttempt.id,
      provider: 'openai',
      model: 'gpt-5.6-terra',
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      status: 'SUCCEEDED',
      usage: {
        input_tokens: 120,
        output_tokens: 20,
        total_tokens: 140,
        cached_input_tokens: null,
        reasoning_tokens: null,
      },
      estimatedCost: {
        estimated_cost: 0.0014,
        currency: 'USD',
        pricing_version: 'openai.pricing.v1',
        input_cost: 0.001,
        output_cost: 0.0004,
        cached_input_cost: null,
        reasoning_cost: null,
      },
    });

    await repository.markAiExecutionSucceeded({
      taskIdentity,
      nowIso: new Date().toISOString(),
      result: {
        task,
        input_hash: `sha256:${randomUUID()}`,
        task_identity: taskIdentity,
        metadata: {
          provider: 'openai',
          model: 'gpt-5.6-terra',
          prompt_version: task.prompt_version,
          output_schema_version: task.output_schema_version,
          model_policy_version: task.model_policy_version,
          model_fingerprint: 'openai:gpt-5.6-terra:prompt:schema',
          usage: {
            input_tokens: 120,
            output_tokens: 20,
            total_tokens: 140,
            cached_input_tokens: null,
            reasoning_tokens: null,
          },
          estimated_cost: {
            estimated_cost: 0.0014,
            currency: 'USD',
            pricing_version: 'openai.pricing.v1',
            input_cost: 0.001,
            output_cost: 0.0004,
            cached_input_cost: null,
            reasoning_cost: null,
          },
        },
        result: { assistant_message: 'ok' },
      } as any,
    });

    const row = await pool.query<{ estimated_cost: string | null; cost_currency: string | null; pricing_version: string | null }>(
      `SELECT estimated_cost::text, cost_currency, pricing_version FROM ai_executions WHERE task_identity = $1 LIMIT 1`,
      [taskIdentity],
    );

    expect(Number(row.rows[0].estimated_cost ?? '0')).toBeCloseTo(0.0014, 12);
    expect(row.rows[0].cost_currency).toBe('USD');
    expect(row.rows[0].pricing_version).toBe('openai.pricing.v1');
  });

  it('marks execution cost unknown when a billable attempt has missing cost', async () => {
    const patientId = randomUUID();
    await ensurePatient(pool, patientId);

    const taskIdentity = `task:${randomUUID()}`;
    const task = {
      task_id: randomUUID(),
      task_type: 'CONVERSATION_DIRECT_RESPONSE',
      task_version: 'conversation-direct-response.v1',
      context_package_id: randomUUID(),
      context_package_version: 'conversation-context.v1',
      context_package_hash: `sha256:${randomUUID()}`,
      prompt_version: 'conversation-direct-response.v1',
      output_schema_version: 'conversation-direct-response-output.v1',
      model_policy_version: 'model-policy.v1',
      correlation_id: randomUUID(),
      created_at: new Date().toISOString(),
      patient_id: patientId,
    } as const;

    await repository.markAiExecutionRunning({
      task,
      taskIdentity,
      inputHash: `sha256:${randomUUID()}`,
      nowIso: new Date().toISOString(),
    });

    const firstAttempt = await repository.createAiExecutionAttempt({
      taskIdentity,
      provider: 'openai',
      model: 'gpt-5.6-terra',
      startedAt: new Date().toISOString(),
    });
    await repository.updateAiExecutionAttempt({
      attemptId: firstAttempt.id,
      provider: 'openai',
      model: 'gpt-5.6-terra',
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      status: 'FAILED',
      usage: {
        input_tokens: 60,
        output_tokens: 0,
        total_tokens: 60,
        cached_input_tokens: null,
        reasoning_tokens: null,
      },
      estimatedCost: null,
      errorType: 'AI_PROVIDER_RETRYABLE',
      errorCode: 'timeout',
    });

    const secondAttempt = await repository.createAiExecutionAttempt({
      taskIdentity,
      provider: 'openai',
      model: 'gpt-5.6-terra',
      startedAt: new Date().toISOString(),
    });
    await repository.updateAiExecutionAttempt({
      attemptId: secondAttempt.id,
      provider: 'openai',
      model: 'gpt-5.6-terra',
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      status: 'SUCCEEDED',
      usage: {
        input_tokens: 90,
        output_tokens: 20,
        total_tokens: 110,
        cached_input_tokens: null,
        reasoning_tokens: null,
      },
      estimatedCost: {
        estimated_cost: 0.0011,
        currency: 'USD',
        pricing_version: 'openai.pricing.v1',
        input_cost: 0.0009,
        output_cost: 0.0002,
        cached_input_cost: null,
        reasoning_cost: null,
      },
    });

    await repository.markAiExecutionSucceeded({
      taskIdentity,
      nowIso: new Date().toISOString(),
      result: {
        task,
        input_hash: `sha256:${randomUUID()}`,
        task_identity: taskIdentity,
        metadata: {
          provider: 'openai',
          model: 'gpt-5.6-terra',
          prompt_version: task.prompt_version,
          output_schema_version: task.output_schema_version,
          model_policy_version: task.model_policy_version,
          model_fingerprint: 'openai:gpt-5.6-terra:prompt:schema',
          usage: {
            input_tokens: 90,
            output_tokens: 20,
            total_tokens: 110,
            cached_input_tokens: null,
            reasoning_tokens: null,
          },
          estimated_cost: {
            estimated_cost: 0.0011,
            currency: 'USD',
            pricing_version: 'openai.pricing.v1',
            input_cost: 0.0009,
            output_cost: 0.0002,
            cached_input_cost: null,
            reasoning_cost: null,
          },
        },
        result: { assistant_message: 'ok' },
      } as any,
    });

    const row = await pool.query<{ estimated_cost: string | null; cost_currency: string | null; pricing_version: string | null }>(
      `SELECT estimated_cost::text, cost_currency, pricing_version FROM ai_executions WHERE task_identity = $1 LIMIT 1`,
      [taskIdentity],
    );

    expect(row.rows[0].estimated_cost).toBeNull();
    expect(row.rows[0].cost_currency).toBeNull();
    expect(row.rows[0].pricing_version).toBeNull();
  });

  it('persists completed evidence session with deterministic tool-call counters and duplicate-byte accounting', async () => {
    const patientId = randomUUID();
    await ensurePatient(pool, patientId);

    const taskIdentity = `task:${randomUUID()}`;
    const task = {
      task_id: randomUUID(),
      task_type: 'CONVERSATION_TIME_RANGE_ANALYSIS',
      task_version: 'conversation-time-range-analysis.v1',
      context_package_id: randomUUID(),
      context_package_version: 'conversation-time-range-context.v1',
      context_package_hash: `sha256:${randomUUID()}`,
      prompt_version: 'conversation-time-range-analysis.v1',
      output_schema_version: 'conversation-time-range-output.v1',
      model_policy_version: 'model-policy.v1',
      correlation_id: randomUUID(),
      created_at: new Date().toISOString(),
      patient_id: patientId,
    } as const;

    await repository.markAiExecutionRunning({
      task,
      taskIdentity,
      inputHash: `sha256:${randomUUID()}`,
      nowIso: new Date().toISOString(),
    });

    await repository.openEvidenceSession({
      taskIdentity,
      patientId,
      taskType: task.task_type,
      contextPackageId: task.context_package_id,
      contextPackageHash: task.context_package_hash,
      initialEvidenceHash: 'sha256:initial-evidence-hash',
      initialEvidenceBytes: 512,
      startedAt: new Date().toISOString(),
    });

    await repository.recordEvidenceToolCallRequested({
      taskIdentity,
      patientId,
      sequence: 1,
      callId: 'call-1',
      toolName: 'get_glucose_evidence',
      requestHash: 'sha256:req-1',
      arguments: {
        tool: 'get_glucose_evidence',
        time_range: { from: '2026-10-08T00:00:00.000Z', to: '2026-10-08T12:00:00.000Z' },
        detail_level: 'DETAIL',
      },
      timeRange: { from: '2026-10-08T00:00:00.000Z', to: '2026-10-08T12:00:00.000Z' },
      detailLevel: 'DETAIL',
      requestedAt: new Date().toISOString(),
    });
    await repository.recordEvidenceToolCallSucceeded({
      taskIdentity,
      patientId,
      sequence: 1,
      resultStatus: 'KNOWN',
      resultHash: 'sha256:result-a',
      resultBytes: 120,
      compilerVersion: 'evidence-tools.v1',
      evidenceVersion: 'evidence-tool-response.v1',
      provenanceRefs: ['event/a'],
      completedAt: new Date().toISOString(),
    });

    await repository.recordEvidenceToolCallRequested({
      taskIdentity,
      patientId,
      sequence: 2,
      callId: 'call-2',
      toolName: 'get_insulin_evidence',
      requestHash: 'sha256:req-2',
      arguments: {
        tool: 'get_insulin_evidence',
        time_range: { from: '2026-10-08T00:00:00.000Z', to: '2026-10-08T12:00:00.000Z' },
        detail_level: 'SUMMARY',
      },
      timeRange: { from: '2026-10-08T00:00:00.000Z', to: '2026-10-08T12:00:00.000Z' },
      detailLevel: 'SUMMARY',
      requestedAt: new Date().toISOString(),
    });
    await repository.recordEvidenceToolCallSucceeded({
      taskIdentity,
      patientId,
      sequence: 2,
      resultStatus: 'KNOWN',
      resultHash: 'sha256:result-a',
      resultBytes: 120,
      compilerVersion: 'evidence-tools.v1',
      evidenceVersion: 'evidence-tool-response.v1',
      provenanceRefs: ['event/a'],
      completedAt: new Date().toISOString(),
    });

    await repository.recordEvidenceToolCallRequested({
      taskIdentity,
      patientId,
      sequence: 3,
      callId: 'call-3',
      toolName: 'get_basal_evidence',
      requestHash: 'sha256:req-3',
      arguments: {
        tool: 'get_basal_evidence',
        time_range: { from: '2026-10-08T00:00:00.000Z', to: '2026-10-08T12:00:00.000Z' },
        detail_level: 'SUMMARY',
      },
      timeRange: { from: '2026-10-08T00:00:00.000Z', to: '2026-10-08T12:00:00.000Z' },
      detailLevel: 'SUMMARY',
      requestedAt: new Date().toISOString(),
    });
    await repository.recordEvidenceToolCallSucceeded({
      taskIdentity,
      patientId,
      sequence: 3,
      resultStatus: 'KNOWN',
      resultHash: 'sha256:result-b',
      resultBytes: 80,
      compilerVersion: 'evidence-tools.v1',
      evidenceVersion: 'evidence-tool-response.v1',
      provenanceRefs: ['event/b'],
      completedAt: new Date().toISOString(),
    });

    await repository.completeEvidenceSession({
      taskIdentity,
      patientId,
      completedAt: new Date().toISOString(),
    });

    const sessionRow = await pool.query<{
      status: string;
      tool_call_count: string;
      successful_tool_call_count: string;
      failed_tool_call_count: string;
      total_tool_result_bytes: string;
      unique_tool_result_bytes: string;
      duplicated_tool_result_bytes: string;
      initial_evidence_hash: string;
      initial_evidence_bytes: string;
    }>(
      `
        SELECT
          s.status,
          s.tool_call_count::text,
          s.successful_tool_call_count::text,
          s.failed_tool_call_count::text,
          s.total_tool_result_bytes::text,
          s.unique_tool_result_bytes::text,
          s.duplicated_tool_result_bytes::text,
          s.initial_evidence_hash,
          s.initial_evidence_bytes::text
        FROM evidence_sessions s
        JOIN ai_executions e ON e.id = s.ai_execution_id
        WHERE e.task_identity = $1
        LIMIT 1
      `,
      [taskIdentity],
    );

    expect(sessionRow.rows[0]).toBeTruthy();
    expect(sessionRow.rows[0].status).toBe('COMPLETED');
    expect(Number(sessionRow.rows[0].tool_call_count)).toBe(3);
    expect(Number(sessionRow.rows[0].successful_tool_call_count)).toBe(3);
    expect(Number(sessionRow.rows[0].failed_tool_call_count)).toBe(0);
    expect(Number(sessionRow.rows[0].total_tool_result_bytes)).toBe(320);
    expect(Number(sessionRow.rows[0].unique_tool_result_bytes)).toBe(200);
    expect(Number(sessionRow.rows[0].duplicated_tool_result_bytes)).toBe(120);
    expect(sessionRow.rows[0].initial_evidence_hash).toBe('sha256:initial-evidence-hash');
    expect(Number(sessionRow.rows[0].initial_evidence_bytes)).toBe(512);

    const callRows = await pool.query<{
      sequence: string;
      call_id: string | null;
      tool_name: string;
      request_hash: string;
      result_hash: string | null;
      status: string;
      arguments: Record<string, unknown>;
      detail_level: string | null;
      patient_id: string;
    }>(
      `
        SELECT sequence::text, call_id, tool_name, request_hash, result_hash, status, arguments, detail_level, patient_id
        FROM evidence_session_tool_calls c
        WHERE c.session_id = (
          SELECT s.id
          FROM evidence_sessions s
          JOIN ai_executions e ON e.id = s.ai_execution_id
          WHERE e.task_identity = $1
          LIMIT 1
        )
        ORDER BY sequence ASC
      `,
      [taskIdentity],
    );

    expect(callRows.rows.map((row) => row.call_id)).toEqual(['call-1', 'call-2', 'call-3']);
    expect(callRows.rows.map((row) => row.tool_name)).toEqual(['get_glucose_evidence', 'get_insulin_evidence', 'get_basal_evidence']);
    expect(callRows.rows.every((row) => row.patient_id === patientId)).toBe(true);
    expect(callRows.rows.every((row) => row.status === 'SUCCEEDED')).toBe(true);
    expect(callRows.rows[0].request_hash).toBe('sha256:req-1');
    expect(callRows.rows[0].result_hash).toBe('sha256:result-a');
    expect(callRows.rows[0].detail_level).toBe('DETAIL');
    expect(JSON.stringify(callRows.rows[0].arguments)).not.toContain('raw_payload');
  });

  it('enforces evidence session patient isolation and persists FAILED session/tool-call status', async () => {
    const patientA = randomUUID();
    const patientB = randomUUID();
    await ensurePatient(pool, patientA);
    await ensurePatient(pool, patientB);

    const taskIdentity = `task:${randomUUID()}`;
    const task = {
      task_id: randomUUID(),
      task_type: 'CONVERSATION_TIME_RANGE_ANALYSIS',
      task_version: 'conversation-time-range-analysis.v1',
      context_package_id: randomUUID(),
      context_package_version: 'conversation-time-range-context.v1',
      context_package_hash: `sha256:${randomUUID()}`,
      prompt_version: 'conversation-time-range-analysis.v1',
      output_schema_version: 'conversation-time-range-output.v1',
      model_policy_version: 'model-policy.v1',
      correlation_id: randomUUID(),
      created_at: new Date().toISOString(),
      patient_id: patientA,
    } as const;

    await repository.markAiExecutionRunning({
      task,
      taskIdentity,
      inputHash: `sha256:${randomUUID()}`,
      nowIso: new Date().toISOString(),
    });

    await repository.openEvidenceSession({
      taskIdentity,
      patientId: patientA,
      taskType: task.task_type,
      contextPackageId: task.context_package_id,
      contextPackageHash: task.context_package_hash,
      initialEvidenceHash: 'sha256:initial',
      initialEvidenceBytes: 256,
      startedAt: new Date().toISOString(),
    });

    await repository.recordEvidenceToolCallRequested({
      taskIdentity,
      patientId: patientB,
      sequence: 1,
      callId: 'cross-patient-call',
      toolName: 'get_glucose_evidence',
      requestHash: 'sha256:cross-patient',
      arguments: { tool: 'get_glucose_evidence' },
      timeRange: null,
      detailLevel: 'SUMMARY',
      requestedAt: new Date().toISOString(),
    });

    const wrongPatientCount = await pool.query<{ count: string }>(
      `
        SELECT count(*)::text AS count
        FROM evidence_session_tool_calls c
        WHERE c.session_id = (
          SELECT s.id
          FROM evidence_sessions s
          JOIN ai_executions e ON e.id = s.ai_execution_id
          WHERE e.task_identity = $1
            AND s.patient_id = $2
          LIMIT 1
        )
      `,
      [taskIdentity, patientA],
    );
    expect(Number(wrongPatientCount.rows[0].count)).toBe(0);

    await repository.recordEvidenceToolCallRequested({
      taskIdentity,
      patientId: patientA,
      sequence: 1,
      callId: 'call-fail-1',
      toolName: 'get_glucose_evidence',
      requestHash: 'sha256:req-fail-1',
      arguments: { tool: 'get_glucose_evidence' },
      timeRange: { from: '2026-10-08T00:00:00.000Z', to: '2026-10-08T12:00:00.000Z' },
      detailLevel: 'SUMMARY',
      requestedAt: new Date().toISOString(),
    });

    await repository.recordEvidenceToolCallFailed({
      taskIdentity,
      patientId: patientA,
      sequence: 1,
      failure: { reason: 'TOOL_RESPONSE_REJECTED', status: 'FAILED' },
      completedAt: new Date().toISOString(),
    });

    await repository.failEvidenceSession({
      taskIdentity,
      patientId: patientA,
      failedAt: new Date().toISOString(),
      failure: { error: 'AI provider failed' },
    });

    const failedSession = await pool.query<{
      status: string;
      failed_tool_call_count: string;
      failure: Record<string, unknown> | null;
    }>(
      `
        SELECT s.status, s.failed_tool_call_count::text, s.failure
        FROM evidence_sessions s
        JOIN ai_executions e ON e.id = s.ai_execution_id
        WHERE e.task_identity = $1
          AND s.patient_id = $2
        LIMIT 1
      `,
      [taskIdentity, patientA],
    );
    expect(failedSession.rows[0].status).toBe('FAILED');
    expect(Number(failedSession.rows[0].failed_tool_call_count)).toBe(1);
    expect(String((failedSession.rows[0].failure ?? {})['error'] ?? '')).toContain('AI provider failed');

    const failedCall = await pool.query<{ status: string; failure: Record<string, unknown> | null }>(
      `
        SELECT status, failure
        FROM evidence_session_tool_calls c
        WHERE c.session_id = (
          SELECT s.id
          FROM evidence_sessions s
          JOIN ai_executions e ON e.id = s.ai_execution_id
          WHERE e.task_identity = $1
            AND s.patient_id = $2
          LIMIT 1
        )
          AND c.sequence = 1
        LIMIT 1
      `,
      [taskIdentity, patientA],
    );
    expect(failedCall.rows[0].status).toBe('FAILED');
    expect(String((failedCall.rows[0].failure ?? {})['reason'] ?? '')).toBe('TOOL_RESPONSE_REJECTED');
  });

  it('picks the state by the reading time, so a reading imported after the question still reaches its answer', async () => {
    const patientId = randomUUID();
    await ensurePatient(pool, patientId);
    const insertState = (version: string, asOf: string, value: number, updatedAt: string) => pool.query(
      `INSERT INTO current_states (patient_id, state_version, as_of, snapshot, updated_at) VALUES ($1::uuid, $2, $3::timestamptz, $4::jsonb, $5::timestamptz)`,
      [patientId, version, asOf, JSON.stringify({ as_of: asOf, glucose: { value } }), updatedAt],
    );
    // 56 imported on time; 73 (taken 10:04) imported by the refresh before the answer, after the 10:04:30 question;
    // 80 taken after the question.
    await insertState('nightscout:a', '2026-10-21T09:59:00.000Z', 56, '2026-10-21T09:59:10.000Z');
    await insertState('nightscout:b', '2026-10-21T10:04:00.000Z', 73, '2026-10-21T10:04:40.000Z');
    await insertState('nightscout:c', '2026-10-21T10:09:00.000Z', 80, '2026-10-21T10:09:05.000Z');

    const state = await repository.getCurrentStateAtOrBefore(patientId, '2026-10-21T10:04:30.000Z');
    expect((state as { glucose: { value: number } }).glucose.value).toBe(73);
    expect(await repository.getCurrentStateAtOrBefore(patientId, '2026-10-21T09:58:00.000Z')).toBeNull();

    // A reading backfilled late (taken 09:50, written 10:10) is never the current one.
    await insertState('nightscout:late', '2026-10-21T09:50:00.000Z', 61, '2026-10-21T10:10:00.000Z');
    expect(((await repository.getCurrentState(patientId)) as { glucose: { value: number } }).glucose.value).toBe(80);
    expect(((await repository.getCurrentStateAtOrBefore(patientId, '2026-10-21T10:04:30.000Z')) as { glucose: { value: number } }).glucose.value).toBe(73);
  });
});

describePostgres('PostgresGlucoMindRepository job finalize lease semantics (postgres)', { timeout: 120_000 }, () => {
  let pool: Pool;
  let repository: PostgresGlucoMindRepository;

  beforeAll(async () => {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      throw new Error('DATABASE_URL is required for PostgresGlucoMindRepository postgres tests');
    }

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

  async function insertAndClaimJob(args: { leaseSeconds: number; nowIso?: string }): Promise<{ jobId: string; leaseToken: string }> {
    const nowIso = args.nowIso ?? '2026-10-05T10:00:00.000Z';
    const inserted = await repository.insertJob({
      jobType: 'analysis.follow_up',
      payloadVersion: 1,
      payload: { source: 'finalize-semantics' },
      dedupeKey: `finalize-semantics:${randomUUID()}`,
      correlationId: randomUUID(),
      causationId: null,
      patientId: null,
      availableAt: nowIso,
      maxAttempts: 5,
    });

    const claim = await repository.claimNextJob('worker-a', nowIso, args.leaseSeconds);
    expect(claim?.id).toBe(inserted.id);
    expect(claim?.lease_token).toBeTruthy();

    return { jobId: inserted.id, leaseToken: String(claim?.lease_token) };
  }

  it('finalize retry: valid lease -> success', async () => {
    const { jobId, leaseToken } = await insertAndClaimJob({ leaseSeconds: 60 });

    const result = await repository.finalizeJobRetry(
      jobId,
      leaseToken,
      '2026-10-05T10:00:10.000Z',
      '2026-10-05T10:01:10.000Z',
      { reason: 'retryable' },
    );

    expect(result.ownershipLost).toBe(false);
    expect(result.rowCount).toBeGreaterThan(0);

    const check = await pool.query<{ status: string; available_at: string; lease_token: string | null }>(
      `SELECT status, available_at::text AS available_at, lease_token::text AS lease_token FROM jobs WHERE id = $1::uuid`,
      [jobId],
    );
    expect(check.rows[0].status).toBe('queued');
    expect(new Date(check.rows[0].available_at).toISOString()).toBe('2026-10-05T10:01:10.000Z');
    expect(check.rows[0].lease_token).toBeNull();
  });

  it('finalize retry: expired lease -> ownership lost', async () => {
    const { jobId, leaseToken } = await insertAndClaimJob({ leaseSeconds: 1 });

    const result = await repository.finalizeJobRetry(
      jobId,
      leaseToken,
      '2026-10-05T10:00:03.000Z',
      '2026-10-05T10:01:03.000Z',
      { reason: 'retryable' },
    );

    expect(result.rowCount).toBe(0);
    expect(result.ownershipLost).toBe(true);
  });

  it('claim: an expired lease on the last attempt fails the job instead of claiming it again', async () => {
    const inserted = await repository.insertJob({
      jobType: 'analysis.follow_up',
      payloadVersion: 1,
      payload: { source: 'lease-exhausted' },
      dedupeKey: `lease-exhausted:${randomUUID()}`,
      correlationId: randomUUID(),
      causationId: null,
      patientId: null,
      availableAt: '2026-10-05T10:00:00.000Z',
      maxAttempts: 1,
    });
    const first = await repository.claimNextJob('worker-a', '2026-10-05T10:00:00.000Z', 1);
    expect(first?.id).toBe(inserted.id);

    const second = await repository.claimNextJob('worker-b', '2026-10-05T10:00:03.000Z', 60);
    expect(second?.id).not.toBe(inserted.id);

    const check = await pool.query<{ status: string; attempts: number; last_error: Record<string, unknown> }>(
      `SELECT status, attempts, last_error FROM jobs WHERE id = $1::uuid`,
      [inserted.id],
    );
    expect(check.rows[0]).toMatchObject({ status: 'failed', attempts: 1, last_error: { error: 'LEASE_EXPIRED_NO_ATTEMPTS_LEFT' } });
  });

  it('finalize retry: wrong lease token -> ownership lost', async () => {
    const { jobId } = await insertAndClaimJob({ leaseSeconds: 60 });

    const result = await repository.finalizeJobRetry(
      jobId,
      randomUUID(),
      '2026-10-05T10:00:10.000Z',
      '2026-10-05T10:01:10.000Z',
      { reason: 'retryable' },
    );

    expect(result.rowCount).toBe(0);
    expect(result.ownershipLost).toBe(true);
  });

  it('finalize retry: reclaimed job -> old worker ownership lost', async () => {
    const inserted = await repository.insertJob({
      jobType: 'analysis.follow_up',
      payloadVersion: 1,
      payload: { source: 'finalize-semantics' },
      dedupeKey: `finalize-semantics:${randomUUID()}`,
      correlationId: randomUUID(),
      causationId: null,
      patientId: null,
      availableAt: '2026-10-05T10:00:00.000Z',
      maxAttempts: 5,
    });

    const firstClaim = await repository.claimNextJob('worker-a', '2026-10-05T10:00:00.000Z', 1);
    expect(firstClaim?.id).toBe(inserted.id);

    const secondClaim = await repository.claimNextJob('worker-b', '2026-10-05T10:00:03.000Z', 60);
    expect(secondClaim?.id).toBe(inserted.id);

    const staleFinalize = await repository.finalizeJobRetry(
      inserted.id,
      String(firstClaim?.lease_token),
      '2026-10-05T10:00:04.000Z',
      '2026-10-05T10:01:04.000Z',
      { reason: 'retryable' },
    );

    expect(staleFinalize.rowCount).toBe(0);
    expect(staleFinalize.ownershipLost).toBe(true);

    const check = await pool.query<{ status: string; lease_token: string | null }>(
      `SELECT status, lease_token::text AS lease_token FROM jobs WHERE id = $1::uuid`,
      [inserted.id],
    );
    expect(check.rows[0].status).toBe('running');
    expect(check.rows[0].lease_token).toBe(String(secondClaim?.lease_token));
  });

  it('finalize success: valid lease -> success', async () => {
    const { jobId, leaseToken } = await insertAndClaimJob({ leaseSeconds: 60 });

    const result = await repository.finalizeJobSuccess(jobId, leaseToken, '2026-10-05T10:00:10.000Z');
    expect(result.ownershipLost).toBe(false);
    expect(result.rowCount).toBeGreaterThan(0);

    const check = await pool.query<{ status: string }>(`SELECT status FROM jobs WHERE id = $1::uuid`, [jobId]);
    expect(check.rows[0].status).toBe('succeeded');
  });

  it('finalize success: stale worker -> ownership lost', async () => {
    const inserted = await repository.insertJob({
      jobType: 'analysis.follow_up',
      payloadVersion: 1,
      payload: { source: 'finalize-semantics' },
      dedupeKey: `finalize-semantics:${randomUUID()}`,
      correlationId: randomUUID(),
      causationId: null,
      patientId: null,
      availableAt: '2026-10-05T10:00:00.000Z',
      maxAttempts: 5,
    });

    const firstClaim = await repository.claimNextJob('worker-a', '2026-10-05T10:00:00.000Z', 1);
    const secondClaim = await repository.claimNextJob('worker-b', '2026-10-05T10:00:03.000Z', 60);
    expect(firstClaim?.id).toBe(inserted.id);
    expect(secondClaim?.id).toBe(inserted.id);

    const staleFinalize = await repository.finalizeJobSuccess(inserted.id, String(firstClaim?.lease_token), '2026-10-05T10:00:04.000Z');
    expect(staleFinalize.rowCount).toBe(0);
    expect(staleFinalize.ownershipLost).toBe(true);
  });

  it('finalize failure: valid lease -> success', async () => {
    const { jobId, leaseToken } = await insertAndClaimJob({ leaseSeconds: 60 });

    const result = await repository.finalizeJobFailure(jobId, leaseToken, '2026-10-05T10:00:10.000Z', { reason: 'fatal' });
    expect(result.ownershipLost).toBe(false);
    expect(result.rowCount).toBeGreaterThan(0);

    const check = await pool.query<{ status: string }>(`SELECT status FROM jobs WHERE id = $1::uuid`, [jobId]);
    expect(check.rows[0].status).toBe('failed');
  });

  it('finalize failure: stale worker -> ownership lost', async () => {
    const inserted = await repository.insertJob({
      jobType: 'analysis.follow_up',
      payloadVersion: 1,
      payload: { source: 'finalize-semantics' },
      dedupeKey: `finalize-semantics:${randomUUID()}`,
      correlationId: randomUUID(),
      causationId: null,
      patientId: null,
      availableAt: '2026-10-05T10:00:00.000Z',
      maxAttempts: 5,
    });

    const firstClaim = await repository.claimNextJob('worker-a', '2026-10-05T10:00:00.000Z', 1);
    const secondClaim = await repository.claimNextJob('worker-b', '2026-10-05T10:00:03.000Z', 60);
    expect(firstClaim?.id).toBe(inserted.id);
    expect(secondClaim?.id).toBe(inserted.id);

    const staleFinalize = await repository.finalizeJobFailure(
      inserted.id,
      String(firstClaim?.lease_token),
      '2026-10-05T10:00:04.000Z',
      { reason: 'fatal' },
    );

    expect(staleFinalize.rowCount).toBe(0);
    expect(staleFinalize.ownershipLost).toBe(true);
  });

  /** A backlog of one job type; any non-interactive type (fixture.background_batch) is claimed like an import batch. */
  async function enqueueJobs(args: { jobType: string; count: number; availableAt: string; patientId?: string | null; dedupePrefix: string }): Promise<void> {
    for (let index = 0; index < args.count; index += 1) {
      await repository.insertJob({
        jobType: args.jobType,
        payloadVersion: 1,
        payload: { fixture: args.dedupePrefix, index },
        dedupeKey: `${args.dedupePrefix}:${index}`,
        correlationId: randomUUID(),
        causationId: null,
        patientId: args.patientId ?? null,
        availableAt: args.availableAt,
        maxAttempts: 5,
      });
    }
  }

  it('prefers interactive investigation.re_evaluate over large batch backlog while bounded fairness remains active', async () => {
    const baseIso = '2026-10-05T16:50:17.490Z';
    const interactiveAvailableAt = '2026-10-05T16:58:00.000Z';

    await enqueueJobs({
      jobType: 'fixture.background_batch',
      count: 2000,
      availableAt: baseIso,
      dedupePrefix: `interactive:meal:${randomUUID()}`,
    });
    await repository.insertJob({
      jobType: 'investigation.re_evaluate',
      payloadVersion: 1,
      payload: { conversation_id: randomUUID(), patient_id: randomUUID() },
      dedupeKey: `interactive:investigation:${randomUUID()}`,
      correlationId: randomUUID(),
      causationId: null,
      patientId: null,
      availableAt: interactiveAvailableAt,
      maxAttempts: 5,
    });

    const claimed = await repository.claimNextJob('worker-interactive-fairness', '2026-10-05T17:10:00.000Z', 300);

    expect(claimed).toBeTruthy();
    expect(claimed?.job_type).toBe('investigation.re_evaluate');
  });

  it('claims a caregiver conversation job ahead of an import backlog', async () => {
    const baseIso = '2026-10-05T16:50:17.490Z';
    await enqueueJobs({
      jobType: 'triggering.hypo_detection',
      count: 200,
      availableAt: baseIso,
      dedupePrefix: `interactive:hypo-backlog:${randomUUID()}`,
    });
    await repository.insertJob({
      jobType: 'conversation.direct_response',
      payloadVersion: 1,
      payload: { conversation_id: randomUUID(), patient_id: randomUUID() },
      dedupeKey: `interactive:conversation:${randomUUID()}`,
      correlationId: randomUUID(),
      causationId: null,
      patientId: null,
      availableAt: '2026-10-05T16:59:00.000Z',
      maxAttempts: 5,
    });

    const claimed = await repository.claimNextJob('worker-interactive-conversation', '2026-10-05T17:10:00.000Z', 300);

    expect(claimed?.job_type).toBe('conversation.direct_response');
  });

  it('keeps analysis.follow_up interactive jobs ahead of background backlog and prevents starvation within the fairness window', async () => {
    const baseIso = '2026-10-05T16:50:17.490Z';
    const interactiveAvailableAt = '2026-10-05T16:59:00.000Z';

    await enqueueJobs({
      jobType: 'triggering.hypo_detection',
      count: 1200,
      availableAt: baseIso,
      dedupePrefix: `interactive:hypo:${randomUUID()}`,
    });
    await repository.insertJob({
      jobType: 'analysis.follow_up',
      payloadVersion: 1,
      payload: { conversation_id: randomUUID(), patient_id: randomUUID() },
      dedupeKey: `interactive:analysis:${randomUUID()}`,
      correlationId: randomUUID(),
      causationId: null,
      patientId: null,
      availableAt: interactiveAvailableAt,
      maxAttempts: 5,
    });

    const claimed = await repository.claimNextJob('worker-interactive-analysis', '2026-10-05T17:10:00.000Z', 300);

    expect(claimed).toBeTruthy();
    expect(claimed?.job_type).toBe('analysis.follow_up');
  });

  it('prioritizes stale nightscout sync when starvation threshold is met', async () => {
    const baseIso = '2026-10-05T16:50:17.490Z';
    const downstreamAvailableAt = baseIso;
    const nightscoutAvailableAt = '2026-10-05T16:51:07.425Z';

    await enqueueJobs({
      jobType: 'triggering.hypo_detection',
      count: 1500,
      availableAt: downstreamAvailableAt,
      dedupePrefix: `starvation:hypo:${randomUUID()}`,
    });
    await enqueueJobs({
      jobType: 'fixture.background_batch',
      count: 1500,
      availableAt: downstreamAvailableAt,
      dedupePrefix: `starvation:meal:${randomUUID()}`,
    });
    await repository.insertJob({
      jobType: 'nightscout.sync',
      payloadVersion: 1,
      payload: { source_id: randomUUID() },
      dedupeKey: `starvation:nightscout:${randomUUID()}`,
      correlationId: randomUUID(),
      causationId: null,
      patientId: null,
      availableAt: nightscoutAvailableAt,
      maxAttempts: 5,
    });

    const claimNowIso = '2026-10-05T17:10:00.000Z';
    const claimed = await repository.claimNextJob('worker-fairness-regression', claimNowIso, 300);

    expect(claimed).toBeTruthy();
    expect(claimed?.job_type).toBe('nightscout.sync');
  });

  it('keeps downstream jobs progressing and avoids permanent starvation under fairness scheduling', async () => {
    const baseIso = '2026-10-05T16:50:17.490Z';
    const nightscoutAvailableAt = '2026-10-05T16:51:07.425Z';

    await enqueueJobs({
      jobType: 'triggering.hypo_detection',
      count: 1200,
      availableAt: baseIso,
      dedupePrefix: `fairness:hypo:${randomUUID()}`,
    });
    await enqueueJobs({
      jobType: 'nightscout.sync',
      count: 5,
      availableAt: nightscoutAvailableAt,
      dedupePrefix: `fairness:nightscout:${randomUUID()}`,
    });

    let nowMs = Date.parse('2026-10-05T17:10:00.000Z');
    let claimedNightscout = 0;
    let claimedDownstream = 0;

    for (let index = 0; index < 30; index += 1) {
      const nowIso = new Date(nowMs).toISOString();
      const claimed = await repository.claimNextJob('worker-fairness-safety', nowIso, 300);
      expect(claimed).toBeTruthy();

      if (claimed?.job_type === 'nightscout.sync') {
        claimedNightscout += 1;
      } else {
        claimedDownstream += 1;
      }

      await repository.finalizeJobSuccess(String(claimed?.id), String(claimed?.lease_token), nowIso);
      nowMs += 2000;
    }

    expect(claimedNightscout).toBeGreaterThan(0);
    expect(claimedDownstream).toBeGreaterThan(0);
    expect(claimedDownstream).toBeGreaterThan(claimedNightscout);
  });
  it('restricted claim: only allowed job types are claimed, other jobs stay queued and unchanged', async () => {
    const insert = (jobType: string, availableAt: string) => repository.insertJob({
      jobType,
      payloadVersion: 1,
      payload: { source: 'restricted-claim' },
      dedupeKey: `restricted-claim:${randomUUID()}`,
      correlationId: randomUUID(),
      causationId: null,
      patientId: null,
      availableAt,
      maxAttempts: 5,
    });
    // Older disallowed jobs come first in queue order and must still be skipped.
    const hypo = await insert('triggering.hypo_detection', '2026-10-05T09:00:00.000Z');
    const legacy = await insert('meal.chat_reply', '2026-10-05T09:01:00.000Z');
    const sync = await insert('nightscout.sync', '2026-10-05T09:30:00.000Z');
    const intake = await insert('meal.wbt_suggestion', '2026-10-05T09:31:00.000Z');
    const snapshot = async (id: string) => (await pool.query(`SELECT status, attempts, locked_by, lease_token, updated_at FROM jobs WHERE id = $1`, [id])).rows[0];
    const before = { hypo: await snapshot(hypo.id), legacy: await snapshot(legacy.id) };
    const allowed = ['nightscout.sync', 'meal.wbt_suggestion'];

    const first = await repository.claimNextJob('worker-restricted', '2026-10-05T10:00:00.000Z', 300, allowed);
    const second = await repository.claimNextJob('worker-restricted', '2026-10-05T10:00:00.000Z', 300, allowed);
    const third = await repository.claimNextJob('worker-restricted', '2026-10-05T10:00:00.000Z', 300, allowed);

    expect([first?.id, second?.id].sort()).toEqual([sync.id, intake.id].sort());
    expect(third).toBeNull();
    expect(await snapshot(hypo.id)).toEqual(before.hypo);
    expect(await snapshot(legacy.id)).toEqual(before.legacy);
    expect(before.hypo.status).toBe('queued');

    // Without a restriction the default behaviour still claims every type.
    const unrestricted = await repository.claimNextJob('worker-all', '2026-10-05T10:00:00.000Z', 300);
    expect([hypo.id, legacy.id]).toContain(unrestricted?.id);
    await expect(repository.claimNextJob('worker-restricted', '2026-10-05T10:00:00.000Z', 300, [])).rejects.toThrow('must not be empty');
  });
});
