import { Inject, Injectable } from '@nestjs/common';
import { mapWithConcurrency } from '@shared/utils/map-with-concurrency';
import { Pool } from 'pg';
import { NotFoundError, ConflictError, ValidationError, ForbiddenError, StaleWriteError, RescueAlreadyLoggedError } from '@shared/errors/app-error';
import { type AuditProvider, PostgresGlucoMindRepository } from '@infra/db/postgres-glucomind.repository';
import { PostgresMealChatRepository, type MealChatMessage } from '@infra/db/postgres-meal-chat.repository';
import { PostgresReplyDraftRepository, type ReplyThreadKind } from '@infra/db/postgres-reply-drafts.repository';
import { PostgresConversationPhotoRepository } from '@infra/db/postgres-conversation-photo.repository';
import { isJpeg, MealPhotoStorage } from '@modules/meal-chat/infrastructure/meal-photo-storage';
import { parseVoiceUpload, VoiceTranscriptionService } from '@modules/voice-transcription/voice-transcription';
import { buildMealChatReplyDedupeKey, MEAL_CHAT_REPLY_JOB_TYPE } from '@modules/meal-chat/application/meal-chat-reply.job';
import { createHash } from 'node:crypto';
import { AI_INSTRUCTIONS_MAX_LENGTH, AI_USER_ROLES, isAiUserRole, type UserAiPreferences } from '@shared/primitives/user-ai-preferences';
import { PostgresMealWbtRepository, type WbtChatSuggestionRow } from '@infra/db/postgres-meal-wbt.repository';
import { fatProteinUnitsOf, shouldRemindAboutWbt, standardWbtDose, wbtReminderAt } from '@modules/meal-wbt/application/wbt-policy';
import { MEAL_WBT_SUGGESTION_JOB_TYPE } from '@modules/meal-wbt/application/wbt-suggestion.job';
import { DATABASE_POOL } from '@infra/db/database.tokens';
import { readPhoneLimits } from '@modules/remote-commands/application/phone-limits';
import {
  createInvestigationCandidateFromQuestionId,
  determineUserMessageCapability,
  isSocialMessage,
  UserMessageCapability,
} from '@modules/context/application/investigation-policy';
import { answerDisplayText } from '@modules/context/application/hypo-question-candidates';
import { ConversationTimeRangeType } from '@modules/context/application/time-range-normalization';
import { routeUserMessage } from '@modules/context/application/message-routing';
import { PostgresMealEntryDetachment, PostgresMealRecordRepository } from '@infra/db/postgres-meal-history.repository';
import { PostgresLoopActionRepository } from '@infra/db/postgres-loop-actions.repository';
import {
  LOOP_ACTION_POLICY,
  summarizeMealInsulin,
  type MealInsulinSummary,
} from '@modules/loop-actions/application/loop-action-policy';
import { LOOP_ACTION_TIME_ZONE } from '@modules/loop-actions/application/loop-action-views';
import { PostgresNotificationHistoryRepository, type NotificationHistoryRow } from '@infra/db/postgres-notification-history.repository';
import { PostgresDashboardRepository } from '@infra/db/postgres-dashboard.repository';
import type { DashboardResponse } from '@modules/dashboard/application/dashboard-snapshot';
import { DashboardAssembler, patientNightscoutReadersFromEnv } from '@modules/dashboard/application/dashboard-assembler';
import { PostgresLiveActivityRepository, type LiveActivityDeviceChange } from '@infra/db/postgres-live-activity.repository';
import type { DashboardInsulin } from '@modules/dashboard/application/dashboard-snapshot';
import { buildDashboardHistory, parseDashboardHistoryWindow, type DashboardHistoryResponse } from '@modules/dashboard/application/dashboard-history';
import { buildDashboardTimeInRange, parseDashboardTimeInRangeDays, type DashboardTimeInRangeResponse } from '@modules/dashboard/application/dashboard-time-in-range';
import { isTrustedMealRecord, type MealRecord } from '@modules/meal-candidates/application/meal-record-trust';
import { describeMealItems, sanitizeMealItems } from '@modules/meal-candidates/application/meal-items';
import { PostgresConversationMealActionRepository } from '@infra/db/postgres-conversation-meal-actions.repository';
import { continuesMealAssistant, isMealActionsEnabled, isMealEditRequest } from '@modules/meal-actions/application/meal-edit-intent';
import { ConversationMealActionsService, toMealActionView, type MealActionRecord } from '@modules/meal-actions/application/conversation-meal-actions.service';
import { parseUserMessageResponseState, type UserMessageCancellationOutcome } from '@modules/analysis/application/user-message-cancellation';
import { isRemoteCommandsServerEnabled, resolveRemoteControlAccess, type RemoteControlAccess } from '@modules/remote-commands/application/remote-control-access';
import { readAiLimitStatus, type AiLimitView } from '@modules/ai-gateway/infrastructure/ai-limit-status';
import { readTrioRemoteTarget, type TrioRemoteTarget } from '@modules/remote-commands/application/trio-remote-target';
import { RemoteCommandsService, type RemoteCommandPreview, type RemoteCommandRequest, type RemoteCommandView } from '@modules/remote-commands/application/remote-commands.service';
import { pumpBolusStep, type RemoteCommandContext, type RemoteCommandSource } from '@modules/remote-commands/application/remote-command-policy';
import { remoteCommandContextFrom } from '@modules/remote-commands/application/remote-command-context';
import { mealForecastDataFrom, type MealForecastData } from '@modules/remote-commands/application/meal-dose-forecast';
import { parseBolusReminders } from '@modules/remote-commands/application/bolus-reminders';
import { PostgresRemoteCommandRepository } from '@infra/db/postgres-remote-commands.repository';
import { PostgresBolusProposalRepository, type BolusProposalWithCommand } from '@infra/db/postgres-bolus-proposals.repository';
import { sentCommandView, toBolusProposalView } from '@modules/remote-commands/application/bolus-proposal-tool';
import { mealRemoteBolusView, type MealRemoteBolusView } from '@modules/remote-commands/application/meal-remote-bolus';
import { PlannedBolusService } from '@modules/remote-commands/application/planned-bolus.service';
import { estimatePlannedBolus, manualInsulinForPart, mealDoseExcess, mealExcessLine, OPEN_PLANNED_BOLUS_STATUSES, toPlannedBolusSummary, type PlannedBolusRecord, type PlannedBolusSummary, type SecondPartEstimate } from '@modules/remote-commands/application/split-bolus';
import { PostgresPushOutboxRepository } from '@infra/db/postgres-push-outbox.repository';
import { nightscoutHistoryImportProgress } from '@modules/integrations/nightscout/application/nightscout-history-backfill';
import { PostgresPlannedBolusRepository } from '@infra/db/postgres-planned-boluses.repository';
import { scheduleValueAt } from '@modules/meal-wbt/application/wbt-policy';
import { parseLoopPrediction } from '@modules/loop-system/application/loop-prediction';
import { patientLoopSystem } from '@modules/loop-system/application/patient-loop-system';
import { readLoopRemoteTarget, type LoopRemoteTarget } from '@modules/remote-commands/application/loop-remote-target';
import { loopSystemNames, type LoopSystem } from '@modules/loop-system/domain/loop-system';
import type { BolusForecastInputs } from '@modules/glucose-forecast/application/bolus-forecast';
import { PostgresRescueCarbsRepository, type DeviceNotificationSettings } from '@infra/db/postgres-rescue-carbs.repository';
import { parseRescueCarbs, parseRescueGivenAt, RESCUE_CHART_AFTER_MS, RESCUE_CHART_BEFORE_MS, toRescueCarbsView, withRescueCarbProposals } from '@modules/rescue-carbs/application/rescue-carbs-view';

import { resolveHomeTimeZone } from '@shared/primitives/home-time-zone';
import { toCareReminderView, type CareReminderRecord } from '@modules/care-reminders/application/care-reminders';
import { PostgresCareReminderRepository } from '@infra/db/postgres-care-reminders.repository';
import { PostgresMealJournalRepository } from '@infra/db/postgres-meal-journal.repository';
import { givenSinceMeal, type GivenSinceMeal } from '@modules/remote-commands/application/bolus-reminders';
import {
  MEAL_JOURNAL_POLICY,
  buildJournalItem,
  chartOtherBoluses,
  clampJournalLimit,
  journalBoluses,
  journalTimeline,
  likePattern,
  parseMealSearchQuery,
  type JournalAction,
  type JournalFacts,
  type JournalItem,
} from '@modules/meal-journal/application/meal-journal';
import { RequestPrincipal } from '../auth/bearer-principal.guard';
import { DeviceAuthService } from './device-auth.service';

/** Ids in paths and bodies (patients, conversations, meals, …): anything else is refused before it reaches SQL. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Rows of a list (a month of meals, loop actions) whose own reads run at once; the pool has 10 connections. */
const LIST_LOAD_CONCURRENCY = 6;

@Injectable()
export class ApiService {
  private readonly mealRecordRepository: PostgresMealRecordRepository;
  private readonly mealChatRepository: PostgresMealChatRepository;
  private readonly conversationPhotoRepository: PostgresConversationPhotoRepository;
  private readonly mealWbtRepository: PostgresMealWbtRepository;
  private readonly mealEntryDetachment: PostgresMealEntryDetachment;
  private readonly loopActions: PostgresLoopActionRepository;
  private readonly conversationMealActionRepository: PostgresConversationMealActionRepository;
  private readonly conversationMealActions: ConversationMealActionsService;
  private readonly notificationHistory: PostgresNotificationHistoryRepository;
  private readonly photoStorage: MealPhotoStorage | null;
  private readonly voiceTranscription: VoiceTranscriptionService | null;
  private readonly dashboardRepository: PostgresDashboardRepository;
  /** The dashboard's data, shared with the worker's Live Activity pushes. */
  private readonly dashboards: DashboardAssembler;
  private readonly liveActivities: PostgresLiveActivityRepository;
  private readonly replyDrafts: PostgresReplyDraftRepository;
  private readonly remoteCommands: RemoteCommandsService;
  private readonly bolusProposals: PostgresBolusProposalRepository;
  private readonly remoteCommandRepository: PostgresRemoteCommandRepository;
  private readonly plannedBolusRepository: PostgresPlannedBolusRepository;
  /** Pushes the API asks for (push-outbox.v1); the worker sends them. */
  private readonly pushOutbox: PostgresPushOutboxRepository;
  private readonly careReminderRepository: PostgresCareReminderRepository;
  private readonly mealJournal: PostgresMealJournalRepository;
  private readonly plannedBoluses: PlannedBolusService;
  private readonly rescueCarbs: PostgresRescueCarbsRepository;
  /** AUTH_MODE=device: every remote command carries the bolus key's signature (device-auth-api.md). */
  private readonly deviceAuth: DeviceAuthService;

  constructor(
    @Inject(PostgresGlucoMindRepository) private readonly repository: PostgresGlucoMindRepository,
    @Inject(DATABASE_POOL) pool: Pool,
  ) {
    this.mealRecordRepository = new PostgresMealRecordRepository(pool);
    this.mealChatRepository = new PostgresMealChatRepository(pool);
    this.replyDrafts = new PostgresReplyDraftRepository(pool);
    this.conversationPhotoRepository = new PostgresConversationPhotoRepository(pool);
    this.mealWbtRepository = new PostgresMealWbtRepository(pool);
    this.mealEntryDetachment = new PostgresMealEntryDetachment(pool);
    this.loopActions = new PostgresLoopActionRepository(pool);
    this.conversationMealActionRepository = new PostgresConversationMealActionRepository(pool, this.mealRecordRepository);
    // Changes confirmed on a conversation card go through the meals tab's own writes (same rules and side effects).
    this.conversationMealActions = new ConversationMealActionsService(this.conversationMealActionRepository, {
      assignLoopAction: (args) => this.loopActions.assign(args),
      setCarbEntryKind: async ({ patientId, eventId, kind, userId }) => {
        if (!(await this.repository.setCarbEntryKind(patientId, eventId, kind, userId))) throw new NotFoundError('Carb entry not found');
        if (kind !== 'MEAL') await this.mealEntryDetachment.detachMealEntriesFromNonMealAnchor(patientId, eventId, userId);
      },
      detachCarbEntry: async ({ patientId, eventId, userId }) => {
        await this.mealEntryDetachment.detachEntry(patientId, eventId, userId);
      },
      setWbtReminder: async ({ patientId, mealRecordId, enabled, userId }) => {
        const record = await this.mealRecordRepository.getMealRecord(patientId, await this.resolveMealIdentity(patientId, mealRecordId));
        await this.mealWbtRepository.setManualReminder({ patientId, mealRecordId, enabled, remindAt: wbtReminderAt(record.started_at), userId });
      },
      afterMealValuesChanged: ({ patientId, mealRecordId, identity }) => this.applyAutoWbtReminder(patientId, mealRecordId, identity),
    });
    this.notificationHistory = new PostgresNotificationHistoryRepository(pool);
    this.photoStorage = MealPhotoStorage.fromEnv(process.env);
    this.voiceTranscription = VoiceTranscriptionService.fromEnv(process.env);
    this.dashboardRepository = new PostgresDashboardRepository(pool);
    // Each patient's own Nightscout (090_sharing_foundation.sql) for the live reads; the synced data otherwise.
    const nightscout = patientNightscoutReadersFromEnv(pool, process.env);
    this.liveActivities = new PostgresLiveActivityRepository(pool);
    this.dashboards = new DashboardAssembler(this.dashboardRepository, repository, nightscout?.careEvents ?? null, nightscout?.live ?? null);
    this.bolusProposals = new PostgresBolusProposalRepository(pool);
    this.remoteCommandRepository = new PostgresRemoteCommandRepository(pool);
    this.plannedBolusRepository = new PostgresPlannedBolusRepository(pool);
    this.pushOutbox = new PostgresPushOutboxRepository(pool);
    this.careReminderRepository = new PostgresCareReminderRepository(pool);
    this.mealJournal = new PostgresMealJournalRepository(pool);
    this.plannedBoluses = new PlannedBolusService({ store: this.plannedBolusRepository, commands: this.remoteCommandRepository });
    this.rescueCarbs = new PostgresRescueCarbsRepository(pool);
    this.deviceAuth = new DeviceAuthService(pool, repository);
    this.remoteCommands = new RemoteCommandsService(
      this.remoteCommandRepository,
      (patientId, now, carbsAt) => this.remoteCommandContext(patientId, now, carbsAt),
      this.bolusProposals,
      this.plannedBolusRepository,
      this.rescueCarbs,
      // Review M2: a planned part is authorized against the server's own later-part estimate (before the calculator).
      async (patientId, plan, now) => (await this.plannedPartEstimate(patientId, plan, await this.resolveMealIdentity(patientId, plan.meal_record_id), now, false)).insulin_u,
    );
  }

  async listAccessiblePatients(
    principal: RequestPrincipal,
  ): Promise<{ user_id: string; user_display_name: string | null; patients: Array<{ patient_id: string; display_name: string; birth_year: number | null }> }> {
    const [patients, userDisplayName] = await Promise.all([
      this.repository.listAccessiblePatients(principal.user_id),
      this.repository.getUserDisplayName(principal.user_id),
    ]);
    return {
      user_id: principal.user_id,
      user_display_name: userDisplayName,
      patients,
    };
  }

  /** "Rok urodzenia": the AI states the patient's age from it; the app asks for it until it is set. */
  async setPatientBirthYear(principal: RequestPrincipal, patientId: string, body: unknown): Promise<{ patient_id: string; birth_year: number }> {
    await this.assertCanWritePatient(principal, patientId);
    const birthYear = (body as Record<string, unknown> | null)?.birth_year;
    const currentYear = new Date().getUTCFullYear();
    if (typeof birthYear !== 'number' || !Number.isInteger(birthYear) || birthYear < 1900 || birthYear > currentYear) {
      throw new ValidationError(`birth_year must be a whole year between 1900 and ${currentYear}`);
    }
    if (!(await this.repository.setPatientBirthYear(patientId, birthYear))) throw new NotFoundError('Patient not found');
    return { patient_id: patientId, birth_year: birthYear };
  }

  /** "Moje instrukcje dla AI": who this user is and their own wishes for the AI (per user, for every patient). */
  async getUserAiPreferences(principal: RequestPrincipal): Promise<UserAiPreferences> {
    return this.repository.getUserAiPreferences(principal.user_id);
  }

  /** Replaces this user's AI preferences; a missing or null field (or blank text) clears it. */
  async setUserAiPreferences(principal: RequestPrincipal, body: unknown): Promise<UserAiPreferences> {
    const input = (body ?? {}) as Record<string, unknown>;
    const role = input.ai_role ?? null;
    if (role !== null && !isAiUserRole(role)) {
      throw new ValidationError(`ai_role must be null or one of ${AI_USER_ROLES.join(', ')}`);
    }
    const rawInstructions = input.ai_instructions ?? null;
    if (rawInstructions !== null && typeof rawInstructions !== 'string') {
      throw new ValidationError('ai_instructions must be a string or null');
    }
    const instructions = rawInstructions?.trim() ?? '';
    // Characters as Postgres counts them (code points), so an emoji is one, like in the app's counter.
    if ([...instructions].length > AI_INSTRUCTIONS_MAX_LENGTH) {
      throw new ValidationError(`ai_instructions must be at most ${AI_INSTRUCTIONS_MAX_LENGTH} characters`);
    }
    const preferences: UserAiPreferences = { ai_role: role, ai_instructions: instructions || null };
    if (!(await this.repository.setUserAiPreferences(principal.user_id, preferences))) throw new NotFoundError('User not found');
    return preferences;
  }

  /** What this caregiver may do for the patient beyond reading and writing data; the app hides what is off. */
  async getCapabilities(principal: RequestPrincipal, patientId: string): Promise<{ patient_id: string; loop_system: LoopSystem; remote_commands: RemoteControlAccess; ai: AiLimitView | null }> {
    await this.assertCanReadPatient(principal, patientId);
    const [switches, loopSystem] = await Promise.all([
      this.repository.getRemoteControlSwitches(principal.user_id, patientId),
      patientLoopSystem(this.dashboardRepository, patientId),
    ]);
    return {
      patient_id: patientId,
      loop_system: loopSystem,
      remote_commands: resolveRemoteControlAccess(isRemoteCommandsServerEnabled(process.env), switches, loopSystem.kind),
      // The monthly AI limit (mellis-admin ai-limit): the app says so where answers would appear. null without paid AI.
      ai: readAiLimitStatus(process.env),
    };
  }

  /** Where a remote command for the patient's Trio goes; only for a caregiver allowed to send commands. */
  async getTrioRemoteTarget(principal: RequestPrincipal, patientId: string): Promise<{ patient_id: string; trio: TrioRemoteTarget; pump_bolus_step: number | null }> {
    await this.assertCanSendRemoteCommands(principal, patientId);
    const now = new Date();
    const [profile, reportedStep] = await Promise.all([
      this.repository.getLatestRawNightscoutProfile(patientId, now.toISOString()),
      this.pumpBolusStepFor(patientId, now),
    ]);
    // The settings show the pump's step instead of asking for it when Trio reports one GlucoMind rounds to.
    return { patient_id: patientId, trio: readTrioRemoteTarget(profile?.raw_profile ?? null, profile?.stored_at ?? null), pump_bolus_step: pumpBolusStep(reportedStep) };
  }

  /** Where a remote command for the patient's Loop goes; only for a caregiver allowed to send commands. */
  async getLoopRemoteTarget(principal: RequestPrincipal, patientId: string): Promise<{ patient_id: string; loop: LoopRemoteTarget; pump_bolus_step: number | null }> {
    await this.assertCanSendRemoteCommands(principal, patientId);
    const now = new Date();
    const [profile, reportedStep, loopSystem] = await Promise.all([
      this.repository.getLatestRawNightscoutProfile(patientId, now.toISOString()),
      this.pumpBolusStepFor(patientId, now),
      patientLoopSystem(this.dashboardRepository, patientId),
    ]);
    const target = readLoopRemoteTarget(profile?.raw_profile ?? null, profile?.stored_at ?? null);
    // A Loop profile left in Nightscout after the patient moved to another loop is not an address any more.
    const current = loopSystem.kind === 'LOOP' || loopSystem.kind === 'UNKNOWN' ? target : { ...target, status: 'NOT_LOOP' as const, device_token: null };
    return { patient_id: patientId, loop: current, pump_bolus_step: pumpBolusStep(reportedStep) };
  }

