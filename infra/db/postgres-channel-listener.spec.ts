import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PostgresChannelListener, type ListenerClient } from './postgres-channel-listener';

class FakeClient extends EventEmitter {
  queries: string[] = [];
  ended = false;
  constructor(private readonly failConnect: boolean) {
    super();
  }
  async connect() {
    if (this.failConnect) throw new Error('refused');
  }
  async query(sql: string) {
    this.queries.push(sql);
  }
  async end() {
    this.ended = true;
  }
}

describe('PostgresChannelListener', () => {
  afterEach(() => vi.useRealTimers());

  it('listens, forwards notifications, reconnects after a lost connection and reports the reconnect', async () => {
    vi.useFakeTimers();
    const clients: FakeClient[] = [];
    const plan = [false, true, false];
    const notifications: string[] = [];
    const onConnected = vi.fn();
    const listener = new PostgresChannelListener({
      connectionString: 'postgres://test',
      channels: ['glucomind_events'],
      onNotification: (channel, payload) => notifications.push(`${channel}:${payload}`),
      onConnected,
      createClient: () => {
        const client = new FakeClient(plan.shift() ?? false);
        clients.push(client);
        return client as unknown as ListenerClient;
      },
      retryDelayMs: () => 100,
      log: () => undefined,
    });
    await listener.start();
    expect(clients[0]!.queries).toEqual(['LISTEN glucomind_events']);
    clients[0]!.emit('notification', { channel: 'glucomind_events', payload: '{"a":1}' });
    expect(notifications).toEqual(['glucomind_events:{"a":1}']);
    expect(onConnected.mock.calls).toEqual([[false]]);

    clients[0]!.emit('error', new Error('connection lost'));
    expect(listener.connected).toBe(false);
    await vi.advanceTimersByTimeAsync(100); // second client fails to connect
    await vi.advanceTimersByTimeAsync(100); // third connects
    expect(clients).toHaveLength(3);
    expect(listener.connected).toBe(true);
    expect(onConnected.mock.calls).toEqual([[false], [true]]);

    await listener.stop();
    expect(clients[2]!.ended).toBe(true);
    clients[2]!.emit('end');
    await vi.advanceTimersByTimeAsync(1000);
    expect(clients).toHaveLength(3);
  });

  it('refuses channel names that are not plain identifiers', () => {
    expect(() => new PostgresChannelListener({ connectionString: 'x', channels: ['bad; DROP'], onNotification: () => undefined })).toThrow('Invalid channel');
  });
});
