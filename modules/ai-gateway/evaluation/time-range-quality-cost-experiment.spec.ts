import { describe, expect, it } from 'vitest';
import type { AiProvider, AiProviderInput, AiProviderResponse } from '@modules/ai-gateway/domain/ai-gateway';
import {
  createHistoryComparisonScenarios,
  runHistoryEvidenceComparisonExperiment,
  runHistoryEvidenceComparisonScenario,
  type HistoryComparisonScenario,
} from './time-range-quality-cost-experiment';
import { runTimeRangeQualityCostExperiment } from './time-range-quality-cost-experiment';
import { resolveEvalArtifactPath } from './eval-artifact-output';

class ProviderBackedMessageTestDouble implements AiProvider {
  readonly history_evaluation_provider_kind = 'test' as const;
  readonly history_evaluation_real_model_used = false as const;

  async generate(input: AiProviderInput): Promise<AiProviderResponse> {
    return {
      provider: 'provider-backed-message-test-double',
      model: 'provider-backed-message-model',
      raw_output: {
        assistant_message: `provider-result:${input.task.task_id}`,
      },
      usage: null,
      estimated_cost: null,
      received_at: new Date().toISOString(),
    };
  }
}

class FailOnHistoryOnProviderTestDouble implements AiProvider {
  readonly history_evaluation_provider_kind = 'test' as const;
  readonly history_evaluation_real_model_used = false as const;

  async generate(input: AiProviderInput): Promise<AiProviderResponse> {
    const payload = JSON.parse(input.prompt.user_payload) as Record<string, unknown>;
    if (payload.historical_evidence) {
      throw new Error('forced history_on failure');
    }

    return {
      provider: 'fail-on-history-on-test-double',
      model: 'fail-on-history-on-model',
      raw_output: {
        assistant_message: `provider-result:${input.task.task_id}`,
      },
      usage: null,
      estimated_cost: null,
      received_at: new Date().toISOString(),
    };
  }
}

class UnknownOriginProviderTestDouble implements AiProvider {
  async generate(): Promise<AiProviderResponse> {
    return {
      provider: 'unknown-origin-provider',
      model: 'unknown-origin-model',
      raw_output: {
        assistant_message: 'unknown provenance provider response',
      },
      usage: null,
      estimated_cost: null,
      received_at: new Date().toISOString(),
    };
  }
}

class PairwiseDeltaProviderTestDouble implements AiProvider {
  readonly history_evaluation_provider_kind = 'test' as const;
  readonly history_evaluation_real_model_used = false as const;

  async generate(input: AiProviderInput): Promise<AiProviderResponse> {
    const payload = JSON.parse(input.prompt.user_payload) as Record<string, unknown>;
    const hasHistory = Boolean(payload.historical_evidence);

    const off = [
      'Meal macro composition is not treated as zero values.',
      'Insulin timing may contribute, but attribution to a single meal is not confirmed.',
      'Later meals and confounding factors are considered in interpretation.',
    ].join(' ');

    const on = [
      'Prior similar patterns were considered as supplemental clinical context.',
      'Meal macro composition is not treated as zero values.',
      'Unknowns remain explicitly unknown with provenance-aware framing.',
      'Later meals and confounding factors are considered in interpretation.',
      'definitive insulin cause',
    ].join(' ');

    return {
      provider: 'pairwise-delta-provider',
      model: 'pairwise-delta-model',
      raw_output: {
        assistant_message: hasHistory ? on : off,
      },
      usage: null,
      estimated_cost: null,
      received_at: new Date().toISOString(),
    };
  }
}

class MultiCallProviderTestDouble implements AiProvider {
  readonly history_evaluation_provider_kind = 'test' as const;
  readonly history_evaluation_real_model_used = false as const;

  async generate(input: AiProviderInput): Promise<AiProviderResponse> {
    const priorToolResults = input.tool_runtime?.tool_results ?? [];
    if (priorToolResults.length === 0) {
      return {
        provider: 'multi-call-provider',
        model: 'multi-call-provider-model',
        raw_output: {},
        tool_call: {
          call_id: `call-${input.task.task_id}`,
          tool_name: 'get_glucose_evidence',
          arguments: {
            time_range: { from: '2026-10-08T09:00:00.000Z', to: '2026-10-08T12:30:00.000Z' },
            detail_level: 'DETAIL',
          },
        },
        tool_calls: [
          {
            call_id: `call-${input.task.task_id}`,
            tool_name: 'get_glucose_evidence',
            arguments: {
              time_range: { from: '2026-10-08T09:00:00.000Z', to: '2026-10-08T12:30:00.000Z' },
              detail_level: 'DETAIL',
            },
          },
        ],
        usage: null,
        estimated_cost: null,
        received_at: new Date().toISOString(),
      };
    }

    return {
      provider: 'multi-call-provider',
      model: 'multi-call-provider-model',
      raw_output: {
        assistant_message: `multi-call-final:${input.task.task_id}`,
      },
      usage: null,
      estimated_cost: null,
      received_at: new Date().toISOString(),
    };
  }
}

