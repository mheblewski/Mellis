import { cleanReadings, deltaPerFiveMinutes, shortAverageSlope, type GlucosePoint } from '@modules/glucose-forecast/application/cgm-trend';
import { makeLocalMinuteOfDay } from '@modules/evidence-tools/daily-insulin-totals';
import { capitalized, loopSystemNames, type LoopSystemKind } from '@modules/loop-system/domain/loop-system';
import { detectHighDespiteInsulin } from '@modules/remote-commands/application/high-glucose-safety';
import { trendArrow } from '@modules/remote-commands/application/bolus-reminders';
import type { RescueEvaluation } from '@modules/rescue-carbs/application/rescue-detection';
import type { RescueDoseProposal } from '@modules/rescue-carbs/application/rescue-dose';

/**
 * What the Teraz screen says right now (now-situation.v1, docs/product/teraz-situation). Pure: no database, no clock, no
 * AI. The server decides the state and writes the finished Polish strings, so both caregivers see the same words and a
 * wording change needs no phone build; the phone only colours and lays them out.
 *
 * Hysteresis needs no stored state. A low episode is read from the readings, and the hold of calm states and the return
 * of praise are folded over the last readings, so the same input always gives the same answer on every phone.
 *
 * Forecast conditions read the rescue evaluation (the loop's forecast), never the experimental prediction engine.
 * States that come with later stages are not here: the undo window (stage 4), the stale and offline push lines
 * (stage 5) and the missing Trio confirmation (stage 7).
 */
export const NOW_SITUATION_POLICY = {
  version: 'now-situation.v6',
  low_mgdl: 70,
  urgent_mgdl: 54,
  /** Two readings in a row at or above these end a low episode. */
  low_exit_mgdl: 75,
  urgent_exit_mgdl: 60,
  high_mgdl: 180,
  very_high_mgdl: 250,
  episode_lookback_minutes: 60,

  /** A reading this old is not current: praise goes first, then everything else at one limit, at any glucose (owner, 2026-11-07). */
  praise_stale_minutes: 10,
  low_stale_minutes: 15,
  stale_minutes: 15,

  loop_silent_minutes: 15,
  /** Sentences about what the loop does need a contact this recent. */
  loop_contact_minutes: 10,
  loop_activity_window_minutes: 30,

  /** Two changes in a row of at least this much per 5 min count as a real rise (states 6b, 6c, 8e). */
  two_rises_mgdl_per_5min: 2,
  /** A drop of at least this much ends "already rising" at once. */
  rise_broken_drop_mgdl: 2,
  /** Direction words need both the last 5 minutes and the short average to agree, so one noisy reading changes nothing. */
  trend_delta_mgdl_per_5min: 3,
  trend_slope_mgdl_per_min: 0.3,
  /** "Glukoza spada" only for a fall this fast: slower wobble is not worth a change of sentence (owner, after the replay). */
  fast_fall_mgdl_per_5min: 10,
  fast_fall_high_mgdl_per_5min: 15,
  doubtful_fall_mgdl_per_5min: 20,
  doubtful_new_sensor_hours: 12,

  forecast_grams_max_glucose_mgdl: 100,
  forecast_grams_max_minutes: 30,
  /** Grams once shown for an alert stay up to this glucose, so they do not jump in and out with the forecast. */
  forecast_grams_keep_max_glucose_mgdl: 110,
  /** Two readings outside the alert's condition end the forecast state. */
  forecast_exit_readings: 2,

  /** After "Podano": this long on both phones to take it back. */
  undo_seconds: 5,
  check_no_reading_grace_minutes: 3,
  check_minutes: 15,
  /** Carbs given from 70 up: how long Mellis watches for a reading below 70 (owner, 2026-11-08). */
  forecast_watch_minutes: 45,
  check_after_urgent_minutes: 10,
  recheck_minutes: 10,
  /** Result states stay this long unless glucose goes below 70. */
  result_hold_minutes: 10,
  urgent_no_new_dose_minutes: 10,
  /** Carbs this recent still beat a stale reading (state 8j). */
  carbs_beat_stale_minutes: 30,
  still_low_label_max_minutes: 60,
  /**
   * State 6c waits without a dose only this long after the lowest reading below 70 (owner, 2026-11-09): two rises
   * (~10 min) to get into 6c, then the 15-minute check of the 15/15 rule. Past it, state 6 gives the dose.
   */
  rising_low_wait_max_minutes: 25,
  /** Texts review (diabetologist, 2026-11-09): below this, 6c does not wait, state 6 gives the dose. */
  rising_low_wait_min_mgdl: 60,
  /** A forecast that counts carbs entered this recently is no reason to wait in 6c (critic, 2026-11-09). */
  rising_low_fresh_carbs_minutes: 20,

  /** A loop-entered carb entry counts as rescue carbs under these conditions (state 8c). */
  rescue_entry_max_g: 20,
  rescue_entry_no_bolus_minutes: 10,
  rescue_entry_glucose_below_mgdl: 80,
  rescue_entry_after_alert_minutes: 30,

  meal_bolus_within_minutes: 120,
  meal_bolus_within_high_minutes: 120,
  /** v3 (teraz-sentence-review): nothing is said about a dose of the last half hour except when it takes effect. */
  fresh_dose_minutes: 30,
  fresh_dose_min_glucose_mgdl: 140,
  /** "Węgle działają szybciej niż insulina": carbs this old, and before them glucose this low and not rising. */
  fresh_carbs_min_g: 5,
  fresh_carbs_from_minutes: 10,
  fresh_carbs_bolus_match_minutes: 15,
  fresh_carbs_before_max_mgdl: 140,
  fresh_carbs_before_max_delta: 5,
  /** The meal's peak ≥ 250 keeps "po posiłku" off only this long after its bolus. */
  meal_peak_guard_after_minutes: 90,
  /** "Na razie nic nie trzeba robić" above 180 after a meal: owner, 2026-11-08, up to 220 only. */
  meal_promise_max_mgdl: 220,
  meal_promise_max_delta: 10,
  /** A loop status this old, or older than a dose, says nothing about IOB, COB or the forecast. */
  snapshot_fresh_minutes: 10,
  /** Numbers from the loop's forecast only where the chart line is this close to it. */
  forecast_chart_agreement_mgdl: 10,
  forecast_cloud_max_width_mgdl: 60,
  forecast_time_round_minutes: 15,
  basal_below_plan_minutes: 15,
  basal_below_plan_max_delta: 2,
  stacking_bolus_minutes: 60,
  stacking_min_mgdl: 70,
  stacking_max_mgdl: 99,
  high_rise_check_minutes: 30,
  high_rise_check_mgdl: 15,
  unexplained_rise_minutes: 45,
  unexplained_rise_mgdl: 60,
  explained_by_dose_hours: 3,
  very_high_no_bolus_hours: 2,
  high_fall_delta: 5,
  /** State 3e ends once glucose has fallen this much since the correction (high-glucose-safety's own bar for its first hour). */
  correction_no_effect_fall_mgdl: 50,
  correction_from_minutes: 30,
  correction_to_minutes: 180,
  extra_insulin_minutes: 30,
  correction_low_line_max_mgdl: 89,
  fast_fall_low_line_max_mgdl: 89,
  low_insulin_clause_mgdl: 20,
  low_insulin_clause_max_delta: -2,
  calm_max_delta: 5,
  calm_no_dose_minutes: 120,
  calm_no_low_minutes: 180,
  meal_carbs_bolus_match_minutes: 30,

  /** Texts review (owner, 2026-11-09): praise only from 4 hours in range. */
  praise_hours: 4,
  praise_min_coverage: 0.9,
  praise_min_glucose_mgdl: 80,
  praise_max_slope_mgdl_per_min: 1,
  praise_min_after_insulin_mgdl: 90,
  praise_max_zero_basal_minutes: 30,
  /** Readings further apart than this in the run are no praise: the plain in-range state stands (texts review, 2026-11-09). */
  praise_even_span_mgdl: 50,
  /** v4: another caregiver's bolus is told this long (owner, 2026-11-08), matched to Mellis's command within this. */
  caregiver_bolus_minutes: 20,
  caregiver_bolus_match_minutes: 10,
  /** No word of praise this long after a reading below 54. */
  praise_no_word_after_urgent_hours: 12,
  praise_day_min_coverage: 0.7,
  /** "Na razie nic nie trzeba robić": the loop's forecast stays at or above this. */
  nothing_to_do_min_forecast_mgdl: 80,
  fresh_data_minutes: 10,
  /** State 6b at 70 or above loses its dose only with this little insulin left to act (IOB × ISF). */
  soft_dose_gone_insulin_mgdl: 15,
  pump_suspended_minutes: 15,
  meal_no_fall_mgdl: 200,
  meal_no_fall_after_minutes: 90,
  /** State 2b: COB at most this, "about zero" (texts review, 2026-11-09). */
  meal_no_fall_max_cob_g: 5,
  carbs_no_bolus_min_g: 20,
  carbs_no_bolus_from_minutes: 15,
  carbs_no_bolus_to_minutes: 60,
  /** IOB × ICR below this share of the carbs: SMBs have not covered them. */
  carbs_no_bolus_covered_share: 0.5,
  bolus_no_carbs_minutes: 90,
  bolus_no_carbs_after_insulin_mgdl: 90,
  back_in_range_max_minutes: 60,
  back_in_range_high_minutes: 30,
  no_added_insulin_max_insulin_mgdl: 30,
  /** In hours with a plan at or below this, SMBs are capped at 0 by the loop's own settings. */
  no_added_insulin_min_plan_u_per_h: 0.05,
  bolus_working_minutes: 120,
  bolus_working_insulin_mgdl: 30,
  no_readings_long_minutes: 60,
  new_sensor_no_readings_minutes: 60,
  evening_note_from_minute: 20 * 60,
  evening_note_to_minute: 22 * 60,
  /** Hours from now to 7:00 at the latest: the reservoir does not last through the night. */
  morning_minute: 7 * 60,
  day_line_from_minute: 6 * 60,
  day_line_to_minute: 22 * 60,
  day_line_stable_minutes: 30,
  day_line_no_rescue_minutes: 120,
  day_line_no_low_minutes: 60,
  day_line_no_urgent_hours: 12,
  day_line_no_very_high_hours: 6,
  day_line_very_high_minutes: 60,
  praise_returns_after_minutes: 15,
  praise_night_max_gap_minutes: 15,
  praise_day_min_tir_percent: 80,
  praise_day_max_below_percent: 4,

  /** Owner, after the replay: 20 minutes, up from the spec's 10. */
  calm_hold_minutes: 20,
  /** How far back the calm states are folded; longer than the hold and the praise return together. */
  fold_minutes: 60,

  /** "…a insulina jest jeszcze aktywna" needs IOB × ISF of at least this much. */
  active_insulin_clause_mgdl: 15,
  /** Owner decision 4 in HANDOFF: a juice of 10 g carbs per 100 ml, one value on the server. */
  juice_ml_per_g: 10,
  /** Reading the same way as the day and night split in the replay. */
  morning_from_minute: 6 * 60,
  morning_to_minute: 10 * 60,
  evening_from_minute: 18 * 60,
  evening_to_minute: 22 * 60,
  night_from_minute: 22 * 60,
  night_to_minute: 6 * 60,
  /**
   * v5 (owner, 2026-11-09, docs/product/teraz-context-action-review.md): a planned meal on Teraz. "O 12:30 obiad." from
   * this long before it, while nothing was entered for it.
   */
  meal_soon_minutes: 30,
  /** Carbs or a bolus from this long before the meal count as entered for it (the meal page's dose window). */
  meal_entered_from_minutes: 45,
  /** A bolus smaller than this does not count as the meal's (an SMB-sized correction). */
  meal_entered_bolus_min_u: 0.3,
  /** "Do posiłku z 12:30 nie ma wpisu węgli.": from and until this long after the meal (diabetologist's veto 3). */
  meal_late_from_minutes: 25,
  meal_late_until_minutes: 90,
  /** Below this the late-meal sentence stays away: a dose then is not what the screen should push. */
  meal_late_min_glucose_mgdl: 100,
  /** A meal this close (before or after) gives the bar its button when another sentence holds the line. */
  meal_link_window_minutes: 30,
} as const;

const POLICY = NOW_SITUATION_POLICY;
const MINUTE_MS = 60_000;

/**
 * Chosen by the owner, 2026-11-07. Since v3 (owner, 2026-11-08) only among the day lines in full calm, at most two hours a
 * day: never in the sentence's place, never where something is going on. Since the texts review (owner, 2026-11-09) one
 * fact only, about hummingbirds, as the brand's signature.
 */
export const NOW_LIGHT_FACT = 'Koliber potrafi latać do tyłu.';
const LIGHT_FACT_FIRST_HOUR = 9;
const LIGHT_FACT_LAST_HOUR = 20;

/** The fact for this local hour, or null: two hours a day, the same on both phones, other hours each day. */
export function lightFact(now: Date, timeZone: string): string | null {
  const minute = (makeLocalMinuteOfDay(timeZone) as (ms: number) => number)(now.getTime());
  const hour = Math.floor(minute / 60);
  const day = Math.floor((now.getTime() - minute * MINUTE_MS) / (24 * 60 * MINUTE_MS) + 0.5);
  const span = LIGHT_FACT_LAST_HOUR - LIGHT_FACT_FIRST_HOUR + 1;
  const first = LIGHT_FACT_FIRST_HOUR + (day * 7) % span;
  const second = LIGHT_FACT_FIRST_HOUR + (day * 7 + 5) % span;
  return hour === first || hour === second ? NOW_LIGHT_FACT : null;
}

/**
 * NOW_SITUATION_ENABLED: the dashboard sends `situation` and the rescue push opens Teraz. On unless 0, false, no or off
 * (owner, 2026-11-13); off, the app draws today's hero and the alert's conversation, which is the way back.
 */
export function isNowSituationEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !/^(0|false|no|off)$/i.test(String(env.NOW_SITUATION_ENABLED ?? '').trim());
}

export const NOW_SITUATION_STATES = [
  '1', '1b', '1c', '1d', '1e', '1f', '2', '2b', '2c', '2d', 'P',
  '3', '3a', '3b', '3c', '3d', '3e', '3f', '3g',
  '4', '4b', '5', '5b',
  '6', '6b', '6c', '6d', '6e', '6f', '6g',
  '7', '7b',
  '8u', '8', '8b', '8c', '8d', '8e', '8f', '8g', '8i', '8j',
  '9', '9b', '9c',
] as const;

export type NowSituationState = typeof NOW_SITUATION_STATES[number];

const PRAISE_STATES: ReadonlySet<NowSituationState> = new Set(['1', '1b', '1c']);
/** These may be held for the calm hold; every other state interrupts them at once. */
const CALM_STATES: ReadonlySet<NowSituationState> = new Set(['1', '1b', '1c', '1d', '2', '3', '3a', '3c', '3g', '4', '4b']);

export function isPraiseState(state: NowSituationState): boolean {
  return PRAISE_STATES.has(state);
}

export function isCalmState(state: NowSituationState): boolean {
  return CALM_STATES.has(state);
}

export interface NowLoopSnapshot {
  at: string;
  iob_u: number | null;
  cob_g: number | null;
  /** The rate the loop last set, U/h; null when the upload does not say. */
  rate_u_per_h: number | null;
}

export interface NowCarbEntry {
  /** The event's id, what "Cofnij" names. */
  id?: string | null;
  at: string;
  grams: number;
  /** The kind stored for the entry; null when it has none yet. */
  kind: 'HYPO_TREATMENT' | 'MEAL' | 'CORRECTION_CARBS' | null;
  /** Tapped in Mellis, or entered in the loop. */
  source: 'MELLIS' | 'LOOP';
  by_user_id?: string | null;
  by_name?: string | null;
  /** How texts speak of that caregiver: 'f' "podała", 'm' "podał"; null when the caregiver has not said. */
  by_gender?: CaregiverGender | null;
}

