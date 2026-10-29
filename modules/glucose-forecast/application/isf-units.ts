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

/** The ISF in mg/dL per U, or null when missing or not positive. `units` is the therapy profile's ("mg/dl", "mmol"). */
export function isfToMgdl(value: number | null | undefined, units: string | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value) || value <= 0) return null;
  const policy = ISF_UNITS_POLICY;
  if (value >= policy.mmol_below) return value;
  const labeledMgdl = /mg/i.test(units ?? '') && !/mmol/i.test(units ?? '');
  return labeledMgdl && value >= policy.mgdl_min ? value : Math.round(value * policy.mgdl_per_mmol);
}
