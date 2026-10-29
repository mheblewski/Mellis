import { SPLIT_ADVICE_POLICY } from '@modules/remote-commands/application/split-advice';
import { CURRENT_READING_MAX_AGE_MINUTES } from '@shared/primitives/glucose-rules';

/**
 * Owner decision (2026-10-15): the assistant may suggest insulin doses (meal boluses and timing, corrections) and therapy
 * settings changes (ICR, ISF, basal, targets) as decision support for the caregiver. Every suggestion must rest on enough
 * data, show its basis and arithmetic, and stay a suggestion to consider: the caregiver decides.
 */
export const THERAPY_SUGGESTION_POLICY_VERSION = 'therapy-suggestion-policy.v8';

const split = SPLIT_ADVICE_POLICY;
const percent = (now: number) => `${now}/${100 - now}`;
/** The split rule in words, from the same constants as the bolus cards (split-advice.v1), so the two never disagree. */
const SPLIT_RULE = `A split meal bolus follows the app's rule: from ${split.ratio_split} WBT per carb exchange (WBT/WW) or ${split.fat_share_split}% of the energy from fat, ${percent(split.mild.now_percent)} with the second part after ${split.mild.after_minutes} min; from ${split.ratio_strong} or ${split.fat_share_strong}%, ${percent(split.strong.now_percent)} after ${split.strong.after_minutes} min; meals under ${split.min_carbs_g} g of carbs are given at once.`;

export const THERAPY_SUGGESTION_INSTRUCTIONS: readonly string[] = [
  'Therapy suggestions are allowed and wanted when the data supports them: meal bolus amount and timing (pre-bolus), correction doses, and changes to ICR, ISF, basal rates and targets. They are always suggestions for the caregiver to consider ("do rozważenia", "możesz rozważyć"), never orders: the caregiver decides.',
  'Every suggestion needs enough data: name its basis (which days, meals or readings), show the arithmetic (for example carbs / ICR, (glucose - target) / ISF - IOB), give an honest confidence and the main risk (hypo, insulin stacking). A suggestion drawn from the likely cause of a low or a high is only as certain as that cause: say which alternative cause would change it. If something essential is missing or stale, say exactly what is missing and give no number.',
  'Settings changes (ICR, ISF, basal, targets) need a pattern repeated on several days (at least three occurrences in the analysed range) and the current value from therapy_profile; suggest small steps of about 10-20% of the current value and say what to watch after the change.',
  'Meal boluses: a meal description is carb data. Take quantities literally ("100 g kaszy" is 100 g of kasza, cooked unless the caregiver says dry), estimate the carbs of every component from typical nutrition values (state the assumptions, e.g. cooked vs dry weight, a sauce thickened with flour), use one most likely total and compute the proposal with the ICR from therapy_profile for the time of the meal. Do not refuse because the description is not exact: say which assumption would change the number and by how much. Suggest pre-bolus timing only when the data supports it.',
  SPLIT_RULE,
  'Format every dose proposal exactly like this (Polish labels, bold labels, one line each, then the rest of the answer):\n**Propozycja:** X,XX j (do rozważenia; every dose rounded DOWN to 0,05 j, as the cards do)[, podanie: timing when supported]\n**Uzasadnienie:** carbs estimate with assumptions, ICR, the arithmetic, the correction part with IOB/COB and why it is or is not added\nFor a split meal bolus write both parts: **Propozycja:** X,XX j teraz + ok. Y,YY j za N min (podział P/Q, the split you chose). When no number can be given (a stale glucose, a falling or low glucose), write **Propozycja:** brak, with the reason, instead.',
  'Corrections now: only with a current glucose no older than 15 minutes (current_state_snapshot.age_minutes), its trend and IOB (and COB when known); subtract IOB, take the closed loop and recent SMBs into account to avoid stacking, and do not recommend insulin on your own when glucose is below target, falling fast or a hypo is in progress: then your recommendation is treating or preventing the low. When the caregiver decides otherwise (e.g. a meal with a later bolus, part of the dose now), their plan goes ahead with one clear warning about the risk.',
  'Err on the conservative side for the patient\'s age (Patient age below) and say so; never present a suggestion as certain or as a substitute for the diabetes team.',
  'The newest reading is current_state_snapshot (as_of, age_minutes). A CGM reading comes every 5 minutes: when age_minutes is 5 or more, say how old it is ("ostatni odczyt sprzed N min") and never describe its trend as still going on ("nadal spada", "dalej rośnie"), because a newer reading may already differ; a dose based on it carries that caveat.',
];

/** The newest reading the answer was written from (current_state_snapshot); null: none was known. */
export interface TherapyProposalGlucose {
  glucose_mgdl: number | null;
  age_minutes: number | null;
  /** Nightscout direction ("SingleDown", "DoubleDown", …); null when not known. */
  trend: string | null;
}

/** The same bounds the prompt states (corrections now, no insulin of its own when low or falling fast). */
export const THERAPY_PROPOSAL_GUARD = {
  max_glucose_age_minutes: CURRENT_READING_MAX_AGE_MINUTES,
  low_mgdl: 70,
  falling_fast_trends: ['DoubleDown', 'SingleDown'] as readonly string[],
} as const;

/**
 * A dose in the answer's "**Propozycja:**" line is checked against the reading it was written from: the prompt's rules
 * (a glucose no older than 15 min, no insulin of its own when low or falling fast) are only words for the model, so a
 * proposal that breaks them gets one plain sentence from the server. The text itself is never changed or cut: the
 * caregiver decides (advisor, not guard).
 */
export type TherapyProposalCorrection = 'THERAPY_NO_READING' | 'THERAPY_LOW' | 'THERAPY_FALLING' | 'THERAPY_STALE_READING';

export function finalizeTherapyProposal(text: string, glucose: TherapyProposalGlucose | null, proposesDose: (text: string) => boolean): { text: string; corrected: boolean; kind?: TherapyProposalCorrection } {
  if (!proposesDose(text)) return { text, corrected: false };
  const guard = THERAPY_PROPOSAL_GUARD;
  const value = glucose?.glucose_mgdl ?? null;
  const age = glucose?.age_minutes ?? null;
  let note: string | null = null;
  let kind: TherapyProposalCorrection | undefined;
  if (value === null || age === null) {
    kind = 'THERAPY_NO_READING';
    note = 'Uwaga: ta propozycja nie opiera się na bieżącej glikemii (brak aktualnego odczytu). Sprawdź glikemię przed podaniem insuliny.';
  } else if (value < guard.low_mgdl) {
    kind = 'THERAPY_LOW';
    note = `Uwaga: glikemia ${Math.round(value)} mg/dL jest poniżej ${guard.low_mgdl}: najpierw leczenie niedocukrzenia, insulina dopiero po wyrównaniu.`;
  } else if (glucose?.trend && guard.falling_fast_trends.includes(glucose.trend)) {
    kind = 'THERAPY_FALLING';
    note = 'Uwaga: glikemia szybko spada: z insuliną lepiej poczekać, aż spadek się zatrzyma, i sprawdzić glikemię jeszcze raz.';
  } else if (age > guard.max_glucose_age_minutes) {
    kind = 'THERAPY_STALE_READING';
    note = `Uwaga: ostatni odczyt glikemii jest sprzed ${Math.round(age)} min, więc ta propozycja może być nieaktualna. Sprawdź glikemię przed podaniem insuliny.`;
  }
  return note ? { text: `${text.trimEnd()}\n\n${note}`, corrected: true, kind } : { text, corrected: false };
}
