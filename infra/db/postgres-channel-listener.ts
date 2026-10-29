import { Client } from 'pg';

export interface ChannelListenerOptions {
  connectionString: string;
  channels: string[];
  onNotification: (channel: string, payload: string) => void;
  /**
   * Called after every successful connect, the first one included: notifications sent while there was no connection
   * (it was lost, or never came up yet) are gone, so listeners must re-read what they show.
   */
  onConnected?: (reconnect: boolean) => void;
  /** Builds the client; tests pass a fake. */
  createClient?: (connectionString: string) => ListenerClient;
  /** Delay before the n-th reconnect attempt (1-based). */
  retryDelayMs?: (attempt: number) => number;
  log?: (event: Record<string, unknown>) => void;
}

/** The part of pg.Client a listener uses. */
export interface ListenerClient {
  connect(): Promise<unknown>;
  query(sql: string): Promise<unknown>;
  end(): Promise<unknown>;
  on(event: 'notification', listener: (message: { channel: string; payload?: string }) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'end', listener: () => void): unknown;
  removeAllListeners(): unknown;
}

const DEFAULT_RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000];

/**
 * One dedicated connection that LISTENs on Postgres channels and reconnects for as long as it runs. Held outside the
 * pool: a pooled client would be handed to other queries and lose its LISTEN.
 */
export class PostgresChannelListener {
  private client: ListenerClient | null = null;
  private stopped = false;
  private everConnected = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private attempt = 0;

  constructor(private readonly options: ChannelListenerOptions) {
    for (const channel of options.channels) {
      if (!/^[a-z_][a-z0-9_]*$/.test(channel)) throw new Error(`Invalid channel name: ${channel}`);
    }
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const client = this.client;
    this.client = null;
    if (client) {
      client.removeAllListeners();
      await client.end().catch(() => undefined);
    }
  }

  get connected(): boolean {
    return this.client !== null;
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    const client = (this.options.createClient ?? ((url) => new Client({ connectionString: url }) as unknown as ListenerClient))(this.options.connectionString);
    client.on('notification', (message) => {
      try {
        this.options.onNotification(message.channel, message.payload ?? '');
      } catch (error) {
        this.log({ event: 'live_channel_handler_failed', error: (error as Error).message });
      }
    });
    client.on('error', (error) => this.handleLost(client, error));
    client.on('end', () => this.handleLost(client, null));
    try {
      await client.connect();
      for (const channel of this.options.channels) await client.query(`LISTEN ${channel}`);
    } catch (error) {
      this.handleLost(client, error as Error);
      return;
    }
    if (this.stopped) {
      client.removeAllListeners();
      await client.end().catch(() => undefined);
      return;
    }
    this.client = client;
    this.attempt = 0;
    const reconnected = this.everConnected;
    this.everConnected = true;
    this.log({ event: reconnected ? 'live_channel_reconnected' : 'live_channel_connected', channels: this.options.channels });
    this.options.onConnected?.(reconnected);
  }

  private handleLost(client: ListenerClient, error: Error | null): void {
    client.removeAllListeners();
    // Swallows the error a dead socket may still emit.
    client.on('error', () => undefined);
    void client.end().catch(() => undefined);
    if (this.client === client) this.client = null;
    if (this.stopped || this.reconnectTimer) return;
    this.attempt += 1;
    const delay = (this.options.retryDelayMs ?? ((n) => DEFAULT_RETRY_DELAYS_MS[Math.min(n, DEFAULT_RETRY_DELAYS_MS.length) - 1] as number))(this.attempt);
    this.log({ event: 'live_channel_lost', error: error?.message ?? null, retry_in_ms: delay });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
  }

  private log(event: Record<string, unknown>): void {
    (this.options.log ?? ((entry) => console.log(JSON.stringify(entry))))(event);
  }
}
