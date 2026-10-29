/**
 * The loop's numbers in one devicestatus, whichever system uploaded it (loop-system.ts). Readers of IOB, COB and the
 * running temp basal go through here instead of walking `openaps.*` / `loop.*` paths themselves.
 *
 * - oref (Trio, AAPS): `openaps.iob.iob`, `openaps.suggested|enacted.{IOB,COB}`, `openaps.enacted.{rate,duration}`.
 *   The suggestion is newer than the last enacted calculation, so it wins.
 * - Loop: `loop.iob.iob`, `loop.cob.cob`, `loop.enacted.{rate,duration,timestamp}` (duration in minutes).
 */

export interface LoopValues {
  iob_u: number | null;
  cob_g: number | null;
}

export interface LoopTempBasal {
  rate_u_per_h: number;
  duration_minutes: number | null;
  /** When the loop set it; null when the upload does not say. */
  set_at: string | null;
}

const IOB_PATHS = [
  ['openaps', 'iob', 'iob'],
  ['openaps', 'suggested', 'IOB'],
  ['openaps', 'suggested', 'iob'],
  ['openaps', 'enacted', 'IOB'],
  ['openaps', 'enacted', 'iob'],
  ['loop', 'iob', 'iob'],
];
const COB_PATHS = [
  ['openaps', 'suggested', 'COB'],
  ['openaps', 'suggested', 'cob'],
  ['openaps', 'enacted', 'COB'],
  ['openaps', 'enacted', 'cob'],
  ['openaps', 'iob', 'cob'],
  ['loop', 'cob', 'cob'],
];

/** IOB (U) and COB (g) of one loop calculation, unrounded; both null when it carries neither. */
export function readLoopValues(payload: Record<string, unknown>): LoopValues {
  return { iob_u: firstNumber(payload, IOB_PATHS), cob_g: firstNumber(payload, COB_PATHS) };
}

/** The temp basal the loop last enacted in this devicestatus; null when it reports none. */
export function readEnactedTempBasal(payload: Record<string, unknown>): LoopTempBasal | null {
  const enacted = asRecord(asRecord(payload.openaps)?.enacted) ?? asRecord(asRecord(payload.loop)?.enacted);
  const rate = finiteNumber(enacted?.rate);
  if (!enacted || rate === null) return null;
  return {
    rate_u_per_h: rate,
    duration_minutes: finiteNumber(enacted.duration),
    set_at: isoOrNull(enacted.deliverAt ?? enacted.timestamp),
  };
}

function firstNumber(payload: Record<string, unknown>, paths: string[][]): number | null {
  for (const path of paths) {
    let value: unknown = payload;
    for (const key of path) value = asRecord(value)?.[key];
    const number = finiteNumber(value);
    if (number !== null) return number;
  }
  return null;
}

function isoOrNull(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) && time > 0 ? new Date(time).toISOString() : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function finiteNumber(value: unknown): number | null {
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof number === 'number' && Number.isFinite(number) ? number : null;
}
