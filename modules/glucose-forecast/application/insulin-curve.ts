/**
 * The insulin curve the Bolus tab's chart spreads a dose over (insulin-curve.v1): oref's exponential curve with the peak
 * the loop itself uses, mapped as oref (Trio) and Loop do. Nothing here invents a setting: without one in the data the
 * peak is rapid-acting's 75 min, marked DEFAULT.
 *
 * Where the setting is in the data Mellis stores (checked 2026-10-30):
 * - Loop: every dose Loop uploads to Nightscout carries `insulinType` (the brand name, e.g. "Novolog"), kept in the
 *   treatment's source_records.raw_payload. Fiasp and Lyumjev mean Loop's ultra-rapid models (peak 55), Afrezza its
 *   inhaled one (29); Novolog / Humalog / Apidra mean the rapid-acting model, adult (75) or child (65), which Loop keeps
 *   on the phone (the Nightscout profile's `loopSettings` has no model): 75, as Loop's default.
 * - Trio: the curve (`curve`, `useCustomPeakTime`, `insulinPeakTime`) is in Trio's preferences on the phone; neither its
 *   Nightscout profile (store/units/deviceToken/overridePresets…) nor its devicestatus (`openaps.suggested` / `iob`) nor
 *   its treatments carry it. TODO(insulin-curve): read Trio's curve once Trio uploads its preferences; until then 75.
 *   `insulinCurveFromTrioPreferences` already maps that shape (oref's rules).
 */

export type InsulinCurveName = 'rapid-acting' | 'rapid-acting-child' | 'ultra-rapid' | 'bilinear' | 'afrezza';
export type InsulinCurveSource = 'TRIO_PREFERENCES' | 'LOOP_INSULIN_TYPE' | 'DEFAULT';

export interface InsulinCurve {
  curve: InsulinCurveName;
  peak_minutes: number;
  source: InsulinCurveSource;
  /** Trio's own peak (useCustomPeakTime) instead of the curve's. */
  custom_peak: boolean;
  /** Loop's insulin brand the curve comes from ("Fiasp"), when it does. */
  insulin_type: string | null;
}

export const INSULIN_CURVE_POLICY = {
  version: 'insulin-curve.v1',
  /** oref and Loop: rapid-acting (adult) 75, Loop's child model 65, ultra-rapid (Fiasp, Lyumjev) 55, Afrezza 29. */
  peak_minutes: { 'rapid-acting': 75, 'rapid-acting-child': 65, 'ultra-rapid': 55, bilinear: 75, afrezza: 29 } satisfies Record<InsulinCurveName, number>,
  /** oref's limits for a custom peak (profile/index.js): rapid-acting 50-120 min, ultra-rapid 35-100 min. */
  custom_peak_range: { 'rapid-acting': [50, 120], 'ultra-rapid': [35, 100] } as Record<string, [number, number]>,
} as const;

export const DEFAULT_INSULIN_CURVE: InsulinCurve = Object.freeze({ curve: 'rapid-acting', peak_minutes: 75, source: 'DEFAULT', custom_peak: false, insulin_type: null });

/**
 * Trio's (oref's) preferences: `curve` "rapid-acting" | "ultra-rapid" | "bilinear", and with `useCustomPeakTime` the
 * `insulinPeakTime` held in oref's range for the curve (bilinear has no peak setting: oref's 75). Null when the
 * preferences give no known curve.
 */
export function insulinCurveFromTrioPreferences(preferences: unknown): InsulinCurve | null {
  if (!preferences || typeof preferences !== 'object') return null;
  const prefs = preferences as Record<string, unknown>;
  const name = typeof prefs.curve === 'string' ? prefs.curve.trim().toLowerCase() : '';
  if (name !== 'rapid-acting' && name !== 'ultra-rapid' && name !== 'bilinear') return null;
  const base = INSULIN_CURVE_POLICY.peak_minutes[name];
  const range = INSULIN_CURVE_POLICY.custom_peak_range[name];
  const custom = Number(prefs.insulinPeakTime);
  if (prefs.useCustomPeakTime === true && range && Number.isFinite(custom) && custom > 0) {
    return { curve: name, peak_minutes: Math.min(range[1], Math.max(range[0], Math.round(custom))), source: 'TRIO_PREFERENCES', custom_peak: true, insulin_type: null };
  }
  return { curve: name, peak_minutes: base, source: 'TRIO_PREFERENCES', custom_peak: false, insulin_type: null };
}

/**
 * Loop's `insulinType` on a Nightscout treatment (LoopKit's brand names) → Loop's model. Novolog / Humalog / Apidra:
 * rapid-acting, adult unless `child` (Loop does not upload which). Null for an unknown name.
 */
export function insulinCurveFromLoopInsulinType(insulinType: unknown, options: { child?: boolean } = {}): InsulinCurve | null {
  if (typeof insulinType !== 'string' || !insulinType.trim()) return null;
  const type = insulinType.trim();
  const key = type.toLowerCase().replace(/[^a-z]/g, '');
  let curve: InsulinCurveName | null = null;
  if (key.startsWith('fiasp') || key.startsWith('lyumjev')) curve = 'ultra-rapid';
  else if (key.startsWith('afrezza')) curve = 'afrezza';
  else if (['novolog', 'novorapid', 'humalog', 'apidra', 'admelog', 'insulinaspart', 'insulinlispro', 'insulinglulisine'].some((name) => key.startsWith(name))) {
    curve = options.child ? 'rapid-acting-child' : 'rapid-acting';
  }
  if (!curve) return null;
  return { curve, peak_minutes: INSULIN_CURVE_POLICY.peak_minutes[curve], source: 'LOOP_INSULIN_TYPE', custom_peak: false, insulin_type: type };
}

/** The first known curve of the sources, else the default (75 min). */
export function resolveInsulinCurve(input: { trio_preferences?: unknown; loop_insulin_type?: unknown }): InsulinCurve {
  return insulinCurveFromTrioPreferences(input.trio_preferences)
    ?? insulinCurveFromLoopInsulinType(input.loop_insulin_type)
    ?? DEFAULT_INSULIN_CURVE;
}
