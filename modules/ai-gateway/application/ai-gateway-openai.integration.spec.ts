import { describe, expect, it } from 'vitest';
import { AiGatewayService } from './ai-gateway.service';
import { OpenAiProvider } from '@modules/ai-gateway/infrastructure/openai-provider';
import { createConversationDirectResponseTask, createConversationTimeRangeAnalysisTask } from './ai-task';

describe('AiGateway + OpenAiProvider integration (mocked Responses API)', () => {
  it('passes direct response through provider boundary with direct-response envelope', async () => {
    const directContext = {
      context_package_id: 'dr-1',
      context_package_version: 'conversation-context.v1',
      content_hash: 'sha256:dr-1',
      created_at: '2026-10-12T10:00:00.000Z',
      patient_ref: { patient_id: 'patient-1' },
      conversation_context: {
        thread_id: 'conv-1',
        thread_state_version: 'conv-v1',
        awaiting_user_answer: false,
        messages: [],
      },
      direct_response_input: {
        user_message_id: 'msg-1',
        user_message_text: 'Podsumuj dzisiejszy dzień',
      },
      current_state_snapshot: {
        as_of: '2026-10-12T10:00:00.000Z',
        current_glucose: 124,
        trend: 'FLAT',
        iob: 1.2,
      },
      provenance: {
        source_refs: ['msg-1'],
      },
    } as const;

    const task = createConversationDirectResponseTask({
      task_id: 'direct-task-1',
      context_package_id: directContext.context_package_id,
      context_package_version: directContext.context_package_version,
      context_package_hash: directContext.content_hash,
      correlation_id: 'conv-1',
      created_at: '2026-10-12T10:00:00.000Z',
      patient_id: 'patient-1',
    });

    let capturedRequest: Record<string, unknown> | null = null;
    const mockClient = {
      responses: {
        create: async (body: Record<string, unknown>) => {
          capturedRequest = body;
          return {
            output_text: JSON.stringify({ assistant_message: 'Podsumowanie dnia gotowe.' }),
          };
        },
      },
    };

    const gateway = new AiGatewayService(new OpenAiProvider({ apiKey: 'sk-test', model: 'gpt-5.6-terra' }, mockClient as any));
    const execution = await gateway.execute({ task, context_package: directContext as any, timeout_ms: 1000 });

    expect(execution.metadata.provider).toBe('openai');
    expect((execution.result as { assistant_message: string }).assistant_message).toContain('Podsumowanie');

    const requestInput = (capturedRequest?.input ?? []) as Array<Record<string, unknown>>;
    const userMessage = requestInput.find((entry) => entry.role === 'user');
    expect(userMessage).toBeTruthy();

    const payload = JSON.parse(String(userMessage?.content ?? '{}')) as Record<string, unknown>;
    // The task's labels are validated, not sent: the model copy leaves them out (payload audit 2026-10-26).
    expect(payload.task).toBeUndefined();
    expect(payload.direct_response_input).toBeTruthy();
    expect(payload.context_package).toBeUndefined();
    expect(payload.analytical_evidence).toBeUndefined();
  });

  it('passes time-range through provider boundary with selected_evidence envelope', async () => {
    const timeRangeContext = {
      context_package_id: 'tr-1',
      context_package_version: 'conversation-time-range-context.v1',
      content_hash: 'sha256:tr-1',
      created_at: '2026-10-12T10:00:00.000Z',
      patient_ref: { patient_id: 'patient-1' },
      analysis_request_input: {
        user_message_id: 'msg-1',
        user_message_text: 'Przeanalizuj ten zakres',
        range_type: 'TODAY',
        timezone: 'UTC',
        range_start: '2026-10-12T00:00:00.000Z',
        range_end: '2026-10-12T10:00:00.000Z',
        requested_at: '2026-10-12T10:00:00.000Z',
      },
      conversation_context: {
        thread_id: 'conv-1',
        thread_state_version: 'conv-v1',
        awaiting_user_answer: false,
        messages: [],
      },
      current_state_snapshot: {
        as_of: '2026-10-12T10:00:00.000Z',
        current_glucose: 142,
        trend: 'FLAT',
        iob: 0.9,
      },
      analytical_evidence: {
        glucose_events: [],
        insulin_treatment_events: [],
        meal_events: [],
        activity_events: [],
        hypo_episodes: [],
        range_event_facts: [],
        summaries: {
          total_events: 2,
          glucose_count: 1,
          insulin_treatment_count: 1,
          meal_count: 0,
          activity_count: 0,
          hypo_episode_count: 0,
          glucose_min: 142,
          glucose_max: 142,
          glucose_avg: 142,
          missing_sections: ['activity_events'],
        },
      },
      provenance: {
        source_refs: ['evt-1'],
        selection_policy_version: 'conversation-time-range-context-selection.v1',
      },
    } as const;

    const task = createConversationTimeRangeAnalysisTask({
      task_id: 'time-range-task-1',
      context_package_id: timeRangeContext.context_package_id,
      context_package_version: timeRangeContext.context_package_version,
      context_package_hash: timeRangeContext.content_hash,
      correlation_id: 'conv-1',
      created_at: '2026-10-12T10:00:00.000Z',
      patient_id: 'patient-1',
    });

    let capturedRequest: Record<string, unknown> | null = null;
    const mockClient = {
      responses: {
        create: async (body: Record<string, unknown>) => {
          capturedRequest = body;
          return {
            output_text: JSON.stringify({ assistant_message: 'Analiza zakresu gotowa.' }),
          };
        },
      },
    };

    const gateway = new AiGatewayService(new OpenAiProvider({ apiKey: 'sk-test', model: 'gpt-5.6-terra' }, mockClient as any));
    const execution = await gateway.execute({ task, context_package: timeRangeContext as any, timeout_ms: 1000 });

    expect(execution.metadata.provider).toBe('openai');
    expect((execution.result as { assistant_message: string }).assistant_message).toContain('Analiza zakresu');

    const requestInput = (capturedRequest?.input ?? []) as Array<Record<string, unknown>>;
    const userMessage = requestInput.find((entry) => entry.role === 'user');
    expect(userMessage).toBeTruthy();

    const payload = JSON.parse(String(userMessage?.content ?? '{}')) as Record<string, unknown>;
    expect(payload.task).toBeUndefined();
    expect(payload.selected_evidence).toBeTruthy();
    expect(payload.analytical_evidence).toBeUndefined();
    expect(JSON.stringify(payload)).not.toContain('raw_payload');
  });

  it('validates every tool-loop provider turn for time-range requests', async () => {
    const previousToolLoopFlag = process.env.AI_ENABLE_TIME_RANGE_GLUCOSE_TOOL_CALLING;
    process.env.AI_ENABLE_TIME_RANGE_GLUCOSE_TOOL_CALLING = '1';

    try {
      const timeRangeContext = {
        context_package_id: 'tr-loop-1',
        context_package_version: 'conversation-time-range-context.v1',
        content_hash: 'sha256:tr-loop-1',
        created_at: '2026-10-12T10:00:00.000Z',
        patient_ref: { patient_id: 'patient-1' },
        analysis_request_input: {
          user_message_id: 'msg-loop-1',
          user_message_text: 'Przeanalizuj glukozę z rana',
          range_type: 'TODAY',
          timezone: 'UTC',
          range_start: '2026-10-12T06:00:00.000Z',
          range_end: '2026-10-12T08:00:00.000Z',
          requested_at: '2026-10-12T10:00:00.000Z',
        },
        conversation_context: {
          thread_id: 'conv-loop-1',
          thread_state_version: 'conv-v1',
          awaiting_user_answer: false,
          messages: [],
        },
        current_state_snapshot: {
          as_of: '2026-10-12T08:00:00.000Z',
          current_glucose: 120,
          trend: 'FLAT',
          iob: 0.4,
        },
        analytical_evidence: {
          glucose_events: [
            {
              event_id: 'g-1',
              source_record_id: 'src-g-1',
              occurred_at: '2026-10-12T06:30:00.000Z',
              payload: {
                glucose_value: 120,
              },
            },
          ],
          insulin_treatment_events: [],
          meal_events: [],
          activity_events: [],
          hypo_episodes: [],
          range_event_facts: [],
          summaries: {
            total_events: 1,
            glucose_count: 1,
            insulin_treatment_count: 0,
            meal_count: 0,
            activity_count: 0,
            hypo_episode_count: 0,
            glucose_min: 120,
            glucose_max: 120,
            glucose_avg: 120,
            missing_sections: [],
          },
        },
        provenance: {
          source_refs: ['evt-loop-1'],
          selection_policy_version: 'conversation-time-range-context-selection.v1',
        },
      } as const;

      const task = createConversationTimeRangeAnalysisTask({
        task_id: 'time-range-loop-task-1',
        context_package_id: timeRangeContext.context_package_id,
        context_package_version: timeRangeContext.context_package_version,
        context_package_hash: timeRangeContext.content_hash,
        correlation_id: 'conv-loop-1',
        created_at: '2026-10-12T10:00:00.000Z',
        patient_id: 'patient-1',
      });

      const requestBodies: Array<Record<string, unknown>> = [];
      const mockClient = {
        responses: {
          create: async (body: Record<string, unknown>) => {
            requestBodies.push(body);

            if (requestBodies.length === 1) {
              return {
                id: 'resp-loop-1',
                output: [
                  {
                    type: 'function_call',
                    id: 'fc-loop-1',
                    call_id: 'call-loop-1',
                    name: 'get_glucose_evidence',
                    arguments: JSON.stringify({
                      time_range: {
                        from: '2026-10-12T06:00:00.000Z',
                        to: '2026-10-12T08:00:00.000Z',
                      },
                      detail_level: 'SUMMARY',
                    }),
                  },
                ],
              };
            }

            return {
              id: 'resp-loop-2',
              output_text: JSON.stringify({ assistant_message: 'Analiza po dowodzie glukozy gotowa.' }),
            };
          },
        },
      };

      const gateway = new AiGatewayService(new OpenAiProvider({ apiKey: 'sk-test', model: 'gpt-5.6-terra' }, mockClient as any));
      const execution = await gateway.execute({ task, context_package: timeRangeContext as any, timeout_ms: 1000 });

      expect((execution.result as { assistant_message: string }).assistant_message).toContain('Analiza');
      expect(requestBodies).toHaveLength(2);

      const firstInput = (requestBodies[0].input ?? []) as Array<Record<string, unknown>>;
      const firstUserPayload = JSON.parse(String(firstInput.find((entry) => entry.role === 'user')?.content ?? '{}')) as Record<string, unknown>;
      expect(firstUserPayload.task).toBeUndefined();
      expect(firstUserPayload.selected_evidence).toBeTruthy();
      expect(firstUserPayload.analytical_evidence).toBeUndefined();

      expect(requestBodies[1].previous_response_id).toBe('resp-loop-1');
      const secondInput = (requestBodies[1].input ?? []) as Array<Record<string, unknown>>;
      const functionOutputs = secondInput.filter((entry) => entry.type === 'function_call_output');
      expect(functionOutputs).toHaveLength(1);
      expect(functionOutputs[0].call_id).toBe('call-loop-1');

      // The intact previous_response_id chain already carries the system and user prompt: it is not billed twice.
      expect(secondInput.some((entry) => entry.role === 'user' || entry.role === 'system')).toBe(false);
      expect(JSON.stringify(secondInput)).not.toContain('raw_payload');
    } finally {
      if (previousToolLoopFlag === undefined) {
        delete process.env.AI_ENABLE_TIME_RANGE_GLUCOSE_TOOL_CALLING;
      } else {
        process.env.AI_ENABLE_TIME_RANGE_GLUCOSE_TOOL_CALLING = previousToolLoopFlag;
      }
    }
  });
});
