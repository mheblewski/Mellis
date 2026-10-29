import 'reflect-metadata';
import { Pool } from 'pg';
import { PostgresGlucoMindRepository } from '@infra/db/postgres-glucomind.repository';
import { PostgresDeviceAuthRepository } from '@infra/db/postgres-device-auth.repository';
import { existsSync } from 'node:fs';
import { FileExperimentBudgetLedger, initializeExperimentBudgetLedger, summarizeExperimentBudget } from '@modules/ai-gateway/infrastructure/experiment-budget-ledger';
import { newOneTimeCode } from '@modules/device-auth/domain/device-crypto';
import { checkAiSetup, parseAiSetupInput } from '@modules/ai-setup/ai-key-check';
import { DeviceAuthService } from '../application/device-auth.service';
import { PostgresRagChunkStore } from '@infra/db/postgres-rag-chunks.repository';
import { resolveKnowledgeDir, runKnowledgeBuild, type KnowledgeBuildInput } from '@infra/db/knowledge-build';
import { createGuardedOpenAiEmbeddingsClientFromEnv, type OpenAiEmbeddingsTransport } from '@modules/ai-gateway/infrastructure/guarded-openai-client';

/**
 * Server-side admin commands of a self-hosted Mellis, compiled into the release image (no tsx there):
 *
 *   node dist/apps/api/src/cli/mellis-admin.js <command> [options]
 *
 *   generate-code              a fresh random code (the installer writes it to .env as SETUP_CODE)
 *   setup-status               whether the setup is open, how many patients, owners and devices
 *   owners                     every owner (name, since when, patients, devices, Cognito logins, last activity), the
 *                              longest-standing first: who to pair when a restored database has several
 *   reset-owner [--name Ania | --user <user_id>]
 *                              a 10-minute pairing link for an owner (shell access = owner); --name adds a new owner
 *                              of every patient, --user pairs that owner (NOT_AN_OWNER otherwise), neither: the first
 *                              owner (the recovery person), else the longest-standing one
 *   check-ai                   checks AI_PROVIDER's key (+ the optional OPENAI_API_KEY with Claude) with free model-list
 *                              calls, from the environment (keys never on the command line); prints what the server can do
 *   ai-budget --total 20 --max-calls 2000 [--monthly] [--time-zone Europe/Warsaw] [--currency USD]
 *             [--experiment-id mellis] [--path /abs/ledger.json]
 *                              creates the AI budget ledger the worker requires (AI_EXPERIMENT_BUDGET_LEDGER_PATH);
 *                              --monthly: the limit applies per calendar month in TZ and starts over by itself
 *   ai-limit --total 15 [--max-calls n]
 *                              the monthly AI limit ("mellis → Zmień ustawienia → Limit AI"): creates the monthly ledger,
 *                              or changes the limit of the existing one keeping what was spent (a one-off ledger becomes
 *                              monthly from this month)
 *   ai-status                  this month's limit, spending, calls, whether the limit is reached and when it starts over
 *   patients                   every patient with its Nightscout address, whether a token is stored, the newest reading
 *   check-nightscout [--exclude-patient <id>]
 *                              tests MELLIS_NIGHTSCOUT_URL / MELLIS_NIGHTSCOUT_TOKEN from the environment, stores nothing
 *   set-nightscout --patient <id>
 *                              tests and stores MELLIS_NIGHTSCOUT_URL / MELLIS_NIGHTSCOUT_TOKEN for the patient (replaces
 *                              the stored one: after a restore, or "Zmień ustawienia → Nightscout")
 *   recovery-code [--user <user_id>]
 *                              a new recovery code for the first owner, or that owner (the old code stops working)
 *   knowledge-build [--force] [--no-embeddings] [--replace-foreign]
 *                              builds the search index of the shipped knowledge base (knowledge/ in the image,
 *                              MELLIS_KNOWLEDGE_DIR overrides) when it changed: full text only without OPENAI_API_KEY,
 *                              with it also embeddings through the cost guard and AI ledger; keeps a corpus it did not
 *                              build (production's own index) unless --replace-foreign (infra/db/knowledge-build.ts)
 *
 * The bash tool `mellis` wraps these (docs/device-auth-api.md). Output is one JSON line on stdout.
 */
