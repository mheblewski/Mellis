import { ConflictError } from '@shared/errors/app-error';
import { resolveHomeTimeZone } from '@shared/primitives/home-time-zone';
import type { MealChatMessage, MealChatProposal } from '@infra/db/postgres-meal-chat.repository';
import { canTransitionMealRecord, type MealRecord } from '@modules/meal-candidates/application/meal-record-trust';
import type { MealChatCurrentMeal, MealChatResponder, MealChatTurn } from './meal-chat-responder';
import type { UserAiPreferences } from '@shared/primitives/user-ai-preferences';

export const MEAL_CHAT_REPLY_JOB_TYPE = 'meal.chat_reply';

export function buildMealChatReplyDedupeKey(userMessageId: string): string {
  return `${MEAL_CHAT_REPLY_JOB_TYPE}:${userMessageId}`;
}

/** Photos sent to the model per reply: the newest ones (older photos stay in the chat history as text turns). */
const MAX_PHOTOS_PER_REPLY = 4;

export interface MealChatReplyDeps {
  findMealIdentityById(patientId: string, mealRecordId: string): Promise<string | null>;
  getMealRecord(patientId: string, mealIdentity: string): Promise<MealRecord>;
  recordAiProposal(patientId: string, mealIdentity: string, proposal: { carbs_g: number | null; protein_g: number | null; fat_g: number | null; ai_execution_id: string | null }): Promise<string>;
  listMessages(patientId: string, mealRecordId: string): Promise<MealChatMessage[]>;
  hasReply(mealRecordId: string, userMessageId: string): Promise<boolean>;
  insertAssistantMessage(args: { patientId: string; mealRecordId: string; replyToMessageId: string; content: string; question: string | null; proposal: MealChatProposal | null }): Promise<void>;
  readPhoto(patientId: string, photoId: string): Promise<Buffer | null>;
  /** "Rok urodzenia" of the patient (null when not set); absent: the prompt says the age is not known. */
  patientBirthYear?(patientId: string): Promise<number | null>;
  /** The patient's time zone (Trio profile, else the server's); absent: the server's. */
  patientTimeZone?(patientId: string): Promise<string>;
  /** "Moje instrukcje dla AI" of the user who wrote the message (null when not set); absent: no preferences line. */
  userAiPreferences?(userId: string): Promise<UserAiPreferences | null>;
  responder: MealChatResponder;
  /** Told the reply text written so far, while the responder writes it; absent: no live draft. */
  onReplyDraft?: (replySoFar: string) => void;
}

/**
 * An earlier reply as the model sees it again: its question and proposal are shown in the chat apart from the text, so
 * they go back with it (a short "Nie" answers that question).
 */
function assistantTurnText(message: MealChatMessage): string {
  let text = message.content;
  if (message.proposal) text += `\n[Propozycja: W ${message.proposal.carbs_g} g, B ${message.proposal.protein_g} g, T ${message.proposal.fat_g} g]`;
  if (message.question) text += `\n[Pytanie do Ciebie: ${message.question}]`;
  return text;
}

function localTime(iso: string, timeZone: string): string | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  try {
    return new Intl.DateTimeFormat('sv-SE', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date);
  } catch {
    return null;
  }
}

/** The meal as it stands, for the model to build on; null when nothing is known yet. */
function currentMeal(record: MealRecord): MealChatCurrentMeal | null {
  const macros = record.macros;
  const items = record.items?.map(({ name, grams, carbs_g, protein_g, fat_g }) => ({ name, grams, carbs_g, protein_g, fat_g })) ?? null;
  const current: MealChatCurrentMeal = {
    description: record.description ?? null,
    status: record.status,
    carbs_g: macros?.carbs.grams ?? null,
    protein_g: macros?.protein.grams ?? null,
    fat_g: macros?.fat.grams ?? null,
    items: items && items.length > 0 ? items : null,
  };
  return current.description || current.items || current.carbs_g !== null ? current : null;
}

/** The message author's AI preferences; null without an author or when they cannot be read (the reply goes on). */
async function authorPreferences(deps: MealChatReplyDeps, authorUserId: string | null | undefined): Promise<UserAiPreferences | null> {
  if (!authorUserId || !deps.userAiPreferences) return null;
  return deps.userAiPreferences(authorUserId).catch(() => null);
}

/**
 * Answers one caregiver message in a meal chat. The proposal becomes the meal's pending (unconfirmed) proposal when the
 * meal can take one; a confirmed or corrected meal keeps its values until the caregiver accepts the new proposal.
 * Idempotent per user message: a retried job that already replied does nothing.
 */
