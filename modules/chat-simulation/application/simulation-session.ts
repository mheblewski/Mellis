import type { AiRuntimeToolDefinition } from '@modules/ai-gateway/domain/ai-gateway';
import type { WhatIfData } from '@modules/settings-whatif/application/icr-whatif';
import type { SettingsReplayCard } from '@modules/settings-whatif/application/settings-replay-card';
import { CHAT_SIMULATION_POLICY, SIMULATION_TOOL_DEFINITIONS, SIMULATION_TOOL_NAMES, type SimulationOutput, type SimulationToolName } from './simulation-tools';
import { runSimulationOffThread } from './simulation-thread';

/** What the AI gateway needs from a tool session: rules, tools, a call budget, and the calls. */
export interface ChatSimulationTools {
  readonly instructions: string;
  readonly definitions: AiRuntimeToolDefinition[];
  readonly maxCalls: number;
  call(toolName: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export interface SimulationDataStore {
  /** Readings, doses, profiles and the logged Trio decisions (with their forecasts) of the last `days` days. */
  loadReplayData(patientId: string, endIso: string, days: number, timeZone: string): Promise<WhatIfData>;
  /** The same without the Trio log (periods only; light for long ranges). */
  loadHistory(patientId: string, endIso: string, days: number, timeZone: string): Promise<WhatIfData>;
}

export const CHAT_SIMULATION_SESSION_POLICY = {
  maxCallsPerAnswer: 6,
  /** All tool time of one answer (the job's lease is 5 min; the model's turns need the rest). */
  answerBudgetMs: 150_000,
  /** One call, at most. */
  callLimitMs: 120_000,
  /** Loaded data stays for follow-up questions of the same patient. */
  cacheMs: 15 * 60_000,
} as const;
const S = CHAT_SIMULATION_SESSION_POLICY;

export const CHAT_SIMULATION_INSTRUCTIONS = [
  'SYMULACJE (chat-simulation.v1). The rules of this block (EXPLANATIONS, WORDS, RULES below) apply only to an answer about a replay or a settings or dosing-rule change; a dose for now, a card or the cause of a low follow the other rules of this prompt. The tools load the weeks they replay themselves, also where other rules say the patient\'s history is not loaded. You can replay this patient\'s real last weeks with changed Trio settings (simulate_settings: one to four changes at once), with a changed way of dosing meal boluses (simulate_dose_rule), compare two periods of real data (compare_periods), and search one-step changes for some hours (find_one_step).',
  'WHEN: every time the caregiver asks what a settings or dosing change would do ("co by było, gdyby…", "czy pomogłoby…", "a gdyby ICR wieczorem 7,5?", "co zmienić, żeby…"), proposes a value, asks why a period was better or worse, or when you are about to say what a change would do. Never estimate an effect yourself; never answer such a question without a tool result.',
  'HOW, like an analyst: 1) Turn the question into concrete changes (current values and blocks from get_therapy_profile when needed). "Trochę więcej/mniej" = one step: ICR ±0,5 g/j, ISF ±10, basal ±0,05 j/h, target ±10. Name the hours you used. 2) Run it. 3) Iterate in the same answer, do not just offer to: when a result trades lows for highs, run one or two alternatives before answering (a gentler value; another lever for the same hours; for a dosing rule the conditional ones — FOLLOW_UP_SKIP_WHEN_FALLING, FOLLOW_UP_MINUS_IOB — or the rule limited to the hours where the lows are), then compare them in a small table; "why was it better/worse" → compare_periods first (habits as well as settings: meal sizes, split doses, bolus timing); "kolejna porcja", "bolus wcześniej" → simulate_dose_rule. 4) Stop when the answer is clear.',
  'ANSWER: lows first — if lows (minutes under 70 or days under 54) get worse at either effect level, say it in the first sentence. Say now → after as a range between the measured effect and the full model effect ("poniżej 70: 725 → 510–585 min w 25 dniach"), the days counted, and the reading of the tool\'s direction fields (never compare numbers yourself). Mention the robustness check only when its direction differs.',
  'CARD: a result with card_shown: true is already on screen as a card above your text (now → after at the full model effect, days and minutes per range, −/+ for other values). Then do not repeat its numbers and give no table for it: write 2–3 sentences — the conclusion (lows first), what the card does not show (the hours counted; that with the measured effect the difference is smaller, with the measured-effect numbers for the range that matters most), and the limits sentence. Several variants tried → one small Markdown table with a header row and a |---| line (wariant | poniżej 70 | poniżej 54 (dni) | powyżej 180 | powyżej 250), first row "teraz" with the current value, numbers short ("550–610"); the card stays for the first variant.',
  'EXPLANATIONS: the replay shows what a change would have done, not why lows or highs happen. Never "bierze się z", "przyczyną jest", "najbardziej prawdopodobne jest": an explanation is said as "pasuje do danych" with the number from a tool result that fits it, and only when you have that number; otherwise leave it out.',
  'WORDS: "spadki poniżej 70", "poniżej 54", "czas powyżej 180/250"; the current settings are "teraz" — not "real", "wysoko", "nisko", "niedocukrzenie", "hipoglikemia", "hiperglikemia", "SMB" (say "mikrobolusy pętli"). Mellis speaks impersonally about its own work ("Przeliczone na 25 dniach", "W przeliczeniu…"), never "liczyłam/liczyłem". Short: the result first, then the table or 2–4 lines, then one sentence of limits.',
  'LIMITS, one sentence each time: the replay changes only what the loop and the doses would do on days that already happened — meals, habits and new lows stay untreated as they were — so it shows a direction, not a promise.',
  'RULES: numbers only from tool results. A tested value may be named as tested; never "zmień na X", never that a change will work: whether to change a setting is for the diabetes clinic ("do omówienia z poradnią"). Never a dose in units for a meal; dosing is discussed as a rule. Never suggest skipping or restricting food. Polish, plain, short; "Mellis" is never declined. A tool status other than OK (NO_TRIO_CYCLES, TOO_FEW_DAYS, LIMIT_REACHED, BUDGET, TIME_LIMIT): say so in one sentence.',
].join('\n');

let cache: Array<{ key: string; at: number; data: WhatIfData }> = [];

/**
 * One answer's simulation tools. Data are loaded on the first call (and kept a few minutes for follow-ups); every call
 * runs in a worker thread with a time limit; a single-change settings replay leaves its card for the answer.
 */
export class ChatSimulationSession implements ChatSimulationTools {
  readonly instructions = CHAT_SIMULATION_INSTRUCTIONS;
  readonly definitions = SIMULATION_TOOL_DEFINITIONS;
  readonly maxCalls = S.maxCallsPerAnswer;
  private spentMs = 0;
  private card: SettingsReplayCard | null = null;

  constructor(private readonly deps: {
    patientId: string;
    timeZone: string;
    store: SimulationDataStore;
    checkDate: string | null;
    now?: () => number;
    log?: (event: Record<string, unknown>) => void;
  }) {}

  private nowMs(): number { return this.deps.now?.() ?? Date.now(); }

  private async data(kind: 'replay' | 'history', days: number): Promise<WhatIfData> {
    const key = `${this.deps.patientId}:${kind}:${days}`;
    const now = this.nowMs();
    cache = cache.filter((x) => now - x.at < S.cacheMs);
    const hit = cache.find((x) => x.key === key);
    if (hit) return hit.data;
    const endIso = new Date(now).toISOString();
    const data = kind === 'replay'
      ? await this.deps.store.loadReplayData(this.deps.patientId, endIso, days, this.deps.timeZone)
      : await this.deps.store.loadHistory(this.deps.patientId, endIso, days, this.deps.timeZone);
    // One replay set and one history per worker: the Trio log of 6 weeks is large.
    cache = [...cache.filter((x) => !x.key.includes(`:${kind}:`)), { key, at: now, data }];
    return data;
  }

  async call(toolName: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!SIMULATION_TOOL_NAMES.includes(toolName as SimulationToolName)) return { tool: toolName, status: 'INVALID_REQUEST', problem: 'Unknown tool.' };
    const name = toolName as SimulationToolName;
    if (this.spentMs >= S.answerBudgetMs) return { tool: name, status: 'BUDGET', note: 'No more simulation time in this answer: answer with what you have.' };
    const started = Date.now();
    try {
      let data: WhatIfData;
      if (name === 'compare_periods') {
        const earliest = [args.a_from, args.b_from].map(String).sort()[0];
        const days = Math.min(CHAT_SIMULATION_POLICY.maxPeriodDays, Math.max(14, Math.ceil((this.nowMs() - Date.parse(`${earliest}T00:00:00Z`)) / 86_400_000) + 2));
        data = await this.data('history', days);
      } else {
        const asked = Number(args.days ?? CHAT_SIMULATION_POLICY.defaultDays);
        const days = Math.min(CHAT_SIMULATION_POLICY.maxDays, Math.max(CHAT_SIMULATION_POLICY.defaultDays, Number.isFinite(asked) ? asked : CHAT_SIMULATION_POLICY.defaultDays));
        data = await this.data('replay', days);
      }
      const left = Math.min(S.callLimitMs, S.answerBudgetMs - this.spentMs);
      const out: SimulationOutput = await runSimulationOffThread({ kind: 'CHAT_SIMULATION', name, args, data, now_ms: this.nowMs(), check_date: this.deps.checkDate }, left);
      // The card is the caregiver's own question (the first single-change replay), not an alternative tried after it.
      const shown = out.card !== null && this.card === null;
      if (shown) this.card = out.card;
      this.deps.log?.({ event: 'chat_simulation', patient_id: this.deps.patientId, tool: name, status: out.result.status, ms: Date.now() - started });
      return { tool: name, ...out.result, ...('card_shown' in out.result ? { card_shown: shown } : {}) };
    } catch (error) {
      const timeLimit = error instanceof Error && error.message === 'REPLAY_TIME_LIMIT';
      this.deps.log?.({ event: 'chat_simulation_failed', patient_id: this.deps.patientId, tool: name, error: error instanceof Error ? error.message : String(error), ms: Date.now() - started });
      return { tool: name, status: timeLimit ? 'TIME_LIMIT' : 'UNAVAILABLE', note: timeLimit ? 'This simulation took too long: say so and answer with what you have.' : 'The simulation could not run now: say so in one sentence; give no numbers for it.' };
    } finally {
      this.spentMs += Date.now() - started;
    }
  }

  /** The card of the last single-change settings replay of this answer (its −/+ lets the caregiver try other values). */
  takeCard(): SettingsReplayCard | null {
    const card = this.card;
    this.card = null;
    return card;
  }
}
