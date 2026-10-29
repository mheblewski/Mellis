import { resolveHomeTimeZone } from '@shared/primitives/home-time-zone';
import { createHash } from 'node:crypto';

export type ConversationReferenceStatus = 'RESOLVED' | 'UNRESOLVED' | 'AMBIGUOUS' | 'UNKNOWN';
export type ConversationTimeRange = 'TODAY' | 'YESTERDAY' | 'LAST_24H' | 'CUSTOM' | 'UNKNOWN';
export type ConversationIntent = 'ANALYSIS_REQUEST' | 'INVESTIGATION_REQUIRED' | 'DIRECT_RESPONSE' | 'CAUSAL_ANALYSIS' | 'UNKNOWN';

/** A message before the current one; `previous_messages` lists them oldest first. */
export interface ConversationMessageReference {
  role: 'USER' | 'ASSISTANT' | 'SYSTEM';
  message_type?: 'USER_MESSAGE' | 'ASSISTANT_MESSAGE' | 'CONTEXT_QUESTION' | 'CONTEXT_ANSWER' | 'ANALYSIS_SUMMARY' | 'RECOMMENDATION' | 'OTHER';
  content?: string | null;
  id?: string | null;
}

export interface KnownEpisodeCandidate {
  episode_id: string;
  started_at?: string | null;
  ended_at?: string | null;
}

export interface ConversationContextResolution {
  conversation_id: string;
  current_user_message_id: string | null;
  resolved_intent: ConversationIntent;
  resolved_time_range: ConversationTimeRange;
  resolved_event_refs: string[];
  resolved_investigation_refs: string[];
  resolved_question_refs: string[];
  relevant_previous_message_refs: string[];
  unresolved_references: string[];
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  status: ConversationReferenceStatus;
  resolution_policy_version: string;
  deterministic_hash: string;
  provenance: {
    source_message_ids: string[];
    notes: string[];
  };
}

const DEFAULT_POLICY_VERSION = 'conversation-context-resolver.v1';

function canonicalText(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[łŁ]/g, 'l')
    .replace(/[ąĄ]/g, 'a')
    .replace(/[ćĆ]/g, 'c')
    .replace(/[ęĘ]/g, 'e')
    .replace(/[óÓ]/g, 'o')
    .replace(/[śŚ]/g, 's')
    .replace(/[żŻ]/g, 'z')
    .replace(/[źŹ]/g, 'z')
    .replace(/[ńŃ]/g, 'n')
    .trim();
}

function buildDeterministicHash(payload: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

/**
 * Wording that asks what caused something ("co spowodowało tę hipoglikemię?", "jaka była przyczyna?", "dlaczego spadł?",
 * "skąd ten wzrost?"), on canonical text. Not causal: "dlaczego nie mogę…" / "czemu służy…" (how-to), "dzięki czemu",
 * "skąd wiesz / skąd masz te dane" (where an answer comes from).
 */
const CAUSAL_QUESTION_PATTERN = new RegExp([
  'spowodowal|spowodowac|spowodowalo|przyczyn|wywolal|co moglo|moglo je powodowac|jak moglo|\\bco sprawil',
  '\\bz jakiego powodu\\b|\\bpowodem\\b',
  '(?<!\\b(?:dzieki|ku|przeciw|wbrew) )\\b(?:dlaczego|czemu)\\b(?! (?:nie )?(?:moge|mozna|da sie|sluz)\\w*)',
  '\\bskad\\b(?![^?.!]{0,40}\\b(?:wiesz|wiem|wiadomo|masz|mam|bierzesz|pobierasz|czerpiesz|wziac)\\b)',
  'what caused|cause of|\\bwhy\\b|\\bhow come\\b|\\breason for\\b',
].join('|'));

export function isCausalQuestion(text: string): boolean {
  return CAUSAL_QUESTION_PATTERN.test(canonicalText(text));
}

function inferIntent(text: string): ConversationIntent {
  const normalized = canonicalText(text);
  if (!normalized) {
    return 'UNKNOWN';
  }
  if (/przeanalizuj|analizuj|analiza/.test(normalized) || CAUSAL_QUESTION_PATTERN.test(normalized)) {
    return 'CAUSAL_ANALYSIS';
  }
  if (/dlaczego|why|co zmienilo|jak dlugo|po obiedzie|rosl/.test(normalized)) {
    return 'INVESTIGATION_REQUIRED';
  }
  if (/dzisiejszy dzien|podsumuj dzien|ostatnie 24/.test(normalized)) {
    return 'ANALYSIS_REQUEST';
  }
  return 'UNKNOWN';
}

const TODAY_WORDS = /\bdzis\b|\bdzisiaj\b|\bdzisiejsz\w*|\btoday\b/g;
/** "wczoraj" and its forms, not "przedwczoraj" (two days ago). */
const YESTERDAY_WORDS = /(?:^|[^a-z])wczoraj\w*|\byesterday\b/g;

/** The day a text mentions last ("wczoraj było źle, a dziś?" is about today), or null. */
function latestDayMention(text: string): 'TODAY' | 'YESTERDAY' | null {
  const normalized = canonicalText(text);
  const lastIndex = (pattern: RegExp) => Math.max(-1, ...[...normalized.matchAll(pattern)].map((match) => match.index ?? -1));
  const today = lastIndex(TODAY_WORDS);
  const yesterday = lastIndex(YESTERDAY_WORDS);
  if (today < 0 && yesterday < 0) return null;
  return today > yesterday ? 'TODAY' : 'YESTERDAY';
}

/**
 * The day the conversation is about: the current message's own day word (today wins when it names both), otherwise
 * the latest mention in the caregiver's earlier messages, newest first, and only then in the assistant's.
 */
function inferTimeRange(text: string, previousMessages: ConversationMessageReference[]): ConversationTimeRange {
  const normalized = canonicalText(text);
  if (normalized.match(TODAY_WORDS)) {
    return 'TODAY';
  }
  if (normalized.match(YESTERDAY_WORDS)) {
    return 'YESTERDAY';
  }
  const newestFirst = [...previousMessages].reverse();
  for (const role of ['USER', 'ASSISTANT'] as const) {
    for (const message of newestFirst.filter((candidate) => candidate.role === role)) {
      const mention = latestDayMention(message.content ?? '');
      if (mention) return mention;
    }
  }
  return 'UNKNOWN';
}

/** "8:05" or "8.05" (with or without a leading zero) for an instant on the local clock; never inside "18:05". */
function localClockPattern(iso: string, timeZone: string): RegExp | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? 'NaN');
  const minute = parts.find((part) => part.type === 'minute')?.value ?? '';
  if (!Number.isFinite(hour) || minute.length !== 2) return null;
  return new RegExp(`(?<![\\d:.])0?${hour}[:.]${minute}(?!\\d)`);
}

