import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { PostgresLowRiskAlertRepository } from './postgres-low-risk-alert.repository';

const url = process.env.TEST_DATABASE_URL;
const enabled = process.env.RUN_POSTGRES_INTEGRATION === '1' && Boolean(url);

describe.skipIf(!enabled)('PostgresLowRiskAlertRepository', () => {
  let pool: Pool;
  const patient = randomUUID();
  const listed = randomUUID();
  const other = randomUUID();

  beforeAll(async () => {
    pool = new Pool({ connectionString: url });
    await pool.query(`INSERT INTO patients (id, display_name) VALUES ($1, 'test')`, [patient]);
    for (const user of [listed, other]) {
      await pool.query(`INSERT INTO users (id, display_name) VALUES ($1, 'test')`, [user]);
      await pool.query(`INSERT INTO caregiver_relationships (user_id, patient_id, is_owner, relationship_type) VALUES ($1, $2, true, 'shared')`, [user, patient]);
    }
    await pool.query(`INSERT INTO patient_devices (patient_id, platform, device_id, push_token, user_id, active) VALUES ($1, 'ios', 'a', 'token-listed', $2, true), ($1, 'ios', 'a2', 'token-listed', $2, true), ($1, 'ios', 'b', 'token-other', $3, true), ($1, 'ios', 'c', 'token-off', $2, false)`, [patient, listed, other]);
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM patients WHERE id = $1`, [patient]);
    await pool.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [[listed, other]]);
    await pool.end();
  });

  it('scores every patient with the experiment on; the model decides and pushes only where someone is listed', async () => {
    const repo = new PostgresLowRiskAlertRepository(pool);
    expect(await repo.listPatients()).not.toContain(patient);
    await pool.query(`INSERT INTO prediction_experiment_optins (patient_id, enabled) VALUES ($1, true)`, [patient]);
    expect(await repo.listPatients()).toContain(patient);
    expect(await repo.decidesAlert(patient)).toBe(false);
    expect(await repo.listPushTokens(patient)).toEqual([]);
    await pool.query(`INSERT INTO prediction_low_alert_recipients (patient_id, user_id) VALUES ($1, $2)`, [patient, listed]);
    expect(await repo.decidesAlert(patient)).toBe(true);
    expect(await repo.listPushTokens(patient)).toEqual(['token-listed']);
  });

  it('logs a reading once and reads the last score and alarm', async () => {
    const repo = new PostgresLowRiskAlertRepository(pool);
    const entry = { patient_id: patient, reading_at: '2026-11-07T10:00:00.000Z', model_id: 'low-risk.v1', glucose_mgdl: 90, score: 0.7, threshold: 0.5, alarm: true };
    expect(await repo.logScore(entry)).toBe(true);
    expect(await repo.logScore(entry)).toBe(false);
    await repo.logScore({ ...entry, reading_at: '2026-11-07T10:05:00.000Z', alarm: false, score: 0.2 });
    expect(await repo.lastScoredAt(patient)).toBe('2026-11-07T10:05:00.000Z');
    expect(await repo.lastAlarmAt(patient)).toBe('2026-11-07T10:00:00.000Z');
    await repo.markPushed(entry, 1);
    const row = await pool.query(`SELECT pushed_to FROM prediction_low_scores WHERE patient_id = $1 AND alarm`, [patient]);
    expect(row.rows[0].pushed_to).toBe(1);
  });

  it('lists when a low alert reached a phone: pushed rescue alerts and the model\'s own pushes, from a date on', async () => {
    const repo = new PostgresLowRiskAlertRepository(pool);
    const alert = (firstFlag: string, notified: string | null) => pool.query(
      `INSERT INTO rescue_carb_alerts (patient_id, status, level, trigger_source, first_flag_at, notified_at, last_evaluated_at, evaluation)
       VALUES ($1, 'RESOLVED', 'PREDICTED_LOW', 'CGM_TREND', $2, $3, $2, '{}'::jsonb)`,
      [patient, firstFlag, notified],
    );
    await alert('2026-11-06T08:00:00.000Z', '2026-11-06T08:05:00.000Z');
    await alert('2026-11-07T09:00:00.000Z', '2026-11-07T09:02:00.000Z');
    await alert('2026-11-07T11:00:00.000Z', null);
    // From the test above: 10:00 was pushed by the model, 10:05 was only scored.
    expect(await repo.listPushedAlertTimes(patient, '2026-11-07T00:00:00.000Z')).toEqual(['2026-11-07T09:02:00.000Z', '2026-11-07T10:00:00.000Z']);
  });
});
