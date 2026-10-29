import type { Pool, PoolClient } from 'pg';
import {
  INVITATION_VALID_DAYS,
  isBetaAccessAllowed,
  MAX_PEOPLE_PER_PATIENT,
  normalizeEmail,
  parsePermissions,
  SharingError,
  type SharingPermissions,
} from '@modules/sharing/domain/sharing';
import { EFFECTIVE_REMOTE_COMMANDS_SQL } from './postgres-glucomind.repository';

export interface PatientMember {
  user_id: string;
  display_name: string;
  is_owner: boolean;
  permissions: SharingPermissions;
  remote_bolus: { granted_by: string | null; granted_at: string | null; confirmed_at: string | null; effective: boolean };
}

export interface SharingInvitation {
  id: string;
  patient_id: string;
  /** null for an invitation by code (AUTH_MODE=device). */
  email: string | null;
  invitee_name: string | null;
  invited_by: string;
  permissions: SharingPermissions;
  created_at: string;
  expires_at: string;
  accepted_at: string | null;
  accepted_by: string | null;
  revoked_at: string | null;
}

/** Invitees join with this relationship_type; today's caregivers keep 'primary_caregiver'. */
const SHARED_RELATIONSHIP_TYPE = 'shared';

/**
 * Memberships (caregiver_relationships), invitations (sharing_invitations) and the beta allowlist (beta_allowlist), all
 * from 090_sharing_foundation.sql. Changes to one patient's people run under a lock of the patient row, so the limit
 * of 10 people and the owner rules hold under concurrent requests. API endpoints come with stage 2.
 */
export class PostgresSharingRepository {
  constructor(private readonly pool: Pool) {}

  async listMembers(patientId: string): Promise<PatientMember[]> {
    const rows = (await this.pool.query(
      `SELECT DISTINCT ON (r.user_id) r.user_id, u.display_name, r.is_owner, r.permissions,
              r.remote_bolus_granted_by, r.remote_bolus_granted_at, r.remote_bolus_confirmed_at,
              ${EFFECTIVE_REMOTE_COMMANDS_SQL} AS remote_effective
       FROM caregiver_relationships r JOIN users u ON u.id = r.user_id
       WHERE r.patient_id = $1::uuid
       ORDER BY r.user_id, r.is_owner DESC, ${EFFECTIVE_REMOTE_COMMANDS_SQL} DESC, r.created_at`,
      [patientId],
    )).rows;
    return rows.map(toMember).sort((a, b) => Number(b.is_owner) - Number(a.is_owner) || a.display_name.localeCompare(b.display_name));
  }

  async getMember(patientId: string, userId: string): Promise<PatientMember | null> {
    return (await this.listMembers(patientId)).find((member) => member.user_id === userId) ?? null;
  }

  /** Makes a member an owner or not; only an owner may, and the last owner stays one. */
  async setOwner(patientId: string, actingUserId: string, targetUserId: string, isOwner: boolean): Promise<void> {
    await this.inPatientLock(patientId, async (client) => {
      await assertOwner(client, patientId, actingUserId);
      const updated = await client.query(
        `UPDATE caregiver_relationships
         SET is_owner = $3,
             permissions = permissions || jsonb_build_object('manage_sharing', $3::boolean),
             updated_at = now()
         WHERE patient_id = $1::uuid AND user_id = $2::uuid`,
        [patientId, targetUserId, isOwner],
      );
      if ((updated.rowCount ?? 0) === 0) throw new SharingError('NOT_A_MEMBER');
      await assertStillHasOwner(client, patientId);
      await afterMembershipChange(client, patientId);
    });
  }

