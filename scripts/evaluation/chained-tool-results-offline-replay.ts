/**
 * Offline validation of AI_EXPERIMENT_OMIT_CHAINED_TOOL_RESULTS against captured provider request chains.
 *
 * No network calls: a replay provider reproduces the model's captured tool-call sequence, the real
 * AiGatewayService executes evidence tools locally against the captured context package, and the
 * requests produced with the flag off (baseline) and on (experimental) are compared.
 *
 * Output contains measurements and invariant results only (no prompt, evidence or answer content).
 *
 * Usage: tsx scripts/evaluation/chained-tool-results-offline-replay.ts <out.json> <capture.jsonl>...
 * <out.json> must resolve outside every Git working tree; it is validated before any capture is read and written
 * with mode 0600.
 */
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { canonicalJson } from '@shared/utils/canonical-json';
import { AiGatewayService, OMIT_CHAINED_TOOL_RESULTS_FLAG } from '@modules/ai-gateway/application/ai-gateway.service';
import { createConversationTimeRangeAnalysisTask } from '@modules/ai-gateway/application/ai-task';
import type { AiProvider, AiProviderInput, AiProviderResponse, AiRuntimeToolCall } from '@modules/ai-gateway/domain/ai-gateway';
import { buildOpenAiResponsesRequestBody } from '@modules/ai-gateway/infrastructure/openai-provider';
import { AiProviderError } from '@modules/ai-gateway/infrastructure/ai-provider.error';
import { writeEvaluationOutputFile } from '@modules/ai-gateway/infrastructure/evaluation-capture-path';
import { describeErrorSafely, positionalArguments, requireInputFileArgument, resolveEvaluationOutputFile } from './evaluation-output-dir';

type CaptureRow = Record<string, any>;
type Mode = 'baseline' | 'experimental';
const DETAIL_LEVELS = ['SUMMARY', 'SIGNIFICANT_EVENTS', 'DETAIL', 'TRAJECTORY'] as const;
const FINAL_MESSAGE = 'Replay final answer. Activity impact remains UNKNOWN.';

function bytes(value: unknown): number {
  return Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
}

function splitChains(rows: CaptureRow[]): CaptureRow[][] {
  const chains: CaptureRow[][] = [];
  for (const row of rows) {
    if (!row.request_representation || row.task?.task_type !== 'CONVERSATION_TIME_RANGE_ANALYSIS') continue;
    if (!row.request_representation.previous_response_id || chains.length === 0) chains.push([row]);
    else chains[chains.length - 1].push(row);
  }
  return chains;
}

function functionOutputs(row: CaptureRow): Array<{ call_id: string; output: string }> {
  return row.request_representation.input.filter((item: any) => item.type === 'function_call_output');
}

/** Part A: apply the omission rule to the exact historical request bodies. */
function analyzeCapturedBodies(chain: CaptureRow[]) {
  const earlier = new Map<string, string>();
  return chain.map((row, index) => {
    const outputs = functionOutputs(row);
    const omitted = outputs.filter((item) => earlier.has(item.call_id));
    const kept = outputs.filter((item) => !earlier.has(item.call_id));
    const genuineDuplicates = omitted.every((item) => earlier.get(item.call_id) === item.output);
    const experimentalBody = {
      ...row.request_representation,
      input: row.request_representation.input.filter((item: any) => !(item.type === 'function_call_output' && earlier.has(item.call_id))),
    };
    for (const item of outputs) if (!earlier.has(item.call_id)) earlier.set(item.call_id, item.output);
    return {
      call: index + 1,
      previous_response_id_sent: Boolean(row.request_representation.previous_response_id),
      outputs_sent_baseline: outputs.length,
      outputs_sent_experimental: kept.length,
      omitted_outputs: omitted.length,
      omitted_are_identical_to_earlier_items: genuineDuplicates,
      omitted_output_bytes: omitted.reduce((sum, item) => sum + bytes(item.output), 0),
      body_bytes_baseline: bytes(row.request_representation),
      body_bytes_experimental: bytes(experimentalBody),
      captured_serialized_input_bytes: row.serialized_input_bytes ?? null,
    };
  });
}

