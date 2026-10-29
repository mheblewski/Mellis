import { detectLoopSystem, type LoopSystemKind } from '../domain/loop-system';

/**
 * The loop's own forecast from its newest device status (glucose-forecast.v1; first used by rescue-carbs.v1,
 * the rescue-carbs plan).
 *
 * Trio / AAPS (oref) upload `openaps.suggested` (and `.enacted`) with `predBGs.{IOB,ZT,COB,UAM}`: one value per 5 min,
 * index 0 = the BG the calculation used, and `carbsReq` only when oref thinks carbs are needed within 45 min. Loop
 * uploads `loop.predicted.values` from `startDate`. Nothing here is a clinical decision: it only reads the fields.
 */

export interface LoopPredictionCurves {
  /** Insulin + current deviation fading over 60 min (oref). Loop's single curve is stored here too. */
  IOB?: number[];
  /** Insulin only, with basal suspended from now (oref). */
  ZT?: number[];
  /** With carbs still absorbing (oref, only when COB > 0). */
  COB?: number[];
  /** Unannounced meal (oref). */
  UAM?: number[];
}

export interface LoopPrediction {
  /** How the forecast was computed: oref (Trio, AAPS) or Loop's single combined curve. */
  source: 'OPENAPS' | 'LOOP';
  /** Which system uploaded it (texts name it: "Trio prognozuje", "Loop prognozuje"). */
  system: LoopSystemKind;
  /** When index 0 of the curves applies (the calculation time). */
  computed_at: string;
  bg: number | null;
  carbs_req_g: number | null;
  /** oref's insulin needed to bring eventual glucose to target (Trio/AAPS only), U. */
  insulin_req_u?: number | null;
  /** Loop's own bolus recommendation now (`loop.recommendedBolus`; Loop only), U: what Loop would give for this level. */
  recommended_bolus_u?: number | null;
  iob_u: number | null;
  cob_g: number | null;
  /** oref's sensitivity and carb ratio of this calculation (autosens/overrides included), per U and g per U. oref prints
   * the ISF in the user's units (mmol/L for mmol/L users) despite the name: read it with isfToMgdl (isf-units.ts). */
  isf_mgdl_per_u: number | null;
  icr_g_per_u: number | null;
  eventual_bg: number | null;
  /** oref's target of this calculation (Trio: `current_target`, temp targets and overrides included), mg/dL. */
  target_mgdl?: number | null;
  /** From oref's reason text: the lowest forecast after 90 min (minPredBG) and from now (minGuardBG), mg/dL. */
  min_pred_bg?: number | null;
  min_guard_bg?: number | null;
  /** From the reason text, only when oref printed them: the largest SMB allowed now ("maxBolus", the SMB or UAM
   * minutes × the scheduled basal, rounded to 0.1 U), the temp basal ceiling ("maxSafeBasal") and Max IOB ("max_iob"). */
  smb_cap_u?: number | null;
  max_safe_basal_u_per_h?: number | null;
  max_iob_u?: number | null;
  /** When the loop last enacted a calculation (`openaps.enacted`): absent in open loop. */
  enacted_at?: string | null;
  curves: LoopPredictionCurves;
}

/** The limits oref printed in a reason text (each null when not printed). */
export function orefReasonLimits(reason: unknown): Pick<LoopPrediction, 'min_pred_bg' | 'min_guard_bg' | 'smb_cap_u' | 'max_safe_basal_u_per_h' | 'max_iob_u'> {
  const text = typeof reason === 'string' ? reason : '';
  const read = (pattern: RegExp): number | null => {
    const match = pattern.exec(text);
    const value = match ? Number(match[1]) : NaN;
    return Number.isFinite(value) ? value : null;
  };
  return {
    min_pred_bg: read(/minPredBG:? (-?\d+(?:\.\d+)?)/),
    min_guard_bg: read(/minGuardBG:? (-?\d+(?:\.\d+)?)/),
    smb_cap_u: read(/maxBolus:? (\d+(?:\.\d+)?)/),
    max_safe_basal_u_per_h: read(/maxSafeBasal:? (\d+(?:\.\d+)?)/),
    max_iob_u: read(/max_iob:? (\d+(?:\.\d+)?)/),
  };
}

