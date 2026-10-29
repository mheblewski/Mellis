import type { NightscoutDeviceStatusDto, NightscoutEntryDto, NightscoutProfileDto } from './nightscout-client';

/**
 * A patient's Nightscout as a person types it (the self-hosted setup and "Dodaj pacjenta",
 * docs/device-auth-api.md): the address and read-only token are checked here before the patient's source is
 * saved. Units and time zone come from Nightscout.
 */

export type NightscoutConnectionErrorCode =
  | 'NIGHTSCOUT_ADDRESS_INVALID'
  | 'NIGHTSCOUT_HOST_NOT_ALLOWED'
  | 'NIGHTSCOUT_UNREACHABLE'
  | 'NIGHTSCOUT_TOKEN_MISSING'
  | 'NIGHTSCOUT_TOKEN_INVALID'
  | 'NIGHTSCOUT_TOKEN_ADMIN'
  | 'NIGHTSCOUT_TOKEN_NOT_READ_ONLY'
  | 'NIGHTSCOUT_NO_RECENT_READINGS'
  | 'NIGHTSCOUT_ALREADY_USED';

export class NightscoutConnectionError extends Error {
  constructor(readonly code: NightscoutConnectionErrorCode) {
    super(code);
  }
}

export interface NightscoutConnectionInput {
  base_url: string;
  token: string;
}

/**
 * Splits what was typed or pasted: "janek.example.com", "https://x.example/?token=reader-abc" (token in the link)
 * or address and token apart. Only the origin is kept; the token never goes into an error.
 */
export function parseNightscoutConnectionInput(rawUrl: unknown, rawToken: unknown): NightscoutConnectionInput {
  const typed = typeof rawUrl === 'string' ? rawUrl.trim() : '';
  if (!typed) throw new NightscoutConnectionError('NIGHTSCOUT_ADDRESS_INVALID');
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(typed) ? typed : `https://${typed}`);
  } catch {
    throw new NightscoutConnectionError('NIGHTSCOUT_ADDRESS_INVALID');
  }
  // A dotless host ("nightscout", a container on the same Docker network) is checked against NIGHTSCOUT_ALLOWED_HOSTS
  // by assertNightscoutHostAllowed; refused there unless listed.
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || !/^[a-z0-9.-]+$|^\[[0-9a-f:.]+\]$/i.test(url.hostname)) {
    throw new NightscoutConnectionError('NIGHTSCOUT_ADDRESS_INVALID');
  }
  const token = (typeof rawToken === 'string' && rawToken.trim()) || url.searchParams.get('token')?.trim() || '';
  if (!token) throw new NightscoutConnectionError('NIGHTSCOUT_TOKEN_MISSING');
  return { base_url: url.origin.toLowerCase(), token };
}

/**
 * Which addresses the server may contact for a person (the server fetches what they typed): https only, never a local
 * or private address, unless NIGHTSCOUT_ALLOWED_HOSTS names it. NIGHTSCOUT_ALLOWED_HOSTS set = only those hosts (the
 * test environment lists its test Nightscout); NIGHTSCOUT_BLOCKED_HOSTS are always refused (e.g. the real patient's).
 */
export function assertNightscoutHostAllowed(baseUrl: string, env: Record<string, string | undefined>): void {
  const url = new URL(baseUrl);
  const host = url.hostname.toLowerCase();
  const list = (name: string) => (env[name] ?? '').split(',').map((entry) => entry.trim().toLowerCase()).filter(Boolean);
  const allowed = list('NIGHTSCOUT_ALLOWED_HOSTS');
  if (list('NIGHTSCOUT_BLOCKED_HOSTS').includes(host)) throw new NightscoutConnectionError('NIGHTSCOUT_HOST_NOT_ALLOWED');
  if (allowed.length > 0) {
    if (!allowed.includes(host)) throw new NightscoutConnectionError(host.includes('.') ? 'NIGHTSCOUT_HOST_NOT_ALLOWED' : 'NIGHTSCOUT_ADDRESS_INVALID');
    return;
  }
  if (!host.includes('.') && host !== 'localhost') throw new NightscoutConnectionError('NIGHTSCOUT_ADDRESS_INVALID');
  if (url.protocol !== 'https:' || isLocalOrPrivateHost(host)) throw new NightscoutConnectionError('NIGHTSCOUT_HOST_NOT_ALLOWED');
}

function isLocalOrPrivateHost(host: string): boolean {
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return true;
  const v4 = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  return host.startsWith('[') || host.includes(':');
}

/** What the connection test reads; HttpNightscoutClient in production, a fake in tests. */
export interface NightscoutProbeClient {
  fetchRecentEntries(sinceMs: number, count: number): Promise<NightscoutEntryDto[]>;
  fetchLatestDeviceStatus(): Promise<NightscoutDeviceStatusDto | null>;
  fetchProfiles(input: { patient_id: string; cursor: string | null; limit: number }): Promise<{ profiles: NightscoutProfileDto[] }>;
}

export interface NightscoutConnectionResult {
  base_url: string;
  last_reading: { value: number; unit: 'mg/dL'; at: string; age_minutes: number };
  uploader: string | null;
  units: 'mg/dL' | 'mmol/L' | null;
  timezone: string | null;
}