/** Tool calls the model made in response N = outputs first delivered in request N+1. */
function reconstructToolCalls(chain: CaptureRow[]): Array<Array<{ call_id: string; tool_name: string; range: { from: string; to: string }; content_hash: string | null }>> {
  const seen = new Set<string>();
  const perResponse = chain.map(() => [] as Array<{ call_id: string; tool_name: string; range: { from: string; to: string }; content_hash: string | null }>);
  chain.forEach((row, index) => {
    for (const item of functionOutputs(row)) {
      if (seen.has(item.call_id)) continue;
      seen.add(item.call_id);
      const parsed = JSON.parse(item.output);
      perResponse[index - 1]?.push({
        call_id: item.call_id,
        tool_name: String(parsed.tool),
        range: parsed.coverage?.range ?? parsed.evidence?.coverage?.range,
        content_hash: typeof parsed.content_hash === 'string' ? parsed.content_hash : null,
      });
    }
  });
  return perResponse;
}

class ReplayProvider implements AiProvider {
  readonly inputs: AiProviderInput[] = [];
  constructor(private readonly responses: Array<AiProviderResponse | Error>) {}
  async generate(input: AiProviderInput): Promise<AiProviderResponse> {
    this.inputs.push(JSON.parse(JSON.stringify({ ...input, context_package: null })));
    const next = this.responses[this.inputs.length - 1];
    if (!next) throw new Error('REPLAY_SCRIPT_EXHAUSTED');
    if (next instanceof Error) throw next;
    return next;
  }
}

function toolResponse(responseId: string | null, calls: AiRuntimeToolCall[]): AiProviderResponse {
  return { provider: 'replay', model: 'replay', response_id: responseId, received_at: '2026-10-12T00:00:00.000Z', raw_output: {}, tool_calls: calls };
}

function finalResponse(): AiProviderResponse {
  return { provider: 'replay', model: 'replay', response_id: 'replay-final', received_at: '2026-10-12T00:00:00.000Z', raw_output: { assistant_message: FINAL_MESSAGE } };
}

function taskFor(context: any, suffix: string) {
  return createConversationTimeRangeAnalysisTask({
    task_id: `offline-replay-${suffix}`,
    context_package_id: context.context_package_id,
    context_package_version: context.context_package_version,
    context_package_hash: context.content_hash,
    correlation_id: `offline-replay-${suffix}`,
    created_at: '2026-10-12T00:00:00.000Z',
    patient_id: context.patient_ref.patient_id,
  });
}

function withEnv<T>(mode: Mode, fn: () => Promise<T>): Promise<T> {
  const previous = { ...process.env };
  process.env.AI_ENABLE_TIME_RANGE_GLUCOSE_TOOL_CALLING = '1';
  process.env.NODE_ENV = 'test';
  process.env[OMIT_CHAINED_TOOL_RESULTS_FLAG] = mode === 'experimental' ? '1' : '0';
  return fn().finally(() => {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  });
}

async function runGateway(context: any, script: Array<AiProviderResponse | Error>, mode: Mode, suffix: string) {
  return withEnv(mode, async () => {
    const provider = new ReplayProvider(script);
    try {
      const execution = await new AiGatewayService(provider).execute({ task: taskFor(context, suffix), context_package: context, timeout_ms: 600_000 });
      return { provider, execution, error: null as string | null };
    } catch (error) {
      return { provider, execution: null, error: (error as { code?: string }).code ?? String(error) };
    }
  });
}

/** Offline probe: find the detail level whose locally executed output reproduces the captured content hash. */
async function recoverDetailLevel(context: any, call: { tool_name: string; range: { from: string; to: string }; content_hash: string | null }) {
  for (const level of DETAIL_LEVELS) {
    const probe = await runGateway(context, [
      toolResponse('probe-1', [{ call_id: 'probe-call', tool_name: call.tool_name, arguments: { time_range: call.range, detail_level: level } }]),
      finalResponse(),
    ], 'baseline', 'probe');
    const result = probe.provider.inputs[1]?.tool_runtime?.tool_results?.[0]?.result as Record<string, unknown> | undefined;
    if (result && result.content_hash === call.content_hash) return { level, reproduced_exactly: true };
  }
  return { level: 'SIGNIFICANT_EVENTS' as const, reproduced_exactly: false };
}

