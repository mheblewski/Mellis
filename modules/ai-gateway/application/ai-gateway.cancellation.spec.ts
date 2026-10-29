import { describe, expect, it } from 'vitest';
import { AiGatewayService } from './ai-gateway.service';
import { createConversationTimeRangeAnalysisTask } from './ai-task';
import { AiExecutionError, type AiProvider, type AiProviderInput, type AiProviderResponse } from '@modules/ai-gateway/domain/ai-gateway';

function createContext(): any {
  return {
    context_package_id: 'tr-cancel-1',
    context_package_version: 'conversation-time-range-context.v1',
    content_hash: 'sha256:tr-cancel-1',
    created_at: '2026-10-08T10:00:00.000Z',
    patient_ref: { patient_id: 'patient-1' },
    analysis_request_input: {
      user_message_id: 'msg-cancel-1',
      user_message_text: 'Przeanalizuj mi dzisiejszy dzień',
      range_type: 'TODAY',
      timezone: 'Europe/Warsaw',
      range_start: '2026-10-08T00:00:00.000Z',
      range_end: '2026-10-08T23:59:59.999Z',
      requested_at: '2026-10-08T10:00:00.000Z',
    },
    conversation_context: { thread_id: 'conv-cancel-1', thread_state_version: 'v1', awaiting_user_answer: false, messages: [] },
    current_state_snapshot: { as_of: '2026-10-08T10:00:00.000Z', current_glucose: 142, trend: 'FLAT', iob: 1.9 },
    analytical_evidence: {
      glucose_events: [{ event_id: 'g-1', occurred_at: '2026-10-08T06:00:00.000Z', payload: { glucose_value: 91 }, provenance_ref: 'source-record/g-1' }],
      insulin_treatment_events: [],
      meal_events: [],
      activity_events: [],
      hypo_episodes: [],
      range_event_facts: [],
      summaries: {
        total_events: 1, glucose_count: 1, insulin_treatment_count: 0, meal_count: 0, activity_count: 0, hypo_episode_count: 0,
        glucose_min: 91, glucose_max: 91, glucose_avg: 91, missing_sections: ['insulin_treatment_events', 'meal_events', 'activity_events', 'hypo_episodes'],
      },
    },
    provenance: { source_refs: ['msg-cancel-1'], selection_policy_version: 'conversation-time-range-selector.v1' },
  };
}

function createTask(context: any) {
  return createConversationTimeRangeAnalysisTask({
    task_id: 'cancel-task-1',
    context_package_id: context.context_package_id,
    context_package_version: context.context_package_version,
    context_package_hash: context.content_hash,
    correlation_id: 'conv-cancel-1',
    created_at: '2026-10-08T10:00:00.000Z',
    patient_id: 'patient-1',
  });
}

/** Behaves like the OpenAI SDK: the request hangs until its signal aborts, then rejects. */
class HangingProvider implements AiProvider {
  calls = 0;
  receivedSignal: AbortSignal | undefined;
  requestAborted = false;

  generate(input: AiProviderInput): Promise<AiProviderResponse> {
    this.calls += 1;
    this.receivedSignal = input.abort_signal;
    return new Promise((_, reject) => {
      input.abort_signal?.addEventListener('abort', () => {
        this.requestAborted = true;
        reject(new Error('Request was aborted.'));
      });
    });
  }
}

async function execute(provider: AiProvider, signal: AbortSignal, steps: string[] = []) {
  const context = createContext();
  return new AiGatewayService(provider).execute({
    task: createTask(context),
    context_package: context,
    timeout_ms: 5_000,
    abort_signal: signal,
    processing_observer: { onStep: (step) => { steps.push(step.type); } },
  });
}

describe('AiGatewayService cancellation', () => {
  it('aborts the in-flight provider request and fails fast with a non-retryable AI_CANCELLED', async () => {
    const provider = new HangingProvider();
    const controller = new AbortController();
    const steps: string[] = [];
    const running = execute(provider, controller.signal, steps);

    await new Promise((resolve) => setTimeout(resolve, 10));
    // The provider gets a per-call signal that follows the caller's (and also fires when the call times out).
    expect(provider.receivedSignal?.aborted).toBe(false);
    const startedAt = Date.now();
    controller.abort();

    const error = await running.catch((caught) => caught);
    expect(error).toBeInstanceOf(AiExecutionError);
    expect(error.code).toBe('AI_CANCELLED');
    expect(error.retryable).toBe(false);
    expect(provider.requestAborted).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    // A cancellation is not reported as a FAILED processing step.
    expect(steps).not.toContain('FAILED');
  });

  it('never calls the provider when already cancelled', async () => {
    const provider = new HangingProvider();
    const controller = new AbortController();
    controller.abort();

    await expect(execute(provider, controller.signal)).rejects.toMatchObject({ code: 'AI_CANCELLED' });
    expect(provider.calls).toBe(0);
  });

  it('stops waiting even when a provider ignores the signal', async () => {
    const provider: AiProvider = { generate: () => new Promise(() => undefined) };
    const controller = new AbortController();
    const running = execute(provider, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    await expect(running).rejects.toMatchObject({ code: 'AI_CANCELLED' });
  });
});
