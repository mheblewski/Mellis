import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { resolveEvalArtifactPath, writeEvalArtifact } from '@modules/ai-gateway/evaluation/eval-artifact-output';
import { AiGatewayService } from './ai-gateway.service';
import { createConversationTimeRangeAnalysisTask } from './ai-task';
import { AiProvider, AiProviderInput, AiProviderResponse, TimeRangeAnalysisContextRecord } from '@modules/ai-gateway/domain/ai-gateway';

interface CapturedProviderCall {
  call_number: number;
  serialized_bytes: number;
  input_fingerprint: string;
  requested_tools: string[];
  delivered_tool_results: Array<{
    call_id: string;
    tool_name: string;
    result_hash: string;
    result_bytes: number;
  }>;
}

interface ScenarioRun {
  name: string;
  provider_call_count: number;
  calls: CapturedProviderCall[];
  tool_call_audit_count: number;
  retransmission: {
    unique_result_bytes: number;
    transmitted_result_bytes: number;
    duplicated_bytes: number;
    retransmission_ratio: number;
    per_result: Array<{
      key: string;
      tool_name: string;
      first_call: number;
      last_call: number;
      delivery_count: number;
      result_bytes: number;
      transmitted_bytes: number;
    }>;
  };
}

class ScriptedProvider implements AiProvider {
  readonly capturedInputs: AiProviderInput[] = [];

  constructor(private readonly step: (callNumber: number, input: AiProviderInput) => AiProviderResponse) {}

  async generate(input: AiProviderInput): Promise<AiProviderResponse> {
    const snapshot = JSON.parse(JSON.stringify(input)) as AiProviderInput;
    this.capturedInputs.push(snapshot);
    return this.step(this.capturedInputs.length, snapshot);
  }
}

