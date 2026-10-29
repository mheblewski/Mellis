import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReplyDraftPublisher } from './application/reply-draft-publisher';

function store() {
  const log: string[] = [];
  return {
    log,
    write: vi.fn(async (content: string) => { log.push(`write:${content}`); }),
    remove: vi.fn(async () => { log.push('remove'); }),
  };
}

describe('ReplyDraftPublisher', () => {
  afterEach(() => vi.useRealTimers());

  it('writes at most once per interval, always the latest text, and deletes the draft at the end', async () => {
    vi.useFakeTimers();
    const target = store();
    const publisher = new ReplyDraftPublisher(target, 200);
    publisher.update('G');
    await vi.advanceTimersByTimeAsync(0);
    publisher.update('Gli');
    publisher.update('Glike');
    await vi.advanceTimersByTimeAsync(100);
    expect(target.log).toEqual(['write:G']);
    publisher.update('Glikemia');
    await vi.advanceTimersByTimeAsync(100);
    expect(target.log).toEqual(['write:G', 'write:Glikemia']);
    await publisher.finish();
    publisher.update('late');
    await vi.advanceTimersByTimeAsync(500);
    expect(target.log).toEqual(['write:G', 'write:Glikemia', 'remove']);
  });

  it('a pending write is dropped by finish, and finish without any draft deletes nothing', async () => {
    vi.useFakeTimers();
    const target = store();
    const publisher = new ReplyDraftPublisher(target, 200);
    publisher.update('A');
    await vi.advanceTimersByTimeAsync(0);
    publisher.update('AB');
    await publisher.finish();
    await publisher.finish();
    await vi.advanceTimersByTimeAsync(500);
    expect(target.log).toEqual(['write:A', 'remove']);

    const empty = store();
    await new ReplyDraftPublisher(empty).finish();
    expect(empty.log).toEqual([]);
  });

  it('skips a failed write and keeps going', async () => {
    vi.useFakeTimers();
    const target = store();
    target.write.mockRejectedValueOnce(new Error('db down'));
    const errors: unknown[] = [];
    const publisher = new ReplyDraftPublisher(target, 200, (error) => errors.push(error));
    publisher.update('A');
    await vi.advanceTimersByTimeAsync(0);
    publisher.update('AB');
    await vi.advanceTimersByTimeAsync(200);
    expect(errors).toHaveLength(1);
    expect(target.log).toEqual(['write:AB']);
  });
});
