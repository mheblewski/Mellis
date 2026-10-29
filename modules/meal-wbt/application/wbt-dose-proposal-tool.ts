import type { AiRuntimeToolDefinition } from '@modules/ai-gateway/domain/ai-gateway';
import { WBT_DOSE_BOUNDS, WBT_POLICY_VERSION, WBT_STANDARD_FACTOR, roundDownWbtUnits, standardWbtDose } from './wbt-policy';
import type { WbtSuggestionContext } from './wbt-suggestion.job';

/**
 * propose_wbt_dose: in a meal's WBT conversation (wbt-chat.v1), the model's way to offer another WBT dose than the one
 * proposed (or the caregiver's own). The dose becomes the meal's newest WBT suggestion: its card in the chat and the WBT
 * screen give it to Trio as this meal's WBT, through the same checks as the screen. Nothing is sent by the tool. The data
 * never block a dose: a dose below 90 mg/dL, above the usual bounds or after WBT insulin was given is a warning.
 */

export const PROPOSE_WBT_DOSE_TOOL_NAME = 'propose_wbt_dose';
export const WBT_DOSE_PROPOSAL_POLICY_VERSION = 'wbt-chat.v1';
/** One dose per answer; a corrected call replaces the answer's earlier dose. */
export const MAX_PROPOSE_WBT_DOSE_CALLS_PER_ANSWER = 2;
/** Above this a dose is surely a mistake (the loop's own maximum bolus is checked again when it is sent). */
const MAX_WBT_DOSE_U = 15;
/** Below this glucose (mg/dL) the screen's proposal gives no WBT insulin; here it is a warning. */
const LOW_GLUCOSE_MGDL = WBT_DOSE_BOUNDS.no_insulin_below_mgdl;
/** Personal cases shown to the model: the closest ones by WBT. */

export const PROPOSE_WBT_DOSE_TOOL_DEFINITION: AiRuntimeToolDefinition = {
  name: PROPOSE_WBT_DOSE_TOOL_NAME,
  description: 'Prepares the WBT (fat-protein) insulin card of this conversation\'s meal: the dose the caregiver gives from the app, sent to Trio as this meal\'s WBT after they confirm it with Face ID. Nothing is sent by this tool. The dose becomes the meal\'s current WBT proposal (the WBT screen shows it too). Returns PROPOSED with the card and the warnings of this dose (low glucose, above the usual bounds, WBT insulin already given); INVALID_REQUEST for a dose that cannot be given.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      insulin_u: { type: 'number', description: `The WBT insulin dose in units, as the caregiver named it or as you recommend it from meal_wbt (0-${MAX_WBT_DOSE_U}).` },
      reason: { type: 'string', description: 'One short Polish sentence for the card: why this dose (and why it differs from the earlier proposal, if it does).' },
    },
    required: ['insulin_u', 'reason'],
  },
};

export const WBT_DOSE_PROPOSAL_INSTRUCTIONS = [
  'WBT CONVERSATION: this conversation is about the WBT (fat and protein) insulin of one meal: meal_wbt in the context has the meal and its WBT, the ICR now, the standard dose (WBT × 10 / ICR × 30%), what was already given for this meal and the dose proposed now (meal_wbt.current_proposal, with its rationale). Use the newest glucose, trend, IOB and COB too.',
  'Talk the dose over: explain it from these data, answer the caregiver\'s questions and say plainly when the data speak for more or less. When the caregiver names another dose ("daj 0,5", "mniej", "o połowę"), or you recommend a different one, call propose_wbt_dose once with it: the card is the only way to give it from this chat. THE CAREGIVER\'S OWN DOSE COMES FIRST: prepare exactly that card, do not argue, and say the most important warning of the result once, in one plain sentence starting with "⚠️".',
  'Never use propose_bolus for WBT insulin in this conversation. When meal_wbt.already_given shows WBT insulin for this meal, say so before any further dose. After PROPOSED, say the dose in one sentence and that the caregiver gives it with the card (Trio, as this meal\'s WBT); never write that it was given or sent.',
].join('\n');

export interface WbtDoseProposalStore {
  insertChatSuggestion(args: { patientId: string; mealRecordId: string; conversationId: string; userMessageId: string; result: Record<string, unknown> }): Promise<{ id: string }>;
  discardChatSuggestionsForUserMessage(patientId: string, userMessageId: string): Promise<void>;
}

/** The port the AI gateway calls; one session per answer. */
export interface WbtDoseProposalTools {
  readonly instructions: string;
  propose(args: Record<string, unknown>): Promise<Record<string, unknown>>;
}

const units = roundDownWbtUnits;

/** The proposal the conversation starts from: the newest WBT suggestion of the meal (screen or chat). */
export interface WbtCurrentProposal {
  dose_units: number;
  rationale: string;
}

/** What the model sees of the meal's WBT (meal_wbt): the screen's data and the dose proposed now. */
export function mealWbtForAi(context: WbtSuggestionContext, current: WbtCurrentProposal | null): Record<string, unknown> {
  const fpu = context.meal.fat_protein_units;
  const standard = fpu && fpu > 0 && context.icr_g_per_u ? standardWbtDose(fpu, context.icr_g_per_u) : null;
  return {
    policy_version: WBT_POLICY_VERSION,
    meal: context.meal,
    icr_g_per_u: context.icr_g_per_u,
    standard_dose: standard ? { ...standard, factor: WBT_STANDARD_FACTOR } : null,
    current: context.current,
    already_given: context.already_given,
    current_proposal: current ? { dose_units: current.dose_units, rationale: current.rationale } : null,
  };
}

