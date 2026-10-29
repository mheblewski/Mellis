import type { Pool, PoolClient } from 'pg';
import { EFFECTIVE_REMOTE_COMMANDS_SQL } from './postgres-glucomind.repository';
import { insertMembershipFromInvitation } from './postgres-sharing.repository';

/**
 * AUTH_MODE=device storage (091_self_hosted_device_auth.sql, docs/device-auth-api.md): the server's setup state,
 * paired devices with their public keys, one-time pairing codes, single-use challenges and session tokens. Secrets
 * (codes, tokens, the recovery code) are stored only as SHA-256; the callers hash them.
 */

export type PairingPurpose = 'SETUP_OWNER' | 'ADD_DEVICE' | 'INVITATION' | 'RESET_OWNER';
export type ChallengePurpose = 'SESSION' | 'REMOTE_BOLUS' | 'REMOTE_BOLUS_CONFIRM' | 'BOLUS_KEY';

export interface DeviceRow {
  id: string;
  user_id: string;
  name: string;
  platform: 'ios';
  public_key: string;
  /** The Face ID bound bolus key; null until registered (092: a phone pairs with its device key alone). */
  bolus_public_key: string | null;
  bolus_key_registered_at: string | null;
  client_device_id: string | null;
  created_at: string;
  last_seen_at: string | null;
  revoked_at: string | null;
}

export interface NewDevice {
  name: string;
  publicKey: string;
  /** Only from an app that still pairs with both keys (pairing message v1). */
  bolusPublicKey: string | null;
  clientDeviceId: string | null;
}

export interface SetupState {
  completed_at: string | null;
  recovery_user_id: string | null;
  has_recovery_code: boolean;
}

export interface PairedDevice {
  device_id: string;
  user_id: string;
  purpose: PairingPurpose;
  /** INVITATION: the patient the person joined. */
  patient_id: string | null;
}

export class DeviceAuthError extends Error {
  constructor(
    readonly code:
      | 'SETUP_COMPLETED'
      | 'SETUP_NEEDS_PATIENT'
      | 'SETUP_NEEDS_OWNER'
      | 'PAIRING_CODE_INVALID'
      | 'DEVICE_ALREADY_PAIRED'
      | 'RECOVERY_CODE_INVALID'
      | 'DEVICE_NOT_FOUND'
      | 'NO_OWNER_TO_RESET'
      | 'CO_OWNER_NOT_ALLOWED'
      | 'NOT_AN_OWNER'
      | 'REMOTE_BOLUS_NOT_GRANTED'
      | 'HANDOFF_KEY_CHANGED',
  ) {
    super(code);
  }
}

/** Every permission (owners always hold them). */
const FULL_PERMISSIONS = { glucose_alerts: true, ai_chat_meals: true, manage_sharing: true, remote_commands: false };
const DEVICE_COLUMNS = 'id, user_id, name, platform, public_key, bolus_public_key, bolus_key_registered_at, client_device_id, created_at, last_seen_at, revoked_at';
/** last_seen_at is written at most this often per device. */
const LAST_SEEN_INTERVAL_SECONDS = 300;

export class PostgresDeviceAuthRepository {
  constructor(private readonly pool: Pool) {}

  async getSetupState(): Promise<SetupState> {
    const row = (await this.pool.query(`SELECT completed_at, recovery_user_id, recovery_code_hash IS NOT NULL AS has_recovery_code FROM server_setup WHERE id`)).rows[0];
    // The row is created by migration 091; a missing row (restored partial dump) counts as completed, never as open.
    if (!row) return { completed_at: new Date(0).toISOString(), recovery_user_id: null, has_recovery_code: false };
    return { completed_at: iso(row.completed_at), recovery_user_id: row.recovery_user_id ?? null, has_recovery_code: row.has_recovery_code === true };
  }

  async listPatients(): Promise<Array<{ patient_id: string; display_name: string; birth_year: number | null }>> {
    return (await this.pool.query(`SELECT id AS patient_id, display_name, birth_year FROM patients ORDER BY created_at, id`)).rows;
  }

  /**
   * A patient with its meal history and loop actions starting now (what deploy/sql/bootstrap-patient.sql did). With an
   * owner: that person owns it (the app's "Dodaj pacjenta"); during setup the pending first owner, when already named.
   * `coOwnerUserIds`: more owners, each already an owner of one of the owner's patients (CO_OWNER_NOT_ALLOWED
   * otherwise); they get every permission but remote bolus, which still needs its own grant and confirmation.
   * `remoteControlEnabled`: the patient's remote control switch (045) starts on; per-person grants still gate it.
   */
  async createPatient(input: {
    displayName: string;
    birthYear: number;
    ownerUserId?: string | null;
    onlyDuringSetup?: boolean;
    coOwnerUserIds?: string[];
    remoteControlEnabled?: boolean;
  }): Promise<{ patient_id: string }> {
    return this.inTransaction(async (client) => {
      const setup = (await client.query(`SELECT completed_at, recovery_user_id FROM server_setup WHERE id FOR UPDATE`)).rows[0];
      if (input.onlyDuringSetup && (!setup || setup.completed_at)) throw new DeviceAuthError('SETUP_COMPLETED');
      const owner = input.ownerUserId ?? (input.onlyDuringSetup ? setup?.recovery_user_id ?? null : null);
      const coOwners = input.coOwnerUserIds ?? [];
      if (coOwners.length > 0) {
        if (!owner || (await this.allowedCoOwners(client, owner, coOwners)).length !== coOwners.length) throw new DeviceAuthError('CO_OWNER_NOT_ALLOWED');
      }
      const patient = (await client.query<{ id: string }>(
        `INSERT INTO patients (display_name, birth_year, remote_control) VALUES ($1, $2, $3::jsonb) RETURNING id`,
        [input.displayName, input.birthYear, JSON.stringify({ enabled: input.remoteControlEnabled === true })],
      )).rows[0];
      await client.query(
        `INSERT INTO meal_history_epochs (patient_id, starts_at, assignment_policy_version, decided_by, note)
         VALUES ($1::uuid, now(), 'new-meal-assignment.v1', 'setup', 'meal history from the patient''s start')`,
        [patient.id],
      );
      await client.query(`INSERT INTO loop_action_epochs (patient_id, starts_at) VALUES ($1::uuid, now())`, [patient.id]);
      if (owner) await linkOwner(client, owner, patient.id);
      for (const coOwner of coOwners) await linkOwner(client, coOwner, patient.id);
      return { patient_id: patient.id };
    });
  }

