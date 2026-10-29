import { FALLING_FAST_MGDL_PER_MIN } from '@shared/primitives/glucose-rules';
import { agree, capitalized, loopSystemNames, type LoopSystemKind } from '@modules/loop-system/domain/loop-system';
import type { DoseCalculation, RecentInsulin } from './dose-calculator';

/**
 * What GlucoMind checks before a caregiver may send a meal or bolus to Trio (remote-bolus-trio-plan.md W3, W4, §3).
 * Trio checks again on the patient's phone (max bolus, max IOB, boluses since the command, newer carbs); these checks
 * come first so a caregiver is not shown a "Podaj" button for a dose GlucoMind already knows is unsafe or unknown.
 *
 * Blocks stop the command; only amounts that cannot be sent and a command still waiting for Trio block. Everything
 * about the patient's data (low or missing glucose, a loop not reporting, no ICR, unknown boluses) is a warning: the
 * caregiver can always give a bolus. Warnings are shown in the confirmation and must be
 * acknowledged: the server refuses a command whose current warnings were not all on the screen the caregiver confirmed.
 */

export const REMOTE_COMMAND_POLICY = {
  version: 'remote-commands.v1',
  /** Hard ceilings on the server; the phone's own limits (settings) are usually lower. */
  max_carbs_g: 300,
  max_insulin_u: 30,
  /** Insulin without a recent glucose reading or loop calculation is pointed out. */
  glucose_old_minutes: 15,
  glucose_stale_minutes: 30,
  loop_stale_minutes: 30,
  /** Glucose below this now or within the lookback is pointed out in strong words. */
  low_block_mgdl: 70,
  low_lookback_minutes: 30,
  low_warn_mgdl: 80,
  /** mg/dL per 5 minutes: the shared "falling fast". */
  falling_fast_delta: FALLING_FAST_MGDL_PER_MIN * 5,
  recent_bolus_minutes: 15,
  /** A dose further than this from carbs / ICR is pointed out. */
  icr_difference_ratio: 0.2,
  /** The phone must start sending within this time after the server authorized the command. */
  send_window_seconds: 120,
  /** A command without any report this long after its send deadline counts as possibly delivered (NO_REPLY). */
  unreported_grace_seconds: 90,
  /** A remote bolus of this long ago is pointed out before the next one; an unconfirmed one in strong words. */
  recent_remote_bolus_minutes: 30,
  /** No answer from Trio within this time: the caregiver is told not to resend and to check the patient's phone. */
  reply_timeout_minutes: 3,
  /** A card's dose Trio refused can be retried for this long after the refused command. */
  retry_window_minutes: 30,
  /** The loop's carb entry or bolus for a command shows up in Nightscout within this time after it was authorized. */
  match_window_minutes: 20,
  /** The Bolus tab's meal eaten later: its carbs are dated in Trio at most this far ahead (the bolus starts now). */
  max_meal_in_minutes: 30,
  /**
   * Seconds after Trio's answer when Nightscout is read again (instead of the next minute's sync): Trio uploads the
   * carbs and the bolus within a few seconds, so the meal is created right away rather than 30–90 s later.
   */
  sync_after_answer_seconds: [3, 10, 25],
} as const;

export type RemoteCommandSource = 'BOLUS_SCREEN' | 'CHAT_CARD' | 'NEW_MEAL' | 'WBT_SCREEN' | 'PLANNED_BOLUS' | 'RESCUE_CARBS';

export type RemoteCommandBlock =
  | 'INVALID_AMOUNTS'
  | 'COMMAND_IN_FLIGHT';