class NoActivityViolationProviderTestDouble implements AiProvider {
  readonly history_evaluation_provider_kind = 'test' as const;
  readonly history_evaluation_real_model_used = false as const;

  async generate(input: AiProviderInput): Promise<AiProviderResponse> {
    const payload = JSON.parse(input.prompt.user_payload) as Record<string, unknown>;
    const hasHistory = Boolean(payload.historical_evidence);

    return {
      provider: 'no-activity-violation-provider',
      model: 'no-activity-violation-model',
      raw_output: {
        assistant_message: hasHistory
          ? 'No activity was recorded in this range.'
          : 'Po posiłku glukoza wzrosła, a następnie częściowo opadła; wpływ aktywności pozostaje UNKNOWN.',
      },
      usage: null,
      estimated_cost: null,
      received_at: new Date().toISOString(),
    };
  }
}

class PayloadCaptureProviderTestDouble implements AiProvider {
  readonly history_evaluation_provider_kind = 'test' as const;
  readonly history_evaluation_real_model_used = false as const;
  readonly payloads: Array<Record<string, unknown>> = [];

  async generate(input: AiProviderInput): Promise<AiProviderResponse> {
    const payload = JSON.parse(input.prompt.user_payload) as Record<string, unknown>;
    this.payloads.push(payload);

    return {
      provider: 'payload-capture-provider',
      model: 'payload-capture-model',
      raw_output: {
        assistant_message: `payload-captured:${input.task.task_id}`,
      },
      usage: null,
      estimated_cost: null,
      received_at: new Date().toISOString(),
    };
  }
}

