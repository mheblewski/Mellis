import { Inject, Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import type { Pool } from 'pg';
import { DATABASE_POOL } from '@infra/db/database.tokens';
import { PostgresChannelListener } from '@infra/db/postgres-channel-listener';
import { PostgresReplyDraftRepository } from '@infra/db/postgres-reply-drafts.repository';
import { parseDatabaseLiveNotification, type LiveEvent } from '@modules/live-updates/application/live-event';
import { CoalescingDraftReader, LiveEventHub } from '@modules/live-updates/application/live-event-hub';
import { SSE_HEARTBEAT, SseEventWriter, sseFrame, sseOpening } from '@modules/live-updates/application/sse-event-writer';

export const LIVE_EVENTS_CHANNEL = 'glucomind_events';
const HEARTBEAT_MS = 15_000;
/** The stream ends after this long and the app reconnects with a fresh token (access is checked on every connect). */
const MAX_CONNECTION_MS = 15 * 60_000;
const RETRY_MS = 3_000;

/**
 * Live updates for the app: one LISTEN connection to Postgres, fanned out to each patient's open Server-Sent Events
 * streams. Drafts are read once per notification and sent as deltas per connection.
 */
@Injectable()
export class LiveEventsService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger('LiveEvents');
  private readonly hub = new LiveEventHub();
  private readonly drafts: PostgresReplyDraftRepository;
  private readonly draftReader: CoalescingDraftReader;
  private readonly listener: PostgresChannelListener;
  private readonly closers = new Set<() => void>();

  constructor(@Inject(DATABASE_POOL) pool: Pool, @Inject(ConfigService) config: ConfigService) {
    this.drafts = new PostgresReplyDraftRepository(pool);
    this.draftReader = new CoalescingDraftReader(
      async (thread, threadId, patientId) => {
        const draft = await this.drafts.get(thread === 'conversation' ? 'CONVERSATION' : 'MEAL_CHAT', threadId, patientId);
        return draft ? { reply_to_message_id: draft.reply_to_message_id, content: draft.content } : null;
      },
      (patientId, event) => this.hub.publish(patientId, event),
      (error) => this.logger.warn(JSON.stringify({ event: 'live_draft_read_failed', error: (error as Error).message })),
    );
    this.listener = new PostgresChannelListener({
      connectionString: config.getOrThrow<string>('DATABASE_URL'),
      channels: [LIVE_EVENTS_CHANNEL],
      onNotification: (_channel, payload) => this.handleNotification(payload),
      // Notifications sent while there was no connection are lost: every app connected meanwhile re-reads what it shows.
      onConnected: () => this.hub.publishToAll({ type: 'resync' }),
      log: (entry) => this.logger.log(JSON.stringify(entry)),
    });
  }

  async onModuleInit(): Promise<void> {
    // Never blocks startup: without the listener the app falls back to polling until it reconnects.
    void this.listener.start();
  }

  async onApplicationShutdown(): Promise<void> {
    for (const close of [...this.closers]) close();
    await this.listener.stop();
  }

  handleNotification(payload: string): void {
    const notification = parseDatabaseLiveNotification(payload);
    if (!notification || !this.hub.hasSubscribers(notification.patient_id)) return;
    if (notification.type === 'draft') {
      this.draftReader.request(notification.patient_id, notification.thread, notification.id);
      return;
    }
    this.hub.publish(notification.patient_id, { type: 'change', kind: notification.kind, id: notification.id });
  }

  /** Streams the patient's events until the app disconnects or the connection reaches its maximum age. */
  stream(patientId: string, request: Request, response: Response): void {
    // The app went away while its access was being checked: nothing to stream to (and no close event will come).
    if (request.socket.destroyed || response.destroyed || response.writableEnded) return;
    response.status(200);
    response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    response.setHeader('Cache-Control', 'no-cache, no-store, no-transform');
    response.setHeader('Connection', 'keep-alive');
    // nginx and compatible proxies: do not buffer this response.
    response.setHeader('X-Accel-Buffering', 'no');
    response.flushHeaders();
    request.socket.setNoDelay(true);
    request.socket.setKeepAlive(true);

    const writer = new SseEventWriter();
    const openedAt = Date.now();
    let eventsSent = 0;
    const write = (chunk: string) => {
      if (chunk && !response.writableEnded) response.write(chunk);
    };
    write(sseOpening(RETRY_MS));
    write(sseFrame('ready', { heartbeat_s: HEARTBEAT_MS / 1000, live: this.listener.connected }));

    const unsubscribe = this.hub.subscribe(patientId, (event: LiveEvent) => {
      const frame = writer.frame(event);
      if (frame) eventsSent += 1;
      write(frame);
    });
    const heartbeat = setInterval(() => write(SSE_HEARTBEAT), HEARTBEAT_MS);
    const maxAge = setTimeout(() => close('max_age'), MAX_CONNECTION_MS);
    let closed = false;
    const close = (reason: 'app' | 'max_age' | 'error' | 'shutdown') => {
      if (closed) return;
      closed = true;
      // Connections that keep ending after about 45 s mean a proxy holds the stream back (the app's idle timeout).
      this.logger.log(JSON.stringify({ event: 'live_stream_closed', reason, duration_ms: Date.now() - openedAt, events_sent: eventsSent, open_streams: this.hub.connectionCount - 1 }));
      clearInterval(heartbeat);
      clearTimeout(maxAge);
      unsubscribe();
      this.closers.delete(closeOnShutdown);
      if (!response.writableEnded) response.end();
    };
    const closeOnShutdown = () => close('shutdown');
    this.closers.add(closeOnShutdown);
    // The response closes when the app disconnects (request 'close' may fire as soon as the request body is read).
    response.on('close', () => close('app'));
    response.on('error', () => close('error'));
  }
}
