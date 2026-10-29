import type { AiRuntimeToolDefinition } from '@modules/ai-gateway/domain/ai-gateway';
import { calibratedLoopCurve } from '@modules/glucose-forecast/application/forecast-calibration';
import { buildGlucoseForecast, lowestWithin } from '@modules/glucose-forecast/application/glucose-forecast';
import { parseLoopPrediction } from '@modules/loop-system/application/loop-prediction';
import { glucoseRisingForSecondDose } from '@modules/remote-commands/application/bolus-reminders';
import { DEFERRED_BOLUS_POLICY, LATER_PLAN_POLICY } from '@modules/remote-commands/application/split-bolus';

/**
 * Reminders the chat sets for the caregiver (care-reminders.v1: the agent may prepare any
 * reminder the caregiver asks for). A note, pushed to every caregiver at a time or when glucose has stopped falling,
 * starts rising, goes above or below a threshold. A condition is waited for (3 h unless said otherwise; rising 1 h, as the
 * Bolus tab's): stopped falling then reminds anyway, saying it was not met; rising and a threshold lapse quietly (EXPIRED). Nothing is sent to the loop; a dose to give later
 * is the bolus card's later part instead (later-plan.v1).
 */

export const CARE_REMINDER_POLICY = {
  version: 'care-reminders.v1',
  max_in_minutes: 7 * 24 * 60,
  default_wait_minutes: LATER_PLAN_POLICY.default_wait_minutes,
  default_rising_wait_minutes: LATER_PLAN_POLICY.default_rising_wait_minutes,
  min_wait_minutes: LATER_PLAN_POLICY.min_wait_minutes,
  max_wait_minutes: LATER_PLAN_POLICY.max_wait_minutes,
  min_threshold_mgdl: 40,
  max_threshold_mgdl: 400,
  max_note_length: 300,
  max_per_answer: 3,
} as const;

export type CareReminderTrigger = 'AT_TIME' | 'GLUCOSE_STOPPED_FALLING' | 'GLUCOSE_RISING' | 'GLUCOSE_ABOVE' | 'GLUCOSE_BELOW';
const TRIGGERS: CareReminderTrigger[] = ['AT_TIME', 'GLUCOSE_STOPPED_FALLING', 'GLUCOSE_RISING', 'GLUCOSE_ABOVE', 'GLUCOSE_BELOW'];
/** MISSED: a reminder at a time the worker could not send within 2 h; GIVEN: a second dose given before it came (082). */
export type CareReminderStatus = 'ACTIVE' | 'FIRED' | 'CANCELLED' | 'EXPIRED' | 'MISSED' | 'GIVEN';

export interface CareReminderRecord {
  id: string;
  patient_id: string;
  conversation_id: string | null;
  user_message_id: string | null;
  created_by_user_id: string | null;
  note: string;
  trigger: CareReminderTrigger;
  due_at: string;
  threshold_mgdl: number | null;
  wait_until: string | null;
  status: CareReminderStatus;
  fired_at: string | null;
  fired_reason: 'READY' | 'FORCED' | null;
  fired_glucose_mgdl: number | null;
  cancelled_at: string | null;
  cancelled_by_user_id: string | null;
  cancelled_by_name?: string | null;
  created_at: string;
  /** SECOND_DOSE (bolus-reminders.v1, migration 073): the second dose of a Bolus tab meal (meal_record_id); null: the chat's. */
  kind?: 'SECOND_DOSE' | null;
  meal_record_id?: string | null;
  /** A caregiver gave the dose it asked for (migration 074): the meal's page shows it as given. */
  dose_given_at?: string | null;
  /** The loop action that answered it (migration 082): one dose answers one reminder. */
  dose_given_action_id?: string | null;
  /** Its conversation was deleted (listActive): the push opens the patient instead. */
  conversation_deleted?: boolean;
}

export type NewCareReminder = Pick<CareReminderRecord, 'patient_id' | 'conversation_id' | 'user_message_id' | 'created_by_user_id' | 'note' | 'trigger' | 'due_at' | 'threshold_mgdl' | 'wait_until'>;

