import { afterEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { serverCorrectionFlag, WorkerService } from './worker.service';
import {
  createTrioFixture, trioRepositoryHandlers, TRIO_CONVERSATION_ID, TRIO_PATIENT_ID, TRIO_USER_MESSAGE_ID,
} from '@infra/testing/trio-volume.fixture';

// Offline: what the server changes in a model's answer is kept on the saved message (server-corrections.v1) and logged
// without patient values, so the review sees how often each backstop acts.

const REQUESTED_AT = '2026-10-19T07:15:00.000Z';
const NIGHT_START = '2026-10-15T22:00:00.000Z';
const FIXTURE = createTrioFixture({ requestedAtIso: REQUESTED_AT, todayStartIso: '2026-10-18T22:00:00.000Z', days: 4 });

function setup(result: Record<string, unknown>) {
  const handlers = trioRepositoryHandlers(FIXTURE, { question: 'Jak minęła noc?' });
  const repository = Object.fromEntries(Object.entries(handlers).map(([name, handler]) => [name, vi.fn(handler)])) as any;
  const aiGateway = { execute: vi.fn().mockResolvedValue({ result, metadata: { provider: 'fake', model: 'trio', model_fingerprint: 'trio' }, input_hash: 'sha256:trio' }) };
  const worker = new WorkerService(repository, {} as any, { get: vi.fn(), getOrThrow: vi.fn() } as any, aiGateway as any, {} as any);
  const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  return { worker, repository, warn };
}

const analyseNight = (worker: WorkerService) => (worker as any).handleConversationTimeRangeAnalysis('job-1', 'lease-1', {
  patient_id: TRIO_PATIENT_ID, conversation_id: TRIO_CONVERSATION_ID, user_message_id: TRIO_USER_MESSAGE_ID,
  range_type: 'SHORT_RANGE', range_start: NIGHT_START, range_end: REQUESTED_AT, timezone: 'Europe/Warsaw', normalization_policy_version: 'test',
});
const savedAnswer = (repository: any) => repository.insertMessage.mock.calls.at(-1)[0];
const logged = (warn: ReturnType<typeof vi.spyOn>, event: string) => warn.mock.calls
  .map((call) => { try { return JSON.parse(String(call[0])); } catch { return null; } })
  .filter((entry) => entry?.event === event);

afterEach(() => vi.restoreAllMocks());

describe('server corrections of a model answer (server-corrections.v1)', () => {
  it('keeps dropped options and the cut pointer on the message and in a log line without the text', async () => {
    const { worker, repository, warn } = setup({
      assistant_message: 'Noc była spokojna. Wybierz opcję poniżej.',
      // One option is no options (2-3 needed): the picker is dropped and so is the pointer to it.
      answer_options: [{ key: 'A', title: 'Bez zmian', recommended: true }],
    });
    await analyseNight(worker);

    const saved = savedAnswer(repository);
    expect(saved.content).toBe('Noc była spokojna.');
    expect(saved.metadata.anomaly_flags).toEqual([{ type: 'SERVER_CORRECTION', version: 'server-corrections.v1', corrections: ['OPTION_POINTER_REMOVED', 'OPTIONS_DROPPED'] }]);
    const [event] = logged(warn, 'server_correction');
    expect(event).toMatchObject({ event: 'server_correction', task_type: 'CONVERSATION_TIME_RANGE_ANALYSIS', corrections: ['OPTION_POINTER_REMOVED', 'OPTIONS_DROPPED'] });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('spokojna');
  });

  it('leaves an answer the server did not change without a flag', async () => {
    const { worker, repository, warn } = setup({ assistant_message: 'Noc była spokojna, cukier w zakresie.' });
    await analyseNight(worker);
    expect(savedAnswer(repository).metadata).not.toHaveProperty('anomaly_flags');
    expect(logged(warn, 'server_correction')).toEqual([]);
  });

  it('names each kind once and nothing for no corrections', () => {
    expect(serverCorrectionFlag([false, null, undefined])).toBeNull();
    expect(serverCorrectionFlag(['BOLUS_GIVEN_CLAIM', 'BOLUS_GIVEN_CLAIM', false, 'THERAPY_LOW'])?.corrections).toEqual(['BOLUS_GIVEN_CLAIM', 'THERAPY_LOW']);
  });
});
