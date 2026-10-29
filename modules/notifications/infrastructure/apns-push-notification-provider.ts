import { createHash, createPrivateKey, createSign } from 'crypto';
import { connect, ClientHttp2Session, ClientHttp2Stream, IncomingHttpHeaders } from 'http2';
import { PushNotificationProvider } from './push-notification-provider';
import { PushNotificationEnvelope } from '@modules/notifications/domain/push-notification';
import { PushNotificationProviderError } from './push-notification-provider.error';

interface ApnsConfig {
  teamId: string;
  keyId: string;
  privateKey: string;
  bundleId: string;
  useSandbox: boolean;
  timeoutMs: number;
}

interface JwtCache {
  token: string;
  expiresAtMs: number;
}

/** A Live Activity push: the `aps` dictionary (event, content-state, …) for one activity or push-to-start token. */
export interface LiveActivityPushSender {
  sendLiveActivity(token: string, aps: Record<string, unknown>, options?: { priority?: 5 | 10 }): Promise<void>;
}

export class ApnsPushNotificationProvider implements PushNotificationProvider, LiveActivityPushSender {
  private jwtCache: JwtCache | null = null;
  /** One HTTP/2 session per APNs host: the BadDeviceToken fallback can talk to both. */
  private readonly sessions = new Map<string, { session: ClientHttp2Session; lastUsedMs: number }>();
  /** Tokens that only the non-default host accepted. */
  private readonly tokenHosts = new Map<string, string>();
  private readonly connect: (authority: string) => ClientHttp2Session;
  private readonly now: () => number;

  constructor(
    private readonly config: ApnsConfig,
    deps: { connect?: (authority: string) => ClientHttp2Session; now?: () => number } = {},
  ) {
    this.connect = deps.connect ?? ((authority) => connect(authority));
    this.now = deps.now ?? Date.now;
  }

  async send(notification: PushNotificationEnvelope): Promise<void> {
    const payload = {
      aps: {
        alert: {
          title: notification.title,
          body: notification.body,
        },
        sound: 'default',
        ...(notification.interruptionLevel ? { 'interruption-level': notification.interruptionLevel } : {}),
      },
      gluco: notification.payload.type === 'planned_bolus'
        ? {
            type: notification.payload.type,
            patientId: notification.payload.patientId,
            mealId: notification.payload.mealId,
            plannedBolusId: notification.payload.plannedBolusId,
            routePath: notification.payload.routePath,
            universalLink: notification.payload.universalLink,
          }
        : notification.payload.type === 'care_reminder'
        ? {
            type: notification.payload.type,
            patientId: notification.payload.patientId,
            ...(notification.payload.conversationId ? { conversationId: notification.payload.conversationId } : {}),
            ...(notification.payload.mealId ? { mealId: notification.payload.mealId } : {}),
            reminderId: notification.payload.reminderId,
            routePath: notification.payload.routePath,
            universalLink: notification.payload.universalLink,
          }
        : notification.payload.type === 'rescue_carbs'
        ? {
            type: notification.payload.type,
            patientId: notification.payload.patientId,
            conversationId: notification.payload.conversationId,
            alertId: notification.payload.alertId,
            routePath: notification.payload.routePath,
            universalLink: notification.payload.universalLink,
          }
        : notification.payload.type === 'wbt_reminder' || notification.payload.type === 'meal_chat_answer' || notification.payload.type === 'dose_given'
        ? {
            type: notification.payload.type,
            patientId: notification.payload.patientId,
            mealId: notification.payload.mealId,
            routePath: notification.payload.routePath,
            universalLink: notification.payload.universalLink,
          }
        : {
            type: notification.payload.type,
            patientId: notification.payload.patientId,
            conversationId: notification.payload.conversationId,
            routePath: notification.payload.routePath,
            universalLink: notification.payload.universalLink,
          },
    };

    await this.deliver(notification.pushToken, JSON.stringify(payload), deliveryHeaders(notification, Date.now()));
  }

  /** ActivityKit's own push type and topic; the same host fallback as alerts (Xcode builds carry sandbox tokens). */
  async sendLiveActivity(token: string, aps: Record<string, unknown>, options: { priority?: 5 | 10 } = {}): Promise<void> {
    await this.deliver(token, JSON.stringify({ aps }), {
      'apns-topic': `${this.config.bundleId}.push-type.liveactivity`,
      'apns-push-type': 'liveactivity',
      'apns-priority': String(options.priority ?? 10),
    });
  }

