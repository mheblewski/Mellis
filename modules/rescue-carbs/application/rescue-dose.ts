import { isfToMgdl, isfUnitsUnknown } from '@modules/glucose-forecast/application/isf-units';
import { capitalized, loopSystemNames, type LoopSystemKind } from '@modules/loop-system/domain/loop-system';
import { patientAge, polishYears } from '@shared/primitives/patient-age';
import type { RescueEvaluation } from './rescue-detection';

/**
 * The static rescue carb dose (rescue-dose.v4). Everything comes from the child's
 * own ISF and ICR: CSF = ISF / ICR is how many mg/dL one gram raises glucose. No AI.
 *
 * - The dose brings the lowest forecast within 30 min (the curve with COB while carbs absorb) back to 90 mg/dL, COB the
 *   curve does not count credited; at most 20 g at once, then the 15-minute recheck (the reminder) gives more if needed.
 * - Only an ongoing low with no loop forecast keeps ISPAD 2022's bound: a dose raising glucose ~70 mg/dL (0.3 g/kg).
 * - v4 (owner 2026-11-07): an ongoing low that is not rising gets at least a dose for the patient's age: 0.15 g/kg by the
 *   approximate weight for that age, half of ISPAD's 0.3 g/kg, and never more than a rise of 70 mg/dL. ISF and ICR stay the
 *   main calculation; with settings that already give more, nothing changes. Unknown age: no floor.
 * - v5 (owner 2026-11-15): below 54 the floor is ISPAD's full 0.3 g/kg by the approximate weight for the age (13 years →
 *   14 g), not bounded by the +70 mg/dL from CSF: a teenager at 47 mg/dL was offered 4 g where caregivers give 10–15 g.
 *   Carbs still absorbing (COB) no longer cancel either floor: glucose falling under 70 with COB on board shows the meal
 *   is not stopping the fall. Within one portion (20 g) as before.
 * - v5 (owner 2026-11-16): 54–69 falling fast (6 mg/dL per 5 min or more, or the forecast under 54 within 15 min) gets
 *   the full 0.3 g/kg too: such a low is under 54 within minutes. Flat or slowly falling keeps the half.
 * - v6 (owner 2026-11-16, role review docs/product/rescue-floor-review.md): the fast fall by the CGM needs two falls of
 *   6 mg/dL per 5 min in a row (one noisy reading moved a teenager from 8 to 18 g); the forecast under 54 within 15 min
 *   still counts alone. The floors themselves stay.
 * - Dose audit 2026-11-16 (other people's profiles): a profile without units whose ISF fits both (below 25) gives no
 *   formula dose (an ISF of 20 mg/dL read as mmol/L made 48 mg/dL → 4 g for an adult); an ongoing low gets the dose for
 *   the age alone (UNITS_UNKNOWN), without the age none. A missing year of birth is said on an ongoing low.
 * - Owner decision 2026-11-01 (v3): oref's carbsReq and the loop's eventual glucose are no longer the dose. Both count all
 *   insulin on board to its end, carbsReq credits COB only above 25% of the meal's carbs and eventual glucose none, so
 *   v2 proposed a median 7 g where 0.7 g was needed (37 alerts not treated, one patient's history).
 *   carbsReq stays a detection signal and is shown for information.
 */

