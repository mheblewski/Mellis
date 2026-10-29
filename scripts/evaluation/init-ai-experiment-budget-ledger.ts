import { initializeExperimentBudgetLedger, summarizeExperimentBudget } from '@modules/ai-gateway/infrastructure/experiment-budget-ledger';
import { describePath } from '@modules/ai-gateway/infrastructure/evaluation-capture-path';

/**
 * Creates the durable budget ledger of one AI experiment (local file outside every Git working tree). Refuses to
 * overwrite an existing ledger. No network, no database, no AI call.
 *
 *   npx tsx --tsconfig tsconfig.json scripts/evaluation/init-ai-experiment-budget-ledger.ts \
 *     --path /abs/path/outside/repo/ledger.json --experiment-id first-paid-experiment \
 *     --total-budget 0.25 --currency USD --max-calls 1
 */
export function main(argv: readonly string[]): void {
  const value = (flag: string): string => {
    const index = argv.indexOf(flag);
    const found = index >= 0 ? argv[index + 1] : undefined;
    if (!found || found.startsWith('--')) throw new Error(`Missing ${flag}`);
    return found;
  };
  const path = value('--path');
  const ledger = initializeExperimentBudgetLedger(path, {
    experiment_id: value('--experiment-id'),
    currency: value('--currency'),
    total_budget: Number(value('--total-budget')),
    max_calls: Number(value('--max-calls')),
  });
  const summary = summarizeExperimentBudget(ledger);
  process.stdout.write(`${JSON.stringify({ ledger: describePath(path), experiment_id: ledger.experiment_id, currency: ledger.currency, total_budget: ledger.total_budget, max_calls: ledger.max_calls, ...summary })}\n`);
}

if (require.main === module) {
  main(process.argv.slice(2));
}
