import { readBooleanFlag } from '@infra/config/environment';
import { isfToMgdl } from '@modules/glucose-forecast/application/isf-units';
import { readIcrWhatIfIntent } from './icr-whatif-intent';
import { scheduleAt, toMinutes, type ReplaySetting, type SettingChange } from './settings-replay';
import { formatSettingValue, SETTINGS_REPLAY_CARD_POLICY } from './settings-replay-card';

/**
 * SETTINGS_REPLAY_ENABLED: the chat answers named changes of basal, target, ISF and ICR with the settings replay on
 * Trio's logged decisions (settings-replay.v1, the same card as "Pod lupą"). Off by default; when off, ICR keeps the
 * older replay (SETTINGS_WHATIF_ENABLED).
 */
export function isSettingsReplayEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return readBooleanFlag(env, 'SETTINGS_REPLAY_ENABLED');
}

/** Optional ISO date of the planned check of the insulin effect, for the card's confidence line. */
export function settingsReplayCheckDate(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = env.SETTINGS_REPLAY_CHECK_DATE?.trim();
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

/** Metadata `policy` of the ask-first reply; its chips name the setting, so they are read like any message. */
export const SETTINGS_REPLAY_ASK_POLICY = 'SETTINGS_REPLAY_ASK';

/**
 * Reading a named settings change from a chat message (settings-replay-intent.v1), without a model call.
 * Understood (basal, target, ISF; ICR through the ICR reader):
 * - "Co jeśli baza o północy będzie 0,10 zamiast 0,05?", "baza 0–1 na 0,1", "bazę od 2 do 5 z 0,1 na 0,05";
 * - "cel w nocy 100", "cel na 120", "ISF w nocy z 190 na 170", "ISF 3:30 na 130";
 * - chip texts of the ask-first reply: "Baza 0:00–2:00 na 0,10".
 * A block is the explicit range, else the schedule block at the named hour, else the block with the named old value,
 * else the named time of day (narrowed to it when one block covers more), else the only block. Ambiguous → ask.
 */
export const SETTINGS_REPLAY_INTENT_VERSION = 'settings-replay-intent.v1';

export interface TherapySchedules {
  basal_u_per_h: Array<[string, number]> | null;
  carb_ratio_g_per_u: Array<[string, number]> | null;
  sensitivity_per_u: Array<[string, number]> | null;
  target_low_mgdl: Array<[string, number]> | null;
  units: string | null;
}

export type SettingsReplayIntent =
  | { kind: 'REPLAY'; change: SettingChange }
  | { kind: 'ASK'; message: string; chips: string[] };

const SETTING_WORDS: Array<[ReplaySetting, RegExp]> = [
  ['BASAL', /\b(baz[aeyo]\w*|bazal\w*|basal\w*)\b/],
  ['TARGET', /\b(cel|celu|celem|target\w*)\b/],
  ['ISF', /\b(isf|wrazliwos\w*)\b/],
];
const PARTS: Array<[string, RegExp, number, number]> = [
  ['w nocy', /\b(w\s+nocy|noc\w*|nocn\w*)\b/, 0, 360],
  ['rano', /\b(rano|rana|poran\w*)\b/, 360, 600],
  ['w dzień', /\b(w\s+dzien|w\s+ciagu\s+dnia|dzienn\w*|poludni\w*)\b/, 600, 1080],
  ['wieczorem', /\b(wieczor\w*)\b/, 1080, 1440],
];
const NUM = '(\\d+(?:[.,]\\d+)?)';
const TIME = '(\\d{1,2})(?::(\\d{2}))?';
const RANGE = new RegExp(`(?:\\bod\\s+)?\\b${TIME}\\s*(?:-|–|—|do)\\s*${TIME}\\b(?!\\s*(?:j|u|mg|%))`);
const AT_HOUR = new RegExp(`\\bo\\s+(?:godz\\w*\\s+)?${TIME}\\b`);
const MIDNIGHT = /\b(o\s+)?polnoc\w*\b/;
const FROM_TO = new RegExp(`\\bz\\s+${NUM}\\s+na\\s+${NUM}`);
const INSTEAD = new RegExp(`${NUM}\\s+zamiast\\s+${NUM}`);
const ARROW = new RegExp(`${NUM}\\s*(?:->|→|=>)\\s*${NUM}`);
const TO_ONLY = new RegExp(`\\b(?:na|bedzie|byla|bylo|wynosi\\w*)\\s+${NUM}(?!\\s*(?:-|–|:|do\\b))`);

function plain(text: string): string {
  return String(text ?? '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ł/g, 'l');
}
const parseNumber = (value: string) => Number(value.replace(',', '.'));
const hhmm = (minutes: number) => `${String(Math.floor(minutes / 60) % 24).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
const clockLabel = (minutes: number) => (minutes === 1440 ? '24:00' : hhmm(minutes).replace(/^0(\d):/, '$1:'));
const NAME: Record<ReplaySetting, string> = { BASAL: 'Baza', TARGET: 'Cel', ISF: 'ISF', ICR: 'ICR' };

interface Block { from: number; to: number; value: number }

function blocksOf(schedule: Array<[string, number]>, scale: (v: number) => number): Block[] {
  const sorted = [...schedule].map(([t, v]) => [toMinutes(t), scale(v)] as [number, number]).sort((a, b) => a[0] - b[0]);
  if (sorted.length === 0) return [];
  if (sorted[0][0] !== 0) sorted.unshift([0, sorted[sorted.length - 1][1]]);
  return sorted.map(([from, value], i) => ({ from, to: i + 1 < sorted.length ? sorted[i + 1][0] : 1440, value }));
}

function scheduleFor(setting: ReplaySetting, therapy: TherapySchedules): Block[] {
  if (setting === 'BASAL') return blocksOf(therapy.basal_u_per_h ?? [], (v) => v);
  if (setting === 'TARGET') return blocksOf(therapy.target_low_mgdl ?? [], (v) => v);
  if (setting === 'ISF') return blocksOf(therapy.sensitivity_per_u ?? [], (v) => isfToMgdl(v, therapy.units) ?? v);
  return blocksOf(therapy.carb_ratio_g_per_u ?? [], (v) => v);
}

function valueInRange(setting: ReplaySetting, value: number): boolean {
  const [min, max] = SETTINGS_REPLAY_CARD_POLICY.bounds[setting];
  return Number.isFinite(value) && value >= min && value <= max && (setting === 'BASAL' || value > 0);
}

/** Chip text of the ask-first reply for one block. */
function chip(setting: ReplaySetting, block: Block, value: number | null): string {
  const range = `${clockLabel(block.from)}–${clockLabel(block.to)}`;
  return value === null ? `${NAME[setting]} ${range}` : `${NAME[setting]} ${range} na ${formatSettingValue(setting, value).replace(/ (j\/h|mg\/dl)$/, '')}`;
}

/** The change a message names, or null (the chat answers as usual). */
export function readSettingsReplayIntent(message: string, therapy: TherapySchedules, options: { earlierUserMessages?: string[] } = {}): SettingsReplayIntent | null {
  const text = plain(message);
  const named = SETTING_WORDS.filter(([, re]) => re.test(text)).map(([s]) => s);
  if (named.length === 0) {
    // ICR keeps its own reader (times of day, proportions, ask-first chips); a single block becomes one change.
    const icr = readIcrWhatIfIntent(message, therapy.carb_ratio_g_per_u, { earlierUserMessages: options.earlierUserMessages });
    if (!icr || icr.kind !== 'REPLAY') return null;
    const block = icr.blocks[0];
    if (icr.scope.kind === 'ALL') return { kind: 'REPLAY', change: { setting: 'ICR', from: '00:00', to: '00:00', value: Math.round(scheduleAt(therapy.carb_ratio_g_per_u, 0)! * icr.ratio * 10) / 10 } };
    return { kind: 'REPLAY', change: { setting: 'ICR', from: block.start, to: block.end === '24:00' ? '00:00' : block.end, value: Math.round(block.value * icr.ratio * 10) / 10 } };
  }
  if (named.length > 1) return null;
  const setting = named[0];
  const blocks = scheduleFor(setting, therapy);
  if (blocks.length === 0) return null;

  // Values: new and (optionally) old.
  let newValue: number | null = null;
  let oldValue: number | null = null;
  const pair = FROM_TO.exec(text);
  const instead = INSTEAD.exec(text);
  const arrow = ARROW.exec(text);
  if (pair) { oldValue = parseNumber(pair[1]); newValue = parseNumber(pair[2]); }
  else if (instead) { newValue = parseNumber(instead[1]); oldValue = parseNumber(instead[2]); }
  else if (arrow) { oldValue = parseNumber(arrow[1]); newValue = parseNumber(arrow[2]); }
  else {
    const only = TO_ONLY.exec(text);
    if (only) newValue = parseNumber(only[1]);
  }

  // Time: explicit range, an hour, midnight, a time of day.
  let range: [number, number] | null = null;
  const textNoValues = text.replace(FROM_TO, ' ').replace(INSTEAD, ' ').replace(ARROW, ' ');
  const r = RANGE.exec(textNoValues);
  if (r) {
    const a = Number(r[1]) * 60 + Number(r[2] ?? 0);
    const b = Number(r[3]) * 60 + Number(r[4] ?? 0);
    if (a < 1440 && b <= 1440 && a !== b) range = [a, b === 0 ? 1440 : b];
  }
  let hour: number | null = null;
  if (!range) {
    const at = AT_HOUR.exec(textNoValues);
    if (at && Number(at[1]) < 24) hour = Number(at[1]) * 60 + Number(at[2] ?? 0);
    else if (MIDNIGHT.test(text)) hour = 0;
  }
  const part = PARTS.filter(([, re]) => re.test(text));

  let target: Block | null = null;
  let candidates: Block[] = blocks;
  if (range) {
    target = { from: range[0], to: range[1], value: blocks.find((b) => b.from <= range![0] && range![0] < b.to)?.value ?? blocks[0].value };
  } else if (hour !== null) {
    target = blocks.find((b) => b.from <= hour! && hour! < b.to) ?? null;
  } else if (oldValue !== null) {
    candidates = blocks.filter((b) => Math.abs(b.value - oldValue!) < 1e-6 + (setting === 'BASAL' ? 0.001 : 0.5));
    if (part.length === 1) candidates = candidates.filter((b) => b.from < part[0][3] && b.to > part[0][2]);
    if (candidates.length === 1) target = candidates[0];
  } else if (part.length === 1) {
    const [, , a, z] = part[0];
    candidates = blocks.filter((b) => b.from < z && b.to > a);
    if (candidates.length === 1) target = { from: Math.max(candidates[0].from, a), to: Math.min(candidates[0].to, z), value: candidates[0].value };
  } else if (blocks.length === 1) {
    target = blocks[0];
  }

  if (newValue === null) {
    // "cel w nocy 100": a single number left once the times are taken out.
    const rest = textNoValues.replace(RANGE, ' ').replace(AT_HOUR, ' ');
    const numbers = [...rest.matchAll(new RegExp(NUM, 'g'))].map((m) => parseNumber(m[1]));
    if (numbers.length === 1) newValue = numbers[0];
  }
  if (newValue === null) return null;
  if (!valueInRange(setting, newValue)) return null;
  if (!target) {
    if (candidates.length === 0) candidates = blocks;
    const list = candidates.map((b) => `${clockLabel(b.from)}–${clockLabel(b.to)} ${formatSettingValue(setting, b.value)}`).join(', ');
    return {
      kind: 'ASK',
      message: `${NAME[setting]} ma kilka przedziałów: ${list}. Który przeliczyć z wartością ${formatSettingValue(setting, newValue)}?`,
      chips: candidates.slice(0, 6).map((b) => chip(setting, b, newValue)),
    };
  }
  if (Math.abs(newValue - target.value) < 1e-9) return null;
  return { kind: 'REPLAY', change: { setting, from: hhmm(target.from), to: hhmm(target.to % 1440), value: newValue } };
}