  /** The Bolus form: the dose from carbs / ICR and what would stop or need a second look, with the data behind it. */
  async previewRemoteCommand(principal: RequestPrincipal, patientId: string, query: { carbs_g: number; insulin_u: number | null; bolus_step: number; meal_in_minutes?: number | null; proposal_id?: string | null; dose_default?: 'CALCULATOR' | null; source?: RemoteCommandSource | null; planned_bolus_id?: string | null }): Promise<RemoteCommandPreview> {
    await this.assertCanSendRemoteCommands(principal, patientId);
    if (query.proposal_id && !UUID_PATTERN.test(query.proposal_id)) throw new ValidationError('proposal_id must be a UUID');
    if (query.planned_bolus_id && !UUID_PATTERN.test(query.planned_bolus_id)) throw new ValidationError('planned_bolus_id must be a UUID');
    return this.remoteCommands.preview(patientId, query);
  }

  async authorizeRemoteCommand(principal: RequestPrincipal, patientId: string, body: RemoteCommandRequest): Promise<{ command: RemoteCommandView }> {
    await this.assertCanSendRemoteCommands(principal, patientId);
    const request = parseRemoteCommandRequest(body);
    // The WBT window's meal must be this patient's (Meal not found otherwise).
    if (request.wbt_meal_id) await this.resolveMealIdentity(patientId, request.wbt_meal_id);
    // A command sent from a chat names its conversation (its replies and live events go there): it must be one of this
    // patient's. With a card (proposal_id) the service also checks that the card belongs to that conversation.
    if (request.conversation_id && !(await this.repository.conversationBelongsToPatient(patientId, request.conversation_id))) {
      throw new ValidationError('conversation_id does not match a conversation of this patient');
    }
    // A paired device signs every command with its Face ID bound key, naming the patient and the dose it confirmed.
    const deviceAuthorization = principal.auth_provider === 'DEVICE'
      ? await this.deviceAuth.verifySignedRemoteCommand(principal, patientId, request, (body as unknown as Record<string, unknown> | null)?.device_authorization)
      : null;
    const command = await this.remoteCommands.authorize(patientId, principal.user_id, request);
    if (deviceAuthorization) await this.deviceAuth.recordCommandAuthorization(command.id, deviceAuthorization);
    return { command };
  }

  async reportRemoteCommandSent(principal: RequestPrincipal, patientId: string, commandId: string, body: { accepted?: unknown; message?: unknown }): Promise<{ command: RemoteCommandView }> {
    // Reports are accepted after a switch went off: the command already left the phone.
    await this.assertCanWritePatient(principal, patientId);
    requireRemoteCommandId(commandId);
    if (typeof body?.accepted !== 'boolean') throw new ValidationError('accepted must be a boolean');
    return { command: await this.remoteCommands.reportSent(patientId, principal.user_id, commandId, { accepted: body.accepted, message: typeof body.message === 'string' ? body.message.slice(0, 500) : null }) };
  }

  async reportRemoteCommandReply(principal: RequestPrincipal, patientId: string, commandId: string, body: { success?: unknown; message?: unknown; step?: unknown; withheld?: unknown }): Promise<{ command: RemoteCommandView }> {
    await this.assertCanWritePatient(principal, patientId);
    requireRemoteCommandId(commandId);
    if (typeof body?.success !== 'boolean' || typeof body.message !== 'string') throw new ValidationError('success (boolean) and message (string) are required');
    if (body.step !== undefined && body.step !== null && body.step !== 'carbs' && body.step !== 'bolus') throw new ValidationError('step must be carbs or bolus');
    const step = body.step === 'carbs' || body.step === 'bolus' ? body.step : null;
    if (body.withheld !== undefined && typeof body.withheld !== 'boolean') throw new ValidationError('withheld must be a boolean');
    return { command: await this.remoteCommands.reportReply(patientId, principal.user_id, commandId, { success: body.success, message: body.message, step, withheld: body.withheld === true }) };
  }

  async listRemoteCommands(principal: RequestPrincipal, patientId: string, limit: number): Promise<{ patient_id: string; items: RemoteCommandView[] }> {
    await this.assertCanReadPatient(principal, patientId);
    return { patient_id: patientId, items: await this.remoteCommands.list(patientId, principal.user_id, limit) };
  }

  async getRemoteCommand(principal: RequestPrincipal, patientId: string, commandId: string): Promise<{ command: RemoteCommandView }> {
    await this.assertCanReadPatient(principal, patientId);
    requireRemoteCommandId(commandId);
    return { command: await this.remoteCommands.get(patientId, principal.user_id, commandId) };
  }

  /** Glucose, loop and last bolus as the dashboard shows them (Nightscout live first), with the ICR valid now. */
  private async remoteCommandContext(patientId: string, now: Date, carbsAt?: Date | null): Promise<Omit<RemoteCommandContext, 'in_flight_command_id' | 'recent_remote_bolus'> & { forecast_inputs: BolusForecastInputs; meal_forecast: MealForecastData | null }> {
    const [{ dashboard, sources }, therapy, reportedPumpStep, lastCarbsAt, lastCarbs2hAt] = await Promise.all([
      this.dashboardWithSourcesFor(patientId, now),
      this.repository.getTherapyProfileAt(patientId, now.toISOString()),
      this.pumpBolusStepFor(patientId, now),
      // Fast carbs eaten in the last 15 min are already working: no "carbs first" again (as on the chat cards).
      this.rescueCarbs.getLastEatenCarbsAt(patientId, new Date(now.getTime() - 15 * 60_000).toISOString(), now.toISOString()).catch(() => null),
      // dose-calculator.v2: no opt-in correction at 0 g with carbs of the last 2 h (unread: none offered).
      this.lastCarbsWithin(patientId, now, 120),
    ]);
    const forecastSinceMs = now.getTime() - 40 * 60_000;
    return {
      // dose-calculator.v1: the same readings, loop calculation and profile the chat cards' calculator reads.
      meal_forecast: sources.loopStatus || sources.readings.length > 0
        ? mealForecastDataFrom({ now, readings: sources.readings, loopStatus: sources.loopStatus, therapy, lastCarbsAt, lastCarbs2hAt })
        : null,
      ...remoteCommandContextFrom({ now, dashboard, therapy, pumpBolusStep: reportedPumpStep, carbsAt, loopStatus: sources.loopStatus }),
      // The Bolus form's chart (bolus-forecast.v1): the same readings and loop status the dashboard shows.
      forecast_inputs: {
        readings: sources.readings.filter((reading) => Date.parse(reading.at) >= forecastSinceMs).map((reading) => ({ at: reading.at, value: reading.value })),
        prediction: parseLoopPrediction(sources.loopStatus),
        profile_isf: scheduleValueAt(therapy.sensitivity_per_u, now.toISOString(), therapy.timezone ?? LOOP_ACTION_TIME_ZONE),
        profile_units: therapy.units,
        dia_hours: therapy.dia_hours,
      },
    };
  }

  /**
   * The newest carb entry of the last `minutes` with carbs (any kind but one the caregiver marked ignored): null when
   * none, undefined when it could not be read (dose-calculator.v2 then offers no correction).
   */
  private async lastCarbsWithin(patientId: string, now: Date, minutes: number): Promise<string | null | undefined> {
    try {
      const rows = await this.repository.listCarbEntriesBetween(patientId, new Date(now.getTime() - minutes * 60_000).toISOString(), new Date(now.getTime() + 60_000).toISOString());
      const eaten = rows.filter((row) => row.kind !== 'IGNORED' && Number(row.payload?.carbs) > 0);
      const last = eaten.at(-1);
      return last ? new Date(last.occurred_at).toISOString() : null;
    } catch {
      return undefined;
    }
  }

  /** Trio's reported pump step of the last day; unknown (the phone's setting) when it cannot be read. */
  private async pumpBolusStepFor(patientId: string, now: Date): Promise<number | null> {
    try {
      return await this.repository.getPumpBolusIncrement(patientId, new Date(now.getTime() - 24 * 3_600_000).toISOString());
    } catch {
      return null;
    }
  }

  /** The conversation's bolus cards; none before migration 047 or with bolus cards off. */
  private async bolusCardsFor(patientId: string, conversationId: string): Promise<BolusProposalWithCommand[]> {
    try {
      return await this.bolusProposals.listForConversation(patientId, conversationId);
    } catch {
      return [];
    }
  }

  private async assertCanSendRemoteCommands(principal: RequestPrincipal, patientId: string): Promise<void> {
    await this.assertCanWritePatient(principal, patientId);
    const [switches, loopSystem] = await Promise.all([
      this.repository.getRemoteControlSwitches(principal.user_id, patientId),
      patientLoopSystem(this.dashboardRepository, patientId),
    ]);
    const access = resolveRemoteControlAccess(isRemoteCommandsServerEnabled(process.env), switches, loopSystem.kind);
    if (!access.enabled) {
      throw new ForbiddenError(`Remote commands are off (${access.reason})`);
    }
  }

  /** The Dashboard tab: latest reading, 24 h chart and time in range, pump, IOB/COB, site and sensor ages. */
  async getDashboard(principal: RequestPrincipal, patientId: string, now: Date = new Date()): Promise<DashboardResponse> {
    await this.assertCanReadPatient(principal, patientId);
    const [dashboard, history] = await Promise.all([this.dashboardFor(patientId, now), this.nightscoutHistoryImport(patientId)]);
    return history ? { ...dashboard, nightscout_history: history } : dashboard;
  }

  /** The Nightscout history import while it runs (the dashboard's progress row); fails open (no row). */
  private async nightscoutHistoryImport(patientId: string): Promise<DashboardResponse['nightscout_history']> {
    const repository = this.repository as Partial<Pick<PostgresGlucoMindRepository, 'getNightscoutHistoryState'>>;
    if (typeof repository.getNightscoutHistoryState !== 'function') return null;
    try {
      const state = await repository.getNightscoutHistoryState(patientId);
      return state ? nightscoutHistoryImportProgress(state.metadata) : null;
    } catch {
      return null;
    }
  }

  /** The dashboard chart scrolled back: readings, insulin and the loop's IOB/COB of [from, to). */
  async getDashboardHistory(principal: RequestPrincipal, patientId: string, query: { from?: unknown; to?: unknown }, now: Date = new Date()): Promise<DashboardHistoryResponse> {
    await this.assertCanReadPatient(principal, patientId);
    const window = parseDashboardHistoryWindow(query.from, query.to, now);
    if (typeof window === 'string') {
      throw new ValidationError(window);
    }
    const fromIso = window.from.toISOString();
    const toIso = window.to.toISOString();
    const [readings, loopStatuses, insulin] = await Promise.all([
      this.dashboardRepository.listGlucoseReadingsBetween(patientId, fromIso, toIso),
      this.dashboardRepository.listLoopStatusesBetween(patientId, fromIso, toIso),
      this.dashboardInsulin(patientId, fromIso, toIso),
    ]);
    return buildDashboardHistory({ patientId, window, readings, loopStatuses, insulin });
  }

  /** The time-in-range breakdown of the last 1, 7 or 14 days, from the synced readings. */
  async getDashboardTimeInRange(principal: RequestPrincipal, patientId: string, daysRaw: unknown, now: Date = new Date()): Promise<DashboardTimeInRangeResponse> {
    await this.assertCanReadPatient(principal, patientId);
    const days = parseDashboardTimeInRangeDays(daysRaw);
    if (typeof days === 'string') {
      throw new ValidationError(days);
    }
    const fromIso = new Date(now.getTime() - days * 24 * 3_600_000).toISOString();
    // Readings stamped a little after the server's clock still count (the window ends at now, inclusive).
    const toIso = new Date(now.getTime() + 1).toISOString();
    const readings = await this.dashboardRepository.listGlucoseReadingsBetween(patientId, fromIso, toIso);
    return buildDashboardTimeInRange({ patientId, days, now, readings });
  }

  private async dashboardFor(patientId: string, now: Date): Promise<DashboardResponse> {
    return this.dashboards.dashboard(patientId, now);
  }

  /** The dashboard and the readings and loop status it was built from (live Nightscout first). */
  private async dashboardWithSourcesFor(patientId: string, now: Date) {
    return this.dashboards.dashboardWithSources(patientId, now);
  }

  /** The chart's insulin; fails open (the chart then shows glucose only). */
  private async dashboardInsulin(patientId: string, fromIso: string, toIso: string): Promise<DashboardInsulin | null> {
    return this.dashboards.insulin(patientId, fromIso, toIso);
  }

  async getPendingInvestigation(principal: RequestPrincipal, patientId: string): Promise<{ patient_id: string; pending_investigation: Record<string, unknown> | null }> {
    await this.assertCanReadPatient(principal, patientId);
    const pendingInvestigation = await this.repository.getPendingInvestigation(patientId);
    return {
      patient_id: patientId,
      pending_investigation: pendingInvestigation,
    };
  }

  async listPendingQuestions(principal: RequestPrincipal, patientId: string): Promise<{ patient_id: string; items: Array<Record<string, unknown>> }> {
    await this.assertCanReadPatient(principal, patientId);
    const items = await this.repository.listPendingQuestions(patientId);
    return {
      patient_id: patientId,
      items,
    };
  }

  /** Pushes sent for the patient, newest first: the bell in the app, for a notification dismissed on the phone. */
  async listNotifications(principal: RequestPrincipal, patientId: string, limit: number): Promise<{ patient_id: string; items: NotificationHistoryRow[] }> {
    await this.assertCanReadPatient(principal, patientId);
    const boundedLimit = Number.isFinite(limit) ? Math.min(Math.max(Math.trunc(limit), 1), 100) : 50;
    return { patient_id: patientId, items: await this.notificationHistory.listRecent(patientId, boundedLimit) };
  }

  async getRecommendation(principal: RequestPrincipal, patientId: string, recommendationId: string): Promise<Record<string, unknown>> {
    await this.assertCanReadPatient(principal, patientId);
    const recommendation = UUID_PATTERN.test(recommendationId) ? await this.repository.getRecommendation(patientId, recommendationId) : null;
    if (!recommendation) {
      throw new NotFoundError('Recommendation not found');
    }

    return recommendation;
  }

  async getConversation(principal: RequestPrincipal, patientId: string, conversationId: string): Promise<Record<string, unknown>> {
    await this.assertCanReadPatient(principal, patientId);
    const conversation = UUID_PATTERN.test(conversationId) ? await this.repository.getConversation(patientId, conversationId) : null;
    if (!conversation || isDeletedConversation(conversation)) {
      throw new NotFoundError('Conversation not found');
    }

    const hypo = conversation.episode_id ? await this.buildConversationHypo(patientId, conversationId) : null;
    const replyDraft = await this.loadReplyDraft('CONVERSATION', patientId, conversationId, conversation.messages);
    const userFacing = this.toUserFacingConversation(conversation);
    const mealActions = await this.conversationMealActionRepository.listForConversation(patientId, conversationId);
    const bolusCards = await this.bolusCardsFor(patientId, conversationId);
    const plans = await this.plannedBolusesForCards(patientId, bolusCards);
    const withCardsOnly = withBolusProposals(withMealActions(userFacing, mealActions), bolusCards, principal.user_id, new Date(), plans);
    // Every reminder a card set, each with its switch-off: its later parts and its meal's WBT reminder.
    const withCards = withCardReminders(withCardsOnly, await this.cardRemindersFor(patientId, bolusCards));
    const rescue = await this.buildConversationRescue(patientId, conversation);
    // Cards of an ordinary conversation have no alert (the chat may still prepare them); before migration 051: none.
    const chatRescueCards = rescue || conversation.episode_id ? [] : await this.rescueCarbs.listProposalsForConversation(patientId, conversationId).catch(() => []);
    const withRescueCards = rescue
      ? withRescueCarbProposals(withCards, rescue.proposals, rescue.alert.treatment_proposal_id)
      : withRescueCarbProposals(withCards, chatRescueCards, null);
    // Before migration 063: no reminders.
    const reminders = await this.careReminderRepository.listForConversation(patientId, conversationId).catch(() => []);
    const withReminders = reminders.length > 0 ? withCareReminders(withRescueCards, reminders, await this.patientTimeZone(patientId)) : withRescueCards;
    // A meal's WBT conversation (wbt-chat.v1): the meal it is about, and the doses its answers proposed.
    const wbtMealId = typeof conversation.wbt_meal_record_id === 'string' ? conversation.wbt_meal_record_id : null;
    const withWbt = wbtMealId
      ? withWbtProposals(
        withReminders,
        await this.mealWbtRepository.listChatSuggestions(patientId, conversationId).catch(() => []),
        await this.wbtCommandForChat(patientId, wbtMealId, principal.user_id),
      )
      : withReminders;
    return { ...withWbt, ...(hypo ? { hypo } : {}), ...(rescue ? { rescue_carbs: rescue.view } : {}), ...(wbtMealId ? { wbt: { meal_id: wbtMealId } } : {}), reply_draft: replyDraft };
  }

  /** Either caregiver cancels a reminder the chat set (care-reminders.v1); the card shows who did. */
  async cancelCareReminder(principal: RequestPrincipal, patientId: string, reminderId: string): Promise<Record<string, unknown>> {
    await this.assertCanWritePatient(principal, patientId);
    const existing = await this.careReminderRepository.get(patientId, reminderId);
    if (!existing) throw new NotFoundError('Reminder not found');
    const cancelled = await this.careReminderRepository.cancel(patientId, reminderId, principal.user_id);
    if (!cancelled) throw new ConflictError('CARE_REMINDER_SETTLED: To przypomnienie nie jest już aktywne.');
    return { reminder: toCareReminderView(cancelled, await this.patientTimeZone(patientId)) };
  }

  private async patientTimeZone(patientId: string): Promise<string> {
    try {
      const therapy = await this.repository.getTherapyProfileAt(patientId, new Date().toISOString());
      return therapy?.timezone ?? resolveHomeTimeZone();
    } catch {
      return resolveHomeTimeZone();
    }
  }

  /**
   * The rescue block of an alert's conversation (rescue-carbs.v1): the alert, its forecast and dose, the CGM curve
   * since 2 h before it, and what was logged. Null for other conversations and before migration 051.
   */
  private async buildConversationRescue(patientId: string, conversation: Record<string, unknown>) {
    if (String(conversation.trigger_type ?? '') !== 'RESCUE_CARBS') return null;
    const alert = await this.rescueCarbs.getAlertByConversation(patientId, String(conversation.id)).catch(() => null);
    if (!alert) return null;
    const detectedMs = Date.parse(alert.notified_at ?? alert.first_flag_at);
    const [readings, proposals, loggedBy, declinedBy] = await Promise.all([
      this.repository.listGlucoseReadingsBetween(
        patientId,
        new Date(detectedMs - RESCUE_CHART_BEFORE_MS).toISOString(),
        new Date(Math.min(Date.now(), detectedMs + RESCUE_CHART_AFTER_MS)).toISOString(),
      ),
      this.rescueCarbs.listProposalsForConversation(patientId, String(conversation.id)),
      alert.treated_by_user_id ? this.rescueCarbs.userDisplayName(alert.treated_by_user_id) : Promise.resolve(null),
      alert.declined_by_user_id ? this.rescueCarbs.userDisplayName(alert.declined_by_user_id) : Promise.resolve(null),
    ]);
    return { alert, proposals, view: toRescueCarbsView(alert, { readings, logged_by: loggedBy, declined_by: declinedBy }) };
  }

  /**
   * "Podano dosłodzenie" (or a chat card's "Zatwierdź Y g"): the carbs given for the alert of this conversation, stored
   * in GlucoMind only (never sent to Nightscout or the loop) as a hypo treatment, shown in the meals tab.
   */
  async logRescueCarbs(principal: RequestPrincipal, patientId: string, conversationId: string, body: unknown): Promise<{ rescue_carbs: Record<string, unknown> }> {
    await this.assertCanWritePatient(principal, patientId);
    if (!UUID_PATTERN.test(conversationId)) throw new NotFoundError('Conversation not found');
    const conversation = await this.repository.getConversation(patientId, conversationId);
    if (!conversation || isDeletedConversation(conversation)) throw new NotFoundError('Conversation not found');
    const alert = String(conversation.trigger_type ?? '') === 'RESCUE_CARBS' ? await this.rescueCarbs.getAlertByConversation(patientId, conversationId) : null;
    if (!alert) throw new NotFoundError('This conversation is not about a rescue carb alert');
    const input = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    const carbs = parseRescueCarbs(input.carbs_g);
    if (carbs === null) throw new ValidationError('carbs_g must be 1-50 g in 0.5 g steps');
    const givenAt = parseRescueGivenAt(input.given_at, new Date());
    if (givenAt === null) throw new ValidationError('given_at must be within the last 2 hours');
    const proposalId = input.proposal_id === undefined || input.proposal_id === null ? null : String(input.proposal_id);
    if (proposalId !== null && !UUID_PATTERN.test(proposalId)) throw new ValidationError('proposal_id must be a uuid');
    // stale-alerts.v1: logging what was given is allowed at any age (only sending to the loop is refused when stale).
    const result = await this.rescueCarbs.logTreatment({
      patientId,
      alertId: alert.id,
      carbsG: carbs,
      givenAt,
      userId: principal.user_id ?? null,
      source: proposalId ? 'CHAT_CARD' : 'ALERT',
      proposalId,
    });
    if (result.status === 'ALREADY_LOGGED') throw new RescueAlreadyLoggedError(result.logged_by ? `Dosłodzenie już wpisane (${result.logged_by})` : 'Dosłodzenie już wpisane');
    if (result.status === 'PROPOSAL_NOT_FOUND') throw new NotFoundError('Rescue carb card not found');
    if (result.status === 'NOT_FOUND') throw new NotFoundError('Rescue carb alert not found');
    const rescue = await this.buildConversationRescue(patientId, conversation);
    return { rescue_carbs: rescue?.view ?? {} };
  }

