import type { MealChatProposal } from '@infra/db/postgres-meal-chat.repository';
import { ON_OUTPUT_TEXT_OPTION, type OpenAiResponsesTransport } from '@modules/ai-gateway/infrastructure/guarded-openai-client';
import { readStreamingJsonStringField } from '@modules/ai-gateway/application/partial-json-field';
import { DiabCalcUnavailableError, type FoodSearch } from '../infrastructure/diabcalc-mcp-client';
import { patientAge, patientAgeInstructionPl } from '@shared/primitives/patient-age';
import { userAiPreferencesInstructionPl, type UserAiPreferences } from '@shared/primitives/user-ai-preferences';

export interface MealChatTurn {
  role: 'USER' | 'ASSISTANT';
  content: string;
  /** JPEG photos of this turn (USER only), already read from disk. */
  photos: Buffer[];
}

export interface MealChatInput {
  meal: {
    started_at: string;
    local_time: string | null;
    /** Carbs the caregiver logged for the loop (Nightscout); a hint, not the truth about the meal. */
    logged_carbs_g: number | null;
    /** What the meal is now (description, items, values, status): a new proposal builds on it (null or absent = none). */
    current?: MealChatCurrentMeal | null;
  };
  turns: MealChatTurn[];
  /** "Rok urodzenia": portions follow the patient's age (null or absent = not set). */
  patient_birth_year?: number | null;
  /** "Moje instrukcje dla AI" of the user who wrote the last message: one low-priority line last (null or absent = none). */
  user_preferences?: UserAiPreferences | null;
}

export interface MealChatCurrentMeal {
  description: string | null;
  /** CONFIRMED / CORRECTED: values a caregiver accepted; otherwise a proposal or the loop's carbs. */
  status: string;
  carbs_g: number | null;
  protein_g: number | null;
  fat_g: number | null;
  items: Array<{ name: string; grams: number | null; carbs_g: number; protein_g: number; fat_g: number }> | null;
}

export interface MealChatReply {
  reply: string;
  question: string | null;
  proposal: Omit<MealChatProposal, 'proposal_id'> | null;
}

export interface MealChatResponder {
  readonly providerName: string;
  /** `onDraft`, when given, is told the reply text written so far while it is written ("" when a round ends in searches). */
  respond(input: MealChatInput, options?: { onDraft?: (replySoFar: string) => void }): Promise<MealChatReply>;
}

/** Offline responder (AI_PROVIDER=fake): proposes the logged carbs, nothing else. */
export class FakeMealChatResponder implements MealChatResponder {
  readonly providerName = 'fake';

  async respond(input: MealChatInput, options: { onDraft?: (replySoFar: string) => void } = {}): Promise<MealChatReply> {
    const reply = this.reply(input);
    // FAKE_AI_STREAM_DELAY_MS (local checks of live drafts): the reply is written in chunks; unset or 0: at once.
    const delayMs = Number(process.env.FAKE_AI_STREAM_DELAY_MS ?? 0);
    if (options.onDraft && Number.isFinite(delayMs) && delayMs > 0) {
      const chunk = Math.max(1, Math.ceil(reply.reply.length / 8));
      for (let end = chunk; ; end += chunk) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        options.onDraft(reply.reply.slice(0, Math.min(end, reply.reply.length)));
        if (end >= reply.reply.length) break;
      }
    }
    return reply;
  }

  private reply(input: MealChatInput): MealChatReply {
    const carbs = input.meal.logged_carbs_g;
    if (carbs === null) {
      return { reply: 'Opisz proszę, co było w posiłku i ile mniej więcej.', question: 'Co i ile zjadł?', proposal: null };
    }
    return {
      reply: 'Wersja testowa: proponuję wartości wpisane w Nightscout.',
      question: null,
      proposal: {
        items: [{ name: 'Posiłek (wartości z Nightscout)', grams: null, carbs_g: carbs, protein_g: 0, fat_g: 0, source: 'ESTIMATE' }],
        carbs_g: carbs,
        protein_g: 0,
        fat_g: 0,
        confidence: 'LOW',
        assumptions: 'Bez analizy: wartości z Nightscout.',
      },
    };
  }
}

const MAX_TOOL_ROUNDS = 6;
const MEAL_CHAT_ROUND_TIMEOUT_MS = 120_000;

