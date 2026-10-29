import type { CareReminderRecord } from '@modules/care-reminders/application/care-reminders';
import type { LoopActionPurpose } from '@modules/loop-actions/application/loop-action-policy';
import { fatProteinUnitsOf, type WbtReminderStatus } from '@modules/meal-wbt/application/wbt-policy';
import { planTrigger, type PlannedBolusRecord } from '@modules/remote-commands/application/split-bolus';

/**
 * The Meals tab's journal (meal-journal.v1, owner decision 2026-10-25): only meals that have a description (from the
 * chat, the meal chat or earlier) or a reminder (WBT, a Bolus tab second dose, a planned later part). Pure: the API
 * reads the rows and this file turns them into what the app shows. A Bolus tab meal has no name: the app names it by its
 * carbs, insulin and time, never by an invented one.
 */

export const MEAL_JOURNAL_POLICY = {
  version: 'meal-journal.v1',
  default_limit: 20,
  max_limit: 50,
  /** A reminder whose moment came this recently, with no dose given since, is "due now" (the list's header). */
  due_now_minutes: 30,
  /** Search: glucose peak and lowest this long after the meal's start. */
  search_glucose_hours: 4,
  /** The meal page's chart: from 30 min before to 6 h after the start (or now). */
  chart_before_minutes: 30,
  chart_after_hours: 6,
} as const;

export type JournalReminderKind = 'WBT' | 'SECOND_DOSE' | 'PLANNED_PART';
/** MISSED (WBT only, migration 081): its time had long passed when it was switched on; it never came. */
export type JournalReminderStatus = 'WAITING' | 'DUE_NOW' | 'SENT' | 'EXPIRED' | 'OFF' | 'GIVEN' | 'MISSED';
export type JournalSource = 'CHAT' | 'BOLUS_SCREEN' | 'OTHER';

export interface JournalReminder {
  /** WBT: "wbt" (a meal has one); SECOND_DOSE: the care reminder's id; PLANNED_PART: the planned bolus's id. */
  id: string;
  kind: JournalReminderKind;
  /** AFTER_MINUTES (a time: WBT, a second dose after minutes, a timed part) or the glucose condition waited for. */
  trigger: string;
  due_at: string;
  /** A glucose condition is watched until then; null for a time. */
  wait_until: string | null;
  status: JournalReminderStatus;
  enabled: boolean;
  /** When its push went out (or its moment came); null before. */
  fired_at: string | null;
  /** A line the meal page shows under it (only when there is one): why a WBT reminder never came. */
  note?: string;
}

export interface JournalItem {
  meal_id: string;
  started_at: string;
  /** The meal's description; null for a Bolus tab meal (the app names it "45 g · 4,5 j" with its time). */
  title: string | null;
  carbs_g: number | null;
  /** Every bolus assigned to the meal (its own, add-ons and later parts, pre-bolus, WBT, corrections), not SMBs. */
  insulin_total_u: number | null;
  source: JournalSource;
  conversation_id: string | null;
  /** Protein or fat known: a WBT dose can be worked out. */
  has_macros: boolean;
  reminders: JournalReminder[];
}

/** One bolus of the meal for its page and time line. */
export interface JournalBolus {
  at: string;
  insulin_u: number | null;
  carbs_g: number | null;
  kind: 'MEAL' | 'WBT' | 'PART' | 'OTHER';
  /** GLUCOMIND: sent from the app; LOOP: entered in the loop's own app. */
  source: 'GLUCOMIND' | 'LOOP';
  author_name: string | null;
}

export type JournalTimelineEvent =
  | { at: string; type: 'BOLUS'; bolus: JournalBolus }
  | { at: string; type: 'REMINDER'; reminder: JournalReminder };

/** A loop action assigned to the meal, as the journal needs it. */
export interface JournalAction {
  id: string;
  purpose: LoopActionPurpose | null;
  started_at: string;
  carbs_g: number | null;
  bolus_units: number | null;
  assigned_by: string | null;
}

