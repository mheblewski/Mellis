import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Pool } from 'pg';
import { CodedError, ValidationError } from '@shared/errors/app-error';
import { DATABASE_POOL } from '@infra/db/database.tokens';
import { patientNightscoutClientsFromEnv } from '@infra/db/patient-nightscout-clients.factory';
import { PostgresGlucoMindRepository, type AuditProvider } from '@infra/db/postgres-glucomind.repository';
import { DeviceAuthError, PostgresDeviceAuthRepository, type ChallengePurpose, type DeviceRow, type HandoffRow, type NewDevice, type OwnerSummary } from '@infra/db/postgres-device-auth.repository';
import { PostgresSharingRepository, type PatientMember, type SharingInvitation } from '@infra/db/postgres-sharing.repository';
import { SharingError, type SharingPermissions } from '@modules/sharing/domain/sharing';
import {
  bolusKeyMessage,
  DeviceAuthInputError,
  hashOneTimeCode,
  newNonce,
  newOneTimeCode,
  newSessionToken,
  normalizeOneTimeCode,
  pairingMessage,
  parseHandoffCiphertext,
  parseP256PublicKey,
  remoteSettingsHandoffMessage,
  parseSignedEnvelope,
  readSignedPayload,
  sameAmount,
  sameName,
  secretsEqual,
  sessionMessage,
  sha256Hex,
  verifyDeviceSignature,
  type HandoffRecipientKey,
  type SignedRemoteBolusConfirmPayload,
  type SignedRemoteCommandPayload,
} from '@modules/device-auth/domain/device-crypto';
import {
  assertNightscoutHostAllowed,
  guardsNightscoutHost,
  NightscoutConnectionError,
  parseNightscoutConnectionInput,
  probeNightscout,
  type NightscoutConnectionResult,
  type NightscoutProbeClient,
} from '@modules/integrations/nightscout/application/nightscout-connection';
import { HttpNightscoutClient } from '@modules/integrations/nightscout/infrastructure/http-nightscout-client';
import { AiKeyCheckError, checkAiSetup, parseAiSetupInput } from '@modules/ai-setup/ai-key-check';
import type { RequestPrincipal } from '../auth/bearer-principal.guard';

/** Pairing codes (setup, another phone, reset-owner) live 10 minutes; invitations as long as the invitation. */
export const PAIRING_CODE_TTL_MS = 10 * 60_000;
export const SESSION_TTL_MS = 15 * 60_000;
export const CHALLENGE_TTL_MS = 2 * 60_000;
/** A handed-over remote settings package waits this long for the recipient's phone. */
export const HANDOFF_TTL_MS = 7 * 24 * 60 * 60_000;
/** At most this many phones of one person per hand-off. */
const MAX_HANDOFF_DEVICES = 10;
const SETUP_CODE_HEADER = 'x-mellis-setup-code';

export type NightscoutProbeClientFactory = (baseUrl: string, token: string) => NightscoutProbeClient;

const httpProbeClient: NightscoutProbeClientFactory = (baseUrl, token) =>
  new HttpNightscoutClient(baseUrl, token, 'ACCESS_TOKEN_JWT', { guardPrivateNetwork: guardsNightscoutHost(baseUrl, process.env), requireReadOnlyToken: true });

const NIGHTSCOUT_ERROR_STATUS: Record<string, number> = {
  NIGHTSCOUT_ADDRESS_INVALID: 422,
  NIGHTSCOUT_HOST_NOT_ALLOWED: 422,
  NIGHTSCOUT_UNREACHABLE: 422,
  NIGHTSCOUT_TOKEN_MISSING: 422,
  NIGHTSCOUT_TOKEN_INVALID: 422,
  NIGHTSCOUT_TOKEN_ADMIN: 422,
  NIGHTSCOUT_TOKEN_NOT_READ_ONLY: 422,
  NIGHTSCOUT_NO_RECENT_READINGS: 422,
  NIGHTSCOUT_ALREADY_USED: 409,
};

const DEVICE_AUTH_ERROR_STATUS: Record<DeviceAuthError['code'], number> = {
  SETUP_COMPLETED: 409,
  SETUP_NEEDS_PATIENT: 409,
  SETUP_NEEDS_OWNER: 409,
  PAIRING_CODE_INVALID: 401,
  DEVICE_ALREADY_PAIRED: 409,
  RECOVERY_CODE_INVALID: 401,
  DEVICE_NOT_FOUND: 404,
  NO_OWNER_TO_RESET: 409,
  CO_OWNER_NOT_ALLOWED: 422,
  NOT_AN_OWNER: 403,
  REMOTE_BOLUS_NOT_GRANTED: 409,
  HANDOFF_KEY_CHANGED: 409,
};

const SHARING_ERROR_STATUS: Record<string, number> = {
  NOT_AN_OWNER: 403,
  NOT_A_MEMBER: 404,
  ALREADY_A_MEMBER: 409,
  PEOPLE_LIMIT_REACHED: 409,
  INVITATION_NOT_FOUND: 404,
  INVITATION_EXPIRED: 410,
  INVITATION_CLOSED: 410,
  REMOTE_BOLUS_NOT_GRANTED: 409,
  LAST_OWNER: 409,
  INVALID_PERMISSIONS: 422,
};

export interface PairingCodeView {
  code: string;
  expires_at: string;
  /** What the QR code holds: the server address and the code. */
  pairing_url: string;
}

export interface SessionView {
  access_token: string;
  token_type: 'Bearer';
  expires_at: string;
}

export interface DeviceView {
  device_id: string;
  user_id: string;
  name: string;
  created_at: string;
  last_seen_at: string | null;
  this_device: boolean;
  /** The phone has registered its Face ID bound bolus key (it can sign remote commands). */
  has_bolus_key: boolean;
}

/** At most this many co-owners in one "Dodaj pacjenta" (a patient has at most 10 people). */
const MAX_CO_OWNERS = 9;

/**
 * Self-hosted Mellis: the setup (stage 2) and device auth (stage 3, AUTH_MODE=device), docs/device-auth-api.md.
 * The Cognito path never comes here. Every change is an audit event (DEVICE_*, SETUP_*).
 */
@Injectable()
export class DeviceAuthService {
  private readonly logger = new Logger(DeviceAuthService.name);
  private readonly store: PostgresDeviceAuthRepository;
  private readonly sharing: PostgresSharingRepository;
  probeClient: NightscoutProbeClientFactory = httpProbeClient;
  /** The AI key checks' HTTP (a fake in tests). */
  aiFetch: Parameters<typeof checkAiSetup>[1] = undefined;

  constructor(
    @Inject(DATABASE_POOL) private readonly pool: Pool,
    @Inject(PostgresGlucoMindRepository) private readonly repository: PostgresGlucoMindRepository,
  ) {
    this.store = new PostgresDeviceAuthRepository(pool);
    this.sharing = new PostgresSharingRepository(pool);
  }

  static isDeviceMode(env: NodeJS.ProcessEnv = process.env): boolean {
    return (env.AUTH_MODE ?? '').trim().toLowerCase() === 'device';
  }

  // Setup (stage 2) ---------------------------------------------------------------------------------------------------

  /** GET /v1/setup: public; the patients only with a valid setup code while the setup is open. */
  async setupStatus(headers: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.requireDeviceMode();
    const state = await this.store.getSetupState();
    const open = !state.completed_at;
    const authorized = open && this.setupCodeMatches(headers);
    return {
      auth_mode: 'device',
      setup: open ? 'OPEN' : 'COMPLETED',
      setup_code_configured: !!this.configuredSetupCode(),
      ...(authorized ? { patients: await this.store.listPatients(), first_owner_named: !!state.recovery_user_id } : {}),
    };
  }

