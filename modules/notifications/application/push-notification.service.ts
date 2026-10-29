import { APP_LINK_ORIGIN, PushNotificationEnvelope, type PushNotificationPayload } from '@modules/notifications/domain/push-notification';
import { PushNotificationProvider } from '@modules/notifications/infrastructure/push-notification-provider';
import type { NotificationHistoryRecorder } from './notification-history';
import { withPatientLabel, type PatientPushLabeler } from './patient-push-label';

/** recordOnly: the bell entry without a push (a queued reminder, recordQueuedReminder). */
interface SendOptions {
  recordOnly?: boolean;
}

type QueuedReminderRequest = import('./push-outbox').PushOutboxRequest;

export class PushNotificationService {
  constructor(
    private readonly provider: PushNotificationProvider,
    private readonly history: NotificationHistoryRecorder | null = null,
    private readonly patientLabels: PatientPushLabeler | null = null,
  ) {}

  async sendConversationQuestion(input: {
    patientId: string;
    pushToken: string;
    conversationId: string;
    questionId: string;
    title: string;
    body: string;
  }): Promise<void> {
    const envelope: PushNotificationEnvelope = {
      platform: 'ios',
      pushToken: input.pushToken,
      title: input.title,
      body: input.body,
      payload: {
        type: 'conversation_question',
        patientId: input.patientId,
        conversationId: input.conversationId,
        questionId: input.questionId,
        routePath: `/patients/${input.patientId}/conversations/${input.conversationId}?questionId=${encodeURIComponent(input.questionId)}`,
        universalLink: `${APP_LINK_ORIGIN}/patients/${input.patientId}/conversations/${input.conversationId}?questionId=${encodeURIComponent(input.questionId)}`,
      },
    };

    await this.send(envelope, `conversation-question:${input.patientId}:${input.conversationId}:${input.questionId}`);
  }

  /**
   * WBT insulin reminder; the caller decided the reminder is due (the caregiver switched it on or AUTO did). The route
   * ends in /wbt, so a tap opens the meal's WBT dose screen.
   */
  async sendWbtReminder(input: { patientId: string; pushToken: string; mealId: string; body: string }, options: SendOptions = {}): Promise<void> {
    const routePath = `${buildMealRoutePath(input.patientId, input.mealId)}/wbt`;
    await this.send({
      platform: 'ios',
      pushToken: input.pushToken,
      title: 'Przypomnienie o WBT',
      body: input.body,
      payload: { type: 'wbt_reminder', patientId: input.patientId, mealId: input.mealId, routePath, universalLink: `${APP_LINK_ORIGIN}${routePath}` },
    }, `wbt-reminder:${input.mealId}`, options);
  }

  /** The second part of a split meal bolus is due (once per plan in the history, whatever the number of devices). */
  async sendPlannedBolusReminder(input: { patientId: string; pushToken: string; mealId: string; plannedBolusId: string; title: string; body: string }, options: SendOptions = {}): Promise<void> {
    const routePath = `${buildMealRoutePath(input.patientId, input.mealId)}/planned-bolus`;
    await this.send({
      platform: 'ios',
      pushToken: input.pushToken,
      title: input.title,
      body: input.body,
      payload: { type: 'planned_bolus', patientId: input.patientId, mealId: input.mealId, plannedBolusId: input.plannedBolusId, routePath, universalLink: `${APP_LINK_ORIGIN}${routePath}` },
    }, `planned-bolus:${input.plannedBolusId}`, options);
  }

