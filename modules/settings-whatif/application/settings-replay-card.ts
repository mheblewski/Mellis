import type { CheckedReplay } from './settings-search';
import type { ReplaySetting, ReplayWindow, SettingChange, WindowOutcome } from './settings-replay';

/**
 * The card of a settings replay (settings-replay-card.v1), the same in the chat and in "Pod lupą" (mockups v3,
 * docs/product/settings-lupa-mockups-review-2.md): window header, one verdict line, the setting with −/+, four rows,
 * one confidence line and details that open in place. All text and rounding are done here, once.
 * Carried as a metric card of kind SETTING_REPLAY; older apps show no card for a kind they do not know.
 */
export const SETTINGS_REPLAY_CARD_VERSION = 'settings-replay-card.v1';

export const SETTINGS_REPLAY_CARD_POLICY = {
  /** A change smaller than this share and these minutes counts as "no change" in the verdict and the row colour. */
  same_share: 0.1,
  same_minutes: 30,
  steps: { BASAL: 0.05, TARGET: 5, ISF: 5, ICR: 0.5 } as Record<ReplaySetting, number>,
  bounds: { BASAL: [0, 1], TARGET: [80, 180], ISF: [20, 400], ICR: [2, 40] } as Record<ReplaySetting, [number, number]>,
} as const;

const C = SETTINGS_REPLAY_CARD_POLICY;

export interface NowAfter { now: number; after: number }
export type Tone = 'GAIN' | 'COST' | 'NONE';
export type RowKey = 'BELOW_54' | 'BELOW_70' | 'ABOVE_180_1H' | 'ABOVE_250';

export interface SettingsReplayCardRow {
  key: RowKey;
  /** "Poniżej 54", "Ponad 1 h powyżej 180" */
  label: string;
  days: NowAfter;
  minutes: NowAfter;
  /** "3 → 4 noce" (unit only in the first row), "9 → 11" */
  days_text: string;
  /** "75 → 235 min" */
  minutes_text: string;
  tone: Tone;
}

export interface SettingsReplayCard {
  version: string;
  setting: ReplaySetting;
  from: string;
  to: string;
  now_value: number;
  value: number;
  step: number;
  min: number;
  max: number;
  /** "Baza 0:00–1:00" */
  setting_label: string;
  /** "teraz 0,05 j/h · +0,05 j na godzinę" */
  now_label: string;
  /** "0,10 j/h" */
  value_label: string;
  window: ReplayWindow;
  /** "Noc 0:00–10:00 · 26 nocy" */
  window_label: string;
  days: number;
  /** One line, two parts with their own tone; a null part is left out. */
  verdict: { lows: { text: string; tone: Tone } | null; rises: { text: string; tone: Tone } | null; text: string };
  rows: SettingsReplayCardRow[];
  /** "Do 29.11 liczby pokazują tylko kierunek." */
  confidence: string;
  /** Lines under "Szczegóły". */
  details: string[];
  /** Lows did not grow (minutes and days below 70 and 54). */
  lows_not_worse: boolean;
  basis: 'TRIO_REPLAY';
}

const pl = (value: number, digits = 2) => {
  const rounded = Number(value.toFixed(digits));
  return String(rounded).replace('.', ',');
};
const fixed = (value: number, digits: number) => value.toFixed(digits).replace('.', ',');
const clock = (time: string) => (time === '00:00' ? '0:00' : time.replace(/^0(\d):/, '$1:'));
const dateLabel = (iso: string) => { const [, m, d] = iso.split('-').map(Number); return `${d}.${m}`; };

/** Polish plural: 1 noc, 2–4 noce, 5+ nocy (12–14 nocy). */
export function plural(n: number, one: string, few: string, many: string): string {
  const abs = Math.abs(Math.round(n));
  if (abs === 1) return one;
  const last = abs % 10;
  const lastTwo = abs % 100;
  return last >= 2 && last <= 4 && (lastTwo < 12 || lastTwo > 14) ? few : many;
}

const NAME: Record<ReplaySetting, string> = { BASAL: 'Baza', TARGET: 'Cel', ISF: 'ISF', ICR: 'ICR' };

export function formatSettingValue(setting: ReplaySetting, value: number): string {
  if (setting === 'BASAL') return `${fixed(value, 2)} j/h`;
  if (setting === 'TARGET') return `${Math.round(value)} mg/dl`;
  if (setting === 'ISF') return `${Math.round(value)}`;
  return pl(value, 1);
}

