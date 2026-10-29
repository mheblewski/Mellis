import { describe, expect, it } from 'vitest';
import { mapWithConcurrency } from './map-with-concurrency';

describe('mapWithConcurrency', () => {
  it('keeps the order and never runs more than the limit at once', async () => {
    let running = 0;
    let most = 0;
    const result = await mapWithConcurrency([30, 5, 20, 1, 10, 2], 3, async (ms, index) => {
      running += 1;
      most = Math.max(most, running);
      await new Promise((resolve) => setTimeout(resolve, ms));
      running -= 1;
      return `${index}:${ms}`;
    });
    expect(result).toEqual(['0:30', '1:5', '2:20', '3:1', '4:10', '5:2']);
    expect(most).toBe(3);
  });

  it('handles an empty list and passes a failure on', async () => {
    expect(await mapWithConcurrency([], 4, async () => 1)).toEqual([]);
    await expect(mapWithConcurrency([1, 2], 2, async (n) => { if (n === 2) throw new Error('boom'); return n; })).rejects.toThrow('boom');
  });
});