/** A Bolus tab meal's second dose (bolus-reminders.v1). */
export type NewSecondDoseReminder = Pick<CareReminderRecord, 'patient_id' | 'created_by_user_id' | 'note' | 'due_at' | 'wait_until'> & {
  meal_record_id: string;
  trigger: 'AT_TIME' | 'GLUCOSE_RISING';
  /** The command it came with ("remote-command:<id>"), in user_message_id. */
  source_ref: string;
};

export interface CareReminderStore {
  insert(reminder: NewCareReminder): Promise<CareReminderRecord>;
  discardForUserMessage(patientId: string, userMessageId: string): Promise<void>;
  listForConversation(patientId: string, conversationId: string): Promise<CareReminderRecord[]>;
  listActive(): Promise<CareReminderRecord[]>;
  /** ACTIVE -> FIRED once (two workers never push twice). */
  markFired(patientId: string, id: string, reason: 'READY' | 'FORCED', glucose: number | null): Promise<boolean>;
  /** ACTIVE -> EXPIRED: a threshold never crossed within its watching time (no push). */
  markExpired(patientId: string, id: string): Promise<boolean>;
  cancel(patientId: string, id: string, userId: string): Promise<CareReminderRecord | null>;
  get(patientId: string, id: string): Promise<CareReminderRecord | null>;
}

export const SET_REMINDER_TOOL_NAME = 'set_reminder';

export const SET_REMINDER_TOOL_DEFINITION: AiRuntimeToolDefinition = {
  name: SET_REMINDER_TOOL_NAME,
  description: 'Sets a reminder pushed to every caregiver of the patient: at a time, or when glucose has stopped falling, starts rising, goes above or below a threshold. A condition is watched for wait_minutes: stopped falling then reminds anyway saying it was not met; rising and a threshold (above / below) lapse quietly. Only a note: nothing is sent to the loop. For a dose later after a meal card use propose_bolus.later instead. Returns SET with the reminder.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      note: { type: 'string', description: 'What to remind, in Polish, as the push text: short and concrete ("Sprawdź glukozę po pływaniu", "Zmiana wkłucia").' },
      trigger: { type: 'string', enum: TRIGGERS },
      in_minutes: { type: ['integer', 'null'], description: `AT_TIME: minutes from now (1-${CARE_REMINDER_POLICY.max_in_minutes}), or null with at_local. Glucose triggers: checked from this many minutes from now (null: at once).` },
      at_local: { type: ['string', 'null'], description: 'AT_TIME: the time in the patient\'s time zone as "YYYY-MM-DDTHH:MM" (e.g. tomorrow 07:00), or null with in_minutes.' },
      threshold_mgdl: { type: ['integer', 'null'], description: 'GLUCOSE_ABOVE / GLUCOSE_BELOW only, mg/dL.' },
      wait_minutes: { type: ['integer', 'null'], description: `Glucose triggers: how long the condition is watched (null: ${CARE_REMINDER_POLICY.default_wait_minutes}, rising ${CARE_REMINDER_POLICY.default_rising_wait_minutes}); for a threshold alarm the caregiver wants watched longer (e.g. the night), set it.` },
    },
    required: ['note', 'trigger', 'in_minutes', 'at_local', 'threshold_mgdl', 'wait_minutes'],
  },
};

export const SET_REMINDER_INSTRUCTIONS = 'REMINDERS: when the caregiver asks to be reminded of something (or agrees to your offer of a reminder), call set_reminder once per reminder with the note and when; then say in one sentence what will be reminded and when. Set exactly what they asked; do not refuse or replace it. A reminder about a dose after a meal card belongs on that card (propose_bolus.later).';