  /**
   * "Zatwierdź Y g" on a rescue carb card of an ordinary conversation (no alert): logged like "+" → "Dosłodzenie" in the
   * meals tab (GlucoMind only, never Nightscout or the loop); returns the card with what was logged. 409 when the other
   * caregiver confirmed it first, 404 for an unknown card or an alert's card (those go through …/rescue-carbs).
   */
  async acceptChatRescueCarbs(principal: RequestPrincipal, patientId: string, conversationId: string, proposalId: string, body: unknown): Promise<{ proposal: Record<string, unknown> }> {
    await this.assertCanWritePatient(principal, patientId);
    if (!UUID_PATTERN.test(conversationId) || !UUID_PATTERN.test(proposalId)) throw new NotFoundError('Rescue carb card not found');
    const conversation = await this.repository.getConversation(patientId, conversationId);
    if (!conversation || isDeletedConversation(conversation)) throw new NotFoundError('Conversation not found');
    const input = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    const carbs = parseRescueCarbs(input.carbs_g);
    if (carbs === null) throw new ValidationError('carbs_g must be 1-50 g in 0.5 g steps');
    const givenAt = parseRescueGivenAt(input.given_at, new Date());
    if (givenAt === null) throw new ValidationError('given_at must be within the last 2 hours');
    // stale-alerts.v1: "Podano X g" only logs here, so an old card is still accepted (the loop send is guarded instead).
    const result = await this.rescueCarbs.acceptChatProposal({ patientId, conversationId, proposalId, carbsG: carbs, givenAt, userId: principal.user_id ?? null });
    if (result.status === 'ALREADY_LOGGED') throw new RescueAlreadyLoggedError(result.logged_by ? `Dosłodzenie już wpisane (${result.logged_by})` : 'Dosłodzenie już wpisane');
    if (result.status === 'PROPOSAL_NOT_FOUND') throw new NotFoundError('Rescue carb card not found');
    if (result.status === 'OPTION_TAKEN') throw new RescueAlreadyLoggedError(`Wybrano już opcję ${result.option} tej odpowiedzi.`);
    const proposal = result.proposal;
    return {
      proposal: {
        id: proposal.id,
        carbs_g: proposal.carbs_g,
        reason: proposal.reason,
        status: proposal.status,
        created_at: proposal.created_at,
        logged: proposal.treatment ? { carbs_g: proposal.treatment.carbs_g, given_at: proposal.treatment.given_at } : null,
        alert_id: result.alert_id,
      },
    };
  }

  /**
   * "Nie podaję": no rescue carbs for the alert of this conversation (e.g. decided in its chat), so no reminder push.
   * Carbs can still be logged later; 409 when they already were.
   */
  async declineRescueCarbs(principal: RequestPrincipal, patientId: string, conversationId: string): Promise<{ rescue_carbs: Record<string, unknown> }> {
    await this.assertCanWritePatient(principal, patientId);
    if (!UUID_PATTERN.test(conversationId)) throw new NotFoundError('Conversation not found');
    const conversation = await this.repository.getConversation(patientId, conversationId);
    if (!conversation || isDeletedConversation(conversation)) throw new NotFoundError('Conversation not found');
    const alert = String(conversation.trigger_type ?? '') === 'RESCUE_CARBS' ? await this.rescueCarbs.getAlertByConversation(patientId, conversationId) : null;
    if (!alert) throw new NotFoundError('This conversation is not about a rescue carb alert');
    // stale-alerts.v1: "Nie podaję" stays allowed at any age.
    const result = await this.rescueCarbs.declineAlert({ patientId, alertId: alert.id, userId: principal.user_id ?? null });
    if (result.status === 'ALREADY_LOGGED') throw new RescueAlreadyLoggedError(result.logged_by ? `Dosłodzenie już wpisane (${result.logged_by})` : 'Dosłodzenie już wpisane');
    if (result.status === 'NOT_FOUND') throw new NotFoundError('Rescue carb alert not found');
    const rescue = await this.buildConversationRescue(patientId, conversation);
    return { rescue_carbs: rescue?.view ?? {} };
  }

  /** The phone's own switches ("Ostrzeżenia o możliwym hipo" in the settings). 404 for a device never registered. */
  async getDeviceNotificationSettings(principal: RequestPrincipal, patientId: string, deviceId: string): Promise<DeviceNotificationSettings> {
    await this.assertCanReadPatient(principal, patientId);
    const settings = await this.rescueCarbs.getDeviceSettings(patientId, deviceId.trim());
    if (!settings) throw new NotFoundError('Device not registered');
    return settings;
  }

  /** Changes the switches in the body; a switch left out keeps its value. */
  async setDeviceNotificationSettings(principal: RequestPrincipal, patientId: string, deviceId: string, body: unknown): Promise<DeviceNotificationSettings> {
    await this.assertCanWritePatient(principal, patientId);
    const input = (body as Record<string, unknown> | null) ?? {};
    const changes: { rescue_carb_alerts_enabled?: boolean; answer_ready_push_enabled?: boolean; reservoir_push_enabled?: boolean } = {};
    for (const key of ['rescue_carb_alerts_enabled', 'answer_ready_push_enabled', 'reservoir_push_enabled'] as const) {
      if (input[key] === undefined) continue;
      if (typeof input[key] !== 'boolean') throw new ValidationError(`${key} must be a boolean`);
      changes[key] = input[key] as boolean;
    }
    if (Object.keys(changes).length === 0) throw new ValidationError('rescue_carb_alerts_enabled, answer_ready_push_enabled or reservoir_push_enabled is required');
    const settings = await this.rescueCarbs.setDeviceSettings(patientId, deviceId.trim(), changes);
    if (!settings) throw new NotFoundError('Device not registered');
    return settings;
  }