export async function main(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  out: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
  fetchImpl?: Parameters<typeof checkAiSetup>[1],
  overrides: { embeddings?: OpenAiEmbeddingsTransport | null; knowledgeStore?: KnowledgeBuildInput['store'] } = {},
): Promise<number> {
  const [command, ...rest] = argv;
  const option = (flag: string): string | null => {
    const index = rest.indexOf(flag);
    const value = index >= 0 ? rest[index + 1] : undefined;
    return value && !value.startsWith('--') ? value : null;
  };

  if (command === 'generate-code') {
    out(JSON.stringify({ code: newOneTimeCode() }));
    return 0;
  }

  if (command === 'check-ai') {
    const provider = (env.AI_PROVIDER ?? '').trim().toLowerCase();
    try {
      const input = parseAiSetupInput({
        provider,
        api_key: provider === 'openai' ? env.OPENAI_API_KEY : env.ANTHROPIC_API_KEY,
        openai_api_key: provider === 'openai' ? undefined : env.OPENAI_API_KEY,
      });
      const result = await checkAiSetup(input, fetchImpl);
      out(JSON.stringify({ ok: true, checked: result.checked, capabilities: result.capabilities }));
      return 0;
    } catch (error) {
      out(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
      return 1;
    }
  }

  const ledgerPath = option('--path') ?? env.AI_EXPERIMENT_BUDGET_LEDGER_PATH?.trim() ?? '';
  const timeZone = option('--time-zone') ?? (env.TZ?.trim() || 'Europe/Warsaw');
  const maxCallCost = Number(env.AI_EXPERIMENT_MAX_COST);
  const failed = (error: unknown): number => {
    out(JSON.stringify({ error: (error as { code?: string }).code ?? (error instanceof Error ? error.message : String(error)) }));
    return 1;
  };

  if (command === 'ai-budget') {
    try {
      // Refuses to overwrite an existing ledger (its spending would be lost).
      const ledger = initializeExperimentBudgetLedger(ledgerPath, {
        experiment_id: option('--experiment-id') ?? 'mellis',
        currency: option('--currency') ?? env.AI_EXPERIMENT_COST_CURRENCY?.trim() ?? 'USD',
        total_budget: Number(option('--total')),
        max_calls: Number(option('--max-calls')),
        monthly_time_zone: rest.includes('--monthly') ? timeZone : null,
      });
      out(JSON.stringify({ ledger: ledgerPath, experiment_id: ledger.experiment_id, currency: ledger.currency, total_budget: ledger.total_budget, max_calls: ledger.max_calls, period: ledger.period ?? null, ...summarizeExperimentBudget(ledger) }));
      return 0;
    } catch (error) {
      return failed(error);
    }
  }

  if (command === 'ai-limit') {
    const total = Number(option('--total'));
    const maxCalls = option('--max-calls') ? Number(option('--max-calls')) : defaultMonthlyCalls(total);
    try {
      if (!existsSync(ledgerPath)) {
        initializeExperimentBudgetLedger(ledgerPath, {
          experiment_id: 'mellis',
          currency: env.AI_EXPERIMENT_COST_CURRENCY?.trim() || 'USD',
          total_budget: total,
          max_calls: maxCalls,
          monthly_time_zone: timeZone,
        });
      } else {
        new FileExperimentBudgetLedger(ledgerPath).setLimit({ total_budget: total, max_calls: maxCalls, monthly_time_zone: timeZone });
      }
      out(JSON.stringify({ ledger: ledgerPath, ...new FileExperimentBudgetLedger(ledgerPath).status(Number.isFinite(maxCallCost) ? maxCallCost : null) }));
      return 0;
    } catch (error) {
      return failed(error);
    }
  }

  if (command === 'ai-status') {
    try {
      out(JSON.stringify({ ledger: ledgerPath, ...new FileExperimentBudgetLedger(ledgerPath).status(Number.isFinite(maxCallCost) ? maxCallCost : null) }));
      return 0;
    } catch (error) {
      return failed(error);
    }
  }

  const databaseCommands = ['setup-status', 'owners', 'reset-owner', 'patients', 'check-nightscout', 'set-nightscout', 'recovery-code', 'knowledge-build'];
  if (!command || !databaseCommands.includes(command)) {
    out(JSON.stringify({
      error: 'USAGE',
      commands: ['generate-code', 'setup-status', 'check-ai', 'owners', 'reset-owner [--name <first name> | --user <user_id>]', 'ai-budget --total <amount> --max-calls <n> [--monthly]',
        'ai-limit --total <amount> [--max-calls <n>]', 'ai-status', 'patients', 'check-nightscout [--exclude-patient <id>]', 'set-nightscout --patient <id>', 'recovery-code [--user <user_id>]',
        'knowledge-build [--force] [--no-embeddings] [--replace-foreign]'],
    }));
    return 2;
  }

  if (command === 'reset-owner' && option('--name') && option('--user')) {
    out(JSON.stringify({ error: 'USAGE', command: 'reset-owner [--name <first name> | --user <user_id>]' }));
    return 2;
  }

  if (command === 'knowledge-build' && overrides.knowledgeStore) return knowledgeBuild(rest, env, out, overrides.knowledgeStore, overrides.embeddings);

  const databaseUrl = env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    out(JSON.stringify({ error: 'DATABASE_URL is required' }));
    return 2;
  }
  const pool = new Pool({ connectionString: databaseUrl, max: 2 });
  try {
    if (command === 'setup-status') {
      const state = await new PostgresDeviceAuthRepository(pool).getSetupState();
      const counts = (await pool.query<{ patients: number; owners: number; devices: number }>(
        `SELECT (SELECT count(*)::int FROM patients) AS patients,
                (SELECT count(DISTINCT user_id)::int FROM caregiver_relationships WHERE is_owner) AS owners,
                (SELECT count(*)::int FROM devices WHERE revoked_at IS NULL) AS devices`,
      )).rows[0];
      out(JSON.stringify({ auth_mode: (env.AUTH_MODE ?? 'cognito').trim().toLowerCase(), setup: state.completed_at ? 'COMPLETED' : 'OPEN', first_owner_named: !!state.recovery_user_id, has_recovery_code: state.has_recovery_code, setup_code_configured: (env.SETUP_CODE ?? '').trim().length >= 16, ...counts }));
      return 0;
    }
    if (command === 'knowledge-build') return await knowledgeBuild(rest, env, out, new PostgresRagChunkStore(pool), overrides.embeddings);
    const service = new DeviceAuthService(pool, new PostgresGlucoMindRepository(pool));
    if (command === 'owners') {
      out(JSON.stringify({ owners: await service.listOwners() }));
      return 0;
    }
    if (command === 'patients') {
      out(JSON.stringify({ patients: await service.listPatientSources() }));
      return 0;
    }
    if (command === 'check-nightscout') {
      out(JSON.stringify(await service.checkNightscout(env.MELLIS_NIGHTSCOUT_URL, env.MELLIS_NIGHTSCOUT_TOKEN, option('--exclude-patient'))));
      return 0;
    }
    if (command === 'set-nightscout') {
      const patientId = option('--patient');
      if (!patientId) {
        out(JSON.stringify({ error: 'USAGE', command: 'set-nightscout --patient <id>' }));
        return 2;
      }
      out(JSON.stringify(await service.replacePatientNightscout(patientId, env.MELLIS_NIGHTSCOUT_URL, env.MELLIS_NIGHTSCOUT_TOKEN)));
      return 0;
    }
    if (command === 'recovery-code') {
      out(JSON.stringify(await service.replaceRecoveryCode(option('--user'))));
      return 0;
    }
    const result = await service.resetOwner(option('--name'), env.PUBLIC_BASE_URL?.trim() || null, new Date(), option('--user'));
    out(JSON.stringify(result));
    return 0;
  } catch (error) {
    return failed(error);
  } finally {
    await pool.end();
  }
}

