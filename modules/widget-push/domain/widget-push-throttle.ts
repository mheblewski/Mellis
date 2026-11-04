/**
 * When a WidgetKit push goes out (widget-push.v1): every new reading, so the complication never waits for watchOS's own
 * schedule (a small change waited 2 min, 2026-11-04). Apple gives each widget a push budget of unknown size; the
 * timeline stays the fallback when it runs out, and the log lines show how far it goes.
 */

export type GlucoseLevel = 'urgent_low' | 'low' | 'in_range' | 'high' | 'very_high';

/** Below 54 urgent, below 70 low, 70–180 in range, 181–250 high, above 250 very high (mg/dL). */
export function glucoseLevel(valueMgdl: number): GlucoseLevel {
  if (valueMgdl < 54) return 'urgent_low';
  if (valueMgdl < 70) return 'low';
  if (valueMgdl <= 180) return 'in_range';
  if (valueMgdl <= 250) return 'high';
  return 'very_high';
}

/** At most one push per token in this window, for all its patients together (entering <54 excepted). */
export const WIDGET_PUSH_TOKEN_MIN_INTERVAL_MS = 4 * 60_000;

export type WidgetPushReason = 'first' | 'urgent_low' | 'level_change' | 'new_reading';
export type WidgetSkipReason = 'same_reading' | 'older_reading' | 'token_cap';

export interface WidgetPushStateSnapshot {
  /** The last reading decided on (pushed or skipped as not worth it). */
  last_reading_at: string | null;
  /** What the last push for this token+patient showed. */
  last_pushed_at: string | null;
  last_value: number | null;
  last_level: string | null;
}

export type WidgetPushDecision =
  | { push: true; reason: WidgetPushReason; level: GlucoseLevel; priority: 5 | 10 }
  | { push: false; reason: WidgetSkipReason; level: GlucoseLevel };

export function decideWidgetPush(input: {
  reading: { at: string; value: number };
  /** Null before the first decision for this token+patient. */
  state: WidgetPushStateSnapshot | null;
  /** The token's last push for any of its patients. */
  tokenLastPushedAt: string | null;
  now: Date;
}): WidgetPushDecision {
  const { reading, state, now } = input;
  const level = glucoseLevel(reading.value);
  const readingMs = Date.parse(reading.at);
  const lastReadingMs = state?.last_reading_at ? Date.parse(state.last_reading_at) : NaN;
  if (Number.isFinite(lastReadingMs)) {
    if (readingMs === lastReadingMs) return { push: false, reason: 'same_reading', level };
    if (readingMs < lastReadingMs) return { push: false, reason: 'older_reading', level };
  }

  const lastPushedMs = state?.last_pushed_at ? Date.parse(state.last_pushed_at) : NaN;
  let reason: WidgetPushReason;
  if (level === 'urgent_low' && state?.last_level !== 'urgent_low') reason = 'urgent_low';
  else if (!state || !Number.isFinite(lastPushedMs)) reason = 'first';
  else if (level !== state.last_level) reason = 'level_change';
  else reason = 'new_reading';

  if (reason !== 'urgent_low') {
    const tokenLastMs = input.tokenLastPushedAt ? Date.parse(input.tokenLastPushedAt) : NaN;
    if (Number.isFinite(tokenLastMs) && now.getTime() - tokenLastMs < WIDGET_PUSH_TOKEN_MIN_INTERVAL_MS) {
      return { push: false, reason: 'token_cap', level };
    }
  }
  return { push: true, reason, level, priority: reason === 'urgent_low' ? 10 : 5 };
}
