import { describe, expect, it } from 'vitest';
import { AiGatewayService } from './ai-gateway.service';
import { createConversationDirectResponseTask } from './ai-task';
import type { AiProvider, AiProviderInput, AiProviderResponse } from '@modules/ai-gateway/domain/ai-gateway';
import type { DiabCalcFood, FoodSearch } from '@modules/meal-chat/infrastructure/diabcalc-mcp-client';

const USAGE = { input_tokens: 100, output_tokens: 10, total_tokens: 110, cached_input_tokens: 0, reasoning_tokens: 0 };
const COST = { estimated_cost: 0.01, currency: 'USD', pricing_version: 'test', input_cost: 0.008, output_cost: 0.002, cached_input_cost: 0, reasoning_cost: 0 };

function directContext(text: string): any {
  return {
    context_package_id: 'direct-draft-1',
    context_package_version: 'conversation-context.v1',
    content_hash: 'sha256:direct-draft-1',
    created_at: '2026-10-19T10:00:00.000Z',
    patient_ref: { patient_id: 'patient-1' },
    conversation_context: { thread_id: 'conv-draft-1', thread_state_version: 'v1', awaiting_user_answer: false, messages: [] },
    direct_response_input: { user_message_id: 'msg-draft-1', user_message_text: text },
    current_state_snapshot: null,
    patient_facts: [],
    provenance: { source_refs: ['msg-draft-1'] },
  };
}

function directTask(context: any) {
  return createConversationDirectResponseTask({
    task_id: 'direct-draft-task-1', context_package_id: context.context_package_id, context_package_version: context.context_package_version,
    context_package_hash: context.content_hash, correlation_id: 'conv-draft-1', created_at: '2026-10-19T10:00:00.000Z', patient_id: 'patient-1',
  });
}

/** Streams each scripted turn's raw output in small chunks to on_output_text, then returns the turn's response. */
class StreamingProvider implements AiProvider {
  calls = 0;
  constructor(private readonly turns: Array<{ chunks: string[]; response: AiProviderResponse }>) {}

  async generate(input: AiProviderInput): Promise<AiProviderResponse> {
    const turn = this.turns[this.calls];
    this.calls += 1;
    let text = '';
    input.on_output_text?.(text);
    for (const chunk of turn.chunks) {
      text += chunk;
      input.on_output_text?.(text);
    }
    return turn.response;
  }
}

const answerResponse = (text: string): AiProviderResponse => ({
  provider: 'fake', model: 'deep-x', response_id: 'resp-final', received_at: '2026-10-19T10:00:02.000Z',
  raw_output: { assistant_message: text, follow_up_candidates: [], conversation_title: null }, usage: USAGE, estimated_cost: COST,
});
const toolCallResponse: AiProviderResponse = {
  provider: 'fake', model: 'deep-x', response_id: 'resp-tool', received_at: '2026-10-19T10:00:01.000Z', raw_output: {},
  tool_calls: [{ call_id: 'call-1', tool_name: 'search_food', arguments: { queries: ['pizza'] } }], usage: USAGE, estimated_cost: COST,
};
const foods: FoodSearch = {
  searchFood: async (): Promise<DiabCalcFood[]> => [],
};

describe('reply draft while a conversation answer is written', () => {
  it('reports the assistant message as it grows, never the JSON around it', async () => {
    const provider = new StreamingProvider([{
      chunks: ['{"assistant_', 'message":"Gli', 'kemia \\"w normie\\"', '.","follow_up_candidates":[{"question":"Co dalej?"', '}],"conversation_title":null}'],
      response: answerResponse('Glikemia "w normie".'),
    }]);
    const drafts: string[] = [];
    const ctx = directContext('Jak glikemia?');
    const execution = await new AiGatewayService(provider).execute({
      task: directTask(ctx), context_package: ctx, timeout_ms: 5000, reply_draft_observer: { onDraft: (text) => drafts.push(text) },
    });
    // Unchanged text (the rest of the JSON being written) is not reported again.
    expect(drafts).toEqual(['Gli', 'Glikemia "w normie"', 'Glikemia "w normie".']);
    expect(execution.result).toMatchObject({ assistant_message: 'Glikemia "w normie".' });
  });

  it('clears text written before a tool call, then follows the answer turn', async () => {
    const provider = new StreamingProvider([
      { chunks: ['{"assistant_message":"Sprawdzam'], response: toolCallResponse },
      { chunks: ['{"assistant_message":"Pizza: 62 g', '","follow_up_candidates":[],"conversation_title":null}'], response: answerResponse('Pizza: 62 g') },
    ]);
    const drafts: string[] = [];
    const ctx = directContext('Ile węgli ma pizza?');
    await new AiGatewayService(provider).execute({
      task: directTask(ctx), context_package: ctx, timeout_ms: 5000, food_search: foods, reply_draft_observer: { onDraft: (text) => drafts.push(text) },
    });
    expect(drafts).toEqual(['Sprawdzam', '', 'Pizza: 62 g']);
  });

  it('a throwing listener does not fail the answer', async () => {
    const provider = new StreamingProvider([{ chunks: ['{"assistant_message":"Ok"}'], response: answerResponse('Ok') }]);
    const ctx = directContext('?');
    await expect(new AiGatewayService(provider).execute({
      task: directTask(ctx), context_package: ctx, timeout_ms: 5000, reply_draft_observer: { onDraft: () => { throw new Error('listener'); } },
    })).resolves.toMatchObject({ result: { assistant_message: 'Ok' } });
  });
});

describe('provider calls the gateway gives up on', () => {
  it('aborts a call that timed out, so it does not keep running and billing', async () => {
    let signal: AbortSignal | undefined;
    const provider: AiProvider = {
      generate: (input) => {
        signal = input.abort_signal;
        return new Promise(() => undefined);
      },
    };
    const ctx = directContext('?');
    await expect(new AiGatewayService(provider).execute({ task: directTask(ctx), context_package: ctx, timeout_ms: 30 })).rejects.toMatchObject({ code: 'AI_TIMEOUT' });
    expect(signal?.aborted).toBe(true);
  });
});