  /**
   * A reminder the chat set (care-reminders.v1): opens the conversation it was set in (the app's start without one). A
   * meal's reminder (a Bolus tab second dose, bolus-reminders.v1) opens the meal instead and carries its mealId.
   */
  async sendCareReminder(input: { patientId: string; pushToken: string; conversationId: string | null; mealId?: string | null; reminderId: string; title: string; body: string }, options: SendOptions = {}): Promise<void> {
    const routePath = input.mealId
      ? buildMealRoutePath(input.patientId, input.mealId)
      : input.conversationId ? `/patients/${input.patientId}/conversations/${input.conversationId}` : `/patients/${input.patientId}`;
    await this.send({
      platform: 'ios',
      pushToken: input.pushToken,
      title: input.title,
      body: input.body,
      payload: {
        type: 'care_reminder',
        patientId: input.patientId,
        ...(input.conversationId ? { conversationId: input.conversationId } : {}),
        ...(input.mealId ? { mealId: input.mealId } : {}),
        reminderId: input.reminderId,
        routePath,
        universalLink: `${APP_LINK_ORIGIN}${routePath}`,
      },
    }, `care-reminder:${input.reminderId}`, options);
  }

  /**
   * A reminder at a time the worker could not send within 2 h: no late push, but the bell says it was
   * missed. Opens what the reminder would have opened.
   */
  async recordMissedCareReminder(input: { patientId: string; conversationId: string | null; mealId?: string | null; reminderId: string; note: string }): Promise<void> {
    if (!this.history) return;
    const routePath = input.mealId
      ? buildMealRoutePath(input.patientId, input.mealId)
      : input.conversationId ? `/patients/${input.patientId}/conversations/${input.conversationId}` : `/patients/${input.patientId}`;
    await this.history.record({
      dedupeKey: `care-reminder:${input.reminderId}`,
      patientId: input.patientId,
      type: 'care_reminder',
      title: 'Przegapione przypomnienie',
      body: input.note,
      payload: {
        type: 'care_reminder',
        patientId: input.patientId,
        ...(input.conversationId ? { conversationId: input.conversationId } : {}),
        ...(input.mealId ? { mealId: input.mealId } : {}),
        reminderId: input.reminderId,
        routePath,
        universalLink: `${APP_LINK_ORIGIN}${routePath}`,
      },
    });
  }

  /**
   * Another caregiver gave the dose a meal's reminder asked for: "Druga dawka podana" or "WBT
   * podane", who and how much; a tap opens the meal. One entry in the bell per reminder.
   */
  async sendDoseGiven(input: { patientId: string; pushToken: string; mealId: string; reminderKey: string; title: string; body: string }, options: SendOptions = {}): Promise<void> {
    const routePath = buildMealRoutePath(input.patientId, input.mealId);
    await this.send({
      platform: 'ios',
      pushToken: input.pushToken,
      title: input.title,
      body: input.body,
      payload: { type: 'dose_given', patientId: input.patientId, mealId: input.mealId, routePath, universalLink: `${APP_LINK_ORIGIN}${routePath}` },
    }, `dose-given:${input.reminderKey}`, options);
  }

  /**
   * A low may be coming (rescue-carbs.v1): time-sensitive, opens the alert's conversation. The history keeps one entry
   * per push (the reminder is its own entry).
   */
  async sendRescueCarbAlert(input: { patientId: string; pushToken: string; conversationId: string; alertId: string; title: string; body: string; reminder: boolean }): Promise<void> {
    const routePath = `/patients/${input.patientId}/conversations/${input.conversationId}`;
    await this.send({
      platform: 'ios',
      pushToken: input.pushToken,
      title: input.title,
      body: input.body,
      interruptionLevel: 'time-sensitive',
      payload: { type: 'rescue_carbs', patientId: input.patientId, conversationId: input.conversationId, alertId: input.alertId, routePath, universalLink: `${APP_LINK_ORIGIN}${routePath}` },
    }, `rescue-carbs:${input.alertId}:${input.reminder ? 'reminder' : 'alert'}`);
  }