  /** The phone's Live Activity switch and tokens (live-activity.v1); the worker pushes from them. */
  async setLiveActivity(principal: RequestPrincipal, patientId: string, deviceId: string, body: unknown): Promise<Record<string, unknown>> {
    await this.assertCanReadPatient(principal, patientId);
    const input = (body as Record<string, unknown> | null) ?? {};
    const change: LiveActivityDeviceChange = {};
    for (const key of ['enabled', 'island_enabled'] as const) {
      if (input[key] === undefined) continue;
      if (typeof input[key] !== 'boolean') throw new ValidationError(`${key} must be a boolean`);
      change[key] = input[key] as boolean;
    }
    for (const key of ['start_token', 'update_token', 'activity_id'] as const) {
      const value = input[key];
      if (value === undefined) continue;
      if (value !== null && (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,200}$/.test(value))) throw new ValidationError(`${key} must be a token string or null`);
      change[key] = value as string | null;
    }
    // Two patients (migration 094): the list starts with the patient of the path; each one must be the caller's.
    if (input.patient_ids !== undefined) {
      const ids = input.patient_ids;
      if (!Array.isArray(ids) || ids.length < 1 || ids.length > 2 || !ids.every((id) => typeof id === 'string' && UUID_PATTERN.test(id))) {
        throw new ValidationError('patient_ids must be one or two patient ids');
      }
      const normalized = (ids as string[]).map((id) => id.toLowerCase());
      if (normalized[0] !== patientId.toLowerCase() || new Set(normalized).size !== normalized.length) {
        throw new ValidationError('patient_ids must start with the patient of the path and not repeat');
      }
      for (const id of normalized.slice(1)) await this.assertCanReadPatient(principal, id);
      change.patient_ids = normalized;
    }
    if (input.island_mode !== undefined) {
      if (input.island_mode !== 'both' && input.island_mode !== 'closer') throw new ValidationError('island_mode must be both or closer');
      change.island_mode = input.island_mode;
    }
    if (input.island_left_patient_id !== undefined) {
      const left = input.island_left_patient_id;
      if (left !== null && (typeof left !== 'string' || !UUID_PATTERN.test(left))) throw new ValidationError('island_left_patient_id must be a patient id or null');
      change.island_left_patient_id = left === null ? null : (left as string).toLowerCase();
    }
    if (Object.keys(change).length === 0) throw new ValidationError('enabled, island_enabled, start_token, update_token or activity_id is required');
    const row = await this.liveActivities.upsertFromDevice({ deviceId: deviceId.trim(), patientId, userId: principal.user_id, change, now: new Date() });
    if (!row) throw new NotFoundError('Device not registered');
    return {
      device_id: row.device_id,
      patient_id: row.patient_id,
      patient_ids: row.patient_ids,
      enabled: row.enabled,
      island_enabled: row.island_enabled,
      island_mode: row.island_mode,
      island_left_patient_id: row.island_left_patient_id,
      has_activity: row.update_token !== null,
    };
  }

  /** The caregiver confirmed a meal change card ("Zatwierdź"); `edited` are the values changed with "Popraw". */
  async applyConversationMealAction(principal: RequestPrincipal, patientId: string, conversationId: string, actionId: string, input: { edited?: unknown } = {}): Promise<{ patient_id: string; meal_action: Record<string, unknown> }> {
    await this.assertCanWritePatient(principal, patientId);
    await this.requireLiveConversation(patientId, conversationId, actionId);
    const edited = input.edited === undefined || input.edited === null ? null : input.edited;
    if (edited !== null && (typeof edited !== 'object' || Array.isArray(edited))) throw new ValidationError('edited must be an object');
    const action = await this.conversationMealActions.apply({ patientId, conversationId, actionId, userId: principal.user_id, edited: edited as Record<string, unknown> | null });
    return { patient_id: patientId, meal_action: toMealActionView(action) };
  }

  async rejectConversationMealAction(principal: RequestPrincipal, patientId: string, conversationId: string, actionId: string): Promise<{ patient_id: string; meal_action: Record<string, unknown> }> {
    await this.assertCanWritePatient(principal, patientId);
    await this.requireLiveConversation(patientId, conversationId, actionId);
    const action = await this.conversationMealActions.reject({ patientId, conversationId, actionId, userId: principal.user_id });
    return { patient_id: patientId, meal_action: toMealActionView(action) };
  }

  /** "Cofnij" on a confirmed meal change card. */
  async undoConversationMealAction(principal: RequestPrincipal, patientId: string, conversationId: string, actionId: string): Promise<{ patient_id: string; meal_action: Record<string, unknown> }> {
    await this.assertCanWritePatient(principal, patientId);
    await this.requireLiveConversation(patientId, conversationId, actionId);
    const action = await this.conversationMealActions.undo({ patientId, conversationId, actionId, userId: principal.user_id });
    return { patient_id: patientId, meal_action: toMealActionView(action) };
  }

  private async requireLiveConversation(patientId: string, conversationId: string, actionId?: string): Promise<void> {
    const conversation = UUID_PATTERN.test(conversationId) ? await this.repository.getConversation(patientId, conversationId) : null;
    if (!conversation || isDeletedConversation(conversation)) throw new NotFoundError('Conversation not found');
    if (actionId !== undefined && !UUID_PATTERN.test(actionId)) throw new NotFoundError('Meal change not found');
  }

  /**
   * The answer being written to the latest caregiver message, so a phone that opens the thread (or polls) mid-answer sees
   * it too. Null once the answer is stored, for a draft of an older message, and when the draft cannot be read.
   */
  private async loadReplyDraft(kind: ReplyThreadKind, patientId: string, threadId: string, messages: unknown): Promise<{ reply_to_message_id: string; content: string } | null> {
    const list = Array.isArray(messages) ? (messages as Array<Record<string, unknown>>) : [];
    const lastUserIndex = list.map((message) => String(message.role ?? '').toUpperCase()).lastIndexOf('USER');
    if (lastUserIndex < 0 || list.slice(lastUserIndex + 1).some((message) => String(message.role ?? '').toUpperCase() === 'ASSISTANT')) return null;
    try {
      const draft = await this.replyDrafts.get(kind, threadId, patientId);
      return draft && draft.reply_to_message_id === String(list[lastUserIndex]?.id) ? { reply_to_message_id: draft.reply_to_message_id, content: draft.content } : null;
    } catch {
      return null;
    }
  }

  /** The header of a conversation about a hypo: the episode and its CGM curve. */
  private async buildConversationHypo(patientId: string, conversationId: string): Promise<Record<string, unknown> | null> {
    const episode = await this.repository.getConversationHypo(patientId, conversationId);
    if (!episode) {
      return null;
    }
    const startedMs = Date.parse(episode.started_at);
    const endedMs = episode.ended_at ? Date.parse(episode.ended_at) : startedMs;
    const readings = await this.repository.listGlucoseReadingsBetween(
      patientId,
      new Date(startedMs - HYPO_CHART_BEFORE_MS).toISOString(),
      new Date(Math.min(Date.now(), endedMs + HYPO_CHART_AFTER_MS)).toISOString(),
    );

    return {
      episode_id: episode.episode_id,
      state: episode.state,
      severity: episode.severity,
      started_at: episode.started_at,
      ended_at: episode.ended_at,
      duration_minutes: episode.duration_minutes,
      minimum_glucose: episode.minimum_glucose,
      glucose_readings: readings,
    };
  }

  /** Deletes a conversation for every caregiver of the patient (soft delete: answers stay as patient facts). */
  async deleteConversation(principal: RequestPrincipal, patientId: string, conversationId: string): Promise<void> {
    await this.assertCanWritePatient(principal, patientId);
    if (!UUID_PATTERN.test(conversationId)) {
      throw new NotFoundError('Conversation not found');
    }
    const deleted = await this.repository.softDeleteConversation(patientId, conversationId, principal.user_id);
    if (!deleted) {
      throw new NotFoundError('Conversation not found');
    }
  }

  /**
   * Renames and/or pins a conversation from the history list, for every caregiver of the patient. A caregiver's name
   * is never replaced by the AI's.
   */
  async updateConversation(
    principal: RequestPrincipal,
    patientId: string,
    conversationId: string,
    body: { title?: unknown; pinned?: unknown },
  ): Promise<void> {
    await this.assertCanWritePatient(principal, patientId);
    if (!UUID_PATTERN.test(conversationId)) {
      throw new NotFoundError('Conversation not found');
    }
    const title = body?.title === undefined ? undefined : normalizeConversationTitle(body.title);
    if (title === null) {
      throw new ValidationError(`title must be text of 1-${MAX_CONVERSATION_TITLE_LENGTH} characters`);
    }
    if (body?.pinned !== undefined && typeof body.pinned !== 'boolean') {
      throw new ValidationError('pinned must be true or false');
    }
    const pinned = body?.pinned as boolean | undefined;
    if (title === undefined && pinned === undefined) {
      throw new ValidationError('Nothing to change: send title and/or pinned');
    }
    const updated = await this.repository.updateConversationListSettings({ patientId, conversationId, userId: principal.user_id, title, pinned });
    if (!updated) {
      throw new NotFoundError('Conversation not found');
    }
  }

  async listConversations(principal: RequestPrincipal, patientId: string, limit: number, cursor: string | null): Promise<{ patient_id: string; items: unknown[]; next_cursor: string | null }> {
    await this.assertCanReadPatient(principal, patientId);
    const boundedLimit = Number.isFinite(limit) ? Math.max(1, Math.min(200, Math.floor(limit))) : 50;
    const result = await this.repository.listConversations(patientId, boundedLimit, cursor);
    return {
      patient_id: patientId,
      items: result.items,
      next_cursor: result.nextCursor,
    };
  }

  async createConversation(principal: RequestPrincipal, patientId: string, clientRequestId: string): Promise<{ conversation: Record<string, unknown>; created: boolean }> {
    await this.assertCanWritePatient(principal, patientId);

    const createdConversation = await this.repository.createConversation({
      patientId,
      origin: 'USER',
      conversationType: 'USER_INITIATED',
      threadStateVersion: 'conv-v1',
      awaitingUserAnswer: false,
      triggerType: null,
      triggerId: null,
      episodeId: null,
      clientRequestId,
    });

    const conversation = await this.repository.getConversation(patientId, String(createdConversation.conversation.id));
    if (!conversation) {
      throw new NotFoundError('Conversation not found');
    }

    return {
      conversation: this.toUserFacingConversation(conversation),
      created: createdConversation.created,
    };
  }

  async submitAnswer(principal: RequestPrincipal, patientId: string, conversationId: string, payload: {
    message_type: 'USER_MESSAGE';
    content?: string;
    photo_ids?: unknown;
    bolus_cards?: unknown;
    rescue_cards?: unknown;
    phone_limits?: unknown;
    idempotency_key: string;
  } | {
    message_type: 'CONTEXT_ANSWER';
    question_id: string;
    answer: { type: 'YES' | 'NO' | 'UNKNOWN' | 'TEXT'; text?: string };
    idempotency_key: string;
  }): Promise<{ message: Record<string, unknown>; conversation: Record<string, unknown>; created: boolean; decision: string }> {
    await this.assertCanWritePatient(principal, patientId);
    assertSubmittedMessageShape(payload);

    const conversation = UUID_PATTERN.test(conversationId) ? await this.repository.getConversation(patientId, conversationId) : null;
    if (!conversation || isDeletedConversation(conversation)) {
      throw new NotFoundError('Conversation not found');
    }

    const existingByKey = await this.repository.getMessageByIdempotencyKey(conversationId, payload.idempotency_key);
    // A message stored by a request that failed before its answer job was queued is sent again through the whole path
    // (the insert and the job are idempotent), instead of waiting forever for an answer that was never asked for.
    if (existingByKey && !(payload.message_type === 'USER_MESSAGE' && userMessageNeedsDispatch(existingByKey, conversation))) {
      const replayDecision = this.getUserMessageReplayDecision(existingByKey);
      return {
        message: existingByKey,
        conversation: this.toUserFacingConversation(conversation),
        created: false,
        decision: existingByKey.message_type === 'USER_MESSAGE' ? replayDecision : 'ANSWER_RECEIVED',
      };
    }

    if (payload.message_type === 'USER_MESSAGE') {
      return this.handleUserMessage({
        principal,
        patientId,
        conversationId,
        payload,
        conversation,
      });
    }

    const content = answerDisplayText(payload.answer);
    if (!content) {
      throw new ConflictError('Empty answer text');
    }

    const existingAnswer = await this.repository.getMessageByQuestionId(conversationId, payload.question_id);
    if (existingAnswer) {
      const sameSemanticAnswer =
        existingAnswer.answer_type === payload.answer.type &&
        (payload.answer.type !== 'TEXT' || existingAnswer.answer_text === (payload.answer.text ?? null));

      if (sameSemanticAnswer) {
        return {
          message: existingAnswer,
          conversation: this.toUserFacingConversation(conversation),
          created: false,
          decision: 'ANSWER_RECEIVED',
        };
      }

      throw new ConflictError('Question already answered with a different answer');
    }

    const candidate = createInvestigationCandidateFromQuestionId(payload.question_id);
    if (!candidate) {
      throw new NotFoundError('Question not found');
    }

    const result = await this.repository.withTransaction(async (client) => {
      const questionResult = await client.query(
        `
          SELECT
            cq.status,
            cq.answer_message_id,
            cq.related_event_id,
            c.episode_id,
            e.trigger_id,
            t.source_event_id AS trigger_source_event_id
          FROM context_questions cq
          JOIN conversations c ON c.id = cq.conversation_id
          LEFT JOIN hypo_episodes e ON e.id = c.episode_id
          LEFT JOIN triggers t ON t.id = e.trigger_id
          WHERE cq.conversation_id = $1 AND cq.question_id = $2
          FOR UPDATE OF cq
        `,
        [conversationId, payload.question_id],
      );

      const questionRow = questionResult.rows[0] as {
        status: string;
        answer_message_id: string | null;
        related_event_id: string | null;
        episode_id: string | null;
        trigger_id: string | null;
        trigger_source_event_id: string | null;
      } | undefined;
      if (!questionRow) {
        throw new NotFoundError('Question not found');
      }

      if (questionRow.status === 'ANSWERED') {
        const answeredMessage = await this.repository.getMessageByQuestionId(conversationId, payload.question_id);
        if (!answeredMessage) {
          throw new ConflictError('Question already answered');
        }

        const sameSemanticAnswer =
          answeredMessage.answer_type === payload.answer.type &&
          (payload.answer.type !== 'TEXT' || answeredMessage.answer_text === (payload.answer.text ?? null));

        if (sameSemanticAnswer) {
          return answeredMessage;
        }

        throw new ConflictError('Question already answered with a different answer');
      }

      const messageResult = await client.query(
        `
          INSERT INTO messages (
            conversation_id, patient_id, role, message_type, content, question_id, answer_type, answer_text, answer_value, provenance_ref, idempotency_key,
            author_user_id
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
          ON CONFLICT (conversation_id, idempotency_key)
          DO UPDATE SET updated_at = now()
          RETURNING *
        `,
        [
          conversationId,
          patientId,
          'USER',
          'CONTEXT_ANSWER',
          content,
          payload.question_id,
          payload.answer.type,
          payload.answer.type === 'TEXT' ? payload.answer.text ?? null : null,
          payload.answer.type === 'YES' ? true : payload.answer.type === 'NO' ? false : null,
          `conv/${conversationId}/messages/${payload.idempotency_key}`,
          payload.idempotency_key,
          principal.user_id,
        ],
      );

      await client.query(
        `
          UPDATE conversations
          SET awaiting_user_answer = false,
              updated_at = now(),
              thread_state_version = $2
          WHERE id = $1
        `,
        [conversationId, 'conv-v9'],
      );

      await client.query(
        `
          UPDATE context_questions
          SET status = 'ANSWERED',
              answer_message_id = $2,
              updated_at = now()
          WHERE conversation_id = $1 AND question_id = $3
        `,
        [conversationId, messageResult.rows[0].id, payload.question_id],
      );

      const sourceEventId = questionRow.related_event_id ?? questionRow.trigger_source_event_id ?? null;
      const nowIso = new Date().toISOString();
      const knowledgeStatus = payload.answer.type === 'UNKNOWN' ? 'UNKNOWN' : 'KNOWN';
      const value = payload.answer.type === 'YES'
        ? true
        : payload.answer.type === 'NO'
          ? false
          : payload.answer.type === 'TEXT'
            ? payload.answer.text ?? null
            : null;
      const valueType = payload.answer.type === 'TEXT'
        ? 'TEXT'
        : payload.answer.type === 'UNKNOWN'
          ? 'NULL'
          : 'BOOLEAN';

      await client.query(
        `
          INSERT INTO patient_context (
            patient_id, fact_key, fact_name, fact_type, scope, value, value_type, knowledge_status,
            source_type, source_ref, source_event_id, source_conversation_id, source_question_id,
            related_episode_id, related_trigger_id, observed_at, recorded_at, confidence, validity,
            created_by, status
          ) VALUES (
            $1,$2,$3,$4,'EVENT',$5::jsonb,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::timestamptz,$16::timestamptz,$17,$18,$19,$20
          )
          ON CONFLICT (patient_id, fact_key, scope, source_event_id, source_question_id)
          DO UPDATE SET
            value = EXCLUDED.value,
            value_type = EXCLUDED.value_type,
            knowledge_status = EXCLUDED.knowledge_status,
            source_type = EXCLUDED.source_type,
            source_ref = EXCLUDED.source_ref,
            source_conversation_id = EXCLUDED.source_conversation_id,
            related_episode_id = EXCLUDED.related_episode_id,
            related_trigger_id = EXCLUDED.related_trigger_id,
            observed_at = EXCLUDED.observed_at,
            recorded_at = EXCLUDED.recorded_at,
            confidence = EXCLUDED.confidence,
            validity = EXCLUDED.validity,
            created_by = EXCLUDED.created_by,
            status = EXCLUDED.status,
            updated_at = now()
        `,
        [
          patientId,
          candidate.fact_key,
          candidate.fact_name,
          candidate.fact_type,
          JSON.stringify(value),
          valueType,
          knowledgeStatus,
          'USER_REPORT',
          `conv/${conversationId}/messages/${payload.idempotency_key}`,
          sourceEventId,
          conversationId,
          payload.question_id,
          questionRow.episode_id,
          questionRow.trigger_id,
          nowIso,
          nowIso,
          'HIGH',
          'VALID',
          principal.user_id,
          'ACTIVE',
        ],
      );

      await client.query(
        `
          INSERT INTO jobs (
            job_type, status, payload_version, payload, dedupe_key, correlation_id, causation_id, patient_id, available_at, max_attempts
          ) VALUES ($1,'queued',$2,$3,$4,$5,$6,$7,now(),$8)
          ON CONFLICT (job_type, dedupe_key)
          DO UPDATE SET updated_at = now()
        `,
        [
          'investigation.re_evaluate',
          1,
          {
            patient_id: patientId,
            conversation_id: conversationId,
            question_id: payload.question_id,
            answer_type: payload.answer.type,
            source_event_id: sourceEventId,
          },
          `investigation.re_evaluate:answer:${conversationId}:${payload.question_id}`,
          conversationId,
          conversationId,
          patientId,
          5,
        ],
      );

      return messageResult.rows[0];
    });

    return {
      message: result,
      conversation: this.toUserFacingConversation({
        ...conversation,
        awaiting_user_answer: false,
      }),
      created: true,
      decision: 'ANSWER_RECEIVED',
    };
  }

  private async handleUserMessage(args: {
    principal: RequestPrincipal;
    patientId: string;
    conversationId: string;
    payload: { message_type: 'USER_MESSAGE'; content?: string; photo_ids?: unknown; bolus_cards?: unknown; rescue_cards?: unknown; phone_limits?: unknown; idempotency_key: string };
    conversation: Record<string, unknown>;
  }): Promise<{ message: Record<string, unknown>; conversation: Record<string, unknown>; created: boolean; decision: UserMessageCapability }> {
    const { patientId, conversationId, payload, conversation } = args;
    const content = String(payload.content ?? '').trim();
    // A long paste would be refused by the AI cost guard after the retries; refused here at once (the app keeps the text).
    if (content.length > MAX_CHAT_MESSAGE_CHARS) throw new ValidationError(`content must be at most ${MAX_CHAT_MESSAGE_CHARS} characters`);
    const photoIds = await this.validateConversationPhotoIds(patientId, conversationId, payload.photo_ids);
    if (!content && photoIds.length === 0) {
      throw new ValidationError('Message content is required');
    }

    // A meal change ("zamiast obiadu zjadł…", "to były węgle korekcyjne") and a short reply to an answer working on a
    // meal are answered directly with the meal tools, not as an analysis of the period (conversation-meal-actions.v1).
    // The hypo screen's chat stays about its hypo, a WBT conversation about its meal's WBT (with the dose tool).
    const mealChange = isMealActionsEnabled()
      && !conversation.episode_id
      && !conversation.wbt_meal_record_id
      && String(conversation.trigger_type ?? '') !== 'RESCUE_CARBS'
      && (isMealEditRequest(content)
        || (continuesMealAssistant(Array.isArray(conversation.messages) ? conversation.messages as Array<Record<string, unknown>> : [], content)
          && determineUserMessageCapability(content) !== 'ANALYSIS_REQUEST'));
    const capability = mealChange ? 'DIRECT_RESPONSE' : determineUserMessageCapability(content);
    // The patient's clock (Trio profile zone, else the server's): "wczoraj", "o 7" and the periods are read in it.
    const patientTz = await this.patientTimeZone(patientId);
    const { messageResult, followUpRange, route } = await this.repository.withTransaction(async (client) => {
      const inserted = await client.query(
        `
          INSERT INTO messages (
            conversation_id, patient_id, role, message_type, content, provenance_ref, metadata, idempotency_key, author_user_id
          ) VALUES ($1,$2,'USER','USER_MESSAGE',$3,$4,$5::jsonb,$6,$7)
          ON CONFLICT (conversation_id, idempotency_key)
          DO UPDATE SET updated_at = now()
          RETURNING *
        `,
        [
          conversationId,
          patientId,
          content,
          `conv/${conversationId}/messages/${payload.idempotency_key}`,
          JSON.stringify({
            message_type: 'USER_MESSAGE',
            decision: capability,
            ...(photoIds.length > 0 ? { photo_ids: photoIds } : {}),
            // The sending phone has the patient's remote control set up: the answer may prepare bolus cards.
            ...(payload.bolus_cards === true ? { bolus_cards: true } : {}),
            // Its own send limits (the phone refuses a card above them): the cards warn about them.
            ...(payload.bolus_cards === true && readPhoneLimits(payload.phone_limits) ? { phone_limits: readPhoneLimits(payload.phone_limits) } : {}),
            // The sending phone can confirm rescue carb cards outside an alert's chat.
            ...(payload.rescue_cards === true ? { rescue_cards: true } : {}),
          }),
          payload.idempotency_key,
          args.principal.user_id,
        ],
      );

      // The route is resolved here, before the conversation is updated: a message answered as a time-range analysis
      // (e.g. "jak wyglądał mój cukier przez ostatnie 7 dni") must never persist awaiting_user_answer=true, even when
      // its wording alone would classify it as INVESTIGATION_REQUIRED.
      // In a hypo screen's chat every question about the patient is about that hypo: its window is the default range.
      const requestedAtIso = String(inserted.rows[0].created_at ?? new Date().toISOString());
      // A rescue alert's chat likewise stays about its alert (rescue-carbs.v1).
      // Only small talk leaves the event's chat without its data: a general question there is about the event too.
      const aboutPatient = !isSocialMessage(content);
      const hypoWindow = conversation.episode_id && aboutPatient
        ? await this.hypoConversationRange(patientId, conversationId, requestedAtIso)
        : String(conversation.trigger_type ?? '') === 'RESCUE_CARBS' && aboutPatient
          ? await this.rescueConversationRange(patientId, conversationId, requestedAtIso)
          // A meal's WBT conversation stays about that meal and what followed it (wbt-chat.v1).
          : typeof conversation.wbt_meal_record_id === 'string' && aboutPatient
            ? await this.wbtConversationRange(patientId, conversation.wbt_meal_record_id, requestedAtIso)
            : null;
      // Data by default: only social and general messages are answered without the patient's data. A photo (a meal to
      // dose for, a product label) is always a question about this patient.
      const route = routeUserMessage({
        content,
        messages: Array.isArray(conversation.messages) ? conversation.messages as Array<Record<string, unknown>> : [],
        conversationId,
        requestedAtIso,
        timezone: patientTz,
        hasPhotos: photoIds.length > 0,
        hypoWindow,
      });
      const resolvedRange = route.route === 'ANALYSIS' && !mealChange ? route.window : null;

      await client.query(
        `
          UPDATE conversations
          SET awaiting_user_answer = $2,
              updated_at = now()
          WHERE id = $1
        `,
        [conversationId, capability === 'INVESTIGATION_REQUIRED' && route.route === 'UNRESOLVED'],
      );

      return { messageResult: inserted.rows[0], followUpRange: resolvedRange, route };
    });

    if (followUpRange) {

      await this.enqueueTimeRangeAnalysisJob({
        patientId,
        conversationId,
        userMessageId: String(messageResult.id),
        rangeType: followUpRange.rangeType,
        rangeStart: followUpRange.rangeStart,
        rangeEnd: followUpRange.rangeEnd,
        timezone: followUpRange.timezone,
        normalizationPolicyVersion: followUpRange.normalizationPolicyVersion,
      });
      await this.persistUserMessageDecision(String(messageResult.id), conversationId, 'ANALYSIS_REQUEST');

      return {
        message: this.withDecisionMetadata(messageResult, 'ANALYSIS_REQUEST'),
        conversation: this.toUserFacingConversation({
          ...conversation,
          awaiting_user_answer: false,
        }),
        created: true,
        decision: 'ANALYSIS_REQUEST',
      };
    }

    // Without a window (an invalid request time or timezone) the message falls back to its capability.
    if (route.route === 'UNRESOLVED' && capability === 'ANALYSIS_REQUEST') {

      const investigation = await this.evaluateInvestigationForUserMessage({
        patientId,
        conversationId,
      });

      if (investigation.shouldProceedToAnalysis) {
        await this.repository.insertJob({
          jobType: 'analysis.follow_up',
          payloadVersion: 1,
          payload: {
            patient_id: patientId,
            conversation_id: conversationId,
            question_id: null,
          },
          // One per message: a second unresolved message of the conversation gets its own job (not the first one's).
          dedupeKey: `analysis.follow_up:user-initial:${conversationId}:${String(messageResult.id)}`,
          correlationId: conversationId,
          causationId: conversationId,
          patientId,
          availableAt: new Date().toISOString(),
          maxAttempts: 5,
        });
      }
      await this.persistUserMessageDecision(String(messageResult.id), conversationId, 'INVESTIGATION_REQUIRED');

      return {
        message: this.withDecisionMetadata(messageResult, 'INVESTIGATION_REQUIRED'),
        conversation: this.toUserFacingConversation({
          ...conversation,
          awaiting_user_answer: investigation.state === 'QUESTION_PENDING',
        }),
        created: true,
        decision: 'INVESTIGATION_REQUIRED',
      };
    }

    if (route.route === 'UNRESOLVED' && capability === 'INVESTIGATION_REQUIRED') {
      const evaluation = await this.evaluateInvestigationForUserMessage({ patientId, conversationId });

      if (evaluation.shouldProceedToAnalysis) {
        await this.repository.insertJob({
          jobType: 'analysis.follow_up',
          payloadVersion: 1,
          payload: {
            patient_id: patientId,
            conversation_id: conversationId,
            question_id: null,
          },
          // One per message: a second unresolved message of the conversation gets its own job (not the first one's).
          dedupeKey: `analysis.follow_up:user-initial:${conversationId}:${String(messageResult.id)}`,
          correlationId: conversationId,
          causationId: conversationId,
          patientId,
          availableAt: new Date().toISOString(),
          maxAttempts: 5,
        });
      }
      await this.persistUserMessageDecision(String(messageResult.id), conversationId, 'INVESTIGATION_REQUIRED');

      return {
        message: this.withDecisionMetadata(messageResult, 'INVESTIGATION_REQUIRED'),
        conversation: this.toUserFacingConversation({
          ...conversation,
          awaiting_user_answer: evaluation.state === 'QUESTION_PENDING',
        }),
        created: true,
        decision: 'INVESTIGATION_REQUIRED',
      };
    }

    await this.enqueueDirectResponseJob({
      patientId,
      conversationId,
      userMessageId: String(messageResult.id),
    });
    await this.persistUserMessageDecision(String(messageResult.id), conversationId, 'DIRECT_RESPONSE');

    return {
      message: this.withDecisionMetadata(messageResult, 'DIRECT_RESPONSE'),
      conversation: this.toUserFacingConversation({
        ...conversation,
        awaiting_user_answer: false,
      }),
      created: true,
      decision: 'DIRECT_RESPONSE',
    };
  }

  private toUserFacingConversation(conversation: Record<string, unknown>): Record<string, unknown> {
    const rawMessages = Array.isArray(conversation.messages)
      ? (conversation.messages as Array<Record<string, unknown>>)
      : [];

    const answeredUserMessageIds = new Set(rawMessages
      .filter((message) => String(message.role ?? '').toUpperCase() === 'ASSISTANT')
      .map((message) => (message.metadata as Record<string, unknown> | null)?.user_message_id)
      .filter((id): id is string => typeof id === 'string'));

    const filteredMessages = rawMessages
      .filter((message) => this.isUserFacingConversationMessage(message))
      .map((message) => {
        if (String(message.message_type ?? '').toUpperCase() !== 'USER_MESSAGE') {
          return message;
        }
        // Additive fields: the durable cancellation state, and whether an analysis for this message can still be
        // cancelled (it has a direct-response/analysis job, no reply yet, and no result is being saved).
        const state = parseUserMessageResponseState(message.metadata);
        const decision = (message.metadata as Record<string, unknown> | null)?.decision;
        return {
          ...message,
          response_status: state === 'CANCELLED' ? 'CANCELLED' : null,
          analysis_cancellable: state === null
            && !answeredUserMessageIds.has(String(message.id))
            && (decision === 'DIRECT_RESPONSE' || decision === 'ANALYSIS_REQUEST'),
        };
      });

    return {
      ...conversation,
      messages: filteredMessages,
    };
  }

  private isUserFacingConversationMessage(message: Record<string, unknown>): boolean {
    const role = String(message.role ?? '').trim().toUpperCase();
    const messageType = String(message.message_type ?? '').trim().toUpperCase();

    if (role === 'USER') {
      return true;
    }

    return messageType === 'ASSISTANT_MESSAGE'
      || messageType === 'CONTEXT_QUESTION'
      || messageType === 'CONTEXT_ANSWER'
      || role === 'ASSISTANT';
  }

  private getUserMessageReplayDecision(message: Record<string, unknown>): UserMessageCapability {
    const metadata = (message.metadata as Record<string, unknown> | null) ?? null;
    const persisted = typeof metadata?.decision === 'string' ? metadata.decision : null;
    if (persisted === 'DIRECT_RESPONSE' || persisted === 'INVESTIGATION_REQUIRED' || persisted === 'ANALYSIS_REQUEST') {
      return persisted;
    }

    return determineUserMessageCapability(String(message.content ?? ''));
  }

  /** A rescue alert's chat: from DIA (4 h fallback) before the alert to now, at most 3 h after it. */
  /** A WBT conversation's data: from an hour before its meal to the question (at most 12 h after the meal). */
  private async wbtConversationRange(patientId: string, mealId: string, requestedAtIso: string): Promise<{
    rangeType: ConversationTimeRangeType;
    rangeStart: string;
    rangeEnd: string;
    timezone: string;
    normalizationPolicyVersion: string;
  } | null> {
    const startedAt = await this.resolveMealIdentity(patientId, mealId)
      .then((identity) => this.mealRecordRepository.getMealRecord(patientId, identity))
      .then((record) => record.started_at, () => null);
    const mealMs = startedAt ? Date.parse(startedAt) : Number.NaN;
    const requestedMs = Date.parse(requestedAtIso);
    const endMs = Math.min(mealMs + 12 * 60 * 60_000, Number.isFinite(requestedMs) ? requestedMs : Date.now());
    const startMs = mealMs - 60 * 60_000;
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs >= endMs) return null;
    return {
      rangeType: 'TODAY',
      rangeStart: new Date(startMs).toISOString(),
      rangeEnd: new Date(endMs).toISOString(),
      timezone: await this.patientTimeZone(patientId),
      normalizationPolicyVersion: 'time-range-normalization.v1',
    };
  }

  private async rescueConversationRange(patientId: string, conversationId: string, requestedAtIso: string): Promise<{
    rangeType: ConversationTimeRangeType;
    rangeStart: string;
    rangeEnd: string;
    timezone: string;
    normalizationPolicyVersion: string;
  } | null> {
    const alert = await this.rescueCarbs.getAlertByConversation(patientId, conversationId).catch(() => null);
    if (!alert) return null;
    const alertMs = Date.parse(alert.notified_at ?? alert.first_flag_at);
    const dia = await this.repository.getTherapyDiaAt(patientId, new Date(alertMs).toISOString()).catch(() => null);
    const diaHours = dia?.status === 'KNOWN' && typeof dia.dia_hours === 'number' && dia.dia_hours > 0 && dia.dia_hours <= 12 ? dia.dia_hours : 4;
    const requestedMs = Date.parse(requestedAtIso);
    const endMs = Math.min(alertMs + 3 * 60 * 60_000, Number.isFinite(requestedMs) ? requestedMs : Date.now());
    const startMs = alertMs - diaHours * 60 * 60_000;
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs >= endMs) return null;
    return {
      rangeType: 'TODAY',
      rangeStart: new Date(startMs).toISOString(),
      rangeEnd: new Date(endMs).toISOString(),
      timezone: await this.patientTimeZone(patientId),
      normalizationPolicyVersion: 'time-range-normalization.v1',
    };
  }

  /**
   * The window a hypo screen's chat analyses: from one insulin action time (DIA of the therapy, 4 h when unknown)
   * before the hypo to 3 h after it ended (the treatment and any rebound), never past the request. Up to 25 h fits the
   * single-day range type.
   */
  private async hypoConversationRange(patientId: string, conversationId: string, requestedAtIso: string): Promise<{
    rangeType: ConversationTimeRangeType;
    rangeStart: string;
    rangeEnd: string;
    timezone: string;
    normalizationPolicyVersion: string;
  } | null> {
    const hypo = await this.repository.getConversationHypo(patientId, conversationId);
    if (!hypo) {
      return null;
    }
    const dia = await this.repository.getTherapyDiaAt(patientId, hypo.started_at).catch(() => null);
    const diaHours = dia?.status === 'KNOWN' && typeof dia.dia_hours === 'number' && dia.dia_hours > 0 && dia.dia_hours <= 12 ? dia.dia_hours : 4;
    const startedMs = Date.parse(hypo.started_at);
    const endedMs = hypo.ended_at ? Date.parse(hypo.ended_at) : startedMs;
    const requestedMs = Date.parse(requestedAtIso);
    const endMs = Math.min(endedMs + 3 * 60 * 60_000, Number.isFinite(requestedMs) ? requestedMs : Date.now());
    const startMs = Math.max(startedMs - diaHours * 60 * 60_000, endMs - 24 * 60 * 60_000);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs >= endMs) {
      return null;
    }
    return {
      rangeType: 'TODAY',
      rangeStart: new Date(startMs).toISOString(),
      rangeEnd: new Date(endMs).toISOString(),
      timezone: await this.patientTimeZone(patientId),
      normalizationPolicyVersion: 'time-range-normalization.v1',
    };
  }

  private withDecisionMetadata(
    message: Record<string, unknown>,
    decision: UserMessageCapability,
  ): Record<string, unknown> {
    const metadata = (message.metadata as Record<string, unknown> | null) ?? {};
    return {
      ...message,
      metadata: {
        ...metadata,
        decision,
      },
    };
  }

  /** Stores the message's decision once its answer job (if any) is queued: dispatched marks it done. */
  private async persistUserMessageDecision(
    messageId: string,
    conversationId: string,
    decision: UserMessageCapability,
  ): Promise<void> {
    await this.repository.withTransaction(async (client) => {
      await client.query(
        `
          UPDATE messages
          SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('decision', $3::text, 'dispatched', true),
              updated_at = now()
          WHERE id = $1
            AND conversation_id = $2
        `,
        [messageId, conversationId, decision],
      );
    });
  }

  private async enqueueDirectResponseJob(args: {
    patientId: string;
    conversationId: string;
    userMessageId: string;
  }): Promise<void> {
    await this.repository.insertJob({
      jobType: 'conversation.direct_response',
      payloadVersion: 1,
      payload: {
        patient_id: args.patientId,
        conversation_id: args.conversationId,
        user_message_id: args.userMessageId,
      },
      dedupeKey: `conversation.direct_response:${args.conversationId}:${args.userMessageId}`,
      correlationId: args.conversationId,
      causationId: args.conversationId,
      patientId: args.patientId,
      availableAt: new Date().toISOString(),
      maxAttempts: 5,
    });
  }

  private async enqueueTimeRangeAnalysisJob(args: {
    patientId: string;
    conversationId: string;
    userMessageId: string;
    rangeType: ConversationTimeRangeType;
    rangeStart: string;
    rangeEnd: string;
    timezone: string;
    normalizationPolicyVersion: string;
  }): Promise<void> {
    await this.repository.insertJob({
      jobType: 'conversation.time_range_analysis',
      payloadVersion: 1,
      payload: {
        patient_id: args.patientId,
        conversation_id: args.conversationId,
        user_message_id: args.userMessageId,
        range_type: args.rangeType,
        range_start: args.rangeStart,
        range_end: args.rangeEnd,
        timezone: args.timezone,
        normalization_policy_version: args.normalizationPolicyVersion,
      },
      dedupeKey: `conversation.time_range_analysis:${args.conversationId}:${args.userMessageId}:${args.rangeType}:${args.rangeStart}:${args.rangeEnd}:${args.timezone}`,
      correlationId: args.conversationId,
      causationId: args.conversationId,
      patientId: args.patientId,
      availableAt: new Date().toISOString(),
      maxAttempts: 5,
    });
  }

  private async evaluateInvestigationForUserMessage(args: {
    patientId: string;
    conversationId: string;
  }): Promise<{ shouldProceedToAnalysis: boolean; state: string }> {
    return this.repository.evaluateInvestigationForEvent({
      patientId: args.patientId,
      eventId: null,
      eventFamily: 'USER',
      conversationId: args.conversationId,
      episodeId: null,
      triggerId: null,
      phase: 'INITIAL',
    });
  }

  /**
   * Cancels the analysis answering `messageId` (modules/analysis/application/user-message-cancellation.ts).
   * Idempotent: repeating returns ALREADY_CANCELLED; a result already being saved returns ALREADY_COMPLETED.
   */
  async cancelMessageAnalysis(
    principal: RequestPrincipal,
    patientId: string,
    conversationId: string,
    messageId: string,
  ): Promise<{ result: UserMessageCancellationOutcome; message_id: string; conversation: Record<string, unknown> }> {
    await this.assertCanWritePatient(principal, patientId);
    if (!UUID_PATTERN.test(conversationId) || !UUID_PATTERN.test(messageId)) {
      throw new NotFoundError('Message not found');
    }

    const cancellation = await this.repository.cancelUserMessageResponse({
      patientId,
      conversationId,
      userMessageId: messageId,
      cancelledBy: principal.user_id,
      nowIso: new Date().toISOString(),
    });
    if (!cancellation) {
      throw new NotFoundError('Message not found');
    }
    // A cancel during a retry's wait never reaches the worker again: the failed attempt's cards and reminders go here
    // (a reminder would still push). A running job discards its own as well.
    if (cancellation.outcome === 'CANCELLED' || cancellation.outcome === 'ALREADY_CANCELLED') {
      await Promise.all([
        this.careReminderRepository.discardForUserMessage(patientId, messageId),
        this.bolusProposals.discardForUserMessage(patientId, messageId),
        this.rescueCarbs.discardProposalsForUserMessage(patientId, messageId),
      ]).catch(() => undefined);
    }

    const conversation = await this.repository.getConversation(patientId, conversationId);
    if (!conversation) {
      throw new NotFoundError('Conversation not found');
    }

    return {
      result: cancellation.outcome,
      message_id: messageId,
      conversation: this.toUserFacingConversation(conversation),
    };
  }

  /**
   * Answers one caregiver message again after its answer failed (Ponów próbę): its failed job goes back to the queue
   * with the same question and range. REQUEUED, or NOT_FAILED when there was no failed job for it (already answered,
   * still running, or retried already); the conversation is returned either way.
   */
  async retryMessageAnalysis(
    principal: RequestPrincipal,
    patientId: string,
    conversationId: string,
    messageId: string,
  ): Promise<{ result: 'REQUEUED' | 'NOT_FAILED'; message_id: string; conversation: Record<string, unknown> }> {
    await this.assertCanWritePatient(principal, patientId);
    if (!UUID_PATTERN.test(conversationId) || !UUID_PATTERN.test(messageId)) {
      throw new NotFoundError('Message not found');
    }
    const message = await this.repository.getMessageById(conversationId, messageId);
    if (!message || String(message.patient_id ?? patientId) !== patientId || String(message.message_type ?? '') !== 'USER_MESSAGE') {
      throw new NotFoundError('Message not found');
    }
    const requeued = await this.repository.requeueFailedConversationResponse({ patientId, conversationId, userMessageId: messageId });
    const conversation = await this.repository.getConversation(patientId, conversationId);
    if (!conversation) {
      throw new NotFoundError('Conversation not found');
    }
    return {
      result: requeued ? 'REQUEUED' : 'NOT_FAILED',
      message_id: messageId,
      conversation: this.toUserFacingConversation(conversation),
    };
  }

  /** Stores one JPEG photo for the main chat (base64 in JSON, at most 4 MB); a message then lists it in photo_ids. */
  async uploadConversationPhoto(principal: RequestPrincipal, patientId: string, conversationId: string, input: { content_type?: unknown; data_base64?: unknown }): Promise<{ patient_id: string; photo_id: string }> {
    await this.assertCanWritePatient(principal, patientId);
    if (!this.photoStorage) {
      throw new ConflictError('Photo storage is not configured');
    }
    if (!UUID_PATTERN.test(conversationId)) {
      throw new NotFoundError('Conversation not found');
    }
    const conversation = await this.repository.getConversation(patientId, conversationId);
    if (!conversation || isDeletedConversation(conversation)) {
      throw new NotFoundError('Conversation not found');
    }
    const data = decodeJpegUpload(input);
    const photoId = await this.conversationPhotoRepository.insertPhoto({
      patientId,
      conversationId,
      contentType: 'image/jpeg',
      byteSize: data.length,
      sha256: createHash('sha256').update(data).digest('hex'),
      userId: principal.user_id,
    });
    await this.photoStorage.save(patientId, photoId, data);
    return { patient_id: patientId, photo_id: photoId };
  }

  /** Voice messages can be sent here for transcription (GET /v1/app-config); otherwise the app transcribes on the phone. */
  serverVoiceTranscriptionAvailable(): boolean {
    return this.voiceTranscription !== null;
  }

  /**
   * A voice message recorded in a chat composer, as text to edit and send. Nothing is stored; the patient only decides
   * who may use it (a caregiver who can write messages for them).
   */
  async transcribeVoice(principal: RequestPrincipal, patientId: string, input: { content_type?: unknown; data_base64?: unknown }): Promise<{ patient_id: string; text: string; duration_seconds: number }> {
    await this.assertCanWritePatient(principal, patientId);
    if (!this.voiceTranscription) {
      throw new ConflictError('Voice transcription is not configured');
    }
    const result = await this.voiceTranscription.transcribe(parseVoiceUpload(input));
    return { patient_id: patientId, text: result.text, duration_seconds: Math.round(result.duration_seconds * 10) / 10 };
  }

  async getConversationPhoto(principal: RequestPrincipal, patientId: string, conversationId: string, photoId: string): Promise<{ contentType: string; data: Buffer }> {
    await this.assertCanReadPatient(principal, patientId);
    if (!this.photoStorage || !UUID_PATTERN.test(photoId) || !UUID_PATTERN.test(conversationId)) {
      throw new NotFoundError('Photo not found');
    }
    const photo = await this.conversationPhotoRepository.getPhoto(patientId, conversationId, photoId);
    if (!photo) {
      throw new NotFoundError('Photo not found');
    }
    try {
      return { contentType: photo.content_type, data: await this.photoStorage.read(patientId, photoId) };
    } catch {
      throw new NotFoundError('Photo not found');
    }
  }

  /** At most 3 ids of photos uploaded to this conversation; anything else is rejected before the message is stored. */
  private async validateConversationPhotoIds(patientId: string, conversationId: string, raw: unknown): Promise<string[]> {
    const photoIds = parsePhotoIds(raw);
    if (photoIds.length > 0 && (await this.conversationPhotoRepository.countPhotosOfConversation(patientId, conversationId, photoIds)) !== photoIds.length) {
      throw new ValidationError('Unknown photo id for this conversation');
    }
    return photoIds;
  }

  /** Stores one JPEG photo of a meal (base64 in JSON, at most 4 MB) for the meal chat. */
  async uploadMealPhoto(principal: RequestPrincipal, patientId: string, mealId: string, input: { content_type?: unknown; data_base64?: unknown }): Promise<{ patient_id: string; photo_id: string }> {
    await this.assertCanWritePatient(principal, patientId);
    if (!this.photoStorage) {
      throw new ConflictError('Photo storage is not configured');
    }
    await this.resolveMealIdentity(patientId, mealId);
    const data = decodeJpegUpload(input);
    const photoId = await this.mealChatRepository.insertPhoto({
      patientId,
      mealRecordId: mealId,
      contentType: 'image/jpeg',
      byteSize: data.length,
      sha256: createHash('sha256').update(data).digest('hex'),
      userId: principal.user_id,
    });
    await this.photoStorage.save(patientId, photoId, data);
    return { patient_id: patientId, photo_id: photoId };
  }

  async getMealPhoto(principal: RequestPrincipal, patientId: string, mealId: string, photoId: string): Promise<{ contentType: string; data: Buffer }> {
    await this.assertCanReadPatient(principal, patientId);
    if (!this.photoStorage || !UUID_PATTERN.test(photoId) || !UUID_PATTERN.test(mealId)) {
      throw new NotFoundError('Photo not found');
    }
    const photo = await this.mealChatRepository.getPhoto(patientId, mealId, photoId);
    if (!photo) {
      throw new NotFoundError('Photo not found');
    }
    try {
      return { contentType: photo.content_type, data: await this.photoStorage.read(patientId, photoId) };
    } catch {
      throw new NotFoundError('Photo not found');
    }
  }

  /** The meal chat with the meal itself and whether the AI is still answering the last message. */
  async getMealChat(principal: RequestPrincipal, patientId: string, mealId: string): Promise<Record<string, unknown>> {
    await this.assertCanReadPatient(principal, patientId);
    return this.loadMealChat(patientId, mealId);
  }

  /**
   * A caregiver message (text and/or photos). The first one also becomes the meal's description, so the meal leaves
   * "awaiting description"; the AI answers in a job (meal.chat_reply).
   */
  async postMealChatMessage(
    principal: RequestPrincipal,
    patientId: string,
    mealId: string,
    input: { content?: unknown; photo_ids?: unknown },
    idempotencyKey: string,
  ): Promise<Record<string, unknown>> {
    await this.assertCanWritePatient(principal, patientId);
    const content = typeof input.content === 'string' ? input.content.trim() : '';
    // Same rules as the main chat: duplicates are dropped, anything but photo ids is refused.
    const photoIds = parsePhotoIds(input.photo_ids);
    if (content.length > 2000) throw new ValidationError('content must be at most 2000 characters');
    if (!content && photoIds.length === 0) throw new ValidationError('A message needs text or a photo');
    if (!idempotencyKey || idempotencyKey.length > 200) throw new ValidationError('Idempotency-Key header is required');
    const identity = await this.resolveMealIdentity(patientId, mealId);
    if ((await this.mealChatRepository.countPhotosOfMeal(patientId, mealId, photoIds)) !== photoIds.length) {
      throw new ValidationError('Unknown photo id for this meal');
    }

    const { message } = await this.mealChatRepository.insertUserMessage({
      patientId,
      mealRecordId: mealId,
      content,
      photoIds,
      authorUserId: principal.user_id,
      idempotencyKey,
    });
    const record = await this.mealRecordRepository.getMealRecord(patientId, identity);
    if (record.status === 'AWAITING_DESCRIPTION' || record.status === 'INCOMPLETE') {
      try {
        await this.mealRecordRepository.recordDescription(patientId, identity, {
          description: content || 'Zdjęcie posiłku',
          photo_ref: photoIds[0] ? `photo:${photoIds[0]}` : null,
        });
      } catch (error) {
        // The other caregiver's first message described the meal a moment earlier: this message still gets its reply.
        if (!(error instanceof ConflictError)) throw error;
      }
    }
    await this.repository.insertJob({
      jobType: MEAL_CHAT_REPLY_JOB_TYPE,
      payloadVersion: 1,
      payload: { patient_id: patientId, meal_record_id: mealId, user_message_id: message.id },
      dedupeKey: buildMealChatReplyDedupeKey(message.id),
      correlationId: mealId,
      causationId: message.id,
      patientId,
      availableAt: new Date().toISOString(),
      maxAttempts: 3,
    });
    return this.loadMealChat(patientId, mealId);
  }

  /**
   * Accepts the proposal of one AI message: the meal's pending proposal is confirmed as such; any other (an older one,
   * or a new one for an already confirmed meal) is saved as the caregiver's values.
   */
  async acceptMealChatProposal(principal: RequestPrincipal, patientId: string, mealId: string, messageId: string, input: { expected_revision?: unknown } = {}): Promise<Record<string, unknown>> {
    await this.assertCanWritePatient(principal, patientId);
    // Checked by the first write only: the later ones follow this caregiver's own first write.
    let expectedRevision = parseExpectedRevision(input.expected_revision);
    const guarded = () => {
      const options = { expectedRevision };
      expectedRevision = null;
      return options;
    };
    if (!UUID_PATTERN.test(messageId)) throw new NotFoundError('Message not found');
    const identity = await this.resolveMealIdentity(patientId, mealId);
    const message = await this.mealChatRepository.getMessage(patientId, mealId, messageId);
    if (!message || message.role !== 'ASSISTANT' || !message.proposal) {
      throw new NotFoundError('Proposal not found');
    }
    const record = await this.mealRecordRepository.getMealRecord(patientId, identity);
    // The meal is described by what was recognised ("Skyr Polmlek truskawka i kiwi (75 g)"), not by the first chat
    // message ("Pół opakowania"): similar meals for dose questions are found by these words.
    const recognised = describeMealItems(message.proposal.items);
    if (expectedRevision !== null && expectedRevision !== record.content_revision) {
      throw new StaleWriteError(`MEAL_CHANGED: meal ${mealId} is at revision ${record.content_revision}, the save was based on ${expectedRevision}`);
    }
    if (recognised && recognised !== record.description) {
      await this.mealRecordRepository.updateDescription(patientId, identity, recognised, guarded());
    }
    // The items become the meal's own (043), so a later change ("one slice less") has them to start from.
    const items = sanitizeMealItems(message.proposal.items);
    const withItems = { items: 'items' in items ? items.items : null };
    if (message.proposal.proposal_id && record.status === 'AI_PROPOSED' && record.pending_proposal_id === message.proposal.proposal_id) {
      await this.mealRecordRepository.confirmProposal(patientId, identity, principal.user_id, message.proposal.proposal_id, { ...guarded(), ...withItems });
    } else {
      await this.mealRecordRepository.correctMacros(patientId, identity, principal.user_id, {
        carbs_g: message.proposal.carbs_g,
        protein_g: message.proposal.protein_g,
        fat_g: message.proposal.fat_g,
      }, { ...guarded(), ...withItems });
    }
    await this.applyAutoWbtReminder(patientId, mealId, identity);
    return this.loadMealChat(patientId, mealId);
  }

  /** Asks the AI again for the last caregiver message whose reply failed. */
  async retryMealChatReply(principal: RequestPrincipal, patientId: string, mealId: string): Promise<Record<string, unknown>> {
    await this.assertCanWritePatient(principal, patientId);
    await this.resolveMealIdentity(patientId, mealId);
    const messages = await this.mealChatRepository.listMessages(patientId, mealId);
    const lastUser = [...messages].reverse().find((message) => message.role === 'USER');
    if (lastUser && !messages.some((message) => message.reply_to_message_id === lastUser.id)) {
      await this.repository.requeueFailedJob(MEAL_CHAT_REPLY_JOB_TYPE, buildMealChatReplyDedupeKey(lastUser.id));
    }
    return this.loadMealChat(patientId, mealId);
  }

  private async loadMealChat(patientId: string, mealId: string): Promise<Record<string, unknown>> {
    const meal = await this.loadMealView(patientId, mealId);
    const messages: MealChatMessage[] = await this.mealChatRepository.listMessages(patientId, mealId);
    const lastUser = [...messages].reverse().find((message) => message.role === 'USER');
    const answered = lastUser ? messages.some((message) => message.reply_to_message_id === lastUser.id) : true;
    const jobStatus = lastUser && !answered
      ? await this.repository.getJobStatusByDedupeKey(MEAL_CHAT_REPLY_JOB_TYPE, buildMealChatReplyDedupeKey(lastUser.id))
      : null;
    const failed = jobStatus === 'failed';
    const pending = Boolean(lastUser && !answered && !failed);
    return {
      patient_id: patientId,
      meal,
      messages,
      reply_pending: pending,
      reply_failed: Boolean(lastUser && !answered && failed),
      reply_draft: pending ? await this.loadReplyDraft('MEAL_CHAT', patientId, mealId, messages) : null,
    };
  }

  /** Caregiver switches the WBT reminder of a meal on or off; AUTO never overrides this choice afterwards. */
  async setMealWbtReminder(principal: RequestPrincipal, patientId: string, mealId: string, input: { enabled?: unknown }): Promise<{ patient_id: string; meal: Record<string, unknown> }> {
    await this.assertCanWritePatient(principal, patientId);
    if (typeof input.enabled !== 'boolean') throw new ValidationError('enabled must be true or false');
    const identity = await this.resolveMealIdentity(patientId, mealId);
    const record = await this.mealRecordRepository.getMealRecord(patientId, identity);
    if (input.enabled) await this.assertWbtReminderCanStart(patientId, mealId, record.started_at, new Date());
    await this.mealWbtRepository.setManualReminder({ patientId, mealRecordId: mealId, enabled: input.enabled, remindAt: wbtReminderAt(record.started_at), userId: principal.user_id });
    return { patient_id: patientId, meal: await this.loadMealView(patientId, mealId) };
  }

  /** A WBT reminder is switched on only while it can still come: 2.5 h after the meal, and not once sent or expired. */
  private async assertWbtReminderCanStart(patientId: string, mealId: string, startedAt: string, now: Date): Promise<void> {
    const existing = await this.mealWbtRepository.getReminder(patientId, mealId);
    if (existing && existing.status !== 'SCHEDULED') throw new ConflictError('WBT_REMINDER_SETTLED: To przypomnienie o WBT już minęło.');
    if (Date.parse(existing?.remind_at ?? wbtReminderAt(startedAt)) <= now.getTime()) throw new ConflictError('WBT_REMINDER_PASSED: Minęło już 2,5 h od posiłku.');
  }

  /** Asks the AI for a WBT dose for this meal (job meal.wbt_suggestion); the answer is read with getMealWbtSuggestion. */
  async requestMealWbtSuggestion(principal: RequestPrincipal, patientId: string, mealId: string): Promise<Record<string, unknown>> {
    await this.assertCanWritePatient(principal, patientId);
    await this.resolveMealIdentity(patientId, mealId);
    // Checked and created under the meal's lock: two caregivers tapping at once start one paid AI call.
    const { id: suggestionId, created } = await this.mealWbtRepository.createSuggestionIfNonePending(patientId, mealId, principal.user_id);
    if (created) {
      await this.repository.insertJob({
        jobType: MEAL_WBT_SUGGESTION_JOB_TYPE,
        payloadVersion: 1,
        payload: { patient_id: patientId, meal_record_id: mealId, suggestion_id: suggestionId },
        dedupeKey: `${MEAL_WBT_SUGGESTION_JOB_TYPE}:${suggestionId}`,
        correlationId: mealId,
        causationId: suggestionId,
        patientId,
        availableAt: new Date().toISOString(),
        maxAttempts: 2,
      });
    }
    return this.getMealWbtSuggestionView(patientId, mealId, principal.user_id);
  }

  /** The meal's WBT conversation (wbt-chat.v1), created on first use; its id opens it like any conversation. */
  async openMealWbtConversation(principal: RequestPrincipal, patientId: string, mealId: string): Promise<Record<string, unknown>> {
    await this.assertCanWritePatient(principal, patientId);
    const identity = await this.resolveMealIdentity(patientId, mealId);
    const record = await this.mealRecordRepository.getMealRecord(patientId, identity);
    const conversationId = await this.mealWbtRepository.getOrCreateWbtConversation(patientId, mealId, wbtConversationTitle(record.started_at));
    return { patient_id: patientId, meal_id: mealId, conversation_id: conversationId };
  }

  async getMealWbtSuggestion(principal: RequestPrincipal, patientId: string, mealId: string): Promise<Record<string, unknown>> {
    await this.assertCanReadPatient(principal, patientId);
    await this.resolveMealIdentity(patientId, mealId);
    return this.getMealWbtSuggestionView(patientId, mealId, principal.user_id);
  }

  private async getMealWbtSuggestionView(patientId: string, mealId: string, viewerUserId: string): Promise<Record<string, unknown>> {
    const suggestion = await this.mealWbtRepository.getLatestSuggestion(patientId, mealId);
    return { patient_id: patientId, meal: await this.loadMealView(patientId, mealId), suggestion, remote_command: await this.wbtRemoteCommand(patientId, mealId, viewerUserId) };
  }

  /** The meal's last WBT command with when it was authorized: the WBT conversation's newest card shows it once sent. */
  private async wbtCommandForChat(patientId: string, mealId: string, viewerUserId: string): Promise<{ view: Record<string, unknown>; authorized_at: string | null } | null> {
    try {
      const command = await this.remoteCommandRepository.latestWbtForMeal(patientId, mealId);
      if (!command || command.status === 'EXPIRED' || command.status === 'SEND_FAILED') return null;
      return { view: sentCommandView(command, viewerUserId, new Date()), authorized_at: command.authorized_at ?? null };
    } catch {
      return null;
    }
  }

  /** The WBT window's last command to Trio, shown on its card like a chat card's (none before migration 049). */
  private async wbtRemoteCommand(patientId: string, mealId: string, viewerUserId: string): Promise<Record<string, unknown> | null> {
    try {
      const command = await this.remoteCommandRepository.latestWbtForMeal(patientId, mealId);
      if (!command || command.status === 'EXPIRED' || command.status === 'SEND_FAILED') return null;
      return sentCommandView(command, viewerUserId, new Date());
    } catch {
      return null;
    }
  }

  /**
   * After the meal's values changed: the AUTO WBT reminder follows its protein and fat (no-op when the caregiver chose
   * MANUALly), and its open later parts its carbs (migration 076: carbs removed before the second part).
   */
  private async applyAutoWbtReminder(patientId: string, mealId: string, identity: string): Promise<void> {
    const record = await this.mealRecordRepository.getMealRecord(patientId, identity);
    const macros = { protein_g: record.macros.protein.grams, fat_g: record.macros.fat.grams };
    await this.mealWbtRepository.setAutoReminder({ patientId, mealRecordId: mealId, enabled: shouldRemindAboutWbt(macros), remindAt: wbtReminderAt(record.started_at) });
    const step = pumpBolusStep(await this.pumpBolusStepFor(patientId, new Date())) ?? 0.05;
    const origin = record.macros.carbs.origin;
    const excess = await this.plannedBoluses.followMealCarbs(patientId, mealId, record.macros.carbs.grams, step, {
      carbsFromCaregiver: origin !== null && origin !== 'NIGHTSCOUT_ENTRY',
    });
    if (excess && excess.after_g > excess.before_g) await this.queueMealExcessPush(patientId, mealId, record, { grams: excess.after_g, insulin_u: excess.excess_u, kind: 'LATER_PARTS' });
    // Any other meal with a bolus: its carbs now against the carbs its insulin was given for.
    else if (origin !== null && origin !== 'NIGHTSCOUT_ENTRY') await this.noticeMealDoseExcess(patientId, mealId, record).catch(() => undefined);
  }

  /** A meal without later parts whose carbs dropped below its insulin's: a push when the excess grows (migration 084). */
  private async noticeMealDoseExcess(patientId: string, mealId: string, record: MealRecord): Promise<void> {
    if ((await this.plannedBolusRepository.listForMeal(patientId, mealId)).length > 0) return;
    const excess = mealDoseExcess({ actions: await this.loopActions.listActionsForMeals(patientId, [mealId]), meal_carbs_g: record.macros.carbs.grams });
    const grams = excess?.grams ?? 0;
    const notified = await this.mealJournal.notifiedDoseExcess(patientId, mealId);
    if (grams === notified) return;
    await this.mealJournal.setNotifiedDoseExcess(patientId, mealId, grams);
    if (excess && grams > notified) await this.queueMealExcessPush(patientId, mealId, record, { grams, insulin_u: excess.insulin_u, kind: 'MEAL' });
  }

  /**
   * Carbs removed beyond the later parts: every caregiver's phone is told the insulin given was too
   * much. Queued in the push outbox; the worker sends it within half a minute and tries again if APNs fails.
   */
  private async queueMealExcessPush(patientId: string, mealId: string, record: MealRecord, excess: { grams: number; insulin_u: number | null; kind: 'LATER_PARTS' | 'MEAL' }): Promise<void> {
    const line = mealExcessLine(excess.grams, excess.insulin_u, excess.kind);
    if (!line) return;
    const name = (record.description ?? '').replace(/\s+/g, ' ').trim();
    const shortName = name.length > 40 ? `${name.slice(0, 39).replace(/[\s,;]+$/, '')}…` : name;
    const now = new Date();
    const key = `meal-excess:${mealId}:${excess.grams}:${now.getTime()}`;
    try {
      await this.pushOutbox.enqueue({
        dedupeKey: key,
        patientId,
        request: { kind: 'care_reminder', input: { patientId, conversationId: null, mealId, reminderId: key, title: 'Za duża dawka po zmianie posiłku', body: shortName ? `${shortName}: ${line}` : line } },
        excludeUserId: null,
        expiresAt: new Date(now.getTime() + 60 * 60_000).toISOString(),
        nextAttemptAt: now.toISOString(),
      });
    } catch {
      // The warning on the meal page stays; only the push is lost (migration 079 not applied).
    }
  }

  private async loadMealWbtView(patientId: string, mealId: string, record: MealRecord): Promise<Record<string, unknown> | null> {
    const macros = { protein_g: record.macros.protein.grams, fat_g: record.macros.fat.grams };
    const reminder = await this.mealWbtRepository.getReminder(patientId, mealId);
    const units = fatProteinUnitsOf(macros.protein_g, macros.fat_g);
    // The standard dose (WBT x 10 / ICR x 30%) with the ICR of the meal's time: the time line's estimate.
    let standardDose: number | null = null;
    if (units !== null && units > 0) {
      try {
        const therapy = await this.repository.getTherapyProfileAt(patientId, record.started_at);
        const icr = scheduleValueAt(therapy?.carb_ratio_g_per_u ?? null, record.started_at, therapy?.timezone ?? resolveHomeTimeZone());
        standardDose = icr ? standardWbtDose(units, icr).dose_units : null;
      } catch {
        standardDose = null;
      }
    }
    return {
      fat_protein_units: units,
      standard_dose_u: standardDose,
      auto_threshold_met: shouldRemindAboutWbt(macros),
      reminder: reminder ? { enabled: reminder.enabled, source: reminder.source, remind_at: reminder.remind_at, status: reminder.status } : null,
    };
  }

  async getMeal(principal: RequestPrincipal, patientId: string, mealId: string): Promise<{ patient_id: string; meal: Record<string, unknown> }> {
    await this.assertCanReadPatient(principal, patientId);
    return { patient_id: patientId, meal: await this.loadMealView(patientId, mealId) };
  }

  /**
   * The Meals tab (meal-journal.v1): meals with a description or a reminder, newest first, a page started before
   * `before`; `next_before` asks for the next page (null: no more).
   */
  async getMealJournal(principal: RequestPrincipal, patientId: string, query: { before?: unknown; after?: unknown; limit?: unknown }, now = new Date()): Promise<{ patient_id: string; items: JournalItem[]; next_before: string | null }> {
    await this.assertCanReadPatient(principal, patientId);
    const limit = clampJournalLimit(query.limit);
    // `before`: an ISO time, or the previous page's cursor "<time>|<meal id>".
    const [beforeTime, beforeId] = typeof query.before === 'string' && query.before.includes('|') ? query.before.split('|', 2) : [query.before, undefined];
    if (beforeId !== undefined && !UUID_PATTERN.test(beforeId)) throw new ValidationError('before must be an ISO timestamp');
    const before = optionalIsoQuery(beforeTime, 'before');
    const after = optionalIsoQuery(query.after, 'after');
    const rows = await this.mealJournal.listJournalMeals(patientId, before, limit + 1, after, beforeId ?? null);
    const page = rows.slice(0, limit);
    const items = await this.journalItems(patientId, page.map((row) => row.meal_record_id), now);
    return {
      patient_id: patientId,
      items: page.map((row) => items.get(row.meal_record_id)).filter((item): item is JournalItem => item !== undefined),
      next_before: rows.length > limit ? `${page[page.length - 1].started_at}|${page[page.length - 1].meal_record_id}` : null,
    };
  }

  /** The calendar's dots: when the journal's meals between `from` and `to` started (at most 62 days at once). */
  async getMealJournalDays(principal: RequestPrincipal, patientId: string, query: { from?: unknown; to?: unknown }): Promise<{ patient_id: string; starts: string[] }> {
    await this.assertCanReadPatient(principal, patientId);
    const from = optionalIsoQuery(query.from, 'from');
    const to = optionalIsoQuery(query.to, 'to');
    if (!from || !to) throw new ValidationError('from and to are required');
    const span = Date.parse(to) - Date.parse(from);
    if (span <= 0 || span > 62 * 24 * 60 * 60_000) throw new ValidationError('from must be before to, at most 62 days');
    return { patient_id: patientId, starts: await this.mealJournal.listJournalMealStarts(patientId, from, to) };
  }

  /** Meals whose description has the text (case and diacritics folded), newest first, with glucose 4 h after. */
  async searchMeals(principal: RequestPrincipal, patientId: string, query: { q?: unknown; limit?: unknown }, now = new Date()): Promise<{ patient_id: string; query: string; items: Array<JournalItem & { glucose_peak_mgdl: number | null; glucose_min_mgdl: number | null }> }> {
    await this.assertCanReadPatient(principal, patientId);
    const text = parseMealSearchQuery(query.q);
    if (text === null) throw new ValidationError('q must be 1-100 characters');
    const rows = await this.mealJournal.searchMeals(patientId, likePattern(text), clampJournalLimit(query.limit));
    const items = await this.journalItems(patientId, rows.map((row) => row.meal_record_id), now);
    return {
      patient_id: patientId,
      query: text,
      items: rows.flatMap((row) => {
        const item = items.get(row.meal_record_id);
        return item ? [{ ...item, glucose_peak_mgdl: row.glucose_peak_mgdl, glucose_min_mgdl: row.glucose_min_mgdl }] : [];
      }),
    };
  }

  /**
   * A meal's page in the new Meals tab: the journal item with its description and values (and whether a save may name
   * its revision), glucose from 30 min before to 6 h after the start (or now), its boluses and a time line.
   */
  async getMealOverview(principal: RequestPrincipal, patientId: string, mealId: string, now = new Date()): Promise<{ patient_id: string; overview: Record<string, unknown> }> {
    await this.assertCanReadPatient(principal, patientId);
    const identity = await this.resolveMealIdentity(patientId, mealId);
    const record = await this.mealRecordRepository.getMealRecord(patientId, identity);
    // A cancelled meal (or one merged into another) is not in the journal: a push or bell link to it finds nothing.
    const facts = record.status === 'CANCELLED' ? undefined : (await this.journalFacts(patientId, [mealId]))[0];
    if (!facts) throw new NotFoundError('Meal not found');
    const item = buildJournalItem(facts, now);
    const startMs = Date.parse(record.started_at);
    const chartFrom = new Date(startMs - MEAL_JOURNAL_POLICY.chart_before_minutes * 60_000).toISOString();
    const chartUntil = new Date(Math.min(startMs + MEAL_JOURNAL_POLICY.chart_after_hours * 3_600_000, now.getTime())).toISOString();
    const glucose = Number.isFinite(startMs)
      ? await this.repository.listGlucoseReadingsBetween(patientId, chartFrom, chartUntil)
      : [];
    // Boluses on no meal in the chart's window: the chart shows all the insulin given, not only the meal's.
    const windowActions = Number.isFinite(startMs)
      ? await this.loopActions.listActionsBetween(patientId, chartFrom, new Date(Date.parse(chartUntil) + 60_000).toISOString()).catch(() => [])
      : [];
    const otherActions = windowActions.filter((action) => action.meal_record_id === null);
    const senders = await this.mealJournal.sendersForActions(patientId, [...facts.actions, ...otherActions].map((action) => action.id)).catch(() => new Map<string, string | null>());
    const boluses = journalBoluses(facts.actions, facts.awaiting_units, senders);
    const otherBoluses = chartOtherBoluses(otherActions, new Set(facts.actions.map((action) => action.id)), senders);
    // Insulin given by hand since the meal's bolus, whatever it was for (another phone, Trio): said next to a reminder
    // that has come, so a dose already given is not given twice. Null when it cannot be read.
    const givenSinceStart = await this.givenSinceMealStart(patientId, record.started_at, now).catch(() => null);
    const doseExcess = await this.mealDoseExcess(patientId, mealId, record).catch(() => null);
    return {
      patient_id: patientId,
      overview: {
        ...item,
        description: record.description,
        status: record.status,
        trusted: isTrustedMealRecord(record),
        // Sent back as expected_revision with a caregiver save (refused when the other caregiver saved first).
        content_revision: record.content_revision ?? null,
        macros: record.macros,
        items: record.items ?? null,
        has_photo: record.has_photo,
        pending_proposal_id: record.pending_proposal_id ?? null,
        glucose,
        boluses,
        other_boluses: otherBoluses,
        timeline: journalTimeline(boluses, item.reminders),
        given_since_start: givenSinceStart,
        // Carbs removed beyond the later parts: the insulin given was too much. Null: none.
        dose_excess: doseExcess,
      },
    };
  }

  private async mealDoseExcess(patientId: string, mealId: string, record: MealRecord): Promise<{ grams: number; insulin_u: number | null; message: string } | null> {
    const parts = await this.plannedBolusRepository.listForMeal(patientId, mealId);
    if (parts.length === 0) {
      // A meal without later parts: its carbs now against its insulin's, once a caregiver set them.
      const origin = record.macros.carbs.origin;
      if (origin === null || origin === 'NIGHTSCOUT_ENTRY') return null;
      const excess = mealDoseExcess({ actions: await this.loopActions.listActionsForMeals(patientId, [mealId]), meal_carbs_g: record.macros.carbs.grams });
      const message = excess ? mealExcessLine(excess.grams, excess.insulin_u, 'MEAL') : null;
      return excess && message ? { ...excess, message } : null;
    }
    const grams = parts.reduce((sum, part) => sum + (part.meal_excess_g ?? 0), 0);
    if (grams <= 0) return null;
    const icr = parts.find((part) => part.icr_g_per_u && part.icr_g_per_u > 0)?.icr_g_per_u ?? null;
    const insulin = icr ? Math.round((grams / icr) * 100) / 100 : null;
    const message = mealExcessLine(grams, insulin);
    return message ? { grams, insulin_u: insulin, message } : null;
  }

  private async givenSinceMealStart(patientId: string, mealStartedAt: string, now: Date): Promise<GivenSinceMeal> {
    const actions = await this.loopActions.listActionsBetween(patientId, mealStartedAt, new Date(now.getTime() + 60_000).toISOString());
    const [senders, caregiverCount, loopSystem] = await Promise.all([
      this.mealJournal.sendersForActions(patientId, actions.map((action) => action.id)),
      this.mealJournal.caregiverCount(patientId).catch(() => 1),
      patientLoopSystem(this.dashboardRepository, patientId),
    ]);
    // The same clock as the reminders' pushes, so the page and the push say the same times.
    return givenSinceMeal({ mealStartedAt, now, timeZone: resolveHomeTimeZone(), actions, senders, caregiverCount, loopName: loopSystemNames(loopSystem.kind).nominative });
  }

  /**
   * Switches one of a meal's reminders on or off (writers): `wbt` is the meal's WBT reminder (the caregiver's own choice
   * from then on), another id a second dose (cancelled, or back on while it can still come) or a planned later part
   * (skipped; a skipped part is not planned again). Returns the meal's journal item.
   */
  async setMealReminderEnabled(principal: RequestPrincipal, patientId: string, mealId: string, reminderId: string, body: { enabled?: unknown }, now = new Date()): Promise<{ patient_id: string; item: JournalItem }> {
    await this.assertCanWritePatient(principal, patientId);
    if (typeof body?.enabled !== 'boolean') throw new ValidationError('enabled must be true or false');
    const enabled = body.enabled;
    const identity = await this.resolveMealIdentity(patientId, mealId);
    // A cancelled meal's reminders are not switched (nothing is written before refusing).
    const record = await this.mealRecordRepository.getMealRecord(patientId, identity);
    if (record.status === 'CANCELLED') throw new NotFoundError('Meal not found');
    if (reminderId === 'wbt') {
      if (enabled) await this.assertWbtReminderCanStart(patientId, mealId, record.started_at, now);
      await this.mealWbtRepository.setManualReminder({ patientId, mealRecordId: mealId, enabled, remindAt: wbtReminderAt(record.started_at), userId: principal.user_id });
    } else {
      if (!UUID_PATTERN.test(reminderId)) throw new NotFoundError('Reminder not found');
      const care = await this.careReminderRepository.get(patientId, reminderId);
      const plan = care ? null : await this.plannedBolusRepository.get(patientId, reminderId).catch(() => null);
      if (care && care.meal_record_id === mealId) {
        await this.toggleCareReminder(patientId, principal.user_id, care, enabled);
      } else if (plan && plan.meal_record_id === mealId) {
        const open = OPEN_PLANNED_BOLUS_STATUSES.includes(plan.status);
        if (!enabled && open) await this.plannedBoluses.skip(patientId, principal.user_id, plan.id);
        else if (enabled && !open) throw new ConflictError('PLANNED_PART_SETTLED: Tej części bolusa nie można już włączyć.');
        else if (!enabled && plan.status !== 'SKIPPED' && plan.status !== 'CANCELLED') throw new ConflictError('PLANNED_PART_SETTLED: Ta część bolusa nie jest już zaplanowana.');
      } else {
        throw new NotFoundError('Reminder not found');
      }
    }
    const item = (await this.journalItems(patientId, [mealId], now)).get(mealId);
    if (!item) throw new NotFoundError('Meal not found');
    return { patient_id: patientId, item };
  }

  /** Off: an active reminder is cancelled; on: a cancelled one comes back while its time has not passed. Idempotent. */
  private async toggleCareReminder(patientId: string, userId: string, reminder: CareReminderRecord, enabled: boolean): Promise<void> {
    if (enabled ? reminder.status === 'ACTIVE' : reminder.status === 'CANCELLED') return;
    if (reminder.status === 'FIRED' || reminder.status === 'EXPIRED' || reminder.status === 'MISSED' || reminder.status === 'GIVEN') {
      throw new ConflictError('CARE_REMINDER_SETTLED: To przypomnienie już minęło.');
    }
    const changed = enabled ? await this.careReminderRepository.reactivate(patientId, reminder.id) : await this.careReminderRepository.cancel(patientId, reminder.id, userId);
    if (!changed) throw new ConflictError(enabled ? 'CARE_REMINDER_PASSED: Czas tego przypomnienia już minął.' : 'CARE_REMINDER_SETTLED: To przypomnienie nie jest już aktywne.');
  }

  /** Journal items of these meals (a meal that cannot be read is left out). */
  private async journalItems(patientId: string, mealIds: string[], now: Date): Promise<Map<string, JournalItem>> {
    const facts = await this.journalFacts(patientId, mealIds);
    return new Map(facts.map((fact) => [fact.meal_id, buildJournalItem(fact, now)]));
  }

  /** What journal items are built from, read for the whole page at once (meal values one by one, a few at a time). */
  private async journalFacts(patientId: string, mealIds: string[]): Promise<JournalFacts[]> {
    if (mealIds.length === 0) return [];
    const records = await mapWithConcurrency(mealIds, LIST_LOAD_CONCURRENCY, async (mealId) => {
      const identity = await this.mealRecordRepository.findMealIdentityById(patientId, mealId).catch(() => null);
      return identity ? { mealId, record: await this.mealRecordRepository.getMealRecord(patientId, identity).catch(() => null) } : { mealId, record: null };
    });
    const [actions, origins, wbt, care, parts] = await Promise.all([
      this.loopActions.listActionsForMeals(patientId, mealIds),
      this.mealJournal.mealOrigins(patientId, mealIds),
      this.mealWbtRepository.listRemindersForMeals(patientId, mealIds),
      // Second doses (migration 073) and planned parts (050): none when not installed.
      this.careReminderRepository.listForMeals(patientId, mealIds).catch(() => []),
      this.plannedBolusRepository.listForMeals(patientId, mealIds).catch(() => []),
    ]);
    const missing = actions.filter((action) => action.bolus_units === null).map((action) => action.id);
    const confirmed = missing.length > 0 ? await this.remoteCommandRepository.confirmedBolusesForActions(patientId, missing).catch(() => new Map<string, { units: number }>()) : new Map<string, { units: number }>();
    const awaiting = new Map([...confirmed].map(([id, bolus]) => [id, bolus.units]));
    return records.flatMap(({ mealId, record }) => {
      if (!record || record.status === 'CANCELLED') return [];
      const mealActions: JournalAction[] = actions.filter((action) => action.meal_record_id === mealId).map((action) => ({
        id: action.id,
        purpose: action.purpose,
        started_at: action.started_at,
        carbs_g: action.carbs_g,
        bolus_units: action.bolus_units,
        assigned_by: action.assigned_by,
      }));
      const reminder = wbt.find((row) => row.meal_record_id === mealId) ?? null;
      return [{
        meal_id: mealId,
        started_at: record.started_at,
        description: record.description,
        carbs_g: record.macros.carbs.grams ?? record.source_carbs_g,
        protein_g: record.macros.protein.grams,
        fat_g: record.macros.fat.grams,
        actions: mealActions,
        awaiting_units: awaiting,
        origin: origins.get(mealId) ?? { first_command_source: null, conversation_id: null },
        wbt: reminder ? { enabled: reminder.enabled, source: reminder.source, remind_at: reminder.remind_at, status: reminder.status, sent_at: reminder.sent_at, dose_given_at: reminder.dose_given_at ?? null, skip_reason: reminder.skip_reason ?? null } : null,
        care: care.filter((row) => row.meal_record_id === mealId),
        parts: parts.filter((row) => row.meal_record_id === mealId),
      }];
    });
  }

  /** Caregiver edits the meal description (values are edited with correctMealMacros). */
  async updateMealDescription(principal: RequestPrincipal, patientId: string, mealId: string, input: { description?: unknown; expected_revision?: unknown }): Promise<{ patient_id: string; meal: Record<string, unknown> }> {
    await this.assertCanWritePatient(principal, patientId);
    const description = typeof input.description === 'string' ? input.description.trim() : '';
    if (!description || description.length > 2000) {
      throw new ValidationError('description must be 1-2000 characters');
    }
    const identity = await this.resolveMealIdentity(patientId, mealId);
    await this.mealRecordRepository.updateDescription(patientId, identity, description, { expectedRevision: parseExpectedRevision(input.expected_revision) });
    return { patient_id: patientId, meal: await this.loadMealView(patientId, mealId) };
  }

  /** Caregiver enters or edits the values; each given value is attributed to the caregiver. */
  async correctMealMacros(
    principal: RequestPrincipal,
    patientId: string,
    mealId: string,
    input: { carbs_g?: unknown; protein_g?: unknown; fat_g?: unknown; expected_revision?: unknown },
  ): Promise<{ patient_id: string; meal: Record<string, unknown> }> {
    await this.assertCanWritePatient(principal, patientId);
    const grams = (value: unknown, name: string): number | null => {
      if (value === null || value === undefined) return null;
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1000) {
        throw new ValidationError(`${name} must be a number between 0 and 1000 or null`);
      }
      return value;
    };
    const macros = { carbs_g: grams(input.carbs_g, 'carbs_g'), protein_g: grams(input.protein_g, 'protein_g'), fat_g: grams(input.fat_g, 'fat_g') };
    if (macros.carbs_g === null && macros.protein_g === null && macros.fat_g === null) {
      throw new ValidationError('At least one of carbs_g, protein_g or fat_g is required');
    }
    const identity = await this.resolveMealIdentity(patientId, mealId);
    await this.mealRecordRepository.correctMacros(patientId, identity, principal.user_id, macros, { expectedRevision: parseExpectedRevision(input.expected_revision) });
    await this.applyAutoWbtReminder(patientId, mealId, identity);
    return { patient_id: patientId, meal: await this.loadMealView(patientId, mealId) };
  }

  private async resolveMealIdentity(patientId: string, mealId: string): Promise<string> {
    let identity: string | null;
    try {
      identity = await this.mealRecordRepository.findMealIdentityById(patientId, mealId);
    } catch (error) {
      // Migration 027 not applied yet: the new meal history does not exist.
      if ((error as { code?: string })?.code === '42P01') throw new NotFoundError('Meal not found');
      throw error;
    }
    if (!identity) throw new NotFoundError('Meal not found');
    return identity;
  }

  private async loadMealView(patientId: string, mealId: string): Promise<Record<string, unknown>> {
    const record: MealRecord = await this.mealRecordRepository.getMealRecord(patientId, await this.resolveMealIdentity(patientId, mealId));
    return {
      meal_id: mealId,
      // The Nightscout carb entry that started the meal (opens its page in the meal calendar).
      anchor_event_id: await this.mealRecordRepository.getAnchorEventId(patientId, mealId),
      status: record.status,
      started_at: record.started_at,
      source_carbs_g: record.source_carbs_g,
      description: record.description,
      has_photo: record.has_photo,
      macros: record.macros,
      pending_proposal_id: record.pending_proposal_id ?? null,
      // What the meal consisted of (name, grams, macros), when known.
      items: record.items ?? null,
      // Sent back as expected_revision with a caregiver save, which is refused if the other caregiver saved first.
      content_revision: record.content_revision ?? null,
      // No macro proposal job runs any more (the description endpoints that queued it are gone): none is in progress,
      // and a DESCRIBED meal gets none. Both fields stay because the app decodes them.
      proposal_in_progress: false,
      proposal_failed: record.status === 'DESCRIBED',
      trusted: isTrustedMealRecord(record),
      wbt: await this.loadMealWbtView(patientId, mealId, record),
      // Doses of the loop actions assigned to this meal (loop-actions.v1); null for meals without any.
      insulin: await this.loadMealInsulin(patientId, mealId, record.started_at),
      // A remote bolus Trio refused for this meal, and whether it may be given now.
      remote_bolus: await this.loadMealRemoteBolus(patientId, mealId),
      // The planned second part of a split meal bolus (the grey clock on the meal's rail and chart).
      planned_bolus: await this.loadMealPlannedBolus(patientId, mealId),
      // Every planned later part (the meal's time line, each with its switch-off).
      planned_parts: await this.plannedBoluses.summariesForMeal(patientId, mealId).catch(() => []),
    };
  }

  private async loadMealPlannedBolus(patientId: string, mealId: string): Promise<PlannedBolusSummary | null> {
    try {
      return await this.plannedBoluses.summaryForMeal(patientId, mealId);
    } catch {
      // Migration 050 not applied: no split boluses.
      return null;
    }
  }

  /** Per card: every planned later part and its meal's WBT reminder (none before the meal was saved). */
  private async cardRemindersFor(patientId: string, cards: BolusProposalWithCommand[]): Promise<Map<string, { planned_parts: PlannedBolusSummary[]; wbt_reminder: Record<string, unknown> | null }>> {
    const out = new Map<string, { planned_parts: PlannedBolusSummary[]; wbt_reminder: Record<string, unknown> | null }>();
    const ids = cards.filter((card) => card.proposal.split !== null).map((card) => card.proposal.id);
    const parts = ids.length > 0 ? await this.plannedBoluses.allSummariesForProposals(patientId, ids).catch(() => new Map<string, PlannedBolusSummary[]>()) : new Map<string, PlannedBolusSummary[]>();
    for (const { proposal, command } of cards) {
      const mealId = command?.meal_record_id ?? null;
      const reminder = mealId ? await this.mealWbtRepository.getReminder(patientId, mealId).catch(() => null) : null;
      const planned = parts.get(proposal.id) ?? [];
      if (planned.length === 0 && !reminder) continue;
      // A WBT dose given for the meal settles the reminder on the card (as on the meal's tile).
      const wbtGiven = reminder && mealId
        ? (await this.loopActions.listActionsForMeals(patientId, [mealId]).catch(() => []))
          .filter((action) => action.purpose === 'WBT' && (action.bolus_units ?? 0) > 0)
          .reduce((total, action) => total + (action.bolus_units ?? 0), 0)
        : 0;
      out.set(proposal.id, {
        planned_parts: planned,
        wbt_reminder: reminder && mealId
          ? { meal_id: mealId, remind_at: reminder.remind_at, status: reminder.status, enabled: reminder.enabled, source: reminder.source, given_units: wbtGiven > 0 ? Math.round(wbtGiven * 100) / 100 : null }
          : null,
      });
    }
    return out;
  }

  /** The planned parts of the conversation's split cards (none before migration 050). */
  private async plannedBolusesForCards(patientId: string, cards: BolusProposalWithCommand[]): Promise<Map<string, PlannedBolusSummary>> {
    const ids = cards.filter((card) => card.proposal.split !== null).map((card) => card.proposal.id);
    if (ids.length === 0) return new Map();
    try {
      return await this.plannedBoluses.summariesForProposals(patientId, ids);
    } catch {
      return new Map();
    }
  }

  /**
   * The planned second part of a meal's split bolus as its card shows it: what was given, the deferred carbs and the
   * dose now (ICR now minus the loop's extra insulin since the meal), the command sent for it and who settled it.
   */
  async getMealPlannedBolus(principal: RequestPrincipal, patientId: string, mealId: string, plannedBolusId?: string | null): Promise<Record<string, unknown>> {
    await this.assertCanReadPatient(principal, patientId);
    const identity = await this.resolveMealIdentity(patientId, mealId);
    return this.plannedBolusView(patientId, mealId, identity, principal.user_id, plannedBolusId ?? null);
  }

  /** Either caregiver skips the planned part (the reminder and the button disappear on both phones). */
  async skipMealPlannedBolus(principal: RequestPrincipal, patientId: string, mealId: string, body: { planned_bolus_id?: unknown }): Promise<Record<string, unknown>> {
    await this.assertCanWritePatient(principal, patientId);
    const identity = await this.resolveMealIdentity(patientId, mealId);
    if (typeof body?.planned_bolus_id !== 'string') throw new ValidationError('planned_bolus_id is required');
    const plan = await this.plannedBolusRepository.get(patientId, body.planned_bolus_id);
    if (!plan || plan.meal_record_id !== mealId) throw new NotFoundError('Planned bolus not found');
    await this.plannedBoluses.skip(patientId, principal.user_id, plan.id);
    return this.plannedBolusView(patientId, mealId, identity, principal.user_id);
  }

  /** The part a push or a skip named (`plannedBolusId`), else the meal's current one. */
  private async plannedBolusView(patientId: string, mealId: string, identity: string, viewerUserId: string, plannedBolusId: string | null = null): Promise<Record<string, unknown>> {
    const named = plannedBolusId && UUID_PATTERN.test(plannedBolusId) ? await this.plannedBolusRepository.get(patientId, plannedBolusId).catch(() => null) : null;
    const plan = named && named.meal_record_id === mealId ? named : await this.plannedBolusRepository.latestForMeal(patientId, mealId).catch(() => null);
    const meal = await this.loadMealView(patientId, mealId);
    if (!plan) return { patient_id: patientId, meal, planned_bolus: null };
    const now = new Date();
    const command = await this.remoteCommandRepository.latestForPlannedBolus(patientId, plan.id);
    const open = OPEN_PLANNED_BOLUS_STATUSES.includes(plan.status);
    let estimate: SecondPartEstimate | null = null;
    if (open) {
      try {
        estimate = await this.plannedPartEstimate(patientId, plan, identity, now, true);
      } catch {
        estimate = null;
      }
    }
    const sent = command && !['EXPIRED', 'SEND_FAILED'].includes(command.status) ? sentCommandView(command, viewerUserId, now) : null;
    return {
      patient_id: patientId,
      meal,
      planned_bolus: {
        ...toPlannedBolusSummary(plan, open ? command : null),
        meal_started_at: (meal as { started_at?: string }).started_at ?? null,
        icr_at_plan: plan.icr_g_per_u,
        estimate,
        command: sent,
      },
    };
  }

  /**
   * A planned part's dose now (the push's and the meal screen's estimate). `withCalculator` false: before the
   * calculator lowers it, the later_part reference its authorization is held against (dose-calculator.v1, review M2).
   */
  private async plannedPartEstimate(patientId: string, plan: PlannedBolusRecord, identity: string, now: Date, withCalculator: boolean): Promise<SecondPartEstimate> {
    const record = await this.mealRecordRepository.getMealRecord(patientId, identity);
    const [therapy, events, reportedStep] = await Promise.all([
      this.repository.getTherapyProfileAt(patientId, now.toISOString()),
      this.repository.listInsulinDeliveryEventsByRange({ patientId, startAtIso: new Date(Date.parse(record.started_at) - 6 * 3_600_000).toISOString(), endAtIso: now.toISOString() }),
      this.pumpBolusStepFor(patientId, now),
    ]);
    // The card's insulin as delivered (a refused bolus and its retry), not as the first command asked.
    const cardInsulin = await this.plannedBoluses.cardInsulinGiven(plan).catch(() => null);
    // Insulin given by hand since the meal's bolus is taken off, as in the part's push (owner 2026-10-26).
    const manualInsulin = await this.manualInsulinForPlan(patientId, plan, record.started_at, now).catch(() => null);
    // dose-calculator.v1: the dose is lowered for a glucose below target or falling, a drop, or carbs first.
    const forecast = withCalculator
      ? await this.dashboardWithSourcesFor(patientId, now)
        .then(({ sources }) => mealForecastDataFrom({ now, readings: sources.readings, loopStatus: sources.loopStatus, therapy }))
        .catch(() => null)
      : undefined;
    return estimatePlannedBolus({
      forecast,
      plan: cardInsulin === null ? plan : { ...plan, first_insulin_u: cardInsulin },
      meal_started_at: record.started_at,
      loop_extra_from: await this.plannedBoluses.earlierPartGivenAt(plan).catch(() => null),
      now_iso: now.toISOString(),
      therapy,
      events,
      step: pumpBolusStep(reportedStep) ?? 0.05,
      fallback_time_zone: resolveHomeTimeZone(),
      icr_at: scheduleValueAt,
      manual_insulin_u: manualInsulin,
    });
  }

  /** Insulin given by hand for the meal since its bolus that none of its parts or commands accounts for. */
  private async manualInsulinForPlan(patientId: string, plan: PlannedBolusRecord, mealStartedAt: string, now: Date): Promise<number | null> {
    const [actions, used] = await Promise.all([
      this.loopActions.listActionsBetween(patientId, mealStartedAt, new Date(now.getTime() + 60_000).toISOString()),
      this.plannedBolusRepository.usedLoopActionIds(patientId, plan.meal_record_id),
    ]);
    const manual = manualInsulinForPart({ actions, used, meal_record_id: plan.meal_record_id, meal_started_at: mealStartedAt, now });
    return manual.length > 0 ? manual.reduce((total, action) => total + (action.bolus_units ?? 0), 0) : null;
  }

  private async loadMealRemoteBolus(patientId: string, mealId: string): Promise<MealRemoteBolusView | null> {
    try {
      return mealRemoteBolusView(await this.remoteCommandRepository.listForMeal(patientId, mealId), new Date());
    } catch {
      // Migrations 045/047 not applied: no remote commands.
      return null;
    }
  }

  private async loadMealInsulin(patientId: string, mealId: string, startedAt: string): Promise<MealInsulinSummary | null> {
    const actions = await this.loopActions.listActionsForMeals(patientId, [mealId]);
    if (actions.length === 0 || !Number.isFinite(Date.parse(startedAt))) return null;
    const windowEnd = new Date(Date.parse(startedAt) + LOOP_ACTION_POLICY.meal_window_hours * 3_600_000).toISOString();
    const [nextMealStartedAt, smbs] = await Promise.all([
      this.loopActions.nextMealStart(patientId, startedAt),
      this.loopActions.listSmbsBetween(patientId, startedAt, windowEnd),
    ]);
    const summary = summarizeMealInsulin({
      meal_started_at: startedAt,
      next_meal_started_at: nextMealStartedAt,
      actions: actions.filter((action) => action.purpose !== null).map((action) => ({
        id: action.id,
        purpose: action.purpose!,
        started_at: action.started_at,
        carbs_g: action.carbs_g,
        bolus_units: action.bolus_units,
      })),
      smbs,
    });
    return this.withAwaitingBoluses(patientId, summary);
  }

  /** A dose without a bolus whose remote command Trio confirmed: the bolus is on its way to Nightscout. */
  private async withAwaitingBoluses(patientId: string, summary: MealInsulinSummary): Promise<MealInsulinSummary> {
    const missing = summary.doses.filter((dose) => dose.bolus_units === null).map((dose) => dose.loop_action_id);
    if (missing.length === 0) return summary;
    try {
      const confirmed = await this.remoteCommandRepository.confirmedBolusesForActions(patientId, missing);
      if (confirmed.size === 0) return summary;
      return { ...summary, doses: summary.doses.map((dose) => (dose.bolus_units === null && confirmed.has(dose.loop_action_id) ? { ...dose, awaiting_bolus: confirmed.get(dose.loop_action_id)! } : dose)) };
    } catch {
      // Remote commands not installed (migration 046): nothing to wait for.
      return summary;
    }
  }

  async registerDevice(
    principal: RequestPrincipal,
    patientId: string,
    payload: { platform: 'ios'; device_id: string; push_token: string; app_version?: string; release_secret?: unknown },
  ): Promise<{ device: Record<string, unknown>; created: boolean }> {
    await this.assertCanWritePatient(principal, patientId);

    if (payload.platform !== 'ios') {
      throw new ValidationError('Unsupported platform');
    }

    const deviceId = payload.device_id?.trim();
    const pushToken = payload.push_token?.trim();
    if (!deviceId) {
      throw new ValidationError('device_id is required');
    }

    if (!pushToken) {
      throw new ValidationError('push_token is required');
    }

    const existing = await this.repository.listActivePatientDevices(patientId, 'ios');
    const matched = existing.find((device) => String((device as { device_id: string }).device_id) === deviceId);

    const device = await this.repository.upsertPatientDevice({
      patientId,
      platform: 'ios',
      deviceId,
      pushToken,
      appVersion: payload.app_version?.trim() || null,
      userId: principal.user_id,
      releaseSecretHash: releaseSecretHash(payload.release_secret),
    });

    await this.repository.insertAuditEvent({
      eventType: 'DEVICE_REGISTERED',
      outcome: 'ALLOW',
      provider: auditProvider(principal),
      providerSubject: principal.auth_subject ?? null,
      userId: principal.user_id ?? null,
      requestPath: null,
      metadata: {
        patient_id: patientId,
        platform: 'ios',
        device_id: deviceId,
      },
    });

    // The release secret's hash never leaves the server.
    const { release_secret_hash: _secret, ...shown } = device as unknown as Record<string, unknown>;
    return {
      device: shown,
      created: !matched,
    };
  }

  /**
   * Sign-out on a phone (POST /v1/me/devices/sign-out): its push token stops receiving pushes for every patient this
   * caregiver can access. Idempotent: a token already inactive or unknown is not an error.
   */
  /**
   * A phone releases its rows without a session (POST /v1/devices/release, audit 2026-10-26): its sign-out could not
   * reach the server (offline), so the previous caregiver's pushes kept coming. Needs the token and the phone's release
   * secret; answers the same whether anything matched or not.
   */
  async releaseDevice(body: unknown): Promise<void> {
    const input = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    if (input.platform !== 'ios') throw new ValidationError('Unsupported platform');
    const pushToken = typeof input.push_token === 'string' ? input.push_token.trim() : '';
    if (!pushToken || pushToken.length > 512) throw new ValidationError('push_token is required');
    const hash = releaseSecretHash(input.release_secret);
    if (!hash) throw new ValidationError('release_secret is required');
    const released = await this.repository.releasePatientDevices('ios', pushToken, hash);
    // A no-op (nothing matched: an old token, a wrong secret, a repeat) leaves no audit row, so an unauthenticated
    // caller cannot fill the audit table.
    if (released === 0) return;
    try {
      await this.repository.insertAuditEvent({
        eventType: 'DEVICE_RELEASED',
        outcome: 'ALLOW',
        provider: 'DEVICE_SECRET',
        providerSubject: null,
        userId: null,
        requestPath: null,
        metadata: { platform: 'ios', deactivated_devices: released },
      });
    } catch {
      // best-effort audit only: the devices are already released
    }
  }

  async signOutDevice(principal: RequestPrincipal, body: unknown): Promise<void> {
    const input = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    if (input.platform !== 'ios') {
      throw new ValidationError('Unsupported platform');
    }
    const pushToken = typeof input.push_token === 'string' ? input.push_token.trim() : '';
    if (!pushToken || pushToken.length > 512) {
      throw new ValidationError('push_token is required');
    }

    const deactivated = await this.repository.deactivatePatientDevicesForUser(principal.user_id, 'ios', pushToken);
    try {
      await this.repository.insertAuditEvent({
        eventType: 'DEVICE_SIGNED_OUT',
        outcome: 'ALLOW',
        provider: auditProvider(principal),
        providerSubject: principal.auth_subject ?? null,
        userId: principal.user_id ?? null,
        requestPath: null,
        metadata: {
          platform: 'ios',
          deactivated_devices: deactivated,
        },
      });
    } catch {
      // best-effort audit only: the devices are already signed out
    }
  }

  /** The live event stream of a patient is readable by the same caregivers as the patient's data. */
  async authorizeLiveEvents(principal: RequestPrincipal, patientId: string): Promise<void> {
    await this.assertCanReadPatient(principal, patientId);
  }

  private async assertCanReadPatient(principal: RequestPrincipal, patientId: string): Promise<void> {
    // A malformed id is no patient of this caregiver: 403 like any other, never a database error.
    const access = UUID_PATTERN.test(patientId) ? await this.repository.getAccessRow(principal.user_id, patientId) : null;
    if (!access || !access.can_read_patient) {
      try {
        await this.repository.insertAuditEvent({
          eventType: 'PATIENT_ACCESS_DENIED',
          outcome: 'DENY',
          provider: auditProvider(principal),
          providerSubject: principal.auth_subject ?? null,
          userId: principal.user_id ?? null,
          requestPath: null,
          metadata: {
            patient_id: patientId,
            permission: 'read',
            reason: 'NO_ACTIVE_RELATIONSHIP',
          },
        });
      } catch {
        // best-effort audit only; do not mask the auth failure
      }

      throw new ForbiddenError('Patient access denied');
    }
  }

  private async assertCanWritePatient(principal: RequestPrincipal, patientId: string): Promise<void> {
    const access = UUID_PATTERN.test(patientId) ? await this.repository.getAccessRow(principal.user_id, patientId) : null;
    if (!access || !access.can_write_patient) {
      try {
        await this.repository.insertAuditEvent({
          eventType: 'PATIENT_ACCESS_DENIED',
          outcome: 'DENY',
          provider: auditProvider(principal),
          providerSubject: principal.auth_subject ?? null,
          userId: principal.user_id ?? null,
          requestPath: null,
          metadata: {
            patient_id: patientId,
            permission: 'write',
            reason: 'NO_ACTIVE_RELATIONSHIP',
          },
        });
      } catch {
        // best-effort audit only; do not mask the auth failure
      }

      throw new ForbiddenError('Patient access denied');
    }
  }
}

