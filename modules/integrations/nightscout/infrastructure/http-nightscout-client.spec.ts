import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'crypto';
import { HttpNightscoutClient, NightscoutClientError } from './http-nightscout-client';

describe('HttpNightscoutClient', () => {
  it('defaults to BEARER auth mode and parses entries', async () => {
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ([{ _id: 'entry-1', sgv: 68 }]),
    }));
    vi.stubGlobal('fetch', fetchSpy);

    const client = new HttpNightscoutClient('https://nightscout.example.com', 'secret-token');
    const result = await client.fetchEntries({ patient_id: 'patient-1', cursor: '2026-09-16T20:00:00.000Z', limit: 25 });

    expect(result.entries).toHaveLength(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, options] = fetchSpy.mock.calls[0] as [URL, RequestInit];
    expect(String(url)).toContain('/api/v1/entries');
    expect(String(url)).toContain('count=25');
    expect(options?.headers).toMatchObject({ Authorization: 'Bearer secret-token' });
    expect((options?.headers as Record<string, string>)['api-secret']).toBeUndefined();
  });

  it('fetches recent entries newest first and the newest devicestatus', async () => {
    const fetchSpy = vi.fn(async () => ({ ok: true, status: 200, json: async () => ([{ _id: 'x', sgv: 124, date: 1 }]) }));
    vi.stubGlobal('fetch', fetchSpy);

    const client = new HttpNightscoutClient('https://nightscout.example.com', 'secret-token');
    await client.fetchRecentEntries(1792253319000.7, 30);
    const status = await client.fetchLatestDeviceStatus();

    const [entriesUrl] = fetchSpy.mock.calls[0] as unknown as [URL];
    expect(entriesUrl.pathname).toBe('/api/v1/entries');
    expect(entriesUrl.searchParams.get('find[date][$gt]')).toBe('1792253319000');
    expect(entriesUrl.searchParams.get('sort[date]')).toBe('-1');
    expect(entriesUrl.searchParams.get('count')).toBe('30');
    const [statusUrl] = fetchSpy.mock.calls[1] as unknown as [URL];
    expect(statusUrl.pathname).toBe('/api/v1/devicestatus');
    expect(statusUrl.searchParams.get('sort[created_at]')).toBe('-1');
    expect(statusUrl.searchParams.get('count')).toBe('1');
    expect(status).toMatchObject({ _id: 'x' });
  });

  it('fetches devicestatus between two moments, oldest first', async () => {
    const fetchSpy = vi.fn(async () => ({ ok: true, status: 200, json: async () => ([{ pump: { reservoir: 180 } }]) }));
    vi.stubGlobal('fetch', fetchSpy);

    const client = new HttpNightscoutClient('https://nightscout.example.com', 'secret-token');
    const statuses = await client.fetchDeviceStatusesBetween('2026-10-14T10:51:44.000Z', '2026-10-14T11:51:44.000Z', 30);

    expect(statuses).toHaveLength(1);
    const [url] = fetchSpy.mock.calls[0] as unknown as [URL];
    expect(url.pathname).toBe('/api/v1/devicestatus');
    expect(url.searchParams.get('find[created_at][$gte]')).toBe('2026-10-14T10:51:44.000Z');
    expect(url.searchParams.get('find[created_at][$lte]')).toBe('2026-10-14T11:51:44.000Z');
    expect(url.searchParams.get('sort[created_at]')).toBe('1');
  });

  it('fetches the newest treatment of one event type', async () => {
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ([{ _id: 'tx-9', eventType: 'Site Change', created_at: '2026-10-16T09:10:00.000Z' }]),
    }));
    vi.stubGlobal('fetch', fetchSpy);

    const client = new HttpNightscoutClient('https://nightscout.example.com', 'secret-token');
    const treatment = await client.fetchLatestTreatmentOfType('Site Change', '2026-09-17T00:00:00.000Z');

    expect(treatment?.created_at).toBe('2026-10-16T09:10:00.000Z');
    const [url] = fetchSpy.mock.calls[0] as [URL, RequestInit];
    expect(url.searchParams.get('find[eventType]')).toBe('Site Change');
    expect(url.searchParams.get('find[created_at][$gte]')).toBe('2026-09-17T00:00:00.000Z');
    expect(url.searchParams.get('sort[created_at]')).toBe('-1');
    expect(url.searchParams.get('count')).toBe('1');
  });

  it('bounds the look-back fetch for late uploads with an exclusive upper limit', async () => {
    const fetchSpy = vi.fn(async () => ({ ok: true, status: 200, json: async () => ([]) }));
    vi.stubGlobal('fetch', fetchSpy);

    const client = new HttpNightscoutClient('https://nightscout.example.com', 'secret-token');
    await client.fetchEntries({ patient_id: 'patient-1', cursor: '2026-10-21T04:00:00.000Z', before: '2026-10-21T10:00:00.000Z', limit: 500 });
    await client.fetchTreatments({ patient_id: 'patient-1', cursor: '2026-10-21T04:00:00.000Z', before: '2026-10-21T10:00:00.000Z', limit: 500 });

    const [entriesUrl] = fetchSpy.mock.calls[0] as unknown as [URL];
    expect(entriesUrl.searchParams.get('find[date][$gte]')).toBe(String(Date.parse('2026-10-21T04:00:00.000Z')));
    expect(entriesUrl.searchParams.get('find[date][$lt]')).toBe(String(Date.parse('2026-10-21T10:00:00.000Z')));
    const [treatmentsUrl] = fetchSpy.mock.calls[1] as unknown as [URL];
    expect(treatmentsUrl.searchParams.get('find[created_at][$gte]')).toBe('2026-10-21T04:00:00.000Z');
    expect(treatmentsUrl.searchParams.get('find[created_at][$lt]')).toBe('2026-10-21T10:00:00.000Z');
  });

  it('fetches treatments with bounded cursor on created_at', async () => {
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ([{ _id: 'tx-1', eventType: 'Bolus', created_at: '2026-10-04T10:00:00.000Z', insulin: 1.5 }]),
    }));
    vi.stubGlobal('fetch', fetchSpy);

    const client = new HttpNightscoutClient('https://nightscout.example.com', 'secret-token');
    const result = await client.fetchTreatments({ patient_id: 'patient-1', cursor: '2026-10-04T00:00:00.000Z', limit: 20 });

    expect(result.treatments).toHaveLength(1);
    const [url, options] = fetchSpy.mock.calls[0] as [URL, RequestInit];
    expect(String(url)).toContain('/api/v1/treatments');
    expect(String(url)).toContain('find%5Bcreated_at%5D%5B%24gte%5D=2026-10-04T00%3A00%3A00.000Z');
    expect(String(url)).toContain('sort%5Bcreated_at%5D=1');
    expect(options?.headers).toMatchObject({ Authorization: 'Bearer secret-token' });
  });

  it('uses explicit BEARER auth mode', async () => {
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ([{ _id: 'entry-1', sgv: 68 }]),
    }));
    vi.stubGlobal('fetch', fetchSpy);

    const client = new HttpNightscoutClient('https://nightscout.example.com', 'synthetic-bearer-token', 'BEARER');
    await client.fetchEntries({ patient_id: 'patient-1', cursor: null, limit: 1 });

    const [, options] = fetchSpy.mock.calls[0] as [URL, RequestInit];
    expect(options?.headers).toMatchObject({ Authorization: 'Bearer synthetic-bearer-token' });
    expect((options?.headers as Record<string, string>)['api-secret']).toBeUndefined();
  });

  it('uses API_SECRET_SHA1 mode and does not send Authorization header', async () => {
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ([{ _id: 'entry-1', sgv: 68 }]),
    }));
    vi.stubGlobal('fetch', fetchSpy);

    const rawSecret = 'synthetic-nightscout-secret';
    const expectedSha1 = createHash('sha1').update(rawSecret).digest('hex');
    const client = new HttpNightscoutClient('https://nightscout.example.com', rawSecret, 'API_SECRET_SHA1');
    await client.fetchEntries({ patient_id: 'patient-1', cursor: null, limit: 1 });

    const [, options] = fetchSpy.mock.calls[0] as [URL, RequestInit];
    const headers = options?.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
    expect(headers['api-secret']).toBe(expectedSha1);
  });

  it('uses API_SECRET_SHA1 headers for treatments requests', async () => {
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ([]),
    }));
    vi.stubGlobal('fetch', fetchSpy);

    const rawSecret = 'synthetic-nightscout-secret';
    const expectedSha1 = createHash('sha1').update(rawSecret).digest('hex');
    const client = new HttpNightscoutClient('https://nightscout.example.com', rawSecret, 'API_SECRET_SHA1');
    await client.fetchTreatments({ patient_id: 'patient-1', cursor: null, limit: 1 });

    const [, options] = fetchSpy.mock.calls[0] as [URL, RequestInit];
    const headers = options?.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
    expect(headers['api-secret']).toBe(expectedSha1);
  });

  it('fetches devicestatus with cursor/count/sort and keeps rows with no patient marker', async () => {
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ([
        { _id: 'status-1', created_at: '2026-10-05T19:29:31.864Z', openaps: { iob: { iob: 1.161 } } },
        { _id: 'status-foreign', patient: 'other-patient', created_at: '2026-10-05T19:30:31.864Z', openaps: { iob: { iob: 1.0 } } },
        { _id: 'status-matching', patient: 'patient-1', created_at: '2026-10-05T19:31:31.864Z', openaps: { iob: { iob: 1.2 } } },
      ]),
    }));
    vi.stubGlobal('fetch', fetchSpy);

    const client = new HttpNightscoutClient('https://nightscout.example.com', 'secret-token');
    const result = await client.fetchDeviceStatuses({ patient_id: 'patient-1', cursor: '2026-10-05T19:00:00.000Z', limit: 200 });

    expect(result.device_statuses.map((row) => row._id)).toEqual(['status-1', 'status-matching']);
    const [url, options] = fetchSpy.mock.calls[0] as [URL, RequestInit];
    expect(String(url)).toContain('/api/v1/devicestatus');
    expect(String(url)).toContain('count=200');
    expect(String(url)).toContain('find%5Bcreated_at%5D%5B%24gte%5D=2026-10-05T19%3A00%3A00.000Z');
    expect(String(url)).toContain('sort%5Bcreated_at%5D=1');
    expect(options?.headers).toMatchObject({ Authorization: 'Bearer secret-token' });
  });

  it('fetches Nightscout profiles from the profile endpoint and keeps the current profile payload', async () => {
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ([{
        _id: 'profile-1',
        defaultProfile: 'Default',
        store: {
          Default: {
            dia: 6,
            carbratio: [{ time: '00:00', value: 12 }],
            sens: [{ time: '00:00', value: 45 }],
          },
        },
        timezone: 'Europe/Warsaw',
      }]),
    }));
    vi.stubGlobal('fetch', fetchSpy);

    const client = new HttpNightscoutClient('https://nightscout.example.com', 'secret-token');
    const result = await client.fetchProfiles({ patient_id: 'patient-1', cursor: null, limit: 25 });

    expect(result.profiles).toHaveLength(1);
    expect(result.profiles[0].defaultProfile).toBe('Default');
    const [url] = fetchSpy.mock.calls[0] as [URL, RequestInit];
    expect(String(url)).toContain('/api/v1/profile');
    expect(String(url)).toContain('count=25');
  });

  it('rejects invalid auth mode', () => {
    expect(() => new HttpNightscoutClient('https://nightscout.example.com', 'synthetic-secret', 'INVALID_MODE' as any)).toThrow(
      'Unsupported Nightscout auth mode',
    );
  });

  it('rejects empty credential', () => {
    expect(() => new HttpNightscoutClient('https://nightscout.example.com', '   ')).toThrow(
      'Nightscout credential must be a non-empty string',
    );
  });

  it('sanitizes credential in transport error messages', async () => {
    const secret = 'synthetic-secret-value';
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error(`authorization: bearer ${secret}; api-secret: ${createHash('sha1').update(secret).digest('hex')}`);
    }));

    const client = new HttpNightscoutClient('https://nightscout.example.com', secret, 'API_SECRET_SHA1');
    await expect(client.fetchEntries({ patient_id: 'patient-1', cursor: null, limit: 1 })).rejects.toMatchObject({ retryable: true });

    try {
      await client.fetchEntries({ patient_id: 'patient-1', cursor: null, limit: 1 });
    } catch (error) {
      expect(error).toBeInstanceOf(NightscoutClientError);
      const message = (error as Error).message;
      expect(message).not.toContain(secret);
      expect(message).toContain('[REDACTED]');
    }
  });

  it('marks 429 and 5xx as retryable and 401/403 as non-retryable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 429, json: async () => [] })));
    const client = new HttpNightscoutClient('https://nightscout.example.com', 'secret-token');
    await expect(client.fetchEntries({ patient_id: 'patient-1', cursor: null, limit: 25 })).rejects.toMatchObject({ retryable: true });

    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 401, json: async () => [] })));
    await expect(client.fetchEntries({ patient_id: 'patient-1', cursor: null, limit: 25 })).rejects.toMatchObject({ retryable: false });

    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => [] })));
    await expect(client.fetchEntries({ patient_id: 'patient-1', cursor: null, limit: 25 })).rejects.toBeInstanceOf(NightscoutClientError);
  });
});
describe('HttpNightscoutClient 401/403 handling', () => {
  it.each([401, 403])('BEARER: %i is a non-retryable credentials error with the status code', async (status) => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status, json: async () => [] })));
    const client = new HttpNightscoutClient('https://nightscout.example.com', 'synthetic-bearer-token', 'BEARER');
    await expect(client.fetchEntries({ patient_id: 'patient-1', cursor: null, limit: 1 }))
      .rejects.toMatchObject({ message: 'Nightscout credentials rejected', retryable: false, statusCode: status });
  });
});

