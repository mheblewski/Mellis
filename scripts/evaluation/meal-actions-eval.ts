/**
 * Evaluation of meal changes from the main chat (conversation-meal-actions.v1, stage 4 of
 * the conversation-meal-actions plan). Synthetic meals of one day go into an isolated test database; each
 * Polish scenario is answered by the AI gateway with get_meals / propose_meal_change (and DiabCalc in a live run), and
 * the stored cards are scored: the right operation and meal, values within tolerance, a question when the message is
 * too vague, nothing proposed for questions that are not changes, and no "zapisałem" in the answer.
 *
 * Dry run (default): a scripted oracle plays the model, so the database, the tools and the scoring are checked without
 * any paid call. Live run: --live, with OPENAI_* and the cost guard / budget ledger variables of a budgeted session.
 *
 *   TEST_DATABASE_URL=postgresql://…/…_test npx tsx scripts/evaluation/meal-actions-eval.ts [--live] [--only id,id] [--output-dir dir]
 */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { assertIntegrationTestDatabaseConfiguration, assertPoolUsesIsolatedTestDatabase, truncatePublicTablesForIntegrationTests } from '@infra/db/postgres-test-isolation';
import { PostgresConversationMealActionRepository } from '@infra/db/postgres-conversation-meal-actions.repository';
import { PostgresLoopActionRepository } from '@infra/db/postgres-loop-actions.repository';
import { PostgresMealRecordRepository } from '@infra/db/postgres-meal-history.repository';
import { PostgresMealWbtRepository } from '@infra/db/postgres-meal-wbt.repository';
import { AiGatewayService } from '@modules/ai-gateway/application/ai-gateway.service';
import { createConversationDirectResponseTask } from '@modules/ai-gateway/application/ai-task';
import type { AiProvider, AiProviderInput, AiProviderResponse } from '@modules/ai-gateway/domain/ai-gateway';
import { OpenAiProvider } from '@modules/ai-gateway/infrastructure/openai-provider';
import { parseOpenAiReasoningEffort } from '@infra/config/environment';
import { resolveOpenAiCostGuardFromEnv } from '@modules/ai-gateway/infrastructure/guarded-openai-client';
import { TieredAiProvider } from '@modules/ai-gateway/infrastructure/tiered-ai-provider';
import { DiabCalcMcpClient } from '@modules/meal-chat/infrastructure/diabcalc-mcp-client';
import { ConversationMealActionsService, type MealActionRecord } from '@modules/meal-actions/application/conversation-meal-actions.service';
import { finalizeMealActionAnswer, MealActionsToolSession } from '@modules/meal-actions/application/meal-actions-tool';
import { isMealEditRequest } from '@modules/meal-actions/application/meal-edit-intent';
import type { MealItem } from '@modules/meal-candidates/application/meal-items';

const TIME_ZONE = 'Europe/Warsaw';

// ---- The day the scenarios talk about ------------------------------------------------------------------------------

/** Today's local date and a local time as an ISO instant (Europe/Warsaw, either offset). */
function localInstant(date: string, time: string): string {
  for (const offset of ['+02:00', '+01:00']) {
    const candidate = new Date(`${date}T${time}:00${offset}`);
    const shown = new Intl.DateTimeFormat('sv-SE', { hour: '2-digit', minute: '2-digit', timeZone: TIME_ZONE }).format(candidate);
    if (shown === time) return candidate.toISOString();
  }
  return new Date(`${date}T${time}:00+01:00`).toISOString();
}

const TODAY = new Intl.DateTimeFormat('sv-SE', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: TIME_ZONE }).format(new Date());
const NOW = localInstant(TODAY, '17:30');

type MealKey = 'BREAKFAST' | 'LUNCH' | 'SNACK';
type EntryKey = 'BREAKFAST' | 'LUNCH' | 'ADD_ON' | 'CORRECTION' | 'SNACK';

interface SeededMeal {
  key: MealKey;
  time: string;
  carbs: number;
  bolus: number | null;
  content: { description: string; items: MealItem[] } | null;
  wbtReminder: boolean | null;
}

const MEALS: SeededMeal[] = [
  {
    key: 'BREAKFAST', time: '07:30', carbs: 35, bolus: 3.5, wbtReminder: null,
    content: {
      description: 'Owsianka na mleku',
      items: [
        { name: 'Płatki owsiane', grams: 40, carbs_g: 24, protein_g: 5, fat_g: 2.8, source: 'DIABCALC' },
        { name: 'Mleko 2%', grams: 200, carbs_g: 9.6, protein_g: 6.6, fat_g: 4, source: 'DIABCALC' },
      ],
    },
  },
  {
    key: 'LUNCH', time: '13:10', carbs: 40, bolus: 4, wbtReminder: true,
    content: {
      description: 'Zupa pomidorowa z makaronem',
      items: [
        { name: 'Zupa pomidorowa', grams: 250, carbs_g: 12.5, protein_g: 2.5, fat_g: 5, source: 'DIABCALC' },
        { name: 'Makaron ugotowany', grams: 100, carbs_g: 28, protein_g: 5, fat_g: 1, source: 'DIABCALC' },
      ],
    },
  },
  { key: 'SNACK', time: '16:30', carbs: 15, bolus: 1.5, wbtReminder: null, content: null },
];

