/**
 * How long the insulin in the reservoir lasts and how urgent a change is (reservoir-level.v1, owner 2026-10-29). The
 * same level colours the dashboard, the widgets and the Live Activity and decides the reservoir push.
 *  1. With the patient's usage (reservoir-usage.v1): hours left = units / (average daily units / 24); yellow below
 *     24 h, red below 8 h.
 *  2. Without it, the percent of the level after the last change (reservoir_full_units): yellow below 15 %, red
 *     below 7 %.
 *  3. Without either, the old fixed units: yellow below 25 U, red below 10 U.
 */
export const RESERVOIR_LEVEL_POLICY = {
  version: 'reservoir-level.v1',
  warning_hours: 24,
  alarm_hours: 8,
  warning_percent: 15,
  alarm_percent: 7,
  warning_units: 25,
  alarm_units: 10,
} as const;

export type ReservoirLevel = 'normal' | 'warning' | 'alarm';

export interface ReservoirStatus {
  /** Hours the reservoir lasts at the average use, one decimal; null without a usage estimate. */
  hours_left: number | null;
  level: ReservoirLevel;
  basis: 'USAGE' | 'PERCENT' | 'UNITS';
}

export function reservoirStatus(args: { units: number | null; fullUnits: number | null; averageDailyUnits: number | null }): ReservoirStatus | null {
  const policy = RESERVOIR_LEVEL_POLICY;
  const units = args.units;
  if (units === null || !Number.isFinite(units) || units < 0) return null;
  const perDay = args.averageDailyUnits;
  if (perDay !== null && Number.isFinite(perDay) && perDay > 0) {
    const hours = units / (perDay / 24);
    return {
      hours_left: Math.round(hours * 10) / 10,
      level: hours < policy.alarm_hours ? 'alarm' : hours < policy.warning_hours ? 'warning' : 'normal',
      basis: 'USAGE',
    };
  }
  const full = args.fullUnits;
  if (full !== null && Number.isFinite(full) && full > 0) {
    const percent = (units / full) * 100;
    return { hours_left: null, level: percent < policy.alarm_percent ? 'alarm' : percent < policy.warning_percent ? 'warning' : 'normal', basis: 'PERCENT' };
  }
  return { hours_left: null, level: units < policy.alarm_units ? 'alarm' : units < policy.warning_units ? 'warning' : 'normal', basis: 'UNITS' };
}

/**
 * "na ok. 1 dzień i 20 godz." / "na ok. 2 dni" (24 h and more: days and the hours left over, 0 hours left out),
 * "na ok. 14 godz.", "na mniej niż 1 godz.": what the app and the push say (1.0.5: "44 godz." was hard to read).
 * Rounded down to whole hours, so the reservoir never seems to last longer than it does.
 */
export function formatReservoirDuration(hours: number): string {
  if (!Number.isFinite(hours) || hours < 1) return 'na mniej niż 1 godz.';
  const whole = Math.floor(hours);
  if (whole >= 24) {
    const days = Math.floor(whole / 24);
    const rest = whole % 24;
    return rest > 0 ? `na ok. ${days} ${polishDays(days)} i ${rest} godz.` : `na ok. ${days} ${polishDays(days)}`;
  }
  return `na ok. ${whole} godz.`;
}

export function polishDays(count: number): string {
  return count === 1 ? 'dzień' : 'dni';
}
