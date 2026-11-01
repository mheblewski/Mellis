import { isfToMgdl } from '@modules/glucose-forecast/application/isf-units';
import { capitalized, loopSystemNames, type LoopSystemKind } from '@modules/loop-system/domain/loop-system';
import type { RescueEvaluation } from './rescue-detection';

/**
 * The static rescue carb dose (rescue-dose.v3, the rescue-carbs plan). Everything comes from the child's
 * own ISF and ICR: CSF = ISF / ICR is how many mg/dL one gram raises glucose. No AI.
 *
 * - The dose brings the lowest forecast within 30 min (the curve with COB while carbs absorb) back to 90 mg/dL, COB the
 *   curve does not count credited; at most 20 g at once, then the 15-minute recheck (the reminder) gives more if needed.
 * - Only an ongoing low with no loop forecast keeps ISPAD 2022's bound: a dose raising glucose ~70 mg/dL (0.3 g/kg).
 * - Owner decision 2026-11-01 (v3): oref's carbsReq and the loop's eventual glucose are no longer the dose. Both count all
 *   insulin on board to its end, carbsReq credits COB only above 25% of the meal's carbs and eventual glucose none, so
 *   v2 proposed a median 7 g where 0.7 g was needed (37 alerts not treated, one patient's history).
 *   carbsReq stays a detection signal and is shown for information.
 */

export const RESCUE_DOSE_POLICY = {
  version: 'rescue-dose.v3',
  target_mgdl: 90,
  /** One portion at most; then the 15-minute recheck. */
  max_portion_g: 20,
  /** An ongoing low without a loop forecast: the dose raises glucose about this much (ISPAD: 54–72 mg/dL with 0.3 g/kg). */
  low_without_forecast_rise_mgdl: 70,
  min_rise_mgdl: 20,
  min_g: 3,
  /** Share of COB credited when the forecast curve does not count the carbs still absorbing. */
  cob_credit_share: 0.75,
} as const;

/** TRIO_CARBS_REQ: rescue-dose.v2 only (stored alerts); v3 never gives it. */
export type RescueDoseBasis = 'TRIO_CARBS_REQ' | 'FORMULA' | 'URGENT_MAX' | 'NO_PROFILE';

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

  const csf = isf / icr;
  const glucose = evaluation.glucose?.value ?? null;
  const ongoingLow = evaluation.level === 'LOW_NOW' || evaluation.level === 'URGENT_LOW';
  // Without the loop nothing is known about the insulin still working: an ongoing low gets ISPAD's dose, not more.
  const withoutForecast = ongoingLow && !evaluation.loop_used;
  const minG = Math.max(policy.min_g, Math.ceil(policy.min_rise_mgdl / csf));
  const maxG = withoutForecast
    ? Math.max(minG, Math.min(policy.max_portion_g, Math.round(policy.low_without_forecast_rise_mgdl / csf)))
    : policy.max_portion_g;
  const clamp = (grams: number) => Math.min(maxG, Math.max(minG, Math.round(grams)));
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
    const ispad = Math.max(minG, Math.min(maxG, Math.round(policy.low_without_forecast_rise_mgdl / csf)));
    if (ispad > carbs) {
      carbs = ispad;
      needed = Math.max(needed, ispad);
      lines.push(`Glukoza < 54: co najmniej ${ispad} g (podnosi o ok. 70 mg/dL).`);
    }
  }

  if (Math.round(needed) > maxG) {
    lines.push(`Jednorazowo najwyżej ${maxG} g: podaj ${carbs} g i sprawdź glukozę po 15 min.`);
    warnings.push(`Potrzeba więcej niż jedna porcja (${formatNumber(Math.round(needed))} g): po 15 min sprawdź glukozę i w razie potrzeby podaj kolejną.`);
  } else {
    lines.push(`Proponuję ${carbs} g, kontrola glukozy po 15 min.`);
  }
  if (iob !== null) lines.push(`Aktywna insulina (IOB): ${formatNumber(iob)} j.`);
  // Insulin no logged carbs cover, more than one portion would offset (BG − IOB×ISF + COB×CSF back to 90): often a
  // meal bolus whose carbs were never entered in the loop.
  const uncoveredG = iob !== null && glucose !== null && iob > 0 ? (policy.target_mgdl - (glucose - iob * isf + (cob ?? 0) * csf)) / csf : 0;
  if (iob !== null && uncoveredG > policy.max_portion_g) {
    warnings.push(`Dużo aktywnej insuliny (IOB ${formatNumber(iob)} j): sprawdź, czy nie brakuje wpisu węglowodanów w ${loopName.locative}.`);
  }
  return { ...base, carbs_g: carbs, min_g: minG, max_g: maxG, basis, csf_mgdl_per_g: Math.round(csf * 10) / 10, explanation: lines, warnings };
}

function formatNumber(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return String(rounded).replace('.', ',');
}
