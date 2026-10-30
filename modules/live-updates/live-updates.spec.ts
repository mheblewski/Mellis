import { describe, expect, it, vi } from 'vitest';
import { parseDatabaseLiveNotification } from './application/live-event';
import { CoalescingDraftReader, LiveEventHub } from './application/live-event-hub';
import { SseEventWriter, sseOpening } from './application/sse-event-writer';

const P = '11111111-1111-4111-8111-111111111111';
const C = '22222222-2222-4222-8222-222222222222';
const M = '33333333-3333-4333-8333-333333333333';

function parseFrame(frame: string): { event: string; data: any } {
  const [eventLine, dataLine] = frame.trim().split('\n');
  return { event: eventLine!.replace('event: ', ''), data: JSON.parse(dataLine!.replace('data: ', '')) };
}

describe('parseDatabaseLiveNotification', () => {
  it('reads change and draft notifications as the triggers send them', () => {
    expect(parseDatabaseLiveNotification(JSON.stringify({ p: P, k: 'meal', id: M.toUpperCase() }))).toEqual({ patient_id: P, type: 'change', kind: 'meal', id: M });
    expect(parseDatabaseLiveNotification(JSON.stringify({ p: P, k: 'meals', id: null }))).toEqual({ patient_id: P, type: 'change', kind: 'meals', id: null });
    // A remote settings package was handed over (1.0.5): the app re-reads its own waiting packages.
    expect(parseDatabaseLiveNotification(JSON.stringify({ p: P, k: 'remote_settings_handoff', id: null }))).toEqual({ patient_id: P, type: 'change', kind: 'remote_settings_handoff', id: null });
    expect(parseDatabaseLiveNotification(JSON.stringify({ p: P, k: 'conversation_draft', id: C }))).toEqual({ patient_id: P, type: 'draft', thread: 'conversation', id: C });
    expect(parseDatabaseLiveNotification(JSON.stringify({ p: P, k: 'meal_chat_draft', id: M }))).toEqual({ patient_id: P, type: 'draft', thread: 'meal_chat', id: M });
  });

  it('drops anything unexpected', () => {
    for (const payload of ['', 'nope', '{}', JSON.stringify({ p: 'x', k: 'meal' }), JSON.stringify({ p: P, k: 'secret' }), JSON.stringify({ p: P, k: 'conversation_draft', id: null })]) {
      expect(parseDatabaseLiveNotification(payload)).toBeNull();
    }
  });
});

describe('LiveEventHub', () => {
  it('delivers to the patient only and keeps going when one listener throws', () => {
    const hub = new LiveEventHub();
    const mine = vi.fn();
    const other = vi.fn();
    hub.subscribe(P, () => { throw new Error('broken'); });
    const unsubscribe = hub.subscribe(P.toUpperCase(), mine);
    hub.subscribe(C, other);
    hub.publish(P, { type: 'resync' });
    expect(mine).toHaveBeenCalledWith({ type: 'resync' });
    expect(other).not.toHaveBeenCalled();
    unsubscribe();
    hub.publishToAll({ type: 'resync' });
    expect(mine).toHaveBeenCalledTimes(1);
    expect(other).toHaveBeenCalledTimes(1);
    expect(hub.connectionCount).toBe(2);
  });
});

describe('CoalescingDraftReader', () => {
  it('reads one thread at a time and once more for notifications during a read, publishing in write order', async () => {
    let stored = 'Gli';
    const releases: Array<() => void> = [];
    const read = vi.fn(async () => {
      const content = stored;
      await new Promise<void>((resolve) => releases.push(resolve));
      return { reply_to_message_id: 'm1', content };
    });
    const published: string[] = [];
    const reader = new CoalescingDraftReader(read, (_patient, event) => {
      if (event.type === 'draft') published.push(event.draft?.content ?? '');
    });
    reader.request(P, 'conversation', C);
    stored = 'Glike';
    reader.request(P, 'conversation', C);
    stored = 'Glikemia';
    reader.request(P, 'conversation', C);
    expect(read).toHaveBeenCalledTimes(1);
    releases.shift()!();
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    releases.shift()!();
    await reader.idle();
    expect(published).toEqual(['Gli', 'Glikemia']);
  });
});

describe('SseEventWriter', () => {
  it('sends drafts as deltas, a full text after a reset, and a clear once', () => {
    const writer = new SseEventWriter();
    const draft = (content: string, replyTo = 'm1') => writer.frame({ type: 'draft', thread: 'conversation', id: C, draft: { reply_to_message_id: replyTo, content } });
    expect(parseFrame(draft('Gli')).data).toEqual({ thread: 'conversation', id: C, reply_to: 'm1', offset: 0, delta: 'Gli' });
    expect(parseFrame(draft('Glikemia')).data).toMatchObject({ offset: 3, delta: 'kemia' });
    expect(draft('Glikemia')).toBe('');
    // The model started over (tool call) or another answer began: full text from offset 0.
    expect(parseFrame(draft('Pizza')).data).toMatchObject({ offset: 0, delta: 'Pizza' });
    expect(parseFrame(draft('Pizza', 'm2')).data).toMatchObject({ offset: 0, delta: 'Pizza', reply_to: 'm2' });
    expect(parseFrame(writer.frame({ type: 'draft', thread: 'conversation', id: C, draft: null })).data).toEqual({ thread: 'conversation', id: C, cleared: true });
    expect(writer.frame({ type: 'draft', thread: 'conversation', id: C, draft: null })).toBe('');
  });

  it('frames changes and resyncs, and forgets sent drafts on resync', () => {
    const writer = new SseEventWriter();
    expect(parseFrame(writer.frame({ type: 'change', kind: 'meal', id: M }))).toEqual({ event: 'change', data: { kind: 'meal', id: M } });
    writer.frame({ type: 'draft', thread: 'meal_chat', id: M, draft: { reply_to_message_id: 'm1', content: 'Dwa' } });
    expect(parseFrame(writer.frame({ type: 'resync' })).event).toBe('resync');
    expect(parseFrame(writer.frame({ type: 'draft', thread: 'meal_chat', id: M, draft: { reply_to_message_id: 'm1', content: 'Dwa kawałki' } })).data).toMatchObject({ offset: 0 });
  });

  it('opens with padding and the retry delay', () => {
    expect(sseOpening(3000)).toMatch(/^: {2048}\nretry: 3000\n\n$/);
  });
});
