import type { LiveEvent } from './live-event';

/**
 * Turns live events into Server-Sent Events frames for one connection. Drafts go out as deltas: `offset` is the length
 * of the text the app already has, so it appends `delta` when its text is that long, replaces it when offset is 0, and
 * re-reads the conversation when neither fits (a frame it missed).
 *
 * Frames:
 *   event: change   data: {"kind":"meal","id":"…"}
 *   event: draft    data: {"thread":"conversation","id":"…","reply_to":"…","offset":12,"delta":"…"}
 *   event: draft    data: {"thread":"conversation","id":"…","cleared":true}
 *   event: resync   data: {}
 */
export class SseEventWriter {
  private readonly sentDrafts = new Map<string, { replyTo: string; content: string }>();

  /** The frames to write for an event; empty when the connection already has it. */
  frame(event: LiveEvent): string {
    switch (event.type) {
      case 'change':
        return sseFrame('change', { kind: event.kind, id: event.id });
      case 'resync':
        this.sentDrafts.clear();
        return sseFrame('resync', {});
      case 'draft': {
        const key = `${event.thread}:${event.id}`;
        const previous = this.sentDrafts.get(key);
        if (!event.draft) {
          if (!previous) return '';
          this.sentDrafts.delete(key);
          return sseFrame('draft', { thread: event.thread, id: event.id, cleared: true });
        }
        const { reply_to_message_id: replyTo, content } = event.draft;
        const continues = previous !== undefined && previous.replyTo === replyTo && content.startsWith(previous.content);
        if (continues && content.length === previous.content.length) return '';
        const offset = continues ? previous.content.length : 0;
        this.sentDrafts.set(key, { replyTo, content });
        return sseFrame('draft', { thread: event.thread, id: event.id, reply_to: replyTo, offset, delta: content.slice(offset) });
      }
      default:
        return '';
    }
  }
}

export function sseFrame(event: string, data: unknown): string {
  // JSON never contains a raw newline, so one data line carries the whole payload.
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** A comment line: keeps proxies and the app's idle timer from closing a quiet connection. */
export const SSE_HEARTBEAT = ': ping\n\n';

/**
 * Sent first: about 2 kB of comment so a proxy that buffers the start of a response forwards the stream at once, then
 * the reconnect delay the app should use.
 */
export function sseOpening(retryMs: number): string {
  return `:${' '.repeat(2048)}\nretry: ${retryMs}\n\n`;
}
