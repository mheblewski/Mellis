/**
 * Loop actions (loop-actions.v1, migration 041): what the caregiver did in the loop app, one item per use of the bolus
 * calculator (a carb entry and/or a manual bolus logged within GROUP_WINDOW of each other). Nothing is assigned
 * automatically and nobody is asked after the fact: an action gets its purpose from the app's own bolus command
 * (remote-command-reconciler.ts) or from the chat (SET_PURPOSE, conversation-meal-actions.v1). SMBs are the loop's own doses and never become actions; they are shown in a meal's window as context.
 */

export const LOOP_ACTION_POLICY = {
  version: 'loop-actions.v1',
  /** Trio logs the carb entry and the bolus of one calculator use seconds apart (observed up to ~80 s). */
  group_window_minutes: 3,
  /** Trio syncs a bolus up to a minute or two after its carbs: an action this young may still get its bolus. */
  settle_minutes: 2,
  /** SMBs and boluses counted in a meal's window. */
  meal_window_hours: 4,
  /** A pre-bolus links to the meal created within this time after it. */
  pre_bolus_link_minutes: 90,
} as const;

const LOOP_ACTION_PURPOSES = ['NEW_MEAL', 'MEAL_ADDITION', 'WBT', 'CORRECTION', 'PRE_BOLUS', 'HYPO_TREATMENT', 'IGNORED'] as const;
export type LoopActionPurpose = (typeof LOOP_ACTION_PURPOSES)[number];

export function isLoopActionPurpose(value: unknown): value is LoopActionPurpose {
  return typeof value === 'string' && (LOOP_ACTION_PURPOSES as readonly string[]).includes(value);
}

/** Purposes that need a meal. CORRECTION and PRE_BOLUS may name one; the rest never do. */
const PURPOSES_REQUIRING_MEAL: ReadonlySet<LoopActionPurpose> = new Set(['MEAL_ADDITION', 'WBT']);
const PURPOSES_ALLOWING_MEAL: ReadonlySet<LoopActionPurpose> = new Set(['MEAL_ADDITION', 'WBT', 'CORRECTION']);

export type LoopEventType = 'CARB_ENTRY' | 'BOLUS';

export interface LoopEvent {
  event_id: string;
  event_type: LoopEventType;
  occurred_at: string;
}

export interface OpenLoopAction {
  id: string;
  started_at: string;
  /** Types already in the action (at most one of each). */
  event_types: LoopEventType[];
  /** Assigned actions never take new events: the caregiver answered for what they saw. */
  assigned: boolean;
}

/** Joins the nearest unassigned action within the window that lacks this event type; otherwise a new action. */
export function groupLoopEvent(event: LoopEvent, nearby: OpenLoopAction[]): { action: 'JOIN'; loop_action_id: string } | { action: 'NEW' } {
  const at = Date.parse(event.occurred_at);
  const windowMs = LOOP_ACTION_POLICY.group_window_minutes * 60_000;
  const candidates = nearby
    .filter((action) => !action.assigned && !action.event_types.includes(event.event_type))
    .map((action) => ({ action, distance: Math.abs(Date.parse(action.started_at) - at) }))
    .filter((candidate) => Number.isFinite(candidate.distance) && candidate.distance <= windowMs)
    .sort((a, b) => a.distance - b.distance || a.action.id.localeCompare(b.action.id));
  return candidates[0] ? { action: 'JOIN', loop_action_id: candidates[0].action.id } : { action: 'NEW' };
}

/** Validation of a caregiver's assignment against the action's events. */
export function assignmentProblem(purpose: LoopActionPurpose, mealId: string | null, hasCarbs: boolean, hasBolus: boolean): string | null {
  if (PURPOSES_REQUIRING_MEAL.has(purpose) && !mealId) return `${purpose} needs meal_id`;
  if (!PURPOSES_ALLOWING_MEAL.has(purpose) && mealId) return `${purpose} takes no meal_id`;
  if (purpose === 'NEW_MEAL' && !hasCarbs) return 'NEW_MEAL needs a carb entry; a bolus before a meal is PRE_BOLUS';
  if (purpose === 'PRE_BOLUS' && !hasBolus) return 'PRE_BOLUS needs a bolus';
  if (purpose === 'HYPO_TREATMENT' && !hasCarbs) return 'HYPO_TREATMENT needs a carb entry';
  return null;
}