/** Everything one item is built from (read in batches for a page). */
export interface JournalFacts {
  meal_id: string;
  started_at: string;
  description: string | null;
  /** The meal's own carbs (its values) or else the loop's carb entries. */
  carbs_g: number | null;
  protein_g: number | null;
  fat_g: number | null;
  actions: JournalAction[];
  /** Boluses Trio confirmed for actions whose bolus is not in Nightscout yet (action id → units). */
  awaiting_units: Map<string, number>;
  origin: { first_command_source: string | null; conversation_id: string | null };
  wbt: { enabled: boolean; source: 'AUTO' | 'MANUAL'; remind_at: string; status: WbtReminderStatus; sent_at: string | null; dose_given_at?: string | null; skip_reason?: 'STALE' | null } | null;
  care: CareReminderRecord[];
  parts: PlannedBolusRecord[];
}

const MEAL_INSULIN_PURPOSES: ReadonlySet<LoopActionPurpose> = new Set(['NEW_MEAL', 'MEAL_ADDITION', 'PRE_BOLUS', 'CORRECTION', 'WBT']);
const round2 = (value: number) => Math.round(value * 100) / 100;

export function clampJournalLimit(raw: unknown): number {
  const value = typeof raw === 'string' && raw.trim() ? Number(raw) : typeof raw === 'number' ? raw : MEAL_JOURNAL_POLICY.default_limit;
  if (!Number.isFinite(value)) return MEAL_JOURNAL_POLICY.default_limit;
  return Math.max(1, Math.min(MEAL_JOURNAL_POLICY.max_limit, Math.trunc(value)));
}

/** The boluses' units as the meal views count them (summarizeMealInsulin's kinds), a confirmed one on its way too. */
export function mealInsulinTotal(actions: JournalAction[], awaiting: Map<string, number>): number | null {
  let total = 0;
  let any = false;
  for (const action of actions) {
    if (!action.purpose || !MEAL_INSULIN_PURPOSES.has(action.purpose)) continue;
    const units = action.bolus_units ?? awaiting.get(action.id) ?? null;
    if (units === null) continue;
    total += units;
    any = true;
  }
  return any ? round2(total) : null;
}

function wbtGiven(actions: JournalAction[], awaiting: Map<string, number>): boolean {
  return actions.some((action) => action.purpose === 'WBT' && ((action.bolus_units ?? awaiting.get(action.id) ?? 0) > 0));
}

function dueNowOrSent(firedAtMs: number, nowMs: number): JournalReminderStatus {
  return nowMs - firedAtMs <= MEAL_JOURNAL_POLICY.due_now_minutes * 60_000 ? 'DUE_NOW' : 'SENT';
}

/** The meal's WBT reminder: a WBT dose given (assigned to the meal, or the one that answered it) settles it. */
export function wbtReminderStatus(wbt: NonNullable<JournalFacts['wbt']>, given: boolean, now: Date): JournalReminderStatus {
  if (given || wbt.dose_given_at) return 'GIVEN';
  if (!wbt.enabled) return 'OFF';
  if (wbt.status === 'SENT') return dueNowOrSent(Date.parse(wbt.sent_at ?? wbt.remind_at), now.getTime());
  // Switched on long after its time (protein or fat added late): no push, not a lapse (owner decision 2026-10-26).
  if (wbt.status === 'MISSED') return 'MISSED';
  // Skipped by the worker: too late to send (it was down) or the WBT carbs were already in the loop.
  if (wbt.status === 'SKIPPED') return 'EXPIRED';
  return Date.parse(wbt.remind_at) > now.getTime() ? 'WAITING' : 'DUE_NOW';
}

export const WBT_REMINDER_MISSED_NOTE = 'Przypomnienie o WBT minęło — sprawdź, czy WBT jest jeszcze potrzebne.';
export const WBT_REMINDER_STALE_NOTE = 'Przypomnienie o WBT nie zostało wysłane (przerwa serwera).';

/** Why the WBT reminder never came: switched on too late (MISSED), or the worker could not send it in time (STALE). */
function wbtReminderNote(wbt: NonNullable<JournalFacts['wbt']>, status: JournalReminderStatus): { note?: string } {
  if (status === 'MISSED') return { note: WBT_REMINDER_MISSED_NOTE };
  if (status === 'EXPIRED' && wbt.skip_reason === 'STALE') return { note: WBT_REMINDER_STALE_NOTE };
  return {};
}

