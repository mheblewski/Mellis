import 'dotenv/config';
import {
  resetDevFirstSliceScenario,
  runDevFirstSliceScenario,
} from '../modules/integrations/nightscout/application/dev-first-slice-runner';

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const shouldResetOnly = args.has('--reset');

  if (shouldResetOnly) {
    await resetDevFirstSliceScenario();
    console.log('FIRST SLICE DEV SCENARIO RESET COMPLETE');
    return;
  }

  const result = await runDevFirstSliceScenario();

  console.log('FIRST SLICE DEV SCENARIO READY');
  console.log('');
  console.log(`patientId: ${result.patientId}`);
  console.log(`hypo episode: ${result.hypo.episode_id} (${result.hypo.started_at} - ${result.hypo.ended_at})`);
  console.log(`sent to the caregiver: ${result.conversations} conversations, ${result.queuedHypoPushes} hypo pushes (expected 0: nothing is asked after the fact)`);
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});