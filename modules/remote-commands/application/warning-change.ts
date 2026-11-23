import { agree, type LoopSystemNames } from '@modules/loop-system/domain/loop-system';
import { formatUnits } from './remote-command-policy';

/**
 * Warnings changed between the slide and the authorization (owner 2026-11-18, after a reading 97 → 90 arriving during
 * the slide refused a bolus whose same warning had been accepted seconds earlier): the server refuses only when the
 * situation got WORSE since the slide. A live warning acknowledged by its exact key always passes; otherwise, by its
 * code (the part of the key before the first ':'):
 *
 * - no acknowledged key of the same code: a new warning, refused;
 * - glucose (INSULIN_WHILE_LOW, GLUCOSE_FALLING_OR_LOW, LOW_GLUCOSE): refused when the glucose is at least 5 mg/dL lower
 *   than the acknowledged one, or INSULIN_WHILE_LOW's level is more severe;
 * - the dashed line (DOSE_LINE_LOW): refused when its band went BELOW_100 → BELOW_70 or its minimum is at least 5 mg/dL
 *   lower; DOSE_ABOVE_PROPOSALS / DOSE_ABOVE_CALCULATOR: refused when the reference went down (the dose is further
 *   above it);
 * - new insulin (RECENT_BOLUS, RECENT_INSULIN, RECENT_REMOTE_BOLUS, UNCONFIRMED_REMOTE_BOLUS, ALREADY_SENT_FOR_MEAL):
 *   another timestamp or id is another bolus or command, refused; RECENT_INSULIN with the same newest dose and a higher
 *   total too;
 * - age (GLUCOSE_STALE, GLUCOSE_OLD, LOOP_STALE) and DOSE_DIFFERS_FROM_ICR: the same code acknowledged passes;
 * - any other code: the exact key is required (the conservative default).
 *
 * Pure: the keys are parsed here, the service only passes the live warnings and the acknowledged keys.
 */
export const WARNING_CHANGE_POLICY = {
  version: 'warning-change.v1',
  /** A drop of at least this many mg/dL (glucose, the dashed line's minimum) is worse. */
  worse_drop_mgdl: 5,
} as const;

export interface WarningLike {
  code: string;
  key: string;
  message: string;
  severity?: string;
}

export type Worsening =
  /** Another bolus, SMB or command since the slide. `remote`: a remote command (another caregiver's or the same one's). */
  | { kind: 'NEW_INSULIN'; warning: WarningLike; remote: boolean; at: string | null; units: number | null }
  | { kind: 'GLUCOSE_DROP'; warning: WarningLike; before: number | null; after: number | null }
  | { kind: 'FORECAST_DROP'; warning: WarningLike; before: number | null; after: number | null }
  | { kind: 'NEW_WARNING'; warning: WarningLike };

const GLUCOSE_CODES = new Set(['INSULIN_WHILE_LOW', 'GLUCOSE_FALLING_OR_LOW', 'LOW_GLUCOSE']);
const LOOP_INSULIN_CODES = new Set(['RECENT_BOLUS', 'RECENT_INSULIN']);
const REMOTE_INSULIN_CODES = new Set(['RECENT_REMOTE_BOLUS', 'UNCONFIRMED_REMOTE_BOLUS', 'ALREADY_SENT_FOR_MEAL']);
const SAME_CODE_PASSES = new Set(['GLUCOSE_STALE', 'GLUCOSE_OLD', 'LOOP_STALE', 'DOSE_DIFFERS_FROM_ICR']);
/** INSULIN_WHILE_LOW's levels, mildest first (a forecast, a low reading not fresh, low now, urgently low). */
const LOW_LEVEL_RANK: Record<string, number> = { PREDICTED_LOW: 0, STALE_LOW: 1, BELOW_70: 2, LOW_NOW: 2, URGENT_LOW: 3 };

export function warningCode(key: string): string {
  const colon = key.indexOf(':');
  return colon < 0 ? key : key.slice(0, colon);
}

/** The key's parts after the code. ISO timestamps hold ':' too, so values are read from the ends. */
function partsOf(key: string): string[] {
  const colon = key.indexOf(':');
  return colon < 0 ? [] : key.slice(colon + 1).split(':');
}