  /** An owner grants remote bolus; it counts only after the grantee confirms it (confirmRemoteBolus). */
  async grantRemoteBolus(patientId: string, actingUserId: string, granteeUserId: string, now: Date): Promise<void> {
    await this.inPatientLock(patientId, async (client) => {
      await assertOwner(client, patientId, actingUserId);
      // Remote bolus needs "Rozmowy z AI i posiłki" (the Bolus tab and the cards live there, audit #6).
      const member = (await client.query(
        `SELECT bool_or(is_owner) AS is_owner, bool_or(permissions->'ai_chat_meals' IS DISTINCT FROM 'false'::jsonb) AS care
         FROM caregiver_relationships WHERE patient_id = $1::uuid AND user_id = $2::uuid HAVING count(*) > 0`,
        [patientId, granteeUserId],
      )).rows[0];
      if (!member) throw new SharingError('NOT_A_MEMBER');
      if (!member.is_owner && !member.care) throw new SharingError('INVALID_PERMISSIONS');
      const updated = await client.query(
        `UPDATE caregiver_relationships
         SET permissions = permissions || '{"remote_commands": true}'::jsonb,
             remote_bolus_granted_by = $3::uuid, remote_bolus_granted_at = $4, remote_bolus_confirmed_at = NULL, updated_at = now()
         WHERE patient_id = $1::uuid AND user_id = $2::uuid`,
        [patientId, granteeUserId, actingUserId, now.toISOString()],
      );
      if ((updated.rowCount ?? 0) === 0) throw new SharingError('NOT_A_MEMBER');
    });
  }

  /** The grantee confirms on their own phone (Face ID in the app); a grant from someone no longer an owner is refused. */
  async confirmRemoteBolus(patientId: string, userId: string, now: Date): Promise<void> {
    await this.inPatientLock(patientId, async (client) => {
      const updated = await client.query(
        `UPDATE caregiver_relationships r
         SET remote_bolus_confirmed_at = $3, updated_at = now()
         WHERE r.patient_id = $1::uuid AND r.user_id = $2::uuid
           AND r.permissions->'remote_commands' = 'true'::jsonb AND r.remote_bolus_granted_at IS NOT NULL
           AND EXISTS (SELECT 1 FROM caregiver_relationships g
                       WHERE g.patient_id = r.patient_id AND g.user_id = r.remote_bolus_granted_by AND g.is_owner)`,
        [patientId, userId, now.toISOString()],
      );
      if ((updated.rowCount ?? 0) === 0) throw new SharingError('REMOTE_BOLUS_NOT_GRANTED');
    });
  }

  /** An owner, or the grantee themself, turns remote bolus off. */
  async revokeRemoteBolus(patientId: string, actingUserId: string, granteeUserId: string): Promise<void> {
    await this.inPatientLock(patientId, async (client) => {
      if (actingUserId !== granteeUserId) await assertOwner(client, patientId, actingUserId);
      const updated = await client.query(
        `UPDATE caregiver_relationships
         SET permissions = permissions || '{"remote_commands": false}'::jsonb,
             remote_bolus_granted_by = NULL, remote_bolus_granted_at = NULL, remote_bolus_confirmed_at = NULL, updated_at = now()
         WHERE patient_id = $1::uuid AND user_id = $2::uuid`,
        [patientId, granteeUserId],
      );
      if ((updated.rowCount ?? 0) === 0) throw new SharingError('NOT_A_MEMBER');
    });
  }