const CURVE_KEYS = ['IOB', 'ZT', 'COB', 'UAM'] as const;

export function parseLoopPrediction(status: { observed_at: string; raw_payload: Record<string, unknown> } | null): LoopPrediction | null {
  if (!status) return null;
  const openaps = asRecord(status.raw_payload.openaps);
  if (openaps) {
    const suggested = asRecord(openaps.suggested);
    const enacted = asRecord(openaps.enacted);
    // The suggestion is the newest calculation; the enacted one is used only when no suggestion has curves.
    const decision = [suggested, enacted].find((candidate) => candidate && asRecord(candidate.predBGs)) ?? suggested ?? enacted;
    if (!decision) return null;
    const predBGs = asRecord(decision.predBGs) ?? {};
    const curves: LoopPredictionCurves = {};
    for (const key of CURVE_KEYS) {
      const values = numberArray(predBGs[key]);
      if (values.length > 0) curves[key] = values;
    }
    return {
      source: 'OPENAPS',
      system: detectLoopSystem(status.raw_payload).kind,
      computed_at: isoOr(decision.deliverAt, decision.timestamp, status.observed_at),
      bg: finiteNumber(decision.bg),
      carbs_req_g: positiveOrNull(finiteNumber(decision.carbsReq)),
      insulin_req_u: finiteNumber(decision.insulinReq),
      iob_u: finiteNumber(decision.IOB) ?? finiteNumber(asRecord(openaps.iob)?.iob),
      cob_g: finiteNumber(decision.COB),
      isf_mgdl_per_u: positiveOrNull(finiteNumber(decision.ISF)),
      icr_g_per_u: positiveOrNull(finiteNumber(decision.CR)),
      eventual_bg: finiteNumber(decision.eventualBG),
      target_mgdl: positiveOrNull(finiteNumber(decision.current_target) ?? finiteNumber(decision.target_bg)),
      ...orefReasonLimits(decision.reason),
      enacted_at: enacted ? isoOrNull(enacted.deliverAt, enacted.timestamp) : null,
      curves,
    };
  }
  const loop = asRecord(status.raw_payload.loop);
  const predicted = asRecord(loop?.predicted);
  if (loop && predicted) {
    const values = numberArray(predicted.values);
    return {
      source: 'LOOP',
      system: 'LOOP',
      computed_at: isoOr(predicted.startDate, loop.timestamp, status.observed_at),
      bg: values[0] ?? null,
      carbs_req_g: null,
      recommended_bolus_u: finiteNumber(loop.recommendedBolus),
      iob_u: finiteNumber(asRecord(loop.iob)?.iob),
      cob_g: finiteNumber(asRecord(loop.cob)?.cob),
      isf_mgdl_per_u: null,
      icr_g_per_u: null,
      eventual_bg: values.at(-1) ?? null,
      curves: values.length > 0 ? { IOB: values } : {},
    };
  }
  return null;
}

function numberArray(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const numbers = value.map(finiteNumber);
  return numbers.every((number) => number !== null) ? numbers as number[] : [];
}

function isoOr(...candidates: unknown[]): string {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && Number.isFinite(Date.parse(candidate))) return new Date(candidate).toISOString();
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return new Date(candidate).toISOString();
  }
  return new Date(0).toISOString();
}

function isoOrNull(...candidates: unknown[]): string | null {
  const iso = isoOr(...candidates);
  return Date.parse(iso) > 0 ? iso : null;
}

function positiveOrNull(value: number | null): number | null {
  return value !== null && value > 0 ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function finiteNumber(value: unknown): number | null {
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof number === 'number' && Number.isFinite(number) ? number : null;
}