  private async deliver(token: string, body: string, headers: Record<string, string>): Promise<void> {
    const jwt = this.getOrCreateJwt();
    // Phones carry sandbox tokens (Xcode builds) or production ones (TestFlight/App Store) and the
    // server cannot tell which: a BadDeviceToken from one host is retried once on the other, and the
    // host that took it is remembered for this token (2026-10-26, pushes never arrived after a mismatch).
    const primary = this.tokenHosts.get(token) ?? this.defaultEndpoint();
    const response = await this.post(primary, token, jwt, body, headers);
    if (response.status === 200) {
      return;
    }
    if (!isBadDeviceToken(response)) {
      throw mapApnsResponse(response);
    }

    const fallback = otherEndpoint(primary);
    const fallbackResponse = await this.post(fallback, token, jwt, body, headers);
    if (fallbackResponse.status === 200) {
      this.rememberTokenHost(token, fallback);
      console.warn('[APNS_HOST_FALLBACK]', JSON.stringify({
        token_hash: tokenHash(token),
        rejected_by: hostLabel(primary),
        delivered_by: hostLabel(fallback),
      }));
      return;
    }
    if (isBadDeviceToken(fallbackResponse)) {
      // Both hosts refuse it: only now is the token really invalid.
      this.tokenHosts.delete(token);
      throw new PushNotificationProviderError('DEVICE_TOKEN_INVALID', 'APNs device token is invalid on both hosts', false);
    }
    throw mapApnsResponse(fallbackResponse);
  }

  private defaultEndpoint(): string {
    return this.config.useSandbox ? SANDBOX_ENDPOINT : PRODUCTION_ENDPOINT;
  }

  private rememberTokenHost(token: string, endpoint: string): void {
    this.tokenHosts.delete(token);
    if (endpoint === this.defaultEndpoint()) {
      return;
    }
    this.tokenHosts.set(token, endpoint);
    // Bounded: the oldest remembered token goes first (Map keeps insertion order).
    while (this.tokenHosts.size > MAX_REMEMBERED_TOKEN_HOSTS) {
      const oldest = this.tokenHosts.keys().next().value as string;
      this.tokenHosts.delete(oldest);
    }
  }

  private async post(
    endpoint: string,
    deviceToken: string,
    jwt: string,
    payload: string,
    headers: Record<string, string>,
  ): Promise<{ status: number; body: string }> {
    try {
      return await this.sendHttp2Request({ endpoint, deviceToken, jwt, payload, headers });
    } catch (error) {
      const message = sanitizeError(formatTransportError(error));
      throw new PushNotificationProviderError('APNS_NETWORK', message, true);
    }
  }

  private getOrCreateJwt(): string {
    const nowMs = Date.now();
    if (this.jwtCache && this.jwtCache.expiresAtMs > nowMs + 10_000) {
      return this.jwtCache.token;
    }

    const issuedAt = Math.floor(nowMs / 1000);
    const header = base64UrlEncode(JSON.stringify({ alg: 'ES256', kid: this.config.keyId }));
    const payload = base64UrlEncode(JSON.stringify({ iss: this.config.teamId, iat: issuedAt }));
    const toSign = `${header}.${payload}`;

    const signer = createSign('sha256');
    signer.update(toSign);
    signer.end();

    const privateKey = createPrivateKey(this.config.privateKey.replace(/\\n/g, '\n'));
    const signature = signer.sign(privateKey);
    const jwt = `${toSign}.${base64UrlEncodeBuffer(signature)}`;

    this.jwtCache = {
      token: jwt,
      expiresAtMs: nowMs + 50 * 60 * 1000,
    };

    return jwt;
  }

  private async getOrCreateSession(endpoint: string): Promise<ClientHttp2Session> {
    const cached = this.sessions.get(endpoint);
    if (cached && !cached.session.closed && !cached.session.destroyed) {
      // A TCP connection can die silently (NAT, sleep): after a quiet minute it is pinged before use,
      // and a dead one is replaced instead of making every push wait out the timeout.
      if (this.now() - cached.lastUsedMs <= SESSION_IDLE_CHECK_MS || await pingSession(cached.session, PING_TIMEOUT_MS)) {
        cached.lastUsedMs = this.now();
        return cached.session;
      }
      this.dropSession(endpoint, cached.session);
    }

    const session = this.connect(endpoint);
    session.on('error', () => {
      // Request-level handlers report actionable errors. Keep this to avoid unhandled events.
    });
    session.on('close', () => {
      if (this.sessions.get(endpoint)?.session === session) {
        this.sessions.delete(endpoint);
      }
    });
    this.sessions.set(endpoint, { session, lastUsedMs: this.now() });
    return session;
  }