/** Errors of the client as the person can act on them. */
export function classifyNightscoutFailure(error: unknown): NightscoutConnectionErrorCode {
  if (error instanceof NightscoutConnectionError) return error.code;
  const message = error instanceof Error ? error.message : '';
  const status = (error as { statusCode?: number | null })?.statusCode ?? null;
  if (message.includes('admin permissions')) return 'NIGHTSCOUT_TOKEN_ADMIN';
  if (message.includes('can write')) return 'NIGHTSCOUT_TOKEN_NOT_READ_ONLY';
  if (status === 401 || status === 403 || message.includes('token exchange')) return 'NIGHTSCOUT_TOKEN_INVALID';
  return 'NIGHTSCOUT_UNREACHABLE';
}

/**
 * Reads the newest reading of the last 24 h (required), the loop's newest status (who uploads: Trio, Loop, AAPS) and the
 * profile (units, time zone). Any failure becomes one NightscoutConnectionError code.
 */
export async function probeNightscout(baseUrl: string, client: NightscoutProbeClient, now: Date = new Date()): Promise<NightscoutConnectionResult> {
  let entries: NightscoutEntryDto[];
  try {
    entries = await client.fetchRecentEntries(now.getTime() - 24 * 3_600_000, 5);
  } catch (error) {
    throw new NightscoutConnectionError(classifyNightscoutFailure(error));
  }
  const newest = entries
    .map((entry) => ({ value: Number(entry.sgv), atMs: Number(entry.date ?? Date.parse(String(entry.dateString ?? ''))) }))
    .filter((entry) => Number.isFinite(entry.value) && entry.value > 0 && Number.isFinite(entry.atMs))
    .sort((a, b) => b.atMs - a.atMs)[0];
  if (!newest) throw new NightscoutConnectionError('NIGHTSCOUT_NO_RECENT_READINGS');

  const [status, profiles] = await Promise.all([
    client.fetchLatestDeviceStatus().catch(() => null),
    client.fetchProfiles({ patient_id: '', cursor: null, limit: 1 }).then((result) => result.profiles).catch(() => [] as NightscoutProfileDto[]),
  ]);
  const profile = newestProfile(profiles);
  return {
    base_url: baseUrl,
    last_reading: {
      value: Math.round(newest.value),
      unit: 'mg/dL',
      at: new Date(newest.atMs).toISOString(),
      age_minutes: Math.max(0, Math.round((now.getTime() - newest.atMs) / 60_000)),
    },
    uploader: uploaderName(status),
    units: profileUnits(profile),
    timezone: profileTimeZone(profile),
  };
}

/** "Trio", "Loop", "AndroidAPS", "OpenAPS" from the devicestatus' device and keys; null when unknown. */
export function uploaderName(status: NightscoutDeviceStatusDto | null): string | null {
  if (!status) return null;
  const device = String(status.device ?? '').toLowerCase();
  if (device.includes('trio')) return 'Trio';
  if (device.includes('loop') || (status as Record<string, unknown>).loop) return 'Loop';
  if (device.includes('androidaps') || device.includes('aaps')) return 'AndroidAPS';
  if (device.startsWith('openaps') || status.openaps) return device.includes('iphone') ? 'Trio' : 'OpenAPS';
  return status.device ? String(status.device).slice(0, 40) : null;
}

function newestProfile(profiles: NightscoutProfileDto[]): NightscoutProfileDto | null {
  return [...profiles].sort((a, b) => Date.parse(String(b.startDate ?? 0)) - Date.parse(String(a.startDate ?? 0)))[0] ?? null;
}

function activeStore(profile: NightscoutProfileDto | null): Record<string, unknown> | null {
  if (!profile?.store || typeof profile.store !== 'object') return null;
  const store = profile.store as Record<string, Record<string, unknown>>;
  return (profile.defaultProfile && store[profile.defaultProfile]) || Object.values(store)[0] || null;
}

function profileUnits(profile: NightscoutProfileDto | null): 'mg/dL' | 'mmol/L' | null {
  const raw = String(activeStore(profile)?.units ?? profile?.units ?? '').toLowerCase();
  if (raw.startsWith('mmol')) return 'mmol/L';
  if (raw.startsWith('mg')) return 'mg/dL';
  return null;
}

function profileTimeZone(profile: NightscoutProfileDto | null): string | null {
  const raw = activeStore(profile)?.timezone ?? profile?.timezone;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
}

/**
 * Whether the server must guard the connection: always, except a local or private host that NIGHTSCOUT_ALLOWED_HOSTS
 * lists on purpose (a development fake on this machine). Public hosts always go through the guard.
 */
export function guardsNightscoutHost(baseUrl: string, env: Record<string, string | undefined>): boolean {
  const host = new URL(baseUrl).hostname.toLowerCase();
  const allowed = (env.NIGHTSCOUT_ALLOWED_HOSTS ?? '').split(',').map((entry) => entry.trim().toLowerCase()).filter(Boolean);
  return !(allowed.includes(host) && isLocalOrPrivateHost(host));
}