  /**
   * Setup: names the first owner (created once, renamed on a repeat) as the owner of every patient, replaces any earlier
   * unused setup pairing code and stores the new recovery code. Only while the setup is open and there is a patient.
   */
  async prepareFirstOwner(input: { firstName: string; codeHash: string; recoveryCodeHash: string; expiresAt: Date }): Promise<{ user_id: string }> {
    return this.inTransaction(async (client) => {
      const setup = (await client.query(`SELECT completed_at, recovery_user_id FROM server_setup WHERE id FOR UPDATE`)).rows[0];
      if (!setup || setup.completed_at) throw new DeviceAuthError('SETUP_COMPLETED');
      const patients = (await client.query<{ id: string }>(`SELECT id FROM patients ORDER BY created_at, id`)).rows;
      if (patients.length === 0) throw new DeviceAuthError('SETUP_NEEDS_PATIENT');
      let userId: string | null = setup.recovery_user_id ?? null;
      if (userId) {
        const renamed = await client.query(`UPDATE users SET display_name = $2, updated_at = now() WHERE id = $1::uuid`, [userId, input.firstName]);
        if ((renamed.rowCount ?? 0) === 0) userId = null;
      }
      if (!userId) userId = (await client.query<{ id: string }>(`INSERT INTO users (display_name) VALUES ($1) RETURNING id`, [input.firstName])).rows[0].id;
      for (const patient of patients) await linkOwner(client, userId, patient.id);
      await client.query(`UPDATE device_pairing_codes SET expires_at = least(expires_at, now()) WHERE purpose = 'SETUP_OWNER' AND used_at IS NULL`);
      await client.query(
        `INSERT INTO device_pairing_codes (code_hash, purpose, user_id, expires_at) VALUES ($1, 'SETUP_OWNER', $2::uuid, $3)`,
        [input.codeHash, userId, input.expiresAt.toISOString()],
      );
      await client.query(
        `UPDATE server_setup SET recovery_user_id = $1::uuid, recovery_code_hash = $2, updated_at = now() WHERE id`,
        [userId, input.recoveryCodeHash],
      );
      return { user_id: userId };
    });
  }

  /**
   * Setup: a fresh pairing code for the first owner already named (POST /v1/setup/owner), e.g. for install-app.sh on the
   * Mac right before the app's first start. The recovery code stays; earlier unused setup codes stop working.
   */
  async createSetupOwnerPairingCode(input: { codeHash: string; expiresAt: Date }): Promise<{ user_id: string }> {
    return this.inTransaction(async (client) => {
      const setup = (await client.query(`SELECT completed_at, recovery_user_id FROM server_setup WHERE id FOR UPDATE`)).rows[0];
      if (!setup || setup.completed_at) throw new DeviceAuthError('SETUP_COMPLETED');
      if (!setup.recovery_user_id) throw new DeviceAuthError('SETUP_NEEDS_OWNER');
      await client.query(`UPDATE device_pairing_codes SET expires_at = least(expires_at, now()) WHERE purpose = 'SETUP_OWNER' AND used_at IS NULL`);
      await client.query(
        `INSERT INTO device_pairing_codes (code_hash, purpose, user_id, expires_at) VALUES ($1, 'SETUP_OWNER', $2::uuid, $3)`,
        [input.codeHash, setup.recovery_user_id, input.expiresAt.toISOString()],
      );
      return { user_id: setup.recovery_user_id };
    });
  }

  /**
   * `mellis` on the server: a new recovery code (the old one stops working) for the first owner, else the
   * longest-standing owner, who becomes the recovery person. Used after a restore of a server that never had one (a
   * Cognito-era backup). Finishes an open setup like reset-owner: the setup code is void from now on.
   */
  async replaceRecoveryCode(input: { recoveryCodeHash: string }): Promise<{ user_id: string; display_name: string }> {
    return this.inTransaction(async (client) => {
      const setup = (await client.query(`SELECT recovery_user_id FROM server_setup WHERE id FOR UPDATE`)).rows[0];
      const recoveryOwns = setup?.recovery_user_id
        ? (await client.query(`SELECT 1 FROM caregiver_relationships WHERE user_id = $1::uuid AND is_owner LIMIT 1`, [setup.recovery_user_id])).rowCount
        : 0;
      const userId: string | null = recoveryOwns ? setup.recovery_user_id : (await client.query<{ user_id: string }>(
        `SELECT user_id FROM caregiver_relationships WHERE is_owner ORDER BY created_at, user_id LIMIT 1`,
      )).rows[0]?.user_id ?? null;
      if (!userId) throw new DeviceAuthError('NO_OWNER_TO_RESET');
      await client.query(
        `INSERT INTO server_setup (id, completed_at, recovery_user_id, recovery_code_hash) VALUES (true, now(), $1::uuid, $2)
         ON CONFLICT (id) DO UPDATE SET completed_at = COALESCE(server_setup.completed_at, now()), recovery_user_id = $1::uuid,
           recovery_code_hash = $2, updated_at = now()`,
        [userId, input.recoveryCodeHash],
      );
      const name = (await client.query<{ display_name: string | null }>(`SELECT display_name FROM users WHERE id = $1::uuid`, [userId])).rows[0]?.display_name ?? '';
      return { user_id: userId, display_name: name };
    });
  }