export type RemoteCommandWarning =
  | 'LOW_GLUCOSE'
  | 'NO_GLUCOSE'
  | 'GLUCOSE_STALE'
  | 'LOOP_STALE'
  | 'NO_THERAPY_PROFILE'
  | 'INSULIN_HISTORY_UNAVAILABLE'
  | 'GLUCOSE_OLD'
  | 'GLUCOSE_FALLING_OR_LOW'
  | 'RECENT_BOLUS'
  | 'DOSE_DIFFERS_FROM_ICR'
  | 'RECENT_REMOTE_BOLUS'
  | 'UNCONFIRMED_REMOTE_BOLUS'
  /** Chat cards only (card-advice.ts): the forecast with the card's carbs and insulin goes below 70 (54) mg/dL. */
  | 'FORECAST_LOW'
  /** Chat cards only: a low now or within ~30 min while the card has no fast carbs (meal-dose-forecast.ts). */
  | 'FAST_CARBS_FIRST'
  /** Chat cards only, insulin for a high: Trio adds insulin itself, glucose falling, night (card-advice.ts). */
  | 'CORRECTION_STACKING'
  | 'CORRECTION_FALLING'
  | 'CORRECTION_NIGHT'
  /** Chat cards only: a high despite insulin, check the set and ketones (high-glucose-safety.ts). */
  | 'HIGH_DESPITE_INSULIN'
  /** Chat cards only: the card covers fewer carbs than an earlier unsent card for the same meal. */
  | 'PLAN_SHORTER'
  /** Chat cards only: a card of an earlier answer for the same meal was already sent. */
  | 'ALREADY_SENT_FOR_MEAL'
  /** Chat cards only: above the send limits set on the asking phone (it would refuse to send). */
  | 'PHONE_LIMIT'
  /** dose-calculator.v1: the dose is max(0,5 j, 25%) above the calculator (live, every insulin command). */
  | 'DOSE_ABOVE_CALCULATOR'
  /** dose-calculator.v1: insulin while glucose is below 70 or a low is near (carbs first); a separate confirmation. */
  | 'INSULIN_WHILE_LOW'
  /** dose-calculator.v1: much insulin in the last 90–120 min (manual, remote, SMB) and this dose is not covered by the calculator. */
  | 'RECENT_INSULIN'
  /** Chat cards only: the dose the model (or the caregiver through it) gave is max(0,5 j, 25%) above the formula. */
  | 'DOSE_ABOVE_FORMULA'
  /** dose-calculator.v1 (review M4): the calculator threw, the dose was not checked; acknowledged as checked by hand. */
  | 'CALCULATOR_UNAVAILABLE'
  /** dose-calculator.v1 (review L4): the same-meal check could not read the recent commands; acknowledged. */
  | 'SAME_MEAL_CHECK_UNAVAILABLE';

/**
 * Warnings only a chat card computes (its forecast, advice and meal history), never evaluateRemoteCommand: the card's
 * own ones join the confirmation's preview and must be acknowledged when it is authorized.
 */
export const CARD_ONLY_WARNINGS: readonly RemoteCommandWarning[] = ['FORECAST_LOW', 'FAST_CARBS_FIRST', 'CORRECTION_STACKING', 'CORRECTION_FALLING', 'CORRECTION_NIGHT', 'HIGH_DESPITE_INSULIN', 'PLAN_SHORTER', 'ALREADY_SENT_FOR_MEAL', 'DOSE_ABOVE_FORMULA'];

