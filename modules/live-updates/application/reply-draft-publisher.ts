/** Where a draft is kept: one answer in one thread (see PostgresReplyDraftRepository). */
export interface ReplyDraftStore {
  write(content: string): Promise<void>;
  remove(): Promise<void>;
}

/**
 * Keeps the stored draft of one answer close to what the model has written, without a database write per delta: at
 * most one write per interval, writes in order, and the latest text is always written. `finish` stops writing and
 * deletes the draft; call it after the answer is stored (or failed), so no late write can bring the draft back.
 * A failing write is logged and skipped: the draft is only a preview of the stored answer.
 */
export class ReplyDraftPublisher {
  private latest: string | null = null;
  private written: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private chain: Promise<void> = Promise.resolve();
  private lastWriteAt = 0;
  private finished = false;

  constructor(
    private readonly store: ReplyDraftStore,
    private readonly intervalMs = 200,
    private readonly onError: (error: unknown) => void = () => undefined,
    private readonly now: () => number = Date.now,
  ) {}

  update(content: string): void {
    if (this.finished) return;
    this.latest = content;
    if (this.timer) return;
    const wait = Math.max(0, this.lastWriteAt + this.intervalMs - this.now());
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, wait);
  }

  /** Stops writing, waits for a write in progress and deletes the draft. Idempotent. */
  async finish(): Promise<void> {
    if (this.finished) {
      await this.chain;
      return;
    }
    this.finished = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const hadDraft = this.written !== null || this.latest !== null;
    this.chain = this.chain.then(async () => {
      if (!hadDraft) return;
      try {
        await this.store.remove();
      } catch (error) {
        this.onError(error);
      }
    });
    await this.chain;
  }

  private flush(): void {
    this.chain = this.chain.then(async () => {
      const content = this.latest;
      if (this.finished || content === null || content === this.written) return;
      this.lastWriteAt = this.now();
      try {
        await this.store.write(content);
        this.written = content;
      } catch (error) {
        this.onError(error);
      }
    });
  }
}
