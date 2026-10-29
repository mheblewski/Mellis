import { describe, expect, it } from 'vitest';
import { isCausalQuestion, resolveConversationContext, type ConversationMessageReference } from './conversation-context-resolver';

describe('isCausalQuestion', () => {
  it('recognises questions about a cause, with or without Polish diacritics', () => {
    for (const question of [
      'Co spowodowało tę hipoglikemię?',
      'Jaka była przyczyna spadku?',
      'A co mogło je powodować?',
      'Dlaczego dzisiaj przed południem cukier spadł poniżej 70?',
      'dlaczego dzisiaj cukier spadl ponizej 70',
      'Czemu w nocy był taki skok?',
      'A czemu?',
      'Skąd ten spadek po obiedzie?',
      'Skąd się wziął ten wzrost?',
      'Z jakiego powodu był ten dołek?',
      'Co sprawiło, że tak szybko spadł?',
      'Why did glucose drop at 10:30?',
      'How come it went low after lunch?',
    ]) {
      expect(isCausalQuestion(question), question).toBe(true);
    }
  });

  it('keeps how-to, source and plain data questions non-causal', () => {
    for (const question of [
      'Dlaczego nie mogę zmienić bazy w aplikacji?',
      'Czemu służy tymczasowy cel?',
      'Dzięki czemu pętla tak dobrze trzymała noc?',
      'Skąd wiesz, że to było SMB?',
      'Skąd masz te dane o insulinie?',
      'Pokaż insulinę i wpisy węgli wokół 16:18',
      'Kiedy były spadki cukru?',
      'Ile było bolusów wczoraj?',
      'Jaki jest teraz cukier?',
      'Show me yesterday\'s night',
      'Somewhere around noon it dropped',
    ]) {
      expect(isCausalQuestion(question), question).toBe(false);
    }
  });

  it('resolves a "dlaczego" follow-up as a causal analysis of the analysed day', () => {
    const resolution = resolveConversationContext({
      conversation_id: 'conv-why',
      current_user_message: 'Dlaczego tak spadł?',
      previous_messages: [
        { role: 'USER', message_type: 'USER_MESSAGE', content: 'Jak wyglądał dzisiaj cukier?' },
        { role: 'ASSISTANT', message_type: 'ASSISTANT_MESSAGE', content: 'Dzisiaj był jeden spadek do 55 mg/dl.' },
      ],
    });
    expect(resolution.resolved_intent).toBe('CAUSAL_ANALYSIS');
    expect(resolution.resolved_time_range).toBe('TODAY');
    // A how-to "dlaczego" stays an investigation, not a causal analysis.
    expect(resolveConversationContext({ conversation_id: 'conv-howto', current_user_message: 'Dlaczego nie mogę zmienić celu?' }).resolved_intent)
      .toBe('INVESTIGATION_REQUIRED');
  });
});

describe('resolveConversationContext: the day and the hypo episode an earlier message is about', () => {
  // 2026-10-19 06:05-06:40 UTC is 08:05-08:40 in Warsaw (CEST).
  const episode = { episode_id: 'ep-morning', started_at: '2026-10-19T06:05:00.000Z', ended_at: '2026-10-19T06:40:00.000Z' };
  const resolve = (previous: Array<[ConversationMessageReference['role'], string]>, current = 'Dlaczego tak spadł?') => resolveConversationContext({
    conversation_id: 'conv',
    current_user_message: current,
    previous_messages: previous.map(([role, content], index) => ({ id: `m${index}`, role, content })),
    known_episode_candidates: [episode],
    timezone: 'Europe/Warsaw',
  });

  it('matches an episode by the local clock times the caregiver wrote', () => {
    expect(resolve([['USER', 'Hipo od 8:05 do 8:40, co się stało?']]).resolved_event_refs).toEqual(['ep-morning']);
    expect(resolve([['USER', 'Spadek między 08.05 a 08.40']]).resolved_event_refs).toEqual(['ep-morning']);
    // The UTC clock is not what the caregiver sees.
    expect(resolve([['USER', 'Hipo od 6:05 do 6:40']]).resolved_event_refs).toEqual([]);
  });

  it('does not match a clock time inside a longer one', () => {
    expect(resolve([['USER', 'Spadek od 18:05 do 18:40']]).resolved_event_refs).toEqual([]);
  });

  it('reads "dziś" as today and prefers the latest mention in the caregiver messages', () => {
    expect(resolve([['USER', 'Jak było dziś rano?']]).resolved_time_range).toBe('TODAY');
    expect(resolve([['USER', 'Jak było wczoraj?'], ['ASSISTANT', 'Wczoraj ...'], ['USER', 'A dziś po obiedzie?']]).resolved_time_range).toBe('TODAY');
    expect(resolve([['USER', 'Wczoraj było źle, a jak dziś?']]).resolved_time_range).toBe('TODAY');
    expect(resolve([['USER', 'Dziś lepiej niż wczoraj?']]).resolved_time_range).toBe('YESTERDAY');
    // The caregiver's own words win over the assistant's.
    expect(resolve([['USER', 'Co było wczoraj wieczorem?'], ['ASSISTANT', 'Dzisiaj rano też był spadek.']]).resolved_time_range).toBe('YESTERDAY');
    // "przedwczoraj" is not yesterday.
    expect(resolve([['USER', 'Co było przedwczoraj?']]).resolved_time_range).toBe('UNKNOWN');
  });

  it('keeps the current message\'s own day word first', () => {
    expect(resolve([['USER', 'Jak było dziś?']], 'A wczoraj?').resolved_time_range).toBe('YESTERDAY');
    expect(resolve([['USER', 'Jak było wczoraj?']], 'A dzisiaj?').resolved_time_range).toBe('TODAY');
  });
});
