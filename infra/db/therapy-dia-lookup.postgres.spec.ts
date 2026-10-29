import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { PostgresGlucoMindRepository } from './postgres-glucomind.repository';
import { configurePostgresIntegrationEnvironment, truncatePublicTablesForIntegrationTests } from './postgres-test-isolation';

const runPostgresIntegration = process.env.RUN_POSTGRES_INTEGRATION === '1';
const describePostgres = runPostgresIntegration ? describe.sequential : describe.skip;

configurePostgresIntegrationEnvironment(process.env);

describePostgres('therapy profile and DIA lookups (PostgreSQL)', () => {
  let pool: Pool;
  let repository: PostgresGlucoMindRepository;

  beforeAll(async () => {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) throw new Error('DATABASE_URL is required for therapy DIA lookup postgres tests');
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

  async function patientWithTherapies(therapies: Array<{ validFrom: string; validTo?: string | null; profile: Record<string, unknown> }>) {
    const patientId = randomUUID();
    await pool.query(`INSERT INTO patients (id, display_name) VALUES ($1::uuid, 'p')`, [patientId]);
    for (const [index, therapy] of therapies.entries()) {
      await pool.query(
        `INSERT INTO therapies (patient_id, snapshot, valid_from, valid_to, therapy_version, active_profile_id)
         VALUES ($1::uuid, $2::jsonb, $3::timestamptz, $4::timestamptz, $5, 'Default')`,
        [patientId, JSON.stringify({ profile: therapy.profile }), therapy.validFrom, therapy.validTo ?? null, `v${index + 1}`],
      );
    }
    return patientId;
  }

  it('reads the DIA of the profile valid at the requested instant, not a later one', async () => {
    const patientId = await patientWithTherapies([
      { validFrom: '2026-10-01T00:00:00.000Z', validTo: '2026-10-14T00:00:00.000Z', profile: { dia: 6 } },
      { validFrom: '2026-10-14T00:00:00.000Z', profile: { dia: 5 } },
      { validFrom: '2026-10-16T00:00:00.000Z', profile: { dia: 9 } },
    ]);
    expect(await repository.getTherapyDiaAt(patientId, '2026-10-15T08:00:00.000Z')).toMatchObject({ status: 'KNOWN', dia_hours: 5, valid_from: '2026-10-14T00:00:00.000Z' });
    expect(await repository.getTherapyDiaAt(patientId, '2026-10-10T08:00:00.000Z')).toMatchObject({ status: 'KNOWN', dia_hours: 6 });
  });

  it('returns the profile valid at the instant as compact [HH:MM, value] schedules, without defaults', async () => {
    const patientId = await patientWithTherapies([{
      validFrom: '2026-10-01T00:00:00.000Z',
      profile: {
        dia: 5, units: 'mg/dl', timezone: 'Europe/Warsaw',
        carbratio: [{ time: '00:00', timeAsSeconds: 0, value: 12 }, { time: '07:00', timeAsSeconds: 25200, value: 9 }],
        sens: [{ time: '00:00', timeAsSeconds: 0, value: 110 }],
        basal: [{ time: '00:00', timeAsSeconds: 0, value: 0.35 }],
        target_low: [{ time: '00:00', timeAsSeconds: 0, value: 100 }],
      },
    }]);
    expect(await repository.getTherapyProfileAt(patientId, '2026-10-15T08:00:00.000Z')).toMatchObject({
      status: 'KNOWN', units: 'mg/dl', timezone: 'Europe/Warsaw', dia_hours: 5,
      carb_ratio_g_per_u: [['00:00', 12], ['07:00', 9]],
      sensitivity_per_u: [['00:00', 110]],
      basal_u_per_h: [['00:00', 0.35]],
      target_low: [['00:00', 100]],
      target_high: null,
    });
    expect(await repository.getTherapyProfileAt(await patientWithTherapies([]), '2026-10-15T08:00:00.000Z')).toMatchObject({ status: 'MISSING', carb_ratio_g_per_u: null });
  });

  it('reports MISSING, never a default, when there is no profile or it has no numeric DIA', async () => {
    const withoutProfile = await patientWithTherapies([]);
    expect(await repository.getTherapyDiaAt(withoutProfile, '2026-10-15T08:00:00.000Z')).toEqual({ status: 'MISSING', dia_hours: null, therapy_id: null, valid_from: null });
    const withoutDia = await patientWithTherapies([{ validFrom: '2026-10-01T00:00:00.000Z', profile: { basal: [] } }]);
    expect(await repository.getTherapyDiaAt(withoutDia, '2026-10-15T08:00:00.000Z')).toMatchObject({ status: 'MISSING', dia_hours: null });
    const notYetValid = await patientWithTherapies([{ validFrom: '2026-10-20T00:00:00.000Z', profile: { dia: 5 } }]);
    expect(await repository.getTherapyDiaAt(notYetValid, '2026-10-15T08:00:00.000Z')).toMatchObject({ status: 'MISSING', therapy_id: null });
  });
});
