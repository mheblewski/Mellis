import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CodedError } from '@shared/errors/app-error';
import { FakeDeviceKey } from '@modules/device-auth/testing/fake-device-keys';
import { pairingMessage } from '@modules/device-auth/domain/device-crypto';
import { patientRouteScope } from '../auth/patient-permission.guard';
import { DeviceAuthService } from './device-auth.service';
import type { RequestPrincipal } from '../auth/bearer-principal.guard';

const PATIENT = '11111111-1111-4111-8111-111111111111';
const principal: RequestPrincipal = { user_id: '22222222-2222-4222-8222-222222222222', auth_provider: 'DEVICE', auth_subject: 'device:d1', device_id: '33333333-3333-4333-8333-333333333333' };

/** The service with its stores replaced by stubs: no database. */
function service(store: Record<string, unknown>, ownsAPatient = true): DeviceAuthService {
  const pool = { query: vi.fn(async () => ({ rowCount: ownsAPatient ? 1 : 0, rows: [] })) };
  const instance = new DeviceAuthService(pool as never, { insertAuditEvent: vi.fn() } as never);
  Object.assign((instance as unknown as { store: Record<string, unknown> }).store, store);
  return instance;
}

async function codeOf(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    return error instanceof CodedError ? error.code : (error as Error).constructor.name;
  }
  return 'NO_ERROR';
}

describe('DeviceAuthService (AUTH_MODE=device), without a database', () => {
  const previousMode = process.env.AUTH_MODE;
  beforeAll(() => {
    process.env.AUTH_MODE = 'device';
  });
  afterAll(() => {
    if (previousMode === undefined) delete process.env.AUTH_MODE;
    else process.env.AUTH_MODE = previousMode;
  });

  it('gives a remote bolus challenge only to a person with an effective grant, on a phone with a bolus key', async () => {
    const createChallenge = vi.fn(async () => ({ challenge_id: 'c1' }));
    const base = { isMemberOf: async () => true, getPatientDisplayName: async () => 'Zosia', createChallenge };
    const device = { id: principal.device_id, revoked_at: null, public_key: 'K', bolus_public_key: null };
    expect(await codeOf(service({ ...base, hasEffectiveRemoteBolus: async () => false, getDevice: async () => device }).signingChallenge(principal, PATIENT, { purpose: 'REMOTE_BOLUS' }))).toBe('REMOTE_BOLUS_NOT_PERMITTED');
    expect(await codeOf(service({ ...base, hasEffectiveRemoteBolus: async () => true, getDevice: async () => device }).signingChallenge(principal, PATIENT, { purpose: 'REMOTE_BOLUS' }))).toBe('BOLUS_KEY_REQUIRED');
    expect(createChallenge).not.toHaveBeenCalled();
    // The grantee's confirmation challenge comes before the bolus key exists (one Face ID signs both).
    const confirm = await service({ ...base, hasEffectiveRemoteBolus: async () => false, getDevice: async () => device }).signingChallenge(principal, PATIENT, { purpose: 'REMOTE_BOLUS_CONFIRM' });
    expect(confirm).toMatchObject({ challenge_id: 'c1', patient_id: PATIENT, patient_name: 'Zosia' });
    const withKey = await service({ ...base, hasEffectiveRemoteBolus: async () => true, getDevice: async () => ({ ...device, bolus_public_key: 'B' }) }).signingChallenge(principal, PATIENT, { purpose: 'REMOTE_BOLUS' });
    expect(withKey).toMatchObject({ challenge_id: 'c1' });
  });

  it('refuses a remote command from a phone without a bolus key with BOLUS_KEY_REQUIRED', async () => {
    const key = new FakeDeviceKey();
    const envelope = key.signPayload({ v: 1, type: 'remote_command', challenge_id: 'c', nonce: 'n', device_id: principal.device_id, patient_id: PATIENT, patient_name: 'Zosia', insulin_u: 1, carbs_g: 10, confirmation: 'x' });
    const store = { getDevice: async () => ({ id: principal.device_id, revoked_at: null, public_key: key.publicKey, bolus_public_key: null }), getPatientDisplayName: async () => 'Zosia' };
    expect(await codeOf(service(store).verifySignedRemoteCommand(principal, PATIENT, { insulin_u: 1, carbs_g: 10 }, envelope))).toBe('BOLUS_KEY_REQUIRED');
  });

  it('checks co_owner_user_ids before the Nightscout is tested', async () => {
    const allowedCoOwners = vi.fn(async () => []);
    const instance = service({ allowedCoOwners });
    const probe = vi.fn();
    instance.probeClient = probe as never;
    expect(await codeOf(instance.createPatient(principal, { co_owner_user_ids: 'x' }))).toBe('ValidationError');
    expect(await codeOf(instance.createPatient(principal, { co_owner_user_ids: ['not-a-uuid'] }))).toBe('ValidationError');
    expect(await codeOf(instance.createPatient(principal, { co_owner_user_ids: ['44444444-4444-4444-8444-444444444444'] }))).toBe('CO_OWNER_NOT_ALLOWED');
    expect(allowedCoOwners).toHaveBeenCalledWith(expect.anything(), principal.user_id, ['44444444-4444-4444-8444-444444444444']);
    expect(probe).not.toHaveBeenCalled();
    expect(await codeOf(service({ allowedCoOwners }, false).createPatient(principal, {}))).toBe('NOT_AN_OWNER');
  });

  it('pairs with the device key alone: a pairing without bolus fields reaches the store with no bolus key', async () => {
    const key = new FakeDeviceKey();
    const code = 'ABCDE-FGHJK-MNPQR-STVWX';
    const pairWithCode = vi.fn(async () => ({ device_id: principal.device_id, user_id: principal.user_id, purpose: 'ADD_DEVICE', patient_id: null }));
    const instance = service({ pairWithCode, createSession: vi.fn(), getUserDisplayName: async () => 'Tomek' });
    (instance as unknown as { repository: Record<string, unknown> }).repository.listAccessiblePatients = async () => [];
    const body = { code, device: { name: 'iPhone', public_key: key.publicKey }, signature: key.sign(pairingMessage(code, key.publicKey)) };
    await instance.pair(body);
    expect(pairWithCode).toHaveBeenCalledWith(expect.objectContaining({ device: { name: 'iPhone', publicKey: key.publicKey, bolusPublicKey: null, clientDeviceId: null } }));
    expect(await codeOf(instance.pair({ ...body, signature: new FakeDeviceKey().sign(pairingMessage(code, key.publicKey)) }))).toBe('PAIRING_SIGNATURE_INVALID');
  });

  it('lets members with glucose only read the Nightscout summary', () => {
    expect(patientRouteScope('/v1/patients/:patientId/nightscout')).toBe('glucose');
    expect(patientRouteScope('/v1/patients/:patientId/signing-challenges')).toBe('care');
  });
});