/** Whether the window is a night (starts between 21:00 and 3:00): counted in nights, else in days. */
function isNight(window: ReplayWindow): boolean {
  const [h] = window.from.split(':').map(Number);
  return h >= 21 || h < 3;
}

function windowName(window: ReplayWindow): string {
  const [h] = window.from.split(':').map(Number);
  const [hEnd] = window.to.split(':').map(Number);
  // An evening counted together with the night after it (night lows searched in the evening).
  if (h >= 17 && h < 21 && hEnd >= 6 && hEnd < 17) return 'Wieczór i noc';
  if (isNight(window)) return 'Noc';
  if (h < 9) return 'Rano';
  if (h < 17) return 'Dzień';
  return 'Wieczór';
}

const changed = (now: number, after: number) => Math.abs(after - now) >= Math.max(C.same_minutes, now * C.same_share);

/** Tone of a row from its minutes: lows fewer = gain, rises fewer = gain. */
function tone(now: number, after: number): Tone {
  if (!changed(now, after)) return 'NONE';
  return after < now ? 'GAIN' : 'COST';
}

export function buildSettingsReplayCard(args: {
  checked: CheckedReplay;
  change: SettingChange;
  now_value: number;
  /** ISO date of the planned check of the insulin effect, or null. */
  check_date: string | null;
}): SettingsReplayCard {
  const { main, half_effect: half, without_two_days: without } = args.checked;
  const { change } = args;
  const night = isNight(main.window);
  const dayWord = (n: number) => (night ? plural(n, 'noc', 'noce', 'nocy') : plural(n, 'dzień', 'dni', 'dni'));
  const a = main.now;
  const b = main.after;

  const rowsSpec: Array<{ key: RowKey; label: string; days: (o: WindowOutcome) => number; minutes: (o: WindowOutcome) => number }> = [
    { key: 'BELOW_54', label: 'Poniżej 54', days: (o) => o.days_below_54, minutes: (o) => o.minutes_below_54 },
    { key: 'BELOW_70', label: 'Poniżej 70', days: (o) => o.days_below_70, minutes: (o) => o.minutes_below_70 },
    { key: 'ABOVE_180_1H', label: 'Ponad 1 h powyżej 180', days: (o) => o.days_above_180_over_1h, minutes: (o) => o.minutes_above_180 },
    { key: 'ABOVE_250', label: 'Powyżej 250', days: (o) => o.days_above_250, minutes: (o) => o.minutes_above_250 },
  ];
  const rows = rowsSpec.map((spec, i): SettingsReplayCardRow => {
    const days = { now: spec.days(a), after: spec.days(b) };
    const minutes = { now: Math.round(spec.minutes(a)), after: Math.round(spec.minutes(b)) };
    return {
      key: spec.key,
      label: spec.label,
      days,
      minutes,
      days_text: `${days.now} → ${days.after}${i === 0 ? ` ${dayWord(days.after)}` : ''}`,
      minutes_text: `${minutes.now} → ${minutes.after} min`,
      tone: tone(minutes.now, minutes.after),
    };
  });

  const lowsTone = (() => {
    const t54 = tone(a.minutes_below_54, b.minutes_below_54);
    const t70 = tone(a.minutes_below_70, b.minutes_below_70);
    if (t54 === 'COST' || t70 === 'COST' || b.days_below_54 > a.days_below_54) return 'COST' as const;
    if (t54 === 'GAIN' || t70 === 'GAIN') return 'GAIN' as const;
    return 'NONE' as const;
  })();
  const risesTone = tone(a.minutes_above_180, b.minutes_above_180);
  const lowsPart = lowsTone === 'NONE' ? null : { text: lowsTone === 'GAIN' ? 'Mniej spadków' : 'Spadków przybywa', tone: lowsTone };
  const risesPart = risesTone === 'NONE' ? null : { text: risesTone === 'GAIN' ? 'krótsze wzrosty' : 'dłużej powyżej 180', tone: risesTone };
  const verdictText = lowsPart && risesPart
    ? `${lowsPart.text}, ${risesPart.text}.`
    : lowsPart ? `${lowsPart.text}.`
      : risesPart ? `${risesPart.text[0].toUpperCase()}${risesPart.text.slice(1)}.` : 'Bez wyraźnej zmiany.';

  const delta = change.value - args.now_value;
  let hint = '';
  if (change.setting === 'BASAL') hint = ` · ${delta >= 0 ? '+' : '−'}${fixed(Math.abs(delta), 2)} j na godzinę`;
  if (change.setting === 'ICR' && main.meal_dose_change_u !== null) {
    const du = main.meal_dose_change_u;
    hint = ` · ${du >= 0 ? '+' : '−'}${fixed(Math.abs(du), 2)} j na posiłek`;
  }
  const [min, max] = C.bounds[change.setting];

  const details: string[] = [];
  if (half) {
    details.push(`Przy połowie wpływu insuliny: poniżej 70 ${half.now.days_below_70} → ${half.after.days_below_70}, ponad godzinę powyżej 180 ${half.now.days_above_180_over_1h} → ${half.after.days_above_180_over_1h} (${night ? 'noce' : 'dni'}).`);
  }
  details.push(`Bez dwóch ${night ? 'nocy' : 'dni'}, które zmiana ruszyła najmocniej: poniżej 70 ${without.now.days_below_70} → ${without.after.days_below_70}, ponad godzinę powyżej 180 ${without.now.days_above_180_over_1h} → ${without.after.days_above_180_over_1h}.`);
  if (b.lowest_mgdl < a.lowest_mgdl - 4) {
    const after = b.lowest_mgdl <= 40 ? 'poniżej 40' : String(Math.round(b.lowest_mgdl));
    details.push(`Najniższa wartość: ${Math.round(a.lowest_mgdl)} → ${after} (${dateLabel(b.lowest_date)}).`);
  }
  details.push('Decyzje pętli odtworzone z zapisu Trio i rozstrzygnięte jeszcze raz przy zmienionym ustawieniu.');
  details.push('W przeliczeniu nikt nie podaje węgli na nowe spadki.');
  if (main.skipped.length > 0) {
    const clockChanges = main.skipped.filter((s) => s.reason === 'CLOCK_CHANGE').map((s) => dateLabel(s.date));
    const gaps = main.skipped.filter((s) => s.reason === 'LOW_COVERAGE').length;
    const parts = [clockChanges.length ? `${clockChanges.join(', ')} (zmiana czasu)` : '', gaps ? `${gaps} ${plural(gaps, night ? 'noc' : 'dzień', night ? 'noce' : 'dni', night ? 'nocy' : 'dni')} z przerwami w danych` : ''].filter(Boolean);
    details.push(`Bez: ${parts.join(', ')}.`);
  }
  const first = main.runs[0]?.date;
  const last = main.runs[main.runs.length - 1]?.date;
  if (first && last) details.push(`Policzono ${main.runs.length} ${dayWord(main.runs.length)}, ${dateLabel(first)}–${dateLabel(last)}.`);

  const confidence = args.check_date
    ? `Do ${dateLabel(args.check_date)} liczby pokazują tylko kierunek.`
    : 'Wpływu insuliny nie sprawdzono jeszcze na prawdziwej zmianie, liczby pokazują kierunek.';

  return {
    version: SETTINGS_REPLAY_CARD_VERSION,
    setting: change.setting,
    from: change.from,
    to: change.to,
    now_value: args.now_value,
    value: change.value,
    step: C.steps[change.setting],
    min,
    max,
    setting_label: `${NAME[change.setting]} ${clock(change.from)}–${clock(change.to === '00:00' ? '24:00' : change.to)}`,
    now_label: `teraz ${formatSettingValue(change.setting, args.now_value)}${hint}`,
    value_label: formatSettingValue(change.setting, change.value),
    window: main.window,
    window_label: `${windowName(main.window)} ${clock(main.window.from)}–${clock(main.window.to)} · ${main.runs.length} ${dayWord(main.runs.length)}`,
    days: main.runs.length,
    verdict: { lows: lowsPart, rises: risesPart, text: verdictText },
    rows,
    confidence,
    details,
    lows_not_worse: b.minutes_below_54 <= a.minutes_below_54 && b.minutes_below_70 <= a.minutes_below_70 && b.days_below_54 <= a.days_below_54 && b.days_below_70 <= a.days_below_70,
    basis: 'TRIO_REPLAY',
  };
}

/** Light structural check of a stored card. */
export function sanitizeSettingsReplayCard(value: unknown): SettingsReplayCard | null {
  if (typeof value !== 'object' || value === null) return null;
  const card = value as Record<string, unknown>;
  if (card.version !== SETTINGS_REPLAY_CARD_VERSION || typeof card.setting_label !== 'string' || typeof card.window_label !== 'string') return null;
  if (!Array.isArray(card.rows) || card.rows.length !== 4 || !Array.isArray(card.details)) return null;
  if (!Number.isFinite(card.value) || !Number.isFinite(card.now_value) || !Number.isFinite(card.step)) return null;
  return card as unknown as SettingsReplayCard;
}