function deliveredIds(provider: ReplayProvider): string[][] {
  return provider.inputs.map((input) => (input.tool_runtime?.tool_results ?? []).map((result) => result.call_id));
}

function providerBodyBytes(input: AiProviderInput): number {
  return bytes(buildOpenAiResponsesRequestBody({
    model: 'gpt-5.6-terra',
    task_type: 'CONVERSATION_TIME_RANGE_ANALYSIS',
    system_instructions: input.prompt.system_instructions,
    user_payload: input.prompt.user_payload,
    previous_response_id: input.previous_response_id ?? null,
    tool_runtime: input.tool_runtime,
  }));
}

/** Part B: replay through the current gateway in both modes and check the invariants. */
async function replayChain(chain: CaptureRow[], chainIndex: number) {
  const context = chain[0].context_package;
  const contextHashBefore = createHash('sha256').update(canonicalJson(context)).digest('hex');
  const reconstructed = reconstructToolCalls(chain);
  const toolCallsPerResponse: AiRuntimeToolCall[][] = [];
  let reproducedExactly = 0;
  let toolCallCount = 0;
  for (const calls of reconstructed.slice(0, -1)) {
    const recovered: AiRuntimeToolCall[] = [];
    for (const call of calls) {
      const detail = await recoverDetailLevel(context, call);
      toolCallCount += 1;
      if (detail.reproduced_exactly) reproducedExactly += 1;
      recovered.push({ call_id: call.call_id, tool_name: call.tool_name, arguments: { time_range: call.range, detail_level: detail.level } });
    }
    toolCallsPerResponse.push(recovered);
  }
  const responseScript = (ids: Array<string | null>) => [
    ...toolCallsPerResponse.map((calls, index) => toolResponse(ids[index], calls)),
    finalResponse(),
  ];
  const ids = toolCallsPerResponse.map((_, index) => `replay-resp-${chainIndex}-${index + 1}`);

  const baseline = await runGateway(context, responseScript(ids), 'baseline', `c${chainIndex}`);
  const experimental = await runGateway(context, responseScript(ids), 'experimental', `c${chainIndex}`);
  const invariants: Record<string, boolean> = {};
  const base = baseline.provider.inputs;
  const exp = experimental.provider.inputs;

  invariants.both_completed = baseline.error === null && experimental.error === null;
  invariants.same_call_count = base.length === exp.length;
  invariants.prompts_identical = base.every((input, index) => canonicalJson(input.prompt) === canonicalJson(exp[index]?.prompt));
  invariants.tool_definitions_identical = base.every((input, index) => canonicalJson(input.tool_runtime?.available_tools) === canonicalJson(exp[index]?.tool_runtime?.available_tools));
  invariants.previous_response_ids_identical = base.every((input, index) => (input.previous_response_id ?? null) === (exp[index]?.previous_response_id ?? null));

  const baseIds = deliveredIds(baseline.provider);
  const expIds = deliveredIds(experimental.provider);
  invariants.experimental_is_baseline_minus_earlier = baseIds.every((ids, index) => {
    const earlier = new Set(baseIds.slice(0, index).flat());
    return canonicalJson(ids.filter((id) => !earlier.has(id))) === canonicalJson(expIds[index]);
  });
  invariants.no_output_sent_twice = new Set(expIds.flat()).size === expIds.flat().length;
  invariants.outputs_answer_previous_response_in_order = expIds.every((ids, index) => index === 0
    ? ids.length === 0
    : canonicalJson(ids) === canonicalJson(toolCallsPerResponse[index - 1]?.slice(0, ids.length).map((call) => call.call_id)));
  invariants.context_preserved_union_equals_baseline_final = canonicalJson([...expIds.flat()].sort()) === canonicalJson([...(baseIds.at(-1) ?? [])].sort());
  invariants.output_payloads_identical = exp.every((input, index) => (input.tool_runtime?.tool_results ?? []).every((result) => {
    const twin = (base[index]?.tool_runtime?.tool_results ?? []).find((candidate) => candidate.call_id === result.call_id);
    return twin !== undefined && canonicalJson(twin.result) === canonicalJson(result.result);
  }));
  invariants.final_results_identical = canonicalJson(baseline.execution?.result) === canonicalJson(experimental.execution?.result);
  invariants.context_package_unchanged = createHash('sha256').update(canonicalJson(context)).digest('hex') === contextHashBefore;

  const ledger = experimental.execution?.metadata.context_package_usage?.provider_call_ledger as Record<string, any> | undefined;
  const budgetCapped = toolCallsPerResponse.some((calls, index) => (expIds[index + 1]?.length ?? 0) < calls.length);

  return {
    chain: chainIndex,
    source: chain[0].__source,
    captured_calls: chain.length,
    replayed_calls: { baseline: base.length, experimental: exp.length },
    tool_calls_reconstructed: toolCallCount,
    tool_outputs_reproduced_exactly: reproducedExactly,
    tool_calls_unanswered_due_to_budget: budgetCapped,
    errors: { baseline: baseline.error, experimental: experimental.error },
    invariants,
    per_call: base.map((input, index) => ({
      call: index + 1,
      delivery: ledger?.calls?.[index]?.tool_result_delivery ?? null,
      outputs_baseline: baseIds[index].length,
      outputs_experimental: expIds[index]?.length ?? null,
      body_bytes_baseline: providerBodyBytes(input),
      body_bytes_experimental: exp[index] ? providerBodyBytes(exp[index]) : null,
      omitted_bytes: ledger?.calls?.[index]?.tool_results_omitted_chained_bytes ?? null,
    })),
  };
}