  /**
   * An owner changes what a member may do: glucose_alerts, ai_chat_meals, manage_sharing (owner) and remote_commands
   * (a new grant that the member confirms on their phone). An owner always has glucose and the AI; anyone else keeps at
   * least one of them. Grants that no longer hold are cleared afterwards (audit #6).
   */
  async updateMemberPermissions(input: { patientId: string; actingUserId: string; targetUserId: string; permissions: Partial<SharingPermissions>; now: Date }): Promise<void> {
    await this.inPatientLock(input.patientId, async (client) => {
      await assertOwner(client, input.patientId, input.actingUserId);
      const current = (await client.query(
        `SELECT is_owner, permissions FROM caregiver_relationships
         WHERE patient_id = $1::uuid AND user_id = $2::uuid ORDER BY is_owner DESC LIMIT 1`,
        [input.patientId, input.targetUserId],
      )).rows[0];
      if (!current) throw new SharingError('NOT_A_MEMBER');
      const wanted = input.permissions;
      const isOwner = typeof wanted.manage_sharing === 'boolean' ? wanted.manage_sharing : current.is_owner;
      const flags: Record<string, boolean> = {};
      for (const key of ['glucose_alerts', 'ai_chat_meals'] as const) if (typeof wanted[key] === 'boolean') flags[key] = wanted[key] as boolean;
      if (isOwner) Object.assign(flags, { glucose_alerts: true, ai_chat_meals: true });
      flags.manage_sharing = isOwner;
      const merged = { ...(current.permissions ?? {}), ...flags };
      if (!isOwner && merged.glucose_alerts === false && merged.ai_chat_meals === false) throw new SharingError('INVALID_PERMISSIONS');
      await client.query(
        `UPDATE caregiver_relationships SET is_owner = $3, permissions = permissions || $4::jsonb, updated_at = now()
         WHERE patient_id = $1::uuid AND user_id = $2::uuid`,
        [input.patientId, input.targetUserId, isOwner, JSON.stringify(flags)],
      );
      await assertStillHasOwner(client, input.patientId);
      await afterMembershipChange(client, input.patientId);
      if (wanted.remote_commands === false) {
        await client.query(
          `UPDATE caregiver_relationships
           SET permissions = permissions || '{"remote_commands": false}'::jsonb,
               remote_bolus_granted_by = NULL, remote_bolus_granted_at = NULL, remote_bolus_confirmed_at = NULL, updated_at = now()
           WHERE patient_id = $1::uuid AND user_id = $2::uuid`,
          [input.patientId, input.targetUserId],
        );
        return;
      }
      const grant = (await client.query(
        `SELECT remote_bolus_granted_at FROM caregiver_relationships WHERE patient_id = $1::uuid AND user_id = $2::uuid ORDER BY is_owner DESC LIMIT 1`,
        [input.patientId, input.targetUserId],
      )).rows[0];
      // "On" for someone already granted (confirmed or still waiting) changes nothing: re-granting would clear their
      // confirmation, and a repeated switch from another owner's phone must not take remote bolus away.
      if (wanted.remote_commands === true && !grant?.remote_bolus_granted_at) {
        if (!isOwner && merged.ai_chat_meals === false) throw new SharingError('INVALID_PERMISSIONS');
        await client.query(
          `UPDATE caregiver_relationships
           SET permissions = permissions || '{"remote_commands": true}'::jsonb,
               remote_bolus_granted_by = $3::uuid, remote_bolus_granted_at = $4, remote_bolus_confirmed_at = NULL, updated_at = now()
           WHERE patient_id = $1::uuid AND user_id = $2::uuid`,
          [input.patientId, input.targetUserId, input.actingUserId, input.now.toISOString()],
        );
      }
    });
  }

  /** An owner removes someone (or anyone leaves); the last owner cannot. */
  async removeMember(patientId: string, actingUserId: string, targetUserId: string): Promise<void> {
    await this.inPatientLock(patientId, async (client) => {
      if (actingUserId !== targetUserId) await assertOwner(client, patientId, actingUserId);
      const deleted = await client.query(`DELETE FROM caregiver_relationships WHERE patient_id = $1::uuid AND user_id = $2::uuid`, [patientId, targetUserId]);
      if ((deleted.rowCount ?? 0) === 0) throw new SharingError('NOT_A_MEMBER');
      await assertStillHasOwner(client, patientId);
      await afterMembershipChange(client, patientId);
    });
  }