/** The port the AI gateway calls; one session per answer. */
export interface CareReminderTools {
  set(args: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export interface CareReminderSessionDeps {
  patientId: string;
  conversationId: string;
  userMessageId: string;
  authorUserId: string | null;
  /** The patient's time zone (at_local). */
  timeZone: string;
  store: Pick<CareReminderStore, 'insert'>;
  now?: () => Date;
}

/** One answer's set_reminder calls. */
export class CareReminderSession implements CareReminderTools {
  readonly created: CareReminderRecord[] = [];
  private readonly now: () => Date;

  constructor(private readonly deps: CareReminderSessionDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  async set(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (this.created.length >= CARE_REMINDER_POLICY.max_per_answer) {
      return { tool: SET_REMINDER_TOOL_NAME, status: 'LIMIT_REACHED', note: `At most ${CARE_REMINDER_POLICY.max_per_answer} reminders per answer.` };
    }
    const parsed = parseReminderRequest(args, this.now(), this.deps.timeZone);
    if ('problem' in parsed) return { tool: SET_REMINDER_TOOL_NAME, status: 'INVALID', problem: parsed.problem };
    const record = await this.deps.store.insert({
      patient_id: this.deps.patientId,
      conversation_id: this.deps.conversationId || null,
      user_message_id: this.deps.userMessageId,
      created_by_user_id: this.deps.authorUserId,
      ...parsed,
    });
    this.created.push(record);
    return {
      tool: SET_REMINDER_TOOL_NAME,
      status: 'SET',
      reminder: { note: record.note, trigger: record.trigger, due_at: record.due_at, threshold_mgdl: record.threshold_mgdl, wait_until: record.wait_until, described: describeReminder(record, this.deps.timeZone) },
    };
  }
}

/** The model's arguments as a reminder to store; a problem the model can fix otherwise. */
export function parseReminderRequest(args: Record<string, unknown>, now: Date, timeZone: string): Omit<NewCareReminder, 'patient_id' | 'conversation_id' | 'user_message_id' | 'created_by_user_id'> | { problem: string } {
  const policy = CARE_REMINDER_POLICY;
  const note = typeof args.note === 'string' ? args.note.trim() : '';
  if (!note) return { problem: 'note is required' };
  const trigger = args.trigger as CareReminderTrigger;
  if (!TRIGGERS.includes(trigger)) return { problem: `trigger must be one of ${TRIGGERS.join(', ')}` };
  const inMinutes = args.in_minutes === null || args.in_minutes === undefined ? null : Number(args.in_minutes);
  if (inMinutes !== null && (!Number.isInteger(inMinutes) || inMinutes < 0 || inMinutes > policy.max_in_minutes)) return { problem: `in_minutes must be whole minutes 0-${policy.max_in_minutes}` };
  let dueMs: number;
  if (trigger === 'AT_TIME') {
    if (typeof args.at_local === 'string' && args.at_local.trim()) {
      const at = localToUtc(args.at_local.trim(), timeZone);
      if (at === null) return { problem: 'at_local must be "YYYY-MM-DDTHH:MM"' };
      if (at <= now.getTime()) return { problem: 'at_local is in the past' };
      if (at > now.getTime() + policy.max_in_minutes * 60_000) return { problem: 'at_local is more than 7 days ahead' };
      dueMs = at;
    } else if (inMinutes !== null && inMinutes > 0) {
      dueMs = now.getTime() + inMinutes * 60_000;
    } else {
      return { problem: 'AT_TIME needs in_minutes (> 0) or at_local' };
    }
  } else {
    dueMs = now.getTime() + (inMinutes ?? 0) * 60_000;
  }
  const threshold = args.threshold_mgdl === null || args.threshold_mgdl === undefined ? null : Number(args.threshold_mgdl);
  const needsThreshold = trigger === 'GLUCOSE_ABOVE' || trigger === 'GLUCOSE_BELOW';
  if (needsThreshold && (threshold === null || !Number.isInteger(threshold) || threshold < policy.min_threshold_mgdl || threshold > policy.max_threshold_mgdl)) {
    return { problem: `threshold_mgdl must be whole mg/dL ${policy.min_threshold_mgdl}-${policy.max_threshold_mgdl} for ${trigger}` };
  }
  const wait = args.wait_minutes === null || args.wait_minutes === undefined
    ? (trigger === 'GLUCOSE_RISING' ? policy.default_rising_wait_minutes : policy.default_wait_minutes)
    : Number(args.wait_minutes);
  if (trigger !== 'AT_TIME' && (!Number.isInteger(wait) || wait < policy.min_wait_minutes || wait > policy.max_wait_minutes)) {
    return { problem: `wait_minutes must be whole minutes ${policy.min_wait_minutes}-${policy.max_wait_minutes} or null` };
  }
  return {
    note: note.slice(0, policy.max_note_length),
    trigger,
    due_at: new Date(dueMs).toISOString(),
    threshold_mgdl: needsThreshold ? threshold : null,
    wait_until: trigger === 'AT_TIME' ? null : new Date(dueMs + wait * 60_000).toISOString(),
  };
}

export type CareReminderReadiness =
  | { state: 'WAIT' }
  | { state: 'EXPIRED' }
  | { state: 'READY' | 'FORCED'; glucose_mgdl: number | null };

/** Whether the reminder comes now (same glucose rules as a bolus card's later part). */
export function careReminderReadiness(args: {
  now: Date;
  reminder: Pick<CareReminderRecord, 'trigger' | 'due_at' | 'threshold_mgdl' | 'wait_until'>;
  readings: Array<{ at: string; value: number }>;
  loopStatus: { observed_at: string; raw_payload: Record<string, unknown> } | null;
}): CareReminderReadiness {
  const nowMs = args.now.getTime();
  const { reminder } = args;
  if (nowMs < Date.parse(reminder.due_at)) return { state: 'WAIT' };
  if (reminder.trigger === 'AT_TIME') return { state: 'READY', glucose_mgdl: null };
  const forecast = buildGlucoseForecast({ now: args.now, readings: args.readings, prediction: parseLoopPrediction(args.loopStatus) });
  const glucose = forecast.reading_fresh && forecast.glucose ? forecast.glucose.value : null;
  const slope = forecast.slope_per_min;
  let met = false;
  if (glucose !== null) {
    if (reminder.trigger === 'GLUCOSE_ABOVE') met = reminder.threshold_mgdl !== null && glucose >= reminder.threshold_mgdl;
    else if (reminder.trigger === 'GLUCOSE_BELOW') met = reminder.threshold_mgdl !== null && glucose <= reminder.threshold_mgdl;
    else if (reminder.trigger === 'GLUCOSE_RISING') met = glucoseRisingForSecondDose(args.readings, args.now);
    else {
      const calibrated = calibratedLoopCurve(forecast, 30);
      const forecastMin = calibrated.length > 1 ? lowestWithin(calibrated)?.value ?? null : null;
      met = glucose >= DEFERRED_BOLUS_POLICY.ready_min_glucose_mgdl
        && !(slope !== null && slope < DEFERRED_BOLUS_POLICY.ready_min_slope_per_min)
        && !(forecastMin !== null && forecastMin < DEFERRED_BOLUS_POLICY.ready_min_forecast_mgdl);
    }
  }
  if (met) return { state: 'READY', glucose_mgdl: glucose };
  if (reminder.wait_until && nowMs >= Date.parse(reminder.wait_until)) {
    // A threshold is an alarm and rising watches like the Bolus tab: never met, it lapses without a push.
    return isThresholdAlarm(reminder.trigger) ? { state: 'EXPIRED' } : { state: 'FORCED', glucose_mgdl: glucose };
  }
  return { state: 'WAIT' };
}

/** A threshold alarm, and rising (the Bolus tab's rule): never met, it lapses without a push. */
function isThresholdAlarm(trigger: CareReminderTrigger): boolean {
  return trigger === 'GLUCOSE_ABOVE' || trigger === 'GLUCOSE_BELOW' || trigger === 'GLUCOSE_RISING';
}

/** The push: the note, and for a glucose condition whether it was met. */
export function careReminderPushContent(reminder: Pick<CareReminderRecord, 'note' | 'trigger' | 'threshold_mgdl'>, readiness: Exclude<CareReminderReadiness, { state: 'WAIT' } | { state: 'EXPIRED' }>): { title: string; body: string } {
  if (reminder.trigger === 'AT_TIME') return { title: 'Przypomnienie', body: reminder.note };
  const glucose = readiness.glucose_mgdl === null ? 'brak świeżego odczytu' : `${readiness.glucose_mgdl} mg/dL`;
  const line = readiness.state === 'READY'
    ? `Glukoza ${glucose}: ${CONDITION_MET[reminder.trigger]}${reminder.threshold_mgdl !== null ? ` ${reminder.threshold_mgdl}` : ''}.`
    : `Glukoza ${glucose}: ${CONDITION_NOT_MET[reminder.trigger]}${reminder.threshold_mgdl !== null ? ` ${reminder.threshold_mgdl}` : ''}.`;
  return { title: 'Przypomnienie', body: `${reminder.note}\n${line}` };
}

const CONDITION_MET: Record<Exclude<CareReminderTrigger, 'AT_TIME'>, string> = {
  GLUCOSE_STOPPED_FALLING: 'przestała spadać',
  GLUCOSE_RISING: 'rośnie',
  GLUCOSE_ABOVE: 'powyżej',
  GLUCOSE_BELOW: 'poniżej',
};

const CONDITION_NOT_MET: Record<Exclude<CareReminderTrigger, 'AT_TIME'>, string> = {
  GLUCOSE_STOPPED_FALLING: 'nadal spada albo jest niska (minął czas oczekiwania)',
  GLUCOSE_RISING: 'nie zaczęła rosnąć (minął czas oczekiwania)',
  GLUCOSE_ABOVE: 'nie przekroczyła (minął czas oczekiwania)',
  GLUCOSE_BELOW: 'nie spadła poniżej (minął czas oczekiwania)',
};

/** "dziś 18:30", "gdy glukoza zacznie rosnąć (pilnuję do 21:10)" */
export function describeReminder(reminder: Pick<CareReminderRecord, 'trigger' | 'due_at' | 'threshold_mgdl' | 'wait_until'>, timeZone: string): string {
  const time = (iso: string) => new Intl.DateTimeFormat('pl-PL', { timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
  if (reminder.trigger === 'AT_TIME') return time(reminder.due_at);
  const condition = {
    GLUCOSE_STOPPED_FALLING: 'gdy glukoza przestanie spadać',
    GLUCOSE_RISING: 'gdy glukoza zacznie rosnąć',
    GLUCOSE_ABOVE: `gdy glukoza przekroczy ${reminder.threshold_mgdl}`,
    GLUCOSE_BELOW: `gdy glukoza spadnie poniżej ${reminder.threshold_mgdl}`,
  }[reminder.trigger];
  if (!reminder.wait_until) return condition;
  return isThresholdAlarm(reminder.trigger) ? `${condition} (pilnuję do ${time(reminder.wait_until)})` : `${condition} (najpóźniej ${time(reminder.wait_until)})`;
}

/** A reminder as the chat card shows it. */
export interface CareReminderView {
  id: string;
  note: string;
  trigger: CareReminderTrigger;
  due_at: string;
  threshold_mgdl: number | null;
  wait_until: string | null;
  status: CareReminderStatus;
  fired_at: string | null;
  fired_reason: 'READY' | 'FORCED' | null;
  cancelled_by_name: string | null;
  /** Polish, for the card ("gdy glukoza przestanie spadać (najpóźniej wt., 21:10)"). */
  described: string;
}

export function toCareReminderView(reminder: CareReminderRecord, timeZone: string): CareReminderView {
  return {
    id: reminder.id,
    note: reminder.note,
    trigger: reminder.trigger,
    due_at: reminder.due_at,
    threshold_mgdl: reminder.threshold_mgdl,
    wait_until: reminder.wait_until,
    status: reminder.status,
    fired_at: reminder.fired_at,
    fired_reason: reminder.fired_reason,
    cancelled_by_name: reminder.cancelled_by_name ?? null,
    described: describeReminder(reminder, timeZone),
  };
}

/** "YYYY-MM-DDTHH:MM" in a time zone → epoch ms; null when not a valid local time. */
export function localToUtc(local: string, timeZone: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local);
  if (!match) return null;
  const [, y, mo, d, h, mi] = match.map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
  // "02-31" is not a day (Date.UTC would roll it into March).
  if (new Date(Date.UTC(y, mo - 1, d)).getUTCDate() !== d) return null;
  // Guess as UTC, then correct by the zone's offset at that instant (twice, for DST edges).
  let guess = Date.UTC(y, mo - 1, d, h, mi);
  for (let pass = 0; pass < 2; pass += 1) {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(guess));
    const get = (type: string) => Number(parts.find((part) => part.type === type)?.value);
    const shown = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'));
    guess += Date.UTC(y, mo - 1, d, h, mi) - shown;
  }
  return guess;
}
