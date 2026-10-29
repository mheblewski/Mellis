import { describe, expect, it } from 'vitest';
import type { AiProviderInput, AiProviderResponse } from '@modules/ai-gateway/domain/ai-gateway';
import { createTimeRangeQualityCostFixtures } from '@modules/ai-gateway/evaluation/time-range-quality-cost-experiment';
import type { OpenAiProvider } from '@modules/ai-gateway/infrastructure/openai-provider';
import { runBatched } from './run-live-time-range-quality-cost';

describe('runBatched continuation', () => {
  it('uses turn-1 function_call call_id values and previous_response_id on turn 2', async () => {
    const fixture = createTimeRangeQualityCostFixtures().find((entry) => entry.fixture_id === 'fixture-progressive-valuable-v2');
    expect(fixture).toBeTruthy();

    const capturedInputs: AiProviderInput[] = [];
    const fakeProvider = {
      async generate(input: AiProviderInput): Promise<AiProviderResponse> {
        capturedInputs.push(input);

        if (capturedInputs.length === 1) {
          return {
            provider: 'openai',
            model: 'gpt-5.6-terra',
            response_id: 'resp_turn_1',
            raw_output: {},
            tool_calls: [
              {
                call_id: 'call_g',
                tool_name: 'get_glucose_evidence',
                arguments: {
                  time_range: {
                    from: '2026-10-08T09:00:00.000Z',
                    to: '2026-10-08T10:00:00.000Z',
                  },
                  detail_level: 'TRAJECTORY',
                },
              },
              {
                call_id: 'call_i',
                tool_name: 'get_insulin_evidence',
                arguments: {
                  time_range: {
                    from: '2026-10-08T09:00:00.000Z',
                    to: '2026-10-08T10:00:00.000Z',
                  },
                  detail_level: 'DETAIL',
                },
              },
              {
                call_id: 'call_b',
                tool_name: 'get_basal_evidence',
                arguments: {
                  time_range: {
                    from: '2026-10-08T09:00:00.000Z',
                    to: '2026-10-08T10:00:00.000Z',
                  },
                  detail_level: 'DETAIL',
                },
              },
            ],
            tool_call: null,
            received_at: '2026-10-08T00:00:00.000Z',
            usage: {
              input_tokens: 100,
              output_tokens: 50,
              total_tokens: 150,
              cached_input_tokens: 10,
              reasoning_tokens: 20,
            },
            estimated_cost: {
              estimated_cost: 0.001,
              currency: 'USD',
              pricing_version: 'test',
              input_cost: 0.0006,
              output_cost: 0.0004,
              cached_input_cost: 0,
              reasoning_cost: 0,
            },
            diagnostics: {
              response_id: 'resp_turn_1',
              output_item_types: ['reasoning', 'function_call', 'function_call', 'function_call'],
              function_call_names: ['get_glucose_evidence', 'get_insulin_evidence', 'get_basal_evidence'],
              function_call_arguments: [],
              function_call_count: 3,
              has_output_text: false,
              http_status: null,
              error_name: null,
              error_type: null,
              error_code: null,
              error_message: null,
              retryable: null,
              stage: 'PROVIDER_RESPONSE',
            },
          };
        }

        return {
          provider: 'openai',
          model: 'gpt-5.6-terra',
          response_id: 'resp_turn_2',
          raw_output: {
            assistant_message: 'final answer',
          },
          received_at: '2026-10-08T00:00:01.000Z',
          usage: {
            input_tokens: 200,
            output_tokens: 60,
            total_tokens: 260,
            cached_input_tokens: 20,
            reasoning_tokens: 30,
          },
          estimated_cost: {
            estimated_cost: 0.002,
            currency: 'USD',
            pricing_version: 'test',
            input_cost: 0.001,
            output_cost: 0.001,
            cached_input_cost: 0,
            reasoning_cost: 0,
          },
          diagnostics: {
            response_id: 'resp_turn_2',
            output_item_types: ['reasoning', 'message'],
            function_call_names: [],
            function_call_arguments: [],
            function_call_count: 0,
            has_output_text: true,
            http_status: null,
            error_name: null,
            error_type: null,
            error_code: null,
            error_message: null,
            retryable: null,
            stage: 'PROVIDER_RESPONSE',
          },
        };
      },
    };

    const result = await runBatched({
      fixture: fixture!,
      runNumber: 1,
      provider: fakeProvider as unknown as OpenAiProvider,
    });

    expect(capturedInputs).toHaveLength(2);

    const turnOneInput = capturedInputs[0];
    const turnTwoInput = capturedInputs[1];

    expect(turnOneInput.previous_response_id).toBeNull();
    expect(turnOneInput.tool_runtime?.tool_results).toHaveLength(0);
    expect(turnOneInput.tool_runtime?.available_tools.map((tool) => tool.name)).toEqual([
      'get_glucose_evidence',
      'get_insulin_evidence',
      'get_basal_evidence',
    ]);

    expect(turnTwoInput.previous_response_id).toBe('resp_turn_1');
    expect(turnTwoInput.tool_runtime?.available_tools).toEqual([]);
    expect(turnTwoInput.tool_runtime?.tool_results.map((result) => result.call_id)).toEqual([
      'call_g',
      'call_i',
      'call_b',
    ]);
    expect(turnTwoInput.tool_runtime?.tool_results.map((result) => result.tool_name)).toEqual([
      'get_glucose_evidence',
      'get_insulin_evidence',
      'get_basal_evidence',
    ]);

    expect(result.status).toBe('COMPLETED');
    expect(result.provider_call_count).toBe(2);
    expect(result.tool_calls).toHaveLength(3);
    expect(result.tool_calls.map((entry) => entry.refinement_kind)).toEqual(['INITIAL', 'INITIAL', 'INITIAL']);
  });
});
