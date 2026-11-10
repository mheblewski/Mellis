import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { validateApiEnvironment } from '@infra/config/environment';
import { DatabaseModule } from '@infra/db/database.module';
import { assertPoolUsesIsolatedTestDatabase, configurePostgresIntegrationEnvironment } from '@infra/db/postgres-test-isolation';
import { diagnosticRecorder } from '@modules/diagnostics/application/diagnostic-recorder';
import { applyMigrationsForDiagnosticsTests } from '@modules/diagnostics/infrastructure/apply-migrations.testing';
import { startDiagnosticEvents } from '@modules/diagnostics/infrastructure/start-diagnostic-events';
import { BearerPrincipalGuard } from '../auth/bearer-principal.guard';
import { CognitoAuthService } from '../auth/cognito-auth.service';
import { DiagnosticsController } from './diagnostics.controller';

const USER = randomUUID();
const PATIENT = randomUUID();

describe.runIf(process.env.RUN_POSTGRES_INTEGRATION === '1')('GET /v1/me/diagnostic-report (postgres)', { timeout: 180_000 }, () => {
  let app: INestApplication;
  let pool: Pool;
  const envBackup: Record<string, string | undefined> = {};

  beforeAll(async () => {
    configurePostgresIntegrationEnvironment(process.env);
    for (const name of ['AUTH_MODE', 'ALLOW_AUTH_DISABLED_IN_LOCAL', 'NODE_ENV', 'AUTH_DISABLED_USER_ID']) envBackup[name] = process.env[name];
    process.env.AUTH_MODE = 'disabled';
    process.env.ALLOW_AUTH_DISABLED_IN_LOCAL = 'true';
    process.env.NODE_ENV = 'development';
    process.env.AUTH_DISABLED_USER_ID = USER;

    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
    await assertPoolUsesIsolatedTestDatabase(pool);
    await applyMigrationsForDiagnosticsTests(pool);
    await pool.query("INSERT INTO users (id, display_name) VALUES ($1::uuid, 'Mama Kuby')", [USER]);
    await pool.query("INSERT INTO patients (id, display_name) VALUES ($1::uuid, 'Kuba')", [PATIENT]);
    await pool.query(
      `INSERT INTO caregiver_relationships (id, user_id, patient_id, relationship_type, permissions, is_owner)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'CAREGIVER', '{}'::jsonb, false)`,
      [randomUUID(), USER, PATIENT],
    );

    app = (await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true, validate: validateApiEnvironment }), DatabaseModule],
      controllers: [DiagnosticsController],
      providers: [BearerPrincipalGuard, CognitoAuthService],
    }).compile()).createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    diagnosticRecorder.stop();
    await app?.close();
    await pool?.end();
    for (const [name, value] of Object.entries(envBackup)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it('refuses a caregiver who owns no patient, and records the route without an id', async () => {
    const refused = await request(app.getHttpServer()).get('/v1/me/diagnostic-report').expect(403);
    expect(refused.body.code).toBe('NOT_AN_OWNER');
    expect(JSON.stringify(refused.body)).not.toContain('RAPORT');

    startDiagnosticEvents(pool, 'api');
    await vi.waitFor(async () => {
      const rows = (await pool.query("SELECT level, fields FROM diagnostic_events WHERE event = 'api_request_failed'")).rows;
      expect(rows).toEqual([{ level: 'warn', fields: { code: 'NOT_AN_OWNER', method: 'GET', route: '/v1/me/diagnostic-report', status: 403 } }]);
    }, { timeout: 5_000 });
  });

  it('gives an owner the report, without names or identifiers', async () => {
    await pool.query('UPDATE caregiver_relationships SET is_owner = true WHERE user_id = $1::uuid', [USER]);
    const response = await request(app.getHttpServer()).get('/v1/me/diagnostic-report').expect(200);
    const text: string = response.body.text;
    expect(text).toContain('RAPORT SERWERA');
    expect(text).toContain('Podopieczny 1');
    expect(text).not.toContain('nie udało się odczytać');
    for (const leak of ['Kuba', USER, PATIENT]) expect(text).not.toContain(leak);
  });
});