function hashValue(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function captureProviderCalls(inputs: AiProviderInput[]): CapturedProviderCall[] {
  return inputs.map((input, index) => {
    const serialized = JSON.stringify(input);
    const toolResults = input.tool_runtime?.tool_results ?? [];
    return {
      call_number: index + 1,
      serialized_bytes: Buffer.byteLength(serialized, 'utf8'),
      input_fingerprint: hashValue(input),
      requested_tools: (input.tool_runtime?.available_tools ?? []).map((tool) => tool.name),
      delivered_tool_results: toolResults.map((toolResult) => {
        const normalizedResult = toolResult.result as Record<string, unknown>;
        const resultHash = typeof normalizedResult.content_hash === 'string'
          ? normalizedResult.content_hash
          : hashValue(normalizedResult);
        return {
          call_id: toolResult.call_id,
          tool_name: toolResult.tool_name,
          result_hash: resultHash,
          result_bytes: Buffer.byteLength(JSON.stringify(normalizedResult), 'utf8'),
        };
      }),
    };
  });
}

function computeRetransmission(calls: CapturedProviderCall[]): ScenarioRun['retransmission'] {
  type Presence = {
    key: string;
    tool_name: string;
    result_bytes: number;
    call_numbers: number[];
  };

  const map = new Map<string, Presence>();
  let transmittedResultBytes = 0;

  for (const call of calls) {
    for (const result of call.delivered_tool_results) {
      transmittedResultBytes += result.result_bytes;
      const key = `${result.tool_name}:${result.result_hash}`;
      const existing = map.get(key);
      if (existing) {
        existing.call_numbers.push(call.call_number);
      } else {
        map.set(key, {
          key,
          tool_name: result.tool_name,
          result_bytes: result.result_bytes,
          call_numbers: [call.call_number],
        });
      }
    }
  }

  const perResult = Array.from(map.values()).map((entry) => {
    const firstCall = Math.min(...entry.call_numbers);
    const lastCall = Math.max(...entry.call_numbers);
    const deliveryCount = entry.call_numbers.length;
    return {
      key: entry.key,
      tool_name: entry.tool_name,
      first_call: firstCall,
      last_call: lastCall,
      delivery_count: deliveryCount,
      result_bytes: entry.result_bytes,
      transmitted_bytes: entry.result_bytes * deliveryCount,
    };
  });

  const uniqueResultBytes = perResult.reduce((sum, entry) => sum + entry.result_bytes, 0);
  const duplicatedBytes = transmittedResultBytes - uniqueResultBytes;
  const retransmissionRatio = transmittedResultBytes > 0 ? duplicatedBytes / transmittedResultBytes : 0;

  return {
    unique_result_bytes: uniqueResultBytes,
    transmitted_result_bytes: transmittedResultBytes,
    duplicated_bytes: duplicatedBytes,
    retransmission_ratio: Number(retransmissionRatio.toFixed(6)),
    per_result: perResult,
  };
}

// recent_insulin is read by AiGatewayService (known_treatment_events) but is not part of TimeRangeAnalysisContextRecord.
type ForensicTimeRangeContext = TimeRangeAnalysisContextRecord & {
  current_state_snapshot: NonNullable<TimeRangeAnalysisContextRecord['current_state_snapshot']> & { recent_insulin: Array<Record<string, unknown>> };
};

function createForensicTimeRangeContext(): ForensicTimeRangeContext {
  return {
    context_package_id: 'tr-forensic-1',
    context_package_version: 'conversation-time-range-context.v1',
    content_hash: 'sha256:tr-forensic-1',
    created_at: '2026-10-08T10:00:00.000Z',
    patient_ref: { patient_id: 'patient-1' },
    analysis_request_input: {
      user_message_id: 'msg-forensic-1',
      user_message_text: 'Przeanalizuj mi dzisiejszy dzień krok po kroku',
      range_type: 'TODAY',
      timezone: 'Europe/Warsaw',
      range_start: '2026-10-08T00:00:00.000Z',
      range_end: '2026-10-08T23:59:59.999Z',
      requested_at: '2026-10-08T10:00:00.000Z',
    },
    conversation_context: {
      thread_id: 'conv-forensic-1',
      thread_state_version: 'conv-forensic-v1',
      awaiting_user_answer: false,
      messages: [],
    },
    current_state_snapshot: {
      as_of: '2026-10-08T10:00:00.000Z',
      current_glucose: 142,
      trend: 'FLAT',
      iob: 1.9,
      recent_insulin: [
        {
          event_id: 'ins-temp-0',
          kind: 'TEMP_BASAL',
          occurred_at: '2026-10-08T09:40:00.000Z',
          duration_minutes: 30,
          rate: 0.55,
          provenance_ref: 'source-record/temp-0',
        },
      ],
    },
    analytical_evidence: {
      glucose_events: [
        { event_id: 'g-1', occurred_at: '2026-10-08T06:00:00.000Z', payload: { glucose_value: 91 }, provenance_ref: 'source-record/g-1' },
        { event_id: 'g-2', occurred_at: '2026-10-08T07:00:00.000Z', payload: { glucose_value: 122 }, provenance_ref: 'source-record/g-2' },
        { event_id: 'g-3', occurred_at: '2026-10-08T08:00:00.000Z', payload: { glucose_value: 158 }, provenance_ref: 'source-record/g-3' },
      ],
      insulin_treatment_events: [
        {
          event_id: 'ins-bolus-1',
          occurred_at: '2026-10-08T06:45:00.000Z',
          kind: 'BOLUS',
          amount: 2.2,
          unit: 'U',
          provenance_ref: 'source-record/ins-bolus-1',
        },
        {
          event_id: 'ins-temp-1',
          occurred_at: '2026-10-08T08:15:00.000Z',
          kind: 'TEMP_BASAL',
          rate: 0.7,
          duration_minutes: 45,
          unit: 'U/h',
          provenance_ref: 'source-record/ins-temp-1',
        },
      ],
      meal_events: [
        {
          event_id: 'meal-1',
          occurred_at: '2026-10-08T06:40:00.000Z',
          payload: { carbs_grams: 18 },
          provenance_ref: 'source-record/meal-1',
        },
      ],
      activity_events: [],
      hypo_episodes: [],
      range_event_facts: [],
      summaries: {
        total_events: 6,
        glucose_count: 3,
        insulin_treatment_count: 2,
        meal_count: 1,
        activity_count: 0,
        hypo_episode_count: 0,
        glucose_min: 91,
        glucose_max: 158,
        glucose_avg: 123,
        missing_sections: ['activity_events'],
      },
    },
    provenance: {
      source_refs: ['msg-forensic-1'],
      selection_policy_version: 'conversation-time-range-selector.v1',
    },
  };
}

function createForensicTask(contextPackage: TimeRangeAnalysisContextRecord) {
  return createConversationTimeRangeAnalysisTask({
    task_id: 'time-range-forensic-task-1',
    context_package_id: String(contextPackage.context_package_id),
    context_package_version: String(contextPackage.context_package_version),
    context_package_hash: String(contextPackage.content_hash),
    correlation_id: 'conv-forensic-1',
    created_at: '2026-10-08T10:00:00.000Z',
    patient_id: 'patient-1',
  });
}

async function runScenario(args: {
  name: string;
  providerScript: (callNumber: number) => AiProviderResponse;
}): Promise<ScenarioRun> {
  const contextPackage = createForensicTimeRangeContext();
  const task = createForensicTask(contextPackage);
  const provider = new ScriptedProvider((callNumber) => args.providerScript(callNumber));
  const gateway = new AiGatewayService(provider);

  const previousMainFlag = process.env.AI_ENABLE_TIME_RANGE_GLUCOSE_TOOL_CALLING;
  process.env.AI_ENABLE_TIME_RANGE_GLUCOSE_TOOL_CALLING = '1';

  try {
    const execution = await gateway.execute({ task, context_package: contextPackage, timeout_ms: 2000 });
    const calls = captureProviderCalls(provider.capturedInputs);
    const retransmission = computeRetransmission(calls);

    return {
      name: args.name,
      provider_call_count: calls.length,
      calls,
      tool_call_audit_count: execution.metadata.evidence_tool_calls?.length ?? 0,
      retransmission,
    };
  } finally {
    if (previousMainFlag === undefined) {
      delete process.env.AI_ENABLE_TIME_RANGE_GLUCOSE_TOOL_CALLING;
    } else {
      process.env.AI_ENABLE_TIME_RANGE_GLUCOSE_TOOL_CALLING = previousMainFlag;
    }
  }
}

function toMarkdown(report: {
  generated_at: string;
  baseline: ScenarioRun;
  sequential: ScenarioRun;
  batched: ScenarioRun;
  answers: Array<{ question: string; answer: string }>;
}): string {
  const lines: string[] = [];
  lines.push('# Evidence Retransmission Forensic Report');
  lines.push('');
  lines.push(`generated_at: ${report.generated_at}`);
  lines.push('');
  lines.push('## 1) CURRENT BASELINE');
  lines.push(`- scenario: ${report.baseline.name}`);
  lines.push(`- provider_call_count: ${report.baseline.provider_call_count}`);
  lines.push(`- tool_call_audit_count: ${report.baseline.tool_call_audit_count}`);
  lines.push(`- retransmission_ratio: ${report.baseline.retransmission.retransmission_ratio}`);
  lines.push('');
  lines.push('## 2) MULTI-STEP TRACE');
  lines.push('### Sequential (glucose -> insulin -> basal -> final)');
  for (const call of report.sequential.calls) {
    lines.push(`- call #${call.call_number}: bytes=${call.serialized_bytes}, delivered_results=${call.delivered_tool_results.map((entry) => `${entry.tool_name}@${entry.result_hash.slice(0, 16)}`).join(', ') || 'none'}`);
  }
  lines.push('### Batched (glucose+insulin+basal -> final)');
  for (const call of report.batched.calls) {
    lines.push(`- call #${call.call_number}: bytes=${call.serialized_bytes}, delivered_results=${call.delivered_tool_results.map((entry) => `${entry.tool_name}@${entry.result_hash.slice(0, 16)}`).join(', ') || 'none'}`);
  }
  lines.push('');
  lines.push('## 3) PROVIDER REQUEST ANALYSIS');
  for (const answer of report.answers) {
    lines.push(`- ${answer.question}: ${answer.answer}`);
  }
  lines.push('');
  lines.push('## 4) EVIDENCE RETRANSMISSION');
  lines.push(`- sequential unique_result_bytes: ${report.sequential.retransmission.unique_result_bytes}`);
  lines.push(`- sequential transmitted_result_bytes: ${report.sequential.retransmission.transmitted_result_bytes}`);
  lines.push(`- sequential duplicated_bytes: ${report.sequential.retransmission.duplicated_bytes}`);
  lines.push(`- sequential retransmission_ratio: ${report.sequential.retransmission.retransmission_ratio}`);
  for (const entry of report.sequential.retransmission.per_result) {
    lines.push(`- sequential ${entry.key}: first_call=${entry.first_call}, last_call=${entry.last_call}, deliveries=${entry.delivery_count}, bytes=${entry.result_bytes}, transmitted=${entry.transmitted_bytes}`);
  }
  lines.push('');
  lines.push('## 5) SEQUENTIAL VS BATCHED COMPARISON');
  lines.push(`- sequential transmitted_result_bytes: ${report.sequential.retransmission.transmitted_result_bytes}`);
  lines.push(`- batched transmitted_result_bytes: ${report.batched.retransmission.transmitted_result_bytes}`);
  lines.push(`- sequential duplicated_bytes: ${report.sequential.retransmission.duplicated_bytes}`);
  lines.push(`- batched duplicated_bytes: ${report.batched.retransmission.duplicated_bytes}`);
  lines.push('');
  lines.push('## 6) TOKEN/BYTE/COST IMPACT');
  lines.push(`- sequential provider_calls: ${report.sequential.provider_call_count}`);
  lines.push(`- batched provider_calls: ${report.batched.provider_call_count}`);
  lines.push(`- sequential total_provider_input_bytes: ${report.sequential.calls.reduce((sum, call) => sum + call.serialized_bytes, 0)}`);
  lines.push(`- batched total_provider_input_bytes: ${report.batched.calls.reduce((sum, call) => sum + call.serialized_bytes, 0)}`);
  lines.push('- cost implication: with usage-based pricing, repeated tool_result payload replay increases input tokens and therefore cost.');
  lines.push('');
  lines.push('## 7) ARCHITECTURAL IMPLICATIONS');
  lines.push('- Current provider-neutral contract resends full tool_results history on every subsequent provider call.');
  lines.push('- This is safe and deterministic but scales poorly when tool outputs are large and tool count increases.');
  lines.push('- Request identity hashes remain deterministic, enabling auditable byte-level retransmission accounting.');
  lines.push('');
  lines.push('## 8) RECOMMENDED NEXT STEP');
  lines.push('- Preserve current behavior until Evidence Session is introduced; use this baseline as the control dataset for that follow-up change.');

  return `${lines.join('\n')}\n`;
}

describe('evidence retransmission forensic', () => {
  it('measures actual provider input retransmission across baseline, sequential, and batched loops', async () => {
    const baseline = await runScenario({
      name: 'current-single-tool-baseline',
      providerScript: (callNumber) => {
        if (callNumber === 1) {
          return {
            provider: 'fake',
            model: 'deterministic-time-range-forensic-v1',
            received_at: new Date().toISOString(),
            raw_output: {},
            tool_call: {
              call_id: 'baseline-call-1',
              tool_name: 'get_glucose_evidence',
              arguments: {
                time_range: {
                  from: '2026-10-08T06:00:00.000Z',
                  to: '2026-10-08T09:00:00.000Z',
                },
                detail_level: 'DETAIL',
              },
            },
          };
        }

        return {
          provider: 'fake',
          model: 'deterministic-time-range-forensic-v1',
          received_at: new Date().toISOString(),
          raw_output: { assistant_message: 'Baseline complete.' },
        };
      },
    });

    const sequential = await runScenario({
      name: 'diagnostic-sequential-multi-step',
      providerScript: (callNumber) => {
        if (callNumber === 1) {
          return {
            provider: 'fake',
            model: 'deterministic-time-range-forensic-v1',
            received_at: new Date().toISOString(),
            raw_output: {},
            tool_call: {
              call_id: 'seq-call-1',
              tool_name: 'get_glucose_evidence',
              arguments: {
                time_range: {
                  from: '2026-10-08T06:00:00.000Z',
                  to: '2026-10-08T09:00:00.000Z',
                },
                detail_level: 'DETAIL',
              },
            },
          };
        }

        if (callNumber === 2) {
          return {
            provider: 'fake',
            model: 'deterministic-time-range-forensic-v1',
            received_at: new Date().toISOString(),
            raw_output: {},
            tool_call: {
              call_id: 'seq-call-2',
              tool_name: 'get_insulin_evidence',
              arguments: {
                time_range: {
                  from: '2026-10-08T06:00:00.000Z',
                  to: '2026-10-08T09:00:00.000Z',
                },
                detail_level: 'DETAIL',
              },
            },
          };
        }

        if (callNumber === 3) {
          return {
            provider: 'fake',
            model: 'deterministic-time-range-forensic-v1',
            received_at: new Date().toISOString(),
            raw_output: {},
            tool_call: {
              call_id: 'seq-call-3',
              tool_name: 'get_basal_evidence',
              arguments: {
                time_range: {
                  from: '2026-10-08T06:00:00.000Z',
                  to: '2026-10-08T09:00:00.000Z',
                },
                detail_level: 'DETAIL',
              },
            },
          };
        }

        return {
          provider: 'fake',
          model: 'deterministic-time-range-forensic-v1',
          received_at: new Date().toISOString(),
          raw_output: { assistant_message: 'Sequential complete.' },
        };
      },
    });

    const batched = await runScenario({
      name: 'diagnostic-batched-multi-step',
      providerScript: (callNumber) => {
        if (callNumber === 1) {
          return {
            provider: 'fake',
            model: 'deterministic-time-range-forensic-v1',
            received_at: new Date().toISOString(),
            raw_output: {},
            tool_calls: [
              {
                call_id: 'batch-call-1',
                tool_name: 'get_glucose_evidence',
                arguments: {
                  time_range: {
                    from: '2026-10-08T06:00:00.000Z',
                    to: '2026-10-08T09:00:00.000Z',
                  },
                  detail_level: 'DETAIL',
                },
              },
              {
                call_id: 'batch-call-2',
                tool_name: 'get_insulin_evidence',
                arguments: {
                  time_range: {
                    from: '2026-10-08T06:00:00.000Z',
                    to: '2026-10-08T09:00:00.000Z',
                  },
                  detail_level: 'DETAIL',
                },
              },
              {
                call_id: 'batch-call-3',
                tool_name: 'get_basal_evidence',
                arguments: {
                  time_range: {
                    from: '2026-10-08T06:00:00.000Z',
                    to: '2026-10-08T09:00:00.000Z',
                  },
                  detail_level: 'DETAIL',
                },
              },
            ],
          };
        }

        return {
          provider: 'fake',
          model: 'deterministic-time-range-forensic-v1',
          received_at: new Date().toISOString(),
          raw_output: { assistant_message: 'Batched complete.' },
        };
      },
    });

    expect(baseline.provider_call_count).toBe(2);
    expect(sequential.provider_call_count).toBe(4);
    expect(batched.provider_call_count).toBe(2);

    expect(sequential.retransmission.duplicated_bytes).toBeGreaterThan(0);
    expect(sequential.retransmission.retransmission_ratio).toBeGreaterThan(0);
    expect(batched.retransmission.duplicated_bytes).toBeGreaterThanOrEqual(0);
    expect(batched.retransmission.duplicated_bytes).toBeLessThan(sequential.retransmission.duplicated_bytes);
    expect(sequential.retransmission.transmitted_result_bytes).toBeGreaterThan(batched.retransmission.transmitted_result_bytes);

    const providerRequestAnswers = [
      {
        question: 'Q1 Does call #N resend prior tool results?',
        answer: 'Yes. Each next provider call includes all accumulated tool_results in tool_runtime.',
      },
      {
        question: 'Q2 Is replay bounded by tool call budget?',
        answer: 'Yes. Loop budget is max 3 tool calls, enforced before each execution.',
      },
      {
        question: 'Q3 Is replay provider-neutral or OpenAI-specific?',
        answer: 'Provider-neutral in ai-gateway contracts; OpenAI adapter serializes that input.',
      },
      {
        question: 'Q4 Is initial evidence package re-sent each call?',
        answer: 'Yes. The same task/context/prompt payload is passed on each provider generate() call.',
      },
      {
        question: 'Q5 Are tool results appended or replaced?',
        answer: 'Appended. providerToolResults grows monotonically and is passed as-is each iteration.',
      },
      {
        question: 'Q6 Can current abstraction avoid replay by response-id continuation?',
        answer: 'No. Current provider-neutral contract has no continuation token or prior-response reference.',
      },
      {
        question: 'Q7 Are retransmission bytes directly measurable at boundary?',
        answer: 'Yes. This report captures exact serialized provider input per call and per-result payload bytes.',
      },
      {
        question: 'Q8 Does batching multiple tool calls reduce replay duplication?',
        answer: 'Yes. Batched mode delivers each tool result once before final answer.',
      },
      {
        question: 'Q9 Is production behavior changed for non-diagnostic runtime?',
        answer: 'No. Sequential and batched runs use the production tool definitions; only the scripted provider differs.',
      },
    ];

    const report = {
      generated_at: new Date().toISOString(),
      baseline,
      sequential,
      batched,
      answers: providerRequestAnswers,
    };

    const markdown = toMarkdown(report);
    writeEvalArtifact(resolveEvalArtifactPath('evidence-retransmission-forensic-baseline.json'), `${JSON.stringify(report, null, 2)}\n`);
    writeEvalArtifact(resolveEvalArtifactPath('evidence-retransmission-forensic-baseline.md'), markdown);

    expect(report.sequential.calls.map((call) => call.call_number)).toEqual([1, 2, 3, 4]);
    expect(report.batched.calls.map((call) => call.call_number)).toEqual([1, 2]);
  });
});