  /** Destroys a broken session; only the cached one is forgotten, so a newer session is never dropped. */
  private dropSession(endpoint: string, session: ClientHttp2Session): void {
    if (this.sessions.get(endpoint)?.session === session) {
      this.sessions.delete(endpoint);
    }
    if (!session.destroyed) {
      session.destroy();
    }
  }

  private async sendHttp2Request(input: {
    endpoint: string;
    deviceToken: string;
    jwt: string;
    payload: string;
    headers?: Record<string, string>;
  }): Promise<{ status: number; body: string }> {
    const session = await this.getOrCreateSession(input.endpoint);
    const dropSession = (): void => this.dropSession(input.endpoint, session);

    return new Promise((resolve, reject) => {
      let settled = false;
      let statusCode = 0;
      let responseBody = '';

      let request: ClientHttp2Stream;
      try {
        request = session.request({
          ':method': 'POST',
          ':path': `/3/device/${encodeURIComponent(input.deviceToken)}`,
          authorization: `bearer ${input.jwt}`,
          'content-type': 'application/json',
          'apns-topic': this.config.bundleId,
          'apns-push-type': 'alert',
          'apns-priority': '10',
          ...input.headers,
        });
      } catch (error) {
        // The session went away between the check and the request.
        dropSession();
        reject(error);
        return;
      }

      request.setEncoding('utf8');
      request.setTimeout(this.config.timeoutMs, () => {
        rejectOnce(new Error(`APNs request timed out after ${this.config.timeoutMs}ms`));
        request.close();
        // A timed-out request usually means a dead connection: the next push gets a new one.
        dropSession();
      });

      request.on('response', (headers: IncomingHttpHeaders) => {
        const rawStatus = headers[':status'];
        statusCode = typeof rawStatus === 'number' ? rawStatus : Number(rawStatus ?? 0);
      });

      request.on('data', (chunk: string) => {
        responseBody += chunk;
      });

      request.on('error', (error: unknown) => {
        // Temporary transport diagnostics for APNs http2 connectivity issues.
        console.warn('[APNS_TRANSPORT_ERROR]', JSON.stringify(extractTransportDiagnostics(error)));
        rejectOnce(error);
        dropSession();
      });

      request.on('end', () => {
        resolveOnce({ status: statusCode, body: responseBody });
      });

      // A stream closed without 'end' or 'error' (e.g. the session was torn down) must not hang the push.
      request.on('close', () => {
        rejectOnce(new Error('APNs stream closed before a response'));
      });

      request.end(input.payload);

      function resolveOnce(value: { status: number; body: string }): void {
        if (settled) {
          return;
        }

        settled = true;
        resolve(value);
      }

      function rejectOnce(error: unknown): void {
        if (settled) {
          return;
        }

        settled = true;
        reject(error);
      }
    });
  }
}

const SANDBOX_ENDPOINT = 'https://api.sandbox.push.apple.com';
const PRODUCTION_ENDPOINT = 'https://api.push.apple.com';
const MAX_REMEMBERED_TOKEN_HOSTS = 1_000;
const SESSION_IDLE_CHECK_MS = 60_000;
const PING_TIMEOUT_MS = 2_000;

function otherEndpoint(endpoint: string): string {
  return endpoint === SANDBOX_ENDPOINT ? PRODUCTION_ENDPOINT : SANDBOX_ENDPOINT;
}

function hostLabel(endpoint: string): 'sandbox' | 'production' {
  return endpoint === SANDBOX_ENDPOINT ? 'sandbox' : 'production';
}

/** A short hash so logs can tell phones apart without carrying the token. */
function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 10);
}

function isBadDeviceToken(response: { status: number; body: string }): boolean {
  return response.status === 400 && readApnsReason(response.body) === 'BadDeviceToken';
}

