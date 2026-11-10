import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertPoolUsesIsolatedTestDatabase, configurePostgresIntegrationEnvironment } from '@infra/db/postgres-test-isolation';
import { applyMigrationsForDiagnosticsTests } from './apply-migrations.testing';
import { buildDiagnosticReport } from '../application/diagnostic-report';
import { PostgresDiagnosticStore } from './postgres-diagnostic-store';

configurePostgresIntegrationEnvironment(process.env);

describe.runIf(process.env.RUN_POSTGRES_INTEGRATION === '1')('PostgresDiagnosticStore (postgres)', { timeout: 180_000 }, () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
    await assertPoolUsesIsolatedTestDatabase(pool);
    await applyMigrationsForDiagnosticsTests(pool);
    await pool.query('DELETE FROM diagnostic_events');
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
  });

  it('adds up repeated writes of a bucket and prunes old rows', async () => {
    const store = new PostgresDiagnosticStore(pool);
    const row = {
      bucket_start: '2026-11-07T10:00:00.000Z', source: 'worker', level: 'warn' as const, event: 'record_rejected', fields_key: '{"reason":"BAD"}',
      fields: { reason: 'BAD' }, count: 2, first_at: '2026-11-07T10:01:00.000Z', last_at: '2026-11-07T10:02:00.000Z', duration_ms_total: 5, duration_ms_max: 5,
    };
    await store.writeDiagnosticEvents([row]);
    await store.writeDiagnosticEvents([{ ...row, count: 1, first_at: '2026-11-07T10:03:00.000Z', last_at: '2026-11-07T10:04:00.000Z', duration_ms_total: 9, duration_ms_max: 9 }]);
    expect(await store.eventTotals('2026-11-01T00:00:00.000Z')).toEqual([{ level: 'warn', event: 'record_rejected', count: 3, last_at: '2026-11-07T10:04:00.000Z' }]);
    const [timeline] = await store.timeline('2026-11-01T00:00:00.000Z', '2026-11-07T00:00:00.000Z', 10);
    expect(timeline).toMatchObject({ count: 3, first_at: '2026-11-07T10:01:00.000Z', duration_ms_max: 9, fields: { reason: 'BAD' } });
    expect(await store.deleteDiagnosticEventsBefore('2026-11-08T00:00:00.000Z')).toBe(1);
  });

  it('every part of the report runs against the real schema', async () => {
    const text = await buildDiagnosticReport(new PostgresDiagnosticStore(pool), { MELLIS_VERSION: '1.0.34' }, new Date('2026-11-07T12:00:00Z'), null);
    expect(text).not.toContain('nie udało się odczytać');
    expect(text).toMatch(/\b1[1-9][0-9]_[a-z_]+\b/); // the newest migration's name
  });

  it('reads real rows without their identifiers, names, addresses or amounts', async () => {
    const owner = (await pool.query<{ id: string }>("INSERT INTO users (id, display_name) VALUES (gen_random_uuid(), 'Mama Kuby') RETURNING id")).rows[0].id;
    const patient = (await pool.query<{ id: string }>("INSERT INTO patients (id, display_name) VALUES (gen_random_uuid(), 'Kuba') RETURNING id")).rows[0].id;
    await pool.query("INSERT INTO sources (patient_id, source_system, source_key, base_url, enabled) VALUES ($1::uuid, 'NIGHTSCOUT', 'ns-secret-host', 'https://ns.secret-host.example', true)", [patient]);
    await pool.query("INSERT INTO patient_devices (patient_id, platform, device_id, push_token, app_version, user_id) VALUES ($1::uuid, 'ios', 'device-secret', 'pushtoken-secret', '1.0.33 (1200 · d37e1ab)', $2::uuid)", [patient, owner]);
    const text = await buildDiagnosticReport(new PostgresDiagnosticStore(pool), {}, new Date(), null);
    expect(text).not.toContain('nie udało się odczytać');
    expect(text).toContain('Telefon 1: ios, wersja 1.0.33_1200_d37e1ab, podopiecznych 1, aktywny tak');
    expect(text).toContain('Nightscout: włączony tak, token nie');
    for (const leak of ['Kuba', 'secret', patient, owner]) expect(text).not.toContain(leak);
  });
});
