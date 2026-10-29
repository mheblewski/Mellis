import { describe, expect, it } from 'vitest';
import { buildAiInputHash, buildContextPackageIdentityHash, createConversationDirectResponseTask, createConversationTimeRangeAnalysisTask } from './ai-task';
import { selectOpenAiStructuredSchema } from '@modules/ai-gateway/infrastructure/openai-provider';
import { THERAPY_SUGGESTION_POLICY_VERSION } from './therapy-suggestion-policy';

const context = (overrides: Record<string, unknown> = {}) => ({
  context_package_id: 'cp-1',
  created_at: '2026-10-14T10:00:00.000Z',
  content_hash: '',
  analysis_request_input: { user_message_id: 'm-1', range_start: '2026-10-11T22:00:00.000Z', range_end: '2026-10-14T16:00:00.000Z' },
  analytical_evidence: { glucose_events: [{ event_id: 'g-1', occurred_at: '2026-10-13T09:00:00.000Z', payload: { glucose_value: 110 } }] },
  historical_evidence: {
    retrieval_run_id: 'run-a',
    retrieval_timestamp: '2026-10-14T10:00:01.000Z',
    selected_cases: [{ case_reference: { summary: 'similar meal' } }],
    provenance: { policy_version: 'historical-context.v1', retrieval_run_id: 'run-a', retrieval_timestamp: '2026-10-14T10:00:01.000Z' },
  },
  ...overrides,
});

describe('buildContextPackageIdentityHash', () => {
  it('is the same for two attempts that differ only in per-attempt metadata', () => {
    const first = context();
    const retry = context({
      created_at: '2026-10-14T10:05:00.000Z',
      content_hash: 'sha256:previous',
      historical_evidence: {
        retrieval_run_id: 'run-b',
        retrieval_timestamp: '2026-10-14T10:05:02.000Z',
        selected_cases: [{ case_reference: { summary: 'similar meal' } }],
        provenance: { policy_version: 'historical-context.v1', retrieval_run_id: 'run-b', retrieval_timestamp: '2026-10-14T10:05:02.000Z' },
      },
    });
    expect(buildContextPackageIdentityHash(retry)).toBe(buildContextPackageIdentityHash(first));
    // The plain input hash does change, which is why identities used to differ on every retry.
    expect(buildAiInputHash({ context_package: retry })).not.toBe(buildAiInputHash({ context_package: first }));
  });

  it('changes when clinical or historical content changes', () => {
    const base = buildContextPackageIdentityHash(context());
    expect(buildContextPackageIdentityHash(context({ analytical_evidence: { glucose_events: [{ event_id: 'g-1', occurred_at: '2026-10-13T09:00:00.000Z', payload: { glucose_value: 111 } }] } }))).not.toBe(base);
    expect(buildContextPackageIdentityHash(context({
      historical_evidence: { ...context().historical_evidence, selected_cases: [{ case_reference: { summary: 'different meal' } }] },
    }))).not.toBe(base);
    expect(buildContextPackageIdentityHash(context({ historical_evidence: null }))).not.toBe(base);
  });

  it('treats a missing and a null historical_evidence alike', () => {
    const { historical_evidence: _history, ...withoutHistory } = context();
    expect(buildContextPackageIdentityHash(withoutHistory)).toBe(buildContextPackageIdentityHash(context({ historical_evidence: null })));
  });
});

describe('task versions', () => {
  it('name the real output schema, prompt and model routing policy instead of placeholder labels', () => {
    const args = { task_id: 't', context_package_id: 'cp', context_package_version: 'v', context_package_hash: 'h', correlation_id: 'c', created_at: '2026-10-21T10:00:00.000Z' };
    const direct = createConversationDirectResponseTask(args);
    const timeRange = createConversationTimeRangeAnalysisTask(args);
    expect(direct.output_schema_version).toBe(selectOpenAiStructuredSchema(direct.task_type).name);
    expect(timeRange.output_schema_version).toBe(selectOpenAiStructuredSchema(timeRange.task_type).name);
    expect(timeRange.prompt_version).toContain(THERAPY_SUGGESTION_POLICY_VERSION);
    for (const task of [direct, timeRange]) {
      expect(task.model_policy_version).toBe('model-tier-routing.v1');
      expect(task.prompt_version).toMatch(/-prompt\.v\d/);
    }
  });
});