/** Loop entries without an answer yet: 15 g at 13:40 (an add-on) and 10 g at 15:00 (correction carbs). */
const UNANSWERED = [
  { key: 'ADD_ON' as const, time: '13:40', carbs: 15 },
  { key: 'CORRECTION' as const, time: '15:00', carbs: 10 },
];

// ---- Scenarios -----------------------------------------------------------------------------------------------------

type Expectation =
  | { kind: 'PROPOSAL'; operations: string[]; meal?: MealKey; entry?: EntryKey; purpose?: string; target?: MealKey; carbs?: { value: number; tolerance: number } | 'MORE' | 'LESS'; fat?: number; enabled?: boolean; alsoOperations?: string[] }
  | { kind: 'ASK' }
  | { kind: 'NONE' };

interface Scenario {
  id: string;
  message: string;
  expect: Expectation;
  /** For the scripted oracle (dry run): the calls a correct model would make. */
  oracle: Array<Record<string, unknown>>;
}

const SCENARIOS: Scenario[] = [
  {
    id: 'replace-lunch',
    message: 'Zamiast zupy na obiad zjadł dwa naleśniki (razem ok. 120 g) z twarogiem półtłustym (ok. 60 g).',
    expect: { kind: 'PROPOSAL', operations: ['REPLACE_CONTENT'], meal: 'LUNCH', carbs: { value: 36, tolerance: 0.2 } },
    oracle: [{ operation: 'REPLACE_CONTENT', meal: 'LUNCH', items: [{ name: 'Naleśnik', grams: 120, carbs_g: 34.2, protein_g: 7.8, fat_g: 8.4, source: 'DIABCALC' }, { name: 'Twaróg półtłusty', grams: 60, carbs_g: 2.1, protein_g: 11.1, fat_g: 2.4, source: 'DIABCALC' }] }],
  },
  {
    id: 'replace-last-meal',
    message: 'Zamiast ostatniego posiłku, który wpisałem, zjadł 2 kromki chleba pszennego (po 30 g) z masłem.',
    expect: { kind: 'PROPOSAL', operations: ['REPLACE_CONTENT'], meal: 'SNACK', carbs: { value: 30, tolerance: 0.2 } },
    oracle: [{ operation: 'REPLACE_CONTENT', meal: 'SNACK', items: [{ name: 'Chleb pszenny', grams: 60, carbs_g: 29.4, protein_g: 4.8, fat_g: 1.2, source: 'DIABCALC' }, { name: 'Masło', grams: 5, carbs_g: 0, protein_g: 0, fat_g: 4.1, source: 'DIABCALC' }] }],
  },
  {
    id: 'half-lunch',
    message: 'Obiad zjadł tylko w połowie.',
    expect: { kind: 'PROPOSAL', operations: ['REPLACE_CONTENT', 'UPDATE_MACROS'], meal: 'LUNCH', carbs: { value: 20.3, tolerance: 0.15 } },
    oracle: [{ operation: 'REPLACE_CONTENT', meal: 'LUNCH', items: [{ name: 'Zupa pomidorowa', grams: 125, carbs_g: 6.3, protein_g: 1.3, fat_g: 2.5, source: 'DIABCALC' }, { name: 'Makaron ugotowany', grams: 50, carbs_g: 14, protein_g: 2.5, fat_g: 0.5, source: 'DIABCALC' }] }],
  },
  {
    id: 'pasta-left',
    message: 'Na obiad nie dojadł makaronu, zostało mniej więcej pół makaronu. Zupę zjadł całą.',
    expect: { kind: 'PROPOSAL', operations: ['REPLACE_CONTENT', 'UPDATE_MACROS'], meal: 'LUNCH', carbs: { value: 26.5, tolerance: 0.15 } },
    oracle: [{ operation: 'REPLACE_CONTENT', meal: 'LUNCH', items: [{ name: 'Zupa pomidorowa', grams: 250, carbs_g: 12.5, protein_g: 2.5, fat_g: 5, source: 'DIABCALC' }, { name: 'Makaron ugotowany', grams: 50, carbs_g: 14, protein_g: 2.5, fat_g: 0.5, source: 'DIABCALC' }] }],
  },
  {
    id: 'fat-only',
    message: 'W obiedzie tłuszczu było jednak 20 g, reszta się zgadza.',
    expect: { kind: 'PROPOSAL', operations: ['UPDATE_MACROS'], meal: 'LUNCH', fat: 20, carbs: { value: 40.5, tolerance: 0.01 } },
    oracle: [{ operation: 'UPDATE_MACROS', meal: 'LUNCH', fat_g: 20 }],
  },
  {
    id: 'more-breakfast',
    message: 'Na śniadanie zjadł jednak całą owsiankę i jeszcze banana (ok. 100 g).',
    expect: { kind: 'PROPOSAL', operations: ['REPLACE_CONTENT'], meal: 'BREAKFAST', carbs: { value: 54.6, tolerance: 0.15 } },
    oracle: [{ operation: 'REPLACE_CONTENT', meal: 'BREAKFAST', items: [{ name: 'Płatki owsiane', grams: 40, carbs_g: 24, protein_g: 5, fat_g: 2.8, source: 'DIABCALC' }, { name: 'Mleko 2%', grams: 200, carbs_g: 9.6, protein_g: 6.6, fat_g: 4, source: 'DIABCALC' }, { name: 'Banan', grams: 100, carbs_g: 21, protein_g: 1, fat_g: 0.3, source: 'DIABCALC' }] }],
  },
  {
    id: 'breakfast-was-pancakes',
    message: 'Na śniadanie nie było owsianki, tylko 3 naleśniki z dżemem truskawkowym (naleśniki razem 180 g, dżem 45 g).',
    expect: { kind: 'PROPOSAL', operations: ['REPLACE_CONTENT'], meal: 'BREAKFAST', carbs: { value: 80, tolerance: 0.2 } },
    oracle: [{ operation: 'REPLACE_CONTENT', meal: 'BREAKFAST', items: [{ name: 'Naleśnik', grams: 180, carbs_g: 51.3, protein_g: 11.7, fat_g: 12.6, source: 'DIABCALC' }, { name: 'Dżem truskawkowy', grams: 45, carbs_g: 27, protein_g: 0.2, fat_g: 0, source: 'DIABCALC' }] }],
  },
  {
    id: 'rename-breakfast',
    message: 'Zmień opis śniadania na: owsianka z cynamonem.',
    expect: { kind: 'PROPOSAL', operations: ['UPDATE_DESCRIPTION'], meal: 'BREAKFAST' },
    oracle: [{ operation: 'UPDATE_DESCRIPTION', meal: 'BREAKFAST', description: 'Owsianka z cynamonem' }],
  },
  {
    id: 'correction-entry',
    message: 'To wpisane o 15:00 to były węgle korekcyjne, nie jedzenie.',
    expect: { kind: 'PROPOSAL', operations: ['SET_PURPOSE'], entry: 'CORRECTION', purpose: 'CORRECTION' },
    oracle: [{ operation: 'SET_PURPOSE', entry: 'CORRECTION', purpose: 'CORRECTION' }],
  },
  {
    id: 'add-on-entry',
    message: 'Te 15 g o 13:40 to była dokładka do obiadu.',
    expect: { kind: 'PROPOSAL', operations: ['SET_PURPOSE'], entry: 'ADD_ON', purpose: 'MEAL_ADDITION', target: 'LUNCH' },
    oracle: [{ operation: 'SET_PURPOSE', entry: 'ADD_ON', purpose: 'MEAL_ADDITION', target_meal: 'LUNCH' }],
  },
  {
    id: 'delete-snack',
    message: 'Usuń posiłek z 16:30, to był błędny wpis.',
    expect: { kind: 'PROPOSAL', operations: ['SET_PURPOSE'], entry: 'SNACK', purpose: 'IGNORED' },
    oracle: [{ operation: 'SET_PURPOSE', entry: 'SNACK', purpose: 'IGNORED' }],
  },
  {
    id: 'hypo-entry',
    message: 'Te 10 g o 15:00 to był sok na niski cukier.',
    expect: { kind: 'PROPOSAL', operations: ['SET_PURPOSE'], entry: 'CORRECTION', purpose: 'HYPO_TREATMENT' },
    oracle: [{ operation: 'SET_PURPOSE', entry: 'CORRECTION', purpose: 'HYPO_TREATMENT' }],
  },
  {
    id: 'wbt-off',
    message: 'Nie przypominaj o WBT do obiadu.',
    expect: { kind: 'PROPOSAL', operations: ['SET_WBT_REMINDER'], meal: 'LUNCH', enabled: false },
    oracle: [{ operation: 'SET_WBT_REMINDER', meal: 'LUNCH', enabled: false }],
  },
  {
    id: 'two-changes',
    message: 'Do obiadu była jeszcze surówka z marchewki 100 g. I wyłącz przypomnienie o WBT do obiadu.',
    expect: { kind: 'PROPOSAL', operations: ['REPLACE_CONTENT'], meal: 'LUNCH', carbs: { value: 48, tolerance: 0.15 }, alsoOperations: ['SET_WBT_REMINDER'] },
    oracle: [
      { operation: 'REPLACE_CONTENT', meal: 'LUNCH', items: [{ name: 'Zupa pomidorowa', grams: 250, carbs_g: 12.5, protein_g: 2.5, fat_g: 5, source: 'DIABCALC' }, { name: 'Makaron ugotowany', grams: 100, carbs_g: 28, protein_g: 5, fat_g: 1, source: 'DIABCALC' }, { name: 'Surówka z marchewki', grams: 100, carbs_g: 7.5, protein_g: 1, fat_g: 0.2, source: 'ESTIMATE' }] },
      { operation: 'SET_WBT_REMINDER', meal: 'LUNCH', enabled: false },
    ],
  },
  {
    id: 'vague',
    message: 'Zamiast ostatniego posiłku zjadł coś innego.',
    expect: { kind: 'ASK' },
    oracle: [],
  },
  {
    id: 'unknown-amount',
    message: 'Zamiast zupy na obiad zjadł pierogi ruskie.',
    expect: { kind: 'ASK' },
    oracle: [],
  },
  {
    id: 'ambiguous-meal',
    message: 'Popraw posiłek z 13:00, było więcej makaronu.',
    expect: { kind: 'ASK' },
    oracle: [],
  },
  {
    id: 'not-a-change-dose',
    message: 'Ile insuliny podać na kolację z 2 kanapkami?',
    expect: { kind: 'NONE' },
    oracle: [],
  },
  {
    id: 'not-a-change-question',
    message: 'Ile węglowodanów miał dziś obiad?',
    expect: { kind: 'NONE' },
    oracle: [],
  },
  {
    id: 'typed-yes',
    message: 'tak, zapisz',
    expect: { kind: 'NONE' },
    oracle: [],
  },
];

