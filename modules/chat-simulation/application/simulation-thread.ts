import { join } from 'path';
import { isMainThread, parentPort, workerData } from 'worker_threads';
import type { WhatIfData } from '@modules/settings-whatif/application/icr-whatif';
import { runInThread } from '@modules/settings-whatif/application/replay-thread';
import { runSimulationTool, type SimulationOutput, type SimulationToolName } from './simulation-tools';

/** One chat simulation tool call, counted off the worker's main thread (pushes, sync and other answers keep going). */
export interface SimulationTask { kind: 'CHAT_SIMULATION'; name: SimulationToolName; args: Record<string, unknown>; data: WhatIfData; now_ms: number; check_date: string | null }

const run = (task: SimulationTask) => runSimulationTool(task.name, task.args, task.data, task.now_ms, task.check_date);

export function runSimulationOffThread(task: SimulationTask, timeLimitMs: number): Promise<SimulationOutput> {
  return runInThread(join(__dirname, 'simulation-thread.js'), task, () => run(task), timeLimitMs);
}

if (!isMainThread && parentPort && (workerData as SimulationTask | undefined)?.kind === 'CHAT_SIMULATION') {
  parentPort.postMessage(run(workerData as SimulationTask));
}