/** The grammatical gender a caregiver chose for texts about them (users.preferences.grammatical_gender). */
export type CaregiverGender = 'f' | 'm';

export function caregiverGender(value: unknown): CaregiverGender | null {
  return value === 'f' || value === 'm' ? value : null;
}

/** A bolus Mellis sent to the loop and the loop confirmed, with who sent it. */
export interface NowRemoteBolus {
  at: string;
  units: number;
  carbs_g: number;
  /** PARTIAL: the loop delivered less, so the dose in Nightscout differs. */
  status: 'SUCCEEDED' | 'PARTIAL';
  by_user_id: string;
  by_name: string | null;
  by_gender: CaregiverGender | null;
}

export interface NowSituationInput {
  now: Date;
  time_zone: string;
  /** The user reading the screen: "Podano" for their own tap, "Opiekun Ewa podał" for someone else's. */
  viewer_user_id?: string | null;
  /** Nominative, used in the glucagon sentence. */
  patient_label?: string | null;
  /** Readings of at least the last 24 h, in any order. */
  readings: GlucosePoint[];
  loop: {
    system: LoopSystemKind;
    /** Oldest first, at least the last 2 h. Empty for a patient without a loop: nothing is said about one then. */
    snapshots: NowLoopSnapshot[];
    plan_rate_u_per_h: number | null;
    /**
     * The basal running now and since when, as the dashboard's basal pill shows it (delivered basal, temp basals merged).
     * The loop status only carries a rate on the cycles that set a new one.
     */
    rate_now?: { rate_u_per_h: number | null; since: string | null } | null;
  };
  /** The loop's main forecast in full (oref's COB or IOB curve) when fresh; absent or empty otherwise. */
  loop_curve?: GlucosePoint[];
  /** The forecast line Teraz's chart draws, with its cloud; numbers from loop_curve only where this line agrees. */
  chart_line?: Array<GlucosePoint & { low?: number; high?: number }>;
  /** The insulin peak from the loop's own settings, minutes after a dose; null when the loop does not send it. */
  insulin_peak_minutes?: number | null;
  isf_mgdl_per_u: number | null;
  /** Manual boluses, without SMBs. */
  boluses: Array<{ at: string; units: number }>;
  /** Remote boluses of the last hour with their senders, to say who gave a bolus (v4); absent: no one is named. */
  remote_boluses?: NowRemoteBolus[];
  smbs: Array<{ at: string; units: number }>;
  carbs: NowCarbEntry[];
  sensor_changed_at?: string | null;
  site_changed_at?: string | null;
  /** The pump reports a suspension since then. */
  pump_suspended_since?: string | null;
  /** A remote bolus of the last hours did not finish cleanly: "nothing to do" cannot be promised. */
  bolus_problem?: boolean;
  /** The arrow as the sensor gives it; null when unknown. "Spada" is not said against it. */
  trend_direction?: string | null;
  /** An override in force, for the second sentence. */
  override?: { name: string | null; percentage: number } | null;
  /** How long the reservoir lasts at the usual daily insulin; null when unknown. */
  reservoir_hours_left?: number | null;
  /** The current rescue evaluation; null when none could be made. */
  evaluation: RescueEvaluation | null;
  /** The dose from rescue-dose for this evaluation, computed on demand so a low without an alert has one too. */
  dose: RescueDoseProposal | null;
  /**
   * The pushed rescue alert still open. `last_triggered_at`: the newest evaluation that flagged it. `grams_since`: when
   * forecastGramsConditionHolds first held for this alert; null when it has not.
   */
  alert: { notified_at: string; last_triggered_at: string | null; grams_since?: string | null; grams?: number | null } | null;
  /** When recent alerts were pushed, to tell rescue carbs entered in the loop from a snack. */
  recent_alerts_notified_at?: string[];
  /** Highest point of the loop's main forecast; null when unknown. */
  forecast_peak_mgdl: number | null;
  /** Keys of the check pushes already sent for this patient (recent), for the push that closes a missing reading. */
  sent_check_push_keys?: string[];
  /** "Mellis powiadomi" is a promise: on only together with its push (stage 5). */
  check_push_live: boolean;
  /**
   * Planned meals near now (meal-plan.v1): PLANNED, not paused, MEAL only. Absent: no plan is read, nothing is said about
   * one (v5).
   */
  planned_meals?: NowPlannedMeal[];
}

/** A planned meal as Teraz needs it (v5). */
export interface NowPlannedMeal {
  id: string;
  /** As the plan names it, nominative: "obiad", "Zupa i podwieczorek". Never declined. */
  title: string;
  planned_at: string;
  /** Dish names, in the plan's order. */
  items: string[];
  /** A caregiver already said the bolus near it was (or was not) for it, or whether it was eaten. */
  answered: boolean;
}

/** The bar's one button (v5): it only opens a screen, never sends anything. */
export type NowLink =
  | { kind: 'MEAL_PLAN_ENTRY'; entry_id: string; label: string }
  | { kind: 'CONVERSATION'; label: string };

export type NowGlucoseTone = 'NEUTRAL' | 'AMBER' | 'RED' | 'ON_RED' | 'STALE';

export interface NowSituation {
  policy_version: string;
  state: NowSituationState;
  evaluated_at: string;
  glucose: { value: number; at: string; age_minutes: number; tone: NowGlucoseTone } | null;
  /** The second number. DOSE is a fact, FORECAST_DOSE has the dashed underline, the others are time. */
  second: {
    kind: 'DOSE' | 'SOFT_DOSE' | 'FORECAST_DOSE' | 'GIVEN' | 'CHECK' | 'NO_READING';
    label: string | null;
    value: string;
    unit: string | null;
    note: string | null;
  } | null;
  sentence: string;
  detail: string | null;
  action:
    | { kind: 'GIVEN'; grams: number; style: 'FILLED' | 'OUTLINE'; label: string; other_amount_label: string }
    | { kind: 'LOG_CARBS'; label: string }
    | { kind: 'UNDO'; label: string; event_id: string; until: string }
    | null;
  /** The running check after carbs. */
  check: { carbs_at: string; carbs_g: number; due_at: string } | null;
  dose_policy_version: string | null;
  /** Quiet states only: one of these goes under the sentence (now-day-lines.v2). The phone picks. */
  day_lines?: string[];
  /** The sentence is a light fact, not about the patient: a conversation does not start from it. */
  light?: boolean;
  /** The day line among day_lines that is a light fact: the phone draws it grey (owner, 2026-11-08). */
  light_fact?: string | null;
  /**
   * v5: the bar's button, tied to the sentence; null: no button. Never set beside `action` (one action on screen). Phones
   * before v5 do not read it and keep "Porozmawiaj ›".
   */
  link: NowLink | null;
}

type CheckPhase =
  /** Carbs given from 70 up (a forecast): no check, only watching for a reading below 70 until `untilMs`. */
  | { kind: 'WATCHING'; untilMs: number }
  | { kind: 'WAITING'; dueMs: number; second: boolean }
  | { kind: 'BACK'; resultMs: number; value: number; hadLow: boolean; minutes: number }
  | { kind: 'FALLING'; dueMs: number; resultMs: number; value: number }
  | { kind: 'RISING'; dueMs: number; resultMs: number; value: number }
  | { kind: 'STILL_LOW'; resultMs: number }
  | { kind: 'OVER'; resultMs: number; backAbove: boolean };

/** Lookups over the input at a moment in time, past moments included. */
class Moment {
  readonly readings: GlucosePoint[];
  readonly latest: GlucosePoint | null;
  readonly ageMinutes: number | null;
  readonly delta: number | null;
  readonly slope: number | null;
  readonly snapshot: NowLoopSnapshot | null;
  readonly loopAgeMinutes: number | null;
  /** Past moments know nothing about the current evaluation or dose. */
  constructor(
    readonly input: NowSituationInput,
    readonly allReadings: GlucosePoint[],
    readonly times: number[],
    readonly ms: number,
    readonly isNow: boolean,
    readonly minuteOf: (ms: number) => number,
  ) {
    const end = upperBound(times, ms);
    this.readings = allReadings.slice(Math.max(0, end - 340), end);
    this.latest = this.readings.at(-1) ?? null;
    this.ageMinutes = this.latest ? (ms - Date.parse(this.latest.at)) / MINUTE_MS : null;
    const recent = this.readings.slice(-8);
    this.delta = deltaPerFiveMinutes(recent);
    this.slope = shortAverageSlope(recent);
    this.snapshot = newestAt(input.loop.snapshots, ms);
    this.loopAgeMinutes = this.snapshot ? (ms - Date.parse(this.snapshot.at)) / MINUTE_MS : null;
  }

  get rising(): boolean {
    return (this.delta ?? 0) >= POLICY.trend_delta_mgdl_per_5min && (this.slope ?? 0) >= POLICY.trend_slope_mgdl_per_min;
  }

  get falling(): boolean {
    return (this.delta ?? 0) <= -POLICY.trend_delta_mgdl_per_5min && (this.slope ?? 0) <= -POLICY.trend_slope_mgdl_per_min;
  }

  get loopSilent(): boolean {
    return this.loopAgeMinutes !== null && this.loopAgeMinutes >= POLICY.loop_silent_minutes;
  }

  get loopInContact(): boolean {
    return this.loopAgeMinutes !== null && this.loopAgeMinutes <= POLICY.loop_contact_minutes;
  }
}

export function decideNowSituation(input: NowSituationInput): NowSituation {
  const nowMs = input.now.getTime();
  const readings = cleanReadings(input.readings, input.now);
  const times = readings.map((reading) => Date.parse(reading.at));
  const minuteOf = makeLocalMinuteOfDay(input.time_zone) as (ms: number) => number;
  const moment = (ms: number, isNow: boolean) => new Moment(input, readings, times, ms, isNow, minuteOf);

  const current = moment(nowMs, true);
  const raw = classify(current);
  if (!isCalmState(raw)) return build(raw, current);

  // A calm state now: what was on screen a moment ago decides whether it changes yet.
  let shown: NowSituationState | null = null;
  let shownSinceMs = 0;
  let praiseLostMs = Number.NEGATIVE_INFINITY;
  const step = (candidate: Moment) => {
    let next = classify(candidate);
    if (isPraiseState(next) && candidate.ms - praiseLostMs < POLICY.praise_returns_after_minutes * MINUTE_MS) {
      next = classify(candidate, { noPraise: true });
    }
    if (shown === null) {
      shown = next;
      shownSinceMs = candidate.ms;
      return;
    }
    if (next === shown) return;
    const samePraise = isPraiseState(next) && isPraiseState(shown);
    // A fast fall is news: it never waits for the hold of the sentence before it.
    const interrupts = next === '4' || next === '4b' || next === '3c';
    const held = !samePraise && !interrupts && isCalmState(shown) && isCalmState(next) && !isPraiseState(shown)
      && candidate.ms - shownSinceMs < POLICY.calm_hold_minutes * MINUTE_MS
      && claimStillTrue(shown, candidate);
    if (held) return;
    if (isPraiseState(shown) && !isPraiseState(next)) praiseLostMs = candidate.ms;
    shown = next;
    shownSinceMs = candidate.ms;
  };
  const from = nowMs - POLICY.fold_minutes * MINUTE_MS;
  for (let index = lowerBound(times, from); index < times.length && times[index] < nowMs; index += 1) step(moment(times[index], false));
  step(current);
  const state: NowSituationState = shown ?? raw;
  // Mellis's own fall from the last readings often stands beside a sensor arrow that does not fall: the arrow stays, the words give way.
  return build(state === '4' && arrowNotFalling(input) && !fallStaysTold(current) ? classify(current, { arrowNotFalling: true, noPraise: true }) : state, current);
}

/** A held calm state must not say something the newest reading contradicts. */
function claimStillTrue(state: NowSituationState, at: Moment): boolean {
  const value = at.latest?.value;
  if (value === undefined) return false;
  const delta = at.delta ?? 0;
  switch (state) {
    case '1d': return value >= POLICY.low_mgdl && value <= POLICY.high_mgdl;
    case '2': return value < POLICY.very_high_mgdl && !fallingFast(at);
    case '3': return value > POLICY.high_mgdl && delta >= 0;
    case '3a': return value > POLICY.very_high_mgdl && delta >= 0;
    case '3c':
    case '3g': return value > POLICY.high_mgdl && delta <= 0;
    case '4':
    case '4b': return delta <= 0;
    default: return false;
  }
}

function classify(at: Moment, options: { noPraise?: boolean; arrowNotFalling?: boolean } = {}): NowSituationState {
  const { latest, ageMinutes } = at;
  if (at.isNow && undoableEntry(at)) return '8u';
  if (!latest || ageMinutes === null) return '9';
  const value = latest.value;
  const entry = newestRescueEntry(at);
  const stale = (value < POLICY.low_mgdl && ageMinutes >= POLICY.low_stale_minutes)
    || (ageMinutes >= POLICY.stale_minutes);
  if (stale) {
    if (entry && (at.ms - Date.parse(entry.at)) / MINUTE_MS <= POLICY.carbs_beat_stale_minutes) return '8j';
    return value < POLICY.rescue_entry_glucose_below_mgdl || at.falling ? '9b' : '9';
  }

  const phase = entry ? checkPhase(at, entry) : null;
  const backCutMs = phase && (phase.kind === 'BACK' || (phase.kind === 'OVER' && phase.backAbove)) ? phase.resultMs : null;

  if (inEpisode(at, POLICY.urgent_mgdl, POLICY.urgent_exit_mgdl, backCutMs)) {
    if (entry && (at.ms - Date.parse(entry.at)) / MINUTE_MS < POLICY.urgent_no_new_dose_minutes) return '8g';
    return at.isNow && at.input.dose?.carbs_g == null ? '7b' : '7';
  }

  if (entry && phase) {
    if (phase.kind === 'WAITING' || phase.kind === 'WATCHING') return waitingState(at, entry);
    if (phase.kind === 'FALLING' && value >= POLICY.low_mgdl) return '8f';
    // Still below 70 at the second look and no longer rising: the new dose at once, not another 10 minutes (texts review).
    if (phase.kind === 'RISING' && value < POLICY.low_mgdl && risingHeld(at.readings)) return '8e';
    const inHold = phase.kind === 'BACK' && at.ms - phase.resultMs < POLICY.result_hold_minutes * MINUTE_MS;
    if (inHold && value >= POLICY.low_mgdl) return phase.hadLow ? '8d' : '8i';
  }

  if (inEpisode(at, POLICY.low_mgdl, POLICY.low_exit_mgdl, backCutMs)) return lowState(at, phase);

  if (at.loopSilent) return sustainedHigh(at) ? '3d' : '9c';
  if (forecastActive(at)) return forecastGrams(at) !== null ? '5' : '5b';
  if (pumpSuspended(at)) return 'P';
  if (sustainedHigh(at)) return '3b';
  if (correctionNoEffect(at) !== null) return '3e';
  // 2b only once the loop counts the meal's carbs as nearly absorbed: with carbs still acting a rise is the meal (critic).
  if (mealStillRising(at) && (at.snapshot?.cob_g ?? Number.POSITIVE_INFINITY) <= POLICY.meal_no_fall_max_cob_g && afterMeal(at, true)) return '2b';
  if (afterMeal(at)) return '2';
  if (carbsWithoutBolus(at)) return '2c';
  // A dose of the last half hour: only when it takes effect, never "it still works" (v3, rule 12).
  if (freshDose(at) !== null && value > POLICY.fresh_dose_min_glucose_mgdl) {
    if (value <= POLICY.high_mgdl && bolusWithoutCarbs(at)) return '1f';
    return '2d';
  }

  if (value > POLICY.high_mgdl) {
    if (basalBelowPlan(at) !== null) return '3f';
    if (highFallCause(at) !== null) return '3g';
    if ((at.delta ?? 0) <= -POLICY.fast_fall_high_mgdl_per_5min) return '3c';
    return value > POLICY.very_high_mgdl ? '3a' : '3';
  }
  if (fallingFast(at) && (value < 110 || !options.arrowNotFalling)) return value < 110 ? '4b' : '4';
  if (bolusWithoutCarbs(at)) return '1f';
  if (!options.noPraise && praiseHolds(at)) return praiseKind(at);
  if (backInRangeMinutes(at) !== null) return '1e';
  return '1d';
}

