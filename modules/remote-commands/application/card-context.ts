import type { AnswerOption } from '@modules/ai-gateway/application/answer-options';
import { wbtPlanOf, type BolusProposalRecord } from './bolus-proposal-tool';
import { planParts, planTrigger } from './split-bolus';

/**
 * The cards an earlier answer prepared, as the model reads them in the conversation (card-context.v1, owner 2026-10-23):
 * the answer's text no longer repeats the cards' numbers (answer-options.v1), so without this a follow-up such as
 * "Podziel dawkę na pół" had no numbers to work with. States are as of the question, so a retry reads the same text.
 */

export const CARD_CONTEXT_POLICY_VERSION = 'card-context.v1';

export interface CardForContext {
  proposal: BolusProposalRecord;
  command: { status: string; carbs_g: number; insulin_u: number; authorized_at?: string | null; carbs_in_trio_g?: number } | null;
}

export interface RescueCardForContext {
  carbs_g: number;
  option_key: string | null;
  status: string;
  treated: boolean;
}

const units = (value: number) => `${(Math.round(value * 100) / 100).toString().replace('.', ',')} j`;

function laterText(part: ReturnType<typeof planParts>[number]): string {
  const trigger = planTrigger(part);
  const when = trigger === 'AFTER_MINUTES' ? `za ${part.later_after_minutes} min`
    : trigger === 'GLUCOSE_STOPPED_FALLING' ? 'gdy glukoza przestanie spadać'
      : trigger === 'GLUCOSE_RISING' ? 'gdy glukoza zacznie rosnąć'
        : `gdy glukoza przekroczy ${part.threshold_mgdl ?? '?'} mg/dL`;
  const dose = part.fixed_insulin_u !== null && part.fixed_insulin_u !== undefined ? units(part.fixed_insulin_u) : `ok. ${units(part.later_insulin_u)}`;
  return `${when}: ${part.later_carbs_g > 0 ? `${part.later_carbs_g} g + ` : ''}${dose}`;
}

function stateText(card: CardForContext, asOfMs: number): string {
  const command = card.command;
  if (command && command.authorized_at && Date.parse(command.authorized_at) <= asOfMs && !['SEND_FAILED', 'EXPIRED'].includes(command.status)) {
    // A bolus-only retry after "carbs stored, bolus refused": the carbs are in Trio from the first command.
    const carbsInTrio = command.carbs_g === 0 && (command.carbs_in_trio_g ?? 0) > 0 ? command.carbs_in_trio_g! : null;
    if (carbsInTrio !== null) return `wysłana (${carbsInTrio} g w pętli z pierwszego polecenia, bolus ${units(command.insulin_u)} ponowiony, status ${command.status})`;
    return `wysłana (${command.carbs_g} g + ${units(command.insulin_u)}, status ${command.status})`;
  }
  return Date.parse(card.proposal.expires_at) <= asOfMs ? 'nieaktualna (dane się zmieniły; nową kartę liczy się na aktualnych danych)' : 'do podania';
}

/** "[Karty pod tą odpowiedzią] …" for one answer; null without cards. */
export function describeAnswerCards(args: { cards: CardForContext[]; rescue: RescueCardForContext[]; options: AnswerOption[]; asOf: string }): string | null {
  if (args.cards.length === 0 && args.rescue.length === 0) return null;
  const asOfMs = Date.parse(args.asOf);
  const optionLabel = (key: string | null) => {
    if (!key) return 'Karta';
    const option = args.options.find((entry) => entry.key === key);
    return `Opcja ${key}${option?.recommended ? ' (polecana)' : ''}${option ? ` „${option.title}”` : ''}`;
  };
  const lines = args.cards.map((card) => {
    const p = card.proposal;
    const parts = planParts(p.split);
    const wbtPlan = wbtPlanOf(p);
    const wbt = wbtPlan?.auto ? wbtPlan.standard_dose_u : null;
    const meal = p.meal_payload?.description ? ` ${p.meal_payload.description}` : '';
    const macros = p.meal_payload?.macros ? ` (cały posiłek: ${p.meal_payload.macros.carbs_g} g W, ${p.meal_payload.macros.protein_g} g B, ${p.meal_payload.macros.fat_g} g T)` : '';
    return `- ${optionLabel(p.option_key)}, ${p.purpose}${meal}${macros}: teraz ${p.carbs_g} g + ${units(p.insulin_u)}`
      + parts.map((part) => `; ${laterText(part)}`).join('')
      + (wbt ? `; WBT ok. ${units(wbt)} (przypomnienie)` : '')
      + `; stan: ${stateText(card, asOfMs)}`;
  });
  const rescueLines = args.rescue.map((card) => `- ${optionLabel(card.option_key)}, dosłodzenie ${card.carbs_g} g; stan: ${card.treated ? 'zapisane' : card.status === 'ACCEPTED' ? 'potwierdzone (wysłane, czeka na wpis z pętli)' : card.status === 'SUPERSEDED' ? 'nieaktualne (zastąpione nowszą kartą)' : 'do potwierdzenia'}`);
  return ['[Karty pod tą odpowiedzią]', ...lines, ...rescueLines].join('\n');
}