  /**
   * POST /v1/setup/patients (setup code): { display_name, birth_year, nightscout: { url, token } }. The Nightscout is
   * tested before anything is saved (read-only token, a reading of the last 24 h); then the patient and its encrypted
   * source are stored. More patients later: POST /v1/patients by an owner's phone.
   */
  async setupCreatePatient(headers: Record<string, unknown>, body: unknown, now = new Date()): Promise<Record<string, unknown>> {
    await this.requireOpenSetup(headers);
    const created = await this.createPatientWithNightscout(body, null, now, true);
    await this.audit('SETUP_CODE', null, null, 'SETUP_PATIENT_CREATED', { patient_id: created.patient.patient_id, host: new URL(created.nightscout.base_url).hostname });
    return created;
  }

  /**
   * POST /v1/setup/owner (setup code): { first_name }. Names the first owner (owner of every patient so far) and returns
   * the pairing code for their phone and the recovery code (shown only here; a repeat replaces both).
   */
  async setupFirstOwner(headers: Record<string, unknown>, body: unknown, requestOrigin: string | null, now = new Date()): Promise<Record<string, unknown>> {
    await this.requireOpenSetup(headers);
    const firstName = parseFirstName((body as Record<string, unknown> | null)?.first_name);
    const code = newOneTimeCode();
    const recoveryCode = newOneTimeCode(5);
    const expiresAt = new Date(now.getTime() + PAIRING_CODE_TTL_MS);
    const owner = await this.run(() => this.store.prepareFirstOwner({ firstName, codeHash: hashOneTimeCode(code) as string, recoveryCodeHash: hashOneTimeCode(recoveryCode) as string, expiresAt }));
    await this.audit('SETUP_CODE', null, owner.user_id, 'SETUP_FIRST_OWNER_NAMED', {});
    return {
      user_id: owner.user_id,
      first_name: firstName,
      pairing: this.pairingView(code, expiresAt, requestOrigin),
      recovery_code: recoveryCode,
    };
  }

  /**
   * POST /v1/setup/ai (setup code): { provider: "anthropic" | "openai", api_key, openai_api_key? }. Checks each key with
   * a free model-list call and returns the .env lines the setup page writes (the server keeps no key) and what the
   * server can do with them. With OpenAI its key also serves knowledge search and voice; with Claude the optional
   * OpenAI key adds them (skipped: word-only search, voice on the phone). 422 AI_KEY_INVALID / AI_KEY_UNREACHABLE /
   * AI_KEY_MISSING name the key in the title.
   */
  async setupCheckAi(headers: Record<string, unknown>, body: unknown): Promise<Record<string, unknown>> {
    await this.requireOpenSetup(headers);
    try {
      const result = await checkAiSetup(parseAiSetupInput((body ?? {}) as Record<string, unknown>), this.aiFetch);
      await this.audit('SETUP_CODE', null, null, 'SETUP_AI_CHECKED', { provider: result.env.AI_PROVIDER, keys: result.checked });
      return { ...result };
    } catch (error) {
      // The title names the failing key ("AI_KEY_INVALID: OPENAI_API_KEY") so the setup asks for that one again.
      if (error instanceof AiKeyCheckError) throw coded(error.code, 422, error.message);
      throw error;
    }
  }

  /**
   * POST /v1/setup/nightscout-check (setup code): { url, token } — the same test as POST /v1/setup/patients, nothing
   * stored. The installer asks for the Nightscout first and shows the newest reading before it asks for the name.
   */
  async setupCheckNightscout(headers: Record<string, unknown>, body: unknown, now = new Date()): Promise<Record<string, unknown>> {
    await this.requireOpenSetup(headers);
    const raw = (body ?? {}) as Record<string, unknown>;
    const { result } = await this.probeNightscout(raw.url ?? raw.base_url, raw.token, now);
    return { nightscout: result };
  }

  /**
   * POST /v1/setup/pairing-code (setup code): a fresh 10-minute pairing code for the first owner named by
   * POST /v1/setup/owner, without touching the recovery code. install-app.sh on the Mac asks for it with the setup code
   * ("Kod konfiguracji") right before the app's first start; earlier unused setup codes stop working. 409
   * SETUP_NEEDS_OWNER before the owner is named.
   */
  async setupPairingCode(headers: Record<string, unknown>, requestOrigin: string | null, now = new Date()): Promise<Record<string, unknown>> {
    await this.requireOpenSetup(headers);
    const code = newOneTimeCode();
    const expiresAt = new Date(now.getTime() + PAIRING_CODE_TTL_MS);
    const owner = await this.run(() => this.store.createSetupOwnerPairingCode({ codeHash: hashOneTimeCode(code) as string, expiresAt }));
    await this.audit('SETUP_CODE', null, owner.user_id, 'SETUP_PAIRING_CODE_CREATED', {});
    return { user_id: owner.user_id, pairing: this.pairingView(code, expiresAt, requestOrigin) };
  }

  // Pairing and sessions (stage 3) ---------------------------------------------------------------------------------------

  /**
   * POST /v1/pair (public): { code, first_name?, device: { name, public_key, client_device_id? }, signature } — the
   * device key signs pairingMessage(code, public_key) (v2). No bolus key: it is registered when the person confirms a
   * remote bolus grant (registerBolusKey), so a phone without Face ID pairs too. An older app that sends
   * bolus_public_key + bolus_signature signs v1 with both keys. Returns the device, the person, their patients and a
   * first session.
   */
  async pair(body: unknown, now = new Date()): Promise<Record<string, unknown>> {
    this.requireDeviceMode();
    const raw = (body ?? {}) as Record<string, unknown>;
    const codeHash = hashOneTimeCode(raw.code);
    if (!codeHash) throw coded('PAIRING_CODE_INVALID', 401, 'The pairing code is not valid');
    const device = parseNewDevice(raw, normalizeOneTimeCode(raw.code));
    const firstName = raw.first_name === undefined || raw.first_name === null ? null : parseFirstName(raw.first_name);
    const paired = await this.run(() => this.store.pairWithCode({ codeHash, device, firstName, now }));
    await this.audit('DEVICE', `device:${paired.device_id}`, paired.user_id, 'DEVICE_PAIRED', { purpose: paired.purpose, device_name: device.name, patient_id: paired.patient_id });
    return this.pairedResponse(paired.device_id, paired.user_id, now);
  }

  /** POST /v1/auth/challenge (public): { device_id } → a nonce the device key signs for a session. */
  async sessionChallenge(body: unknown, now = new Date()): Promise<Record<string, unknown>> {
    this.requireDeviceMode();
    const deviceId = String((body as Record<string, unknown> | null)?.device_id ?? '');
    return this.challengeFor(deviceId, 'SESSION', null, now);
  }

  /** POST /v1/auth/session (public): { device_id, challenge_id, signature } → a short-lived bearer token. */
  async createSession(body: unknown, now = new Date()): Promise<SessionView> {
    this.requireDeviceMode();
    const raw = (body ?? {}) as Record<string, unknown>;
    const deviceId = String(raw.device_id ?? '');
    const challengeId = String(raw.challenge_id ?? '');
    const device = await this.store.getDevice(deviceId);
    const invalid = () => coded('DEVICE_AUTH_FAILED', 401, 'The device could not be authenticated');
    if (!device || device.revoked_at) throw invalid();
    const nonce = await this.store.consumeChallenge({ challengeId, deviceId, purpose: 'SESSION', patientId: null, now });
    if (!nonce || !verifyDeviceSignature(device.public_key, sessionMessage(deviceId, challengeId, nonce), raw.signature)) throw invalid();
    return this.issueSession(deviceId, now);
  }

  /** The bearer guard: the device and person behind a session token; null when unknown, expired or revoked. */
  async resolveSessionToken(token: string, now = new Date()): Promise<RequestPrincipal | null> {
    if (!token.startsWith('mls_') || token.length > 200) return null;
    const session = await this.store.resolveSession(sha256Hex(token), now);
    return session ? { user_id: session.user_id, auth_provider: 'DEVICE', auth_subject: `device:${session.device_id}`, device_id: session.device_id } : null;
  }

  // The person's own devices ---------------------------------------------------------------------------------------------

  /** GET /v1/me/devices */
  async listOwnDevices(principal: RequestPrincipal): Promise<{ devices: DeviceView[] }> {
    const device = this.requireDevicePrincipal(principal);
    return { devices: (await this.store.listDevicesOfUser(principal.user_id)).map((row) => toDeviceView(row, device)) };
  }

