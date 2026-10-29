import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ValidationError } from '@shared/errors/app-error';
import { ApiService } from '../application/api.service';
import { BearerPrincipalGuard } from '../auth/bearer-principal.guard';
import { MeController } from './me.controller';

const USER = '55555555-5555-4555-8555-555555555555';
const PATIENT_A = '11111111-1111-4111-8111-111111111111';

describe('POST /v1/me/devices/sign-out (HTTP)', () => {
  let app: INestApplication;
  const apiService = { signOutDevice: vi.fn(async () => undefined) };
  const auth = { authenticateBearerToken: vi.fn(async () => ({ userId: USER, providerSubject: 'sub-1' })) };

  beforeAll(async () => {
    vi.stubEnv('AUTH_MODE', 'cognito');
    const moduleRef = await Test.createTestingModule({
      controllers: [MeController],
      providers: [{ provide: ApiService, useValue: apiService }],
    })
      // The real guard with a stubbed Cognito check (no decorator metadata under vitest to inject it by type).
      .overrideGuard(BearerPrincipalGuard)
      .useValue(new BearerPrincipalGuard(auth as any))
      .compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.init();
  });

  afterEach(() => {
    apiService.signOutDevice.mockClear();
  });

  afterAll(async () => {
    await app.close();
    vi.unstubAllEnvs();
  });

  it('deactivates the token for the caller and answers 204 with no body', async () => {
    const response = await request(app.getHttpServer())
      .post('/v1/me/devices/sign-out')
      .set('Authorization', 'Bearer valid.jwt')
      .send({ push_token: 'token-a', platform: 'ios' });

    expect(response.status).toBe(204);
    expect(response.text).toBe('');
    expect(apiService.signOutDevice).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: USER, auth_provider: 'COGNITO' }),
      { push_token: 'token-a', platform: 'ios' },
    );
  });

  it('answers a missing token with 401 UNAUTHENTICATED as application/problem+json', async () => {
    const response = await request(app.getHttpServer()).post('/v1/me/devices/sign-out').send({ push_token: 'token-a', platform: 'ios' });

    expect(response.status).toBe(401);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(JSON.parse(response.text)).toMatchObject({ status: 401, code: 'UNAUTHENTICATED' });
    expect(apiService.signOutDevice).not.toHaveBeenCalled();
  });

  it('answers a malformed body with 422 problem details', async () => {
    apiService.signOutDevice.mockRejectedValueOnce(new ValidationError('push_token is required'));
    const response = await request(app.getHttpServer())
      .post('/v1/me/devices/sign-out')
      .set('Authorization', 'Bearer valid.jwt')
      .send({ platform: 'ios' });

    expect(response.status).toBe(422);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(JSON.parse(response.text)).toMatchObject({ code: 'VALIDATION_ERROR', title: 'push_token is required' });
  });
});

describe('ApiService.signOutDevice', () => {
  function setup() {
    const repo = {
      deactivatePatientDevicesForUser: vi.fn(async () => 2),
      insertAuditEvent: vi.fn(async () => undefined),
      getAccessRow: vi.fn(async () => ({ can_read_patient: true, can_write_patient: true })),
      listActivePatientDevices: vi.fn(async () => []),
      upsertPatientDevice: vi.fn(async () => ({ id: 'd-1' })),
    };
    return { repo, api: new ApiService(repo as any, {} as any) };
  }

  it('deactivates the trimmed token for the caller and audits it with the real provider', async () => {
    const { repo, api } = setup();
    await api.signOutDevice({ user_id: USER, auth_provider: 'LOCAL_TOKEN', auth_subject: `local-token:${USER}` }, { push_token: ' token-a ', platform: 'ios' });

    expect(repo.deactivatePatientDevicesForUser).toHaveBeenCalledWith(USER, 'ios', 'token-a');
    expect(repo.insertAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'DEVICE_SIGNED_OUT', provider: 'LOCAL_TOKEN', metadata: { platform: 'ios', deactivated_devices: 2 } }));
  });

  it('still signs out when the audit row cannot be written', async () => {
    const { repo, api } = setup();
    repo.insertAuditEvent.mockRejectedValueOnce(new Error('db down'));
    await expect(api.signOutDevice({ user_id: USER }, { push_token: 'token-a', platform: 'ios' })).resolves.toBeUndefined();
    expect(repo.deactivatePatientDevicesForUser).toHaveBeenCalled();
  });

  it('refuses another platform or a missing token with 422', async () => {
    const { repo, api } = setup();
    await expect(api.signOutDevice({ user_id: USER }, { push_token: 'token-a', platform: 'android' })).rejects.toBeInstanceOf(ValidationError);
    await expect(api.signOutDevice({ user_id: USER }, { push_token: '  ', platform: 'ios' })).rejects.toBeInstanceOf(ValidationError);
    await expect(api.signOutDevice({ user_id: USER }, { push_token: 7, platform: 'ios' })).rejects.toBeInstanceOf(ValidationError);
    expect(repo.deactivatePatientDevicesForUser).not.toHaveBeenCalled();
  });

  it('audits device registration with the provider that authenticated the request', async () => {
    const { repo, api } = setup();
    await api.registerDevice({ user_id: USER, auth_provider: 'LOCAL_DEV' }, PATIENT_A, { platform: 'ios', device_id: 'dev-1', push_token: 'token-a' });
    expect(repo.insertAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'DEVICE_REGISTERED', provider: 'LOCAL_DEV' }));
  });

  it('audits denied patient access with the request provider (Cognito when unset)', async () => {
    const { repo, api } = setup();
    repo.getAccessRow.mockResolvedValueOnce(null as any);
    await expect(api.getPendingInvestigation({ user_id: USER }, PATIENT_A)).rejects.toThrow('Patient access denied');
    expect(repo.insertAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'PATIENT_ACCESS_DENIED', provider: 'COGNITO' }));
  });
});
