import 'dotenv/config';
import 'reflect-metadata';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { configurePostgresIntegrationEnvironment, truncatePublicTablesForIntegrationTests } from '@infra/db/postgres-test-isolation';
import { FakeDeviceKey } from '@modules/device-auth/testing/fake-device-keys';
import { randomBytes } from 'node:crypto';
import { bolusKeyMessage, pairingMessage, remoteSettingsHandoffMessage, sessionMessage } from '@modules/device-auth/domain/device-crypto';

const runPostgresIntegration = process.env.RUN_POSTGRES_INTEGRATION === '1';
const describePostgres = runPostgresIntegration ? describe.sequential : describe.skip;

configurePostgresIntegrationEnvironment(process.env);

const SETUP_CODE = 'TEST1-SETUP-CODE2-ABCDE';
const ENV: Record<string, string> = {
  AUTH_MODE: 'device',
  NIGHTSCOUT_TOKEN_ENCRYPTION_KEY: '11'.repeat(32),
  SETUP_CODE,
  NIGHTSCOUT_ALLOWED_HOSTS: 'localhost,127.0.0.1',
  REMOTE_COMMANDS_ENABLED: 'true',
  PUBLIC_BASE_URL: 'https://mellis.example',
};

/** A Nightscout on this machine: `reader-*` tokens read, `writer-*` tokens can also write. */
function fakeNightscout(): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const json = (body: unknown, status = 200) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const exchange = url.pathname.match(/^\/api\/v2\/authorization\/request\/(.+)$/);
    if (exchange) {
      const token = decodeURIComponent(exchange[1]);
      if (!token.startsWith('reader-') && !token.startsWith('writer-')) return json({ message: 'Unauthorized' }, 401);
      const permissionGroups = token.startsWith('writer-') ? [['api:*:read', 'api:treatments:create']] : [['api:*:read']];
      return json({ token: 'aaa.bbb.ccc', exp: Math.floor(Date.now() / 1000) + 3600, permissionGroups });
    }
    if (req.headers.authorization !== 'Bearer aaa.bbb.ccc') return json({ message: 'Unauthorized' }, 401);
    if (url.pathname === '/api/v1/entries') return json([{ sgv: 123, date: Date.now() - 3 * 60_000, direction: 'Flat' }]);
    if (url.pathname === '/api/v1/devicestatus') return json([{ device: 'Trio', openaps: {}, created_at: new Date().toISOString() }]);
    if (url.pathname.startsWith('/api/v1/profile')) return json([]);
    return json([], 404);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as AddressInfo).port })));
}

interface Phone {
  device: FakeDeviceKey;
  /** Made when the person confirms remote bolus (registerBolusKey), not at pairing. */
  bolus: FakeDeviceKey;
  deviceId?: string;
  token?: string;
}

function newPhone(): Phone {
  return { device: new FakeDeviceKey(), bolus: new FakeDeviceKey() };
}

/** Today's app: the device key alone signs pairing message v2 (a phone without Face ID pairs too). */
function pairBody(phone: Phone, code: string, name: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const message = pairingMessage(code, phone.device.publicKey);
  return {
    code,
    device: { name, public_key: phone.device.publicKey, client_device_id: `${name}-app-id` },
    signature: phone.device.sign(message),
    ...extra,
  };
}

/** An app from before step 1: both keys at pairing, v1. */
function legacyPairBody(phone: Phone, code: string, name: string): Record<string, unknown> {
  const message = pairingMessage(code, phone.device.publicKey, phone.bolus.publicKey);
  return {
    code,
    device: { name, public_key: phone.device.publicKey, bolus_public_key: phone.bolus.publicKey, client_device_id: `${name}-app-id` },
    signature: phone.device.sign(message),
    bolus_signature: phone.bolus.sign(message),
  };
}

