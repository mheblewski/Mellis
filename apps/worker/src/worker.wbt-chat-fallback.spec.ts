import { describe, expect, it, vi } from 'vitest';
import { WorkerService } from './worker.service';

const PATIENT = '11111111-1111-4111-8111-111111111111';
const MEAL = '44444444-4444-4444-8444-444444444444';

function createWorker() {
  const configService = { getOrThrow: vi.fn().mockReturnValue('test'), get: vi.fn().mockReturnValue(undefined) } as any;
  const nightscout = { ensureNightscoutSource: vi.fn(), prepareNightscoutSources: vi.fn().mockResolvedValue({ seed: null, sources: 1 }), enqueueRecurringSyncJobs: vi.fn() } as any;
  const worker = new WorkerService({} as any, nightscout, configService, {} as any, {} as any) as any;
  const bolusSession = { fastCarbsAdvice: vi.fn(async () => null) };
  worker.createMealActionsSession = vi.fn(async () => null);
  worker.createBolusProposalSession = vi.fn(async () => bolusSession);
  worker.createCareReminderSession = vi.fn(async () => null);
  worker.loadConversationImages = vi.fn(async () => ({ images: [], unavailable: 0 }));
  return worker;
}

describe('WorkerService WBT conversation without its WBT data', () => {
  it('prepares no bolus cards, so a WBT dose cannot become an ordinary bolus card', async () => {
    const worker = createWorker();
    const input: Record<string, unknown> = {};
    await worker.attachConversationAiExtras(input, PATIENT, { id: 'c1', messages: [], wbt_meal_record_id: MEAL }, 'm1', null, null);
    expect(worker.createBolusProposalSession).not.toHaveBeenCalled();
    expect(input.bolus_proposals).toBeUndefined();
  });

  it('keeps bolus cards in an ordinary conversation', async () => {
    const worker = createWorker();
    const input: Record<string, unknown> = {};
    await worker.attachConversationAiExtras(input, PATIENT, { id: 'c1', messages: [] }, 'm1', null, null);
    expect(input.bolus_proposals).toBeDefined();
  });
});

describe('WorkerService conversation photos', () => {
  const worker = () => {
    const w = new WorkerService({} as any, { ensureNightscoutSource: vi.fn(), prepareNightscoutSources: vi.fn().mockResolvedValue({ seed: null, sources: 1 }), enqueueRecurringSyncJobs: vi.fn() } as any, { getOrThrow: vi.fn().mockReturnValue('test'), get: vi.fn().mockReturnValue(undefined) } as any, {} as any, {} as any) as any;
    w.mealPhotoStorage = { read: vi.fn(async () => Buffer.from('jpeg')) };
    return w;
  };
  const messages = [
    { id: 'u1', role: 'USER', content: 'Ile to ma?', metadata: { photo_ids: ['55555555-5555-4555-8555-555555555555'] } },
    { id: 'a1', role: 'ASSISTANT', content: 'Ok. 40 g.' },
    { id: 'u2', role: 'USER', content: 'a ile tłuszczu?' },
    { id: 'a2', role: 'ASSISTANT', content: '12 g.' },
    { id: 'u3', role: 'USER', content: 'jak wygląda TIR z tygodnia?' },
  ];

  it('sends a photo with its question and the next one only', async () => {
    const w = worker();
    expect((await w.loadConversationImages(PATIENT, { messages }, 'u1')).images).toHaveLength(1);
    expect((await w.loadConversationImages(PATIENT, { messages }, 'u2')).images).toHaveLength(1);
    expect((await w.loadConversationImages(PATIENT, { messages }, 'u3')).images).toHaveLength(0);
  });
});