export const RESCUE_DOSE_POLICY = {
  version: 'rescue-dose.v6',
  /** Owner 2026-11-09: every dose in grams rounds up to an even number (dextrose tablets come in even grams). */
  even_grams: true,
  target_mgdl: 90,
  /** One portion at most; then the 15-minute recheck. */
  max_portion_g: 20,
  /** An ongoing low without a loop forecast: the dose raises glucose about this much (ISPAD: 54–72 mg/dL with 0.3 g/kg). */
  low_without_forecast_rise_mgdl: 70,
  min_rise_mgdl: 20,
  min_g: 3,
  /** Share of COB credited when the forecast curve does not count the carbs still absorbing. */
  cob_credit_share: 0.75,
  /** An ongoing low: at least this many grams from this age on, oldest first. Weights for age are approximate. */
  age_floor_g: [{ from_age: 17, g: 10 }, { from_age: 14, g: 8 }, { from_age: 12, g: 6 }, { from_age: 9, g: 4 }, { from_age: 0, g: 3 }],
  /**
   * Below 54 (v5): at least ISPAD's 0.3 g/kg, by the approximate median weight for the age (kg), oldest first; grams
   * round up to even and stay within one portion.
   */
  urgent_floor_g_per_kg: 0.3,
  weight_for_age_kg: [
    { from_age: 17, kg: 62 }, { from_age: 16, kg: 58 }, { from_age: 15, kg: 55 }, { from_age: 14, kg: 50 }, { from_age: 13, kg: 45 },
    { from_age: 12, kg: 40 }, { from_age: 11, kg: 36 }, { from_age: 10, kg: 32 }, { from_age: 9, kg: 29 }, { from_age: 8, kg: 26 },
    { from_age: 7, kg: 23 }, { from_age: 6, kg: 21 }, { from_age: 5, kg: 18 }, { from_age: 4, kg: 16 }, { from_age: 3, kg: 14 },
    { from_age: 0, kg: 12 },
  ],
  /** 54–69 gets the full floor when falling at least this fast per 5 min… */
  fast_fall_mgdl_per_5min: 6,
  /** …or when the forecast goes under 54 within this many minutes. */
  fast_fall_forecast_minutes: 15,
  /** Falling or flat: from this rise per 5 min the low is already getting better. */
  age_floor_rising_mgdl_per_5min: 2,
} as const;

/** TRIO_CARBS_REQ: rescue-dose.v2 only (stored alerts); v3 never gives it. */
export type RescueDoseBasis = 'TRIO_CARBS_REQ' | 'FORMULA' | 'URGENT_MAX' | 'NO_PROFILE' | 'UNITS_UNKNOWN';

export interface RescueDoseProposal {
  policy_version: string;
  carbs_g: number | null;
  /** The bounds the dose was kept in (min 3 g or +20 mg/dL; max 20 g, or +70 mg/dL for a low without a forecast). */
  min_g: number | null;
  max_g: number | null;
  basis: RescueDoseBasis;
  csf_mgdl_per_g: number | null;
  isf_mgdl_per_u: number | null;
  icr_g_per_u: number | null;
  /** Where ISF and ICR came from: the loop's calculation (autosens included) or the therapy profile. */
  settings_source: 'LOOP' | 'PROFILE' | null;
  iob_u: number | null;
  cob_g: number | null;
  trio_carbs_req_g: number | null;
  /** Polish lines for the screen and the model: the basis and the arithmetic. */
  explanation: string[];
  /** Polish lines shown above the explanation: more needed than one portion, insulin no logged carbs cover. */
  warnings: string[];
}

