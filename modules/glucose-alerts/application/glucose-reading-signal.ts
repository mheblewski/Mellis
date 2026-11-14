/**
 * In-process signal from the Nightscout sync to the glucose push timer (glucose-push-fast, 2026-11-14): a sync stored
 * a new reading and the rescue carb alert has judged it, so the glucose push need not wait for the next minute or for
 * the reading to be 60 s old. Measured before: a low came 79 s after its reading, other kinds 20 s, and 10-70 s
 * depending on where the minute tick fell.
 *
 * `rescueJudgedAt` is when the rescue evaluation that saw the stored reading started (or now, where rescue alerts do not
 * run): a reading observed at or before it was judged by the rescue alert already.
 */
export type GlucoseReadingListener = (rescueJudgedAt: Date) => void;

const listeners = new Set<GlucoseReadingListener>();

export const glucoseReadingSignal = {
  notify(rescueJudgedAt: Date): void {
    for (const listener of listeners) listener(rescueJudgedAt);
  },
  subscribe(listener: GlucoseReadingListener): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },
};
