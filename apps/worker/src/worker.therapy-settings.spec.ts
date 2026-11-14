import { describe, expect, it, vi } from 'vitest';
import { WorkerService } from './worker.service';

const PROFILE = {
  status: 'KNOWN',
  units: 'mg/dl',
  timezone: 'Europe/Warsaw',
  dia_hours: 6,
  basal_u_per_h: [['00:00', 0.3], ['06:00', 0.45], ['21:00', 0.35]],
  carb_ratio_g_per_u: [['00:00', 10], ['06:00', 5], ['18:00', 6.8]],
  sensitivity_per_u: [['00:00', 300]],
  target_low: [['00:00', 100]],
  target_high: [['00:00', 100]],
};

function repository() {
  return {
    getTherapyProfileAt: vi.fn().mockResolvedValue(PROFILE),
    listTherapyProfileUploads: vi.fn().mockResolvedValue([]),
    listInsulinDeliveryEventsByRange: vi.fn().mockResolvedValue([]),
    claimUserMessageCompletion: vi.fn().mockResolvedValue(true),
    insertMessage: vi.fn().mockResolvedValue({ id: 'a1' }),
    finalizeJobSuccess: vi.fn().mockResolvedValue(undefined),
  };
}

function workerWith(repository: Record<string, unknown>) {
  const worker = Object.create(WorkerService.prototype);
  Object.assign(worker, {
    repository,
    bolusDashboardRepository: { getPatientLabel: vi.fn().mockResolvedValue('Janek'), getLoopStatusAtOrBefore: vi.fn().mockResolvedValue(null) },
    therapyContextRepository: null,
    jobLogger: { log: vi.fn(), warn: vi.fn() },
    patientLoopSystem: vi.fn().mockResolvedValue({ kind: 'TRIO' }),
    patientTimeZone: vi.fn().mockResolvedValue('Europe/Warsaw'),
  });
  return worker as { prepareTherapySettings(args: Record<string, unknown>): Promise<{ answered: boolean }> };
}

const args = (userText: string, extra: Record<string, unknown> = {}) => ({
  jobId: 'j', leaseToken: 'l', patientId: 'p', conversationId: 'c', userMessageId: 'u1', userText,
  messages: [{ id: 'u1', role: 'USER' }], requestAt: new Date('2026-11-11T12:20:00Z'), idempotencyKey: 'k', hasPhotos: false, ...extra,
});

describe('therapy settings answer without a model call (therapy-settings-reply.v1)', () => {
  it('saves the card with a line by code for every setting, not only basal', async () => {
    for (const question of ['Jaką bazę ma Janek?', 'Jakie jest ICR o 13:00?', 'A ISF?', 'Pokaż cel', 'Jakie Janek ma ustawienia?']) {
      const repo = repository();
      expect((await workerWith(repo).prepareTherapySettings(args(question))).answered).toBe(true);
      const inserted = repo.insertMessage.mock.calls[0][0];
      expect(inserted.content).toBe('To ustawienia z profilu w Trio.');
      expect(inserted.metadata).toMatchObject({
        source: 'therapy-settings-policy', policy: 'THERAPY_SETTINGS_CARD', policy_version: 'therapy-settings-reply.v1',
        decision: 'DIRECT_RESPONSE', user_message_id: 'u1', metric_card: { kind: 'THERAPY_SETTINGS' },
      });
      expect(inserted.idempotencyKey).toBe('k');
      expect(repo.finalizeJobSuccess).toHaveBeenCalled();
    }
  });

  it('offers the other settings under a card that shows only some', async () => {
    const repo = repository();
    await workerWith(repo).prepareTherapySettings(args('Jaką bazę ma Janek?'));
    expect(repo.insertMessage.mock.calls[0][0].metadata.suggested_follow_ups).toEqual(['Pokaż wszystkie ustawienia']);
  });

  it('a follow-up reads the card the code saved', async () => {
    const repo = repository();
    await workerWith(repo).prepareTherapySettings(args('Jakie jest ICR o 13:00?'));
    const saved = repo.insertMessage.mock.calls[0][0];
    const next = repository();
    const messages = [{ id: 'a1', role: 'ASSISTANT', metadata: saved.metadata }, { id: 'u2', role: 'USER' }];
    await workerWith(next).prepareTherapySettings(args('a o 19?', { userMessageId: 'u2', messages }));
    expect(next.insertMessage.mock.calls[0][0].metadata.metric_card.therapy).toMatchObject({ at: '19:00', settings: [{ key: 'ICR' }] });
  });

  it('leaves other questions and photos to the usual answer', async () => {
    const repo = repository();
    expect((await workerWith(repo).prepareTherapySettings(args('Czy ICR o 13 jest za mocne?'))).answered).toBe(false);
    expect((await workerWith(repo).prepareTherapySettings(args('Jaką bazę ma Janek?', { hasPhotos: true }))).answered).toBe(false);
    expect(repo.insertMessage).not.toHaveBeenCalled();
  });

  it('falls back to the usual answer when the profile cannot be read', async () => {
    const repo = { ...repository(), getTherapyProfileAt: vi.fn().mockRejectedValue(new Error('down')) };
    expect((await workerWith(repo).prepareTherapySettings(args('Jaką bazę ma Janek?'))).answered).toBe(false);
    expect(repo.insertMessage).not.toHaveBeenCalled();
  });
});
