/**
 * Glucose rules every module shares (owner decision 2026-10-26): one meaning of "falling fast" and of a current
 * reading for the AI's text checks, the cards, the forecasts, reminders and commands.
 */

/** Falling fast: at least this many mg/dL per minute down (Nightscout's single arrow down, -10 mg/dL in 5 min). */
export const FALLING_FAST_MGDL_PER_MIN = -2;

/** A reading at most this old (minutes, two missed CGM readings) is the current glucose for advice and doses. */
export const CURRENT_READING_MAX_AGE_MINUTES = 15;

/** Time in range "very low": below this (mg/dL). The app's choice (2026-10-26), one value for the AI and the dashboard. */
export const TIR_VERY_LOW_BELOW_MGDL = 55;
