import 'reflect-metadata';
import type { Request } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeviceAuthService, pairingServerUrl } from '../application/device-auth.service';
import { loopbackOrigin } from './device-auth.controller';

function fakeRequest(remoteAddress: string, headers: Record<string, string>): Request {
  return { headers, socket: { remoteAddress } } as unknown as Request;
}

describe('pairing links never trust the client-supplied Host (PUBLIC_BASE_URL)', () => {
  const saved = { PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL, AUTH_MODE: process.env.AUTH_MODE };
  beforeEach(() => {
    delete process.env.PUBLIC_BASE_URL;
    process.env.AUTH_MODE = 'device';
  });
  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('uses PUBLIC_BASE_URL when set, whatever the request says', () => {
    process.env.PUBLIC_BASE_URL = 'https://mellis.example/';
    expect(pairingServerUrl(null)).toBe('https://mellis.example');
    expect(pairingServerUrl('http://localhost:3000')).toBe('https://mellis.example');
  });

  it('without PUBLIC_BASE_URL refuses with PUBLIC_BASE_URL_MISSING (503)', () => {
    expect(() => pairingServerUrl(null)).toThrow(expect.objectContaining({ code: 'PUBLIC_BASE_URL_MISSING', httpStatus: 503 }));
  });

  it('takes a loopback origin only from a loopback peer with a loopback Host and no forwarding headers', () => {
    expect(loopbackOrigin(fakeRequest('127.0.0.1', { host: 'localhost:3000' }))).toBe('http://localhost:3000');
    expect(loopbackOrigin(fakeRequest('::ffff:127.0.0.1', { host: '127.0.0.1:3000' }))).toBe('http://127.0.0.1:3000');
    expect(loopbackOrigin(fakeRequest('::1', { host: '[::1]:3000' }))).toBe('http://[::1]:3000');
    // A forged Host or X-Forwarded-Host never becomes the link's server.
    expect(loopbackOrigin(fakeRequest('127.0.0.1', { host: 'evil.example' }))).toBeNull();
    expect(loopbackOrigin(fakeRequest('127.0.0.1', { host: 'localhost:3000', 'x-forwarded-host': 'evil.example' }))).toBeNull();
    expect(loopbackOrigin(fakeRequest('172.18.0.5', { host: 'localhost:3000' }))).toBeNull();
    expect(loopbackOrigin(fakeRequest('127.0.0.1', { host: 'localhost.evil.example' }))).toBeNull();
  });

  it('refuses before anything is written: no pairing code is stored', async () => {
    const store = { createPairingCode: vi.fn(async () => undefined) };
    const service = Object.create(DeviceAuthService.prototype) as DeviceAuthService;
    Object.assign(service as unknown as Record<string, unknown>, { store });
    await expect(service.createOwnPairingCode({ user_id: 'u1', auth_provider: 'DEVICE', device_id: 'd1' }, null)).rejects.toMatchObject({ code: 'PUBLIC_BASE_URL_MISSING' });
    expect(store.createPairingCode).not.toHaveBeenCalled();
  });
});
