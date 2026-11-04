import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { WatchService } from '../application/watch.service';
import { ApiService } from '../application/api.service';
import { BearerPrincipalGuard } from '../auth/bearer-principal.guard';
import { MeController } from './me.controller';
import { MeWatchController, WatchController } from './watch.controller';
import { sha256Hex } from '@modules/watch/domain/watch-glance';

const USER = '55555555-5555-4555-8555-555555555555';
const OTHER_USER = '66666666-6666-4666-8666-666666666666';
const PATIENT_A = '11111111-1111-4111-8111-111111111111';
const PATIENT_B = '22222222-2222-4222-8222-222222222222';
const PATIENT_C = '33333333-3333-4333-8333-333333333333';

interface DeviceRow { id: string; user_id: string; device: string | null; patient_ids: string[]; token_hash: string; revoked_at: Date | null; created_at: Date; last_used_at: Date | null }

/** PostgresWatchDeviceRepository in memory (the SQL itself is covered by the postgres spec). */
class FakeWatchDeviceRepository {
  devices: DeviceRow[] = [];
  touches = 0;
  constructor(public access: Record<string, Record<string, string>>) {}

  async createWatchDevice(args: { userId: string; device: string | null; patientIds: string[]; tokenHash: string; now: Date }) {
    for (const old of this.devices.filter((d) => d.user_id === args.userId && d.device === args.device && !d.revoked_at)) old.revoked_at = args.now;
    const device: DeviceRow = {
      id: `0000000${this.devices.length + 1}-0000-4000-8000-000000000000`, user_id: args.userId, device: args.device, patient_ids: args.patientIds,
      token_hash: args.tokenHash, revoked_at: null, created_at: args.now, last_used_at: null,
    };
    this.devices.push(device);
    return device;
  }

  async findActiveDeviceByTokenHash(hash: string) {
    return this.devices.find((d) => d.token_hash === hash && d.revoked_at === null) ?? null;
  }

  async touchDevice(id: string, now: Date) {
    const device = this.devices.find((d) => d.id === id)!;
    if (!device.last_used_at || now.getTime() - device.last_used_at.getTime() >= 60_000) {
      device.last_used_at = now;
      this.touches += 1;
    }
  }

  async revokeDevice(id: string, userId: string, now: Date) {
    const device = this.devices.find((d) => d.id === id && d.user_id === userId && d.revoked_at === null);
    if (!device) return false;
    device.revoked_at = now;
    return true;
  }

  async readablePatients(userId: string, ids: string[]) {
    const mine = this.access[userId] ?? {};
    // Reversed on purpose: the service must restore the chosen order.
    return ids.filter((id) => mine[id]).map((id) => ({ id, name: mine[id] })).reverse();
  }
}