  /**
   * An owner invites an e-mail. A still open invitation for the same e-mail is replaced; members and open invitations
   * together stay within MAX_PEOPLE_PER_PATIENT.
   */
  async createInvitation(input: {
    patientId: string;
    invitedBy: string;
    email: string;
    inviteeName?: string | null;
    permissions: Partial<SharingPermissions>;
    now: Date;
  }): Promise<SharingInvitation> {
    const email = normalizeEmail(input.email);
    const permissions = parsePermissions(input.permissions);
    return this.inPatientLock(input.patientId, async (client) => {
      await assertOwner(client, input.patientId, input.invitedBy);
      const member = await client.query(
        `SELECT 1 FROM caregiver_relationships r JOIN auth_identities ai ON ai.user_id = r.user_id
         WHERE r.patient_id = $1::uuid AND lower(btrim(ai.email)) = $2 LIMIT 1`,
        [input.patientId, email],
      );
      if ((member.rowCount ?? 0) > 0) throw new SharingError('ALREADY_A_MEMBER');
      await client.query(
        `UPDATE sharing_invitations SET revoked_at = $3
         WHERE patient_id = $1::uuid AND email = $2 AND accepted_at IS NULL AND revoked_at IS NULL`,
        [input.patientId, email, input.now.toISOString()],
      );
      const people = (await client.query<{ n: number }>(
        `SELECT (SELECT count(DISTINCT user_id) FROM caregiver_relationships WHERE patient_id = $1::uuid)
              + (SELECT count(*) FROM sharing_invitations
                 WHERE patient_id = $1::uuid AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > $2) AS n`,
        [input.patientId, input.now.toISOString()],
      )).rows[0];
      if (Number(people.n) >= MAX_PEOPLE_PER_PATIENT) throw new SharingError('PEOPLE_LIMIT_REACHED');
      const row = (await client.query(
        `INSERT INTO sharing_invitations (patient_id, email, invitee_name, invited_by, permissions, created_at, expires_at)
         VALUES ($1::uuid, $2, $3, $4::uuid, $5::jsonb, $6, $6::timestamptz + make_interval(days => $7))
         RETURNING *`,
        [input.patientId, email, input.inviteeName?.trim() || null, input.invitedBy, JSON.stringify(permissions), input.now.toISOString(), INVITATION_VALID_DAYS],
      )).rows[0];
      return toInvitation(row);
    });
  }

  /**
   * AUTH_MODE=device: an owner invites a person by first name; the invitation is carried by a one-time code the caller
   * stores in the same transaction (`withCode`). Members and open invitations stay within MAX_PEOPLE_PER_PATIENT.
   */
  async createCodeInvitation(input: {
    patientId: string;
    invitedBy: string;
    inviteeName: string;
    permissions: Partial<SharingPermissions>;
    now: Date;
    withCode: (client: PoolClient, invitation: SharingInvitation) => Promise<void>;
  }): Promise<SharingInvitation> {
    const permissions = parsePermissions(input.permissions);
    // An owner always has glucose and the AI; remote bolus needs the AI (audit #6, #13).
    if (permissions.manage_sharing) Object.assign(permissions, { glucose_alerts: true, ai_chat_meals: true });
    if (!permissions.glucose_alerts && !permissions.ai_chat_meals) throw new SharingError('INVALID_PERMISSIONS');
    if (permissions.remote_commands && !permissions.ai_chat_meals) throw new SharingError('INVALID_PERMISSIONS');
    return this.inPatientLock(input.patientId, async (client) => {
      await assertOwner(client, input.patientId, input.invitedBy);
      const people = (await client.query<{ n: number }>(
        `SELECT (SELECT count(DISTINCT user_id) FROM caregiver_relationships WHERE patient_id = $1::uuid)
              + (SELECT count(*) FROM sharing_invitations
                 WHERE patient_id = $1::uuid AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > $2) AS n`,
        [input.patientId, input.now.toISOString()],
      )).rows[0];
      if (Number(people.n) >= MAX_PEOPLE_PER_PATIENT) throw new SharingError('PEOPLE_LIMIT_REACHED');
      const row = (await client.query(
        `INSERT INTO sharing_invitations (patient_id, email, invitee_name, invited_by, permissions, created_at, expires_at)
         VALUES ($1::uuid, NULL, $2, $3::uuid, $4::jsonb, $5, $5::timestamptz + make_interval(days => $6))
         RETURNING *`,
        [input.patientId, input.inviteeName, input.invitedBy, JSON.stringify(permissions), input.now.toISOString(), INVITATION_VALID_DAYS],
      )).rows[0];
      const invitation = toInvitation(row);
      await input.withCode(client, invitation);
      return invitation;
    });
  }