export function computeRescueDose(input: {
  evaluation: RescueEvaluation;
  loop: { system?: LoopSystemKind; isf_mgdl_per_u: number | null; icr_g_per_u: number | null; iob_u: number | null; cob_g: number | null; eventual_bg?: number | null } | null;
  profile: { isf: number | null; icr_g_per_u: number | null; units: string | null };
  /** "Rok urodzenia"; null or absent: no floor for the age. */
  birth_year?: number | null;
}): RescueDoseProposal {
  const policy = RESCUE_DOSE_POLICY;
  const { evaluation } = input;
  const fromLoop = evaluation.loop_used && input.loop?.isf_mgdl_per_u && input.loop?.icr_g_per_u;
  const isf = isfToMgdl(fromLoop ? input.loop!.isf_mgdl_per_u : input.profile.isf, input.profile.units);
  const icr = fromLoop ? input.loop!.icr_g_per_u! : input.profile.icr_g_per_u;
  const iob = evaluation.loop_used ? input.loop?.iob_u ?? null : null;
  const cob = evaluation.loop_used ? input.loop?.cob_g ?? null : null;
  const loopName = loopSystemNames(input.loop?.system ?? 'UNKNOWN');
  const base = {
    policy_version: policy.version,
    isf_mgdl_per_u: isf,
    icr_g_per_u: icr !== null && icr > 0 ? icr : null,
    settings_source: (isf && icr ? (fromLoop ? 'LOOP' : 'PROFILE') : null) as RescueDoseProposal['settings_source'],
    iob_u: iob,
    cob_g: cob,
    trio_carbs_req_g: evaluation.carbs_req_g,
  };
  if (!isf || !icr || !(icr > 0)) {
    return { ...base, carbs_g: null, min_g: null, max_g: null, basis: 'NO_PROFILE', csf_mgdl_per_g: null, explanation: ['Brak ISF lub ICR w profilu terapii: nie da się policzyć dawki. Sprawdź glukozę.'], warnings: [] };
  }

  const ongoingLow = evaluation.level === 'LOW_NOW' || evaluation.level === 'URGENT_LOW';
  const rawIsf = fromLoop ? input.loop!.isf_mgdl_per_u : input.profile.isf;
  if (isfUnitsUnknown(rawIsf, input.profile.units)) {
    return { ...base, ...unitsUnknownDose({ evaluation, birthYear: input.birth_year, rawIsf: rawIsf!, ongoingLow }) };
  }

  const csf = isf / icr;
  const glucose = evaluation.glucose?.value ?? null;
  // Without the loop nothing is known about the insulin still working: an ongoing low gets ISPAD's dose, not more.
  const withoutForecast = ongoingLow && !evaluation.loop_used;
  const ageFloor = ageFloorG({ evaluation, birthYear: input.birth_year, csf, ongoingLow });
  const minG = evenUp(Math.max(policy.min_g, Math.ceil(policy.min_rise_mgdl / csf), ageFloor ?? 0));
  const maxG = withoutForecast
    ? evenUp(Math.max(minG, Math.min(policy.max_portion_g, Math.round(policy.low_without_forecast_rise_mgdl / csf))))
    : evenUp(policy.max_portion_g);
  const clamp = (grams: number) => Math.min(maxG, Math.max(minG, evenUp(Math.round(grams))));
  const csfText = `1 g podnosi o ok. ${formatNumber(csf)} mg/dL (ISF ${formatNumber(isf)} / ICR ${formatNumber(icr)}${fromLoop ? `, z obliczenia ${loopName.genitive}` : ', z profilu'})`;
  const lines: string[] = [];
  const warnings: string[] = [];

  let carbs: number;
  let basis: RescueDoseBasis;
  let needed: number;
  if (withoutForecast && evaluation.level === 'URGENT_LOW') {
    basis = 'URGENT_MAX';
    needed = maxG;
    carbs = maxG;
    lines.push(`Glukoza ${glucose} mg/dL (< 54), bez prognozy ${loopName.genitive}: pełna dawka.`, csfText, `${maxG} g podniesie o ok. ${Math.round(maxG * csf)} mg/dL.`);
  } else {
    basis = 'FORMULA';
    const lowest = evaluation.predicted_min_mgdl ?? glucose ?? policy.target_mgdl;
    const credit = cob !== null && cob > 0 && !evaluation.curve?.includes_cob ? cob * policy.cob_credit_share : 0;
    needed = (policy.target_mgdl - lowest) / csf - credit;
    carbs = clamp(needed);
    lines.push(
      withoutForecast
        ? `Glukoza ${glucose} mg/dL, bez prognozy ${loopName.genitive} (aktywna insulina nieznana).`
        : `Najniżej w prognozie na 30 min: ${lowest} mg/dL${evaluation.minutes_to_low !== null ? ` (poniżej 70 za ok. ${evaluation.minutes_to_low} min)` : ''}.`,
      csfText,
      `(${policy.target_mgdl} − ${lowest}) / ${formatNumber(csf)} = ${formatNumber((policy.target_mgdl - lowest) / csf)} g${credit > 0 ? ` − ${formatNumber(credit)} g z aktywnych węglowodanów (COB ${formatNumber(cob!)} g)` : ''}.`,
    );
  }
  if (evaluation.loop_used && evaluation.carbs_req_g !== null && evaluation.carbs_req_g > 0) {
    // For information only: carbsReq counts all insulin on board to its end and only part of COB, so it is usually more.
    lines.push(`${capitalized(loopName.nominative)} liczy ${formatNumber(evaluation.carbs_req_g)} g na całe działanie aktywnej insuliny; to zwykle więcej, niż potrzeba teraz.`);
  }
  if (evaluation.level === 'URGENT_LOW' && basis !== 'URGENT_MAX') {
    // Below 54 at least ISPAD's dose (+70 mg/dL), within one portion.
    const ispad = Math.max(minG, Math.min(maxG, evenUp(Math.round(policy.low_without_forecast_rise_mgdl / csf))));
    if (ispad > carbs) {
      carbs = ispad;
      needed = Math.max(needed, ispad);
      lines.push(`Glukoza < 54: co najmniej ${ispad} g (podnosi o ok. 70 mg/dL).`);
    }
  }

  if (ageFloor !== null && ageFloor > Math.round(needed)) {
    lines.push(evaluation.level === 'URGENT_LOW'
      ? `Glukoza < 54: w tym wieku co najmniej ${ageFloor} g (ok. 0,3 g na kg masy ciała).`
      : fallingFast(evaluation)
        ? `Glukoza szybko spada: w tym wieku co najmniej ${ageFloor} g (ok. 0,3 g na kg masy ciała).`
        : `Przy niskiej glukozie w tym wieku najmniejsza dawka to ${ageFloor} g.`);
  }
  if (Math.round(needed) > maxG) {
    lines.push(`Jednorazowo najwyżej ${maxG} g: podaj ${carbs} g i sprawdź glukozę po 15 min.`);
    warnings.push(`Potrzeba więcej niż jedna porcja (${formatNumber(Math.round(needed))} g): po 15 min sprawdź glukozę i w razie potrzeby podaj kolejną.`);
  } else {
    lines.push(`Proponuję ${carbs} g, kontrola glukozy po 15 min.`);
  }
  if (ongoingLow && !patientAge(input.birth_year, new Date(evaluation.evaluated_at))) warnings.push(NO_BIRTH_YEAR_WARNING);
  if (iob !== null) lines.push(`Aktywna insulina (IOB): ${formatNumber(iob)} j.`);
  // Insulin no logged carbs cover, more than one portion would offset (BG − IOB×ISF + COB×CSF back to 90): often a
  // meal bolus whose carbs were never entered in the loop.
  const uncoveredG = iob !== null && glucose !== null && iob > 0 ? (policy.target_mgdl - (glucose - iob * isf + (cob ?? 0) * csf)) / csf : 0;
  if (iob !== null && uncoveredG > policy.max_portion_g) {
    warnings.push(`Dużo aktywnej insuliny (IOB ${formatNumber(iob)} j): sprawdź, czy nie brakuje wpisu węglowodanów w ${loopName.locative}.`);
  }
  return { ...base, carbs_g: carbs, min_g: minG, max_g: maxG, basis, csf_mgdl_per_g: Math.round(csf * 10) / 10, explanation: lines, warnings };
}

