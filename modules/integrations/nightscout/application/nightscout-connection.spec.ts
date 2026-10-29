import { describe, expect, it } from 'vitest';
import {
  assertNightscoutHostAllowed,
  classifyNightscoutFailure,
  parseNightscoutConnectionInput,
  probeNightscout,
  uploaderName,
  type NightscoutProbeClient,
} from './nightscout-connection';
import { NightscoutClientError } from '../infrastructure/http-nightscout-client';

const NOW = new Date('2026-10-27T12:00:00.000Z');

function client(overrides: Partial<NightscoutProbeClient> = {}): NightscoutProbeClient {
  return {
    fetchRecentEntries: async () => [{ sgv: 132, date: NOW.getTime() - 4 * 60_000 }, { sgv: 128, date: NOW.getTime() - 9 * 60_000 }],
    fetchLatestDeviceStatus: async () => ({ device: 'Trio', openaps: {} }),
    fetchProfiles: async () => ({ profiles: [{ defaultProfile: 'Default', startDate: '2026-10-01T00:00:00Z', store: { Default: { units: 'mmol', timezone: 'Europe/Warsaw' } } }] }),
    ...overrides,
  };
}

describe('Nightscout connection', () => {
  it('splits a pasted link into address and token, assumes https and keeps only the origin', () => {
    expect(parseNightscoutConnectionInput('https://Janek.NS.example/?token=reader-abc123', '')).toEqual({ base_url: 'https://janek.ns.example', token: 'reader-abc123' });
    expect(parseNightscoutConnectionInput(' janek.ns.example/api ', ' reader-x ')).toEqual({ base_url: 'https://janek.ns.example', token: 'reader-x' });
    expect(() => parseNightscoutConnectionInput('', 't')).toThrow('NIGHTSCOUT_ADDRESS_INVALID');
    expect(() => parseNightscoutConnectionInput('not a host', 't')).toThrow('NIGHTSCOUT_ADDRESS_INVALID');
    expect(() => parseNightscoutConnectionInput('ftp://x.example', 't')).toThrow('NIGHTSCOUT_ADDRESS_INVALID');
    expect(() => parseNightscoutConnectionInput('https://x.example', '')).toThrow('NIGHTSCOUT_TOKEN_MISSING');
  });

  it('refuses plain http and local or private hosts, and follows the allowed and blocked lists', () => {
    expect(() => assertNightscoutHostAllowed('https://ns.example', {})).not.toThrow();
    for (const url of ['http://ns.example', 'https://localhost', 'https://127.0.0.1', 'https://10.0.0.5', 'https://192.168.1.2', 'https://mac.local', 'https://169.254.169.254']) {
      expect(() => assertNightscoutHostAllowed(url, {}), url).toThrow('NIGHTSCOUT_HOST_NOT_ALLOWED');
    }
    const testEnv = { NIGHTSCOUT_ALLOWED_HOSTS: 'test-ns.example.org, localhost', NIGHTSCOUT_BLOCKED_HOSTS: 'home-ns.example.net' };
    expect(() => assertNightscoutHostAllowed('https://test-ns.example.org', testEnv)).not.toThrow();
    expect(() => assertNightscoutHostAllowed('http://localhost', testEnv)).not.toThrow();
    expect(() => assertNightscoutHostAllowed('https://home-ns.example.net', testEnv)).toThrow('NIGHTSCOUT_HOST_NOT_ALLOWED');
    expect(() => assertNightscoutHostAllowed('https://other.example', testEnv)).toThrow('NIGHTSCOUT_HOST_NOT_ALLOWED');
    expect(() => assertNightscoutHostAllowed('https://home-ns.example.net', { NIGHTSCOUT_BLOCKED_HOSTS: 'home-ns.example.net' })).toThrow('NIGHTSCOUT_HOST_NOT_ALLOWED');
  });

  it('reports the newest reading of 24 h, the uploader, units and time zone', async () => {
    await expect(probeNightscout('https://ns.example', client(), NOW)).resolves.toEqual({
      base_url: 'https://ns.example',
      last_reading: { value: 132, unit: 'mg/dL', at: '2026-10-27T11:56:00.000Z', age_minutes: 4 },
      uploader: 'Trio',
      units: 'mmol/L',
      timezone: 'Europe/Warsaw',
    });
  });

  it('names what the person can fix: no readings, refused or admin token, no Nightscout there', async () => {
    await expect(probeNightscout('https://ns.example', client({ fetchRecentEntries: async () => [] }), NOW)).rejects.toThrow('NIGHTSCOUT_NO_RECENT_READINGS');
    await expect(probeNightscout('https://ns.example', client({ fetchRecentEntries: async () => { throw new NightscoutClientError('Nightscout credentials rejected', false, 401); } }), NOW))
      .rejects.toThrow('NIGHTSCOUT_TOKEN_INVALID');
    expect(classifyNightscoutFailure(new NightscoutClientError('Nightscout access token grants admin permissions; use a read-only token', false))).toBe('NIGHTSCOUT_TOKEN_ADMIN');
    expect(classifyNightscoutFailure(new NightscoutClientError('Nightscout request failed with status 404', false, 404))).toBe('NIGHTSCOUT_UNREACHABLE');
    expect(classifyNightscoutFailure(new Error('getaddrinfo ENOTFOUND'))).toBe('NIGHTSCOUT_UNREACHABLE');
    // Status and profile are optional: the reading alone is enough.
    await expect(probeNightscout('https://ns.example', client({ fetchLatestDeviceStatus: async () => { throw new Error('x'); }, fetchProfiles: async () => { throw new Error('x'); } }), NOW))
      .resolves.toMatchObject({ uploader: null, units: null, timezone: null });
  });

  it('recognises the common loop apps', () => {
    expect(uploaderName({ device: 'Trio' })).toBe('Trio');
    expect(uploaderName({ device: 'loop://iPhone' })).toBe('Loop');
    expect(uploaderName({ device: 'openaps://AndroidAPS' })).toBe('AndroidAPS');
    expect(uploaderName(null)).toBeNull();
  });

  it('takes a Nightscout on the same Docker network only when the server lists its name', () => {
    const typed = parseNightscoutConnectionInput('http://nightscout:1337', 'reader-abc');
    expect(typed.base_url).toBe('http://nightscout:1337');
    expect(() => assertNightscoutHostAllowed(typed.base_url, {})).toThrow('NIGHTSCOUT_ADDRESS_INVALID');
    expect(() => assertNightscoutHostAllowed(typed.base_url, { NIGHTSCOUT_ALLOWED_HOSTS: 'nightscout' })).not.toThrow();
    expect(() => assertNightscoutHostAllowed('https://ns.example', { NIGHTSCOUT_ALLOWED_HOSTS: 'nightscout' })).toThrow('NIGHTSCOUT_HOST_NOT_ALLOWED');
    expect(() => assertNightscoutHostAllowed('https://typo', { NIGHTSCOUT_ALLOWED_HOSTS: 'nightscout' })).toThrow('NIGHTSCOUT_ADDRESS_INVALID');
    expect(() => parseNightscoutConnectionInput('https://bad host', 'reader-abc')).toThrow('NIGHTSCOUT_ADDRESS_INVALID');
  });
});