/** What a carb entry of an action assigned to `purpose` is, in carb_entry_kinds terms. */
export function carbKindForPurpose(purpose: LoopActionPurpose): 'MEAL' | 'CORRECTION_CARBS' | 'HYPO_TREATMENT' | 'FAT_PROTEIN_UNITS' | 'IGNORED' {
  switch (purpose) {
    case 'NEW_MEAL':
    case 'MEAL_ADDITION':
      return 'MEAL';
    case 'WBT':
      return 'FAT_PROTEIN_UNITS';
    case 'CORRECTION':
    case 'PRE_BOLUS':
      return 'CORRECTION_CARBS';
    case 'HYPO_TREATMENT':
      return 'HYPO_TREATMENT';
    case 'IGNORED':
      return 'IGNORED';
  }
}

export function localTime(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('pl-PL', { hour: '2-digit', minute: '2-digit', timeZone }).format(new Date(iso));
}

export type DoseKind = 'MEAL' | 'ADDITION' | 'PRE_BOLUS' | 'CORRECTION' | 'WBT';

export interface MealDose {
  loop_action_id: string;
  kind: DoseKind;
  at: string;
  bolus_units: number | null;
  /** Carbs given to the loop with it (real for MEAL/ADDITION, virtual for CORRECTION, WBT carbs for WBT). */
  carbs_g: number | null;
  /**
   * A remote bolus Trio confirmed ("Bolus started") that is not in Nightscout yet (Trio in the background uploads
   * late): the units and when Trio confirmed them. Only while bolus_units is null.
   */
  awaiting_bolus?: { units: number; confirmed_at: string } | null;
}

export interface MealInsulinSummary {
  /** Bolus units for the food: the meal's own bolus, add-ons and a pre-bolus. */
  meal_units: number;
  correction_units: number;
  wbt_units: number;
  smb_units: number;
  smb_count: number;
  /** Carbs the loop was told were eaten (meal + add-ons); null when none were logged. */
  loop_carbs_g: number | null;
  doses: MealDose[];
  smbs: Array<{ at: string; units: number }>;
}

const round2 = (value: number) => Math.round(value * 100) / 100;

/**
 * Insulin of one meal: the boluses of the actions linked to it, plus SMBs from its start until meal_window_hours later
 * or the next meal's start, whichever is first.
 */
export function summarizeMealInsulin(input: {
  meal_started_at: string;
  next_meal_started_at: string | null;
  actions: Array<{ id: string; purpose: LoopActionPurpose; started_at: string; carbs_g: number | null; bolus_units: number | null }>;
  smbs: Array<{ at: string; units: number }>;
}): MealInsulinSummary {
  const doses: MealDose[] = [];
  for (const action of [...input.actions].sort((a, b) => Date.parse(a.started_at) - Date.parse(b.started_at))) {
    const kind: DoseKind | null = action.purpose === 'NEW_MEAL' ? 'MEAL'
      : action.purpose === 'MEAL_ADDITION' ? 'ADDITION'
        : action.purpose === 'PRE_BOLUS' ? 'PRE_BOLUS'
          : action.purpose === 'CORRECTION' ? 'CORRECTION'
            : action.purpose === 'WBT' ? 'WBT'
              : null;
    if (!kind) continue;
    doses.push({ loop_action_id: action.id, kind, at: action.started_at, bolus_units: action.bolus_units, carbs_g: action.carbs_g });
  }
  const start = Date.parse(input.meal_started_at);
  const windowEnd = start + LOOP_ACTION_POLICY.meal_window_hours * 3_600_000;
  const end = input.next_meal_started_at ? Math.min(windowEnd, Date.parse(input.next_meal_started_at)) : windowEnd;
  const smbs = input.smbs
    .filter((smb) => Date.parse(smb.at) >= start && Date.parse(smb.at) < end)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const sum = (kinds: DoseKind[]) => round2(doses.filter((dose) => kinds.includes(dose.kind)).reduce((total, dose) => total + (dose.bolus_units ?? 0), 0));
  const loopCarbs = doses.filter((dose) => dose.kind === 'MEAL' || dose.kind === 'ADDITION').map((dose) => dose.carbs_g).filter((g): g is number => g !== null);
  return {
    meal_units: sum(['MEAL', 'ADDITION', 'PRE_BOLUS']),
    correction_units: sum(['CORRECTION']),
    wbt_units: sum(['WBT']),
    smb_units: round2(smbs.reduce((total, smb) => total + smb.units, 0)),
    smb_count: smbs.length,
    loop_carbs_g: loopCarbs.length ? round2(loopCarbs.reduce((a, b) => a + b, 0)) : null,
    doses,
    smbs,
  };
}
