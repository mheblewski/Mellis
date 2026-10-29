import { afterEach, describe, expect, it, vi } from 'vitest';
import { patientAgeInstruction } from '@shared/primitives/patient-age';
import { canonicalJson } from '@shared/utils/canonical-json';
import {
  type AiProvider,
  type AiProviderInput,
  type AiProviderResponse,
  type TimeRangeAnalysisContextRecord,
} from '@modules/ai-gateway/domain/ai-gateway';
import { createSyntheticTodayContext } from '@modules/context/application/today-compact-evidence-view.fixture';
import { TODAY_COMPACT_EVIDENCE_VIEW_VERSION } from '@modules/context/application/today-compact-evidence-view';
import { AiGatewayService } from './ai-gateway.service';
import { createConversationTimeRangeAnalysisTask } from './ai-task';
import { buildTimeRangeAnalysisPrompt } from './time-range-analysis-prompt';

const ASSISTANT_MESSAGE = 'Dzisiaj glikemia była zmienna. Brak danych o aktywności, więc jej wpływ pozostaje UNKNOWN.';

class RecordingProvider implements AiProvider {
  readonly inputs: AiProviderInput[] = [];

  async generate(input: AiProviderInput): Promise<AiProviderResponse> {
    this.inputs.push(structuredClone({ ...input, context_package: null }) as AiProviderInput);
    return {
      provider: 'fake',
      model: 'deterministic-time-range-v1',
      received_at: '2026-10-07T20:00:01.000Z',
      raw_output: { assistant_message: ASSISTANT_MESSAGE },
      serialized_input_bytes: Buffer.byteLength(input.prompt.user_payload, 'utf8'),
      usage: { input_tokens: 1234, output_tokens: 50, total_tokens: 1284, cached_input_tokens: 0, reasoning_tokens: 0 },
    };
  }
}

function createTask(context: TimeRangeAnalysisContextRecord) {
  return createConversationTimeRangeAnalysisTask({
    task_id: 'compact-shadow-task-1',
    context_package_id: context.context_package_id,
    context_package_version: context.context_package_version,
    context_package_hash: context.content_hash,
    correlation_id: context.conversation_context.thread_id,
    created_at: '2026-10-07T20:00:00.000Z',
    patient_id: context.patient_ref.patient_id,
  });
}

async function runToday(mode: 'off' | 'shadow') {
  vi.stubEnv('GLUCO_MIND_CONTEXT_BUDGET_MODE', mode);
  vi.stubEnv('AI_ENABLE_TIME_RANGE_GLUCOSE_TOOL_CALLING', '0');

  const context = createSyntheticTodayContext();
  const contextBefore = canonicalJson(context);
  const task = createTask(context);
  const provider = new RecordingProvider();
  const execution = await new AiGatewayService(provider).execute({ task, context_package: context, timeout_ms: 1000 });

  return { context, contextBefore, task, provider, execution };
}

describe('AiGatewayService TODAY compact evidence shadow', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('leaves the production provider payload, answer and context package unchanged', async () => {
    const off = await runToday('off');
    const shadow = await runToday('shadow');

    expect(shadow.provider.inputs).toEqual(off.provider.inputs);
    expect(shadow.provider.inputs).toHaveLength(1);

    const expectedPrompt = buildTimeRangeAnalysisPrompt(shadow.task, shadow.context);
    expect(shadow.provider.inputs[0].prompt.user_payload).toBe(expectedPrompt.user_payload);
    // The gateway adds the patient's age last (not known here: the context has no year of birth).
    expect(shadow.provider.inputs[0].prompt.system_instructions).toBe(`${expectedPrompt.system_instructions}\n${patientAgeInstruction(null)}`);
    expect(shadow.provider.inputs[0].prompt.user_payload).not.toContain(TODAY_COMPACT_EVIDENCE_VIEW_VERSION);
    expect(shadow.provider.inputs[0].prompt.user_payload).not.toContain('compact_evidence_shadow');

    expect(shadow.execution.result).toEqual(off.execution.result);
    expect(shadow.execution.input_hash).toBe(off.execution.input_hash);
    expect(canonicalJson(shadow.context)).toBe(shadow.contextBefore);
  });

  it('records bounded shadow measurements only in execution telemetry', async () => {
    const off = await runToday('off');
    const shadow = await runToday('shadow');

    expect(off.execution.metadata.context_package_usage?.compact_evidence_shadow).toBeUndefined();

    const measurement = shadow.execution.metadata.context_package_usage?.compact_evidence_shadow as Record<string, any>;
    expect(measurement).toMatchObject({
      status: 'MEASURED',
      sent_to_provider: false,
      range_type: 'TODAY',
      context_package_id: shadow.context.context_package_id,
      context_package_hash: shadow.context.content_hash,
      tokens: {
        provider_input_tokens_last_call: 1234,
        provider_input_tokens_kind: 'AUTHORITATIVE_PROVIDER_USAGE',
        compact_view_tokens: null,
        compact_view_tokens_kind: 'UNAVAILABLE_NO_LOCAL_TOKENIZER',
      },
    });
    expect(measurement.bytes.production_user_payload).toBe(
      Buffer.byteLength(shadow.provider.inputs[0].prompt.user_payload, 'utf8'),
    );
    expect(measurement.comparisons.map((entry: { baseline: string }) => entry.baseline)).toEqual([
      'FULL_AI_BOUND_CONTEXT',
      'FULL_ANALYTICAL_EVIDENCE',
      'PRODUCTION_USER_PAYLOAD',
    ]);
    // Telemetry carries measurements and section names, never the view content or evidence refs.
    expect(measurement.daily_summary).toBeUndefined();
    expect(measurement.references).toBeUndefined();
    const serializedMeasurement = JSON.stringify(measurement);
    for (const event of shadow.context.analytical_evidence.meal_events) {
      expect(serializedMeasurement).not.toContain(String(event.event_id));
    }

    const { compact_evidence_shadow: _ignored, ...rest } = shadow.execution.metadata.context_package_usage ?? {};
    expect(rest).toEqual(off.execution.metadata.context_package_usage);
  });
});