  /** DELETE /v1/me/devices/:deviceId — one's own phone (a lost one, or this one before handing it over). */
  async revokeOwnDevice(principal: RequestPrincipal, deviceId: string, now = new Date()): Promise<void> {
    this.requireDevicePrincipal(principal);
    const device = await this.store.getDevice(deviceId);
    if (!device || device.user_id !== principal.user_id || device.revoked_at) throw coded('DEVICE_NOT_FOUND', 404, 'Device not found');
    await this.store.revokeDevice({ deviceId, revokedBy: principal.user_id, now });
    await this.audit('DEVICE', principal.auth_subject ?? null, principal.user_id, 'DEVICE_REVOKED', { device_id: deviceId, own: true });
  }

  /** POST /v1/me/pairing-codes — pairs another phone of the same person (QR shown on this one). */
  async createOwnPairingCode(principal: RequestPrincipal, requestOrigin: string | null, now = new Date()): Promise<PairingCodeView> {
    this.requireDevicePrincipal(principal);
    const code = newOneTimeCode();
    const expiresAt = new Date(now.getTime() + PAIRING_CODE_TTL_MS);
    await this.store.createPairingCode({ purpose: 'ADD_DEVICE', userId: principal.user_id, createdBy: principal.user_id, codeHash: hashOneTimeCode(code) as string, expiresAt });
    await this.audit('DEVICE', principal.auth_subject ?? null, principal.user_id, 'DEVICE_PAIRING_CODE_CREATED', {});
    return this.pairingView(code, expiresAt, requestOrigin);
  }

  /** POST /v1/me/invitations/accept — a paired person joins one more patient: { code }. */
  async acceptInvitation(principal: RequestPrincipal, body: unknown, now = new Date()): Promise<Record<string, unknown>> {
    const deviceId = this.requireDevicePrincipal(principal);
    const codeHash = hashOneTimeCode((body as Record<string, unknown> | null)?.code);
    if (!codeHash) throw coded('PAIRING_CODE_INVALID', 401, 'The invitation code is not valid');
    const joined = await this.run(() => this.store.acceptInvitationCode({ codeHash, userId: principal.user_id, deviceId, now }));
    await this.audit('DEVICE', principal.auth_subject ?? null, principal.user_id, 'DEVICE_INVITATION_ACCEPTED', { patient_id: joined.patient_id });
    return { patient_id: joined.patient_id, member: await this.sharing.getMember(joined.patient_id, principal.user_id) };
  }

  /**
   * POST /v1/patients: an owner adds one more patient (same body as the setup), and owns it. Optional
   * `co_owner_user_ids`: people who own one of the caller's patients become owners of the new one too (every permission
   * but remote bolus, which needs its own grant and the person's confirmation); anyone else is 422 CO_OWNER_NOT_ALLOWED.
   */
  async createPatient(principal: RequestPrincipal, body: unknown, now = new Date()): Promise<Record<string, unknown>> {
    this.requireDevicePrincipal(principal);
    const owns = (await this.pool.query(`SELECT 1 FROM caregiver_relationships WHERE user_id = $1::uuid AND is_owner LIMIT 1`, [principal.user_id])).rowCount;
    // Only an owner of the server's family adds patients (an invited helper does not).
    if (!owns) throw coded('NOT_AN_OWNER', 403, 'Only an owner adds patients');
    const coOwners = parseCoOwnerIds((body as Record<string, unknown> | null)?.co_owner_user_ids, principal.user_id);
    // Checked before the Nightscout is probed (and again in the transaction that creates the patient).
    if (coOwners.length > 0 && (await this.store.allowedCoOwners(this.pool, principal.user_id, coOwners)).length !== coOwners.length) {
      throw coded('CO_OWNER_NOT_ALLOWED', 422, 'Every co-owner must own one of your patients');
    }
    const created = await this.createPatientWithNightscout(body, principal.user_id, now, false, coOwners);
    await this.audit('DEVICE', principal.auth_subject ?? null, principal.user_id, 'PATIENT_CREATED', { patient_id: created.patient.patient_id, co_owner_user_ids: coOwners });
    return { ...created, co_owner_user_ids: coOwners };
  }

  /**
   * GET /v1/me/co-owners — "Dodaj też współwłaścicieli": the owners of the caller's own patients (not the caller), each
   * with the patients they own. Empty for someone who owns no patient.
   */
  async listCoOwnerCandidates(principal: RequestPrincipal): Promise<Record<string, unknown>> {
    this.requireDevicePrincipal(principal);
    return { people: await this.store.listCoOwnerCandidates(principal.user_id) };
  }

  /** GET /v1/patients/:id/nightscout — the patient's Nightscout address and newest reading, for any member. */
  async nightscoutSummary(principal: RequestPrincipal, patientId: string): Promise<Record<string, unknown>> {
    this.requireDevicePrincipal(principal);
    if (!(await this.store.isMemberOf(principal.user_id, patientId))) throw coded('NOT_A_MEMBER', 403, 'Patient access denied');
    return { patient_id: patientId, ...(await this.store.getNightscoutSummary(patientId)) };
  }

  /** POST /v1/me/devices/bolus-key/challenge — the nonce both keys sign when this phone registers its bolus key. */
  async bolusKeyChallenge(principal: RequestPrincipal, now = new Date()): Promise<Record<string, unknown>> {
    const deviceId = this.requireDevicePrincipal(principal);
    return this.challengeFor(deviceId, 'BOLUS_KEY', null, now);
  }

  /**
   * POST /v1/me/devices/bolus-key — { challenge_id, bolus_public_key, signature, bolus_signature }: this session's phone
   * registers (or, after a Face ID change, replaces) its Face ID bound bolus key. The device key signs
   * bolusKeyMessage(device_id, challenge_id, nonce, bolus_public_key) to prove the phone, the new bolus key signs the
   * same bytes to prove possession. The challenge is used up either way.
   */
  async registerBolusKey(principal: RequestPrincipal, body: unknown, now = new Date()): Promise<Record<string, unknown>> {
    const deviceId = this.requireDevicePrincipal(principal);
    const raw = (body ?? {}) as Record<string, unknown>;
    const bolusPublicKey = String(raw.bolus_public_key ?? '');
    const challengeId = String(raw.challenge_id ?? '');
    let bolusKey;
    try {
      bolusKey = parseP256PublicKey(bolusPublicKey);
    } catch {
      throw coded('PUBLIC_KEY_INVALID', 422, 'bolus_public_key must be a P-256 public key (X9.63, base64)');
    }
    const device = await this.store.getDevice(deviceId);
    if (!device || device.revoked_at) throw coded('DEVICE_NOT_PAIRED', 401, 'This device is not paired with the server');
    if (bolusPublicKey === device.public_key) throw coded('PUBLIC_KEY_INVALID', 422, 'The bolus key must differ from the device key');
    const nonce = await this.store.consumeChallenge({ challengeId, deviceId, purpose: 'BOLUS_KEY', patientId: null, now });
    const message = nonce ? bolusKeyMessage(deviceId, challengeId, nonce, bolusPublicKey) : null;
    if (!message || !verifyDeviceSignature(device.public_key, message, raw.signature) || !verifyDeviceSignature(bolusKey, message, raw.bolus_signature)) {
      this.logger.warn(JSON.stringify({ event: 'bolus_key_registration_refused', device_id: deviceId }));
      throw coded('BOLUS_KEY_SIGNATURE_INVALID', 403, 'The bolus key registration is not signed by this device and the new key');
    }
    if (!(await this.run(() => this.store.registerBolusKey({ deviceId, bolusPublicKey, now })))) throw coded('DEVICE_NOT_PAIRED', 401, 'This device is not paired with the server');
    await this.audit('DEVICE', principal.auth_subject ?? null, principal.user_id, 'DEVICE_BOLUS_KEY_REGISTERED', { device_id: deviceId, replaced: !!device.bolus_public_key });
    return { device_id: deviceId, bolus_key_registered_at: now.toISOString() };
  }

