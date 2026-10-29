/**
 * Which automated insulin delivery system runs the patient's loop, read from what it uploads to Nightscout
 * (the loop-support plan). The one place that knows how Trio, Loop and AAPS sign their device status, which
 * of them computes with oref (carbsReq, insulinReq, SMB limits) and how their names read in Polish texts.
 *
 * - Trio: `openaps` + `device: "Trio"`.
 * - AAPS: `openaps` + `device: "openaps://AndroidAPS…"`.
 * - OpenAPS rig or another oref uploader: `openaps` with any other device.
 * - Loop: `loop` (`device: "loop://<iPhone>"`).
 */

export type LoopSystemKind = 'TRIO' | 'AAPS' | 'OPENAPS' | 'LOOP' | 'UNKNOWN';

export interface LoopSystem {
  kind: LoopSystemKind;
  /** The system's version when it uploads one (Loop: `loop.version`); null otherwise. */
  version: string | null;
}

export const UNKNOWN_LOOP_SYSTEM: LoopSystem = { kind: 'UNKNOWN', version: null };

/** The system that uploaded one devicestatus; UNKNOWN when it carries no loop calculation (e.g. a pump-only record). */
export function detectLoopSystem(rawPayload: Record<string, unknown> | null | undefined): LoopSystem {
  if (!rawPayload) return UNKNOWN_LOOP_SYSTEM;
  const loop = asRecord(rawPayload.loop);
  if (loop) return { kind: 'LOOP', version: text(loop.version) };
  const openaps = asRecord(rawPayload.openaps);
  if (openaps) {
    const device = (text(rawPayload.device) ?? '').toLowerCase();
    if (device.startsWith('trio')) return { kind: 'TRIO', version: null };
    if (device.includes('androidaps')) return { kind: 'AAPS', version: null };
    return { kind: 'OPENAPS', version: null };
  }
  return UNKNOWN_LOOP_SYSTEM;
}

/** oref systems report carbsReq, insulinReq, SMB limits and separate curves; Loop reports one combined forecast. */
export function computesWithOref(kind: LoopSystemKind): boolean {
  return kind === 'TRIO' || kind === 'AAPS' || kind === 'OPENAPS';
}

/** How a remote command reaches the loop: Trio's encrypted push, or Loop's push with a one-time password. */
export type RemoteCommandDriver = 'TRIO' | 'LOOP';

/**
 * The driver for this system's remote commands; null when GlucoMind cannot send to it (AAPS runs on Android, an
 * OpenAPS rig has no push). UNKNOWN keeps Trio's: no recent device status must not switch off a Trio the caregiver set
 * up (the phone still checks the Trio it pinned in Nightscout before every command).
 */
export function remoteCommandDriver(kind: LoopSystemKind): RemoteCommandDriver | null {
  if (kind === 'TRIO' || kind === 'UNKNOWN') return 'TRIO';
  if (kind === 'LOOP') return 'LOOP';
  return null;
}

/** The system's name in the three forms Polish texts need: "Trio liczy", "w Trio", "do Trio" / "Loop liczy", "w Loopie", "do Loopa". */
export interface LoopSystemNames {
  nominative: string;
  locative: string;
  genitive: string;
  /** Grammatical gender, for the words that agree with the name: "Trio samo / przyjęło", "Loop sam / przyjął". */
  gender: 'm' | 'f' | 'n';
}

const NAMES: Record<LoopSystemKind, LoopSystemNames> = {
  TRIO: { nominative: 'Trio', locative: 'Trio', genitive: 'Trio', gender: 'n' },
  LOOP: { nominative: 'Loop', locative: 'Loopie', genitive: 'Loopa', gender: 'm' },
  AAPS: { nominative: 'AAPS', locative: 'AAPS', genitive: 'AAPS', gender: 'm' },
  OPENAPS: { nominative: 'OpenAPS', locative: 'OpenAPS', genitive: 'OpenAPS', gender: 'm' },
  UNKNOWN: { nominative: 'pętla', locative: 'pętli', genitive: 'pętli', gender: 'f' },
};

export function loopSystemNames(kind: LoopSystemKind): LoopSystemNames {
  return NAMES[kind];
}

/** The form that agrees with the system's name: agree(names, { m: 'sam', f: 'sama', n: 'samo' }). */
export function agree(names: LoopSystemNames, forms: Record<LoopSystemNames['gender'], string>): string {
  return forms[names.gender];
}

/** The name at the start of a sentence ("Pętla", "Trio"). */
export function capitalized(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/** The name the AI context and English prompts use ("the loop" when unknown). */
export function loopSystemLabel(kind: LoopSystemKind): string {
  return kind === 'UNKNOWN' ? 'the loop' : NAMES[kind].nominative;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
