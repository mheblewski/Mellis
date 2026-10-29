import { FileExperimentBudgetLedger } from './experiment-budget-ledger';

/**
 * What the app shows about the AI limit (GET /v1/patients/:id/capabilities → `ai`): whether no more paid answer fits
 * this month, and when the monthly limit starts over. Read from the same ledger the worker reserves in.
 */
export interface AiLimitView {
  limit_reached: boolean;
  /** Start of the next month in the server's time zone; null for a one-off budget. */
  resets_at: string | null;
}

/**
 * null without paid AI (AI_PROVIDER fake or unset) or without a ledger path. A ledger that cannot be read says "not
 * reached": the worker refuses those calls anyway and the answer shows its own error.
 */
export function readAiLimitStatus(env: Record<string, string | undefined> = process.env, now: () => string = () => new Date().toISOString()): AiLimitView | null {
  const provider = (env.AI_PROVIDER ?? '').trim().toLowerCase();
  const path = env.AI_EXPERIMENT_BUDGET_LEDGER_PATH?.trim();
  if ((provider !== 'openai' && provider !== 'anthropic') || !path) return null;
  try {
    const maxCost = Number(env.AI_EXPERIMENT_MAX_COST);
    const status = new FileExperimentBudgetLedger(path, now).status(Number.isFinite(maxCost) && maxCost > 0 ? maxCost : null);
    return { limit_reached: status.limit_reached, resets_at: status.resets_at };
  } catch {
    return { limit_reached: false, resets_at: null };
  }
}