  async listOpenInvitations(patientId: string, now: Date): Promise<SharingInvitation[]> {
    const rows = (await this.pool.query(
      `SELECT * FROM sharing_invitations
       WHERE patient_id = $1::uuid AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > $2
       ORDER BY created_at`,
      [patientId, now.toISOString()],
    )).rows;
    return rows.map(toInvitation);
  }

  /** At sign-in: the invitations waiting for this e-mail (newest first). */
  async findOpenInvitationsByEmail(rawEmail: string, now: Date): Promise<SharingInvitation[]> {
    const rows = (await this.pool.query(
      `SELECT * FROM sharing_invitations
       WHERE email = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > $2
       ORDER BY created_at DESC`,
      [normalizeEmail(rawEmail), now.toISOString()],
    )).rows;
    return rows.map(toInvitation);
  }

  /**
   * The invitee accepts (once). The membership gets the invitation's permissions; remote bolus, when included, is
   * granted by the inviter and confirmed now only with confirmRemoteBolus (Face ID in the app), otherwise it waits for
   * confirmRemoteBolus. The inviter must still be an owner.
   */
  async acceptInvitation(input: { invitationId: string; userId: string; email: string; now: Date; confirmRemoteBolus: boolean }): Promise<PatientMember> {
    const email = normalizeEmail(input.email);
    const invitation = (await this.pool.query(`SELECT patient_id FROM sharing_invitations WHERE id = $1::uuid`, [input.invitationId])).rows[0];
    if (!invitation) throw new SharingError('INVITATION_NOT_FOUND');
    const patientId: string = invitation.patient_id;
    await this.inPatientLock(patientId, (client) =>
      insertMembershipFromInvitation(client, input.invitationId, input.userId, input.now, { email, confirmRemoteBolus: input.confirmRemoteBolus }));
    return (await this.getMember(patientId, input.userId)) as PatientMember;
  }

  async revokeInvitation(invitationId: string, actingUserId: string, now: Date): Promise<void> {
    const invitation = (await this.pool.query(`SELECT patient_id FROM sharing_invitations WHERE id = $1::uuid`, [invitationId])).rows[0];
    if (!invitation) throw new SharingError('INVITATION_NOT_FOUND');
    await this.inPatientLock(invitation.patient_id, async (client) => {
      await assertOwner(client, invitation.patient_id, actingUserId);
      const updated = await client.query(
        `UPDATE sharing_invitations SET revoked_at = $2 WHERE id = $1::uuid AND accepted_at IS NULL AND revoked_at IS NULL`,
        [invitationId, now.toISOString()],
      );
      if ((updated.rowCount ?? 0) === 0) throw new SharingError('INVITATION_CLOSED');
    });
  }

