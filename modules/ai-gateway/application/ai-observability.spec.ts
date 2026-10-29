import { describe, expect, it } from 'vitest';
import type { ContextPackageRecord } from '@modules/context/domain/context-package';
import { buildContextPackageUsage, buildExactInputFingerprint, buildPricingEstimate, calculateProviderUsageCost, normalizeAIUsage } from './ai-observability';

/** A hypo context package as the former context-package-builder (v1) produced it. */
function baseContextPackage(): ContextPackageRecord {
  return {
    context_package_id: 'package-1',
    context_package_version: 'context-package.v1',
    content_hash: 'sha256:test',
    created_at: '2026-01-01T00:00:00.000Z',
    created_for_job_id: 'job-1',
    patient_ref: { patient_id: 'patient-1' },
    task: {
      task_type: 'HYPO_EPISODE_CONTEXT',
      prompt_version: 'hypo-analysis.v1',
      output_schema_version: 'hypo-analysis-output.v1',
    },
    trigger: {
      trigger_id: 'trigger-1',
      trigger_type: 'HYPO_DETECTED',
      trigger_rule_version: 'hypo.cgm.ada2026.v1',
      created_at: '2026-01-01T00:00:00.000Z',
      source_event_id: 'evt-1',
    },
    hypo_episode: {
      episode_id: 'ep-1',
      episode_state: 'OPEN',
      episode_severity: 'L1',
      episode_started_at: '2026-01-01T00:00:00.000Z',
      episode_ended_at: 'UNKNOWN',
      start_reading_id: 'evt-1',
      latest_reading_id: 'evt-1',
    },
    glucose_evidence: [
      {
        reading_id: 'evt-1',
        source_record_id: 'src-1',
        observed_at: '2026-01-01T00:00:00.000Z',
        recorded_at: '2026-01-01T00:00:00.000Z',
        glucose_value: 68,
        glucose_unit: 'mg/dL',
        classification: 'L1',
        relation_to_episode: 'LATEST',
        validity: 'VALID',
        provenance_ref: 'source-record/src-1',
      },
    ],
    current_state_snapshot: {
      state_version: 'cs-1',
      as_of: '2026-01-01T00:00:00.000Z',
      current_glucose: 68,
      trend: 'UNKNOWN',
      glucose_rate_of_change: 'UNKNOWN',
      iob: 'UNKNOWN',
      recent_insulin: [],
      recent_meal: null,
      recent_activity: null,
      recent_sleep: null,
      recent_illness: null,
      active_therapy_ref: 'UNKNOWN',
    },
    active_therapy_snapshot: {
      therapy_id: 'UNKNOWN',
      therapy_version: 'UNKNOWN',
      active_profile_id: 'UNKNOWN',
      basal_schedule: 'UNKNOWN',
      icr_schedule: 'UNKNOWN',
      isf_schedule: 'UNKNOWN',
      target_schedule: 'UNKNOWN',
      dia: 'UNKNOWN',
      automation_mode: 'UNKNOWN',
    },
    conversation_context: {
      thread_id: 'conv-1',
      thread_state_version: 'conv-v1',
      awaiting_user_answer: true,
      messages: [],
    },
    event_context_facts: [],
    provenance: {
      trigger_id: 'trigger-1',
      source_event_id: 'evt-1',
      source_record_ids: ['src-1'],
      current_state_version: 'cs-1',
      therapy_version: 'UNKNOWN',
      conversation_thread_version: 'conv-v1',
    },
    source_versions: {
      nightscout_sync_cursor: 'cur-1',
      current_state_version: 'cs-1',
      therapy_version: 'UNKNOWN',
      trigger_rule_version: 'hypo.cgm.ada2026.v1',
      conversation_thread_version: 'conv-v1',
      package_version: 'context-package.v1',
    },
    selection_policy: {
      task_bounded: true,
      episode_bounded: true,
      thread_bounded: true,
      no_memory: true,
      no_knowledge: true,
      no_full_history: true,
    },
    package_status: 'PARTIAL',
  } as unknown as ContextPackageRecord;
}

