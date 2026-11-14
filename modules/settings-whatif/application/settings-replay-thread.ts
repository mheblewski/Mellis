import { join } from 'path';
import { isMainThread, parentPort, workerData } from 'worker_threads';
import type { WhatIfData } from './icr-whatif';
import type { SettingChange } from './settings-replay';
import { settingsReplayCard, type SettingsReplayCardResult } from './settings-replay-service';
import { runInThread } from './replay-thread';

/** The card for one change (the −/+ on a card), counted off the API's main thread. */
export interface ReplayCardTask { kind: 'SETTINGS_REPLAY_CARD'; data: WhatIfData; change: SettingChange; check_date: string | null }

const run = (task: ReplayCardTask) => settingsReplayCard(task.data, task.change, { check_date: task.check_date });

export function settingsReplayCardOffThread(task: ReplayCardTask): Promise<SettingsReplayCardResult> {
  return runInThread(join(__dirname, 'settings-replay-thread.js'), task, () => run(task));
}

if (!isMainThread && parentPort && (workerData as ReplayCardTask | undefined)?.kind === 'SETTINGS_REPLAY_CARD') {
  parentPort.postMessage(run(workerData as ReplayCardTask));
}
