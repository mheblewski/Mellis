/** audit_events older than this are deleted (sign-ins, device registrations, denied patient access). */
export const AUDIT_EVENT_RETENTION_DAYS = 180;
/** At most one retention run per hour, one bounded batch each: the table never needs a long delete. */
export const AUDIT_RETENTION_INTERVAL_MS = 60 * 60_000;
export const AUDIT_RETENTION_BATCH = 5_000;

export interface AuditRetentionStore {
  deleteAuditEventsOlderThan(cutoffIso: string, limit: number): Promise<number>;
}

export interface AuditRetentionState {
  lastRunMs: number | null;
}

const processState: AuditRetentionState = { lastRunMs: null };

/**
 * Deletes one batch of audit events older than AUDIT_EVENT_RETENTION_DAYS when the last run is an hour old. Called from
 * a periodic worker tick; never throws (a failure is logged and retried at the next due run). Returns the rows deleted.
 */
export async function pruneAuditEventsIfDue(
  store: AuditRetentionStore,
  log: (event: Record<string, unknown>) => void,
  now: Date = new Date(),
  state: AuditRetentionState = processState,
): Promise<number> {
  const nowMs = now.getTime();
  if (state.lastRunMs !== null && nowMs - state.lastRunMs < AUDIT_RETENTION_INTERVAL_MS) return 0;
  state.lastRunMs = nowMs;
  const cutoffIso = new Date(nowMs - AUDIT_EVENT_RETENTION_DAYS * 24 * 3_600_000).toISOString();
  try {
    const deleted = await store.deleteAuditEventsOlderThan(cutoffIso, AUDIT_RETENTION_BATCH);
    if (deleted > 0) log({ event: 'audit_events_pruned', deleted, cutoff: cutoffIso });
    return deleted;
  } catch (error) {
    log({ event: 'audit_events_prune_failed', error: error instanceof Error ? error.message : String(error) });
    return 0;
  }
}
