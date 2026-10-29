import { describe, expect, it, vi } from 'vitest';
import { WorkerService } from './worker.service';

describe('WorkerService finalize lease-loss semantics', () => {
  it('refuses to claim new work after shutdown begins', async () => {
    const repository = {
      claimNextJob: vi.fn().mockResolvedValue({
        id: 'job-shutdown-1',
        lease_token: 'lease-shutdown-1',
        job_type: 'unknown.type',
        payload_version: 1,
        payload: {},
        correlation_id: 'corr-shutdown-1',
        causation_id: null,
        patient_id: null,
        attempts: 1,
        max_attempts: 5,
      }),
      finalizeJobSuccess: vi.fn().mockResolvedValue({ rowCount: 1, ownershipLost: false }),
      finalizeJobRetry: vi.fn().mockResolvedValue({ rowCount: 1, ownershipLost: false }),
      finalizeJobFailure: vi.fn().mockResolvedValue({ rowCount: 1, ownershipLost: false }),
    } as any;

    const nightscoutSyncService = {
      ensureNightscoutSource: vi.fn(), prepareNightscoutSources: vi.fn().mockResolvedValue({ seed: null, sources: 1 }),
      enqueueRecurringSyncJobs: vi.fn(),
      runNightscoutSyncJob: vi.fn(),
      runHypoDetectionJob: vi.fn(),
    } as any;

    const configService = { getOrThrow: vi.fn().mockReturnValue('test') } as any;
    const aiGateway = {} as any;
    const pushNotificationService = {} as any;

    const worker = new WorkerService(
      repository,
      nightscoutSyncService,
      configService,
      aiGateway,
      pushNotificationService,
    );

    worker.onModuleDestroy();
    await worker.processOnce();

    expect(repository.claimNextJob).not.toHaveBeenCalled();
  });

  it('finalizes terminal retry exhaustion as failed instead of retrying again', async () => {
    const repository = {
      claimNextJob: vi.fn().mockResolvedValueOnce({
        id: 'job-retry-exhausted',
        lease_token: 'lease-retry-exhausted',
        job_type: 'triggering.hypo_detection',
        payload_version: 1,
        payload: { patient_id: '11111111-1111-4111-8111-111111111111', event_id: '22222222-2222-4222-8222-222222222222' },
        correlation_id: 'corr-retry-exhausted',
        causation_id: null,
        patient_id: '11111111-1111-4111-8111-111111111111',
        attempts: 3,
        max_attempts: 3,
      }).mockResolvedValueOnce(null),
      finalizeJobSuccess: vi.fn().mockResolvedValue({ rowCount: 1, ownershipLost: false }),
      finalizeJobRetry: vi.fn().mockResolvedValue({ rowCount: 1, ownershipLost: false }),
      finalizeJobFailure: vi.fn().mockResolvedValue({ rowCount: 1, ownershipLost: false }),
    } as any;

    const nightscoutSyncService = {
      ensureNightscoutSource: vi.fn(), prepareNightscoutSources: vi.fn().mockResolvedValue({ seed: null, sources: 1 }),
      enqueueRecurringSyncJobs: vi.fn(),
      runNightscoutSyncJob: vi.fn(),
      runHypoDetectionJob: vi.fn().mockRejectedValue({ retryable: true, message: 'transient failure' }),
    } as any;

    const configService = { getOrThrow: vi.fn().mockReturnValue('test') } as any;
    const aiGateway = {} as any;
    const pushNotificationService = {} as any;

    const worker = new WorkerService(
      repository,
      nightscoutSyncService,
      configService,
      aiGateway,
      pushNotificationService,
    );

    await worker.processOnce();

    expect(repository.finalizeJobRetry).not.toHaveBeenCalled();
    expect(repository.finalizeJobFailure).toHaveBeenCalledTimes(1);
    expect(repository.finalizeJobFailure).toHaveBeenCalledWith(
      'job-retry-exhausted',
      'lease-retry-exhausted',
      expect.any(String),
      expect.objectContaining({
        job_type: 'triggering.hypo_detection',
        retryable: true,
      }),
    );
  });

  it('ownership lost during finalize does not trigger second finalize and does not destabilize loop', async () => {
    const repository = {
      claimNextJob: vi
        .fn()
        .mockResolvedValueOnce({
          id: 'job-1',
          lease_token: 'lease-1',
          job_type: 'unknown.type',
          payload_version: 1,
          payload: {},
          correlation_id: 'corr-1',
          causation_id: null,
          patient_id: null,
          attempts: 1,
          max_attempts: 5,
        })
        .mockResolvedValueOnce(null),
      finalizeJobSuccess: vi.fn().mockResolvedValue({ rowCount: 0, ownershipLost: true }),
      finalizeJobRetry: vi.fn().mockResolvedValue({ rowCount: 0, ownershipLost: true }),
      finalizeJobFailure: vi.fn().mockResolvedValue({ rowCount: 0, ownershipLost: true }),
    } as any;

    const nightscoutSyncService = {
      ensureNightscoutSource: vi.fn(), prepareNightscoutSources: vi.fn().mockResolvedValue({ seed: null, sources: 1 }),
      enqueueRecurringSyncJobs: vi.fn(),
      runNightscoutSyncJob: vi.fn(),
      runHypoDetectionJob: vi.fn(),
    } as any;

    const configService = { getOrThrow: vi.fn().mockReturnValue('test') } as any;
    const aiGateway = {} as any;
    const pushNotificationService = {} as any;

    const worker = new WorkerService(
      repository,
      nightscoutSyncService,
      configService,
      aiGateway,
      pushNotificationService,
    );

    await expect(worker.processOnce()).resolves.toBeUndefined();
    await expect(worker.processOnce()).resolves.toBeUndefined();

    expect(repository.finalizeJobSuccess).toHaveBeenCalledTimes(1);
    expect(repository.finalizeJobRetry).not.toHaveBeenCalled();
    expect(repository.finalizeJobFailure).not.toHaveBeenCalled();
    expect(repository.claimNextJob).toHaveBeenCalledTimes(2);
  });

  it('skips patient-sensitive push delivery when no active caregiver relationship remains', async () => {
    const repository = {
      claimNextJob: vi.fn().mockResolvedValueOnce({
        id: 'push-job-1',
        lease_token: 'lease-push-1',
        job_type: 'notifications.push_conversation_question',
        payload_version: 1,
        payload: {
          patient_id: '11111111-1111-4111-8111-111111111111',
          conversation_id: '22222222-2222-4222-8222-222222222222',
          question_id: 'question-1',
          notification_dedupe_key: 'queue:abc',
        },
        correlation_id: 'corr-push-1',
        causation_id: null,
        patient_id: '11111111-1111-4111-8111-111111111111',
        attempts: 1,
        max_attempts: 5,
      }).mockResolvedValueOnce(null),
      patientHasAnyCaregiverRelationship: vi.fn().mockResolvedValue(false),
      getPushNotificationByDedupeKey: vi.fn().mockResolvedValue(null),
      insertAuditEvent: vi.fn().mockResolvedValue(undefined),
      incrementPushNotificationAttempts: vi.fn().mockResolvedValue(undefined),
      getConversation: vi.fn().mockResolvedValue({ pending_question: { question_id: 'question-1' } }),
      listActivePatientDevices: vi.fn().mockResolvedValue([{ push_token: 'token-1' }]),
      finalizeJobSuccess: vi.fn().mockResolvedValue({ rowCount: 0, ownershipLost: false }),
      finalizeJobRetry: vi.fn().mockResolvedValue({ rowCount: 0, ownershipLost: false }),
      finalizeJobFailure: vi.fn().mockResolvedValue({ rowCount: 0, ownershipLost: false }),
    } as any;

    const nightscoutSyncService = {
      ensureNightscoutSource: vi.fn(), prepareNightscoutSources: vi.fn().mockResolvedValue({ seed: null, sources: 1 }),
      enqueueRecurringSyncJobs: vi.fn(),
      runNightscoutSyncJob: vi.fn(),
      runHypoDetectionJob: vi.fn(),
    } as any;

    const configService = { getOrThrow: vi.fn().mockReturnValue('test') } as any;
    const aiGateway = {} as any;
    const pushNotificationService = {
      sendConversationQuestion: vi.fn().mockResolvedValue(undefined),
    } as any;

    const worker = new WorkerService(
      repository,
      nightscoutSyncService,
      configService,
      aiGateway,
      pushNotificationService,
    );

    await expect(worker.processOnce()).resolves.toBeUndefined();

    expect(repository.patientHasAnyCaregiverRelationship).toHaveBeenCalledWith('11111111-1111-4111-8111-111111111111');
    expect(pushNotificationService.sendConversationQuestion).not.toHaveBeenCalled();
    expect(repository.insertAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'PUSH_AUTHORIZATION_DENIED',
      outcome: 'DENY',
      metadata: expect.objectContaining({ patient_id: '11111111-1111-4111-8111-111111111111' }),
    }));
  });
});