const MAX_CONVERSATION_TITLE_LENGTH = 80;
/** Hypo screen chart: CGM from 2 h before the hypo to 2 h after it ended. */
const HYPO_CHART_BEFORE_MS = 2 * 60 * 60_000;
const HYPO_CHART_AFTER_MS = 2 * 60 * 60_000;

/** A caregiver's conversation name with whitespace collapsed; null when it is not text or empty or too long. */
function normalizeConversationTitle(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const title = raw.replace(/\s+/g, ' ').trim();
  return title.length > 0 && title.length <= MAX_CONVERSATION_TITLE_LENGTH ? title : null;
}

function isDeletedConversation(conversation: Record<string, unknown>): boolean {
  return conversation.deleted_at !== null && conversation.deleted_at !== undefined;
}

/**
 * Meal change cards under the answers that prepared them (conversation-meal-actions.v1): an answer lists the changes
 * prepared for the caregiver message it answers. Changes of an answer that was never stored are not shown.
 */
function withMealActions(conversation: Record<string, unknown>, actions: MealActionRecord[]): Record<string, unknown> {
  if (actions.length === 0 || !Array.isArray(conversation.messages)) return conversation;
  const byUserMessage = new Map<string, Record<string, unknown>[]>();
  for (const action of actions) {
    if (action.status === 'DISCARDED') continue;
    const list = byUserMessage.get(action.user_message_id) ?? [];
    list.push(toMealActionView(action));
    byUserMessage.set(action.user_message_id, list);
  }
  const answeredBy = (message: Record<string, unknown>): string | null => {
    if (String(message.role ?? '').toUpperCase() !== 'ASSISTANT') return null;
    const answered = (message.metadata as Record<string, unknown> | null)?.user_message_id;
    return typeof answered === 'string' ? answered : null;
  };
  // One card list per answered message, on its last answer (a retried answer does not repeat the cards).
  const list = conversation.messages as Array<Record<string, unknown>>;
  const lastAnswer = new Map<string, number>();
  list.forEach((message, index) => {
    const answered = answeredBy(message);
    if (answered) lastAnswer.set(answered, index);
  });
  const messages = list.map((message, index) => {
    const answered = answeredBy(message);
    const cards = answered && lastAnswer.get(answered) === index ? byUserMessage.get(answered) : undefined;
    return cards ? { ...message, meal_actions: cards } : message;
  });
  return { ...conversation, messages };
}