  /** Every patient with its stored Nightscout address and newest reading (the server tool's lists). */
  async listPatientSources(): Promise<Array<{ patient_id: string; display_name: string; birth_year: number | null; nightscout_url: string | null; has_token: boolean; last_reading_at: string | null }>> {
    const rows = (await this.pool.query(
      `SELECT p.id AS patient_id, p.display_name, p.birth_year,
              s.base_url AS nightscout_url, (s.api_token_ciphertext IS NOT NULL) AS has_token,
              (SELECT max(e.occurred_at) FROM events e WHERE e.patient_id = p.id AND e.type = 'GLUCOSE_READING_AVAILABLE') AS last_reading_at
         FROM patients p
         LEFT JOIN LATERAL (SELECT base_url, api_token_ciphertext FROM sources
                             WHERE patient_id = p.id AND source_system = 'NIGHTSCOUT'
                             ORDER BY (api_token_ciphertext IS NOT NULL) DESC, created_at DESC LIMIT 1) s ON true
        ORDER BY p.created_at, p.id`,
    )).rows;
    return rows.map((row) => ({
      patient_id: row.patient_id,
      display_name: row.display_name,
      birth_year: row.birth_year ?? null,
      nightscout_url: row.nightscout_url ?? null,
      has_token: row.has_token === true,
      last_reading_at: row.last_reading_at ? new Date(row.last_reading_at).toISOString() : null,
    }));
  }

  /**
   * Pairs a phone with a one-time code (single use, not expired): SETUP_OWNER completes the setup (the setup code is
   * void from then on), INVITATION creates the person and their membership, ADD_DEVICE / RESET_OWNER pair into an
   * existing person. All in one transaction: a code is never used twice and never half-applied.
   */
  async pairWithCode(input: { codeHash: string; device: NewDevice; firstName: string | null; now: Date }): Promise<PairedDevice> {
    return this.inTransaction(async (client) => {
      const code = (await client.query(`SELECT * FROM device_pairing_codes WHERE code_hash = $1 FOR UPDATE`, [input.codeHash])).rows[0];
      if (!code || code.used_at || new Date(code.expires_at).getTime() <= input.now.getTime()) throw new DeviceAuthError('PAIRING_CODE_INVALID');
      let userId: string | null = code.user_id ?? null;
      let patientId: string | null = null;
      if (code.purpose === 'SETUP_OWNER') {
        const setup = (await client.query(`SELECT completed_at FROM server_setup WHERE id FOR UPDATE`)).rows[0];
        if (!setup || setup.completed_at) throw new DeviceAuthError('PAIRING_CODE_INVALID');
        await client.query(`UPDATE server_setup SET completed_at = $1, updated_at = now() WHERE id`, [input.now.toISOString()]);
      }
      if (code.purpose === 'INVITATION') {
        const invitation = (await client.query(`SELECT * FROM sharing_invitations WHERE id = $1::uuid`, [code.invitation_id])).rows[0];
        if (!invitation) throw new DeviceAuthError('PAIRING_CODE_INVALID');
        await client.query(`SELECT 1 FROM patients WHERE id = $1::uuid FOR UPDATE`, [invitation.patient_id]);
        const name = (input.firstName ?? '').trim() || String(invitation.invitee_name ?? '').trim();
        // A withdrawn, expired or used invitation is just an invalid code to the phone.
        if (invitation.accepted_at || invitation.revoked_at || new Date(invitation.expires_at).getTime() <= input.now.getTime()) throw new DeviceAuthError('PAIRING_CODE_INVALID');
        userId = (await client.query<{ id: string }>(`INSERT INTO users (display_name) VALUES ($1) RETURNING id`, [name])).rows[0].id;
        await insertMembershipFromInvitation(client, invitation.id, userId, input.now);
        patientId = invitation.patient_id;
      }
      if (!userId) throw new DeviceAuthError('PAIRING_CODE_INVALID');
      const deviceId = await insertDevice(client, userId, input.device);
      await client.query(`UPDATE device_pairing_codes SET used_at = $2, used_by_device_id = $3::uuid WHERE id = $1::uuid`, [code.id, input.now.toISOString(), deviceId]);
      return { device_id: deviceId, user_id: userId, purpose: code.purpose, patient_id: patientId };
    });
  }

  /** A person already paired joins another patient with an invitation code. */
  async acceptInvitationCode(input: { codeHash: string; userId: string; deviceId: string; now: Date }): Promise<{ patient_id: string }> {
    return this.inTransaction(async (client) => {
      const code = (await client.query(`SELECT * FROM device_pairing_codes WHERE code_hash = $1 FOR UPDATE`, [input.codeHash])).rows[0];
      if (!code || code.purpose !== 'INVITATION' || code.used_at || new Date(code.expires_at).getTime() <= input.now.getTime()) throw new DeviceAuthError('PAIRING_CODE_INVALID');
      const invitation = (await client.query(`SELECT id, patient_id FROM sharing_invitations WHERE id = $1::uuid`, [code.invitation_id])).rows[0];
      if (!invitation) throw new DeviceAuthError('PAIRING_CODE_INVALID');
      await client.query(`SELECT 1 FROM patients WHERE id = $1::uuid FOR UPDATE`, [invitation.patient_id]);
      await insertMembershipFromInvitation(client, invitation.id, input.userId, input.now);
      await client.query(`UPDATE device_pairing_codes SET used_at = $2, used_by_device_id = $3::uuid WHERE id = $1::uuid`, [code.id, input.now.toISOString(), input.deviceId]);
      return { patient_id: invitation.patient_id };
    });
  }

  async createPairingCode(input: { purpose: Exclude<PairingPurpose, 'INVITATION' | 'SETUP_OWNER'>; userId: string; createdBy: string | null; codeHash: string; expiresAt: Date }): Promise<void> {
    await this.pool.query(
      `INSERT INTO device_pairing_codes (code_hash, purpose, user_id, created_by, expires_at) VALUES ($1, $2, $3::uuid, $4::uuid, $5)`,
      [input.codeHash, input.purpose, input.userId, input.createdBy, input.expiresAt.toISOString()],
    );
  }

