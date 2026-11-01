import type { AiRuntimeToolDefinition } from '@modules/ai-gateway/domain/ai-gateway';
import { hasRescueTreatment, type RescueAlertRecord } from './rescue-alert-policy';
import type { RescueCarbProposalRecord } from './rescue-carbs-store';
import { RESCUE_DOSE_POLICY } from './rescue-dose';
import { RESCUE_DETECTION_POLICY } from './rescue-detection';
import { readOptionKey, type AnswerOptionKey } from '@modules/ai-gateway/application/answer-options';

/**
 * propose_rescue_carbs: in a rescue alert's chat, the model's way to offer another rescue dose than the static one
 * (rescue-carbs.v1); in an ordinary conversation, a card for rescue carbs the caregiver says they gave (or will give).
 * The card's "Zatwierdź Y g" opens the same form as "Podano dosłodzenie"; nothing is logged or sent by the tool. Since
 * migration 064 confirming sends the carbs to the loop when the phone can (else GlucoMind only). One card per
 * option of the answer (answer-options.v1), so at most one without options.
 */

export const PROPOSE_RESCUE_CARBS_TOOL_NAME = 'propose_rescue_carbs';
export const RESCUE_CARB_PROPOSAL_POLICY_VERSION = 'rescue-carb-proposals.v8';
export const MAX_PROPOSE_RESCUE_CARBS_CALLS_PER_ANSWER = 3;
/** One portion, the same bound as the alert's push dose (owner decision 2026-10-26: 20 g everywhere, was 30 on cards). */
export const RESCUE_CARB_PROPOSAL_MAX_G = RESCUE_DOSE_POLICY.max_portion_g;
const URGENT_MGDL = RESCUE_DETECTION_POLICY.urgent_mgdl;

export const PROPOSE_RESCUE_CARBS_TOOL_DEFINITION: AiRuntimeToolDefinition = {
  name: PROPOSE_RESCUE_CARBS_TOOL_NAME,
  description: 'Prepares a card with a rescue carb dose (fast carbohydrates for a low or a predicted low) the caregiver confirms after giving it: sent to the loop when the caregiver\'s phone sends remote commands (Trio), else saved only in Mellis; the card says which. Nothing is logged or sent by this tool. One card per option of the answer (one when the answer has no options). Returns PROPOSED with the card, or ALREADY_LOGGED when carbs were already logged for the rescue alert of this conversation (then no card).',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      carbs_g: { type: ['integer', 'null'], description: `Grams of fast carbohydrates, 1-${RESCUE_CARB_PROPOSAL_MAX_G}, whole grams (the loop takes whole grams). null: the dose the data advise now (fast_carbs_first), so the card can be prepared in the same turn as the meal cards.` },
      option: { type: ['string', 'null'], enum: ['A', 'B', 'C', null], description: 'The option of your answer this card belongs to (answer_options key); null when the answer offers no options.' },
      reason: { type: 'string', description: 'One short Polish sentence for the card: why this dose (and why it differs from the static proposal, if it does). Never where the carbs are logged (Mellis, Trio, Nightscout, the loop): the card already says it.' },
    },
    required: ['carbs_g', 'option', 'reason'],
  },
};

