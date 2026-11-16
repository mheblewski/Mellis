/**
 * One rule for reading an insulin sensitivity factor (ISF) as mg/dL per U, used for the therapy profile's ISF and for
 * the loop's own (oref's `ISF` is printed in the user's units, like its targets) by the meal dose reduction, the rescue
 * dose and the Bolus tab's chart.
 *
 * - An ISF of 25 or more is mg/dL whatever the label: 25 mmol/L per U (450 mg/dL) is not a real setting.
 * - Below 25, the profile's units decide: mg/dL ISF of 15–25 is real (adults on large daily doses), and so is mmol/L ISF
 *   of 15–25 (small children).
 * - Without units, below 25 is mmol/L: most mmol/L ISFs are 1–15, most mg/dL ISFs are 30–400.
 * - Below 10 is mmol/L even under a mg/dL label: an ISF of 3 mg/dL per U (over 180 U a day) is a mislabeled profile.
 */
export const ISF_UNITS_POLICY = {
  /** An ISF below this may be mmol/L per U (see above). */
  mmol_below: 25,
  /** An ISF below this is mmol/L per U even under a mg/dL label. */
  mgdl_min: 10,
  mgdl_per_mmol: 18,
} as const;

/**
 * The profile names no units and the ISF fits both (below 25): isfToMgdl reads it as mmol/L, which for an ISF of
 * 10–25 mg/dL per U makes it 18 times too high (dose audit 2026-11-16: a rescue dose of 4 g at 48 mg/dL for an adult).
 * The rescue dose does not use it then. The meal calculator still does: there the misread ISF only shrinks the
 * correction, and skipping the calculator would also drop its IOB subtraction (a larger dose).
 */
export function isfUnitsUnknown(value: number | null | undefined, units: string | null | undefined): boolean {
  if (value === null || value === undefined || !Number.isFinite(value) || value <= 0) return false;
  if (value >= ISF_UNITS_POLICY.mmol_below) return false;
  return !/mg|mmol/i.test(units ?? '');
}

/** The ISF in mg/dL per U, or null when missing or not positive. `units` is the therapy profile's ("mg/dl", "mmol"). */
export function isfToMgdl(value: number | null | undefined, units: string | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value) || value <= 0) return null;
  const policy = ISF_UNITS_POLICY;
  if (value >= policy.mmol_below) return value;
  const labeledMgdl = /mg/i.test(units ?? '') && !/mmol/i.test(units ?? '');
  return labeledMgdl && value >= policy.mgdl_min ? value : Math.round(value * policy.mgdl_per_mmol);
}
