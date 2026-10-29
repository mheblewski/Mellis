import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  TIME_RANGE_FULL_REPLAY_NORMALIZER_V1,
  normalizeTimeRangeFullReplayInputV1,
} from './time-range-full-replay-normalizer-v1';

describe('TIME_RANGE_FULL_REPLAY_NORMALIZER_V1', () => {
  it('is deterministic and preserves the expected canonical shape', () => {
    const fixturePath = join(__dirname, '__fixtures__', 'time-range-full-replay-normalizer-v1.fixture.json');
    const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as any;

    const first = normalizeTimeRangeFullReplayInputV1(fixture);
    const second = normalizeTimeRangeFullReplayInputV1(fixture);

    expect(TIME_RANGE_FULL_REPLAY_NORMALIZER_V1).toBe('TIME_RANGE_FULL_REPLAY_NORMALIZER_V1');
    expect(first).toEqual(second);
    expect(first.context_package_version).toBe('conversation-time-range-context.v1');
    expect(first.analysis_request_input.user_message_id).toBe(fixture.legacy_payload.range.user_message_id);
    expect(first.conversation_context.messages.length).toBe(2);
    expect(first.analytical_evidence.summaries.glucose_count).toBe(1);
    expect(first.analytical_evidence.summaries.insulin_treatment_count).toBe(1);
    expect(first.analytical_evidence.summaries.meal_count).toBe(1);
    expect(first.provenance.selection_policy_version).toBe('conversation-time-range-context-selection.v1');
    expect(first.content_hash.startsWith('sha256:')).toBe(true);
  });
});