/**
 * A second dose (or any care reminder of the meal): given when a bolus was assigned to the meal after it was set (an
 * add-on or a correction of it) or a caregiver's dose answered it (dose_given_at: a Bolus tab dose has no meal); a
 * glucose condition still watched is waiting.
 */
export function careReminderStatus(reminder: CareReminderRecord, actions: JournalAction[], awaiting: Map<string, number>, now: Date): JournalReminderStatus {
  const setMs = Date.parse(reminder.created_at);
  const givenAfter = actions.some((action) => (action.purpose === 'MEAL_ADDITION' || action.purpose === 'CORRECTION')
    && Date.parse(action.started_at) >= setMs
    && (action.bolus_units ?? awaiting.get(action.id) ?? 0) > 0);
  // Given before it came (082) is given; one the worker could not send in time (MISSED) lapsed like an expired one.
  if (reminder.status === 'GIVEN') return 'GIVEN';
  if (reminder.status === 'CANCELLED') return 'OFF';
  if (reminder.status === 'EXPIRED' || reminder.status === 'MISSED') return 'EXPIRED';
  if (givenAfter || reminder.dose_given_at) return 'GIVEN';
  if (reminder.status === 'FIRED') return dueNowOrSent(Date.parse(reminder.fired_at ?? reminder.due_at), now.getTime());
  if (reminder.trigger !== 'AT_TIME') return 'WAITING';
  return Date.parse(reminder.due_at) > now.getTime() ? 'WAITING' : 'DUE_NOW';
}

/** A planned later part: open ones are waiting until due and due now once due or sent (its button stays until given). */
export function plannedPartStatus(part: Pick<PlannedBolusRecord, 'status' | 'due_at'>, now: Date): JournalReminderStatus {
  switch (part.status) {
    case 'GIVEN': return 'GIVEN';
    case 'SKIPPED':
    case 'CANCELLED': return 'OFF';
    case 'EXPIRED': return 'EXPIRED';
    case 'NOTIFIED': return 'DUE_NOW';
    default: return Date.parse(part.due_at) > now.getTime() ? 'WAITING' : 'DUE_NOW';
  }
}

export function journalReminders(facts: Pick<JournalFacts, 'wbt' | 'care' | 'parts' | 'actions' | 'awaiting_units'>, now: Date): JournalReminder[] {
  const reminders: JournalReminder[] = [];
  // An AUTO reminder switched off by the macros was never the caregiver's: no reminder to show.
  if (facts.wbt && (facts.wbt.enabled || facts.wbt.source === 'MANUAL')) {
    const status = wbtReminderStatus(facts.wbt, wbtGiven(facts.actions, facts.awaiting_units), now);
    reminders.push({
      id: 'wbt',
      kind: 'WBT',
      trigger: 'AFTER_MINUTES',
      due_at: facts.wbt.remind_at,
      wait_until: null,
      status,
      enabled: facts.wbt.enabled,
      fired_at: facts.wbt.sent_at,
      ...wbtReminderNote(facts.wbt, status),
    });
  }
  for (const reminder of facts.care) {
    reminders.push({
      id: reminder.id,
      kind: 'SECOND_DOSE',
      trigger: reminder.trigger === 'AT_TIME' ? 'AFTER_MINUTES' : reminder.trigger,
      due_at: reminder.due_at,
      wait_until: reminder.wait_until,
      status: careReminderStatus(reminder, facts.actions, facts.awaiting_units, now),
      enabled: reminder.status !== 'CANCELLED',
      fired_at: reminder.fired_at,
    });
  }
  for (const part of facts.parts) {
    reminders.push({
      id: part.id,
      kind: 'PLANNED_PART',
      trigger: planTrigger(part),
      due_at: part.due_at,
      wait_until: part.wait_until,
      status: plannedPartStatus(part, now),
      enabled: part.status !== 'SKIPPED' && part.status !== 'CANCELLED',
      fired_at: part.notified_at,
    });
  }
  return reminders.sort((a, b) => Date.parse(a.due_at) - Date.parse(b.due_at));
}

