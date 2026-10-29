export type PushPlatform = 'ios';

/**
 * Origin of the in-app links pushes carry (`universalLink`, next to `routePath`). The app routes them itself, so no
 * domain is needed; the reserved .invalid name never resolves. To open them as real universal links, set your own
 * domain here and in the iOS app (AppLink.host), add `applinks:<domain>` to the app's entitlements and serve an
 * apple-app-site-association file there (apps/ios/apple-app-site-association.example.json).
 */
export const APP_LINK_ORIGIN = 'https://app.mellis.invalid';

export type PushNotificationType = 'conversation_question' | 'wbt_reminder' | 'planned_bolus' | 'rescue_carbs' | 'care_reminder' | 'conversation_answer' | 'meal_chat_answer' | 'dose_given' | 'reservoir_low';

export interface ConversationQuestionPushPayload {
  type: 'conversation_question';
  patientId: string;
  conversationId: string;
  questionId: string;
  routePath: string;
  universalLink: string;
}

/** Reminds about insulin for fat and protein (WBT) 2.5 h after a meal; opens /patients/{patientId}/meals/{mealId}/wbt. */
export interface WbtReminderPushPayload {
  type: 'wbt_reminder';
  patientId: string;
  mealId: string;
  routePath: string;
  universalLink: string;
}

/**
 * The second part of a split meal bolus is due; opens /patients/{patientId}/meals/{mealId}/planned-bolus (the card with
 * the part already given and the dose to give now).
 */
export interface PlannedBolusPushPayload {
  type: 'planned_bolus';
  patientId: string;
  mealId: string;
  plannedBolusId: string;
  routePath: string;
  universalLink: string;
}

/**
 * Glucose may drop below 70 mg/dL (or already did): rescue carbs with a proposed dose (rescue-carbs.v1); opens the
 * alert's conversation /patients/{patientId}/conversations/{conversationId}.
 */
export interface RescueCarbsPushPayload {
  type: 'rescue_carbs';
  patientId: string;
  conversationId: string;
  alertId: string;
  routePath: string;
  universalLink: string;
}

/**
 * A reminder the chat set (care-reminders.v1); opens the conversation it was set in, or the patient without one. A
 * Bolus tab meal's second dose (bolus-reminders.v1) has mealId and opens /patients/{patientId}/meals/{mealId}.
 */
export interface CareReminderPushPayload {
  type: 'care_reminder';
  patientId: string;
  conversationId?: string;
  mealId?: string;
  reminderId: string;
  routePath: string;
  universalLink: string;
}

/**
 * GlucoMind's answer to the caregiver's question is ready (answer-ready-push.v1); opens the conversation
 * /patients/{patientId}/conversations/{conversationId}. The app shows no banner while it is open.
 */
export interface ConversationAnswerPushPayload {
  type: 'conversation_answer';
  patientId: string;
  conversationId: string;
  routePath: string;
  universalLink: string;
}

/** The meal chat's answer is ready (answer-ready-push.v1); opens the meal /patients/{patientId}/meals/{mealId}. */
export interface MealChatAnswerPushPayload {
  type: 'meal_chat_answer';
  patientId: string;
  mealId: string;
  routePath: string;
  universalLink: string;
}

/**
 * Another caregiver gave the dose a meal's reminder asked for (a second dose or WBT); opens the meal
 * /patients/{patientId}/meals/{mealId}.
 */
export interface DoseGivenPushPayload {
  type: 'dose_given';
  patientId: string;
  mealId: string;
  routePath: string;
  universalLink: string;
}

/**
 * Little insulin left in the reservoir (reservoir-alerts.v1): level 'warning' (under 24 h at the average use) or
 * 'alarm' (under 8 h). routePath is the patient (/patients/{patientId}, what older apps open); universalLink is the
 * patient's equipment list (/patients/{patientId}/equipment), which newer apps open.
 */
export interface ReservoirLowPushPayload {
  type: 'reservoir_low';
  patientId: string;
  level: 'warning' | 'alarm';
  routePath: string;
  universalLink: string;
}

export type PushNotificationPayload = ConversationQuestionPushPayload | WbtReminderPushPayload | PlannedBolusPushPayload | RescueCarbsPushPayload | CareReminderPushPayload | ConversationAnswerPushPayload | MealChatAnswerPushPayload | DoseGivenPushPayload | ReservoirLowPushPayload;

export interface PushNotificationEnvelope {
  platform: PushPlatform;
  pushToken: string;
  title: string;
  body: string;
  payload: PushNotificationPayload;
  /** APNs interruption level; time-sensitive breaks through Focus (the app has the entitlement). */
  interruptionLevel?: 'time-sensitive';
  /** apns-collapse-id: a second push with the same id replaces the first on the phone instead of adding another. */
  collapseId?: string;
}
