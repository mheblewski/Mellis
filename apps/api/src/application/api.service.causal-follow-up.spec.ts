import { describe, expect, it } from 'vitest';
import { determineUserMessageCapability } from '@modules/context/application/investigation-policy';
import { routeUserMessage } from '@modules/context/application/message-routing';

// Offline: only the message routing of ApiService.handleUserMessage (no repository, no database).
const CONVERSATION_ID = 'conversation-causal-1';
const REQUESTED_AT = '2026-10-15T08:43:25.000Z';
const ANALYSED_RANGE = {
  range_type: 'SHORT_RANGE',
  range_start: '2026-10-12T22:00:00.000Z',
  range_end: '2026-10-15T08:42:51.000Z',
  timezone: 'Europe/Warsaw',
  normalization_policy_version: 'time-range-normalization.v1',
};

function resolveRange(messages: Array<Record<string, unknown>>, content: string) {
  const route = routeUserMessage({ content, messages, conversationId: CONVERSATION_ID, requestedAtIso: REQUESTED_AT, timezone: 'Europe/Warsaw', hasPhotos: false });
  return route.route === 'ANALYSIS' ? route.window : null;
}

const analysisAboutYesterday = [
  { id: 'm1', role: 'USER', message_type: 'USER_MESSAGE', content: 'Co było wczoraj największym problemem?', metadata: { decision: 'ANALYSIS_REQUEST' } },
  { id: 'm2', role: 'ASSISTANT', message_type: 'ASSISTANT_MESSAGE', content: 'Wczoraj wystąpiły dwa niskie odczyty.', metadata: { decision: 'ANALYSIS_REQUEST', ...ANALYSED_RANGE } },
];

describe('causal hypo follow-ups are routed to the time-range analysis (offline)', () => {
  it('sends "Co spowodowało tę hipoglikemię?" after an analysis of yesterday to that analysed range, not to a direct response', () => {
    // The keyword classifier alone would answer it directly, without any patient evidence.
    expect(determineUserMessageCapability('Co spowodowało tę hipoglikemię?')).toBe('DIRECT_RESPONSE');

    const range = resolveRange(analysisAboutYesterday, 'Co spowodowało tę hipoglikemię?');
    // The analysed period continues up to the question (anything that happened since is in the window).
    expect(range).toMatchObject({ rangeType: 'SHORT_RANGE', rangeStart: ANALYSED_RANGE.range_start, rangeEnd: REQUESTED_AT });
  });

  it('keeps the analysed range when a direct reply without a range came in between', () => {
    const messages = [
      ...analysisAboutYesterday,
      { id: 'm3', role: 'USER', message_type: 'USER_MESSAGE', content: 'Co oznacza IOB?', metadata: { decision: 'DIRECT_RESPONSE' } },
      { id: 'm4', role: 'ASSISTANT', message_type: 'ASSISTANT_MESSAGE', content: 'IOB to insulina aktywna.', metadata: { decision: 'DIRECT_RESPONSE' } },
    ];
    expect(resolveRange(messages, 'Jaka była przyczyna tej hipoglikemii?')).toMatchObject({ rangeType: 'SHORT_RANGE', rangeStart: ANALYSED_RANGE.range_start });
  });

  it('falls back to the 3-day window (three complete days plus today) containing yesterday when the analysed answer carries no range', () => {
    const messages = analysisAboutYesterday.map((message) => (message.role === 'ASSISTANT' ? { ...message, metadata: { decision: 'ANALYSIS_REQUEST' } } : message));
    expect(resolveRange(messages, 'Co spowodowało tę hipoglikemię?')).toMatchObject({ rangeType: 'SHORT_RANGE', rangeStart: '2026-10-11T22:00:00.000Z' });
  });

  it('analyses yesterday\'s window without a previous analysed answer, and answers thanks directly', () => {
    expect(resolveRange([analysisAboutYesterday[0]], 'Co spowodowało tę hipoglikemię?')).toMatchObject({ rangeType: 'SHORT_RANGE', rangeStart: '2026-10-11T22:00:00.000Z' });
    expect(resolveRange(analysisAboutYesterday, 'Dziękuję')).toBeNull();
  });

  it('lets a day count named in a follow-up win over the analysed period', () => {
    // "dzisiaj" earlier in the conversation and a causal word would otherwise pin it to the analysed range.
    const messages = [
      { id: 'm1', role: 'USER', message_type: 'USER_MESSAGE', content: 'Co było dzisiaj największym problemem?', metadata: { decision: 'ANALYSIS_REQUEST' } },
      { id: 'm2', role: 'ASSISTANT', message_type: 'ASSISTANT_MESSAGE', content: 'Dwa niskie odczyty.', metadata: { decision: 'ANALYSIS_REQUEST', ...ANALYSED_RANGE } },
    ];
    expect(resolveRange(messages, 'Co powodowało spadki po obiedzie w ostatnich 7 dniach?')).toMatchObject({ rangeType: 'MEDIUM_RANGE' });
    expect(resolveRange(messages, 'Jaka była przyczyna spadków w ostatnich 14 dniach?')).toMatchObject({ rangeType: 'LONG_RANGE' });
    // Without a day count the causal follow-up still continues the analysed period.
    expect(resolveRange(messages, 'Co spowodowało ten spadek?')).toMatchObject({ rangeType: 'SHORT_RANGE', rangeStart: ANALYSED_RANGE.range_start });
  });
});
