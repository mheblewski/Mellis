import { UnauthorizedException } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BearerPrincipalGuard } from './bearer-principal.guard';
import { createHash } from 'crypto';

describe('BearerPrincipalGuard', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('rejects missing bearer tokens', async () => {
    vi.stubEnv('AUTH_MODE', 'cognito');

    const authService = {
      authenticateBearerToken: vi.fn(),
    } as any;

    const guard = new BearerPrincipalGuard(authService);
    const request = { headers: {}, path: '/v1/patients/patient-1/current-state' };
    const context = {
      switchToHttp: () => ({ getRequest: () => request }),
    } as any;

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(authService.authenticateBearerToken).not.toHaveBeenCalled();
  });

  it('rejects malformed authorization headers', async () => {
    vi.stubEnv('AUTH_MODE', 'cognito');

    const authService = {
      authenticateBearerToken: vi.fn(),
    } as any;

    const guard = new BearerPrincipalGuard(authService);
    const request = {
      headers: { authorization: 'Token abc123' },
      path: '/v1/patients/patient-1/current-state',
    };
    const context = {
      switchToHttp: () => ({ getRequest: () => request }),
    } as any;

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(authService.authenticateBearerToken).not.toHaveBeenCalled();
  });

  it('binds the authenticated principal to the request', async () => {
    vi.stubEnv('AUTH_MODE', 'cognito');

    const authService = {
      authenticateBearerToken: vi.fn().mockResolvedValue({
        userId: 'user-1',
        providerSubject: 'cognito-sub-1',
      }),
    } as any;

    const guard = new BearerPrincipalGuard(authService);
    const request = {
      headers: { authorization: 'Bearer valid.jwt' },
      path: '/v1/patients/patient-1/current-state',
    };
    const context = {
      switchToHttp: () => ({ getRequest: () => request }),
    } as any;

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(authService.authenticateBearerToken).toHaveBeenCalledWith(
      'valid.jwt',
      '/v1/patients/patient-1/current-state',
    );
    expect(request.principal).toMatchObject({
      user_id: 'user-1',
      auth_provider: 'COGNITO',
      auth_subject: 'cognito-sub-1',
    });
  });

  it('in disabled mode it injects a deterministic local principal without bearer token', async () => {
    vi.stubEnv('AUTH_MODE', 'disabled');
    vi.stubEnv('AUTH_DISABLED_USER_ID', '22222222-2222-4222-8222-222222222222');

    const authService = {
      authenticateBearerToken: vi.fn(),
    } as any;

    const guard = new BearerPrincipalGuard(authService);
    const request = { headers: {}, path: '/v1/me/patients' };
    const context = {
      switchToHttp: () => ({ getRequest: () => request }),
    } as any;

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(authService.authenticateBearerToken).not.toHaveBeenCalled();
    expect(request.principal).toMatchObject({
      user_id: '22222222-2222-4222-8222-222222222222',
      auth_provider: 'LOCAL_DEV',
      auth_subject: 'local-dev:22222222-2222-4222-8222-222222222222',
    });
  });
});
describe('BearerPrincipalGuard AUTH_MODE=local_token', () => {
  // Synthetic test value only; real tokens are generated locally and never committed.
  const TOKEN = 'synthetic-local-token-for-tests-only';
  const TOKEN_SHA256 = createHash('sha256').update(TOKEN).digest('hex');
  const USER_ID = '00000000-0000-4000-8000-0000000000aa';

  const stubLocalTokenEnv = (overrides: Record<string, string> = {}) => {
    vi.stubEnv('AUTH_MODE', 'local_token');
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('ALLOW_AUTH_DISABLED_IN_LOCAL', 'false');
    vi.stubEnv('LOCAL_AUTH_USER_ID', USER_ID);
    vi.stubEnv('LOCAL_AUTH_TOKEN_SHA256', TOKEN_SHA256);
    for (const [key, value] of Object.entries(overrides)) vi.stubEnv(key, value);
  };

  const run = async (headers: Record<string, string>, body: Record<string, unknown> = {}) => {
    const authService = { authenticateBearerToken: vi.fn() } as any;
    const guard = new BearerPrincipalGuard(authService);
    const request: Record<string, any> = { headers, body, path: '/v1/me/patients' };
    const context = { switchToHttp: () => ({ getRequest: () => request }) } as any;
    const outcome = await guard.canActivate(context).then((value) => ({ value }), (error: unknown) => ({ error }));
    return { ...outcome, request, authService };
  };

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('accepts the configured token and binds the principal from configuration only', async () => {
    stubLocalTokenEnv();
    const result = await run({ authorization: `Bearer ${TOKEN}` }, { user_id: 'attacker-supplied-id' });
    expect(result).toMatchObject({ value: true });
    expect(result.request.principal).toEqual({ user_id: USER_ID, auth_provider: 'LOCAL_TOKEN', auth_subject: `local-token:${USER_ID}` });
    expect(result.authService.authenticateBearerToken).not.toHaveBeenCalled();
  });

  it('rejects a missing, empty, malformed or wrong token with 401', async () => {
    stubLocalTokenEnv();
    for (const headers of [{}, { authorization: 'Bearer ' }, { authorization: `Token ${TOKEN}` }, { authorization: `Bearer ${TOKEN}x` }, { authorization: `Bearer ${TOKEN_SHA256}` }]) {
      const result = await run(headers);
      expect((result as { error?: unknown }).error).toBeInstanceOf(UnauthorizedException);
      expect(result.request.principal).toBeUndefined();
    }
  });

  it('fails closed with 401 when the configuration is missing, outside development, or disabled auth is still allowed', async () => {
    for (const overrides of [
      { LOCAL_AUTH_TOKEN_SHA256: '' },
      { LOCAL_AUTH_TOKEN_SHA256: 'not-a-hash' },
      { LOCAL_AUTH_USER_ID: '' },
      { NODE_ENV: 'production' },
      { NODE_ENV: 'test' },
      { ALLOW_AUTH_DISABLED_IN_LOCAL: 'true' },
    ]) {
      vi.unstubAllEnvs();
      stubLocalTokenEnv(overrides);
      const result = await run({ authorization: `Bearer ${TOKEN}` });
      expect((result as { error?: unknown }).error).toBeInstanceOf(UnauthorizedException);
      // Never falls back to the disabled-mode principal.
      expect(result.request.principal).toBeUndefined();
    }
  });

  it('never puts the token or its hash into errors or logs', async () => {
    stubLocalTokenEnv();
    const logs: string[] = [];
    for (const method of ['log', 'warn', 'error', 'info', 'debug'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(' ')); });
    }
    const wrong = await run({ authorization: `Bearer ${TOKEN}-wrong` });
    const error = (wrong as { error?: UnauthorizedException }).error;
    const serialized = JSON.stringify({ message: error?.message, response: error?.getResponse() });
    for (const secret of [TOKEN, TOKEN_SHA256]) {
      expect(serialized).not.toContain(secret);
      expect(logs.join('\n')).not.toContain(secret);
    }
  });

  it('keeps AUTH_MODE=disabled unchanged: no token needed, configured local-dev principal', async () => {
    vi.stubEnv('AUTH_MODE', 'disabled');
    vi.stubEnv('AUTH_DISABLED_USER_ID', USER_ID);
    const result = await run({});
    expect(result).toMatchObject({ value: true });
    expect(result.request.principal).toMatchObject({ user_id: USER_ID, auth_provider: 'LOCAL_DEV' });
  });
});

