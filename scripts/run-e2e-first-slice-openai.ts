import 'dotenv/config';
import { spawnSync } from 'child_process';

const apiKey = process.env.OPENAI_API_KEY?.trim();
if (!apiKey) {
  console.error('OPENAI_API_KEY is required when running npm run e2e:first-slice:openai');
  process.exit(1);
}

const env = {
  ...process.env,
  E2E_AI_PROVIDER: 'openai',
  // Deliberate opt-in: without it infra/testing/offline-providers.ts forces fake AI in every test run.
  ALLOW_LIVE_AI: '1',
  RUN_POSTGRES_INTEGRATION: '1',
};

console.log('[e2e:first-slice:openai] Running TODAY-analysis live E2E with the real OpenAI provider');

const result = spawnSync(
  'npx',
  ['vitest', 'run', 'apps/api/src/controllers/api-product-lifecycle.postgres.spec.ts', '--testNamePattern=LIVE: TODAY analysis', '--testTimeout=180000'],
  {
    stdio: 'inherit',
    env,
  },
);

process.exit(result.status ?? 1);