function matchEpisodeCandidatesByTimeWindows(
  previousMessages: ConversationMessageReference[],
  knownEpisodeCandidates: KnownEpisodeCandidate[],
  timeZone: string,
): string[] {
  const previousText = previousMessages.map((message) => message.content ?? '').join(' ');
  const normalizedText = canonicalText(previousText);

  if (!normalizedText || knownEpisodeCandidates.length === 0) {
    return [];
  }

  const matchedIds: string[] = [];
  for (const candidate of knownEpisodeCandidates) {
    if (!candidate.started_at || !candidate.ended_at) {
      continue;
    }

    const startClock = localClockPattern(candidate.started_at, timeZone);
    const endClock = localClockPattern(candidate.ended_at, timeZone);
    if (startClock && endClock && startClock.test(normalizedText) && endClock.test(normalizedText)) {
      matchedIds.push(candidate.episode_id);
    }
  }

  return [...new Set(matchedIds)];
}

export function resolveConversationContext(args: {
  conversation_id: string;
  current_user_message_id?: string | null;
  current_user_message: string;
  previous_messages?: ConversationMessageReference[];
  known_episode_candidates?: KnownEpisodeCandidate[];
  /** The clock caregivers write times on (episode times are matched in it); defaults to TZ, else Europe/Warsaw. */
  timezone?: string;
}): ConversationContextResolution {
  const previousMessages = args.previous_messages ?? [];
  const knownEpisodeCandidates = args.known_episode_candidates ?? [];
  const timeRange = inferTimeRange(args.current_user_message, previousMessages);
  const resolvedIntent = inferIntent(args.current_user_message);
  const eventRefs = matchEpisodeCandidatesByTimeWindows(previousMessages, knownEpisodeCandidates, args.timezone ?? resolveHomeTimeZone());
  const relevantPreviousMessageRefs = previousMessages
    .filter((message) => message.role === 'ASSISTANT' && (message.content ?? '').trim().length > 0)
    .map((message) => message.id ?? `${message.role}:${message.content ?? ''}`)
    .filter(Boolean);

  const unresolvedRefs: string[] = [];
  if (resolvedIntent === 'CAUSAL_ANALYSIS' && timeRange === 'UNKNOWN') {
    unresolvedRefs.push('time_range');
  }
  if (resolvedIntent === 'CAUSAL_ANALYSIS' && eventRefs.length === 0 && previousMessages.length > 0) {
    unresolvedRefs.push('episode_reference');
  }

  const resolvedQuestionRefs: string[] = [];
  const resolvedInvestigationRefs: string[] = [];
  const status: ConversationReferenceStatus = (
    timeRange !== 'UNKNOWN' && eventRefs.length > 0 && unresolvedRefs.length === 0
  )
    ? 'RESOLVED'
    : (eventRefs.length > 0 || timeRange !== 'UNKNOWN')
      ? 'UNRESOLVED'
      : 'UNKNOWN';

  const provenance = {
    source_message_ids: relevantPreviousMessageRefs,
    notes: [
      timeRange !== 'UNKNOWN' ? `Resolved time range: ${timeRange}` : 'Time range not yet resolved',
      eventRefs.length > 0 ? `Resolved event refs: ${eventRefs.join(',')}` : 'No event refs resolved from prior conversation',
    ],
  };

  const payload: Omit<ConversationContextResolution, 'deterministic_hash'> = {
    conversation_id: args.conversation_id,
    current_user_message_id: args.current_user_message_id ?? null,
    resolved_intent: resolvedIntent,
    resolved_time_range: timeRange,
    resolved_event_refs: [...eventRefs],
    resolved_investigation_refs: [...resolvedInvestigationRefs],
    resolved_question_refs: [...resolvedQuestionRefs],
    relevant_previous_message_refs: [...relevantPreviousMessageRefs],
    unresolved_references: [...unresolvedRefs],
    confidence: status === 'RESOLVED' ? 'HIGH' : 'MEDIUM',
    status,
    resolution_policy_version: DEFAULT_POLICY_VERSION,
    provenance,
  };

  return {
    ...payload,
    deterministic_hash: buildDeterministicHash(payload),
  };
}

export function shouldSkipUserClarificationQuestion(
  conversationContext: Pick<ConversationContextResolution, 'status' | 'resolved_time_range' | 'resolved_event_refs'>,
): boolean {
  return conversationContext.status === 'RESOLVED'
    && conversationContext.resolved_time_range !== 'UNKNOWN'
    && conversationContext.resolved_event_refs.length > 0;
}