  // People of a patient (owners) ---------------------------------------------------------------------------------------

  /** GET /v1/patients/:id/people — members (owners also see each one's devices) and open invitations (owners). */
  async listPeople(principal: RequestPrincipal, patientId: string, now = new Date()): Promise<Record<string, unknown>> {
    const thisDevice = this.requireDevicePrincipal(principal);
    if (!(await this.store.isMemberOf(principal.user_id, patientId))) throw coded('NOT_A_MEMBER', 403, 'Patient access denied');
    const owner = await this.store.isOwnerOf(principal.user_id, patientId);
    const [members, devices, invitations] = await Promise.all([
      this.sharing.listMembers(patientId),
      owner ? this.store.listDevicesOfPatientMembers(patientId) : Promise.resolve([] as DeviceRow[]),
      owner ? this.sharing.listOpenInvitations(patientId, now) : Promise.resolve([] as SharingInvitation[]),
    ]);
    return {
      patient_id: patientId,
      you_are_owner: owner,
      people: members.map((member) => ({
        ...member,
        is_you: member.user_id === principal.user_id,
        ...(owner ? { devices: devices.filter((device) => device.user_id === member.user_id).map((device) => toDeviceView(device, thisDevice)) } : {}),
      })),
      invitations: invitations.map(toInvitationView),
    };
  }

  /**
   * POST /v1/patients/:id/invitations — { first_name, permissions: { glucose_alerts, ai_chat_meals, manage_sharing,
   * remote_commands } }. The code (shown as a QR / link on the owner's phone) pairs the invitee's phone straight into
   * the new person; an already paired person enters it in "Dołącz" (POST /v1/me/invitations/accept).
   */
  async invite(principal: RequestPrincipal, patientId: string, body: unknown, requestOrigin: string | null, now = new Date()): Promise<Record<string, unknown>> {
    this.requireDevicePrincipal(principal);
    const raw = (body ?? {}) as Record<string, unknown>;
    const firstName = parseFirstName(raw.first_name);
    const permissions = parsePermissionsInput(raw.permissions);
    const code = newOneTimeCode();
    const invitation = await this.run(() => this.sharing.createCodeInvitation({
      patientId,
      invitedBy: principal.user_id,
      inviteeName: firstName,
      permissions,
      now,
      withCode: (client, created) => this.store.createInvitationCode(client, { invitationId: created.id, createdBy: principal.user_id, codeHash: hashOneTimeCode(code) as string, expiresAt: created.expires_at }),
    }));
    await this.audit('DEVICE', principal.auth_subject ?? null, principal.user_id, 'SHARING_INVITATION_CREATED', { patient_id: patientId, invitation_id: invitation.id, permissions: invitation.permissions });
    return { invitation: toInvitationView(invitation), pairing: this.pairingView(code, new Date(invitation.expires_at), requestOrigin) };
  }

  /** DELETE /v1/patients/:id/invitations/:invitationId */
  async revokeInvitation(principal: RequestPrincipal, patientId: string, invitationId: string, now = new Date()): Promise<void> {
    this.requireDevicePrincipal(principal);
    const open = (await this.sharing.listOpenInvitations(patientId, now)).find((invitation) => invitation.id === invitationId);
    if (!open) throw coded('INVITATION_NOT_FOUND', 404, 'Invitation not found');
    await this.run(() => this.sharing.revokeInvitation(invitationId, principal.user_id, now));
    await this.audit('DEVICE', principal.auth_subject ?? null, principal.user_id, 'SHARING_INVITATION_REVOKED', { patient_id: patientId, invitation_id: invitationId });
  }

  /** PUT /v1/patients/:id/people/:userId — { permissions: {...} } (owners). Remote bolus on = a new grant to confirm. */
  async updatePerson(principal: RequestPrincipal, patientId: string, userId: string, body: unknown, now = new Date()): Promise<PatientMember> {
    this.requireDevicePrincipal(principal);
    const permissions = parsePermissionsInput((body as Record<string, unknown> | null)?.permissions, true);
    await this.run(() => this.sharing.updateMemberPermissions({ patientId, actingUserId: principal.user_id, targetUserId: userId, permissions, now }));
    await this.audit('DEVICE', principal.auth_subject ?? null, principal.user_id, 'SHARING_PERMISSIONS_CHANGED', { patient_id: patientId, target_user_id: userId, permissions });
    const member = await this.sharing.getMember(patientId, userId);
    if (!member) throw coded('NOT_A_MEMBER', 404, 'Not a member');
    return member;
  }

  /**
   * DELETE /v1/patients/:id/people/:userId — an owner removes someone, or anyone leaves. A person left without any
   * patient keeps their devices (an owner may invite them again); revoke them separately.
   */
  async removePerson(principal: RequestPrincipal, patientId: string, userId: string): Promise<void> {
    this.requireDevicePrincipal(principal);
    await this.run(() => this.sharing.removeMember(patientId, principal.user_id, userId));
    await this.audit('DEVICE', principal.auth_subject ?? null, principal.user_id, principal.user_id === userId ? 'SHARING_LEFT' : 'SHARING_MEMBER_REMOVED', { patient_id: patientId, target_user_id: userId });
  }

  /** DELETE /v1/patients/:id/people/:userId/devices/:deviceId — an owner revokes a member's device. */
  async revokeMemberDevice(principal: RequestPrincipal, patientId: string, userId: string, deviceId: string, now = new Date()): Promise<void> {
    this.requireDevicePrincipal(principal);
    if (!(await this.store.isOwnerOf(principal.user_id, patientId))) throw coded('NOT_AN_OWNER', 403, 'Only an owner revokes devices');
    const device = await this.store.getDevice(deviceId);
    if (!device || device.user_id !== userId || device.revoked_at || !(await this.store.isMemberOf(userId, patientId))) throw coded('DEVICE_NOT_FOUND', 404, 'Device not found');
    await this.store.revokeDevice({ deviceId, revokedBy: principal.user_id, now });
    await this.audit('DEVICE', principal.auth_subject ?? null, principal.user_id, 'DEVICE_REVOKED', { device_id: deviceId, patient_id: patientId, target_user_id: userId });
  }

  // Signed remote bolus -------------------------------------------------------------------------------------------------

  /**
   * POST /v1/patients/:id/signing-challenges — { purpose: "REMOTE_BOLUS" | "REMOTE_BOLUS_CONFIRM" }: the nonce the bolus
   * key signs, with the patient's name as the server stores it (the signed payload must carry it). REMOTE_BOLUS only for
   * a person whose remote bolus counts (403 REMOTE_BOLUS_NOT_PERMITTED) on a phone with a registered bolus key (403
   * BOLUS_KEY_REQUIRED). REMOTE_BOLUS_CONFIRM for any member: the app asks for it before registering the bolus key, so
   * one Face ID signs both.
   */
  async signingChallenge(principal: RequestPrincipal, patientId: string, body: unknown, now = new Date()): Promise<Record<string, unknown>> {
    const deviceId = this.requireDevicePrincipal(principal);
    const purpose = (body as Record<string, unknown> | null)?.purpose;
    if (purpose !== 'REMOTE_BOLUS' && purpose !== 'REMOTE_BOLUS_CONFIRM') throw new ValidationError('purpose must be REMOTE_BOLUS or REMOTE_BOLUS_CONFIRM');
    if (!(await this.store.isMemberOf(principal.user_id, patientId))) throw coded('NOT_A_MEMBER', 403, 'Patient access denied');
    if (purpose === 'REMOTE_BOLUS') {
      if (!(await this.store.hasEffectiveRemoteBolus(principal.user_id, patientId))) throw coded('REMOTE_BOLUS_NOT_PERMITTED', 403, 'Remote bolus is not granted and confirmed for this person');
      if (!(await this.store.getDevice(deviceId))?.bolus_public_key) throw bolusKeyRequired();
    }
    const patientName = await this.store.getPatientDisplayName(patientId);
    return { ...(await this.challengeFor(deviceId, purpose, patientId, now)), patient_id: patientId, patient_name: patientName };
  }