  /** The closed beta (isBetaAccessAllowed): allowlisted, invited (open or accepted) or already linked to a patient. */
  async isBetaAccessAllowed(rawEmail: string, allowlistEnabled: boolean, now: Date): Promise<boolean> {
    if (!allowlistEnabled) return true;
    const email = normalizeEmail(rawEmail);
    const row = (await this.pool.query<{ allowlisted: boolean; invited: boolean; member: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM beta_allowlist WHERE email = $1) AS allowlisted,
              EXISTS (SELECT 1 FROM sharing_invitations
                      WHERE email = $1 AND revoked_at IS NULL AND (accepted_at IS NOT NULL OR expires_at > $2)) AS invited,
              EXISTS (SELECT 1 FROM auth_identities ai JOIN caregiver_relationships r ON r.user_id = ai.user_id
                      WHERE lower(btrim(ai.email)) = $1) AS member`,
      [email, now.toISOString()],
    )).rows[0];
    return isBetaAccessAllowed(allowlistEnabled, row);
  }

  async addToBetaAllowlist(rawEmail: string, note: string | null = null): Promise<void> {
    await this.pool.query(`INSERT INTO beta_allowlist (email, note) VALUES ($1, $2) ON CONFLICT (email) DO NOTHING`, [normalizeEmail(rawEmail), note]);
  }

  async removeFromBetaAllowlist(rawEmail: string): Promise<void> {
    await this.pool.query(`DELETE FROM beta_allowlist WHERE email = $1`, [normalizeEmail(rawEmail)]);
  }

  private async inPatientLock<T>(patientId: string, work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT 1 FROM patients WHERE id = $1::uuid FOR UPDATE`, [patientId]);
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw translateDatabaseError(error);
    } finally {
      client.release();
    }
  }
}

/**
 * Accepts an invitation inside the caller's transaction (the patient row already locked): open, unexpired, the inviter
 * still an owner, the person not yet a member. The membership gets the invitation's permissions; remote bolus, when
 * included (and with the AI and meals), is granted by the inviter and counts only once confirmed. `email`: the Cognito
 * path's match; invitations by code (AUTH_MODE=device) have none.
 */
export async function insertMembershipFromInvitation(
  client: PoolClient,
  invitationId: string,
  userId: string,
  now: Date,
  options: { email?: string | null; confirmRemoteBolus?: boolean } = {},
): Promise<void> {
  const row = (await client.query(`SELECT * FROM sharing_invitations WHERE id = $1::uuid FOR UPDATE`, [invitationId])).rows[0];
  if (!row) throw new SharingError('INVITATION_NOT_FOUND');
  const patientId: string = row.patient_id;
  if (row.accepted_at || row.revoked_at) throw new SharingError('INVITATION_CLOSED');
  if (new Date(row.expires_at).getTime() <= now.getTime()) throw new SharingError('INVITATION_EXPIRED');
  if (options.email !== undefined && row.email !== options.email) throw new SharingError('INVITATION_EMAIL_MISMATCH');
  if (!(await isOwner(client, patientId, row.invited_by))) throw new SharingError('NOT_AN_OWNER');
  // Already a member (any relationship): an invitation never adds a second row or overwrites permissions (#20).
  const existing = await client.query(`SELECT 1 FROM caregiver_relationships WHERE patient_id = $1::uuid AND user_id = $2::uuid LIMIT 1`, [patientId, userId]);
  if ((existing.rowCount ?? 0) > 0) throw new SharingError('ALREADY_A_MEMBER');
  const permissions = parsePermissions(row.permissions);
  const remote = permissions.remote_commands && (permissions.ai_chat_meals || permissions.manage_sharing);
  const nowIso = now.toISOString();
  await client.query(
    `INSERT INTO caregiver_relationships (user_id, patient_id, relationship_type, permissions, is_owner,
                                          remote_bolus_granted_by, remote_bolus_granted_at, remote_bolus_confirmed_at)
     VALUES ($1::uuid, $2::uuid, $3, $4::jsonb, $5, $6::uuid, $7::timestamptz, $8::timestamptz)`,
    [
      userId,
      patientId,
      SHARED_RELATIONSHIP_TYPE,
      JSON.stringify({ ...permissions, remote_commands: remote }),
      permissions.manage_sharing,
      remote ? row.invited_by : null,
      remote ? new Date(row.created_at).toISOString() : null,
      remote && options.confirmRemoteBolus ? nowIso : null,
    ],
  );
  await client.query(`UPDATE sharing_invitations SET accepted_at = $2, accepted_by = $3::uuid WHERE id = $1::uuid`, [invitationId, nowIso, userId]);
}

