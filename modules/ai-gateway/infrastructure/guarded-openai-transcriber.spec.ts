import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AiProviderError } from './ai-provider.error';
import { FileExperimentBudgetLedger, initializeExperimentBudgetLedger } from './experiment-budget-ledger';
import { createGuardedOpenAiTranscriber, createGuardedOpenAiTranscriberFromEnv, type GuardedTranscriptionRequest, type TranscriptionPricingConfig } from './guarded-openai-client';

// Guarded transcriptions with a fake transport and a ledger file in a temporary directory: offline, nothing billed.

vi.mock('openai', () => ({
  default: class {
    readonly audio = { transcriptions: { create: vi.fn() } };
  },
  toFile: async (data: Buffer, name: string) => ({ name, size: data.length }),
}));

const PRICING: TranscriptionPricingConfig = { per_minute: 0.0045, currency: 'USD', pricing_version: 'synthetic-transcribe.v1' };
const GUARD = { max_cost: 0.25, currency: 'USD' };
const REQUEST: GuardedTranscriptionRequest = { model: 'gpt-transcribe', audio: Buffer.from('audio'), filename: 'voice.m4a', duration_seconds: 20, languages: ['pl'], prompt: 'Bolus' };

let dir: string;
let ledgerPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'guarded-transcriber-'));
  ledgerPath = join(dir, 'ledger.json');
  initializeExperimentBudgetLedger(ledgerPath, { experiment_id: 'transcriber-test', currency: 'USD', total_budget: 0.05, max_calls: 3 });
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

function transcriber(create: ReturnType<typeof vi.fn>, overrides: Partial<Parameters<typeof createGuardedOpenAiTranscriber>[0]> = {}) {
  return createGuardedOpenAiTranscriber({ transport: { audio: { transcriptions: { create } } }, pricing: PRICING, costGuard: GUARD, ledger: new FileExperimentBudgetLedger(ledgerPath), ...overrides });
}

function reservations() {
  return new FileExperimentBudgetLedger(ledgerPath).read().reservations;
}

describe('guarded transcriber', () => {
  it('reserves the length bound, sends once without retries and settles the billed seconds', async () => {
    const create = vi.fn(async (_body: Record<string, unknown>, _options?: Record<string, unknown>) => ({ text: 'Cukier 145', usage: { type: 'duration', seconds: 21 } }));
    const result = await transcriber(create).transcribe(REQUEST, { timeout: 30_000 });

    expect(result).toEqual({ text: 'Cukier 145', billed_seconds: 21, cost: (21 / 60) * 0.0045 });
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0]).toMatchObject({ model: 'gpt-transcribe', file: { name: 'voice.m4a' }, response_format: 'json', languages: ['pl'], prompt: 'Bolus' });
    expect(create.mock.calls[0][1]).toMatchObject({ maxRetries: 0, timeout: 30_000 });
    const [reservation] = reservations();
    expect(reservation.max_cost).toBeCloseTo(((20 * 1.1 + 2) / 60) * 0.0045, 12);
    expect(reservation.status).toBe('SETTLED');
    expect(reservation.actual_cost).toBeCloseTo((21 / 60) * 0.0045, 12);
  });

  it('keeps the worst case charged when no billed seconds come back', async () => {
    const create = vi.fn(async () => ({ text: 'Hipo', usage: { type: 'tokens', input_tokens: 10, output_tokens: 2 } }));
    const result = await transcriber(create).transcribe(REQUEST);

    expect(result.billed_seconds).toBeNull();
    const [reservation] = reservations();
    expect(reservation.actual_cost).toBeCloseTo(reservation.max_cost, 12);
  });

  it('a failed call stays charged at its worst case and is rethrown', async () => {
    const create = vi.fn(async () => {
      throw new Error('network down');
    });
    await expect(transcriber(create).transcribe(REQUEST)).rejects.toThrow('network down');
    expect(reservations()[0].status).toBe('OUTCOME_UNKNOWN');
  });

  it('refuses without pricing, guard or ledger, a currency mismatch, an empty or endless recording, before any traffic', async () => {
    const create = vi.fn();
    await expect(transcriber(create, { pricing: null }).transcribe(REQUEST)).rejects.toBeInstanceOf(AiProviderError);
    await expect(transcriber(create, { costGuard: null }).transcribe(REQUEST)).rejects.toBeInstanceOf(AiProviderError);
    await expect(transcriber(create, { ledger: null }).transcribe(REQUEST)).rejects.toBeInstanceOf(AiProviderError);
    await expect(transcriber(create, { pricing: { ...PRICING, currency: 'EUR' } }).transcribe(REQUEST)).rejects.toThrow(/CURRENCY_MISMATCH/);
    await expect(transcriber(create).transcribe({ ...REQUEST, duration_seconds: 0 })).rejects.toThrow(/INVALID_REQUEST_SIZE/);
    await expect(transcriber(create).transcribe({ ...REQUEST, audio: Buffer.alloc(0) })).rejects.toThrow(/INVALID_REQUEST_SIZE/);
    // 4000 minutes at 0.0045 is far over the 0.25 per-call limit.
    await expect(transcriber(create).transcribe({ ...REQUEST, duration_seconds: 240_000 })).rejects.toThrow(/MAX_COST_EXCEEDS_LIMIT/);
    expect(create).not.toHaveBeenCalled();
    expect(reservations()).toHaveLength(0);
  });

  it('stops at the ledger call limit', async () => {
    const create = vi.fn(async () => ({ text: 'x', usage: { type: 'duration', seconds: 1 } }));
    const guarded = transcriber(create);
    for (let call = 0; call < 3; call += 1) await guarded.transcribe(REQUEST);
    await expect(guarded.transcribe(REQUEST)).rejects.toThrow(/EXPERIMENT_CALL_LIMIT_REACHED/);
    expect(create).toHaveBeenCalledTimes(3);
  });

  it('from the environment needs the transcription price and the ledger', () => {
    const env = {
      OPENAI_TRANSCRIPTION_PRICING_PER_MINUTE: '0.0045',
      OPENAI_TRANSCRIPTION_PRICING_VERSION: 'v1',
      OPENAI_PRICING_CURRENCY: 'USD',
      AI_EXPERIMENT_MAX_COST: '0.25',
      AI_EXPERIMENT_COST_CURRENCY: 'USD',
      AI_EXPERIMENT_BUDGET_LEDGER_PATH: ledgerPath,
    };
    expect(createGuardedOpenAiTranscriberFromEnv(env, 'sk-test')).toBeDefined();
    expect(() => createGuardedOpenAiTranscriberFromEnv({ ...env, OPENAI_TRANSCRIPTION_PRICING_PER_MINUTE: '' }, 'sk-test')).toThrow(/INCOMPLETE_PRICING/);
    expect(() => createGuardedOpenAiTranscriberFromEnv({ ...env, AI_EXPERIMENT_BUDGET_LEDGER_PATH: '' }, 'sk-test')).toThrow(/AI_EXPERIMENT_BUDGET_LEDGER_PATH/);
    expect(() => createGuardedOpenAiTranscriberFromEnv({ ...env, AI_EXPERIMENT_BUDGET_LEDGER_PATH: join(dir, 'missing.json') }, 'sk-test')).toThrow();
  });
});