  /**
   * Checks a remote command's `device_authorization` ({ payload, signature }) before the command is authorized: signed
   * by this session's device's bolus key (Face ID on the phone) over a fresh single-use challenge for this patient,
   * naming the patient as stored and carrying the same insulin and carbs as the request. Returns what is stored with
   * the command. Any mismatch: 403 REMOTE_COMMAND_SIGNATURE_INVALID, nothing is sent.
   */
  async verifySignedRemoteCommand(principal: RequestPrincipal, patientId: string, request: { insulin_u: number; carbs_g: number }, rawAuthorization: unknown, now = new Date()): Promise<Record<string, unknown>> {
    const deviceId = this.requireDevicePrincipal(principal);
    const invalid = (reason: string) => {
      this.logger.warn(JSON.stringify({ event: 'remote_command_signature_refused', reason, patient_id: patientId, device_id: deviceId }));
      return coded('REMOTE_COMMAND_SIGNATURE_INVALID', 403, 'The remote command is not signed by this device');
    };
    if (rawAuthorization === undefined || rawAuthorization === null) throw coded('REMOTE_COMMAND_SIGNATURE_REQUIRED', 403, 'Remote commands must be signed by the device (Face ID)');
    let signed: { bytes: Buffer; payload: SignedRemoteCommandPayload };
    try {
      signed = readSignedPayload<SignedRemoteCommandPayload>(parseSignedEnvelope(rawAuthorization), 'remote_command');
    } catch {
      throw invalid('PAYLOAD_INVALID');
    }
    const { payload } = signed;
    const device = await this.store.getDevice(deviceId);
    const patientName = await this.store.getPatientDisplayName(patientId);
    if (!device || device.revoked_at) throw invalid('DEVICE_REVOKED');
    if (!device.bolus_public_key) throw bolusKeyRequired();
    if (payload.device_id !== deviceId || payload.patient_id !== patientId) throw invalid('WRONG_DEVICE_OR_PATIENT');
    if (!patientName || !sameName(payload.patient_name, patientName)) throw invalid('PATIENT_NAME_MISMATCH');
    if (!sameAmount(payload.insulin_u, request.insulin_u) || !sameAmount(payload.carbs_g, request.carbs_g)) throw invalid('AMOUNT_MISMATCH');
    if (!verifyDeviceSignature(device.bolus_public_key, signed.bytes, parseSignedEnvelope(rawAuthorization).signature)) throw invalid('BAD_SIGNATURE');
    // The challenge is used last, so a refused request does not burn it; a valid one cannot be replayed.
    const nonce = await this.store.consumeChallenge({ challengeId: payload.challenge_id, deviceId, purpose: 'REMOTE_BOLUS', patientId, now });
    if (!nonce || nonce !== payload.nonce) throw invalid('CHALLENGE_INVALID');
    return {
      device_id: deviceId,
      challenge_id: payload.challenge_id,
      confirmation: payload.confirmation,
      patient_name: payload.patient_name,
      insulin_u: payload.insulin_u,
      carbs_g: payload.carbs_g,
      payload: rawAuthorization && (rawAuthorization as Record<string, unknown>).payload,
      signature: rawAuthorization && (rawAuthorization as Record<string, unknown>).signature,
      verified_at: now.toISOString(),
    };
  }

  async recordCommandAuthorization(commandId: string, authorization: Record<string, unknown>): Promise<void> {
    await this.store.recordCommandAuthorization(commandId, authorization);
  }

  /**
   * POST /v1/patients/:id/remote-bolus/confirm — { device_authorization } signed by the bolus key: the grantee's own
   * confirmation of a remote bolus grant (Face ID on their phone), required before any command of theirs counts.
   */
  async confirmRemoteBolus(principal: RequestPrincipal, patientId: string, body: unknown, now = new Date()): Promise<PatientMember> {
    const deviceId = this.requireDevicePrincipal(principal);
    const rawAuthorization = (body as Record<string, unknown> | null)?.device_authorization;
    const invalid = () => coded('REMOTE_COMMAND_SIGNATURE_INVALID', 403, 'The confirmation is not signed by this device');
    let signed: { bytes: Buffer; payload: SignedRemoteBolusConfirmPayload };
    try {
      signed = readSignedPayload<SignedRemoteBolusConfirmPayload>(parseSignedEnvelope(rawAuthorization), 'remote_bolus_confirm');
    } catch {
      throw invalid();
    }
    const device = await this.store.getDevice(deviceId);
    const patientName = await this.store.getPatientDisplayName(patientId);
    if (!device || device.revoked_at || signed.payload.device_id !== deviceId || signed.payload.patient_id !== patientId) throw invalid();
    if (!device.bolus_public_key) throw bolusKeyRequired();
    if (!patientName || !sameName(signed.payload.patient_name, patientName)) throw invalid();
    if (!verifyDeviceSignature(device.bolus_public_key, signed.bytes, parseSignedEnvelope(rawAuthorization).signature)) throw invalid();
    const nonce = await this.store.consumeChallenge({ challengeId: signed.payload.challenge_id, deviceId, purpose: 'REMOTE_BOLUS_CONFIRM', patientId, now });
    if (!nonce || nonce !== signed.payload.nonce) throw invalid();
    await this.run(() => this.sharing.confirmRemoteBolus(patientId, principal.user_id, now));
    await this.audit('DEVICE', principal.auth_subject ?? null, principal.user_id, 'REMOTE_BOLUS_CONFIRMED', { patient_id: patientId, device_id: deviceId, confirmation: signed.payload.confirmation });
    return (await this.sharing.getMember(patientId, principal.user_id)) as PatientMember;
  }

  // Remote settings hand-off (step 2, §8) -------------------------------------------------------------------------------

  /**
   * GET /v1/patients/:id/people/:userId/handoff-devices (owners): the phones of a person with a remote bolus grant
   * (confirmed or waiting) and, for each, the public key the owner's phone encrypts the settings package to: the Face
   * ID bound bolus key when the phone has one, else its device key (until the person confirms remote bolus there).
   */
  async handoffDevices(principal: RequestPrincipal, patientId: string, userId: string): Promise<Record<string, unknown>> {
    const thisDevice = this.requireDevicePrincipal(principal);
    if (!(await this.store.isOwnerOf(principal.user_id, patientId))) throw coded('NOT_AN_OWNER', 403, 'Only an owner hands over remote settings');
    if (!(await this.store.isMemberOf(userId, patientId))) throw coded('NOT_A_MEMBER', 404, 'Not a member');
    if (!(await this.store.hasRemoteBolusGrant(this.pool, userId, patientId))) throw coded('REMOTE_BOLUS_NOT_GRANTED', 409, 'This person has no remote bolus grant for the patient');
    const devices = (await this.store.listDevicesOfUser(userId)).filter((device) => device.id !== thisDevice);
    return {
      patient_id: patientId,
      user_id: userId,
      display_name: await this.store.getUserDisplayName(userId),
      devices: devices.map((device) => ({
        device_id: device.id,
        name: device.name,
        recipient_key: device.bolus_public_key ? 'bolus' : 'device',
        encryption_public_key: device.bolus_public_key ?? device.public_key,
      })),
    };
  }

