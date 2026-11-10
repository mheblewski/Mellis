import { ValidationError } from '@shared/errors/app-error';
import type { MealChatProposal } from '@infra/db/postgres-meal-chat.repository';
import type { MealChatCurrentMeal, MealChatResponder, MealChatTurn } from '@modules/meal-chat/application/meal-chat-responder';
import { withoutDoseHere } from '@modules/meal-chat/application/meal-chat-reply.job';
import type { UserAiPreferences } from '@shared/primitives/user-ai-preferences';
import { MEAL_PLAN_POLICY, type MealPlanEntry, type MealPlanItem } from './meal-plan';

/**
 * The planned meal's chat: a caregiver writes what changed in a planned meal ("zamiast kisielu batonik"),
 * Mellis answers with the whole meal after the change, as the meal chat does for an eaten meal, and an accepted change
 * replaces the entry's dishes. Nothing here gives a dose: the page computes it from the dishes, as before.
 */
export const MEAL_PLAN_CHAT_REPLY_JOB_TYPE = 'meal_plan.chat_reply';

export function buildMealPlanChatReplyDedupeKey(userMessageId: string): string {
  return `${MEAL_PLAN_CHAT_REPLY_JOB_TYPE}:${userMessageId}`;
}

/** Photos sent to the model per reply, as in the meal chat. */
const MAX_PHOTOS_PER_REPLY = 4;

export const MEAL_PLAN_CHAT_POLICY = {
  max_content_length: 2000,
  max_plate_summary_length: 1000,
  /** The plate as a phone stores it (portions, added foods): opaque here, only bounded. */
  max_plate_bytes: 16_000,
} as const;

export interface MealPlanChatMessage {
  id: string;
  role: 'USER' | 'ASSISTANT';
  content: string;
  photo_ids: string[];
  plate_summary: string | null;
  proposal: MealChatProposal | null;
  question: string | null;
  author_display_name: string | null;
  author_user_id: string | null;
  reply_to_message_id: string | null;
  accepted_at: string | null;
  created_at: string;
}

/** A caregiver message: its text and/or photos (ids checked by the caller) and, when the phone sent it, the plate it saw. */
export function parseMealPlanChatPost(body: unknown): { content: string; photo_ids: string[]; plate_summary: string | null } {
  const input = (body ?? {}) as Record<string, unknown>;
  const content = typeof input.content === 'string' ? input.content.trim() : '';
  const photoIds = parseMealPlanPhotoIds(input.photo_ids);
  if (!content && photoIds.length === 0) throw new ValidationError('A message needs text or a photo');
  if (content.length > MEAL_PLAN_CHAT_POLICY.max_content_length) throw new ValidationError(`content must be at most ${MEAL_PLAN_CHAT_POLICY.max_content_length} characters`);
  const summary = typeof input.plate_summary === 'string' ? input.plate_summary.trim() : '';
  if (summary.length > MEAL_PLAN_CHAT_POLICY.max_plate_summary_length) throw new ValidationError(`plate_summary must be at most ${MEAL_PLAN_CHAT_POLICY.max_plate_summary_length} characters`);
  return { content, photo_ids: photoIds, plate_summary: summary || null };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Absent → none; photo ids only, duplicates dropped, at most 3 (as in the meal chat). */
function parseMealPlanPhotoIds(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.some((id) => typeof id !== 'string' || !UUID.test(id))) throw new ValidationError('photo_ids must be photo ids');
  const ids = [...new Set((raw as string[]).map((id) => id.toLowerCase()))];
  if (ids.length > 3) throw new ValidationError('At most 3 photo ids');
  return ids;
}

/** The phone's plate: any JSON object within the size limit (null clears it). */
export function parseMealPlanPlate(body: unknown): Record<string, unknown> | null {
  const plate = (body as Record<string, unknown> | null)?.plate;
  if (plate === null) return null;
  if (typeof plate !== 'object' || plate === undefined || Array.isArray(plate)) throw new ValidationError('plate must be an object or null');
  if (JSON.stringify(plate).length > MEAL_PLAN_CHAT_POLICY.max_plate_bytes) throw new ValidationError('plate is too large');
  return plate as Record<string, unknown>;
}

const round1 = (value: number) => Math.round(value * 10) / 10;
const clampGrams = (value: number | null | undefined): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(500, Math.max(0, round1(value))) : null;

/**
 * The dishes after an accepted change. The model's food grams go into the name ("Batonik zbożowy 25 g"), as the menu
 * names its portions ("Krupnik 250 ml"); a name that already has a number keeps its own.
 */
export function mealPlanItemsFromProposal(proposal: Pick<MealChatProposal, 'items'>): MealPlanItem[] {
  return proposal.items.slice(0, MEAL_PLAN_POLICY.max_items).map((item) => {
    const base = item.name.trim().replace(/\s+/g, ' ');
    const grams = typeof item.grams === 'number' && Number.isFinite(item.grams) && item.grams > 0 ? Math.round(item.grams) : null;
    const named = grams !== null && !/\d/.test(base) ? `${base} ${grams} g` : base;
    return {
      name: (named || 'Potrawa').slice(0, MEAL_PLAN_POLICY.max_item_length),
      carbs_g: clampGrams(item.carbs_g),
      protein_g: clampGrams(item.protein_g),
      fat_g: clampGrams(item.fat_g),
    };
  });
}

