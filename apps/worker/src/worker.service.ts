import { mealWbtForAi, WbtDoseProposalSession, type WbtCurrentProposal } from '@modules/meal-wbt/application/wbt-dose-proposal-tool';
import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { resolveHomeTimeZone } from '@shared/primitives/home-time-zone';
import { ConfigService } from '@nestjs/config';
import { messagePhotoIds, PostgresGlucoMindRepository } from '@infra/db/postgres-glucomind.repository';
import { AiExecutionError, AiGateway } from '@modules/ai-gateway/domain/ai-gateway';
import {
  buildAiInputHash,
  buildContextPackageIdentityHash,
  buildAiTaskIdentity,
  createConversationDirectResponseTask,
  createConversationTimeRangeAnalysisTask,
} from '@modules/ai-gateway/application/ai-task';
import {
  collectAlreadySuggestedFollowUps,
  collectFollowUpExclusions,
  sanitizeConversationTitle,
  selectFollowUpSuggestions,
} from '@modules/ai-gateway/application/conversation-style';
import { sanitizeKnowledgeSources } from '@modules/ai-gateway/application/knowledge-answer-rules';
import { evaluateNoDataClaims, findNoDataClaims, type SuspiciousNoDataFlag } from '@modules/ai-gateway/application/suspicious-no-data-answer';
import type { TimeRangeAnalysisContextRecord } from '@modules/ai-gateway/domain/ai-gateway';
import { NightscoutSyncService } from '@modules/integrations/nightscout/application/nightscout-sync.service';
import { PushNotificationService } from '@modules/notifications/application/push-notification.service';
import { PushNotificationProviderError } from '@modules/notifications/infrastructure/push-notification-provider.error';
import { ANSWER_FAILED_PUSH_BODY, ANSWER_FAILED_PUSH_TITLE, ANSWER_READY_PUSH_TITLE, answerPushBody } from '@modules/notifications/application/answer-push-text';
import { getCandidateRegistry } from '@modules/context/application/investigation-policy';
import { buildBeyondReachAnswer } from '@modules/context/application/message-routing';
import {
  ConversationTimeRangeType,
  isSupportedConversationTimeRangeType,
  isValidTimeZone,
  localDayWindows,
  validateNormalizedTimeRangeWindow,
} from '@modules/context/application/time-range-normalization';
import { buildDailyInsulinTotals, type DailyInsulinTotals, type InsulinDeliveryEvent } from '@modules/evidence-tools/daily-insulin-totals';
import { deriveRecommendationDecision } from '@modules/recommendations/application/recommendation-policy';
import { RemoteCommandReconciler } from '@modules/remote-commands/application/remote-command-reconciler';
import { PlannedBolusService } from '@modules/remote-commands/application/planned-bolus.service';
import { estimatePlannedBolus, manualInsulinForPart, plannedBolusExpiresAtMs, SPLIT_BOLUS_POLICY, plannedBolusPushContent, plannedDoseCarbs, planTrigger, type PlannedBolusReadiness, type PlannedBolusRecord } from '@modules/remote-commands/application/split-bolus';
import { plannedBolusReadinessFrom } from '@modules/remote-commands/application/deferred-bolus';
import { pumpBolusStep } from '@modules/remote-commands/application/remote-command-policy';
import { PostgresPlannedBolusRepository } from '@infra/db/postgres-planned-boluses.repository';
import { PostgresPushOutboxRepository } from '@infra/db/postgres-push-outbox.repository';
import { PushOutbox } from '@modules/notifications/application/push-outbox';
import { BolusProposalSession, finalizeBolusAnswer, isBolusProposalsEnabled, isDoseRequest, proposesDose, settleAnswerCards } from '@modules/remote-commands/application/bolus-proposal-tool';
import { finalizeTherapyProposal } from '@modules/ai-gateway/application/therapy-suggestion-policy';
import { buildTherapyNow, THERAPY_NOW_CONTEXT_KINDS, type TherapyNow } from '@modules/context/application/therapy-now';
import { answerToolScope, type AnswerToolScope } from '@modules/ai-gateway/application/answer-tool-scope';
import { PostgresTherapyContextEventRepository } from '@infra/db/postgres-therapy-context-events.repository';
import { readPhoneLimits } from '@modules/remote-commands/application/phone-limits';
import { remoteCommandContextFrom } from '@modules/remote-commands/application/remote-command-context';
import { mealForecastDataFrom } from '@modules/remote-commands/application/meal-dose-forecast';
import { highGlucoseSafetyInputsFrom } from '@modules/remote-commands/application/high-glucose-safety';
import { CareReminderSession, careReminderPushContent, careReminderReadiness } from '@modules/care-reminders/application/care-reminders';
import { currentGlucose, DOSE_GIVEN_WINDOW_MINUTES, doseAnsweringReminder, doseGivenPushContent, givenSinceMeal, planBolusTabReminders, secondDoseGivenBefore, secondDosePushContent, secondDoseReadiness, secondDoseTitleAtSend, wbtWaitForSecondDose, type GivenSinceMeal } from '@modules/remote-commands/application/bolus-reminders';
import { PostgresMealJournalRepository } from '@infra/db/postgres-meal-journal.repository';
import { PostgresCareReminderRepository } from '@infra/db/postgres-care-reminders.repository';
import { isRemoteCommandsServerEnabled, resolveRemoteControlAccess } from '@modules/remote-commands/application/remote-control-access';
import { patientLoopSystem } from '@modules/loop-system/application/patient-loop-system';
import { loopSystemNames, UNKNOWN_LOOP_SYSTEM, type LoopSystem } from '@modules/loop-system/domain/loop-system';
import { PostgresBolusProposalRepository } from '@infra/db/postgres-bolus-proposals.repository';
import { PostgresDashboardRepository } from '@infra/db/postgres-dashboard.repository';
import { buildDashboard } from '@modules/dashboard/application/dashboard-snapshot';
import { PostgresRemoteCommandRepository } from '@infra/db/postgres-remote-commands.repository';
import { PostgresAiSideCallRepository, type AiSideCallKind } from '@infra/db/postgres-ai-side-calls.repository';
import type { SettledAiCall } from '@modules/ai-gateway/infrastructure/guarded-openai-client';
import { REMOTE_COMMAND_POLICY } from '@modules/remote-commands/application/remote-command-policy';
import { buildDashboardInsulin } from '@modules/dashboard/application/dashboard-insulin';
import { PostgresMealRecordRepository } from '@infra/db/postgres-meal-history.repository';
import { GLUCOSE_FORECAST_POLICY } from '@modules/glucose-forecast/application/glucose-forecast';
import { MEAL_CHAT_REPLY_JOB_TYPE, runMealChatReplyJob } from '@modules/meal-chat/application/meal-chat-reply.job';
import { PostgresMealWbtRepository } from '@infra/db/postgres-meal-wbt.repository';
import { computeWbtCase, isMealWbtDose, wbtIcrLookup, type WbtHistoryEvent } from '@modules/meal-wbt/application/wbt-history';
import { fatProteinUnitsOf, scheduleValueAt, shouldRemindAboutWbt, wbtReminderAt, wbtReminderBodyFor, WBT_REMINDER_STALE_AFTER_MINUTES } from '@modules/meal-wbt/application/wbt-policy';
import {
  FakeWbtSuggestionResponder,
  MEAL_WBT_SUGGESTION_JOB_TYPE,
  OpenAiWbtSuggestionResponder,
  runWbtSuggestionJob,
  type WbtSuggestionContext,
  type WbtSuggestionResponder,
} from '@modules/meal-wbt/application/wbt-suggestion.job';
import { FakeMealChatResponder, OpenAiMealChatResponder, type MealChatResponder } from '@modules/meal-chat/application/meal-chat-responder';
import { DiabCalcMcpClient, type FoodSearch } from '@modules/meal-chat/infrastructure/diabcalc-mcp-client';
import type { AiUserImage } from '@modules/ai-gateway/domain/ai-gateway';
import { MealPhotoStorage } from '@modules/meal-chat/infrastructure/meal-photo-storage';
import { createGuardedOpenAiClientFromEnv } from '@modules/ai-gateway/infrastructure/guarded-openai-client';
import { createGuardedAnthropicClientFromEnv } from '@modules/ai-gateway/infrastructure/anthropic-responses-transport';
import { PostgresMealChatRepository } from '@infra/db/postgres-meal-chat.repository';
import { PostgresReplyDraftRepository, type ReplyThreadKind } from '@infra/db/postgres-reply-drafts.repository';
import { PostgresChannelListener } from '@infra/db/postgres-channel-listener';
import { ReplyDraftPublisher } from '@modules/live-updates/application/reply-draft-publisher';
import { selectMealsForAiContext, type MealContextSelection } from '@modules/meal-candidates/application/meal-record-trust';
import { FAT_PROTEIN_UNIT_LOOKBACK_HOURS, linkFatProteinUnitEntriesToMeals, type FatProteinUnitLinkedMeal } from '@modules/meal-candidates/application/fat-protein-unit-link';
import { parseWorkerJobTypes } from '@infra/config/environment';
import { computeGlucoseTimeInRange, computeGlucoseTimeInRangeFromBands } from '@modules/context/application/glucose-time-in-range';
import type { EvidenceProcessingStep } from '@modules/evidence-tools';
import { PostgresLoopActionRepository } from '@infra/db/postgres-loop-actions.repository';
import { LOOP_ACTION_TIME_ZONE } from '@modules/loop-actions/application/loop-action-views';
import { PostgresRescueCarbsRepository } from '@infra/db/postgres-rescue-carbs.repository';
import { RescueCarbAlertService } from '@modules/rescue-carbs/application/rescue-carb-alert.service';
import { isRescueCarbAlertsEnabled } from '@modules/rescue-carbs/application/rescue-carbs-store';
import { RescueCarbProposalSession, rescueAlertForAi } from '@modules/rescue-carbs/application/rescue-carb-proposal-tool';
import { sanitizeAnswerOptions, type AnswerOption } from '@modules/ai-gateway/application/answer-options';
import { describeAnswerCards } from '@modules/remote-commands/application/card-context';
import type { RescueAlertRecord } from '@modules/rescue-carbs/application/rescue-alert-policy';
import { PostgresConversationMealActionRepository } from '@infra/db/postgres-conversation-meal-actions.repository';
import { ConversationMealActionsService } from '@modules/meal-actions/application/conversation-meal-actions.service';
import { finalizeMealActionAnswer, MealActionsToolSession } from '@modules/meal-actions/application/meal-actions-tool';
import { continuesMealAssistant, isMealActionsEnabled, isMealEditRequest } from '@modules/meal-actions/application/meal-edit-intent';
import type { UserAiPreferences } from '@shared/primitives/user-ai-preferences';
import { pruneAuditEventsIfDue } from '@modules/security/application/audit-retention';

type MealEventProjection = {
  event_id: string;
  occurred_at: string;
  payload: Record<string, unknown>;
};

type ResolvedCurrentMealAnchor = {
  meal_query_detected: boolean;
  selected_meal_event: MealEventProjection | null;
  reference: NonNullable<TimeRangeAnalysisContextRecord['current_meal_reference']>;
};

function normalizeText(value: string): string {
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

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value.replace(',', '.'));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function isMealQuery(text: string): boolean {
  const normalized = normalizeText(text);
  return /posilek|sniadanie|obiad|kolacja|lunch|dinner|breakfast|meal|carb|weglowodan|weglowodany|przedszkol|daycare|menu/.test(normalized);
}

function parseMealTypeHints(text: string): Set<string> {
  const normalized = normalizeText(text);
  const hints = new Set<string>();
  if (/sniadanie|breakfast/.test(normalized)) {
    hints.add('BREAKFAST');
  }
  if (/obiad|lunch/.test(normalized)) {
    hints.add('LUNCH');
  }
  if (/kolacj|dinner|supper/.test(normalized)) {
    hints.add('DINNER');
  }
  if (/przekaska|snack/.test(normalized)) {
    hints.add('SNACK');
  }
  return hints;
}

function parseTimeHintMinutes(text: string): number | null {
  const normalized = normalizeText(text);
  const match = normalized.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
  if (!match) {
    return null;
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) {
    return null;
  }
  return (hour * 60) + minute;
}

function parseCarbsFromUserText(text: string): number | null {
  const normalized = normalizeText(text);
  const match = normalized.match(/(\d{1,3}(?:[.,]\d{1,2})?)\s*g\b(?:\s*(?:wegl|carb|cho))?/);
  return match ? toFiniteNumber(match[1]) : null;
}

function parseEventMealType(event: MealEventProjection): string | null {
  const payload = event.payload;
  const direct = typeof payload.meal_type === 'string'
    ? payload.meal_type
    : typeof payload.mealType === 'string'
      ? payload.mealType
      : null;
  if (direct) {
    return String(direct).toUpperCase();
  }

  const description = normalizeText(String(payload.description ?? payload.meal_name ?? payload.food_name ?? payload.note ?? ''));
  if (!description) {
    return null;
  }
  if (/sniadanie|breakfast/.test(description)) {
    return 'BREAKFAST';
  }
  if (/obiad|lunch/.test(description)) {
    return 'LUNCH';
  }
  if (/kolacj|dinner|supper/.test(description)) {
    return 'DINNER';
  }
  if (/przekaska|snack/.test(description)) {
    return 'SNACK';
  }
  return null;
}

function isDataPersistenceQuestion(text: string): boolean {
  const normalized = normalizeText(text);
  if (!normalized) {
    return false;
  }

  const asksAboutSaving = /zapisz|zapisyw|zapisane|zapis do bazy|trafia do bazy|retencj|prywat|privacy|where.*save|saved|stored/.test(normalized);
  const asksAboutMealOrConversation = /posilek|meal|rozmow|conversation|baza|database/.test(normalized);
  return asksAboutSaving && asksAboutMealOrConversation;
}

function buildDataPersistenceAnswer(): string {
  return 'Twoja wiadomosc jest trwale zapisywana w historii rozmowy. Dane wpisane swobodnie w czacie sa wykorzystywane do tej rozmowy i analiz, ale nie tworza automatycznie osobnego, ustrukturyzowanego rekordu posilku. Ustrukturyzowany zapis kontekstu pacjenta aktualizuje sie wtedy, gdy odpowiadasz na dedykowane pytania kontekstowe i potwierdzasz konkretne fakty.';
}

function resolveCurrentMealAnchor(args: {
  user_message_text: string;
  request_at_iso: string;
  meal_events: MealEventProjection[];
  current_state_recent_meal?: { event_id?: string; occurred_at?: string; carbs?: number } | null;
}): ResolvedCurrentMealAnchor {
  const mealQueryDetected = isMealQuery(args.user_message_text);
  const normalizedMessage = normalizeText(args.user_message_text);
  const mealTypeHints = parseMealTypeHints(args.user_message_text);
  const timeHintMinutes = parseTimeHintMinutes(args.user_message_text);
  const carbsFromText = parseCarbsFromUserText(args.user_message_text);
  const pointsToRecentMeal = /ten\s+posilek|to\s+sniadanie|to\s+obiad|to\s+kolacje|this\s+meal/.test(normalizedMessage);
  const plannedMealMention = /przedszkol|daycare|menu|planow/.test(normalizedMessage);

  const recentMealEventId = typeof args.current_state_recent_meal?.event_id === 'string'
    ? String(args.current_state_recent_meal.event_id)
    : null;

  const scored = args.meal_events.map((event) => {
    let score = 0;
    const mealType = parseEventMealType(event);
    const eventCarbs = toFiniteNumber(event.payload.carbs ?? event.payload.carbohydrate_amount ?? event.payload.carbohydrates);
    const eventMinutes = (() => {
      const timestamp = new Date(event.occurred_at);
      return Number.isFinite(timestamp.getTime()) ? (timestamp.getUTCHours() * 60) + timestamp.getUTCMinutes() : null;
    })();

    if (normalizedMessage.includes(event.event_id.toLowerCase())) {
      score += 10;
    }
    if (mealType && mealTypeHints.has(mealType)) {
      score += 5;
    }
    if (timeHintMinutes !== null && eventMinutes !== null && Math.abs(eventMinutes - timeHintMinutes) <= 45) {
      score += 4;
    }
    if (pointsToRecentMeal && recentMealEventId && recentMealEventId === event.event_id) {
      score += 4;
    }
    if (carbsFromText !== null && eventCarbs !== null && Math.abs(carbsFromText - eventCarbs) <= 5) {
      score += 2;
    }

    return { event, score, mealType, eventCarbs };
  });

  const ordered = [...scored].sort((left, right) => {
    if (left.score !== right.score) {
      return right.score - left.score;
    }
    const leftTime = new Date(left.event.occurred_at).getTime();
    const rightTime = new Date(right.event.occurred_at).getTime();
    if (leftTime !== rightTime) {
      return rightTime - leftTime;
    }
    return left.event.event_id.localeCompare(right.event.event_id);
  });

  const top = ordered[0] ?? null;
  const second = ordered[1] ?? null;
  const hasAmbiguousTop = Boolean(top && second && top.score > 0 && top.score === second.score);

  if (top && top.score > 0 && !hasAmbiguousTop) {
    return {
      meal_query_detected: mealQueryDetected,
      selected_meal_event: top.event,
      reference: {
        status: 'RESOLVED',
        reference_type: 'EVENT',
        confidence: top.score >= 7 ? 'HIGH' : 'MEDIUM',
        source: 'NIGHTSCOUT_EVENT',
        meal_event_id: top.event.event_id,
        occurred_at: top.event.occurred_at,
        description: typeof top.event.payload.description === 'string'
          ? String(top.event.payload.description)
          : typeof top.event.payload.meal_name === 'string'
            ? String(top.event.payload.meal_name)
            : null,
        carbs: {
          value: top.eventCarbs,
          knowledge_status: top.eventCarbs === null ? 'UNKNOWN' : 'KNOWN',
          origin: 'OBSERVED',
        },
        protein_grams: {
          value: toFiniteNumber(top.event.payload.protein ?? top.event.payload.bialko),
          knowledge_status: toFiniteNumber(top.event.payload.protein ?? top.event.payload.bialko) === null ? 'MISSING' : 'KNOWN',
          origin: 'OBSERVED',
        },
        fat_grams: {
          value: toFiniteNumber(top.event.payload.fat ?? top.event.payload.tluszcz),
          knowledge_status: toFiniteNumber(top.event.payload.fat ?? top.event.payload.tluszcz) === null ? 'MISSING' : 'KNOWN',
          origin: 'OBSERVED',
        },
        fiber_grams: {
          value: toFiniteNumber(top.event.payload.fiber ?? top.event.payload.blonnik),
          knowledge_status: toFiniteNumber(top.event.payload.fiber ?? top.event.payload.blonnik) === null ? 'MISSING' : 'KNOWN',
          origin: 'OBSERVED',
        },
        candidate_meal_event_ids: ordered.slice(0, 5).map((entry) => entry.event.event_id),
        planned_meal_source_available: false,
        notes: ['resolved_from_meal_events'],
      },
    };
  }

  if (mealQueryDetected && args.meal_events.length > 1 && (hasAmbiguousTop || top?.score === 0)) {
    return {
      meal_query_detected: true,
      selected_meal_event: null,
      reference: {
        status: 'AMBIGUOUS',
        reference_type: 'NONE',
        confidence: 'LOW',
        source: 'UNAVAILABLE',
        meal_event_id: null,
        occurred_at: null,
        description: null,
        carbs: { value: null, knowledge_status: 'UNKNOWN', origin: 'INFERRED' },
        protein_grams: { value: null, knowledge_status: 'UNKNOWN', origin: 'INFERRED' },
        fat_grams: { value: null, knowledge_status: 'UNKNOWN', origin: 'INFERRED' },
        fiber_grams: { value: null, knowledge_status: 'UNKNOWN', origin: 'INFERRED' },
        candidate_meal_event_ids: args.meal_events.map((event) => event.event_id).slice(0, 5),
        planned_meal_source_available: false,
        notes: ['multiple_meal_candidates_without_safe_disambiguation'],
      },
    };
  }

  if (mealQueryDetected && carbsFromText !== null) {
    return {
      meal_query_detected: true,
      selected_meal_event: null,
      reference: {
        status: 'RESOLVED',
        reference_type: 'USER_REPORTED',
        confidence: 'MEDIUM',
        source: 'USER_MESSAGE',
        meal_event_id: null,
        occurred_at: args.request_at_iso,
        description: args.user_message_text,
        carbs: { value: carbsFromText, knowledge_status: 'KNOWN', origin: 'REPORTED' },
        protein_grams: { value: null, knowledge_status: 'UNKNOWN', origin: 'REPORTED' },
        fat_grams: { value: null, knowledge_status: 'UNKNOWN', origin: 'REPORTED' },
        fiber_grams: { value: null, knowledge_status: 'UNKNOWN', origin: 'REPORTED' },
        candidate_meal_event_ids: [],
        planned_meal_source_available: false,
        notes: ['resolved_from_user_reported_carbs'],
      },
    };
  }

  if (mealQueryDetected && pointsToRecentMeal && args.current_state_recent_meal?.occurred_at) {
    return {
      meal_query_detected: true,
      selected_meal_event: null,
      reference: {
        status: 'RESOLVED',
        reference_type: 'CURRENT_STATE_RECENT_MEAL',
        confidence: 'MEDIUM',
        source: 'CURRENT_STATE',
        meal_event_id: recentMealEventId,
        occurred_at: String(args.current_state_recent_meal.occurred_at),
        description: null,
        carbs: {
          value: toFiniteNumber(args.current_state_recent_meal?.carbs),
          knowledge_status: toFiniteNumber(args.current_state_recent_meal?.carbs) === null ? 'UNKNOWN' : 'KNOWN',
          origin: 'INFERRED',
        },
        protein_grams: { value: null, knowledge_status: 'MISSING', origin: 'INFERRED' },
        fat_grams: { value: null, knowledge_status: 'MISSING', origin: 'INFERRED' },
        fiber_grams: { value: null, knowledge_status: 'MISSING', origin: 'INFERRED' },
        candidate_meal_event_ids: recentMealEventId ? [recentMealEventId] : [],
        planned_meal_source_available: false,
        notes: ['resolved_from_recent_meal_context'],
      },
    };
  }

  const unresolvedNotes = ['could_not_resolve_specific_current_meal'];
  if (plannedMealMention) {
    unresolvedNotes.push('planned_meal_source_unavailable');
  }

  return {
    meal_query_detected: mealQueryDetected,
    selected_meal_event: null,
    reference: {
      status: 'UNRESOLVED',
      reference_type: 'NONE',
      confidence: 'LOW',
      source: 'UNAVAILABLE',
      meal_event_id: null,
      occurred_at: null,
      description: null,
      carbs: { value: null, knowledge_status: mealQueryDetected ? 'UNKNOWN' : 'MISSING', origin: 'INFERRED' },
      protein_grams: { value: null, knowledge_status: mealQueryDetected ? 'UNKNOWN' : 'MISSING', origin: 'INFERRED' },
      fat_grams: { value: null, knowledge_status: mealQueryDetected ? 'UNKNOWN' : 'MISSING', origin: 'INFERRED' },
      fiber_grams: { value: null, knowledge_status: mealQueryDetected ? 'UNKNOWN' : 'MISSING', origin: 'INFERRED' },
      candidate_meal_event_ids: args.meal_events.map((event) => event.event_id).slice(0, 5),
      planned_meal_source_available: false,
      notes: unresolvedNotes,
    },
  };
}

/** How often a running analysis checks whether its user message was cancelled (then aborts the AI request). */
export const ANALYSIS_CANCELLATION_POLL_MS = 2_000;
/** Upper bound of jobs one timer tick processes back to back before yielding to the next tick. */
export const WORKER_DRAIN_MAX_JOBS_PER_TICK = 50;
/** At most one draft write per this many ms while an answer is written (the app smooths the text in between). */
const REPLY_DRAFT_WRITE_INTERVAL_MS = 200;
// On shutdown the in-flight job gets this long to finish; after that its lease is released so another worker can
// claim it right away instead of waiting out the 300 s lease.
export const WORKER_SHUTDOWN_GRACE_MS = 5_000;

/**
 * Fresh glucose (fresh-glucose.v1, 2026-10-21): a reading reached Nightscout 5 s after the CGM but GlucoMind only
 * 84 s later, after an answer that used the previous one (56 instead of 73 mg/dL). Nightscout syncs therefore run in
 * their own lane (never behind a 40-second chat answer), every 10 s while a reading is due, and before an answer when
 * the newest reading is older than this.
 */
export const NIGHTSCOUT_SYNC_JOB_TYPE = 'nightscout.sync';
/** A CGM reading comes every 5 min; older than this, a newer one is probably in Nightscout already. */
export const FRESH_READING_MAX_AGE_MS = 270_000;
/** The due-reading poll: from 5 min 5 s after the newest reading, every 10 s, until 15 min (then the minute sync). */
export const DUE_READING_POLL_MS = 10_000;
export const DUE_READING_AFTER_MS = 305_000;
export const DUE_READING_POLL_UNTIL_MS = 15 * 60_000;
/** The refresh before an answer waits at most this long (the answer goes on with what is there). */
export const ANSWER_REFRESH_TIMEOUT_MS = 6_000;

function isCancelledAiExecution(error: unknown): boolean {
  return error instanceof AiExecutionError && error.code === 'AI_CANCELLED';
}

/** Every job type processOnce has a handler for; a restricted worker may only name these. */
export const WORKER_HANDLED_JOB_TYPES: readonly string[] = [
  'nightscout.sync',
  'triggering.hypo_detection',
  'analysis.follow_up',
  'conversation.direct_response',
  'conversation.time_range_analysis',
  'investigation.re_evaluate',
  'notifications.push_conversation_question',
  MEAL_CHAT_REPLY_JOB_TYPE,
  MEAL_WBT_SUGGESTION_JOB_TYPE,
];

/** A planned part's reminder quotes glucose only from a reading at most this old (the forecast's freshness window). */
const PLANNED_BOLUS_GLUCOSE_MAX_AGE_MINUTES = GLUCOSE_FORECAST_POLICY.max_reading_age_minutes;
/** A WBT reminder not sent within this many minutes after it was due is skipped instead of firing late. */
const WBT_REMINDER_MAX_AGE_MINUTES = WBT_REMINDER_STALE_AFTER_MINUTES;
/** How long a reminder push that has not reached every phone is tried again (push-outbox.v1). */
const REMINDER_PUSH_TTL_MINUTES = 60;
/** A chat reminder at a time later than this is not pushed (owner 2026-10-26): it is MISSED, and the bell says so. */
const CARE_REMINDER_MAX_LATE_MINUTES = 120;
/** A WBT reminder comes no sooner than this after the meal's second dose came unanswered (never two at once). */
const WBT_AFTER_SECOND_DOSE_MINUTES = 30;

/**
 * WORKER_JOB_TYPES as validated by ConfigModule (string[]) or raw (string). null means no restriction. Throws on an
 * empty, malformed or unhandled entry, so a bad value stops the worker instead of claiming every job.
 */
export function resolveAllowedJobTypes(value: unknown): string[] | null {
  if (value === undefined || value === null) {
    return null;
  }
  const parsed = parseWorkerJobTypes(Array.isArray(value) ? value.join(',') : String(value));
  if (!parsed) {
    return null;
  }
  const unhandled = parsed.filter((type) => !WORKER_HANDLED_JOB_TYPES.includes(type));
  if (unhandled.length > 0) {
    throw new Error(`Invalid environment variable: WORKER_JOB_TYPES names job types this worker does not handle: ${unhandled.join(', ')}`);
  }
  return parsed;
}

/**
 * NIGHTSCOUT_SYNC_ENABLED as validated by ConfigModule (boolean) or raw (string). Unset keeps sync enabled, so existing
 * deployments are unchanged. Anything other than true/false/1/0 throws instead of guessing.
 */
export function resolveNightscoutSyncEnabled(value: unknown): boolean {
  if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) {
    return true;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  const normalized = String(value).trim().toLowerCase();
  if (normalized === 'true' || normalized === '1') {
    return true;
  }
  if (normalized === 'false' || normalized === '0') {
    return false;
  }
  throw new Error('Invalid environment variable: NIGHTSCOUT_SYNC_ENABLED must be true/false or 1/0');
}

/**
 * With sync disabled the worker must never claim nightscout.sync (a queued leftover would still reach Nightscout):
 * an unrestricted worker claims every other handled type, and an explicit request for nightscout.sync is refused.
 */
export function resolveClaimableJobTypes(allowedJobTypes: string[] | null, nightscoutSyncEnabled: boolean): string[] | null {
  if (nightscoutSyncEnabled) {
    return allowedJobTypes;
  }
  if (allowedJobTypes === null) {
    return WORKER_HANDLED_JOB_TYPES.filter((type) => type !== 'nightscout.sync');
  }
  if (allowedJobTypes.includes('nightscout.sync')) {
    throw new Error('Invalid environment variables: WORKER_JOB_TYPES includes nightscout.sync while NIGHTSCOUT_SYNC_ENABLED=false');
  }
  return allowedJobTypes;
}


/** Caregiver-started conversations without a name get one from their first answer; system ones keep their trigger name. */
function conversationNeedsAiTitle(conversation: Record<string, unknown> | null | undefined): boolean {
  if (!conversation) return false;
  const title = typeof conversation.title === 'string' ? conversation.title.trim() : '';
  return title.length === 0 && String(conversation.origin ?? '').toUpperCase() === 'USER';
}

/** The push for a clarifying question about the caregiver's own message (not about a hypo). */
const CLARIFYING_QUESTION_PUSH = {
  title: 'Mellis potrzebuje odpowiedzi',
  body: 'Mam pytanie doprecyzowujące do Twojej wiadomości. Odpowiedź pomoże mi lepiej przeanalizować sytuację.',
} as const;

/** The loop's IOB/COB readings stored as events (Trio: ~330 of each a day); time-range analyses do not read them. */
const LOOP_SNAPSHOT_EVENT_TYPES = ['IOB_SNAPSHOT', 'COB_SNAPSHOT'] as const;

