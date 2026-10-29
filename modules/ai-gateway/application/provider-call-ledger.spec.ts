import { describe, expect, it } from 'vitest';
import { canonicalJson } from '@shared/utils/canonical-json';
import { ProviderCallLedger, type ProviderCallRequestShape } from './provider-call-ledger';

const toolResultA = { call_id: 'call-a', tool_name: 'get_glucose_evidence', result: { tool: 'get_glucose_evidence', evidence: { points: [1, 2, 3] } } };
const toolResultB = { call_id: 'call-b', tool_name: 'get_insulin_evidence', result: { tool: 'get_insulin_evidence', evidence: { doses: ['x'] } } };

function request(overrides: Partial<ProviderCallRequestShape> = {}): ProviderCallRequestShape {
  return {
    turn_kind: 'INITIAL',
    previous_response_id: null,
    system_instructions: 'system',
    user_payload: '{"task":"x"}',
    available_tools: [{ name: 'get_glucose_evidence' }],
    tool_results: [],
    ...overrides,
  };
}

function usage(input: number, output: number, cached = 0, reasoning = 0) {
  return { input_tokens: input, output_tokens: output, total_tokens: input + output, cached_input_tokens: cached, reasoning_tokens: reasoning };
}

function cost(amount: number) {
  return { estimated_cost: amount, currency: 'USD', pricing_version: 'p1', input_cost: amount / 2, output_cost: amount / 2, cached_input_cost: 0, reasoning_cost: 0 };
}

