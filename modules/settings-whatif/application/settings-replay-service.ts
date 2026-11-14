import { isfToMgdl } from '@modules/glucose-forecast/application/isf-units';
import type { WhatIfData } from './icr-whatif';
import { buildSettingsReplayCard, type SettingsReplayCard } from './settings-replay-card';
import { scheduleAt, toMinutes, type ReplayWindow, type SettingChange } from './settings-replay';
import { placeWindow, replayChecked } from './settings-search';

/**
 * One entry point for a card: the chat, the −/+ on the card and "Pod lupą" all call this, so a value checked by hand
 * and one found by the search are counted the same way (settings-replay.v1 + settings-replay-card.v1).
 */

const hhmm = (minutes: number) => `${String(Math.floor(minutes / 60) % 24).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

/** The current value of the changed setting at the start of its block, in the units of the change. */
export function currentSettingValue(data: WhatIfData, change: Pick<SettingChange, 'setting' | 'from'>): number | null {
  const therapies = [...data.therapies].sort((a, b) => (a.from_ms ?? 0) - (b.from_ms ?? 0));
  const current = therapies[therapies.length - 1];
  if (!current) return null;
  const at = toMinutes(change.from);
  if (change.setting === 'BASAL') return scheduleAt(current.basal_u_per_h, at);
  if (change.setting === 'TARGET') return scheduleAt(current.target_low_mgdl ?? null, at);
  if (change.setting === 'ICR') return scheduleAt(current.carb_ratio_g_per_u, at);
  return isfToMgdl(scheduleAt(current.sensitivity_per_u, at), current.units);
}

/**
 * The window a change is counted in: the block of the current ICR schedule the change starts in, plus 4 h after it
 * (as a place in "Pod lupą"); a whole-day change counts the whole day.
 */
export function windowForChange(data: WhatIfData, change: Pick<SettingChange, 'from' | 'to'>): ReplayWindow {
  if (change.from === change.to) return { from: '00:00', to: '00:00' };
  const therapies = [...data.therapies].sort((a, b) => (a.from_ms ?? 0) - (b.from_ms ?? 0));
  const icr = therapies[therapies.length - 1]?.carb_ratio_g_per_u ?? [['00:00', 0]];
  const starts = [...new Set(icr.map(([t]) => toMinutes(t)))].sort((a, b) => a - b);
  if (starts[0] !== 0) starts.unshift(0);
  const at = toMinutes(change.from);
  let index = 0;
  starts.forEach((s, i) => { if (s <= at) index = i; });
  const from = starts[index];
  const to = index + 1 < starts.length ? starts[index + 1] : 1440;
  return placeWindow({ from: hhmm(from), to: hhmm(to) });
}

export type SettingsReplayCardResult =
  | { status: 'OK'; card: SettingsReplayCard }
  | { status: 'NO_TRIO_CYCLES' | 'NO_SETTINGS' | 'TOO_FEW_DAYS' | 'NO_CURRENT_VALUE' | 'OUT_OF_RANGE' | 'CONFLICTING_CHANGES' };

export function settingsReplayCard(data: WhatIfData, change: SettingChange, options: { check_date: string | null; window?: ReplayWindow }): SettingsReplayCardResult {
  const now = currentSettingValue(data, change);
  if (now === null) return { status: 'NO_CURRENT_VALUE' };
  if (!(change.value >= 0) || (change.setting !== 'BASAL' && !(change.value > 0))) return { status: 'OUT_OF_RANGE' };
  const checked = replayChecked(data, change, options.window ?? windowForChange(data, change));
  if (!('main' in checked)) return { status: checked.status };
  return { status: 'OK', card: buildSettingsReplayCard({ checked, change, now_value: now, check_date: options.check_date }) };
}