describe('HttpNightscoutClient ACCESS_TOKEN_JWT', () => {
  // Synthetic values only. A JWT-shaped string (three dot-separated parts); never a real token.
  const ACCESS_TOKEN = 'glucomind-readonly-0123456789abcdef';
  const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJhY2Nlc3NUb2tlbiI6InN5bnRoZXRpYyJ9.c3ludGhldGljLXNpZ25hdHVyZQ';
  const nowSeconds = () => Math.floor(Date.now() / 1000);
  const readOnlyExchange = (overrides: Record<string, unknown> = {}) => ({
    token: JWT, sub: 'glucomind', permissionGroups: [['api:*:read']], iat: nowSeconds(), exp: nowSeconds() + 8 * 3600, ...overrides,
  });

  type Call = { url: string; headers: Record<string, string> };
  function scriptedFetch(responses: Array<{ status: number; body?: unknown } | Error>) {
    const calls: Call[] = [];
    const fetchSpy = vi.fn(async (url: URL, options?: { headers?: Record<string, string> }) => {
      calls.push({ url: String(url), headers: { ...(options?.headers ?? {}) } });
      const next = responses.shift();
      if (!next) throw new Error('unexpected request');
      if (next instanceof Error) throw next;
      return { ok: next.status >= 200 && next.status < 300, status: next.status, json: async () => next.body };
    });
    vi.stubGlobal('fetch', fetchSpy);
    return calls;
  }
  const client = () => new HttpNightscoutClient('https://nightscout.example.com', ACCESS_TOKEN, 'ACCESS_TOKEN_JWT');
  const fetchEntries = (instance: HttpNightscoutClient) => instance.fetchEntries({ patient_id: 'patient-1', cursor: null, limit: 1 });

  it('exchanges the access token for a JWT and sends only the JWT as Bearer on API requests', async () => {
    const calls = scriptedFetch([{ status: 200, body: readOnlyExchange() }, { status: 200, body: [] }]);
    await fetchEntries(client());

    expect(calls).toHaveLength(2);
    expect(new URL(calls[0].url).pathname).toBe(`/api/v2/authorization/request/${ACCESS_TOKEN}`);
    expect(calls[0].headers.Authorization).toBeUndefined();
    expect(calls[0].headers['api-secret']).toBeUndefined();
    expect(new URL(calls[1].url).pathname).toBe('/api/v1/entries');
    expect(calls[1].headers).toMatchObject({ Authorization: `Bearer ${JWT}` });
    expect(calls[1].headers['api-secret']).toBeUndefined();
    // The raw access token never reaches an API request (URL or headers).
    expect(calls[1].url).not.toContain(ACCESS_TOKEN);
    expect(JSON.stringify(calls[1].headers)).not.toContain(ACCESS_TOKEN);
  });

  it('URL-encodes the access token in the exchange path', async () => {
    const calls = scriptedFetch([{ status: 200, body: readOnlyExchange() }, { status: 200, body: [] }]);
    await fetchEntries(new HttpNightscoutClient('https://nightscout.example.com', 'a b/c?d', 'ACCESS_TOKEN_JWT'));
    expect(new URL(calls[0].url).pathname).toBe('/api/v2/authorization/request/a%20b%2Fc%3Fd');
  });

  it('reuses a valid JWT and renews it only when it is about to expire', async () => {
    const calls = scriptedFetch([
      { status: 200, body: readOnlyExchange({ exp: nowSeconds() + 3600 }) }, { status: 200, body: [] }, { status: 200, body: [] },
    ]);
    const instance = client();
    await fetchEntries(instance);
    await fetchEntries(instance);
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual(['/api/v2/authorization/request/' + ACCESS_TOKEN, '/api/v1/entries', '/api/v1/entries']);

    const expiring = scriptedFetch([
      { status: 200, body: readOnlyExchange({ exp: nowSeconds() + 30 }) }, { status: 200, body: [] },
      { status: 200, body: readOnlyExchange() }, { status: 200, body: [] },
    ]);
    const renewing = client();
    await fetchEntries(renewing);
    await fetchEntries(renewing);
    expect(expiring.filter((call) => call.url.includes('/authorization/request/'))).toHaveLength(2);
  });

  it('exchanges again once when Nightscout refuses a cached JWT (a Nightscout restart), and fails when that is refused too', async () => {
    const calls = scriptedFetch([
      { status: 200, body: readOnlyExchange() }, { status: 200, body: [] },
      // Nightscout restarted: the cached JWT is refused, a new exchange works.
      { status: 401 }, { status: 200, body: readOnlyExchange() }, { status: 200, body: [{ sgv: 90 }] },
    ]);
    const instance = client();
    await fetchEntries(instance);
    expect((await fetchEntries(instance)).entries).toEqual([{ sgv: 90 }]);
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
      `/api/v2/authorization/request/${ACCESS_TOKEN}`, '/api/v1/entries', '/api/v1/entries', `/api/v2/authorization/request/${ACCESS_TOKEN}`, '/api/v1/entries',
    ]);

    // Refused again with a fresh JWT: no loop, the error stays.
    scriptedFetch([{ status: 401 }, { status: 200, body: readOnlyExchange() }, { status: 403 }]);
    await expect(fetchEntries(instance)).rejects.toMatchObject({ message: 'Nightscout credentials rejected', statusCode: 403 });
  });

  it('shares one exchange between concurrent requests', async () => {
    const calls = scriptedFetch([{ status: 200, body: readOnlyExchange() }, { status: 200, body: [] }, { status: 200, body: [] }]);
    const instance = client();
    await Promise.all([fetchEntries(instance), instance.fetchTreatments({ patient_id: 'patient-1', cursor: null, limit: 1 })]);
    expect(calls.filter((call) => call.url.includes('/authorization/request/'))).toHaveLength(1);
  });

  it.each([401, 403])('a %i from the exchange is a credentials error and no API request is made', async (status) => {
    const calls = scriptedFetch([{ status }]);
    await expect(fetchEntries(client())).rejects.toMatchObject({ message: 'Nightscout credentials rejected', retryable: false, statusCode: status });
    expect(calls).toHaveLength(1);
  });

  it.each([401, 403])('a %i on the API request with a JWT is a credentials error, without fallback to api-secret', async (status) => {
    const calls = scriptedFetch([{ status: 200, body: readOnlyExchange() }, { status }]);
    await expect(fetchEntries(client())).rejects.toMatchObject({ message: 'Nightscout credentials rejected', retryable: false, statusCode: status });
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.headers['api-secret'] === undefined)).toBe(true);
  });

  it('refuses an access token with admin permissions, or one whose permissions cannot be verified', async () => {
    for (const body of [readOnlyExchange({ permissionGroups: [['*']] }), readOnlyExchange({ permissionGroups: ['*'] }), readOnlyExchange({ permissionGroups: undefined })]) {
      const calls = scriptedFetch([{ status: 200, body }]);
      await expect(fetchEntries(client())).rejects.toMatchObject({ retryable: false });
      expect(calls).toHaveLength(1);
    }
  });

  it('refuses an exchange response without a valid JWT or expiry', async () => {
    for (const body of [{}, readOnlyExchange({ token: 'not-a-jwt' }), readOnlyExchange({ exp: undefined }), readOnlyExchange({ exp: nowSeconds() - 10 }), null]) {
      const calls = scriptedFetch([{ status: 200, body }]);
      await expect(fetchEntries(client())).rejects.toMatchObject({ message: 'Nightscout token exchange returned no valid JWT', retryable: false });
      expect(calls).toHaveLength(1);
    }
  });

  it('never exposes the access token, its URL form, the exchange path or the JWT in errors or logs', async () => {
    const logs: string[] = [];
    for (const method of ['log', 'warn', 'error', 'info', 'debug'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(' ')); });
    }
    const secretLike = 'tok en/with?chars-0123456789abcdef';
    // Transport failure during the exchange whose message echoes the URL in raw and encoded form.
    scriptedFetch([new Error(`connect failed for https://nightscout.example.com/api/v2/authorization/request/${encodeURIComponent(secretLike)} (${secretLike})`)]);
    const exchangeError = (await fetchEntries(new HttpNightscoutClient('https://nightscout.example.com', secretLike, 'ACCESS_TOKEN_JWT')).catch((error: Error) => error)) as Error;
    expect(exchangeError).toBeInstanceOf(NightscoutClientError);
    expect(exchangeError.message).not.toContain(secretLike);
    expect(exchangeError.message).not.toContain(encodeURIComponent(secretLike));
    expect(exchangeError.message).toContain('/authorization/request/[REDACTED]');

    // Transport failure on the API request whose message echoes the JWT.
    scriptedFetch([{ status: 200, body: readOnlyExchange() }, new Error(`socket hang up; authorization: Bearer ${JWT}; jwt=${JWT}`)]);
    const apiError = (await fetchEntries(client()).catch((error: Error) => error)) as Error;
    expect(apiError.message).not.toContain(JWT);
    expect(apiError.message).not.toContain(ACCESS_TOKEN);

    expect(logs.join('\n')).not.toContain(secretLike);
    expect(logs.join('\n')).not.toContain(JWT);
    expect(logs.join('\n')).not.toContain(ACCESS_TOKEN);
    vi.restoreAllMocks();
  });

  it('leaves the existing modes unchanged: no exchange in BEARER or API_SECRET_SHA1', async () => {
    for (const mode of ['BEARER', 'API_SECRET_SHA1'] as const) {
      const calls = scriptedFetch([{ status: 200, body: [] }]);
      await fetchEntries(new HttpNightscoutClient('https://nightscout.example.com', ACCESS_TOKEN, mode));
      expect(calls).toHaveLength(1);
      expect(new URL(calls[0].url).pathname).toBe('/api/v1/entries');
    }
  });
});