  /**
   * POST /v1/patients/:id/remote-settings-handoffs (owners) — { to_user_id, loop_kind, packages: [{ to_device_id,
   * recipient_key, ciphertext, sender_signature }] }: one ECIES package per recipient phone, each signed by this
   * session's device key over remoteSettingsHandoffMessage. The server cannot read them; it checks the signature, that
   * the recipient has a grant and that each phone's key is still the one encrypted to, and stores the ciphertext only.
   */
  async createHandoff(principal: RequestPrincipal, patientId: string, body: unknown, now = new Date()): Promise<Record<string, unknown>> {
    const fromDeviceId = this.requireDevicePrincipal(principal);
    const raw = (body ?? {}) as Record<string, unknown>;
    const toUserId = String(raw.to_user_id ?? '');
    const loopKind = raw.loop_kind;
    if (loopKind !== 'trio' && loopKind !== 'loop') throw new ValidationError('loop_kind must be trio or loop');
    if (!Array.isArray(raw.packages) || raw.packages.length === 0 || raw.packages.length > MAX_HANDOFF_DEVICES) throw new ValidationError(`packages must hold 1-${MAX_HANDOFF_DEVICES} items`);
    if (toUserId === principal.user_id) throw new ValidationError('to_user_id must be another person');
    if (!(await this.store.isOwnerOf(principal.user_id, patientId))) throw coded('NOT_AN_OWNER', 403, 'Only an owner hands over remote settings');
    const sender = await this.store.getDevice(fromDeviceId);
    if (!sender || sender.revoked_at) throw coded('DEVICE_NOT_PAIRED', 401, 'This device is not paired with the server');
    const seen = new Set<string>();
    const packages = (raw.packages as unknown[]).map((item) => {
      const value = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
      const toDeviceId = String(value.to_device_id ?? '').toLowerCase();
      const recipientKey = value.recipient_key;
      if (!toDeviceId || seen.has(toDeviceId) || toDeviceId === fromDeviceId.toLowerCase()) throw new ValidationError('packages need distinct to_device_id values of other phones');
      seen.add(toDeviceId);
      if (recipientKey !== 'bolus' && recipientKey !== 'device') throw new ValidationError('recipient_key must be bolus or device');
      let ciphertext: Buffer;
      try {
        ciphertext = parseHandoffCiphertext(value.ciphertext);
      } catch {
        throw coded('HANDOFF_PAYLOAD_INVALID', 422, 'ciphertext must be base64 of an ECIES message (at most 16 KiB)');
      }
      const message = remoteSettingsHandoffMessage({ patientId, fromDeviceId, toDeviceId, loopKind, recipientKey, ciphertext: value.ciphertext as string });
      if (!verifyDeviceSignature(sender.public_key, message, value.sender_signature)) {
        // Never log the package itself.
        this.logger.warn(JSON.stringify({ event: 'remote_settings_handoff_refused', reason: 'BAD_SIGNATURE', patient_id: patientId, device_id: fromDeviceId }));
        throw coded('HANDOFF_SIGNATURE_INVALID', 403, 'The package is not signed by this device');
      }
      return { toDeviceId, recipientKey: recipientKey as HandoffRecipientKey, ciphertext, senderSignature: value.sender_signature as string };
    });
    const created = await this.run(() => this.store.createRemoteSettingsHandoffs({
      patientId,
      fromUserId: principal.user_id,
      fromDeviceId,
      toUserId,
      loopKind,
      packages,
      now,
      expiresAt: new Date(now.getTime() + HANDOFF_TTL_MS),
    }));
    await this.audit('DEVICE', principal.auth_subject ?? null, principal.user_id, 'REMOTE_SETTINGS_HANDED_OVER', { patient_id: patientId, to_user_id: toUserId, loop_kind: loopKind, devices: created.map((row) => row.to_device_id) });
    return { handoffs: created };
  }

  /** GET /v1/patients/:id/remote-settings-handoffs (owners): packages waiting or fetched, until they expire. */
  async listPatientHandoffs(principal: RequestPrincipal, patientId: string, now = new Date()): Promise<Record<string, unknown>> {
    this.requireDevicePrincipal(principal);
    if (!(await this.store.isOwnerOf(principal.user_id, patientId))) throw coded('NOT_AN_OWNER', 403, 'Only an owner sees hand-offs');
    return { handoffs: (await this.store.listHandoffsOfPatient(patientId, now)).map(toHandoffView) };
  }

  /** DELETE /v1/patients/:id/remote-settings-handoffs/:handoffId (owners): withdraws a package not fetched yet. */
  async revokeHandoff(principal: RequestPrincipal, patientId: string, handoffId: string): Promise<void> {
    this.requireDevicePrincipal(principal);
    if (!(await this.store.isOwnerOf(principal.user_id, patientId))) throw coded('NOT_AN_OWNER', 403, 'Only an owner withdraws hand-offs');
    if (!(await this.store.revokeHandoff({ patientId, handoffId }))) throw coded('HANDOFF_NOT_FOUND', 404, 'Hand-off not found');
    await this.audit('DEVICE', principal.auth_subject ?? null, principal.user_id, 'REMOTE_SETTINGS_HANDOFF_REVOKED', { patient_id: patientId, handoff_id: handoffId });
  }

  /** GET /v1/me/remote-settings-handoffs: packages waiting for this phone (no ciphertext). */
  async listMyHandoffs(principal: RequestPrincipal, now = new Date()): Promise<Record<string, unknown>> {
    const deviceId = this.requireDevicePrincipal(principal);
    return { handoffs: (await this.store.listPendingHandoffsForDevice(deviceId, now)).map(toHandoffView) };
  }

  /** POST /v1/me/remote-settings-handoffs/:id/consume: the package for this phone, once; then only a receipt is kept. */
  async consumeHandoff(principal: RequestPrincipal, handoffId: string, now = new Date()): Promise<Record<string, unknown>> {
    const deviceId = this.requireDevicePrincipal(principal);
    const row = await this.store.consumeHandoff({ handoffId, deviceId, now });
    if (!row) throw coded('HANDOFF_NOT_FOUND', 404, 'Hand-off not found');
    await this.audit('DEVICE', principal.auth_subject ?? null, principal.user_id, 'REMOTE_SETTINGS_HANDOFF_FETCHED', { patient_id: row.patient_id, handoff_id: handoffId, from_user_id: row.from_user_id });
    return { ...toHandoffView(row), ciphertext: row.ciphertext, sender_signature: row.sender_signature };
  }

  /** DELETE /v1/me/remote-settings-handoffs/:id: "Odrzuć" on the recipient's phone. */
  async rejectHandoff(principal: RequestPrincipal, handoffId: string): Promise<void> {
    const deviceId = this.requireDevicePrincipal(principal);
    if (!(await this.store.rejectHandoff({ handoffId, deviceId }))) throw coded('HANDOFF_NOT_FOUND', 404, 'Hand-off not found');
    await this.audit('DEVICE', principal.auth_subject ?? null, principal.user_id, 'REMOTE_SETTINGS_HANDOFF_REJECTED', { handoff_id: handoffId });
  }

  // Recovery -------------------------------------------------------------------------------------------------------------

  /**
   * POST /v1/setup/recover (public): { recovery_code, device, signature } — the device key signs
   * pairingMessage(recovery_code, public_key) as in pair(). Pairs a new phone into the first owner and returns a new
   * recovery code.
   */
  async recover(body: unknown, now = new Date()): Promise<Record<string, unknown>> {
    this.requireDeviceMode();
    const raw = (body ?? {}) as Record<string, unknown>;
    const recoveryHash = hashOneTimeCode(raw.recovery_code);
    if (!recoveryHash) throw coded('RECOVERY_CODE_INVALID', 401, 'The recovery code is not valid');
    const device = parseNewDevice(raw, normalizeOneTimeCode(raw.recovery_code));
    const newRecoveryCode = newOneTimeCode(5);
    const paired = await this.run(() => this.store.recoverOwner({ recoveryCodeHash: recoveryHash, newRecoveryCodeHash: hashOneTimeCode(newRecoveryCode) as string, device, now }));
    await this.audit('RECOVERY_CODE', `device:${paired.device_id}`, paired.user_id, 'DEVICE_PAIRED', { purpose: 'RECOVERY_CODE', device_name: device.name });
    return { ...(await this.pairedResponse(paired.device_id, paired.user_id, now)), recovery_code: newRecoveryCode };
  }

