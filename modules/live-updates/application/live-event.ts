/**
 * Live updates (live-updates.v1): what the app is told while it is open. A change event only says what to re-read;
 * the app fetches it through the usual endpoints, so access rules and response shapes stay in one place.
 */

/** Everything the app re-reads on a change event. */
export const CHANGE_KINDS = ['conversation', 'meal', 'meals', 'meal_chat', 'loop_action', 'hypo', 'notifications', 'capabilities', 'remote_command'] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];

export type DraftThread = 'conversation' | 'meal_chat';

export type LiveEvent =
  | { type: 'change'; kind: ChangeKind; id: string | null }
  /** The answer being written in a conversation or meal chat; null when it is gone (stored, failed or cancelled). */
  | { type: 'draft'; thread: DraftThread; id: string; draft: { reply_to_message_id: string; content: string } | null }
  /** Some events may have been missed (the server lost its database connection): re-read everything shown. */
  | { type: 'resync' };

/** A notification on glucomind_events as the row triggers send it (042_live_updates.sql). */
export type DatabaseLiveNotification =
  | { patient_id: string; type: 'change'; kind: ChangeKind; id: string | null }
  | { patient_id: string; type: 'draft'; thread: DraftThread; id: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Parses a trigger payload; anything unexpected is dropped (null) rather than forwarded. */
export function parseDatabaseLiveNotification(payload: string): DatabaseLiveNotification | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const { p, k, id } = parsed as { p?: unknown; k?: unknown; id?: unknown };
  if (typeof p !== 'string' || !UUID.test(p) || typeof k !== 'string') return null;
  const entityId = typeof id === 'string' && UUID.test(id) ? id.toLowerCase() : null;
  const patientId = p.toLowerCase();
  if (k === 'conversation_draft' || k === 'meal_chat_draft') {
    if (!entityId) return null;
    return { patient_id: patientId, type: 'draft', thread: k === 'conversation_draft' ? 'conversation' : 'meal_chat', id: entityId };
  }
  if (!(CHANGE_KINDS as readonly string[]).includes(k)) return null;
  return { patient_id: patientId, type: 'change', kind: k as ChangeKind, id: entityId };
}