  /**
   * Little insulin left in the reservoir (reservoir-alerts.v1): one entry in the bell per level and fill (notifiedAt
   * is when that level was first pushed), one push per phone. A tap opens the patient's equipment list.
   */
  async sendReservoirAlert(input: { patientId: string; pushToken: string; level: 'warning' | 'alarm'; notifiedAt: string; title: string; body: string }): Promise<void> {
    const routePath = `/patients/${input.patientId}`;
    await this.send({
      platform: 'ios',
      pushToken: input.pushToken,
      title: input.title,
      body: input.body,
      collapseId: `reservoir-${input.patientId}`,
      payload: { type: 'reservoir_low', patientId: input.patientId, level: input.level, routePath, universalLink: `${APP_LINK_ORIGIN}/patients/${input.patientId}/equipment` },
    }, `reservoir:${input.patientId}:${input.level}:${input.notifiedAt}`);
  }

  /**
   * GlucoMind's answer to the caregiver's question is ready, or failed for good (answer-ready-push.v1). Only the asking
   * caregiver's phones get it, and the app shows no banner while it is open. Not kept in the bell history: the answer
   * is in the chat. One push per question on a phone: a resend replaces it (collapse id).
   */
  async sendAnswerReady(input: {
    patientId: string;
    pushToken: string;
    target: { conversationId: string } | { mealId: string };
    questionMessageId: string;
    title: string;
    body: string;
  }): Promise<void> {
    const target = input.target;
    const routePath = 'conversationId' in target
      ? `/patients/${input.patientId}/conversations/${target.conversationId}`
      : buildMealRoutePath(input.patientId, target.mealId);
    const universalLink = `${APP_LINK_ORIGIN}${routePath}`;
    const payload: PushNotificationPayload = 'conversationId' in target
      ? { type: 'conversation_answer', patientId: input.patientId, conversationId: target.conversationId, routePath, universalLink }
      : { type: 'meal_chat_answer', patientId: input.patientId, mealId: target.mealId, routePath, universalLink };
    await this.send({
      platform: 'ios',
      pushToken: input.pushToken,
      title: input.title,
      body: input.body,
      collapseId: `answer-${input.questionMessageId}`,
      payload,
    }, null);
  }

  /**
   * Adds the notification to the bell history once per dedupe key (the other devices of the patient hit the same row),
   * then sends to one device. The bell comes first (audit 2026-10-26): a push APNs refused or that timed out is still
   * in the app. A failed history write never fails the push.
   */
  /**
   * A queued reminder push goes into the bell at once (push-outbox.v1): a push that finds no phone for a while is still
   * in the app. Its sends later add nothing (same dedupe key).
   */
  async recordQueuedReminder(request: QueuedReminderRequest): Promise<void> {
    const recordOnly = { recordOnly: true };
    switch (request.kind) {
      case 'wbt_reminder': return this.sendWbtReminder({ ...request.input, pushToken: '' }, recordOnly);
      case 'planned_bolus': return this.sendPlannedBolusReminder({ ...request.input, pushToken: '' }, recordOnly);
      case 'care_reminder': return this.sendCareReminder({ ...request.input, pushToken: '' }, recordOnly);
      case 'dose_given': return this.sendDoseGiven({ ...request.input, pushToken: '' }, recordOnly);
    }
  }

  private async send(envelope: PushNotificationEnvelope, historyDedupeKey: string | null, options: SendOptions = {}): Promise<void> {
    if (this.history && historyDedupeKey !== null) {
      try {
        await this.history.record({
          dedupeKey: historyDedupeKey,
          patientId: envelope.payload.patientId,
          type: envelope.payload.type,
          title: envelope.title,
          body: envelope.body,
          payload: envelope.payload,
        });
      } catch {
        // The bell just misses this entry; the push still goes out.
      }
    }
    if (options.recordOnly) return;
    // A phone with several patients sees whose push it is; the bell (one patient's history) keeps the plain title.
    const label = this.patientLabels ? await this.patientLabels.labelFor(envelope.pushToken, envelope.payload.patientId).catch(() => null) : null;
    await this.provider.send(label ? { ...envelope, title: withPatientLabel(envelope.title, label) } : envelope);
  }
}

export function buildMealRoutePath(patientId: string, mealId: string): string {
  return `/patients/${patientId}/meals/${mealId}`;
}
