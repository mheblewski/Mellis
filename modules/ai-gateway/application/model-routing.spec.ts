import { describe, expect, it, vi } from 'vitest';
import { selectModelTier } from './model-routing';
import { TieredAiProvider } from '@modules/ai-gateway/infrastructure/tiered-ai-provider';
import { AiGatewayService } from './ai-gateway.service';
import { createConversationDirectResponseTask } from './ai-task';

const timeRange = (userMessageText: string, rangeType = 'SHORT_RANGE', hasPreHypoEvidence = false) =>
  selectModelTier({ task: { task_type: 'CONVERSATION_TIME_RANGE_ANALYSIS' }, userMessageText, rangeType, hasPreHypoEvidence });

describe('model routing (questions asked from the iPhone)', () => {
  it('keeps every analysis on the main model', () => {
    expect(timeRange('Przeanalizuj mi wczorajszy dzień pod kątem hipoglikemii')).toEqual({ tier: 'DEEP', reason: 'ANALYTICAL_QUESTION' });
    expect(timeRange('Co spowodowało tę hipoglikemię?')).toEqual({ tier: 'DEEP', reason: 'CAUSAL_QUESTION' });
    expect(timeRange('A czy można wywnioskować co spowodowało tą hipoglikemię?')).toMatchObject({ tier: 'DEEP' });
    expect(timeRange('Porównaj glukozę po bolusach 9 i 14 października')).toEqual({ tier: 'DEEP', reason: 'ANALYTICAL_QUESTION' });
    expect(timeRange('Pokaż noce z ostatnich 7 dni', 'MEDIUM_RANGE')).toEqual({ tier: 'DEEP', reason: 'LONG_RANGE' });
    expect(timeRange('Pokaż insulinę przed spadkiem', 'SHORT_RANGE', true)).toEqual({ tier: 'DEEP', reason: 'PRE_HYPO_EVIDENCE' });
    expect(timeRange('Jaki jest teraz cukier i czy trend jest stabilny?', 'TODAY')).toMatchObject({ tier: 'DEEP' });
  });

  it('routes "dlaczego", "czemu", "skąd" and "why" questions as causal; how-to and source questions are not', () => {
    for (const question of ['Dlaczego dzisiaj przed południem cukier spadł poniżej 70?', 'Czemu w nocy był taki skok?', 'Skąd ten spadek po obiedzie?', 'Why did it drop at 10:30?']) {
      expect(timeRange(question)).toEqual({ tier: 'DEEP', reason: 'CAUSAL_QUESTION' });
    }
    expect(timeRange('Dlaczego nie mogę zmienić bazy w aplikacji?')).toEqual({ tier: 'DEEP', reason: 'THERAPY_QUESTION' });
    expect(timeRange('Skąd wiesz, że to było SMB?').reason).not.toBe('CAUSAL_QUESTION');
    expect(timeRange('Kiedy były spadki cukru?')).toEqual({ tier: 'LIGHT', reason: 'DATA_LOOKUP' });
  });

  it('keeps dose and settings questions on the main model, but not lookups that only mention basal or corrections', () => {
    for (const question of ['Ile insuliny podać na obiad 45 g?', 'Czy zmniejszyć bazę w nocy?', 'Czy dać korektę teraz?', 'Czy zmienić ICR na śniadanie?', 'Jaki prebolus przy pizzy?']) {
      expect(timeRange(question)).toEqual({ tier: 'DEEP', reason: 'THERAPY_QUESTION' });
    }
    expect(timeRange('Czy były wtedy wstrzymania bazy lub korekty automatyki?')).toEqual({ tier: 'LIGHT', reason: 'DATA_LOOKUP' });
  });

  it('defaults unclear questions to the main model', () => {
    expect(timeRange('Co działo się z glikemią wokół spadku o 10:28?')).toEqual({ tier: 'DEEP', reason: 'UNCLEAR_DEFAULTS_TO_DEEP' });
    expect(selectModelTier({ task: { task_type: 'SOME_OTHER_TASK' }, userMessageText: null })).toEqual({ tier: 'DEEP', reason: 'OTHER_TASK' });
  });

  it('uses the light model for plain data lookups over a short range and for direct replies', () => {
    for (const question of [
      'Pokaż insulinę i wpisy węgli wokół 16:18',
      'Pokaż przebieg glukozy od 15:00 do 17:30',
      'Sprawdź insulinę i wpisy z obu tych poranków',
      'Ile było bolusów wczoraj?',
      'Czy były wtedy wstrzymania bazy lub korekty automatyki?',
    ]) {
      expect(timeRange(question)).toEqual({ tier: 'LIGHT', reason: 'DATA_LOOKUP' });
    }
    expect(selectModelTier({ task: { task_type: 'CONVERSATION_DIRECT_RESPONSE' }, userMessageText: 'Co oznacza IOB?' })).toEqual({ tier: 'LIGHT', reason: 'DIRECT_RESPONSE' });
  });

  it('answers knowledge questions on the main model when the knowledge base is on; thanks and greetings stay light', () => {
    const direct = (text: string) => selectModelTier({ task: { task_type: 'CONVERSATION_DIRECT_RESPONSE' }, userMessageText: text, knowledgeToolAvailable: true });
    expect(direct('Czy to normalne, że po pizzy cukier rośnie po 4 godzinach?')).toEqual({ tier: 'DEEP', reason: 'KNOWLEDGE_QUESTION' });
    expect(direct('Dzięki!')).toEqual({ tier: 'LIGHT', reason: 'DIRECT_RESPONSE' });
    expect(direct('')).toEqual({ tier: 'LIGHT', reason: 'DIRECT_RESPONSE' });

    const lookup = (text: string) => selectModelTier({ task: { task_type: 'CONVERSATION_TIME_RANGE_ANALYSIS' }, userMessageText: text, rangeType: 'TODAY', knowledgeToolAvailable: true });
    expect(lookup('Jak przygotować pętlę Trio do treningu: kiedy ustawić tymczasowy cel?')).toEqual({ tier: 'DEEP', reason: 'KNOWLEDGE_QUESTION' });
    for (const question of ['Pokaż przebieg glukozy od 15:00 do 17:30', 'Ile było bolusów wczoraj?', 'Czy były wtedy wstrzymania bazy lub korekty automatyki?', 'Sprawdź insulinę i wpisy z obu tych poranków']) {
      expect(lookup(question)).toEqual({ tier: 'LIGHT', reason: 'DATA_LOOKUP' });
    }
  });

  it('sends each call to the provider of its tier (DEEP when absent)', async () => {
    const deep = { generate: vi.fn().mockResolvedValue({ model: 'deep' }) };
    const light = { generate: vi.fn().mockResolvedValue({ model: 'light' }) };
    const tiered = new TieredAiProvider(deep as any, light as any);
    expect(await tiered.generate({ model_tier: 'LIGHT' } as any)).toEqual({ model: 'light' });
    expect(await tiered.generate({ model_tier: 'DEEP' } as any)).toEqual({ model: 'deep' });
    expect(await tiered.generate({} as any)).toEqual({ model: 'deep' });
    expect(deep.generate).toHaveBeenCalledTimes(2);
    expect(light.generate).toHaveBeenCalledTimes(1);
  });

  it('names the main tier\'s provider and model, and a failed attempt the model of its chosen tier', async () => {
    const deep = { providerName: 'openai', model: 'deep-model', generate: vi.fn() };
    const light = { providerName: 'openai', model: 'light-model', generate: vi.fn().mockRejectedValue(new Error('down')) };
    const tiered = new TieredAiProvider(deep as any, light as any);
    expect([tiered.providerName, tiered.model]).toEqual(['openai', 'deep-model']);
    expect(tiered.describeTier('LIGHT')).toEqual({ provider: 'openai', model: 'light-model' });

    const ctx: any = {
      context_package_id: 'direct-tier-1', context_package_version: 'conversation-context.v1', content_hash: 'sha256:direct-tier-1',
      created_at: '2026-10-21T12:00:00.000Z', patient_ref: { patient_id: 'patient-1' },
      conversation_context: { thread_id: 'conv-tier-1', thread_state_version: 'v1', awaiting_user_answer: false, messages: [] },
      direct_response_input: { user_message_id: 'msg-tier-1', user_message_text: 'Dzięki!' },
      current_state_snapshot: null, patient_facts: [], provenance: { source_refs: ['msg-tier-1'] },
    };
    const task = createConversationDirectResponseTask({
      task_id: 'direct-tier-task-1', context_package_id: ctx.context_package_id, context_package_version: ctx.context_package_version,
      context_package_hash: ctx.content_hash, correlation_id: 'conv-tier-1', created_at: ctx.created_at, patient_id: 'patient-1',
    });
    const started: Array<{ provider: string; model: string }> = [];
    const failed: Array<{ provider: string; model: string }> = [];
    await expect(new AiGatewayService(tiered).execute({
      task, context_package: ctx, timeout_ms: 5000,
      attempt_observer: {
        onAttemptStarted: async (args) => { started.push({ provider: args.provider, model: args.model }); return { attempt_id: 'a1', attempt_number: 1 }; },
        onAttemptSucceeded: async () => {},
        onAttemptFailed: async (args) => { failed.push({ provider: args.provider, model: args.model }); },
      },
    })).rejects.toBeTruthy();
    expect(started).toEqual([{ provider: 'openai', model: 'deep-model' }]);
    expect(failed).toEqual([{ provider: 'openai', model: 'light-model' }]);
  });
});
