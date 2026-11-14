import { formatUnits } from './remote-command-policy';
import { INSULIN_COUNTED_STATUSES } from './remote-command-status';
import { mealDoseShortfall, OPEN_PLANNED_BOLUS_STATUSES, type PlannedBolusRecord } from './split-bolus';

/**
 * meal-coverage.v1 (owner 2026-11-11, role review docs/product/meal-insulin-progress-review.md): the meal page's bar of
 * the insulin given for the meal's carbs. Never a to-do: an empty end is drawn only when the meal's rest is really
 * missing (the same rule as the action card: mealDoseShortfall, ≥ ~0,5 j). Everything else that is not given yet has
 * its own name: a later part (planned), what the calculator held back on purpose (covered), a dose on its way (sent,
 * not yet in the loop). Orange only for the meal's dose excess (its carbs lowered below what its insulin was for).
 * Only the meal's own doses (NEW_MEAL / MEAL_ADDITION): WBT, corrections on no meal and the loop's own insulin stay out.
 */
export const MEAL_COVERAGE_POLICY = {
  version: 'meal-coverage.v1',
  /** Other meals with a bolus this close to the meal's start are named on its page (the 11:53 chips case). */
  neighbour_minutes: 60,
  /** Below this a held-back amount is not drawn (rounding). */
  min_held_u: 0.1,
} as const;

export type MealCoverageSegmentKind = 'GIVEN' | 'IN_FLIGHT' | 'PLANNED' | 'HELD' | 'GAP';

export interface MealCoverageSegment {
  kind: MealCoverageSegmentKind;
  insulin_u: number;
  /** GIVEN / IN_FLIGHT: when it was given or sent; PLANNED: when it is due. */
  at: string | null;
}

export interface MealCoverageNeighbour {
  meal_id: string;
  started_at: string;
  insulin_u: number;
  carbs_g: number;
  /** "O 11:53 zapisano osobny posiłek: 2,4 j na 20 g." */
  line: string;
}

export interface MealCoverage {
  version: string;
  carbs_g: number;
  icr_g_per_u: number;
  /** Carbs ÷ ICR at the meal's time, to 0,1 j. */
  icr_u: number;
  given_u: number;
  dose_count: number;
  /** In time order; the bar's scale is their sum. Empty: no bar, the headline only. */
  segments: MealCoverageSegment[];
  /** The last part of the bar that was too much (dose_excess.insulin_u); 0: none. */
  excess_u: number;
  /** "3,8 j na 32 g", "4 j podane · 4 j o 19:35", "2,4 j z 3,9 j", "3,9 j na 32 g · jedna dawka". */
  headline: string;
  /** Lines under the bar, each saying what one segment is (held back, on its way). */
  notes: string[];
  accessibility_label: string;
  neighbours: MealCoverageNeighbour[];
}

export interface MealCoverageInput {
  meal_carbs_g: number | null;
  meal_carbs_origin: string | null;
  /** ICR at the meal's start (the therapy profile then); null: no bar. */
  icr_g_per_u: number | null;
  actions: Array<{ id: string; started_at: string; purpose: string | null; carbs_g: number | null; bolus_units: number | null }>;
  /** Confirmed units of actions whose bolus is not in Nightscout yet (journal awaiting_units). */
  awaiting_units?: Map<string, number>;
  /** The meal's remote commands (its own and its parts'). */
  commands: Array<{ id: string; status: string; purpose: string | null; insulin_u: number; authorized_at: string | null; loop_action_id: string | null; planned_bolus_id: string | null }>;
  parts: Array<Pick<PlannedBolusRecord, 'id' | 'status' | 'due_at' | 'planned_insulin_u' | 'fixed_insulin_u'> & { part_index?: number }>;
  /** calculatorHeldBackU of the meal's commands. */
  held_back_u: number;
  excess_u: number | null;
  step: number;
  time_zone: string;
  loop_name: string;
  neighbours?: Array<{ meal_id: string; started_at: string; insulin_u: number; carbs_g: number }>;
}

// A pre-bolus is insulin for this meal's carbs too.
const MEAL_PURPOSES = new Set(['NEW_MEAL', 'MEAL_ADDITION', 'PRE_BOLUS']);
const round1 = (value: number) => Math.round(value * 10) / 10;
const round2 = (value: number) => Math.round(value * 100) / 100;
const units = (value: number) => `${formatUnits(round1(value))} j`;

