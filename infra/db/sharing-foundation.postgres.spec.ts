import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import {
  assertPoolUsesIsolatedTestDatabase,
  configurePostgresIntegrationEnvironment,
} from './postgres-test-isolation';

const runPostgresIntegration = process.env.RUN_POSTGRES_INTEGRATION === '1';
const describePostgres = runPostgresIntegration ? describe.sequential : describe.skip;

configurePostgresIntegrationEnvironment(process.env);

const MIGRATIONS_DIR = resolve(__dirname, 'migrations');
const SKIPPED_MIGRATIONS = new Set(['026_meal_supersession.sql']);
const SHARING_MIGRATION = '090_sharing_foundation.sql';
const SCHEMA = 'sharing_090_spec';

/** Applies every migration, optionally stopping before one (to seed pre-migration data). */
async function applyMigrations(pool: Pool, before?: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const hasVector = ((await client.query(`SELECT 1 FROM pg_available_extensions WHERE name = 'vector'`)).rowCount ?? 0) > 0;
    for (const fileName of readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql')).sort()) {
      if (before && fileName >= before) break;
      if (SKIPPED_MIGRATIONS.has(fileName) || (!hasVector && fileName.startsWith('036_'))) continue;
      const applied = await client.query('SELECT 1 FROM schema_migrations WHERE version = $1', [fileName]);
      if ((applied.rowCount ?? 0) > 0) continue;
      await client.query(readFileSync(resolve(MIGRATIONS_DIR, fileName), 'utf8'));
      await client.query('INSERT INTO schema_migrations(version) VALUES ($1)', [fileName]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

describePostgres('sharing foundation, migration 090 (postgres)', { timeout: 120_000 }, () => {
  let pool: Pool;
  // Loaded lazily: offline runs must not import the gated modules (postgres-gated-spec-imports.spec.ts).
  let Sharing: typeof import('./postgres-sharing.repository').PostgresSharingRepository;
  let Credentials: typeof import('./postgres-nightscout-credentials.repository').PostgresNightscoutCredentialsRepository;
  let GlucoMind: typeof import('./postgres-glucomind.repository').PostgresGlucoMindRepository;
  let patientId: string;
  let adam: string;
  let ewa: string;
  let guest: string;
  const now = new Date('2026-10-27T10:00:00.000Z');

  async function addUser(name: string, email?: string): Promise<string> {
    const id = randomUUID();
    await pool.query(`INSERT INTO users (id, display_name) VALUES ($1::uuid, $2)`, [id, name]);
    if (email) {
      await pool.query(
        `INSERT INTO auth_identities (user_id, provider, provider_subject, provider_username, email) VALUES ($1::uuid, 'COGNITO', $2, $2, $3)`,
        [id, randomUUID(), email],
      );
    }
    return id;
  }

  async function link(userId: string, permissions: Record<string, unknown> = {}): Promise<void> {
    await pool.query(
      `INSERT INTO caregiver_relationships (user_id, patient_id, relationship_type, permissions) VALUES ($1::uuid, $2::uuid, 'primary_caregiver', $3::jsonb)`,
      [userId, patientId, JSON.stringify(permissions)],
    );
  }

  beforeAll(async () => {
    // Its own schema, migrated up to 089 first, so 090's data migration runs on today's rows; the public schema the
    // other specs use is left alone.
    const admin = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    await assertPoolUsesIsolatedTestDatabase(admin);
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA};`);
    await admin.end();
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4, options: `-c search_path=${SCHEMA},public` });
    await assertPoolUsesIsolatedTestDatabase(pool);
    await applyMigrations(pool, SHARING_MIGRATION);
    patientId = randomUUID();
    await pool.query(`INSERT INTO patients (id, display_name, remote_control) VALUES ($1::uuid, 'Janek', '{"enabled": true}')`, [patientId]);
    adam = await addUser('Adam', 'Adam@Example.com');
    ewa = await addUser('Ewa', 'ewa@example.com');
    await link(adam, { remote_commands: true });
    await link(ewa);
    await pool.query(
      `INSERT INTO sources (patient_id, source_system, source_key, source_version, metadata)
       VALUES ($1::uuid, 'NIGHTSCOUT', $1::text, 'nightscout.v1', jsonb_build_object('base_url', 'https://test-ns.example', 'stream_cursors', jsonb_build_object('entries', '2026-10-27T09:00:00.000Z')))`,
      [patientId],
    );
    await applyMigrations(pool);
    ({ PostgresSharingRepository: Sharing } = await import('./postgres-sharing.repository'));
    ({ PostgresNightscoutCredentialsRepository: Credentials } = await import('./postgres-nightscout-credentials.repository'));
    ({ PostgresGlucoMindRepository: GlucoMind } = await import('./postgres-glucomind.repository'));
  });

  afterAll(async () => {
    if (pool) {
      await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
      await pool.end();
    }
  });

  describe('data migration', () => {
    it('makes both linked caregivers owners, keeps the remote bolus switch working and allowlists their e-mails', async () => {
      const members = await new Sharing(pool).listMembers(patientId);
      expect(members.map((m) => [m.display_name, m.is_owner, m.permissions])).toEqual([
        ['Adam', true, { glucose_alerts: true, ai_chat_meals: true, manage_sharing: true, remote_commands: true }],
        ['Ewa', true, { glucose_alerts: true, ai_chat_meals: true, manage_sharing: true, remote_commands: false }],
      ]);
      const repo = new GlucoMind(pool as any);
      expect((await repo.getRemoteControlSwitches(adam, patientId))?.caregiver_permissions).toMatchObject({ remote_commands: true });
      expect((await repo.getRemoteControlSwitches(ewa, patientId))?.caregiver_permissions).toMatchObject({ remote_commands: false });
      const allowlist = (await pool.query(`SELECT email FROM beta_allowlist ORDER BY email`)).rows.map((r) => r.email);
      expect(allowlist).toEqual(['adam@example.com', 'ewa@example.com']);
    });

    it('copies the source address into base_url and keeps its sync cursors', async () => {
      const row = (await pool.query(`SELECT base_url, enabled, api_token_ciphertext, metadata FROM sources WHERE patient_id = $1::uuid`, [patientId])).rows[0];
      expect(row).toMatchObject({ base_url: 'https://test-ns.example', enabled: true, api_token_ciphertext: null });
      expect(row.metadata.stream_cursors.entries).toBe('2026-10-27T09:00:00.000Z');
    });
  });

  describe('per-patient Nightscout', () => {
    it('stores credentials once with onlyIfMissing, replaces them otherwise, and allows one connection per patient', async () => {
      const credentials = new Credentials(pool);
      const seeded = await credentials.saveNightscoutCredentials({ patientId, baseUrl: 'https://test-ns.example/', authMode: 'ACCESS_TOKEN_JWT', tokenCiphertext: 'v1:a:b:c', onlyIfMissing: true });
      expect(seeded).toMatchObject({ base_url: 'https://test-ns.example', auth_mode: 'ACCESS_TOKEN_JWT', api_token_ciphertext: 'v1:a:b:c' });
      expect(await credentials.saveNightscoutCredentials({ patientId, baseUrl: 'https://other.example', authMode: 'BEARER', tokenCiphertext: 'v1:x:y:z', onlyIfMissing: true })).toBeNull();
      const replaced = await credentials.saveNightscoutCredentials({ patientId, baseUrl: 'https://test-ns.example', authMode: 'BEARER', tokenCiphertext: 'v1:d:e:f' });
      expect(replaced?.source_id).toBe(seeded?.source_id);
      const metadata = (await pool.query(`SELECT metadata FROM sources WHERE id = $1::uuid`, [seeded?.source_id])).rows[0].metadata;
      expect(metadata.stream_cursors.entries).toBe('2026-10-27T09:00:00.000Z');

      // An extra source row of the same patient is allowed, a second connection is not; saving keeps using the first.
      await pool.query(`INSERT INTO sources (patient_id, source_system, source_key) VALUES ($1::uuid, 'NIGHTSCOUT', 'second')`, [patientId]);
      await expect(pool.query(
        `UPDATE sources SET api_token_ciphertext = 'v1:1:2:3' WHERE patient_id = $1::uuid AND source_key = 'second'`, [patientId],
      )).rejects.toMatchObject({ code: '23505' });
      const again = await credentials.saveNightscoutCredentials({ patientId, baseUrl: 'https://test-ns.example', authMode: 'BEARER', tokenCiphertext: 'v1:g:h:i' });
      expect(again?.source_id).toBe(seeded?.source_id);
      expect((await credentials.getNightscoutCredentials(patientId))?.api_token_ciphertext).toBe('v1:g:h:i');
      await pool.query(`DELETE FROM sources WHERE patient_id = $1::uuid AND source_key = 'second'`, [patientId]);
      await expect(pool.query(`UPDATE sources SET api_token_ciphertext = 'plain' WHERE patient_id = $1::uuid AND source_key = $1::text`, [patientId])).rejects.toMatchObject({ code: '23514' });
    });

    it('drops a disabled source from the worker list', async () => {
      const { PostgresNightscoutRepository } = await import('./postgres-nightscout.repository');
      const nightscout = new PostgresNightscoutRepository(pool as any);
      expect((await nightscout.listNightscoutSources()).map((s) => s.patient_id)).toEqual([patientId]);
      await new Credentials(pool).setNightscoutSourceEnabled(patientId, false);
      expect(await nightscout.listNightscoutSources()).toEqual([]);
      await new Credentials(pool).setNightscoutSourceEnabled(patientId, true);
    });

    it('switches off a source of the patient without an address or token when the Nightscout is stored (restored older install)', async () => {
      const { PostgresNightscoutRepository } = await import('./postgres-nightscout.repository');
      const nightscout = new PostgresNightscoutRepository(pool as any);
      const credentials = new Credentials(pool);
      // A restored Cognito-era backup: the env-configured install's source row, no base_url and no token after 090.
      const old = (await pool.query(
        `INSERT INTO sources (patient_id, source_system, source_key, source_version, metadata, created_at)
         VALUES ($1::uuid, 'NIGHTSCOUT', 'env-nightscout', 'nightscout.v1', '{}'::jsonb, '2026-01-01T00:00:00Z') RETURNING id`,
        [patientId],
      )).rows[0].id;
      expect((await nightscout.listNightscoutSources()).map((s) => s.id)).toContain(old);

      const saved = await credentials.saveNightscoutCredentials({ patientId, baseUrl: 'https://test-ns.example', authMode: 'ACCESS_TOKEN_JWT', tokenCiphertext: 'v1:n:e:w' });
      expect(saved?.source_id).not.toBe(old);
      const rows = (await pool.query(`SELECT id, enabled, base_url FROM sources WHERE patient_id = $1::uuid AND source_system = 'NIGHTSCOUT' ORDER BY created_at`, [patientId])).rows;
      expect(rows).toEqual([
        { id: old, enabled: false, base_url: null },
        { id: saved?.source_id, enabled: true, base_url: 'https://test-ns.example' },
      ]);
      expect((await nightscout.listNightscoutSources()).map((s) => s.id)).toEqual([saved?.source_id]);
      // Off and on again: the row without an address stays off; its records are kept.
      await credentials.setNightscoutSourceEnabled(patientId, false);
      await credentials.setNightscoutSourceEnabled(patientId, true);
      expect((await nightscout.listNightscoutSources()).map((s) => s.id)).toEqual([saved?.source_id]);
      await pool.query(`DELETE FROM sources WHERE id = $1::uuid`, [old]);
    });
  });

  describe('memberships', () => {
    beforeEach(async () => {
      await pool.query(`DELETE FROM sharing_invitations`);
      await pool.query(`DELETE FROM caregiver_relationships WHERE user_id NOT IN ($1::uuid, $2::uuid)`, [adam, ewa]);
      guest = await addUser('Gość', `guest-${randomUUID().slice(0, 8)}@example.com`);
    });

    it('keeps at least one owner, also when the database is used directly', async () => {
      const sharing = new Sharing(pool);
      await sharing.setOwner(patientId, adam, ewa, false);
      await expect(sharing.setOwner(patientId, adam, adam, false)).rejects.toMatchObject({ code: 'LAST_OWNER' });
      await expect(sharing.removeMember(patientId, adam, adam)).rejects.toMatchObject({ code: 'LAST_OWNER' });
      await expect(pool.query(`UPDATE caregiver_relationships SET is_owner = false WHERE patient_id = $1::uuid`, [patientId])).rejects.toThrow('PATIENT_NEEDS_AN_OWNER');
      await expect(sharing.setOwner(patientId, ewa, ewa, true)).rejects.toMatchObject({ code: 'NOT_AN_OWNER' });
      await sharing.setOwner(patientId, adam, ewa, true);
      expect((await sharing.getMember(patientId, ewa))?.is_owner).toBe(true);
    });

    it('counts remote bolus only when an owner granted it and the grantee confirmed it', async () => {
      const sharing = new Sharing(pool);
      const repo = new GlucoMind(pool as any);
      await pool.query(
        `INSERT INTO caregiver_relationships (user_id, patient_id, relationship_type, permissions) VALUES ($1::uuid, $2::uuid, 'shared', '{"glucose_alerts": true}')`,
        [guest, patientId],
      );
      // Switched on by hand without a grant: still off.
      await pool.query(`UPDATE caregiver_relationships SET permissions = permissions || '{"remote_commands": true}' WHERE user_id = $1::uuid`, [guest]);
      expect((await repo.getRemoteControlSwitches(guest, patientId))?.caregiver_permissions).toMatchObject({ remote_commands: false });

      await expect(sharing.grantRemoteBolus(patientId, guest, guest, now)).rejects.toMatchObject({ code: 'NOT_AN_OWNER' });
      await expect(pool.query(
        `UPDATE caregiver_relationships SET remote_bolus_granted_by = $1::uuid, remote_bolus_granted_at = now() WHERE user_id = $1::uuid`, [guest],
      )).rejects.toThrow('REMOTE_BOLUS_GRANTER_NOT_OWNER');

      await sharing.grantRemoteBolus(patientId, ewa, guest, now);
      expect((await repo.getRemoteControlSwitches(guest, patientId))?.caregiver_permissions).toMatchObject({ remote_commands: false });
      await sharing.confirmRemoteBolus(patientId, guest, now);
      expect((await repo.getRemoteControlSwitches(guest, patientId))?.caregiver_permissions).toMatchObject({ remote_commands: true, glucose_alerts: true });

      // The granter stops being an owner: the grant no longer counts.
      await sharing.setOwner(patientId, adam, ewa, false);
      expect((await repo.getRemoteControlSwitches(guest, patientId))?.caregiver_permissions).toMatchObject({ remote_commands: false });
      await sharing.setOwner(patientId, adam, ewa, true);

      await sharing.revokeRemoteBolus(patientId, guest, guest);
      expect((await sharing.getMember(patientId, guest))?.remote_bolus).toEqual({ granted_by: null, granted_at: null, confirmed_at: null, effective: false });
      await expect(sharing.confirmRemoteBolus(patientId, guest, now)).rejects.toMatchObject({ code: 'REMOTE_BOLUS_NOT_GRANTED' });
    });
  });

  describe('invitations', () => {
    beforeEach(async () => {
      await pool.query(`DELETE FROM sharing_invitations`);
      await pool.query(`DELETE FROM caregiver_relationships WHERE user_id NOT IN ($1::uuid, $2::uuid)`, [adam, ewa]);
    });

    it('invites by normalized e-mail for 7 days, single use, and the accepted membership gets the permissions', async () => {
      const sharing = new Sharing(pool);
      const invitation = await sharing.createInvitation({
        patientId, invitedBy: ewa, email: '  Babcia@Example.com ', inviteeName: 'Babcia', now,
        permissions: { glucose_alerts: true, ai_chat_meals: true, remote_commands: true },
      });
      expect(invitation).toMatchObject({ email: 'babcia@example.com', expires_at: '2026-11-03T10:00:00.000Z' });
      expect((await sharing.findOpenInvitationsByEmail('BABCIA@example.com', now)).map((i) => i.id)).toEqual([invitation.id]);

      const babcia = await addUser('Babcia', 'babcia@example.com');
      await expect(sharing.acceptInvitation({ invitationId: invitation.id, userId: babcia, email: 'other@example.com', now, confirmRemoteBolus: true }))
        .rejects.toMatchObject({ code: 'INVITATION_EMAIL_MISMATCH' });
      const member = await sharing.acceptInvitation({ invitationId: invitation.id, userId: babcia, email: 'babcia@example.com', now, confirmRemoteBolus: true });
      expect(member).toMatchObject({
        is_owner: false,
        permissions: { glucose_alerts: true, ai_chat_meals: true, manage_sharing: false, remote_commands: true },
        remote_bolus: { granted_by: ewa, effective: true },
      });
      await expect(sharing.acceptInvitation({ invitationId: invitation.id, userId: babcia, email: 'babcia@example.com', now, confirmRemoteBolus: true }))
        .rejects.toMatchObject({ code: 'INVITATION_CLOSED' });
      expect(await sharing.findOpenInvitationsByEmail('babcia@example.com', now)).toEqual([]);
      await expect(sharing.createInvitation({ patientId, invitedBy: ewa, email: 'babcia@example.com', now, permissions: {} }))
        .rejects.toMatchObject({ code: 'ALREADY_A_MEMBER' });
    });

    it('waits for the confirmation when remote bolus was accepted without it, and makes a co-owner from manage_sharing', async () => {
      const sharing = new Sharing(pool);
      const invitation = await sharing.createInvitation({ patientId, invitedBy: adam, email: 'tata@example.com', now, permissions: { manage_sharing: true, remote_commands: true } });
      const tata = await addUser('Tata', 'tata@example.com');
      const member = await sharing.acceptInvitation({ invitationId: invitation.id, userId: tata, email: 'tata@example.com', now, confirmRemoteBolus: false });
      expect(member).toMatchObject({ is_owner: true, remote_bolus: { granted_by: adam, confirmed_at: null, effective: false } });
      await sharing.confirmRemoteBolus(patientId, tata, now);
      expect((await sharing.getMember(patientId, tata))?.remote_bolus.effective).toBe(true);
    });

    it('refuses expired, revoked and non-owner invitations and replaces an open one for the same e-mail', async () => {
      const sharing = new Sharing(pool);
      const guestUser = await addUser('Gość', 'gosc@example.com');
      await pool.query(`INSERT INTO caregiver_relationships (user_id, patient_id, relationship_type) VALUES ($1::uuid, $2::uuid, 'shared')`, [guestUser, patientId]);
      await expect(sharing.createInvitation({ patientId, invitedBy: guestUser, email: 'x@example.com', now, permissions: {} })).rejects.toMatchObject({ code: 'NOT_AN_OWNER' });

      const first = await sharing.createInvitation({ patientId, invitedBy: ewa, email: 'x@example.com', now, permissions: {} });
      const second = await sharing.createInvitation({ patientId, invitedBy: ewa, email: 'x@example.com', now, permissions: { glucose_alerts: true } });
      expect((await sharing.listOpenInvitations(patientId, now)).map((i) => i.id)).toEqual([second.id]);
      const x = await addUser('X', 'x@example.com');
      await expect(sharing.acceptInvitation({ invitationId: first.id, userId: x, email: 'x@example.com', now, confirmRemoteBolus: false })).rejects.toMatchObject({ code: 'INVITATION_CLOSED' });

      const later = new Date(now.getTime() + 8 * 86_400_000);
      await expect(sharing.acceptInvitation({ invitationId: second.id, userId: x, email: 'x@example.com', now: later, confirmRemoteBolus: false })).rejects.toMatchObject({ code: 'INVITATION_EXPIRED' });
      expect(await sharing.findOpenInvitationsByEmail('x@example.com', later)).toEqual([]);

      await expect(sharing.revokeInvitation(second.id, guestUser, now)).rejects.toMatchObject({ code: 'NOT_AN_OWNER' });
      await sharing.revokeInvitation(second.id, adam, now);
      await expect(sharing.revokeInvitation(second.id, adam, now)).rejects.toMatchObject({ code: 'INVITATION_CLOSED' });
    });

    it('allows at most 10 people per patient, members and open invitations together', async () => {
      const sharing = new Sharing(pool);
      // Two owners are members already: eight invitations fit.
      for (let i = 0; i < 8; i += 1) {
        await sharing.createInvitation({ patientId, invitedBy: ewa, email: `p${i}@example.com`, now, permissions: {} });
      }
      await expect(sharing.createInvitation({ patientId, invitedBy: ewa, email: 'p8@example.com', now, permissions: {} })).rejects.toMatchObject({ code: 'PEOPLE_LIMIT_REACHED' });
      // Re-inviting someone already invited replaces it and still fits; an expired one frees its place.
      await sharing.createInvitation({ patientId, invitedBy: ewa, email: 'p0@example.com', now, permissions: {} });
      const later = new Date(now.getTime() + 8 * 86_400_000);
      await sharing.createInvitation({ patientId, invitedBy: ewa, email: 'p8@example.com', now: later, permissions: {} });
    });
  });

  describe('beta allowlist', () => {
    it('lets in allowlisted, invited and linked e-mails, and everyone when switched off', async () => {
      const sharing = new Sharing(pool);
      await pool.query(`DELETE FROM sharing_invitations`);
      expect(await sharing.isBetaAccessAllowed('stranger@example.com', true, now)).toBe(false);
      expect(await sharing.isBetaAccessAllowed('stranger@example.com', false, now)).toBe(true);
      expect(await sharing.isBetaAccessAllowed('ADAM@example.com', true, now)).toBe(true);
      await sharing.createInvitation({ patientId, invitedBy: ewa, email: 'invited@example.com', now, permissions: {} });
      expect(await sharing.isBetaAccessAllowed('invited@example.com', true, now)).toBe(true);
      await sharing.addToBetaAllowlist(' Friend@Example.com ');
      expect(await sharing.isBetaAccessAllowed('friend@example.com', true, now)).toBe(true);
      await sharing.removeFromBetaAllowlist('friend@example.com');
      expect(await sharing.isBetaAccessAllowed('friend@example.com', true, now)).toBe(false);
    });
  });
});
