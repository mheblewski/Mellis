import { UnauthorizedException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CognitoAuthService } from './cognito-auth.service';

const mockVerify = vi.fn();

vi.mock('aws-jwt-verify', () => ({
  CognitoJwtVerifier: {
    create: vi.fn(() => ({ verify: mockVerify })),
  },
}));

describe('CognitoAuthService', () => {
  beforeEach(() => {
    mockVerify.mockReset();
  });

  it('rejects invalid signatures without writing a database row', async () => {
    mockVerify.mockRejectedValue(new Error('Signature verification failed'));

    const repository = {
      resolveOrCreateUserByCognitoSubject: vi.fn(),
      insertAuditEvent: vi.fn().mockResolvedValue(undefined),
    } as any;

    const configService = {
      getOrThrow: vi.fn((key: string) => {
        if (key === 'COGNITO_USER_POOL_ID') return 'eu-central-1_example';
        if (key === 'COGNITO_CLIENT_ID') return 'client-id';
        if (key === 'COGNITO_TOKEN_USE') return 'access';
        return '';
      }),
      get: vi.fn((key: string) => (key === 'COGNITO_TOKEN_USE' ? 'access' : undefined)),
    } as any;

    const service = new CognitoAuthService(configService, repository);

    await expect(service.authenticateBearerToken('bad.jwt', '/v1/patients/patient-1/current-state')).rejects.toBeInstanceOf(UnauthorizedException);
    expect(repository.insertAuditEvent).not.toHaveBeenCalled();
  });

  it('rejects expired tokens with a detectable auth failure and no audit row', async () => {
    mockVerify.mockRejectedValue(new Error('Token expired'));

    const repository = {
      resolveOrCreateUserByCognitoSubject: vi.fn(),
      insertAuditEvent: vi.fn().mockResolvedValue(undefined),
    } as any;

    const configService = {
      getOrThrow: vi.fn((key: string) => {
        if (key === 'COGNITO_USER_POOL_ID') return 'eu-central-1_example';
        if (key === 'COGNITO_CLIENT_ID') return 'client-id';
        if (key === 'COGNITO_TOKEN_USE') return 'access';
        return '';
      }),
      get: vi.fn((key: string) => (key === 'COGNITO_TOKEN_USE' ? 'access' : undefined)),
    } as any;

    const service = new CognitoAuthService(configService, repository);

    await expect(service.authenticateBearerToken('expired.jwt', '/v1/patients/patient-1/current-state')).rejects.toBeInstanceOf(UnauthorizedException);
    expect(repository.insertAuditEvent).not.toHaveBeenCalled();
  });

  it('writes the sign-in audit row only when the identity was new or not seen for a while', async () => {
    mockVerify.mockResolvedValue({ sub: 'subject-1', email: 'a@example.com' });
    const repository = {
      resolveOrCreateUserByCognitoSubject: vi.fn()
        .mockResolvedValueOnce({ userId: 'user-1', touched: true })
        .mockResolvedValueOnce({ userId: 'user-1', touched: false }),
      insertAuditEvent: vi.fn().mockResolvedValue(undefined),
    } as any;
    const configService = {
      getOrThrow: vi.fn((key: string) => (key === 'COGNITO_TOKEN_USE' ? 'access' : 'x')),
      get: vi.fn(() => 'access'),
    } as any;
    const service = new CognitoAuthService(configService, repository);

    await expect(service.authenticateBearerToken('good.jwt', '/v1/me/patients')).resolves.toEqual({ userId: 'user-1', providerSubject: 'subject-1' });
    await expect(service.authenticateBearerToken('good.jwt', '/v1/me/patients')).resolves.toEqual({ userId: 'user-1', providerSubject: 'subject-1' });

    expect(repository.insertAuditEvent).toHaveBeenCalledTimes(1);
    expect(repository.insertAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'AUTHENTICATE_BEARER_TOKEN', outcome: 'ALLOW', userId: 'user-1' }));
  });
});