const SYSTEM_INSTRUCTIONS = [
  'Jesteś asystentem żywieniowym osoby z cukrzycą typu 1 i jej opiekunów. Szacujesz makroskładniki JEDNEGO posiłku na podstawie opisu i/lub zdjęć.',
  'Najważniejsze są węglowodany (to od nich zależy insulina), potem tłuszcz i białko.',
  'Rozpoznaj składniki i ich wagę. Gdy wagi nie podano, oszacuj ją ze zdjęcia (talerz, sztućce, opakowanie) albo przyjmij typową porcję dla osoby w wieku pacjenta i napisz to w assumptions.',
  'Dla każdego głównego składnika wywołaj search_food (polska nazwa produktu, np. "bułka kajzerka", "ryż biały gotowany"). Wybierz najlepiej pasujący produkt: zwykły, nie bezglutenowy/light/specjalny, chyba że opis lub zdjęcie mówi inaczej. Policz makro: wartość_na_100g × gramy / 100.',
  'Gdy search_food nie znajdzie produktu albo zwróci błąd, oszacuj wartości sam i oznacz pozycję source=ESTIMATE. Pozycje z bazy DiabCalc oznacz source=DIABCALC.',
  'logged_carbs_g to węglowodany, które opiekun wpisał do pętli. Porównaj z oszacowaniem; jeśli różnica jest duża, krótko o tym wspomnij.',
  'Gdy niepewność zmienia węglowodany o więcej niż ok. 20% (wielkość porcji, czy napój był słodzony, ile zostało na talerzu), zadaj JEDNO krótkie pytanie w polu question, ale i tak podaj najlepszą propozycję.',
  'Twoje wcześniejsze pytanie widać w historii jako [Pytanie do Ciebie: …]. Krótka odpowiedź opiekuna ("tak", "nie", liczba) odpowiada na nie: przyjmij ją i uwzględnij, nie dopytuj, co znaczy.',
  'Pole proposal to zawsze CAŁY posiłek. current_meal (w ostatniej wiadomości) to jego obecny skład. Gdy opiekun coś dopisuje ("dodatkowo", "do tego", "jeszcze", "i"), zostaw wszystkie dotychczasowe pozycje z current_meal z ich wartościami i dodaj nowe. Usuń albo zamień pozycję tylko wtedy, gdy opiekun wyraźnie tak pisze. Gdy current_meal ma wartości bez pozycji, wpisz je jako jedną pozycję (nazwa z description albo "Dotychczasowy posiłek") i dodaj nowe.',
  'Gdy nie masz żadnej informacji o posiłku (pusty opis, nieczytelne zdjęcie), ustaw proposal na null i zapytaj, co to było.',
  'Odpowiadasz po polsku, krótko (2-4 zdania w reply), rzeczowo i ciepło. Sumy w proposal muszą być sumą pozycji. Węglowodany w pełnych gramach (pętla przyjmuje tylko pełne), białko i tłuszcz do 1 miejsca po przecinku.',
  'Nie podawaj dawek insuliny ani zaleceń terapeutycznych: tylko skład posiłku.',
].join('\n');

const PROPOSAL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['items', 'carbs_g', 'protein_g', 'fat_g', 'confidence', 'assumptions'],
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'grams', 'carbs_g', 'protein_g', 'fat_g', 'source'],
        properties: {
          name: { type: 'string' },
          grams: { type: ['number', 'null'] },
          carbs_g: { type: 'number' },
          protein_g: { type: 'number' },
          fat_g: { type: 'number' },
          source: { type: 'string', enum: ['DIABCALC', 'ESTIMATE'] },
        },
      },
    },
    carbs_g: { type: 'number' },
    protein_g: { type: 'number' },
    fat_g: { type: 'number' },
    confidence: { type: 'string', enum: ['HIGH', 'MEDIUM', 'LOW'] },
    assumptions: { type: 'string' },
  },
} as const;

const MEAL_CHAT_REPLY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['reply', 'question', 'proposal'],
  properties: {
    reply: { type: 'string' },
    question: { type: ['string', 'null'] },
    proposal: { anyOf: [{ type: 'null' }, PROPOSAL_SCHEMA] },
  },
} as const;

const SEARCH_FOOD_TOOL = {
  type: 'function',
  name: 'search_food',
  description: 'Szuka produktu w bazie DiabCalc (polskie produkty). Zwraca wartości na 100 g: węglowodany, białko, tłuszcz, kcal oraz typową porcję.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['query'],
    properties: { query: { type: 'string', description: 'Polska nazwa produktu, np. "jabłko", "chleb pszenny".' } },
  },
  strict: true,
} as const;

/**
 * Meal chat on OpenAI (Responses API) through the guarded client: every round passes the cost guard and the budget
 * ledger. Photos go as image inputs; the model looks products up in DiabCalc through search_food.
 */