/** Part C: failure and fallback paths, replayed offline on one captured chain. */
async function failurePaths(chain: CaptureRow[]) {
  const context = chain[0].context_package;
  const calls = reconstructToolCalls(chain).slice(0, -1).map((group) => group.map((call) => ({
    call_id: call.call_id, tool_name: call.tool_name, arguments: { time_range: call.range, detail_level: 'SIGNIFICANT_EVENTS' },
  })));
  if (calls.length < 2) return null;

  const missingId = await runGateway(context, [toolResponse('r1', calls[0]), toolResponse(null, calls[1]), ...calls.slice(2).map((group, i) => toolResponse(`r${i + 3}`, group)), finalResponse()], 'experimental', 'fallback');
  const missingIdBaseline = await runGateway(context, [toolResponse('r1', calls[0]), toolResponse(null, calls[1]), ...calls.slice(2).map((group, i) => toolResponse(`r${i + 3}`, group)), finalResponse()], 'baseline', 'fallback');
  const rejected = await runGateway(context, [toolResponse('r1', calls[0]), new AiProviderError('Previous response not found', false, 'previous_response_not_found')], 'experimental', 'rejected');
  const retry = await runGateway(context, [toolResponse('r1b', calls[0]), toolResponse('r2b', calls[1]), ...calls.slice(2).map((group, i) => toolResponse(`r${i + 3}b`, group)), finalResponse()], 'experimental', 'retry');
  const fallbackLedger = missingId.execution?.metadata.context_package_usage?.provider_call_ledger as Record<string, any> | undefined;

  return {
    missing_response_id: {
      completed: missingId.error === null,
      third_call_delivery: fallbackLedger?.calls?.[2]?.tool_result_delivery ?? null,
      third_call_identical_to_baseline: canonicalJson(missingId.provider.inputs[2]) === canonicalJson(missingIdBaseline.provider.inputs[2]),
      no_output_missing: deliveredIds(missingId.provider)[2]?.length === deliveredIds(missingIdBaseline.provider)[2]?.length,
    },
    rejected_chain: {
      failed_closed: rejected.execution === null,
      error_code: rejected.error,
      calls_attempted: rejected.provider.inputs.length,
    },
    retry_after_failure: {
      completed: retry.error === null,
      first_call_has_no_previous_response_id: (retry.provider.inputs[0]?.previous_response_id ?? null) === null,
      first_call_has_no_tool_outputs: (retry.provider.inputs[0]?.tool_runtime?.tool_results ?? []).length === 0,
      no_output_sent_twice: new Set(deliveredIds(retry.provider).flat()).size === deliveredIds(retry.provider).flat().length,
    },
  };
}

