import { readBooleanFlag } from '@infra/config/environment';
import type { WhatIfScope } from './icr-whatif';

/** SETTINGS_WHATIF_ENABLED: the chat answers named ICR changes with the replay (true/1). Off by default. */
export function isSettingsWhatIfEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return readBooleanFlag(env, 'SETTINGS_WHATIF_ENABLED');
}

/** Metadata `policy` of this feature's ask-first reply; a chip tapped under it is read as a change. */
export const ICR_WHATIF_ASK_POLICY = 'SETTINGS_WHATIF_ASK';

/** Whether the latest assistant message before the user's one is this feature's ask-first reply. */
export function followsIcrWhatIfAsk(messages: Array<Record<string, unknown>>, userMessageId: string): boolean {
  const index = messages.findIndex((message) => String(message.id) === userMessageId);
  const before = (index >= 0 ? messages.slice(0, index) : messages).filter((message) => String(message.role ?? '') === 'ASSISTANT');
  const last = before[before.length - 1];
  return (last?.metadata as Record<string, unknown> | null | undefined)?.policy === ICR_WHATIF_ASK_POLICY;
}

/**
 * Reading a named ICR change from a chat message (icr-whatif-intent.v1), without a model call, and the ask-first reply
 * when the named value is not in the settings. The chips of that reply keep the user's proportion, and tapping one sends
 * its text back, which this reader understands too (only right after an ask-first reply).
 *
 * Understood:
 * - "Chcę zmienić ICR z 4 na 5", "przelicznik węglowodanów z 4 na 5": the blocks whose ICR is 4 now; none → ask first.
 * - "ICR rano na 6", "ICR rano z 5 na 6", "zmień ICR wieczorem na 8,5": the named time of day.
 * - "o 20% mniej insuliny" / "o 20% więcej insuliny" with ICR, optionally with a time of day; without one → all times.
 * - Chip texts: "Rano 5 → 6,3", "Wszystkie pory: 20% mniej insuliny", "Podam inną wartość".
 */
export const ICR_WHATIF_INTENT_VERSION = 'icr-whatif-intent.v1';

export type DayPart = 'NIGHT' | 'MORNING' | 'DAY' | 'EVENING';

export interface IcrBlock {
  start: string;
  end: string;
  value: number;
  part: DayPart;
}

export type IcrWhatIfIntent =
  | { kind: 'REPLAY'; scope: WhatIfScope; ratio: number; title: string; blocks: IcrBlock[] }
  | { kind: 'ASK_TIME'; message: string; chips: string[] }
  | { kind: 'ASK_VALUE'; message: string };

const PART_WORDS: Array<[DayPart, RegExp]> = [
  ['MORNING', /\b(rano|rana|ranne\w*|poran\w*|sniadani\w*)\b/],
  ['DAY', /\b(w\s+dzien|w\s+ciagu\s+dnia|dzienn\w*|obiad\w*|poludni\w*|w\s+szkole)\b/],
  ['EVENING', /\b(wieczor\w*|kolacj\w*)\b/],
  ['NIGHT', /\b(w\s+nocy|noc\w*|nocn\w*)\b/],
];

const PART_LABEL: Record<DayPart, string> = { MORNING: 'rano', DAY: 'w dzień', EVENING: 'wieczorem', NIGHT: 'w nocy' };
const PART_ORDER: DayPart[] = ['MORNING', 'DAY', 'EVENING', 'NIGHT'];

const ICR_WORDS = /\b(icr|cr|przelicznik\w*|carb\s+ratio|wspolczynnik\w*\s+weglowodan\w*|weglowodan\w*\s+na\s+jednostk\w*)\b/;
const OTHER_SETTING = /\b(isf|wrazliwos\w*|baz\w*|bazal\w*|cel\w*|target\w*|dia)\b/;
const NUMBER = '(\\d+(?:[.,]\\d+)?)';
const FROM_TO = new RegExp(`\\bz\\s+${NUMBER}\\s+(?:g\\S*\\s+)?na\\s+${NUMBER}`);
const ARROW = new RegExp(`${NUMBER}\\s*(?:->|→|=>|na)\\s*${NUMBER}`);
const TO_ONLY = new RegExp(`\\bna\\s+${NUMBER}\\b`);
const PERCENT = /(?:\bo\s+)?(\d+(?:[.,]\d+)?)\s*%\s*(mniej|wiecej)\s+insulin\w*/;