export class OpenAiMealChatResponder implements MealChatResponder {
  constructor(
    private readonly client: OpenAiResponsesTransport,
    private readonly model: string,
    private readonly foods: FoodSearch | null,
    readonly providerName = 'openai',
  ) {}

  async respond(input: MealChatInput, options: { onDraft?: (replySoFar: string) => void } = {}): Promise<MealChatReply> {
    const tools = this.foods ? [SEARCH_FOOD_TOOL] : undefined;
    const draft = options.onDraft ? new ReplyDraftReader(options.onDraft) : null;
    // Each round is bounded (a streamed one as a whole); without it the SDK would wait up to ten minutes.
    const callOptions = () => ({ timeout: MEAL_CHAT_ROUND_TIMEOUT_MS, ...(draft ? { [ON_OUTPUT_TEXT_OPTION]: draft.startRound() } : {}) });
    // Instructions are not carried over a previous_response_id chain: every round sends them.
    const baseInstructions = [
      SYSTEM_INSTRUCTIONS,
      patientAgeInstructionPl(patientAge(input.patient_birth_year, new Date())),
      ...(this.foods ? [] : ['Baza DiabCalc jest teraz niedostępna: szacuj sam (source=ESTIMATE).']),
    ].join('\n');
    // The writer's own preferences go last, below every rule above; nothing set: no line.
    const preferencesLine = userAiPreferencesInstructionPl(input.user_preferences);
    const instructions = preferencesLine ? `${baseInstructions}\n${preferencesLine}` : baseInstructions;
    let response = await this.client.responses.create({
      model: this.model,
      instructions,
      input: buildInput(input),
      tools,
      parallel_tool_calls: true,
      text: { format: { type: 'json_schema', name: 'meal_chat_reply', strict: true, schema: MEAL_CHAT_REPLY_SCHEMA } },
    }, callOptions());

    for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
      const calls = functionCalls(response);
      if (calls.length === 0) break;
      draft?.discardRound();
      const outputs = await Promise.all(calls.map(async (call) => ({
        type: 'function_call_output',
        call_id: call.call_id,
        output: JSON.stringify(await this.runTool(call.name, call.arguments)),
      })));
      response = await this.client.responses.create({
        model: this.model,
        instructions,
        previous_response_id: response.id,
        input: outputs,
        tools,
        // The last allowed round must answer instead of searching again.
        ...(round === MAX_TOOL_ROUNDS - 1 ? { tool_choice: 'none' } : {}),
        text: { format: { type: 'json_schema', name: 'meal_chat_reply', strict: true, schema: MEAL_CHAT_REPLY_SCHEMA } },
      }, callOptions());
    }

    return parseReply(response);
  }

  private async runTool(name: string, rawArguments: string): Promise<unknown> {
    if (name !== 'search_food' || !this.foods) {
      return { error: 'Narzędzie niedostępne. Oszacuj wartości samodzielnie (source=ESTIMATE).' };
    }
    let query = '';
    try {
      query = String((JSON.parse(rawArguments) as { query?: unknown }).query ?? '');
    } catch {
      return { error: 'Niepoprawne argumenty.' };
    }
    try {
      const foods = await this.foods.searchFood(query, 5);
      return foods.length > 0 ? { query, foods } : { query, foods: [], note: 'Brak wyników. Spróbuj innej nazwy albo oszacuj (source=ESTIMATE).' };
    } catch (error) {
      if (error instanceof DiabCalcUnavailableError) {
        return { error: 'Baza DiabCalc jest niedostępna. Oszacuj wartości samodzielnie (source=ESTIMATE).' };
      }
      throw error;
    }
  }
}

function buildInput(input: MealChatInput): Array<Record<string, unknown>> {
  const context = {
    meal_started_at: input.meal.started_at,
    meal_local_time: input.meal.local_time,
    logged_carbs_g: input.meal.logged_carbs_g,
  };
  const lastUser = input.turns.map((turn) => turn.role).lastIndexOf('USER');
  const turns = input.turns.map((turn, index) => {
    if (turn.role === 'ASSISTANT') {
      return { role: 'assistant', content: turn.content };
    }
    const content: Array<Record<string, unknown>> = [];
    let text = index === 0 ? `Dane posiłku: ${JSON.stringify(context)}\n\n${turn.content || '(bez opisu, tylko zdjęcie)'}` : (turn.content || '(zdjęcie)');
    // The meal as it is now goes with the newest message: earlier proposals may have been accepted or edited since.
    if (index === lastUser && input.meal.current) text = `current_meal: ${JSON.stringify(input.meal.current)}\n\n${text}`;
    content.push({ type: 'input_text', text });
    for (const photo of turn.photos) {
      content.push({ type: 'input_image', image_url: `data:image/jpeg;base64,${photo.toString('base64')}`, detail: 'auto' });
    }
    return { role: 'user', content };
  });
  return turns;
}