export class WbtDoseProposalSession implements WbtDoseProposalTools {
  readonly instructions = WBT_DOSE_PROPOSAL_INSTRUCTIONS;
  private proposed = false;

  /** A WBT card was prepared in this answer (the text is checked like a bolus card's: nothing "given"). */
  get used(): boolean {
    return this.proposed;
  }

  constructor(private readonly deps: {
    /** The asking phone has remote control (it can send the card to Trio); absent: assumed it can. */
    canSendToTrio?: boolean;
    patientId: string;
    mealRecordId: string;
    conversationId: string;
    userMessageId: string;
    store: WbtDoseProposalStore;
    context: WbtSuggestionContext;
    current: WbtCurrentProposal | null;
    nowIso: string;
  }) {}

  async propose(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const requested = typeof args.insulin_u === 'number' ? args.insulin_u : Number.NaN;
    if (!Number.isFinite(requested) || requested < 0 || requested > MAX_WBT_DOSE_U) {
      return { tool: PROPOSE_WBT_DOSE_TOOL_NAME, status: 'INVALID_REQUEST', problem: `insulin_u must be 0-${MAX_WBT_DOSE_U} units` };
    }
    const { context } = this.deps;
    const dose = units(requested);
    const reason = typeof args.reason === 'string' && args.reason.trim() ? args.reason.trim().slice(0, 300) : 'Dawka ustalona w rozmowie.';
    const warnings = this.warnings(dose);
    const icr = context.icr_g_per_u;
    const result = {
      policy_version: WBT_DOSE_PROPOSAL_POLICY_VERSION,
      provider: 'chat',
      generated_at: this.deps.nowIso,
      basis: 'CHAT',
      dose_units: dose,
      carbs_equivalent_g: icr ? Math.round(dose * icr) : null,
      rationale: reason,
      warnings,
      icr_g_per_u: icr,
      meal: context.meal,
      current: context.current,
      already_given: context.already_given,
      // Still read by the app's WBT screen (always empty: no earlier meals are used).
      history_cases_used: 0,
      history_cases: [],
    };
    // A corrected dose replaces the answer's earlier one: one card per answer.
    if (this.proposed) await this.deps.store.discardChatSuggestionsForUserMessage(this.deps.patientId, this.deps.userMessageId);
    await this.deps.store.insertChatSuggestion({
      patientId: this.deps.patientId,
      mealRecordId: this.deps.mealRecordId,
      conversationId: this.deps.conversationId,
      userMessageId: this.deps.userMessageId,
      result,
    });
    const replaced = this.proposed;
    this.proposed = true;
    return {
      tool: PROPOSE_WBT_DOSE_TOOL_NAME,
      status: 'PROPOSED',
      card: { insulin_u: dose, carbs_equivalent_g: result.carbs_equivalent_g },
      warnings,
      note: replaced ? 'This card replaces the dose prepared earlier in this answer.' : 'The card is ready: do not prepare it again.',
      ...(this.deps.canSendToTrio === false ? { note_phone: 'This phone has no remote control: the dose is shown on the WBT screen and the caregiver gives it in Trio themself. Say so; never "give it with the card".' } : {}),
    };
  }

  /** What the caregiver should know before giving this dose; never a block. */
  private warnings(dose: number): string[] {
    const { context } = this.deps;
    const warnings: string[] = [];
    const glucose = context.current.glucose_mgdl;
    if (dose > 0 && glucose !== null && glucose < LOW_GLUCOSE_MGDL) {
      warnings.push(`Glikemia ${Math.round(glucose)} mg/dL: poniżej ${LOW_GLUCOSE_MGDL} WBT zwykle się nie podaje.`);
    }
    // A reading older than 15 min (or none) is not the glucose now (the WBT screen proposes 0 then; here a warning).
    const asOf = context.current.as_of ? Date.parse(context.current.as_of) : Number.NaN;
    const age = Number.isFinite(asOf) ? Math.round((Date.parse(this.deps.nowIso) - asOf) / 60_000) : null;
    if (dose > 0 && (glucose === null || age === null || age > 15)) {
      warnings.push(glucose === null || age === null ? 'Brak aktualnej glikemii: sprawdź ją przed podaniem.' : `Ostatni odczyt glikemii jest sprzed ${age} min: sprawdź ją przed podaniem.`);
    }
    const given = context.already_given.wbt_insulin_units ?? 0;
    if (dose > 0 && (given > 0 || context.already_given.wbt_carbs_logged_g > 0)) {
      warnings.push(`Na WBT tego posiłku podano już ${given > 0 ? `${given} j` : `${context.already_given.wbt_carbs_logged_g} g WBT`}.`);
    }
    const fpu = context.meal.fat_protein_units;
    if (fpu && fpu > 0 && context.icr_g_per_u) {
      const standard = standardWbtDose(fpu, context.icr_g_per_u).dose_units;
      const ceiling = WBT_DOSE_BOUNDS.max_standard_multiple * standard;
      if (ceiling > 0 && dose > ceiling) warnings.push(`Dawka ponad dwa razy większa niż standardowa (${units(ceiling)} j).`);
    }
    return warnings;
  }
}