describe('Apple Watch devices and glance (HTTP)', () => {
  let app: INestApplication;
  let service: WatchService;
  let repo: FakeWatchDeviceRepository;
  const widgetPush = { upsert: vi.fn(async () => ({})) };
  const glucoMind = {
    listAccessiblePatients: vi.fn(async (_userId: string) => [
      { patient_id: PATIENT_A, display_name: 'Ania', birth_year: null },
      { patient_id: PATIENT_B, display_name: 'Zosia', birth_year: null },
      { patient_id: PATIENT_C, display_name: 'Ziemowit', birth_year: null },
    ]),
  };
  const dashboard = vi.fn(async (patientId: string) => {
    if (patientId === PATIENT_B) return { glucose: null, loop: null };
    return {
      glucose: { value: 112, unit: 'mg/dL' as const, direction: 'FortyFiveUp', observed_at: '2026-11-03T09:58:00.000Z', delta: 4 },
      loop: { iob_units: 1.4, cob_grams: 18, observed_at: '2026-11-03T09:58:00.000Z' },
    };
  });
  const auth = { authenticateBearerToken: vi.fn(async () => ({ userId: USER, providerSubject: 'sub-1' })) };
  const apiService = { listAccessiblePatients: vi.fn(async () => ({ user_id: USER, user_display_name: null, patients: [] })) };

  beforeAll(async () => {
    vi.stubEnv('AUTH_MODE', 'cognito');
    service = new WatchService(glucoMind as any, {} as any);
    const moduleRef = await Test.createTestingModule({
      controllers: [MeWatchController, WatchController, MeController],
      providers: [{ provide: WatchService, useValue: service }, { provide: ApiService, useValue: apiService }],
    })
      .overrideGuard(BearerPrincipalGuard)
      .useValue(new BearerPrincipalGuard(auth as any))
      .compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.init();
  });

  beforeEach(() => {
    repo = new FakeWatchDeviceRepository({
      [USER]: { [PATIENT_A]: 'Ania', [PATIENT_B]: 'Zosia', [PATIENT_C]: 'Ziemowit' },
      [OTHER_USER]: { [PATIENT_C]: 'Ziemowit' },
    });
    (service as any).devices = repo;
    (service as any).widgetPush = widgetPush;
    widgetPush.upsert.mockClear();
    (service as any).dashboard = dashboard;
    auth.authenticateBearerToken.mockClear();
    dashboard.mockClear();
  });

  afterAll(async () => {
    await app.close();
    vi.unstubAllEnvs();
  });

  const server = () => app.getHttpServer();
  const createWatch = (body: Record<string, unknown> = {}, bearer = 'valid.jwt') =>
    request(server()).post('/v1/me/watch-devices').set('Authorization', `Bearer ${bearer}`).send({ device: 'Apple Watch', ...body });
  const glance = (token: string) => request(server()).get('/v1/watch/glance').set('Authorization', `Bearer ${token}`);
  const pushBody = (overrides: Record<string, unknown> = {}) => ({ token: 'AB'.repeat(32), topic: 'pl.mellis.TEAM.watchkitapp', environment: 'sandbox', platform: 'watchos', ...overrides });
  const putPush = (token: string, body: Record<string, unknown> = pushBody()) =>
    request(server()).put('/v1/watch/widget-push-token').set('Authorization', `Bearer ${token}`).send(body);

  it('creates a device with a watch token for the caregiver\'s first patients (up to 4) and reads the glance with ids', async () => {
    const created = await createWatch();
    expect(created.status).toBe(201);
    expect(created.body).toEqual({
      token: expect.stringMatching(/^gmw_[A-Za-z0-9_-]{43}$/),
      device: { id: repo.devices[0].id, device: 'Apple Watch', patient_ids: [PATIENT_A, PATIENT_B, PATIENT_C], created_at: expect.any(String), last_used_at: null },
      patients: [{ id: PATIENT_A, name: 'Ania' }, { id: PATIENT_B, name: 'Zosia' }, { id: PATIENT_C, name: 'Ziemowit' }],
    });
    expect(repo.devices[0].token_hash).toBe(sha256Hex(created.body.token));
    const read = await glance(created.body.token);
    expect(read.status).toBe(200);
    expect(read.body.p.map((p: { id: string }) => p.id)).toEqual([PATIENT_A, PATIENT_B, PATIENT_C]);
  });

  it('refuses a bad body and patients of someone else', async () => {
    expect((await createWatch({ device: 7 })).status).toBe(422);
    expect((await createWatch({ patient_ids: [PATIENT_A, PATIENT_B, PATIENT_C, PATIENT_A.replace('1111-4111', '4444-4444'), '77777777-7777-4777-8777-777777777777'] })).status).toBe(422);
    repo.access[USER] = { [PATIENT_A]: 'Ania' };
    expect((await createWatch({ patient_ids: [PATIENT_A, PATIENT_B] })).status).toBe(403);
    expect(repo.devices).toEqual([]);
    const chosen = await createWatch({ patient_ids: [PATIENT_A] });
    expect(chosen.status).toBe(201);
    expect(chosen.body.patients).toEqual([{ id: PATIENT_A, name: 'Ania' }]);
  });

  it('GET /v1/watch/glance answers the compact glance in the chosen order', async () => {
    const { body: { token } } = await createWatch({ patient_ids: [PATIENT_A, PATIENT_B] });
    const response = await glance(token);
    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(typeof response.body.now).toBe('number');
    expect(response.body.p).toEqual([
      { id: PATIENT_A, n: 'Ania', v: 112, dir: 'FortyFiveUp', dl: 4, at: Math.floor(Date.parse('2026-11-03T09:58:00.000Z') / 1000), iob: 1.4, cob: 18 },
      { id: PATIENT_B, n: 'Zosia', v: null, dir: null, dl: null, at: null, iob: null, cob: null },
    ]);
    expect(repo.touches).toBe(1);
    await glance(token);
    expect(repo.touches).toBe(1);
  });

  it('a patient whose dashboard fails still gets an entry with nulls', async () => {
    const { body: { token } } = await createWatch({ patient_ids: [PATIENT_A, PATIENT_B] });
    dashboard.mockRejectedValueOnce(new Error('db down'));
    const response = await glance(token);
    expect(response.status).toBe(200);
    expect(response.body.p).toHaveLength(2);
  });

  it('drops patients the caregiver lost access to since', async () => {
    const { body: { token } } = await createWatch({ patient_ids: [PATIENT_A, PATIENT_B] });
    delete repo.access[USER][PATIENT_A];
    const response = await glance(token);
    expect(response.status).toBe(200);
    expect(response.body.p.map((p: { n: string }) => p.n)).toEqual(['Zosia']);
    expect(dashboard).not.toHaveBeenCalledWith(PATIENT_A, expect.anything());
  });

  it('answers 401 without a token, for an unknown token and a user token', async () => {
    expect((await request(server()).get('/v1/watch/glance')).status).toBe(401);
    expect((await glance(`gmw_${'a'.repeat(43)}`)).status).toBe(401);
    expect((await glance('valid.jwt')).status).toBe(401);
  });

  it('a new device with the same label replaces the old one; DELETE /v1/me/watch-devices/:id revokes', async () => {
    const first = await createWatch();
    const second = await createWatch();
    expect((await glance(first.body.token)).status).toBe(401);
    expect((await glance(second.body.token)).status).toBe(200);
    const revoked = await request(server()).delete(`/v1/me/watch-devices/${second.body.device.id}`).set('Authorization', 'Bearer valid.jwt');
    expect(revoked.status).toBe(204);
    const after = await glance(second.body.token);
    expect(after.status).toBe(401);
    expect(after.body.code).toBe('UNAUTHENTICATED');
    expect((await request(server()).delete(`/v1/me/watch-devices/${second.body.device.id}`).set('Authorization', 'Bearer valid.jwt')).status).toBe(404);
  });

  it('revokes only the caller\'s own device (404 otherwise)', async () => {
    await createWatch();
    repo.devices[0].user_id = OTHER_USER;
    expect((await request(server()).delete(`/v1/me/watch-devices/${repo.devices[0].id}`).set('Authorization', 'Bearer valid.jwt')).status).toBe(404);
    expect((await request(server()).delete('/v1/me/watch-devices/not-a-uuid').set('Authorization', 'Bearer valid.jwt')).status).toBe(404);
    expect(repo.devices[0].revoked_at).toBeNull();
  });

  it('a watch token is never accepted as a user token on other routes', async () => {
    const { body: { token } } = await createWatch();
    auth.authenticateBearerToken.mockClear();
    expect((await request(server()).get('/v1/me/patients').set('Authorization', `Bearer ${token}`)).status).toBe(401);
    expect((await createWatch({}, token)).status).toBe(401);
    expect(auth.authenticateBearerToken).not.toHaveBeenCalled();
    expect(apiService.listAccessiblePatients).not.toHaveBeenCalled();
  });

  it('PUT /v1/watch/widget-push-token stores the token for the watch device\'s readable patients', async () => {
    const created = await createWatch({ patient_ids: [PATIENT_B, PATIENT_A] });
    delete repo.access[USER][PATIENT_B];
    const response = await putPush(created.body.token, pushBody({ environment: 'production' }));
    expect(response.status).toBe(204);
    expect(widgetPush.upsert).toHaveBeenCalledWith(expect.objectContaining({
      token: 'ab'.repeat(32), userId: USER, watchDeviceId: created.body.device.id, topic: 'pl.mellis.TEAM.watchkitapp',
      environment: 'production', platform: 'watchos', patientIds: [PATIENT_A],
    }));
  });

  it.each([
    ['a non-hex token', { token: 'zz'.repeat(32) }],
    ['an odd-length token', { token: 'abc' }],
    ['a missing token', { token: undefined }],
    ['an unknown environment', { environment: 'development' }],
    ['an unknown platform', { platform: 'android' }],
    ['a topic that is no bundle id', { topic: 'mellis' }],
    ['a topic with the push-type suffix', { topic: 'pl.mellis.ios.watchkitapp.push-type.widgets' }],
    ['a topic with spaces', { topic: 'pl.mel lis.ios' }],
  ])('PUT /v1/watch/widget-push-token refuses %s with 422', async (_label, overrides) => {
    const created = await createWatch();
    const response = await putPush(created.body.token, pushBody(overrides));
    expect(response.status).toBe(422);
    expect(widgetPush.upsert).not.toHaveBeenCalled();
  });

  it('PUT /v1/watch/widget-push-token: 401 for a user token, an unknown or revoked watch token; 403 with no readable patient', async () => {
    expect((await putPush('valid.jwt')).status).toBe(401);
    expect((await putPush(`gmw_${'a'.repeat(43)}`)).status).toBe(401);
    expect((await request(server()).put('/v1/watch/widget-push-token').send(pushBody())).status).toBe(401);
    const created = await createWatch({ patient_ids: [PATIENT_A] });
    repo.access[USER] = {};
    expect((await putPush(created.body.token)).status).toBe(403);
    repo.access[USER] = { [PATIENT_A]: 'Ania' };
    await request(server()).delete(`/v1/me/watch-devices/${created.body.device.id}`).set('Authorization', 'Bearer valid.jwt');
    expect((await putPush(created.body.token)).status).toBe(401);
    expect(widgetPush.upsert).not.toHaveBeenCalled();
  });
});