/** The planned meal as the model builds on it: the plate the caregiver saw when available, else the menu's dishes. */
export function mealPlanCurrentMeal(entry: Pick<MealPlanEntry, 'title' | 'items'>, plateSummary: string | null): MealChatCurrentMeal {
  const sum = (pick: (item: MealPlanItem) => number | null) => {
    const values = entry.items.map(pick);
    return values.every((value) => value !== null) && values.length > 0 ? round1(values.reduce((total, value) => total + (value ?? 0), 0)) : null;
  };
  return {
    description: plateSummary ? `${entry.title}. Na talerzu teraz: ${plateSummary}` : entry.title,
    status: 'PLANNED',
    carbs_g: sum((item) => item.carbs_g),
    protein_g: sum((item) => item.protein_g),
    fat_g: sum((item) => item.fat_g),
    items: entry.items.length > 0
      ? entry.items.map((item) => ({ name: item.name, grams: null, carbs_g: item.carbs_g ?? 0, protein_g: item.protein_g ?? 0, fat_g: item.fat_g ?? 0 }))
      : null,
  };
}

function assistantTurnText(message: MealPlanChatMessage): string {
  let text = message.content;
  if (message.proposal) text += `\n[Propozycja: W ${message.proposal.carbs_g} g, B ${message.proposal.protein_g} g, T ${message.proposal.fat_g} g]`;
  if (message.question) text += `\n[Pytanie do Ciebie: ${message.question}]`;
  return text;
}

export interface MealPlanChatReplyDeps {
  getEntry(patientId: string, entryId: string): Promise<MealPlanEntry | null>;
  listMessages(patientId: string, entryId: string): Promise<MealPlanChatMessage[]>;
  hasReply(entryId: string, userMessageId: string): Promise<boolean>;
  insertAssistantMessage(args: { patientId: string; entryId: string; replyToMessageId: string; content: string; question: string | null; proposal: MealChatProposal | null }): Promise<void>;
  /** The patient's confirmed rules about meals ("Co Mellis pamięta"), as written. */
  planRules(patientId: string): Promise<string[]>;
  /** A photo's JPEG (null when it cannot be read: the reply goes on without it). */
  readPhoto?(patientId: string, photoId: string): Promise<Buffer | null>;
  patientBirthYear?(patientId: string): Promise<number | null>;
  userAiPreferences?(userId: string): Promise<UserAiPreferences | null>;
  responder: MealChatResponder;
  onReplyDraft?: (replySoFar: string) => void;
}

/** Answers one caregiver message of a planned meal's chat; a retried job that already replied does nothing. */
export async function runMealPlanChatReplyJob(deps: MealPlanChatReplyDeps, payload: Record<string, unknown>): Promise<'REPLIED' | 'ALREADY_REPLIED'> {
  const patientId = String(payload.patient_id ?? '');
  const entryId = String(payload.entry_id ?? '');
  const userMessageId = String(payload.user_message_id ?? '');
  if (!patientId || !entryId || !userMessageId) throw new Error('INVALID_MEAL_PLAN_CHAT_REPLY_PAYLOAD');
  if (await deps.hasReply(entryId, userMessageId)) return 'ALREADY_REPLIED';
  const entry = await deps.getEntry(patientId, entryId);
  if (!entry) throw new Error('MEAL_PLAN_ENTRY_NOT_FOUND');
  const messages = await deps.listMessages(patientId, entryId);
  const upTo = messages.findIndex((message) => message.id === userMessageId);
  if (upTo < 0) throw new Error('MEAL_PLAN_CHAT_MESSAGE_NOT_FOUND');
  const history = messages.slice(0, upTo + 1);
  // The newest photos go to the model (a label is read once; older photos stay in the chat as text turns).
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
      if (!photoBudget.has(photoId) || !deps.readPhoto) continue;
      const photo = await deps.readPhoto(patientId, photoId).catch(() => null);
      if (photo) photos.push(photo);
    }
    turns.push({ role: message.role, content: message.role === 'ASSISTANT' ? assistantTurnText(message) : message.content, photos });
  }
  const question = history[upTo];
  const preferences = question?.author_user_id && deps.userAiPreferences ? await deps.userAiPreferences(question.author_user_id).catch(() => null) : null;
  const reply = await deps.responder.respond({
    meal: { started_at: entry.planned_at, local_time: null, logged_carbs_g: null, current: mealPlanCurrentMeal(entry, question?.plate_summary ?? null) },
    planned: { title: entry.title, rules: await deps.planRules(patientId).catch(() => []) },
    turns,
    patient_birth_year: deps.patientBirthYear ? await deps.patientBirthYear(patientId).catch(() => null) : null,
    user_preferences: preferences,
  }, deps.onReplyDraft ? { onDraft: deps.onReplyDraft } : {});
  await deps.insertAssistantMessage({
    patientId,
    entryId,
    replyToMessageId: userMessageId,
    content: withoutDoseHere(reply.reply),
    question: reply.question,
    proposal: reply.proposal ? { ...reply.proposal, proposal_id: null } : null,
  });
  return 'REPLIED';
}