const NO_BIRTH_YEAR_WARNING = 'Nie podano roku urodzenia: dawka nie ma najmniejszej porcji dla wieku. Uzupełnij go w Ustawieniach, w sekcji Profil.';

/**
 * A profile without units and an ISF that fits both (dose audit 2026-11-16): no formula. An ongoing low that is not
 * rising gets the dose for the age alone (below 54 or falling fast 0.3 g/kg by weight for age, else the age table);
 * otherwise no number.
 */
function unitsUnknownDose(input: { evaluation: RescueEvaluation; birthYear: number | null | undefined; rawIsf: number; ongoingLow: boolean }): Omit<RescueDoseProposal, 'policy_version' | 'isf_mgdl_per_u' | 'icr_g_per_u' | 'settings_source' | 'iob_u' | 'cob_g' | 'trio_carbs_req_g'> {
  const policy = RESCUE_DOSE_POLICY;
  const { evaluation } = input;
  const age = patientAge(input.birthYear, new Date(evaluation.evaluated_at));
  const warnings = [`Profil terapii w Nightscout nie ma jednostek (mg/dL czy mmol/L), a ISF ${formatNumber(input.rawIsf)} pasuje do obu: Mellis nie liczy dawki z ISF. Ustaw jednostki w profilu.`];
  const rising = (evaluation.delta_per_5min ?? 0) >= policy.age_floor_rising_mgdl_per_5min;
  let grams: number | null = null;
  if (input.ongoingLow && age && !rising && !evaluation.suppressed_reason) {
    grams = evaluation.level === 'URGENT_LOW' || fallingFast(evaluation)
      ? weightFloorG(age.age_years)
      : evenUp(policy.age_floor_g.find((step) => age.age_years >= step.from_age)?.g ?? policy.min_g);
  }
  if (input.ongoingLow && !age) warnings.push(NO_BIRTH_YEAR_WARNING);
  const explanation = grams !== null
    ? [`Dawka tylko według wieku (${age!.age_years} ${polishYears(age!.age_years)}), bez ISF.`, `Proponuję ${grams} g, kontrola glukozy po 15 min.`]
    : ['Bez jednostek ISF nie da się policzyć dawki. Podaj szybkie węglowodany według swojego planu i sprawdź glukozę po 15 min.'];
  return { carbs_g: grams, min_g: grams, max_g: grams, basis: 'UNITS_UNKNOWN', csf_mgdl_per_g: null, explanation, warnings };
}

