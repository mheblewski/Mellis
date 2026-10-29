import 'dotenv/config';
import 'reflect-metadata';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Client, Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '@infra/db/migrate';
import { listMigrationFiles, resolveMigrationsDir } from '@infra/db/migration-files';
import { assertIntegrationTestDatabaseConfiguration, configurePostgresIntegrationEnvironment } from '@infra/db/postgres-test-isolation';
import { FakeDeviceKey } from '@modules/device-auth/testing/fake-device-keys';
import { pairingMessage } from '@modules/device-auth/domain/device-crypto';

/**
 * Stage 5, history from a Cognito-era installation (the community-self-hosted plan): a database at
 * migration 089 (today's production schema) with Cognito users, a patient whose Nightscout came from the environment,
 * conversations and an old push row is dumped (pg_dump -Fc, as `deploy/backup.sh` did), restored into an empty
 * database (pg_restore --no-owner --no-privileges, as `mellis` restores) and migrated to the newest schema. Then the
 * server tool's steps: the Nightscout is stored again (the token is never in a backup), "Połącz telefon właściciela"
 * lists the owners (a leftover test person created first is one of them, as in the dress rehearsal) and pairs a phone
 * into the one chosen, a new recovery code is made. Synthetic data only.
 */

const runPostgresIntegration = process.env.RUN_POSTGRES_INTEGRATION === '1';
const describePostgres = runPostgresIntegration ? describe.sequential : describe.skip;
configurePostgresIntegrationEnvironment(process.env);

const LAST_COGNITO_MIGRATION = '089_bolus_tab_create_meal.sql';
const PATIENT = 'aaaaaaaa-aaaa-4aaa-8aaa-0000000000a1';
const FIRST_OWNER = 'bbbbbbbb-bbbb-4bbb-8bbb-0000000000b1';
const SECOND = 'bbbbbbbb-bbbb-4bbb-8bbb-0000000000b2';
const TESTER = 'bbbbbbbb-bbbb-4bbb-8bbb-0000000000b0';

function databaseUrl(base: string, name: string): string {
  const url = new URL(base);
  url.pathname = `/${name}`;
  return url.toString();
}