export const RESCUE_CARB_PROPOSAL_INSTRUCTIONS = [
  'RESCUE CARBS: this conversation is about a rescue carb alert (rescue_carb_alert in the context): glucose was predicted to fall below 70 mg/dL, or already was. The app proposed a static dose from the patient\'s ISF/ICR (proposal.explanation shows the arithmetic); the caregiver logs what was given with the button above the chat.',
  'Validate the dose with the data: current glucose and trend (newest CGM readings), IOB and COB, the loop\'s forecast and carbsReq, insulin given recently, activity, and carbs logged since the alert. Confirming a dose sends it to the loop when the caregiver\'s phone sends remote commands (Trio; the loop then counts it in COB); otherwise, or when the caregiver chooses not to send it, it is saved only in Mellis (entry_source GLUCOMIND, in_loop false): NOT in the loop, so the loop\'s COB, IOB and forecasts do not include it and a later rise from it may make the loop give extra insulin.',
  `On a loop small doses are usually enough when little insulin is working (the loop already suspended basal): about 5-10 g for a child (ISPAD/AID consensus), scaled up with the patient's age for a teenager or an adult (often 10-15 g; the weight is not known here). oref's carbsReq (Trio, AAPS; Loop has none) is not the dose: it counts all insulin on board to its end and credits COB only above 25% of the meal's carbs, so it is usually several times what is needed now (rescue-dose.v3, 2026-11-01). Dose for the lowest forecast within 30 minutes, at most ${RESCUE_CARB_PROPOSAL_MAX_G} g at once. Recheck after 15 minutes; a second dose only if still low or falling. Below ${URGENT_MGDL} mg/dL treat at once. Much insulin on board with no carbs in COB often means a meal bolus whose carbs were never entered in the loop: ask about it.`,
  'When your answer recommends a rescue dose different from the static proposal (or the caregiver asks for one), call propose_rescue_carbs once with it (once per option when the answer offers options); never for a dose already logged (rescue_carb_alert.treatment). After PROPOSED, say the grams in one sentence and that the caregiver confirms them with the card after giving them; never write that the carbs were given or logged.',
  `rescue_carb_alert.declined_at set: the caregiver chose "Nie podaję" (no rescue carbs for now; no reminder follows). Respect it and do not repeat the dose; say plainly only when the level is now worse than the push announced (rescue_carb_alert.level: a predicted low that is now a real low below 70 mg/dL, or anything below ${URGENT_MGDL} mg/dL): the app then starts a new alert by the same rule. If they decide to give carbs after all, a card still logs them.`,
].join('\n');

/** propose_rescue_carbs in an ordinary conversation (no alert): a card for rescue carbs the caregiver gave or will give. */
export const RESCUE_CARB_CHAT_INSTRUCTIONS = [
  'RESCUE CARBS: fast carbohydrates given for a low or a predicted low (juice, glucose, jelly sweets) are confirmed with a card: sent to the loop as a hypo treatment when the caregiver\'s phone sends remote commands (Trio; the loop counts them in COB; no meal), otherwise, or when the caregiver chooses not to send them, saved only in Mellis (then the loop\'s COB, IOB and forecasts do not include them, and a later rise from them may make the loop give extra insulin).',
  `When the caregiver says they gave or are about to give rescue carbs, or asks to log them, call propose_rescue_carbs once (once per option when the answer offers options) with those grams (the amount they named; if none, the dose you recommend from the data: on a loop about 5-10 g for a child, scaled up for a teenager or an adult, never oref's carbsReq, which is usually several times too much; at most ${RESCUE_CARB_PROPOSAL_MAX_G} g at once) and a short reason: why these grams (glucose, trend, what was given), never where they are logged, which the card already says. Not for meals or carbs the loop should dose insulin for: those are entered in the loop. Not for an amount already logged (a CARB_ENTRY with entry_source GLUCOMIND at that time).`,
  'After PROPOSED (without answer_options: with them the text names no numbers), say in one sentence that the caregiver confirms Y g on the card (it says whether they go to the loop or only to Mellis; the amount can be changed there); never write that the carbs were logged or sent.',
].join('\n');

