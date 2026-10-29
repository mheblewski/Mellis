import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ConfigModule } from '@nestjs/config';
import { validateApiEnvironment } from '@infra/config/environment';
import { DatabaseModule } from '@infra/db/database.module';
import { configurePostgresIntegrationEnvironment, truncatePublicTablesForIntegrationTests } from '@infra/db/postgres-test-isolation';
import { ApiService } from '../application/api.service';
import { BearerPrincipalGuard } from '../auth/bearer-principal.guard';
import { CognitoAuthService } from '../auth/cognito-auth.service';
import { MeController } from './me.controller';
import { PatientController } from './patient.controller';

const runPostgresIntegration = process.env.RUN_POSTGRES_INTEGRATION === '1';
const describePostgres = runPostgresIntegration ? describe.sequential : describe.skip;

async function seedPatientAndUser(pool: Pool, userId: string, patientId: string, displayName: string): Promise<void> {
  await pool.query(
    `INSERT INTO users (id, display_name) VALUES ($1::uuid, $2) ON CONFLICT (id) DO NOTHING`,
    [userId, `user-${userId.slice(0, 8)}`],
  );

  await pool.query(
    `INSERT INTO patients (id, display_name) VALUES ($1::uuid, $2) ON CONFLICT (id) DO NOTHING`,
    [patientId, displayName],
  );
}

async function seedRelationship(pool: Pool, userId: string, patientId: string): Promise<void> {
  await pool.query(
    `INSERT INTO caregiver_relationships (id, user_id, patient_id, relationship_type, permissions)
     VALUES ($1::uuid, $2::uuid, $3::uuid, 'CAREGIVER', '{}'::jsonb)
     ON CONFLICT (user_id, patient_id, relationship_type) DO NOTHING`,
    [randomUUID(), userId, patientId],
  );
}

describePostgres('API local auth-disabled mode (postgres)', { timeout: 120_000 }, () => {
  let app: INestApplication;
  let pool: Pool;
  const localUserId = '11111111-1111-4111-8111-111111111111';
  const envBackup: Record<string, string | undefined> = {};

  beforeAll(async () => {
    configurePostgresIntegrationEnvironment(process.env);

    envBackup.AUTH_MODE = process.env.AUTH_MODE;
    envBackup.ALLOW_AUTH_DISABLED_IN_LOCAL = process.env.ALLOW_AUTH_DISABLED_IN_LOCAL;
    envBackup.NODE_ENV = process.env.NODE_ENV;
    envBackup.AUTH_DISABLED_USER_ID = process.env.AUTH_DISABLED_USER_ID;

    process.env.AUTH_MODE = 'disabled';
    process.env.ALLOW_AUTH_DISABLED_IN_LOCAL = 'true';
    process.env.NODE_ENV = 'development';
    process.env.AUTH_DISABLED_USER_ID = localUserId;

    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      throw new Error('DATABASE_URL is required for Postgres integration tests');
    }

    pool = new Pool({ connectionString: databaseUrl });
    app = (await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true, validate: validateApiEnvironment }), DatabaseModule],
      controllers: [PatientController, MeController],
      providers: [ApiService, BearerPrincipalGuard, CognitoAuthService],
    }).compile()).createNestApplication();

    await app.init();
  });

  beforeEach(async () => {
    await truncatePublicTablesForIntegrationTests(pool);
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();

    process.env.AUTH_MODE = envBackup.AUTH_MODE;
    process.env.ALLOW_AUTH_DISABLED_IN_LOCAL = envBackup.ALLOW_AUTH_DISABLED_IN_LOCAL;
    process.env.NODE_ENV = envBackup.NODE_ENV;
    process.env.AUTH_DISABLED_USER_ID = envBackup.AUTH_DISABLED_USER_ID;
  });

  it('allows /v1/me/patients and patient-scoped reads without Cognito bearer while keeping patient isolation', async () => {
    const allowedPatientId = randomUUID();
    const deniedPatientId = randomUUID();

    await seedPatientAndUser(pool, localUserId, allowedPatientId, 'patient-allowed');
    await seedPatientAndUser(pool, localUserId, deniedPatientId, 'patient-denied');
    await seedRelationship(pool, localUserId, allowedPatientId);

    const mePatients = await request(app.getHttpServer())
      .get('/v1/me/patients')
      .expect(200);

    expect(mePatients.body.user_id).toBe(localUserId);
    expect(mePatients.body.patients.map((row: { patient_id: string }) => row.patient_id)).toContain(allowedPatientId);
    expect(mePatients.body.patients.map((row: { patient_id: string }) => row.patient_id)).not.toContain(deniedPatientId);

    await request(app.getHttpServer())
      .get(`/v1/patients/${allowedPatientId}/pending-investigation`)
      .expect(200);

    await request(app.getHttpServer())
      .get(`/v1/patients/${deniedPatientId}/pending-investigation`)
      .expect(403);
  });
});