  /** The invitation's code (its expiry is the invitation's). */
  async createInvitationCode(client: PoolClient, input: { invitationId: string; createdBy: string; codeHash: string; expiresAt: string }): Promise<void> {
    await client.query(
      `INSERT INTO device_pairing_codes (code_hash, purpose, invitation_id, created_by, expires_at) VALUES ($1, 'INVITATION', $2::uuid, $3::uuid, $4)`,
      [input.codeHash, input.invitationId, input.createdBy, input.expiresAt],
    );
  }

  /**
   * Recovery: the code shown once at setup pairs a new phone into the first owner (while they still own a patient)
   * and is replaced by a new one in the same step.
   */
  async recoverOwner(input: { recoveryCodeHash: string; newRecoveryCodeHash: string; device: NewDevice; now: Date }): Promise<PairedDevice> {
    return this.inTransaction(async (client) => {
      const setup = (await client.query(`SELECT completed_at, recovery_user_id, recovery_code_hash FROM server_setup WHERE id FOR UPDATE`)).rows[0];
      if (!setup?.completed_at || !setup.recovery_code_hash || setup.recovery_code_hash !== input.recoveryCodeHash || !setup.recovery_user_id) {
        throw new DeviceAuthError('RECOVERY_CODE_INVALID');
      }
      const owns = await client.query(`SELECT 1 FROM caregiver_relationships WHERE user_id = $1::uuid AND is_owner LIMIT 1`, [setup.recovery_user_id]);
      if ((owns.rowCount ?? 0) === 0) throw new DeviceAuthError('RECOVERY_CODE_INVALID');
      const deviceId = await insertDevice(client, setup.recovery_user_id, input.device);
      await client.query(`UPDATE server_setup SET recovery_code_hash = $1, updated_at = now() WHERE id`, [input.newRecoveryCodeHash]);
      return { device_id: deviceId, user_id: setup.recovery_user_id, purpose: 'RESET_OWNER', patient_id: null };
    });
  }

  /**
   * `reset-owner` on the server (shell access = owner): a pairing code for an owner. With a name, a new person becomes
   * the owner of every patient; otherwise the first owner (the recovery person), else the longest-standing owner.
   */
  async prepareResetOwner(input: { firstName: string | null; codeHash: string; expiresAt: Date }): Promise<{ user_id: string; display_name: string }> {
    return this.inTransaction(async (client) => {
      const setup = (await client.query(`SELECT recovery_user_id FROM server_setup WHERE id FOR UPDATE`)).rows[0];
      let userId: string | null = null;
      if (input.firstName) {
        const patients = (await client.query<{ id: string }>(`SELECT id FROM patients ORDER BY created_at, id`)).rows;
        if (patients.length === 0) throw new DeviceAuthError('SETUP_NEEDS_PATIENT');
        userId = (await client.query<{ id: string }>(`INSERT INTO users (display_name) VALUES ($1) RETURNING id`, [input.firstName])).rows[0].id;
        for (const patient of patients) await linkOwner(client, userId, patient.id);
      } else {
        const recovery = setup?.recovery_user_id
          ? (await client.query(`SELECT 1 FROM caregiver_relationships WHERE user_id = $1::uuid AND is_owner LIMIT 1`, [setup.recovery_user_id])).rowCount
          : 0;
        userId = recovery ? setup.recovery_user_id : (await client.query<{ user_id: string }>(
          `SELECT user_id FROM caregiver_relationships WHERE is_owner ORDER BY created_at, user_id LIMIT 1`,
        )).rows[0]?.user_id ?? null;
      }
      if (!userId) throw new DeviceAuthError('NO_OWNER_TO_RESET');
      await client.query(
        `INSERT INTO device_pairing_codes (code_hash, purpose, user_id, expires_at) VALUES ($1, 'RESET_OWNER', $2::uuid, $3)`,
        [input.codeHash, userId, input.expiresAt.toISOString()],
      );
      // A server that never finished its setup is finished by the owner's reset: the setup code is void from now on.
      await client.query(`UPDATE server_setup SET completed_at = COALESCE(completed_at, now()), recovery_user_id = COALESCE(recovery_user_id, $1::uuid), updated_at = now() WHERE id`, [userId]);
      const name = (await client.query<{ display_name: string }>(`SELECT display_name FROM users WHERE id = $1::uuid`, [userId])).rows[0].display_name;
      return { user_id: userId, display_name: name };
    });
  }

  /**
   * Of `candidates`, the people who own at least one patient `ownerUserId` owns (who "Dodaj pacjenta" may make
   * co-owners). The owner themself never counts.
   */
  async allowedCoOwners(client: Pool | PoolClient, ownerUserId: string, candidates: string[]): Promise<string[]> {
    const ids = candidates.filter((id) => UUID.test(id));
    if (ids.length === 0) return [];
    const rows = (await client.query<{ user_id: string }>(
      `SELECT DISTINCT o.user_id
       FROM caregiver_relationships mine
       JOIN caregiver_relationships o ON o.patient_id = mine.patient_id AND o.is_owner
       WHERE mine.user_id = $1::uuid AND mine.is_owner AND o.user_id <> $1::uuid AND o.user_id = ANY($2::uuid[])`,
      [ownerUserId, ids],
    )).rows;
    return rows.map((row) => row.user_id);
  }