describePostgres('self-hosted setup and device auth through the API (postgres)', { timeout: 120_000 }, () => {
  let app: INestApplication;
  let pool: Pool;
  let nightscout: { server: Server; port: number };
  const envBackup: Record<string, string | undefined> = {};

  const http = () => request(app.getHttpServer());
  const nsUrl = (host = 'localhost') => `http://${host}:${nightscout.port}`;
  const auth = (phone: Phone) => ({ Authorization: `Bearer ${phone.token}` });

  async function setupServer(): Promise<{ patientId: string; owner: Phone; ownerId: string; recoveryCode: string }> {
    const patient = await http().post('/v1/setup/patients').set('X-Mellis-Setup-Code', SETUP_CODE)
      .send({ display_name: 'Janek', birth_year: 2017, nightscout: { url: nsUrl(), token: 'reader-abc' } }).expect(201);
    const owner = await http().post('/v1/setup/owner').set('X-Mellis-Setup-Code', SETUP_CODE).send({ first_name: 'Piotr' }).expect(201);
    const phone = newPhone();
    const paired = await http().post('/v1/pair').send(pairBody(phone, owner.body.pairing.code, 'iPhone Piotra')).expect(201);
    phone.deviceId = paired.body.device_id;
    phone.token = paired.body.session.access_token;
    return { patientId: patient.body.patient.patient_id, owner: phone, ownerId: owner.body.user_id, recoveryCode: owner.body.recovery_code };
  }

  /** What the app does when the person confirms remote bolus: a BOLUS_KEY challenge signed by both keys. */
  async function registerBolusKey(phone: Phone, status: number, overrides: { signer?: FakeDeviceKey; bolusSigner?: FakeDeviceKey } = {}) {
    const challenge = await http().post('/v1/me/devices/bolus-key/challenge').set(auth(phone)).expect(201);
    const message = bolusKeyMessage(phone.deviceId!, challenge.body.challenge_id, challenge.body.nonce, phone.bolus.publicKey);
    return http().post('/v1/me/devices/bolus-key').set(auth(phone)).send({
      challenge_id: challenge.body.challenge_id,
      bolus_public_key: phone.bolus.publicKey,
      signature: (overrides.signer ?? phone.device).sign(message),
      bolus_signature: (overrides.bolusSigner ?? phone.bolus).sign(message),
    }).expect(status);
  }

  async function signed(phone: Phone, patientId: string, purpose: 'REMOTE_BOLUS' | 'REMOTE_BOLUS_CONFIRM', fields: Record<string, unknown>) {
    const challenge = await http().post(`/v1/patients/${patientId}/signing-challenges`).set(auth(phone)).send({ purpose }).expect(201);
    return phone.bolus.signPayload({
      v: 1,
      type: purpose === 'REMOTE_BOLUS' ? 'remote_command' : 'remote_bolus_confirm',
      challenge_id: challenge.body.challenge_id,
      nonce: challenge.body.nonce,
      device_id: phone.deviceId,
      patient_id: patientId,
      patient_name: challenge.body.patient_name,
      ...fields,
    });
  }

  beforeAll(async () => {
    for (const [key, value] of Object.entries(ENV)) {
      envBackup[key] = process.env[key];
      process.env[key] = value;
    }
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    nightscout = await fakeNightscout();
    const { ApiAppModule } = await import('../app.module');
    app = (await Test.createTestingModule({ imports: [ApiAppModule] }).compile()).createNestApplication({ logger: false });
    await app.init();
  });

  beforeEach(async () => {
    await truncatePublicTablesForIntegrationTests(pool);
    // A fresh database has this row from migration 091 (the truncate removed it).
    await pool.query(`INSERT INTO server_setup (id) VALUES (true)`);
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    nightscout?.server.close();
    for (const [key, value] of Object.entries(envBackup)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('lets the installer test the Nightscout first and install-app.sh get a fresh owner code that keeps the recovery code', async () => {
    const checked = await http().post('/v1/setup/nightscout-check').set('X-Mellis-Setup-Code', SETUP_CODE).send({ url: nsUrl(), token: 'reader-abc' }).expect(200);
    expect(checked.body.nightscout).toMatchObject({ last_reading: { value: 123 }, uploader: 'Trio' });
    expect((await http().post('/v1/setup/nightscout-check').set('X-Mellis-Setup-Code', SETUP_CODE).send({ url: nsUrl(), token: 'writer-abc' }).expect(422)).body.code).toBe('NIGHTSCOUT_TOKEN_NOT_READ_ONLY');
    await http().post('/v1/setup/nightscout-check').send({ url: nsUrl(), token: 'reader-abc' }).expect(401);
    expect(Number((await pool.query(`SELECT count(*) FROM patients`)).rows[0].count)).toBe(0);

    await http().post('/v1/setup/patients').set('X-Mellis-Setup-Code', SETUP_CODE)
      .send({ display_name: 'Janek', birth_year: 2017, nightscout: { url: nsUrl(), token: 'reader-abc' } }).expect(201);
    expect((await http().post('/v1/setup/pairing-code').set('X-Mellis-Setup-Code', SETUP_CODE).expect(409)).body.code).toBe('SETUP_NEEDS_OWNER');
    const owner = await http().post('/v1/setup/owner').set('X-Mellis-Setup-Code', SETUP_CODE).send({ first_name: 'Piotr' }).expect(201);
    const fresh = await http().post('/v1/setup/pairing-code').set('X-Mellis-Setup-Code', SETUP_CODE).expect(201);
    expect(fresh.body).toMatchObject({ user_id: owner.body.user_id, pairing: { pairing_url: expect.stringContaining('mellis://pair?server=https%3A%2F%2Fmellis.example&code=') } });

    // The installer's first code stops working; the fresh one pairs the first owner and closes the setup.
    const phone = newPhone();
    await http().post('/v1/pair').send(pairBody(phone, owner.body.pairing.code, 'iPhone')).expect(401);
    const paired = await http().post('/v1/pair').send(pairBody(phone, fresh.body.pairing.code, 'iPhone')).expect(201);
    expect(paired.body.user.user_id).toBe(owner.body.user_id);
    expect((await http().post('/v1/setup/pairing-code').set('X-Mellis-Setup-Code', SETUP_CODE).expect(409)).body.code).toBe('SETUP_COMPLETED');

    // The recovery code printed by the installer still works.
    const lost = newPhone();
    const message = pairingMessage(owner.body.recovery_code, lost.device.publicKey);
    await http().post('/v1/setup/recover').send({ recovery_code: owner.body.recovery_code, device: { name: 'Nowy iPhone', public_key: lost.device.publicKey }, signature: lost.device.sign(message) }).expect(201);
  });

  it('server tool: lists patients, replaces a Nightscout and makes a new recovery code', async () => {
    const { patientId, ownerId, recoveryCode } = await setupServer();
    const { DeviceAuthService } = await import('../application/device-auth.service');
    const service = app.get(DeviceAuthService);
    expect(await service.listPatientSources()).toEqual([expect.objectContaining({ patient_id: patientId, display_name: 'Janek', has_token: true, nightscout_url: nsUrl() })]);
    // The same address again for the same patient (a new token after a restore) is fine; another patient's would not be.
    const replaced = await service.replacePatientNightscout(patientId, nsUrl(), 'reader-new');
    expect(replaced).toMatchObject({ patient_id: patientId, nightscout: { uploader: 'Trio' } });
    await expect(service.replacePatientNightscout(patientId, nsUrl(), 'writer-x')).rejects.toMatchObject({ code: 'NIGHTSCOUT_TOKEN_NOT_READ_ONLY' });
    await expect(service.replacePatientNightscout('aaaaaaaa-aaaa-4aaa-8aaa-000000000009', nsUrl(), 'reader-x')).rejects.toMatchObject({ code: 'PATIENT_NOT_FOUND' });
    const renewed = await service.replaceRecoveryCode();
    expect(renewed).toMatchObject({ user_id: ownerId, display_name: 'Piotr' });
    const phone = newPhone();
    await http().post('/v1/setup/recover').send({ recovery_code: recoveryCode, device: { name: 'x', public_key: phone.device.publicKey }, signature: phone.device.sign(pairingMessage(recoveryCode, phone.device.publicKey)) }).expect(401);
    await http().post('/v1/setup/recover').send({ recovery_code: renewed.recovery_code, device: { name: 'x', public_key: phone.device.publicKey }, signature: phone.device.sign(pairingMessage(renewed.recovery_code, phone.device.publicKey)) }).expect(201);
  });

  it('sets up a fresh server with the setup code only, then pairs the first owner and voids the code', async () => {
    expect((await http().get('/v1/setup').expect(200)).body).toEqual({ auth_mode: 'device', setup: 'OPEN', setup_code_configured: true });
    await http().post('/v1/setup/patients').send({}).expect(401);
    await http().post('/v1/setup/patients').set('X-Mellis-Setup-Code', 'WRONG-WRONG-WRONG-WRONG').send({}).expect(401);
    expect((await http().post('/v1/setup/owner').set('X-Mellis-Setup-Code', SETUP_CODE).send({ first_name: 'Piotr' }).expect(409)).body.code).toBe('SETUP_NEEDS_PATIENT');

    // The Nightscout is tested on save: a token that can write is refused, a wrong one too, nothing is stored.
    const writer = await http().post('/v1/setup/patients').set('X-Mellis-Setup-Code', SETUP_CODE)
      .send({ display_name: 'Janek', birth_year: 2017, nightscout: { url: nsUrl(), token: 'writer-abc' } }).expect(422);
    expect(writer.body.code).toBe('NIGHTSCOUT_TOKEN_NOT_READ_ONLY');
    expect((await http().post('/v1/setup/patients').set('X-Mellis-Setup-Code', SETUP_CODE)
      .send({ display_name: 'Janek', birth_year: 2017, nightscout: { url: nsUrl(), token: 'nobody' } }).expect(422)).body.code).toBe('NIGHTSCOUT_TOKEN_INVALID');
    expect((await http().post('/v1/setup/patients').set('X-Mellis-Setup-Code', SETUP_CODE)
      .send({ display_name: 'Janek', birth_year: 2017, nightscout: { url: 'http://10.0.0.5:1337', token: 'reader-abc' } }).expect(422)).body.code).toBe('NIGHTSCOUT_HOST_NOT_ALLOWED');
    expect(Number((await pool.query(`SELECT count(*) FROM patients`)).rows[0].count)).toBe(0);

    const created = await http().post('/v1/setup/patients').set('X-Mellis-Setup-Code', SETUP_CODE)
      .send({ display_name: 'Janek', birth_year: 2017, nightscout: { url: nsUrl(), token: 'reader-abc' } }).expect(201);
    expect(created.body.nightscout).toMatchObject({ base_url: nsUrl(), uploader: 'Trio', last_reading: { value: 123 } });
    const patientId = created.body.patient.patient_id;
    const source = (await pool.query(`SELECT base_url, auth_mode, api_token_ciphertext FROM sources WHERE patient_id = $1::uuid`, [patientId])).rows[0];
    expect(source).toMatchObject({ base_url: nsUrl(), auth_mode: 'ACCESS_TOKEN_JWT' });
    expect(source.api_token_ciphertext).toMatch(/^v1:/);
    expect(source.api_token_ciphertext).not.toContain('reader-abc');
    expect((await pool.query(`SELECT count(*)::int AS n FROM meal_history_epochs WHERE patient_id = $1::uuid`, [patientId])).rows[0].n).toBe(1);

    const status = await http().get('/v1/setup').set('X-Mellis-Setup-Code', SETUP_CODE).expect(200);
    expect(status.body.patients).toEqual([{ patient_id: patientId, display_name: 'Janek', birth_year: 2017 }]);

    const owner = await http().post('/v1/setup/owner').set('X-Mellis-Setup-Code', SETUP_CODE).send({ first_name: 'Piotr' }).expect(201);
    expect(owner.body.pairing.pairing_url).toBe(`mellis://pair?server=${encodeURIComponent('https://mellis.example')}&code=${owner.body.pairing.code}`);
    expect(owner.body.recovery_code).toMatch(/^[0-9A-Z]{5}(-[0-9A-Z]{5}){4}$/);

    // The pairing request must be signed by the key it registers (and, from an older app, by both keys).
    const phone = newPhone();
    const forged = pairBody(phone, owner.body.pairing.code, 'iPhone');
    forged.signature = newPhone().device.sign(pairingMessage(owner.body.pairing.code, phone.device.publicKey));
    expect((await http().post('/v1/pair').send(forged).expect(401)).body.code).toBe('PAIRING_SIGNATURE_INVALID');
    const forgedLegacy = legacyPairBody(phone, owner.body.pairing.code, 'iPhone');
    forgedLegacy.bolus_signature = newPhone().bolus.sign(pairingMessage(owner.body.pairing.code, phone.device.publicKey, phone.bolus.publicKey));
    expect((await http().post('/v1/pair').send(forgedLegacy).expect(401)).body.code).toBe('PAIRING_SIGNATURE_INVALID');
    // A v1 signature does not pass as v2 (the bolus key is not silently dropped).
    const mixed = pairBody(phone, owner.body.pairing.code, 'iPhone', { signature: phone.device.sign(pairingMessage(owner.body.pairing.code, phone.device.publicKey, phone.bolus.publicKey)) });
    expect((await http().post('/v1/pair').send(mixed).expect(401)).body.code).toBe('PAIRING_SIGNATURE_INVALID');

    const paired = await http().post('/v1/pair').send(pairBody(phone, owner.body.pairing.code.toLowerCase(), 'iPhone Piotra')).expect(201);
    expect(paired.body).toMatchObject({ user: { user_id: owner.body.user_id, display_name: 'Piotr' }, session: { token_type: 'Bearer' } });
    expect(paired.body.patients.map((row: { patient_id: string }) => row.patient_id)).toEqual([patientId]);

    // Single use, and the setup code is void now.
    expect((await http().post('/v1/pair').send(pairBody(newPhone(), owner.body.pairing.code, 'x')).expect(401)).body.code).toBe('PAIRING_CODE_INVALID');
    expect((await http().get('/v1/setup').set('X-Mellis-Setup-Code', SETUP_CODE).expect(200)).body).toEqual({ auth_mode: 'device', setup: 'COMPLETED', setup_code_configured: true });
    expect((await http().post('/v1/setup/owner').set('X-Mellis-Setup-Code', SETUP_CODE).send({ first_name: 'Eve' }).expect(409)).body.code).toBe('SETUP_COMPLETED');
    expect((await http().post('/v1/setup/patients').set('X-Mellis-Setup-Code', SETUP_CODE).send({}).expect(409)).body.code).toBe('SETUP_COMPLETED');

    const me = await http().get('/v1/me/patients').set('Authorization', `Bearer ${paired.body.session.access_token}`).expect(200);
    expect(me.body).toMatchObject({ user_id: owner.body.user_id, user_display_name: 'Piotr', patients: [{ patient_id: patientId, display_name: 'Janek' }] });
    // Paired with the device key only: no bolus key until remote bolus is confirmed.
    const device = (await pool.query(`SELECT bolus_public_key, bolus_key_registered_at FROM devices WHERE id = $1::uuid`, [paired.body.device_id])).rows[0];
    expect(device).toEqual({ bolus_public_key: null, bolus_key_registered_at: null });
    const devices = await http().get('/v1/me/devices').set('Authorization', `Bearer ${paired.body.session.access_token}`).expect(200);
    expect(devices.body.devices[0]).toMatchObject({ this_device: true, has_bolus_key: false });
    // A patient made by the setup has remote control on (each person still needs a grant and their confirmation).
    expect((await pool.query(`SELECT remote_control FROM patients WHERE id = $1::uuid`, [patientId])).rows[0].remote_control).toEqual({ enabled: true });
    const nightscoutSummary = await http().get(`/v1/patients/${patientId}/nightscout`).set('Authorization', `Bearer ${paired.body.session.access_token}`).expect(200);
    expect(nightscoutSummary.body).toEqual({ patient_id: patientId, base_url: nsUrl(), last_reading_at: null });
  });

  it('still pairs an app that sends both keys (v1), with its bolus key registered at once', async () => {
    await http().post('/v1/setup/patients').set('X-Mellis-Setup-Code', SETUP_CODE)
      .send({ display_name: 'Janek', birth_year: 2017, nightscout: { url: nsUrl(), token: 'reader-abc' } }).expect(201);
    const owner = await http().post('/v1/setup/owner').set('X-Mellis-Setup-Code', SETUP_CODE).send({ first_name: 'Piotr' }).expect(201);
    const phone = newPhone();
    const paired = await http().post('/v1/pair').send(legacyPairBody(phone, owner.body.pairing.code, 'iPhone')).expect(201);
    const device = (await pool.query(`SELECT bolus_public_key, bolus_key_registered_at FROM devices WHERE id = $1::uuid`, [paired.body.device_id])).rows[0];
    expect(device.bolus_public_key).toBe(phone.bolus.publicKey);
    expect(device.bolus_key_registered_at).not.toBeNull();
  });

  it('registers the bolus key only when the device key and the new key both sign a fresh challenge', async () => {
    const { owner } = await setupServer();
    await http().post('/v1/me/devices/bolus-key/challenge').expect(401);
    // Signed by another phone's device key, or by a key other than the one registered: refused, challenge used up.
    expect((await registerBolusKey(owner, 403, { signer: new FakeDeviceKey() })).body.code).toBe('BOLUS_KEY_SIGNATURE_INVALID');
    expect((await registerBolusKey(owner, 403, { bolusSigner: new FakeDeviceKey() })).body.code).toBe('BOLUS_KEY_SIGNATURE_INVALID');
    const challenge = await http().post('/v1/me/devices/bolus-key/challenge').set(auth(owner)).expect(201);
    const message = bolusKeyMessage(owner.deviceId!, challenge.body.challenge_id, challenge.body.nonce, owner.device.publicKey);
    const sameAsDevice = await http().post('/v1/me/devices/bolus-key').set(auth(owner))
      .send({ challenge_id: challenge.body.challenge_id, bolus_public_key: owner.device.publicKey, signature: owner.device.sign(message), bolus_signature: owner.device.sign(message) }).expect(422);
    expect(sameAsDevice.body.code).toBe('PUBLIC_KEY_INVALID');
    expect((await pool.query(`SELECT bolus_public_key FROM devices WHERE id = $1::uuid`, [owner.deviceId])).rows[0].bolus_public_key).toBeNull();

    const registered = await registerBolusKey(owner, 200);
    expect(registered.body).toMatchObject({ device_id: owner.deviceId });
    expect((await pool.query(`SELECT bolus_public_key FROM devices WHERE id = $1::uuid`, [owner.deviceId])).rows[0].bolus_public_key).toBe(owner.bolus.publicKey);
    expect((await http().get('/v1/me/devices').set(auth(owner)).expect(200)).body.devices[0].has_bolus_key).toBe(true);
    // After a Face ID change the app makes a new bolus key and registers it again.
    owner.bolus = new FakeDeviceKey();
    await registerBolusKey(owner, 200);
    expect((await pool.query(`SELECT bolus_public_key FROM devices WHERE id = $1::uuid`, [owner.deviceId])).rows[0].bolus_public_key).toBe(owner.bolus.publicKey);
  });

  it('checks the AI keys during setup and returns the .env lines, naming a failing key', async () => {
    const { DeviceAuthService } = await import('../application/device-auth.service');
    const service = app.get(DeviceAuthService);
    service.aiFetch = async (_url, init) => ({ status: (init.headers['x-api-key'] ?? init.headers.Authorization ?? '').includes('good') ? 200 : 401 });
    try {
      await http().post('/v1/setup/ai').send({ provider: 'anthropic', api_key: 'good-claude' }).expect(401);
      const claude = await http().post('/v1/setup/ai').set('X-Mellis-Setup-Code', SETUP_CODE).send({ provider: 'anthropic', api_key: 'good-claude', openai_api_key: 'good-openai' }).expect(200);
      expect(claude.body).toMatchObject({ env: { AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'good-claude', OPENAI_API_KEY: 'good-openai' }, capabilities: { knowledge_search_mode: 'hybrid', server_voice_transcription: true } });
      const bad = await http().post('/v1/setup/ai').set('X-Mellis-Setup-Code', SETUP_CODE).send({ provider: 'anthropic', api_key: 'good-claude', openai_api_key: 'bad' }).expect(422);
      expect(bad.body).toMatchObject({ code: 'AI_KEY_INVALID', title: 'AI_KEY_INVALID: OPENAI_API_KEY' });
      // Keys are never stored or written to the audit trail.
      expect(JSON.stringify((await pool.query(`SELECT metadata FROM audit_events`)).rows)).not.toContain('good-claude');
    } finally {
      service.aiFetch = undefined;
    }
  });

  it('gives a session only for a signed, unused challenge of a paired device', async () => {
    const { owner } = await setupServer();
    await http().get('/v1/me/patients').expect(401);
    await http().get('/v1/me/patients').set('Authorization', 'Bearer mls_forged').expect(401);

    const challenge = await http().post('/v1/auth/challenge').send({ device_id: owner.deviceId }).expect(200);
    const wrongKey = { device_id: owner.deviceId, challenge_id: challenge.body.challenge_id, signature: owner.bolus.sign(sessionMessage(owner.deviceId!, challenge.body.challenge_id, challenge.body.nonce)) };
    expect((await http().post('/v1/auth/session').send(wrongKey).expect(401)).body.code).toBe('DEVICE_AUTH_FAILED');
    // The refused attempt used the challenge up.
    const again = await http().post('/v1/auth/challenge').send({ device_id: owner.deviceId }).expect(200);
    const body = { device_id: owner.deviceId, challenge_id: again.body.challenge_id, signature: owner.device.sign(sessionMessage(owner.deviceId!, again.body.challenge_id, again.body.nonce)) };
    const session = await http().post('/v1/auth/session').send(body).expect(200);
    expect(session.body.access_token).toMatch(/^mls_/);
    expect(Date.parse(session.body.expires_at) - Date.now()).toBeLessThanOrEqual(15 * 60_000);
    await http().post('/v1/auth/session').send(body).expect(401);
    await http().get('/v1/me/devices').set('Authorization', `Bearer ${session.body.access_token}`).expect(200);
    // Only the hash of the token is stored.
    expect((await pool.query(`SELECT count(*)::int AS n FROM device_sessions WHERE token_hash = $1`, [session.body.access_token])).rows[0].n).toBe(0);
    await http().post('/v1/auth/challenge').send({ device_id: '00000000-0000-4000-8000-000000000000' }).expect(401);
  });

  it('authorizes a remote command only with a fresh bolus-key signature naming the patient and the dose', async () => {
    const { patientId, owner, ownerId } = await setupServer();
    // No grant yet: no remote bolus challenge at all.
    expect((await http().post(`/v1/patients/${patientId}/signing-challenges`).set(auth(owner)).send({ purpose: 'REMOTE_BOLUS' }).expect(403)).body.code).toBe('REMOTE_BOLUS_NOT_PERMITTED');
    // The owner grants themself remote bolus and confirms it with the bolus key (Face ID on the phone).
    await http().put(`/v1/patients/${patientId}/people/${ownerId}`).set(auth(owner)).send({ permissions: { remote_commands: true } }).expect(200);
    expect((await http().get(`/v1/patients/${patientId}/capabilities`).set(auth(owner)).expect(200)).body.remote_commands.enabled).toBe(false);
    expect((await http().post(`/v1/patients/${patientId}/signing-challenges`).set(auth(owner)).send({ purpose: 'REMOTE_BOLUS' }).expect(403)).body.code).toBe('REMOTE_BOLUS_NOT_PERMITTED');
    // The app asks for the confirm challenge first, then registers the bolus key, then confirms (one Face ID signs both).
    const confirmation = await signed(owner, patientId, 'REMOTE_BOLUS_CONFIRM', { confirmation: 'Chcę podawać bolus zdalnie dla Janka' });
    const withoutKey = await http().post(`/v1/patients/${patientId}/remote-bolus/confirm`).set(auth(owner)).send({ device_authorization: confirmation }).expect(403);
    expect(withoutKey.body.code).toBe('BOLUS_KEY_REQUIRED');
    await registerBolusKey(owner, 200);
    const confirmed = await http().post(`/v1/patients/${patientId}/remote-bolus/confirm`).set(auth(owner)).send({ device_authorization: confirmation }).expect(200);
    expect(confirmed.body.member.remote_bolus.effective).toBe(true);
    expect((await http().get(`/v1/patients/${patientId}/capabilities`).set(auth(owner)).expect(200)).body.remote_commands.enabled).toBe(true);

    const command = { source: 'BOLUS_SCREEN', carbs_g: 30, insulin_u: 2.5, bolus_step: 0.05, device_id: 'iPhone Piotra-app-id', acknowledged_warnings: [] as string[] };
    const unsigned = await http().post(`/v1/patients/${patientId}/remote-commands`).set(auth(owner)).send(command).expect(403);
    expect(unsigned.body.code).toBe('REMOTE_COMMAND_SIGNATURE_REQUIRED');

    const text = 'Podać 2,5 j dla Janka?';
    for (const tampered of [
      { insulin_u: 5, carbs_g: 30, confirmation: text },
      { insulin_u: 2.5, carbs_g: 30, confirmation: text, patient_name: 'Ewa' },
    ]) {
      const envelope = await signed(owner, patientId, 'REMOTE_BOLUS', tampered);
      const refused = await http().post(`/v1/patients/${patientId}/remote-commands`).set(auth(owner)).send({ ...command, device_authorization: envelope }).expect(403);
      expect(refused.body.code).toBe('REMOTE_COMMAND_SIGNATURE_INVALID');
    }
    // Signed by the device key instead of the Face ID bound bolus key.
    const challenge = await http().post(`/v1/patients/${patientId}/signing-challenges`).set(auth(owner)).send({ purpose: 'REMOTE_BOLUS' }).expect(201);
    const wrongKey = owner.device.signPayload({ v: 1, type: 'remote_command', challenge_id: challenge.body.challenge_id, nonce: challenge.body.nonce, device_id: owner.deviceId, patient_id: patientId, patient_name: 'Janek', insulin_u: 2.5, carbs_g: 30, confirmation: text });
    await http().post(`/v1/patients/${patientId}/remote-commands`).set(auth(owner)).send({ ...command, device_authorization: wrongKey }).expect(403);

    // The confirmation lists the preview's warnings (no loop status, no ICR in this test's Nightscout); they are acknowledged.
    const preview = await http().get(`/v1/patients/${patientId}/remote-commands/preview?carbs_g=30&insulin_u=2.5`).set(auth(owner)).expect(200);
    command.acknowledged_warnings = (preview.body.warnings ?? []).map((warning: { key: string }) => warning.key);
    const envelope = await signed(owner, patientId, 'REMOTE_BOLUS', { insulin_u: 2.5, carbs_g: 30, confirmation: text });
    const accepted = await http().post(`/v1/patients/${patientId}/remote-commands`).set(auth(owner)).send({ ...command, device_authorization: envelope });
    expect(accepted.status, JSON.stringify(accepted.body)).toBeLessThan(300);
    const stored = (await pool.query(`SELECT device_authorization FROM remote_commands WHERE id = $1::uuid`, [accepted.body.command.id])).rows[0].device_authorization;
    expect(stored).toMatchObject({ device_id: owner.deviceId, confirmation: text, patient_name: 'Janek', insulin_u: 2.5, carbs_g: 30 });
    // The same signature cannot be sent twice.
    const replay = await http().post(`/v1/patients/${patientId}/remote-commands`).set(auth(owner)).send({ ...command, device_authorization: envelope }).expect(403);
    expect(replay.body.code).toBe('REMOTE_COMMAND_SIGNATURE_INVALID');
  });

  it('keeps a confirmed grant when remote bolus is switched on again, and needs a bolus key on every phone', async () => {
    const { patientId, owner, ownerId } = await setupServer();
    await http().put(`/v1/patients/${patientId}/people/${ownerId}`).set(auth(owner)).send({ permissions: { remote_commands: true } }).expect(200);
    await registerBolusKey(owner, 200);
    const confirmation = await signed(owner, patientId, 'REMOTE_BOLUS_CONFIRM', { confirmation: 'Chcę podawać bolus zdalnie dla Janka' });
    await http().post(`/v1/patients/${patientId}/remote-bolus/confirm`).set(auth(owner)).send({ device_authorization: confirmation }).expect(200);
    const before = (await pool.query(`SELECT remote_bolus_granted_at, remote_bolus_confirmed_at FROM caregiver_relationships WHERE patient_id = $1::uuid AND user_id = $2::uuid`, [patientId, ownerId])).rows[0];

    // A repeated "on" (another owner's phone, an older app) changes nothing: the grant and the confirmation stay.
    const again = await http().put(`/v1/patients/${patientId}/people/${ownerId}`).set(auth(owner)).send({ permissions: { remote_commands: true, glucose_alerts: true } }).expect(200);
    expect(again.body.member.remote_bolus).toMatchObject({ effective: true });
    const after = (await pool.query(`SELECT remote_bolus_granted_at, remote_bolus_confirmed_at FROM caregiver_relationships WHERE patient_id = $1::uuid AND user_id = $2::uuid`, [patientId, ownerId])).rows[0];
    expect(after).toEqual(before);
    await http().post(`/v1/patients/${patientId}/signing-challenges`).set(auth(owner)).send({ purpose: 'REMOTE_BOLUS' }).expect(201);

    // Another phone of the same person, paired without Face ID: the grant counts, but this phone has no bolus key.
    const code = await http().post('/v1/me/pairing-codes').set(auth(owner)).expect(201);
    const ipad = newPhone();
    const ipadPaired = await http().post('/v1/pair').send(pairBody(ipad, code.body.code, 'iPad')).expect(201);
    ipad.deviceId = ipadPaired.body.device_id;
    ipad.token = ipadPaired.body.session.access_token;
    expect((await http().post(`/v1/patients/${patientId}/signing-challenges`).set(auth(ipad)).send({ purpose: 'REMOTE_BOLUS' }).expect(403)).body.code).toBe('BOLUS_KEY_REQUIRED');
    const command = { source: 'BOLUS_SCREEN', carbs_g: 30, insulin_u: 2.5, bolus_step: 0.05, device_id: 'iPad-app-id', acknowledged_warnings: [] as string[] };
    const forged = ipad.bolus.signPayload({ v: 1, type: 'remote_command', challenge_id: '00000000-0000-4000-8000-000000000000', nonce: 'n', device_id: ipad.deviceId, patient_id: patientId, patient_name: 'Janek', insulin_u: 2.5, carbs_g: 30, confirmation: 'x' });
    const refused = await http().post(`/v1/patients/${patientId}/remote-commands`).set(auth(ipad)).send({ ...command, device_authorization: forged }).expect(403);
    expect(refused.body.code).toBe('BOLUS_KEY_REQUIRED');
    expect(Number((await pool.query(`SELECT count(*) FROM remote_commands`)).rows[0].count)).toBe(0);

    // Switched off, then on again: a new grant that waits for a new confirmation.
    await http().put(`/v1/patients/${patientId}/people/${ownerId}`).set(auth(owner)).send({ permissions: { remote_commands: false } }).expect(200);
    const regranted = await http().put(`/v1/patients/${patientId}/people/${ownerId}`).set(auth(owner)).send({ permissions: { remote_commands: true } }).expect(200);
    expect(regranted.body.member.remote_bolus).toMatchObject({ effective: false, confirmed_at: null });
    expect((await http().post(`/v1/patients/${patientId}/signing-challenges`).set(auth(owner)).send({ purpose: 'REMOTE_BOLUS' }).expect(403)).body.code).toBe('REMOTE_BOLUS_NOT_PERMITTED');
  });

  it('adds a patient with co-owners who own one of the caller\'s patients, never anyone else', async () => {
    const { patientId, owner, ownerId } = await setupServer();
    // Ania: a co-owner of Janek. Ewa: a helper (not an owner).
    const aniaInvite = await http().post(`/v1/patients/${patientId}/invitations`).set(auth(owner)).send({ first_name: 'Ania', permissions: { manage_sharing: true } }).expect(201);
    const ania = newPhone();
    const aniaPaired = await http().post('/v1/pair').send(pairBody(ania, aniaInvite.body.pairing.code, 'iPhone Ani')).expect(201);
    ania.token = aniaPaired.body.session.access_token;
    const aniaId = aniaPaired.body.user.user_id;
    const ewaInvite = await http().post(`/v1/patients/${patientId}/invitations`).set(auth(owner)).send({ first_name: 'Ewa', permissions: { glucose_alerts: true, ai_chat_meals: true } }).expect(201);
    const ewaPaired = await http().post('/v1/pair').send(pairBody(newPhone(), ewaInvite.body.pairing.code, 'iPhone Ewy')).expect(201);
    const ewaId = ewaPaired.body.user.user_id;

    const candidates = await http().get('/v1/me/co-owners').set(auth(owner)).expect(200);
    expect(candidates.body).toEqual({ people: [{ user_id: aniaId, display_name: 'Ania', patients: [{ patient_id: patientId, display_name: 'Janek' }] }] });
    expect((await http().get('/v1/me/co-owners').set('Authorization', `Bearer ${ewaPaired.body.session.access_token}`).expect(200)).body).toEqual({ people: [] });

    const body = { display_name: 'Zosia', birth_year: 2020, nightscout: { url: nsUrl('127.0.0.1'), token: 'reader-xyz' } };
    for (const wrong of [[ewaId], ['00000000-0000-4000-8000-000000000000'], [aniaId, ewaId]]) {
      const refused = await http().post('/v1/patients').set(auth(owner)).send({ ...body, co_owner_user_ids: wrong }).expect(422);
      expect(refused.body.code).toBe('CO_OWNER_NOT_ALLOWED');
    }
    await http().post('/v1/patients').set(auth(owner)).send({ ...body, co_owner_user_ids: 'nope' }).expect(422);
    expect(Number((await pool.query(`SELECT count(*) FROM patients`)).rows[0].count)).toBe(1);

    const created = await http().post('/v1/patients').set(auth(owner)).send({ ...body, co_owner_user_ids: [aniaId, ownerId, aniaId] }).expect(201);
    expect(created.body.co_owner_user_ids).toEqual([aniaId]);
    const zosia = created.body.patient.patient_id;
    // Remote control on for the new patient; Ania owns it with everything but remote bolus.
    expect((await pool.query(`SELECT remote_control FROM patients WHERE id = $1::uuid`, [zosia])).rows[0].remote_control).toEqual({ enabled: true });
    const people = await http().get(`/v1/patients/${zosia}/people`).set(auth(ania)).expect(200);
    expect(people.body.you_are_owner).toBe(true);
    const aniaRow = people.body.people.find((row: { user_id: string }) => row.user_id === aniaId);
    expect(aniaRow).toMatchObject({ is_owner: true, permissions: { glucose_alerts: true, ai_chat_meals: true, manage_sharing: true, remote_commands: false }, remote_bolus: { granted_at: null, effective: false } });
    expect(people.body.people.map((row: { user_id: string }) => row.user_id).sort()).toEqual([ownerId, aniaId].sort());
    expect((await http().get('/v1/me/patients').set(auth(ania)).expect(200)).body.patients.length).toBe(2);
  });

  it('invites a person by code with scopes, clears a grant when the AI goes off, and revokes their phone', async () => {
    const { patientId, owner } = await setupServer();
    const invited = await http().post(`/v1/patients/${patientId}/invitations`).set(auth(owner))
      .send({ first_name: 'Ewa', permissions: { glucose_alerts: true, ai_chat_meals: false } }).expect(201);
    expect(invited.body.invitation).toMatchObject({ first_name: 'Ewa', permissions: { glucose_alerts: true, ai_chat_meals: false, manage_sharing: false, remote_commands: false } });
    expect(invited.body.pairing.pairing_url).toContain('mellis://pair?server=');

    const ewa = newPhone();
    const paired = await http().post('/v1/pair').send(pairBody(ewa, invited.body.pairing.code, 'iPhone Ewy')).expect(201);
    ewa.deviceId = paired.body.device_id;
    ewa.token = paired.body.session.access_token;
    const ewaId = paired.body.user.user_id;
    expect(paired.body.user.display_name).toBe('Ewa');
    expect(paired.body.patients.map((row: { patient_id: string }) => row.patient_id)).toEqual([patientId]);
    expect((await http().post('/v1/pair').send(pairBody(newPhone(), invited.body.pairing.code, 'x')).expect(401)).body.code).toBe('PAIRING_CODE_INVALID');

    // Glucose only: the dashboard yes, chats, people and remote commands no.
    await http().get(`/v1/patients/${patientId}/dashboard`).set(auth(ewa)).expect(200);
    expect((await http().get(`/v1/patients/${patientId}/conversations`).set(auth(ewa)).expect(403)).body.code).toBe('PERMISSION_DENIED');
    await http().post(`/v1/patients/${patientId}/signing-challenges`).set(auth(ewa)).send({ purpose: 'REMOTE_BOLUS' }).expect(403);
    await http().post(`/v1/patients/${patientId}/invitations`).set(auth(ewa)).send({ first_name: 'X', permissions: { glucose_alerts: true } }).expect(403);

    // The owner gives the AI and remote bolus; it waits for Ewa's own signed confirmation; AI off clears it (audit #6).
    await http().put(`/v1/patients/${patientId}/people/${ewaId}`).set(auth(owner)).send({ permissions: { ai_chat_meals: true, remote_commands: true } }).expect(200);
    let people = await http().get(`/v1/patients/${patientId}/people`).set(auth(owner)).expect(200);
    let ewaRow = people.body.people.find((row: { user_id: string }) => row.user_id === ewaId);
    expect(ewaRow.remote_bolus).toMatchObject({ effective: false, confirmed_at: null });
    expect(ewaRow.remote_bolus.granted_at).not.toBeNull();
    expect(ewaRow.devices.map((device: { name: string }) => device.name)).toEqual(['iPhone Ewy']);
    await http().put(`/v1/patients/${patientId}/people/${ewaId}`).set(auth(owner)).send({ permissions: { ai_chat_meals: false } }).expect(200);
    people = await http().get(`/v1/patients/${patientId}/people`).set(auth(owner)).expect(200);
    ewaRow = people.body.people.find((row: { user_id: string }) => row.user_id === ewaId);
    expect(ewaRow.remote_bolus).toMatchObject({ granted_at: null, effective: false });

    // Ewa cannot change her own permissions; the owner revokes her phone: its session ends at once.
    await http().put(`/v1/patients/${patientId}/people/${ewaId}`).set(auth(ewa)).send({ permissions: { manage_sharing: true } }).expect(403);
    await http().delete(`/v1/patients/${patientId}/people/${ewaId}/devices/${ewa.deviceId}`).set(auth(owner)).expect(204);
    await http().get(`/v1/me/patients`).set(auth(ewa)).expect(401);
    await http().post('/v1/auth/challenge').send({ device_id: ewa.deviceId }).expect(401);

    // An open invitation can be withdrawn.
    const second = await http().post(`/v1/patients/${patientId}/invitations`).set(auth(owner)).send({ first_name: 'Babcia', permissions: { glucose_alerts: true } }).expect(201);
    await http().delete(`/v1/patients/${patientId}/invitations/${second.body.invitation.invitation_id}`).set(auth(owner)).expect(204);
    expect((await http().post('/v1/pair').send(pairBody(newPhone(), second.body.pairing.code, 'x')).expect(401)).body.code).toBe('PAIRING_CODE_INVALID');
  });

  it('adds a second patient from the owner phone and lets a paired person join it by code', async () => {
    const { patientId, owner } = await setupServer();
    expect((await http().post('/v1/patients').set(auth(owner))
      .send({ display_name: 'Zosia', birth_year: 2020, nightscout: { url: nsUrl(), token: 'reader-abc' } }).expect(409)).body.code).toBe('NIGHTSCOUT_ALREADY_USED');
    const second = await http().post('/v1/patients').set(auth(owner))
      .send({ display_name: 'Zosia', birth_year: 2020, nightscout: { url: nsUrl('127.0.0.1'), token: 'reader-xyz' } }).expect(201);
    const zosia = second.body.patient.patient_id;
    const mine = await http().get('/v1/me/patients').set(auth(owner)).expect(200);
    expect(mine.body.patients.map((row: { display_name: string }) => row.display_name).sort()).toEqual(['Janek', 'Zosia']);

    const invite = await http().post(`/v1/patients/${patientId}/invitations`).set(auth(owner)).send({ first_name: 'Ewa', permissions: { glucose_alerts: true, ai_chat_meals: true } }).expect(201);
    const ewa = newPhone();
    const paired = await http().post('/v1/pair').send(pairBody(ewa, invite.body.pairing.code, 'iPhone Ewy')).expect(201);
    ewa.token = paired.body.session.access_token;
    await http().post('/v1/patients').set(auth(ewa)).send({ display_name: 'X', birth_year: 2020, nightscout: { url: nsUrl(), token: 'reader-abc' } }).expect(403);

    const zosiaInvite = await http().post(`/v1/patients/${zosia}/invitations`).set(auth(owner)).send({ first_name: 'Ewa', permissions: { glucose_alerts: true } }).expect(201);
    const joined = await http().post('/v1/me/invitations/accept').set(auth(ewa)).send({ code: zosiaInvite.body.pairing.code }).expect(200);
    expect(joined.body.patient_id).toBe(zosia);
    expect((await http().get('/v1/me/patients').set(auth(ewa)).expect(200)).body.patients.length).toBe(2);

    // Another phone of the same person; a lost one is revoked from the list.
    const code = await http().post('/v1/me/pairing-codes').set(auth(owner)).expect(201);
    const ipad = newPhone();
    const ipadPaired = await http().post('/v1/pair').send(pairBody(ipad, code.body.code, 'iPad')).expect(201);
    expect(ipadPaired.body.user.display_name).toBe('Piotr');
    const devices = await http().get('/v1/me/devices').set(auth(owner)).expect(200);
    expect(devices.body.devices.map((device: { name: string; this_device: boolean }) => [device.name, device.this_device])).toEqual([['iPhone Piotra', true], ['iPad', false]]);
    await http().delete(`/v1/me/devices/${ipadPaired.body.device_id}`).set(auth(owner)).expect(204);
    await http().get('/v1/me/devices').set('Authorization', `Bearer ${ipadPaired.body.session.access_token}`).expect(401);
  });

  it('recovers the owner with the recovery code (rotated) and with reset-owner on the server', async () => {
    const { owner, recoveryCode, ownerId } = await setupServer();
    await http().post('/v1/setup/recover').send(pairBody(newPhone(), 'AAAAA-AAAAA-AAAAA-AAAAA-AAAAA', 'x', { recovery_code: 'AAAAA-AAAAA-AAAAA-AAAAA-AAAAA' })).expect(401);
    const phone = newPhone();
    const recovered = await http().post('/v1/setup/recover').send(pairBody(phone, recoveryCode, 'Nowy iPhone', { recovery_code: recoveryCode })).expect(201);
    expect(recovered.body.user.user_id).toBe(ownerId);
    expect(recovered.body.recovery_code).not.toBe(recoveryCode);
    await http().post('/v1/setup/recover').send(pairBody(newPhone(), recoveryCode, 'x', { recovery_code: recoveryCode })).expect(401);
    // The old phone still works until someone revokes it.
    await http().get('/v1/me/devices').set(auth(owner)).expect(200);

    const { main } = await import('../cli/mellis-admin');
    const lines: string[] = [];
    expect(await main(['reset-owner'], { ...process.env }, (line) => lines.push(line))).toBe(0);
    const reset = JSON.parse(lines[0]);
    expect(reset).toMatchObject({ user_id: ownerId, display_name: 'Piotr' });
    expect(reset.pairing_url).toContain(encodeURIComponent('https://mellis.example'));
    const viaShell = await http().post('/v1/pair').send(pairBody(newPhone(), reset.code, 'iPhone po resecie')).expect(201);
    expect(viaShell.body.user.user_id).toBe(ownerId);

    expect(await main(['reset-owner', '--name', 'Ania'], { ...process.env }, (line) => lines.push(line))).toBe(0);
    const ania = JSON.parse(lines[1]);
    expect(ania.display_name).toBe('Ania');
    expect(ania.user_id).not.toBe(ownerId);
    expect(await main(['setup-status'], { ...process.env }, (line) => lines.push(line))).toBe(0);
    expect(JSON.parse(lines[2])).toMatchObject({ auth_mode: 'device', setup: 'COMPLETED', patients: 1, owners: 2 });
  });

  describe('remote settings hand-off (step 2)', () => {
    /** Not a real ECIES message (the server cannot read one anyway): the shape it checks, 0x04 ‖ 65+ bytes. */
    const fakeCiphertext = () => Buffer.concat([Buffer.from([0x04]), randomBytes(160)]).toString('base64');

    async function invitePhone(patientId: string, owner: Phone, name: string, permissions: Record<string, boolean>) {
      const invite = await http().post(`/v1/patients/${patientId}/invitations`).set(auth(owner)).send({ first_name: name, permissions }).expect(201);
      const phone = newPhone();
      const paired = await http().post('/v1/pair').send(pairBody(phone, invite.body.pairing.code, `iPhone ${name}`)).expect(201);
      phone.deviceId = paired.body.device_id;
      phone.token = paired.body.session.access_token;
      return { phone, userId: paired.body.user.user_id as string };
    }

    async function anotherPhone(phone: Phone, name: string): Promise<Phone> {
      const code = await http().post('/v1/me/pairing-codes').set(auth(phone)).expect(201);
      const second = newPhone();
      const paired = await http().post('/v1/pair').send(pairBody(second, code.body.code, name)).expect(201);
      second.deviceId = paired.body.device_id;
      second.token = paired.body.session.access_token;
      return second;
    }

    function handoffPackage(sender: Phone, patientId: string, toDeviceId: string, recipientKey: 'bolus' | 'device', loopKind: 'trio' | 'loop' = 'trio', signer?: FakeDeviceKey) {
      const ciphertext = fakeCiphertext();
      const message = remoteSettingsHandoffMessage({ patientId, fromDeviceId: sender.deviceId!, toDeviceId, loopKind, recipientKey, ciphertext });
      return { to_device_id: toDeviceId, recipient_key: recipientKey, ciphertext, sender_signature: (signer ?? sender.device).sign(message) };
    }

    it('lets only an owner send, only to a person with a grant, encrypted to the key each phone has now', async () => {
      const { patientId, owner, ownerId } = await setupServer();
      const { phone: ania, userId: aniaId } = await invitePhone(patientId, owner, 'Ania', { glucose_alerts: true, ai_chat_meals: true });

      // No grant yet: nothing to hand over.
      expect((await http().get(`/v1/patients/${patientId}/people/${aniaId}/handoff-devices`).set(auth(owner)).expect(409)).body.code).toBe('REMOTE_BOLUS_NOT_GRANTED');
      await http().put(`/v1/patients/${patientId}/people/${aniaId}`).set(auth(owner)).send({ permissions: { remote_commands: true } }).expect(200);

      // Waiting for Ania's confirmation, no bolus key yet: the package goes to her device key.
      const devices = await http().get(`/v1/patients/${patientId}/people/${aniaId}/handoff-devices`).set(auth(owner)).expect(200);
      expect(devices.body).toMatchObject({ patient_id: patientId, user_id: aniaId, display_name: 'Ania' });
      expect(devices.body.devices).toEqual([{ device_id: ania.deviceId, name: 'iPhone Ania', recipient_key: 'device', encryption_public_key: ania.device.publicKey }]);
      // Ania is not an owner: she cannot read the keys, nor send.
      expect((await http().get(`/v1/patients/${patientId}/people/${ownerId}/handoff-devices`).set(auth(ania)).expect(403)).body.code).toBe('NOT_AN_OWNER');
      const fromAnia = await http().post(`/v1/patients/${patientId}/remote-settings-handoffs`).set(auth(ania))
        .send({ to_user_id: ownerId, loop_kind: 'trio', packages: [handoffPackage(ania, patientId, owner.deviceId!, 'device')] }).expect(403);
      expect(fromAnia.body.code).toBe('NOT_AN_OWNER');

      const send = (packages: unknown[], toUserId = aniaId) => http().post(`/v1/patients/${patientId}/remote-settings-handoffs`).set(auth(owner)).send({ to_user_id: toUserId, loop_kind: 'trio', packages });
      // Signed by another key, or the signature of another device's package: refused, nothing stored.
      expect((await send([handoffPackage(owner, patientId, ania.deviceId!, 'device', 'trio', new FakeDeviceKey())]).expect(403)).body.code).toBe('HANDOFF_SIGNATURE_INVALID');
      const moved = handoffPackage(owner, patientId, ania.deviceId!, 'device');
      expect((await send([{ ...moved, recipient_key: 'bolus' }]).expect(403)).body.code).toBe('HANDOFF_SIGNATURE_INVALID');
      expect((await send([{ ...moved, ciphertext: Buffer.from('plain text settings, not encrypted at all, long enough to pass the size check of the server').toString('base64') }]).expect(422)).body.code).toBe('HANDOFF_PAYLOAD_INVALID');
      // Encrypted to a bolus key Ania's phone does not have: the owner's phone must read the keys again.
      expect((await send([handoffPackage(owner, patientId, ania.deviceId!, 'bolus')]).expect(409)).body.code).toBe('HANDOFF_KEY_CHANGED');
      // Not Ania's phone, and not to oneself.
      await send([handoffPackage(owner, patientId, owner.deviceId!, 'device')]).expect(422);
      await send([handoffPackage(owner, patientId, ania.deviceId!, 'device')], ownerId).expect(422);
      const { phone: ewa, userId: ewaId } = await invitePhone(patientId, owner, 'Ewa', { glucose_alerts: true, ai_chat_meals: true, remote_commands: true });
      expect((await send([handoffPackage(owner, patientId, ewa.deviceId!, 'device')]).expect(404)).body.code).toBe('DEVICE_NOT_FOUND');
      expect((await send([handoffPackage(owner, patientId, ania.deviceId!, 'device')], ewaId).expect(404)).body.code).toBe('DEVICE_NOT_FOUND');
      expect(Number((await pool.query(`SELECT count(*) FROM remote_settings_handoffs`)).rows[0].count)).toBe(0);

      const created = await send([moved]).expect(201);
      expect(created.body.handoffs).toEqual([expect.objectContaining({ to_device_id: ania.deviceId, recipient_key: 'device' })]);
      const stored = (await pool.query(`SELECT ciphertext, sender_signature, loop_kind, consumed_at, expires_at - created_at AS ttl FROM remote_settings_handoffs`)).rows[0];
      expect((stored.ciphertext as Buffer).toString('base64')).toBe(moved.ciphertext);
      expect(stored).toMatchObject({ sender_signature: moved.sender_signature, loop_kind: 'trio', consumed_at: null });
      expect(stored.ttl.days).toBe(7);

      // After Ania confirms remote bolus (bolus key registered), new packages go to the bolus key.
      await registerBolusKey(ania, 200);
      const after = await http().get(`/v1/patients/${patientId}/people/${aniaId}/handoff-devices`).set(auth(owner)).expect(200);
      expect(after.body.devices[0]).toMatchObject({ recipient_key: 'bolus', encryption_public_key: ania.bolus.publicKey });
      // The package already sent to her device key still waits (that key still works).
      expect((await http().get('/v1/me/remote-settings-handoffs').set(auth(ania)).expect(200)).body.handoffs).toHaveLength(1);
    });

    it('delivers a package once, only to its phone, until it expires; the recipient can refuse it and the owner withdraw it', async () => {
      const { patientId, owner, ownerId } = await setupServer();
      const { phone: ania, userId: aniaId } = await invitePhone(patientId, owner, 'Ania', { glucose_alerts: true, ai_chat_meals: true, remote_commands: true });
      const aniaSecond = await anotherPhone(ania, 'iPad Ani');
      const send = (packages: unknown[]) => http().post(`/v1/patients/${patientId}/remote-settings-handoffs`).set(auth(owner)).send({ to_user_id: aniaId, loop_kind: 'loop', packages }).expect(201);
      const first = handoffPackage(owner, patientId, ania.deviceId!, 'device', 'loop');
      const second = handoffPackage(owner, patientId, aniaSecond.deviceId!, 'device', 'loop');
      const created = (await send([first, second])).body.handoffs as Array<{ handoff_id: string; to_device_id: string }>;
      const forFirst = created.find((row) => row.to_device_id === ania.deviceId)!.handoff_id;
      const forSecond = created.find((row) => row.to_device_id === aniaSecond.deviceId)!.handoff_id;

      const listed = await http().get('/v1/me/remote-settings-handoffs').set(auth(ania)).expect(200);
      expect(listed.body.handoffs).toEqual([expect.objectContaining({
        handoff_id: forFirst, patient_id: patientId, patient_name: 'Janek', from_user_id: ownerId, from_name: 'Piotr',
        from_device_id: owner.deviceId, from_device_public_key: owner.device.publicKey, to_device_id: ania.deviceId, loop_kind: 'loop', recipient_key: 'device',
      })]);
      expect(listed.body.handoffs[0].ciphertext).toBeUndefined();
      expect((await http().get('/v1/me/remote-settings-handoffs').set(auth(owner)).expect(200)).body.handoffs).toEqual([]);

      // Another phone, even the same person's, cannot fetch it; the owner cannot either.
      await http().post(`/v1/me/remote-settings-handoffs/${forFirst}/consume`).set(auth(aniaSecond)).expect(404);
      await http().post(`/v1/me/remote-settings-handoffs/${forFirst}/consume`).set(auth(owner)).expect(404);
      const fetched = await http().post(`/v1/me/remote-settings-handoffs/${forFirst}/consume`).set(auth(ania)).expect(200);
      expect(fetched.body).toMatchObject({ handoff_id: forFirst, ciphertext: first.ciphertext, sender_signature: first.sender_signature, from_device_public_key: owner.device.publicKey });
      // Single use: gone from the server (only a receipt without ciphertext stays for the owner).
      await http().post(`/v1/me/remote-settings-handoffs/${forFirst}/consume`).set(auth(ania)).expect(404);
      expect((await http().get('/v1/me/remote-settings-handoffs').set(auth(ania)).expect(200)).body.handoffs).toEqual([]);
      const receipt = (await pool.query(`SELECT ciphertext, sender_signature, consumed_at FROM remote_settings_handoffs WHERE id = $1::uuid`, [forFirst])).rows[0];
      expect(receipt.ciphertext).toBeNull();
      expect(receipt.sender_signature).toBeNull();
      expect(receipt.consumed_at).not.toBeNull();
      const sent = await http().get(`/v1/patients/${patientId}/remote-settings-handoffs`).set(auth(owner)).expect(200);
      expect(sent.body.handoffs.map((row: { handoff_id: string; consumed_at: string | null }) => [row.handoff_id, row.consumed_at !== null]).sort()).toEqual([[forFirst, true], [forSecond, false]].sort());
      await http().get(`/v1/patients/${patientId}/remote-settings-handoffs`).set(auth(ania)).expect(403);

      // "Odrzuć" on the second phone deletes its package.
      await http().delete(`/v1/me/remote-settings-handoffs/${forSecond}`).set(auth(ania)).expect(404);
      await http().delete(`/v1/me/remote-settings-handoffs/${forSecond}`).set(auth(aniaSecond)).expect(204);
      await http().post(`/v1/me/remote-settings-handoffs/${forSecond}/consume`).set(auth(aniaSecond)).expect(404);

      // A newer package replaces an unfetched one; the owner can withdraw it.
      const older = (await send([handoffPackage(owner, patientId, aniaSecond.deviceId!, 'device', 'loop')])).body.handoffs[0].handoff_id;
      const newer = (await send([handoffPackage(owner, patientId, aniaSecond.deviceId!, 'device', 'loop')])).body.handoffs[0].handoff_id;
      expect((await http().get('/v1/me/remote-settings-handoffs').set(auth(aniaSecond)).expect(200)).body.handoffs.map((row: { handoff_id: string }) => row.handoff_id)).toEqual([newer]);
      await http().post(`/v1/me/remote-settings-handoffs/${older}/consume`).set(auth(aniaSecond)).expect(404);
      await http().delete(`/v1/patients/${patientId}/remote-settings-handoffs/${newer}`).set(auth(ania)).expect(403);
      await http().delete(`/v1/patients/${patientId}/remote-settings-handoffs/${newer}`).set(auth(owner)).expect(204);
      await http().post(`/v1/me/remote-settings-handoffs/${newer}/consume`).set(auth(aniaSecond)).expect(404);

      // Expired after 7 days: not listed, not fetched, deleted.
      const expiring = (await send([handoffPackage(owner, patientId, ania.deviceId!, 'device', 'loop')])).body.handoffs[0].handoff_id;
      await pool.query(`UPDATE remote_settings_handoffs SET expires_at = now() - interval '1 second', created_at = now() - interval '7 days' WHERE id = $1::uuid`, [expiring]);
      expect((await http().get('/v1/me/remote-settings-handoffs').set(auth(ania)).expect(200)).body.handoffs).toEqual([]);
      await http().post(`/v1/me/remote-settings-handoffs/${expiring}/consume`).set(auth(ania)).expect(404);
      expect(Number((await pool.query(`SELECT count(*) FROM remote_settings_handoffs WHERE id = $1::uuid`, [expiring])).rows[0].count)).toBe(0);

      // The grant taken away: a waiting package is no longer delivered; a revoked phone gets nothing either.
      const waiting = (await send([handoffPackage(owner, patientId, ania.deviceId!, 'device', 'loop')])).body.handoffs[0].handoff_id;
      await http().put(`/v1/patients/${patientId}/people/${aniaId}`).set(auth(owner)).send({ permissions: { remote_commands: false } }).expect(200);
      expect((await http().get('/v1/me/remote-settings-handoffs').set(auth(ania)).expect(200)).body.handoffs).toEqual([]);
      await http().post(`/v1/me/remote-settings-handoffs/${waiting}/consume`).set(auth(ania)).expect(404);
      // Granted again: the package from before is still not delivered (only one sent under the new grant).
      await http().put(`/v1/patients/${patientId}/people/${aniaId}`).set(auth(owner)).send({ permissions: { remote_commands: true } }).expect(200);
      expect((await http().get('/v1/me/remote-settings-handoffs').set(auth(ania)).expect(200)).body.handoffs).toEqual([]);
      const fresh = (await send([handoffPackage(owner, patientId, ania.deviceId!, 'device', 'loop')])).body.handoffs[0].handoff_id;
      expect((await http().get('/v1/me/remote-settings-handoffs').set(auth(ania)).expect(200)).body.handoffs.map((row: { handoff_id: string }) => row.handoff_id)).toEqual([fresh]);
      // The owner's phone revoked: nothing it sent is delivered.
      await http().delete(`/v1/me/devices/${owner.deviceId}`).set(auth(owner)).expect(204);
      expect((await http().get('/v1/me/remote-settings-handoffs').set(auth(ania)).expect(200)).body.handoffs).toEqual([]);
    });
  });

  it('answers 404 for every device route in another auth mode (Cognito untouched)', async () => {
    process.env.AUTH_MODE = 'cognito';
    try {
      await http().get('/v1/setup').expect(404);
      await http().post('/v1/pair').send({}).expect(404);
      await http().post('/v1/auth/challenge').send({}).expect(404);
    } finally {
      process.env.AUTH_MODE = 'device';
    }
  });
});
