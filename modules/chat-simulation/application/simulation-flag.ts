/** Chat simulation tools (chat-simulation.v1). On unless CHAT_SIMULATION_ENABLED is 0/false/no/off. */
export function isChatSimulationEnabled(env: Record<string, string | undefined>): boolean {
  return !['0', 'false', 'no', 'off'].includes(String(env.CHAT_SIMULATION_ENABLED ?? '').trim().toLowerCase());
}