function mapApnsResponse(response: { status: number; body: string }): PushNotificationProviderError {
  const apnsReason = readApnsReason(response.body);

  if (response.status === 400 && apnsReason === 'BadDeviceToken') {
    return new PushNotificationProviderError('DEVICE_TOKEN_INVALID', 'APNs device token is invalid', false);
  }

  if (response.status === 410 && apnsReason === 'Unregistered') {
    return new PushNotificationProviderError('DEVICE_TOKEN_UNREGISTERED', 'APNs device token is unregistered', false);
  }

  if (response.status === 403 || response.status === 401) {
    return new PushNotificationProviderError('APNS_AUTH', `APNs authentication failed (${response.status})`, false);
  }

  // No :status means the stream ended without a real answer (connection torn down mid-request).
  if (!response.status || response.status === 429 || response.status >= 500) {
    return new PushNotificationProviderError('APNS_RETRYABLE', `APNs temporary failure (${response.status || 'no status'})`, true);
  }

  return new PushNotificationProviderError('APNS_NON_RETRYABLE', `APNs rejected push (${response.status})`, false);
}

function pingSession(session: ClientHttp2Session, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (alive: boolean): void => {
      if (done) {
        return;
      }
      done = true;
      clearTimeout(timer);
      resolve(alive);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    try {
      const sent = session.ping((error) => finish(!error));
      if (!sent) {
        finish(false);
      }
    } catch {
      finish(false);
    }
  });
}

function readApnsReason(responseBody: string): string | null {
  try {
    const json = JSON.parse(responseBody) as { reason?: string };
    return typeof json.reason === 'string' ? json.reason : null;
  } catch {
    return null;
  }
}

function base64UrlEncode(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64url');
}

function base64UrlEncodeBuffer(input: Buffer): string {
  return input.toString('base64url');
}

function sanitizeError(input: string): string {
  return input
    .replace(/(bearer\s+)[A-Za-z0-9._\-]+/gi, '$1[REDACTED]')
    .replace(/-----BEGIN PRIVATE KEY-----[\s\S]*?-----END PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]');
}

function formatTransportError(error: unknown): string {
  if (!(error instanceof Error)) {
    return 'APNs network failure';
  }

  const diagnostics = extractTransportDiagnostics(error);
  const diagnosticsSerialized = JSON.stringify(diagnostics);

  const cause = (error as Error & { cause?: unknown }).cause;
  if (!cause) {
    return `${error.message}; diagnostics=${diagnosticsSerialized}`;
  }

  if (cause instanceof Error) {
    const causeCode = (cause as Error & { code?: string }).code;
    const codePart = causeCode ? ` [${causeCode}]` : '';
    return `${error.message}; cause=${cause.name}${codePart}: ${cause.message}; diagnostics=${diagnosticsSerialized}`;
  }

  return `${error.message}; cause=${String(cause)}; diagnostics=${diagnosticsSerialized}`;
}

function extractTransportDiagnostics(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) {
    return {
      name: 'UnknownError',
      message: sanitizeError(String(error)),
    };
  }

  const typedError = error as Error & {
    code?: string;
    cause?: unknown;
  };
  const cause = typedError.cause;
  const causeError = cause instanceof Error
    ? cause as Error & {
      code?: string;
      errno?: string | number;
      syscall?: string;
      hostname?: string;
      port?: number;
    }
    : null;

  return {
    error_name: sanitizeError(typedError.name || 'Error'),
    error_message: sanitizeError(typedError.message || ''),
    error_code: typedError.code ?? null,
    cause_name: causeError ? sanitizeError(causeError.name || 'Error') : null,
    cause_message: causeError ? sanitizeError(causeError.message || '') : cause ? sanitizeError(String(cause)) : null,
    cause_code: causeError?.code ?? null,
    cause_errno: causeError?.errno ?? null,
    cause_syscall: causeError?.syscall ?? null,
    cause_hostname: causeError?.hostname ?? null,
    cause_port: causeError?.port ?? null,
  };
}

/** A rescue alert is about now: a phone that was offline does not get it hours later, and its reminder replaces it. */
export const RESCUE_PUSH_TTL_SECONDS = 15 * 60;

export function deliveryHeaders(notification: PushNotificationEnvelope, nowMs: number): Record<string, string> {
  if (notification.payload.type !== 'rescue_carbs') {
    return notification.collapseId ? { 'apns-collapse-id': notification.collapseId.slice(0, 64) } : {};
  }
  return {
    'apns-expiration': String(Math.floor(nowMs / 1000) + RESCUE_PUSH_TTL_SECONDS),
    'apns-collapse-id': `rescue-${notification.payload.alertId}`.slice(0, 64),
  };
}