@Injectable()
export class WorkerService implements OnModuleInit, OnModuleDestroy {
  private jobTimer: NodeJS.Timeout | null = null;
  private syncTimer: NodeJS.Timeout | null = null;
  private running = false;
  private shuttingDown = false;
  private stopPromise: Promise<void> | null = null;
  private inFlight: Promise<void> | null = null;
  private inFlightJob: { id: string; lease_token: string } | null = null;
  private lastProcessOnceClaimed = false;
  /** One Nightscout sync at a time per source: the sync lane, the due-reading poll and the refresh before an answer. */
  private readonly sourceSyncs = new Map<string, Promise<void>>();
  private syncLaneTimer: NodeJS.Timeout | null = null;
  private syncLaneRunning = false;
  private syncLaneInFlight: Promise<void> | null = null;
  private syncLaneJob: { id: string; lease_token: string } | null = null;
  private dueReadingTimer: NodeJS.Timeout | null = null;
  private dueReadingPollRunning = false;
  private readonly mealRecordRepository?: PostgresMealRecordRepository;
  private readonly createMealChatResponder: () => MealChatResponder;
  private mealChatResponder: MealChatResponder | null = null;
  private readonly mealPhotoStorage: MealPhotoStorage | null;
  // DiabCalc product search for conversation answers (search_food); only with a paid provider (OpenAI or Claude).
  private readonly conversationFoodSearch: FoodSearch | null;
  /** Meal changes prepared in conversations (conversation-meal-actions.v1); null without a database pool. */
  private readonly conversationMealActions: { repository: PostgresConversationMealActionRepository; service: ConversationMealActionsService } | null;
  private readonly mealChatRepository?: PostgresMealChatRepository;
  /** Answers being written (live-updates.v1); absent without a database pool (offline tests). */
  private readonly replyDraftRepository?: PostgresReplyDraftRepository;
  /** The draft of the answer the current job writes; deleted when the job ends (stored, failed or cancelled). */
  private activeReplyDraft: ReplyDraftPublisher | null = null;
  /** Wakes the queue as soon as a job is queued (glucomind_jobs), instead of the next poll. */
  private jobListener: PostgresChannelListener | null = null;
  private readonly mealWbtRepository?: PostgresMealWbtRepository;
  private readonly createWbtSuggestionResponder: () => WbtSuggestionResponder;
  private wbtSuggestionResponder: WbtSuggestionResponder | null = null;
  private wbtReminderTimer: NodeJS.Timeout | null = null;
  private loopActionRepository?: PostgresLoopActionRepository;
  /** Who sent a loop action from the app (the Meals tab's journal SQL), for reminder pushes. */
  private mealJournalRepository?: PostgresMealJournalRepository;
  private remoteCommandReconciler?: RemoteCommandReconciler;
  private plannedBolusRepository?: PostgresPlannedBolusRepository;
  /** Reminder pushes kept until every phone has them (push-outbox.v1); built on first use. */
  private pushOutboxInstance: PushOutbox | null = null;
  private plannedBolusService?: PlannedBolusService;
  private bolusProposalRepository?: PostgresBolusProposalRepository;
  private bolusDashboardRepository?: PostgresDashboardRepository;
  private rescueCarbsRepository?: PostgresRescueCarbsRepository;
  private rescueCarbAlerts?: RescueCarbAlertService;
  private rescueCarbTimer: NodeJS.Timeout | null = null;
  private rescueCarbsRunning = false;
  /** A new reading came while an evaluation ran (on readings read before it): one more evaluation follows. */
  private rescueCarbsRerun = false;
  private wbtRemindersRunning = false;
  /** Bolus card sessions of answers in progress, by the answered caregiver message. */
  private readonly bolusSessions = new Map<string, BolusProposalSession>();
  private readonly wbtSessions = new Map<string, WbtDoseProposalSession>();
  /** Rescue carb card sessions of answers in progress (their option keys decide whether the options are kept). */
  private readonly rescueSessions = new Map<string, RescueCarbProposalSession>();
  /** The answer whose cards and reminders exist but are not stored with an answer yet (cancelled or failed for good:
   * they go, never pushed or shown). */
  private answerExtrasPending: { patientId: string; userMessageId: string } | null = null;
  private careReminderRepository: PostgresCareReminderRepository | null = null;
  private therapyContextRepository: PostgresTherapyContextEventRepository | null = null;
  private remoteCommandRepository: PostgresRemoteCommandRepository | null = null;
  private loopActionTimer: NodeJS.Timeout | null = null;
  private auditPruneTimer: NodeJS.Timeout | null = null;
  private loopActionsRunning = false;
  /** Timer runs still going (reminders, loop actions, planned boluses, rescue alerts): stop() waits for them. */
  private readonly backgroundRuns = new Set<Promise<void>>();
  // Restricted mode (WORKER_JOB_TYPES): only these job types are claimed; every other job stays queued untouched.
  private readonly allowedJobTypes: string[] | null;
  // NIGHTSCOUT_SYNC_ENABLED=false: no source registration, no sync scheduling and no nightscout.sync claims.
  private readonly nightscoutSyncEnabled: boolean;
  private readonly jobLogger = new Logger(WorkerService.name);
  /** Phase marks of the answers being prepared (answer_phase_timing): job start and the end of the glucose refresh. */
  private readonly answerPhaseMarks = new Map<string, { job_started_at: number; refreshed_at: number | null }>();

  constructor(
    @Inject(PostgresGlucoMindRepository)
    private readonly repository: PostgresGlucoMindRepository,
    @Inject(NightscoutSyncService)
    private readonly nightscoutSyncService: NightscoutSyncService,
    @Inject(ConfigService)
    private readonly configService: ConfigService,
    @Inject('AI_GATEWAY')
    private readonly aiGateway: AiGateway,
    @Inject(PushNotificationService)
    private readonly pushNotificationService: PushNotificationService,
  ) {
    const readConfig = (key: string): unknown => (typeof this.configService.get === 'function' ? this.configService.get(key) : undefined);
    this.nightscoutSyncEnabled = resolveNightscoutSyncEnabled(readConfig('NIGHTSCOUT_SYNC_ENABLED'));
    this.allowedJobTypes = resolveClaimableJobTypes(resolveAllowedJobTypes(readConfig('WORKER_JOB_TYPES')), this.nightscoutSyncEnabled);
    const aiProvider = String(readConfig('AI_PROVIDER') ?? 'fake').toLowerCase();
    const paidAi = aiProvider === 'openai' || aiProvider === 'anthropic';
    // Meal chat and WBT build their own Responses requests: the same guarded client shape for both providers.
    // Each paid call of the meal chat and the WBT screen is kept in ai_side_calls (migration 087): they are outside
    // the gateway's ai_executions, so their cost and latency were only in the budget ledger.
    const sideCallsPool = (this.repository as unknown as { pool?: unknown }).pool;
    const sideCalls = sideCallsPool ? new PostgresAiSideCallRepository(sideCallsPool as any) : null;
    const recordSideCall = (kind: AiSideCallKind) => (call: SettledAiCall) => {
      void sideCalls?.record(kind, call).catch((error: unknown) => this.jobLogger.warn(JSON.stringify({ event: 'ai_side_call_record_failed', kind, error: error instanceof Error ? error.message.slice(0, 120) : 'UNKNOWN' })));
    };
    const createResponsesClient = (kind: AiSideCallKind) => (aiProvider === 'anthropic'
      ? createGuardedAnthropicClientFromEnv(process.env, recordSideCall(kind))
      : createGuardedOpenAiClientFromEnv(process.env, String(readConfig('OPENAI_API_KEY') ?? ''), recordSideCall(kind)));
    const responsesModel = () => (aiProvider === 'anthropic'
      ? String(readConfig('ANTHROPIC_MODEL') ?? '').trim() || 'claude-opus-5-5'
      : String(readConfig('OPENAI_MODEL') ?? ''));
    // Built on first use: the guarded OpenAI client reads the budget ledger, which only meal chat jobs need here.
    this.createMealChatResponder = () => (paidAi
      ? new OpenAiMealChatResponder(
        createResponsesClient('MEAL_CHAT'),
        responsesModel(),
        DiabCalcMcpClient.fromEnv(process.env),
        aiProvider,
      )
      : new FakeMealChatResponder());
    this.createWbtSuggestionResponder = () => (paidAi
      ? new OpenAiWbtSuggestionResponder(createResponsesClient('WBT_SUGGESTION'), responsesModel(), aiProvider)
      : new FakeWbtSuggestionResponder());
    this.mealPhotoStorage = MealPhotoStorage.fromEnv(process.env);
    this.conversationFoodSearch = paidAi
      ? DiabCalcMcpClient.fromEnv(process.env)
      : null;
    const mealActionsPool = (this.repository as unknown as { pool?: unknown }).pool;
    if (mealActionsPool) {
      const repository = new PostgresConversationMealActionRepository(mealActionsPool as any);
      // The worker only prepares changes; applying them is the API's (a caregiver taps "Zatwierdź").
      const notHere = async () => { throw new Error('MEAL_ACTION_APPLY_NOT_IN_WORKER'); };
      const service = new ConversationMealActionsService(repository, {
        assignLoopAction: notHere,
        setCarbEntryKind: notHere,
        detachCarbEntry: notHere,
        setWbtReminder: notHere,
        afterMealValuesChanged: notHere,
      });
      this.conversationMealActions = { repository, service };
    } else {
      this.conversationMealActions = null;
    }

    const pool = (this.repository as unknown as { pool?: unknown }).pool;
    if (pool) {
      this.mealRecordRepository = new PostgresMealRecordRepository(pool as any);
      this.mealChatRepository = new PostgresMealChatRepository(pool as any);
      this.replyDraftRepository = new PostgresReplyDraftRepository(pool as any);
      this.mealWbtRepository = new PostgresMealWbtRepository(pool as any);
      this.loopActionRepository = new PostgresLoopActionRepository(pool as any);
      const loopActions = this.loopActionRepository;
      const meals = this.mealRecordRepository;
      const remoteCommands = new PostgresRemoteCommandRepository(pool as any);
      this.remoteCommandRepository = remoteCommands;
      const wbtReminders = this.mealWbtRepository;
      this.plannedBolusRepository = new PostgresPlannedBolusRepository(pool as any);
      this.careReminderRepository = new PostgresCareReminderRepository(pool as any);
      this.therapyContextRepository = new PostgresTherapyContextEventRepository(pool as any);
      const plannedBoluses = new PlannedBolusService({
        store: this.plannedBolusRepository,
        commands: remoteCommands,
        postponeWbtReminder: (patientId, mealRecordId, notBeforeIso) => wbtReminders.postponeReminder(patientId, mealRecordId, notBeforeIso),
        log: (event) => this.jobLogger.log(JSON.stringify(event)),
      });
      this.plannedBolusService = plannedBoluses;
      const therapyContext = this.therapyContextRepository;
      this.remoteCommandReconciler = new RemoteCommandReconciler({
        commands: remoteCommands,
        loopActions,
        loopRefusals: {
          listSince: (sinceIso) => therapyContext.listRemoteCommandNotesSince(sinceIso, 'Mellis:'),
          transition: (patientId, commandId, to, fields) => remoteCommands.transition(patientId, commandId, to, fields),
        },
        plannedBoluses: {
          createForMeal: async (command, mealRecordId, mealStartedAt) => {
            await plannedBoluses.createForMeal(command, mealRecordId, mealStartedAt);
          },
          markGivenByCommand: (command, loopActionId) => plannedBoluses.markGivenByCommand(command, loopActionId),
        },
        meals: {
          findMealIdentityById: (patientId, mealRecordId) => meals.findMealIdentityById(patientId, mealRecordId),
          editContent: (patientId, identity, userId, edit) => meals.editContent(patientId, identity, userId, edit),
          afterMealSaved: async (patientId, mealRecordId) => {
            const identity = await meals.findMealIdentityById(patientId, mealRecordId);
            if (!identity || !this.mealWbtRepository) return;
            const record = await meals.getMealRecord(patientId, identity);
            const macros = { protein_g: record.macros.protein.grams, fat_g: record.macros.fat.grams };
            await this.mealWbtRepository.setAutoReminder({ patientId, mealRecordId, enabled: shouldRemindAboutWbt(macros), remindAt: wbtReminderAt(record.started_at) });
          },
        },
        bolusTabReminders: {
          // Timed from the loop's entry (bolus-reminders.v1): the WBT reminder is the caregiver's own (MANUAL, on), the
          // second dose a care reminder of the meal.
          createForMeal: async (command, reminders, mealRecordId, entryAt) => {
            const plan = planBolusTabReminders({ reminders, carbs_g: command.carbs_g, insulin_u: command.insulin_u, entry_at: entryAt, set_at: command.authorized_at, now: new Date(), time_zone: resolveHomeTimeZone() });
            if (plan.wbt_remind_at && wbtReminders) {
              await wbtReminders.setManualReminder({ patientId: command.patient_id, mealRecordId, enabled: true, remindAt: plan.wbt_remind_at, userId: command.user_id });
            }
            if (plan.second_dose && this.careReminderRepository) {
              await this.careReminderRepository.insertSecondDose({
                patient_id: command.patient_id,
                meal_record_id: mealRecordId,
                created_by_user_id: command.user_id,
                source_ref: `remote-command:${command.id}`,
                ...plan.second_dose,
              });
            }
          },
        },
        rescue: {
          linkCommandEntry: async (patientId, commandId, carbEventId) => {
            await this.rescueCarbsRepository?.linkCommandEntry(patientId, commandId, carbEventId);
          },
          releaseFailedCommandTreatments: async () => (await this.rescueCarbsRepository?.releaseFailedCommandTreatments()) ?? 0,
        },
        log: (event) => this.jobLogger.log(JSON.stringify(event)),
      });
      this.bolusProposalRepository = new PostgresBolusProposalRepository(pool as any);
      this.bolusDashboardRepository = new PostgresDashboardRepository(pool as any);
      this.rescueCarbsRepository = new PostgresRescueCarbsRepository(pool as any);
      const dashboards = this.bolusDashboardRepository;
      this.rescueCarbAlerts = new RescueCarbAlertService({
        store: this.rescueCarbsRepository,
        data: {
          listGlucoseReadingsSince: (patientId, sinceIso) => dashboards.listGlucoseReadingsSince(patientId, sinceIso),
          getLatestLoopStatus: (patientId) => dashboards.getLatestLoopStatus(patientId),
          getTherapyProfileAt: (patientId, atIso) => this.repository.getTherapyProfileAt(patientId, atIso),
        },
        push: { sendRescueCarbAlert: (input) => this.pushNotificationService.sendRescueCarbAlert(input) },
        onPushError: (pushToken, error) => this.deactivateDeadPushToken(pushToken, error),
        log: (event) => this.jobLogger.log(JSON.stringify(event)),
        timezone: LOOP_ACTION_TIME_ZONE,
      });
    }
  }

  async onModuleInit(): Promise<void> {
    const nightscoutSync = this.nightscoutSyncEnabled ? 'ENABLED' : 'DISABLED';
    new Logger(WorkerService.name).log(JSON.stringify(this.allowedJobTypes
      ? { event: 'worker_mode', mode: 'RESTRICTED', allowed_job_types: this.allowedJobTypes, nightscout_sync: nightscoutSync }
      : { event: 'worker_mode', mode: 'ALL_JOB_TYPES', nightscout_sync: nightscoutSync }));
    if (this.nightscoutSyncEnabled) {
      // Each patient's own Nightscout (090_sharing_foundation.sql); NIGHTSCOUT_* env only seeds the first one once.
      const prepared = await this.nightscoutSyncService.prepareNightscoutSources(process.env);
      this.jobLogger.log(JSON.stringify({ event: 'nightscout_sources', sources: prepared.sources, seed: prepared.seed }));
      this.syncTimer = setInterval(() => {
        void this.enqueueNightscoutSyncJobs();
      }, 60_000);
      if (this.syncLaneEnabled) {
        this.syncLaneTimer = setInterval(() => {
          void this.drainSyncLane();
        }, 2000);
        this.dueReadingTimer = setInterval(() => {
          this.runInBackground(() => this.pollDueReadings());
        }, DUE_READING_POLL_MS);
      }
    }
    this.jobTimer = setInterval(() => {
      void this.drainQueue();
    }, 2000);
    this.startJobListener();
    if (this.nightscoutSyncEnabled) {
      void this.enqueueNightscoutSyncJobs();
    }
    // WBT reminders are sent by the unrestricted worker only (a restricted one serves a subset of jobs).
    if (!this.allowedJobTypes && this.mealWbtRepository) {
      this.wbtReminderTimer = setInterval(() => {
        // A slow run (APNs, database) is never overlapped by the next minute's: two runs would race on the same reminders.
        if (this.wbtRemindersRunning) return;
        this.wbtRemindersRunning = true;
        this.runInBackground(() => this.dispatchDueWbtReminders().finally(() => { this.wbtRemindersRunning = false; }));
      }, 60_000);
    }
    // Loop actions: group new carb entries / boluses, match the app's commands, run planned parts and reminders
    // (unrestricted worker only). Nobody is asked what an entry was for.
    if (!this.allowedJobTypes && this.loopActionRepository) {
      this.loopActionTimer = setInterval(() => {
        this.runInBackground(() => this.processLoopActions());
      }, 30_000);
      this.auditPruneTimer = setInterval(() => {
        // audit_events retention (180 days), at most once an hour; never throws.
        this.runInBackground(async () => { await pruneAuditEventsIfDue(this.repository, (event) => this.jobLogger.log(JSON.stringify(event))); });
      }, 60_000);
    }
    // Rescue carb alerts (rescue-carbs.v1): unrestricted worker only, behind RESCUE_CARB_ALERTS_ENABLED.
    if (!this.allowedJobTypes && this.rescueCarbAlerts && isRescueCarbAlertsEnabled(process.env)) {
      this.rescueCarbTimer = setInterval(() => {
        this.runInBackground(() => this.evaluateRescueCarbAlerts());
      }, 60_000);
    }
    void this.drainQueue();
  }

  /** One rescue carb evaluation per patient with an opted-in phone; never two runs at once. */
  async evaluateRescueCarbAlerts(now = new Date()): Promise<void> {
    if (!this.rescueCarbAlerts || this.rescueCarbsRunning || this.shuttingDown) return;
    this.rescueCarbsRunning = true;
    try {
      let runAt = now;
      do {
        this.rescueCarbsRerun = false;
        try {
          await this.rescueCarbAlerts.run(runAt);
        } catch (error) {
          // Migration 051 not applied yet, or the database is down: the next minute tries again.
          this.jobLogger.warn(JSON.stringify({ event: 'rescue_carbs_unavailable', error_code: safeJobErrorCode(error) }));
        }
        runAt = new Date();
      } while (this.rescueCarbsRerun && !this.shuttingDown);
    } finally {
      this.rescueCarbsRunning = false;
    }
  }

  /**
   * A sync stored new glucose readings (fresh-glucose.v1 reads them ~12 s after Nightscout has them): evaluate rescue
   * carb alerts now instead of on the next minute (audit 2026-10-26). Only where the minute timer runs (unrestricted
   * worker, RESCUE_CARB_ALERTS_ENABLED); the timer stays as the fallback. Detection only: database reads, no AI.
   */
  private evaluateRescueCarbAlertsAfterReading(): void {
    if (!this.rescueCarbTimer || this.shuttingDown) return;
    if (this.rescueCarbsRunning) {
      this.rescueCarbsRerun = true;
      return;
    }
    this.runInBackground(() => this.evaluateRescueCarbAlerts());
  }

  /**
   * Processes jobs back to back (bounded per tick) instead of one job per timer tick, so a large import backlog does
   * not take hours. Still one job at a time: processOnce's running guard serialises every caller.
   */
  private async drainQueue(maxJobs = WORKER_DRAIN_MAX_JOBS_PER_TICK): Promise<void> {
    // Runs from timers as `void this.drainQueue()`: never rejects (an unhandled rejection ends the process).
    try {
      for (let processed = 0; processed < maxJobs; processed += 1) {
        await this.processOnce();
        if (!this.lastProcessOnceClaimed || this.shuttingDown) return;
      }
    } catch (error) {
      this.jobLogger.error(JSON.stringify({ event: 'job_drain_failed', error_code: safeJobErrorCode(error) }));
    }
  }

  onModuleDestroy(): Promise<void> {
    return this.stop();
  }

  /**
   * Stops claiming (synchronously, before the first await), then waits up to graceMs for the in-flight job. A job
   * still running after that has its lease released so it is re-queued at once. Idempotent: repeated calls share
   * the first stop. The pg pool is ended later (onApplicationShutdown), so the release can still reach the database.
   */
  stop(graceMs = WORKER_SHUTDOWN_GRACE_MS): Promise<void> {
    if (!this.stopPromise) {
      this.shuttingDown = true;
      if (this.jobTimer) {
        clearInterval(this.jobTimer);
        this.jobTimer = null;
      }
      if (this.syncTimer) {
        clearInterval(this.syncTimer);
        this.syncTimer = null;
      }
      if (this.syncLaneTimer) {
        clearInterval(this.syncLaneTimer);
        this.syncLaneTimer = null;
      }
      if (this.dueReadingTimer) {
        clearInterval(this.dueReadingTimer);
        this.dueReadingTimer = null;
      }
      if (this.wbtReminderTimer) {
        clearInterval(this.wbtReminderTimer);
        this.wbtReminderTimer = null;
      }
      if (this.loopActionTimer) {
        clearInterval(this.loopActionTimer);
        this.loopActionTimer = null;
      }
      if (this.auditPruneTimer) {
        clearInterval(this.auditPruneTimer);
        this.auditPruneTimer = null;
      }
      if (this.rescueCarbTimer) {
        clearInterval(this.rescueCarbTimer);
        this.rescueCarbTimer = null;
      }
      const listener = this.jobListener;
      this.jobListener = null;
      this.stopPromise = Promise.all([
        this.waitForInFlightJob(graceMs),
        this.waitForSyncLane(graceMs),
        this.waitForBackgroundRuns(graceMs),
        listener?.stop(),
      ]).then(() => undefined);
    }
    return this.stopPromise;
  }

  /** Runs a timer's task and keeps it until it settles, so stop() can wait for it (the tasks never throw). */
  private runInBackground(task: () => Promise<void>): void {
    const run = task().catch((error: unknown) => {
      this.jobLogger.error(JSON.stringify({ event: 'background_run_failed', error_code: safeJobErrorCode(error) }));
    });
    this.backgroundRuns.add(run);
    void run.finally(() => this.backgroundRuns.delete(run));
  }

  /**
   * On stop: waits up to graceMs for the timer runs still going. They mark a reminder or loop action SENT before the
   * push goes out, so ending the pool under them would leave it marked sent but never delivered.
   */
  private async waitForBackgroundRuns(graceMs: number): Promise<void> {
    if (this.backgroundRuns.size === 0) return;
    let graceTimer: NodeJS.Timeout | undefined;
    const settled = await Promise.race([
      Promise.allSettled([...this.backgroundRuns]).then(() => true),
      new Promise<boolean>((resolve) => { graceTimer = setTimeout(() => resolve(false), graceMs); }),
    ]);
    clearTimeout(graceTimer);
    if (!settled) {
      this.jobLogger.warn(JSON.stringify({ event: 'worker_stopped', background_runs: this.backgroundRuns.size, outcome: 'grace_elapsed' }));
    }
  }

  private async waitForInFlightJob(graceMs: number): Promise<void> {
    const inFlight = this.inFlight;
    if (!inFlight) {
      this.jobLogger.log(JSON.stringify({ event: 'worker_stopped', in_flight_job: false }));
      return;
    }

    let graceTimer: NodeJS.Timeout | undefined;
    await Promise.race([
      inFlight.catch(() => undefined),
      new Promise<void>((resolve) => {
        graceTimer = setTimeout(resolve, graceMs);
      }),
    ]);
    clearTimeout(graceTimer);

    // Still set when the job outlived the grace period, or was claimed just as the stop began and never started.
    const job = this.inFlightJob;
    if (!job) {
      this.jobLogger.log(JSON.stringify({ event: 'worker_stopped', in_flight_job: true, outcome: 'finished' }));
      return;
    }

    const repository = this.repository as Partial<Pick<PostgresGlucoMindRepository, 'releaseJobLease'>>;
    try {
      if (repository.releaseJobLease) {
        await repository.releaseJobLease(job.id, job.lease_token, new Date().toISOString());
      }
      this.jobLogger.warn(JSON.stringify({ event: 'worker_stopped', in_flight_job: true, outcome: 'lease_released', job_id: job.id }));
    } catch (error) {
      this.jobLogger.error(JSON.stringify({ event: 'worker_stopped', in_flight_job: true, outcome: 'lease_release_failed', job_id: job.id, error_code: safeJobErrorCode(error) }));
    }
  }

  /** Runs from a timer: never rejects (the database may be down; the next minute tries again). */
  private async enqueueNightscoutSyncJobs(): Promise<void> {
    try {
      await this.nightscoutSyncService.enqueueRecurringSyncJobs(new Date().toISOString());
    } catch (error) {
      this.jobLogger.warn(JSON.stringify({ event: 'nightscout_sync_enqueue_failed', error_code: safeJobErrorCode(error) }));
      return;
    }
    void this.drainSyncLane();
  }

  /** Nightscout syncs have their own lane in the unrestricted worker (a restricted one keeps a single lane). */
  private get syncLaneEnabled(): boolean {
    return this.nightscoutSyncEnabled && !this.allowedJobTypes;
  }

  /** Runs a source's sync after any sync of it still running (never two at once). */
  private runSourceSync(sourceId: string): Promise<void> {
    const previous = this.sourceSyncs.get(sourceId) ?? Promise.resolve();
    const run = previous.then(() => this.nightscoutSyncService.runNightscoutSyncJob(sourceId, new Date().toISOString())).then((result) => {
      if ((result?.entries?.imported ?? 0) > 0) this.evaluateRescueCarbAlertsAfterReading();
    });
    const settled = run.catch(() => undefined);
    this.sourceSyncs.set(sourceId, settled);
    void settled.then(() => {
      if (this.sourceSyncs.get(sourceId) === settled) this.sourceSyncs.delete(sourceId);
    });
    return run;
  }

  /**
   * The queued Nightscout syncs, run now: processOnce leaves them to the sync lane (fresh-glucose.v1), so a tool or test
   * that drives the worker by hand calls both.
   */
  async processSyncLaneOnce(): Promise<void> {
    await this.drainSyncLane();
  }

  /** The sync lane: nightscout.sync jobs back to back, beside the main lane (fresh-glucose.v1). */
  private async drainSyncLane(): Promise<void> {
    if (!this.syncLaneEnabled || this.shuttingDown || this.syncLaneRunning) return;
    this.syncLaneRunning = true;
    const run = (async () => {
      for (let processed = 0; processed < WORKER_DRAIN_MAX_JOBS_PER_TICK && !this.shuttingDown; processed += 1) {
        let claimed: Awaited<ReturnType<PostgresGlucoMindRepository['claimNextJob']>>;
        try {
          claimed = await this.repository.claimNextJob('worker-1-sync', new Date().toISOString(), 300, [NIGHTSCOUT_SYNC_JOB_TYPE]);
        } catch (error) {
          this.jobLogger.error(JSON.stringify({ event: 'job_claim_failed', lane: 'sync', error_code: safeJobErrorCode(error) }));
          return;
        }
        if (!claimed) return;
        this.syncLaneJob = { id: claimed.id, lease_token: claimed.lease_token };
        if (this.shuttingDown) return;
        const startedAtMs = Date.now();
        const jobRef = { job_id: claimed.id, job_type: claimed.job_type };
        this.jobLogger.log(JSON.stringify({ event: 'job_claimed', lane: 'sync', ...jobRef, attempt: claimed.attempts }));
        try {
          await this.handleNightscoutSync(claimed.id, claimed.lease_token, claimed.payload);
          this.jobLogger.log(JSON.stringify({ event: 'job_finished', lane: 'sync', ...jobRef, outcome: 'succeeded', duration_ms: Date.now() - startedAtMs }));
        } catch (error) {
          await this.finalizeFailedJob(claimed, error, jobRef, startedAtMs);
        } finally {
          // Finished or finalized: nothing to hand back on stop.
          this.syncLaneJob = null;
        }
      }
    })();
    this.syncLaneInFlight = run;
    try {
      await run;
    } catch (error) {
      // Runs from timers as `void this.drainSyncLane()`: never rejects.
      this.jobLogger.error(JSON.stringify({ event: 'job_drain_failed', lane: 'sync', error_code: safeJobErrorCode(error) }));
    } finally {
      this.syncLaneRunning = false;
      if (this.syncLaneInFlight === run) this.syncLaneInFlight = null;
    }
  }

  /** On stop: waits for the sync lane's job, then hands back a lease it still holds (re-queued at once). */
  private async waitForSyncLane(graceMs: number): Promise<void> {
    const inFlight = this.syncLaneInFlight;
    if (inFlight) {
      let graceTimer: NodeJS.Timeout | undefined;
      await Promise.race([inFlight.catch(() => undefined), new Promise<void>((resolve) => { graceTimer = setTimeout(resolve, graceMs); })]);
      clearTimeout(graceTimer);
    }
    const job = this.syncLaneJob;
    if (!job) return;
    const repository = this.repository as Partial<Pick<PostgresGlucoMindRepository, 'releaseJobLease'>>;
    try {
      await repository.releaseJobLease?.(job.id, job.lease_token, new Date().toISOString());
      this.jobLogger.warn(JSON.stringify({ event: 'worker_stopped', lane: 'sync', in_flight_job: true, outcome: 'lease_released', job_id: job.id }));
    } catch (error) {
      this.jobLogger.error(JSON.stringify({ event: 'worker_stopped', lane: 'sync', in_flight_job: true, outcome: 'lease_release_failed', job_id: job.id, error_code: safeJobErrorCode(error) }));
    }
  }

  /** The newest reading's time (current state), or NaN. */
  private async latestReadingMs(patientId: string): Promise<number> {
    const state = (await this.repository.getCurrentState(patientId).catch(() => null)) as Record<string, unknown> | null;
    return Date.parse(String(state?.as_of ?? ''));
  }

  /** Every 10 s while a reading is due (5 min 5 s – 15 min after the newest one): reads Nightscout at once. */
  private async pollDueReadings(): Promise<void> {
    if (this.shuttingDown || this.dueReadingPollRunning) return;
    this.dueReadingPollRunning = true;
    try {
      for (const source of await this.nightscoutSyncService.listNightscoutSources()) {
        if (this.sourceSyncs.has(source.id)) continue;
        const age = Date.now() - (await this.latestReadingMs(source.patient_id));
        if (!Number.isFinite(age) || age < DUE_READING_AFTER_MS || age > DUE_READING_POLL_UNTIL_MS) continue;
        await this.runSourceSync(source.id);
      }
    } catch (error) {
      this.jobLogger.warn(JSON.stringify({ event: 'due_reading_poll_failed', error_code: safeJobErrorCode(error) }));
    } finally {
      this.dueReadingPollRunning = false;
    }
  }

