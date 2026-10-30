import { Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import {
  NightscoutClient,
  FetchEntriesInput,
  FetchEntriesResult,
  NightscoutEntryDto,
  FetchTreatmentsInput,
  FetchTreatmentsResult,
  NightscoutTreatmentDto,
  FetchDeviceStatusesInput,
  FetchDeviceStatusesResult,
  NightscoutDeviceStatusDto,
  FetchProfilesInput,
  FetchProfilesResult,
  NightscoutProfileDto,
} from '../application/nightscout-client';
import { guardedGet, GuardedRequestError, type GuardedResponse } from './guarded-http';

/**
 * BEARER: the credential is sent as `Authorization: Bearer <credential>` (Nightscout accepts only a valid JWT there).
 * API_SECRET_SHA1: `api-secret: sha1(<credential>)` (the instance API_SECRET; admin rights).
 * ACCESS_TOKEN_JWT: the credential is a Nightscout access token (subject token, e.g. a read-only role). It is exchanged
 * at GET /api/v2/authorization/request/<token> for a short-lived JWT, which is then sent as `Authorization: Bearer`.
 * Tokens granting admin permissions ('*') are refused. There is no fallback between modes.
 */
export type NightscoutAuthMode = 'BEARER' | 'API_SECRET_SHA1' | 'ACCESS_TOKEN_JWT';

/** A cached JWT is renewed this long before it expires. */
const JWT_RENEWAL_MARGIN_MS = 60_000;

export class NightscoutClientError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean,
    public readonly statusCode: number | null = null,
  ) {
    super(message);
  }
}

@Injectable()
export class HttpNightscoutClient implements NightscoutClient {
  private readonly authMode: NightscoutAuthMode;
  /** ACCESS_TOKEN_JWT only: the exchanged JWT, kept in memory and never logged. */
  private jwt: { token: string; expiresAtMs: number } | null = null;
  private jwtExchange: Promise<string> | null = null;

  constructor(
    private readonly baseUrl: string,
    private readonly apiToken: string,
    authMode: NightscoutAuthMode = 'BEARER',
    /**
     * guardPrivateNetwork: the address came from a person (sharing audit #7) — connect only to public addresses checked at
     * connect time, no redirects, capped bodies. requireReadOnlyToken: refuse an access token that can write.
     */
    private readonly options: { guardPrivateNetwork?: boolean; requireReadOnlyToken?: boolean } = {},
  ) {
    if (!this.apiToken || !this.apiToken.trim()) {
      throw new Error('Nightscout credential must be a non-empty string');
    }

    if (authMode !== 'BEARER' && authMode !== 'API_SECRET_SHA1' && authMode !== 'ACCESS_TOKEN_JWT') {
      throw new Error('Unsupported Nightscout auth mode');
    }

    this.authMode = authMode;
  }

  private async buildAuthHeaders(): Promise<Record<string, string>> {
    if (this.authMode === 'ACCESS_TOKEN_JWT') {
      return {
        Authorization: `Bearer ${await this.currentAccessTokenJwt()}`,
        Accept: 'application/json',
      };
    }

    if (this.authMode === 'API_SECRET_SHA1') {
      const apiSecret = createHash('sha1').update(this.apiToken).digest('hex');
      return {
        'api-secret': apiSecret,
        Accept: 'application/json',
      };
    }

    return {
      Authorization: `Bearer ${this.apiToken}`,
      Accept: 'application/json',
    };
  }