export interface RemoteCommandContext {
  now: string;
  /** `direction` is the reading's Nightscout trend (Flat, FortyFiveUp, …), what the dashboard's arrow shows. */
  glucose: { value: number; observed_at: string; delta: number | null; direction?: string | null } | null;
  /** Lowest reading in the low lookback, if any reading. */
  lowest_recent_glucose: number | null;
  loop: { iob_units: number | null; cob_grams: number | null; observed_at: string } | null;
  last_bolus: { at: string; units: number } | null;
  /** False when the boluses could not be read (the last bolus is then unknown, not absent). */
  bolus_history_known: boolean;
  /** The newest remote bolus that may have reached Trio (it can be missing from Nightscout for minutes). */
  recent_remote_bolus: { at: string; units: number; status: string } | null;
  /** g/U at `carbs_at` (at `now` without it); null without a therapy profile. */
  icr_g_per_u: number | null;
  /**
   * When Trio dates the carbs: a meal eaten later (the Bolus tab's "+15 min"), sent with them as Trio's
   * `scheduled_time` while the bolus starts now. Absent: the carbs are dated now.
   */
  carbs_at?: string | null;
  /** A command of this patient still waiting for Trio's answer (any caregiver). */
  in_flight_command_id: string | null;
  /** The pump's bolus step Trio reports in its device status (pump.bolusIncrement); null when not reported. */
  pump_bolus_step?: number | null;
  /** The system the command goes to (texts name it); absent on rows from before loop-support: Trio. */
  loop_system?: LoopSystemKind;
  /** Insulin of the recent-insulin window (manual boluses and SMBs from Nightscout); absent: not read (dose-calculator.v1). */
  recent_insulin?: RecentInsulin | null;
  /** Every remote bolus of the recent-insulin window that may have been given (review L3); absent: not read. */
  recent_remote_boluses?: Array<{ id: string; at: string; units: number }> | null;
  /** The loop-style calculator for the command's carbs (dose-calculator.v1), as checked; absent on older rows. */
  dose_calculation?: DoseCalculation | null;
}

export interface RemoteCommandEvaluation {
  /** carbs / ICR rounded down to the pump step; null without carbs or ICR. */
  icr_insulin_u: number | null;
  blocks: Array<{ code: RemoteCommandBlock; message: string }>;
  /** `key` names the warning and the data it is about: a new bolus or reading makes a new key to acknowledge. */
  warnings: Array<{ code: RemoteCommandWarning; key: string; message: string; severity?: 'WARNING' | 'DANGER' }>;
}

/**
 * The step doses are rounded to: the pump's own (from Trio's device status) when it is one GlucoMind can round to,
 * else the phone's setting. A pump finer than 0.05 U delivers every 0.05 U dose; a coarser step than 0.1 U is not
 * supported here (null: the phone's setting decides).
 */
export function pumpBolusStep(reported: number | null | undefined): 0.05 | 0.1 | null {
  if (typeof reported !== 'number' || !Number.isFinite(reported) || reported <= 0) return null;
  if (Math.abs(reported - 0.1) < 1e-6) return 0.1;
  if (reported <= 0.05 + 1e-6 && Math.abs(0.05 / reported - Math.round(0.05 / reported)) < 1e-6) return 0.05;
  return null;
}

/** Rounds down to the pump's step (never up: a remote dose may be smaller than asked, not larger). */
export function roundDownToStep(units: number, step: number): number {
  if (!Number.isFinite(units) || units <= 0) return 0;
  const safeStep = Number.isFinite(step) && step > 0 ? step : 0.05;
  // Work in hundredths of a unit to keep 4.55 / 0.05 from becoming 90.999….
  const stepHundredths = Math.round(safeStep * 100);
  const unitsHundredths = Math.floor(units * 100 + 1e-6);
  return (Math.floor(unitsHundredths / stepHundredths) * stepHundredths) / 100;
}

export function insulinForCarbs(carbsG: number, icrGramsPerUnit: number | null, step: number): number | null {
  if (!icrGramsPerUnit || icrGramsPerUnit <= 0 || !(carbsG > 0)) return null;
  return roundDownToStep(carbsG / icrGramsPerUnit, step);
}

/**
 * `calculator_default_u`: the dose the loop-style calculator proposes for these carbs (dose-calculator.v1); a dose
 * between it and carbs / ICR is the calculator's lowering, not a dose that "differs from ICR".
 */
