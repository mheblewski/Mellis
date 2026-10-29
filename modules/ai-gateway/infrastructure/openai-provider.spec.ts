import { describe, expect, it } from 'vitest';
import { OpenAiProvider } from './openai-provider';
import { AiProviderError } from './ai-provider.error';
import { AiProviderInput } from '@modules/ai-gateway/domain/ai-gateway';

function createInput(): AiProviderInput {
  const contextPackage = {
    context_package_id: 'dr-1',
    context_package_version: 'conversation-context.v1',
    content_hash: 'sha256:dr-1',
    created_at: '2026-01-01T00:00:00.000Z',
    patient_ref: { patient_id: 'patient-1' },
    conversation_context: {
      thread_id: 'conv-1',
      thread_state_version: 'conv-v1',
      awaiting_user_answer: false,
      messages: [],
    },
    direct_response_input: {
      user_message_id: 'msg-1',
      user_message_text: 'Jak teraz wygląda glukoza?',
    },
    current_state_snapshot: {
      as_of: '2026-01-01T00:00:00.000Z',
      current_glucose: 68,
      trend: 'UNKNOWN',
    },
  } as unknown as AiProviderInput['context_package'];

  return {
    task: {
      task_id: 'task-1',
      task_type: 'CONVERSATION_DIRECT_RESPONSE',
      task_version: 'conversation-direct-response-task.v1',
      context_package_id: 'dr-1',
      context_package_version: 'conversation-context.v1',
      context_package_hash: 'sha256:dr-1',
      prompt_version: 'conversation-direct-response.v1',
      output_schema_version: 'conversation-direct-response-output.v1',
      model_policy_version: 'openai-policy.v1',
      correlation_id: 'conv-1',
      created_at: '2026-01-01T00:00:00.000Z',
      patient_id: 'patient-1',
    },
    context_package: contextPackage,
    prompt: {
      prompt_version: 'conversation-direct-response.v1',
      output_schema_version: 'conversation-direct-response-output.v1',
      system_instructions: 'system',
      user_payload: JSON.stringify({
        task: {
          task_type: 'CONVERSATION_DIRECT_RESPONSE',
          task_version: 'conversation-direct-response-task.v1',
          prompt_version: 'conversation-direct-response.v1',
          output_schema_version: 'conversation-direct-response-output.v1',
          correlation_id: 'conv-1',
        },
        patient_ref: { patient_id: 'patient-1' },
        conversation_context: {
          thread_id: 'conv-1',
          recent_messages: [],
        },
        current_state_snapshot: {
          as_of: '2026-01-01T00:00:00.000Z',
          current_glucose: 68,
          trend: 'UNKNOWN',
        },
        direct_response_input: {
          user_message_id: 'msg-1',
          user_message_text: 'Jak teraz wygląda glukoza?',
        },
        provenance_summary: {
          source_refs: ['msg-1'],
        },
        evidence_contract: {
          use_only_observed_and_deterministic_data: true,
          never_invent_patient_specific_events_or_values: true,
          explicitly_mark_missing_or_unknown_sections: true,
          no_chain_of_thought: true,
        },
      }),
    },
  };
}

function validOutput() {
  return {
    assistant_message: 'Glukoza wynosi teraz 68 mg/dL.',
    follow_up_candidates: [],
    conversation_title: null,
  };
}

