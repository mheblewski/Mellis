import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LiveEventsService } from './live-events.service';

const P = '11111111-1111-4111-8111-111111111111';
const C = '22222222-2222-4222-8222-222222222222';

class FakeResponse extends EventEmitter {
  chunks: string[] = [];
  headers: Record<string, string> = {};
  statusCode = 0;
  writableEnded = false;
  status(code: number) { this.statusCode = code; return this; }
  setHeader(name: string, value: string) { this.headers[name] = value; }
  flushHeaders() {}
  write(chunk: string) { this.chunks.push(chunk); return true; }
  end() { this.writableEnded = true; this.emit('close'); }
}

function setup(draftRows: Array<Record<string, unknown>> = []) {
  const pool = { query: vi.fn(async () => ({ rows: draftRows })) };
  const config = { getOrThrow: () => 'postgres://unused' };
  const service = new LiveEventsService(pool as any, config as any);
  const request = { socket: { setNoDelay: vi.fn(), setKeepAlive: vi.fn(), destroyed: false } };
  const response = new FakeResponse();
  return { service, pool, request, response };
}

const frames = (response: FakeResponse) => response.chunks.filter((chunk) => chunk.startsWith('event: ')).map((chunk) => chunk.split('\n')[0]!.slice(7));

describe('LiveEventsService.stream', () => {
  afterEach(() => vi.useRealTimers());

  it('opens an event stream and forwards the patient changes', () => {
    const { service, request, response } = setup();
    service.stream(P, request as any, response as any);
    expect(response.statusCode).toBe(200);
    expect(response.headers['Content-Type']).toBe('text/event-stream; charset=utf-8');
    expect(response.headers['X-Accel-Buffering']).toBe('no');
    expect(frames(response)).toEqual(['ready']);

    service.handleNotification(JSON.stringify({ p: P, k: 'meal', id: C }));
    service.handleNotification(JSON.stringify({ p: '99999999-9999-4999-8999-999999999999', k: 'meal', id: C }));
    expect(frames(response)).toEqual(['ready', 'change']);
    expect(response.chunks.at(-1)).toContain(`"kind":"meal","id":"${C}"`);
  });

  it('reads a draft once and sends it as a delta', async () => {
    const { service, pool, request, response } = setup([{ thread_kind: 'CONVERSATION', thread_id: C, reply_to_message_id: 'm1', content: 'Glikemia', updated_at: new Date() }]);
    service.stream(P, request as any, response as any);
    service.handleNotification(JSON.stringify({ p: P, k: 'conversation_draft', id: C }));
    await vi.waitFor(() => expect(frames(response)).toContain('draft'));
    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(response.chunks.at(-1)).toContain('"offset":0,"delta":"Glikemia"');
  });

  it('does not read drafts nobody watches, sends heartbeats and stops at the maximum age', async () => {
    vi.useFakeTimers();
    const { service, pool, request, response } = setup();
    service.handleNotification(JSON.stringify({ p: P, k: 'conversation_draft', id: C }));
    expect(pool.query).not.toHaveBeenCalled();

    service.stream(P, request as any, response as any);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(response.chunks.at(-1)).toBe(': ping\n\n');
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(response.writableEnded).toBe(true);
    // Unsubscribed: later notifications go nowhere.
    const count = response.chunks.length;
    service.handleNotification(JSON.stringify({ p: P, k: 'meal', id: C }));
    expect(response.chunks).toHaveLength(count);
  });

  it('does not subscribe a connection the app dropped while its access was checked', () => {
    const { service, request, response } = setup();
    request.socket.destroyed = true;
    service.stream(P, request as any, response as any);
    expect(response.chunks).toEqual([]);
    expect((service as any).hub.connectionCount).toBe(0);
  });

  it('closes streams on shutdown', async () => {
    const { service, request, response } = setup();
    service.stream(P, request as any, response as any);
    await service.onApplicationShutdown();
    expect(response.writableEnded).toBe(true);
  });
});
