import { afterEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { WorkerService } from './worker.service';
import {
  createTrioFixture, trioRepositoryHandlers, TRIO_CONVERSATION_ID, TRIO_PATIENT_ID, TRIO_USER_MESSAGE_ID, type TrioFixture,
} from '@infra/testing/trio-volume.fixture';

// Offline: the real worker saves an AI answer that claims missing data while the (synthetic Trio) database has it for
// the answer's window. The answer is saved unchanged, with metadata.anomaly_flags and a log line without patient values.

/** Monday 19.10.2026 09:15 in Warsaw (CEST). */
const REQUESTED_AT = '2026-10-19T07:15:00.000Z';
const NIGHT_START = '2026-10-15T22:00:00.000Z';
const FIXTURE = createTrioFixture({ requestedAtIso: REQUESTED_AT, todayStartIso: '2026-10-18T22:00:00.000Z', days: 4 });
const EMPTY_FIXTURE: TrioFixture = { ...FIXTURE, events: [] };

function setup(answer: string, options: { fixture?: TrioFixture; countFails?: boolean } = {}) {
  const handlers = trioRepositoryHandlers(options.fixture ?? FIXTURE, { question: 'Jak minęła noc?' });
  if (options.countFails) handlers.countPatientDataInRange = async () => { throw new Error('synthetic count failure'); };
  const repository = Object.fromEntries(Object.entries(handlers).map(([name, handler]) => [name, vi.fn(handler)])) as any;
  const aiGateway = { execute: vi.fn().mockResolvedValue({ result: { assistant_message: answer }, metadata: { provider: 'fake', model: 'trio', model_fingerprint: 'trio' }, input_hash: 'sha256:trio' }) };
  const worker = new WorkerService(repository, {} as any, { get: vi.fn(), getOrThrow: vi.fn() } as any, aiGateway as any, {} as any);
  const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  return { worker, repository, warn };
}

const analyseNight = (worker: WorkerService) => (worker as any).handleConversationTimeRangeAnalysis('job-1', 'lease-1', {
  patient_id: TRIO_PATIENT_ID, conversation_id: TRIO_CONVERSATION_ID, user_message_id: TRIO_USER_MESSAGE_ID,
  range_type: 'SHORT_RANGE', range_start: NIGHT_START, range_end: REQUESTED_AT, timezone: 'Europe/Warsaw', normalization_policy_version: 'test',
});
const replyDirectly = (worker: WorkerService) => (worker as any).handleConversationDirectResponse('job-2', 'lease-2', {
  patient_id: TRIO_PATIENT_ID, conversation_id: TRIO_CONVERSATION_ID, user_message_id: TRIO_USER_MESSAGE_ID,
});
const savedAnswer = (repository: any) => repository.insertMessage.mock.calls.at(-1)[0];
const logged = (warn: ReturnType<typeof vi.spyOn>, event: string) => warn.mock.calls
  .map((call) => { try { return JSON.parse(String(call[0])); } catch { return null; } })
  .filter((entry) => entry?.event === event);

afterEach(() => vi.restoreAllMocks());

describe('answers that claim missing data the database has are flagged, never changed', () => {
  it('flags an analysis answer saying there were no CGM readings in a window full of them', async () => {
    const answer = 'Z dzisiejszej nocy nie ma odczytów CGM i nie było bolusa, więc nie mogę ocenić nocy.';
    const { worker, repository, warn } = setup(answer);
    await analyseNight(worker);

    const saved = savedAnswer(repository);
    expect(saved.content).toBe(answer);
    expect(saved.metadata.anomaly_flags).toEqual([{
      type: 'SUSPICIOUS_NO_DATA_ANSWER',
      detector_version: 'suspicious-no-data-answer.v1',
      claims: [{ kind: 'GLUCOSE', phrase: 'nie ma odczytów' }, { kind: 'BOLUS', phrase: 'nie było bolusa' }],
      window_basis: 'ANALYSED_RANGE',
      window_from: NIGHT_START,
      window_to: REQUESTED_AT,
      counts: expect.objectContaining({ glucose_readings: expect.any(Number), boluses: 36 + 3 }),
    }]);
    expect(saved.metadata.anomaly_flags[0].counts.glucose_readings).toBe(3 * 288 + 111 - 12);
    expect(repository.countPatientDataInRange).toHaveBeenCalledWith({ patientId: TRIO_PATIENT_ID, startAtIso: NIGHT_START, endAtIso: REQUESTED_AT });

    const [event] = logged(warn, 'suspicious_no_data_answer');
    expect(event).toEqual({
      event: 'suspicious_no_data_answer',
      message_id: 'trio-assistant-message-1',
      conversation_id: TRIO_CONVERSATION_ID,
      user_message_id: TRIO_USER_MESSAGE_ID,
      task_type: 'CONVERSATION_TIME_RANGE_ANALYSIS',
      range_type: 'SHORT_RANGE',
      window_basis: 'ANALYSED_RANGE',
      window_hours: 81,
      phrases: ['nie ma odczytów', 'nie było bolusa'],
      claim_kinds: ['GLUCOSE', 'BOLUS'],
      counts: saved.metadata.anomaly_flags[0].counts,
    });
    // Neither the answer nor the question reaches the log.
    expect(JSON.stringify(warn.mock.calls)).not.toContain('nocy');
  });

  it('does not read the database for an answer without such a claim, and does not flag a true claim', async () => {
    const plain = setup('Noc była spokojna, cukier w zakresie.');
    await analyseNight(plain.worker);
    expect(plain.repository.countPatientDataInRange).not.toHaveBeenCalled();
    expect(savedAnswer(plain.repository).metadata).not.toHaveProperty('anomaly_flags');

    const empty = setup('Z tej nocy nie mam żadnych danych.', { fixture: EMPTY_FIXTURE });
    await analyseNight(empty.worker);
    expect(empty.repository.countPatientDataInRange).toHaveBeenCalledTimes(1);
    expect(savedAnswer(empty.repository).metadata).not.toHaveProperty('anomaly_flags');
    expect(logged(empty.warn, 'suspicious_no_data_answer')).toEqual([]);
  });

  it('saves the answer unchanged when the check fails', async () => {
    const answer = 'Nie mam danych z nocy.';
    const { worker, repository, warn } = setup(answer, { countFails: true });
    await analyseNight(worker);
    expect(savedAnswer(repository)).toMatchObject({ content: answer });
    expect(savedAnswer(repository).metadata).not.toHaveProperty('anomaly_flags');
    expect(logged(warn, 'suspicious_no_data_check_failed')).toHaveLength(1);
    expect(repository.finalizeJobSuccess).toHaveBeenCalled();
  });

  it('checks a direct reply against the 24 hours before the question', async () => {
    const answer = 'Nie mam dostępu do odczytów, sprawdź aplikację Trio.';
    const { worker, repository, warn } = setup(answer);
    await replyDirectly(worker);
    const saved = savedAnswer(repository);
    expect(saved.content).toBe(answer);
    expect(saved.metadata.anomaly_flags[0]).toMatchObject({
      window_basis: 'LAST_24H',
      window_from: '2026-10-18T07:15:00.000Z',
      window_to: REQUESTED_AT,
      claims: [{ kind: 'GLUCOSE', phrase: 'nie mam odczytów' }, { kind: 'ANY_DATA', phrase: 'nie mam dostępu' }],
    });
    expect(logged(warn, 'suspicious_no_data_answer')[0]).toMatchObject({ task_type: 'CONVERSATION_DIRECT_RESPONSE', range_type: null, window_hours: 24 });
  });
});
