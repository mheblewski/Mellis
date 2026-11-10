import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkerService } from './worker.service';

const SCHEDULE: Array<[string, number]> = [['00:00', 10], ['06:00', 5], ['09:30', 8.3], ['18:00', 6.8]];

function workerWith(repository: Record<string, unknown>, settingsWhatIfRepository?: unknown) {
  const worker = Object.create(WorkerService.prototype);
  Object.assign(worker, { repository, settingsWhatIfRepository, jobLogger: { log: vi.fn() } });
  return worker as { prepareIcrWhatIf(args: Record<string, unknown>): Promise<{ answered: boolean; card: unknown }> };
}

function repository() {
  return {
    getTherapyProfileAt: vi.fn().mockResolvedValue({ carb_ratio_g_per_u: SCHEDULE }),
    claimUserMessageCompletion: vi.fn().mockResolvedValue(true),
    insertMessage: vi.fn().mockResolvedValue({ id: 'a1' }),
    finalizeJobSuccess: vi.fn().mockResolvedValue(undefined),
  };
}

/** `days` breakfasts at 07:00 UTC with their full dose (20 g, 4 U at ICR 5), flat glucose. */
function syntheticData(days: number) {
  const start = Date.UTC(2026, 9, 1);
  const readings: Array<[number, number]> = [];
  for (let ms = start; ms < start + (days + 1) * 86_400_000; ms += 300_000) readings.push([ms, 120]);
  return {
    time_zone: 'UTC', readings, smbs: [], temps: [], dia_hours: 5, peak_minutes: 75,
    carbs: Array.from({ length: days }, (_, d) => ({ ms: start + d * 86_400_000 + 7 * 3_600_000, g: 20, kind: 'MEAL' })),
    boluses: Array.from({ length: days }, (_, d) => [start + d * 86_400_000 + 7 * 3_600_000, 4]),
    therapies: [{ from_ms: null, carb_ratio_g_per_u: SCHEDULE, sensitivity_per_u: [['00:00', 100]], basal_u_per_h: [['00:00', 0.2]], units: 'mg/dl' }],
  };
}

const args = (userText: string, messages: Array<Record<string, unknown>> = [{ id: 'u1', role: 'USER' }]) => ({
  jobId: 'j', leaseToken: 'l', patientId: 'p', conversationId: 'c', userMessageId: 'u1', userText, messages, requestAtIso: '2026-11-08T20:00:00Z', idempotencyKey: 'k',
});

describe('ICR what-if ask-first reply (icr-whatif-intent.v1)', () => {
  afterEach(() => { delete process.env.SETTINGS_WHATIF_ENABLED; });

  it('does nothing while SETTINGS_WHATIF_ENABLED is off', async () => {
    const repo = repository();
    expect((await workerWith(repo).prepareIcrWhatIf(args('Chcę zmienić ICR z 4 na 5'))).answered).toBe(false);
    expect(repo.getTherapyProfileAt).not.toHaveBeenCalled();
  });

  it('asks for the time of day, with chips, when the value is not in the settings', async () => {
    process.env.SETTINGS_WHATIF_ENABLED = 'true';
    const repo = repository();
    expect((await workerWith(repo).prepareIcrWhatIf(args('Chcę zmienić ICR z 4 na 5, sprawdź czy to ma sens'))).answered).toBe(true);
    const inserted = repo.insertMessage.mock.calls[0][0];
    expect(inserted.content).toMatch(/^W ustawieniach nie ma ICR 4\./);
    expect(inserted.metadata).toMatchObject({ policy: 'SETTINGS_WHATIF_ASK', decision: 'DIRECT_RESPONSE', user_message_id: 'u1' });
    expect(inserted.metadata.suggested_follow_ups).toContain('Rano 5 → 6,3');
    expect(inserted.idempotencyKey).toBe('k');
    expect(repo.finalizeJobSuccess).toHaveBeenCalled();
  });

  it('answers "Podam inną wartość" only right after its own ask-first reply', async () => {
    process.env.SETTINGS_WHATIF_ENABLED = 'true';
    const after = [{ id: 'a0', role: 'ASSISTANT', metadata: { policy: 'SETTINGS_WHATIF_ASK' } }, { id: 'u1', role: 'USER' }];
    const repo = repository();
    expect((await workerWith(repo).prepareIcrWhatIf(args('Podam inną wartość', after))).answered).toBe(true);
    expect(repo.insertMessage.mock.calls[0][0].metadata.policy).toBe('SETTINGS_WHATIF_ASK_VALUE');
    const other = repository();
    expect((await workerWith(other).prepareIcrWhatIf(args('Podam inną wartość'))).answered).toBe(false);
    expect(other.insertMessage).not.toHaveBeenCalled();
  });

  it('leaves other questions to the usual answer', async () => {
    process.env.SETTINGS_WHATIF_ENABLED = 'true';
    const repo = repository();
    expect(await workerWith(repo).prepareIcrWhatIf(args('Jak minęła noc?'))).toEqual({ answered: false, card: null });
    expect(repo.insertMessage).not.toHaveBeenCalled();
  });

  it('replays a change it can read and puts the card above the usual answer', async () => {
    process.env.SETTINGS_WHATIF_ENABLED = 'true';
    const repo = repository();
    const store = { loadIcrWhatIfData: vi.fn().mockResolvedValue(syntheticData(25)) };
    const result = await workerWith(repo, store).prepareIcrWhatIf(args('ICR rano z 5 na 6'));
    expect(result.answered).toBe(false);
    expect(result.card).toMatchObject({ kind: 'SETTING_WHATIF', whatif: { title: 'ICR rano 5 → 6', scope_label: 'Rano, 6:00–9:30', meals: 25, small_sample: true } });
    expect(store.loadIcrWhatIfData.mock.calls[0][0]).toMatchObject({ patientId: 'p', days: 31, peakMinutes: 75 });
    expect(repo.insertMessage).not.toHaveBeenCalled();
  });

  it('says so, written by code, when the time of day has too few meals', async () => {
    process.env.SETTINGS_WHATIF_ENABLED = 'true';
    const repo = repository();
    const store = { loadIcrWhatIfData: vi.fn().mockResolvedValue(syntheticData(12)) };
    expect((await workerWith(repo, store).prepareIcrWhatIf(args('ICR rano z 5 na 6'))).answered).toBe(true);
    const inserted = repo.insertMessage.mock.calls[0][0];
    expect(inserted.content).toBe('W porze „Rano, 6:00–9:30” w ostatnich 31 dniach jest za mało posiłków z bolusem, żeby to przeliczyć (12, potrzeba co najmniej 20). Spróbuj innej pory albo wróć do tego za kilka tygodni.');
    expect(inserted.metadata.policy).toBe('SETTINGS_WHATIF_TOO_FEW_MEALS');
  });

  it('falls back to the usual answer when the data cannot be read', async () => {
    process.env.SETTINGS_WHATIF_ENABLED = 'true';
    const repo = repository();
    const store = { loadIcrWhatIfData: vi.fn().mockRejectedValue(new Error('down')) };
    expect(await workerWith(repo, store).prepareIcrWhatIf(args('ICR rano z 5 na 6'))).toEqual({ answered: false, card: null });
  });

  it('never stops an answer when the settings cannot be read', async () => {
    process.env.SETTINGS_WHATIF_ENABLED = 'true';
    const repo = { ...repository(), getTherapyProfileAt: vi.fn().mockRejectedValue(new Error('down')) };
    expect((await workerWith(repo).prepareIcrWhatIf(args('ICR z 4 na 5'))).answered).toBe(false);
  });
});
