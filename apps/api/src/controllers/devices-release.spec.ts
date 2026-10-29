import 'reflect-metadata';
import { createHash } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ApiService } from '../application/api.service';
import { DevicesController } from './devices.controller';

const SECRET = 'a'.repeat(43);

describe('POST /v1/devices/release (HTTP, no session)', () => {
  let app: INestApplication;
  const repository = {
    releasePatientDevices: vi.fn(async () => 2),
    insertAuditEvent: vi.fn(async () => undefined),
  };

  beforeAll(async () => {
    // The real service method on a stubbed repository: no bearer token at all.
    const service = Object.create(ApiService.prototype) as ApiService;
    Object.assign(service as unknown as Record<string, unknown>, { repository });
    const moduleRef = await Test.createTestingModule({
      controllers: [DevicesController],
      providers: [{ provide: ApiService, useValue: service }],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('releases the rows of this token whose secret matches, and only stores its hash', async () => {
    await request(app.getHttpServer()).post('/v1/devices/release').send({ platform: 'ios', push_token: 'token-a', release_secret: SECRET }).expect(204);
    expect(repository.releasePatientDevices).toHaveBeenCalledWith('ios', 'token-a', createHash('sha256').update(SECRET).digest('hex'));
    expect(repository.insertAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'DEVICE_RELEASED', provider: 'DEVICE_SECRET', userId: null }));
  });

  it('writes no audit row when nothing was released (a no-op stays a quiet 204)', async () => {
    repository.releasePatientDevices.mockResolvedValueOnce(0);
    repository.insertAuditEvent.mockClear();
    await request(app.getHttpServer()).post('/v1/devices/release').send({ platform: 'ios', push_token: 'token-b', release_secret: SECRET }).expect(204);
    expect(repository.releasePatientDevices).toHaveBeenCalledWith('ios', 'token-b', expect.any(String));
    expect(repository.insertAuditEvent).not.toHaveBeenCalled();
  });

  it('refuses a missing or short secret and an unknown platform (422, as validation errors are)', async () => {
    await request(app.getHttpServer()).post('/v1/devices/release').send({ platform: 'ios', push_token: 'token-a' }).expect(422);
    await request(app.getHttpServer()).post('/v1/devices/release').send({ platform: 'ios', push_token: 'token-a', release_secret: 'short' }).expect(422);
    await request(app.getHttpServer()).post('/v1/devices/release').send({ platform: 'android', push_token: 'token-a', release_secret: SECRET }).expect(422);
  });
});