export function evaluateRemoteCommand(input: { carbs_g: number; insulin_u: number; bolus_step: number; context: RemoteCommandContext; calculator_default_u?: number | null }): RemoteCommandEvaluation {
  const { carbs_g: carbs, insulin_u: insulin, context } = input;
  const policy = REMOTE_COMMAND_POLICY;
  const nowMs = Date.parse(context.now);
  const minutesSince = (iso: string | null | undefined): number => (iso ? (nowMs - Date.parse(iso)) / 60_000 : Number.POSITIVE_INFINITY);
  const icrInsulin = insulinForCarbs(carbs, context.icr_g_per_u, input.bolus_step);
  const blocks: RemoteCommandEvaluation['blocks'] = [];
  const warnings: RemoteCommandEvaluation['warnings'] = [];
  const loopName = loopSystemNames(context.loop_system ?? 'TRIO');

  const validCarbs = Number.isInteger(carbs) && carbs >= 0 && carbs <= policy.max_carbs_g;
  const validInsulin = Number.isFinite(insulin) && insulin >= 0 && insulin <= policy.max_insulin_u && roundDownToStep(insulin, input.bolus_step) === insulin;
  if (!validCarbs || !validInsulin || (carbs === 0 && insulin === 0)) {
    blocks.push({ code: 'INVALID_AMOUNTS', message: `Podaj węglowodany (pełne gramy) i/lub insulinę w krokach pompy (${formatUnits(input.bolus_step)} j).` });
  }
  if (context.in_flight_command_id) {
    blocks.push({ code: 'COMMAND_IN_FLIGHT', message: `Poprzednie polecenie czeka na odpowiedź ${loopName.genitive}. Poczekaj na nią albo sprawdź telefon pacjenta.` });
  }

  if (insulin > 0) {
    const glucoseAge = minutesSince(context.glucose?.observed_at);
    const lowNow = context.glucose !== null && context.glucose.value < policy.low_block_mgdl;
    const lowRecently = context.lowest_recent_glucose !== null && context.lowest_recent_glucose < policy.low_block_mgdl;
    if (context.glucose && lowNow) {
      warnings.push({ code: 'LOW_GLUCOSE', key: `LOW_GLUCOSE:${context.glucose.observed_at}`, message: `Glukoza ${context.glucose.value} mg/dL: insulina może pogłębić niedocukrzenie.` });
    } else if (lowRecently) {
      warnings.push({ code: 'LOW_GLUCOSE', key: `LOW_GLUCOSE:${context.glucose?.observed_at ?? 'none'}:${context.lowest_recent_glucose}`, message: `Glukoza spadła do ${context.lowest_recent_glucose} mg/dL w ostatnich ${policy.low_lookback_minutes} min: insulina może pogłębić niedocukrzenie.` });
    }
    if (!context.glucose) {
      warnings.push({ code: 'NO_GLUCOSE', key: 'NO_GLUCOSE', message: 'Brak odczytu glukozy.' });
    } else if (glucoseAge > policy.glucose_stale_minutes) {
      warnings.push({ code: 'GLUCOSE_STALE', key: `GLUCOSE_STALE:${context.glucose.observed_at}`, message: `Ostatni odczyt glukozy ma ${Math.round(glucoseAge)} min: nie wiadomo, jaka jest teraz.` });
    } else if (glucoseAge > policy.glucose_old_minutes) {
      warnings.push({ code: 'GLUCOSE_OLD', key: `GLUCOSE_OLD:${context.glucose.observed_at}`, message: `Ostatni odczyt glukozy ma ${Math.round(glucoseAge)} min.` });
    }
    if (minutesSince(context.loop?.observed_at) > policy.loop_stale_minutes) {
      warnings.push({ code: 'LOOP_STALE', key: `LOOP_STALE:${context.loop?.observed_at ?? 'none'}`, message: `${capitalized(loopName.nominative)} od ponad ${policy.loop_stale_minutes} min nie ${agree(loopName, { m: 'wysłał', f: 'wysłała', n: 'wysłało' })} obliczeń do Nightscout: pętla może nie działać, a IOB może być nieaktualne.` });
    }
    if (carbs > 0 && context.icr_g_per_u === null) {
      warnings.push({ code: 'NO_THERAPY_PROFILE', key: 'NO_THERAPY_PROFILE', message: 'Brak przelicznika węglowodanów (ICR) z profilu w Nightscout: dawki nie sprawdzono z przelicznikiem.' });
    }
    if (!lowNow && !lowRecently && context.glucose && (context.glucose.value < policy.low_warn_mgdl || (context.glucose.delta !== null && context.glucose.delta <= policy.falling_fast_delta))) {
      warnings.push({ code: 'GLUCOSE_FALLING_OR_LOW', key: `GLUCOSE_FALLING_OR_LOW:${context.glucose.observed_at}`, message: `Glukoza ${context.glucose.value} mg/dL${context.glucose.delta !== null ? `, zmiana ${context.glucose.delta > 0 ? '+' : ''}${context.glucose.delta} na 5 min` : ''}.` });
    }
    if (!context.bolus_history_known) {
      warnings.push({ code: 'INSULIN_HISTORY_UNAVAILABLE', key: 'INSULIN_HISTORY_UNAVAILABLE', message: 'Nie udało się wczytać ostatnich bolusów: nie wiadomo, czy niedawno podano insulinę.' });
    }
    const remote = context.recent_remote_bolus;
    // The same bolus already in Nightscout is said once, by RECENT_BOLUS (it is also no longer "unconfirmed").
    const remoteInNightscout = remote !== null && context.last_bolus !== null
      && Math.abs(context.last_bolus.units - remote.units) <= 0.051
      && Math.abs(Date.parse(context.last_bolus.at) - Date.parse(remote.at)) <= 5 * 60_000;
    if (remote && !remoteInNightscout && minutesSince(remote.at) <= policy.recent_remote_bolus_minutes) {
      if (remote.status === 'NO_REPLY') {
        // Not a block: caregivers confirm by phone whether it went; the confirmation must
        // show it and the caregiver acknowledges it explicitly.
        warnings.push({ code: 'UNCONFIRMED_REMOTE_BOLUS', key: `UNCONFIRMED_REMOTE_BOLUS:${remote.at}`, message: `Zdalny bolus ${formatUnits(remote.units)} j sprzed ${Math.max(0, Math.round(minutesSince(remote.at)))} min nie ma potwierdzenia z Trio i MÓGŁ zostać podany. Podaj kolejny tylko, jeśli wiesz, że tamten nie dotarł.` });
      } else {
        warnings.push({ code: 'RECENT_REMOTE_BOLUS', key: `RECENT_REMOTE_BOLUS:${remote.at}`, message: `Zdalny bolus ${formatUnits(remote.units)} j wysłano ${Math.max(0, Math.round(minutesSince(remote.at)))} min temu (może jeszcze nie być w Nightscout).` });
      }
    }
    if (context.last_bolus && minutesSince(context.last_bolus.at) <= policy.recent_bolus_minutes) {
      warnings.push({ code: 'RECENT_BOLUS', key: `RECENT_BOLUS:${context.last_bolus.at}:${context.last_bolus.units}`, message: `Bolus ${formatUnits(context.last_bolus.units)} j podano ${Math.max(0, Math.round(minutesSince(context.last_bolus.at)))} min temu.` });
    }
    // Insulin without carbs (a correction) needs no warning: 0 g is on the screen and on the card.
    const loweredByCalculator = typeof input.calculator_default_u === 'number' && insulin < icrInsulin! && insulin >= input.calculator_default_u - 1e-6;
    if (carbs > 0 && icrInsulin !== null && icrInsulin > 0 && Math.abs(insulin - icrInsulin) / icrInsulin > policy.icr_difference_ratio && !loweredByCalculator) {
      warnings.push({ code: 'DOSE_DIFFERS_FROM_ICR', key: `DOSE_DIFFERS_FROM_ICR:${carbs}:${insulin}:${context.icr_g_per_u}`, message: `Dawka różni się od przelicznika: ${carbs} g / ICR ${context.icr_g_per_u} = ${formatUnits(icrInsulin)} j.` });
    }
  }

  return { icr_insulin_u: icrInsulin, blocks, warnings };
}

export function formatUnits(units: number): string {
  return (Math.round(units * 100) / 100).toString().replace('.', ',');
}