function clock(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('pl-PL', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
}

/**
 * The bar, or null when it would not be honest: carbs read from Nightscout entries only (not the whole meal), no ICR
 * at the meal's time, or no insulin given or on its way for the meal (the page keeps its old line).
 */
export function mealCoverage(input: MealCoverageInput): MealCoverage | null {
  const carbs = input.meal_carbs_g;
  const icr = input.icr_g_per_u;
  if (carbs === null || !Number.isFinite(carbs) || carbs <= 0) return null;
  if (input.meal_carbs_origin === null || input.meal_carbs_origin === 'NIGHTSCOUT_ENTRY') return null;
  if (!icr || !(icr > 0)) return null;

  const doses = input.actions
    .filter((action) => action.purpose !== null && MEAL_PURPOSES.has(action.purpose))
    .map((action) => ({ ...action, units: action.bolus_units ?? input.awaiting_units?.get(action.id) ?? 0 }))
    .filter((action) => action.units > 0)
    .sort((a, b) => Date.parse(a.started_at) - Date.parse(b.started_at));
  // Sent for the meal (its own dose or a part), not in the loop yet: never a gap, or the other phone gives it again.
  const inFlight = input.commands
    .filter((command) => (INSULIN_COUNTED_STATUSES as readonly string[]).includes(command.status)
      && command.insulin_u > 0 && command.purpose !== 'WBT' && command.purpose !== 'HYPO_TREATMENT'
      && command.loop_action_id === null)
    .sort((a, b) => Date.parse(a.authorized_at ?? '') - Date.parse(b.authorized_at ?? ''));
  const sending = new Set(inFlight.map((command) => command.planned_bolus_id).filter((id): id is string => id !== null));
  const planned = input.parts
    .filter((part) => OPEN_PLANNED_BOLUS_STATUSES.includes(part.status) && !sending.has(part.id))
    .map((part) => ({ part, units: part.fixed_insulin_u ?? part.planned_insulin_u }))
    .filter(({ units: value }) => value > 0)
    .sort((a, b) => (a.part.part_index ?? 0) - (b.part.part_index ?? 0) || Date.parse(a.part.due_at) - Date.parse(b.part.due_at));

  const given = round2(doses.reduce((sum, dose) => sum + dose.units, 0));
  const sent = round2(inFlight.reduce((sum, command) => sum + command.insulin_u, 0));
  if (!(given > 0) && !(sent > 0)) return null;
  const held = input.held_back_u >= MEAL_COVERAGE_POLICY.min_held_u ? round2(input.held_back_u) : 0;
  // The rest really missing, by the action card's rule; none while a part is to come or a dose is on its way.
  const shortfall = planned.length === 0 && sent === 0
    ? mealDoseShortfall({ actions: doses.map((dose) => ({ purpose: 'MEAL_ADDITION', carbs_g: dose.carbs_g, bolus_units: dose.units })), meal_carbs_g: carbs, icr_g_per_u: icr, step: input.step, held_back_u: held })
    : null;
  const gap = shortfall && shortfall.insulin_u >= 0.5 ? shortfall.insulin_u : 0;
  const excess = input.excess_u && input.excess_u > 0 ? Math.min(round2(input.excess_u), given) : 0;

  const segments: MealCoverageSegment[] = [
    ...doses.map((dose) => ({ kind: 'GIVEN' as const, insulin_u: round2(dose.units), at: dose.started_at })),
    ...inFlight.map((command) => ({ kind: 'IN_FLIGHT' as const, insulin_u: round2(command.insulin_u), at: command.authorized_at })),
    ...(held > 0 ? [{ kind: 'HELD' as const, insulin_u: held, at: null }] : []),
    ...planned.map(({ part, units: value }) => ({ kind: 'PLANNED' as const, insulin_u: round2(value), at: part.due_at })),
    ...(gap > 0 ? [{ kind: 'GAP' as const, insulin_u: round2(gap), at: null }] : []),
  ];
  const icrU = round1(carbs / icr);
  const grams = `${Math.round(carbs)} g`;
  const single = doses.length + inFlight.length === 1 && segments.length === 1 && excess === 0;

  let headline: string;
  if (planned.length > 0) {
    const later = planned.slice(0, 2).map(({ part, units: value }) => `${units(value)} o ${clock(part.due_at, input.time_zone)}`);
    headline = [`${units(given + sent)} podane`, ...later].join(' · ');
  } else if (gap > 0) {
    headline = `${units(given)} z ${units(icrU)}`;
  } else {
    headline = `${units(given + sent)} na ${grams}${single ? ' · jedna dawka' : ''}`;
  }

  const notes: string[] = [];
  for (const command of inFlight) {
    const at = command.authorized_at ? ` o ${clock(command.authorized_at, input.time_zone)}` : '';
    notes.push(command.status === 'UNCERTAIN' || command.status === 'NO_REPLY'
      ? `${units(command.insulin_u)}${at}: sprawdzam, czy doszło.`
      : `${units(command.insulin_u)} wysłano${at}, czekam na ${input.loop_name}.`);
  }
  if (held > 0) notes.push(`${units(held)} mniej: insulina z wcześniejszych dawek jeszcze działała.`);

  const neighbours = (input.neighbours ?? [])
    .filter((meal) => meal.insulin_u > 0)
    .sort((a, b) => Date.parse(a.started_at) - Date.parse(b.started_at))
    .map((meal) => ({
      ...meal,
      insulin_u: round2(meal.insulin_u),
      line: `O ${clock(meal.started_at, input.time_zone)} zapisano osobny posiłek: ${units(meal.insulin_u)}${meal.carbs_g > 0 ? ` na ${Math.round(meal.carbs_g)} g` : ''}.`,
    }));

  const spoken = [
    `Insulina na węglowodany: ${planned.length > 0 ? headline : gap > 0 ? `podano ${units(given)} z ${units(icrU)} z przelicznika` : `podano ${units(given + sent)} na ${grams}`}`,
    ...notes,
  ].join('. ').replace(/\.\./g, '.');

  return {
    version: MEAL_COVERAGE_POLICY.version,
    carbs_g: round1(carbs),
    icr_g_per_u: icr,
    icr_u: icrU,
    given_u: given,
    dose_count: doses.length,
    segments: single ? [] : segments,
    excess_u: excess,
    headline,
    notes,
    accessibility_label: spoken,
    neighbours,
  };
}
