import { formatUnits } from './remote-command-policy';

/**
 * A high despite insulin (kept from correction-up.v1 when the rest of it went): glucose above
 * 250 mg/dL for 2 h, or a correction bolus 1–3 h ago that did not lower glucose by 50 mg/dL in its first hour. Insulin
 * from the pump may not be getting in (set failure): meter, ketones, set change, pen (Phillip 2023, Polish HCL guideline
 * 2024). Only a warning on the card: the caregiver still decides.
 */

const HIGH_GLUCOSE_SAFETY_POLICY = {
  version: 'high-glucose-safety.v1',
  sustained_high_mgdl: 250,
  sustained_high_minutes: 120,
  /** At least this share of the 5-min readings in the window must be there to call it sustained. */
  sustained_min_coverage: 0.75,
  correction_check_after_minutes: 60,
  correction_min_fall_mgdl: 50,
  /** A bolus counts as a correction when it came without carbs (± this) at or above this glucose. */
  correction_carbs_window_minutes: 20,
  correction_min_glucose_mgdl: 180,
  /** ...and is looked for this far back (60–180 min: its first hour must be over). */
  correction_lookback_minutes: 180,
  still_high_mgdl: 200,
} as const;

export type HighGlucoseSafetyKind = 'SUSTAINED_HIGH' | 'CORRECTION_NO_EFFECT';

export interface HighGlucoseSafetyInputs {
  /** CGM readings of the last ~3 h, oldest first. */
  readings: Array<{ at: string; value: number }>;
  /** Manual boluses of the last ~3 h; null when the history could not be read. */
  boluses: Array<{ at: string; units: number }> | null;
  /** Carb entries of the last ~3 h (to tell a correction from a meal bolus); null when unknown. */
  carbs: Array<{ at: string; grams: number }> | null;
}

const CHECK = 'Sprawdź glukometrem, zmierz ketony i rozważ wymianę wkłucia oraz korektę penem według planu na wysoki cukier (wpisaną w Trio): insulina z pompy może nie docierać.';

export function detectHighDespiteInsulin(input: HighGlucoseSafetyInputs & { now: Date }): { kind: HighGlucoseSafetyKind; message: string } | null {
  const policy = HIGH_GLUCOSE_SAFETY_POLICY;
  const nowMs = input.now.getTime();
  const windowStart = nowMs - policy.sustained_high_minutes * 60_000;
  const inWindow = input.readings.filter((reading) => {
    const at = Date.parse(reading.at);
    return at >= windowStart && at <= nowMs;
  });
  const expected = policy.sustained_high_minutes / 5;
  const firstMs = inWindow.length > 0 ? Math.min(...inWindow.map((reading) => Date.parse(reading.at))) : Infinity;
  if (inWindow.length >= expected * policy.sustained_min_coverage && firstMs <= windowStart + 15 * 60_000
    && inWindow.every((reading) => reading.value > policy.sustained_high_mgdl)) {
    return {
      kind: 'SUSTAINED_HIGH',
      message: `Glukoza powyżej ${policy.sustained_high_mgdl} mg/dL od ${policy.sustained_high_minutes / 60} godzin mimo pętli. ${CHECK}`,
    };
  }
  if (!input.boluses || !input.carbs) return null;
  const latest = input.readings.at(-1);
  if (!latest || latest.value < policy.still_high_mgdl) return null;
  for (const bolus of [...input.boluses].reverse()) {
    const atMs = Date.parse(bolus.at);
    const age = (nowMs - atMs) / 60_000;
    if (age < policy.correction_check_after_minutes || age > policy.correction_lookback_minutes) continue;
    const withCarbs = input.carbs.some((entry) => entry.grams > 0 && Math.abs(Date.parse(entry.at) - atMs) <= policy.correction_carbs_window_minutes * 60_000);
    const before = glucoseNear(input.readings, atMs);
    const after = glucoseNear(input.readings, atMs + policy.correction_check_after_minutes * 60_000);
    if (withCarbs || before === null || after === null || before < policy.correction_min_glucose_mgdl) continue;
    if (before - after < policy.correction_min_fall_mgdl) {
      return {
        kind: 'CORRECTION_NO_EFFECT',
        message: `Korekta ${formatUnits(bolus.units)} j sprzed ${Math.round(age)} min nie obniżyła glukozy o ${policy.correction_min_fall_mgdl} mg/dL w godzinę (${before} → ${after} mg/dL). ${CHECK}`,
      };
    }
  }
  return null;
}

/** The safety inputs from synced readings, insulin events and carb entries of the last ~4 h. */
export function highGlucoseSafetyInputsFrom(input: {
  now: Date;
  readings: Array<{ at: string; value: number }>;
  insulinEvents: Array<{ type: string; occurred_at: string; payload: Record<string, unknown> }> | null;
  carbEntries: Array<{ occurred_at: string | Date; payload: Record<string, unknown> }> | null;
}): HighGlucoseSafetyInputs {
  const sinceMs = input.now.getTime() - 4 * 3_600_000;
  const seen = new Set<string>();
  return {
    readings: input.readings
      .filter((reading) => Date.parse(reading.at) >= sinceMs && Date.parse(reading.at) <= input.now.getTime() && Number.isFinite(reading.value) && reading.value > 38)
      .map((reading) => ({ at: reading.at, value: reading.value }))
      .sort((left, right) => Date.parse(left.at) - Date.parse(right.at)),
    boluses: input.insulinEvents
      ? input.insulinEvents
        .filter((event) => String(event.type).toUpperCase() === 'BOLUS')
        .flatMap((event) => {
          const units = Number(event.payload?.insulin_units ?? event.payload?.insulin);
          const key = `${event.occurred_at}|${units}`;
          if (!Number.isFinite(units) || units <= 0 || seen.has(key)) return [];
          seen.add(key);
          return [{ at: new Date(event.occurred_at).toISOString(), units }];
        })
        .sort((left, right) => Date.parse(left.at) - Date.parse(right.at))
      : null,
    carbs: input.carbEntries
      ? input.carbEntries
        .map((entry) => ({ at: new Date(entry.occurred_at).toISOString(), grams: Number(entry.payload?.carbs ?? entry.payload?.carbs_g ?? 0) }))
        .filter((entry) => Number.isFinite(entry.grams))
      : null,
  };
}

/** The reading nearest a time (within 10 min), null without one. */
function glucoseNear(readings: Array<{ at: string; value: number }>, ms: number): number | null {
  let best: { distance: number; value: number } | null = null;
  for (const reading of readings) {
    const distance = Math.abs(Date.parse(reading.at) - ms);
    if (distance <= 10 * 60_000 && (!best || distance < best.distance)) best = { distance, value: reading.value };
  }
  return best?.value ?? null;
}