/** Carbs just tapped in Mellis, still possible to take back. */
function undoableEntry(at: Moment): (NowCarbEntry & { id: string }) | null {
  const entry = newestAt(at.input.carbs.filter((candidate) => candidate.source === 'MELLIS' && candidate.id), at.ms);
  if (!entry || at.ms - Date.parse(entry.at) >= POLICY.undo_seconds * 1000) return null;
  return entry as NowCarbEntry & { id: string };
}

/** The three prepared questions under a conversation started from Teraz (spec section 4), with this patient's loop name. */
export function situationQuestions(state: NowSituationState, system: LoopSystemKind): string[] {
  const loop = capitalized(loopSystemNames(system).nominative);
  // Texts review (2026-11-09): "Co się działo w tym czasie?" only after a high (1e); in calm there is nothing to explain.
  if (state === '1e') return ['Co się działo w tym czasie?', 'Jak wyglądał ostatni tydzień?', 'Czy któraś pora dnia wymaga uwagi?'];
  if (state === '1' || state === '1b' || state === '1c' || state === '1d' || state === '8d' || state === '8i') return ['Jak wyglądał ostatni tydzień?', 'Czy któraś pora dnia wymaga uwagi?'];
  if (state === '2' || state === '2d') return ['Czy ta dawka wystarczy na ten posiłek?', 'Kiedy glukoza powinna zacząć spadać?', 'Jak podobne posiłki działały wcześniej?'];
  // 3f: the loop gives less basal because it expects a fall, so "how much it adds" would contradict the sentence.
  if (state === '3f') return ['Skąd ta wysoka glukoza?', 'Ile insuliny jeszcze działa?', `Dlaczego ${loop} przewiduje spadek?`];
  if (state === '3' || state === '3a' || state === '3g') return ['Skąd ta wysoka glukoza?', 'Ile insuliny jeszcze działa?', `Ile insuliny dodaje już ${loop}?`];
  if (state === '1f') return ['Co sprawdzić najpierw?', 'Jak nisko może zejść glukoza?', 'Ile insuliny jeszcze działa?'];
  // 2c: carbs without a bolus, glucose goes up, not down.
  if (state === '2c') return ['Co sprawdzić najpierw?', 'Jak wysoko może wzrosnąć glukoza?', 'Ile insuliny jeszcze działa?'];
  // The pen question only where a correction by pen is the next step (3b, 3e).
  if (state === '3b' || state === '3e') return ['Kiedy i jak zmierzyć ketony?', 'Jak sprawdzić, czy wkłucie działa?', 'Kiedy podać insulinę penem?'];
  if (state === 'P') return ['Kiedy i jak zmierzyć ketony?', 'Co sprawdzić, zanim włączę pompę?'];
  if (state === '3d' || state === '2b') return ['Kiedy i jak zmierzyć ketony?', 'Jak sprawdzić, czy wkłucie działa?'];
  if (state === '3c' || state === '4' || state === '4b') return ['Skąd ten spadek?', 'Jak nisko może zejść glukoza?', 'Ile insuliny jeszcze działa?'];
  if (state === '5' || state === '5b') return ['Skąd to ostrzeżenie?', 'Czy warto już podać węgle?', 'Co będzie, jeśli nic nie podam?'];
  if (state === '7' || state === '7b' || state === '8g') return ['Jak podać glukagon?', 'Co zrobić po podaniu węgli?', 'Kiedy podać glukagon?'];
  // 6c shows no amount: the question is whether carbs are needed at all.
  if (state === '6c') return ['Skąd ta niska glukoza?', 'Czy trzeba podać węgle?', 'Ile insuliny jeszcze działa?'];
  if (state === '6b') return ['Skąd ta niska glukoza?', 'Czy ta ilość wystarczy?', `Czy ${loop} poda insulinę na te węgle?`];
  if (state.startsWith('6')) return ['Skąd ten spadek?', 'Czy ta ilość wystarczy?', `Czy ${loop} poda insulinę na te węgle?`];
  if (state.startsWith('8')) return ['Kiedy można podać kolejne węgle?', 'Co zrobić, jeśli glukoza nie wzrośnie?', `Czy ${loop} uwzględnia te węgle?`];
  return ['Co sprawdzić najpierw?', 'Co się dzieje, gdy pętla milczy?', 'Kiedy zmierzyć glukozę glukometrem?'];
}

/** The first message of a conversation from Teraz: the same picture as the screen. Written by the server, no model involved. */
export function situationConversationSeed(args: { situation: NowSituation; iob: number | null; cob: number | null; basal: number | null; timeZone: string; now: Date }): string {
  const { situation } = args;
  const minute = (makeLocalMinuteOfDay(args.timeZone) as (ms: number) => number)(args.now.getTime());
  const number = (value: number) => String(Math.round(value * 100) / 100).replace('.', ',');
  const parts = [`Z ekranu Teraz, ${Math.floor(minute / 60)}:${String(minute % 60).padStart(2, '0')}.`];
  if (situation.glucose) parts.push(`Glukoza ${situation.glucose.value} mg/dL.`);
  const second = situation.second;
  if (second && (second.kind === 'DOSE' || second.kind === 'SOFT_DOSE' || second.kind === 'FORECAST_DOSE')) parts.push(`Propozycja ${second.value} szybkich węgli.`);
  const numbers = [
    args.iob !== null ? `IOB ${number(args.iob)} j` : null,
    args.cob !== null ? `COB ${number(args.cob)} g` : null,
    args.basal !== null ? `baza ${number(args.basal)} j/h` : null,
  ].filter((part): part is string => part !== null);
  if (numbers.length > 0) parts.push(`${numbers.join(', ')}.`);
  if (!situation.light && situation.sentence.trim()) parts.push(situation.sentence.trim());
  if (situation.detail) parts.push(situation.detail);
  return parts.join(' ');
}

/**
 * When the situation could not be worked out (a failed read of the alert or carbs): only what the dashboard itself knows,
 * so the screen stays the same one. No dose, no button, nothing about the loop.
 */
export function fallbackNowSituation(glucose: { value: number; observed_at: string } | null | undefined, now: Date, loopSystem: LoopSystemKind = 'UNKNOWN'): NowSituation {
  const age = glucose ? Math.max(0, Math.round((now.getTime() - Date.parse(glucose.observed_at)) / MINUTE_MS)) : 0;
  const current = glucose && age < POLICY.stale_minutes;
  return {
    policy_version: POLICY.version,
    state: current ? '1d' : '9',
    evaluated_at: now.toISOString(),
    glucose: glucose ? { value: glucose.value, at: glucose.observed_at, age_minutes: age, tone: current ? glucoseTone('1d', glucose.value) : 'STALE' } : null,
    second: glucose && !current ? { kind: 'NO_READING', label: null, value: `${age} min`, unit: 'bez odczytu', note: null } : null,
    // Texts review (2026-11-09): a fresh reading needs no words, an old one the same line as state 9.
    sentence: current ? '' : `Warto sprawdzić sensor i telefon z ${INSTRUMENTAL[loopSystem]}.`,
    detail: null,
    action: null,
    check: null,
    dose_policy_version: null,
    link: null,
  };
}

export interface NowCheckPush {
  /** One push per carb entry and result. */
  key: string;
  kind: 'still_low' | 'rising_low' | 'no_reading' | 'below_low' | 'reading_back';
  title: string;
  body: string;
  /** Not for a phone whose own low alert ("Powiadomienia o glikemii") already says it: one push, not two. */
  skip_if_low_alert?: boolean;
}

/**
 * The push the sentence "Mellis powiadomi" promises, from the same check the screen shows; null when none is due. A result
 * from 70 up wakes nobody. A little time is left for a reading that is due before saying there is none.
 */
export function decideCheckPush(input: NowSituationInput): NowCheckPush | null {
  const readings = cleanReadings(input.readings, input.now);
  const at = new Moment(input, readings, readings.map((reading) => Date.parse(reading.at)), input.now.getTime(), true, makeLocalMinuteOfDay(input.time_zone) as (ms: number) => number);
  const entry = newestRescueEntry(at);
  if (!entry?.id) return null;
  const phase = checkPhase(at, entry);
  const entryMs = Date.parse(entry.at);
  // "Po węglach: 78 ↗": the number in the title; the arrow only as the sensor gives it, and only for the newest reading.
  const title = (value: number | null, atMs?: number) => {
    if (value === null) return 'Po węglach: brak odczytu';
    const arrow = atMs !== undefined && at.latest && Date.parse(at.latest.at) === atMs ? trendArrow(input.trend_direction ?? null, null) : null;
    return `Po węglach: ${value}${arrow ? ` ${arrow}` : ''}`;
  };
  const after = (ms: number) => Math.round((ms - entryMs) / MINUTE_MS);
  if (phase.kind === 'STILL_LOW') {
    const value = at.latest?.value;
    if (value === undefined || value >= POLICY.low_mgdl || at.ms - phase.resultMs > POLICY.result_hold_minutes * MINUTE_MS) return null;
    const grams = input.dose?.carbs_g;
    const dose = grams ? ` Mellis proponuje jeszcze ${grams} g szybkich węglowodanów.` : '';
    return { key: `${entry.id}:still_low:${phase.resultMs}`, kind: 'still_low', title: title(value), body: `Minęło ${after(phase.resultMs)} min, a glukoza nadal jest poniżej 70.${dose}` };
  }
  if (phase.kind === 'RISING') {
    if (at.ms - phase.resultMs > POLICY.result_hold_minutes * MINUTE_MS) return null;
    return { key: `${entry.id}:rising_low:${phase.resultMs}`, kind: 'rising_low', title: title(phase.value, phase.resultMs), body: `Minęło ${after(phase.resultMs)} min i glukoza rośnie. Więcej węgli nie trzeba. Mellis sprawdzi ją znowu o ${clock(phase.dueMs, at.minuteOf)}.` };
  }
  // Below 70 before the check, after carbs given from 70 up (owner, 2026-11-08): at once, not at the check.
  const before = glucoseAt(at, entryMs);
  const value = at.latest?.value;
  const fresh = (at.ageMinutes ?? Number.POSITIVE_INFINITY) <= POLICY.fresh_data_minutes;
  // Also back above 70 and falling after a low (FALLING): the next reading below 70 does not wait for the second look.
  if (((phase.kind === 'WAITING' && before !== null && before >= POLICY.low_mgdl) || phase.kind === 'FALLING')
    && value !== undefined && value < POLICY.low_mgdl && fresh && Date.parse(at.latest!.at) > entryMs) {
    return {
      key: `${entry.id}:below_low`,
      kind: 'below_low',
      title: title(value),
      body: `Węgle z ${clock(entryMs, at.minuteOf)} zwykle działają po 10–15 min. Mellis sprawdzi glukozę o ${clock(phase.dueMs, at.minuteOf)}. Do tego czasu nie podawaj kolejnych węgli.`,
      skip_if_low_alert: true,
    };
  }
  // Watching after carbs from a forecast, and readings stopped: the same push as a check without its reading.
  if (phase.kind === 'WATCHING' && at.latest && (at.ageMinutes ?? 0) >= POLICY.check_minutes + POLICY.check_no_reading_grace_minutes) {
    return { key: `${entry.id}:no_reading`, kind: 'no_reading', title: title(null), body: `Od ${Math.round(at.ageMinutes!)} min nie ma nowego odczytu. Zmierz glukozę glukometrem.` };
  }
  if (phase.kind === 'WAITING' && at.ms >= phase.dueMs + POLICY.check_no_reading_grace_minutes * MINUTE_MS) {
    return { key: `${entry.id}:no_reading`, kind: 'no_reading', title: title(null), body: `Od węgli minęło ${after(phase.dueMs)} min, a nowego odczytu nie ma. Zmierz glukozę glukometrem.` };
  }
  // After "nie ma nowego odczytu": the reading is back, so the matter closes on the phone too (owner, 2026-11-08).
  if ((input.sent_check_push_keys ?? []).includes(`${entry.id}:no_reading`) && value !== undefined && fresh) {
    const trend = at.rising ? ', glukoza rośnie' : at.falling ? ', glukoza spada' : '';
    return { key: `${entry.id}:reading_back`, kind: 'reading_back', title: title(value, Date.parse(at.latest!.at)), body: `Odczyt wrócił${trend}.` };
  }
  return null;
}

function pumpSuspended(at: Moment): boolean {
  const since = at.input.pump_suspended_since ? Date.parse(at.input.pump_suspended_since) : Number.NaN;
  return Number.isFinite(since) && at.ms - since >= POLICY.pump_suspended_minutes * MINUTE_MS;
}

/**
 * A correction 1–3 h ago that lowered glucose too little in its first hour: how long ago it was and how much glucose fell
 * since; null otherwise. Not once it has fallen by 50 since, nor while the loop gives less basal than the plan, which
 * explains a small fall without a site in doubt (texts review, 2026-11-09).
 */
function correctionNoEffect(at: Moment): { minutes: number; fall: number } | null {
  const recent = at.readings.filter((reading) => at.ms - Date.parse(reading.at) <= 185 * MINUTE_MS);
  const found = detectHighDespiteInsulin({
    now: new Date(at.ms),
    readings: recent,
    boluses: at.input.boluses.filter((dose) => Date.parse(dose.at) <= at.ms),
    carbs: at.input.carbs.filter((entry) => Date.parse(entry.at) <= at.ms).map((entry) => ({ at: entry.at, grams: entry.grams })),
  });
  if (found?.kind !== 'CORRECTION_NO_EFFECT' || !found.bolus_at || found.before_mgdl === undefined || !at.latest) return null;
  const fall = Math.max(0, Math.round(found.before_mgdl - at.latest.value));
  if (fall >= POLICY.correction_no_effect_fall_mgdl) return null;
  const plan = at.input.loop.plan_rate_u_per_h;
  const rate = rateAt(at);
  if (plan !== null && rate !== null && rate.rate < plan) return null;
  return { minutes: (at.ms - Date.parse(found.bolus_at)) / MINUTE_MS, fall };
}

function newestBolus(at: Moment): { at: string; units: number } | null {
  return newestAt(at.input.boluses, at.ms);
}

function mealStillRising(at: Moment): boolean {
  const bolus = newestBolus(at);
  return at.rising && (at.latest?.value ?? 0) > POLICY.meal_no_fall_mgdl && bolus !== null && at.ms - Date.parse(bolus.at) > POLICY.meal_no_fall_after_minutes * MINUTE_MS;
}

function unbolusedCarbs(at: Moment): NowCarbEntry | null {
  const icr = at.input.dose?.icr_g_per_u ?? null;
  const iob = at.snapshot?.iob_u ?? null;
  if (icr === null || iob === null || !at.loopInContact || (at.snapshot?.cob_g ?? 0) <= 0 || at.falling || (at.latest?.value ?? 0) <= 100) return null;
  for (const entry of at.input.carbs) {
    const minutes = (at.ms - Date.parse(entry.at)) / MINUTE_MS;
    if (minutes < POLICY.carbs_no_bolus_from_minutes || minutes > POLICY.carbs_no_bolus_to_minutes) continue;
    if (entry.grams < POLICY.carbs_no_bolus_min_g || entry.source !== 'LOOP' || isRescueEntry(at, entry)) continue;
    const bolusNear = at.input.boluses.some((dose) => Math.abs(Date.parse(dose.at) - Date.parse(entry.at)) <= POLICY.meal_carbs_bolus_match_minutes * MINUTE_MS);
    if (!bolusNear && iob * icr < entry.grams * POLICY.carbs_no_bolus_covered_share) return entry;
  }
  return null;
}

