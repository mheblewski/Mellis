import { describe, expect, it } from 'vitest';
import {
  CONVERSATION_STYLE_INSTRUCTIONS,
  SUGGESTED_FOLLOW_UP_INSTRUCTIONS,
  collectAlreadySuggestedFollowUps,
  collectFollowUpExclusions,
  sanitizeConversationTitle,
  sanitizeSuggestedFollowUps,
  selectFollowUpSuggestions,
  optionChipMatchesAnswer,
} from './conversation-style';
import { routeUserMessage } from '@modules/context/application/message-routing';
import { buildDirectResponsePrompt } from './direct-response-prompt';
import { directResponseAiResultSchema } from './ai-contract.schema';
import { selectOpenAiStructuredSchema } from '@modules/ai-gateway/infrastructure/openai-provider';

describe('conversation style and suggested follow-ups', () => {
  it('keeps up to three distinct, short suggestions (dose questions included) and drops the rest without rewriting them', () => {
    expect(sanitizeSuggestedFollowUps([
      'Co mogło spowodować spadek o 10:28?',
      '  Co mogło   spowodować spadek o 10:28? ',
      'x'.repeat(121),
      42,
      '',
      'Ile jednostek podać na kolację?',
      'Czy zmniejszyć bazę w nocy?',
      'Porównaj z przedwczoraj',
    ])).toEqual(['Co mogło spowodować spadek o 10:28?', 'Ile jednostek podać na kolację?', 'Czy zmniejszyć bazę w nocy?']);
    expect(sanitizeSuggestedFollowUps(undefined)).toEqual([]);
    expect(sanitizeSuggestedFollowUps('Co dalej?')).toEqual([]);
  });

  it('asks the answer for assessed candidates in strict mode; older outputs still parse', () => {
    const schema = selectOpenAiStructuredSchema('CONVERSATION_TIME_RANGE_ANALYSIS').schema as any;
    expect(schema.required).toEqual(['assistant_message', 'follow_up_candidates', 'conversation_title', 'answer_options']);
    // assistant_message first: the candidates, the title and the options are written after the answer.
    expect(Object.keys(schema.properties)).toEqual(['assistant_message', 'follow_up_candidates', 'conversation_title', 'answer_options']);
    expect(schema.properties.answer_options.items.required).toEqual(['key', 'title', 'detail', 'note', 'recommended']);
    expect(schema.properties.conversation_title.type).toEqual(['string', 'null']);
    expect(schema.properties.follow_up_candidates.items.required).toEqual(['question', 'kind', 'repeats_answer', 'answerable', 'usefulness']);
    expect(schema.properties.follow_up_candidates.items.properties.kind.enum).toEqual(['NOW', 'WHY', 'NEXT_TIME', 'PATTERN']);
    expect(directResponseAiResultSchema.safeParse({ assistant_message: 'Hej!' }).success).toBe(true);
    expect(directResponseAiResultSchema.safeParse({ assistant_message: 'Hej!', follow_up_candidates: [{ question: 'A?' }, 7] }).success).toBe(true);
    expect(directResponseAiResultSchema.safeParse({ assistant_message: 'Hej!', suggested_follow_ups: ['A?'], hot_follow_up_index: 0 }).success).toBe(true);
    expect(directResponseAiResultSchema.safeParse({ assistant_message: 'Hej!', follow_up_candidates: [], conversation_title: 'Pizza w sobotę' }).success).toBe(true);
    expect(directResponseAiResultSchema.safeParse({ assistant_message: 'Hej!', follow_up_candidates: [], conversation_title: null }).success).toBe(true);
  });

  it('asks for a conversation title only while the conversation has none, in both conversation prompts', () => {
    const base = { thread_id: 't', thread_state_version: 'v', messages: [] };
    const payload = (conversation_context: Record<string, unknown>) => JSON.parse(buildDirectResponsePrompt({ task_type: 'CONVERSATION_DIRECT_RESPONSE' } as any, {
      direct_response_input: { user_message_id: 'm1', user_message_text: 'Co oznacza IOB?' },
      conversation_context,
      patient_ref: { patient_id: 'p' },
      provenance: { source_refs: [] },
    } as any).user_payload);
    expect(payload({ ...base, needs_title: true }).conversation_context.needs_title).toBe(true);
    expect(payload(base).conversation_context.needs_title).toBe(false);
    expect(CONVERSATION_STYLE_INSTRUCTIONS.join(' ')).toContain('conversation_title: when conversation_context.needs_title is true');
  });

  it('saves a clean one-line title and drops an empty or overlong one instead of cutting it', () => {
    expect(sanitizeConversationTitle('  „Pizza   w sobotę”. ')).toBe('Pizza w sobotę');
    expect(sanitizeConversationTitle('Nocne spadki po sporcie')).toBe('Nocne spadki po sporcie');
    expect(sanitizeConversationTitle('')).toBeNull();
    expect(sanitizeConversationTitle(null)).toBeNull();
    expect(sanitizeConversationTitle(42)).toBeNull();
    expect(sanitizeConversationTitle('x'.repeat(61))).toBeNull();
  });

  it('puts the friendly, focused style into the direct-response prompt next to its data rule', () => {
    const prompt = buildDirectResponsePrompt({ task_type: 'CONVERSATION_DIRECT_RESPONSE' } as any, {
      direct_response_input: { user_message_id: 'm1', user_message_text: 'Co oznacza IOB?' },
      conversation_context: { thread_id: 't', thread_state_version: 'v', messages: [] },
      patient_ref: { patient_id: 'p' },
      current_state_snapshot: null,
      patient_facts: [],
      provenance: { source_refs: [], selection_policy_version: 'v1' },
    } as any);
    for (const instruction of CONVERSATION_STYLE_INSTRUCTIONS) expect(prompt.system_instructions).toContain(instruction);
    // No patient data in a direct reply: no dose numbers here, the question goes to an analysis with data.
    expect(prompt.system_instructions).toContain('give no numbers here');
    expect(prompt.system_instructions).not.toContain('card tools');
    expect(JSON.parse(prompt.user_payload).evidence_contract.therapy_suggestions).toBe('NOT_IN_THIS_REPLY_NO_PATIENT_DATA_LOADED');
    const style = CONVERSATION_STYLE_INSTRUCTIONS.join(' ');
    expect(style).toContain('experienced diabetologist');
    expect(style).toContain('never explain basics');
    // Interpretation is allowed, certainty and dosing are not.
    expect(style).toContain('Interpretation, not certainty');
    expect(style).toContain('at least one alternative the data cannot rule out');
    expect(style).toContain('never present one cause as established');
    // Practical hints are woven into the text when useful, not a fixed labelled section in every answer.
    expect(style).toContain('never as a separate labelled section such as "Na przyszłość"');
    expect(style).toContain('only under the therapy suggestion rules');
  });

  it('lets a dose through the card tools when they are attached, the no-numbers rule covering the rest of the text', () => {
    const prompt = buildDirectResponsePrompt({ task_type: 'CONVERSATION_DIRECT_RESPONSE' } as any, {
      direct_response_input: { user_message_id: 'm1', user_message_text: 'Ile podać na tę kanapkę?' },
      conversation_context: { thread_id: 't', thread_state_version: 'v', messages: [] },
      patient_ref: { patient_id: 'p' },
      provenance: { source_refs: [] },
    } as any, { dose_card_tools: true });
    expect(prompt.system_instructions).toContain('A dose to give now goes only through them');
    // With the cards the current state is data: no "not loaded" line that contradicts the cards.
    expect(prompt.system_instructions).toContain('Never write that data are missing or not loaded while you prepare cards');
    expect(prompt.system_instructions).not.toContain('No patient history (glucose readings, insulin, meals, activity) is loaded');
    expect(prompt.system_instructions).not.toContain('suggest discussing urgent treatment decisions with a clinician');
    const payload = JSON.parse(prompt.user_payload);
    expect(payload.evidence_contract.therapy_suggestions).toBe('ONLY_ON_DOSE_CARDS_NOT_IN_TEXT');
    expect(payload.allowed_response_contract.therapy_suggestions).toBe('ONLY_ON_DOSE_CARDS_NOT_IN_TEXT');
  });

  it('drops suggestions that repeat an earlier question or suggestion, ignoring case, accents and punctuation', () => {
    const messages = [
      { id: 'u1', role: 'USER', content: 'Jak wyglądał dziś cukier?' },
      { id: 'a1', role: 'ASSISTANT', content: 'Spadek o 10:28.', suggested_follow_ups: ['Co spowodowało spadek o 10:28?', 'Czy w ostatnich 7 dniach też spada po obiedzie?'] },
      { id: 'u2', role: 'USER', content: 'Co spowodowało spadek o 10:28?' },
      { id: 'a2', role: 'ASSISTANT', content: 'SMB po bolusie.', metadata: { suggested_follow_ups: ['Jak zwykle reaguje na pizzę?'] } },
    ];
    expect(collectAlreadySuggestedFollowUps(messages)).toEqual([
      'Co spowodowało spadek o 10:28?',
      'Czy w ostatnich 7 dniach też spada po obiedzie?',
      'Jak zwykle reaguje na pizzę?',
    ]);
    expect(sanitizeSuggestedFollowUps([
      'jak wygladal dzis cukier',
      'Czy w ostatnich 7 dniach też spada po obiedzie',
      'Jak zwykle reaguje na PIZZĘ?!',
      'Czy spadek o 10:28 to skutek SMB po bolusie z 8:15?',
    ], { exclude: collectFollowUpExclusions(messages) })).toEqual(['Czy spadek o 10:28 to skutek SMB po bolusie z 8:15?']);
    expect(collectAlreadySuggestedFollowUps(undefined)).toEqual([]);
  });

  it('keeps only the 12 latest earlier suggestions, the latest repeat counting as latest', () => {
    const messages = Array.from({ length: 15 }, (_, index) => ({ role: 'ASSISTANT', content: '', suggested_follow_ups: [`Pytanie ${index}`] }));
    messages.push({ role: 'ASSISTANT', content: '', suggested_follow_ups: ['Pytanie 0'] });
    const collected = collectAlreadySuggestedFollowUps(messages);
    expect(collected).toHaveLength(12);
    expect(collected.at(-1)).toBe('Pytanie 0');
    expect(collected[0]).toBe('Pytanie 4');
  });

  it('asks for assessed candidates in plain words, without example questions to copy', () => {
    const rules = SUGGESTED_FOLLOW_UP_INSTRUCTIONS.join(' ');
    expect(CONVERSATION_STYLE_INSTRUCTIONS).toEqual(expect.arrayContaining([...SUGGESTED_FOLLOW_UP_INSTRUCTIONS]));
    // Live 2026-10-16: example questions in the rules came back word for word.
    expect(rules).not.toMatch(/"[^"]*\?"/);
    expect(rules).toContain('after assistant_message, write 5 candidate questions');
    expect(rules).toContain('asks what to do (carbs, a correction, a temporary target), not whether something may happen');
    expect(rules).toContain('repeats_answer: true when your answer already says what tapping the question would return');
    expect(rules).toContain('a late rise is timed from the meal, not from that entry');
    expect(rules).toContain('conversation_context.already_suggested_follow_ups');
  });

  it('only recommends period phrases the router understands', () => {
    const at = '2026-10-16T10:00:00.000Z';
    const parse = (content: string) => routeUserMessage({ content, messages: [], conversationId: 'style', requestedAtIso: at, timezone: 'Europe/Warsaw', hasPhotos: false });
    expect(parse('Czy w ostatnich 7 dniach też spada po obiedzie?')).toMatchObject({ route: 'ANALYSIS', basis: 'NAMED_PERIOD', window: { rangeType: 'MEDIUM_RANGE' } });
    expect(parse('Czy w ostatnich 14 dniach widać efekt brzasku?')).toMatchObject({ route: 'ANALYSIS', basis: 'NAMED_PERIOD', window: { rangeType: 'LONG_RANGE' } });
    expect(parse('Czy w ostatnich 3 dniach było podobnie?')).toMatchObject({ route: 'ANALYSIS', basis: 'NAMED_PERIOD', window: { rangeType: 'SHORT_RANGE' } });
    expect(parse('Czy wczoraj po kolacji było podobnie?')).toMatchObject({ route: 'ANALYSIS', basis: 'NAMED_PERIOD', window: { rangeType: 'SHORT_RANGE' } });
    expect(parse('Ile razy dziś spadł poniżej 70?')).toMatchObject({ route: 'ANALYSIS', basis: 'NAMED_PERIOD', window: { rangeType: 'TODAY' } });
  });

  it('shows the model the suggestions it already offered in both conversation prompts', () => {
    const conversation_context = { thread_id: 't', thread_state_version: 'v', messages: [], already_suggested_follow_ups: ['Jak zwykle reaguje na pizzę?'] };
    const direct = JSON.parse(buildDirectResponsePrompt({ task_type: 'CONVERSATION_DIRECT_RESPONSE' } as any, {
      direct_response_input: { user_message_id: 'm1', user_message_text: 'Co oznacza IOB?' },
      conversation_context,
      patient_ref: { patient_id: 'p' },
      provenance: { source_refs: [] },
    } as any).user_payload);
    expect(direct.conversation_context.already_suggested_follow_ups).toEqual(['Jak zwykle reaguje na pizzę?']);
  });

  it('selects answerable, new, useful candidates, best first and one of each kind first; highlights only a 4 or 5', () => {
    const candidate = (question: string, kind: string, usefulness: number, flags: { repeats?: boolean; answerable?: boolean } = {}) => ({
      question, kind, usefulness, repeats_answer: flags.repeats ?? false, answerable: flags.answerable ?? true,
    });
    expect(selectFollowUpSuggestions([
      candidate('Czy przy 158↗ pętla ma dość insuliny?', 'NOW', 5),
      candidate('Czy może jeszcze zejść za nisko?', 'NOW', 5, { repeats: true }),
      candidate('Co jadł w nocy w szkole?', 'WHY', 5, { answerable: false }),
      candidate('Ile węgli dać teraz, żeby nie spadł?', 'NOW', 5),
      candidate('Czy nocne skoki się powtarzają?', 'PATTERN', 4),
      candidate('Czy nocne skoki ponad 300 były w ostatnich 7 dniach?', 'PATTERN', 4),
      candidate('Dać mniej insuliny na następny obiad?', 'NEXT_TIME', 3),
      candidate('Co zrobić, gdy znów spadnie po WF-ie?', 'NOW', 4),
      candidate('Czy to normalne?', 'WHY', 2),
      'zepsuty kandydat',
      { question: 'Bez oceny?' },
    ], ['Czy nocne skoki się powtarzają?'])).toEqual({
      suggestions: ['Ile węgli dać teraz, żeby nie spadł?', 'Czy nocne skoki ponad 300 były w ostatnich 7 dniach?', 'Dać mniej insuliny na następny obiad?'],
      hot: 'Ile węgli dać teraz, żeby nie spadł?',
    });
    expect(selectFollowUpSuggestions([
      candidate('Pierwsze pytanie?', 'WHY', 3),
      candidate('Drugie pytanie?', 'WHY', 3),
      candidate('Trzecie pytanie?', 'PATTERN', 3),
    ], [])).toEqual({ suggestions: ['Pierwsze pytanie?', 'Trzecie pytanie?', 'Drugie pytanie?'], hot: null });
    expect(selectFollowUpSuggestions(undefined, [])).toEqual({ suggestions: [], hot: null });
  });

});

