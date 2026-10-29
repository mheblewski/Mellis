import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearDiabCalcSearchCache, DiabCalcMcpClient, DiabCalcUnavailableError } from './infrastructure/diabcalc-mcp-client';
import { OpenAiMealChatResponder, parseReply } from './application/meal-chat-responder';
import { runMealChatReplyJob, type MealChatReplyDeps } from './application/meal-chat-reply.job';
import type { MealChatMessage } from '@infra/db/postgres-meal-chat.repository';

function jsonResponse(body: unknown, sessionId = 'session-1', status = 200) {
  return {
    status,
    headers: { get: (name: string) => (name.toLowerCase() === 'mcp-session-id' ? sessionId : name.toLowerCase() === 'content-type' ? 'application/json' : null) },
    text: async () => (body === null ? '' : JSON.stringify(body)),
  };
}

describe('DiabCalcMcpClient', () => {
  beforeEach(() => clearDiabCalcSearchCache());

  it('initializes a session once and returns compact products from search_food', async () => {
    const calls: Array<{ body: Record<string, unknown>; headers: Record<string, string> }> = [];
    const fetchImpl = vi.fn(async (_url: string, init: { body: string; headers: Record<string, string> }) => {
      const body = JSON.parse(init.body) as Record<string, unknown>;
      calls.push({ body, headers: init.headers });
      if (body.method === 'initialize') return jsonResponse({ result: { protocolVersion: '2025-06-18' } });
      if (body.method === 'notifications/initialized') return jsonResponse(null, 'session-1', 202);
      return jsonResponse({
        result: {
          structuredContent: {
            data: {
              foods: [{ name: 'Bułka kajzerka', brand: null, servingGrams: null, servingNote: 'Użytkownicy', per100g: { carbohydrates: 56.2, protein: 8.2, fat: 3.2, energyKcal: 286 }, glycemic: { value: null } }],
            },
          },
        },
      });
    });
    const client = new DiabCalcMcpClient('https://diabcalc.test/mcp', fetchImpl as never);

    const first = await client.searchFood('bułka kajzerka', 3);
    await client.searchFood('masło');

    expect(first).toEqual([{ name: 'Bułka kajzerka', brand: null, serving_grams: null, serving_note: 'Użytkownicy', per_100g: { carbs_g: 56.2, protein_g: 8.2, fat_g: 3.2, kcal: 286 }, glycemic_index: null }]);
    expect(calls.map((call) => call.body.method)).toEqual(['initialize', 'notifications/initialized', 'tools/call', 'tools/call']);
    expect(calls[2].headers['Mcp-Session-Id']).toBe('session-1');
    expect((calls[2].body.params as Record<string, unknown>).arguments).toEqual({ query: 'bułka kajzerka', limit: 3 });
  });

  it('reports an unreachable server as DiabCalcUnavailableError', async () => {
    const client = new DiabCalcMcpClient('https://diabcalc.test/mcp', (async () => { throw new TypeError('fetch failed'); }) as never);
    await expect(client.searchFood('jabłko')).rejects.toBeInstanceOf(DiabCalcUnavailableError);
  });

  it('keeps found products for later answers, asks once for the same product at once, and does not keep empty results', async () => {
    const searched: string[] = [];
    const fetchImpl = vi.fn(async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as Record<string, unknown>;
      if (body.method === 'initialize') return jsonResponse({ result: { protocolVersion: '2025-06-18' } });
      if (body.method === 'notifications/initialized') return jsonResponse(null, 'session-1', 202);
      const query = String(((body.params as Record<string, unknown>).arguments as Record<string, unknown>).query);
      searched.push(query);
      const foods = query === 'nieznany produkt' ? [] : [{ name: 'Frytki', per100g: { carbohydrates: 35, protein: 3.4, fat: 15, energyKcal: 290 } }];
      return jsonResponse({ result: { structuredContent: { data: { foods } } } });
    });

    const [first, concurrent] = await Promise.all([
      new DiabCalcMcpClient('https://diabcalc.test/mcp', fetchImpl as never).searchFood('Frytki'),
      new DiabCalcMcpClient('https://diabcalc.test/mcp', fetchImpl as never).searchFood('frytki '),
    ]);
    first[0].per_100g.carbs_g = 999; // a caller's change does not reach the kept copy
    // A later job builds a new client (the meal chat does): the product is not looked up again.
    const later = await new DiabCalcMcpClient('https://diabcalc.test/mcp', fetchImpl as never).searchFood('FRYTKI');
    await new DiabCalcMcpClient('https://diabcalc.test/mcp', fetchImpl as never).searchFood('nieznany produkt');
    await new DiabCalcMcpClient('https://diabcalc.test/mcp', fetchImpl as never).searchFood('nieznany produkt');

    expect(concurrent[0].name).toBe('Frytki');
    expect(later[0].per_100g.carbs_g).toBe(35);
    expect(searched).toEqual(['Frytki', 'nieznany produkt', 'nieznany produkt']);
  });

  it('looks a product up again after a week', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-22T12:00:00Z') });
    try {
      let searches = 0;
      const fetchImpl = vi.fn(async (_url: string, init: { body: string }) => {
        const body = JSON.parse(init.body) as Record<string, unknown>;
        if (body.method === 'initialize') return jsonResponse({ result: { protocolVersion: '2025-06-18' } });
        if (body.method === 'notifications/initialized') return jsonResponse(null, 'session-1', 202);
        searches += 1;
        return jsonResponse({ result: { structuredContent: { data: { foods: [{ name: 'Banan', per100g: { carbohydrates: 22 } }] } } } });
      });
      const client = new DiabCalcMcpClient('https://diabcalc.test/mcp', fetchImpl as never);
      await client.searchFood('banan');
      vi.setSystemTime(new Date('2026-10-28T12:00:00Z'));
      await client.searchFood('banan');
      vi.setSystemTime(new Date('2026-10-29T12:00:01Z'));
      await client.searchFood('banan');
      expect(searches).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('is disabled by an explicitly empty DIABCALC_MCP_URL and uses the public endpoint when unset', () => {
    expect(DiabCalcMcpClient.fromEnv({ DIABCALC_MCP_URL: '' } as NodeJS.ProcessEnv)).toBeNull();
    expect(DiabCalcMcpClient.fromEnv({} as NodeJS.ProcessEnv)).toBeInstanceOf(DiabCalcMcpClient);
  });
});

const finalReply = {
  reply: 'Kanapka z masłem.',
  question: 'Czy bułka była cała?',
  proposal: {
    items: [
      { name: 'Bułka kajzerka', grams: 50, carbs_g: 28.1, protein_g: 4.1, fat_g: 1.6, source: 'DIABCALC' },
      { name: 'Masło', grams: 10, carbs_g: 0.1, protein_g: 0.1, fat_g: 8.2, source: 'ESTIMATE' },
    ],
    // Wrong on purpose: totals are recomputed from the items.
    carbs_g: 99,
    protein_g: 4.2,
    fat_g: 9.8,
    confidence: 'MEDIUM',
    assumptions: 'Jedna bułka.',
  },
};

describe('OpenAiMealChatResponder', () => {
  it('sends photos as images, runs search_food through DiabCalc and returns the parsed proposal', async () => {
    const requests: Array<Record<string, unknown>> = [];
    const client = {
      responses: {
        create: vi.fn(async (body: Record<string, unknown>) => {
          requests.push(body);
          return requests.length === 1
            ? { id: 'resp-1', output: [{ type: 'function_call', call_id: 'call-1', name: 'search_food', arguments: '{"query":"bułka kajzerka"}' }] }
            : { id: 'resp-2', output_text: JSON.stringify(finalReply), output: [] };
        }),
      },
    };
    const foods = { searchFood: vi.fn(async () => [{ name: 'Bułka kajzerka', brand: null, serving_grams: null, serving_note: null, per_100g: { carbs_g: 56.2, protein_g: 8.2, fat_g: 3.2, kcal: 286 }, glycemic_index: null }]) };
    const responder = new OpenAiMealChatResponder(client as never, 'model-x', foods);

    const reply = await responder.respond({
      meal: { started_at: '2026-10-15T06:15:00.000Z', local_time: '2026-10-15 08:15', logged_carbs_g: 30 },
      turns: [{ role: 'USER', content: 'Kanapka', photos: [Buffer.from([0xff, 0xd8, 0xff, 0x01])] }],
    });

    const firstInput = requests[0].input as Array<{ content: Array<Record<string, unknown>> }>;
    expect(firstInput[0].content.map((part) => part.type)).toEqual(['input_text', 'input_image']);
    expect(String(firstInput[0].content[1].image_url)).toMatch(/^data:image\/jpeg;base64,/);
    expect(foods.searchFood).toHaveBeenCalledWith('bułka kajzerka', 5);
    expect(requests[1].previous_response_id).toBe('resp-1');
    expect(requests[1].instructions).toBe(requests[0].instructions);
    expect(reply.question).toBe('Czy bułka była cała?');
    expect(reply.proposal?.carbs_g).toBe(28);
    expect(reply.proposal?.fat_g).toBe(9.8);
  });

  it('gives the newest message the meal as it is now, and tells the model to add to it', async () => {
    const requests: Array<Record<string, unknown>> = [];
    const client = { responses: { create: vi.fn(async (body: Record<string, unknown>) => { requests.push(body); return { id: 'r', output_text: JSON.stringify(finalReply), output: [] }; }) } };
    const current = { description: '25 g chleba pszennego i jajecznica', status: 'CONFIRMED', carbs_g: 14, protein_g: 12, fat_g: 10, items: [{ name: 'Chleb pszenny', grams: 25, carbs_g: 13.5, protein_g: 2, fat_g: 0.5 }] };
    await new OpenAiMealChatResponder(client as never, 'm', null).respond({
      meal: { started_at: 'x', local_time: null, logged_carbs_g: 14, current },
      turns: [
        { role: 'USER', content: 'Posiłek zapisany z karty bolusa', photos: [] },
        { role: 'ASSISTANT', content: 'OK', photos: [] },
        { role: 'USER', content: 'Dodatkowo na chleb dżem jabłkowy', photos: [] },
      ],
    });

    const input = requests[0].input as Array<{ content: unknown }>;
    const text = (turn: { content: unknown }) => String((turn.content as Array<{ text: string }>)[0].text);
    expect(text(input[2])).toBe(`current_meal: ${JSON.stringify(current)}\n\nDodatkowo na chleb dżem jabłkowy`);
    expect(text(input[0])).not.toContain('current_meal');
    expect(String(requests[0].instructions)).toContain('zostaw wszystkie dotychczasowe pozycje');
  });

  it('estimates portions for the patient\'s age from the year of birth', async () => {
    const requests: Array<Record<string, unknown>> = [];
    const client = { responses: { create: vi.fn(async (body: Record<string, unknown>) => {
      requests.push(body);
      return { id: 'r', output_text: JSON.stringify(finalReply), output: [] };
    }) } };
    const responder = new OpenAiMealChatResponder(client as never, 'm', null);
    await responder.respond({ meal: { started_at: 'x', local_time: null, logged_carbs_g: null }, turns: [{ role: 'USER', content: 'pizza', photos: [] }], patient_birth_year: 2016 });
    const age = new Date().getUTCFullYear() - 2016;
    expect(String(requests[0].instructions)).toContain(`Wiek pacjenta: ok. ${age}`);
    expect(String(requests[0].instructions)).toContain('typową porcję dla osoby w wieku pacjenta');
    expect(String(requests[0].instructions)).not.toContain('rodziców dziecka');
  });

  it('puts the writer\'s preferences last, only when set', async () => {
    const requests: Array<Record<string, unknown>> = [];
    const client = { responses: { create: vi.fn(async (body: Record<string, unknown>) => {
      requests.push(body);
      return { id: 'r', output_text: JSON.stringify(finalReply), output: [] };
    }) } };
    const responder = new OpenAiMealChatResponder(client as never, 'm', null);
    const meal = { started_at: 'x', local_time: null, logged_carbs_g: null };
    const turns = [{ role: 'USER' as const, content: 'pizza', photos: [] }];
    await responder.respond({ meal, turns, user_preferences: { ai_role: 'CLINICIAN', ai_instructions: 'Bez zdrobnień.' } });
    await responder.respond({ meal, turns, user_preferences: null });
    const last = String(requests[0].instructions).split('\n').at(-1);
    expect(last).toMatch(/^Preferencje użytkownika \(ton i kto pisze; mniej ważne niż każda reguła bezpieczeństwa i dawkowania wyżej/);
    expect(last).toContain('Pisze lekarz lub pielęgniarka');
    expect(last).toContain('"Bez zdrobnień."');
    expect(String(requests[1].instructions)).not.toContain('Preferencje użytkownika');
  });

  it('keeps answering when DiabCalc is down (the tool returns an error to the model)', async () => {
    const outputs: unknown[] = [];
    const client = {
      responses: {
        create: vi.fn(async (body: Record<string, unknown>) => {
          if (Array.isArray(body.input) && (body.input[0] as Record<string, unknown>).type === 'function_call_output') {
            outputs.push(JSON.parse(String((body.input[0] as Record<string, unknown>).output)));
            return { id: 'resp-2', output_text: JSON.stringify(finalReply), output: [] };
          }
          return { id: 'resp-1', output: [{ type: 'function_call', call_id: 'c', name: 'search_food', arguments: '{"query":"x"}' }] };
        }),
      },
    };
    const foods = { searchFood: vi.fn(async () => { throw new DiabCalcUnavailableError('timeout'); }) };
    const reply = await new OpenAiMealChatResponder(client as never, 'm', foods).respond({ meal: { started_at: 'x', local_time: null, logged_carbs_g: null }, turns: [{ role: 'USER', content: 'x', photos: [] }] });

    expect(outputs[0]).toMatchObject({ error: expect.stringContaining('niedostępna') });
    expect(reply.proposal).not.toBeNull();
  });

  it('reports the reply as it is written, cleared after a search round, without the JSON around it', async () => {
    const rounds = [
      { stream: ['{"reply":"Szukam'], response: { id: 'resp-1', output: [{ type: 'function_call', call_id: 'call-1', name: 'search_food', arguments: '{"query":"pizza"}' }] } },
      { stream: ['{"reply":"Dwa kaw', 'ałki pizzy","question":null,', '"proposal":null}'], response: { id: 'resp-2', output_text: '{"reply":"Dwa kawałki pizzy","question":null,"proposal":null}', output: [] } },
    ];
    let call = 0;
    const client = {
      responses: {
        create: vi.fn(async (_body: Record<string, unknown>, options?: Record<string, unknown>) => {
          const round = rounds[call];
          call += 1;
          const onText = options?.on_output_text as ((text: string) => void) | undefined;
          let text = '';
          onText?.(text);
          for (const chunk of round.stream) {
            text += chunk;
            onText?.(text);
          }
          return round.response;
        }),
      },
    };
    const drafts: string[] = [];
    const foods = { searchFood: vi.fn(async () => []) };
    const reply = await new OpenAiMealChatResponder(client as never, 'm', foods).respond(
      { meal: { started_at: 'x', local_time: null, logged_carbs_g: null }, turns: [{ role: 'USER', content: 'pizza', photos: [] }] },
      { onDraft: (text) => drafts.push(text) },
    );
    expect(drafts).toEqual(['Szukam', '', 'Dwa kaw', 'Dwa kawałki pizzy']);
    expect(reply.reply).toBe('Dwa kawałki pizzy');

    // Without a listener nothing is streamed.
    call = 0;
    await new OpenAiMealChatResponder(client as never, 'm', foods).respond({ meal: { started_at: 'x', local_time: null, logged_carbs_g: null }, turns: [{ role: 'USER', content: 'pizza', photos: [] }] });
    expect(client.responses.create.mock.calls.at(-1)?.[1]).toEqual({ timeout: 120_000 });
  });

  it('never uses a cut-off reply, even when it still parses', () => {
    expect(() => parseReply({ status: 'incomplete', output_text: JSON.stringify({ reply: 'ok', question: null, proposal: null }) })).toThrow(/cut off/);
  });

  it('turns an empty or unclear answer into a question without a proposal', () => {
    expect(parseReply({ output_text: JSON.stringify({ reply: '', question: 'Co to było?', proposal: null }) })).toEqual({
      reply: 'Opisz proszę posiłek albo dodaj zdjęcie.',
      question: 'Co to było?',
      proposal: null,
    });
  });
});

function message(partial: Partial<MealChatMessage> & { id: string; role: 'USER' | 'ASSISTANT' }): MealChatMessage {
  return { content: '', photo_ids: [], proposal: null, question: null, author_display_name: null, reply_to_message_id: null, created_at: '2026-10-15T08:00:00.000Z', ...partial };
}

function jobDeps(status: string, overrides: Partial<MealChatReplyDeps> = {}) {
  const inserted: unknown[] = [];
  const deps: MealChatReplyDeps = {
    findMealIdentityById: vi.fn(async () => 'meal:identity'),
    getMealRecord: vi.fn(async () => ({ status, started_at: '2026-10-15T06:15:00.000Z', source_carbs_g: 30 } as never)),
    recordAiProposal: vi.fn(async () => 'proposal-1'),
    listMessages: vi.fn(async () => [message({ id: 'u1', role: 'USER', content: 'Kanapka', photo_ids: ['p1'] })]),
    hasReply: vi.fn(async () => false),
    insertAssistantMessage: vi.fn(async (args) => { inserted.push(args); }),
    readPhoto: vi.fn(async () => Buffer.from([0xff, 0xd8, 0xff])),
    responder: { providerName: 'stub', respond: vi.fn(async () => parseReply({ output_text: JSON.stringify(finalReply) })) },
    ...overrides,
  };
  return { deps, inserted };
}

describe('runMealChatReplyJob', () => {
  it('makes the proposal the meal pending proposal and stores the reply once', async () => {
    const { deps, inserted } = jobDeps('DESCRIBED');
    await expect(runMealChatReplyJob(deps, { patient_id: 'p', meal_record_id: 'm', user_message_id: 'u1' })).resolves.toBe('REPLIED');

    expect(deps.recordAiProposal).toHaveBeenCalledWith('p', 'meal:identity', { carbs_g: 28, protein_g: 4.2, fat_g: 9.8, ai_execution_id: null });
    expect(inserted).toEqual([expect.objectContaining({ replyToMessageId: 'u1', question: 'Czy bułka była cała?', proposal: expect.objectContaining({ proposal_id: 'proposal-1' }) })]);
  });

  it('keeps a confirmed meal unchanged: the proposal waits in the chat for acceptance', async () => {
    const { deps, inserted } = jobDeps('CONFIRMED');
    await runMealChatReplyJob(deps, { patient_id: 'p', meal_record_id: 'm', user_message_id: 'u1' });

    expect(deps.recordAiProposal).not.toHaveBeenCalled();
    expect(inserted).toEqual([expect.objectContaining({ proposal: expect.objectContaining({ proposal_id: null }) })]);
  });

  it('keeps the reply when the meal was confirmed while the AI answered', async () => {
    const { ConflictError } = await import('@shared/errors/app-error');
    const { deps, inserted } = jobDeps('DESCRIBED', { recordAiProposal: vi.fn(async () => { throw new ConflictError('cannot move from CONFIRMED to AI_PROPOSED'); }) });
    await expect(runMealChatReplyJob(deps, { patient_id: 'p', meal_record_id: 'm', user_message_id: 'u1' })).resolves.toBe('REPLIED');
    expect(inserted).toEqual([expect.objectContaining({ proposal: expect.objectContaining({ proposal_id: null }) })]);
  });

  it('gives the model back its own question, so a short answer to it is understood', async () => {
    const { deps } = jobDeps('DESCRIBED', {
      listMessages: vi.fn(async () => [
        message({ id: 'u1', role: 'USER', content: 'Jabłecznik' }),
        message({ id: 'a1', role: 'ASSISTANT', content: 'To dosłodzenie.', question: 'Czy zjadł coś oprócz jabłecznika?' }),
        message({ id: 'u2', role: 'USER', content: 'Nie' }),
      ]),
    });
    await runMealChatReplyJob(deps, { patient_id: 'p', meal_record_id: 'm', user_message_id: 'u2' });

    const turns = vi.mocked(deps.responder.respond).mock.calls[0][0].turns;
    expect(turns.map((turn) => turn.content)).toEqual(['Jabłecznik', 'To dosłodzenie.\n[Pytanie do Ciebie: Czy zjadł coś oprócz jabłecznika?]', 'Nie']);
  });

  it('sees the reply to an earlier message even when it was stored after this one', async () => {
    const { deps } = jobDeps('DESCRIBED', {
      listMessages: vi.fn(async () => [
        message({ id: 'u1', role: 'USER', content: 'Pizza' }),
        message({ id: 'u2', role: 'USER', content: 'a do tego sok' }),
        message({ id: 'a1', role: 'ASSISTANT', content: 'Pizza to ok. 60 g.', reply_to_message_id: 'u1' }),
      ]),
    });
    await runMealChatReplyJob(deps, { patient_id: 'p', meal_record_id: 'm', user_message_id: 'u2' });
    const turns = vi.mocked(deps.responder.respond).mock.calls[0][0].turns;
    expect(turns.map((turn) => turn.content)).toEqual(['Pizza', 'Pizza to ok. 60 g.', 'a do tego sok']);
  });

  it('passes the meal as it is now to the responder', async () => {
    const { deps } = jobDeps('CONFIRMED', {
      getMealRecord: vi.fn(async () => ({
        status: 'CONFIRMED', started_at: '2026-10-15T06:15:00.000Z', source_carbs_g: 14, description: 'Chleb i jajecznica',
        macros: { carbs: { grams: 14, origin: 'USER' }, protein: { grams: 12, origin: 'USER' }, fat: { grams: 10, origin: 'USER' } },
        items: [{ name: 'Chleb pszenny', grams: 25, carbs_g: 13.5, protein_g: 2, fat_g: 0.5, source: 'DIABCALC' }],
      } as never)),
    });
    await runMealChatReplyJob(deps, { patient_id: 'p', meal_record_id: 'm', user_message_id: 'u1' });

    expect(deps.responder.respond).toHaveBeenCalledWith(expect.objectContaining({
      meal: expect.objectContaining({ current: { description: 'Chleb i jajecznica', status: 'CONFIRMED', carbs_g: 14, protein_g: 12, fat_g: 10, items: [{ name: 'Chleb pszenny', grams: 25, carbs_g: 13.5, protein_g: 2, fat_g: 0.5 }] } }),
    }), expect.anything());
  });

  it('answers with the preferences of the user who wrote the message', async () => {
    const userAiPreferences = vi.fn(async (userId: string) => ({ ai_role: userId === 'grandma' ? 'GRANDPARENT' as const : null, ai_instructions: null }));
    const { deps } = jobDeps('DESCRIBED', {
      userAiPreferences,
      listMessages: vi.fn(async () => [
        message({ id: 'u0', role: 'USER', content: 'Pizza', author_user_id: 'mum' }),
        message({ id: 'u1', role: 'USER', content: 'Dwa kawałki', author_user_id: 'grandma' }),
      ]),
    });
    await runMealChatReplyJob(deps, { patient_id: 'p', meal_record_id: 'm', user_message_id: 'u1' });
    expect(userAiPreferences).toHaveBeenCalledWith('grandma');
    expect(vi.mocked(deps.responder.respond).mock.calls[0][0].user_preferences).toEqual({ ai_role: 'GRANDPARENT', ai_instructions: null });
  });

  it('answers without preferences when they cannot be read', async () => {
    const { deps } = jobDeps('DESCRIBED', {
      userAiPreferences: vi.fn(async () => { throw new Error('column "ai_role" does not exist'); }),
      listMessages: vi.fn(async () => [message({ id: 'u1', role: 'USER', content: 'Kanapka', author_user_id: 'mum' })]),
    });
    await expect(runMealChatReplyJob(deps, { patient_id: 'p', meal_record_id: 'm', user_message_id: 'u1' })).resolves.toBe('REPLIED');
    expect(vi.mocked(deps.responder.respond).mock.calls[0][0].user_preferences).toBeNull();
  });

  it('does nothing when the message already has a reply (job retry)', async () => {
    const { deps } = jobDeps('DESCRIBED', { hasReply: vi.fn(async () => true) });
    await expect(runMealChatReplyJob(deps, { patient_id: 'p', meal_record_id: 'm', user_message_id: 'u1' })).resolves.toBe('ALREADY_REPLIED');
    expect(deps.responder.respond).not.toHaveBeenCalled();
  });
});

describe('meal chat replies and doses', () => {
  it('adds one sentence when a reply names insulin, and nothing to a reply about the meal', async () => {
    const { withoutDoseHere } = await import('./application/meal-chat-reply.job');
    expect(withoutDoseHere('Na to podałbym 2,5 j.')).toMatch(/zakładka Bolus/);
    expect(withoutDoseHere('To ok. 45 g węglowodanów i 12 g tłuszczu.')).toBe('To ok. 45 g węglowodanów i 12 g tłuszczu.');
    expect(withoutDoseHere('Jedna kajzerka to 30 g W.')).toBe('Jedna kajzerka to 30 g W.');
  });
});