const carbsWithoutBolus = (at: Moment): boolean => unbolusedCarbs(at) !== null;

function bolusWithoutCarbs(at: Moment): boolean {
  const bolus = newestBolus(at);
  const isf = at.input.isf_mgdl_per_u;
  const iob = at.snapshot?.iob_u ?? null;
  if (!bolus || isf === null || iob === null || !at.loopInContact || !at.latest) return false;
  const bolusMs = Date.parse(bolus.at);
  if (at.ms - bolusMs > POLICY.bolus_no_carbs_minutes * MINUTE_MS) return false;
  const carbsNear = at.input.carbs.some((entry) => Math.abs(Date.parse(entry.at) - bolusMs) <= POLICY.meal_carbs_bolus_match_minutes * MINUTE_MS);
  return !carbsNear && at.latest.value - activeInsulinUnits(at)! * isf < POLICY.bolus_no_carbs_after_insulin_mgdl;
}

/** IOB of the newest status plus the boluses it has not seen yet; null without a status. */
function activeInsulinUnits(at: Moment): number | null {
  const snapshot = at.snapshot;
  if (!snapshot || snapshot.iob_u === null) return null;
  const snapshotMs = Date.parse(snapshot.at);
  const unseen = at.input.boluses.filter((dose) => Date.parse(dose.at) > snapshotMs && Date.parse(dose.at) <= at.ms).reduce((sum, dose) => sum + dose.units, 0);
  return snapshot.iob_u + unseen;
}

/** Carbs of a meal (not rescue carbs) up to the moment. */
function mealCarbs(at: Moment): NowCarbEntry[] {
  return at.input.carbs.filter((entry) => entry.grams > 0 && Date.parse(entry.at) <= at.ms && !isRescueEntry(at, entry));
}

/** The newest bolus or meal carbs of the last half hour, its time; null when there is none. */
function freshDose(at: Moment): number | null {
  const times = [...at.input.boluses.map((dose) => dose.at), ...mealCarbs(at).map((entry) => entry.at)].map((iso) => Date.parse(iso))
    .filter((ms) => ms <= at.ms && at.ms - ms <= POLICY.fresh_dose_minutes * MINUTE_MS);
  return times.length > 0 ? Math.max(...times) : null;
}

/** The loop status is recent and newer than the newest bolus and carbs: its IOB, COB and forecast count them. */
function snapshotFresh(at: Moment): boolean {
  const snapshot = at.snapshot;
  if (!snapshot || at.loopAgeMinutes === null || at.loopAgeMinutes > POLICY.snapshot_fresh_minutes) return false;
  const snapshotMs = Date.parse(snapshot.at);
  const doses = [...at.input.boluses, ...at.input.carbs].map((item) => Date.parse(item.at)).filter((ms) => ms <= at.ms);
  return doses.every((ms) => ms <= snapshotMs);
}


/** The basal running at the moment; null when unknown. Past moments know it only when it already ran then. */
function rateAt(at: Moment): { rate: number; sinceMs: number | null } | null {
  const now = at.input.loop.rate_now;
  if (!now || now.rate_u_per_h === null) return null;
  const sinceMs = now.since ? Date.parse(now.since) : null;
  if (!at.isNow && (sinceMs === null || sinceMs > at.ms)) return null;
  return { rate: now.rate_u_per_h, sinceMs };
}

/** Basal below the plan for a while at a high glucose that has stopped rising, the forecast going down: the rate. */
function basalBelowPlan(at: Moment): number | null {
  if (!at.isNow || !at.latest || !at.loopInContact || !snapshotFresh(at)) return null;
  const plan = at.input.loop.plan_rate_u_per_h;
  const rate = rateAt(at);
  if (plan === null || rate === null || rate.sinceMs === null || rate.rate >= plan) return null;
  if (at.ms - rate.sinceMs < POLICY.basal_below_plan_minutes * MINUTE_MS) return null;
  if ((at.delta ?? 0) > POLICY.basal_below_plan_max_delta || (activeInsulinUnits(at) ?? 0) <= 0) return null;
  const end = (at.input.loop_curve ?? []).at(-1)?.value;
  if (end === undefined || end >= at.latest.value) return null;
  return rate.rate;
}

/** Why glucose above 180 falls: a correction 30 min – 3 h ago, or extra insulin from the loop; null otherwise. */
function highFallCause(at: Moment): { kind: 'CORRECTION'; at: string } | { kind: 'LOOP' } | null {
  if (!at.falling || (at.delta ?? 0) > -POLICY.high_fall_delta) return null;
  const correction = newestBolus(at);
  if (correction) {
    const age = (at.ms - Date.parse(correction.at)) / MINUTE_MS;
    const carbsNear = at.input.carbs.some((entry) => Math.abs(Date.parse(entry.at) - Date.parse(correction.at)) <= POLICY.meal_carbs_bolus_match_minutes * MINUTE_MS);
    if (age >= POLICY.correction_from_minutes && age <= POLICY.correction_to_minutes && !carbsNear) return { kind: 'CORRECTION', at: correction.at };
  }
  if (!at.loopInContact) return null;
  const hourMs = 60 * MINUTE_MS;
  const smb = at.input.smbs.some((dose) => dose.units > 0 && Date.parse(dose.at) <= at.ms && at.ms - Date.parse(dose.at) <= hourMs);
  const plan = at.input.loop.plan_rate_u_per_h;
  const rate = rateAt(at);
  const raised = plan !== null && rate !== null && rate.sinceMs !== null && rate.rate > plan && at.ms - rate.sinceMs >= POLICY.extra_insulin_minutes * MINUTE_MS;
  return smb || raised ? { kind: 'LOOP' } : null;
}

/** Any bolus or meal carbs within these hours before the moment. */
function doseWithin(at: Moment, hours: number, what: 'bolus' | 'carbs' | 'any'): boolean {
  const fromMs = at.ms - hours * 60 * MINUTE_MS;
  const inWindow = (iso: string) => Date.parse(iso) >= fromMs && Date.parse(iso) <= at.ms;
  const bolus = what !== 'carbs' && at.input.boluses.some((dose) => inWindow(dose.at));
  const carbs = what !== 'bolus' && mealCarbs(at).some((entry) => inWindow(entry.at));
  return bolus || carbs;
}

/** The loop's forecast at a time, interpolated; null outside the curve. */
function curveValueAt(points: readonly GlucosePoint[] | undefined, ms: number): number | null {
  if (!points || points.length === 0) return null;
  for (let index = 0; index < points.length; index += 1) {
    const pointMs = Date.parse(points[index].at);
    if (pointMs === ms) return points[index].value;
    if (pointMs > ms) {
      if (index === 0) return null;
      const previousMs = Date.parse(points[index - 1].at);
      return points[index - 1].value + ((points[index].value - points[index - 1].value) * (ms - previousMs)) / (pointMs - previousMs);
    }
  }
  return null;
}

/**
 * A number from the loop's forecast may stand only now, on a fresh status, and where Teraz's chart line shows the same
 * within 10 mg/dL (owner, 2026-11-08): beyond the line, or off it, the sentence goes without the number.
 */
function forecastPoint(at: Moment, ms: number): number | null {
  if (!at.isNow || !snapshotFresh(at)) return null;
  const line = at.input.chart_line;
  const loop = curveValueAt(at.input.loop_curve, ms);
  const chart = curveValueAt(line, ms);
  if (loop === null || chart === null || Math.abs(loop - chart) > POLICY.forecast_chart_agreement_mgdl) return null;
  // The cloud around the line (rule 6, diabetologist's veto): its lower edge at or above 70 and at most 60 wide there.
  const low = curveValueAt(line?.map((point) => ({ at: point.at, value: point.low ?? point.value })), ms);
  const high = curveValueAt(line?.map((point) => ({ at: point.at, value: point.high ?? point.value })), ms);
  if (low === null || high === null || low < POLICY.low_mgdl || high - low > POLICY.forecast_cloud_max_width_mgdl) return null;
  return loop;
}

/** Teraz's chart shows a low ahead: the forecast line or its cloud's lower edge goes below 70. Only now, where a line is drawn. */
function chartShowsLow(at: Moment): boolean {
  if (!at.isNow) return false;
  return (at.input.chart_line ?? []).some((point) => Date.parse(point.at) > at.ms && (point.low ?? point.value) < POLICY.low_mgdl);
}

function futureCurve(at: Moment): GlucosePoint[] {
  return (at.input.loop_curve ?? []).filter((point) => Date.parse(point.at) > at.ms);
}

/** The lowest point of the whole forecast, rounded down to 10, when it can be told. */
function forecastLowest(at: Moment): number | null {
  const future = futureCurve(at);
  if (future.length === 0) return null;
  const lowest = future.reduce((min, point) => (point.value < min.value ? point : min));
  const value = forecastPoint(at, Date.parse(lowest.at));
  return value === null ? null : Math.floor(lowest.value / 10) * 10;
}







/** Back in 70–180 after an hour or more above it: how long it was above; null otherwise. */
function backInRangeMinutes(at: Moment): number | null {
  const run = inRangeRun(at);
  const isf = at.input.isf_mgdl_per_u;
  if (run.length === 0 || isf === null || !at.latest || at.falling) return null;
  const firstMs = Date.parse(run[0].at);
  if (at.ms - firstMs > POLICY.back_in_range_max_minutes * MINUTE_MS) return null;
  if (at.latest.value - (at.snapshot?.iob_u ?? 0) * isf < POLICY.bolus_no_carbs_after_insulin_mgdl) return null;
  let aboveFromMs: number | null = null;
  for (let index = at.readings.length - 1; index >= 0; index -= 1) {
    const readingMs = Date.parse(at.readings[index].at);
    if (readingMs >= firstMs) continue;
    if (at.readings[index].value <= POLICY.high_mgdl) break;
    aboveFromMs = readingMs;
  }
  if (aboveFromMs === null) return null;
  const minutes = (firstMs - aboveFromMs) / MINUTE_MS;
  return minutes >= POLICY.back_in_range_high_minutes ? minutes : null;
}

/** Linia dnia may stand only with nothing at all going on (review section D). The equipment rows are checked on the phone. */
export function dayLinesAllowed(input: NowSituationInput, situation: NowSituation): boolean {
  // v3, row 25: only in range with nothing at all said, and nothing going on (owner, 2026-11-08).
  if (situation.state !== '1d' || situation.sentence !== '') return false;
  const readings = cleanReadings(input.readings, input.now);
  const times = readings.map((reading) => Date.parse(reading.at));
  const minuteOf = makeLocalMinuteOfDay(input.time_zone) as (ms: number) => number;
  const nowMs = input.now.getTime();
  const at = new Moment(input, readings, times, nowMs, true, minuteOf);
  const value = at.latest?.value;
  const minute = minuteOf(nowMs);
  if (value === undefined || value < 80 || value > POLICY.high_mgdl || at.falling) return false;
  if (value < 100 && (at.delta ?? 0) < -2) return false;
  if (minute < POLICY.day_line_from_minute || minute >= POLICY.day_line_to_minute) return false;
  const lowest = input.evaluation?.predicted_min_mgdl ?? null;
  if (lowest === null || lowest < POLICY.nothing_to_do_min_forecast_mgdl || input.evaluation?.status === 'TRIGGER' || input.alert) return false;
  if (situation.state === '1d' && (input.isf_mgdl_per_u === null || value - (at.snapshot?.iob_u ?? 0) * input.isf_mgdl_per_u < POLICY.bolus_no_carbs_after_insulin_mgdl)) return false;
  if (input.bolus_problem || input.pump_suspended_since) return false;
  if ((at.ageMinutes ?? Number.POSITIVE_INFINITY) > POLICY.fresh_data_minutes || !at.loopInContact) return false;
  const sensorMs = input.sensor_changed_at ? Date.parse(input.sensor_changed_at) : Number.NaN;
  if (Number.isFinite(sensorMs) && nowMs - sensorMs < POLICY.doubtful_new_sensor_hours * 60 * MINUTE_MS) return false;
  if (input.override || situation.detail) return false;
  const minutesAgo = (reading: GlucosePoint) => (nowMs - Date.parse(reading.at)) / MINUTE_MS;
  const recent = readings.filter((reading) => nowMs - Date.parse(reading.at) <= POLICY.day_line_stable_minutes * MINUTE_MS);
  if (recent.some((reading) => reading.value < 80 || reading.value > POLICY.high_mgdl)) return false;
  const lastThree = fiveMinuteChanges(readings.slice(-4), 3);
  if (lastThree.some((change) => Math.abs(change) > POLICY.calm_max_delta)) return false;
  if (doseWithin(at, POLICY.calm_no_dose_minutes / 60, 'any')) return false;
  if (readings.some((reading) => minutesAgo(reading) <= POLICY.calm_no_low_minutes && reading.value < POLICY.low_mgdl)) return false;
  if (input.forecast_peak_mgdl !== null && input.forecast_peak_mgdl > POLICY.high_mgdl) return false;
  if (readings.some((reading) => minutesAgo(reading) <= POLICY.day_line_no_low_minutes && reading.value < POLICY.low_mgdl)) return false;
  if (readings.some((reading) => minutesAgo(reading) <= POLICY.day_line_no_urgent_hours * 60 && reading.value < POLICY.urgent_mgdl)) return false;
  const veryHigh = readings.filter((reading) => minutesAgo(reading) <= POLICY.day_line_no_very_high_hours * 60 && reading.value > POLICY.very_high_mgdl).length;
  if (veryHigh * 5 >= POLICY.day_line_very_high_minutes) return false;
  if (input.carbs.some((entry) => nowMs - Date.parse(entry.at) <= POLICY.day_line_no_rescue_minutes * MINUTE_MS && Date.parse(entry.at) <= nowMs && isRescueEntry(at, entry))) return false;
  // The last half hour was quiet too.
  for (let index = lowerBound(times, nowMs - POLICY.day_line_stable_minutes * MINUTE_MS); index < times.length; index += 1) {
    const state = classify(new Moment(input, readings, times, times[index], false, minuteOf), { noPraise: true });
    if (state !== '1d') return false;
  }
  return true;
}

const FALLING_ARROWS: ReadonlySet<string> = new Set(['FortyFiveDown', 'SingleDown', 'DoubleDown', 'TripleDown']);

/** False while the arrow is unknown: then the words stay. */
function arrowNotFalling(input: NowSituationInput): boolean {
  return Boolean(input.trend_direction) && !FALLING_ARROWS.has(input.trend_direction!);
}

/**
 * The sensor's arrow is smoothed and late, so a real fall is still told against it (diabetologist, 2026-11-07): very fast,
 * lasting over three readings, or with enough insulin acting to go below 70.
 */
function fallStaysTold(at: Moment): boolean {
  if ((at.delta ?? 0) <= -POLICY.fast_fall_high_mgdl_per_5min) return true;
  const [last, before] = fiveMinuteChanges(at.readings.slice(-3), 2);
  if (last !== undefined && before !== undefined && last <= -POLICY.fast_fall_mgdl_per_5min && before <= -POLICY.fast_fall_mgdl_per_5min) return true;
  // Enough insulin still acting to take glucose below 70 without carbs. Any insulin at all would keep nearly every fall.
  const isf = at.input.isf_mgdl_per_u;
  return isf !== null && at.loopInContact && (at.latest?.value ?? 0) - (at.snapshot?.iob_u ?? 0) * isf < POLICY.low_mgdl;
}

function fallingFast(at: Moment): boolean {
  return at.falling && (at.delta ?? 0) <= -POLICY.fast_fall_mgdl_per_5min;
}