describe('option taps', () => {
  const candidate = (question: string) => ({ question, kind: 'NOW', usefulness: 5, answerable: true, repeats_answer: false });

  it('keeps "Wybieram opcję B" only under an answer that offers option B', () => {
    const offered = 'Opcja A (polecam): 30 g bez insuliny teraz. **Opcja B:** mniejszy bolus od razu.';
    const ownPlan = 'Przygotowałam kartę na 28 g węgli i 1,8 j teraz, a za 10 min przypomnienie.';
    const raw = [candidate('Wybieram opcję B: mniejszy bolus od razu'), candidate('Czy po pizzach bywa późny wzrost')];
    expect(selectFollowUpSuggestions(raw, [], offered).suggestions).toContain('Wybieram opcję B: mniejszy bolus od razu');
    expect(selectFollowUpSuggestions(raw, [], ownPlan).suggestions).toEqual(['Czy po pizzach bywa późny wzrost']);
    expect(optionChipMatchesAnswer('Wybieram opcję C: sok', offered)).toBe(false);
    expect(optionChipMatchesAnswer('Co zrobić, jeśli spada?', ownPlan)).toBe(true);
  });
});

describe('one rescue carbs rule in every conversation prompt', () => {
  it('states the 20 g first-portion limit in the shared style (direct and time-range prompts)', async () => {
    const { CONVERSATION_STYLE_INSTRUCTIONS } = await import('./conversation-style');
    expect(CONVERSATION_STYLE_INSTRUCTIONS.join('\n')).toMatch(/at most 20 g at once/);
  });
});