/** Part D: two different patients' chains interleaved on one gateway instance. */
async function isolation(chainA: CaptureRow[], chainB: CaptureRow[]) {
  const build = (chain: CaptureRow[], tag: string) => {
    const calls = reconstructToolCalls(chain).slice(0, -1).map((group) => group.map((call) => ({
      call_id: `${tag}-${call.call_id}`, tool_name: call.tool_name, arguments: { time_range: call.range, detail_level: 'SIGNIFICANT_EVENTS' },
    })));
    return [...calls.map((group, index) => toolResponse(`${tag}-resp-${index + 1}`, group)), finalResponse()];
  };
  return withEnv('experimental', async () => {
    const providerA = new ReplayProvider(build(chainA, 'A'));
    const providerB = new ReplayProvider(build(chainB, 'B'));
    const contextA = { ...chainA[0].context_package, patient_ref: { patient_id: 'isolation-patient-a' } };
    const contextB = { ...chainB[0].context_package, patient_ref: { patient_id: 'isolation-patient-b' } };
    await Promise.all([
      new AiGatewayService(providerA).execute({ task: taskFor(contextA, 'iso-a'), context_package: contextA, timeout_ms: 600_000 }),
      new AiGatewayService(providerB).execute({ task: taskFor(contextB, 'iso-b'), context_package: contextB, timeout_ms: 600_000 }),
    ]);
    const leaks = (provider: ReplayProvider, own: string) => provider.inputs.some((input) =>
      (input.previous_response_id && !input.previous_response_id.startsWith(own))
      || (input.tool_runtime?.tool_results ?? []).some((result) => !result.call_id.startsWith(own)));
    return { cross_chain_leak_a: leaks(providerA, 'A'), cross_chain_leak_b: leaks(providerB, 'B') };
  });
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const [outArg, ...captureFiles] = positionalArguments(argv, []);
  // Validated before any capture is read.
  const outPath = resolveEvaluationOutputFile(outArg);
  requireInputFileArgument(captureFiles[0], 'capture file');
  const chains = captureFiles.flatMap((file) => splitChains(readFileSync(file, 'utf8').split('\n').filter(Boolean)
    .map((line) => ({ ...JSON.parse(line), __source: file.split('/').pop() }))));
  const multiTurn = chains.filter((chain) => chain.length >= 2 && chain[0].context_package?.analytical_evidence);

  const capturedBodies = multiTurn.map((chain, index) => ({ chain: index + 1, source: chain[0].__source, calls: analyzeCapturedBodies(chain) }));
  const replays = [];
  for (const [index, chain] of multiTurn.entries()) replays.push(await replayChain(chain, index + 1));
  const withForkPoints = multiTurn.filter((chain) => chain.length >= 3);
  const failure = withForkPoints[0] ? await failurePaths(withForkPoints[0]) : null;
  const iso = withForkPoints.length >= 2 ? await isolation(withForkPoints[0], withForkPoints[withForkPoints.length - 1]) : null;

  writeEvaluationOutputFile(outPath, `${JSON.stringify({ generated_at: new Date().toISOString(), chains_total: chains.length, multi_turn_chains: multiTurn.length, captured_bodies: capturedBodies, replays, failure_paths: failure, isolation: iso }, null, 2)}\n`);
  console.log(`wrote ${outPath}: ${multiTurn.length} multi-turn chains`);
}

if (require.main === module) {
  void main().catch((error) => {
    console.error(describeErrorSafely(error));
    process.exitCode = 1;
  });
}