function waitingState(at: Moment, entry: NowCarbEntry): NowSituationState {
  if (entry.source === 'LOOP') return '8c';
  const viewer = at.input.viewer_user_id ?? null;
  return entry.by_user_id && viewer && entry.by_user_id !== viewer ? '8b' : '8';
}

function lowState(at: Moment, phase: CheckPhase | null): NowSituationState {
  const value = at.latest!.value;
  const held = risingHeld(at.readings);
  if (value >= POLICY.low_mgdl) return '6b';
  // A rise softens or holds back the dose only from 60 up and with the loop in touch (texts review, diabetologist): below
  // 60 state 6 gives the full dose, a silent loop gets 6e.
  const waits = held && !risingLowWaitOver(at) && value >= POLICY.rising_low_wait_min_mgdl && !at.loopSilent;
  // 6c also needs a forecast that does not lean on carbs entered a moment ago.
  if (waits && forecastClearsLow(at)) return '6c';
  if (at.isNow && at.input.dose?.carbs_g == null) return '6g';
  if (phase?.kind === 'RISING') return '6f';
  if (phase?.kind === 'STILL_LOW' || phase?.kind === 'OVER') {
    const minutes = (at.ms - phase.resultMs) / MINUTE_MS;
    if (minutes <= POLICY.still_low_label_max_minutes && !(phase.kind === 'OVER' && phase.backAbove)) return '6f';
  }
  if (waits) return '6b';
  if (at.loopSilent) return '6e';
  if (doubtfulReading(at)) return '6d';
  return '6';
}

function doubtfulReading(at: Moment): boolean {
  if ((at.delta ?? 0) <= -POLICY.doubtful_fall_mgdl_per_5min) return true;
  const sensor = at.input.sensor_changed_at ? Date.parse(at.input.sensor_changed_at) : Number.NaN;
  return Number.isFinite(sensor) && at.ms - sensor >= 0 && at.ms - sensor < POLICY.doubtful_new_sensor_hours * 60 * MINUTE_MS;
}

/** Below 70 since a low point this long ago: a slow rise no longer stands in for carbs (rule in POLICY). */
function risingLowWaitOver(at: Moment): boolean {
  let lowestValue = Number.POSITIVE_INFINITY;
  let lowestMs = at.ms;
  for (let index = at.readings.length - 1; index >= 0 && at.readings[index].value < POLICY.low_mgdl; index -= 1) {
    if (at.readings[index].value <= lowestValue) {
      lowestValue = at.readings[index].value;
      lowestMs = Date.parse(at.readings[index].at);
    }
  }
  return at.ms - lowestMs >= POLICY.rising_low_wait_max_minutes * MINUTE_MS;
}

/** State 6c: the loop's own forecast stays at or above the reading and is at 80 or more by the end of its 30 minutes. */
function forecastClearsLow(at: Moment): boolean {
  if (!at.isNow) return false;
  const evaluation = at.input.evaluation;
  const curve = evaluation?.curve;
  if (!curve || curve.name === 'CGM' || curve.points.length === 0 || evaluation?.predicted_min_mgdl == null) return false;
  // The loop counts carbs as soon as they are entered, long before they act: such a forecast says nothing yet.
  const freshCarbs = at.input.carbs.some((entry) => {
    const minutes = (at.ms - Date.parse(entry.at)) / MINUTE_MS;
    return entry.grams > 0 && minutes >= 0 && minutes < POLICY.rising_low_fresh_carbs_minutes;
  });
  if (curve.includes_cob && freshCarbs) return false;
  return evaluation.predicted_min_mgdl >= at.latest!.value && curve.points.at(-1)!.value >= POLICY.rescue_entry_glucose_below_mgdl;
}

/** Glucose below `below` with no two readings in a row at or above `exit` since. The check's result ends it earlier. */
function inEpisode(at: Moment, below: number, exit: number, cutMs: number | null): boolean {
  const oldest = at.ms - POLICY.episode_lookback_minutes * MINUTE_MS;
  let above = 0;
  for (let index = at.readings.length - 1; index >= 0; index -= 1) {
    const reading = at.readings[index];
    const readingMs = Date.parse(reading.at);
    if (readingMs < oldest || (cutMs !== null && readingMs <= cutMs)) return false;
    if (reading.value < below) return true;
    if (reading.value >= exit) {
      above += 1;
      if (above >= 2) return false;
    } else {
      above = 0;
    }
  }
  return false;
}

function fiveMinuteChanges(readings: GlucosePoint[], count: number): number[] {
  const changes: number[] = [];
  for (let index = readings.length - 1; index > 0 && changes.length < count; index -= 1) {
    const minutes = (Date.parse(readings[index].at) - Date.parse(readings[index - 1].at)) / MINUTE_MS;
    if (minutes <= 0 || minutes > 8) break;
    changes.push(((readings[index].value - readings[index - 1].value) * 5) / minutes);
  }
  return changes;
}

/** Two rises in a row; one reading without a rise keeps it, and a real drop ends it at once. */
export function risingHeld(readings: GlucosePoint[]): boolean {
  const [last, before, earlier] = fiveMinuteChanges(readings.slice(-4), 3);
  const up = POLICY.two_rises_mgdl_per_5min;
  if (last === undefined || before === undefined) return false;
  if (last <= -POLICY.rise_broken_drop_mgdl) return false;
  if (last >= up && before >= up) return true;
  return before >= up && earlier !== undefined && earlier >= up;
}

function twoRises(readings: GlucosePoint[]): boolean {
  const [last, before] = fiveMinuteChanges(readings.slice(-3), 2);
  return last !== undefined && before !== undefined && last >= POLICY.two_rises_mgdl_per_5min && before >= POLICY.two_rises_mgdl_per_5min;
}

function forecastActive(at: Moment): boolean {
  const { alert, evaluation } = at.input;
  if (!alert) return false;
  if (at.isNow && evaluation?.status === 'TRIGGER') return true;
  const flagged = alert.last_triggered_at ? Date.parse(alert.last_triggered_at) : Number.NaN;
  if (!Number.isFinite(flagged)) return false;
  return at.readings.filter((reading) => Date.parse(reading.at) > flagged).length < POLICY.forecast_exit_readings;
}

/**
 * The condition that starts the grams of state 5: glucose up to 100 and a low within 30 minutes. A low-risk model alarm
 * stands for the low (it looks 15-45 min ahead), so the push's dose and Teraz agree.
 */
export function forecastGramsConditionHolds(glucose: number | null | undefined, minutesToLow: number | null | undefined, byModel = false): boolean {
  return glucose != null && glucose <= POLICY.forecast_grams_max_glucose_mgdl
    && (byModel || (minutesToLow != null && minutesToLow <= POLICY.forecast_grams_max_minutes));
}

/**
 * The grams of state 5, or null: the push's own grams while its alert runs (owner, 2026-11-08: the push said "3 g" and
 * Teraz said nothing). Without them, today's dose under the old start condition (up to 100, kept to 110).
 */
function forecastGrams(at: Moment): number | null {
  const { evaluation, dose, alert } = at.input;
  if (!at.latest || !alert) return null;
  if (alert.grams != null && alert.grams > 0) return alert.grams;
  const holds = forecastGramsConditionHolds(at.latest.value, evaluation?.minutes_to_low, at.isNow && evaluation?.confirmation === 'LOW_RISK_MODEL');
  const kept = Boolean(alert.grams_since) && at.latest.value <= POLICY.forecast_grams_keep_max_glucose_mgdl;
  return holds || kept ? dose?.carbs_g ?? null : null;
}

function sustainedHigh(at: Moment): boolean {
  const recent = at.readings.filter((reading) => at.ms - Date.parse(reading.at) <= 125 * MINUTE_MS);
  return detectHighDespiteInsulin({ now: new Date(at.ms), readings: recent, boluses: null, carbs: null })?.kind === 'SUSTAINED_HIGH';
}

function afterMeal(at: Moment, carbsAbsorbed = false): boolean {
  const value = at.latest!.value;
  const cob = at.snapshot?.cob_g ?? null;
  if (cob === null || (cob <= 0 && !carbsAbsorbed) || !at.loopInContact || value >= POLICY.very_high_mgdl) return false;
  // "Nothing to do for now" does not stand next to a fast fall.
  if (fallingFast(at)) return false;
  // IOB and COB of a status older than the meal say nothing about it (v3, rule 5); the first half hour is 2d's.
  if (!snapshotFresh(at) || freshDose(at) !== null) return false;
  const newest = newestBolus(at);
  const peak = at.isNow ? at.input.forecast_peak_mgdl : null;
  if (peak !== null && peak >= POLICY.very_high_mgdl && newest && at.ms - Date.parse(newest.at) > POLICY.meal_peak_guard_after_minutes * MINUTE_MS) return false;
  const withinMinutes = value > POLICY.high_mgdl ? POLICY.meal_bolus_within_high_minutes : POLICY.meal_bolus_within_minutes;
  if ((at.snapshot?.iob_u ?? 0) <= 0) return false;
  const bolus = at.input.boluses.some((dose) => {
    const age = (at.ms - Date.parse(dose.at)) / MINUTE_MS;
    return age >= 0 && age <= withinMinutes;
  });
  if (!bolus) return false;
  const newestCarbs = newestAt(at.input.carbs.filter((entry) => entry.grams > 0), at.ms);
  if (!newestCarbs) return false;
  const carbsMs = Date.parse(newestCarbs.at);
  return at.input.boluses.some((dose) => Math.abs(Date.parse(dose.at) - carbsMs) <= POLICY.meal_carbs_bolus_match_minutes * MINUTE_MS);
}

/** The run of readings in 70–180 up to the moment, without a gap longer than 15 minutes. */
function inRangeRun(at: Moment): GlucosePoint[] {
  const run: GlucosePoint[] = [];
  for (let index = at.readings.length - 1; index >= 0; index -= 1) {
    const reading = at.readings[index];
    if (reading.value < POLICY.low_mgdl || reading.value > POLICY.high_mgdl) break;
    if (run.length > 0 && Date.parse(run[0].at) - Date.parse(reading.at) > POLICY.stale_minutes * MINUTE_MS) break;
    run.unshift(reading);
  }
  return run;
}

function zeroBasalMinutes(at: Moment): number {
  const snapshots = at.input.loop.snapshots;
  let since: number | null = null;
  for (let index = snapshots.length - 1; index >= 0; index -= 1) {
    const atMs = Date.parse(snapshots[index].at);
    if (atMs > at.ms) continue;
    if (snapshots[index].rate_u_per_h !== 0) break;
    since = atMs;
  }
  return since === null ? 0 : (at.ms - since) / MINUTE_MS;
}

function praiseHolds(at: Moment): boolean {
  const { latest, ageMinutes, snapshot, slope } = at;
  const { evaluation, alert, isf_mgdl_per_u: isf } = at.input;
  if (!latest || ageMinutes === null || ageMinutes >= POLICY.praise_stale_minutes) return false;
  if (latest.value < POLICY.praise_min_glucose_mgdl || at.falling) return false;
  if (slope === null || Math.abs(slope) >= POLICY.praise_max_slope_mgdl_per_min) return false;
  if (!at.loopInContact || !snapshot || snapshot.cob_g === null || snapshot.iob_u === null) return false;
  if (snapshot.cob_g > 0 || isf === null) return false;
  if (latest.value - snapshot.iob_u * isf < POLICY.praise_min_after_insulin_mgdl) return false;
  if (zeroBasalMinutes(at) > POLICY.praise_max_zero_basal_minutes) return false;
  if (alert) return false;
  if (at.isNow && evaluation?.status === 'TRIGGER') return false;
  const run = inRangeRun(at);
  const windowMs = POLICY.praise_hours * 60 * MINUTE_MS;
  if (run.length === 0 || at.ms - Date.parse(run[0].at) < windowMs) return false;
  // A run further apart than 50 was "Dobrze to wygląda." until the texts review: now the plain in-range state (1d).
  const values = run.map((reading) => reading.value);
  if (Math.max(...values) - Math.min(...values) > POLICY.praise_even_span_mgdl) return false;
  const inWindow = run.filter((reading) => at.ms - Date.parse(reading.at) <= windowMs).length;
  return inWindow >= (POLICY.praise_hours * 12) * POLICY.praise_min_coverage;
}

function praiseKind(at: Moment): NowSituationState {
  const minute = at.minuteOf(at.ms);
  if (minute >= POLICY.morning_from_minute && minute < POLICY.morning_to_minute && nightWasGood(at, minute)) return '1b';
  if (minute >= POLICY.evening_from_minute && minute < POLICY.evening_to_minute && dayWasGood(at, minute) !== null) return '1c';
  return '1';
}

function nightRange(at: Moment, minute: number): { fromMs: number; toMs: number } {
  const toMs = at.ms - (minute - POLICY.night_to_minute) * MINUTE_MS;
  const nightMinutes = 24 * 60 - POLICY.night_from_minute + POLICY.night_to_minute;
  return { fromMs: toMs - nightMinutes * MINUTE_MS, toMs };
}

function nightWasGood(at: Moment, minute: number): boolean {
  const { fromMs, toMs } = nightRange(at, minute);
  const night = at.readings.filter((reading) => {
    const readingMs = Date.parse(reading.at);
    return readingMs >= fromMs && readingMs <= toMs;
  });
  if (night.length === 0) return false;
  const gapMs = POLICY.praise_night_max_gap_minutes * MINUTE_MS;
  if (Date.parse(night[0].at) - fromMs > gapMs || toMs - Date.parse(night.at(-1)!.at) > gapMs) return false;
  for (let index = 0; index < night.length; index += 1) {
    if (night[index].value < POLICY.low_mgdl || night[index].value > POLICY.high_mgdl) return false;
    if (index > 0 && Date.parse(night[index].at) - Date.parse(night[index - 1].at) > gapMs) return false;
  }
  return !at.input.carbs.some((entry) => {
    const entryMs = Date.parse(entry.at);
    return entryMs >= fromMs && entryMs <= toMs && isRescueEntry(at, entry);
  });
}

/** Today's time in range in percent when today qualifies for the evening sentence; null when it does not. */
function dayWasGood(at: Moment, minute: number): number | null {
  const fromMs = at.ms - minute * MINUTE_MS;
  const today = at.readings.filter((reading) => Date.parse(reading.at) >= fromMs);
  if (today.length < (minute / 5) * POLICY.praise_day_min_coverage) return null;
  const inRange = today.filter((reading) => reading.value >= POLICY.low_mgdl && reading.value <= POLICY.high_mgdl).length;
  const below = today.filter((reading) => reading.value < POLICY.low_mgdl).length;
  const tir = (inRange / today.length) * 100;
  if (tir < POLICY.praise_day_min_tir_percent) return null;
  if ((below / today.length) * 100 >= POLICY.praise_day_max_below_percent) return null;
  if (today.some((reading) => reading.value < POLICY.urgent_mgdl)) return null;
  return Math.round(tir);
}

function glucoseAt(at: Moment, ms: number): number | null {
  let found: GlucosePoint | null = null;
  for (let index = at.readings.length - 1; index >= 0; index -= 1) {
    if (Date.parse(at.readings[index].at) <= ms) {
      found = at.readings[index];
      break;
    }
  }
  if (!found || ms - Date.parse(found.at) > POLICY.stale_minutes * MINUTE_MS) return null;
  return found.value;
}

function isRescueEntry(at: Moment, entry: NowCarbEntry): boolean {
  if (entry.kind === 'HYPO_TREATMENT') return true;
  if (entry.kind !== null || entry.grams <= 0 || entry.grams > POLICY.rescue_entry_max_g) return false;
  const entryMs = Date.parse(entry.at);
  const bolusNear = at.input.boluses.some((dose) => Math.abs(Date.parse(dose.at) - entryMs) <= POLICY.rescue_entry_no_bolus_minutes * MINUTE_MS);
  if (bolusNear) return false;
  const glucose = glucoseAt(at, entryMs);
  if (glucose !== null && glucose < POLICY.rescue_entry_glucose_below_mgdl) return true;
  return (at.input.recent_alerts_notified_at ?? []).some((notified) => {
    const minutes = (entryMs - Date.parse(notified)) / MINUTE_MS;
    return minutes >= 0 && minutes <= POLICY.rescue_entry_after_alert_minutes;
  });
}

