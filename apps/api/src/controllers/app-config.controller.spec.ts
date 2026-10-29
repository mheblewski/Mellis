import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ApiService } from '../application/api.service';
import { BearerPrincipalGuard } from '../auth/bearer-principal.guard';
import { PostgresGlucoMindRepository } from '@infra/db/postgres-glucomind.repository';
import { AppConfigController } from './app-config.controller';
import { PatientController } from './patient.controller';

describe('public and removed endpoints (HTTP)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    vi.stubEnv('AUTH_MODE', 'cognito');
    const moduleRef = await Test.createTestingModule({
      controllers: [AppConfigController, PatientController],
      providers: [
        { provide: ApiService, useValue: { serverVoiceTranscriptionAvailable: () => true } },
        { provide: PostgresGlucoMindRepository, useValue: { getMemberScopes: async () => null } },
      ],
    })
      .overrideGuard(BearerPrincipalGuard)
      .useValue(new BearerPrincipalGuard({ authenticateBearerToken: vi.fn() } as any))
      .compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    vi.unstubAllEnvs();
  });

  it('keeps GET /v1/app-config public (read before sign-in)', async () => {
    const response = await request(app.getHttpServer()).get('/v1/app-config');
    expect(response.status).toBe(200);
    expect(response.body.ios).toHaveProperty('min_build');
    expect(response.body.voice).toEqual({ server_transcription: true });
  });

  it('requires a bearer token for the stream-check diagnostic', async () => {
    const response = await request(app.getHttpServer()).get('/v1/app-config/stream-check');
    expect(response.status).toBe(401);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(JSON.parse(response.text)).toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('no longer serves POST …/meal-cases/reconstruct (no client used it)', async () => {
    const response = await request(app.getHttpServer())
      .post('/v1/patients/11111111-1111-4111-8111-111111111111/meal-cases/reconstruct')
      .set('Authorization', 'Bearer token')
      .send({ candidate_identity: 'x' });
    expect(response.status).toBe(404);
  });

  // The after-the-fact meal logging (loop action questions, carb entry calendar, hypo report form, manual rescue carbs)
  // and reads no app build calls any more: gone, not stubbed (the app is updated together with the server).
  it.each([
    ['GET', 'current-state'],
    ['GET', 'latest-hypo'],
    ['GET', 'hypo-episodes'],
    ['GET', 'hypo-episodes/22222222-2222-4222-8222-222222222222'],
    ['GET', 'analyses/22222222-2222-4222-8222-222222222222'],
    ['PUT', 'conversations/22222222-2222-4222-8222-222222222222/hypo-report'],
    ['POST', 'rescue-carbs'],
    ['GET', 'carb-entries'],
    ['GET', 'carb-entries/attention'],
    ['PUT', 'carb-entries/22222222-2222-4222-8222-222222222222/kind'],
    ['POST', 'carb-entries/22222222-2222-4222-8222-222222222222/detach'],
    ['GET', 'loop-actions'],
    ['GET', 'loop-actions/22222222-2222-4222-8222-222222222222'],
    ['PUT', 'loop-actions/22222222-2222-4222-8222-222222222222/assignment'],
    ['POST', 'loop-actions/22222222-2222-4222-8222-222222222222/skip'],
    ['GET', 'meals'],
    ['GET', 'meals/22222222-2222-4222-8222-222222222222/timeline'],
    ['GET', 'meals/journal/reminders'],
  ])('no longer serves %s …/%s', async (method, path) => {
    const url = `/v1/patients/11111111-1111-4111-8111-111111111111/${path}`;
    const server = request(app.getHttpServer());
    const call = method === 'GET' ? server.get(url) : method === 'PUT' ? server.put(url) : server.post(url);
    const response = await call.set('Authorization', 'Bearer token').send({});
    expect(response.status).toBe(404);
  });
});