/** The alert as the model sees it: what was detected, the static proposal and what was logged. */
export function rescueAlertForAi(alert: RescueAlertRecord): Record<string, unknown> {
  const evaluation = alert.evaluation;
  return {
    alert_id: alert.id,
    status: alert.status,
    level: alert.level,
    trigger_source: alert.trigger_source,
    detected_at: alert.notified_at ?? alert.first_flag_at,
    glucose_mgdl: evaluation.glucose?.value ?? null,
    glucose_at: evaluation.glucose?.at ?? null,
    delta_per_5min: evaluation.delta_per_5min,
    loop_forecast_used: evaluation.loop_used,
    trio_carbs_req_g: evaluation.carbs_req_g,
    predicted_min_mgdl: evaluation.predicted_min_mgdl,
    predicted_low_at: evaluation.predicted_low_at,
    proposal: alert.proposal
      ? { carbs_g: alert.proposal.carbs_g, range_g: [alert.proposal.min_g, alert.proposal.max_g], basis: alert.proposal.basis, csf_mgdl_per_g: alert.proposal.csf_mgdl_per_g, explanation: alert.proposal.explanation, warnings: alert.proposal.warnings ?? [] }
      : null,
    treatment: hasRescueTreatment(alert) ? { carbs_g: alert.treatment_carbs_g, given_at: alert.treated_at, in_loop: (alert.treatment_command_id ?? null) !== null } : null,
    declined_at: alert.declined_at && !hasRescueTreatment(alert) ? alert.declined_at : null,
    reminder_sent_at: alert.reminder_sent_at,
  };
}

export interface RescueCarbProposalStore {
  insertProposal(proposal: { patientId: string; alertId: string | null; conversationId: string; userMessageId: string; carbsG: number; reason: string | null; optionKey: AnswerOptionKey | null }): Promise<RescueCarbProposalRecord>;
  getAlert(patientId: string, alertId: string): Promise<RescueAlertRecord | null>;
  /** Takes back a card of this answer that a newer one for the same option replaces (absent: no replacing). */
  discardProposal?(patientId: string, proposalId: string): Promise<void>;
  /** The newest carbs eaten in the window (any entry), for an ordinary chat's card (absent: not checked). */
  getLastEatenCarbsAt?(patientId: string, fromIso: string, toIso: string): Promise<string | null>;
}