/**
 * Bolus cards under the answers that prepared them (remote-bolus-trio-plan.md W7), on the last answer to the caregiver
 * message like meal change cards, with the state of the command sent from each.
 */
function withBolusProposals(conversation: Record<string, unknown>, cards: BolusProposalWithCommand[], viewerUserId: string, now: Date, plans: Map<string, PlannedBolusSummary> = new Map()): Record<string, unknown> {
  if (cards.length === 0 || !Array.isArray(conversation.messages)) return conversation;
  const byUserMessage = new Map<string, Record<string, unknown>[]>();
  for (const { proposal, command } of cards) {
    const list = byUserMessage.get(proposal.user_message_id) ?? [];
    list.push(toBolusProposalView(proposal, command, viewerUserId, now, plans.get(proposal.id) ?? null) as unknown as Record<string, unknown>);
    byUserMessage.set(proposal.user_message_id, list);
  }
  const answeredBy = (message: Record<string, unknown>): string | null => {
    if (String(message.role ?? '').toUpperCase() !== 'ASSISTANT') return null;
    const answered = (message.metadata as Record<string, unknown> | null)?.user_message_id;
    return typeof answered === 'string' ? answered : null;
  };
  const list = conversation.messages as Array<Record<string, unknown>>;
  const lastAnswer = new Map<string, number>();
  list.forEach((message, index) => {
    const answered = answeredBy(message);
    if (answered) lastAnswer.set(answered, index);
  });
  const messages = list.map((message, index) => {
    const answered = answeredBy(message);
    const proposals = answered && lastAnswer.get(answered) === index ? byUserMessage.get(answered) : undefined;
    return proposals ? { ...message, bolus_proposals: proposals } : message;
  });
  return { ...conversation, messages };
}