  /**
   * Before an answer that uses glucose: when the newest reading is older than 4.5 min, read Nightscout now (at most
   * 6 s; the answer goes on with what is there). Never throws.
   */
  private async refreshGlucoseBeforeAnswer(patientId: string): Promise<void> {
    if (!this.nightscoutSyncEnabled || !patientId) return;
    try {
      const before = await this.latestReadingMs(patientId);
      if (Number.isFinite(before) && Date.now() - before < FRESH_READING_MAX_AGE_MS) return;
      const sources = (await this.nightscoutSyncService.listNightscoutSources()).filter((source) => source.patient_id === patientId);
      if (sources.length === 0) return;
      const startedAtMs = Date.now();
      let timer: NodeJS.Timeout | undefined;
      const outcome = await Promise.race([
        Promise.all(sources.map((source) => this.runSourceSync(source.id))).then(() => 'synced' as const),
        new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), ANSWER_REFRESH_TIMEOUT_MS); }),
      ]);
      clearTimeout(timer);
      const after = await this.latestReadingMs(patientId);
      this.jobLogger.log(JSON.stringify({
        event: 'glucose_refreshed_before_answer',
        outcome,
        duration_ms: Date.now() - startedAtMs,
        reading_age_before_s: Number.isFinite(before) ? Math.round((startedAtMs - before) / 1000) : null,
        new_reading: Number.isFinite(after) && after !== before,
      }));
    } catch (error) {
      this.jobLogger.warn(JSON.stringify({ event: 'glucose_refresh_failed', error_code: safeJobErrorCode(error) }));
    }
  }

  async processOnce(): Promise<void> {
    if (this.shuttingDown || this.running) {
      return;
    }

    const run = this.claimAndRunNextJob();
    this.inFlight = run;
    try {
      await run;
    } finally {
      if (this.inFlight === run) {
        this.inFlight = null;
      }
    }
  }

  private async claimAndRunNextJob(): Promise<void> {
    this.running = true;
    let handedBackOnStop = false;
    let willRetry = false;
    this.lastProcessOnceClaimed = false;
    try {
      const nowIso = new Date().toISOString();
      let claimed: Awaited<ReturnType<PostgresGlucoMindRepository['claimNextJob']>>;
      try {
        // The unrestricted worker leaves Nightscout syncs to its sync lane (fresh-glucose.v1).
        claimed = this.syncLaneEnabled
          ? await this.repository.claimNextJob('worker-1', nowIso, 300, this.allowedJobTypes, [NIGHTSCOUT_SYNC_JOB_TYPE])
          : await this.repository.claimNextJob('worker-1', nowIso, 300, this.allowedJobTypes);
      } catch (error) {
        // processOnce runs from a timer as `void this.processOnce()`: a rejection here would be unhandled.
        this.jobLogger.error(JSON.stringify({ event: 'job_claim_failed', error_code: safeJobErrorCode(error) }));
        return;
      }
      if (!claimed) {
        return;
      }
      this.lastProcessOnceClaimed = true;
      this.inFlightJob = { id: claimed.id, lease_token: claimed.lease_token };
      if (this.shuttingDown) {
        // Claimed while the stop began: do not start new work; stop() hands the lease back.
        handedBackOnStop = true;
        return;
      }

      const startedAtMs = Date.now();
      // Job ids and types only: never the payload, message content or patient identifiers.
      const jobRef = { job_id: claimed.id, job_type: claimed.job_type };
      this.jobLogger.log(JSON.stringify({ event: 'job_claimed', ...jobRef, attempt: claimed.attempts }));

      try {
        switch (claimed.job_type) {
          case 'nightscout.sync':
            await this.handleNightscoutSync(claimed.id, claimed.lease_token, claimed.payload);
            break;
          case 'triggering.hypo_detection':
            await this.handleHypoDetection(claimed.id, claimed.lease_token, claimed.payload);
            break;
          case 'analysis.follow_up':
            await this.handleAnalysisFollowUp(claimed.id, claimed.lease_token, claimed.payload);
            break;
          case 'conversation.direct_response':
            await this.handleConversationDirectResponse(claimed.id, claimed.lease_token, claimed.payload);
            break;
          case 'conversation.time_range_analysis':
            await this.handleConversationTimeRangeAnalysis(claimed.id, claimed.lease_token, claimed.payload);
            break;
          case 'investigation.re_evaluate':
            await this.handleInvestigationReEvaluate(claimed.id, claimed.lease_token, claimed.payload);
            break;
          case 'notifications.push_conversation_question':
            await this.handleConversationQuestionPush(claimed.id, claimed.lease_token, claimed.payload);
            break;
          case MEAL_CHAT_REPLY_JOB_TYPE:
            await this.handleMealChatReply(claimed.id, claimed.lease_token, claimed.payload);
            break;
          case MEAL_WBT_SUGGESTION_JOB_TYPE:
            await this.handleWbtSuggestion(claimed.id, claimed.lease_token, claimed.payload);
            break;
          default:
            await this.repository.finalizeJobSuccess(claimed.id, claimed.lease_token, new Date().toISOString());
            break;
        }
        this.jobLogger.log(JSON.stringify({ event: 'job_finished', ...jobRef, outcome: 'succeeded', duration_ms: Date.now() - startedAtMs }));
        await this.pushAnswerOutcome(claimed, 'ready');
      } catch (error) {
        // Before the job state changes (which tells the app to re-read): a failed attempt's text must not be read as
        // the answer in progress.
        await this.finishReplyDraft();
        willRetry = await this.finalizeFailedJob(claimed, error, jobRef, startedAtMs);
        if (!willRetry) await this.pushAnswerOutcome(claimed, 'failed');
      }
    } finally {
      // After the answer is stored (or the job failed): no later draft write can outlive the stored answer.
      await this.finishReplyDraft();
      // An answer cancelled or failed for good leaves cards and reminders nobody sees: a reminder would still push.
      // (willRetry is this job's own: the sync lane fails jobs at the same time.)
      if (this.answerExtrasPending && !willRetry) {
        await this.discardAnswerExtras(this.answerExtrasPending.patientId, this.answerExtrasPending.userMessageId);
      }
      this.answerExtrasPending = null;
      // Card sessions live for one answer (one main-lane job at a time): none outlives a failed or cancelled one.
      this.bolusSessions.clear();
      this.wbtSessions.clear();
      this.rescueSessions.clear();
      if (!handedBackOnStop) {
        this.inFlightJob = null;
      }
      this.running = false;
    }
  }

  /**
   * A failed attempt: retried with backoff while retryable and attempts remain, else failed (both lanes). Never
   * throws: when the database is down too, the lease simply expires and the job is claimed again (or fails when
   * no attempts remain).
   */
  private async finalizeFailedJob(
    claimed: { id: string; lease_token: string; job_type: string; attempts: number; max_attempts: number },
    error: unknown,
    jobRef: { job_id: string; job_type: string },
    startedAtMs: number,
  ): Promise<boolean> {
    const retryable = isRetryableError(error);
    const willRetry = retryable && claimed.attempts < claimed.max_attempts;
    this.jobLogger.warn(JSON.stringify({
      event: 'job_finished',
      ...jobRef,
      outcome: willRetry ? 'retry' : 'failed',
      duration_ms: Date.now() - startedAtMs,
      error_code: safeJobErrorCode(error),
      // What actually went wrong (e.g. "Connection error." from the AI provider), short and without payloads.
      error_detail: jobErrorDetail(error),
      ...(willRetry ? { retry_in_seconds: retryBackoffSeconds(claimed.job_type, claimed.attempts) } : {}),
    }));
    try {
      await this.writeFailedJob(claimed, error, retryable, willRetry);
    } catch (finalizeError) {
      this.jobLogger.error(JSON.stringify({ event: 'job_finalize_failed', ...jobRef, error_code: safeJobErrorCode(finalizeError) }));
    }
    return willRetry;
  }

  private async writeFailedJob(
    claimed: { id: string; lease_token: string; job_type: string; attempts: number },
    error: unknown,
    retryable: boolean,
    willRetry: boolean,
  ): Promise<void> {
    if (willRetry) {
      const backoffSeconds = retryBackoffSeconds(claimed.job_type, claimed.attempts);
      await this.repository.finalizeJobRetry(
        claimed.id,
        claimed.lease_token,
        new Date().toISOString(),
        new Date(Date.now() + backoffSeconds * 1000).toISOString(),
        {
          error: error instanceof Error ? error.message : String(error),
          job_type: claimed.job_type,
          retryable: true,
        },
      );
    } else {
      await this.repository.finalizeJobFailure(
        claimed.id,
        claimed.lease_token,
        new Date().toISOString(),
        {
          error: error instanceof Error ? error.message : String(error),
          job_type: claimed.job_type,
          retryable,
        },
      );
    }
  }

  /** Listens on glucomind_jobs with its own connection (production only: needs the database pool and its URL). */
  private startJobListener(): void {
    const databaseUrl = (this.configService as { get?: (key: string) => unknown }).get?.('DATABASE_URL');
    if (!this.replyDraftRepository || typeof databaseUrl !== 'string' || !databaseUrl) return;
    this.jobListener = new PostgresChannelListener({
      connectionString: databaseUrl,
      channels: ['glucomind_jobs'],
      onNotification: () => {
        if (this.shuttingDown) return;
        void this.drainQueue();
        void this.drainSyncLane();
      },
      // Jobs queued while the connection was down are found by the regular poll anyway.
      log: (entry) => new Logger(WorkerService.name).log(JSON.stringify(entry)),
    });
    void this.jobListener.start();
  }

  /** Starts the live draft of the answer the current job writes (see ReplyDraftPublisher). */
  private startReplyDraft(kind: ReplyThreadKind, threadId: string, patientId: string, replyToMessageId: string): ReplyDraftPublisher | null {
    const drafts = this.replyDraftRepository;
    if (!drafts || !patientId || !threadId || !replyToMessageId) return null;
    void this.finishReplyDraft();
    const publisher = new ReplyDraftPublisher(
      {
        // The dose line waits for the final answer and its server notes (owner 2026-10-26): never acted on half-checked.
        write: (content) => drafts.upsert({ kind, threadId, patientId, replyToMessageId, content: withoutDraftDoseLine(content) }),
        remove: () => drafts.delete({ kind, threadId, replyToMessageId }),
      },
      REPLY_DRAFT_WRITE_INTERVAL_MS,
      (error) => this.jobLogger.warn(JSON.stringify({ event: 'reply_draft_write_failed', kind, error: error instanceof Error ? error.message : String(error) })),
    );
    this.activeReplyDraft = publisher;
    return publisher;
  }

  private async finishReplyDraft(): Promise<void> {
    const publisher = this.activeReplyDraft;
    this.activeReplyDraft = null;
    await publisher?.finish();
  }

  private createAiAttemptObserver(repositoryWithAiExecutions: unknown) {
    return {
      onAttemptStarted: async (args: { task_identity: string; provider: string; model: string; started_at: string }) => {
        const repositoryWithAttempts = repositoryWithAiExecutions as {
          createAiExecutionAttempt?: (params: { taskIdentity: string; provider: string; model: string; startedAt: string }) => Promise<{ id: string; attempt_number: number }>;
        };
        const created = repositoryWithAttempts.createAiExecutionAttempt
          ? await repositoryWithAttempts.createAiExecutionAttempt({
            taskIdentity: args.task_identity,
            provider: args.provider,
            model: args.model,
            startedAt: args.started_at,
          })
          : null;

        return created ? { attempt_id: created.id, attempt_number: created.attempt_number } : null;
      },
      onAttemptSucceeded: async (args: {
        attempt_id: string;
        task_identity: string;
        provider: string;
        model: string;
        model_fingerprint?: string | null;
        input_fingerprint?: string | null;
        started_at: string;
        completed_at: string;
        provider_latency_ms?: number | null;
        usage?: { input_tokens: number | null; output_tokens: number | null; total_tokens: number | null; cached_input_tokens: number | null; reasoning_tokens: number | null } | null;
        estimated_cost?: { estimated_cost: number | null; currency: string | null; pricing_version: string | null; input_cost: number | null; output_cost: number | null; cached_input_cost: number | null; reasoning_cost: number | null } | null;
      }) => {
        const repositoryWithAttempts = repositoryWithAiExecutions as {
          updateAiExecutionAttempt?: (params: { attemptId: string; provider: string; model: string; modelFingerprint?: string | null; inputFingerprint?: string | null; startedAt: string; completedAt?: string | null; providerLatencyMs?: number | null; status: 'RUNNING' | 'SUCCEEDED' | 'FAILED'; usage?: { input_tokens: number | null; output_tokens: number | null; total_tokens: number | null; cached_input_tokens: number | null; reasoning_tokens: number | null } | null; estimatedCost?: { estimated_cost: number | null; currency: string | null; pricing_version: string | null; input_cost: number | null; output_cost: number | null; cached_input_cost: number | null; reasoning_cost: number | null } | null; }) => Promise<void>;
        };
        if (repositoryWithAttempts.updateAiExecutionAttempt) {
          await repositoryWithAttempts.updateAiExecutionAttempt({
            attemptId: args.attempt_id,
            provider: args.provider,
            model: args.model,
            modelFingerprint: args.model_fingerprint ?? null,
            inputFingerprint: args.input_fingerprint ?? null,
            startedAt: args.started_at,
            completedAt: args.completed_at,
            providerLatencyMs: args.provider_latency_ms ?? null,
            status: 'SUCCEEDED',
            usage: args.usage ?? null,
            estimatedCost: args.estimated_cost ?? null,
          });
        }
      },
      onAttemptFailed: async (args: {
        attempt_id?: string | null;
        task_identity: string;
        provider: string;
        model: string;
        started_at: string;
        completed_at: string;
        provider_latency_ms?: number | null;
        error_type: string;
        error_code?: string | null;
        usage?: { input_tokens: number | null; output_tokens: number | null; total_tokens: number | null; cached_input_tokens: number | null; reasoning_tokens: number | null } | null;
        estimated_cost?: { estimated_cost: number | null; currency: string | null; pricing_version: string | null; input_cost: number | null; output_cost: number | null; cached_input_cost: number | null; reasoning_cost: number | null } | null;
      }) => {
        const repositoryWithAttempts = repositoryWithAiExecutions as {
          updateAiExecutionAttempt?: (params: { attemptId: string; provider: string; model: string; modelFingerprint?: string | null; inputFingerprint?: string | null; startedAt: string; completedAt?: string | null; providerLatencyMs?: number | null; status: 'RUNNING' | 'SUCCEEDED' | 'FAILED'; usage?: { input_tokens: number | null; output_tokens: number | null; total_tokens: number | null; cached_input_tokens: number | null; reasoning_tokens: number | null } | null; estimatedCost?: { estimated_cost: number | null; currency: string | null; pricing_version: string | null; input_cost: number | null; output_cost: number | null; cached_input_cost: number | null; reasoning_cost: number | null } | null; errorType?: string | null; errorCode?: string | null; }) => Promise<void>;
        };
        if (repositoryWithAttempts.updateAiExecutionAttempt && args.attempt_id) {
          await repositoryWithAttempts.updateAiExecutionAttempt({
            attemptId: args.attempt_id,
            provider: args.provider,
            model: args.model,
            startedAt: args.started_at,
            completedAt: args.completed_at,
            providerLatencyMs: args.provider_latency_ms ?? null,
            status: 'FAILED',
            errorType: args.error_type,
            errorCode: args.error_code ?? null,
            usage: args.usage ?? null,
            estimatedCost: args.estimated_cost ?? null,
          });
        }
      },
    };
  }

  private createAiProcessingObserver(repositoryWithAiExecutions: unknown, taskIdentity: string) {
    return {
      onStep: async (step: EvidenceProcessingStep) => {
        const repositoryWithProcessing = repositoryWithAiExecutions as {
          updateAiExecutionProcessingStep?: (args: {
            taskIdentity: string;
            step: Record<string, unknown>;
            status: 'PROCESSING' | 'FAILED';
          }) => Promise<void>;
        };

        if (!repositoryWithProcessing.updateAiExecutionProcessingStep) {
          return;
        }

        await repositoryWithProcessing.updateAiExecutionProcessingStep({
          taskIdentity,
          step: {
            execution_id: step.executionId,
            sequence: step.sequence,
            type: step.type,
            status: step.status,
            label: step.label,
            tool: step.tool ?? null,
            detail: step.detail ?? null,
            time_range: step.timeRange
              ? { start: step.timeRange.from, end: step.timeRange.to }
              : null,
            started_at: step.startedAt,
            completed_at: step.completedAt ?? null,
          },
          status: step.type === 'FAILED' ? 'FAILED' : 'PROCESSING',
        });
      },
    };
  }

  private createEvidenceSessionObserver(repositoryWithAiExecutions: unknown) {
    return {
      onSessionStarted: async (args: {
        task_identity: string;
        patient_id: string;
        task_type: string;
        context_package_id: string;
        context_package_hash: string;
        initial_evidence_hash: string;
        initial_evidence_bytes: number;
        started_at: string;
      }) => {
        const repositoryWithEvidenceSession = repositoryWithAiExecutions as {
          openEvidenceSession?: (params: {
            taskIdentity: string;
            patientId: string;
            taskType: string;
            contextPackageId: string;
            contextPackageHash: string;
            initialEvidenceHash: string;
            initialEvidenceBytes: number;
            startedAt: string;
          }) => Promise<{ sessionId: string } | null>;
        };
        if (repositoryWithEvidenceSession.openEvidenceSession) {
          await repositoryWithEvidenceSession.openEvidenceSession({
            taskIdentity: args.task_identity,
            patientId: args.patient_id,
            taskType: args.task_type,
            contextPackageId: args.context_package_id,
            contextPackageHash: args.context_package_hash,
            initialEvidenceHash: args.initial_evidence_hash,
            initialEvidenceBytes: args.initial_evidence_bytes,
            startedAt: args.started_at,
          });
        }
      },
      onToolCallRequested: async (args: {
        task_identity: string;
        patient_id: string;
        sequence: number;
        call_id: string | null;
        tool_name: string;
        request_hash: string;
        normalized_arguments: Record<string, unknown>;
        time_range: { from: string; to: string } | null;
        detail_level: string | null;
        requested_at: string;
      }) => {
        const repositoryWithEvidenceSession = repositoryWithAiExecutions as {
          recordEvidenceToolCallRequested?: (params: {
            taskIdentity: string;
            patientId: string;
            sequence: number;
            callId: string | null;
            toolName: string;
            requestHash: string;
            arguments: Record<string, unknown>;
            timeRange: { from: string; to: string } | null;
            detailLevel: string | null;
            requestedAt: string;
          }) => Promise<void>;
        };
        if (repositoryWithEvidenceSession.recordEvidenceToolCallRequested) {
          await repositoryWithEvidenceSession.recordEvidenceToolCallRequested({
            taskIdentity: args.task_identity,
            patientId: args.patient_id,
            sequence: args.sequence,
            callId: args.call_id,
            toolName: args.tool_name,
            requestHash: args.request_hash,
            arguments: args.normalized_arguments,
            timeRange: args.time_range,
            detailLevel: args.detail_level,
            requestedAt: args.requested_at,
          });
        }
      },
      onToolCallSucceeded: async (args: {
        task_identity: string;
        patient_id: string;
        sequence: number;
        result_status: string;
        result_hash: string;
        result_bytes: number;
        compiler_version: string | null;
        evidence_version: string | null;
        provenance_refs: string[];
        completed_at: string;
      }) => {
        const repositoryWithEvidenceSession = repositoryWithAiExecutions as {
          recordEvidenceToolCallSucceeded?: (params: {
            taskIdentity: string;
            patientId: string;
            sequence: number;
            resultStatus: string;
            resultHash: string;
            resultBytes: number;
            compilerVersion: string | null;
            evidenceVersion: string | null;
            provenanceRefs: string[];
            completedAt: string;
          }) => Promise<void>;
        };
        if (repositoryWithEvidenceSession.recordEvidenceToolCallSucceeded) {
          await repositoryWithEvidenceSession.recordEvidenceToolCallSucceeded({
            taskIdentity: args.task_identity,
            patientId: args.patient_id,
            sequence: args.sequence,
            resultStatus: args.result_status,
            resultHash: args.result_hash,
            resultBytes: args.result_bytes,
            compilerVersion: args.compiler_version,
            evidenceVersion: args.evidence_version,
            provenanceRefs: args.provenance_refs,
            completedAt: args.completed_at,
          });
        }
      },
      onToolCallFailed: async (args: {
        task_identity: string;
        patient_id: string;
        sequence: number;
        completed_at: string;
        failure: Record<string, unknown>;
      }) => {
        const repositoryWithEvidenceSession = repositoryWithAiExecutions as {
          recordEvidenceToolCallFailed?: (params: {
            taskIdentity: string;
            patientId: string;
            sequence: number;
            failure: Record<string, unknown>;
            completedAt: string;
          }) => Promise<void>;
        };
        if (repositoryWithEvidenceSession.recordEvidenceToolCallFailed) {
          await repositoryWithEvidenceSession.recordEvidenceToolCallFailed({
            taskIdentity: args.task_identity,
            patientId: args.patient_id,
            sequence: args.sequence,
            failure: args.failure,
            completedAt: args.completed_at,
          });
        }
      },
    };
  }

  private async handleNightscoutSync(jobId: string, leaseToken: string, payload: Record<string, unknown>): Promise<void> {
    const sourceId = String(payload.source_id);
    await this.runSourceSync(sourceId);
    await this.repository.finalizeJobSuccess(jobId, leaseToken, new Date().toISOString());
    // A read right after Trio answered a caregiver's command: build the loop action and the meal now, not on the
    // next 30-second tick (the unrestricted worker only, like the tick).
    if (typeof payload.remote_command_id === 'string' && !this.allowedJobTypes && this.loopActionRepository) {
      await this.processLoopActions();
    }
  }

  private async handleHypoDetection(jobId: string, leaseToken: string, payload: Record<string, unknown>): Promise<void> {
    const patientId = String(payload.patient_id);
    const eventId = String(payload.event_id);
    const persisted = await this.nightscoutSyncService.runHypoDetectionJob(eventId, patientId, new Date().toISOString());
    await this.repository.finalizeJobSuccess(jobId, leaseToken, new Date().toISOString());
    void persisted;
  }

  private async handleConversationDirectResponse(jobId: string, leaseToken: string, payload: Record<string, unknown>): Promise<void> {
    const patientId = String(payload.patient_id ?? '');
    const conversationId = String(payload.conversation_id ?? '');
    const userMessageId = String(payload.user_message_id ?? '');
    if (!patientId || !conversationId || !userMessageId) {
      throw new Error('INVALID_DIRECT_RESPONSE_PAYLOAD');
    }

    const conversation = (await this.repository.getConversation(patientId, conversationId)) as any;
    if (!conversation) {
      throw new Error('INSUFFICIENT_DATA');
    }

    const assistantIdempotencyKey = `assistant-message:direct:${conversationId}:${userMessageId}`;
    const existingAssistant = await this.repository.getMessageByIdempotencyKey(conversationId, assistantIdempotencyKey);
    if (existingAssistant) {
      await this.repository.finalizeJobSuccess(jobId, leaseToken, new Date().toISOString());
      return;
    }

    // Cards and reminders of this question from an earlier attempt belong to it until it is answered: a cancel (also
    // during the retry wait) or a final failure discards them; an answer reusing the stored AI result keeps them.
    this.answerExtrasPending = { patientId, userMessageId };

    // Cancelled by the user before this job started (or between retries): do no work at all.
    if (await this.isAnalysisCancelled(conversationId, userMessageId)) {
      await this.finalizeCancelledAnalysisJob(jobId, leaseToken, null);
      return;
    }

    // A newer reading is probably in Nightscout already: read it before the answer uses glucose (fresh-glucose.v1).
    const jobStartedAt = Date.now();
    await this.refreshGlucoseBeforeAnswer(patientId);
    this.answerPhaseMarks.set(userMessageId, { job_started_at: jobStartedAt, refreshed_at: Date.now() });
    if (this.answerPhaseMarks.size > 50) this.answerPhaseMarks.delete(this.answerPhaseMarks.keys().next().value as string);

    const userMessage = await this.repository.getMessageById(conversationId, userMessageId);
    if (!userMessage || String(userMessage.message_type ?? '') !== 'USER_MESSAGE') {
      throw new Error('USER_MESSAGE_NOT_FOUND');
    }

    const userText = String(userMessage.content ?? '').trim();
    // "Zapisz ten posiłek jako…" is a meal change for the chat to prepare, not a question about what is stored.
    if (isDataPersistenceQuestion(userText) && !(isMealActionsEnabled() && isMealEditRequest(userText))) {
      if (!(await this.claimAnalysisCompletion(conversationId, userMessageId))) {
        await this.finalizeCancelledAnalysisJob(jobId, leaseToken, null);
        return;
      }
      await this.repository.insertMessage({
        conversationId,
        patientId,
        role: 'ASSISTANT',
        messageType: 'ASSISTANT_MESSAGE',
        content: buildDataPersistenceAnswer(),
        questionId: null,
        answerType: null,
        answerText: null,
        answerValue: null,
        provenanceRef: `policy/conversation/${conversationId}`,
        metadata: {
          source: 'direct-response-policy',
          decision: 'DIRECT_RESPONSE',
          user_message_id: userMessageId,
          policy: 'DATA_PERSISTENCE_EXPLANATION',
        },
        idempotencyKey: assistantIdempotencyKey,
      });

      await this.repository.finalizeJobSuccess(jobId, leaseToken, new Date().toISOString());
      return;
    }

    const requestTimestamp = toIsoTimestamp(userMessage.created_at) ?? new Date().toISOString();
    // A period older than the 30 days an analysis holds (routeUserMessage sends it here): said plainly, no model call.
    const patientTz = await this.patientTimeZone(patientId);
    const beyondReachAnswer = buildBeyondReachAnswer(userText, requestTimestamp, patientTz);
    if (beyondReachAnswer) {
      if (!(await this.claimAnalysisCompletion(conversationId, userMessageId))) {
        await this.finalizeCancelledAnalysisJob(jobId, leaseToken, null);
        return;
      }
      await this.repository.insertMessage({
        conversationId,
        patientId,
        role: 'ASSISTANT',
        messageType: 'ASSISTANT_MESSAGE',
        content: beyondReachAnswer,
        questionId: null,
        answerType: null,
        answerText: null,
        answerValue: null,
        provenanceRef: `policy/conversation/${conversationId}`,
        metadata: {
          source: 'direct-response-policy',
          decision: 'DIRECT_RESPONSE',
          user_message_id: userMessageId,
          policy: 'PERIOD_BEYOND_REACH',
        },
        idempotencyKey: assistantIdempotencyKey,
      });

      await this.repository.finalizeJobSuccess(jobId, leaseToken, new Date().toISOString());
      return;
    }

    const currentState = ((await this.repository.getCurrentStateAtOrBefore(patientId, requestTimestamp))
      ?? (await this.repository.getCurrentState(patientId))) as any;
    const latestFacts = await this.repository.listRecentConversationEventFacts({
      patientId,
      conversationId,
      limit: 20,
    });

    const requestMs = Date.parse(requestTimestamp);
    const messagesAtRequest: any[] = Array.isArray(conversation.messages)
      ? conversation.messages.filter((message: any) => !(Date.parse(String(message.created_at ?? requestTimestamp)) > requestMs))
      : [];
    // Earlier answers' cards (their numbers are not in the answers' text): the model can change or recompute them.
    const cardNotes = await this.answerCardNotes(patientId, conversationId, messagesAtRequest, requestTimestamp);
    const contextBase = {
      context_package_id: `conversation:${conversationId}:user-message:${userMessageId}`,
      context_package_version: 'conversation-context.v1' as const,
      content_hash: '',
      created_at: new Date().toISOString(),
      // The question's time: "za godzinę", "jutro o 7" are read from it, not from when the job ran (retries, backoff).
      question_at: requestTimestamp,
      patient_ref: {
        patient_id: patientId,
        birth_year: await this.patientBirthYear(patientId),
      },
      user_preferences: await this.userAiPreferences(userMessage.author_user_id),
      conversation_context: {
        thread_id: String(conversation.id),
        thread_state_version: String(conversation.thread_state_version ?? 'conv-v1'),
        awaiting_user_answer: Boolean(conversation.awaiting_user_answer),
        // Only messages up to the question: a retry hashes the same context even when the chat went on meanwhile.
        messages: messagesAtRequest.slice(-12).map((message: any) => ({
          message_id: String(message.id),
          role: String(message.role ?? 'SYSTEM') as 'SYSTEM' | 'USER' | 'ASSISTANT',
          created_at: String(message.created_at ?? requestTimestamp),
          content: withCardNote(conversationMessageTextForAi(message), cardNotes.get(String(message.id))),
          provenance_ref: String(message.provenance_ref ?? ''),
          message_type: typeof message.message_type === 'string' ? message.message_type : 'OTHER',
        })),
        already_suggested_follow_ups: collectAlreadySuggestedFollowUps(messagesAtRequest),
        needs_title: conversationNeedsAiTitle(conversation),
      },
      direct_response_input: {
        user_message_id: String(userMessage.id),
        user_message_text: userQuestionTextForAi(userMessage),
      },
      current_state_snapshot: currentState
        ? {
            as_of: String(currentState.as_of ?? new Date().toISOString()),
            current_glucose: typeof currentState.glucose?.value === 'number' ? Number(currentState.glucose.value) : 'UNKNOWN' as const,
            trend: typeof currentState.glucose?.trend === 'string' ? String(currentState.glucose.trend) : 'UNKNOWN' as const,
            iob: typeof currentState.iob?.value === 'number' ? Number(currentState.iob.value) : 'UNKNOWN' as const,
            cob: typeof currentState.cob?.value === 'number' ? Number(currentState.cob.value) : 'UNKNOWN' as const,
            // How old the reading was when the question was asked (a CGM reading comes every 5 min); the question's
            // time, not the clock, keeps the context hash stable across retries.
            age_minutes: Number.isFinite(Date.parse(String(currentState.as_of)))
              ? Math.max(0, Math.round((Date.parse(requestTimestamp) - Date.parse(String(currentState.as_of))) / 60_000))
              : null,
          }
        : null,
      therapy_now: await this.loadTherapyNow(patientId, requestTimestamp),
      patient_time_zone: patientTz,
      patient_facts: latestFacts.map((fact) => ({
        fact_key: String(fact.fact_key ?? ''),
        fact_name: String(fact.fact_name ?? ''),
        knowledge_status: String(fact.knowledge_status ?? ''),
        value: fact.value,
        value_type: String(fact.value_type ?? ''),
        source_ref: String(fact.source_ref ?? ''),
        recorded_at: String(fact.recorded_at ?? new Date().toISOString()),
      })),
      provenance: {
        source_refs: [
          String(userMessage.id),
          String(userMessage.provenance_ref ?? ''),
          ...latestFacts
            .map((fact) => String(fact.source_ref ?? ''))
            .filter((ref) => ref.length > 0)
            .slice(0, 20),
        ].filter((ref) => ref.length > 0),
      },
    };

    // Stable across job retries (see buildContextPackageIdentityHash): a retry reuses a succeeded AI execution.
    const contextHash = buildContextPackageIdentityHash(contextBase as unknown as Record<string, unknown>);
    const directContext = {
      ...contextBase,
      content_hash: contextHash,
    };

    const aiTask = createConversationDirectResponseTask({
      task_id: `${jobId}:${conversationId}:${userMessageId}`,
      context_package_id: directContext.context_package_id,
      context_package_version: directContext.context_package_version,
      context_package_hash: directContext.content_hash,
      correlation_id: conversationId,
      created_at: new Date().toISOString(),
      patient_id: patientId,
    });
    const taskIdentity = buildAiTaskIdentity(aiTask);

    const repositoryWithAiExecutions = this.repository as unknown as {
      getAiExecutionByTaskIdentity?: (taskIdentity: string) => Promise<Record<string, unknown> | null>;
      markAiExecutionRunning?: (args: { task: typeof aiTask; taskIdentity: string; inputHash: string; nowIso: string }) => Promise<void>;
      markAiExecutionSucceeded?: (args: { taskIdentity: string; result: Record<string, unknown>; nowIso: string }) => Promise<void>;
      markAiExecutionFailed?: (args: { taskIdentity: string; error: Record<string, unknown>; nowIso: string }) => Promise<void>;
      completeEvidenceSession?: (args: { taskIdentity: string; patientId: string; completedAt: string }) => Promise<void>;
      failEvidenceSession?: (args: { taskIdentity: string; patientId: string; failedAt: string; failure: Record<string, unknown> }) => Promise<void>;
    };

    const existingExecution = repositoryWithAiExecutions.getAiExecutionByTaskIdentity
      ? await repositoryWithAiExecutions.getAiExecutionByTaskIdentity(taskIdentity)
      : null;

    let aiExecution: Record<string, unknown>;
    let mealSession: MealActionsToolSession | null = null;
    if (existingExecution?.status === 'succeeded' && existingExecution.normalized_result) {
      aiExecution = existingExecution.normalized_result as Record<string, unknown>;
    } else {
      if (repositoryWithAiExecutions.markAiExecutionRunning) {
        await repositoryWithAiExecutions.markAiExecutionRunning({
          task: aiTask,
          taskIdentity,
          inputHash: buildAiInputHash({ context_package: directContext }),
          nowIso: new Date().toISOString(),
        });
      }

      try {
        const timeoutCandidate = typeof (this.configService as { get?: (key: string) => unknown }).get === 'function'
          ? (this.configService as { get: (key: string) => unknown }).get('OPENAI_TIMEOUT_MS')
          : undefined;
        const timeoutMs = Number(timeoutCandidate ?? 15_000);
        const attemptObserver = this.createAiAttemptObserver(repositoryWithAiExecutions);

        const aiInvokeInput = {
          task: aiTask,
          context_package: directContext,
          timeout_ms: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 15_000,
        } as {
          task: typeof aiTask;
          context_package: typeof directContext;
          timeout_ms: number;
          attempt_observer?: typeof attemptObserver;
        };
        Object.defineProperty(aiInvokeInput, 'attempt_observer', {
          value: attemptObserver,
          enumerable: false,
          configurable: true,
        });
        mealSession = await this.attachConversationAiExtras(aiInvokeInput, patientId, conversation, userMessageId);

        const executed = await this.executeCancellableAi(aiInvokeInput, conversationId, userMessageId, patientId);
        aiExecution = executed as unknown as Record<string, unknown>;
        if (repositoryWithAiExecutions.markAiExecutionSucceeded) {
          await repositoryWithAiExecutions.markAiExecutionSucceeded({
            taskIdentity,
            result: aiExecution,
            nowIso: new Date().toISOString(),
          });
        }
      } catch (error) {
        if (isCancelledAiExecution(error)) {
          await this.finalizeCancelledAnalysisJob(jobId, leaseToken, taskIdentity);
          return;
        }
        if (repositoryWithAiExecutions.markAiExecutionFailed) {
          await repositoryWithAiExecutions.markAiExecutionFailed({
            taskIdentity,
            error: {
              error: error instanceof Error ? error.message : String(error),
              retryable: isRetryableError(error),
            },
            nowIso: new Date().toISOString(),
          });
        }

        throw error;
      }
    }

    // Last point where a cancellation wins: after this claim the result is saved and cancel reports ALREADY_COMPLETED.
    if (!(await this.claimAnalysisCompletion(conversationId, userMessageId))) {
      await this.finalizeCancelledAnalysisJob(jobId, leaseToken, taskIdentity);
      return;
    }

    const aiExecutionTyped = aiExecution as {
      metadata?: {
        provider?: string;
        model?: string;
        model_fingerprint?: string;
        knowledge_sources?: unknown;
      };
      result: {
        assistant_message?: string;
        follow_up_candidates?: unknown;
        conversation_title?: unknown;
        answer_options?: unknown;
      };
    };
    const mealAnswer = await this.mealActionAnswerState(mealSession, patientId, userMessageId);
    const answerText = String(aiExecutionTyped.result?.assistant_message ?? '').trim();
    if (!answerText) {
      throw new Error('INVALID_DIRECT_RESPONSE_OUTPUT');
    }
    // A meal change is saved only from its card, a dose is given only from its card: an answer that says otherwise gets
    // one plain sentence.
    const bolusAnswer = await this.bolusAnswerState(patientId, userMessageId);
    const answerOptions = await this.answerOptionsFor(aiExecutionTyped.result?.answer_options, bolusAnswer, userMessageId, patientId);
    // Options the server dropped (fewer than two with cards): the text must not point to a picker that is not there.
    // A free-text dose is checked against the reading it was written from, as in the analysis path.
    const directSnapshot = contextBase.current_state_snapshot;
    const directGlucose = directSnapshot
      ? { glucose_mgdl: typeof directSnapshot.current_glucose === 'number' ? directSnapshot.current_glucose : null, age_minutes: directSnapshot.age_minutes ?? null, trend: directSnapshot.trend === 'UNKNOWN' ? null : directSnapshot.trend }
      : null;
    const mealChecked = finalizeMealActionAnswer(answerText, mealAnswer);
    const therapyChecked = finalizeTherapyProposal(mealChecked.text, directGlucose, proposesDose);
    const bolusChecked = finalizeBolusAnswer(therapyChecked.text, bolusAnswer);
    const assistantMessage = withoutOptionPointer(bolusChecked.text, answerOptions.length > 0);
    const correctionFlag = serverCorrectionFlag([
      mealChecked.corrected && 'MEAL_WRITE_CLAIM',
      therapyChecked.kind,
      bolusChecked.kind,
      assistantMessage !== bolusChecked.text && 'OPTION_POINTER_REMOVED',
      modelOfferedOptions(aiExecutionTyped.result?.answer_options) && answerOptions.length === 0 && 'OPTIONS_DROPPED',
    ]);

    // The best three of the answer's own candidates, never a repeat of a question asked or offered before; none under
    // the option picker.
    const { suggestions: suggestedFollowUps, hot: hotSuggestedFollowUp } = withoutOptionChoices(selectFollowUpSuggestions(
      aiExecutionTyped.result?.follow_up_candidates,
      collectFollowUpExclusions(conversation.messages),
      assistantMessage,
    ), answerOptions.length > 0);

    await this.saveAiConversationTitle(conversation, aiExecutionTyped.result?.conversation_title);

    const persistedExecution = await this.repository.getAiExecutionByTaskIdentity(taskIdentity);
    const aiExecutionId = persistedExecution?.id ? String(persistedExecution.id) : null;
    // A direct reply has no analysed range: its claims are checked against the 24 hours before the question.
    const noDataFlag = await this.checkNoDataAnswer({
      patientId,
      answer: assistantMessage,
      windowBasis: 'LAST_24H',
      windowFrom: new Date(Date.parse(requestTimestamp) - 24 * 60 * 60 * 1000).toISOString(),
      windowTo: requestTimestamp,
    });

    const insertedAssistant = await this.repository.insertMessage({
      conversationId,
      patientId,
      role: 'ASSISTANT',
      messageType: 'ASSISTANT_MESSAGE',
      content: assistantMessage,
      questionId: null,
      answerType: null,
      answerText: null,
      answerValue: null,
      provenanceRef: aiExecutionId ? `ai-execution/${aiExecutionId}` : `ai-task/${taskIdentity}`,
      metadata: {
        source: 'direct-response-ai',
        // Best first: the hot one, when there is one, is on top.
        suggested_follow_ups: suggestedFollowUps,
        ...(hotSuggestedFollowUp ? { hot_suggested_follow_up: hotSuggestedFollowUp } : {}),
        ...(answerOptions.length > 0 ? { answer_options: answerOptions } : {}),
        knowledge_sources: sanitizeKnowledgeSources(aiExecutionTyped.metadata?.knowledge_sources),
        decision: 'DIRECT_RESPONSE',
        user_message_id: userMessageId,
        // The answer worked on a meal: a short reply continues it with the meal tools (conversation-meal-actions.v1).
        ...(mealAnswer.used ? { meal_assistant: true } : {}),
        ai_task_type: aiTask.task_type,
        ai_task_version: aiTask.task_version,
        ai_task_identity: taskIdentity,
        ai_execution_id: aiExecutionId,
        provider: aiExecutionTyped.metadata?.provider ?? null,
        model: aiExecutionTyped.metadata?.model ?? null,
        model_fingerprint: aiExecutionTyped.metadata?.model_fingerprint ?? null,
        ...(noDataFlag || correctionFlag ? { anomaly_flags: [noDataFlag, correctionFlag].filter(Boolean) } : {}),
      },
      idempotencyKey: assistantIdempotencyKey,
    });
    // The answer's cards and reminders now belong to a stored answer.
    this.answerExtrasPending = null;
    this.logSuspiciousNoDataAnswer({ flag: noDataFlag, message: insertedAssistant, conversationId, userMessageId, taskType: aiTask.task_type, rangeType: null });
    this.logServerCorrection({ flag: correctionFlag, message: insertedAssistant, conversationId, userMessageId, taskType: aiTask.task_type });

    await this.repository.finalizeJobSuccess(jobId, leaseToken, new Date().toISOString());
  }

  /** Names the conversation in the history list from the answer's conversation_title; a failure never fails the answer. */
  private async saveAiConversationTitle(conversation: Record<string, unknown>, rawTitle: unknown): Promise<void> {
    if (!conversationNeedsAiTitle(conversation)) return;
    const title = sanitizeConversationTitle(rawTitle);
    if (!title) return;
    try {
      await this.repository.setAiConversationTitleIfMissing(String(conversation.id), title);
    } catch (error) {
      this.jobLogger.warn(JSON.stringify({ event: 'conversation_title_not_saved', conversation_id: String(conversation.id), error_code: safeJobErrorCode(error) }));
    }
  }

  /**
   * Safety net (anomaly audit 2026-10-19): an answer that says data is missing ("nie mam danych", "brak odczytów",
   * "nie było bolusa", ...) while the database has that kind of data in the answer's window gets a flag for the owner's
   * daily review (deploy/sql/suspicious-answers.sql). The answer itself is never changed or held back: any failure here
   * only skips the check. The database is read only when the answer makes such a claim.
   */
  private async checkNoDataAnswer(args: {
    patientId: string;
    answer: string;
    windowBasis: SuspiciousNoDataFlag['window_basis'];
    windowFrom: string;
    windowTo: string;
  }): Promise<SuspiciousNoDataFlag | null> {
    try {
      const claims = findNoDataClaims(args.answer);
      if (claims.length === 0) return null;
      const count = (this.repository as { countPatientDataInRange?: PostgresGlucoMindRepository['countPatientDataInRange'] }).countPatientDataInRange;
      if (typeof count !== 'function') return null;
      const counts = await count.call(this.repository, { patientId: args.patientId, startAtIso: args.windowFrom, endAtIso: args.windowTo });
      return evaluateNoDataClaims({ claims, counts, windowBasis: args.windowBasis, windowFrom: args.windowFrom, windowTo: args.windowTo });
    } catch (error) {
      this.jobLogger.warn(JSON.stringify({ event: 'suspicious_no_data_check_failed', error_code: safeJobErrorCode(error) }));
      return null;
    }
  }

  /** The flagged answer's log line: ids, the claim words and the counts, never patient values. */
  private logServerCorrection(args: { flag: ServerCorrectionFlag | null; message: Record<string, unknown> | null | undefined; conversationId: string; userMessageId: string; taskType: string }): void {
    if (!args.flag) return;
    this.jobLogger.warn(JSON.stringify({
      event: 'server_correction',
      message_id: args.message?.id ? String(args.message.id) : null,
      conversation_id: args.conversationId,
      user_message_id: args.userMessageId,
      task_type: args.taskType,
      corrections: args.flag.corrections,
    }));
  }

  private logSuspiciousNoDataAnswer(args: { flag: SuspiciousNoDataFlag | null; message: Record<string, unknown> | null | undefined; conversationId: string; userMessageId: string; taskType: string; rangeType: string | null }): void {
    if (!args.flag) return;
    this.jobLogger.warn(JSON.stringify({
      event: 'suspicious_no_data_answer',
      message_id: args.message?.id ? String(args.message.id) : null,
      conversation_id: args.conversationId,
      user_message_id: args.userMessageId,
      task_type: args.taskType,
      range_type: args.rangeType,
      window_basis: args.flag.window_basis,
      window_hours: Math.round((Date.parse(args.flag.window_to) - Date.parse(args.flag.window_from)) / 36e5),
      phrases: args.flag.claims.map((claim) => claim.phrase),
      claim_kinds: args.flag.claims.map((claim) => claim.kind),
      counts: args.flag.counts,
    }));
  }

  private async handleConversationTimeRangeAnalysis(jobId: string, leaseToken: string, payload: Record<string, unknown>): Promise<void> {
    const patientId = String(payload.patient_id ?? '');
    const conversationId = String(payload.conversation_id ?? '');
    const userMessageId = String(payload.user_message_id ?? '');
    const rangeTypeRaw = String(payload.range_type ?? '');
    const rangeStartIso = String(payload.range_start ?? '');
    const rangeEndIso = String(payload.range_end ?? '');
    const timezone = String(payload.timezone ?? '');
    const normalizationPolicyVersion = String(payload.normalization_policy_version ?? '');

    if (!patientId || !conversationId || !userMessageId || !isSupportedConversationTimeRangeType(rangeTypeRaw)) {
      throw new Error('INVALID_TIME_RANGE_ANALYSIS_PAYLOAD');
    }

    const windowValidation = validateNormalizedTimeRangeWindow({
      range_type: rangeTypeRaw,
      range_start: rangeStartIso,
      range_end: rangeEndIso,
      timezone,
    });
    if (!windowValidation.ok) {
      throw new Error('INVALID_TIME_RANGE_ANALYSIS_PAYLOAD');
    }

    const rangeType: ConversationTimeRangeType = rangeTypeRaw;

    const conversation = (await this.repository.getConversation(patientId, conversationId)) as any;
    if (!conversation) {
      throw new Error('INSUFFICIENT_DATA');
    }

    const assistantIdempotencyKey = `assistant-message:analysis:${conversationId}:${userMessageId}`;
    const existingAssistant = await this.repository.getMessageByIdempotencyKey(conversationId, assistantIdempotencyKey);
    if (existingAssistant) {
      await this.repository.finalizeJobSuccess(jobId, leaseToken, new Date().toISOString());
      return;
    }

    // Cards and reminders of this question from an earlier attempt belong to it until it is answered: a cancel (also
    // during the retry wait) or a final failure discards them; an answer reusing the stored AI result keeps them.
    this.answerExtrasPending = { patientId, userMessageId };

    // Cancelled by the user before this job started (or between retries): do no work at all.
    if (await this.isAnalysisCancelled(conversationId, userMessageId)) {
      await this.finalizeCancelledAnalysisJob(jobId, leaseToken, null);
      return;
    }

    // A newer reading is probably in Nightscout already: read it before the answer uses glucose (fresh-glucose.v1).
    const jobStartedAt = Date.now();
    await this.refreshGlucoseBeforeAnswer(patientId);
    this.answerPhaseMarks.set(userMessageId, { job_started_at: jobStartedAt, refreshed_at: Date.now() });
    // A job that fails before the model leaves its marks: keep only the newest.
    if (this.answerPhaseMarks.size > 50) this.answerPhaseMarks.delete(this.answerPhaseMarks.keys().next().value as string);

    const userMessage = await this.repository.getMessageById(conversationId, userMessageId);
    if (!userMessage || String(userMessage.message_type ?? '') !== 'USER_MESSAGE') {
      throw new Error('USER_MESSAGE_NOT_FOUND');
    }

    const requestAtIso = toIsoTimestamp(userMessage.created_at) ?? new Date().toISOString();
    const requestAt = new Date(requestAtIso);
    if (!Number.isFinite(requestAt.getTime())) {
      throw new Error('INVALID_REQUEST_TIMESTAMP');
    }

    const currentState = ((await this.repository.getCurrentStateAtOrBefore(patientId, requestAtIso))
      ?? (await this.repository.getCurrentState(patientId))) as any;
    // About 520 events a day without the loop's IOB/COB snapshots (CGM every 5 min, temp basals, SMBs, boluses, carbs);
    // Trio adds ~660 snapshots a day, which nothing in the analysis reads (IOB/COB come from the current state). With
    // them a 3-day question lost today and a week its last ~2.5 days (2026-10-19: "z dzisiejszej nocy nie ma odczytów
    // CGM"). Scale the limit with the range up to the repository's cap; when a long range is still cut, keep its most
    // recent events.
    const rangeDays = Math.max(1, Math.ceil((Date.parse(rangeEndIso) - Date.parse(rangeStartIso)) / (24 * 60 * 60 * 1000)));
    const eventLimit = Math.min(5000, Math.max(1800, 650 * rangeDays));
    const events = await this.repository.listPatientEventsByRange({
      patientId,
      startAtIso: rangeStartIso,
      endAtIso: rangeEndIso,
      limit: eventLimit,
      excludeTypes: LOOP_SNAPSHOT_EVENT_TYPES,
      keep: 'NEWEST',
    });
    // A cut selection holds the range from its oldest selected event on (14 days: ~4 days lost, 30 days: ~20).
    const selectionTruncated = events.length >= eventLimit;
    const selectedFrom = selectionTruncated && events.length > 0 ? toIsoTimestamp(events[0].occurred_at) : null;
    // DIA of the therapy valid at the range end: the look-back of the pre-hypo insulin/basal evidence.
    const therapyContext = await (async (): Promise<NonNullable<TimeRangeAnalysisContextRecord['therapy_context']>> => {
      const lookup = (this.repository as { getTherapyDiaAt?: PostgresGlucoMindRepository['getTherapyDiaAt'] }).getTherapyDiaAt;
      if (typeof lookup !== 'function') return { status: 'UNAVAILABLE', dia_hours: null, therapy_id: null, valid_from: null };
      try {
        return await lookup.call(this.repository, patientId, rangeEndIso);
      } catch {
        return { status: 'UNAVAILABLE', dia_hours: null, therapy_id: null, valid_from: null };
      }
    })();
    // Therapy profile valid at the range end: the basis of dose and settings suggestions.
    const therapyProfile = await (async (): Promise<NonNullable<TimeRangeAnalysisContextRecord['therapy_profile']>> => {
      const unavailable = { status: 'UNAVAILABLE' as const, therapy_id: null, valid_from: null, units: null, timezone: null, dia_hours: null, carb_ratio_g_per_u: null, sensitivity_per_u: null, basal_u_per_h: null, target_low: null, target_high: null };
      const lookup = (this.repository as { getTherapyProfileAt?: PostgresGlucoMindRepository['getTherapyProfileAt'] }).getTherapyProfileAt;
      if (typeof lookup !== 'function') return unavailable;
      try {
        return await lookup.call(this.repository, patientId, rangeEndIso);
      } catch {
        return unavailable;
      }
    })();
    // A month can hold more than 50 episodes: the most recent are kept and the true count is reported.
    const hypoEpisodes = await this.repository.listHypoEpisodesIntersectingRange({
      patientId,
      startAtIso: rangeStartIso,
      endAtIso: rangeEndIso,
      limit: 50,
      keep: 'NEWEST',
    });
    const hypoEpisodesTotal = Math.max(hypoEpisodes.length, Number(hypoEpisodes[0]?.total_in_range ?? 0) || 0);
    const dailyInsulinTotals = await this.buildDailyInsulinTotalsForRange({
      patientId,
      rangeStartIso,
      rangeEndIso,
      timezone,
      therapyProfile,
      selectedEvents: events,
      selectionTruncated,
    });
    const rangeFacts = await this.repository.listPatientContextFactsByRecordedRange({
      patientId,
      startAtIso: rangeStartIso,
      endAtIso: rangeEndIso,
      limit: 150,
      keep: 'NEWEST',
    });
    const rangeFactsTotal = Math.max(rangeFacts.length, Number(rangeFacts[0]?.total_in_range ?? 0) || 0);

    const eventProjection = events.map((event) => ({
      event_id: String(event.id ?? ''),
      type: String(event.type ?? ''),
      occurred_at: String(event.occurred_at ?? ''),
      payload: event.payload ?? {},
      source_record_id: event.source_record_id ? String(event.source_record_id) : null,
    }));

    const glucoseEvents = eventProjection.filter((event) => ['GLUCOSE_READING_AVAILABLE', 'GLUCOSE_READING', 'GLUCOSE'].includes(event.type));
    const insulinTreatmentEvents = eventProjection.filter((event) => ['BOLUS', 'SMB', 'TEMP_BASAL', 'IOB_SNAPSHOT', 'COB_SNAPSHOT', 'THERAPY_CONTEXT', 'PROFILE_CHANGE', 'BASAL_PROFILE_SNAPSHOT'].includes(event.type));
    // Correction carbs are entered only so the loop keeps dosing after a correction: they were never eaten.
    const isVirtualCarbs = (event: { payload: unknown }) => (event.payload as Record<string, unknown>)?.carb_kind === 'CORRECTION_CARBS';
    // Entries the caregiver deleted in GlucoMind (mistaken/duplicate) are left out of the analysis entirely.
    const isIgnoredCarbs = (event: { payload: unknown }) => (event.payload as Record<string, unknown>)?.carb_kind === 'IGNORED';
    // WBT: carbs logged to dose for the protein and fat of a meal; not carbohydrates eaten.
    const isFatProteinUnits = (event: { payload: unknown }) => (event.payload as Record<string, unknown>)?.carb_kind === 'FAT_PROTEIN_UNITS';
    const mealEvents = eventProjection.filter((event) => event.type === 'CARB_ENTRY' && !isVirtualCarbs(event) && !isIgnoredCarbs(event) && !isFatProteinUnits(event));
    // Each WBT entry carries the whole meal whose protein and fat it covers (often started before the range).
    const fatProteinUnitLinks = await this.linkFatProteinUnitEntriesToMeals(patientId, eventProjection.filter((event) => event.type === 'CARB_ENTRY' && isFatProteinUnits(event)));
    const fatProteinUnitCarbEvents = eventProjection
      .filter((event) => event.type === 'CARB_ENTRY' && isFatProteinUnits(event))
      .map((event) => ({ ...event, linked_meal: fatProteinUnitLinks.get(event.event_id) ?? null }));
    const virtualCarbEvents = eventProjection.filter((event) => event.type === 'CARB_ENTRY' && isVirtualCarbs(event));
    const mealRecords = await this.loadMealRecordsForAiContext(patientId, rangeStartIso, rangeEndIso);
    const activityEvents = eventProjection.filter((event) => event.type === 'ACTIVITY');

    const glucoseValues = glucoseEvents
      .map((event) => {
        const payloadValue = (event.payload as Record<string, unknown>)?.glucose_value;
        const directValue = (event.payload as Record<string, unknown>)?.glucose;
        const rawSgv = ((event.payload as Record<string, unknown>)?.raw_payload as Record<string, unknown> | undefined)?.sgv;
        const candidate = [payloadValue, directValue, rawSgv].find((value) => typeof value === 'number');
        // A reading of 0 or less is a sensor error, not a glucose: left out as TIR leaves it out.
        return typeof candidate === 'number' && Number.isFinite(candidate) && candidate > 0 ? candidate : null;
      })
      .filter((value): value is number => value !== null);

    const glucoseMin = glucoseValues.length > 0 ? Math.min(...glucoseValues) : null;
    const glucoseMax = glucoseValues.length > 0 ? Math.max(...glucoseValues) : null;
    const glucoseAvg = glucoseValues.length > 0 ? Number((glucoseValues.reduce((sum, value) => sum + value, 0) / glucoseValues.length).toFixed(2)) : null;
    // TIR/TBR/TAR cannot be derived from min/max/avg, so the model gets them computed; coverage up to the question,
    // from the first selected event when the selection was cut (unselected days are not a sensor gap).
    const coverageEndIso = Date.parse(rangeEndIso) > requestAt.getTime() ? requestAt.toISOString() : rangeEndIso;
    const glucoseTimeInRange = computeGlucoseTimeInRange(glucoseValues, { from: selectedFrom ?? rangeStartIso, to: coverageEndIso });
    // A cut selection: the range's glucose aggregates over every reading, so they describe the whole range.
    const glucoseWholeRange = selectionTruncated
      ? await this.loadWholeRangeGlucose(patientId, rangeStartIso, rangeEndIso, coverageEndIso)
      : null;

    const missingSections: string[] = [];
    if (glucoseEvents.length === 0) {
      missingSections.push('glucose_events');
    }
    if (insulinTreatmentEvents.length === 0) {
      missingSections.push('insulin_treatment_events');
    }
    if (mealEvents.length === 0) {
      missingSections.push('meal_events');
    }
    if (activityEvents.length === 0) {
      missingSections.push('activity_events');
    }
    if (hypoEpisodes.length === 0) {
      missingSections.push('hypo_episodes');
    }

    const rangeIdentity = `${rangeType.toLowerCase()}:${rangeStartIso}:${rangeEndIso}`;
    const sourceRefs = [
      String(userMessage.id),
      String(userMessage.provenance_ref ?? ''),
      ...eventProjection.map((event) => event.event_id),
      ...rangeFacts.map((fact) => String(fact.source_ref ?? '')),
    ].filter((ref) => ref.length > 0);
    const derivedCurrentGlucose = typeof currentState?.glucose?.value === 'number' ? Number(currentState.glucose.value) : null;
    const anchoredMeal = resolveCurrentMealAnchor({
      user_message_text: String(userMessage.content ?? ''),
      request_at_iso: requestAtIso,
      meal_events: mealEvents.map((event) => ({
        event_id: event.event_id,
        occurred_at: event.occurred_at,
        payload: (event.payload as Record<string, unknown>) ?? {},
      })),
      current_state_recent_meal: currentState?.recent_meal
        ? {
            event_id: typeof currentState.recent_meal.event_id === 'string' ? String(currentState.recent_meal.event_id) : undefined,
            occurred_at: typeof currentState.recent_meal.occurred_at === 'string' ? String(currentState.recent_meal.occurred_at) : undefined,
            carbs: toFiniteNumber(currentState.recent_meal.carbs) ?? undefined,
          }
        : null,
    });
    // A rescue alert's conversation: the alert, its static dose and what was logged (rescue-carbs.v1).
    const rescueAlert: RescueAlertRecord | null = String(conversation.trigger_type ?? '') === 'RESCUE_CARBS' && this.rescueCarbsRepository
      ? await this.rescueCarbsRepository.getAlertByConversation(patientId, conversationId).catch(() => null)
      : null;

    // A meal's WBT conversation: the meal's WBT and the dose proposed now (wbt-chat.v1).
    // A meal gone (MEAL_NOT_FOUND) answers without the WBT data (and without bolus cards, see attachConversationAiExtras);
    // any other failure fails the job, so it is retried instead of answering as an ordinary chat.
    const wbtChat = typeof conversation.wbt_meal_record_id === 'string'
      ? await this.loadWbtChat(patientId, conversation.wbt_meal_record_id, userMessageId, requestAtIso).catch((error: unknown) => {
        if (error instanceof Error && error.message === 'MEAL_NOT_FOUND') return null;
        throw error;
      })
      : null;

    const cardNotesRange = await this.answerCardNotes(
      patientId,
      conversationId,
      Array.isArray(conversation.messages) ? conversation.messages.filter((message: any) => new Date(String(message.created_at ?? requestAtIso)).getTime() <= requestAt.getTime()) : [],
      requestAtIso,
    );
    const therapyNowTimeZone = await this.patientTimeZone(patientId);
    const analysisContextBase: TimeRangeAnalysisContextRecord = {
      context_package_id: `conversation-time-range:${conversationId}:user-message:${userMessageId}:${rangeIdentity}`,
      context_package_version: 'conversation-time-range-context.v1',
      content_hash: '',
      created_at: new Date().toISOString(),
      patient_ref: {
        patient_id: patientId,
        birth_year: await this.patientBirthYear(patientId),
      },
      user_preferences: await this.userAiPreferences(userMessage.author_user_id),
      analysis_request_input: {
        user_message_id: String(userMessage.id),
        user_message_text: userQuestionTextForAi(userMessage),
        range_type: rangeType,
        timezone,
        range_start: rangeStartIso,
        range_end: rangeEndIso,
        requested_at: requestAtIso,
        normalization_policy_version: normalizationPolicyVersion || undefined,
        ...(conversation.episode_id ? { focus_hypo_episode_id: String(conversation.episode_id) } : {}),
      },
      conversation_context: {
        thread_id: String(conversation.id),
        thread_state_version: String(conversation.thread_state_version ?? 'conv-v1'),
        awaiting_user_answer: Boolean(conversation.awaiting_user_answer),
        messages: Array.isArray(conversation.messages)
          ? conversation.messages
            .filter((message: any) => new Date(String(message.created_at ?? requestAtIso)).getTime() <= requestAt.getTime())
            .slice(-12)
            .map((message: any) => ({
              message_id: String(message.id),
              role: String(message.role ?? 'SYSTEM') as 'SYSTEM' | 'USER' | 'ASSISTANT',
              created_at: String(message.created_at ?? new Date().toISOString()),
              content: withCardNote(conversationMessageTextForAi(message), cardNotesRange.get(String(message.id))),
              provenance_ref: String(message.provenance_ref ?? ''),
              message_type: typeof message.message_type === 'string' ? message.message_type : 'OTHER',
            }))
          : [],
        // As of the question (like the messages): a retry gets the same context and reuses the stored AI result.
        already_suggested_follow_ups: collectAlreadySuggestedFollowUps(Array.isArray(conversation.messages)
          ? conversation.messages.filter((message: any) => new Date(String(message.created_at ?? requestAtIso)).getTime() <= requestAt.getTime())
          : []),
        needs_title: conversationNeedsAiTitle(conversation),
      },
      current_state_snapshot: currentState
        ? {
            as_of: String(currentState.as_of ?? new Date().toISOString()),
            current_glucose: typeof currentState.glucose?.value === 'number' ? Number(currentState.glucose.value) : 'UNKNOWN' as const,
            trend: typeof currentState.glucose?.trend === 'string' ? String(currentState.glucose.trend) : 'UNKNOWN' as const,
            iob: typeof currentState.iob?.value === 'number' ? Number(currentState.iob.value) : 'UNKNOWN' as const,
            cob: typeof currentState.cob?.value === 'number' ? Number(currentState.cob.value) : 'UNKNOWN' as const,
            age_minutes: Number.isFinite(Date.parse(String(currentState.as_of)))
              ? Math.max(0, Math.round((requestAt.getTime() - Date.parse(String(currentState.as_of))) / 60_000))
              : null,
          }
        : null,
      therapy_now: await this.loadTherapyNow(patientId, requestAtIso),
      // Temporary targets, overrides, site / sensor changes, notes… of the analysed period (therapy-context-events.v1).
      therapy_context_events: await this.loadTherapyContextEvents(patientId, rangeStartIso, rangeEndIso, therapyNowTimeZone),
      therapy_context: therapyContext,
      therapy_profile: therapyProfile,
      daily_insulin_totals: dailyInsulinTotals,
      analytical_evidence: {
        selection: { event_limit: eventLimit, events_selected: events.length, truncated: selectionTruncated, ...(selectedFrom ? { selected_from: selectedFrom } : {}) },
        glucose_events: glucoseEvents,
        insulin_treatment_events: insulinTreatmentEvents,
        meal_events: mealEvents,
        ...(virtualCarbEvents.length > 0 ? { virtual_correction_carb_events: virtualCarbEvents } : {}),
        ...(fatProteinUnitCarbEvents.length > 0 ? { fat_protein_unit_carb_events: fatProteinUnitCarbEvents } : {}),
        activity_events: activityEvents,
        hypo_episodes: hypoEpisodes.map((episode) => ({
          episode_id: String(episode.id ?? ''),
          state: String(episode.state ?? ''),
          severity: String(episode.severity ?? ''),
          started_at: String(episode.started_at ?? ''),
          ended_at: episode.ended_at ? String(episode.ended_at) : null,
          trigger_id: episode.trigger_id ? String(episode.trigger_id) : null,
        })),
        range_event_facts: rangeFacts.map((fact) => ({
          fact_id: String(fact.id ?? ''),
          fact_key: String(fact.fact_key ?? ''),
          fact_name: String(fact.fact_name ?? ''),
          value: fact.value,
          value_type: String(fact.value_type ?? ''),
          knowledge_status: String(fact.knowledge_status ?? ''),
          source_ref: String(fact.source_ref ?? ''),
          source_event_id: fact.source_event_id ? String(fact.source_event_id) : null,
          source_conversation_id: fact.source_conversation_id ? String(fact.source_conversation_id) : null,
          recorded_at: String(fact.recorded_at ?? ''),
          created_at: String(fact.created_at ?? ''),
        })),
        // Only present when the new meal history has meals here, so contexts without them are unchanged.
        ...(mealRecords ? { meal_records: mealRecords } : {}),
        ...(rescueAlert ? { rescue_carb_alert: rescueAlertForAi(rescueAlert) } : {}),
        ...(wbtChat ? { meal_wbt: mealWbtForAi(wbtChat.context, wbtChat.current) } : {}),
        summaries: {
          total_events: eventProjection.length,
          glucose_count: glucoseEvents.length,
          insulin_treatment_count: insulinTreatmentEvents.length,
          meal_count: mealEvents.length,
          activity_count: activityEvents.length,
          hypo_episode_count: hypoEpisodes.length,
          glucose_min: glucoseMin,
          glucose_max: glucoseMax,
          glucose_avg: glucoseAvg,
          glucose_time_in_range: glucoseTimeInRange,
          ...(glucoseWholeRange ? { glucose_whole_range: glucoseWholeRange } : {}),
          ...(hypoEpisodesTotal > hypoEpisodes.length ? { hypo_episodes_total: hypoEpisodesTotal } : {}),
          ...(rangeFactsTotal > rangeFacts.length ? { range_event_facts_total: rangeFactsTotal } : {}),
          missing_sections: missingSections,
        },
      },
      current_meal_reference: anchoredMeal.reference,
      provenance: {
        source_refs: sourceRefs,
        selection_policy_version: 'conversation-time-range-context-selection.v1',
      },
    };

    // Stable across job retries (see buildContextPackageIdentityHash): a retry reuses a succeeded AI execution.
    const contextHash = buildContextPackageIdentityHash(analysisContextBase as unknown as Record<string, unknown>);
    const analysisContext: TimeRangeAnalysisContextRecord = {
      ...analysisContextBase,
      content_hash: contextHash,
    };

    const persistedPackage = await this.repository.insertContextPackage({
      patientId,
      jobId,
      packageVersion: analysisContext.context_package_version,
      contentHash: analysisContext.content_hash,
      payload: {
        capability: 'ANALYSIS_REQUEST',
        range: analysisContext.analysis_request_input,
        selection_policy_version: analysisContext.provenance.selection_policy_version,
        evidence_sections: {
          glucose_events: analysisContext.analytical_evidence.glucose_events.length,
          insulin_treatment_events: analysisContext.analytical_evidence.insulin_treatment_events.length,
          meal_events: analysisContext.analytical_evidence.meal_events.length,
          activity_events: analysisContext.analytical_evidence.activity_events.length,
          hypo_episodes: analysisContext.analytical_evidence.hypo_episodes.length,
          range_event_facts: analysisContext.analytical_evidence.range_event_facts.length,
        },
        source_refs: analysisContext.provenance.source_refs.slice(0, 500),
        context_package_id: analysisContext.context_package_id,
        context_package_version: analysisContext.context_package_version,
        content_hash: analysisContext.content_hash,
      },
      status: 'COMPLETE',
    });

    const aiTask = createConversationTimeRangeAnalysisTask({
      task_id: `${jobId}:${conversationId}:${userMessageId}:${rangeIdentity}`,
      context_package_id: analysisContext.context_package_id,
      context_package_version: analysisContext.context_package_version,
      context_package_hash: analysisContext.content_hash,
      correlation_id: conversationId,
      created_at: new Date().toISOString(),
      patient_id: patientId,
    });
    const taskIdentity = buildAiTaskIdentity(aiTask);

    const repositoryWithAiExecutions = this.repository as unknown as {
      getAiExecutionByTaskIdentity?: (taskIdentity: string) => Promise<Record<string, unknown> | null>;
      markAiExecutionRunning?: (args: { task: typeof aiTask; taskIdentity: string; inputHash: string; nowIso: string }) => Promise<void>;
      markAiExecutionSucceeded?: (args: { taskIdentity: string; result: Record<string, unknown>; nowIso: string }) => Promise<void>;
      markAiExecutionFailed?: (args: { taskIdentity: string; error: Record<string, unknown>; nowIso: string }) => Promise<void>;
      completeEvidenceSession?: (args: { taskIdentity: string; patientId: string; completedAt: string }) => Promise<void>;
      failEvidenceSession?: (args: { taskIdentity: string; patientId: string; failedAt: string; failure: Record<string, unknown> }) => Promise<void>;
    };

    const existingExecution = repositoryWithAiExecutions.getAiExecutionByTaskIdentity
      ? await repositoryWithAiExecutions.getAiExecutionByTaskIdentity(taskIdentity)
      : null;

    let aiExecution: Record<string, unknown>;
    let mealSession: MealActionsToolSession | null = null;
    if (existingExecution?.status === 'succeeded' && existingExecution.normalized_result) {
      aiExecution = existingExecution.normalized_result as Record<string, unknown>;
    } else {
      if (repositoryWithAiExecutions.markAiExecutionRunning) {
        await repositoryWithAiExecutions.markAiExecutionRunning({
          task: aiTask,
          taskIdentity,
          inputHash: buildAiInputHash({ context_package: analysisContext }),
          nowIso: new Date().toISOString(),
        });
      }

      try {
        const timeoutCandidate = typeof (this.configService as { get?: (key: string) => unknown }).get === 'function'
          ? (this.configService as { get: (key: string) => unknown }).get('OPENAI_TIMEOUT_MS')
          : undefined;
        const timeoutMs = Number(timeoutCandidate ?? 15_000);
        const attemptObserver = this.createAiAttemptObserver(repositoryWithAiExecutions);
        const processingObserver = this.createAiProcessingObserver(repositoryWithAiExecutions, taskIdentity);
        const evidenceSessionObserver = this.createEvidenceSessionObserver(repositoryWithAiExecutions);

        const aiInvokeInput = {
          task: aiTask,
          context_package: analysisContext,
          timeout_ms: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 15_000,
        } as {
          task: typeof aiTask;
          context_package: typeof analysisContext;
          timeout_ms: number;
          attempt_observer?: typeof attemptObserver;
          processing_observer?: typeof processingObserver;
          evidence_session_observer?: typeof evidenceSessionObserver;
        };
        Object.defineProperty(aiInvokeInput, 'attempt_observer', {
          value: attemptObserver,
          enumerable: false,
          configurable: true,
        });
        Object.defineProperty(aiInvokeInput, 'processing_observer', {
          value: processingObserver,
          enumerable: false,
          configurable: true,
        });
        Object.defineProperty(aiInvokeInput, 'evidence_session_observer', {
          value: evidenceSessionObserver,
          enumerable: false,
          configurable: true,
        });
        mealSession = await this.attachConversationAiExtras(aiInvokeInput, patientId, conversation, userMessageId, rescueAlert, wbtChat);

        const executed = await this.executeCancellableAi(aiInvokeInput, conversationId, userMessageId, patientId);
        aiExecution = executed as unknown as Record<string, unknown>;
        if (repositoryWithAiExecutions.markAiExecutionSucceeded) {
          await repositoryWithAiExecutions.markAiExecutionSucceeded({
            taskIdentity,
            result: aiExecution,
            nowIso: new Date().toISOString(),
          });
        }
        if (repositoryWithAiExecutions.completeEvidenceSession) {
          await repositoryWithAiExecutions.completeEvidenceSession({
            taskIdentity,
            patientId,
            completedAt: new Date().toISOString(),
          });
        }
      } catch (error) {
        if (isCancelledAiExecution(error)) {
          await this.finalizeCancelledAnalysisJob(jobId, leaseToken, taskIdentity);
          return;
        }
        if (repositoryWithAiExecutions.markAiExecutionFailed) {
          await repositoryWithAiExecutions.markAiExecutionFailed({
            taskIdentity,
            error: {
              error: error instanceof Error ? error.message : String(error),
              retryable: isRetryableError(error),
            },
            nowIso: new Date().toISOString(),
          });
        }
        if (repositoryWithAiExecutions.failEvidenceSession) {
          await repositoryWithAiExecutions.failEvidenceSession({
            taskIdentity,
            patientId,
            failedAt: new Date().toISOString(),
            failure: {
              error: error instanceof Error ? error.message : String(error),
              retryable: isRetryableError(error),
            },
          });
        }

        throw error;
      }
    }

    // Last point where a cancellation wins: after this claim the result is saved and cancel reports ALREADY_COMPLETED.
    if (!(await this.claimAnalysisCompletion(conversationId, userMessageId))) {
      await this.finalizeCancelledAnalysisJob(jobId, leaseToken, taskIdentity);
      return;
    }

    const aiExecutionTyped = aiExecution as {
      metadata?: {
        provider?: string;
        model?: string;
        model_fingerprint?: string;
        knowledge_sources?: unknown;
      };
      result: {
        assistant_message?: string;
        follow_up_candidates?: unknown;
        conversation_title?: unknown;
        answer_options?: unknown;
      };
    };
    const mealAnswer = await this.mealActionAnswerState(mealSession, patientId, userMessageId);
    const answerText = String(aiExecutionTyped.result?.assistant_message ?? '').trim();
    if (!answerText) {
      throw new Error('INVALID_TIME_RANGE_ANALYSIS_OUTPUT');
    }
    // A meal change is saved only from its card, a dose is given only from its card: an answer that says otherwise gets
    // one plain sentence.
    const bolusAnswer = await this.bolusAnswerState(patientId, userMessageId);
    const answerOptions = await this.answerOptionsFor(aiExecutionTyped.result?.answer_options, bolusAnswer, userMessageId, patientId);
    // Options the server dropped (fewer than two with cards): the text must not point to a picker that is not there.
    // A free-text dose (therapy-suggestion-policy) is checked against the reading it was written from: one sentence when
    // that reading is missing, stale, low or falling fast.
    const snapshot = analysisContextBase.current_state_snapshot;
    const proposalGlucose = snapshot
      ? { glucose_mgdl: typeof snapshot.current_glucose === 'number' ? snapshot.current_glucose : null, age_minutes: snapshot.age_minutes ?? null, trend: snapshot.trend === 'UNKNOWN' ? null : snapshot.trend }
      : null;
    const mealChecked = finalizeMealActionAnswer(answerText, mealAnswer);
    const therapyChecked = finalizeTherapyProposal(mealChecked.text, proposalGlucose, proposesDose);
    // A WBT card counts as a card: no "przygotuj bolus" note, and a "given" claim is corrected also without bolus cards.
    const wbtUsed = this.wbtSessions.get(userMessageId)?.used === true;
    this.wbtSessions.delete(userMessageId);
    const bolusChecked = finalizeBolusAnswer(therapyChecked.text, wbtUsed ? { ...(bolusAnswer ?? { proposed: [] }), used: true } : bolusAnswer);
    const assistantMessage = withoutOptionPointer(bolusChecked.text, answerOptions.length > 0);
    const correctionFlag = serverCorrectionFlag([
      mealChecked.corrected && 'MEAL_WRITE_CLAIM',
      therapyChecked.kind,
      bolusChecked.kind,
      assistantMessage !== bolusChecked.text && 'OPTION_POINTER_REMOVED',
      modelOfferedOptions(aiExecutionTyped.result?.answer_options) && answerOptions.length === 0 && 'OPTIONS_DROPPED',
    ]);

    // The best three of the answer's own candidates, never a repeat of a question asked or offered before; none under
    // the option picker.
    const { suggestions: suggestedFollowUps, hot: hotSuggestedFollowUp } = withoutOptionChoices(selectFollowUpSuggestions(
      aiExecutionTyped.result?.follow_up_candidates,
      collectFollowUpExclusions(conversation.messages),
      assistantMessage,
    ), answerOptions.length > 0);

    await this.saveAiConversationTitle(conversation, aiExecutionTyped.result?.conversation_title);

    const persistedExecution = await this.repository.getAiExecutionByTaskIdentity(taskIdentity);
    const aiExecutionId = persistedExecution?.id ? String(persistedExecution.id) : null;

    // A retry after the analysis was saved (e.g. the message write failed) reuses it: one analysis and one
    // recommendation per answer (a NULL episode never conflicts in the analyses upsert).
    const linkedAnalysisId = persistedExecution?.analysis_id ? String(persistedExecution.analysis_id) : null;
    const linkedAnalysis = linkedAnalysisId ? await this.repository.getAnalysis(patientId, linkedAnalysisId) : null;
    const analysis = linkedAnalysis ?? await this.repository.insertAnalysis({
      patientId,
      episodeId: null,
      triggerId: null,
      taskType: 'CONVERSATION_TIME_RANGE_ANALYSIS',
      status: 'INSUFFICIENT_DATA',
      facts: [],
      unknowns: [],
      calculations: [],
      hypotheses: [],
      assumptions: [],
      uncertainty: {
        material_unresolved_blocker: true,
      },
      question: null,
      proposal: null,
      rationale: assistantMessage,
      analysisVersion: 'analysis.v1.1',
      contextPackageId: String(persistedPackage.id),
      contextPackageVersion: analysisContext.context_package_version,
      contextPackageHash: analysisContext.content_hash,
      inputHash: typeof (aiExecution as { input_hash?: unknown }).input_hash === 'string'
        ? String((aiExecution as { input_hash: string }).input_hash)
        : null,
      promptVersion: aiTask.prompt_version,
      modelFingerprint: aiExecutionTyped.metadata?.model_fingerprint ?? null,
    });

    if (!linkedAnalysis) {
      await this.repository.linkAiExecutionToAnalysis({
        taskIdentity,
        analysisId: String(analysis.id),
        nowIso: new Date().toISOString(),
      });
    }

    // Upserted per analysis: a retry gets the same recommendation back.
    const recommendationPersisted = await this.persistRecommendationForAnalysis({
      patientId,
      analysisId: String(analysis.id),
      episodeId: null,
      triggerId: null,
      contextPackageId: String(persistedPackage.id),
      contextPackageHash: analysisContext.content_hash,
      historicalSourceRefs: new Set<string>(),
      aiExecutionRef: aiExecutionId,
      sourceVersions: {
        triggerRuleVersion: 'CONVERSATION_TIME_RANGE_ANALYSIS',
        contextPackageVersion: analysisContext.context_package_version,
      },
    });

    await this.repository.linkConversation({
      conversationId,
      analysisId: String(analysis.id),
      recommendationId: String(recommendationPersisted.recommendation.id),
    });

    const noDataFlag = await this.checkNoDataAnswer({
      patientId,
      answer: assistantMessage,
      windowBasis: 'ANALYSED_RANGE',
      windowFrom: rangeStartIso,
      windowTo: rangeEndIso,
    });

    const insertedAssistant = await this.repository.insertMessage({
      conversationId,
      patientId,
      role: 'ASSISTANT',
      messageType: 'ASSISTANT_MESSAGE',
      content: assistantMessage,
      questionId: null,
      answerType: null,
      answerText: null,
      answerValue: null,
      provenanceRef: aiExecutionId ? `ai-execution/${aiExecutionId}` : `ai-task/${taskIdentity}`,
      metadata: {
        source: 'time-range-analysis-ai',
        // Best first: the hot one, when there is one, is on top.
        suggested_follow_ups: suggestedFollowUps,
        ...(hotSuggestedFollowUp ? { hot_suggested_follow_up: hotSuggestedFollowUp } : {}),
        ...(answerOptions.length > 0 ? { answer_options: answerOptions } : {}),
        knowledge_sources: sanitizeKnowledgeSources(aiExecutionTyped.metadata?.knowledge_sources),
        decision: 'ANALYSIS_REQUEST',
        user_message_id: userMessageId,
        ...(mealAnswer.used ? { meal_assistant: true } : {}),
        ai_task_type: aiTask.task_type,
        ai_task_version: aiTask.task_version,
        ai_task_identity: taskIdentity,
        ai_execution_id: aiExecutionId,
        range_type: rangeType,
        range_start: rangeStartIso,
        range_end: rangeEndIso,
        timezone,
        provider: aiExecutionTyped.metadata?.provider ?? null,
        model: aiExecutionTyped.metadata?.model ?? null,
        model_fingerprint: aiExecutionTyped.metadata?.model_fingerprint ?? null,
        ...(noDataFlag || correctionFlag ? { anomaly_flags: [noDataFlag, correctionFlag].filter(Boolean) } : {}),
      },
      idempotencyKey: assistantIdempotencyKey,
    });
    // The answer's cards and reminders now belong to a stored answer.
    this.answerExtrasPending = null;
    this.logSuspiciousNoDataAnswer({ flag: noDataFlag, message: insertedAssistant, conversationId, userMessageId, taskType: aiTask.task_type, rangeType });
    this.logServerCorrection({ flag: correctionFlag, message: insertedAssistant, conversationId, userMessageId, taskType: aiTask.task_type });

    await this.repository.finalizeJobSuccess(jobId, leaseToken, new Date().toISOString());
  }

  /**
   * Glucose aggregates over every reading of the range (the event selection of a long range is cut), with TIR and its
   * CGM coverage up to the question. Null when the query is unavailable or fails: the model then reads the aggregates
   * of the selected part, which say so.
   */
  private async loadWholeRangeGlucose(patientId: string, startAtIso: string, endAtIso: string, coverageEndIso: string): Promise<NonNullable<TimeRangeAnalysisContextRecord['analytical_evidence']['summaries']['glucose_whole_range']> | null> {
    const lookup = (this.repository as { getGlucoseAggregatesByRange?: PostgresGlucoMindRepository['getGlucoseAggregatesByRange'] }).getGlucoseAggregatesByRange;
    if (typeof lookup !== 'function') return null;
    try {
      const aggregates = await lookup.call(this.repository, { patientId, startAtIso, endAtIso });
      return {
        readings_count: aggregates.count,
        min: aggregates.min,
        max: aggregates.max,
        avg: aggregates.avg === null ? null : Number(aggregates.avg.toFixed(2)),
        time_in_range: computeGlucoseTimeInRangeFromBands(aggregates.bands, { from: startAtIso, to: coverageEndIso }),
      };
    } catch {
      return null;
    }
  }

  /**
   * Source meal of each WBT entry, as the meal calendar shows it (linkFatProteinUnitEntriesToMeals). Fails open: when
   * meal history is unavailable or the lookup fails, the entries simply carry no linked meal.
   */
  /**
   * Daily insulin totals of the range from its own bolus/SMB/temp basal query (the shared event selection is cut by its
   * row limit on long ranges), starting a few hours early so a temp basal running at the range start is seen. Falls back
   * to the shared selection when the query is unavailable or fails; null when the range has no local days.
   */
  private async buildDailyInsulinTotalsForRange(args: {
    patientId: string;
    rangeStartIso: string;
    rangeEndIso: string;
    timezone: string;
    therapyProfile: NonNullable<TimeRangeAnalysisContextRecord['therapy_profile']>;
    selectedEvents: Array<Record<string, unknown>>;
    selectionTruncated: boolean;
  }): Promise<DailyInsulinTotals | null> {
    const days = localDayWindows(args.rangeStartIso, args.rangeEndIso, args.timezone);
    if (days.length === 0) return null;
    const fromSelection = (): { events: InsulinDeliveryEvent[]; selectedFrom: string | null } => {
      const events = args.selectedEvents
        .filter((event) => ['BOLUS', 'SMB', 'TEMP_BASAL'].includes(String(event.type ?? '')))
        .map((event) => ({
          event_id: String(event.id ?? ''),
          type: String(event.type ?? ''),
          occurred_at: toIsoTimestamp(event.occurred_at) ?? '',
          payload: (event.payload ?? {}) as Record<string, unknown>,
        }));
      // A cut selection keeps the most recent events (oldest first): what precedes its first event was not selected.
      const first = args.selectedEvents[0];
      return { events, selectedFrom: args.selectionTruncated && first ? toIsoTimestamp(first.occurred_at) : null };
    };
    const lookup = (this.repository as { listInsulinDeliveryEventsByRange?: PostgresGlucoMindRepository['listInsulinDeliveryEventsByRange'] }).listInsulinDeliveryEventsByRange;
    let source = fromSelection();
    if (typeof lookup === 'function') {
      try {
        const events = await lookup.call(this.repository, {
          patientId: args.patientId,
          startAtIso: new Date(Date.parse(args.rangeStartIso) - 6 * 60 * 60 * 1000).toISOString(),
          endAtIso: args.rangeEndIso,
        });
        source = { events, selectedFrom: null };
      } catch {
        // Keep the shared selection.
      }
    }
    const profileTimezone = args.therapyProfile.timezone && isValidTimeZone(args.therapyProfile.timezone) ? args.therapyProfile.timezone : args.timezone;
    return buildDailyInsulinTotals({
      days,
      events: source.events,
      basalSchedule: args.therapyProfile.status === 'KNOWN' ? args.therapyProfile.basal_u_per_h : null,
      profileTimezone,
      selectedFrom: source.selectedFrom,
    });
  }

  private async linkFatProteinUnitEntriesToMeals(patientId: string, wbtEvents: Array<{ event_id: string; occurred_at: string }>): Promise<Map<string, FatProteinUnitLinkedMeal | null>> {
    const records = this.mealRecordRepository;
    const times = wbtEvents.map((event) => Date.parse(event.occurred_at)).filter(Number.isFinite);
    if (!records || times.length === 0) return new Map();
    try {
      const rows = await this.repository.listCarbEntriesBetween(
        patientId,
        new Date(Math.min(...times) - FAT_PROTEIN_UNIT_LOOKBACK_HOURS * 3_600_000).toISOString(),
        new Date(Math.max(...times) + 1).toISOString(),
      );
      const positive = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null);
      // A WBT entry answered "WBT do: <meal>" goes to that meal, not to the one with the most WBT.
      const assignments = this.loopActionRepository
        ? await this.loopActionRepository.listEventAssignments(patientId, rows.filter((row) => row.kind === 'FAT_PROTEIN_UNITS').map((row) => row.event_id)).catch(() => new Map())
        : new Map();
      const entries = await Promise.all(rows.map(async (row) => {
        const raw = ((row.payload ?? {}).raw_payload ?? {}) as Record<string, unknown>;
        const identity = row.meal_record_id && row.is_meal_anchor && row.kind === 'MEAL'
          ? await records.findMealIdentityById(patientId, row.meal_record_id)
          : null;
        return {
          event_id: row.event_id,
          occurred_at: toIsoTimestamp(row.occurred_at),
          kind: row.kind,
          carbs_g: typeof row.payload?.carbs === 'number' ? row.payload.carbs : null,
          protein_g: positive(raw.protein),
          fat_g: positive(raw.fat),
          part_of_meal_id: row.meal_record_id && !row.is_meal_anchor ? row.meal_record_id : null,
          meal_record: identity ? await records.getMealRecord(patientId, identity) : null,
          meal_record_id: identity ? row.meal_record_id : null,
          assigned_meal_id: assignments.get(row.event_id)?.purpose === 'WBT' ? assignments.get(row.event_id)?.meal_record_id ?? null : null,
        };
      }));
      return linkFatProteinUnitEntriesToMeals(entries);
    } catch (error) {
      this.jobLogger.warn(JSON.stringify({ event: 'wbt_meal_link_failed', patient_id: patientId, error: error instanceof Error ? error.message : String(error) }));
      return new Map();
    }
  }

  private async loadMealRecordsForAiContext(patientId: string, fromIso: string, toIso: string): Promise<MealContextSelection | null> {
    if (!this.mealRecordRepository) {
      return null;
    }
    const records = await this.mealRecordRepository.listMealRecordsStartedBetween(patientId, fromIso, toIso);
    return records.length > 0 ? selectMealsForAiContext(records) : null;
  }

  private async handleMealChatReply(jobId: string, leaseToken: string, payload: Record<string, unknown>): Promise<void> {
    if (!this.mealRecordRepository || !this.mealChatRepository) {
      throw new Error('MEAL_HISTORY_SERVICES_UNAVAILABLE');
    }
    const records = this.mealRecordRepository;
    const chat = this.mealChatRepository;
    const photos = this.mealPhotoStorage;
    // No glucose sync here: the meal chat reads no glucose (only the meal, its photos and DiabCalc).
    const draft = this.startReplyDraft('MEAL_CHAT', String(payload.meal_record_id ?? ''), String(payload.patient_id ?? ''), String(payload.user_message_id ?? ''));
    await runMealChatReplyJob({
      findMealIdentityById: (patientId, mealRecordId) => records.findMealIdentityById(patientId, mealRecordId),
      getMealRecord: (patientId, identity) => records.getMealRecord(patientId, identity),
      recordAiProposal: (patientId, identity, proposal) => records.recordAiProposal(patientId, identity, proposal),
      listMessages: (patientId, mealRecordId) => chat.listMessages(patientId, mealRecordId),
      hasReply: (mealRecordId, userMessageId) => chat.hasReply(mealRecordId, userMessageId),
      insertAssistantMessage: (args) => chat.insertAssistantMessage(args),
      readPhoto: async (patientId, photoId) => (photos ? photos.read(patientId, photoId).catch(() => null) : null),
      patientBirthYear: (patientId) => this.patientBirthYear(patientId),
      patientTimeZone: (patientId) => this.patientTimeZone(patientId),
      userAiPreferences: (userId) => this.userAiPreferences(userId),
      responder: (this.mealChatResponder ??= this.createMealChatResponder()),
      ...(draft ? { onReplyDraft: (text: string) => draft.update(text) } : {}),
    }, payload);
    await this.repository.finalizeJobSuccess(jobId, leaseToken, new Date().toISOString());
  }

  /** The system running the patient's loop (loop-system.ts); UNKNOWN without the database. */
  private async patientLoopSystem(patientId: string): Promise<LoopSystem> {
    return this.bolusDashboardRepository ? patientLoopSystem(this.bolusDashboardRepository, patientId) : UNKNOWN_LOOP_SYSTEM;
  }

  /**
   * Insulin given by hand since a meal's bolus, for a reminder's push (bolus-reminders.v1). Null when it cannot be read:
   * the push then says nothing about it rather than "nothing given".
   */
  private async givenSinceMealFor(
    patientId: string,
    mealStartedAt: string,
    now: Date,
    timeZone: string,
    select?: (actions: Awaited<ReturnType<PostgresLoopActionRepository['listActionsBetween']>>) => Awaited<ReturnType<PostgresLoopActionRepository['listActionsBetween']>>,
  ): Promise<GivenSinceMeal | null> {
    const actions = this.loopActionRepository;
    const pool = (this.repository as unknown as { pool?: unknown }).pool;
    if (!actions || !pool) return null;
    try {
      const all = await actions.listActionsBetween(patientId, mealStartedAt, new Date(now.getTime() + 60_000).toISOString());
      const list = select ? select(all) : all;
      this.mealJournalRepository ??= new PostgresMealJournalRepository(pool as never);
      const [senders, caregiverCount, loopSystem] = await Promise.all([
        this.mealJournalRepository.sendersForActions(patientId, list.map((action) => action.id)),
        this.mealJournalRepository.caregiverCount(patientId).catch(() => 1),
        this.patientLoopSystem(patientId),
      ]);
      return givenSinceMeal({ mealStartedAt, now, timeZone, actions: list, senders, caregiverCount, loopName: loopSystemNames(loopSystem.kind).nominative });
    } catch (error) {
      this.jobLogger.warn(JSON.stringify({ event: 'given_since_meal_failed', patient_id: patientId, error_code: safeJobErrorCode(error) }));
      return null;
    }
  }

  /** Loop actions that already answered one of the patient's meal reminders (migration 082); empty before it. */
  private async answeredDoseActionIds(patientId: string): Promise<Set<string>> {
    const pool = (this.repository as unknown as { pool?: unknown }).pool;
    if (!pool) return new Set();
    this.mealJournalRepository ??= new PostgresMealJournalRepository(pool as never);
    // Optional call: a store without it (before migration 082) answers nothing.
    return (await this.mealJournalRepository.answeredDoseActionIds?.(patientId).catch(() => null)) ?? new Set<string>();
  }

  /** The second dose's title from the meal's own entry and its carbs now; null when they cannot be read. */
  private async secondDoseTitleFor(patientId: string, mealRecordId: string): Promise<{ title: string; lines: string[] } | null> {
    const records = this.mealRecordRepository;
    if (!records || !this.loopActionRepository) return null;
    const [identity, actions] = await Promise.all([
      records.findMealIdentityById(patientId, mealRecordId),
      this.loopActionRepository.listActionsForMeals(patientId, [mealRecordId]),
    ]);
    const record = identity ? await records.getMealRecord(patientId, identity).catch(() => null) : null;
    const entry = actions.filter((action) => action.purpose === 'NEW_MEAL').sort((a, b) => Date.parse(a.started_at) - Date.parse(b.started_at))[0] ?? null;
    return secondDoseTitleAtSend({ entry, meal_carbs_g: record?.macros.carbs.grams ?? null, time_zone: resolveHomeTimeZone() });
  }

  private async givenSinceSecondDoseMeal(patientId: string, mealRecordId: string, now: Date): Promise<GivenSinceMeal | null> {
    const records = this.mealRecordRepository;
    if (!records) return null;
    const identity = await records.findMealIdentityById(patientId, mealRecordId).catch(() => null);
    const record = identity ? await records.getMealRecord(patientId, identity).catch(() => null) : null;
    return record ? this.givenSinceMealFor(patientId, record.started_at, now, resolveHomeTimeZone()) : null;
  }

  /**
   * Reminder pushes go through the outbox (push-outbox.v1, audit 2026-10-26): a push that failed for a passing reason,
   * or found no phone, is tried again until it expires. Without the database (unit tests) it sends once.
   */
  private get pushOutbox(): PushOutbox {
    if (!this.pushOutboxInstance) {
      const pool = (this.repository as unknown as { pool?: unknown }).pool;
      this.pushOutboxInstance = new PushOutbox({
        store: pool ? new PostgresPushOutboxRepository(pool as never) : null,
        devices: {
          list: (patientId) => this.repository.listActivePatientDevices(patientId, 'ios'),
          deactivate: (pushToken) => this.repository.deactivatePatientDevicesByPushToken('ios', pushToken),
        },
        push: this.pushNotificationService,
        log: (event) => this.jobLogger.log(JSON.stringify(event)),
      });
    }
    return this.pushOutboxInstance;
  }

  /**
   * A caregiver gave the dose a meal's reminder asked for (owner 2026-10-26): the first dose sent from the app after a
   * second dose's or WBT reminder came goes to the other caregivers' phones, once per reminder ("Druga dawka podana ·
   * Ewa · 1,5 j na posiłek o 18:05"). A dose entered in Trio tells nobody (no caregiver to name). Never throws.
   */
  async processReminderDoseNews(nowIso = new Date().toISOString()): Promise<void> {
    const actions = this.loopActionRepository;
    const pool = (this.repository as unknown as { pool?: unknown }).pool;
    if (!actions || !pool || !this.mealRecordRepository || this.shuttingDown) return;
    this.mealJournalRepository ??= new PostgresMealJournalRepository(pool as never);
    const journal = this.mealJournalRepository;
    const now = new Date(nowIso);
    let reminders: Awaited<ReturnType<PostgresMealJournalRepository['remindersAwaitingDoseNews']>>;
    try {
      reminders = await journal.remindersAwaitingDoseNews(new Date(now.getTime() - DOSE_GIVEN_WINDOW_MINUTES * 60_000).toISOString());
    } catch (error) {
      // Migration 074 not applied yet.
      this.jobLogger.warn(JSON.stringify({ event: 'dose_given_news_unavailable', error_code: safeJobErrorCode(error) }));
      return;
    }
    const answered = new Map<string, Set<string>>();
    for (const reminder of reminders) {
      try {
        const list = await actions.listActionsBetween(reminder.patient_id, reminder.fired_at, new Date(now.getTime() + 60_000).toISOString());
        const senders = await journal.commandSendersForActions(reminder.patient_id, list.map((action) => action.id));
        const doses = list.flatMap((action) => {
          const sender = senders.get(action.id);
          return sender && (action.bolus_units ?? 0) > 0
            ? [{ action_id: action.id, at: action.started_at, insulin_u: action.bolus_units ?? 0, user_id: sender.user_id, name: sender.name, purpose: action.purpose, meal_record_id: action.meal_record_id, carbs_g: action.carbs_g }]
            : [];
        });
        // One dose answers one reminder (audit 2026-10-26): never both a meal's second dose and its WBT, or two meals'.
        const used = answered.get(reminder.patient_id) ?? await this.answeredDoseActionIds(reminder.patient_id);
        answered.set(reminder.patient_id, used);
        const dose = doseAnsweringReminder({ kind: reminder.kind, mealRecordId: reminder.meal_record_id, firedAt: reminder.fired_at, until: reminder.until, now, doses, used });
        if (!dose) continue;
        const identity = await this.mealRecordRepository.findMealIdentityById(reminder.patient_id, reminder.meal_record_id).catch(() => null);
        const record = identity ? await this.mealRecordRepository.getMealRecord(reminder.patient_id, identity).catch(() => null) : null;
        if (!record) continue;
        if (!(await journal.markDoseGiven(reminder, dose.at, dose.action_id ?? null))) continue;
        if (dose.action_id) used.add(dose.action_id);
        const { title, body } = doseGivenPushContent({ kind: reminder.kind, dose, mealStartedAt: record.started_at, timeZone: resolveHomeTimeZone() });
        // The other caregivers' phones only (a phone registered before migration 070 has no caregiver: skipped, it
        // may be the sender's).
        const reminderKey = reminder.kind === 'WBT' ? `wbt:${reminder.meal_record_id}` : reminder.reminder_id;
        const result = await this.pushOutbox.dispatch({
          dedupeKey: `dose-given:${reminderKey}`,
          patientId: reminder.patient_id,
          request: { kind: 'dose_given', input: { patientId: reminder.patient_id, mealId: reminder.meal_record_id, reminderKey, title, body } },
          excludeUserId: dose.user_id,
          ttlMinutes: REMINDER_PUSH_TTL_MINUTES,
          now,
        });
        this.jobLogger.log(JSON.stringify({ event: 'dose_given_push_sent', kind: reminder.kind, meal_record_id: reminder.meal_record_id, devices: result?.delivered ?? 0, retrying: result?.retrying ?? false }));
      } catch (error) {
        this.jobLogger.warn(JSON.stringify({ event: 'dose_given_news_failed', meal_record_id: reminder.meal_record_id, error_code: safeJobErrorCode(error) }));
      }
    }
  }

  /**
   * Sends the WBT insulin reminders that are due (2.5 h after the meal) to every active iOS device of the patient.
   * A reminder older than WBT_REMINDER_MAX_AGE_MINUTES is skipped (the worker was down); one whose meal already got
   * WBT carbs in the loop is skipped too. The reminder is marked SENT before its push (one send, whatever the number of
   * workers); a push that failed for a passing reason is tried again by the outbox (push-outbox.v1). Never throws.
   */
  async dispatchDueWbtReminders(nowIso = new Date().toISOString()): Promise<void> {
    const reminders = this.mealWbtRepository;
    if (!reminders || !this.mealRecordRepository || this.shuttingDown) return;
    try {
      const stale = await reminders.skipStaleReminders(nowIso, WBT_REMINDER_MAX_AGE_MINUTES);
      if (stale > 0) this.jobLogger.warn(JSON.stringify({ event: 'wbt_reminder_stale_skipped', reminders: stale }));
      for (const reminder of await reminders.listDueReminders(nowIso, WBT_REMINDER_MAX_AGE_MINUTES)) {
        const identity = await this.mealRecordRepository.findMealIdentityById(reminder.patient_id, reminder.meal_record_id);
        const record = identity ? await this.mealRecordRepository.getMealRecord(reminder.patient_id, identity).catch(() => null) : null;
        if (!record || record.status === 'CANCELLED' || (await this.mealWbtAlreadyLogged(reminder.patient_id, identity!, record.started_at, nowIso))) {
          await reminders.markReminder(reminder.patient_id, reminder.meal_record_id, 'SKIPPED');
          this.jobLogger.log(JSON.stringify({ event: 'wbt_reminder_skipped', meal_record_id: reminder.meal_record_id }));
          continue;
        }
        // A split bolus's second part still open: the WBT reminder waits for it (given: an hour after it), never two
        // insulin reminders for one meal at once. While it waits it stays due now, so the stale skip (a worker that was
        // down) never drops it unsent behind a part that is open for hours (audit 2026-10-26).
        const openPart = await this.plannedBolusRepository?.latestForMeal(reminder.patient_id, reminder.meal_record_id).catch(() => null);
        if (openPart && (openPart.status === 'SCHEDULED' || openPart.status === 'NOTIFIED')) {
          await reminders.postponeReminder(reminder.patient_id, reminder.meal_record_id, nowIso);
          continue;
        }
        // The same for a Bolus tab meal's second dose: not while it is to come, an hour after it was given, half an hour
        // after it came unanswered (audit 2026-10-26).
        const secondDoses = await this.careReminderRepository?.listForMeals?.(reminder.patient_id, [reminder.meal_record_id]).catch(() => []) ?? [];
        const hold = wbtWaitForSecondDose(secondDoses, { given_gap_minutes: SPLIT_BOLUS_POLICY.wbt_min_gap_minutes, unanswered_gap_minutes: WBT_AFTER_SECOND_DOSE_MINUTES });
        if (hold?.state === 'OPEN') {
          await reminders.postponeReminder(reminder.patient_id, reminder.meal_record_id, nowIso);
          continue;
        }
        if (hold?.state === 'NOT_BEFORE' && Date.parse(hold.at) > Date.parse(nowIso)) {
          await reminders.postponeReminder(reminder.patient_id, reminder.meal_record_id, hold.at);
          this.jobLogger.log(JSON.stringify({ event: 'wbt_reminder_after_second_dose', meal_record_id: reminder.meal_record_id, not_before: hold.at }));
          continue;
        }
        if (!(await reminders.markReminder(reminder.patient_id, reminder.meal_record_id, 'SENT'))) continue;
        const timeZone = resolveHomeTimeZone();
        const given = await this.givenSinceMealFor(reminder.patient_id, record.started_at, new Date(nowIso), timeZone);
        const body = wbtReminderBodyFor(
          { description: record.description, started_at: record.started_at, protein_g: record.macros.protein.grams, fat_g: record.macros.fat.grams },
          timeZone,
          given && given.doses.length > 0 ? given.line : null,
        );
        const result = await this.pushOutbox.dispatch({
          dedupeKey: `wbt-reminder:${reminder.meal_record_id}`,
          patientId: reminder.patient_id,
          request: { kind: 'wbt_reminder', input: { patientId: reminder.patient_id, mealId: reminder.meal_record_id, body } },
          ttlMinutes: REMINDER_PUSH_TTL_MINUTES,
          now: new Date(nowIso),
        });
        this.jobLogger.log(JSON.stringify({ event: 'wbt_reminder_sent', meal_record_id: reminder.meal_record_id, devices: result?.delivered ?? 0, retrying: result?.retrying ?? false }));
      }
    } catch (error) {
      this.jobLogger.warn(JSON.stringify({ event: 'wbt_reminder_dispatch_failed', error_code: safeJobErrorCode(error) }));
    }
  }

  /**
   * Turns new carb entries and manual boluses into loop actions, matches them to the app's remote commands, then runs
   * the planned later parts and the reminders. Nothing asks the caregiver what an entry was for. Never throws.
   */
  async processLoopActions(nowIso = new Date().toISOString()): Promise<void> {
    const repo = this.loopActionRepository;
    if (!repo || this.shuttingDown || this.loopActionsRunning) return;
    this.loopActionsRunning = true;
    try {
      // One patient's bad data must not stop the others, nor the reminders below (audit 2026-10-26).
      let patients: string[] = [];
      try {
        patients = await repo.listPatientsWithEpoch();
      } catch (error) {
        this.jobLogger.warn(JSON.stringify({ event: 'loop_actions_failed', error_code: safeJobErrorCode(error) }));
      }
      for (const patientId of patients) {
        try {
          const grouped = await repo.groupNewEvents(patientId);
          if (grouped > 0) this.jobLogger.log(JSON.stringify({ event: 'loop_actions_grouped', patient_id: patientId, events: grouped }));
        } catch (error) {
          this.jobLogger.warn(JSON.stringify({ event: 'loop_actions_group_failed', patient_id: patientId, error_code: safeJobErrorCode(error) }));
        }
      }
      // An action that is a caregiver's remote command gets its purpose (and meal) from the command.
      try {
        await this.remoteCommandReconciler?.run(nowIso);
      } catch (error) {
        this.jobLogger.warn(JSON.stringify({ event: 'remote_commands_failed', error_code: safeJobErrorCode(error) }));
      }
      // Each step never throws; the guard keeps it that way if one ever does.
      const step = async (name: string, run: () => Promise<void>) => {
        try {
          await run();
        } catch (error) {
          this.jobLogger.warn(JSON.stringify({ event: 'loop_actions_step_failed', step: name, error_code: safeJobErrorCode(error) }));
        }
      };
      // Planned second parts of split boluses: settled by a manual bolus, expired, or due now (after the reconciler,
      // which settles the ones sent from the app).
      await step('planned_boluses', () => this.processPlannedBoluses(nowIso));
      // Reminders the chat set (care-reminders.v1): due at a time, or on a glucose condition.
      await step('care_reminders', () => this.processCareReminders(nowIso));
      // A caregiver gave the dose a meal's reminder asked for: the other caregivers are told (after the reconciler,
      // which names who sent it).
      await step('dose_news', () => this.processReminderDoseNews(nowIso));
      // Reminder pushes that have not reached every phone yet (push-outbox.v1).
      await step('push_outbox', () => this.pushOutbox.retryDue(new Date(nowIso)));
    } finally {
      this.loopActionsRunning = false;
    }
  }

  /**
   * set_reminder for one answer (care-reminders.v1). Reminders an earlier failed attempt set for the same message are
   * cancelled first; without migration 063 the answer goes on without the tool.
   */
  private async createCareReminderSession(patientId: string, conversation: { messages?: unknown; id?: unknown }, userMessageId: string): Promise<CareReminderSession | null> {
    const store = this.careReminderRepository;
    if (!store) return null;
    const messages = Array.isArray(conversation.messages) ? (conversation.messages as Array<Record<string, unknown>>) : [];
    const userMessage = messages.find((message) => String(message.id) === userMessageId);
    try {
      await store.discardForUserMessage(patientId, userMessageId);
    } catch {
      return null;
    }
    const therapy = await this.repository.getTherapyProfileAt(patientId, new Date().toISOString()).catch(() => null);
    return new CareReminderSession({
      patientId,
      conversationId: String(conversation.id ?? ''),
      userMessageId,
      authorUserId: typeof userMessage?.author_user_id === 'string' ? userMessage.author_user_id : null,
      timeZone: therapy?.timezone ?? resolveHomeTimeZone(),
      store,
    });
  }

  /** Active reminders the chat set: pushed to every active iOS device once their time or glucose condition comes. Never throws. */
  async processCareReminders(nowIso = new Date().toISOString()): Promise<void> {
    const store = this.careReminderRepository;
    if (!store || this.shuttingDown) return;
    let reminders: Awaited<ReturnType<PostgresCareReminderRepository['listActive']>>;
    try {
      reminders = await store.listActive();
    } catch (error) {
      // Migration 063 not applied yet.
      this.jobLogger.warn(JSON.stringify({ event: 'care_reminders_unavailable', error_code: safeJobErrorCode(error) }));
      return;
    }
    const now = new Date(nowIso);
    let answered: Map<string, Set<string>> | null = null;
    for (const reminder of reminders) {
      try {
        if (now.getTime() < Date.parse(reminder.due_at)) continue;
        const secondDose = reminder.kind === 'SECOND_DOSE';
        // A reminder at a time the worker could not send in time (it was down): no late push, the bell says it was
        // missed (owner 2026-10-26). The Bolus tab's second dose lapses on its own rule.
        if (!secondDose && reminder.trigger === 'AT_TIME' && now.getTime() - Date.parse(reminder.due_at) > CARE_REMINDER_MAX_LATE_MINUTES * 60_000) {
          if (await store.markMissed(reminder.patient_id, reminder.id)) {
            await this.pushNotificationService.recordMissedCareReminder({ patientId: reminder.patient_id, conversationId: reminder.conversation_deleted ? null : reminder.conversation_id, mealId: reminder.meal_record_id ?? null, reminderId: reminder.id, note: reminder.note })
              .catch(() => undefined);
            this.jobLogger.warn(JSON.stringify({ event: 'care_reminder_missed', care_reminder_id: reminder.id, late_minutes: Math.round((now.getTime() - Date.parse(reminder.due_at)) / 60_000) }));
          }
          continue;
        }
        // The dose a second dose asks for was given before it came (the meal journal's rule): settled, no push.
        if (secondDose && reminder.meal_record_id && this.loopActionRepository) {
          answered ??= new Map();
          const used = answered.get(reminder.patient_id) ?? await this.answeredDoseActionIds(reminder.patient_id);
          answered.set(reminder.patient_id, used);
          const actions = await this.loopActionRepository.listActionsForMeals(reminder.patient_id, [reminder.meal_record_id]).catch(() => []);
          const given = secondDoseGivenBefore({ reminder, actions, used });
          if (given) {
            if (await store.markGivenBeforeDue(reminder.patient_id, reminder.id, given.started_at, given.id)) {
              used.add(given.id);
              this.jobLogger.log(JSON.stringify({ event: 'care_reminder_given_before_due', care_reminder_id: reminder.id }));
            }
            continue;
          }
        }
        const dashboards = this.bolusDashboardRepository;
        // A Bolus tab meal's second dose (bolus-reminders.v1) has its own rising rule, lapses quietly and its push
        // shows the current glucose (also at a time); the chat's reminders keep theirs.
        const [readings, loopStatus] = (reminder.trigger !== 'AT_TIME' || secondDose) && dashboards
          ? await Promise.all([
            dashboards.listGlucoseReadingsSince(reminder.patient_id, new Date(now.getTime() - 40 * 60_000).toISOString()),
            secondDose ? Promise.resolve(null) : dashboards.getLatestLoopStatus(reminder.patient_id),
          ])
          : [[], null];
        const readiness = secondDose
          ? secondDoseReadiness({ now, reminder, readings })
          : careReminderReadiness({ now, reminder, readings, loopStatus });
        if (readiness.state === 'WAIT') continue;
        if (readiness.state === 'EXPIRED') {
          if (await store.markExpired(reminder.patient_id, reminder.id)) this.jobLogger.log(JSON.stringify({ event: 'care_reminder_expired', care_reminder_id: reminder.id, trigger: reminder.trigger, kind: reminder.kind ?? null }));
          continue;
        }
        const glucose = secondDose ? currentGlucose(readings, now) : null;
        const firedGlucose = 'glucose_mgdl' in readiness ? readiness.glucose_mgdl : glucose?.value ?? null;
        if (!(await store.markFired(reminder.patient_id, reminder.id, readiness.state, firedGlucose))) continue;
        const given = secondDose && reminder.meal_record_id ? await this.givenSinceSecondDoseMeal(reminder.patient_id, reminder.meal_record_id, now) : null;
        // The second dose's title is made now: what the meal's bolus delivered and the meal's carbs now (owner 2026-10-26).
        const made = secondDose && reminder.meal_record_id ? await this.secondDoseTitleFor(reminder.patient_id, reminder.meal_record_id).catch(() => null) : null;
        const { title, body } = 'glucose_mgdl' in readiness ? careReminderPushContent(reminder, readiness) : secondDosePushContent(made?.title ?? reminder.note, glucose, given, made?.lines ?? []);
        const result = await this.pushOutbox.dispatch({
          dedupeKey: `care-reminder:${reminder.id}`,
          patientId: reminder.patient_id,
          // A deleted conversation can no longer be opened: the push opens the patient.
          request: { kind: 'care_reminder', input: { patientId: reminder.patient_id, conversationId: reminder.conversation_deleted ? null : reminder.conversation_id, mealId: reminder.meal_record_id ?? null, reminderId: reminder.id, title, body } },
          ttlMinutes: REMINDER_PUSH_TTL_MINUTES,
          now,
        });
        this.jobLogger.log(JSON.stringify({ event: 'care_reminder_sent', care_reminder_id: reminder.id, trigger: reminder.trigger, state: readiness.state, devices: result?.delivered ?? 0, retrying: result?.retrying ?? false }));
      } catch (error) {
        this.jobLogger.warn(JSON.stringify({ event: 'care_reminder_failed', care_reminder_id: reminder.id, error_code: safeJobErrorCode(error) }));
      }
    }
  }

  /**
   * Open planned second parts of split meal boluses (split-bolus.v1): a manual bolus the caregiver assigned to the meal
   * as an addition near the due time gives it; a cancelled meal cancels it; one nobody gave expires; a due one is sent
   * to every active iOS device once (NOTIFIED). Never throws.
   */
  async processPlannedBoluses(nowIso = new Date().toISOString()): Promise<void> {
    const store = this.plannedBolusRepository;
    const service = this.plannedBolusService;
    const records = this.mealRecordRepository;
    if (!store || !service || !records || !this.loopActionRepository || this.shuttingDown) return;
    let plans: Awaited<ReturnType<PostgresPlannedBolusRepository['listOpen']>>;
    try {
      plans = await store.listOpen();
    } catch (error) {
      // Migration 050 not applied yet.
      this.jobLogger.warn(JSON.stringify({ event: 'planned_boluses_unavailable', error_code: safeJobErrorCode(error) }));
      return;
    }
    const nowMs = Date.parse(nowIso);
    for (const plan of plans) {
      try {
        const dueMs = Date.parse(plan.due_at);
        // A manual bolus settles only the meal's earliest open part, and never with a bolus that is already a dose of
        // the meal (the card's own, a part sent from the app or given before): with several parts, part 1's bolus must
        // not mark part 2 given (its reminder would be lost).
        const earliestOpen = plans
          .filter((other) => other.patient_id === plan.patient_id && other.meal_record_id === plan.meal_record_id)
          .sort((a, b) => (a.part_index ?? 0) - (b.part_index ?? 0) || Date.parse(a.due_at) - Date.parse(b.due_at))[0];
        const identity = await records.findMealIdentityById(plan.patient_id, plan.meal_record_id);
        const record = identity ? await records.getMealRecord(plan.patient_id, identity).catch(() => null) : null;
        if (!record || record.status === 'CANCELLED') {
          await store.resolve(plan.patient_id, plan.id, 'CANCELLED');
          this.jobLogger.log(JSON.stringify({ event: 'planned_bolus_cancelled', planned_bolus_id: plan.id }));
          continue;
        }
        if (earliestOpen?.id === plan.id) {
          // Only insulin without carbs, from 30 min before the part is due until it expires (audit 2026-10-26): a dessert
          // with its own bolus added to the meal is not this part's dose, and its reminder must still come.
          const used = (await store.usedLoopActionIds?.(plan.patient_id, plan.meal_record_id)) ?? new Set<string>();
          const fromMs = dueMs - 30 * 60_000;
          const untilMs = plannedBolusExpiresAtMs(plan, record.started_at);
          const manual = (await this.loopActionRepository.listActionsForMeals(plan.patient_id, [plan.meal_record_id]))
            .find((action) => action.purpose === 'MEAL_ADDITION' && (action.bolus_units ?? 0) > 0 && !((action.carbs_g ?? 0) > 0) && !used.has(action.id)
              && Date.parse(action.started_at) >= fromMs && Date.parse(action.started_at) <= untilMs);
          if (manual && (await service.markGivenByLoopAction(plan, { id: manual.id, assigned_by_user_id: null, bolus_units: manual.bolus_units }))) continue;
        }
        if (await service.settleConfirmedUnmatched(plan, new Date(nowMs)).catch(() => false)) continue;
        if (nowMs > plannedBolusExpiresAtMs(plan, record.started_at)) {
          // A command may still be on its way: it settles the plan when it reaches the loop.
          if (await service.commandMaySettle(plan, new Date(nowMs)).catch(() => false)) continue;
          await store.resolve(plan.patient_id, plan.id, 'EXPIRED');
          this.jobLogger.log(JSON.stringify({ event: 'planned_bolus_expired', planned_bolus_id: plan.id }));
          continue;
        }
        if (plan.status !== 'SCHEDULED' || nowMs < dueMs) continue;
        // A glucose condition (glucose stopped falling, rising, above a threshold) is waited for until its waiting time
        // is over; then the reminder comes anyway, saying why (deferred-bolus.v1, later-plan.v1).
        let readiness: PlannedBolusReadiness | undefined;
        if (planTrigger(plan) !== 'AFTER_MINUTES') {
          const dashboards = this.bolusDashboardRepository;
          const [readings, loopStatus] = dashboards
            ? await Promise.all([
              dashboards.listGlucoseReadingsSince(plan.patient_id, new Date(nowMs - 40 * 60_000).toISOString()),
              dashboards.getLatestLoopStatus(plan.patient_id),
            ])
            : [[], null];
          const checked = plannedBolusReadinessFrom({ now: new Date(nowMs), plan, meal_started_at: record.started_at, readings, loopStatus });
          if (checked.state === 'WAIT') continue;
          readiness = checked;
          this.jobLogger.log(JSON.stringify({ event: 'deferred_bolus_ready', planned_bolus_id: plan.id, trigger: planTrigger(plan), state: checked.state, reason: checked.state === 'FORCED' ? checked.reason : null, glucose: checked.glucose_mgdl, slope_per_min: checked.slope_per_min, forecast_min_mgdl: checked.forecast_min_mgdl }));
        }
        if (!(await store.markNotified(plan.patient_id, plan.id))) continue;
        const doseCarbs = plannedDoseCarbs(plan);
        // Insulin given by hand since the meal's bolus is taken off the dose and named in the push (owner 2026-10-26).
        const used = (await store.usedLoopActionIds?.(plan.patient_id, plan.meal_record_id).catch(() => null)) ?? new Set<string>();
        const given = await this.givenSinceMealFor(plan.patient_id, record.started_at, new Date(nowMs), resolveHomeTimeZone(), (actions) => manualInsulinForPart({
          actions, used, meal_record_id: plan.meal_record_id, meal_started_at: record.started_at, now: new Date(nowMs),
        }));
        const givenByHand = given && given.doses.length > 0 ? given : null;
        const estimate = await this.estimatePlannedBolus(plan, record.started_at, nowIso, givenByHand?.total_u ?? null).catch(() => null);
        // Only a recent reading is quoted: an old one after a CGM gap would read as glucose now.
        const recent = await this.bolusDashboardRepository?.listGlucoseReadingsSince(plan.patient_id, new Date(nowMs - PLANNED_BOLUS_GLUCOSE_MAX_AGE_MINUTES * 60_000).toISOString()).catch(() => []) ?? [];
        const latest = recent.reduce<{ at: string; value: number } | null>((newest, reading) => (!newest || Date.parse(reading.at) > Date.parse(newest.at) ? reading : newest), null);
        const glucose = typeof latest?.value === 'number' ? latest.value : null;
        const { title, body } = plannedBolusPushContent({
          description: record.description,
          carbs_g: doseCarbs,
          estimate_u: estimate?.insulin_u ?? plan.planned_insulin_u,
          low_glucose: glucose !== null && glucose < 100 ? glucose : null,
          kind: plan.kind,
          readiness,
          threshold_mgdl: plan.threshold_mgdl,
          meal_change_g: plan.meal_change_g ?? 0,
          fixed_insulin_u: plan.fixed_insulin_u,
          given_line: givenByHand?.line ?? null,
        });
        const result = await this.pushOutbox.dispatch({
          dedupeKey: `planned-bolus:${plan.id}`,
          patientId: plan.patient_id,
          request: { kind: 'planned_bolus', input: { patientId: plan.patient_id, mealId: plan.meal_record_id, plannedBolusId: plan.id, title, body } },
          ttlMinutes: REMINDER_PUSH_TTL_MINUTES,
          now: new Date(nowMs),
        });
        this.jobLogger.log(JSON.stringify({ event: 'planned_bolus_push_sent', planned_bolus_id: plan.id, devices: result?.delivered ?? 0, retrying: result?.retrying ?? false, estimate_u: estimate?.insulin_u ?? null, loop_extra_u: estimate?.loop_extra_u ?? null }));
      } catch (error) {
        this.jobLogger.warn(JSON.stringify({ event: 'planned_bolus_failed', planned_bolus_id: plan.id, error_code: safeJobErrorCode(error) }));
      }
    }
  }

  /** A planned part's dose now (estimatePlannedBolus: its carbs / ICR now minus the loop's and the card's insulin). */
  private async estimatePlannedBolus(plan: PlannedBolusRecord, mealStartedAt: string, nowIso: string, manualInsulinU: number | null = null) {
    const patientId = plan.patient_id;
    const [therapy, events, reportedStep] = await Promise.all([
      this.repository.getTherapyProfileAt(patientId, nowIso),
      this.repository.listInsulinDeliveryEventsByRange({ patientId, startAtIso: new Date(Date.parse(mealStartedAt) - 6 * 3_600_000).toISOString(), endAtIso: nowIso }),
      this.repository.getPumpBolusIncrement(patientId, new Date(Date.parse(nowIso) - 24 * 3_600_000).toISOString()).catch(() => null),
    ]);
    // The card's insulin as delivered (a refused bolus and its retry), not as the first command asked.
    const cardInsulin = await this.plannedBolusService?.cardInsulinGiven(plan).catch(() => null) ?? null;
    return estimatePlannedBolus({
      plan: cardInsulin === null ? plan : { ...plan, first_insulin_u: cardInsulin },
      meal_started_at: mealStartedAt,
      loop_extra_from: await this.plannedBolusService?.earlierPartGivenAt(plan).catch(() => null) ?? null,
      now_iso: nowIso,
      therapy,
      events,
      step: pumpBolusStep(reportedStep) ?? 0.05,
      fallback_time_zone: resolveHomeTimeZone(),
      icr_at: scheduleValueAt,
      manual_insulin_u: manualInsulinU,
    });
  }

  /**
   * Whether this meal's WBT was given since it started: a loop entry answered WBT for this meal (carbs or a bolus
   * alone). Another meal's WBT does not count; an older carb entry without a loop action counts by its kind.
   */
  private async mealWbtAlreadyLogged(patientId: string, mealIdentity: string, startedAtIso: string, nowIso: string): Promise<boolean> {
    const events = await this.loadWbtEvents(patientId, new Date(Date.parse(startedAtIso) + 30 * 60_000).toISOString(), nowIso);
    return events.some((event) => isMealWbtDose(event, mealIdentity));
  }

  /** Events of a range with the caregiver's carb entry kind attached to CARB_ENTRY payloads (carb_kind). */
  private async loadWbtEvents(patientId: string, fromIso: string, toIso: string): Promise<WbtHistoryEvent[]> {
    const raw = await this.repository.listPatientEventsByRange({ patientId, startAtIso: fromIso, endAtIso: toIso, limit: 1000 });
    const carbIds = raw.filter((event) => event.type === 'CARB_ENTRY').map((event) => String(event.id));
    const kinds = typeof (this.repository as { listCarbEntryKinds?: unknown }).listCarbEntryKinds === 'function'
      ? await this.repository.listCarbEntryKinds(patientId, carbIds)
      : new Map<string, string>();
    // Which meal (or other purpose) each carb entry and bolus was assigned to: another meal's bolus is not this one's WBT.
    const assignments = this.loopActionRepository
      ? await this.loopActionRepository.listEventAssignments(patientId, raw.filter((event) => event.type === 'CARB_ENTRY' || event.type === 'BOLUS').map((event) => String(event.id))).catch(() => new Map())
      : new Map();
    return raw.map((event) => {
      const payload = (event.payload ?? {}) as Record<string, unknown>;
      const kind = event.type === 'CARB_ENTRY' ? kinds.get(String(event.id)) : undefined;
      const assignment = assignments.get(String(event.id));
      return {
        type: String(event.type ?? ''),
        occurred_at: event.occurred_at instanceof Date ? event.occurred_at.toISOString() : String(event.occurred_at ?? ''),
        payload: { ...payload, ...(kind ? { carb_kind: kind } : {}), ...(assignment ? { loop_action: assignment } : {}) },
      };
    });
  }

  private async handleWbtSuggestion(jobId: string, leaseToken: string, payload: Record<string, unknown>): Promise<void> {
    const reminders = this.mealWbtRepository;
    if (!reminders || !this.mealRecordRepository) {
      throw new Error('MEAL_HISTORY_SERVICES_UNAVAILABLE');
    }
    const outcome = await runWbtSuggestionJob({
      getSuggestion: (suggestionId) => reminders.getSuggestion(suggestionId),
      // The newest reading first, as before a chat answer: the dose depends on the glucose now.
      loadContext: async (patientId, mealRecordId, nowIso) => {
        await this.refreshGlucoseBeforeAnswer(patientId);
        return this.loadWbtSuggestionContext(patientId, mealRecordId, nowIso);
      },
      completeSuggestion: (suggestionId, status, result) => reminders.completeSuggestion(suggestionId, status, result),
      responder: (this.wbtSuggestionResponder ??= this.createWbtSuggestionResponder()),
      isRetryableError,
    }, payload, new Date().toISOString());
    this.jobLogger.log(JSON.stringify({ event: 'wbt_suggestion_finished', outcome, suggestion_id: payload.suggestion_id ?? null }));
    await this.repository.finalizeJobSuccess(jobId, leaseToken, new Date().toISOString());
  }

  /**
   * A WBT conversation's data for one answer (wbt-chat.v1): the screen's context and the newest proposal. Doses an
   * earlier failed run proposed for this message are dropped first, so they are neither shown nor the "current" one.
   */
  private async loadWbtChat(patientId: string, mealRecordId: string, userMessageId: string, nowIso: string): Promise<WbtChat | null> {
    if (!this.mealWbtRepository || !this.mealRecordRepository) return null;
    await this.mealWbtRepository.discardChatSuggestionsForUserMessage(patientId, userMessageId);
    const context = await this.loadWbtSuggestionContext(patientId, mealRecordId, nowIso);
    const latest = await this.mealWbtRepository.getLatestSuggestion(patientId, mealRecordId);
    const result = latest?.status === 'DONE' ? latest.result : null;
    const current: WbtCurrentProposal | null = result && typeof result.dose_units === 'number'
      ? {
        dose_units: result.dose_units,
        rationale: String(result.rationale ?? ''),
      }
      : null;
    return { mealRecordId, context, current };
  }

  private async loadWbtSuggestionContext(patientId: string, mealRecordId: string, nowIso: string): Promise<WbtSuggestionContext> {
    const records = this.mealRecordRepository!;
    const identity = await records.findMealIdentityById(patientId, mealRecordId);
    if (!identity) throw new Error('MEAL_NOT_FOUND');
    const record = await records.getMealRecord(patientId, identity);
    const timeZoneFallback = resolveHomeTimeZone();
    const icrAt = async (iso: string): Promise<{ icr: number | null; timeZone: string }> => {
      const therapy = await this.repository.getTherapyProfileAt(patientId, iso);
      const timeZone = therapy.timezone ?? timeZoneFallback;
      return { icr: scheduleValueAt(therapy.carb_ratio_g_per_u, iso, timeZone), timeZone };
    };
    const localTime = (iso: string, timeZone: string) => new Intl.DateTimeFormat('sv-SE', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
    const start = Date.parse(record.started_at);
    const { timeZone } = await icrAt(record.started_at);
    // The WBT insulin is given now and the loop converts WBT carbs with the ICR active now, not the meal's.
    const { icr } = await icrAt(nowIso);
    const icrValueAt = async (iso: string) => (await icrAt(iso)).icr;

    const mealEvents = await this.loadWbtEvents(patientId, new Date(start - 30 * 60_000).toISOString(), nowIso);
    const mealBolus = mealEvents
      .filter((event) => event.type === 'BOLUS' && Math.abs(Date.parse(event.occurred_at) - start) <= 30 * 60_000)
      .reduce((total, event) => total + (Number(event.payload.insulin_units ?? event.payload.insulin) || 0), 0);
    const carbs = record.macros.carbs.grams ?? record.source_carbs_g;
    const fpu = fatProteinUnitsOf(record.macros.protein.grams, record.macros.fat.grams);
    const own = computeWbtCase({
      case_id: identity, started_at: record.started_at, local_time: null, description: record.description, carbs_g: carbs,
      protein_g: record.macros.protein.grams, fat_g: record.macros.fat.grams, fat_protein_units: fpu,
      icr_at: await wbtIcrLookup(record.started_at, mealEvents, icrValueAt), events: mealEvents,
    });

    const state = ((await this.repository.getCurrentState(patientId)) ?? {}) as Record<string, any>;
    const numberOrNull = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

    return {
      meal: {
        meal_record_id: mealRecordId,
        description: record.description,
        started_at: record.started_at,
        local_time: localTime(record.started_at, timeZone),
        carbs_g: carbs,
        protein_g: record.macros.protein.grams,
        fat_g: record.macros.fat.grams,
        fat_protein_units: fpu,
        meal_bolus_units: mealBolus > 0 ? Math.round(mealBolus * 100) / 100 : null,
      },
      icr_g_per_u: icr,
      current: {
        as_of: typeof state.as_of === 'string' ? state.as_of : null,
        glucose_mgdl: numberOrNull(state.glucose?.value),
        trend: typeof state.glucose?.trend === 'string' ? state.glucose.trend : null,
        iob_u: numberOrNull(state.iob?.value),
        cob_g: numberOrNull(state.cob?.value),
        minutes_after_meal: Math.round((Date.parse(nowIso) - start) / 60_000),
      },
      already_given: { wbt_carbs_logged_g: own.wbt_carbs_logged_g, late_bolus_units: own.late_bolus_units, wbt_insulin_units: own.wbt_insulin_units },
      patient_birth_year: await this.patientBirthYear(patientId),
    };
  }

  /**
   * The loop's state as of the question and the plans still open (therapy-now.v1). Each source fails on its own (that
   * part is just missing); null without the repositories (tests, fake setups).
   */
  private async loadTherapyNow(patientId: string, atIso: string): Promise<TherapyNow | null> {
    if (!this.bolusDashboardRepository && !this.plannedBolusRepository && !this.careReminderRepository && !this.rescueCarbsRepository) return null;
    const context = this.therapyContextRepository;
    const [loopStatus, plannedBoluses, reminders, rescueAlert, latestContext, notes] = await Promise.all([
      this.bolusDashboardRepository?.getLoopStatusAtOrBefore(patientId, atIso).catch(() => null) ?? null,
      this.plannedBolusRepository?.listOpenForPatient(patientId).catch(() => []) ?? [],
      this.careReminderRepository?.listActiveForPatient(patientId).catch(() => []) ?? [],
      this.rescueCarbsRepository?.getActiveAlert(patientId).catch(() => null) ?? null,
      // Migration 086 not applied yet: no context, the rest goes on.
      context?.latestPerKind(patientId, atIso, THERAPY_NOW_CONTEXT_KINDS).catch(() => null) ?? null,
      context?.listBetween(patientId, new Date(Date.parse(atIso) - 24 * 3_600_000).toISOString(), atIso, 50).then((events) => events.filter((event) => event.kind === 'NOTE')).catch(() => null) ?? null,
    ]);
    return buildTherapyNow({
      atIso, timeZone: await this.patientTimeZone(patientId), loopStatus, plannedBoluses, reminders, rescueAlert,
      contextEvents: latestContext && notes ? { latest: latestContext, notes } : null,
    });
  }

  /** The period's context treatments for an analysis, in the patient's local time; null when not loaded. */
  private async loadTherapyContextEvents(patientId: string, fromIso: string, toIso: string, timeZone: string): Promise<Array<Record<string, unknown>> | null> {
    if (!this.therapyContextRepository || !Number.isFinite(Date.parse(fromIso)) || !Number.isFinite(Date.parse(toIso))) return null;
    try {
      // A target or override set before the period may still run in it: from 24 h earlier.
      const events = await this.therapyContextRepository.listBetween(patientId, new Date(Date.parse(fromIso) - 24 * 3_600_000).toISOString(), toIso, 150);
      const local = (iso: string) => new Intl.DateTimeFormat('sv-SE', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
      return events
        .filter((event) => Date.parse(event.occurred_at) >= Date.parse(fromIso) || (event.duration_minutes ?? 0) > 0 || event.kind === 'PROFILE_SWITCH')
        .map((event) => ({ kind: event.kind, at_local: local(event.occurred_at), ...(event.duration_minutes !== null ? { duration_minutes: event.duration_minutes } : {}), ...event.details }));
    } catch {
      return null;
    }
  }

  /** The patient's clock (owner decision 2026-10-26): the Trio profile's time zone, else the server's. */
  private async patientTimeZone(patientId: string): Promise<string> {
    try {
      const therapy = await this.repository.getTherapyProfileAt(patientId, new Date().toISOString());
      return therapy?.timezone ?? resolveHomeTimeZone();
    } catch {
      return resolveHomeTimeZone();
    }
  }

  /** "Rok urodzenia" for the AI prompts; null when not set or unreadable (the prompt then says the age is not known). */
  private async patientBirthYear(patientId: string): Promise<number | null> {
    try {
      return await this.repository.getPatientBirthYear(patientId);
    } catch {
      return null;
    }
  }

  /**
   * "Moje instrukcje dla AI" of the user who sent the message; null for a message without an author (alerts, older
   * rows) or when unreadable (migration 057 not applied yet): the prompt then has no preferences line.
   */
  private async userAiPreferences(authorUserId: unknown): Promise<UserAiPreferences | null> {
    if (typeof authorUserId !== 'string' || !authorUserId) return null;
    try {
      return await this.repository.getUserAiPreferences(authorUserId);
    } catch {
      return null;
    }
  }

  /** Cancellation operations of the Postgres repository; optional so test doubles without them never cancel. */
  private analysisCancellationStore(): Partial<{
    isUserMessageCancelled(conversationId: string, userMessageId: string): Promise<boolean>;
    claimUserMessageCompletion(conversationId: string, userMessageId: string): Promise<boolean>;
    finalizeJobCancelled(jobId: string, leaseToken: string, nowIso: string): Promise<unknown>;
    markAiExecutionCancelled(args: { taskIdentity: string; nowIso: string }): Promise<void>;
  }> {
    return this.repository as unknown as ReturnType<WorkerService['analysisCancellationStore']>;
  }

  private async isAnalysisCancelled(conversationId: string, userMessageId: string): Promise<boolean> {
    const store = this.analysisCancellationStore();
    return store.isUserMessageCancelled ? store.isUserMessageCancelled(conversationId, userMessageId) : false;
  }

  private async claimAnalysisCompletion(conversationId: string, userMessageId: string): Promise<boolean> {
    const store = this.analysisCancellationStore();
    return store.claimUserMessageCompletion ? store.claimUserMessageCompletion(conversationId, userMessageId) : true;
  }

  private async finalizeCancelledAnalysisJob(jobId: string, leaseToken: string, taskIdentity: string | null): Promise<void> {
    const store = this.analysisCancellationStore();
    const nowIso = new Date().toISOString();
    if (taskIdentity && store.markAiExecutionCancelled) {
      await store.markAiExecutionCancelled({ taskIdentity, nowIso });
    }
    console.log(JSON.stringify({ event: 'analysis_cancelled', job_id: jobId, task_identity: taskIdentity }));
    if (store.finalizeJobCancelled) {
      await store.finalizeJobCancelled(jobId, leaseToken, nowIso);
    } else {
      await this.repository.finalizeJobSuccess(jobId, leaseToken, nowIso);
    }
  }

  /**
   * Runs the AI call with an AbortSignal that fires when the user cancels: the gateway stops before the next
   * provider call and the provider aborts the in-flight HTTP request. Cancellation is detected by polling the
   * message state, because the API and the worker are separate processes.
   */
  /**
   * DiabCalc product search and the caregiver's photos for a conversation answer. Both stay outside the context package
   * (non-enumerable, like meal_lookup), so its hash and a retry's reuse of a succeeded execution are unchanged.
   */
  /**
   * Earlier answers' cards for the model (card-context.v1): the answer that prepared them gets a short list of each card's
   * option, amounts now and later, WBT and state as of the question. Fails open (no notes).
   */
  private async answerCardNotes(patientId: string, conversationId: string, messages: any[], asOf: string): Promise<Map<string, string>> {
    const notes = new Map<string, string>();
    try {
      const bolus = this.bolusProposalRepository ? await this.bolusProposalRepository.listForConversation(patientId, conversationId) : [];
      const rescue = this.rescueCarbsRepository ? await this.rescueCarbsRepository.listProposalsForConversation(patientId, conversationId) : [];
      // A WBT conversation's dose cards (wbt-chat.v1): the model sees what it proposed before.
      const wbt = this.mealWbtRepository ? await this.mealWbtRepository.listChatSuggestions(patientId, conversationId).catch(() => []) : [];
      if (bolus.length === 0 && rescue.length === 0 && wbt.length === 0) return notes;
      const newestRescueAnswer = rescue.at(-1)?.user_message_id ?? null;
      const lastAnswer = new Map<string, any>();
      for (const message of messages) {
        const answered = String(message.role ?? '').toUpperCase() === 'ASSISTANT' ? (message.metadata as Record<string, unknown> | null)?.user_message_id : null;
        if (typeof answered === 'string') lastAnswer.set(answered, message);
      }
      for (const [userMessageId, message] of lastAnswer) {
        const note = describeAnswerCards({
          cards: bolus.filter(({ proposal }) => proposal.user_message_id === userMessageId),
          // As of the question, like the bolus cards' sends: a retry reads the same text.
          // Like the app's view: only the newest answer's rescue cards stay usable, older ones are replaced by them.
          rescue: rescue.filter((card) => card.user_message_id === userMessageId).map((card) => ({
            carbs_g: card.carbs_g,
            option_key: card.option_key,
            status: card.status === 'PROPOSED' && card.user_message_id !== newestRescueAnswer ? 'SUPERSEDED' : card.status,
            treated: card.treatment !== null && Date.parse(card.treatment.given_at) <= Date.parse(asOf),
          })),
          options: sanitizeAnswerOptions((message.metadata as Record<string, unknown> | null)?.answer_options),
          asOf,
        });
        const wbtLines = wbt
          .filter((suggestion) => suggestion.user_message_id === userMessageId && typeof suggestion.result?.dose_units === 'number')
          .map((suggestion) => `- Dawka WBT ${String(suggestion.result!.dose_units).replace('.', ',')} j (propozycja na ekranie WBT; czy podano, widać w meal_wbt.already_given)`);
        const combined = wbtLines.length === 0 ? note : [note ?? '[Karty pod tą odpowiedzią]', ...wbtLines].join('\n');
        if (combined) notes.set(String(message.id), combined);
      }
    } catch {
      // Without the notes the model only reads the answers' text.
    }
    return notes;
  }

  /** Cards and reminders of an answer that will never be stored (cancelled, or failed with no retry left). */
  private async discardAnswerExtras(patientId: string, userMessageId: string): Promise<void> {
    await this.careReminderRepository?.discardForUserMessage(patientId, userMessageId).catch(() => undefined);
    await this.bolusProposalRepository?.discardForUserMessage(patientId, userMessageId).catch(() => undefined);
    await this.rescueCarbsRepository?.discardProposalsForUserMessage(patientId, userMessageId).catch(() => undefined);
    await this.mealWbtRepository?.discardChatSuggestionsForUserMessage(patientId, userMessageId).catch(() => undefined);
    this.jobLogger.log(JSON.stringify({ event: 'answer_extras_discarded', patient_id: patientId, user_message_id: userMessageId }));
  }

  /**
   * The card and meal tools this answer gets (answer-tool-scope.v1): left out only for a clear look back or general
   * question with no dose, food, "now", photo or earlier cards to answer. Unreadable state keeps every tool.
   */
  private async answerToolScopeFor(patientId: string, conversation: { messages?: unknown; id?: unknown; trigger_type?: unknown; wbt_meal_record_id?: unknown }, userMessageId: string, special: boolean): Promise<AnswerToolScope> {
    const messages = Array.isArray(conversation.messages) ? (conversation.messages as Array<Record<string, unknown>>) : [];
    const index = messages.findIndex((message) => String(message.id) === userMessageId);
    const asking = index >= 0 ? messages[index] : null;
    if (!asking) return { cards: true, meals: true };
    const text = String(asking.content ?? '');
    const previousUser = [...messages.slice(0, index)].reverse().find((message) => String(message.role ?? '').toUpperCase() === 'USER');
    const previousAnswer = [...messages.slice(0, index)].reverse().find((message) => String(message.role ?? '').toUpperCase() === 'ASSISTANT');
    let previousAnswerHadCards = sanitizeAnswerOptions((previousAnswer?.metadata as Record<string, unknown> | null)?.answer_options).length > 0;
    if (!previousAnswerHadCards && previousUser) {
      const conversationId = String(conversation.id ?? '');
      try {
        const [bolus, rescue] = await Promise.all([
          this.bolusProposalRepository ? this.bolusProposalRepository.listForConversation(patientId, conversationId) : [],
          this.rescueCarbsRepository ? this.rescueCarbsRepository.listProposalsForConversation(patientId, conversationId) : [],
        ]);
        previousAnswerHadCards = bolus.some(({ proposal }) => proposal.user_message_id === previousUser.id) || rescue.some((card) => card.user_message_id === previousUser.id);
      } catch {
        return { cards: true, meals: true };
      }
    }
    const scope = answerToolScope({
      text,
      hasPhotos: messagePhotoIds(asking.metadata).length > 0,
      previousAnswerHadCards,
      specialConversation: special || typeof conversation.wbt_meal_record_id === 'string' || String(conversation.trigger_type ?? '') === 'RESCUE_CARBS' || isMealEditRequest(text),
    });
    if (!scope.cards || !scope.meals) this.jobLogger.log(JSON.stringify({ event: 'answer_tool_scope', user_message_id: userMessageId, ...scope }));
    return scope;
  }

  private async attachConversationAiExtras(input: object, patientId: string, conversation: { messages?: unknown; id?: unknown; trigger_type?: unknown; wbt_meal_record_id?: unknown }, userMessageId: string, rescueAlert: RescueAlertRecord | null = null, wbtChat: WbtChat | null = null): Promise<MealActionsToolSession | null> {
    this.answerExtrasPending = { patientId, userMessageId };
    const scope = await this.answerToolScopeFor(patientId, conversation, userMessageId, Boolean(rescueAlert || wbtChat));
    if (this.conversationFoodSearch && scope.meals) {
      Object.defineProperty(input, 'food_search', { value: this.conversationFoodSearch, enumerable: false, configurable: true });
    }
    const mealSession = scope.meals ? await this.createMealActionsSession(patientId, conversation, userMessageId) : null;
    if (mealSession) {
      Object.defineProperty(input, 'meal_actions', { value: mealSession, enumerable: false, configurable: true });
    }
    // A WBT conversation without its WBT data (direct answer, meal gone) gets no bolus cards: a "give 0.5 for WBT" card
    // would go to Trio as an ordinary bolus, without the WBT checks of propose_wbt_dose.
    const wbtWithoutData = typeof conversation.wbt_meal_record_id === 'string' && !wbtChat;
    const bolusSession = wbtWithoutData || !scope.cards ? null : await this.createBolusProposalSession(patientId, conversation, userMessageId);
    if (bolusSession) {
      Object.defineProperty(input, 'bolus_proposals', { value: bolusSession, enumerable: false, configurable: true });
      this.bolusSessions.set(userMessageId, bolusSession);
    }
    const reminderSession = scope.cards ? await this.createCareReminderSession(patientId, conversation, userMessageId) : null;
    if (reminderSession) {
      Object.defineProperty(input, 'care_reminders', { value: reminderSession, enumerable: false, configurable: true });
    }
    if (this.rescueCarbsRepository && (rescueAlert || (scope.cards && allowsChatRescueCards(conversation, userMessageId)))) {
      // propose_rescue_carbs in the alert's chat, or an ordinary one whose phone can confirm the cards; cards a failed
      // earlier attempt prepared for this message are dropped.
      const store = this.rescueCarbsRepository;
      const ready = await store.discardProposalsForUserMessage(patientId, userMessageId).then(() => true, () => false);
      if (ready) {
        const rescueSession = new RescueCarbProposalSession({
          patientId, alertId: rescueAlert?.id ?? null, conversationId: String(conversation.id ?? ''), userMessageId, store,
          // carbs_g null: the fast carbs the bolus cards' data advise (one turn with the meal cards).
          ...(bolusSession ? { advisedCarbs: async () => (await bolusSession.fastCarbsAdvice())?.carbs_g ?? null } : {}),
        });
        Object.defineProperty(input, 'rescue_carbs', {
          value: rescueSession,
          enumerable: false,
          configurable: true,
        });
        this.rescueSessions.set(userMessageId, rescueSession);
      }
    }
    if (wbtChat && this.mealWbtRepository) {
      // propose_wbt_dose in a meal's WBT conversation (wbt-chat.v1); doses an earlier failed run proposed were dropped
      // when the WBT data were read.
      const asking = (Array.isArray(conversation.messages) ? conversation.messages as Array<Record<string, unknown>> : []).find((message) => String(message.id) === userMessageId);
      const wbtSession = new WbtDoseProposalSession({
          canSendToTrio: messageAllowsBolusCards(asking),
          patientId,
          mealRecordId: wbtChat.mealRecordId,
          conversationId: String(conversation.id ?? ''),
          userMessageId,
          store: this.mealWbtRepository,
          context: wbtChat.context,
          current: wbtChat.current,
          nowIso: new Date().toISOString(),
        });
      this.wbtSessions.set(userMessageId, wbtSession);
      Object.defineProperty(input, 'wbt_doses', {
        value: wbtSession,
        enumerable: false,
        configurable: true,
      });
    }
    const { images, unavailable } = await this.loadConversationImages(patientId, conversation, userMessageId);
    if (images.length > 0) {
      Object.defineProperty(input, 'user_images', { value: images, enumerable: false, configurable: true });
      this.jobLogger.log(JSON.stringify({ event: 'conversation_photos_attached', patient_id: patientId, user_message_id: userMessageId, photos: images.length }));
    }
    if (unavailable > 0) {
      // The model is told, so it does not answer as if the caregiver had sent no photo.
      Object.defineProperty(input, 'user_images_unavailable', { value: unavailable, enumerable: false, configurable: true });
      this.jobLogger.log(JSON.stringify({ event: 'conversation_photos_unavailable', patient_id: patientId, user_message_id: userMessageId, photos: unavailable }));
    }
    return mealSession;
  }

  /**
   * get_meals / propose_meal_change for one answer (AI_ENABLE_MEAL_ACTIONS). A new AI call answers the message anew, so
   * cards an earlier failed run prepared for it, never shown, are discarded first.
   */
  private async createMealActionsSession(patientId: string, conversation: { messages?: unknown; id?: unknown }, userMessageId: string): Promise<MealActionsToolSession | null> {
    if (!this.conversationMealActions || !isMealActionsEnabled()) return null;
    const messages = Array.isArray(conversation.messages) ? (conversation.messages as Array<Record<string, unknown>>) : [];
    const userText = String(messages.find((message) => String(message.id) === userMessageId)?.content ?? '');
    const conversationId = String(conversation.id ?? '');
    try {
      await this.conversationMealActions.repository.discardForUserMessage(patientId, userMessageId);
    } catch {
      // Migration 043 not applied yet: the answer goes on without the meal tools.
      return null;
    }
    return new MealActionsToolSession({
      patientId,
      conversationId,
      userMessageId,
      service: this.conversationMealActions.service,
      catalog: this.conversationMealActions.repository,
      mealChangeRequested: isMealEditRequest(userText) || continuesMealAssistant(messages, userText, userMessageId),
    });
  }

  /**
   * propose_bolus for one answer (remote-bolus-trio-plan.md W7): only with AI_ENABLE_BOLUS_PROPOSALS, the server switch,
   * and the patient's and the asking caregiver's remote control switches on. Cards a failed earlier attempt prepared
   * for the same message are discarded first.
   */
  private async createBolusProposalSession(patientId: string, conversation: { messages?: unknown; id?: unknown }, userMessageId: string): Promise<BolusProposalSession | null> {
    this.bolusSessions.delete(userMessageId);
    const proposals = this.bolusProposalRepository;
    const dashboards = this.bolusDashboardRepository;
    if (!proposals || !dashboards || !isBolusProposalsEnabled(process.env) || !isRemoteCommandsServerEnabled(process.env)) return null;
    const messages = Array.isArray(conversation.messages) ? (conversation.messages as Array<Record<string, unknown>>) : [];
    const userMessage = messages.find((message) => String(message.id) === userMessageId);
    const authorId = typeof userMessage?.author_user_id === 'string' ? userMessage.author_user_id : null;
    if (!authorId) return null;
    // Only for a phone that can give the dose: its remote control set up (older apps never say so, and get no cards).
    if (!messageAllowsBolusCards(userMessage)) return null;
    try {
      const [switches, loopSystem] = await Promise.all([
        this.repository.getRemoteControlSwitches(authorId, patientId),
        patientLoopSystem(dashboards, patientId),
      ]);
      const access = resolveRemoteControlAccess(true, switches, loopSystem.kind);
      if (!access.enabled) return null;
      await proposals.discardForUserMessage(patientId, userMessageId);
    } catch {
      // Migrations 044-046 not applied yet: the answer goes on without bolus cards.
      return null;
    }
    return new BolusProposalSession({
      patientId,
      conversationId: String(conversation.id ?? ''),
      userMessageId,
      store: proposals,
      doseRequested: isDoseRequest(String(userMessage?.content ?? '')),
      phoneLimits: readPhoneLimits((userMessage?.metadata as Record<string, unknown> | null)?.phone_limits),
      // Earlier answers' cards of the conversation: a new card for the same meal must not lose part of an unsent plan
      // (this answer's own cards are other options, not an earlier plan).
      previousCards: async () => (await proposals.listForConversation(patientId, String(conversation.id ?? ''))).filter(({ proposal }) => proposal.user_message_id !== userMessageId).map(({ proposal, command }) => ({
        id: proposal.id,
        purpose: proposal.purpose,
        carbs_g: proposal.carbs_g,
        split: proposal.split,
        meal_payload: proposal.meal_payload,
        created_at: proposal.created_at,
        sent: command !== null && !['EXPIRED', 'SEND_FAILED'].includes(command.status),
        sent_at: command?.authorized_at ?? null,
        sent_carbs_g: command?.carbs_g ?? null,
        sent_insulin_u: command?.insulin_u ?? null,
      })),
      // Synced data (a minute old at most); the card is checked again with live data when the caregiver uses it.
      context: async (now) => {
        // 4 h: the high-despite-insulin check looks up to 3 h back (a correction and its first hour).
        const sinceIso = new Date(now.getTime() - 4 * 3_600_000).toISOString();
        const nowIso = now.toISOString();
        const [readings, loopStatus, therapy, pumpBolusStep, lastCarbsAt, insulinEvents, carbEntries] = await Promise.all([
          dashboards.listGlucoseReadingsSince(patientId, sinceIso),
          dashboards.getLatestLoopStatus(patientId),
          this.repository.getTherapyProfileAt(patientId, nowIso),
          this.repository.getPumpBolusIncrement(patientId, new Date(now.getTime() - 24 * 3_600_000).toISOString()).catch(() => null),
          // Fast carbs eaten in the last 15 min are already working: no "fast carbs first" again.
          this.rescueCarbsRepository?.getLastEatenCarbsAt(patientId, new Date(now.getTime() - 15 * 60_000).toISOString(), nowIso).catch(() => null) ?? null,
          // high-glucose-safety.v1: boluses and carbs of the last hours (a correction that did not work).
          this.repository.listInsulinDeliveryEventsByRange({ patientId, startAtIso: sinceIso, endAtIso: nowIso }).catch(() => null),
          this.repository.listCarbEntriesBetween(patientId, sinceIso, new Date(now.getTime() + 60_000).toISOString()).catch(() => null),
        ]);
        // The boluses of these hours: a bolus given minutes ago reaches the card's RECENT_BOLUS warning (owner 2026-10-26).
        const insulin = insulinEvents
          ? buildDashboardInsulin({ from: sinceIso, to: nowIso, events: insulinEvents as InsulinDeliveryEvent[], basalSchedule: null, profileTimezone: therapy.timezone ?? resolveHomeTimeZone() })
          : null;
        const dashboard = buildDashboard({ patientId, now, readings, deviceStatus: null, loopStatus, careEvents: null, insulin });
        const recentRemote = await this.remoteCommandRepository?.findRecentWithInsulin(patientId, new Date(now.getTime() - REMOTE_COMMAND_POLICY.recent_remote_bolus_minutes * 60_000).toISOString()).catch(() => null) ?? null;
        return {
          ...remoteCommandContextFrom({ now, dashboard, therapy, pumpBolusStep, loopStatus }),
          recent_remote_bolus: recentRemote ? { at: recentRemote.sent_at ?? recentRemote.authorized_at, units: recentRemote.insulin_u, status: recentRemote.status } : null,
          meal_forecast: mealForecastDataFrom({ now, readings, loopStatus, therapy, lastCarbsAt }),
          high_safety: highGlucoseSafetyInputsFrom({
            now,
            readings,
            insulinEvents,
            carbEntries: carbEntries ? carbEntries.map((entry) => ({ occurred_at: entry.occurred_at, payload: entry.payload })) : null,
          }),
          timezone: therapy.timezone ?? null,
        };
      },
    });
  }

  /** The bolus cards of the stored answer (from the database for a reused result). */
  private async bolusAnswerState(patientId: string, userMessageId: string): Promise<Pick<BolusProposalSession, 'used' | 'proposed' | 'dose_requested'> | { used: boolean; proposed: BolusProposalSession['proposed'] } | null> {
    const session = this.bolusSessions.get(userMessageId);
    this.bolusSessions.delete(userMessageId);
    if (session) return session;
    if (!this.bolusProposalRepository || !isBolusProposalsEnabled(process.env)) return null;
    try {
      const proposed = (await this.bolusProposalRepository.listForUserMessage(patientId, userMessageId)).filter((proposal) => proposal.status !== 'DISCARDED');
      return { used: proposed.length > 0, proposed };
    } catch {
      return null;
    }
  }

  /**
   * The answer's options (answer-options.v1), kept only when a card of this answer belongs to one of them: options
   * without cards would be a picker that changes nothing.
   */
  private async answerOptionsFor(raw: unknown, bolus: { proposed: BolusProposalSession['proposed'] } | null, userMessageId: string, patientId: string): Promise<AnswerOption[]> {
    const session = this.rescueSessions.get(userMessageId);
    this.rescueSessions.delete(userMessageId);
    // A reused stored result has no session: its rescue cards come from the database, like the bolus cards.
    const rescueCards = session
      ? session.proposed
      : await this.rescueCarbsRepository?.listProposalsForUserMessage(patientId, userMessageId).catch(() => []) ?? [];
    // Under a picker a card without an option would show whatever is chosen; without one, cards of different options
    // (or two copies of one card) would stand side by side as plans to send.
    const settled = settleAnswerCards(sanitizeAnswerOptions(raw), bolus?.proposed ?? [], rescueCards);
    for (const card of settled.discardBolus) {
      await this.bolusProposalRepository?.discard(card.patient_id, card.id).catch(() => undefined);
    }
    for (const card of settled.discardRescue) {
      await this.rescueCarbsRepository?.discardProposal(card.patient_id, card.id).catch(() => undefined);
    }
    if (settled.keptOption) {
      this.jobLogger.log(JSON.stringify({ event: 'answer_options_dropped', user_message_id: userMessageId, kept_option: settled.keptOption }));
    }
    if (settled.duplicates.length > 0) {
      this.jobLogger.log(JSON.stringify({ event: 'bolus_card_duplicates_discarded', user_message_id: userMessageId, discarded: settled.duplicates.map((card) => card.id) }));
    }
    return settled.options;
  }

  /** Whether the stored answer worked on meals and which cards it prepared (from the database for a reused result). */
  private async mealActionAnswerState(session: MealActionsToolSession | null, patientId: string, userMessageId: string): Promise<Pick<MealActionsToolSession, 'used' | 'proposed'>> {
    if (session) return session;
    if (!this.conversationMealActions) return { used: false, proposed: [] };
    try {
      const proposed = (await this.conversationMealActions.repository.listForUserMessage(patientId, userMessageId)).filter((action) => action.status !== 'DISCARDED');
      return { used: proposed.length > 0, proposed };
    } catch {
      return { used: false, proposed: [] };
    }
  }

  /**
   * Photos of the latest caregiver message with photos among the last few messages up to the answered one: a follow-up
   * ("a na połowę?") still sees the plate, an unrelated question later in a long conversation does not.
   */
  private async loadConversationImages(patientId: string, conversation: { messages?: unknown }, userMessageId: string): Promise<{ images: AiUserImage[]; unavailable: number }> {
    const none = { images: [], unavailable: 0 };
    if (!this.mealPhotoStorage) return none;
    const messages = Array.isArray(conversation.messages) ? (conversation.messages as Array<Record<string, unknown>>) : [];
    const answeredIndex = messages.findIndex((message) => String(message.id) === userMessageId);
    if (answeredIndex < 0) return none;
    // Owner 2026-10-26: photos go with the question they were added to and with the one next question (often "a ile
    // tłuszczu?"); after that the earlier answer about them is enough, and they no longer steer other topics or cost.
    const recentQuestions = messages.slice(0, answeredIndex + 1).filter((message) => String(message.role ?? '').toUpperCase() === 'USER').slice(-CONVERSATION_PHOTO_QUESTIONS);
    const withPhotos = [...recentQuestions].reverse().find((message) => messagePhotoIds(message.metadata).length > 0);
    if (!withPhotos) return none;
    const images: AiUserImage[] = [];
    let unavailable = 0;
    for (const photoId of messagePhotoIds(withPhotos.metadata)) {
      try {
        const data = await this.mealPhotoStorage.read(patientId, photoId);
        images.push({ media_type: 'image/jpeg', data_base64: data.toString('base64') });
      } catch {
        // A missing file only leaves that photo out; the answer goes on with the rest and says one could not be read.
        unavailable += 1;
      }
    }
    return { images, unavailable };
  }

  private async executeCancellableAi(input: object, conversationId: string, userMessageId: string, patientId?: string): ReturnType<AiGateway['execute']> {
    const controller = new AbortController();
    Object.defineProperty(input, 'abort_signal', { value: controller.signal, enumerable: false, configurable: true });
    // The caregiver sees the answer while the model writes it; like the abort signal, never part of the task hash.
    const draft = patientId ? this.startReplyDraft('CONVERSATION', conversationId, patientId, userMessageId) : null;
    if (draft) {
      Object.defineProperty(input, 'reply_draft_observer', { value: { onDraft: (text: string) => draft.update(text) }, enumerable: false, configurable: true });
    }
    const timer = setInterval(() => {
      void this.isAnalysisCancelled(conversationId, userMessageId)
        .then((cancelled) => {
          if (cancelled) controller.abort();
        })
        .catch(() => undefined);
    }, ANALYSIS_CANCELLATION_POLL_MS);
    const aiStartedAt = Date.now();
    let outcome = 'FAILED';
    try {
      const execution = await this.aiGateway.execute(input as Parameters<AiGateway['execute']>[0]);
      outcome = 'SUCCEEDED';
      return execution;
    } finally {
      clearInterval(timer);
      // Where an answer's time goes before and inside the model loop (the model calls and tools: ai_tool_round_timing).
      const marks = this.answerPhaseMarks.get(userMessageId);
      this.answerPhaseMarks.delete(userMessageId);
      this.jobLogger.log(JSON.stringify({
        event: 'answer_phase_timing',
        outcome,
        refresh_ms: marks && marks.refreshed_at !== null ? marks.refreshed_at - marks.job_started_at : null,
        context_ms: marks && marks.refreshed_at !== null ? aiStartedAt - marks.refreshed_at : null,
        ai_ms: Date.now() - aiStartedAt,
      }));
    }
  }

  private async handleAnalysisFollowUp(jobId: string, leaseToken: string, payload: Record<string, unknown>): Promise<void> {
    const patientId = String(payload.patient_id);
    const conversationId = String(payload.conversation_id);
    const questionId = typeof payload.question_id === 'string' ? String(payload.question_id) : null;

    const conversation = (await this.repository.getConversation(patientId, conversationId)) as any;
    if (!conversation) {
      throw new Error('INSUFFICIENT_DATA');
    }

    if (!conversation.episode_id) {
      await this.handleUserConversationAnalysisFollowUp({
        jobId,
        leaseToken,
        patientId,
        conversation,
        questionId,
      });
      return;
    }

    // Hypos are discussed in their conversation's chat; queued follow-ups of older hypo conversations no longer run
    // the static hypo analysis.
    await this.repository.finalizeJobSuccess(jobId, leaseToken, new Date().toISOString());
  }

  private async handleUserConversationAnalysisFollowUp(args: {
    jobId: string;
    leaseToken: string;
    patientId: string;
    conversation: Record<string, unknown>;
    questionId: string | null;
  }): Promise<void> {
    const { jobId, leaseToken, patientId, conversation, questionId } = args;
    const conversationId = String((conversation as any).id);

    if ((conversation as any).recommendation_id) {
      await this.repository.finalizeJobSuccess(jobId, leaseToken, new Date().toISOString());
      return;
    }

    const investigation = await this.repository.getInvestigationByConversation(patientId, conversationId);
    if (!investigation) {
      throw new Error('INSUFFICIENT_DATA');
    }

    if (investigation.state === 'QUESTION_PENDING' || investigation.state === 'FINISHED_ASK_LATER') {
      await this.repository.finalizeJobSuccess(jobId, leaseToken, new Date().toISOString());
      return;
    }

    const eventFamily = investigation.event_family ?? 'USER';
    const candidates = getCandidateRegistry(eventFamily);
    const factRows = await this.repository.listEventScopedPatientContextByFactKeys({
      patientId,
      eventId: investigation.event_id,
      conversationId,
      factKeys: [...new Set(candidates.map((candidate) => candidate.fact_key))],
    });

    const factByKey = new Map<string, Record<string, unknown>>();
    for (const row of factRows) {
      const factKey = String(row.fact_key ?? '');
      if (!factByKey.has(factKey)) {
        factByKey.set(factKey, row);
      }
    }

    const knownFacts: Array<Record<string, unknown>> = [];
    const unknownFacts: Array<Record<string, unknown>> = [];
    const missingFacts: Array<Record<string, unknown>> = [];
    for (const candidate of candidates) {
      const fact = factByKey.get(candidate.fact_key);
      if (!fact) {
        missingFacts.push({
          fact_key: candidate.fact_key,
          reason: 'MISSING',
        });
        continue;
      }

      const knowledgeStatus = String(fact.knowledge_status ?? '').toUpperCase();
      if (knowledgeStatus === 'UNKNOWN') {
        unknownFacts.push({
          fact_key: candidate.fact_key,
          fact_name: String(fact.fact_name ?? candidate.fact_name),
          reason: 'UNKNOWN',
          source_refs: [String(fact.source_ref ?? '')],
        });
        continue;
      }

      knownFacts.push({
        fact_key: candidate.fact_key,
        statement: `${String(fact.fact_name ?? candidate.fact_name)} confirmed in conversation context.`,
        value: fact.value,
        source_refs: [String(fact.source_ref ?? '')],
      });
    }

    const analysisStatus = knownFacts.length > 0 || unknownFacts.length > 0 ? 'COMPLETED' : 'INSUFFICIENT_DATA';
    const analysisUnknowns = [
      ...unknownFacts,
      ...missingFacts,
    ];

    const analysis = await this.repository.insertAnalysis({
      patientId,
      episodeId: null,
      triggerId: null,
      // Label only: this follow-up runs no AI task (rows before 2026-10-17 carry the removed hypo task's name).
      taskType: 'USER_INVESTIGATION_FOLLOW_UP',
      status: analysisStatus,
      facts: knownFacts,
      unknowns: analysisUnknowns,
      calculations: [],
      hypotheses: [],
      assumptions: [],
      uncertainty: {
        material_unresolved_blocker: missingFacts.length > 0,
      },
      question: null,
      proposal: null,
      rationale: knownFacts.length > 0
        ? 'Conversation-derived context is sufficient to close this user-origin investigation path.'
        : 'Conversation-derived context remains insufficient for a stronger analysis outcome.',
      analysisVersion: 'analysis.v1.1',
      contextPackageId: null,
      contextPackageVersion: null,
      contextPackageHash: null,
      inputHash: null,
      promptVersion: null,
      modelFingerprint: null,
    });

    const recommendationPersisted = await this.persistRecommendationForAnalysis({
      patientId,
      analysisId: String(analysis.id),
      episodeId: null,
      triggerId: null,
      contextPackageId: null,
      contextPackageHash: null,
      historicalSourceRefs: new Set<string>(),
      aiExecutionRef: null,
      sourceVersions: {
        triggerRuleVersion: 'USER',
        contextPackageVersion: null,
      },
    });

    const recommendation = recommendationPersisted.recommendation;

    await this.repository.setConversationAwaitingUserAnswer({
      conversationId,
      awaitingUserAnswer: false,
    });

    await this.repository.linkConversation({
      conversationId,
      analysisId: String(analysis.id),
      recommendationId: String(recommendation.id),
    });

    const assistantMessage = knownFacts.length > 0
      ? 'Dziekuje za doprecyzowanie. Uwzglednilem te informacje w analizie dzisiejszych hipoglikemii. Podsumowanie decyzji znajdziesz ponizej w rekomendacji.'
      : 'Dziekuje za odpowiedz. Uwzglednilem ja w analizie, ale czesc danych pozostaje niepelna. Podsumowanie decyzji znajdziesz ponizej w rekomendacji.';

    await this.repository.insertMessage({
      conversationId,
      patientId,
      role: 'ASSISTANT',
      messageType: 'ASSISTANT_MESSAGE',
      content: assistantMessage,
      questionId: null,
      answerType: null,
      answerText: null,
      answerValue: null,
      provenanceRef: `analysis/${analysis.id}`,
      metadata: {
        source: 'user-investigation-follow-up',
        decision: 'INVESTIGATION_RESOLVED',
        question_id: questionId,
        analysis_id: analysis.id,
        recommendation_id: recommendation.id,
      },
      idempotencyKey: `assistant-message:user-investigation:${conversationId}:${analysis.id}`,
    });

    await this.repository.markInvestigationClosed({
      investigationId: investigation.id,
      state: 'RESOLVED',
    });

    await this.repository.finalizeJobSuccess(jobId, leaseToken, new Date().toISOString());
  }

  private async persistRecommendationForAnalysis(args: {
    patientId: string;
    analysisId: string;
    episodeId: string | null;
    triggerId: string | null;
    contextPackageId: string | null;
    contextPackageHash: string | null;
    historicalSourceRefs: Set<string>;
    aiExecutionRef: string | null;
    sourceVersions: {
      triggerRuleVersion: string;
      contextPackageVersion: string | null;
    };
  }): Promise<{
    recommendation: Record<string, unknown>;
    recommendationDecision: ReturnType<typeof deriveRecommendationDecision>;
    recommendationProposal: Record<string, unknown>;
    recommendationSummary: string;
  }> {
    const analysisRecord = await this.repository.getAnalysis(args.patientId, args.analysisId);
    if (!analysisRecord) {
      throw new Error('INSUFFICIENT_DATA');
    }

    // The analyses saved here carry no question and no proposal: the recommendation rests on the evidence alone.
    const recommendationDecision = deriveRecommendationDecision({
      analysisStatus: String(analysisRecord.status ?? 'INSUFFICIENT_DATA'),
      facts: Array.isArray(analysisRecord.facts) ? analysisRecord.facts : [],
      uncertainty: (analysisRecord.uncertainty as Record<string, unknown> | null) ?? null,
    });

    const recommendationEvidence = buildRecommendationEvidenceEntries({
      facts: Array.isArray(analysisRecord.facts) ? analysisRecord.facts : [],
      hypotheses: Array.isArray(analysisRecord.hypotheses) ? analysisRecord.hypotheses : [],
      calculations: Array.isArray(analysisRecord.calculations) ? analysisRecord.calculations : [],
      historicalSourceRefs: args.historicalSourceRefs,
    });

    const recommendationSummary = typeof analysisRecord.rationale === 'string' && analysisRecord.rationale.length > 0
      ? analysisRecord.rationale
      : 'Z tej analizy nie wynika żadna konkretna sugestia.';

    const supportingEvidenceRefs = recommendationEvidence
      .filter((entry) => entry.role === 'SUPPORTING')
      .map((entry) => entry.ref)
      .slice(0, 50);

    const recommendationProposal = buildDeterministicRecommendationProposal({
      decisionStatus: recommendationDecision.status,
      summary: recommendationSummary,
      supportingEvidenceRefs,
    });

    const recommendation = await this.repository.insertRecommendation({
      patientId: args.patientId,
      analysisId: args.analysisId,
      episodeId: args.episodeId,
      status: recommendationDecision.status,
      facts: Array.isArray(analysisRecord.facts) ? analysisRecord.facts : [],
      unknowns: Array.isArray(analysisRecord.unknowns) ? analysisRecord.unknowns : [],
      calculations: Array.isArray(analysisRecord.calculations) ? analysisRecord.calculations : [],
      hypotheses: Array.isArray(analysisRecord.hypotheses) ? analysisRecord.hypotheses : [],
      proposal: recommendationProposal,
      evidence: recommendationEvidence,
      provenance: {
        trigger_id: args.triggerId,
        analysis_id: args.analysisId,
        context_package_id: args.contextPackageId,
        context_package_hash: args.contextPackageHash,
        recommendation_version: 'recommendation.v1',
        recommendation_policy_version: 'recommendation-policy.v1',
        decision_rule: recommendationDecision.rule,
        recommendation_status: recommendationDecision.status,
        recommendation_type: recommendationDecision.recommendationType,
        question_ref: null,
        ai_execution_ref: args.aiExecutionRef,
        source_versions: {
          trigger_rule_version: args.sourceVersions.triggerRuleVersion,
          context_package_version: args.sourceVersions.contextPackageVersion,
          analysis_version: 'analysis.v1.1',
        },
      },
    });

    return {
      recommendation,
      recommendationDecision,
      recommendationProposal,
      recommendationSummary,
    };
  }

  private async handleInvestigationReEvaluate(jobId: string, leaseToken: string, payload: Record<string, unknown>): Promise<void> {
    const patientId = String(payload.patient_id);
    const conversationId = String(payload.conversation_id);

    const conversation = (await this.repository.getConversation(patientId, conversationId)) as any;
    if (!conversation) {
      throw new Error('INSUFFICIENT_DATA');
    }

    // A hypo conversation asks no more questions (its form replaced them): an answer to an old card ends here.
    if (conversation.episode_id) {
      await this.repository.finalizeJobSuccess(jobId, leaseToken, new Date().toISOString());
      return;
    }

    const investigation = await this.repository.getInvestigationByConversation(patientId, String(conversation.id));
    const alreadyFinalized = Boolean(conversation.recommendation_id)
      || String(investigation?.state ?? '') === 'RESOLVED'
      || String(investigation?.state ?? '') === 'CLOSED';

    if (alreadyFinalized) {
      await this.repository.finalizeJobSuccess(jobId, leaseToken, new Date().toISOString());
      return;
    }

    const sourceEventId = typeof payload.source_event_id === 'string' && payload.source_event_id ? payload.source_event_id : null;
    const evaluation = await this.repository.evaluateInvestigationForEvent({
      patientId,
      eventId: sourceEventId,
      eventFamily: 'USER',
      conversationId: String(conversation.id),
      episodeId: null,
      triggerId: null,
      phase: 'RE_EVALUATE',
    });

    if (evaluation.state === 'QUESTION_PENDING') {
      await this.repository.finalizeJobSuccess(jobId, leaseToken, new Date().toISOString());
      return;
    }

    if (evaluation.shouldProceedToAnalysis) {
      await this.repository.insertJob({
        jobType: 'analysis.follow_up',
        payloadVersion: 1,
        payload: {
          patient_id: patientId,
          conversation_id: String(conversation.id),
          question_id: payload.question_id ?? null,
        },
        dedupeKey: `analysis.follow_up:re-eval:${String(conversation.id)}:${sourceEventId ?? 'user'}`,
        correlationId: String(conversation.id),
        causationId: null,
        patientId,
        availableAt: new Date().toISOString(),
        maxAttempts: 5,
      });
    }

    await this.repository.finalizeJobSuccess(jobId, leaseToken, new Date().toISOString());
  }

  /**
   * answer-ready-push.v1: the caregiver asked and may have put the phone away. Once the answer is stored (main chat, hypo
   * chat, meal chat), or the question failed for good, the asking caregiver's phones with "Gotowa odpowiedź" on get a
   * push; the app shows no banner while it is open. Other caregivers' phones get nothing (it was not their question). A
   * cancelled question or one with no stored answer pushes nothing. Never throws: the job is already finished.
   */
  private async pushAnswerOutcome(claimed: { job_type: string; payload: Record<string, unknown> }, outcome: 'ready' | 'failed'): Promise<void> {
    if (!ANSWER_PUSH_JOB_TYPES.has(claimed.job_type)) return;
    const logRef = { job_type: claimed.job_type, question_message_id: String(claimed.payload.user_message_id ?? '') };
    try {
      const push = await this.answerPushContent(claimed.job_type, claimed.payload, outcome);
      if (!push) return;
      // A job rerun after its lease ran out (> 300 s) finishes again: only the first finish pushes (migration 083).
      if (!(await this.claimAnswerPush(push.patientId, push.questionMessageId, outcome))) {
        this.jobLogger.log(JSON.stringify({ event: 'answer_push_skipped', ...logRef, outcome, reason: 'ALREADY_PUSHED' }));
        return;
      }
      const devices = (await this.repository.listActivePatientDevices(push.patientId, 'ios'))
        .filter((device) => device.user_id === push.authorUserId && device.answer_ready_push_enabled !== false);
      const { delivered } = await this.sendToEachDevice(devices, (device) => this.pushNotificationService.sendAnswerReady({
        patientId: push.patientId,
        pushToken: device.push_token,
        target: push.target,
        questionMessageId: push.questionMessageId,
        title: outcome === 'ready' ? ANSWER_READY_PUSH_TITLE : ANSWER_FAILED_PUSH_TITLE,
        body: push.body,
      }), { event: 'answer_push_failed', ...logRef });
      this.jobLogger.log(JSON.stringify({ event: 'answer_push_sent', ...logRef, outcome, devices: delivered }));
    } catch (error) {
      this.jobLogger.warn(JSON.stringify({ event: 'answer_push_failed', ...logRef, error_code: safeJobErrorCode(error) }));
    }
  }

  /** First caller per question and outcome; without migration 083 (or when the claim fails) the push goes out as before. */
  private async claimAnswerPush(patientId: string, questionMessageId: string, outcome: 'ready' | 'failed'): Promise<boolean> {
    const repository = this.repository as Partial<Pick<PostgresGlucoMindRepository, 'claimAnswerPush'>>;
    if (typeof repository.claimAnswerPush !== 'function') return true;
    try {
      return await repository.claimAnswerPush({ patientId, questionMessageId, outcome });
    } catch (error) {
      this.jobLogger.warn(JSON.stringify({ event: 'answer_push_claim_failed', question_message_id: questionMessageId, error_code: safeJobErrorCode(error) }));
      return true;
    }
  }

  /**
   * One push per phone: a phone whose token APNs rejected is deactivated and every failure is logged (ids and error
   * codes only, never message content); one bad phone never stops the others. Returns what reached a phone.
   */
  private async sendToEachDevice<T extends { push_token: string }>(
    devices: T[],
    send: (device: T) => Promise<unknown>,
    failureLog: { event: string } & Record<string, unknown>,
  ): Promise<{ delivered: number; errors: unknown[] }> {
    let delivered = 0;
    const errors: unknown[] = [];
    for (const device of devices) {
      try {
        await send(device);
        delivered += 1;
      } catch (error) {
        await this.deactivateDeadPushToken(device.push_token, error);
        this.jobLogger.warn(JSON.stringify({ ...failureLog, error_code: safeJobErrorCode(error) }));
        errors.push(error);
      }
    }
    return { delivered, errors };
  }

  /** A token APNs called invalid or unregistered belongs to no phone any more: that phone stops getting pushes. */
  private async deactivateDeadPushToken(pushToken: string, error: unknown): Promise<void> {
    if (error instanceof PushNotificationProviderError && (error.code === 'DEVICE_TOKEN_INVALID' || error.code === 'DEVICE_TOKEN_UNREGISTERED')) {
      await this.repository.deactivatePatientDevicesByPushToken('ios', pushToken);
    }
  }

  /**
   * Who asked, where the answer is and the push text; null when there is nothing to tell: a cancelled question, "ready"
   * with no stored answer, or "failed" although an answer was stored (an earlier run of the job stored it).
   */
  private async answerPushContent(jobType: string, payload: Record<string, unknown>, outcome: 'ready' | 'failed'): Promise<{
    patientId: string;
    authorUserId: string;
    target: { conversationId: string } | { mealId: string };
    questionMessageId: string;
    body: string;
  } | null> {
    const patientId = String(payload.patient_id ?? '');
    const userMessageId = String(payload.user_message_id ?? '');
    if (!patientId || !userMessageId) return null;

    // Meal chat has no cancel (no Stop button): only the stored reply decides.
    if (jobType === MEAL_CHAT_REPLY_JOB_TYPE) {
      const mealRecordId = String(payload.meal_record_id ?? '');
      const chat = this.mealChatRepository;
      if (!mealRecordId || !chat) return null;
      const question = await chat.getMessage(patientId, mealRecordId, userMessageId);
      const authorUserId = typeof question?.author_user_id === 'string' ? question.author_user_id : null;
      if (!authorUserId) return null;
      const reply = (await chat.listMessages(patientId, mealRecordId)).find((message) => message.role === 'ASSISTANT' && message.reply_to_message_id === userMessageId);
      if (outcome === 'ready' ? !reply : reply) return null;
      const body = reply ? answerPushBody(reply.content) : ANSWER_FAILED_PUSH_BODY;
      return { patientId, authorUserId, target: { mealId: mealRecordId }, questionMessageId: userMessageId, body };
    }

    const conversationId = String(payload.conversation_id ?? '');
    if (!conversationId) return null;
    const question = await this.repository.getMessageById(conversationId, userMessageId);
    const authorUserId = typeof question?.author_user_id === 'string' ? question.author_user_id : null;
    if (!authorUserId) return null;
    if (await this.isAnalysisCancelled(conversationId, userMessageId)) return null;
    const kind = jobType === 'conversation.time_range_analysis' ? 'analysis' : 'direct';
    const answer = await this.repository.getMessageByIdempotencyKey(conversationId, `assistant-message:${kind}:${conversationId}:${userMessageId}`);
    if (outcome === 'ready' ? !answer : answer) return null;
    const body = answer ? answerPushBody(String(answer.content ?? '')) : ANSWER_FAILED_PUSH_BODY;
    return { patientId, authorUserId, target: { conversationId }, questionMessageId: userMessageId, body };
  }

  private async handleConversationQuestionPush(jobId: string, leaseToken: string, payload: Record<string, unknown>): Promise<void> {
    const patientId = String(payload.patient_id);
    const conversationId = String(payload.conversation_id);
    const questionId = String(payload.question_id);
    const dedupeKey = String(payload.notification_dedupe_key);

    const notification = await this.repository.getPushNotificationByDedupeKey(dedupeKey);
    if (notification?.status === 'sent') {
      await this.repository.finalizeJobSuccess(jobId, leaseToken, new Date().toISOString());
      return;
    }

    const hasCurrentRelationship = await this.repository.patientHasAnyCaregiverRelationship(patientId);
    if (!hasCurrentRelationship) {
      await this.repository.insertAuditEvent({
        eventType: 'PUSH_AUTHORIZATION_DENIED',
        outcome: 'DENY',
        provider: 'COGNITO',
        providerSubject: null,
        userId: null,
        requestPath: '/internal/notifications.push_conversation_question',
        metadata: {
          patient_id: patientId,
          conversation_id: conversationId,
          question_id: questionId,
          reason: 'NO_ACTIVE_RELATIONSHIP',
        },
      });
      await this.repository.finalizeJobSuccess(jobId, leaseToken, new Date().toISOString());
      return;
    }

    await this.repository.incrementPushNotificationAttempts(dedupeKey);

    const conversation = await this.repository.getConversation(patientId, conversationId);
    const pendingQuestion = (conversation?.pending_question as Record<string, unknown> | null) ?? null;
    if (!conversation || !pendingQuestion || String(pendingQuestion.question_id) !== questionId) {
      await this.repository.finalizeJobSuccess(jobId, leaseToken, new Date().toISOString());
      return;
    }

    const devices = await this.repository.listActivePatientDevices(patientId, 'ios');
    if (devices.length === 0) {
      await this.repository.markPushNotificationFailed({
        dedupeKey,
        retryable: true,
        error: {
          code: 'NO_ACTIVE_DEVICE',
          message: 'No active iOS device token is currently registered for this patient.',
        },
      });
      throw createRetryableError('NO_ACTIVE_DEVICE');
    }
    // Per phone, like the WBT and loop-action senders: a bad token deactivates only that phone, and once one phone
    // got the push the job is done, so a retry never sends it twice to a phone that already has it.
    const { delivered, errors } = await this.sendToEachDevice(devices, (device) => this.pushNotificationService.sendConversationQuestion({
      patientId,
      pushToken: device.push_token,
      conversationId,
      questionId,
      title: CLARIFYING_QUESTION_PUSH.title,
      body: CLARIFYING_QUESTION_PUSH.body,
    }), { event: 'conversation_question_push_failed', conversation_id: conversationId, question_id: questionId });
    // A retryable failure is the one that decides the job when no phone got the push.
    const firstError: unknown = errors.find((error) => isRetryableError(error)) ?? errors[0] ?? null;

    if (delivered > 0 || firstError === null) {
      await this.repository.markPushNotificationSent({ dedupeKey });
      await this.repository.finalizeJobSuccess(jobId, leaseToken, new Date().toISOString());
      return;
    }

    const providerError = firstError instanceof PushNotificationProviderError ? firstError : null;
    await this.repository.markPushNotificationFailed({
      dedupeKey,
      retryable: isRetryableError(firstError),
      error: {
        code: providerError?.code ?? 'PUSH_DELIVERY_ERROR',
        message: firstError instanceof Error ? firstError.message : String(firstError),
      },
    });
    throw firstError;
  }
}

function buildRecommendationEvidenceEntries(args: {
  facts: unknown[];
  hypotheses: unknown[];
  calculations: unknown[];
  historicalSourceRefs: Set<string>;
}): Array<{ evidence_family: 'CURRENT' | 'HISTORICAL' | 'HYPOTHESIS' | 'CALCULATION'; ref: string; role: 'SUPPORTING' | 'OPPOSING' | 'CONTEXTUAL' }> {
  const entries: Array<{ evidence_family: 'CURRENT' | 'HISTORICAL' | 'HYPOTHESIS' | 'CALCULATION'; ref: string; role: 'SUPPORTING' | 'OPPOSING' | 'CONTEXTUAL' }> = [];
  const seen = new Set<string>();

  const push = (entry: { evidence_family: 'CURRENT' | 'HISTORICAL' | 'HYPOTHESIS' | 'CALCULATION'; ref: string; role: 'SUPPORTING' | 'OPPOSING' | 'CONTEXTUAL' }) => {
    const key = `${entry.evidence_family}:${entry.role}:${entry.ref}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    entries.push(entry);
  };

  for (const fact of args.facts) {
    const sourceRefs = (fact as { source_refs?: unknown }).source_refs;
    if (!Array.isArray(sourceRefs)) {
      continue;
    }

    for (const sourceRef of sourceRefs) {
      if (typeof sourceRef !== 'string' || sourceRef.length === 0) {
        continue;
      }

      push({
        evidence_family: args.historicalSourceRefs.has(sourceRef) ? 'HISTORICAL' : 'CURRENT',
        ref: sourceRef,
        role: 'SUPPORTING',
      });
    }
  }

  for (const hypothesis of args.hypotheses) {
    const supporting = (hypothesis as { supporting_evidence_refs?: unknown }).supporting_evidence_refs;
    if (Array.isArray(supporting)) {
      for (const sourceRef of supporting) {
        if (typeof sourceRef === 'string' && sourceRef.length > 0) {
          push({ evidence_family: 'HYPOTHESIS', ref: sourceRef, role: 'SUPPORTING' });
        }
      }
    }

    const opposing = (hypothesis as { opposing_evidence_refs?: unknown }).opposing_evidence_refs;
    if (Array.isArray(opposing)) {
      for (const sourceRef of opposing) {
        if (typeof sourceRef === 'string' && sourceRef.length > 0) {
          push({ evidence_family: 'HYPOTHESIS', ref: sourceRef, role: 'OPPOSING' });
        }
      }
    }
  }

  for (const calculation of args.calculations) {
    const id = (calculation as { calculation_id?: unknown }).calculation_id;
    if (typeof id !== 'string' || id.length === 0) {
      continue;
    }

    push({ evidence_family: 'CALCULATION', ref: id, role: 'CONTEXTUAL' });
  }

  return entries;
}

/** The recommendation card: an observation with the analysis summary (no question or proposal reaches it any more). */
function buildDeterministicRecommendationProposal(args: {
  decisionStatus: ReturnType<typeof deriveRecommendationDecision>['status'];
  summary: string;
  supportingEvidenceRefs: string[];
}): Record<string, unknown> {
  const title = args.decisionStatus === 'INSUFFICIENT_DATA'
    ? 'Za mało danych'
    : args.decisionStatus === 'NO_ACTIONABLE_RECOMMENDATION'
      ? 'Brak sugestii'
      : 'Warto obserwować';

  return {
    type: 'OBSERVATION',
    title,
    text: args.summary,
    recommendation_type: 'NO_ACTION',
    safety_boundary: 'NON_AUTONOMOUS',
    supporting_evidence_refs: args.supportingEvidenceRefs,
    question_ref: null,
  };
}

/**
 * A log-safe error code. Free-text messages are never logged (database errors can quote the values involved): only an
 * explicit `code` (SQLSTATE, Node errno, AiExecutionError) or a message that is itself an UPPER_SNAKE_CASE code.
 */
export function safeJobErrorCode(error: unknown): string {
  const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
  if (typeof code === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(code)) {
    return code;
  }
  const message = error instanceof Error ? error.message : '';
  if (/^[A-Z][A-Z0-9_]{2,63}$/.test(message)) {
    return message;
  }
  return 'UNCLASSIFIED_ERROR';
}

function isRetryableError(error: unknown): boolean {
  if (error && typeof error === 'object' && 'retryable' in error && typeof (error as { retryable: unknown }).retryable === 'boolean') {
    return Boolean((error as { retryable: boolean }).retryable);
  }

  if (!(error instanceof Error)) {
    return false;
  }

  const retryableCodes = new Set(['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENETUNREACH', 'ECONNREFUSED', '57P01', '57P02', '57P03', '40001', '40P01']);
  const code = (error as Error & { code?: string }).code;
  return code ? retryableCodes.has(code) : false;
}

function createRetryableError(message: string): Error & { retryable: true } {
  const error = new Error(message) as Error & { retryable: true };
  error.retryable = true;
  return error;
}

function toIsoTimestamp(value: unknown): string | null {
  if (!value) {
    return null;
  }

  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  }

  if (typeof value === 'string') {
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
  }

  return null;
}

/** Messages back to the answered one that may still lend it their photos (the answered message included). */
/**
 * A reply being written without its "**Propozycja:** X j" lines (and a line just starting one): the dose shows only in
 * the final answer, with the notes the server adds after checking it.
 */
export function withoutDraftDoseLine(draft: string): string {
  const lines = draft.split('\n');
  const kept = lines.filter((line, index) => {
    const trimmed = line.trimStart();
    if (/^\*{0,2}propozycja\b/i.test(trimmed)) return false;
    // The last line may be the start of one ("**Prop").
    return !(index === lines.length - 1 && trimmed.length > 0 && '**propozycja:'.startsWith(trimmed.toLowerCase()));
  });
  return kept.join('\n');
}

/** The question a photo was added to and the next one. */
const CONVERSATION_PHOTO_QUESTIONS = 2;

/** A conversation message as the AI sees it: caregiver messages with photos are marked, photo-only ones say so. */
function conversationMessageTextForAi(message: { content?: unknown; metadata?: unknown }): string {
  const content = String(message.content ?? '');
  if (messagePhotoIds(message.metadata).length === 0) return content;
  return content.trim() ? `${content} [dołączone zdjęcie]` : '[zdjęcie bez opisu]';
}

/** An answer's text with the list of the cards it prepared (card-context.v1). */
function withCardNote(text: string, note: string | undefined): string {
  return note ? `${text}\n\n${note}` : text;
}

/** The answered question: a photo sent without text still reads as a question about the photo. */
function userQuestionTextForAi(message: { content?: unknown; metadata?: unknown }): string {
  const content = String(message.content ?? '');
  return content.trim() || messagePhotoIds(message.metadata).length === 0 ? content : '[zdjęcie bez opisu]';
}

/** The caregiver's phone said, with this message, that it can give a bolus (remote control set up on it). */
/**
 * Rescue carb cards outside an alert's chat: only when the sending phone can confirm them (rescue_cards in the message's
 * metadata, from builds that have the meals tab's "+" → "Dosłodzenie"), and not in a hypo's conversation, whose report
 * form already records the treatment.
 */
export function allowsChatRescueCards(conversation: { messages?: unknown; trigger_type?: unknown }, userMessageId: string): boolean {
  if (String(conversation.trigger_type ?? '') === 'HYPO_DETECTED') return false;
  const messages = Array.isArray(conversation.messages) ? (conversation.messages as Array<Record<string, unknown>>) : [];
  const metadata = messages.find((message) => String(message.id) === userMessageId)?.metadata;
  return typeof metadata === 'object' && metadata !== null && (metadata as Record<string, unknown>).rescue_cards === true;
}

/** Answers a caregiver is waiting for in the chat: a failed attempt is retried within seconds, not a minute. */
const INTERACTIVE_RETRY_SECONDS = [5, 15];
const INTERACTIVE_JOB_TYPES = new Set(['conversation.direct_response', 'conversation.time_range_analysis']);
/** Jobs that answer the caregiver's question: their outcome is pushed to the asking caregiver (answer-ready-push.v1). */
const ANSWER_PUSH_JOB_TYPES = new Set(['conversation.direct_response', 'conversation.time_range_analysis', MEAL_CHAT_REPLY_JOB_TYPE]);

/** Seconds before the next attempt: 5 s, 15 s, then 60 s doubling for chat answers; 60 s doubling (max 30 min) otherwise. */
export function retryBackoffSeconds(jobType: string, attempts: number): number {
  const failedAttempt = Math.max(1, attempts);
  if (INTERACTIVE_JOB_TYPES.has(jobType)) {
    if (failedAttempt <= INTERACTIVE_RETRY_SECONDS.length) return INTERACTIVE_RETRY_SECONDS[failedAttempt - 1];
    return Math.min(60 * 2 ** (failedAttempt - INTERACTIVE_RETRY_SECONDS.length - 1), 60 * 30);
  }
  return Math.min(60 * 2 ** (failedAttempt - 1), 60 * 30);
}

/** "AiExecutionError: Connection error." (class and message, at most 200 characters, one line). */
export function jobErrorDetail(error: unknown): string {
  const name = error instanceof Error ? error.constructor?.name || error.name : typeof error;
  const message = error instanceof Error ? error.message : String(error);
  // Ids (patients, conversations, messages) never go to the log.
  return `${name}: ${message}`.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>').replace(/\s+/g, ' ').slice(0, 200);
}

export function messageAllowsBolusCards(message: Record<string, unknown> | undefined): boolean {
  const metadata = message?.metadata;
  return typeof metadata === 'object' && metadata !== null && (metadata as Record<string, unknown>).bolus_cards === true;
}

/** With the option picker the picker is the next step: no follow-up suggestions (owner 2026-10-22). */
function withoutOptionChoices(selection: { suggestions: string[]; hot: string | null }, hasOptions: boolean): { suggestions: string[]; hot: string | null } {
  return hasOptions ? { suggestions: [], hot: null } : selection;
}

/** "Wybierz opcję poniżej albo napisz własny plan." is the last sentence of an answer with options; without them it goes. */
/** server-corrections.v1: what the server changed in the model's answer, kept on the message for the daily review. */
export interface ServerCorrectionFlag {
  type: 'SERVER_CORRECTION';
  version: 'server-corrections.v1';
  corrections: string[];
}

export function serverCorrectionFlag(kinds: ReadonlyArray<string | false | null | undefined>): ServerCorrectionFlag | null {
  const corrections = [...new Set(kinds.filter((kind): kind is string => typeof kind === 'string' && kind.length > 0))];
  return corrections.length > 0 ? { type: 'SERVER_CORRECTION', version: 'server-corrections.v1', corrections } : null;
}

/** The model's answer offered options (answer_options with at least one entry), before the server checked them. */
export function modelOfferedOptions(raw: unknown): boolean {
  return Array.isArray(raw) && raw.length > 0;
}

export function withoutOptionPointer(text: string, hasOptions: boolean): string {
  if (hasOptions) return text;
  const stripped = text.replace(/\s*Wybierz (?:jedną z )?opcj[eęi][^.!?\n]*[.!?]?\s*$/u, '').trimEnd();
  return stripped || text;
}

/** A meal's WBT conversation, for one answer (wbt-chat.v1). */
interface WbtChat {
  mealRecordId: string;
  context: WbtSuggestionContext;
  current: WbtCurrentProposal | null;
}
