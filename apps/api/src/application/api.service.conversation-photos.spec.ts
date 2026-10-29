import { describe, expect, it, vi } from 'vitest';
import { ApiService } from './api.service';
import { messagePhotoIds } from '@infra/db/postgres-glucomind.repository';

const PATIENT = '11111111-1111-4111-8111-111111111111';
const CONVERSATION = '22222222-2222-4222-8222-222222222222';
const PHOTO_A = '44444444-4444-4444-8444-444444444444';
const PHOTO_B = '55555555-5555-4555-8555-555555555555';
const CAREGIVER = { user_id: '33333333-3333-4333-8333-333333333333' } as any;

function setup(options: { knownPhotos?: string[] } = {}) {
  const jobs: Array<{ jobType: string; payload: Record<string, unknown> }> = [];
  const insertedMessageParams: unknown[][] = [];
  const client = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      if (/INSERT INTO messages/.test(sql)) {
        insertedMessageParams.push(params);
        return { rows: [{ id: 'message-1', created_at: '2026-10-17T10:00:00.000Z', role: 'USER', metadata: JSON.parse(String(params[4])) }] };
      }
      if (/UPDATE conversations/.test(sql) || /UPDATE messages/.test(sql)) return { rows: [] };
      throw new Error(`unexpected query: ${sql}`);
    }),
  };
  const repo = {
    async getAccessRow(userId: string, patientId: string) {
      return userId === CAREGIVER.user_id && patientId === PATIENT ? { can_read_patient: true, can_write_patient: true } : null;
    },
    insertAuditEvent: vi.fn(),
    getConversation: vi.fn(async () => ({ id: CONVERSATION, patient_id: PATIENT, awaiting_user_answer: false, messages: [] })),
    getMessageByIdempotencyKey: vi.fn(async () => null),
    withTransaction: vi.fn(async (handler: (c: typeof client) => Promise<unknown>) => handler(client)),
    insertJob: vi.fn(async (job: { jobType: string; payload: Record<string, unknown> }) => {
      jobs.push(job);
      return job;
    }),
  };
  const api = new ApiService(repo as any, {} as any);
  const known = new Set(options.knownPhotos ?? [PHOTO_A, PHOTO_B]);
  (api as any).conversationPhotoRepository = {
    countPhotosOfConversation: vi.fn(async (_patient: string, _conversation: string, ids: string[]) => ids.filter((id) => known.has(id)).length),
  };
  const send = (content: string, photoIds?: unknown) =>
    api.submitAnswer(CAREGIVER, PATIENT, CONVERSATION, { message_type: 'USER_MESSAGE', content, photo_ids: photoIds, idempotency_key: 'key-1' });
  return { send, jobs, insertedMessageParams };
}

describe('ApiService photos in the main chat', () => {
  it('stores the photo ids on the message and answers a photo with the patient data of today', async () => {
    const { send, jobs, insertedMessageParams } = setup();

    // Worded like a general question, which alone would get a direct reply without the patient's data.
    const response = await send('Ile to ma węglowodanów?', [PHOTO_A, PHOTO_B.toUpperCase()]);

    expect(JSON.parse(String(insertedMessageParams[0][4]))).toMatchObject({ photo_ids: [PHOTO_A, PHOTO_B] });
    expect(response.decision).toBe('ANALYSIS_REQUEST');
    expect(jobs.map((job) => [job.jobType, job.payload.range_type])).toEqual([['conversation.time_range_analysis', 'TODAY']]);
  });

  it('accepts a photo without text and keeps text-only messages unchanged', async () => {
    const photoOnly = setup();
    await photoOnly.send('', [PHOTO_A]);
    expect(photoOnly.insertedMessageParams[0][2]).toBe('');
    expect(photoOnly.jobs[0].jobType).toBe('conversation.time_range_analysis');

    const textOnly = setup();
    await textOnly.send('dzięki');
    expect(JSON.parse(String(textOnly.insertedMessageParams[0][4]))).not.toHaveProperty('photo_ids');
    expect(textOnly.jobs[0].jobType).toBe('conversation.direct_response');
  });

  it('rejects photos of another conversation, more than three, malformed ids and an empty message', async () => {
    await expect(setup({ knownPhotos: [PHOTO_A] }).send('Ile insuliny?', [PHOTO_A, PHOTO_B])).rejects.toMatchObject({ message: 'Unknown photo id for this conversation' });
    const ids = ['a', 'b', 'c', 'd'].map((digit) => `${digit.repeat(8)}-1111-4111-8111-111111111111`);
    await expect(setup({ knownPhotos: ids }).send('x', ids)).rejects.toMatchObject({ message: 'At most 3 photo ids' });
    await expect(setup().send('x', ['../etc/passwd'])).rejects.toMatchObject({ message: 'photo_ids must be photo ids' });
    await expect(setup().send('  ', [])).rejects.toMatchObject({ message: 'Message content is required' });
  });

  it('reads only well-formed photo ids back from message metadata', () => {
    expect(messagePhotoIds({ photo_ids: [PHOTO_A, 'x', 3, PHOTO_B] })).toEqual([PHOTO_A, PHOTO_B]);
    expect(messagePhotoIds(null)).toEqual([]);
    expect(messagePhotoIds({ decision: 'DIRECT_RESPONSE' })).toEqual([]);
  });
});