  /** "Dodaj też współwłaścicieli": the owners of the caller's own patients, each with the patients they own. */
  async listCoOwnerCandidates(ownerUserId: string): Promise<Array<{ user_id: string; display_name: string; patients: Array<{ patient_id: string; display_name: string }> }>> {
    const rows = (await this.pool.query<{ user_id: string; display_name: string; patient_id: string; patient_name: string }>(
      `SELECT DISTINCT o.user_id, u.display_name, p.id AS patient_id, p.display_name AS patient_name
       FROM caregiver_relationships mine
       JOIN caregiver_relationships o ON o.patient_id = mine.patient_id AND o.is_owner AND o.user_id <> mine.user_id
       JOIN users u ON u.id = o.user_id
       JOIN patients p ON p.id = o.patient_id
       WHERE mine.user_id = $1::uuid AND mine.is_owner
       ORDER BY u.display_name, o.user_id, p.display_name`,
      [ownerUserId],
    )).rows;
    const people = new Map<string, { user_id: string; display_name: string; patients: Array<{ patient_id: string; display_name: string }> }>();
    for (const row of rows) {
      const person = people.get(row.user_id) ?? { user_id: row.user_id, display_name: row.display_name, patients: [] };
      person.patients.push({ patient_id: row.patient_id, display_name: row.patient_name });
      people.set(row.user_id, person);
    }
    return [...people.values()];
  }

  /** Registers (or replaces) the device's bolus key; false for a revoked or unknown device. */
  async registerBolusKey(input: { deviceId: string; bolusPublicKey: string; now: Date }): Promise<boolean> {
    try {
      const updated = await this.pool.query(
        `UPDATE devices SET bolus_public_key = $2, bolus_key_registered_at = $3 WHERE id = $1::uuid AND revoked_at IS NULL`,
        [input.deviceId, input.bolusPublicKey, input.now.toISOString()],
      );
      return (updated.rowCount ?? 0) > 0;
    } catch (error) {
      throw translate(error);
    }
  }