function functionCalls(response: Record<string, unknown>): Array<{ call_id: string; name: string; arguments: string }> {
  const output = Array.isArray(response.output) ? (response.output as Array<Record<string, unknown>>) : [];
  return output
    .filter((item) => item.type === 'function_call')
    .map((item) => ({ call_id: String(item.call_id ?? ''), name: String(item.name ?? ''), arguments: String(item.arguments ?? '{}') }));
}

function outputText(response: Record<string, unknown>): string {
  // A cut-off reply may still parse (shortened JSON): never use it.
  if (response.status === 'incomplete') throw new Error('The model reply was cut off (incomplete)');
  if (typeof response.output_text === 'string' && response.output_text) return response.output_text;
  const output = Array.isArray(response.output) ? (response.output as Array<Record<string, unknown>>) : [];
  return output
    .filter((item) => item.type === 'message')
    .flatMap((item) => (Array.isArray(item.content) ? (item.content as Array<Record<string, unknown>>) : []))
    .filter((part) => part.type === 'output_text')
    .map((part) => String(part.text ?? ''))
    .join('');
}

const round1 = (value: number) => Math.round(value * 10) / 10;

export function parseReply(response: Record<string, unknown>): MealChatReply {
  const text = outputText(response);
  let parsed: MealChatReply;
  try {
    parsed = JSON.parse(text) as MealChatReply;
  } catch {
    throw new Error('MEAL_CHAT_INVALID_RESPONSE');
  }
  const reply = typeof parsed.reply === 'string' ? parsed.reply.trim() : '';
  const question = typeof parsed.question === 'string' && parsed.question.trim() ? parsed.question.trim() : null;
  const proposal = parsed.proposal && Array.isArray(parsed.proposal.items) ? parsed.proposal : null;
  if (!proposal) {
    return { reply: reply || 'Opisz proszę posiłek albo dodaj zdjęcie.', question, proposal: null };
  }
  const grams = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? round1(value) : 0);
  const items = proposal.items.slice(0, 30).map((item) => ({
    name: String(item.name ?? '').slice(0, 120),
    grams: typeof item.grams === 'number' && Number.isFinite(item.grams) && item.grams > 0 ? round1(item.grams) : null,
    carbs_g: grams(item.carbs_g),
    protein_g: grams(item.protein_g),
    fat_g: grams(item.fat_g),
    source: item.source === 'DIABCALC' ? 'DIABCALC' as const : 'ESTIMATE' as const,
  }));
  // Totals are the sum of the items, whatever the model wrote.
  const sum = (key: 'carbs_g' | 'protein_g' | 'fat_g') => round1(items.reduce((total, item) => total + item[key], 0));
  return {
    reply: reply || 'Oto moja propozycja.',
    question,
    proposal: {
      items,
      // The meal's carbs go to cards and Trio, which take whole grams: the total is whole, the items keep their tenths.
      carbs_g: Math.round(items.length > 0 ? sum('carbs_g') : grams(proposal.carbs_g)),
      protein_g: items.length > 0 ? sum('protein_g') : grams(proposal.protein_g),
      fat_g: items.length > 0 ? sum('fat_g') : grams(proposal.fat_g),
      confidence: proposal.confidence === 'HIGH' || proposal.confidence === 'MEDIUM' ? proposal.confidence : 'LOW',
      assumptions: String(proposal.assumptions ?? '').slice(0, 600),
    },
  };
}

/** Follows the reply field of each streamed round and reports it when it changes; a listener error is ignored. */
class ReplyDraftReader {
  private last = '';
  private roundWroteText = false;

  constructor(private readonly onDraft: (replySoFar: string) => void) {}

  startRound(): (outputTextSoFar: string) => void {
    this.roundWroteText = false;
    return (outputTextSoFar) => {
      const reply = readStreamingJsonStringField(outputTextSoFar, 'reply');
      if (reply === null || (reply === '' && !this.roundWroteText)) return;
      this.roundWroteText = true;
      this.publish(reply);
    };
  }

  /** The round asked for searches: what it wrote is not the reply. */
  discardRound(): void {
    if (this.roundWroteText) this.publish('');
  }

  private publish(text: string): void {
    if (text === this.last) return;
    this.last = text;
    try {
      this.onDraft(text);
    } catch {
      // Ignored: the reply is still stored.
    }
  }
}