describe('AI observability helpers', () => {
  it('extracts provider usage while leaving unavailable values null', () => {
    expect(normalizeAIUsage({
      input_tokens: 120,
      output_tokens: 80,
      total_tokens: 200,
      input_tokens_details: { cached_tokens: 40 },
      output_tokens_details: { reasoning_tokens: 15 },
    })).toEqual({
      input_tokens: 120,
      output_tokens: 80,
      total_tokens: 200,
      cached_input_tokens: 40,
      reasoning_tokens: 15,
    });

    expect(normalizeAIUsage({ input_tokens: 10, output_tokens: 5, total_tokens: 15 })).toEqual({
      input_tokens: 10,
      output_tokens: 5,
      total_tokens: 15,
      cached_input_tokens: null,
      reasoning_tokens: null,
    });
  });

  it('produces a stable exact input fingerprint for matching serialized input and changes on real input differences', () => {
    const first = {
      model: 'gpt-5.6',
      input: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: '{"a":1}' },
      ],
      text: { format: { type: 'json_schema', name: 'x' } },
    };
    const second = {
      model: 'gpt-5.6',
      input: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: '{"a":1}' },
      ],
      text: { format: { type: 'json_schema', name: 'x' } },
    };
    const third = {
      model: 'gpt-5.6',
      input: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: '{"a":2}' },
      ],
      text: { format: { type: 'json_schema', name: 'x' } },
    };

    expect(buildExactInputFingerprint(first)).toBe(buildExactInputFingerprint(second));
    expect(buildExactInputFingerprint(first)).not.toBe(buildExactInputFingerprint(third));
  });

  it('measures deterministic ContextPackage section sizes and omits absent optional sections', () => {
    const packageRecord = baseContextPackage();
    const usage = buildContextPackageUsage(packageRecord);

    expect(usage.total_serialized_bytes).toBeGreaterThan(0);
    expect(usage.sections.some((section) => section.section_name === 'task')).toBe(true);
    expect(usage.sections.some((section) => section.section_name === 'pattern_evidence')).toBe(false);
    expect(usage.sections.some((section) => section.section_name === 'memory_evidence')).toBe(false);

    const second = buildContextPackageUsage(packageRecord);
    expect(usage).toEqual(second);
    expect(usage.total_serialized_bytes).toBeGreaterThan(0);
  });

  it('calculates cost only when pricing is configured', () => {
    expect(buildPricingEstimate({
      provider: 'openai',
      model: 'gpt-5.6',
      usage: {
        input_tokens: 200,
        output_tokens: 50,
        total_tokens: 250,
        cached_input_tokens: 10,
        reasoning_tokens: 5,
      },
      pricing: {
        input_per_1k_tokens: 0.01,
        output_per_1k_tokens: 0.02,
        cached_input_per_1k_tokens: 0.005,
        reasoning_per_1k_tokens: 0.007,
        currency: 'USD',
        pricing_version: 'test-pricing.v1',
      },
    })).toMatchObject({
      estimated_cost: expect.any(Number),
      currency: 'USD',
      pricing_version: 'test-pricing.v1',
    });

    expect(buildPricingEstimate({
      provider: 'openai',
      model: 'gpt-5.6',
      usage: {
        input_tokens: 200,
        output_tokens: 50,
        total_tokens: 250,
        cached_input_tokens: null,
        reasoning_tokens: null,
      },
      pricing: null,
    })).toBeNull();
  });

  it('marks cost as UNKNOWN when any billable usage dimension has no configured price', () => {
    const result = calculateProviderUsageCost({
      provider: 'openai',
      model: 'gpt-5.6-terra',
      usage: {
        input_tokens: 200,
        output_tokens: 50,
        total_tokens: 250,
        cached_input_tokens: null,
        reasoning_tokens: null,
      },
      pricing: {
        input_per_1k_tokens: 0.01,
        output_per_1k_tokens: null,
        cached_input_per_1k_tokens: 0.005,
        reasoning_per_1k_tokens: 0.007,
        currency: 'USD',
        pricing_version: 'openai.pricing.v1',
      },
    });

    expect(result).toEqual({
      status: 'UNKNOWN',
      provider: 'openai',
      model: 'gpt-5.6-terra',
      reason: 'MISSING_PRICE_FOR_BILLABLE_USAGE',
      pricing_version: 'openai.pricing.v1',
    });
    expect(buildPricingEstimate({
      provider: 'openai',
      model: 'gpt-5.6-terra',
      usage: {
        input_tokens: 200,
        output_tokens: 50,
        total_tokens: 250,
        cached_input_tokens: null,
        reasoning_tokens: null,
      },
      pricing: {
        input_per_1k_tokens: 0.01,
        output_per_1k_tokens: null,
        cached_input_per_1k_tokens: 0.005,
        reasoning_per_1k_tokens: 0.007,
        currency: 'USD',
        pricing_version: 'openai.pricing.v1',
      },
    })).toBeNull();
  });

  it('marks cost as UNKNOWN when usage exists but canonical currency is missing', () => {
    const result = calculateProviderUsageCost({
      provider: 'openai',
      model: 'gpt-5.6-terra',
      usage: {
        input_tokens: 120,
        output_tokens: 80,
        total_tokens: 200,
        cached_input_tokens: null,
        reasoning_tokens: null,
      },
      pricing: {
        input_per_1k_tokens: 0.01,
        output_per_1k_tokens: 0.02,
        cached_input_per_1k_tokens: 0.005,
        reasoning_per_1k_tokens: 0.007,
        currency: null,
        pricing_version: 'openai.pricing.v1',
      },
    });

    expect(result).toEqual({
      status: 'UNKNOWN',
      provider: 'openai',
      model: 'gpt-5.6-terra',
      reason: 'CURRENCY_NOT_CONFIGURED',
      pricing_version: 'openai.pricing.v1',
    });
  });
});

