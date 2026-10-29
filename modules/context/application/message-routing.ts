import { resolveConversationContext, type ConversationMessageReference } from './conversation-context-resolver';
import { isGeneralKnowledgeQuestion, isSocialMessage } from './investigation-policy';
import {
  isSupportedConversationTimeRangeType,
  mergeRequirements,
  normalizeTimeRangeRequest,
  patternRequirement,
  rangeTypeCoveringDaysBack,
  readMessagePeriod,
  validateNormalizedTimeRangeWindow,
  windowForRequirement,
  MAX_ANALYSIS_DAYS_BACK,
  TIME_RANGE_NORMALIZATION_POLICY_VERSION,
  type ConversationTimeRangeType,
  type ParsedTimeRangeRequest,
  type PeriodRequirement,
} from './time-range-normalization';

/** The window a time-range analysis job reads (the conversation.time_range_analysis payload). */
export interface AnalysisWindow {
  rangeType: ConversationTimeRangeType;
  rangeStart: string;
  rangeEnd: string;
  timezone: string;
  normalizationPolicyVersion: string;
}

export type MessageRoute =
  | {
    route: 'ANALYSIS';
    window: AnalysisWindow;
    /** NAMED_PERIOD: the message names it; HYPO_EPISODE: a hypo screen's chat; FOLLOW_UP: the analysed period extended to now. */
    basis: 'NAMED_PERIOD' | 'HYPO_EPISODE' | 'FOLLOW_UP' | 'DEFAULT';
  }
  | { route: 'DIRECT'; reason: 'SOCIAL' | 'GENERAL_KNOWLEDGE' | 'BEYOND_REACH' }
  /** No window could be built (invalid request time or timezone): the caller falls back to the message capability. */
  | { route: 'UNRESOLVED' };

const RANGE_TYPES_BY_SIZE: ConversationTimeRangeType[] = ['TODAY', 'SHORT_RANGE', 'MEDIUM_RANGE', 'LONG_RANGE', 'EXTENDED_RANGE'];

function toWindow(parsed: ParsedTimeRangeRequest): AnalysisWindow | null {
  if (parsed.status !== 'OK') return null;
  return {
    rangeType: parsed.value.range_type,
    rangeStart: parsed.value.range_start,
    rangeEnd: parsed.value.range_end,
    timezone: parsed.value.timezone,
    normalizationPolicyVersion: parsed.value.normalization_policy_version,
  };
}

/** The latest assistant answer that analysed a period (it carries the range); a later direct reply carries none. */
export function latestAnalysedWindow(messages: Array<Record<string, unknown>>): AnalysisWindow | null {
  const metadata = [...messages]
    .reverse()
    .map((message) => (String(message.role ?? '').toUpperCase() === 'ASSISTANT' ? message.metadata as Record<string, unknown> | null : null))
    .find((candidate) => typeof candidate?.range_start === 'string' && typeof candidate?.range_end === 'string');
  if (!metadata || !isSupportedConversationTimeRangeType(String(metadata.range_type))) return null;
  return {
    rangeType: metadata.range_type as ConversationTimeRangeType,
    rangeStart: String(metadata.range_start),
    rangeEnd: String(metadata.range_end),
    timezone: typeof metadata.timezone === 'string' ? metadata.timezone : '',
    normalizationPolicyVersion: typeof metadata.normalization_policy_version === 'string' ? metadata.normalization_policy_version : TIME_RANGE_NORMALIZATION_POLICY_VERSION,
  };
}

/**
 * A follow-up continues the analysed period up to now (2026-10-19: a question at 18:00 after a 10:00 analysis did not
 * see the afternoon, and the next morning saw nothing new), widened to what the message hints at. The analysed start
 * is kept when a range type fits the longer window; otherwise the smallest range type holding its first day is used.
 */
function extendAnalysedWindow(analysed: AnalysisWindow, hints: PeriodRequirement | null, requestedAtIso: string, timezone: string): AnalysisWindow | null {
  const analysedStartMs = Date.parse(analysed.rangeStart);
  const nowMs = Date.parse(requestedAtIso);
  if (!Number.isFinite(analysedStartMs) || !Number.isFinite(nowMs)) return null;
  const hinted = hints ? toWindow(windowForRequirement(hints, requestedAtIso, timezone)) : null;
  const startMs = Math.min(analysedStartMs, hinted ? Date.parse(hinted.rangeStart) : analysedStartMs);
  if (startMs >= nowMs) return hinted;
  for (const rangeType of RANGE_TYPES_BY_SIZE) {
    const window = { range_type: rangeType, range_start: new Date(startMs).toISOString(), range_end: new Date(nowMs).toISOString(), timezone };
    if (validateNormalizedTimeRangeWindow(window).ok) {
      return { rangeType, rangeStart: window.range_start, rangeEnd: window.range_end, timezone, normalizationPolicyVersion: TIME_RANGE_NORMALIZATION_POLICY_VERSION };
    }
  }
  const covering = toWindow(windowForRequirement({ daysBack: 0, sinceMs: startMs }, requestedAtIso, timezone));
  // An analysed period older than 30 days: the most an analysis holds.
  return covering ?? toWindow(normalizeTimeRangeRequest({ range_type: 'EXTENDED_RANGE', requested_at: requestedAtIso, timezone }));
}

function toMessageReferences(messages: Array<Record<string, unknown>>): ConversationMessageReference[] {
  return messages
    .map((message) => ({
      id: String(message.id ?? ''),
      role: (['USER', 'ASSISTANT'].includes(String(message.role ?? '').toUpperCase()) ? String(message.role).toUpperCase() : 'SYSTEM') as ConversationMessageReference['role'],
      message_type: 'OTHER' as ConversationMessageReference['message_type'],
      content: typeof message.content === 'string' ? message.content : '',
    }))
    .filter((message) => message.id.length > 0);
}

