import type { DraftThread, LiveEvent } from './live-event';

export type LiveEventListener = (event: LiveEvent) => void;

/** Fans events out to the open connections of each patient. */
export class LiveEventHub {
  private readonly listeners = new Map<string, Set<LiveEventListener>>();

  subscribe(patientId: string, listener: LiveEventListener): () => void {
    const key = patientId.toLowerCase();
    const set = this.listeners.get(key) ?? new Set<LiveEventListener>();
    set.add(listener);
    this.listeners.set(key, set);
    return () => {
      set.delete(listener);
      if (set.size === 0 && this.listeners.get(key) === set) this.listeners.delete(key);
    };
  }

  hasSubscribers(patientId: string): boolean {
    return (this.listeners.get(patientId.toLowerCase())?.size ?? 0) > 0;
  }

  get connectionCount(): number {
    let count = 0;
    for (const set of this.listeners.values()) count += set.size;
    return count;
  }

  publish(patientId: string, event: LiveEvent): void {
    for (const listener of [...(this.listeners.get(patientId.toLowerCase()) ?? [])]) deliver(listener, event);
  }

  publishToAll(event: LiveEvent): void {
    for (const set of [...this.listeners.values()]) {
      for (const listener of [...set]) deliver(listener, event);
    }
  }
}

function deliver(listener: LiveEventListener, event: LiveEvent): void {
  try {
    listener(event);
  } catch {
    // One broken connection must not stop the others.
  }
}

/**
 * Reads a draft when its notification arrives, at most one read per thread at a time: notifications that arrive during
 * a read cause one more read afterwards. Drafts are therefore published in the order they were written and the last
 * write is never missed.
 */
export class CoalescingDraftReader {
  private readonly running = new Map<string, { again: boolean }>();

  constructor(
    private readonly read: (thread: DraftThread, threadId: string, patientId: string) => Promise<{ reply_to_message_id: string; content: string } | null>,
    private readonly publish: (patientId: string, event: LiveEvent) => void,
    private readonly onError: (error: unknown) => void = () => undefined,
  ) {}

  request(patientId: string, thread: DraftThread, threadId: string): void {
    const key = `${patientId}:${thread}:${threadId}`;
    const current = this.running.get(key);
    if (current) {
      current.again = true;
      return;
    }
    const state = { again: false };
    this.running.set(key, state);
    void (async () => {
      try {
        do {
          state.again = false;
          try {
            const draft = await this.read(thread, threadId, patientId);
            this.publish(patientId, { type: 'draft', thread, id: threadId, draft });
          } catch (error) {
            this.onError(error);
          }
        } while (state.again);
      } finally {
        this.running.delete(key);
      }
    })();
  }

  /** Resolves when no read is running (tests). */
  async idle(): Promise<void> {
    while (this.running.size > 0) await new Promise((resolve) => setTimeout(resolve, 1));
  }
}