describe('calculateProviderUsageCost: cached and reasoning tokens follow the Responses usage contract', () => {
  // Same shape as the configured gpt-5.6-terra pricing (reasoning is billed as output: no surcharge).
  const pricing = {
    input_per_1k_tokens: 0.002,
    output_per_1k_tokens: 0.012,
    cached_input_per_1k_tokens: 0.0002,
    reasoning_per_1k_tokens: 0,
    currency: 'USD',
    pricing_version: 'synthetic-terra-shape.v1',
  };
  const cost = (usage: { input_tokens: number | null; output_tokens: number | null; cached_input_tokens: number | null; reasoning_tokens: number | null }) =>
    calculateProviderUsageCost({ provider: 'openai', model: 'synthetic', pricing, usage: { ...usage, total_tokens: null } });
  const amount = (result: ReturnType<typeof calculateProviderUsageCost>) => (result.status === 'KNOWN' ? result.amount : Number.NaN);

  it('bills all input at the input price when nothing is cached', () => {
    expect(amount(cost({ input_tokens: 4978, output_tokens: 382, cached_input_tokens: 0, reasoning_tokens: 211 })))
      .toBeCloseTo(4978 * 0.002 / 1000 + 382 * 0.012 / 1000, 12);
  });

  it('bills cached tokens only at the cached price when part of the input is cached (no double counting)', () => {
    const result = cost({ input_tokens: 4475, output_tokens: 139, cached_input_tokens: 1273, reasoning_tokens: 72 });
    expect(result).toMatchObject({ status: 'KNOWN' });
    if (result.status !== 'KNOWN') return;
    expect(result.input_cost).toBeCloseTo((4475 - 1273) * 0.002 / 1000, 12);
    expect(result.cached_input_cost).toBeCloseTo(1273 * 0.0002 / 1000, 12);
    expect(result.amount).toBeCloseTo((4475 - 1273) * 0.002 / 1000 + 1273 * 0.0002 / 1000 + 139 * 0.012 / 1000, 12);
    // The previous formula billed the cached tokens twice.
    expect(result.amount).toBeLessThan(4475 * 0.002 / 1000 + 1273 * 0.0002 / 1000 + 139 * 0.012 / 1000);
  });

  it('bills a fully cached input only at the cached price', () => {
    const result = cost({ input_tokens: 2000, output_tokens: 10, cached_input_tokens: 2000, reasoning_tokens: 0 });
    expect(result.status === 'KNOWN' && result.input_cost).toBe(0);
    expect(amount(result)).toBeCloseTo(2000 * 0.0002 / 1000 + 10 * 0.012 / 1000, 12);
  });

  it('does not count reasoning tokens twice: they are part of output_tokens', () => {
    const withSurcharge = calculateProviderUsageCost({
      provider: 'openai', model: 'synthetic', pricing: { ...pricing, reasoning_per_1k_tokens: 0 },
      usage: { input_tokens: 0, output_tokens: 500, cached_input_tokens: 0, reasoning_tokens: 400, total_tokens: 500 },
    });
    expect(amount(withSurcharge)).toBeCloseTo(500 * 0.012 / 1000, 12);
  });

  it('never invents missing usage: no usage, partial usage and impossible usage are UNKNOWN', () => {
    expect(calculateProviderUsageCost({ provider: 'openai', model: 'synthetic', pricing, usage: null })).toMatchObject({ status: 'UNKNOWN', reason: 'USAGE_MISSING' });
    expect(cost({ input_tokens: null, output_tokens: 100, cached_input_tokens: 50, reasoning_tokens: null })).toMatchObject({ status: 'UNKNOWN', reason: 'USAGE_INCOMPLETE' });
    expect(cost({ input_tokens: 100, output_tokens: null, cached_input_tokens: null, reasoning_tokens: null })).toMatchObject({ status: 'UNKNOWN', reason: 'USAGE_INCOMPLETE' });
    expect(cost({ input_tokens: 100, output_tokens: 10, cached_input_tokens: 101, reasoning_tokens: 0 })).toMatchObject({ status: 'UNKNOWN', reason: 'INVALID_USAGE' });
    expect(cost({ input_tokens: 100, output_tokens: 10, cached_input_tokens: 0, reasoning_tokens: 11 })).toMatchObject({ status: 'UNKNOWN', reason: 'INVALID_USAGE' });
  });

  it('keeps an unknown cached count as an upper bound (all input at the input price), never an undercount', () => {
    expect(amount(cost({ input_tokens: 1000, output_tokens: 0, cached_input_tokens: null, reasoning_tokens: null }))).toBeCloseTo(0.002, 12);
  });

  it('sums the calls of one analysis and of a failed attempt per call (usage of the recorded expensive analysis)', () => {
    // Token counts only (no patient data): the recorded per-call usage of the 4-call answer, and the recorded totals of
    // the 3-call failed attempt (cost is linear in tokens, so its totals price the same as its calls).
    const answer = [[4475, 1273, 139], [24160, 4472, 65], [48140, 24157, 65], [73639, 0, 280]];
    const failedAttempt = [[76337, 29667, 273]];
    const sum = (calls: number[][]) => calls.reduce((total, [input, cached, output]) => total + amount(cost({ input_tokens: input, output_tokens: output, cached_input_tokens: cached, reasoning_tokens: 0 })), 0);
    const expected = (calls: number[][]) => calls.reduce((total, [input, cached, output]) => total + ((input - cached) * 0.002 + cached * 0.0002 + output * 0.012) / 1000, 0);
    expect(sum(answer)).toBeCloseTo(expected(answer), 12);
    expect(sum(answer)).toBeCloseTo(0.2536, 3);
    expect(sum(failedAttempt)).toBeCloseTo(expected(failedAttempt), 12);
    expect(sum(failedAttempt)).toBeCloseTo(0.1026, 3);
  });
});