  /** Remote bolus counts for this person and patient: granted by a current owner and confirmed (EFFECTIVE_REMOTE_COMMANDS_SQL). */
  async hasEffectiveRemoteBolus(userId: string, patientId: string): Promise<boolean> {
    if (!UUID.test(patientId)) return false;
    const result = await this.pool.query(
      `SELECT 1 FROM caregiver_relationships r WHERE r.user_id = $1::uuid AND r.patient_id = $2::uuid AND ${EFFECTIVE_REMOTE_COMMANDS_SQL} LIMIT 1`,
      [userId, patientId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /** The patient's Nightscout address and newest glucose reading (Settings → the patient's page). */
  async getNightscoutSummary(patientId: string): Promise<{ base_url: string | null; last_reading_at: string | null }> {
    if (!UUID.test(patientId)) return { base_url: null, last_reading_at: null };
    const row = (await this.pool.query<{ base_url: string | null; last_reading_at: Date | null }>(
      `SELECT (SELECT s.base_url FROM sources s WHERE s.patient_id = $1::uuid AND s.source_system = 'NIGHTSCOUT'
               ORDER BY (s.api_token_ciphertext IS NOT NULL) DESC, s.created_at DESC LIMIT 1) AS base_url,
              (SELECT max(e.occurred_at) FROM events e WHERE e.patient_id = $1::uuid AND e.type = 'GLUCOSE_READING_AVAILABLE') AS last_reading_at`,
      [patientId],
    )).rows[0];
    return { base_url: row?.base_url ?? null, last_reading_at: iso(row?.last_reading_at) };
  }

  async getDevice(deviceId: string): Promise<DeviceRow | null> {
    if (!UUID.test(deviceId)) return null;
    const row = (await this.pool.query(`SELECT ${DEVICE_COLUMNS} FROM devices WHERE id = $1::uuid`, [deviceId])).rows[0];
    return row ? toDevice(row) : null;
  }

  async createChallenge(input: { deviceId: string; purpose: ChallengePurpose; patientId: string | null; nonce: string; expiresAt: Date }): Promise<{ challenge_id: string } | null> {
    const row = (await this.pool.query<{ id: string }>(
      `INSERT INTO device_challenges (device_id, purpose, patient_id, nonce, expires_at)
       SELECT d.id, $2, $3::uuid, $4, $5 FROM devices d WHERE d.id = $1::uuid AND d.revoked_at IS NULL
       RETURNING id`,
      [input.deviceId, input.purpose, input.patientId, input.nonce, input.expiresAt.toISOString()],
    )).rows[0];
    // Old challenges go along the way (they are single use and short-lived anyway).
    await this.pool.query(`DELETE FROM device_challenges WHERE expires_at < now() - interval '1 hour'`);
    return row ? { challenge_id: row.id } : null;
  }

  /** Uses a challenge once: its nonce while unused, unexpired and issued to this device for this purpose; else null. */
  async consumeChallenge(input: { challengeId: string; deviceId: string; purpose: ChallengePurpose; patientId: string | null; now: Date }): Promise<string | null> {
    if (!UUID.test(input.challengeId)) return null;
    const row = (await this.pool.query<{ nonce: string }>(
      `UPDATE device_challenges SET used_at = $5
       WHERE id = $1::uuid AND device_id = $2::uuid AND purpose = $3 AND patient_id IS NOT DISTINCT FROM $4::uuid
         AND used_at IS NULL AND expires_at > $5
       RETURNING nonce`,
      [input.challengeId, input.deviceId, input.purpose, input.patientId, input.now.toISOString()],
    )).rows[0];
    return row?.nonce ?? null;
  }

  async createSession(input: { deviceId: string; tokenHash: string; expiresAt: Date }): Promise<void> {
    await this.pool.query(`INSERT INTO device_sessions (token_hash, device_id, expires_at) VALUES ($1, $2::uuid, $3)`, [input.tokenHash, input.deviceId, input.expiresAt.toISOString()]);
    await this.pool.query(`UPDATE devices SET last_seen_at = now() WHERE id = $1::uuid`, [input.deviceId]);
    await this.pool.query(`DELETE FROM device_sessions WHERE expires_at < now() - interval '1 hour'`);
  }

  /** The device and person behind a session token: unexpired, device not revoked. */
  async resolveSession(tokenHash: string, now: Date): Promise<{ device_id: string; user_id: string } | null> {
    const row = (await this.pool.query<{ device_id: string; user_id: string; stale: boolean }>(
      `SELECT d.id AS device_id, d.user_id,
              (d.last_seen_at IS NULL OR d.last_seen_at < $2::timestamptz - make_interval(secs => ${LAST_SEEN_INTERVAL_SECONDS})) AS stale
       FROM device_sessions s JOIN devices d ON d.id = s.device_id
       WHERE s.token_hash = $1 AND s.expires_at > $2 AND d.revoked_at IS NULL`,
      [tokenHash, now.toISOString()],
    )).rows[0];
    if (!row) return null;
    if (row.stale) await this.pool.query(`UPDATE devices SET last_seen_at = $2 WHERE id = $1::uuid`, [row.device_id, now.toISOString()]);
    return { device_id: row.device_id, user_id: row.user_id };
  }

  async listDevicesOfUser(userId: string, includeRevoked = false): Promise<DeviceRow[]> {
    const rows = (await this.pool.query(
      `SELECT ${DEVICE_COLUMNS} FROM devices WHERE user_id = $1::uuid AND ($2 OR revoked_at IS NULL) ORDER BY created_at`,
      [userId, includeRevoked],
    )).rows;
    return rows.map(toDevice);
  }

  /** The paired devices of everyone with access to the patient (owners see them per person). */
  async listDevicesOfPatientMembers(patientId: string): Promise<DeviceRow[]> {
    const rows = (await this.pool.query(
      `SELECT ${DEVICE_COLUMNS.split(', ').map((column) => `d.${column}`).join(', ')}
       FROM devices d WHERE d.revoked_at IS NULL
         AND EXISTS (SELECT 1 FROM caregiver_relationships r WHERE r.user_id = d.user_id AND r.patient_id = $1::uuid)
       ORDER BY d.created_at`,
      [patientId],
    )).rows;
    return rows.map(toDevice);
  }

  /** Revokes a device: its sessions end at once and its push rows stop. False when already revoked or unknown. */
  async revokeDevice(input: { deviceId: string; revokedBy: string; now: Date }): Promise<boolean> {
    return this.inTransaction(async (client) => {
      const device = (await client.query(
        `UPDATE devices SET revoked_at = $2, revoked_by = $3::uuid WHERE id = $1::uuid AND revoked_at IS NULL RETURNING user_id, client_device_id`,
        [input.deviceId, input.now.toISOString(), input.revokedBy],
      )).rows[0];
      if (!device) return false;
      await client.query(`DELETE FROM device_sessions WHERE device_id = $1::uuid`, [input.deviceId]);
      await client.query(`DELETE FROM device_challenges WHERE device_id = $1::uuid`, [input.deviceId]);
      if (device.client_device_id) {
        await client.query(
          `UPDATE patient_devices SET active = false, updated_at = now() WHERE user_id = $1::uuid AND device_id = $2 AND active`,
          [device.user_id, device.client_device_id],
        );
      }
      return true;
    });
  }

  /** The signed payload and confirmation a device-mode remote command came with (for the audit trail). */
  async recordCommandAuthorization(commandId: string, authorization: Record<string, unknown>): Promise<void> {
    await this.pool.query(`UPDATE remote_commands SET device_authorization = $2::jsonb WHERE id = $1::uuid`, [commandId, JSON.stringify(authorization)]);
  }

  async getPatientDisplayName(patientId: string): Promise<string | null> {
    if (!UUID.test(patientId)) return null;
    return (await this.pool.query<{ display_name: string }>(`SELECT display_name FROM patients WHERE id = $1::uuid`, [patientId])).rows[0]?.display_name ?? null;
  }

  async getUserDisplayName(userId: string): Promise<string | null> {
    return (await this.pool.query<{ display_name: string }>(`SELECT display_name FROM users WHERE id = $1::uuid`, [userId])).rows[0]?.display_name ?? null;
  }

  async isOwnerOf(userId: string, patientId: string): Promise<boolean> {
    if (!UUID.test(patientId)) return false;
    const result = await this.pool.query(`SELECT 1 FROM caregiver_relationships WHERE user_id = $1::uuid AND patient_id = $2::uuid AND is_owner LIMIT 1`, [userId, patientId]);
    return (result.rowCount ?? 0) > 0;
  }

  async isMemberOf(userId: string, patientId: string): Promise<boolean> {
    if (!UUID.test(patientId)) return false;
    const result = await this.pool.query(`SELECT 1 FROM caregiver_relationships WHERE user_id = $1::uuid AND patient_id = $2::uuid LIMIT 1`, [userId, patientId]);
    return (result.rowCount ?? 0) > 0;
  }

  // Remote settings hand-off (093, step 2) -----------------------------------------------------------------------------

  /** Granted remote bolus by a current owner, confirmed or still waiting for the person's confirmation. */
  async hasRemoteBolusGrant(client: Pool | PoolClient, userId: string, patientId: string): Promise<boolean> {
    if (!UUID.test(patientId) || !UUID.test(userId)) return false;
    const result = await client.query(
      `SELECT 1 FROM caregiver_relationships r WHERE r.user_id = $1::uuid AND r.patient_id = $2::uuid AND ${GRANTED_REMOTE_BOLUS_SQL} LIMIT 1`,
      [userId, patientId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Stores one encrypted package per recipient device, replacing any still unfetched package of this patient for that
   * device (the newest settings win). Re-checks in the transaction: the sender owns the patient, the recipient has a
   * grant, each device is the recipient's, paired, and its key of `recipient_key` is the one it has now.
   */
  async createRemoteSettingsHandoffs(input: {
    patientId: string;
    fromUserId: string;
    fromDeviceId: string;
    toUserId: string;
    loopKind: 'trio' | 'loop';
    packages: Array<{ toDeviceId: string; recipientKey: 'bolus' | 'device'; ciphertext: Buffer; senderSignature: string }>;
    now: Date;
    expiresAt: Date;
  }): Promise<Array<{ handoff_id: string; to_device_id: string; recipient_key: string; created_at: string; expires_at: string }>> {
    return this.inTransaction(async (client) => {
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('remote_settings_handoffs:' || $1))`, [input.patientId]);
      const owner = await client.query(`SELECT 1 FROM caregiver_relationships WHERE user_id = $1::uuid AND patient_id = $2::uuid AND is_owner LIMIT 1`, [input.fromUserId, input.patientId]);
      if ((owner.rowCount ?? 0) === 0) throw new DeviceAuthError('NOT_AN_OWNER');
      if (!(await this.hasRemoteBolusGrant(client, input.toUserId, input.patientId))) throw new DeviceAuthError('REMOTE_BOLUS_NOT_GRANTED');
      const created = [];
      for (const pkg of input.packages) {
        const device = (await client.query(`SELECT ${DEVICE_COLUMNS} FROM devices WHERE id = $1::uuid FOR SHARE`, [pkg.toDeviceId])).rows[0];
        if (!device || device.user_id !== input.toUserId || device.revoked_at) throw new DeviceAuthError('DEVICE_NOT_FOUND');
        if (pkg.recipientKey === 'bolus' ? !device.bolus_public_key : !!device.bolus_public_key) throw new DeviceAuthError('HANDOFF_KEY_CHANGED');
        await client.query(`DELETE FROM remote_settings_handoffs WHERE patient_id = $1::uuid AND to_device_id = $2::uuid AND consumed_at IS NULL`, [input.patientId, pkg.toDeviceId]);
        const row = (await client.query(
          `INSERT INTO remote_settings_handoffs (patient_id, from_user_id, from_device_id, to_user_id, to_device_id, loop_kind, recipient_key, ciphertext, sender_signature, created_at, expires_at)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, $7, $8, $9, $10, $11)
           RETURNING id, to_device_id, recipient_key, created_at, expires_at`,
          [input.patientId, input.fromUserId, input.fromDeviceId, input.toUserId, pkg.toDeviceId, input.loopKind, pkg.recipientKey, pkg.ciphertext, pkg.senderSignature, input.now.toISOString(), input.expiresAt.toISOString()],
        )).rows[0];
        created.push({ handoff_id: row.id, to_device_id: row.to_device_id, recipient_key: row.recipient_key, created_at: iso(row.created_at) as string, expires_at: iso(row.expires_at) as string });
      }
      return created;
    });
  }

  /**
   * Packages waiting for this device (not fetched, not expired), only while its person still has a remote bolus grant
   * for the patient and the sender still owns it. No ciphertext here: GET lists, POST …/consume fetches once.
   */
  async listPendingHandoffsForDevice(deviceId: string, now: Date): Promise<HandoffRow[]> {
    await this.purgeExpiredHandoffs(now);
    const rows = (await this.pool.query(
      `SELECT ${HANDOFF_COLUMNS} FROM remote_settings_handoffs h ${HANDOFF_JOINS}
       WHERE h.to_device_id = $1::uuid AND h.consumed_at IS NULL AND h.expires_at > $2 AND ${HANDOFF_STILL_VALID_SQL}
       ORDER BY h.created_at DESC`,
      [deviceId, now.toISOString()],
    )).rows;
    return rows.map(toHandoff);
  }

  /** Fetches a package once: its ciphertext and signature, which are dropped in the same statement. Null otherwise. */
  async consumeHandoff(input: { handoffId: string; deviceId: string; now: Date }): Promise<(HandoffRow & { ciphertext: string; sender_signature: string }) | null> {
    if (!UUID.test(input.handoffId)) return null;
    return this.inTransaction(async (client) => {
      const row = (await client.query(
        `SELECT ${HANDOFF_COLUMNS}, h.ciphertext, h.sender_signature FROM remote_settings_handoffs h ${HANDOFF_JOINS}
         WHERE h.id = $1::uuid AND h.to_device_id = $2::uuid AND h.consumed_at IS NULL AND h.expires_at > $3 AND ${HANDOFF_STILL_VALID_SQL}
         FOR UPDATE OF h`,
        [input.handoffId, input.deviceId, input.now.toISOString()],
      )).rows[0];
      if (!row) return null;
      await client.query(`UPDATE remote_settings_handoffs SET consumed_at = $2, ciphertext = NULL, sender_signature = NULL WHERE id = $1::uuid`, [input.handoffId, input.now.toISOString()]);
      return { ...toHandoff(row), ciphertext: (row.ciphertext as Buffer).toString('base64'), sender_signature: row.sender_signature as string };
    });
  }

  /** The recipient's "Odrzuć": deletes an unfetched package addressed to this device. */
  async rejectHandoff(input: { handoffId: string; deviceId: string }): Promise<boolean> {
    if (!UUID.test(input.handoffId)) return false;
    const deleted = await this.pool.query(`DELETE FROM remote_settings_handoffs WHERE id = $1::uuid AND to_device_id = $2::uuid AND consumed_at IS NULL`, [input.handoffId, input.deviceId]);
    return (deleted.rowCount ?? 0) > 0;
  }

  /** An owner's view of the patient's packages (waiting or fetched, until they expire), without any ciphertext. */
  async listHandoffsOfPatient(patientId: string, now: Date): Promise<HandoffRow[]> {
    if (!UUID.test(patientId)) return [];
    await this.purgeExpiredHandoffs(now);
    const rows = (await this.pool.query(
      `SELECT ${HANDOFF_COLUMNS} FROM remote_settings_handoffs h ${HANDOFF_JOINS}
       WHERE h.patient_id = $1::uuid AND h.expires_at > $2 ORDER BY h.created_at DESC`,
      [patientId, now.toISOString()],
    )).rows;
    return rows.map(toHandoff);
  }

  /** An owner withdraws a package not fetched yet. */
  async revokeHandoff(input: { patientId: string; handoffId: string }): Promise<boolean> {
    if (!UUID.test(input.handoffId) || !UUID.test(input.patientId)) return false;
    const deleted = await this.pool.query(`DELETE FROM remote_settings_handoffs WHERE id = $1::uuid AND patient_id = $2::uuid AND consumed_at IS NULL`, [input.handoffId, input.patientId]);
    return (deleted.rowCount ?? 0) > 0;
  }

  private async purgeExpiredHandoffs(now: Date): Promise<void> {
    await this.pool.query(`DELETE FROM remote_settings_handoffs WHERE expires_at <= $1`, [now.toISOString()]);
  }

  async inTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw translate(error);
    } finally {
      client.release();
    }
  }
}

/** A remote bolus grant from a current owner (confirmed or not) of a member who has the AI and meals (or owns). */
const GRANTED_REMOTE_BOLUS_SQL = `(
  (r.is_owner OR r.permissions->'ai_chat_meals' = 'true'::jsonb)
  AND r.permissions->'remote_commands' = 'true'::jsonb AND r.remote_bolus_granted_at IS NOT NULL
  AND EXISTS (SELECT 1 FROM caregiver_relationships g WHERE g.patient_id = r.patient_id AND g.user_id = r.remote_bolus_granted_by AND g.is_owner)
)`;

export interface HandoffRow {
  handoff_id: string;
  patient_id: string;
  patient_name: string;
  from_user_id: string;
  from_name: string;
  from_device_id: string;
  /** The sender device's key, for the recipient to check the signature (base64 X9.63). */
  from_device_public_key: string;
  to_user_id: string;
  to_name: string;
  to_device_id: string;
  to_device_name: string;
  loop_kind: 'trio' | 'loop';
  recipient_key: 'bolus' | 'device';
  created_at: string;
  expires_at: string;
  consumed_at: string | null;
}

const HANDOFF_COLUMNS = `h.id, h.patient_id, p.display_name AS patient_name, h.from_user_id, fu.display_name AS from_name, h.from_device_id,
  fd.public_key AS from_device_public_key, h.to_user_id, tu.display_name AS to_name, h.to_device_id, td.name AS to_device_name,
  h.loop_kind, h.recipient_key, h.created_at, h.expires_at, h.consumed_at`;
const HANDOFF_JOINS = `JOIN patients p ON p.id = h.patient_id JOIN users fu ON fu.id = h.from_user_id JOIN devices fd ON fd.id = h.from_device_id
  JOIN users tu ON tu.id = h.to_user_id JOIN devices td ON td.id = h.to_device_id`;
/**
 * Delivered only while the sender still owns the patient, both phones are paired and the recipient keeps the grant the
 * package was sent under (one sent before the grant was taken away and given again is not delivered).
 */
const HANDOFF_STILL_VALID_SQL = `fd.revoked_at IS NULL AND td.revoked_at IS NULL
  AND EXISTS (SELECT 1 FROM caregiver_relationships o WHERE o.patient_id = h.patient_id AND o.user_id = h.from_user_id AND o.is_owner)
  AND EXISTS (SELECT 1 FROM caregiver_relationships r WHERE r.patient_id = h.patient_id AND r.user_id = h.to_user_id AND ${GRANTED_REMOTE_BOLUS_SQL}
              AND h.created_at >= r.remote_bolus_granted_at)
  AND (CASE h.recipient_key WHEN 'bolus' THEN td.bolus_public_key IS NOT NULL ELSE true END)`;

function toHandoff(row: Record<string, any>): HandoffRow {
  return {
    handoff_id: row.id,
    patient_id: row.patient_id,
    patient_name: row.patient_name,
    from_user_id: row.from_user_id,
    from_name: row.from_name,
    from_device_id: row.from_device_id,
    from_device_public_key: row.from_device_public_key,
    to_user_id: row.to_user_id,
    to_name: row.to_name,
    to_device_id: row.to_device_id,
    to_device_name: row.to_device_name,
    loop_kind: row.loop_kind,
    recipient_key: row.recipient_key,
    created_at: iso(row.created_at) as string,
    expires_at: iso(row.expires_at) as string,
    consumed_at: iso(row.consumed_at),
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function linkOwner(client: PoolClient, userId: string, patientId: string): Promise<void> {
  await client.query(
    `INSERT INTO caregiver_relationships (user_id, patient_id, relationship_type, permissions, is_owner)
     VALUES ($1::uuid, $2::uuid, 'primary_caregiver', $3::jsonb, true)
     ON CONFLICT (user_id, patient_id, relationship_type) DO UPDATE SET is_owner = true, permissions = caregiver_relationships.permissions || $3::jsonb - 'remote_commands', updated_at = now()`,
    [userId, patientId, JSON.stringify(FULL_PERMISSIONS)],
  );
}

async function insertDevice(client: PoolClient, userId: string, device: NewDevice): Promise<string> {
  const row = (await client.query<{ id: string }>(
    `INSERT INTO devices (user_id, name, public_key, bolus_public_key, bolus_key_registered_at, client_device_id, last_seen_at)
     VALUES ($1::uuid, $2, $3, $4, CASE WHEN $4::text IS NULL THEN NULL ELSE now() END, $5, now()) RETURNING id`,
    [userId, device.name, device.publicKey, device.bolusPublicKey, device.clientDeviceId],
  )).rows[0];
  return row.id;
}

function translate(error: unknown): unknown {
  const constraint = (error as { constraint?: string })?.constraint;
  if (constraint === 'devices_public_key_unique' || constraint === 'devices_bolus_public_key_unique') return new DeviceAuthError('DEVICE_ALREADY_PAIRED');
  return error;
}

function iso(value: unknown): string | null {
  return value ? new Date(value as string).toISOString() : null;
}

function toDevice(row: Record<string, any>): DeviceRow {
  return {
    id: row.id,
    user_id: row.user_id,
    name: row.name,
    platform: row.platform,
    public_key: row.public_key,
    bolus_public_key: row.bolus_public_key ?? null,
    bolus_key_registered_at: iso(row.bolus_key_registered_at),
    client_device_id: row.client_device_id ?? null,
    created_at: iso(row.created_at) as string,
    last_seen_at: iso(row.last_seen_at),
    revoked_at: iso(row.revoked_at),
  };
}