/**
 * WBT doses under the answers that proposed them (wbt-chat.v1), like bolus cards. Only the newest one of the
 * conversation can be given: an older one is replaced.
 */
function withWbtProposals(conversation: Record<string, unknown>, suggestions: WbtChatSuggestionRow[], command: { view: Record<string, unknown>; authorized_at: string | null } | null): Record<string, unknown> {
  const done = suggestions.filter((suggestion) => suggestion.status === 'DONE' && suggestion.result);
  if (done.length === 0 || !Array.isArray(conversation.messages)) return conversation;
  const newest = done[done.length - 1];
  const newestId = newest.id;
  // The meal's WBT command belongs to the newest card when it was sent after the card was proposed.
  const newestCommand = command && command.authorized_at && Date.parse(command.authorized_at) >= Date.parse(newest.created_at) ? command.view : null;
  const byUserMessage = new Map(done.map((suggestion) => [suggestion.user_message_id, suggestion]));
  const list = conversation.messages as Array<Record<string, unknown>>;
  const answeredBy = (message: Record<string, unknown>): string | null => {
    if (String(message.role ?? '').toUpperCase() !== 'ASSISTANT') return null;
    const answered = (message.metadata as Record<string, unknown> | null)?.user_message_id;
    return typeof answered === 'string' ? answered : null;
  };
  const lastAnswer = new Map<string, number>();
  list.forEach((message, index) => {
    const answered = answeredBy(message);
    if (answered) lastAnswer.set(answered, index);
  });
  const messages = list.map((message, index) => {
    const answered = answeredBy(message);
    const suggestion = answered && lastAnswer.get(answered) === index ? byUserMessage.get(answered) : undefined;
    if (!suggestion) return message;
    const result = suggestion.result as Record<string, unknown>;
    return {
      ...message,
      wbt_proposal: {
        suggestion_id: suggestion.id,
        meal_id: suggestion.meal_record_id,
        dose_units: Number(result.dose_units ?? 0),
        carbs_equivalent_g: typeof result.carbs_equivalent_g === 'number' ? result.carbs_equivalent_g : null,
        rationale: String(result.rationale ?? ''),
        warnings: Array.isArray(result.warnings) ? result.warnings : [],
        newest: suggestion.id === newestId,
        command: suggestion.id === newestId ? newestCommand : null,
      },
    };
  });
  return { ...conversation, messages };
}