describe('ProviderCallLedger', () => {
  it('sums provider-reported usage across tool-loop turns and keeps per-call entries', () => {
    const ledger = new ProviderCallLedger();
    ledger.recordResponse(request(), { usage: usage(1000, 50, 0, 10), estimated_cost: cost(0.01), serialized_input_bytes: 7000, requested_tool_call_count: 1 });
    ledger.recordResponse(request({ turn_kind: 'TOOL_CONTINUATION', previous_response_id: 'resp-1', tool_results: [toolResultA] }), {
      usage: usage(4000, 60, 900, 20), estimated_cost: cost(0.02), serialized_input_bytes: 12000, requested_tool_call_count: 1,
    });
    ledger.recordResponse(request({ turn_kind: 'TOOL_CONTINUATION', previous_response_id: 'resp-2', tool_results: [toolResultA, toolResultB] }), {
      usage: usage(9000, 300, 3900, 100), estimated_cost: cost(0.05), serialized_input_bytes: 20000, requested_tool_call_count: 0,
    });

    const aggregate = ledger.buildAggregate();

    expect(aggregate.provider_call_count).toBe(3);
    expect(aggregate.tokens).toMatchObject({
      source: 'PROVIDER_REPORTED_SUM',
      complete: true,
      calls_with_usage: 3,
      totals: { input_tokens: 14000, output_tokens: 410, total_tokens: 14410, cached_input_tokens: 4800, reasoning_tokens: 130 },
    });
    expect(aggregate.tokens.reported_sums).toEqual(aggregate.tokens.totals);
    expect(aggregate.calls.map((call) => call.turn_kind)).toEqual(['INITIAL', 'TOOL_CONTINUATION', 'TOOL_CONTINUATION']);
    expect(aggregate.calls.map((call) => call.previous_response_id_sent)).toEqual([false, true, true]);
    expect(aggregate.calls_by_input_tokens_desc).toEqual([3, 2, 1]);
    expect(aggregate.bytes.provider_request_body_total).toBe(39000);
    expect(aggregate.cost).toMatchObject({ provider_reported: null, local_estimate_kind: 'LOCAL_ESTIMATE_CONFIGURED_PRICING', local_estimate_currency: 'USD' });
    expect(aggregate.cost.local_estimate_total).toBeCloseTo(0.08, 12);
    expect(ledger.buildAttemptUsage()).toEqual(aggregate.tokens.totals);
    expect(ledger.buildAttemptCostEstimate()).toMatchObject({ currency: 'USD', pricing_version: 'p1' });
    expect(ledger.buildAttemptCostEstimate()?.estimated_cost).toBeCloseTo(0.08, 12);
  });

  it('keeps the prompt-cache write tokens and their cost (Claude bills them above the input price)', () => {
    const ledger = new ProviderCallLedger();
    ledger.recordResponse(request(), { usage: { ...usage(1000, 50), cache_write_tokens: 800 }, estimated_cost: { ...cost(0.02), cache_write_cost: 0.01 }, serialized_input_bytes: 7000, requested_tool_call_count: 0 });
    const call = ledger.buildAggregate().calls[0];
    expect(call.provider_reported_usage).toMatchObject({ cache_write_tokens: 800 });
    expect(call.local_cost_estimate).toMatchObject({ cache_write_cost: 0.01 });
    expect(ledger.buildAttemptCostEstimate()).toMatchObject({ cache_write_cost: 0.01 });
  });

  it('measures new versus re-sent tool result bytes with deterministic serialization', () => {
    const ledger = new ProviderCallLedger();
    const bytesA = Buffer.byteLength(canonicalJson(toolResultA.result), 'utf8');
    const bytesB = Buffer.byteLength(canonicalJson(toolResultB.result), 'utf8');

    ledger.recordResponse(request(), { usage: usage(1, 1), requested_tool_call_count: 1 });
    ledger.recordResponse(request({ tool_results: [toolResultA] }), { usage: usage(1, 1), requested_tool_call_count: 1 });
    ledger.recordResponse(request({ turn_kind: 'FINALIZATION', available_tools: [], tool_results: [toolResultA, toolResultB] }), { usage: usage(1, 1), requested_tool_call_count: 0 });

    const aggregate = ledger.buildAggregate();
    expect(aggregate.calls[1].measured_bytes).toMatchObject({ tool_results_sent: bytesA, tool_results_new: bytesA, tool_results_resent: 0 });
    expect(aggregate.calls[2].measured_bytes).toMatchObject({ tool_results_sent: bytesA + bytesB, tool_results_new: bytesB, tool_results_resent: bytesA, tool_definitions: 0 });
    expect(aggregate.calls[2].tool_results_resent_count).toBe(1);
    expect(aggregate.bytes).toMatchObject({
      tool_results_sent_total: 2 * bytesA + bytesB,
      tool_results_unique_total: bytesA + bytesB,
      tool_results_resent_total: bytesA,
      user_payload_total: 3 * Buffer.byteLength('{"task":"x"}', 'utf8'),
      system_instructions_total: 3 * Buffer.byteLength('system', 'utf8'),
    });

    const replay = new ProviderCallLedger();
    replay.recordResponse(request(), { usage: usage(1, 1), requested_tool_call_count: 1 });
    replay.recordResponse(request({ tool_results: [toolResultA] }), { usage: usage(1, 1), requested_tool_call_count: 1 });
    replay.recordResponse(request({ turn_kind: 'FINALIZATION', available_tools: [], tool_results: [toolResultA, toolResultB] }), { usage: usage(1, 1), requested_tool_call_count: 0 });
    expect(canonicalJson(replay.buildAggregate())).toBe(canonicalJson(aggregate));
  });

  it('never invents totals when a call is missing usage', () => {
    const ledger = new ProviderCallLedger();
    ledger.recordResponse(request(), { usage: usage(1000, 50), estimated_cost: cost(0.01), requested_tool_call_count: 1 });
    ledger.recordResponse(request({ tool_results: [toolResultA] }), { usage: null, estimated_cost: null, requested_tool_call_count: 0 });

    const aggregate = ledger.buildAggregate();
    expect(aggregate.tokens.complete).toBe(false);
    expect(aggregate.tokens.calls_with_usage).toBe(1);
    expect(aggregate.tokens.totals.input_tokens).toBeNull();
    expect(aggregate.tokens.reported_sums.input_tokens).toBe(1000);
    expect(aggregate.calls[1].usage_status).toBe('MISSING');
    expect(aggregate.bytes.provider_request_body_total).toBeNull();
    expect(ledger.buildAttemptUsage()).toMatchObject({ input_tokens: null, output_tokens: null });
    expect(ledger.buildAttemptCostEstimate()).toBeNull();
  });

  it('records failed calls as unknown usage and exposes responded-call usage as a lower bound', () => {
    const ledger = new ProviderCallLedger();
    ledger.recordResponse(request(), { usage: usage(1200, 40), estimated_cost: cost(0.012), requested_tool_call_count: 1 });
    ledger.recordFailure(request({ previous_response_id: 'resp-1', tool_results: [toolResultA] }));

    const aggregate = ledger.buildAggregate();
    expect(aggregate).toMatchObject({ provider_call_count: 2, responded_call_count: 1, failed_call_count: 1 });
    expect(aggregate.calls[1]).toMatchObject({ outcome: 'FAILED', usage_status: 'UNKNOWN_CALL_FAILED', provider_reported_usage: null });
    expect(aggregate.tokens.complete).toBe(false);
    expect(ledger.buildRespondedCallsUsage()).toMatchObject({ input_tokens: 1200, output_tokens: 40 });
    expect(ledger.buildAttemptCostEstimate()).toBeNull();
    expect(ledger.buildAttemptCostEstimate(true)?.estimated_cost).toBeCloseTo(0.012, 12);
  });

  it('reports cost as unavailable when pricing is not configured', () => {
    const ledger = new ProviderCallLedger();
    ledger.recordResponse(request(), { usage: usage(10, 5), estimated_cost: null, requested_tool_call_count: 0 });

    expect(ledger.buildAggregate().cost).toEqual({
      provider_reported: null,
      local_estimate_total: null,
      local_estimate_currency: null,
      local_estimate_pricing_version: null,
      local_estimate_kind: 'UNAVAILABLE',
    });
    expect(ledger.buildAttemptUsage()).toEqual(usage(10, 5));
  });

  it('contains measurements only, no prompt or tool result content', () => {
    const ledger = new ProviderCallLedger();
    ledger.recordResponse(request({ user_payload: '{"glucose":"PATIENT-SECRET-VALUE"}', tool_results: [toolResultA] }), { usage: usage(1, 1), requested_tool_call_count: 0 });

    const serialized = JSON.stringify(ledger.buildAggregate());
    expect(serialized).not.toContain('PATIENT-SECRET-VALUE');
    expect(serialized).not.toContain('points');
    expect(serialized).not.toContain('call-a');
  });
});