function newestRescueEntry(at: Moment): NowCarbEntry | null {
  const horizon = POLICY.check_minutes + POLICY.recheck_minutes + POLICY.still_low_label_max_minutes + POLICY.result_hold_minutes;
  let newest: NowCarbEntry | null = null;
  for (const entry of at.input.carbs) {
    const entryMs = Date.parse(entry.at);
    if (entryMs > at.ms || at.ms - entryMs > horizon * MINUTE_MS) continue;
    if ((newest === null || entryMs > Date.parse(newest.at)) && isRescueEntry(at, entry)) newest = entry;
  }
  return newest;
}

/** Where the check after carbs stands. The result is read from the first reading at or after the moment it is due. */
function checkPhase(at: Moment, entry: NowCarbEntry): CheckPhase {
  const entryMs = Date.parse(entry.at);
  const glucose = glucoseAt(at, entryMs);
  // From 70 up there is nothing to decide at 15 minutes (owner, 2026-11-08): Mellis watches for a reading below 70, and
  // only that reading starts the usual check, counted from it.
  if (glucose !== null && glucose >= POLICY.low_mgdl) {
    const untilMs = entryMs + POLICY.forecast_watch_minutes * MINUTE_MS;
    const firstLow = at.readings.find((reading) => Date.parse(reading.at) > entryMs && Date.parse(reading.at) <= Math.min(at.ms, untilMs) && reading.value < POLICY.low_mgdl);
    if (!firstLow) {
      if (at.ms < untilMs) return { kind: 'WATCHING', untilMs };
      return { kind: 'BACK', resultMs: untilMs, value: glucoseAt(at, untilMs) ?? at.latest?.value ?? glucose, hadLow: false, minutes: POLICY.forecast_watch_minutes };
    }
    return checkFrom(at, Date.parse(firstLow.at), firstLow.value, entryMs);
  }
  return checkFrom(at, entryMs, glucose, entryMs);
}

/** The usual check after carbs for a low: its result from the first reading from `startMs` + 15 min (10 below 54). */
function checkFrom(at: Moment, startMs: number, glucose: number | null, entryMs: number): CheckPhase {
  const checkMinutes = glucose !== null && glucose < POLICY.urgent_mgdl ? POLICY.check_after_urgent_minutes : POLICY.check_minutes;
  const dueMs = startMs + checkMinutes * MINUTE_MS;
  const result = firstReadingFrom(at, dueMs);
  if (!result) return { kind: 'WAITING', dueMs, second: false };

  const until = at.readings.filter((reading) => Date.parse(reading.at) <= result.ms);
  const trend = new TrendAt(until);
  if (result.value >= POLICY.low_mgdl && !trend.falling) {
    const hadLow = until.some((reading) => Date.parse(reading.at) >= entryMs && reading.value < POLICY.low_mgdl)
      || (glucose !== null && glucose < POLICY.low_mgdl);
    return { kind: 'BACK', resultMs: result.ms, value: result.value, hadLow, minutes: checkMinutes };
  }
  const isRising = result.value < POLICY.low_mgdl && twoRises(until);
  if (result.value < POLICY.low_mgdl && !isRising) return { kind: 'STILL_LOW', resultMs: result.ms };

  // Falling from at or above 70, or rising below it: one more look after 10 minutes.
  const recheckDueMs = result.ms + POLICY.recheck_minutes * MINUTE_MS;
  const recheck = firstReadingFrom(at, recheckDueMs);
  if (!recheck) {
    return isRising
      ? { kind: 'RISING', dueMs: recheckDueMs, resultMs: result.ms, value: result.value }
      : { kind: 'FALLING', dueMs: recheckDueMs, resultMs: result.ms, value: result.value };
  }
  if (recheck.value < POLICY.low_mgdl) return { kind: 'STILL_LOW', resultMs: recheck.ms };
  return { kind: 'OVER', resultMs: recheck.ms, backAbove: true };
}

class TrendAt {
  readonly falling: boolean;
  constructor(readings: GlucosePoint[]) {
    const recent = readings.slice(-8);
    const delta = deltaPerFiveMinutes(recent) ?? 0;
    const slope = shortAverageSlope(recent) ?? 0;
    this.falling = delta <= -POLICY.trend_delta_mgdl_per_5min && slope <= -POLICY.trend_slope_mgdl_per_min;
  }
}