function plain(text: string): string {
  return String(text ?? '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ł/g, 'l');
}

const parseNumber = (value: string) => Number(value.replace(',', '.'));
const toMinutes = (time: string) => { const [h, m] = time.split(':').map(Number); return (h || 0) * 60 + (m || 0); };
const pl = (value: number) => (Math.round(value * 10) / 10).toString().replace('.', ',');
const clock = (time: string) => time.replace(/^0(\d):/, '$1:');

/** The current ICR schedule as blocks with their time of day (by each block's middle hour). */
export function icrBlocks(schedule: Array<[string, number]>): IcrBlock[] {
  const sorted = [...schedule].sort((a, b) => toMinutes(a[0]) - toMinutes(b[0]));
  return sorted.map(([start, value], index) => {
    const end = index + 1 < sorted.length ? sorted[index + 1][0] : sorted[0][0] === '00:00' ? '24:00' : sorted[0][0];
    let endMin = toMinutes(end);
    if (endMin <= toMinutes(start)) endMin += 24 * 60;
    const middle = ((toMinutes(start) + endMin) / 2 / 60) % 24;
    const part: DayPart = middle < 6 ? 'NIGHT' : middle < 10 ? 'MORNING' : middle < 18 ? 'DAY' : 'EVENING';
    return { start, end, value, part };
  });
}

function partOf(text: string): DayPart | null {
  const found = PART_WORDS.filter(([, re]) => re.test(text)).map(([part]) => part);
  return found.length === 1 ? found[0] : null;
}

function blockTitle(blocks: IcrBlock[], ratio: number): string {
  if (blocks.length === 1) {
    const b = blocks[0];
    return `ICR ${PART_LABEL[b.part]} ${pl(b.value)} → ${pl(b.value * ratio)}`;
  }
  return `ICR ${blocks.map((b) => `${pl(b.value)} → ${pl(b.value * ratio)}`).join(' · ')}`;
}

function scopeFor(blocks: IcrBlock[], all: IcrBlock[]): WhatIfScope {
  if (blocks.length === all.length) return { kind: 'ALL' };
  return blocks.length === 1 ? { kind: 'BLOCK', start: blocks[0].start } : { kind: 'BLOCKS', starts: blocks.map((b) => b.start) };
}

/** "20% mniej insuliny" for a ratio of 1.25. */
function insulinChange(ratio: number): string {
  const percent = Math.round(Math.abs(1 - 1 / ratio) * 100);
  return `${percent}% ${ratio > 1 ? 'mniej' : 'więcej'} insuliny`;
}

function askTime(oldValue: number, newValue: number, all: IcrBlock[]): IcrWhatIfIntent {
  const ratio = newValue / oldValue;
  const ordered = PART_ORDER.flatMap((part) => all.filter((b) => b.part === part));
  const list = ordered.map((b) => `${PART_LABEL[b.part]} ${pl(b.value)} (${clock(b.start)}–${clock(b.end)})`).join(', ');
  const message = `W ustawieniach nie ma ICR ${pl(oldValue)}. Obecnie: ${list}. Którą porę przeliczyć o tę samą proporcję co ${pl(oldValue)} → ${pl(newValue)}?`;
  const chips = [
    ...ordered.map((b) => `${PART_LABEL[b.part][0].toUpperCase()}${PART_LABEL[b.part].slice(1)} ${pl(b.value)} → ${pl(b.value * ratio)}`),
    `Wszystkie pory: ${insulinChange(ratio)}`,
    'Podam inną wartość',
  ];
  return { kind: 'ASK_TIME', message, chips };
}

function replay(blocks: IcrBlock[], all: IcrBlock[], ratio: number, title?: string): IcrWhatIfIntent | null {
  if (blocks.length === 0 || !(ratio > 0) || Math.abs(ratio - 1) < 1e-9) return null;
  return { kind: 'REPLAY', scope: scopeFor(blocks, all), ratio, title: title ?? (blocks.length === all.length && all.length > 1 ? `Wszystkie pory: ${insulinChange(ratio)} na węgle` : blockTitle(blocks, ratio)), blocks };
}

/**
 * The ICR change a message names, or null when it names none (the chat answers as usual). `afterAsk`: the previous
 * answer was this feature's ask-first reply, so a bare chip text counts.
 */
export function readIcrWhatIfIntent(
  message: string,
  schedule: Array<[string, number]> | null,
  options: { afterAsk?: boolean; earlierUserMessages?: string[] } = {},
): IcrWhatIfIntent | null {
  if (!schedule || schedule.length === 0) return null;
  const text = plain(message);
  const all = icrBlocks(schedule);
  // A follow-up such as "A co jakby go zmienić na 5,5?" after "Jaki mamy ICR na śniadanie?": the setting and the time
  // of day come from the caregiver's previous messages (newest first) when this one names a value but not the setting.
  const earlier = (options.earlierUserMessages ?? []).slice(0, 2).map(plain);
  const namesValue = FROM_TO.test(text) || ARROW.test(text) || TO_ONLY.test(text) || PERCENT.test(text);
  const followUp = !ICR_WORDS.test(text) && namesValue && !OTHER_SETTING.test(text) && earlier.some((m) => ICR_WORDS.test(m));
  const mentionsIcr = ICR_WORDS.test(text) || followUp;
  if (!mentionsIcr && !options.afterAsk) return null;
  if (!mentionsIcr && OTHER_SETTING.test(text)) return null;

  if (options.afterAsk && /\bpodam\s+inna\s+wartosc\b/.test(text)) {
    return { kind: 'ASK_VALUE', message: 'Napisz, na ile zmienić ICR i o której porze, np. „ICR rano z 5 na 6”. Przeliczę to na posiłkach z ostatnich 31 dni.' };
  }

  const part = partOf(text) ?? (followUp ? earlier.map(partOf).find((p): p is DayPart => p !== null) ?? null : null);
  const partBlocks = part ? all.filter((b) => b.part === part) : [];

  const percent = PERCENT.exec(text);
  if (percent) {
    const p = parseNumber(percent[1]) / 100;
    if (!(p > 0 && p < 1)) return null;
    const ratio = percent[2] === 'mniej' ? 1 / (1 - p) : 1 / (1 + p);
    if (/\bwszystkie\s+pory\b|\bcal\w*\s+dob\w*/.test(text) || !part) return replay(all, all, ratio);
    return replay(partBlocks, all, ratio);
  }

  const pair = FROM_TO.exec(text) ?? ARROW.exec(text);
  if (pair) {
    const oldValue = parseNumber(pair[1]);
    const newValue = parseNumber(pair[2]);
    if (!(oldValue > 0 && newValue > 0)) return null;
    if (part) {
      const exact = partBlocks.filter((b) => Math.abs(b.value - oldValue) < 0.051);
      if (exact.length > 0) return replay(exact, all, newValue / oldValue);
      return askTime(oldValue, newValue, all);
    }
    const matching = all.filter((b) => Math.abs(b.value - oldValue) < 0.051);
    return matching.length > 0 ? replay(matching, all, newValue / oldValue) : askTime(oldValue, newValue, all);
  }

  const target = TO_ONLY.exec(text);
  if (target && partBlocks.length === 1) {
    const newValue = parseNumber(target[1]);
    return newValue > 0 ? replay(partBlocks, all, newValue / partBlocks[0].value) : null;
  }
  return null;
}