describe('OpenAiProvider', () => {
  it('returns successful structured response', async () => {
    const mockClient = {
      responses: {
        create: async () => ({ output_text: JSON.stringify(validOutput()) }),
      },
    };

    const provider = new OpenAiProvider({ apiKey: 'sk-test', model: 'gpt-5.6-sol', timeoutMs: 1000 }, mockClient as any);
    const result = await provider.generate(createInput());

    expect(result.provider).toBe('openai');
    expect(result.model).toBe('gpt-5.6-sol');
    expect((result.raw_output as any).assistant_message).toBe('Glukoza wynosi teraz 68 mg/dL.');
  });

  it('accepts a semantically safe time-range evidence payload before the provider call', async () => {
    const mockClient = {
      responses: {
        create: async () => ({ output_text: JSON.stringify(validOutput()) }),
      },
    };

    const validPayload = {
      task: {
        task_type: 'CONVERSATION_TIME_RANGE_ANALYSIS',
        task_version: 'conversation-time-range.v1',
        prompt_version: 'conversation-time-range.v1',
        output_schema_version: 'conversation-time-range-output.v1',
        correlation_id: 'corr-1',
      },
      patient_ref: { patient_id: 'patient-1' },
      analysis_request_input: {
        user_message_id: 'm-1',
        user_message_text: 'What happened?',
        range_type: '24H',
        timezone: 'UTC',
        range_start: '2026-01-01T00:00:00.000Z',
        range_end: '2026-01-02T00:00:00.000Z',
        requested_at: '2026-01-01T12:00:00.000Z',
      },
      conversation_context: {
        thread_id: 'thread-1',
        thread_state_version: 'v1',
        recent_messages: [],
      },
      current_state_snapshot: {
        as_of: '2026-01-01T12:00:00.000Z',
        current_glucose: 92,
        trend: 'FLAT',
      },
      selected_evidence: {
        summary: {
          total_events: 1,
          glucose_count: 1,
          insulin_treatment_count: 0,
          meal_count: 0,
          activity_count: 0,
          hypo_episode_count: 0,
          glucose_min: 92,
          glucose_max: 92,
          glucose_avg: 92,
          missing_sections: [],
        },
        glucose: { count: 1, min: 92, max: 92, avg: 92 },
        insulin: { count: 0 },
        meals: { count: 0 },
        activity: { count: 0 },
        range_facts: [],
      },
      provenance_summary: {
        source_refs: ['evt-1'],
        selection_policy_version: 'time-range-policy.v1',
      },
      evidence_contract: {
        use_only_observed_and_deterministic_data: true,
        never_invent_patient_specific_events_or_values: true,
        explicitly_mark_missing_or_unknown_sections: true,
        no_treatment_recommendations: true,
        no_therapy_adjustment_advice: true,
        no_insulin_dosing_guidance: true,
        no_chain_of_thought: true,
      },
    };

    const provider = new OpenAiProvider({ apiKey: 'sk-test', model: 'gpt-5.6-sol', timeoutMs: 1000 }, mockClient as any);
    const input = createInput();
    input.task.task_type = 'CONVERSATION_TIME_RANGE_ANALYSIS';
    input.prompt.user_payload = JSON.stringify(validPayload);

    await expect(provider.generate(input)).resolves.toMatchObject({ provider: 'openai' });
  });

  it('rejects legacy payloads that are not AiEvidenceDeliveryEnvelope', async () => {
    let createCalled = false;
    const mockClient = {
      responses: {
        create: async () => {
          createCalled = true;
          return { output_text: JSON.stringify(validOutput()) };
        },
      },
    };

    const provider = new OpenAiProvider({ apiKey: 'sk-test', model: 'gpt-5.6-sol', timeoutMs: 1000 }, mockClient as any);
    const input = createInput();
    input.task.task_type = 'CONVERSATION_TIME_RANGE_ANALYSIS';
    input.prompt.user_payload = JSON.stringify({
      task: { task_type: 'CONVERSATION_TIME_RANGE_ANALYSIS' },
      plain_data: { value: 1 },
    });

    await expect(provider.generate(input)).rejects.toMatchObject({
      code: 'AI_EVIDENCE_DELIVERY_VALIDATION_FAILED',
      retryable: false,
    });
    expect(createCalled).toBe(false);
  });

  it('rejects full analytical_evidence without raw_payload and nested raw source objects', async () => {
    let createCalled = false;
    const mockClient = {
      responses: {
        create: async () => {
          createCalled = true;
          return { output_text: JSON.stringify(validOutput()) };
        },
      },
    };

    const provider = new OpenAiProvider({ apiKey: 'sk-test', model: 'gpt-5.6-sol', timeoutMs: 1000 }, mockClient as any);
    const input = createInput();
    input.task.task_type = 'CONVERSATION_TIME_RANGE_ANALYSIS';
    input.prompt.user_payload = JSON.stringify({
      task: { task_type: 'CONVERSATION_TIME_RANGE_ANALYSIS' },
      patient_ref: { patient_id: 'patient-1' },
      analysis_request_input: { range_start: '2026-01-01T00:00:00.000Z', range_end: '2026-01-02T00:00:00.000Z' },
      conversation_context: { thread_id: 'thread-1', recent_messages: [] },
      selected_evidence: {
        summary: { total_events: 1 },
        raw_source_objects: [{ source: 'nightscout', payload: { glucose: [1, 2, 3] } }],
      },
      provenance_summary: { source_refs: ['evt-1'], selection_policy_version: 'v1' },
      evidence_contract: { no_chain_of_thought: true },
      analytical_evidence: { glucose_events: [{ glucose_value: 99 }] },
    });

    await expect(provider.generate(input)).rejects.toMatchObject({
      code: 'AI_EVIDENCE_DELIVERY_VALIDATION_FAILED',
      retryable: false,
    });
    expect(createCalled).toBe(false);
  });

  it('rejects invalid tool results before provider call', async () => {
    let createCalled = false;
    const mockClient = {
      responses: {
        create: async () => {
          createCalled = true;
          return { output_text: JSON.stringify(validOutput()) };
        },
      },
    };

    const provider = new OpenAiProvider({ apiKey: 'sk-test', model: 'gpt-5.6-sol', timeoutMs: 1000 }, mockClient as any);
    const input = createInput();
    input.task.task_type = 'CONVERSATION_TIME_RANGE_ANALYSIS';
    input.prompt.user_payload = JSON.stringify({
      task: { task_type: 'CONVERSATION_TIME_RANGE_ANALYSIS' },
      patient_ref: { patient_id: 'patient-1' },
      analysis_request_input: { range_start: '2026-01-01T00:00:00.000Z', range_end: '2026-01-02T00:00:00.000Z' },
      conversation_context: { thread_id: 'thread-1', recent_messages: [] },
      selected_evidence: { summary: { total_events: 1 }, glucose: { count: 1 } },
      provenance_summary: { source_refs: ['evt-1'], selection_policy_version: 'v1' },
      evidence_contract: { no_chain_of_thought: true },
    });
    input.tool_runtime = {
      available_tools: [],
      tool_results: [{ call_id: 'call-1', tool_name: 'get_glucose_evidence', result: { raw_payload: { glucose: [1, 2, 3] } } }],
      max_tool_calls_remaining: 1,
    };

    await expect(provider.generate(input)).rejects.toMatchObject({
      code: 'AI_EVIDENCE_DELIVERY_VALIDATION_FAILED',
      retryable: false,
    });
    expect(createCalled).toBe(false);
  });

  it('rejects source-class payload disguised under aliases in time-range envelope', async () => {
    let createCalled = false;
    const mockClient = {
      responses: {
        create: async () => {
          createCalled = true;
          return { output_text: JSON.stringify(validOutput()) };
        },
      },
    };

    const provider = new OpenAiProvider({ apiKey: 'sk-test', model: 'gpt-5.6-sol', timeoutMs: 1000 }, mockClient as any);
    const input = createInput();
    input.task.task_type = 'CONVERSATION_TIME_RANGE_ANALYSIS';
    input.prompt.user_payload = JSON.stringify({
      task: { task_type: 'CONVERSATION_TIME_RANGE_ANALYSIS' },
      patient_ref: { patient_id: 'patient-1' },
      analysis_request_input: { range_start: '2026-01-01T00:00:00.000Z', range_end: '2026-01-02T00:00:00.000Z' },
      conversation_context: { thread_id: 'thread-1', recent_messages: [] },
      selected_evidence: {
        summary: { total_events: 1 },
        telemetry_blob: {
          sourcePacket: {
            sgv: 96,
            date: 1791324226079,
            dateString: '2026-10-06T22:03:46.079Z',
            type: 'sgv',
          },
        },
      },
      provenance_summary: { source_refs: ['evt-1'], selection_policy_version: 'v1' },
      evidence_contract: { no_chain_of_thought: true },
    });

    await expect(provider.generate(input)).rejects.toMatchObject({
      code: 'AI_EVIDENCE_DELIVERY_VALIDATION_FAILED',
      retryable: false,
    });
    expect(createCalled).toBe(false);
  });

  it('rejects context-package class structures hidden in arrays', async () => {
    let createCalled = false;
    const mockClient = {
      responses: {
        create: async () => {
          createCalled = true;
          return { output_text: JSON.stringify(validOutput()) };
        },
      },
    };

    const provider = new OpenAiProvider({ apiKey: 'sk-test', model: 'gpt-5.6-sol', timeoutMs: 1000 }, mockClient as any);
    const input = createInput();
    input.task.task_type = 'CONVERSATION_TIME_RANGE_ANALYSIS';
    input.prompt.user_payload = JSON.stringify({
      task: { task_type: 'CONVERSATION_TIME_RANGE_ANALYSIS' },
      patient_ref: { patient_id: 'patient-1' },
      analysis_request_input: { range_start: '2026-01-01T00:00:00.000Z', range_end: '2026-01-02T00:00:00.000Z' },
      conversation_context: { thread_id: 'thread-1', recent_messages: [] },
      selected_evidence: {
        summary: { total_events: 1 },
        nested: [
          {
            audit_item: {
              context_package_id: 'cp-1',
              context_package_version: 'context-package.v1',
              content_hash: 'sha256:cp-1',
            },
          },
        ],
      },
      provenance_summary: { source_refs: ['evt-1'], selection_policy_version: 'v1' },
      evidence_contract: { no_chain_of_thought: true },
    });

    await expect(provider.generate(input)).rejects.toMatchObject({
      code: 'AI_EVIDENCE_DELIVERY_VALIDATION_FAILED',
      retryable: false,
    });
    expect(createCalled).toBe(false);
  });

  it('rejects tool results carrying disguised source-class objects in arrays', async () => {
    let createCalled = false;
    const mockClient = {
      responses: {
        create: async () => {
          createCalled = true;
          return { output_text: JSON.stringify(validOutput()) };
        },
      },
    };

    const provider = new OpenAiProvider({ apiKey: 'sk-test', model: 'gpt-5.6-sol', timeoutMs: 1000 }, mockClient as any);
    const input = createInput();
    input.task.task_type = 'CONVERSATION_TIME_RANGE_ANALYSIS';
    input.prompt.user_payload = JSON.stringify({
      task: { task_type: 'CONVERSATION_TIME_RANGE_ANALYSIS' },
      patient_ref: { patient_id: 'patient-1' },
      analysis_request_input: { range_start: '2026-01-01T00:00:00.000Z', range_end: '2026-01-02T00:00:00.000Z' },
      conversation_context: { thread_id: 'thread-1', recent_messages: [] },
      selected_evidence: { summary: { total_events: 1 }, glucose: { count: 1 } },
      provenance_summary: { source_refs: ['evt-1'], selection_policy_version: 'v1' },
      evidence_contract: { no_chain_of_thought: true },
    });
    input.tool_runtime = {
      available_tools: [],
      tool_results: [
        {
          call_id: 'call-1',
          tool_name: 'get_glucose_evidence',
          result: {
            evidence: [
              {
                source_alias: {
                  sgv: 71,
                  date: 1791324226079,
                  type: 'sgv',
                },
              },
            ],
          },
        },
      ],
      max_tool_calls_remaining: 1,
    };

    await expect(provider.generate(input)).rejects.toMatchObject({
      code: 'AI_EVIDENCE_DELIVERY_VALIDATION_FAILED',
      retryable: false,
    });
    expect(createCalled).toBe(false);
  });

  it('maps timeout-like network error as retryable', async () => {
    const mockClient = {
      responses: {
        create: async () => {
          const error = new Error('timed out') as Error & { code: string };
          error.code = 'ETIMEDOUT';
          throw error;
        },
      },
    };

    const provider = new OpenAiProvider({ apiKey: 'sk-test' }, mockClient as any);
    await expect(provider.generate(createInput())).rejects.toMatchObject({ retryable: true });
  });

  it('maps rate limit as retryable', async () => {
    const mockClient = {
      responses: {
        create: async () => {
          throw { status: 429, message: 'rate limit' };
        },
      },
    };

    const provider = new OpenAiProvider({ apiKey: 'sk-test' }, mockClient as any);
    await expect(provider.generate(createInput())).rejects.toMatchObject({ retryable: true, code: 'rate_limit' });
  });

  it('maps server error as retryable', async () => {
    const mockClient = {
      responses: {
        create: async () => {
          throw { status: 503, message: 'upstream unavailable' };
        },
      },
    };

    const provider = new OpenAiProvider({ apiKey: 'sk-test' }, mockClient as any);
    await expect(provider.generate(createInput())).rejects.toMatchObject({ retryable: true });
  });

  it('maps authentication error as non-retryable', async () => {
    const mockClient = {
      responses: {
        create: async () => {
          throw { status: 401, type: 'invalid_request_error', code: 'invalid_api_key', message: 'bad key' };
        },
      },
    };

    const provider = new OpenAiProvider({ apiKey: 'sk-test' }, mockClient as any);
    await expect(provider.generate(createInput())).rejects.toMatchObject({
      retryable: false,
      httpStatus: 401,
      errorType: 'invalid_request_error',
      code: 'invalid_api_key',
      message: 'bad key',
      stage: 'PROVIDER_REQUEST',
    });
  });

  it('fails malformed structured response when JSON is invalid', async () => {
    const mockClient = {
      responses: {
        create: async () => ({ output_text: '{bad-json' }),
      },
    };

    const provider = new OpenAiProvider({ apiKey: 'sk-test' }, mockClient as any);
    await expect(provider.generate(createInput())).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE', retryable: false });
  });

  it('fails malformed structured response when no text payload exists', async () => {
    const mockClient = {
      responses: {
        create: async () => ({ output: [] }),
      },
    };

    const provider = new OpenAiProvider({ apiKey: 'sk-test' }, mockClient as any);
    await expect(provider.generate(createInput())).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE', retryable: false });
  });

  it('maps provider input to Responses API request shape', async () => {
    let requestBody: Record<string, unknown> | undefined;
    let requestOptions: Record<string, unknown> | undefined;

    const mockClient = {
      responses: {
        create: async (body: Record<string, unknown>, options?: Record<string, unknown>) => {
          requestBody = body;
          requestOptions = options;
          return { output_text: JSON.stringify(validOutput()) };
        },
      },
    };

    const provider = new OpenAiProvider({ apiKey: 'sk-test', model: 'gpt-5.6-luna', timeoutMs: 2345 }, mockClient as any);
    await provider.generate(createInput());

    expect(requestBody?.model).toBe('gpt-5.6-luna');
    expect(Array.isArray(requestBody?.input)).toBe(true);
    expect(requestBody?.text).toBeTruthy();
    expect(requestOptions?.timeout).toBe(2345);
  });

  it('sets parallel_tool_calls=false for conversation time range analysis', async () => {
    let requestBody: Record<string, unknown> | undefined;

    const mockClient = {
      responses: {
        create: async (body: Record<string, unknown>) => {
          requestBody = body;
          return {
            output_text: JSON.stringify({ assistant_message: 'ok' }),
          };
        },
      },
    };

    const provider = new OpenAiProvider({ apiKey: 'sk-test' }, mockClient as any);
    const input = createInput();

    input.prompt.user_payload = JSON.stringify({
      task: {
        task_type: 'CONVERSATION_TIME_RANGE_ANALYSIS',
        task_version: 'conversation-time-range.v1',
        prompt_version: 'conversation-time-range.v1',
        output_schema_version: 'conversation-time-range-analysis-output.v1',
        correlation_id: 'conv-1',
      },
      patient_ref: { patient_id: 'patient-1' },
      analysis_request_input: {
        range_start: '2026-01-01T00:00:00.000Z',
        range_end: '2026-01-02T00:00:00.000Z',
      },
      conversation_context: {
        thread_id: 'conv-1',
        recent_messages: [],
      },
      selected_evidence: {
        summary: { total_events: 1 },
      },
      provenance_summary: {
        source_refs: ['src-1'],
        selection_policy_version: 'conversation-time-range.v1',
      },
      evidence_contract: {
        use_only_observed_and_deterministic_data: true,
        never_invent_patient_specific_events_or_values: true,
        explicitly_mark_missing_or_unknown_sections: true,
        no_treatment_recommendations: true,
        no_therapy_adjustment_advice: true,
        no_insulin_dosing_guidance: true,
        no_chain_of_thought: true,
      },
    });

    await provider.generate({
      ...input,
      task: {
        ...input.task,
        task_type: 'CONVERSATION_TIME_RANGE_ANALYSIS',
      },
      prompt: {
        ...input.prompt,
        output_schema_version: 'conversation-time-range-analysis-output.v1',
      },
    });

    expect(requestBody?.parallel_tool_calls).toBe(false);
  });

  it('keeps the tools and sends tool_choice none on the forced final turn, and omits tool_choice otherwise', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const mockClient = {
      responses: {
        create: async (body: Record<string, unknown>) => {
          bodies.push(body);
          return { output_text: JSON.stringify(validOutput()) };
        },
      },
    };
    const provider = new OpenAiProvider({ apiKey: 'sk-test' }, mockClient as any);
    const tool = { name: 'get_glucose_evidence', description: 'desc', input_schema: { type: 'object', additionalProperties: false, properties: { detail_level: { type: 'string' } } } };
    await provider.generate({ ...createInput(), tool_runtime: { available_tools: [tool], tool_results: [], max_tool_calls_remaining: 3 } });
    await provider.generate({ ...createInput(), tool_runtime: { available_tools: [tool], tool_results: [], max_tool_calls_remaining: 0, tool_choice: 'none' } });

    expect(bodies[0]).not.toHaveProperty('tool_choice');
    expect(bodies[1].tool_choice).toBe('none');
    expect(bodies[1].tools).toEqual(bodies[0].tools);
  });

  it('requires top-level required keys in function parameter schemas for Responses API', async () => {
    let requestBody: Record<string, unknown> | undefined;

    const mockClient = {
      responses: {
        create: async (body: Record<string, unknown>) => {
          requestBody = body;
          return { output_text: JSON.stringify(validOutput()) };
        },
      },
    };

    const provider = new OpenAiProvider({ apiKey: 'sk-test' }, mockClient as any);
    await provider.generate({
      ...createInput(),
      tool_runtime: {
        available_tools: [
          {
            name: 'get_glucose_evidence',
            description: 'desc',
            input_schema: {
              type: 'object',
              additionalProperties: false,
              properties: {
                time_range: {
                  type: 'object',
                  properties: { from: { type: 'string' }, to: { type: 'string' } },
                  required: ['from', 'to'],
                },
                detail_level: { type: 'string', enum: ['SUMMARY', 'DETAIL'] },
              },
            },
          },
          {
            name: 'get_insulin_evidence',
            description: 'desc',
            input_schema: {
              type: 'object',
              additionalProperties: false,
              properties: {
                time_range: {
                  type: 'object',
                  properties: { from: { type: 'string' }, to: { type: 'string' } },
                  required: ['from', 'to'],
                },
                detail_level: { type: 'string', enum: ['SUMMARY', 'DETAIL'] },
              },
            },
          },
          {
            name: 'get_basal_evidence',
            description: 'desc',
            input_schema: {
              type: 'object',
              additionalProperties: false,
              properties: {
                time_range: {
                  type: 'object',
                  properties: { from: { type: 'string' }, to: { type: 'string' } },
                  required: ['from', 'to'],
                },
                detail_level: { type: 'string', enum: ['SUMMARY', 'DETAIL'] },
              },
            },
          },
        ],
        tool_results: [],
        max_tool_calls_remaining: 3,
      },
    });

    const tools = (requestBody?.tools ?? []) as Array<Record<string, unknown>>;
    expect(tools).toHaveLength(3);
    expect((tools[0].parameters as Record<string, unknown>).required).toEqual(['time_range', 'detail_level']);
    expect((tools[1].parameters as Record<string, unknown>).required).toEqual(['time_range', 'detail_level']);
    expect((tools[2].parameters as Record<string, unknown>).required).toEqual(['time_range', 'detail_level']);
  });

  it('returns provider-neutral tool call when OpenAI emits function_call output', async () => {
    const mockClient = {
      responses: {
        create: async () => ({
          id: 'resp_1',
          output: [
            {
              type: 'function_call',
              id: 'fc-1',
              call_id: 'fc-1',
              name: 'get_glucose_evidence',
              arguments: JSON.stringify({
                time_range: {
                  from: '2026-10-08T06:00:00.000Z',
                  to: '2026-10-08T07:00:00.000Z',
                },
                detail_level: 'DETAIL',
              }),
            },
          ],
        }),
      },
    };

    const provider = new OpenAiProvider({ apiKey: 'sk-test' }, mockClient as any);
    const result = await provider.generate({
      ...createInput(),
      tool_runtime: {
        available_tools: [
          {
            name: 'get_glucose_evidence',
            description: 'desc',
            input_schema: {
              type: 'object',
              additionalProperties: false,
              properties: {
                time_range: { type: 'object' },
              },
            },
          },
        ],
        tool_results: [],
        max_tool_calls_remaining: 1,
      },
    });

    expect(result.tool_call).toEqual({
      call_id: 'fc-1',
      tool_name: 'get_glucose_evidence',
      arguments: {
        time_range: {
          from: '2026-10-08T06:00:00.000Z',
          to: '2026-10-08T07:00:00.000Z',
        },
        detail_level: 'DETAIL',
      },
    });
    expect(result.response_id).toBe('resp_1');
    expect((result as Record<string, unknown>).output).toBeUndefined();
    expect(result.tool_calls).toEqual([result.tool_call]);
  });

  it('uses previous_response_id for second turn and preserves call_id in function_call_output', async () => {
    const requestBodies: Array<Record<string, unknown>> = [];
    const mockClient = {
      responses: {
        create: async (body: Record<string, unknown>) => {
          requestBodies.push(body);

          if (requestBodies.length === 1) {
            return {
              id: 'resp_first',
              output: [
                {
                  type: 'function_call',
                  id: 'fc-1',
                  call_id: 'call_1',
                  name: 'get_glucose_evidence',
                  arguments: JSON.stringify({
                    time_range: {
                      from: '2026-10-08T06:00:00.000Z',
                      to: '2026-10-08T07:00:00.000Z',
                    },
                    detail_level: 'DETAIL',
                  }),
                },
              ],
            };
          }

          return {
            id: 'resp_second',
            output_text: JSON.stringify(validOutput()),
          };
        },
      },
    };

    const provider = new OpenAiProvider({ apiKey: 'sk-test' }, mockClient as any);

    const first = await provider.generate({
      ...createInput(),
      tool_runtime: {
        available_tools: [
          {
            name: 'get_glucose_evidence',
            description: 'desc',
            input_schema: {
              type: 'object',
              additionalProperties: false,
              properties: {
                time_range: { type: 'object' },
                detail_level: { type: 'string' },
              },
              required: ['time_range', 'detail_level'],
            },
          },
        ],
        tool_results: [],
        max_tool_calls_remaining: 3,
      },
    });

    expect(first.response_id).toBe('resp_first');
    expect(first.tool_call?.call_id).toBe('call_1');

    await provider.generate({
      ...createInput(),
      previous_response_id: first.response_id,
      tool_runtime: {
        available_tools: [
          {
            name: 'get_glucose_evidence',
            description: 'desc',
            input_schema: {
              type: 'object',
              additionalProperties: false,
              properties: {
                time_range: { type: 'object' },
                detail_level: { type: 'string' },
              },
              required: ['time_range', 'detail_level'],
            },
          },
        ],
        tool_results: [
          {
            call_id: 'call_1',
            tool_name: 'get_glucose_evidence',
            result: { status: 'OK', evidence: [] },
          },
        ],
        max_tool_calls_remaining: 2,
      },
    });

    expect(requestBodies).toHaveLength(2);
    expect(requestBodies[1].previous_response_id).toBe('resp_first');

    const secondInput = requestBodies[1].input as Array<Record<string, unknown>>;
    const secondCallOutputs = secondInput.filter((item) => item.type === 'function_call_output');
    expect(secondCallOutputs).toHaveLength(1);
    expect(secondCallOutputs[0].call_id).toBe('call_1');

    const secondTools = requestBodies[1].tools as Array<Record<string, unknown>>;
    expect(secondTools).toHaveLength(1);
    expect(secondTools[0].name).toBe('get_glucose_evidence');
  });

  it('surfaces provider-side regression when function_call_output is sent without previous_response_id', async () => {
    const requestBodies: Array<Record<string, unknown>> = [];
    const mockClient = {
      responses: {
        create: async (body: Record<string, unknown>) => {
          requestBodies.push(body);

          if (requestBodies.length === 1) {
            return {
              id: 'resp_first',
              output: [
                {
                  type: 'function_call',
                  id: 'fc-1',
                  call_id: 'call_1',
                  name: 'get_glucose_evidence',
                  arguments: JSON.stringify({
                    time_range: {
                      from: '2026-10-08T06:00:00.000Z',
                      to: '2026-10-08T07:00:00.000Z',
                    },
                    detail_level: 'DETAIL',
                  }),
                },
              ],
            };
          }

          throw {
            status: 400,
            type: 'invalid_request_error',
            message: '400 No tool call found for function call output with call_id call_1.',
          };
        },
      },
    };

    const provider = new OpenAiProvider({ apiKey: 'sk-test' }, mockClient as any);

    const first = await provider.generate({
      ...createInput(),
      tool_runtime: {
        available_tools: [
          {
            name: 'get_glucose_evidence',
            description: 'desc',
            input_schema: {
              type: 'object',
              additionalProperties: false,
              properties: {
                time_range: { type: 'object' },
                detail_level: { type: 'string' },
              },
              required: ['time_range', 'detail_level'],
            },
          },
        ],
        tool_results: [],
        max_tool_calls_remaining: 3,
      },
    });

    await expect(provider.generate({
      ...createInput(),
      // Intentionally omit previous_response_id to verify regression behavior.
      tool_runtime: {
        available_tools: [
          {
            name: 'get_glucose_evidence',
            description: 'desc',
            input_schema: {
              type: 'object',
              additionalProperties: false,
              properties: {
                time_range: { type: 'object' },
                detail_level: { type: 'string' },
              },
              required: ['time_range', 'detail_level'],
            },
          },
        ],
        tool_results: [
          {
            call_id: first.tool_call?.call_id ?? 'call_1',
            tool_name: 'get_glucose_evidence',
            result: { status: 'OK', evidence: [] },
          },
        ],
        max_tool_calls_remaining: 2,
      },
    })).rejects.toMatchObject({
      name: 'AiProviderError',
      retryable: false,
      httpStatus: 400,
      errorType: 'invalid_request_error',
    } satisfies Partial<AiProviderError>);

    expect(requestBodies).toHaveLength(2);
    expect(requestBodies[1].previous_response_id).toBeUndefined();
    const secondInput = requestBodies[1].input as Array<Record<string, unknown>>;
    const secondCallOutputs = secondInput.filter((item) => item.type === 'function_call_output');
    expect(secondCallOutputs).toHaveLength(1);
    expect(secondCallOutputs[0].call_id).toBe('call_1');
  });

  it('returns all function calls when OpenAI emits batched tool calls', async () => {
    const mockClient = {
      responses: {
        create: async () => ({
          output: [
            {
              type: 'function_call',
              id: 'fc-1',
              call_id: 'fc-1',
              name: 'get_glucose_evidence',
              arguments: JSON.stringify({
                time_range: {
                  from: '2026-10-08T06:00:00.000Z',
                  to: '2026-10-08T07:00:00.000Z',
                },
                detail_level: 'DETAIL',
              }),
            },
            {
              type: 'function_call',
              id: 'fc-2',
              call_id: 'fc-2',
              name: 'get_insulin_evidence',
              arguments: JSON.stringify({
                time_range: {
                  from: '2026-10-08T06:00:00.000Z',
                  to: '2026-10-08T07:00:00.000Z',
                },
                detail_level: 'SUMMARY',
              }),
            },
          ],
        }),
      },
    };

    const provider = new OpenAiProvider({ apiKey: 'sk-test' }, mockClient as any);
    const result = await provider.generate({
      ...createInput(),
      tool_runtime: {
        available_tools: [
          {
            name: 'get_glucose_evidence',
            description: 'desc',
            input_schema: {
              type: 'object',
              additionalProperties: false,
              properties: {
                time_range: { type: 'object' },
              },
            },
          },
          {
            name: 'get_insulin_evidence',
            description: 'desc',
            input_schema: {
              type: 'object',
              additionalProperties: false,
              properties: {
                time_range: { type: 'object' },
              },
            },
          },
        ],
        tool_results: [],
        max_tool_calls_remaining: 3,
      },
    });

    expect(result.tool_call?.tool_name).toBe('get_glucose_evidence');
    expect(result.tool_calls?.map((entry) => entry.tool_name)).toEqual(['get_glucose_evidence', 'get_insulin_evidence']);
  });

  it('normalizes usage metadata and captures exact request identity', async () => {
    const mockClient = {
      responses: {
        create: async (body: Record<string, unknown>) => ({
          output_text: JSON.stringify(validOutput()),
          usage: {
            input_tokens: 128,
            output_tokens: 64,
            total_tokens: 192,
            input_tokens_details: { cached_tokens: 32 },
            output_tokens_details: { reasoning_tokens: 10 },
          },
          request_body: body,
        }),
      },
    };

    const provider = new OpenAiProvider({ apiKey: 'sk-test', model: 'gpt-5.6-obs', timeoutMs: 1000 }, mockClient as any);
    const result = await provider.generate(createInput());

    expect(result.usage).toEqual({
      input_tokens: 128,
      output_tokens: 64,
      total_tokens: 192,
      cached_input_tokens: 32,
      reasoning_tokens: 10,
    });
    expect(result.serialized_input_bytes).toBeGreaterThan(0);
    expect(result.input_fingerprint).toMatch(/^sha256:/);
  });

  it('computes estimated cost when explicit pricing config is provided', async () => {
    const mockClient = {
      responses: {
        create: async () => ({
          output_text: JSON.stringify(validOutput()),
          usage: {
            input_tokens: 1000,
            output_tokens: 500,
            total_tokens: 1500,
            input_tokens_details: { cached_tokens: 100 },
            output_tokens_details: { reasoning_tokens: 50 },
          },
        }),
      },
    };

    const provider = new OpenAiProvider({
      apiKey: 'sk-test',
      model: 'gpt-5.6-terra',
      pricing: {
        input_per_1k_tokens: 0.01,
        output_per_1k_tokens: 0.02,
        cached_input_per_1k_tokens: 0.005,
        reasoning_per_1k_tokens: 0.007,
        currency: 'USD',
        pricing_version: 'openai.gpt-5.6-terra.test-v1',
      },
    }, mockClient as any);

    const result = await provider.generate(createInput());

    expect(result.estimated_cost).toMatchObject({
      currency: 'USD',
      pricing_version: 'openai.gpt-5.6-terra.test-v1',
      output_cost: 0.01,
      cached_input_cost: 0.0005,
    });
    expect(result.estimated_cost?.reasoning_cost ?? 0).toBeCloseTo(0.00035, 12);
    // 900 uncached input tokens at the input price; the 100 cached ones only at the cached price.
    expect(result.estimated_cost?.input_cost).toBeCloseTo(0.009, 12);
    expect(result.estimated_cost?.estimated_cost).toBeCloseTo(0.01985, 12);
  });

  it('sanitizes API key from surfaced errors', async () => {
    const mockClient = {
      responses: {
        create: async () => {
          throw new Error('Unauthorized with key sk-secret-value');
        },
      },
    };

    const provider = new OpenAiProvider({ apiKey: 'sk-secret-value' }, mockClient as any);

    await expect(provider.generate(createInput())).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(AiProviderError);
      const message = (error as Error).message;
      expect(message).not.toContain('sk-secret-value');
      return true;
    });
  });

  it('uses default model when not configured', async () => {
    let usedModel = '';
    const mockClient = {
      responses: {
        create: async (body: Record<string, unknown>) => {
          usedModel = String(body.model ?? '');
          return { output_text: JSON.stringify(validOutput()) };
        },
      },
    };

    const provider = new OpenAiProvider({ apiKey: 'sk-test' }, mockClient as any);
    await provider.generate(createInput());
    expect(usedModel).toBe('gpt-5.6-terra');
  });
});

describe('provider error retryability', () => {
  it('retries timeouts, conflicts, rate limits and server errors, never a request refused as it is', async () => {
    const { mapOpenAiError } = await import('./openai-provider');
    const retryable = (status: number) => mapOpenAiError(Object.assign(new Error(`HTTP ${status}`), { status })).retryable;
    expect([400, 401, 403, 404, 413, 422].map(retryable)).toEqual([false, false, false, false, false, false]);
    expect([408, 409, 429, 500, 529].map(retryable)).toEqual([true, true, true, true, true]);
  });
});