function firstReadingFrom(at: Moment, fromMs: number): { ms: number; value: number } | null {
  // A reading up to two minutes early is the reading the check would read: CGM readings come every 5 minutes.
  const startMs = fromMs - 2 * MINUTE_MS;
  for (const reading of at.readings.slice(-40)) {
    const readingMs = Date.parse(reading.at);
    if (readingMs >= startMs) return { ms: readingMs, value: reading.value };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------------
// Texts
// ---------------------------------------------------------------------------------------------------------------------

const FAST_CARBS = 'szybkich węgli';

const INSTRUMENTAL: Record<LoopSystemKind, string> = { TRIO: 'Trio', LOOP: 'Loopem', AAPS: 'AAPS', OPENAPS: 'OpenAPS', UNKNOWN: 'pętlą' };

/** After "od": "od minuty", "od 2 minut". */
function sinceMinutes(minutes: number): string {
  const whole = Math.max(1, Math.round(minutes));
  return whole === 1 ? 'minuty' : `${whole} minut`;
}

/** Before "po": "minutę po", "22 minuty po", "25 minut po". */
export function minutesAccusative(minutes: number): string {
  const whole = Math.max(1, Math.round(minutes));
  if (whole === 1) return 'Minutę';
  const tens = whole % 100;
  const ones = whole % 10;
  return ones >= 2 && ones <= 4 && (tens < 12 || tens > 14) ? `${whole} minuty` : `${whole} minut`;
}

/** Before "po": "1,5 godziny", "2 godziny", "5 godzin", in half hours (state 2b starts at 90 min; under an hour in minutes). */
export function hoursAccusative(minutes: number): string {
  if (minutes < 60) return minutesAccusative(minutes).toLowerCase();
  const halves = Math.floor(minutes / 30);
  const hours = Math.floor(halves / 2);
  if (halves % 2 === 1) return `${hours},5 godziny`;
  if (hours === 1) return 'godzinę';
  const tens = hours % 100;
  const ones = hours % 10;
  return ones >= 2 && ones <= 4 && (tens < 12 || tens > 14) ? `${hours} godziny` : `${hours} godzin`;
}

/** Before "po korekcie", to the half hour from 1 h: "godzinę", "półtorej godziny", "2 godziny", "2,5 godziny", "3 godziny". */
export function correctionAfter(minutes: number): string {
  const halves = Math.max(2, Math.floor(minutes / 30));
  if (halves === 3) return 'półtorej godziny';
  return hoursAccusative(halves * 30);
}

/** After "od": "od godziny", "od 2 godzin". */
function sinceHours(hours: number): string {
  return hours === 1 ? 'godziny' : `${hours} godzin`;
}

/** After "od", to the half hour: "od 2 godzin", "od 2,5 godziny". */
function sinceHalfHours(minutes: number): string {
  const halves = Math.max(2, Math.floor(minutes / 30));
  return halves % 2 === 0 ? sinceHours(halves / 2) : `${Math.floor(halves / 2)},5 godziny`;
}

/** After "po": "po 40 minutach", "po godzinie", "po 1,5 godziny", "po 2 godzinach", "po 2,5 godziny". */
export function afterDuration(minutes: number): string {
  if (minutes < 60) return `${Math.max(1, Math.round(minutes))} minutach`;
  const halves = Math.floor(minutes / 30);
  if (halves === 2) return 'godzinie';
  return halves % 2 === 0 ? `${halves / 2} godzinach` : `${Math.floor(halves / 2)},5 godziny`;
}

function loopNameCapitalized(at: Moment): string {
  return capitalized(loopSystemNames(at.input.loop.system).nominative);
}

function sinceDuration(minutes: number): string {
  return minutes >= 60 ? sinceHours(Math.floor(minutes / 60)) : sinceMinutes(minutes);
}

function clock(ms: number, minuteOf: (ms: number) => number): string {
  const minute = minuteOf(ms);
  return `${Math.floor(minute / 60)}:${String(minute % 60).padStart(2, '0')}`;
}

function glucagonSentence(input: NowSituationInput): string {
  return `Gdy ${input.patient_label || 'pacjent'} nie reaguje, ma drgawki albo nie może przełykać, nie podawaj niczego doustnie. Podaj glukagon i zadzwoń pod 112.`;
}

function loopAddingInsulin(at: Moment): boolean {
  if (!at.loopInContact) return false;
  const { smbs, loop } = at.input;
  const windowMs = POLICY.loop_activity_window_minutes * MINUTE_MS;
  const inWindow = (iso: string) => {
    const atMs = Date.parse(iso);
    return atMs <= at.ms && at.ms - atMs <= windowMs;
  };
  if (smbs.some((dose) => dose.units > 0 && inWindow(dose.at))) return true;
  const plan = loop.plan_rate_u_per_h;
  if (plan === null) return false;
  // The running basal, as the pill shows it: Trio sends a rate only on the cycles that set a new one (screenshot 1, v3).
  const rate = rateAt(at);
  if (rate !== null && rate.rate > plan) return true;
  return loop.snapshots.some((snapshot) => inWindow(snapshot.at) && (snapshot.rate_u_per_h ?? 0) > plan);
}

/** The promise only while a check can keep it: the worker runs and readings arrive. */
function checkPromise(at: Moment, watching = false): string | null {
  if (!at.input.check_push_live || (at.ageMinutes ?? Number.POSITIVE_INFINITY) > POLICY.fresh_data_minutes) return null;
  if (watching) return 'Mellis da znać, jeśli glukoza spadnie poniżej 70.';
  // Below 70 "Kolejne sprawdzenie za 15 min" already says it (texts review, 2026-11-09). From 70 up the push below 70 comes
  // at once, not at the check (owner, 2026-11-08).
  return (at.latest?.value ?? 0) < POLICY.low_mgdl ? null : 'Jeśli glukoza spadnie poniżej 70 wcześniej, Mellis da znać od razu.';
}

/**
 * How a sentence names another caregiver (owner, 2026-11-08): "Ewa podała" once the caregiver chose the form, else the
 * accepted "Opiekun Ewa podał", and "Drugi opiekun podał" without a name.
 */
export function caregiverWords(name: string | null, gender: CaregiverGender | null): { who: string; gave: string } {
  if (!name) return { who: 'Drugi opiekun', gave: 'podał' };
  if (gender === 'f') return { who: name, gave: 'podała' };
  if (gender === 'm') return { who: name, gave: 'podał' };
  return { who: `Opiekun ${name}`, gave: 'podał' };
}

/** "przed chwilą", "minutę temu", "5 minut temu" (polonist, 2026-11-08: whole minutes, the full word). */
export function minutesAgoWords(minutes: number): string {
  const whole = Math.max(0, Math.floor(minutes));
  if (whole === 0) return 'przed chwilą';
  if (whole === 1) return 'minutę temu';
  const tens = whole % 100;
  const ones = whole % 10;
  return `${whole} ${ones >= 2 && ones <= 4 && (tens < 12 || tens > 14) ? 'minuty' : 'minut'} temu`;
}

const unitsWords = (units: number) => `${String(Math.round(units * 100) / 100).replace('.', ',')} j`;
const COUNT_WORDS: Record<number, string> = { 2: 'dwa', 3: 'trzy', 4: 'cztery' };

type GivenBolus = { ms: number; units: number; carbs_g: number; author: NowRemoteBolus | null };

/** Manual boluses of the window with their senders when Mellis sent them; the loop's record wins over the command. */
function windowBoluses(at: Moment): GivenBolus[] {
  const fromMs = at.ms - POLICY.caregiver_bolus_minutes * MINUTE_MS;
  const remotes = (at.input.remote_boluses ?? []).filter((remote) => Date.parse(remote.at) <= at.ms);
  const used = new Set<NowRemoteBolus>();
  const given: GivenBolus[] = [];
  for (const dose of at.input.boluses) {
    const ms = Date.parse(dose.at);
    if (ms < fromMs || ms > at.ms) continue;
    const near = remotes.filter((remote) => !used.has(remote) && Math.abs(Date.parse(remote.at) - ms) <= POLICY.caregiver_bolus_match_minutes * MINUTE_MS);
    const author = near.find((remote) => Math.abs(remote.units - dose.units) <= 0.05) ?? near.find((remote) => remote.status === 'PARTIAL') ?? null;
    if (author) used.add(author);
    given.push({ ms, units: dose.units, carbs_g: author?.carbs_g ?? 0, author });
  }
  // Confirmed by the loop but not yet in Nightscout.
  for (const remote of remotes) {
    const ms = Date.parse(remote.at);
    if (used.has(remote) || remote.status !== 'SUCCEEDED' || ms < fromMs) continue;
    given.push({ ms, units: remote.units, carbs_g: remote.carbs_g, author: remote });
  }
  return given.sort((left, right) => left.ms - right.ms);
}

/**
 * v4 (owner, 2026-11-08): for 20 min after a bolus someone else gave, who gave it and how much, so the other caregiver
 * does not give it twice. The reader's own bolus says nothing; a bolus without a sender is "poza Mellis".
 */
function caregiverBolusLine(at: Moment): string | null {
  if (!at.isNow) return null;
  const viewer = at.input.viewer_user_id ?? null;
  const others = windowBoluses(at).filter((dose) => !dose.author || dose.author.by_user_id !== viewer);
  if (others.length === 0) return null;
  const newest = others[others.length - 1];
  const ago = minutesAgoWords((at.ms - newest.ms) / MINUTE_MS);
  const key = (dose: GivenBolus) => dose.author?.by_user_id ?? 'OUTSIDE';
  const sameSender = others.every((dose) => key(dose) === key(newest));
  const words = newest.author ? caregiverWords(newest.author.by_name, newest.author.by_gender) : null;
  if (others.length > 1 && sameSender) {
    const total = unitsWords(others.reduce((sum, dose) => sum + dose.units, 0));
    const count = COUNT_WORDS[others.length] ?? String(others.length);
    // "dwa/trzy/cztery bolusy", from five on "5 bolusów" (22–24 never happen in one window).
    const noun = others.length <= 4 ? 'bolusy' : 'bolusów';
    // Owner decision 3 (texts review, 2026-11-09): without a known sender, the time of the bolus and "podano poza Mellis".
    return words
      ? `${words.who} ${words.gave} ${count} ${noun}, razem ${total}, ostatni ${ago}.`
      : `${capitalized(count)} ${noun}, razem ${total}, ostatni z ${clock(newest.ms, at.minuteOf)}, podano poza Mellis.`;
  }
  const carbs = newest.carbs_g > 0 ? ` na ${Math.round(newest.carbs_g)} g węgli` : '';
  return words
    ? `${words.who} ${words.gave} bolus ${unitsWords(newest.units)}${carbs} ${ago}.`
    : `Bolus ${unitsWords(newest.units)} z ${clock(newest.ms, at.minuteOf)} podano poza Mellis.`;
}

/** Where the caregiver's bolus takes the sentence: nothing else to say, praise, calm, or a bolus without carbs. */
const CAREGIVER_BOLUS_TAKES_SENTENCE: ReadonlySet<NowSituationState> = new Set(['1', '1b', '1c', '1d', '1f']);

function givenSentence(entry: NowCarbEntry, at: Moment): string {
  const when = clock(Date.parse(entry.at), at.minuteOf);
  const grams = Math.round(entry.grams);
  if (entry.source === 'LOOP') return `${capitalized(`w ${loopSystemNames(at.input.loop.system).locative}`)} zapisano ${grams} g węgli o ${when}.`;
  if (waitingState(at, entry) === '8b') {
    const { who, gave } = caregiverWords(entry.by_name ?? null, entry.by_gender ?? null);
    return `${who} ${gave} ${grams} g węgli o ${when}.`;
  }
  return `Podano ${grams} g węgli o ${when}.`;
}

/** "25 minut po 5 g węgli glukoza nadal jest poniżej 70." (6f and 8e). */
function stillLowAfterCarbs(entry: NowCarbEntry, at: Moment): string {
  return `${minutesAccusative((at.ms - Date.parse(entry.at)) / MINUTE_MS)} po ${Math.round(entry.grams)} g węgli glukoza nadal jest poniżej 70.`;
}

/** Who tapped and what, then the promise: both caregivers see what was given while the check runs. */
function givenAndPromise(entry: NowCarbEntry | null, at: Moment): string | null {
  return [entry ? givenSentence(entry, at) : null, checkPromise(at)].filter(Boolean).join(' ') || null;
}

function doseSecond(grams: number, kind: 'DOSE' | 'SOFT_DOSE' | 'FORECAST_DOSE', label: string): NonNullable<NowSituation['second']> {
  const note = kind === 'DOSE' ? `około ${grams * POLICY.juice_ml_per_g} ml soku` : null;
  return { kind, label, value: `${grams} g`, unit: FAST_CARBS, note };
}

function givenAction(grams: number, style: 'FILLED' | 'OUTLINE'): NonNullable<NowSituation['action']> {
  return { kind: 'GIVEN', grams, style, label: `Podano ${grams} g`, other_amount_label: 'Inna ilość' };
}

function checkSecond(at: Moment, dueMs: number): NonNullable<NowSituation['second']> {
  return { kind: 'CHECK', label: 'Kolejne sprawdzenie za', value: `${Math.max(1, Math.ceil((dueMs - at.ms) / MINUTE_MS))} min`, unit: null, note: null };
}

/** The animated opening word of praise (owner, 2026-11-09, as in the first mock-ups); SituationHero splits it off at ". ". */
export const PRAISE_WORDS = ['Pięknie.', 'Świetnie.', 'Klasa.'] as const;
/** Now and then the praise ends with this instead of opening with a word (owner, 2026-11-12); SituationHero animates it. */
export const PRAISE_CLOSING = 'Brawo 👏';

function praiseSentence(at: Moment, state: NowSituationState): string {
  const run = inRangeRun(at);
  const firstMs = run.length > 0 ? Date.parse(run[0].at) : at.ms;
  // Stable within one praise episode, another word in the next: the word depends on the hour the run started.
  const urgentRecently = at.readings.some((reading) => at.ms - Date.parse(reading.at) <= POLICY.praise_no_word_after_urgent_hours * 60 * MINUTE_MS && reading.value < POLICY.urgent_mgdl);
  // One episode in four closes with "Brawo 👏" instead of an opening word.
  const pick = Math.floor(firstMs / (60 * MINUTE_MS)) % (PRAISE_WORDS.length + 1);
  const closing = !urgentRecently && pick === PRAISE_WORDS.length;
  const word = urgentRecently || closing ? '' : `${PRAISE_WORDS[pick]} `;
  const end = closing ? ` ${PRAISE_CLOSING}` : '';
  if (state === '1b') return `${word}Przez całą noc glukoza była w zakresie.${end}`;
  // 1c lost "Spokojny dzień…" in the texts review: it says what state 1 says.
  const hours = Math.max(POLICY.praise_hours, Math.floor((at.ms - firstMs) / (60 * MINUTE_MS)));
  return `${word}Od ${sinceHours(hours)} glukoza jest w zakresie.${end}`;
}

function build(state: NowSituationState, at: Moment): NowSituation {
  const { input, latest } = at;
  const names = loopSystemNames(input.loop.system);
  const value = latest?.value ?? 0;
  const entry = newestRescueEntry(at);
  const phase = entry ? checkPhase(at, entry) : null;
  const dueMs = phase && 'dueMs' in phase ? phase.dueMs : null;
  const age = Math.round(at.ageMinutes ?? 0);
  const grams = input.dose?.carbs_g ?? null;

  let second: NowSituation['second'] = null;
  let sentence = '';
  let detail: string | null = null;
  let action: NowSituation['action'] = null;

  const loopName = loopNameCapitalized(at);

  switch (state) {
    case '1':
    case '1b':
    case '1c':
      sentence = praiseSentence(at, state);
      break;
    case '1d':
      // In range there is nothing to say but what is in force; in full calm the day line stands (v3, rows 25–26).
      detail = quietNote(at);
      break;
    case '1e':
      // v4 (owner, 2026-11-08): the line speaks only for an action, a promise or what the screen does not show.
      break;
    case '1f': {
      const bolus = newestBolus(at);
      sentence = bolus ? `W ${names.locative} nie ma węgli do bolusa z ${clock(Date.parse(bolus.at), at.minuteOf)}.` : `W ${names.locative} nie ma węgli do bolusa.`;
      detail = 'Jeśli ten bolus nie był do jedzenia, glukoza może spaść.';
      break;
    }
    case '2d':
      // v4: no forecast peak and no "insulin will act" after a fresh dose; the chart shows both.
      break;
    case 'P': {
      const since = input.pump_suspended_since ? (at.ms - Date.parse(input.pump_suspended_since)) / MINUTE_MS : 0;
      sentence = `Pompa jest wstrzymana od ${sinceDuration(since)}.`;
      if (value > POLICY.very_high_mgdl) detail = at.falling ? 'Warto zmierzyć ketony.' : 'Warto włączyć pompę i zmierzyć ketony.';
      // Diabetologist (texts review, 2026-11-09): from an hour without insulin, the risk of ketones even below 250.
      else if (since >= 60) detail = 'Bez insuliny od ponad godziny rośnie ryzyko ketonów.';
      else detail = 'Jeśli wstrzymanie nie było celowe, warto włączyć pompę.';
      break;
    }
    case '2b': {
      const bolus = newestBolus(at);
      sentence = `${capitalized(hoursAccusative(bolus ? (at.ms - Date.parse(bolus.at)) / MINUTE_MS : 0))} po bolusie glukoza nadal rośnie.`;
      detail = 'Warto sprawdzić wkłucie albo czy węgli nie było więcej.';
      break;
    }
    case '2c': {
      const carbs = unbolusedCarbs(at);
      sentence = carbs
        ? `W ${names.locative} zapisano ${Math.round(carbs.grams)} g węgli o ${clock(Date.parse(carbs.at), at.minuteOf)}, ale nie ma do nich bolusa.`
        : 'Do węgli nie ma bolusa.';
      detail = `Jeśli bolus podano penem, warto go zapisać w ${names.locative}.`;
      break;
    }
    case '3e': {
      const found = correctionNoEffect(at);
      const fall = found?.fall ?? 0;
      const after = capitalized(correctionAfter(found?.minutes ?? 60));
      sentence = fall > 0 ? `${after} po korekcie glukoza spadła tylko o ${fall}.` : `${after} po korekcie glukoza nie spadła.`;
      detail = 'Insulina może nie docierać. Warto sprawdzić wkłucie i zmierzyć ketony.';
      break;
    }
    case '2':
      // v4: "carbs and insulin still act" is what the screen already shows.
      break;
    case '3':
    case '3a':
      ({ sentence, detail } = highWords(at, state));
      break;
    case '3f': {
      const rate = basalBelowPlan(at) ?? 0;
      sentence = rate === 0
        ? `${loopName} nie podaje bazy, bo przewiduje spadek.`
        : `${loopName} podaje mniej bazy, bo przewiduje spadek.`;
      break;
    }
    case '3g':
      // v4: a fall above 180 explains itself on the chart.
      break;
    case '3b':
    case '3d': {
      const above = aboveMinutes(at, POLICY.very_high_mgdl);
      const since = sinceHalfHours(Math.max(120, above));
      if (state === '3b') {
        // Owner decision 5 (texts review, 2026-11-09): one variant from 2 hours, with the ketone threshold.
        sentence = `Od ${since} glukoza jest powyżej 250.`;
        detail = 'Warto sprawdzić wkłucie i zmierzyć ketony. Przy ketonach od 0,6 mmol/l wymień wkłucie i podaj korektę penem według planu z poradni.';
      } else {
        sentence = `Od ${since} glukoza jest powyżej 250, a ${loopName} nie przysyła danych.`;
        detail = `Warto sprawdzić wkłucie i telefon z ${INSTRUMENTAL[input.loop.system]} oraz zmierzyć ketony.`;
      }
      break;
    }
    case '3c':
      break;
    case '4':
    case '4b':
      // v4: no forecast number while it falls in range; the forecast-low states speak when it matters.
      break;
    case '5':
    case '5b': {
      // Owner, 2026-11-08: the sentence follows the drawn forecast. When neither the line nor the cloud's lower edge goes
      // below 70, the alarm (low-risk model or the loop) is told as Mellis's warning, not as "the forecast".
      // Owner decision 4 (texts review, 2026-11-09): one sentence, and a detail while the line does not show it.
      sentence = 'Glukoza może wkrótce spaść poniżej 70.';
      if (!chartShowsLow(at)) detail = 'Linia na wykresie tego jeszcze nie pokazuje.';
      const forecastDose = forecastGrams(at);
      if (state === '5' && forecastDose !== null) {
        second = doseSecond(forecastDose, 'FORECAST_DOSE', 'Możesz podać');
        action = givenAction(forecastDose, 'OUTLINE');
      }
      break;
    }
    case '6':
    case '6d':
    case '6e':
    case '6f': {
      if (grams !== null) {
        second = doseSecond(grams, 'DOSE', 'Podaj');
        action = givenAction(grams, state === '6d' ? 'OUTLINE' : 'FILLED');
      }
      if (state === '6') {
        // The number says "below 70"; the words only when insulin still pulls it down (row 19). The dose stays either way.
        const isf = input.isf_mgdl_per_u;
        const pulling = isf !== null && at.loopInContact && (at.delta ?? 0) <= POLICY.low_insulin_clause_max_delta
          && (activeInsulinUnits(at) ?? 0) * isf >= POLICY.low_insulin_clause_mgdl;
        if (pulling) sentence = 'Insulina jeszcze działa, więc spadek może potrwać.';
      } else if (state === '6d') {
        const sensorMs = input.sensor_changed_at ? Date.parse(input.sensor_changed_at) : Number.NaN;
        const fastFall = (at.delta ?? 0) <= -POLICY.doubtful_fall_mgdl_per_5min;
        sentence = fastFall || !Number.isFinite(sensorMs)
          ? 'Spadek był bardzo szybki. Warto sprawdzić odczyt glukometrem.'
          : `Sensor działa od ${sinceDuration((at.ms - sensorMs) / MINUTE_MS)}. Warto sprawdzić odczyt glukometrem.`;
        detail = 'Jeśli nie da się zmierzyć, podaj węgle.';
      } else if (state === '6e') {
        sentence = `${loopName} nie przysyła danych od ${sinceDuration(at.loopAgeMinutes ?? 0)}, więc nie wiadomo, czy baza jest wstrzymana.`;
      } else {
        // Without an entry the red number says it all (texts review, 2026-11-09).
        sentence = entry ? stillLowAfterCarbs(entry, at) : '';
      }
      break;
    }
    case '6b': {
      const lowestForecast = input.evaluation?.predicted_min_mgdl ?? null;
      const insulinLeft = (at.snapshot?.iob_u ?? Number.POSITIVE_INFINITY) * (input.isf_mgdl_per_u ?? Number.POSITIVE_INFINITY);
      const doseGone = value >= POLICY.low_mgdl && at.rising && lowestForecast !== null && lowestForecast >= POLICY.low_mgdl && insulinLeft < POLICY.soft_dose_gone_insulin_mgdl;
      if (grams !== null && !doseGone) {
        second = doseSecond(grams, 'SOFT_DOSE', 'Jeśli nie podano węgli');
        action = givenAction(grams, 'OUTLINE');
      }
      // Below 70 the dose row "Jeśli nie podano węgli" says it (texts review, 2026-11-09).
      if (value >= POLICY.low_mgdl && doseGone) {
        // Back up after carbs: whether another portion is needed, the one thing the number does not say (row 20).
        const rescue = entry ?? newestAt(at.input.carbs.filter((candidate) => isRescueEntry(at, candidate)), at.ms);
        if (rescue) {
          const lastTwo = at.readings.slice(-2);
          const isf = input.isf_mgdl_per_u;
          const lowest = forecastLowest(at);
          const settled = lastTwo.length === 2 && lastTwo.every((reading) => reading.value >= POLICY.low_mgdl)
            && isf !== null && (activeInsulinUnits(at) ?? Number.POSITIVE_INFINITY) * isf < value - 80
            && lowest !== null && lowest >= POLICY.low_mgdl;
          if (settled) sentence = 'Na razie kolejna porcja węgli nie jest potrzebna.';
        }
      }
      // Otherwise no sentence: the number and the arrow already say where glucose is (owner, 2026-11-09).
      break;
    }
    case '6c': {
      sentence = 'Glukoza jest poniżej 70, ale powoli rośnie. Jeśli przestanie rosnąć, podaj węgle.';
      const end = input.evaluation?.curve?.points.at(-1)?.value;
      // Rounded down: a number that reassures never errs upwards (v3, rule 6).
      detail = end !== undefined ? `${loopName} prognozuje, że za 30 minut glukoza wyniesie około ${Math.floor(end)}.` : null;
      action = { kind: 'LOG_CARBS', label: 'Zapisz węgle' };
      break;
    }
    case '6g':
      sentence = 'Podaj szybkie węgle.';
      detail = 'Bez przeliczników insuliny Mellis nie proponuje ilości węgli.';
      action = { kind: 'LOG_CARBS', label: 'Zapisz węgle' };
      break;
    case '7':
      if (grams !== null) {
        second = doseSecond(grams, 'DOSE', 'Podaj od razu');
        action = givenAction(grams, 'FILLED');
      }
      sentence = glucagonSentence(input);
      break;
    case '7b':
      // The first sentence stands apart on the screen, large.
      sentence = `Podaj od razu szybkie węgle. ${glucagonSentence(input)}`;
      detail = 'Bez przeliczników insuliny Mellis nie proponuje ilości węgli.';
      action = { kind: 'LOG_CARBS', label: 'Zapisz węgle' };
      break;
    case '8u': {
      const given = undoableEntry(at);
      if (given) {
        second = { kind: 'GIVEN', label: 'Podano', value: `${Math.round(given.grams)} g`, unit: FAST_CARBS, note: null };
        action = { kind: 'UNDO', label: 'Cofnij', event_id: given.id, until: new Date(Date.parse(given.at) + POLICY.undo_seconds * 1000).toISOString() };
      }
      // The app counts the seconds down; it keeps what stands before "Mellis zapisze".
      const byOther = given && waitingState(at, given) === '8b' ? caregiverWords(given.by_name ?? null, given.by_gender ?? null) : null;
      sentence = byOther
        ? `${byOther.who} ${byOther.gave} węgle. Mellis zapisze je za ${POLICY.undo_seconds} sekund.`
        : `Węgle zostaną zapisane za ${POLICY.undo_seconds} sekund.`;
      break;
    }
    case '8':
    case '8b':
    case '8c':
      if (entry && phase?.kind === 'WATCHING') {
        // Carbs from a forecast: no countdown, only the watch for a reading below 70, in one line (texts review).
        sentence = [givenSentence(entry, at), checkPromise(at, true)].filter(Boolean).join(' ');
      } else if (entry && dueMs !== null) {
        second = checkSecond(at, dueMs);
        sentence = givenSentence(entry, at);
        detail = checkPromise(at);
      }
      break;
    case '8d':
    case '8i':
      // The check is over and glucose is from 70: no sentence, the number says it (owner, 2026-11-09).
      break;
    case '8e':
      if (dueMs !== null) second = checkSecond(at, dueMs);
      // One sentence with 6f (texts review, 2026-11-09).
      sentence = entry ? stillLowAfterCarbs(entry, at) : '';
      break;
    case '8f':
      if (dueMs !== null) second = checkSecond(at, dueMs);
      // Only what the number does not say: carbs given and the next check moves up into the sentence (owner, 2026-11-09).
      detail = givenAndPromise(entry, at);
      break;
    case '8g': {
      const entryMs = entry ? Date.parse(entry.at) : at.ms;
      const check = dueMs ?? entryMs + POLICY.check_after_urgent_minutes * MINUTE_MS;
      second = checkSecond(at, check);
      sentence = glucagonSentence(input);
      detail = givenAndPromise(entry, at);
      // Still below 54 right after carbs: the check alone must not be all there is to do.
      action = { kind: 'LOG_CARBS', label: 'Zapisz węgle' };
      break;
    }
    case '8j':
      second = { kind: 'NO_READING', label: null, value: `${age} min`, unit: 'bez odczytu', note: null };
      sentence = value < POLICY.low_mgdl ? 'Zmierz glukozę glukometrem.' : 'Warto zmierzyć glukozę glukometrem.';
      detail = entry ? givenSentence(entry, at) : null;
      break;
    case '9':
      if (latest) second = { kind: 'NO_READING', label: null, value: `${age} min`, unit: 'bez odczytu', note: null };
      {
        const sensorMs = input.sensor_changed_at ? Date.parse(input.sensor_changed_at) : Number.NaN;
        const sensorAge = Number.isFinite(sensorMs) ? (at.ms - sensorMs) / MINUTE_MS : Number.POSITIVE_INFINITY;
        if (sensorAge >= 0 && sensorAge <= POLICY.new_sensor_no_readings_minutes) {
          sentence = `Sensor założono ${minutesAccusative(sensorAge).toLowerCase()} temu, więc odczytów jeszcze nie ma.`;
          detail = 'Na razie warto mierzyć glukozę glukometrem.';
        } else if ((at.ageMinutes ?? 0) >= POLICY.no_readings_long_minutes) {
          sentence = `Bez odczytów ${names.nominative} nie ma z czego liczyć.`;
          detail = 'Warto zmierzyć glukozę glukometrem.';
        } else {
          // The "no reading" row says that Mellis does not know (texts review, 2026-11-09).
          sentence = `Warto sprawdzić sensor i telefon z ${INSTRUMENTAL[input.loop.system]}.`;
        }
      }
      break;
    case '9b':
      second = { kind: 'NO_READING', label: null, value: `${age} min`, unit: 'bez odczytu', note: null };
      // The imperative only after a reading below 70; otherwise Mellis stays an advisor.
      sentence = value < POLICY.low_mgdl ? 'Zmierz glukozę glukometrem.' : 'Warto zmierzyć glukozę glukometrem.';
      // No "Zapisz węgle" here: the screen asks for a meter, not for carbs (owner, 2026-11-13).
      break;
    case '9c':
      sentence = `${loopName} nie przysyła danych od ${sinceDuration(at.loopAgeMinutes ?? 0)}.`;
      detail = `Warto sprawdzić telefon z ${INSTRUMENTAL[input.loop.system]}.`;
      break;
  }

  // Another caregiver's bolus (v4): above everything but the lows, the pump, missing data and other actions.
  const caregiverBolus = caregiverBolusLine(at);
  if (caregiverBolus) {
    // Lows, forecast lows, checks, missing data and a stopped pump keep the sentence even when it is empty.
    const leads = !/^[5-9P]/.test(state);
    if ((sentence === '' && leads) || CAREGIVER_BOLUS_TAKES_SENTENCE.has(state)) {
      if (state === '1f') detail = `W ${names.locative} nie ma do niego węgli. Jeśli ten bolus nie był do jedzenia, glukoza może spaść.`;
      else if (state !== '1d') detail = null;
      sentence = caregiverBolus;
    } else if (detail === null) detail = caregiverBolus;
  }
  // v5: a planned meal soon, or one that passed with nothing entered, below the bolus line and the safety states.
  const meal = caregiverBolus && sentence === caregiverBolus ? null : mealWords(at, state);
  if (meal) {
    sentence = meal.sentence;
    detail = meal.detail;
  }
  // One line: with nothing to say, what is in force moves up; with nothing at all, the line stays empty (rules 2, 10).
  // The caregiver's bolus under a low stays under it.
  if (sentence === '' && detail && !(caregiverBolus && detail === caregiverBolus)) {
    sentence = detail;
    detail = null;
  }
  const link = action ? null : meal ? meal.link : barLink(at, state, sentence, caregiverBolus);

  return {
    policy_version: POLICY.version,
    state,
    evaluated_at: input.now.toISOString(),
    glucose: latest ? { value: latest.value, at: latest.at, age_minutes: age, tone: glucoseTone(state, value) } : null,
    second,
    sentence,
    detail,
    action,
    check: entry && dueMs !== null ? { carbs_at: entry.at, carbs_g: Math.round(entry.grams), due_at: new Date(dueMs).toISOString() } : null,
    dose_policy_version: second && second.kind !== 'CHECK' && second.kind !== 'NO_READING' ? input.dose?.policy_version ?? null : null,
    link,
  };
}

/** States whose sentence a planned meal never takes: lows, forecasts, checks, missing data, the pump, ketones, doses in doubt. */
function mealYields(state: NowSituationState): boolean {
  return /^[5-9P]/.test(state) || state === '3b' || state === '3d' || state === '3e' || state === '2b' || state === '2c' || state === '1f';
}

/** States with nothing ready to open, where a conversation is the one way on (review, section 4). */
const CONVERSATION_STATES: ReadonlySet<NowSituationState> = new Set(['3b', '3d', '3e', '2b', '1f', '3f']);

/**
 * The planned meal's sentence (v5): "O 12:30 obiad." in the half hour before it while nothing was entered for it, then
 * "Do posiłku z 12:30 nie ma wpisu węgli." from 25 to 90 minutes after it, when still nothing was entered,
 * glucose is at least 100 and no caregiver answered for it. The title is never declined (polonist).
 */
function mealWords(at: Moment, state: NowSituationState): { sentence: string; detail: string | null; link: NowLink } | null {
  if (!at.isNow || mealYields(state)) return null;
  const meals = [...(at.input.planned_meals ?? [])].sort((left, right) => Date.parse(left.planned_at) - Date.parse(right.planned_at));
  const value = at.latest?.value ?? null;
  for (const meal of meals) {
    const mealMs = Date.parse(meal.planned_at);
    if (!Number.isFinite(mealMs) || mealEntered(at, mealMs)) continue;
    const minutesTo = (mealMs - at.ms) / MINUTE_MS;
    const link: NowLink = { kind: 'MEAL_PLAN_ENTRY', entry_id: meal.id, label: mealLabel(meal.title) };
    if (minutesTo > 0 && minutesTo <= POLICY.meal_soon_minutes) {
      return { sentence: `${mealLabel(meal.title)} jest o ${clock(mealMs, at.minuteOf)}.`, detail: dishesLine(meal.items), link };
    }
    const after = -minutesTo;
    if (after >= POLICY.meal_late_from_minutes && after <= POLICY.meal_late_until_minutes && !meal.answered
      && value !== null && value >= POLICY.meal_late_min_glucose_mgdl) {
      return { sentence: `Do posiłku z ${clock(mealMs, at.minuteOf)} nie ma wpisu węgli.`, detail: null, link };
    }
  }
  return null;
}

/** Carbs, or a bolus of at least 0.3 U, from 45 minutes before the meal on, by anyone (review, veto 3). */
function mealEntered(at: Moment, mealMs: number): boolean {
  const fromMs = mealMs - POLICY.meal_entered_from_minutes * MINUTE_MS;
  const within = (iso: string) => {
    const ms = Date.parse(iso);
    return ms >= fromMs && ms <= at.ms;
  };
  if (at.input.carbs.some((entry) => within(entry.at))) return true;
  const boluses = [...at.input.boluses, ...(at.input.remote_boluses ?? [])];
  return boluses.some((dose) => dose.units >= POLICY.meal_entered_bolus_min_u && within(dose.at));
}

/**
 * The bar's button when the sentence is not a meal's: the meal close by while a forecast, another caregiver's bolus or
 * carbs without a bolus hold the line; a conversation where nothing else can be opened; otherwise none.
 */
function barLink(at: Moment, state: NowSituationState, sentence: string, caregiverBolus: string | null): NowLink | null {
  if (!at.isNow) return null;
  // meal-eaten.v1's "Czy zjedzono cały posiłek?" is not on Teraz (owner, 2026-11-12): under the check countdown it read as
  // what Mellis would check, and during a low the answer changes nothing. It stays on the meal's page.
  const mealNear = state === '5' || state === '5b' || state === '2c' || (caregiverBolus !== null && sentence === caregiverBolus);
  if (mealNear) {
    const window = POLICY.meal_link_window_minutes * MINUTE_MS;
    const meal = (at.input.planned_meals ?? [])
      .filter((candidate) => {
        const ms = Date.parse(candidate.planned_at);
        // A forecast: only a meal still ahead. The others: one just before or after.
        return state === '5' || state === '5b' ? ms > at.ms && ms - at.ms <= window : Math.abs(ms - at.ms) <= window;
      })
      .sort((left, right) => Math.abs(Date.parse(left.planned_at) - at.ms) - Math.abs(Date.parse(right.planned_at) - at.ms))[0];
    if (meal) return { kind: 'MEAL_PLAN_ENTRY', entry_id: meal.id, label: mealLabel(meal.title) };
  }
  if (sentence.trim() === '') return null;
  if (CONVERSATION_STATES.has(state) || ((state === '3' || state === '3a') && sentence !== caregiverBolus)) return { kind: 'CONVERSATION', label: 'Rozmowa o tym' };
  return null;
}

/** "Obiad", "WF", "Zupa i podwieczorek": the title as the plan gives it, first letter up. */
function mealLabel(title: string): string {
  const trimmed = title.trim();
  return trimmed ? capitalized(trimmed) : 'Posiłek';
}

/** Lower-case inside a sentence, but an abbreviation in capitals stays (WF). Never declined. */
function titleInSentence(title: string): string {
  const trimmed = title.trim();
  if (!trimmed) return 'posiłek';
  const firstWord = trimmed.split(/\s+/)[0];
  if (firstWord.length > 1 && firstWord === firstWord.toUpperCase()) return trimmed;
  return trimmed.charAt(0).toLowerCase() + trimmed.slice(1);
}

/** At most two dishes: "Zupa pomidorowa i pierogi." */
function dishesLine(items: string[]): string | null {
  const names = items.map((item) => item.trim()).filter(Boolean).slice(0, 2);
  if (names.length === 0) return null;
  const parts = names.map((name, index) => (index === 0 ? capitalized(name) : titleInSentence(name)));
  const line = parts.join(' i ');
  return /[.!?]$/.test(line) ? line : `${line}.`;
}

/**
 * Above 180 with no meal, dose, basal or fall to explain (rows 8–11, 16, 27): what the loop does about it, when that can
 * be said truly; otherwise nothing. The level itself is never repeated.
 */
function highWords(at: Moment, state: NowSituationState): { sentence: string; detail: string | null } {
  const names = loopSystemNames(at.input.loop.system);
  const loopName = capitalized(names.nominative);
  const value = at.latest?.value ?? 0;
  const adding = loopAddingInsulin(at);
  const ago = (minutes: number) => glucoseAt(at, at.ms - minutes * MINUTE_MS);
  const before30 = ago(POLICY.high_rise_check_minutes);
  const before45 = ago(POLICY.unexplained_rise_minutes);
  const noCarbs = !doseWithin(at, POLICY.explained_by_dose_hours, 'carbs');
  if (state === '3a') {
    const risingLong = at.rising && before30 !== null && value - before30 >= POLICY.high_rise_check_mgdl;
    if (adding && risingLong && noCarbs && !doseWithin(at, POLICY.very_high_no_bolus_hours, 'bolus')) {
      return { sentence: `${loopName} dodaje insulinę, a glukoza nie spada.`, detail: 'Warto sprawdzić wkłucie i zmierzyć ketony.' };
    }
  } else if (adding) {
    const unexplained = before45 !== null && value - before45 >= POLICY.unexplained_rise_mgdl && noCarbs && !doseWithin(at, POLICY.explained_by_dose_hours, 'bolus');
    if (unexplained) return { sentence: `W ${names.locative} nie ma węgli, które tłumaczyłyby ten wzrost.`, detail: null };
  }
  return { sentence: '', detail: null };
}


/** The second sentence in range: what is in force or coming. Linia dnia does not stand beside it. */
function quietNote(at: Moment): string | null {
  const { input } = at;
  const names = loopSystemNames(input.loop.system);
  if (input.override) return `W ${names.locative} działa nadpisanie: ${input.override.name ? `${input.override.name}, ` : ''}${input.override.percentage}%.`;
  const sensorMs = input.sensor_changed_at ? Date.parse(input.sensor_changed_at) : Number.NaN;
  if (Number.isFinite(sensorMs) && at.ms - sensorMs < POLICY.doubtful_new_sensor_hours * 60 * MINUTE_MS) {
    return `Sensor działa od ${sinceDuration((at.ms - sensorMs) / MINUTE_MS)}, więc odczyty mogą być mniej dokładne.`;
  }
  const minute = at.minuteOf(at.ms);
  const hoursLeft = input.reservoir_hours_left ?? null;
  const toMorning = (24 * 60 - minute + POLICY.morning_minute) / 60;
  if (minute >= POLICY.evening_note_from_minute && minute < POLICY.evening_note_to_minute && hoursLeft !== null && hoursLeft < toMorning) {
    const whole = Math.round(hoursLeft);
    if (whole === 0) return 'Zbiornik wystarczy na mniej niż godzinę. Warto wymienić go przed nocą.';
    return `Zbiornik wystarczy na około ${whole === 1 ? 'godzinę' : `${whole} godzin${whole % 10 >= 2 && whole % 10 <= 4 && (whole < 12 || whole > 14) ? 'y' : ''}`}. Warto wymienić go przed nocą.`;
  }
  return null;
}

function aboveMinutes(at: Moment, above: number): number {
  let firstMs = at.ms;
  for (let index = at.readings.length - 1; index >= 0; index -= 1) {
    if (at.readings[index].value <= above) break;
    firstMs = Date.parse(at.readings[index].at);
  }
  return (at.ms - firstMs) / MINUTE_MS;
}

function glucoseTone(state: NowSituationState, value: number): NowGlucoseTone {
  if (state === '8j' || state === '9' || state === '9b') return 'STALE';
  if (state === '7' || state === '7b' || state === '8g') return 'ON_RED';
  if (value < POLICY.low_mgdl) return 'RED';
  if (value > POLICY.high_mgdl) return 'AMBER';
  return 'NEUTRAL';
}

function newestAt<T extends { at: string }>(items: readonly T[], ms: number): T | null {
  let newest: T | null = null;
  let newestMs = Number.NEGATIVE_INFINITY;
  for (const item of items) {
    const itemMs = Date.parse(item.at);
    if (itemMs <= ms && itemMs >= newestMs) {
      newest = item;
      newestMs = itemMs;
    }
  }
  return newest;
}

function upperBound(sorted: number[], value: number): number {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (sorted[middle] <= value) low = middle + 1;
    else high = middle;
  }
  return low;
}

function lowerBound(sorted: number[], value: number): number {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (sorted[middle] < value) low = middle + 1;
    else high = middle;
  }
  return low;
}