  private sanitizeErrorMessage(message: string): string {
    const hashedToken = createHash('sha1').update(this.apiToken).digest('hex');
    let sanitized = message
      .replaceAll(this.apiToken, '[REDACTED]')
      .replaceAll(encodeURIComponent(this.apiToken), '[REDACTED]')
      .replaceAll(hashedToken, '[REDACTED]');
    if (this.jwt) {
      sanitized = sanitized.replaceAll(this.jwt.token, '[REDACTED]');
    }

    return sanitized
      .replace(/(\/authorization\/request\/)[^\s?#'"]+/gi, '$1[REDACTED]')
      .replace(/(authorization\s*:\s*bearer\s+)[^\s]+/gi, '$1[REDACTED]')
      .replace(/(api-secret\s*:\s*)[^\s]+/gi, '$1[REDACTED]');
  }

  /** ACCESS_TOKEN_JWT: a valid cached JWT, or one exchange shared by concurrent callers. */
  private async currentAccessTokenJwt(): Promise<string> {
    if (this.jwt && this.jwt.expiresAtMs - Date.now() > JWT_RENEWAL_MARGIN_MS) {
      return this.jwt.token;
    }
    if (!this.jwtExchange) {
      this.jwtExchange = this.exchangeAccessToken().finally(() => {
        this.jwtExchange = null;
      });
    }
    return this.jwtExchange;
  }

  /**
   * Nightscout's documented exchange takes the access token in the path (GET /api/v2/authorization/request/<token>).
   * The URL is never logged or put into an error message here; see sanitizeErrorMessage.
   */
  private async exchangeAccessToken(): Promise<string> {
    const url = new URL(`/api/v2/authorization/request/${encodeURIComponent(this.apiToken)}`, this.baseUrl);
    const payload = await this.send(url, { Accept: 'application/json' }) as Record<string, unknown> | null;

    const token = typeof payload?.token === 'string' ? payload.token : '';
    const exp = typeof payload?.exp === 'number' && Number.isFinite(payload.exp) ? payload.exp : null;
    if (token.split('.').length !== 3 || exp === null || exp * 1000 <= Date.now()) {
      throw new NightscoutClientError('Nightscout token exchange returned no valid JWT', false);
    }

    const groups = payload?.permissionGroups;
    if (!Array.isArray(groups)) {
      throw new NightscoutClientError('Nightscout token exchange returned no permissions; refusing an unverifiable token', false);
    }
    const permissions = groups.flat(2).map((permission) => String(permission));
    if (permissions.includes('*')) {
      throw new NightscoutClientError('Nightscout access token grants admin permissions; use a read-only token', false);
    }
    // "api:*:read" style; anything granting create/update/delete (or every action) is not read-only.
    if (this.options.requireReadOnlyToken && permissions.some((permission) => permission.split(':').pop() !== 'read')) {
      throw new NightscoutClientError('Nightscout access token can write; use a read-only token', false);
    }

    this.jwt = { token, expiresAtMs: exp * 1000 };
    return token;
  }

  private async requestJson(url: URL): Promise<unknown> {
    const jwt = this.authMode === 'ACCESS_TOKEN_JWT' ? this.jwt?.token ?? null : null;
    try {
      return await this.send(url, await this.buildAuthHeaders());
    } catch (error) {
      // Nightscout signs JWTs with a key it generates at every start: after a restart a cached JWT is refused long
      // before it expires. Drop it and exchange the access token once more (a refused access token still fails).
      const refused = error instanceof NightscoutClientError && (error.statusCode === 401 || error.statusCode === 403);
      if (!refused || this.authMode !== 'ACCESS_TOKEN_JWT' || jwt === null) throw error;
      if (this.jwt?.token === jwt) this.jwt = null;
      return this.send(url, await this.buildAuthHeaders());
    }
  }

  private async send(url: URL, headers: Record<string, string>): Promise<unknown> {
    if (this.options.guardPrivateNetwork) return this.sendGuarded(url, headers);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers,
        signal: controller.signal,
      });

      if (response.status === 401 || response.status === 403) {
        throw new NightscoutClientError('Nightscout credentials rejected', false, response.status);
      }

      if (response.status === 429 || response.status >= 500) {
        throw new NightscoutClientError(`Nightscout request failed with status ${response.status}`, true, response.status);
      }

      if (!response.ok) {
        throw new NightscoutClientError(`Nightscout request failed with status ${response.status}`, false, response.status);
      }

      return await response.json();
    } catch (error) {
      if (error instanceof NightscoutClientError) {
        throw error;
      }

      if (error instanceof Error && error.name === 'AbortError') {
        throw new NightscoutClientError('Nightscout request timed out', true);
      }

      const message = error instanceof Error ? this.sanitizeErrorMessage(error.message) : 'Nightscout transport failure';
      throw new NightscoutClientError(message, true);
    } finally {
      clearTimeout(timeout);
    }
  }

  private async sendGuarded(url: URL, headers: Record<string, string>): Promise<unknown> {
    let response: GuardedResponse;
    try {
      response = await guardedGet(url, headers);
    } catch (error) {
      // One message for every network failure: a typed address must not reveal what answers inside a network.
      const timeout = error instanceof GuardedRequestError && error.reason === 'TIMEOUT';
      throw new NightscoutClientError(timeout ? 'Nightscout request timed out' : 'Nightscout transport failure', true);
    }
    if (response.status === 401 || response.status === 403) throw new NightscoutClientError('Nightscout credentials rejected', false, response.status);
    if (response.status === 429 || response.status >= 500) throw new NightscoutClientError(`Nightscout request failed with status ${response.status}`, true, response.status);
    if (response.status < 200 || response.status >= 300) throw new NightscoutClientError(`Nightscout request failed with status ${response.status}`, false, response.status);
    try {
      return JSON.parse(response.body);
    } catch {
      throw new NightscoutClientError('Nightscout response was not JSON', false);
    }
  }

  private async requestArray(url: URL): Promise<unknown[]> {
    const payload = await this.requestJson(url);
    if (!Array.isArray(payload)) {
      throw new NightscoutClientError('Nightscout response was not an array', false);
    }

    return payload;
  }

  async fetchEntries(input: FetchEntriesInput): Promise<FetchEntriesResult> {
    const url = new URL('/api/v1/entries', this.baseUrl);
    url.searchParams.set('count', String(input.limit));
    if (input.cursor) {
      url.searchParams.set('find[date][$gte]', String(Date.parse(input.cursor)));
    }
    if (input.before) {
      url.searchParams.set('find[date][$lt]', String(Date.parse(input.before)));
    }
    url.searchParams.set('sort[date]', '1');

    const payload = await this.requestArray(url);

    return {
      entries: payload as NightscoutEntryDto[],
      next_cursor: input.cursor,
    };
  }

  async fetchTreatments(input: FetchTreatmentsInput): Promise<FetchTreatmentsResult> {
    const url = new URL('/api/v1/treatments', this.baseUrl);
    url.searchParams.set('count', String(input.limit));
    if (input.cursor) {
      url.searchParams.set('find[created_at][$gte]', input.cursor);
    }
    if (input.before) {
      url.searchParams.set('find[created_at][$lt]', input.before);
    }
    url.searchParams.set('sort[created_at]', '1');

    const payload = await this.requestArray(url);

    return {
      treatments: payload as NightscoutTreatmentDto[],
      next_cursor: input.cursor,
    };
  }

  async fetchDeviceStatuses(input: FetchDeviceStatusesInput): Promise<FetchDeviceStatusesResult> {
    const url = new URL('/api/v1/devicestatus', this.baseUrl);
    url.searchParams.set('count', String(input.limit));
    if (input.cursor) {
      url.searchParams.set('find[created_at][$gte]', input.cursor);
    }
    if (input.before) {
      url.searchParams.set('find[created_at][$lt]', input.before);
    }
    url.searchParams.set('sort[created_at]', '1');

    const payload = await this.requestArray(url);
    const filtered = (payload as NightscoutDeviceStatusDto[]).filter((item) => {
      const sourcePatient = typeof item.patient === 'string'
        ? item.patient
        : typeof item.patientId === 'string'
          ? item.patientId
          : null;

      // Keep records that do not encode patient identity (common Nightscout payload shape),
      // and reject only explicit foreign-patient rows.
      return !sourcePatient || sourcePatient === input.patient_id;
    });

    return {
      device_statuses: filtered,
      next_cursor: input.cursor,
    };
  }

  /** CGM entries newer than `sinceMs`, newest first (the dashboard's live view, ahead of the minute sync). */
  async fetchRecentEntries(sinceMs: number, count: number): Promise<NightscoutEntryDto[]> {
    const url = new URL('/api/v1/entries', this.baseUrl);
    url.searchParams.set('find[date][$gt]', String(Math.floor(sinceMs)));
    url.searchParams.set('sort[date]', '-1');
    url.searchParams.set('count', String(count));
    return await this.requestArray(url) as NightscoutEntryDto[];
  }

  /** The newest devicestatus (pump, IOB, COB) as uploaded by the loop app. */
  async fetchLatestDeviceStatus(): Promise<NightscoutDeviceStatusDto | null> {
    const url = new URL('/api/v1/devicestatus', this.baseUrl);
    url.searchParams.set('sort[created_at]', '-1');
    url.searchParams.set('count', '1');
    const payload = await this.requestArray(url);
    return (payload[0] as NightscoutDeviceStatusDto | undefined) ?? null;
  }

  /** Devicestatus uploaded between two moments (e.g. the hour after a reservoir change), oldest first. */
  async fetchDeviceStatusesBetween(fromIso: string, toIso: string, count: number): Promise<NightscoutDeviceStatusDto[]> {
    const url = new URL('/api/v1/devicestatus', this.baseUrl);
    url.searchParams.set('find[created_at][$gte]', fromIso);
    url.searchParams.set('find[created_at][$lte]', toIso);
    url.searchParams.set('sort[created_at]', '1');
    url.searchParams.set('count', String(count));
    return await this.requestArray(url) as NightscoutDeviceStatusDto[];
  }

  /**
   * The newest treatment of one Nightscout event type (e.g. "Site Change", "Sensor Start") created since `sinceIso`.
   * The sync does not import these care events, so the dashboard asks Nightscout for them directly.
   */
  async fetchLatestTreatmentOfType(eventType: string, sinceIso: string): Promise<NightscoutTreatmentDto | null> {
    const url = new URL('/api/v1/treatments', this.baseUrl);
    url.searchParams.set('find[eventType]', eventType);
    url.searchParams.set('find[created_at][$gte]', sinceIso);
    url.searchParams.set('sort[created_at]', '-1');
    url.searchParams.set('count', '1');

    const payload = await this.requestArray(url);
    return (payload[0] as NightscoutTreatmentDto | undefined) ?? null;
  }

  async fetchProfiles(input: FetchProfilesInput): Promise<FetchProfilesResult> {
    const candidatePaths = ['/api/v1/profile', '/api/v1/profile.json'];

    for (const path of candidatePaths) {
      const url = new URL(path, this.baseUrl);
      url.searchParams.set('count', String(input.limit));
      if (input.cursor) {
        url.searchParams.set('find[startDate][$gte]', input.cursor);
      }
      url.searchParams.set('sort[startDate]', '1');

      try {
        const payload = await this.requestJson(url);
        if (Array.isArray(payload)) {
          return {
            profiles: payload as NightscoutProfileDto[],
            next_cursor: input.cursor,
          };
        }

        if (payload && typeof payload === 'object') {
          return {
            profiles: [payload as NightscoutProfileDto],
            next_cursor: input.cursor,
          };
        }

        return { profiles: [], next_cursor: null };
      } catch (error) {
        if (error instanceof NightscoutClientError && (error.statusCode === 404 || error.statusCode === 400)) {
          continue;
        }
        throw error;
      }
    }

    return { profiles: [], next_cursor: null };
  }
}