/** ISPAD's 0.3 g/kg by the approximate weight for the age, up to even grams, within one portion. */
function weightFloorG(ageYears: number): number {
  const policy = RESCUE_DOSE_POLICY;
  const kg = policy.weight_for_age_kg.find((step) => ageYears >= step.from_age)?.kg ?? policy.weight_for_age_kg[policy.weight_for_age_kg.length - 1].kg;
  return evenUp(Math.min(policy.max_portion_g, Math.round(kg * policy.urgent_floor_g_per_kg)));
}

/**
 * The floor for the age, or null when it does not apply: rising, or right after carbs. Below 54 ISPAD's full 0.3 g/kg
 * (v5); 54–69 half of it, never more than a rise of 70 mg/dL. Carbs still absorbing do not cancel it (v5).
 */
function ageFloorG(input: { evaluation: RescueEvaluation; birthYear: number | null | undefined; csf: number; ongoingLow: boolean }): number | null {
  const { evaluation, csf } = input;
  const policy = RESCUE_DOSE_POLICY;
  const age = patientAge(input.birthYear, new Date(evaluation.evaluated_at));
  if (!input.ongoingLow || !age || evaluation.suppressed_reason) return null;
  if ((evaluation.delta_per_5min ?? 0) >= policy.age_floor_rising_mgdl_per_5min) return null;
  if (evaluation.level === 'URGENT_LOW' || fallingFast(evaluation)) return weightFloorG(age.age_years);
  const floor = policy.age_floor_g.find((step) => age.age_years >= step.from_age)?.g ?? policy.min_g;
  return evenUp(Math.min(floor, Math.ceil(policy.low_without_forecast_rise_mgdl / csf)));
}

/** 54–69 falling fast: at least 6 mg/dL per 5 min twice in a row (v6), or the forecast under 54 within 15 min (v5). */
function fallingFast(evaluation: RescueEvaluation): boolean {
  const policy = RESCUE_DOSE_POLICY;
  if (evaluation.level !== 'LOW_NOW') return false;
  const fall = (delta: number | null | undefined) => delta !== null && delta !== undefined && delta <= -policy.fast_fall_mgdl_per_5min;
  if (fall(evaluation.delta_per_5min) && fall(evaluation.previous_delta_per_5min)) return true;
  const fromMs = Date.parse(evaluation.evaluated_at);
  const untilMs = fromMs + policy.fast_fall_forecast_minutes * 60_000;
  return (evaluation.curve?.points ?? []).some((point) => {
    const ms = Date.parse(point.at);
    return ms > fromMs && ms <= untilMs && point.value < 54;
  });
}

/** Up to the next even whole gram (5 → 6, 6 → 6): at most +1 g, about +CSF mg/dL, on the side away from a low. */
export function evenUp(grams: number): number {
  return Math.ceil(grams / 2) * 2;
}

function formatNumber(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return String(rounded).replace('.', ',');
}