function numberOf(part: string | undefined): number | null {
  if (part === undefined || !/^-?\d+(\.\d+)?$/.test(part)) return null;
  const value = Number(part);
  return Number.isFinite(value) ? value : null;
}

/** "RECENT_BOLUS:2026-11-18T12:46:00.000Z:0.3" → the timestamp between the code and the last part. */
function middleOf(key: string): string {
  return partsOf(key).slice(0, -1).join(':');
}

/** The glucose a glucose-based key holds (its last part); null when the key does not hold one (an older key). */
export function keyGlucose(key: string): number | null {
  return numberOf(partsOf(key).at(-1));
}

/** DOSE_LINE_LOW:{dose}:{high}:{band}:{line min}; the minimum is absent on keys from before warning-change.v1. */
function lineKey(key: string): { dose: number | null; band: string | null; min: number | null } {
  const [dose, , band, min] = partsOf(key);
  return { dose: numberOf(dose), band: band ?? null, min: numberOf(min) };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * The insulin a new-insulin warning names: RECENT_BOLUS:{at}:{units}, RECENT_INSULIN:{newest at}:{window total} (the
 * newest dose's units from the context), RECENT_REMOTE_BOLUS:{at}, UNCONFIRMED_REMOTE_BOLUS:{at},
 * ALREADY_SENT_FOR_MEAL:command:{id}:{at} (a card's own, ALREADY_SENT_FOR_MEAL:{card id}, has no time).
 */
function insulinOf(live: WarningLike, options: WarningChangeOptions): Worsening & { kind: 'NEW_INSULIN' } {
  const parts = partsOf(live.key);
  const lookup = (at: string | null) => (at ? options.dose_at?.(at) ?? null : null);
  if (live.code === 'RECENT_BOLUS' || live.code === 'RECENT_INSULIN') {
    const middle = middleOf(live.key);
    const at = middle && middle !== 'none' ? middle : null;
    // RECENT_INSULIN's window counts a remote command not in Nightscout yet: its newest dose may be one.
    const dose = lookup(at);
    return { kind: 'NEW_INSULIN', warning: live, remote: dose?.remote ?? false, at, units: live.code === 'RECENT_BOLUS' ? numberOf(parts.at(-1)) : dose?.units ?? null };
  }
  const at = live.code === 'ALREADY_SENT_FOR_MEAL' ? (parts[0] === 'command' ? parts.slice(2).join(':') || null : null) : parts.join(':') || null;
  return { kind: 'NEW_INSULIN', warning: live, remote: true, at, units: lookup(at)?.units ?? null };
}

/** A warning of a code not acknowledged at all: refused; said as new insulin or a glucose drop when it is one. */
function newWarning(live: WarningLike, acknowledgedKeys: readonly string[], options: WarningChangeOptions): Worsening {
  if (LOOP_INSULIN_CODES.has(live.code) || REMOTE_INSULIN_CODES.has(live.code)) return insulinOf(live, options);
  if (GLUCOSE_CODES.has(live.code)) {
    // Another glucose warning than the acknowledged one (GLUCOSE_FALLING_OR_LOW at 75, now LOW_GLUCOSE at 68).
    const before = acknowledgedKeys.filter((key) => GLUCOSE_CODES.has(warningCode(key))).map(keyGlucose).find((value) => value !== null) ?? null;
    if (before !== null) return { kind: 'GLUCOSE_DROP', warning: live, before, after: keyGlucose(live.key) };
  }
  return { kind: 'NEW_WARNING', warning: live };
}

/** Null when the live warning is not worse than the acknowledged key of its code; else how it got worse. */
function compare(live: WarningLike, acknowledged: string, options: WarningChangeOptions): Worsening | null {
  const code = live.code;
  const drop = WARNING_CHANGE_POLICY.worse_drop_mgdl;
  if (SAME_CODE_PASSES.has(code)) return null;
  if (GLUCOSE_CODES.has(code)) {
    const before = keyGlucose(acknowledged);
    const after = keyGlucose(live.key);
    if (before === null || after === null) return { kind: 'GLUCOSE_DROP', warning: live, before, after };
    if (code === 'INSULIN_WHILE_LOW') {
      const was = LOW_LEVEL_RANK[partsOf(acknowledged)[0] ?? ''];
      const now = LOW_LEVEL_RANK[partsOf(live.key)[0] ?? ''];
      if (was === undefined || now === undefined || now > was) return { kind: 'GLUCOSE_DROP', warning: live, before, after };
    }
    return before - after >= drop ? { kind: 'GLUCOSE_DROP', warning: live, before, after } : null;
  }
  if (code === 'DOSE_LINE_LOW') {
    const was = lineKey(acknowledged);
    const now = lineKey(live.key);
    const worse = was.dose === null || was.dose !== now.dose
      || (was.band !== now.band && now.band === 'BELOW_70')
      || (was.band !== 'BELOW_100' && was.band !== 'BELOW_70')
      || was.min === null || now.min === null || was.min - now.min >= drop;
    return worse ? { kind: 'FORECAST_DROP', warning: live, before: was.min, after: now.min } : null;
  }
  if (code === 'DOSE_ABOVE_PROPOSALS' || code === 'DOSE_ABOVE_CALCULATOR') {
    const [wasDose, wasReference] = partsOf(acknowledged).map((part) => numberOf(part));
    const [nowDose, nowReference] = partsOf(live.key).map((part) => numberOf(part));
    const worse = wasDose === null || wasDose !== nowDose || wasReference === null || nowReference === null || nowReference < wasReference - 1e-9;
    return worse ? { kind: 'FORECAST_DROP', warning: live, before: null, after: null } : null;
  }
  if (code === 'RECENT_INSULIN' || code === 'RECENT_BOLUS') {
    const wasUnits = numberOf(partsOf(acknowledged).at(-1));
    const nowUnits = numberOf(partsOf(live.key).at(-1));
    if (middleOf(acknowledged) !== middleOf(live.key) || wasUnits === null || nowUnits === null) {
      const given = insulinOf(live, options);
      // RECENT_INSULIN holds only the window's total: without the newest dose in the context, what the total grew by.
      const grew = wasUnits !== null && nowUnits !== null && nowUnits > wasUnits + 1e-9 ? round2(nowUnits - wasUnits) : null;
      return { ...given, units: given.units ?? grew };
    }
    // The same newest dose and a higher total (or bolus): more insulin than acknowledged.
    return nowUnits > wasUnits + 1e-9 ? { ...insulinOf(live, options), units: round2(nowUnits - wasUnits) } : null;
  }
  // Another remote command than the acknowledged one.
  if (REMOTE_INSULIN_CODES.has(code)) return insulinOf(live, options);
  // Any other code: the exact key (already not matched).
  return { kind: 'NEW_WARNING', warning: live };
}

export interface WarningChangeOptions {
  /**
   * The dose given or sent at this ISO time (the live context's remote commands, boluses and SMBs); `remote`: a remote
   * command Mellis sent (said as "wysłano inny zdalny bolus", not as the loop's dose).
   */
  dose_at?: (atIso: string) => { units: number; remote: boolean } | null;
}

/**
 * The live warnings that got worse since the acknowledged ones (empty: the command may go). A live warning passes when
 * its exact key was acknowledged, or when it is not worse than some acknowledged key of its code.
 */
export function worsenedWarnings(live: readonly WarningLike[], acknowledgedKeys: readonly string[], options: WarningChangeOptions = {}): Worsening[] {
  const exact = new Set(acknowledgedKeys);
  const byCode = new Map<string, string[]>();
  for (const key of acknowledgedKeys) {
    const code = warningCode(key);
    byCode.set(code, [...(byCode.get(code) ?? []), key]);
  }
  const worse: Worsening[] = [];
  for (const warning of live) {
    if (exact.has(warning.key)) continue;
    const sameCode = byCode.get(warning.code) ?? [];
    if (sameCode.length === 0) {
      worse.push(newWarning(warning, acknowledgedKeys, options));
      continue;
    }
    const results = sameCode.map((key) => compare(warning, key, options));
    if (results.some((result) => result === null)) continue;
    worse.push(results[0]!);
  }
  return worse;
}

const KIND_ORDER: Record<Worsening['kind'], number> = { NEW_INSULIN: 0, GLUCOSE_DROP: 1, FORECAST_DROP: 2, NEW_WARNING: 3 };

function clock(iso: string, timeZone: string): string | null {
  const at = new Date(iso);
  if (!Number.isFinite(at.getTime())) return null;
  return new Intl.DateTimeFormat('pl-PL', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at);
}

function newWarningSentence(warning: WarningLike): string {
  return `Pojawiło się nowe ostrzeżenie: ${warning.message}`;
}

/** One sentence for one worsening, with its numbers; the warning's own text when the numbers are not known. */
function sentence(worse: Worsening, loop: LoopSystemNames, timeZone: string): string {
  switch (worse.kind) {
    case 'GLUCOSE_DROP':
      return worse.before !== null && worse.after !== null && worse.before - worse.after >= WARNING_CHANGE_POLICY.worse_drop_mgdl
        ? `W trakcie wysyłania glukoza wyraźnie spadła z ${Math.round(worse.before)} do ${Math.round(worse.after)} mg/dL.`
        : newWarningSentence(worse.warning);
    case 'FORECAST_DROP':
      return worse.before !== null && worse.after !== null && worse.after < worse.before
        ? `W trakcie wysyłania prognoza z tą dawką zeszła z ${Math.round(worse.before)} do ok. ${Math.round(worse.after)} mg/dL.`
        : newWarningSentence(worse.warning);
    case 'NEW_INSULIN': {
      const at = worse.at ? clock(worse.at, timeZone) : null;
      if (!at) return newWarningSentence(worse.warning);
      const units = worse.units !== null && worse.units > 0 ? ` ${formatUnits(worse.units)} j` : '';
      if (worse.remote) return `O ${at} wysłano inny zdalny bolus${units}.`;
      return `W trakcie wysyłania ${loop.nominative} ${agree(loop, { m: 'podał', f: 'podała', n: 'podało' })}${units || ' insulinę'} o ${at}.`;
    }
    case 'NEW_WARNING':
      return newWarningSentence(worse.warning);
  }
}

/**
 * The refusal's text after "REMOTE_COMMAND_WARNINGS_CHANGED: " (the contract with the app): one sentence for the most
 * important worsening (new insulin, then a glucose drop, then the forecast, then a new warning; a red one first within
 * each), and on a line of its own
 * the dashed line's minimum when the live warnings hold DOSE_LINE_LOW or INSULIN_WHILE_LOW and the minimum is known.
 */
export function warningsChangedReason(worse: readonly Worsening[], live: readonly WarningLike[], input: { loop: LoopSystemNames; line_min_mgdl?: number | null; time_zone?: string }): string {
  // In each kind the red (DANGER) warning first, then the order the warnings were drawn in.
  const danger = (item: Worsening) => (item.warning.severity === 'DANGER' ? 0 : 1);
  const first = [...worse].sort((left, right) => KIND_ORDER[left.kind] - KIND_ORDER[right.kind] || danger(left) - danger(right))[0];
  if (!first) return '';
  const why = sentence(first, input.loop, input.time_zone ?? 'Europe/Warsaw');
  // The chart's own minimum, else the one the live DOSE_LINE_LOW key holds.
  const keyLine = live.map((warning) => (warning.code === 'DOSE_LINE_LOW' ? lineKey(warning.key).min : null)).find((value) => value !== null) ?? null;
  const known = typeof input.line_min_mgdl === 'number' && Number.isFinite(input.line_min_mgdl) ? input.line_min_mgdl : keyLine;
  const line = known !== null ? Math.round(known) : null;
  const risky = live.some((warning) => warning.code === 'DOSE_LINE_LOW' || warning.code === 'INSULIN_WHILE_LOW');
  // The forecast sentence already names the line: the red line would only repeat it.
  if (first.kind === 'FORECAST_DROP') return why;
  return risky && line !== null ? `${why}\nZ tą dawką prognoza schodzi do ok. ${line} mg/dL.` : why;
}