function hasTool(tool: string): boolean {
  try {
    execFileSync(tool, ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

async function migrateUpTo(url: string, lastFile: string | null): Promise<void> {
  const dir = resolveMigrationsDir() as string;
  const client = new Client({ connectionString: url });
  client.on('error', () => undefined);
  await client.connect();
  try {
    const vector = (await client.query(`SELECT 1 FROM pg_available_extensions WHERE name = 'vector'`)).rowCount ?? 0;
    if (!vector) {
      // Local Postgres without pgvector: the RAG index (036) is marked applied, as in the other local runs.
      await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
      await client.query(`INSERT INTO schema_migrations (version) VALUES ('036_rag_knowledge_index.sql') ON CONFLICT DO NOTHING`);
    }
    if (lastFile === null) {
      await runMigrations(client, dir);
      return;
    }
    const partial = mkdtempSync(join(tmpdir(), 'mellis-migrations-089-'));
    try {
      for (const file of listMigrationFiles(dir)) if (file <= lastFile) copyFileSync(join(dir, file), join(partial, file));
      await runMigrations(client, partial);
    } finally {
      rmSync(partial, { recursive: true, force: true });
    }
  } finally {
    await client.end();
  }
}

describePostgres('restoring a Cognito-era backup into a device-mode server (postgres)', { timeout: 180_000 }, () => {
  const tools = hasTool('pg_dump') && hasTool('pg_restore');
  let admin: Pool;
  let restoredUrl: string;
  let app: INestApplication | undefined;
  let pool: Pool;
  const names: string[] = [];
  const envBackup: Record<string, string | undefined> = {};
  let dumpDir: string;

  beforeAll(async () => {
    const { testDatabaseUrl, identity } = assertIntegrationTestDatabaseConfiguration(process.env);
    admin = new Pool({ connectionString: testDatabaseUrl, max: 1 });
    const source = `${identity.database}_cognito089`;
    const target = `${identity.database}_restored`;
    names.push(source, target);
    for (const name of names) {
      await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await admin.query(`CREATE DATABASE "${name}"`);
    }
    const sourceUrl = databaseUrl(testDatabaseUrl, source);
    restoredUrl = databaseUrl(testDatabaseUrl, target);

    // Today's production: schema at 089, Cognito people, Nightscout from the environment (no stored token).
    await migrateUpTo(sourceUrl, LAST_COGNITO_MIGRATION);
    const fixture = new Client({ connectionString: sourceUrl });
    fixture.on('error', () => undefined);
    await fixture.connect();
    await fixture.query(
      `INSERT INTO users (id, display_name, created_at) VALUES ($1, 'Piotr', '2026-01-01T10:00:00Z'), ($2, 'Ewa', '2026-02-01T10:00:00Z'), ($3, 'iPhone Tester', '2025-12-01T10:00:00Z')`,
      [FIRST_OWNER, SECOND, TESTER],
    );
    await fixture.query(
      `INSERT INTO auth_identities (user_id, provider, provider_subject, email) VALUES ($1, 'COGNITO', 'sub-1', 'first@example.test'), ($2, 'COGNITO', 'sub-2', 'second@example.test')`,
      [FIRST_OWNER, SECOND],
    );
    await fixture.query(`INSERT INTO patients (id, display_name, birth_year) VALUES ($1, 'Kuba', 2016)`, [PATIENT]);
    await fixture.query(
      `INSERT INTO caregiver_relationships (user_id, patient_id, relationship_type, permissions, created_at)
       VALUES ($1, $3, 'CAREGIVER', '{"remote_commands": true}', '2026-01-01T10:00:00Z'), ($2, $3, 'CAREGIVER', '{}', '2026-02-01T10:00:00Z'),
              ($4, $3, 'CAREGIVER', '{}', '2025-12-01T10:00:00Z')`,
      [FIRST_OWNER, SECOND, PATIENT, TESTER],
    );
    await fixture.query(
      `INSERT INTO sources (patient_id, source_system, source_key, source_version, metadata)
       VALUES ($1::uuid, 'NIGHTSCOUT', $1::text, 'nightscout.v1', jsonb_build_object('base_url', 'http://localhost:1'))`,
      [PATIENT],
    );
    await fixture.query(`INSERT INTO conversations (id, patient_id, thread_state_version) VALUES ('cccccccc-cccc-4ccc-8ccc-0000000000c1', $1, 'v1')`, [PATIENT]);
    await fixture.query(
      `INSERT INTO messages (conversation_id, patient_id, role, message_type, content, provenance_ref, idempotency_key, author_user_id)
       VALUES ('cccccccc-cccc-4ccc-8ccc-0000000000c1', $1, 'USER', 'USER_MESSAGE', 'Co było w nocy?', 'test', 'restore-1', $2)`,
      [PATIENT, FIRST_OWNER],
    );
    await fixture.query(
      `INSERT INTO patient_devices (patient_id, platform, device_id, push_token, user_id) VALUES ($1, 'ios', 'old-phone', 'old-token', $2)`,
      [PATIENT, FIRST_OWNER],
    );
    await fixture.end();

    // The backup and the restore, as the server tool does them (custom format, no owners or grants).
    if (tools) {
      dumpDir = mkdtempSync(join(tmpdir(), 'mellis-restore-'));
      const dump = join(dumpDir, 'database.dump');
      execFileSync('pg_dump', ['-Fc', '-f', dump, '-d', sourceUrl]);
      execFileSync('pg_restore', ['--no-owner', '--no-privileges', '--exit-on-error', '-d', restoredUrl, dump]);
    } else {
      restoredUrl = sourceUrl;
    }
    await migrateUpTo(restoredUrl, null);

    for (const [key, value] of Object.entries({
      AUTH_MODE: 'device',
      DATABASE_URL: restoredUrl,
      NIGHTSCOUT_TOKEN_ENCRYPTION_KEY: '22'.repeat(32),
      SETUP_CODE: 'RESTORE-SETUP-CODE-0001',
      NIGHTSCOUT_ALLOWED_HOSTS: 'localhost,127.0.0.1',
      PUBLIC_BASE_URL: 'https://mellis.example',
    })) {
      envBackup[key] = process.env[key];
      process.env[key] = value;
    }
    pool = new Pool({ connectionString: restoredUrl, max: 2 });
    const { ApiAppModule } = await import('../app.module');
    app = (await Test.createTestingModule({ imports: [ApiAppModule] }).compile()).createNestApplication({ logger: false });
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    for (const [key, value] of Object.entries(envBackup)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    for (const name of names) await admin?.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin?.end();
    if (dumpDir) rmSync(dumpDir, { recursive: true, force: true });
  });

  it('keeps the history and the people, finishes the setup and pairs the owner phone into the owner chosen from the list', async () => {
    const http = () => request(app!.getHttpServer());
    expect(tools ? 'pg_dump + pg_restore' : 'migrated in place (no pg_dump on this machine)').toBeTruthy();

    // Every migration after 089 ran on the restored data.
    const newest = listMigrationFiles(resolveMigrationsDir() as string).at(-1);
    expect((await pool.query(`SELECT 1 FROM schema_migrations WHERE version = $1`, [newest])).rowCount).toBe(1);

    // History and people kept; Cognito people stay as people without devices; both became owners (090).
    expect(Number((await pool.query(`SELECT count(*) FROM messages WHERE patient_id = $1`, [PATIENT])).rows[0].count)).toBe(1);
    const people = (await pool.query(`SELECT user_id::text, is_owner, remote_bolus_granted_by::text AS granted FROM caregiver_relationships WHERE patient_id = $1 ORDER BY created_at`, [PATIENT])).rows;
    expect(people).toEqual([
      { user_id: TESTER, is_owner: true, granted: null },
      { user_id: FIRST_OWNER, is_owner: true, granted: FIRST_OWNER },
      { user_id: SECOND, is_owner: true, granted: null },
    ]);
    expect(Number((await pool.query(`SELECT count(*) FROM devices`)).rows[0].count)).toBe(0);
    // A server with owners starts with the setup finished (091): the setup code cannot take it over.
    expect((await http().get('/v1/setup').expect(200)).body.setup).toBe('COMPLETED');
    await http().post('/v1/setup/patients').set('X-Mellis-Setup-Code', 'RESTORE-SETUP-CODE-0001').send({}).expect(409);

    // The Nightscout came from the environment: the address is known (090), no token yet.
    const { DeviceAuthService } = await import('../application/device-auth.service');
    const service = app!.get(DeviceAuthService);
    expect(await service.listPatientSources()).toEqual([expect.objectContaining({ patient_id: PATIENT, display_name: 'Kuba', has_token: false, nightscout_url: 'http://localhost:1' })]);

    // mellis → Połącz telefon właściciela with several owners: `owners` tells them apart (the leftover tester, created
    // first, has no Cognito login, no device and no message), and reset-owner --user pairs the one chosen.
    const owners = await service.listOwners();
    expect(owners.map((o) => [o.user_id, o.display_name, o.has_login_history, o.auth_identities, o.devices, o.patients])).toEqual([
      [TESTER, 'iPhone Tester', false, 0, 0, ['Kuba']],
      [FIRST_OWNER, 'Piotr', true, 1, 0, ['Kuba']],
      [SECOND, 'Ewa', true, 1, 0, ['Kuba']],
    ]);
    expect(owners[0].last_active_at).toBeNull();
    expect(owners[1].last_message_at).toEqual(expect.any(String));
    expect(owners[1].last_active_at).toEqual(expect.any(String));
    await expect(service.resetOwner(null, 'https://mellis.example', new Date(), PATIENT)).rejects.toMatchObject({ code: 'NOT_AN_OWNER' });
    const reset = await service.resetOwner(null, 'https://mellis.example', new Date(), FIRST_OWNER);
    expect(reset).toMatchObject({ user_id: FIRST_OWNER, display_name: 'Piotr', pairing_url: expect.stringContaining('mellis://pair?server=https%3A%2F%2Fmellis.example') });
    const phone = new FakeDeviceKey();
    const paired = await http().post('/v1/pair').send({
      code: reset.code,
      device: { name: 'iPhone Piotra', public_key: phone.publicKey, client_device_id: 'new-app-id' },
      signature: phone.sign(pairingMessage(reset.code, phone.publicKey)),
    }).expect(201);
    expect(paired.body.user.user_id).toBe(FIRST_OWNER);
    const patients = await http().get('/v1/me/patients').set({ Authorization: `Bearer ${paired.body.session.access_token}` }).expect(200);
    expect(JSON.stringify(patients.body)).toContain(PATIENT);

    // A recovery code for the restored server (it never had one); the first owner is the recovery person from now on.
    const recovery = await service.replaceRecoveryCode();
    expect(recovery).toMatchObject({ user_id: FIRST_OWNER });
    const lost = new FakeDeviceKey();
    const recovered = await http().post('/v1/setup/recover').send({
      recovery_code: recovery.recovery_code,
      device: { name: 'Nowy iPhone', public_key: lost.publicKey },
      signature: lost.sign(pairingMessage(recovery.recovery_code, lost.publicKey)),
    }).expect(201);
    expect(recovered.body.user.user_id).toBe(FIRST_OWNER);
  });
});
