/** A phone's send limits as sent with a message; null when absent or out of the limits a phone can set (30 U, 300 g). */
export function readPhoneLimits(value: unknown): { max_bolus_u: number; max_carbs_g: number } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const bolus = raw.max_bolus_u;
  const carbs = raw.max_carbs_g;
  if (typeof bolus !== 'number' || !Number.isFinite(bolus) || bolus <= 0 || bolus > 30) return null;
  if (typeof carbs !== 'number' || !Number.isInteger(carbs) || carbs <= 0 || carbs > 300) return null;
  return { max_bolus_u: bolus, max_carbs_g: carbs };
}