async function isOwner(client: PoolClient, patientId: string, userId: string): Promise<boolean> {
  const result = await client.query(
    `SELECT 1 FROM caregiver_relationships WHERE patient_id = $1::uuid AND user_id = $2::uuid AND is_owner LIMIT 1`,
    [patientId, userId],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * After any change to a patient's people (audit #6): remote bolus grants that no longer hold are cleared — the granter
 * is not an owner any more, or the member lost "Rozmowy z AI i posiłki" — so they never come back without a new grant
 * and confirmation. Open invitations of people who are not owners any more are revoked.
 */
async function afterMembershipChange(client: PoolClient, patientId: string): Promise<void> {
  await client.query(
    `UPDATE caregiver_relationships r
     SET permissions = r.permissions || '{"remote_commands": false}'::jsonb,
         remote_bolus_granted_by = NULL, remote_bolus_granted_at = NULL, remote_bolus_confirmed_at = NULL, updated_at = now()
     WHERE r.patient_id = $1::uuid
       AND (r.remote_bolus_granted_at IS NOT NULL OR r.permissions->'remote_commands' = 'true'::jsonb)
       AND (
         NOT EXISTS (SELECT 1 FROM caregiver_relationships g WHERE g.patient_id = r.patient_id AND g.user_id = r.remote_bolus_granted_by AND g.is_owner)
         OR (NOT r.is_owner AND r.permissions->'ai_chat_meals' = 'false'::jsonb)
       )`,
    [patientId],
  );
  await client.query(
    `UPDATE sharing_invitations i SET revoked_at = now()
     WHERE i.patient_id = $1::uuid AND i.accepted_at IS NULL AND i.revoked_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM caregiver_relationships o WHERE o.patient_id = i.patient_id AND o.user_id = i.invited_by AND o.is_owner)`,
    [patientId],
  );
}

async function assertOwner(client: PoolClient, patientId: string, userId: string): Promise<void> {
  if (!(await isOwner(client, patientId, userId))) throw new SharingError('NOT_AN_OWNER');
}

/** Checked before commit too, so the caller gets LAST_OWNER rather than the deferred trigger's error. */
async function assertStillHasOwner(client: PoolClient, patientId: string): Promise<void> {
  const result = await client.query(`SELECT 1 FROM caregiver_relationships WHERE patient_id = $1::uuid AND is_owner LIMIT 1`, [patientId]);
  if ((result.rowCount ?? 0) === 0) throw new SharingError('LAST_OWNER');
}

function translateDatabaseError(error: unknown): unknown {
  if (error instanceof SharingError) return error;
  const message = (error as { message?: string })?.message ?? '';
  if (message.includes('PATIENT_NEEDS_AN_OWNER')) return new SharingError('LAST_OWNER');
  if (message.includes('REMOTE_BOLUS_GRANTER_NOT_OWNER')) return new SharingError('NOT_AN_OWNER');
  return error;
}

function iso(value: unknown): string | null {
  return value ? new Date(value as string).toISOString() : null;
}

function toMember(row: Record<string, any>): PatientMember {
  const permissions = parsePermissions(row.permissions);
  return {
    user_id: row.user_id,
    display_name: row.display_name,
    is_owner: row.is_owner,
    permissions: { ...permissions, manage_sharing: row.is_owner, remote_commands: row.remote_effective === true },
    remote_bolus: {
      granted_by: row.remote_bolus_granted_by ?? null,
      granted_at: iso(row.remote_bolus_granted_at),
      confirmed_at: iso(row.remote_bolus_confirmed_at),
      effective: row.remote_effective === true,
    },
  };
}

function toInvitation(row: Record<string, any>): SharingInvitation {
  return {
    id: row.id,
    patient_id: row.patient_id,
    email: row.email,
    invitee_name: row.invitee_name,
    invited_by: row.invited_by,
    permissions: parsePermissions(row.permissions),
    created_at: iso(row.created_at) as string,
    expires_at: iso(row.expires_at) as string,
    accepted_at: iso(row.accepted_at),
    accepted_by: row.accepted_by ?? null,
    revoked_at: iso(row.revoked_at),
  };
}