  /**
   * `mellis reset-owner` (server CLI): a pairing code for an owner; with a name, a new owner of every patient; with a
   * user id (`mellis` → "Kogo połączyć?"), that owner, refused with NOT_AN_OWNER for anyone else.
   */
  async resetOwner(firstName: string | null, origin: string | null, now = new Date(), userId: string | null = null): Promise<PairingCodeView & { user_id: string; display_name: string }> {
    const name = firstName === null ? null : parseFirstName(firstName);
    const code = newOneTimeCode();
    const expiresAt = new Date(now.getTime() + PAIRING_CODE_TTL_MS);
    const owner = await this.run(() => this.store.prepareResetOwner({ firstName: name, userId: name === null ? userId : null, codeHash: hashOneTimeCode(code) as string, expiresAt }));
    await this.audit('SERVER_CLI', null, owner.user_id, 'SETUP_RESET_OWNER', { new_person: name !== null });
    return { ...this.pairingView(code, expiresAt, origin), user_id: owner.user_id, display_name: owner.display_name };
  }

  /**
   * `mellis` → a new recovery code (server CLI; shell access = owner). The old code stops working. For a server
   * restored from a backup that never had one (Cognito era) or when the note with the code is lost.
   */
  async replaceRecoveryCode(userId: string | null = null): Promise<{ recovery_code: string; user_id: string; display_name: string }> {
    const recoveryCode = newOneTimeCode(5);
    const owner = await this.run(() => this.store.replaceRecoveryCode({ recoveryCodeHash: hashOneTimeCode(recoveryCode) as string, userId }));
    await this.audit('SERVER_CLI', null, owner.user_id, 'SETUP_RECOVERY_CODE_REPLACED', {});
    return { recovery_code: recoveryCode, ...owner };
  }

  /** The server tool's owner list (`mellis-admin owners`): who to pair when there is more than one owner. */
  async listOwners(): Promise<OwnerSummary[]> {
    return this.store.listOwners();
  }

  /** The server tool's patient list: name, birth year, Nightscout address, whether a token is stored, newest reading. */
  async listPatientSources(): Promise<Array<Record<string, unknown>>> {
    return this.store.listPatientSources();
  }

  /**
   * `mellis` → Zmień ustawienia → Nightscout, and the restore of a backup (whose tokens are encrypted with the old
   * server's key): tests the Nightscout as the setup does (read-only token, a reading in the last 24 h) and stores it
   * for the patient, replacing what was there. Server CLI only. An address used by another patient is refused.
   */
  async replacePatientNightscout(patientId: string, rawUrl: unknown, rawToken: unknown, now = new Date()): Promise<Record<string, unknown>> {
    const patients = await this.store.listPatientSources();
    const patient = patients.find((entry) => entry.patient_id.toLowerCase() === patientId.trim().toLowerCase());
    if (!patient) throw coded('PATIENT_NOT_FOUND', 404, 'PATIENT_NOT_FOUND');
    const clients = patientNightscoutClientsFromEnv(this.pool, process.env);
    if (!clients) throw coded('NIGHTSCOUT_STORAGE_UNAVAILABLE', 503, 'NIGHTSCOUT_TOKEN_ENCRYPTION_KEY is not set on the server');
    const { result, token } = await this.probeNightscout(rawUrl, rawToken, now, patient.patient_id);
    await clients.saveCredentials(patient.patient_id, { baseUrl: result.base_url, token, authMode: 'ACCESS_TOKEN_JWT' });
    await this.audit('SERVER_CLI', null, null, 'NIGHTSCOUT_SOURCE_REPLACED', { patient_id: patient.patient_id, host: new URL(result.base_url).hostname });
    return { patient_id: patient.patient_id, display_name: patient.display_name, nightscout: result };
  }

  /** The same Nightscout test without storing anything (server CLI, before a restore asks for the patients' tokens). */
  async checkNightscout(rawUrl: unknown, rawToken: unknown, excludePatientId: string | null = null, now = new Date()): Promise<Record<string, unknown>> {
    const { result } = await this.probeNightscout(rawUrl, rawToken, now, excludePatientId);
    return { nightscout: result };
  }

  // Helpers -------------------------------------------------------------------------------------------------------------

  private async createPatientWithNightscout(body: unknown, ownerUserId: string | null, now: Date, duringSetup: boolean, coOwnerUserIds: string[] = []): Promise<{ patient: { patient_id: string; display_name: string; birth_year: number }; nightscout: NightscoutConnectionResult }> {
    const raw = (body ?? {}) as Record<string, unknown>;
    const displayName = parseFirstName(raw.display_name, 'display_name');
    const birthYear = raw.birth_year;
    const currentYear = now.getUTCFullYear();
    if (typeof birthYear !== 'number' || !Number.isInteger(birthYear) || birthYear < 1900 || birthYear > currentYear) {
      throw new ValidationError(`birth_year must be a whole year between 1900 and ${currentYear}`);
    }
    const clients = patientNightscoutClientsFromEnv(this.pool, process.env);
    if (!clients) throw coded('NIGHTSCOUT_STORAGE_UNAVAILABLE', 503, 'NIGHTSCOUT_TOKEN_ENCRYPTION_KEY is not set on the server');
    const nightscout = (raw.nightscout ?? {}) as Record<string, unknown>;
    const { result, token } = await this.probeNightscout(nightscout.url ?? nightscout.base_url, nightscout.token, now);
    // Device mode only (requireDeviceMode): the patient's remote control switch starts on; each person still needs an
    // owner's grant and their own confirmation. Cognito patients keep {"enabled": false} (migration 045's default).
    const { patient_id } = await this.run(() => this.store.createPatient({ displayName, birthYear, ownerUserId, onlyDuringSetup: duringSetup, coOwnerUserIds, remoteControlEnabled: true }));
    await clients.saveCredentials(patient_id, { baseUrl: result.base_url, token, authMode: 'ACCESS_TOKEN_JWT' });
    return { patient: { patient_id, display_name: displayName, birth_year: birthYear }, nightscout: result };
  }

  private async probeNightscout(rawUrl: unknown, rawToken: unknown, now: Date, excludePatientId: string | null = null): Promise<{ result: NightscoutConnectionResult; token: string }> {
    try {
      const input = parseNightscoutConnectionInput(rawUrl, rawToken);
      assertNightscoutHostAllowed(input.base_url, process.env);
      // The token is tested first: whether an address is already used is told only to someone holding its token.
      const result = await probeNightscout(input.base_url, this.probeClient(input.base_url, input.token), now);
      const host = new URL(input.base_url).hostname;
      const used = await this.pool.query(
        `SELECT 1 FROM sources WHERE source_system = 'NIGHTSCOUT' AND api_token_ciphertext IS NOT NULL
           AND lower(substring(base_url from '^[a-z]+://([^/:]+)')) = $1
           AND ($2::uuid IS NULL OR patient_id <> $2::uuid) LIMIT 1`,
        [host, excludePatientId],
      );
      if ((used.rowCount ?? 0) > 0) throw new NightscoutConnectionError('NIGHTSCOUT_ALREADY_USED');
      return { result, token: input.token };
    } catch (error) {
      if (error instanceof NightscoutConnectionError) throw coded(error.code, NIGHTSCOUT_ERROR_STATUS[error.code] ?? 422, error.code);
      throw error;
    }
  }

  private async challengeFor(deviceId: string, purpose: ChallengePurpose, patientId: string | null, now: Date): Promise<Record<string, unknown>> {
    const nonce = newNonce();
    const expiresAt = new Date(now.getTime() + CHALLENGE_TTL_MS);
    const device = await this.store.getDevice(deviceId);
    const created = device && !device.revoked_at ? await this.store.createChallenge({ deviceId, purpose, patientId, nonce, expiresAt }) : null;
    // A revoked or unknown device learns only that it must pair again.
    if (!created) throw coded('DEVICE_NOT_PAIRED', 401, 'This device is not paired with the server');
    return { challenge_id: created.challenge_id, nonce, expires_at: expiresAt.toISOString() };
  }

  private async issueSession(deviceId: string, now: Date): Promise<SessionView> {
    const token = newSessionToken();
    const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
    await this.store.createSession({ deviceId, tokenHash: sha256Hex(token), expiresAt });
    return { access_token: token, token_type: 'Bearer', expires_at: expiresAt.toISOString() };
  }