/** "WBT · posiłek 07:11": the meal's local time names its WBT conversation. */
function wbtConversationTitle(startedAt: string): string {
  try {
    const time = new Intl.DateTimeFormat('pl-PL', { timeZone: resolveHomeTimeZone(), hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(startedAt));
    return `WBT · posiłek ${time}`;
  } catch {
    return 'WBT · posiłek';
  }
}

/** Adds each bolus card's reminders (planned parts, the meal's WBT reminder) to the card. */
function withCardReminders(conversation: Record<string, unknown>, reminders: Map<string, { planned_parts: PlannedBolusSummary[]; wbt_reminder: Record<string, unknown> | null }>): Record<string, unknown> {
  if (reminders.size === 0 || !Array.isArray(conversation.messages)) return conversation;
  const messages = (conversation.messages as Array<Record<string, unknown>>).map((message) => {
    const cards = message.bolus_proposals;
    if (!Array.isArray(cards)) return message;
    return { ...message, bolus_proposals: cards.map((card: Record<string, unknown>) => ({ ...card, ...(reminders.get(String(card.id)) ?? {}) })) };
  });
  return { ...conversation, messages };
}

/** Reminders under the answers that set them (care-reminders.v1), like bolus cards. */
function withCareReminders(conversation: Record<string, unknown>, reminders: CareReminderRecord[], timeZone: string): Record<string, unknown> {
  if (reminders.length === 0 || !Array.isArray(conversation.messages)) return conversation;
  const byUserMessage = new Map<string, Record<string, unknown>[]>();
  for (const reminder of reminders) {
    if (!reminder.user_message_id) continue;
    // A failed earlier attempt's reminders were cancelled without a caregiver: never shown.
    if (reminder.status === 'CANCELLED' && !reminder.cancelled_by_user_id) continue;
    const list = byUserMessage.get(reminder.user_message_id) ?? [];
    list.push(toCareReminderView(reminder, timeZone) as unknown as Record<string, unknown>);
    byUserMessage.set(reminder.user_message_id, list);
  }
  const answeredBy = (message: Record<string, unknown>): string | null => {
    if (String(message.role ?? '').toUpperCase() !== 'ASSISTANT') return null;
    const answered = (message.metadata as Record<string, unknown> | null)?.user_message_id;
    return typeof answered === 'string' ? answered : null;
  };
  const list = conversation.messages as Array<Record<string, unknown>>;
  const lastAnswer = new Map<string, number>();
  list.forEach((message, index) => {
    const answered = answeredBy(message);
    if (answered) lastAnswer.set(answered, index);
  });
  const messages = list.map((message, index) => {
    const answered = answeredBy(message);
    const cards = answered && lastAnswer.get(answered) === index ? byUserMessage.get(answered) : undefined;
    return cards ? { ...message, care_reminders: cards } : message;
  });
  return { ...conversation, messages };
}

/** A photo upload's body: base64 JPEG of at most 4 MB. */
function decodeJpegUpload(input: { content_type?: unknown; data_base64?: unknown }): Buffer {
  if (input.content_type !== 'image/jpeg' || typeof input.data_base64 !== 'string') {
    throw new ValidationError('content_type must be image/jpeg and data_base64 a base64 string');
  }
  const data = Buffer.from(input.data_base64, 'base64');
  if (data.length === 0 || data.length > 4 * 1024 * 1024 || !isJpeg(data)) {
    throw new ValidationError('The photo must be a JPEG of at most 4 MB');
  }
  return data;
}

/** photo_ids of a chat message (main or meal chat): absent → none; photo ids only, duplicates dropped, at most 3. */
function parsePhotoIds(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.some((id) => typeof id !== 'string' || !UUID_PATTERN.test(id))) {
    throw new ValidationError('photo_ids must be photo ids');
  }
  const photoIds = [...new Set((raw as string[]).map((id) => id.toLowerCase()))];
  if (photoIds.length > 3) throw new ValidationError('At most 3 photo ids');
  return photoIds;
}

const CONTEXT_ANSWER_TYPES = ['YES', 'NO', 'UNKNOWN', 'TEXT'] as const;

/**
 * The body of POST …/messages before anything is read or written: a USER_MESSAGE, or a CONTEXT_ANSWER with its
 * question_id and a well-formed answer. Any other message_type is refused (422), never treated as an answer.
 */
/** The longest chat message: about two pages of text. */
const MAX_CHAT_MESSAGE_CHARS = 4000;

function assertSubmittedMessageShape(payload: { message_type?: unknown; question_id?: unknown; answer?: unknown }): void {
  if (payload.message_type === 'USER_MESSAGE') return;
  if (payload.message_type !== 'CONTEXT_ANSWER') throw new ValidationError('message_type must be USER_MESSAGE or CONTEXT_ANSWER');
  if (typeof payload.question_id !== 'string' || !payload.question_id.trim()) throw new ValidationError('question_id is required for CONTEXT_ANSWER');
  const answer = payload.answer as { type?: unknown; text?: unknown } | null | undefined;
  if (!answer || typeof answer !== 'object' || !(CONTEXT_ANSWER_TYPES as readonly unknown[]).includes(answer.type)) {
    throw new ValidationError(`answer.type must be one of ${CONTEXT_ANSWER_TYPES.join(', ')}`);
  }
  if (answer.text !== undefined && answer.text !== null && typeof answer.text !== 'string') throw new ValidationError('answer.text must be a string');
}

/** The provider that authenticated the request, for audit rows (requests before the guard set it were Cognito). */
function auditProvider(principal: RequestPrincipal): AuditProvider {
  return principal.auth_provider ?? 'COGNITO';
}

/** A remote command id from the path; anything but a UUID is an unknown command. */
function requireRemoteCommandId(commandId: string): void {
  if (!UUID_PATTERN.test(commandId)) throw new NotFoundError('Remote command not found');
}

/** expected_revision of a caregiver save: a positive integer, or absent/null (older apps: not checked). */
function parseExpectedRevision(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) throw new ValidationError('expected_revision must be a positive integer');
  return value;
}

/** The authorize body as the app sends it; anything malformed is refused before any check runs. */
function parseRemoteCommandRequest(body: unknown): RemoteCommandRequest {
  const raw = (body ?? {}) as Record<string, unknown>;
  const source = raw.source;
  if (source !== 'BOLUS_SCREEN' && source !== 'CHAT_CARD' && source !== 'NEW_MEAL' && source !== 'WBT_SCREEN' && source !== 'PLANNED_BOLUS' && source !== 'RESCUE_CARBS') throw new ValidationError('source must be BOLUS_SCREEN, CHAT_CARD, NEW_MEAL, WBT_SCREEN, PLANNED_BOLUS or RESCUE_CARBS');
  const number = (value: unknown, name: string): number => {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new ValidationError(`${name} must be a number`);
    return value;
  };
  const uuidOrNull = (value: unknown, name: string): string | null => {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string' || !UUID_PATTERN.test(value)) throw new ValidationError(`${name} must be a UUID`);
    return value;
  };
  const acknowledged = Array.isArray(raw.acknowledged_warnings) ? raw.acknowledged_warnings.filter((code): code is string => typeof code === 'string') : [];
  return {
    source,
    carbs_g: number(raw.carbs_g, 'carbs_g'),
    insulin_u: number(raw.insulin_u, 'insulin_u'),
    bolus_step: number(raw.bolus_step, 'bolus_step'),
    device_id: typeof raw.device_id === 'string' ? raw.device_id : '',
    conversation_id: uuidOrNull(raw.conversation_id, 'conversation_id'),
    proposal_id: uuidOrNull(raw.proposal_id, 'proposal_id'),
    follows_command_id: uuidOrNull(raw.follows_command_id, 'follows_command_id'),
    meal: raw.meal && typeof raw.meal === 'object' ? (raw.meal as RemoteCommandRequest['meal']) : null,
    wbt_meal_id: uuidOrNull(raw.wbt_meal_id, 'wbt_meal_id'),
    planned_bolus_id: uuidOrNull(raw.planned_bolus_id, 'planned_bolus_id'),
    rescue_alert_id: uuidOrNull(raw.rescue_alert_id, 'rescue_alert_id'),
    rescue_proposal_id: uuidOrNull(raw.rescue_proposal_id, 'rescue_proposal_id'),
    acknowledged_warnings: acknowledged,
    card_warnings_shown: raw.card_warnings_shown === true,
    // Only the separate low-glucose alert sets it (review H1); anything but true is "not confirmed".
    low_glucose_confirmed: raw.low_glucose_confirmed === true,
    reminders: parseBolusReminders(raw.reminders),
    create_meal: raw.create_meal === true,
    meal_in_minutes: raw.meal_in_minutes === undefined || raw.meal_in_minutes === null ? null : number(raw.meal_in_minutes, 'meal_in_minutes'),
    driver: raw.driver === 'TRIO' || raw.driver === 'LOOP' ? raw.driver : null,
  };
}

/** An optional ISO timestamp from a query string, normalised; refused when not one. */
function optionalIsoQuery(value: unknown, name: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new ValidationError(`${name} must be an ISO timestamp`);
  return new Date(Date.parse(value)).toISOString();
}

/** How long after it was stored a replayed message that was never dispatched is sent again. */
const USER_MESSAGE_REDISPATCH_WINDOW_MS = 15 * 60_000;

/**
 * A user message a failed request stored without queuing its answer job: not marked dispatched, recent, and not
 * answered. Messages older than the window (or stored before the dispatched mark) are never sent again.
 */
export function userMessageNeedsDispatch(message: Record<string, unknown>, conversation: Record<string, unknown>, now = Date.now()): boolean {
  if (message.message_type !== 'USER_MESSAGE') return false;
  const metadata = (message.metadata as Record<string, unknown> | null) ?? null;
  if (metadata?.dispatched === true) return false;
  const createdAt = Date.parse(String(message.created_at ?? ''));
  if (!Number.isFinite(createdAt) || now - createdAt > USER_MESSAGE_REDISPATCH_WINDOW_MS) return false;
  const messages = Array.isArray(conversation.messages) ? conversation.messages as Array<Record<string, unknown>> : [];
  return !messages.some((entry) => String(entry.role ?? '').toUpperCase() === 'ASSISTANT'
    && (entry.metadata as Record<string, unknown> | null)?.user_message_id === message.id);
}

/** sha256 of a phone's release secret (32-256 characters); null when absent or malformed. */
function releaseSecretHash(secret: unknown): string | null {
  if (typeof secret !== 'string') return null;
  const value = secret.trim();
  if (value.length < 32 || value.length > 256) return null;
  return createHash('sha256').update(value).digest('hex');
}
