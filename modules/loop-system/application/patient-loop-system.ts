import { detectLoopSystem, type LoopSystem } from '../domain/loop-system';

/** Where the patient's newest loop calculation is read from (PostgresDashboardRepository). */
export interface LoopStatusSource {
  getLatestLoopStatus(patientId: string): Promise<{ raw_payload: Record<string, unknown> } | null>;
}

/** The system running the patient's loop now: the one that uploaded its newest calculation. */
export async function patientLoopSystem(source: LoopStatusSource, patientId: string): Promise<LoopSystem> {
  return detectLoopSystem((await source.getLatestLoopStatus(patientId))?.raw_payload);
}