export async function runMealChatReplyJob(deps: MealChatReplyDeps, payload: Record<string, unknown>): Promise<'REPLIED' | 'ALREADY_REPLIED'> {
  const patientId = String(payload.patient_id ?? '');
  const mealRecordId = String(payload.meal_record_id ?? '');
  const userMessageId = String(payload.user_message_id ?? '');
  if (!patientId || !mealRecordId || !userMessageId) {
    throw new Error('INVALID_MEAL_CHAT_REPLY_PAYLOAD');
  }
  if (await deps.hasReply(mealRecordId, userMessageId)) {
    return 'ALREADY_REPLIED';
  }
  const identity = await deps.findMealIdentityById(patientId, mealRecordId);
  if (!identity) {
    throw new Error('MEAL_NOT_FOUND');
  }
  const record = await deps.getMealRecord(patientId, identity);
  const messages = await deps.listMessages(patientId, mealRecordId);
  const upTo = messages.findIndex((message) => message.id === userMessageId);
  if (upTo < 0) {
    throw new Error('MEAL_CHAT_MESSAGE_NOT_FOUND');
  }
  // The chat up to this message; a reply to an earlier message stored after it (two caregivers, a send while a reply
  // was written) is placed right after the message it answers, so this answer sees it.
  const earlier = messages.slice(0, upTo + 1);
  const earlierIds = new Set(earlier.map((message) => message.id));
  const lateReplies = messages.slice(upTo + 1).filter((message) => message.role === 'ASSISTANT' && message.reply_to_message_id !== null && earlierIds.has(message.reply_to_message_id) && message.reply_to_message_id !== userMessageId);
  const history = lateReplies.length === 0 ? earlier : earlier.flatMap((message) => [message, ...lateReplies.filter((reply) => reply.reply_to_message_id === message.id)]);

  // Newest photos first until the limit; then back in chat order.
  const photoBudget = new Set<string>();
  for (const message of [...history].reverse()) {
    for (const photoId of [...message.photo_ids].reverse()) {
      if (photoBudget.size < MAX_PHOTOS_PER_REPLY) photoBudget.add(photoId);
    }
  }
  const turns: MealChatTurn[] = [];
  for (const message of history) {
    const photos: Buffer[] = [];
    for (const photoId of message.photo_ids) {
      if (!photoBudget.has(photoId)) continue;
      const photo = await deps.readPhoto(patientId, photoId);
      if (photo) photos.push(photo);
    }
    turns.push({ role: message.role, content: message.role === 'ASSISTANT' ? assistantTurnText(message) : message.content, photos });
  }

  const reply = await deps.responder.respond({
    meal: { started_at: record.started_at, local_time: localTime(record.started_at, deps.patientTimeZone ? await deps.patientTimeZone(patientId).catch(() => resolveHomeTimeZone()) : resolveHomeTimeZone()), logged_carbs_g: record.source_carbs_g, current: currentMeal(record) },
    turns,
    patient_birth_year: deps.patientBirthYear ? await deps.patientBirthYear(patientId).catch(() => null) : null,
    user_preferences: await authorPreferences(deps, history[upTo]?.author_user_id),
  }, deps.onReplyDraft ? { onDraft: deps.onReplyDraft } : {});

  let proposal: MealChatProposal | null = reply.proposal ? { ...reply.proposal, proposal_id: null } : null;
  if (proposal && canTransitionMealRecord(record.status, 'AI_PROPOSED')) {
    try {
      const proposalId = await deps.recordAiProposal(patientId, identity, {
        carbs_g: proposal.carbs_g,
        protein_g: proposal.protein_g,
        fat_g: proposal.fat_g,
        ai_execution_id: null,
      });
      proposal = { ...proposal, proposal_id: proposalId };
    } catch (error) {
      // The other caregiver confirmed or corrected the meal while the AI answered: the reply is kept (no second paid
      // call on a retry) and its proposal waits in the chat, as for a meal confirmed before.
      if (!(error instanceof ConflictError)) throw error;
    }
  }

  await deps.insertAssistantMessage({
    patientId,
    mealRecordId,
    replyToMessageId: userMessageId,
    content: withoutDoseHere(reply.reply),
    question: reply.question,
    proposal,
  });
  return 'REPLIED';
}

/** Insulin units in a meal chat reply ("2 j", "1,5 jednostki", "3 U"). */
const INSULIN_UNITS = /\b\d+(?:[.,]\d+)?\s*(?:j\.?(?![a-ząćęłńóśźż])|jedn\w*|U\b)/i;

/**
 * The meal chat sees no glucose, IOB or ratios, so its prompt asks for no doses; a reply that names insulin anyway gets
 * one sentence pointing to where a dose is computed from the data.
 */
export function withoutDoseHere(reply: string): string {
  if (!INSULIN_UNITS.test(reply)) return reply;
  return `${reply.trimEnd()}\n\nDawki tutaj nie liczę (nie widzę glukozy ani insuliny w organizmie): policzy ją zakładka Bolus albo czat Rozmowy.`;
}