  private async pairedResponse(deviceId: string, userId: string, now: Date): Promise<Record<string, unknown>> {
    const [session, name, patients] = await Promise.all([
      this.issueSession(deviceId, now),
      this.store.getUserDisplayName(userId),
      this.repository.listAccessiblePatients(userId),
    ]);
    return { device_id: deviceId, user: { user_id: userId, display_name: name }, patients, session };
  }

  private pairingView(code: string, expiresAt: Date, requestOrigin: string | null): PairingCodeView {
    const server = publicServerUrl(requestOrigin);
    const url = new URL('mellis://pair');
    url.searchParams.set('server', server);
    url.searchParams.set('code', code);
    return { code, expires_at: expiresAt.toISOString(), pairing_url: url.toString() };
  }

  private configuredSetupCode(): string | null {
    const code = (process.env.SETUP_CODE ?? '').trim();
    return code.length >= 16 ? code : null;
  }

  private setupCodeMatches(headers: Record<string, unknown>): boolean {
    const expected = this.configuredSetupCode();
    const presented = headers[SETUP_CODE_HEADER];
    if (!expected || typeof presented !== 'string') return false;
    return secretsEqual(normalizeOneTimeCode(presented), normalizeOneTimeCode(expected));
  }

  /** The setup code works only while no owner's phone has paired; then every setup call is 409 SETUP_COMPLETED. */
  private async requireOpenSetup(headers: Record<string, unknown>): Promise<void> {
    this.requireDeviceMode();
    if (!this.configuredSetupCode()) throw coded('SETUP_CODE_NOT_CONFIGURED', 503, 'SETUP_CODE (at least 16 characters) is not set on the server');
    const state = await this.store.getSetupState();
    if (state.completed_at) throw coded('SETUP_COMPLETED', 409, 'The server is already set up');
    if (!this.setupCodeMatches(headers)) {
      this.logger.warn(JSON.stringify({ event: 'setup_code_refused' }));
      throw coded('SETUP_CODE_INVALID', 401, 'The setup code is not valid');
    }
  }

  private requireDeviceMode(): void {
    if (!DeviceAuthService.isDeviceMode()) throw coded('NOT_FOUND', 404, 'Not found');
  }

  /** The session's device id; device-mode routes refuse any other principal. */
  private requireDevicePrincipal(principal: RequestPrincipal): string {
    this.requireDeviceMode();
    if (principal.auth_provider !== 'DEVICE' || !principal.device_id) throw coded('DEVICE_SESSION_REQUIRED', 401, 'A device session is required');
    return principal.device_id;
  }

  private async run<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof DeviceAuthError) throw coded(error.code, DEVICE_AUTH_ERROR_STATUS[error.code], error.code);
      if (error instanceof SharingError) throw coded(error.code, SHARING_ERROR_STATUS[error.code] ?? 409, error.code);
      if (error instanceof DeviceAuthInputError) throw coded(error.code, 422, error.code);
      throw error;
    }
  }

  private async audit(provider: AuditProvider, subject: string | null, userId: string | null, eventType: string, metadata: Record<string, unknown>): Promise<void> {
    try {
      await this.repository.insertAuditEvent({ eventType, outcome: 'ALLOW', provider, providerSubject: subject, userId, requestPath: null, metadata });
    } catch {
      // best-effort audit only
    }
  }
}

function coded(code: string, status: number, message: string): CodedError {
  return new CodedError(code, status, message);
}

/** The phone has no registered bolus key: the app offers to set it up (POST /v1/me/devices/bolus-key). */
function bolusKeyRequired(): CodedError {
  return coded('BOLUS_KEY_REQUIRED', 403, 'This phone has no bolus key yet: confirm remote bolus on it first');
}

/** `co_owner_user_ids`: optional array of user ids (the caller and repeats dropped), at most MAX_CO_OWNERS. */
function parseCoOwnerIds(raw: unknown, callerUserId: string): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.some((id) => typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id))) {
    throw new ValidationError('co_owner_user_ids must be an array of user ids');
  }
  const ids = [...new Set(raw.map((id) => (id as string).toLowerCase()))].filter((id) => id !== callerUserId.toLowerCase());
  if (ids.length > MAX_CO_OWNERS) throw new ValidationError(`co_owner_user_ids may name at most ${MAX_CO_OWNERS} people`);
  return ids;
}

/** A first name (people have no e-mail): 1-40 characters after trimming, no control characters. */
function parseFirstName(raw: unknown, field = 'first_name'): string {
  const value = typeof raw === 'string' ? raw.normalize('NFC').trim().replace(/\s+/g, ' ') : '';
  if (!value || value.length > 40 || /[\u0000-\u001f\u007f]/.test(value)) throw new ValidationError(`${field} must be 1-40 characters`);
  return value;
}

/**
 * The device being paired, its key proven by its signature over pairingMessage(code, public_key) (v2). An older app's
 * bolus_public_key is accepted with both signatures over the v1 message.
 */
function parseNewDevice(raw: Record<string, unknown>, code: string): NewDevice {
  const device = (raw.device ?? {}) as Record<string, unknown>;
  const name = typeof device.name === 'string' ? device.name.normalize('NFC').trim().slice(0, 80) : '';
  if (!name) throw new ValidationError('device.name is required');
  const publicKey = String(device.public_key ?? '');
  const bolusPublicKey = typeof device.bolus_public_key === 'string' && device.bolus_public_key ? device.bolus_public_key : null;
  let keys;
  try {
    keys = [parseP256PublicKey(publicKey), bolusPublicKey ? parseP256PublicKey(bolusPublicKey) : null];
  } catch {
    throw new CodedError('PUBLIC_KEY_INVALID', 422, 'device.public_key (and device.bolus_public_key when sent) must be P-256 public keys (X9.63, base64)');
  }
  if (publicKey === bolusPublicKey) throw new CodedError('PUBLIC_KEY_INVALID', 422, 'The two device keys must differ');
  const message = pairingMessage(code, publicKey, bolusPublicKey);
  if (!verifyDeviceSignature(keys[0]!, message, raw.signature) || (keys[1] && !verifyDeviceSignature(keys[1], message, raw.bolus_signature))) {
    throw new CodedError('PAIRING_SIGNATURE_INVALID', 401, 'The pairing request is not signed by the device key');
  }
  const clientDeviceId = typeof device.client_device_id === 'string' && device.client_device_id.trim() ? device.client_device_id.trim().slice(0, 200) : null;
  return { name, publicKey, bolusPublicKey, clientDeviceId };
}

function parsePermissionsInput(raw: unknown, partial = false): Partial<SharingPermissions> {
  const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  if (!value) throw new ValidationError('permissions must be an object');
  const result: Partial<SharingPermissions> = {};
  for (const key of ['glucose_alerts', 'ai_chat_meals', 'manage_sharing', 'remote_commands'] as const) {
    if (value[key] === undefined && partial) continue;
    if (value[key] !== undefined && typeof value[key] !== 'boolean') throw new ValidationError(`permissions.${key} must be a boolean`);
    result[key] = value[key] === true;
  }
  return result;
}

/** PUBLIC_BASE_URL when set (behind a proxy), else the address the request came to. */
function publicServerUrl(requestOrigin: string | null): string {
  const configured = (process.env.PUBLIC_BASE_URL ?? '').trim().replace(/\/+$/, '');
  return configured || requestOrigin || 'http://localhost:3000';
}

function toDeviceView(row: DeviceRow, thisDeviceId: string): DeviceView {
  return { device_id: row.id, user_id: row.user_id, name: row.name, created_at: row.created_at, last_seen_at: row.last_seen_at, this_device: row.id === thisDeviceId, has_bolus_key: !!row.bolus_public_key };
}

function toHandoffView(row: HandoffRow): Record<string, unknown> {
  return {
    handoff_id: row.handoff_id,
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
    created_at: row.created_at,
    expires_at: row.expires_at,
    consumed_at: row.consumed_at,
  };
}

function toInvitationView(invitation: SharingInvitation): Record<string, unknown> {
  return {
    invitation_id: invitation.id,
    first_name: invitation.invitee_name,
    permissions: invitation.permissions,
    created_at: invitation.created_at,
    expires_at: invitation.expires_at,
  };
}