// ---- Database ------------------------------------------------------------------------------------------------------

async function applyMigrations(pool: Pool): Promise<void> {
  const dir = resolve(__dirname, '../../infra/db/migrations');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const hasVector = ((await client.query(`SELECT 1 FROM pg_available_extensions WHERE name = 'vector'`)).rowCount ?? 0) > 0;
    for (const file of readdirSync(dir).filter((name) => name.endsWith('.sql')).sort()) {
      if (file === '026_meal_supersession.sql' || (!hasVector && file.startsWith('036_'))) continue;
      if (((await client.query('SELECT 1 FROM schema_migrations WHERE version = $1', [file])).rowCount ?? 0) > 0) continue;
      await client.query(readFileSync(join(dir, file), 'utf8'));
      await client.query('INSERT INTO schema_migrations(version) VALUES ($1)', [file]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

interface Seeded {
  patientId: string;
  userId: string;
  meals: Record<MealKey, string>;
  entries: Record<EntryKey, { carb: string; action: string }>;
}

async function seed(pool: Pool): Promise<Seeded> {
  await truncatePublicTablesForIntegrationTests(pool);
  const patientId = randomUUID();
  const userId = randomUUID();
  await pool.query(`INSERT INTO patients (id, display_name) VALUES ($1::uuid, 'meal-actions-eval')`, [patientId]);
  await pool.query(`INSERT INTO users (id, display_name) VALUES ($1::uuid, 'Opiekun')`, [userId]);
  const dayStart = localInstant(TODAY, '00:01');
  await pool.query(
    `INSERT INTO meal_history_epochs (patient_id, starts_at, assignment_policy_version, decided_by)
     VALUES ($1::uuid, $2::timestamptz, 'new-meal-assignment.v1', 'eval')`,
    [patientId, dayStart],
  );
  await pool.query(`INSERT INTO loop_action_epochs (patient_id, starts_at) VALUES ($1::uuid, $2::timestamptz)`, [patientId, dayStart]);

  const event = async (time: string, type: 'CARB_ENTRY' | 'BOLUS', value: number, secondsLater = 0): Promise<string> => {
    const sourceId = randomUUID();
    const recordId = randomUUID();
    const eventId = randomUUID();
    const at = new Date(Date.parse(localInstant(TODAY, time)) + secondsLater * 1000).toISOString();
    const payload = type === 'CARB_ENTRY' ? { carbs: value } : { insulin_units: value };
    await pool.query(`INSERT INTO sources (id, patient_id, source_system, source_key, metadata) VALUES ($1::uuid,$2::uuid,'NIGHTSCOUT',$3,'{}'::jsonb)`, [sourceId, patientId, `s-${sourceId}`]);
    await pool.query(
      `INSERT INTO source_records (id, patient_id, source_id, source_system, source_record_id, natural_key, record_type, occurred_at, recorded_at, raw_payload, provenance, canonical_hash)
       VALUES ($1::uuid,$2::uuid,$3::uuid,'NIGHTSCOUT',$4,$5,'TREATMENT',$6::timestamptz,$6::timestamptz,$7::jsonb,'{}'::jsonb,$8)`,
      [recordId, patientId, sourceId, `r-${recordId}`, `n-${recordId}`, at, JSON.stringify(payload), `h-${recordId}`],
    );
    await pool.query(
      `INSERT INTO events (id, patient_id, source_record_id, type, occurred_at, recorded_at, source, context, payload, event_ingestion_origin, created_at)
       VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5::timestamptz,$5::timestamptz,'{}'::jsonb,'{}'::jsonb,$6::jsonb,'LIVE',$7::timestamptz)`,
      [eventId, patientId, recordId, type, at, JSON.stringify(payload), new Date(Date.parse(at) + 60_000).toISOString()],
    );
    return eventId;
  };

  const loop = new PostgresLoopActionRepository(pool);
  const records = new PostgresMealRecordRepository(pool);
  const wbt = new PostgresMealWbtRepository(pool);
  const carbEvents = new Map<string, string>();
  for (const meal of MEALS) {
    carbEvents.set(meal.key, await event(meal.time, 'CARB_ENTRY', meal.carbs));
    if (meal.bolus !== null) await event(meal.time, 'BOLUS', meal.bolus, 40);
  }
  for (const entry of UNANSWERED) carbEvents.set(entry.key, await event(entry.time, 'CARB_ENTRY', entry.carbs));
  await loop.groupNewEvents(patientId);
  const actions = await loop.listActionsBetween(patientId, dayStart, NOW);
  const actionOf = (carb: string) => actions.find((action) => action.carb_event_id === carb)!.id;

  const meals = {} as Record<MealKey, string>;
  for (const meal of MEALS) {
    const actionId = actionOf(carbEvents.get(meal.key)!);
    await loop.assign({ patientId, actionId, purpose: 'NEW_MEAL', mealRecordId: null, userId });
    const mealId = (await loop.getAction(patientId, actionId))!.meal_record_id!;
    meals[meal.key] = mealId;
    const identity = (await records.findMealIdentityById(patientId, mealId))!;
    if (meal.content) {
      const totals = meal.content.items.reduce((sum, item) => ({ carbs_g: sum.carbs_g + item.carbs_g, protein_g: sum.protein_g + item.protein_g, fat_g: sum.fat_g + item.fat_g }), { carbs_g: 0, protein_g: 0, fat_g: 0 });
      const round = (value: number) => Math.round(value * 10) / 10;
      await records.editContent(patientId, identity, userId, { description: meal.content.description, items: meal.content.items, macros: { carbs_g: round(totals.carbs_g), protein_g: round(totals.protein_g), fat_g: round(totals.fat_g) } });
    }
    if (meal.wbtReminder !== null) await wbt.setManualReminder({ patientId, mealRecordId: mealId, enabled: meal.wbtReminder, remindAt: NOW, userId });
  }
  const entries = {} as Record<EntryKey, { carb: string; action: string }>;
  for (const key of ['BREAKFAST', 'LUNCH', 'SNACK', 'ADD_ON', 'CORRECTION'] as EntryKey[]) {
    const carb = carbEvents.get(key)!;
    entries[key] = { carb, action: actionOf(carb) };
  }
  return { patientId, userId, meals, entries };
}

async function newConversation(pool: Pool, patientId: string, message: string): Promise<{ conversationId: string; userMessageId: string }> {
  const conversationId = randomUUID();
  const userMessageId = randomUUID();
  await pool.query(`INSERT INTO conversations (id, patient_id, thread_state_version) VALUES ($1::uuid, $2::uuid, 'v1')`, [conversationId, patientId]);
  await pool.query(
    `INSERT INTO messages (id, conversation_id, patient_id, role, message_type, content, provenance_ref, idempotency_key)
     VALUES ($1::uuid, $2::uuid, $3::uuid, 'USER', 'USER_MESSAGE', $4, 'eval', $5)`,
    [userMessageId, conversationId, patientId, message, `eval-${userMessageId}`],
  );
  return { conversationId, userMessageId };
}

// ---- Providers -----------------------------------------------------------------------------------------------------

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function liveProvider(): AiProvider {
  const env = process.env;
  const apiKey = requireEnv('OPENAI_API_KEY');
  const timeoutMs = Number(env.OPENAI_TIMEOUT_MS ?? 90_000);
  const reasoningEffort = env.OPENAI_REASONING_EFFORT ? parseOpenAiReasoningEffort(env.OPENAI_REASONING_EFFORT) ?? null : null;
  const provider = (pricingEnv: NodeJS.ProcessEnv, model: string) => {
    const guard = resolveOpenAiCostGuardFromEnv(pricingEnv);
    return new OpenAiProvider({ apiKey, model, timeoutMs, reasoningEffort, pricing: guard.pricing, costGuard: guard.costGuard, budgetLedger: guard.budgetLedger });
  };
  const light: NodeJS.ProcessEnv = { ...env };
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith('OPENAI_LIGHT_PRICING_')) light[key.replace('OPENAI_LIGHT_PRICING_', 'OPENAI_PRICING_')] = value;
  }
  return new TieredAiProvider(provider(env, requireEnv('OPENAI_MODEL')), provider(light, requireEnv('OPENAI_LIGHT_MODEL')));
}

/** Dry run: plays a correct model (get_meals, then the scenario's proposals with real handles, then an answer). */
class OracleProvider implements AiProvider {
  private turn = 0;
  private handles: Record<string, string> = {};
  constructor(private readonly scenario: Scenario, private readonly seeded: Seeded) {}

  async generate(input: AiProviderInput): Promise<AiProviderResponse> {
    const base = { provider: 'oracle', model: 'oracle', response_id: `oracle-${this.turn}`, received_at: new Date().toISOString(), usage: null, estimated_cost: null } as unknown as AiProviderResponse;
    const results = input.tool_runtime?.tool_results ?? [];
    const listing = results.find((result) => result.tool_name === 'get_meals')?.result as { meals?: Array<{ meal: string; time: string }>; entries?: Array<{ entry: string; time: string }> } | undefined;
    if (listing) {
      for (const meal of MEALS) this.handles[`M:${meal.key}`] = listing.meals?.find((entry) => entry.time === meal.time)?.meal ?? '';
      for (const [key, time] of [['BREAKFAST', '07:30'], ['LUNCH', '13:10'], ['SNACK', '16:30'], ['ADD_ON', '13:40'], ['CORRECTION', '15:00']]) {
        this.handles[`E:${key}`] = listing.entries?.find((entry) => entry.time === time && entry.entry)?.entry ?? '';
      }
    }
    const step = this.turn++;
    const wantsMeals = this.scenario.oracle.length > 0;
    if (wantsMeals && step === 0) {
      return { ...base, raw_output: {}, tool_calls: [{ call_id: 'oracle-get', tool_name: 'get_meals', arguments: { days_back: 1 } }] };
    }
    const proposal = wantsMeals ? this.scenario.oracle[step - 1] : undefined;
    if (proposal) {
      const args = {
        operation: proposal.operation, meal: proposal.meal ? this.handles[`M:${proposal.meal}`] : null, entry: proposal.entry ? this.handles[`E:${proposal.entry}`] : null,
        items: proposal.items ?? null, description: proposal.description ?? null, carbs_g: proposal.carbs_g ?? null, protein_g: proposal.protein_g ?? null, fat_g: proposal.fat_g ?? null,
        purpose: proposal.purpose ?? null, target_meal: proposal.target_meal ? this.handles[`M:${proposal.target_meal}`] : null, enabled: proposal.enabled ?? null, reason: 'oracle',
      };
      return { ...base, raw_output: {}, tool_calls: [{ call_id: `oracle-${step}`, tool_name: 'propose_meal_change', arguments: args }] };
    }
    const text = this.scenario.expect.kind === 'ASK' ? 'Co dokładnie zjadł i ile?' : 'Przygotowałem zmianę do zatwierdzenia na karcie.';
    return { ...base, raw_output: { assistant_message: text, follow_up_candidates: [], conversation_title: null } };
  }
}

// ---- Scoring -------------------------------------------------------------------------------------------------------

interface Outcome {
  id: string;
  message: string;
  pass: boolean;
  problems: string[];
  cards: Array<{ operation: string; title: string; status: string; after: unknown; warnings: string[] }>;
  answer: string;
  corrected_claim: boolean;
  tool_calls: string[];
  cost_usd: number | null;
  tier: string | null;
  error: string | null;
}

function score(scenario: Scenario, seeded: Seeded, cards: MealActionRecord[], answer: string, corrected: boolean, before: Record<MealKey, { carbs: number | null }>): string[] {
  const problems: string[] = [];
  if (corrected) problems.push('the answer claimed a save');
  const expect = scenario.expect;
  if (expect.kind === 'NONE') {
    if (cards.length > 0) problems.push(`proposed ${cards.map((card) => card.operation).join(', ')} for a message that is not a change`);
    return problems;
  }
  if (expect.kind === 'ASK') {
    if (cards.length > 0) problems.push(`proposed ${cards.map((card) => card.operation).join(', ')} instead of asking`);
    // A question or a request for the missing data ("Napisz proszę, ile…", "potrzebna jest waga porcji").
    if (!/\?|napisz|podaj|daj znać|potrzeb|ile |jak[aie]? /i.test(answer)) problems.push('no question in the answer');
    return problems;
  }
  const main = cards.find((card) => expect.operations.includes(card.operation));
  if (!main) {
    problems.push(`expected ${expect.operations.join(' or ')}, got ${cards.map((card) => card.operation).join(', ') || 'no card'}`);
    return problems;
  }
  if (expect.meal && main.meal_record_id !== seeded.meals[expect.meal] && main.after.kind !== 'PURPOSE') problems.push(`changed the wrong meal (expected ${expect.meal})`);
  if (expect.entry) {
    const entry = seeded.entries[expect.entry];
    if (main.loop_action_id !== entry.action && main.carb_event_id !== entry.carb) problems.push(`changed the wrong loop entry (expected ${expect.entry})`);
  }
  if (expect.purpose && (main.after as { purpose?: string }).purpose !== expect.purpose) problems.push(`purpose ${(main.after as { purpose?: string }).purpose} instead of ${expect.purpose}`);
  if (expect.target && (main.after as { meal_id?: string }).meal_id !== seeded.meals[expect.target]) problems.push(`target meal is not ${expect.target}`);
  if (expect.enabled !== undefined && (main.after as { enabled?: boolean }).enabled !== expect.enabled) problems.push(`reminder ${(main.after as { enabled?: boolean }).enabled} instead of ${expect.enabled}`);
  const carbs = (main.after as { carbs_g?: number | null }).carbs_g ?? null;
  if (expect.fat !== undefined && (main.after as { fat_g?: number }).fat_g !== expect.fat) problems.push(`fat ${(main.after as { fat_g?: number }).fat_g} instead of ${expect.fat}`);
  if (expect.carbs !== undefined && expect.meal) {
    const previous = before[expect.meal].carbs;
    if (carbs === null) problems.push('no carbohydrates on the card');
    else if (expect.carbs === 'MORE' && previous !== null && carbs <= previous) problems.push(`carbs ${carbs} not above ${previous}`);
    else if (expect.carbs === 'LESS' && previous !== null && carbs >= previous) problems.push(`carbs ${carbs} not below ${previous}`);
    else if (typeof expect.carbs === 'object' && Math.abs(carbs - expect.carbs.value) > expect.carbs.value * expect.carbs.tolerance) {
      problems.push(`carbs ${carbs} g outside ${expect.carbs.value} g ±${Math.round(expect.carbs.tolerance * 100)}%`);
    }
  }
  for (const operation of expect.alsoOperations ?? []) {
    if (!cards.some((card) => card.operation === operation)) problems.push(`missing the second change ${operation}`);
  }
  return problems;
}

/** Money settled in the budget ledger so far (live runs): the per-scenario cost is the difference. */
function ledgerCharged(): number | null {
  const path = process.env.AI_EXPERIMENT_BUDGET_LEDGER_PATH;
  if (!path) return null;
  try {
    const ledger = JSON.parse(readFileSync(path, 'utf8')) as { reservations?: Array<{ actual_cost?: number | null }> };
    return (ledger.reservations ?? []).reduce((sum, entry) => sum + (typeof entry.actual_cost === 'number' ? entry.actual_cost : 0), 0);
  } catch {
    return null;
  }
}

// ---- Run -----------------------------------------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const live = args.includes('--live');
  const onlyIndex = args.indexOf('--only');
  const only = onlyIndex >= 0 ? new Set(args[onlyIndex + 1].split(',')) : null;
  const outIndex = args.indexOf('--output-dir');
  const outputDir = outIndex >= 0 ? args[outIndex + 1] : join(process.cwd(), 'artifacts', 'meal-actions-eval');
  const { testDatabaseUrl } = assertIntegrationTestDatabaseConfiguration(process.env);
  const pool = new Pool({ connectionString: testDatabaseUrl, max: 4 });
  process.env.DATABASE_URL = testDatabaseUrl;
  await assertPoolUsesIsolatedTestDatabase(pool);
  await applyMigrations(pool);

  const outcomes: Outcome[] = [];
  const foods = live ? DiabCalcMcpClient.fromEnv(process.env) : null;
  for (const scenario of SCENARIOS.filter((entry) => !only || only.has(entry.id))) {
    const seeded = await seed(pool);
    const store = new PostgresConversationMealActionRepository(pool);
    const notHere = async () => { throw new Error('not applied in the evaluation'); };
    const service = new ConversationMealActionsService(store, { assignLoopAction: notHere, setCarbEntryKind: notHere, detachCarbEntry: notHere, setWbtReminder: notHere, afterMealValuesChanged: notHere });
    const before = {} as Record<MealKey, { carbs: number | null }>;
    for (const meal of MEALS) before[meal.key] = { carbs: (await store.loadMealState(seeded.patientId, seeded.meals[meal.key]))?.state.carbs_g ?? null };
    const { conversationId, userMessageId } = await newConversation(pool, seeded.patientId, scenario.message);
    const session = new MealActionsToolSession({
      patientId: seeded.patientId, conversationId, userMessageId, service, catalog: store,
      mealChangeRequested: isMealEditRequest(scenario.message), now: () => new Date(NOW), timeZone: TIME_ZONE,
    });
    const context: any = {
      context_package_id: `meal-eval:${scenario.id}`, context_package_version: 'conversation-context.v1', content_hash: `sha256:meal-eval-${scenario.id}-${randomUUID()}`,
      created_at: NOW, patient_ref: { patient_id: seeded.patientId },
      conversation_context: { thread_id: conversationId, thread_state_version: 'v1', awaiting_user_answer: false, messages: [{ role: 'USER', message_type: 'USER_MESSAGE', content: scenario.message, created_at: NOW }] },
      direct_response_input: { user_message_id: userMessageId, user_message_text: scenario.message },
      current_state_snapshot: null, patient_facts: [], provenance: { source_refs: [userMessageId] },
    };
    const task = createConversationDirectResponseTask({
      task_id: `meal-eval-${scenario.id}`, context_package_id: context.context_package_id, context_package_version: context.context_package_version,
      context_package_hash: context.content_hash, correlation_id: conversationId, created_at: NOW, patient_id: seeded.patientId,
    });
    const provider = live ? liveProvider() : new OracleProvider(scenario, seeded);
    const gateway = new AiGatewayService(provider);
    let answer = '';
    let error: string | null = null;
    let cost: number | null = null;
    let tier: string | null = null;
    let toolCalls: string[] = [];
    const chargedBefore = live ? ledgerCharged() : null;
    try {
      const execution = await gateway.execute({ task, context_package: context, timeout_ms: Number(process.env.OPENAI_TIMEOUT_MS ?? 90_000), meal_actions: session, ...(foods ? { food_search: foods } : {}) });
      answer = String((execution.result as { assistant_message?: string }).assistant_message ?? '');
      toolCalls = (execution.metadata.evidence_tool_calls ?? []).map((call) => `${call.tool_name}:${call.result_status}`);
      tier = (execution.metadata as unknown as { model_tier?: string }).model_tier ?? null;
    } catch (failure) {
      error = failure instanceof Error ? `${failure.name}: ${failure.message}` : String(failure);
    }
    const chargedAfter = live ? ledgerCharged() : null;
    cost = chargedBefore !== null && chargedAfter !== null ? Math.round((chargedAfter - chargedBefore) * 10_000) / 10_000 : null;
    const { corrected } = finalizeMealActionAnswer(answer, session);
    const cards = (await store.listForUserMessage(seeded.patientId, userMessageId)).filter((card) => card.status === 'PROPOSED');
    const problems = error ? [`failed: ${error}`] : score(scenario, seeded, cards, answer, corrected, before);
    outcomes.push({
      id: scenario.id, message: scenario.message, pass: problems.length === 0, problems,
      cards: cards.map((card) => ({ operation: card.operation, title: card.title, status: card.status, after: card.after, warnings: card.warnings.map((warning) => warning.message) })),
      answer, corrected_claim: corrected, tool_calls: toolCalls, cost_usd: cost, tier, error,
    });
    console.log(`${problems.length === 0 ? 'PASS' : 'FAIL'} ${scenario.id}${problems.length ? ` — ${problems.join('; ')}` : ''}`);
  }
  await truncatePublicTablesForIntegrationTests(pool);
  await pool.end();

  const passed = outcomes.filter((outcome) => outcome.pass).length;
  const totalCost = outcomes.reduce((sum, outcome) => sum + (outcome.cost_usd ?? 0), 0);
  mkdirSync(outputDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  writeFileSync(join(outputDir, `meal-actions-eval-${live ? 'live' : 'dry'}-${stamp}.json`), JSON.stringify({ live, now: NOW, passed, total: outcomes.length, total_cost_usd: totalCost, outcomes }, null, 2));
  const lines = [
    `# Meal changes from the chat: evaluation (${live ? 'live' : 'dry run, scripted oracle'})`,
    '',
    `${passed}/${outcomes.length} passed${live ? `, cost ≈ ${totalCost.toFixed(3)} USD` : ''}.`,
    '',
    '| Scenario | Result | Cards | Problems |',
    '|---|---|---|---|',
    ...outcomes.map((outcome) => `| ${outcome.id} | ${outcome.pass ? 'PASS' : 'FAIL'} | ${outcome.cards.map((card) => card.operation).join(', ') || '—'} | ${outcome.problems.join('; ') || ''} |`),
    '',
    '## Answers',
    '',
    ...outcomes.flatMap((outcome) => [`### ${outcome.id}`, '', `> ${outcome.message}`, '', outcome.answer || `(no answer: ${outcome.error ?? 'empty'})`, '']),
  ];
  writeFileSync(join(outputDir, `meal-actions-eval-${live ? 'live' : 'dry'}-${stamp}.md`), lines.join('\n'));
  console.log(`${passed}/${outcomes.length} passed${live ? `, cost ≈ ${totalCost.toFixed(3)} USD` : ''}; report in ${outputDir}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
