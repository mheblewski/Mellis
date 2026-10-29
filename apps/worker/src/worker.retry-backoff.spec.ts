import { describe, expect, it } from 'vitest';
import { jobErrorDetail, retryBackoffSeconds } from './worker.service';

describe('retrying a failed job', () => {
  it('retries a chat answer within seconds (someone is waiting), other jobs after a minute, doubling', () => {
    expect([1, 2, 3, 4].map((attempts) => retryBackoffSeconds('conversation.direct_response', attempts))).toEqual([5, 15, 60, 120]);
    expect([1, 2].map((attempts) => retryBackoffSeconds('conversation.time_range_analysis', attempts))).toEqual([5, 15]);
    expect([1, 2, 3].map((attempts) => retryBackoffSeconds('nightscout.sync', attempts))).toEqual([60, 120, 240]);
    expect(retryBackoffSeconds('nightscout.sync', 20)).toBe(1800);
  });

  it('logs what went wrong in one short line', () => {
    class AiExecutionError extends Error {}
    expect(jobErrorDetail(new AiExecutionError('Connection error.'))).toBe('AiExecutionError: Connection error.');
    expect(jobErrorDetail(new Error(`a\n${'x'.repeat(300)}`))).toHaveLength(200);
    expect(jobErrorDetail(new Error('patient 3f2c9a1e-5b7d-4e8a-9c21-6d4e8f0a7b13 not found'))).toBe('Error: patient <id> not found');
  });
});
