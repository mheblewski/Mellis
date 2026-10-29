import 'reflect-metadata';
import { Body, Controller, HttpCode, Param, Post } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PUBLIC_RATE_LIMITS, TokenBucketLimiter } from './common/rate-limit';
import { configureHttp } from './http-setup';

@Controller('/v1')
class EchoController {
  @Post('pair')
  @HttpCode(201)
  pair(): Record<string, unknown> {
    return { ok: true };
  }

  @Post('auth/challenge')
  @HttpCode(200)
  challenge(): Record<string, unknown> {
    return { ok: true };
  }

  @Post('patients/:patientId/meals/:mealId/photos')
  @HttpCode(201)
  photo(@Param('patientId') patientId: string, @Body() body: { data_base64?: string }): Record<string, unknown> {
    return { patient_id: patientId, length: body.data_base64?.length ?? 0 };
  }

  @Post('patients/:patientId/conversations')
  @HttpCode(201)
  conversation(@Body() body: { text?: string }): Record<string, unknown> {
    return { length: body.text?.length ?? 0 };
  }
}

describe('HTTP stack (main.ts): rate limits, body limits, proxy trust', () => {
  let app: NestExpressApplication;
  let now = 1_000_000;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ controllers: [EchoController] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false, bodyParser: false });
    configureHttp(app, new TokenBucketLimiter(10_000, () => now));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('pairing: 5 at once per IP, then 429 problem+json with Retry-After; another IP has its own bucket', async () => {
    const from = (ip: string) => request(app.getHttpServer()).post('/v1/pair').set('X-Forwarded-For', ip).send({});
    for (let i = 0; i < 5; i += 1) await from('203.0.113.1').expect(201);
    const refused = await from('203.0.113.1').expect(429);
    expect(refused.headers['content-type']).toContain('application/problem+json');
    expect(refused.headers['retry-after']).toBe('6');
    expect(refused.body).toMatchObject({ status: 429, code: 'RATE_LIMITED', instance: '/v1/pair' });
    await from('203.0.113.2').expect(201);
    // A forged address left of the real one changes nothing: the rightmost untrusted address is the client.
    await request(app.getHttpServer()).post('/v1/pair').set('X-Forwarded-For', '198.51.100.7, 203.0.113.1').send({}).expect(429);
    // Express routes are case-insensitive and allow a trailing slash: so is the limit.
    await request(app.getHttpServer()).post('/V1/PAIR/').set('X-Forwarded-For', '203.0.113.1').send({}).expect(429);
    // 10 per minute: a token back after 6 s.
    now += 6_000;
    await from('203.0.113.1').expect(201);
    await from('203.0.113.1').expect(429);
  });

  it('auth challenge: a bucket of its own (15 at once), not shared with pairing', async () => {
    const from = () => request(app.getHttpServer()).post('/v1/auth/challenge').set('X-Forwarded-For', '203.0.113.50').send({});
    for (let i = 0; i < 15; i += 1) await from().expect(200);
    await from().expect(429);
    await request(app.getHttpServer()).post('/v1/pair').set('X-Forwarded-For', '203.0.113.50').send({}).expect(201);
  });

  it('a normal route refuses a JSON body above 100 kB with 413 problem+json', async () => {
    const big = await request(app.getHttpServer()).post('/v1/patients/p1/conversations').send({ text: 'x'.repeat(150 * 1024) }).expect(413);
    expect(big.headers['content-type']).toContain('application/problem+json');
    expect(big.body).toMatchObject({ status: 413, code: 'PAYLOAD_TOO_LARGE' });
    await request(app.getHttpServer()).post('/v1/patients/p1/conversations').send({ text: 'x'.repeat(50 * 1024) }).expect(201);
  });

  it('a photo route accepts a 5 MB body, and refuses one above 6 MB', async () => {
    const photo = 'A'.repeat(5 * 1024 * 1024);
    const accepted = await request(app.getHttpServer()).post('/v1/patients/p1/meals/m1/photos').send({ content_type: 'image/jpeg', data_base64: photo }).expect(201);
    expect(accepted.body).toEqual({ patient_id: 'p1', length: photo.length });
    await request(app.getHttpServer()).post('/v1/patients/p1/meals/m1/photos').send({ data_base64: 'A'.repeat(7 * 1024 * 1024) }).expect(413);
  });

  it('malformed JSON answers 400 problem+json', async () => {
    const bad = await request(app.getHttpServer()).post('/v1/patients/p1/conversations').set('Content-Type', 'application/json').send('{"text": ').expect(400);
    expect(bad.body).toMatchObject({ status: 400, code: 'INVALID_JSON' });
  });

  it('trusts X-Forwarded-For only from loopback and private-network proxies', () => {
    const trust = app.getHttpAdapter().getInstance().get('trust proxy fn') as (address: string, hop: number) => boolean;
    for (const proxy of ['127.0.0.1', '::1', '172.18.0.5', '::ffff:172.18.0.5', '10.0.0.2', '192.168.1.10', 'fd00::5']) expect(trust(proxy, 0)).toBe(true);
    for (const peer of ['203.0.113.1', '8.8.8.8', '2001:db8::1']) expect(trust(peer, 0)).toBe(false);
  });

  it('sends no CORS headers (cors: false in main.ts; the test app has none either)', async () => {
    const answer = await request(app.getHttpServer()).post('/v1/patients/p1/conversations').set('Origin', 'https://evil.example').send({}).expect(201);
    expect(answer.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('limits every public route, and nothing else', () => {
    const paths = ['POST /v1/pair', 'POST /v1/setup/recover', 'POST /v1/setup/owner', 'POST /v1/setup/patients', 'POST /v1/setup/ai', 'POST /v1/setup/nightscout-check', 'POST /v1/setup/pairing-code', 'GET /v1/setup', 'POST /v1/auth/challenge', 'POST /v1/auth/session', 'POST /v1/devices/release'];
    const ruleOf = (line: string) => {
      const [method, path] = line.split(' ');
      return PUBLIC_RATE_LIMITS.find((rule) => rule.method === method && rule.path.test(path))?.name;
    };
    expect(paths.map(ruleOf)).toEqual(['pairing', 'pairing', 'setup', 'setup', 'setup', 'setup', 'setup', 'setup-status', 'auth', 'auth', 'device-release']);
    for (const other of ['GET /v1/app-config', 'POST /v1/me/pairing-codes', 'POST /v1/patients/p1/conversations', 'GET /v1/me/patients']) expect(ruleOf(other)).toBeUndefined();
  });
});

describe('TokenBucketLimiter memory', () => {
  it('keeps at most maxBuckets buckets, dropping the least recently used', () => {
    const limiter = new TokenBucketLimiter(3, () => 0);
    const rule = { name: 'r', burst: 1, perMinute: 1 };
    for (const ip of ['a', 'b', 'c', 'd']) limiter.take(rule, ip);
    expect(limiter.size).toBe(3);
    // 'a' was evicted: a fresh (full) bucket; 'd' is still empty.
    expect(limiter.take(rule, 'a').allowed).toBe(true);
    expect(limiter.take(rule, 'd').allowed).toBe(false);
  });
});