describe('time-range quality vs cost experiment harness', () => {
  it('runs reproducible multi-strategy experiment with deterministic rubric and artifacts', async () => {
    const report = await runTimeRangeQualityCostExperiment({
      runs_per_strategy: 3,
      output_json_path: resolveEvalArtifactPath('time-range-quality-cost-experiment.json'),
      output_md_path: resolveEvalArtifactPath('time-range-quality-cost-experiment.md'),
    });

    expect(report.report_version).toBe('time-range-quality-cost-experiment.v1');
    expect(report.fixtures.map((fixture) => fixture.fixture_id)).toEqual([
      'fixture-progressive-valuable-v2',
      'fixture-all-relevant',
    ]);

    const strategies = report.strategies.map((strategy) => strategy.id);
    expect(strategies).toEqual(['SEQUENTIAL_PROGRESSIVE', 'BATCHED', 'CONTROL_CURRENT']);

    const expectedRuns = report.fixtures.length * strategies.length * report.run_count_per_strategy;
    expect(report.runs.length).toBe(expectedRuns);

    const hasSequentialShortPath = report.runs.some((run) =>
      run.fixture_id === 'fixture-progressive-valuable-v2'
      && run.strategy === 'SEQUENTIAL_PROGRESSIVE'
      && run.tool_sequence.join(',') === 'get_glucose_evidence,get_insulin_evidence',
    );
    expect(hasSequentialShortPath).toBe(true);

    const batchedAllThree = report.runs.filter((run) => run.strategy === 'BATCHED');
    expect(batchedAllThree.length).toBeGreaterThan(0);
    expect(batchedAllThree.every((run) => run.tool_sequence.join(',') === 'get_glucose_evidence,get_insulin_evidence,get_basal_evidence')).toBe(true);

    const noMaterialFailures = report.runs.every((run) => run.quality_dimensions.every((dimension) => dimension.grade !== 'FAIL'));
    expect(noMaterialFailures).toBe(true);

    const sequentialAggregate = report.strategy_aggregates.find((entry) => entry.strategy === 'SEQUENTIAL_PROGRESSIVE');
    const batchedAggregate = report.strategy_aggregates.find((entry) => entry.strategy === 'BATCHED');
    expect(sequentialAggregate).toBeDefined();
    expect(batchedAggregate).toBeDefined();
    expect((sequentialAggregate?.duplicated_tool_result_bytes_avg ?? 0)).toBeGreaterThanOrEqual(batchedAggregate?.duplicated_tool_result_bytes_avg ?? 0);

    expect(report.architecture_conclusions.recommended_direction).toBe('HYBRID_ADAPTIVE');
  });

  it('marks default provider origin as deterministic with real_model_used=false', async () => {
    const scenario = createHistoryComparisonScenarios()[0];
    const comparison = await runHistoryEvidenceComparisonScenario(scenario);

    expect(comparison.history_off.provider_kind).toBe('deterministic');
    expect(comparison.history_on.provider_kind).toBe('deterministic');
    expect(comparison.history_off.real_model_used).toBe(false);
    expect(comparison.history_on.real_model_used).toBe(false);
  });

  it('marks provider origin as unknown when provider kind cannot be resolved', async () => {
    const scenario = createHistoryComparisonScenarios()[0];
    const comparison = await runHistoryEvidenceComparisonScenario(scenario, {
      provider: new UnknownOriginProviderTestDouble(),
    });

    expect(comparison.history_off.provider_kind).toBe('unknown');
    expect(comparison.history_on.provider_kind).toBe('unknown');
    expect(comparison.history_off.real_model_used).toBeNull();
    expect(comparison.history_on.real_model_used).toBeNull();
  });

  it('detects unexpected full-input changes beyond historical_evidence', async () => {
    const scenario = createHistoryComparisonScenarios()[0];
    const comparison = await runHistoryEvidenceComparisonScenario(scenario, {
      provider: new ProviderBackedMessageTestDouble(),
      context_mutator: ({ variant, context }) => {
        if (variant === 'history_on') {
          return {
            ...context,
            analysis_request_input: {
              ...context.analysis_request_input,
              timezone: 'UTC',
            },
          };
        }
        return context;
      },
    });

    expect(comparison.input_invariant.normalized_input_invariant.identical).toBe(false);
  });

  it('captures all provider.generate calls when tool loop is enabled', async () => {
    const scenario = createHistoryComparisonScenarios()[0];
    const previousFlag = process.env.AI_ENABLE_TIME_RANGE_GLUCOSE_TOOL_CALLING;
    process.env.AI_ENABLE_TIME_RANGE_GLUCOSE_TOOL_CALLING = '1';

    try {
      const comparison = await runHistoryEvidenceComparisonScenario(scenario, {
        provider: new MultiCallProviderTestDouble(),
      });

      expect(comparison.input_invariant.strict_input_invariant.source).toBe('provider_generate_all_calls');
      expect(comparison.input_invariant.strict_input_invariant.off_call_count).toBeGreaterThan(1);
      expect(comparison.input_invariant.strict_input_invariant.on_call_count).toBeGreaterThan(1);
      expect(comparison.input_invariant.normalized_input_invariant.normalized_hashes_off.length).toBe(comparison.input_invariant.strict_input_invariant.off_call_count);
      expect(comparison.input_invariant.normalized_input_invariant.normalized_hashes_on.length).toBe(comparison.input_invariant.strict_input_invariant.on_call_count);
    } finally {
      if (previousFlag === undefined) {
        delete process.env.AI_ENABLE_TIME_RANGE_GLUCOSE_TOOL_CALLING;
      } else {
        process.env.AI_ENABLE_TIME_RANGE_GLUCOSE_TOOL_CALLING = previousFlag;
      }
    }
  });

  it('no longer fails a variant for flagged wording (the gateway logs it and keeps the answer)', async () => {
    const scenario = createHistoryComparisonScenarios()[0];
    const comparison = await runHistoryEvidenceComparisonScenario(scenario, {
      provider: new NoActivityViolationProviderTestDouble(),
    });

    expect(comparison.history_off.status).toBe('SUCCEEDED');
    expect(comparison.history_on.status).toBe('SUCCEEDED');
    expect(comparison.history_on.error).toBeFalsy();
  });

  it('reports complete and incomplete pair counters plus metric availability', async () => {
    const report = await runHistoryEvidenceComparisonExperiment({
      provider: new ProviderBackedMessageTestDouble(),
    });

    expect(report.report_version).toBe('history-evidence-comparison.v1');
    expect(report.scenarios).toHaveLength(7);
    expect(report.scenarios.every((entry) => entry.history_off.variant === 'history_off')).toBe(true);
    expect(report.scenarios.every((entry) => entry.history_on.variant === 'history_on')).toBe(true);
    expect(report.summary.total_pairs).toBe(7);
    expect(report.summary.complete_pairs).toBe(7);
    expect(report.summary.incomplete_pairs).toBe(0);
    expect(report.summary.failed_variants).toBe(0);
    expect(report.summary.metrics_availability.context_size_pairs).toBeGreaterThan(0);
    expect(report.summary.pairwise_delta_summary.not_comparable).toBeGreaterThanOrEqual(0);
  });
});