/** The port the AI gateway calls; one session per answer. */
export interface RescueCarbProposalTools {
  /** What the model is told about the cards: the alert's dose rules, or the ordinary chat's. */
  readonly instructions?: string;
  /** True in a rescue alert's chat (the dose is validated on the main model); false or absent in an ordinary chat. */
  readonly for_alert?: boolean;
  propose(args: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export class RescueCarbProposalSession implements RescueCarbProposalTools {
  readonly proposed: RescueCarbProposalRecord[] = [];

  /** `alertId` null: an ordinary conversation's cards (no alert). */
  /** `advisedCarbs`: the fast carbs the data advise now (fast_carbs_first), for carbs_g null; absent: carbs_g needed. */
  constructor(private readonly deps: { patientId: string; alertId: string | null; conversationId: string; userMessageId: string; store: RescueCarbProposalStore; advisedCarbs?: () => Promise<number | null> }) {}

  get instructions(): string {
    return this.deps.alertId ? RESCUE_CARB_PROPOSAL_INSTRUCTIONS : RESCUE_CARB_CHAT_INSTRUCTIONS;
  }

  get for_alert(): boolean {
    return this.deps.alertId !== null;
  }

  async propose(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    let carbs = typeof args.carbs_g === 'number' ? args.carbs_g : Number.NaN;
    if ((args.carbs_g === null || args.carbs_g === undefined) && this.deps.advisedCarbs) {
      const advised = await this.deps.advisedCarbs().catch(() => null);
      // No dose (no low ahead, or no ISF/ICR to compute one): never a token 1 g card.
      if (advised === null || !Number.isFinite(advised) || advised <= 0) {
        return { tool: PROPOSE_RESCUE_CARBS_TOOL_NAME, status: 'NO_ADVICE', note: 'The data advise no dose now (no low ahead, or no ISF/ICR in the profile to compute one): pass carbs_g yourself if a rescue card is still needed.' };
      }
      carbs = Math.min(RESCUE_CARB_PROPOSAL_MAX_G, Math.max(1, Math.round(advised)));
    } else if (args.carbs_g === null || args.carbs_g === undefined) {
      // No advice wired here (no remote control on this phone): the alert's own dose, else the model names the grams.
      const alertDose = this.deps.alertId ? (await this.deps.store.getAlert(this.deps.patientId, this.deps.alertId))?.proposal?.carbs_g ?? null : null;
      if (alertDose === null) {
        return { tool: PROPOSE_RESCUE_CARBS_TOOL_NAME, status: 'INVALID_REQUEST', problem: 'carbs_g is needed here (no advised dose is available): pass the grams.' };
      }
      carbs = Math.min(RESCUE_CARB_PROPOSAL_MAX_G, Math.max(1, Math.round(alertDose)));
    }
    // Whole grams: the card may go to the loop, which takes whole grams only.
    if (!Number.isFinite(carbs) || carbs < 1 || carbs > RESCUE_CARB_PROPOSAL_MAX_G || Math.round(carbs) !== carbs) {
      return { tool: PROPOSE_RESCUE_CARBS_TOOL_NAME, status: 'INVALID_REQUEST', problem: `carbs_g must be whole grams, 1-${RESCUE_CARB_PROPOSAL_MAX_G}` };
    }
    const optionKey = readOptionKey(args.option);
    const earlier = this.proposed.find((card) => card.option_key === optionKey);
    // A new card for an option replaces its earlier one (the dose changed after a result); without options, one card.
    if (earlier && (optionKey === null || !this.deps.store.discardProposal)) {
      return { tool: PROPOSE_RESCUE_CARBS_TOOL_NAME, status: 'LIMIT_REACHED', note: optionKey ? `Option ${optionKey} already has its rescue carb card: it is shown, do not call again.` : 'One rescue carb card per answer: use the card already prepared.' };
    }
    const alert = this.deps.alertId ? await this.deps.store.getAlert(this.deps.patientId, this.deps.alertId) : null;
    if (alert && hasRescueTreatment(alert)) {
      return { tool: PROPOSE_RESCUE_CARBS_TOOL_NAME, status: 'ALREADY_LOGGED', logged: { carbs_g: alert.treatment_carbs_g, given_at: alert.treated_at }, note: 'Carbs were already logged for this alert: no card. If more are needed now, say so in the answer (a new alert comes after the 15-minute recheck).' };
    }
    // An ordinary chat's card: carbs eaten in the last 15 min (e.g. an earlier answer's card confirmed) are said, so a
    // second portion is not given before the recheck.
    const recentCarbs = !alert && this.deps.store.getLastEatenCarbsAt
      ? await this.deps.store.getLastEatenCarbsAt(this.deps.patientId, new Date(Date.now() - 15 * 60_000).toISOString(), new Date().toISOString()).catch(() => null)
      : null;
    const record = await this.deps.store.insertProposal({
      patientId: this.deps.patientId,
      alertId: this.deps.alertId,
      conversationId: this.deps.conversationId,
      userMessageId: this.deps.userMessageId,
      carbsG: carbs,
      reason: typeof args.reason === 'string' && args.reason.trim() ? args.reason.trim().slice(0, 300) : null,
      optionKey,
    });
    if (earlier) {
      await this.deps.store.discardProposal!(this.deps.patientId, earlier.id);
      this.proposed.splice(this.proposed.indexOf(earlier), 1);
    }
    this.proposed.push(record);
    return { tool: PROPOSE_RESCUE_CARBS_TOOL_NAME, status: 'PROPOSED', card: { carbs_g: record.carbs_g, option: optionKey },
      ...(recentCarbs ? { recent_carbs: { at: recentCarbs, minutes_ago: Math.max(0, Math.round((Date.now() - Date.parse(recentCarbs)) / 60_000)), note: 'Carbs were logged within the last 15 minutes: say so, and that fast carbs usually work within 15 minutes, so another portion is for after the recheck unless glucose is still falling fast.' } } : {}),
      note: earlier ? `This card replaces option ${optionKey}'s earlier rescue card.` : optionKey ? `Option ${optionKey}'s rescue card is ready: call again only to change it.` : 'The card is ready: do not prepare it again.' };
  }
}