/** CHAT: from a chat card or a chat's meal change; BOLUS_SCREEN: a Bolus tab dose; OTHER: anything else. */
export function journalSource(origin: JournalFacts['origin']): JournalSource {
  if (origin.first_command_source === 'BOLUS_SCREEN') return 'BOLUS_SCREEN';
  if (origin.first_command_source === 'CHAT_CARD' || origin.conversation_id) return 'CHAT';
  return 'OTHER';
}

export function buildJournalItem(facts: JournalFacts, now: Date): JournalItem {
  const description = facts.description?.trim() ? facts.description.trim() : null;
  return {
    meal_id: facts.meal_id,
    started_at: facts.started_at,
    title: description,
    carbs_g: facts.carbs_g,
    insulin_total_u: mealInsulinTotal(facts.actions, facts.awaiting_units),
    source: journalSource(facts.origin),
    conversation_id: facts.origin.conversation_id,
    has_macros: fatProteinUnitsOf(facts.protein_g, facts.fat_g) !== null,
    reminders: journalReminders(facts, now),
  };
}

/** Whether a journal item belongs in the list (a description or a reminder); the SQL already picks these. */
export function isJournalMeal(item: Pick<JournalItem, 'title' | 'reminders'>): boolean {
  return item.title !== null || item.reminders.length > 0;
}

export function bolusKind(purpose: LoopActionPurpose | null): JournalBolus['kind'] {
  if (purpose === 'NEW_MEAL' || purpose === 'PRE_BOLUS') return 'MEAL';
  if (purpose === 'WBT') return 'WBT';
  if (purpose === 'MEAL_ADDITION') return 'PART';
  return 'OTHER';
}

/** The meal's boluses, oldest first; a command sent from the app names who sent it. */
export function journalBoluses(actions: JournalAction[], awaiting: Map<string, number>, senders: Map<string, string | null>): JournalBolus[] {
  return actions
    .filter((action) => action.purpose !== null && MEAL_INSULIN_PURPOSES.has(action.purpose))
    .map((action) => ({
      at: action.started_at,
      insulin_u: action.bolus_units ?? awaiting.get(action.id) ?? null,
      carbs_g: action.carbs_g,
      kind: bolusKind(action.purpose),
      source: senders.has(action.id) ? 'GLUCOMIND' as const : 'LOOP' as const,
      author_name: senders.has(action.id) ? senders.get(action.id) ?? action.assigned_by : action.assigned_by,
    }))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

/**
 * Boluses on no meal (given without "Zapisz jako posiłek", or a Trio bolus nobody assigned) that fall in the meal
 * chart's window: drawn on the chart beside the meal's own, oldest first. Other meals' boluses stay on their pages.
 */
export function chartOtherBoluses(
  actions: Array<JournalAction & { meal_record_id: string | null }>,
  mealActionIds: ReadonlySet<string>,
  senders: Map<string, string | null>,
): JournalBolus[] {
  return actions
    .filter((action) => action.meal_record_id === null && !mealActionIds.has(action.id) && (action.bolus_units ?? 0) > 0)
    .map((action) => ({
      at: action.started_at,
      insulin_u: action.bolus_units,
      carbs_g: action.carbs_g,
      kind: 'OTHER' as const,
      source: senders.has(action.id) ? 'GLUCOMIND' as const : 'LOOP' as const,
      author_name: senders.has(action.id) ? senders.get(action.id) ?? action.assigned_by : action.assigned_by,
    }))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

/** Boluses and reminders in time order; a reminder sits at its push (or its due time before it). */
export function journalTimeline(boluses: JournalBolus[], reminders: JournalReminder[]): JournalTimelineEvent[] {
  const events: JournalTimelineEvent[] = [
    ...boluses.map((bolus) => ({ at: bolus.at, type: 'BOLUS' as const, bolus })),
    ...reminders.map((reminder) => ({ at: reminder.fired_at ?? reminder.due_at, type: 'REMINDER' as const, reminder })),
  ];
  return events.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

/** The search text: 1-100 characters after trimming. */
export function parseMealSearchQuery(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const text = raw.trim().replace(/\s+/g, ' ');
  return text.length >= 1 && text.length <= 100 ? text : null;
}

/** LIKE pattern with the user's % and _ taken literally (the SQL folds case and diacritics on both sides). */
export function likePattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}