/**
 * knowledge-build: the embeddings client only with OPENAI_API_KEY (and not --no-embeddings); a missing cost guard or
 * ledger means a full-text build, never an unguarded call. One JSON line: the build result.
 */
async function knowledgeBuild(
  rest: readonly string[],
  env: NodeJS.ProcessEnv,
  out: (line: string) => void,
  store: KnowledgeBuildInput['store'],
  embeddingsOverride: OpenAiEmbeddingsTransport | null | undefined,
): Promise<number> {
  let embeddings: OpenAiEmbeddingsTransport | null = null;
  let embeddingError: string | null = null;
  const apiKey = env.OPENAI_API_KEY?.trim();
  if (!rest.includes('--no-embeddings') && apiKey) {
    if (embeddingsOverride !== undefined) embeddings = embeddingsOverride;
    else {
      try {
        embeddings = createGuardedOpenAiEmbeddingsClientFromEnv(env, apiKey);
      } catch (error) {
        embeddingError = error instanceof Error ? error.message.slice(0, 300) : 'EMBEDDINGS_NOT_CONFIGURED';
      }
    }
  }
  try {
    const result = await runKnowledgeBuild({
      store,
      dir: resolveKnowledgeDir(env),
      embeddings,
      force: rest.includes('--force'),
      replaceForeign: rest.includes('--replace-foreign'),
      log: (line) => process.stderr.write(`${line}\n`),
    });
    out(JSON.stringify({ ok: true, ...result, embedding_error: result.embedding_error ?? embeddingError }));
    return 0;
  } catch (error) {
    out(JSON.stringify({ ok: false, error: error instanceof Error ? error.message.slice(0, 2000) : String(error) }));
    return 1;
  }
}

/** Calls allowed per month with a monthly limit: generous (a chat answer is a few calls); the money limit binds first. */
export function defaultMonthlyCalls(total: number): number {
  return Number.isFinite(total) && total > 0 ? Math.max(1000, Math.ceil(total * 500)) : Number.NaN;
}

if (require.main === module) {
  void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
