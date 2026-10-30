import { EventEmitter } from 'events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApnsPushNotificationProvider } from './apns-push-notification-provider';
import { PushNotificationProviderError } from './push-notification-provider.error';

const PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----\nMHcCAQEEIBmQ1Q4UeZQnqu6FQnD5aJlp7fM9QOp1QzvXyMjtE2N5oAoGCCqGSM49\nAwEHoUQDQgAEk2w8cW9yM0R2mN9x9wG3hM5lq8rFYzXrJr3hXGx36bHf7NG1x4k5\nqXFGS2X9YhG2n7C3L6Qbq3kB11WlQf7XGw==\n-----END PRIVATE KEY-----`;

function createProvider() {
  return new ApnsPushNotificationProvider({
    teamId: 'TEAM12345',
    keyId: 'KEY12345',
    privateKey: PRIVATE_KEY,
    bundleId: 'pl.glucomind.ios',
    useSandbox: true,
    timeoutMs: 500,
  });
}

function createProviderWithStubbedJwt(): ApnsPushNotificationProvider {
  const provider = createProvider();
  vi.spyOn(provider as any, 'getOrCreateJwt').mockReturnValue('jwt');
  return provider;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ApnsPushNotificationProvider', () => {
  it('sends minimal payload without clinical details', async () => {
    const provider = createProviderWithStubbedJwt();
    const sendHttp2Request = vi.spyOn(provider as any, 'sendHttp2Request').mockResolvedValue({ status: 200, body: '' });

    await provider.send({
      platform: 'ios',
      pushToken: 'token-1',
      title: 'GlucoMind',
      body: 'Mam jedno pytanie dotyczace ostatniej hipoglikemii.',
      payload: {
        type: 'conversation_question',
        patientId: 'patient-1',
        conversationId: 'conv-1',
        questionId: 'activity_before_drop',
        routePath: '/patients/patient-1/conversations/conv-1',
        universalLink: 'https://app.mellis.invalid/patients/patient-1/conversations/conv-1',
      },
    });

    expect(sendHttp2Request).toHaveBeenCalledTimes(1);
    const call = sendHttp2Request.mock.calls[0]?.[0] as { endpoint: string; payload: string; deviceToken: string };
    const body = JSON.parse(String(call.payload)) as Record<string, any>;
    expect(call.endpoint).toBe('https://api.sandbox.push.apple.com');
    expect(call.deviceToken).toBe('token-1');
    expect(body).toEqual({
      aps: {
        alert: {
          title: 'GlucoMind',
          body: 'Mam jedno pytanie dotyczace ostatniej hipoglikemii.',
        },
        sound: 'default',
      },
      gluco: {
        type: 'conversation_question',
        patientId: 'patient-1',
        conversationId: 'conv-1',
        routePath: '/patients/patient-1/conversations/conv-1',
        universalLink: 'https://app.mellis.invalid/patients/patient-1/conversations/conv-1',
      },
    });
    expect(body.gluco.questionId).toBeUndefined();
    expect(body.gluco.glucose).toBeUndefined();
    expect(body.gluco.insulin).toBeUndefined();
  });

  it('sends a rescue carb alert as time-sensitive with its alert id', async () => {
    const provider = createProviderWithStubbedJwt();
    const sendHttp2Request = vi.spyOn(provider as any, 'sendHttp2Request').mockResolvedValue({ status: 200, body: '' });

    await provider.send({
      platform: 'ios',
      pushToken: 'token-1',
      title: 'Możliwe niedocukrzenie',
      body: 'Ok. 12:25 może spaść poniżej 70 · proponuję 4 g',
      interruptionLevel: 'time-sensitive',
      payload: {
        type: 'rescue_carbs',
        patientId: 'patient-1',
        conversationId: 'conv-1',
        alertId: 'alert-1',
        routePath: '/patients/patient-1/conversations/conv-1',
        universalLink: 'https://app.mellis.invalid/patients/patient-1/conversations/conv-1',
      },
    });

    const body = JSON.parse(String((sendHttp2Request.mock.calls[0]?.[0] as { payload: string }).payload)) as Record<string, any>;
    expect(body.aps['interruption-level']).toBe('time-sensitive');
    expect(body.gluco).toEqual({
      type: 'rescue_carbs',
      patientId: 'patient-1',
      conversationId: 'conv-1',
      alertId: 'alert-1',
      routePath: '/patients/patient-1/conversations/conv-1',
      universalLink: 'https://app.mellis.invalid/patients/patient-1/conversations/conv-1',
    });
    // Expires with the situation (15 min) and its reminder replaces it on the lock screen.
    const headers = (sendHttp2Request.mock.calls[0]?.[0] as { headers: Record<string, string> }).headers;
    expect(headers['apns-collapse-id']).toBe('rescue-alert-1');
    expect(Number(headers['apns-expiration']) - Math.floor(Date.now() / 1000)).toBeGreaterThan(14 * 60);
    expect(Number(headers['apns-expiration']) - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(15 * 60);
  });

  it('sends a meal chat answer with its meal route and collapses resends of one question', async () => {
    const provider = createProviderWithStubbedJwt();
    const sendHttp2Request = vi.spyOn(provider as any, 'sendHttp2Request').mockResolvedValue({ status: 200, body: '' });

    await provider.send({
      platform: 'ios',
      pushToken: 'token-1',
      title: 'Odpowiedź gotowa',
      body: 'Pizza ma ok. 60 g węglowodanów.',
      collapseId: 'answer-message-1',
      payload: {
        type: 'meal_chat_answer',
        patientId: 'patient-1',
        mealId: 'meal-1',
        routePath: '/patients/patient-1/meals/meal-1',
        universalLink: 'https://app.mellis.invalid/patients/patient-1/meals/meal-1',
      },
    });

    const call = sendHttp2Request.mock.calls[0]?.[0] as { payload: string; headers: Record<string, string> };
    expect(JSON.parse(call.payload).gluco).toEqual({
      type: 'meal_chat_answer',
      patientId: 'patient-1',
      mealId: 'meal-1',
      routePath: '/patients/patient-1/meals/meal-1',
      universalLink: 'https://app.mellis.invalid/patients/patient-1/meals/meal-1',
    });
    expect(call.headers).toEqual({ 'apns-collapse-id': 'answer-message-1' });
  });

  it('sends a remote settings hand-off with its patient route and hand-off id', async () => {
    const provider = createProviderWithStubbedJwt();
    const sendHttp2Request = vi.spyOn(provider as any, 'sendHttp2Request').mockResolvedValue({ status: 200, body: '' });

    await provider.send({
      platform: 'ios',
      pushToken: 'token-1',
      title: 'Przekazane ustawienia',
      body: 'Tomek przekazał Ci ustawienia Trio dla: Zosia',
      collapseId: 'handoff-h1',
      payload: { type: 'remote_settings_handoff', patientId: 'patient-1', handoffId: 'h1', routePath: '/patients/patient-1', universalLink: 'https://app.mellis.invalid/patients/patient-1' },
    });

    const call = sendHttp2Request.mock.calls[0]?.[0] as { payload: string; headers: Record<string, string> };
    expect(JSON.parse(call.payload).gluco).toEqual({ type: 'remote_settings_handoff', patientId: 'patient-1', handoffId: 'h1', routePath: '/patients/patient-1', universalLink: 'https://app.mellis.invalid/patients/patient-1' });
    expect(call.headers).toEqual({ 'apns-collapse-id': 'handoff-h1' });
  });

  it('maps APNs 429 as retryable', async () => {
    const provider = createProviderWithStubbedJwt();
    vi.spyOn(provider as any, 'sendHttp2Request').mockResolvedValue({
      status: 429,
      body: JSON.stringify({ reason: 'TooManyRequests' }),
    });

    await expect(provider.send({
      platform: 'ios',
      pushToken: 'token-1',
      title: 'GlucoMind',
      body: 'body',
      payload: {
        type: 'conversation_question',
        patientId: 'patient-1',
        conversationId: 'conv-1',
        questionId: 'q-1',
        routePath: '/patients/patient-1/conversations/conv-1',
        universalLink: 'https://app.mellis.invalid/patients/patient-1/conversations/conv-1',
      },
    })).rejects.toMatchObject({ retryable: true, code: 'APNS_RETRYABLE' });
  });

  it('maps APNs invalid token as non-retryable once both hosts reject it', async () => {
    const provider = createProviderWithStubbedJwt();
    const sendHttp2Request = vi.spyOn(provider as any, 'sendHttp2Request').mockResolvedValue({
      status: 400,
      body: JSON.stringify({ reason: 'BadDeviceToken' }),
    });

    await expect(provider.send(notification())).rejects.toMatchObject({ retryable: false, code: 'DEVICE_TOKEN_INVALID' });
    expect(endpoints(sendHttp2Request)).toEqual(['https://api.sandbox.push.apple.com', 'https://api.push.apple.com']);
  });

  it('delivers a token of the other APNs environment on the other host and remembers it', async () => {
    const provider = createProviderWithStubbedJwt();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const sendHttp2Request = vi.spyOn(provider as any, 'sendHttp2Request').mockImplementation(async (input: any) => (
      input.endpoint === 'https://api.push.apple.com'
        ? { status: 200, body: '' }
        : { status: 400, body: JSON.stringify({ reason: 'BadDeviceToken' }) }
    ));

    await provider.send(notification('testflight-token'));
    await provider.send(notification('testflight-token'));

    expect(endpoints(sendHttp2Request)).toEqual([
      'https://api.sandbox.push.apple.com',
      'https://api.push.apple.com',
      // Remembered: the second push goes straight to the host that took it.
      'https://api.push.apple.com',
    ]);
    const logged = warn.mock.calls.filter((call) => call[0] === '[APNS_HOST_FALLBACK]');
    expect(logged).toHaveLength(1);
    expect(String(logged[0]?.[1])).toContain('"delivered_by":"production"');
    expect(String(logged[0]?.[1])).not.toContain('testflight-token');
  });

  it('forgets a token of another app (DeviceTokenNotForTopic, e.g. phones restored from an older installation)', async () => {
    const provider = createProviderWithStubbedJwt();
    const sendHttp2Request = vi.spyOn(provider as any, 'sendHttp2Request').mockResolvedValue({
      status: 400,
      body: JSON.stringify({ reason: 'DeviceTokenNotForTopic' }),
    });

    await expect(provider.send(notification())).rejects.toMatchObject({ retryable: false, code: 'DEVICE_TOKEN_INVALID' });
    expect(sendHttp2Request).toHaveBeenCalledTimes(1);
  });

  it('does not try the other host for an unregistered token', async () => {
    const provider = createProviderWithStubbedJwt();
    const sendHttp2Request = vi.spyOn(provider as any, 'sendHttp2Request').mockResolvedValue({
      status: 410,
      body: JSON.stringify({ reason: 'Unregistered' }),
    });

    await expect(provider.send(notification())).rejects.toMatchObject({ retryable: false, code: 'DEVICE_TOKEN_UNREGISTERED' });
    expect(sendHttp2Request).toHaveBeenCalledTimes(1);
  });

  it('keeps a fallback-host failure that is not BadDeviceToken retryable', async () => {
    const provider = createProviderWithStubbedJwt();
    vi.spyOn(provider as any, 'sendHttp2Request').mockImplementation(async (input: any) => (
      input.endpoint === 'https://api.push.apple.com'
        ? { status: 503, body: '' }
        : { status: 400, body: JSON.stringify({ reason: 'BadDeviceToken' }) }
    ));

    await expect(provider.send(notification())).rejects.toMatchObject({ retryable: true, code: 'APNS_RETRYABLE' });
  });

  it('maps a response without status as retryable', async () => {
    const provider = createProviderWithStubbedJwt();
    vi.spyOn(provider as any, 'sendHttp2Request').mockResolvedValue({ status: 0, body: '' });

    await expect(provider.send(notification())).rejects.toMatchObject({ retryable: true, code: 'APNS_RETRYABLE' });
  });

  it('maps HTTP 401 to non-retryable APNS_AUTH', async () => {
    const provider = createProviderWithStubbedJwt();
    vi.spyOn(provider as any, 'sendHttp2Request').mockResolvedValue({
      status: 401,
      body: JSON.stringify({ reason: 'InvalidProviderToken' }),
    });

    await expect(provider.send({
      platform: 'ios',
      pushToken: 'token-1',
      title: 'GlucoMind',
      body: 'body',
      payload: {
        type: 'conversation_question',
        patientId: 'patient-1',
        conversationId: 'conv-1',
        questionId: 'q-1',
        routePath: '/patients/patient-1/conversations/conv-1',
        universalLink: 'https://app.mellis.invalid/patients/patient-1/conversations/conv-1',
      },
    })).rejects.toMatchObject({ retryable: false, code: 'APNS_AUTH' });
  });

  it('maps transport errors to APNS_NETWORK and preserves sanitized cause', async () => {
    const provider = createProviderWithStubbedJwt();
    const transportError = new TypeError(
      'fetch failed authorization bearer verysecrettoken -----BEGIN PRIVATE KEY-----abc-----END PRIVATE KEY-----',
      {
        cause: new Error('tls handshake failure'),
      },
    );
    vi.spyOn(provider as any, 'sendHttp2Request').mockRejectedValue(transportError);

    await expect(provider.send({
      platform: 'ios',
      pushToken: 'token-1',
      title: 'GlucoMind',
      body: 'body',
      payload: {
        type: 'conversation_question',
        patientId: 'patient-1',
        conversationId: 'conv-1',
        questionId: 'q-1',
        routePath: '/patients/patient-1/conversations/conv-1',
        universalLink: 'https://app.mellis.invalid/patients/patient-1/conversations/conv-1',
      },
    })).rejects.toSatisfy((error: unknown): boolean => {
      expect(error).toBeInstanceOf(PushNotificationProviderError);
      expect((error as PushNotificationProviderError).code).toBe('APNS_NETWORK');
      expect((error as PushNotificationProviderError).retryable).toBe(true);
      const message = (error as Error).message;
      expect(message).not.toContain('verysecrettoken');
      expect(message).not.toContain('BEGIN PRIVATE KEY');
      expect(message).toContain('tls handshake failure');
      return true;
    });
  });

  describe('HTTP/2 session', () => {
    it('drops a session whose request timed out, so the next push reconnects', async () => {
      const sessions: FakeSession[] = [];
      const provider = createSessionProvider(sessions, () => 0);
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      const first = provider.send(notification());
      await flush();
      // No answer: the timeout (500 ms in the test config) fires.
      sessions[0]!.lastStream!.fireTimeout();
      await expect(first).rejects.toMatchObject({ retryable: true, code: 'APNS_NETWORK' });
      expect(sessions[0]!.destroyed).toBe(true);

      const second = provider.send(notification());
      await flush();
      sessions[1]!.lastStream!.respond(200);
      await expect(second).resolves.toBeUndefined();
      expect(sessions).toHaveLength(2);
    });

    it('drops a session after a transport error on the stream', async () => {
      const sessions: FakeSession[] = [];
      const provider = createSessionProvider(sessions, () => 0);
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      const first = provider.send(notification());
      await flush();
      sessions[0]!.lastStream!.emit('error', new Error('ECONNRESET'));
      await expect(first).rejects.toMatchObject({ retryable: true, code: 'APNS_NETWORK' });
      expect(sessions[0]!.destroyed).toBe(true);
    });

    it('rejects as retryable when the stream closes without an answer', async () => {
      const sessions: FakeSession[] = [];
      const provider = createSessionProvider(sessions, () => 0);

      const first = provider.send(notification());
      await flush();
      sessions[0]!.lastStream!.emit('close');
      await expect(first).rejects.toMatchObject({ retryable: true, code: 'APNS_NETWORK' });
    });

    it('reuses a busy session without a ping', async () => {
      const sessions: FakeSession[] = [];
      const provider = createSessionProvider(sessions, () => 0);

      for (let i = 0; i < 2; i += 1) {
        const sent = provider.send(notification());
        await flush();
        sessions[0]!.lastStream!.respond(200);
        await sent;
      }
      expect(sessions).toHaveLength(1);
      expect(sessions[0]!.pings).toBe(0);
    });

    it('pings a session idle for over a minute and replaces it when the ping fails', async () => {
      const sessions: FakeSession[] = [];
      let nowMs = 0;
      const provider = createSessionProvider(sessions, () => nowMs);

      const first = provider.send(notification());
      await flush();
      sessions[0]!.lastStream!.respond(200);
      await first;

      nowMs = 61_000;
      sessions[0]!.pingResult = 'error';
      const second = provider.send(notification());
      await flush();
      expect(sessions[0]!.pings).toBe(1);
      expect(sessions[0]!.destroyed).toBe(true);
      sessions[1]!.lastStream!.respond(200);
      await expect(second).resolves.toBeUndefined();
    });

    it('keeps an idle session that answers the ping', async () => {
      const sessions: FakeSession[] = [];
      let nowMs = 0;
      const provider = createSessionProvider(sessions, () => nowMs);

      const first = provider.send(notification());
      await flush();
      sessions[0]!.lastStream!.respond(200);
      await first;

      nowMs = 61_000;
      const second = provider.send(notification());
      await flush();
      sessions[0]!.lastStream!.respond(200);
      await expect(second).resolves.toBeUndefined();
      expect(sessions).toHaveLength(1);
      expect(sessions[0]!.pings).toBe(1);
    });
  });
});

function notification(pushToken = 'token-1') {
  return {
    platform: 'ios' as const,
    pushToken,
    title: 'GlucoMind',
    body: 'body',
    payload: {
      type: 'conversation_question' as const,
      patientId: 'patient-1',
      conversationId: 'conv-1',
      questionId: 'q-1',
      routePath: '/patients/patient-1/conversations/conv-1',
      universalLink: 'https://app.mellis.invalid/patients/patient-1/conversations/conv-1',
    },
  };
}

function endpoints(spy: { mock: { calls: unknown[][] } }): string[] {
  return spy.mock.calls.map((call) => (call[0] as { endpoint: string }).endpoint);
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
  }
}

class FakeStream extends EventEmitter {
  private timeoutHandler: (() => void) | null = null;

  setEncoding(): void {}

  setTimeout(_ms: number, handler: () => void): void {
    this.timeoutHandler = handler;
  }

  end(): void {}

  close(): void {
    this.emit('close');
  }

  fireTimeout(): void {
    this.timeoutHandler?.();
  }

  respond(status: number, body = ''): void {
    this.emit('response', { ':status': status });
    if (body) {
      this.emit('data', body);
    }
    this.emit('end');
    this.emit('close');
  }
}

class FakeSession extends EventEmitter {
  closed = false;
  destroyed = false;
  pings = 0;
  pingResult: 'ok' | 'error' = 'ok';
  lastStream: FakeStream | null = null;

  request(): FakeStream {
    this.lastStream = new FakeStream();
    return this.lastStream;
  }

  ping(callback: (error: Error | null) => void): boolean {
    this.pings += 1;
    queueMicrotask(() => callback(this.pingResult === 'ok' ? null : new Error('ping failed')));
    return true;
  }

  destroy(): void {
    this.destroyed = true;
    this.emit('close');
  }
}

function createSessionProvider(sessions: FakeSession[], now: () => number): ApnsPushNotificationProvider {
  const provider = new ApnsPushNotificationProvider({
    teamId: 'TEAM12345',
    keyId: 'KEY12345',
    privateKey: PRIVATE_KEY,
    bundleId: 'pl.glucomind.ios',
    useSandbox: true,
    timeoutMs: 500,
  }, {
    connect: () => {
      const session = new FakeSession();
      sessions.push(session);
      return session as any;
    },
    now,
  });
  vi.spyOn(provider as any, 'getOrCreateJwt').mockReturnValue('jwt');
  return provider;
}