describe('BearerPrincipalGuard AUTH_MODE=device', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const contextFor = (authorization?: string) => {
    const request: Record<string, unknown> = { headers: authorization ? { authorization } : {}, path: '/v1/me/patients' };
    return { request, context: { switchToHttp: () => ({ getRequest: () => request }) } as any };
  };

  it('binds the session device and person and never asks Cognito', async () => {
    vi.stubEnv('AUTH_MODE', 'device');
    const cognito = { authenticateBearerToken: vi.fn() } as any;
    const principal = { user_id: 'u1', auth_provider: 'DEVICE', auth_subject: 'device:d1', device_id: 'd1' };
    const devices = { resolveSessionToken: vi.fn().mockImplementation(async (token: string) => (token === 'mls_good' ? principal : null)) } as any;
    const guard = new BearerPrincipalGuard(cognito, devices);
    const ok = contextFor('Bearer mls_good');
    await expect(guard.canActivate(ok.context)).resolves.toBe(true);
    expect(ok.request.principal).toEqual(principal);
    await expect(guard.canActivate(contextFor('Bearer mls_bad').context)).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(guard.canActivate(contextFor().context)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(cognito.authenticateBearerToken).not.toHaveBeenCalled();
  });

  it('fails closed without the device session service', async () => {
    vi.stubEnv('AUTH_MODE', 'device');
    const guard = new BearerPrincipalGuard({ authenticateBearerToken: vi.fn() } as any);
    await expect(guard.canActivate(contextFor('Bearer mls_any').context)).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