/**
 * Where a caregiver's chat message goes: a direct reply without data, or a time-range analysis of the patient's data
 * and which window it reads. Data by default (2026-10-19 audit: 37 of 95 realistic questions got no data or a window
 * that missed what they asked):
 * 1. Social messages (thanks, greetings) get a direct reply, unless they carry photos.
 * 2. A named period wins: a day count, hours, a week or month, today/now, yesterday, the night, a weekend, a weekday,
 *    a calendar date. One older than 30 days gets a direct reply that says so.
 * 3. General knowledge (definitions, how-to, privacy) gets a direct reply, unless it carries photos.
 * 4. Everything else is analysed: in a hypo screen's chat the hypo window (a recurring-pattern question gets its week);
 *    after an analysis the analysed period extended to now; otherwise today (yesterday's 3-day window when the
 *    conversation is about yesterday), widened by the message's hints (a clock time later than now is yesterday's,
 *    "kolacja" at 10:00 is yesterday's dinner, "ostatni posiłek" the last 24 h, "ostatnio" / averages / patterns a week).
 */
export function routeUserMessage(args: {
  content: string;
  /** The conversation's messages before this one (role, content, metadata with the analysed range of an answer). */
  messages: Array<Record<string, unknown>>;
  conversationId: string;
  requestedAtIso: string;
  timezone: string;
  hasPhotos: boolean;
  /** The hypo window of a hypo screen's chat, when the conversation has an episode. */
  hypoWindow?: AnalysisWindow | null;
}): MessageRoute {
  const { content, requestedAtIso, timezone, hasPhotos } = args;
  if (!hasPhotos && isSocialMessage(content)) return { route: 'DIRECT', reason: 'SOCIAL' };

  const period = readMessagePeriod(content, requestedAtIso, timezone);
  const pattern = patternRequirement(period);
  if (period.beyondReach && !hasPhotos) return { route: 'DIRECT', reason: 'BEYOND_REACH' };
  if (period.named && !period.beyondReach) {
    const window = toWindow(windowForRequirement(mergeRequirements(period.named, pattern)!, requestedAtIso, timezone));
    return window ? { route: 'ANALYSIS', window, basis: 'NAMED_PERIOD' } : { route: 'UNRESOLVED' };
  }

  // In a hypo, rescue or WBT chat a general question ("czy można podać sok?") is still about that event: answered with
  // its data, not without it.
  if (!hasPhotos && !args.hypoWindow && isGeneralKnowledgeQuestion(content)) return { route: 'DIRECT', reason: 'GENERAL_KNOWLEDGE' };

  const hints = mergeRequirements(period.soft, pattern);
  if (args.hypoWindow) {
    if (!pattern) return { route: 'ANALYSIS', window: args.hypoWindow, basis: 'HYPO_EPISODE' };
    const window = toWindow(windowForRequirement(pattern, requestedAtIso, timezone));
    return window ? { route: 'ANALYSIS', window, basis: 'NAMED_PERIOD' } : { route: 'UNRESOLVED' };
  }

  const analysed = latestAnalysedWindow(args.messages);
  if (analysed) {
    const window = extendAnalysedWindow(analysed, hints, requestedAtIso, timezone);
    return window ? { route: 'ANALYSIS', window, basis: 'FOLLOW_UP' } : { route: 'UNRESOLVED' };
  }

  // A conversation about yesterday (an earlier message said "wczoraj") keeps yesterday's 3-day window.
  const resolution = resolveConversationContext({
    conversation_id: args.conversationId,
    current_user_message: content,
    previous_messages: toMessageReferences(args.messages),
  });
  const conversationDay: PeriodRequirement = { daysBack: resolution.resolved_time_range === 'YESTERDAY' ? 1 : 0, sinceMs: null };
  const window = toWindow(windowForRequirement(mergeRequirements(conversationDay, hints)!, requestedAtIso, timezone));
  return window ? { route: 'ANALYSIS', window, basis: 'DEFAULT' } : { route: 'UNRESOLVED' };
}

const POLISH_MONTHS_GENITIVE = ['stycznia', 'lutego', 'marca', 'kwietnia', 'maja', 'czerwca', 'lipca', 'sierpnia', 'września', 'października', 'listopada', 'grudnia'];

function polishDate(dateKey: string, withYear: boolean): string {
  const [year, month, day] = dateKey.split('-').map(Number);
  return `${day} ${POLISH_MONTHS_GENITIVE[month - 1]}${withYear ? ` ${year}` : ''}`;
}

/**
 * The reply to a question about a period older than the 30 days an analysis holds, or null when the message names
 * none. Written without a model call.
 */
export function buildBeyondReachAnswer(message: string, requestedAtIso: string, timezone: string): string | null {
  const period = readMessagePeriod(message, requestedAtIso, timezone);
  if (!period.beyondReach) return null;
  const earliest = toWindow(normalizeTimeRangeRequest({ range_type: rangeTypeCoveringDaysBack(MAX_ANALYSIS_DAYS_BACK)!, requested_at: requestedAtIso, timezone }));
  if (!earliest) return null;
  const earliestDate = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(earliest.rangeStart));
  const sameYear = earliestDate.slice(0, 4) === period.beyondReach.slice(0, 4);
  return `Mogę przeanalizować najwyżej ostatnie 30 dni, czyli dane od ${polishDate(earliestDate, !sameYear)}. `
    + `Pytanie sięga ${polishDate(period.beyondReach, true)}, więc tego okresu nie przeanalizuję. `
    + 'Zapytaj o dzień albo okres z ostatnich 30 dni, np. „podsumuj ostatni miesiąc”.';
}
