/** "Wzorce" (therapy-patterns.v1): the nightly run, the pushes and the screen. On unless THERAPY_PATTERNS_ENABLED is 0/false/no/off. */
export function isTherapyPatternsEnabled(env: Record<string, string | undefined>): boolean {
  return !['0', 'false', 'no', 'off'].includes(String(env.THERAPY_PATTERNS_ENABLED ?? '').trim().toLowerCase());
}
