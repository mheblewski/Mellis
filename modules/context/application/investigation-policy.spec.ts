import { describe, expect, it } from 'vitest';
import {
  createInvestigationCandidateFromQuestionId,
  determineUserMessageCapability,
  evaluateCandidateDecision,
  evaluateInvestigationDecision,
  getAllowedCandidatesForEvent,
  getCandidateRegistry,
  isGeneralKnowledgeQuestion,
} from './investigation-policy';
import {
  resolveConversationContext,
  shouldSkipUserClarificationQuestion,
} from './conversation-context-resolver';

describe('smart event investigation v1 policy', () => {
  it('asks hypos no question cards: their report is the hypo screen form', () => {
    expect(getCandidateRegistry('HYPO')).toEqual([]);
  });

  it('keeps USER investigation candidate registry isolated from HYPO candidates', () => {
    expect(getCandidateRegistry('USER')).toHaveLength(1);
    expect(getCandidateRegistry('USER')[0].candidate_id).toBe('time_window_context');
    expect(getCandidateRegistry('USER')[0].expected_answer_types).toEqual(['UNKNOWN', 'TEXT']);
  });

  it('routes conversational, investigation, and time-range analysis user intents deterministically', () => {
    expect(determineUserMessageCapability('Cześć')).toBe('DIRECT_RESPONSE');
    expect(determineUserMessageCapability('Jaki mam teraz cukier?')).toBe('INVESTIGATION_REQUIRED');
    expect(determineUserMessageCapability('Dlaczego teraz rośnie?')).toBe('INVESTIGATION_REQUIRED');
    expect(determineUserMessageCapability('Przeanalizuj mi dzisiejszy dzień')).toBe('ANALYSIS_REQUEST');
    expect(determineUserMessageCapability('Ile insuliny na ten posiłek?')).toBe('ANALYSIS_REQUEST');
    expect(determineUserMessageCapability('Jak zareagował wcześniej na podobny posiłek?')).toBe('ANALYSIS_REQUEST');
    expect(determineUserMessageCapability('Co to znaczy?')).toBe('DIRECT_RESPONSE');
    expect(determineUserMessageCapability('Czy zapiszesz ten posiłek do bazy czy będzie wykorzystywany tylko w tej rozmowie?')).toBe('DIRECT_RESPONSE');
  });

  it('recognizes a causal follow-up with Polish diacritics and inherits TODAY scope from the prior analytical thread', () => {
    const resolution = resolveConversationContext({
      conversation_id: 'conv-1',
      current_user_message: 'A co mogło je powodować?',
      previous_messages: [
        {
          role: 'USER',
          message_type: 'USER_MESSAGE',
          content: 'Co było dzisiaj największym problemem?',
        },
        {
          role: 'ASSISTANT',
          message_type: 'ASSISTANT_MESSAGE',
          content: 'Największym problemem była dzisiejsza hipoglikemia.',
        },
      ],
    });

    expect(resolution.resolved_intent).toBe('CAUSAL_ANALYSIS');
    expect(resolution.resolved_time_range).toBe('TODAY');
  });

  it('does not guess TODAY analysis when there is no supporting analytical context', () => {
    const resolution = resolveConversationContext({
      conversation_id: 'conv-2',
      current_user_message: 'A co mogło je powodować?',
      previous_messages: [
        {
          role: 'USER',
          message_type: 'USER_MESSAGE',
          content: 'Cześć!',
        },
      ],
    });

    expect(resolution.resolved_time_range).toBe('UNKNOWN');
    expect(resolution.resolved_intent).toBe('CAUSAL_ANALYSIS');
    expect(resolution.resolved_event_refs).toEqual([]);
  });

  it('keeps unrelated event references out of a causal follow-up unless the prior thread established them', () => {
    const resolution = resolveConversationContext({
      conversation_id: 'conv-3',
      current_user_message: 'A co mogło je powodować?',
      previous_messages: [
        {
          role: 'USER',
          message_type: 'USER_MESSAGE',
          content: 'Co to znaczy?',
        },
      ],
      known_episode_candidates: [
        { episode_id: 'episode-irrelevant', started_at: '2026-10-07T06:39:00Z', ended_at: '2026-10-07T07:09:00Z' },
      ],
    });

    expect(resolution.resolved_event_refs).toEqual([]);
    expect(resolution.resolved_time_range).toBe('UNKNOWN');
  });

  it('reuses prior conversation scope and avoids a generic time-window clarification when the thread already established TODAY and specific hypo episodes', () => {
    const resolution = resolveConversationContext({
      conversation_id: 'conv-1',
      current_user_message: 'Przeanalizuj dokładnie co mogło je powodować',
      previous_messages: [
        {
          role: 'USER',
          message_type: 'USER_MESSAGE',
          content: 'Co według Ciebie było dzisiaj największym problemem?',
        },
        {
          role: 'ASSISTANT',
          message_type: 'ASSISTANT_MESSAGE',
          content: 'Największym problemem były dziś powtarzające się hipoglikemie rano: 3 epizody (ok. 6:39–7:09, 8:34–9:09 i 10:49–11:19), z najniższym odczytem 51 mg/dL.',
        },
      ],
      // Stored in UTC, written by the assistant on the Warsaw clock (CEST, UTC+2).
      known_episode_candidates: [
        { episode_id: 'hypo-a', started_at: '2026-10-07T04:39:00Z', ended_at: '2026-10-07T05:09:00Z' },
        { episode_id: 'hypo-b', started_at: '2026-10-07T06:34:00Z', ended_at: '2026-10-07T07:09:00Z' },
        { episode_id: 'hypo-c', started_at: '2026-10-07T08:49:00Z', ended_at: '2026-10-07T09:19:00Z' },
      ],
      timezone: 'Europe/Warsaw',
    });

    expect(resolution.status).toBe('RESOLVED');
    expect(resolution.resolved_time_range).toBe('TODAY');
    expect(resolution.resolved_event_refs).toEqual(['hypo-a', 'hypo-b', 'hypo-c']);
    expect(shouldSkipUserClarificationQuestion(resolution)).toBe(true);
  });

  it('finishes a hypo investigation without asking', () => {
    const decision = evaluateInvestigationDecision({
      eventFamily: 'HYPO',
      eventFacts: [],
      activeQuestionId: null,
    });

    expect(decision.decision).toBe('FINISH');
    expect(getAllowedCandidatesForEvent({ eventFamily: 'HYPO', eventFacts: [], activeQuestionId: null })).toEqual([]);
  });

  it('still resolves the old hypo cards by question id, so an answer from an old app build is stored', () => {
    const candidate = createInvestigationCandidateFromQuestionId('activity_before_drop');
    expect(candidate?.fact_key).toBe('activity_before_drop');
    expect(candidate?.fact_name).toBe('Activity before drop');
    expect(candidate?.fact_type).toBe('CAREGIVER_CONTEXT');

    const secondCandidate = createInvestigationCandidateFromQuestionId('additional_carbohydrates');
    expect(secondCandidate?.fact_key).toBe('additional_carbohydrates');
    expect(secondCandidate?.fact_type).toBe('CAREGIVER_CONTEXT');
  });

  it('represents ASK_LATER for eligible but deferred candidates without side effects', () => {
    const deferred = evaluateCandidateDecision({
      candidate: {
        candidate_id: 'deferred_candidate',
        version: 'hypo-question-candidate.v1',
        event_family: 'HYPO',
        fact_key: 'deferred_candidate',
        fact_name: 'Deferred candidate',
        fact_type: 'CAREGIVER_CONTEXT',
        question_type: 'CONTEXT_QUESTION',
        question_text: 'Deferred question?',
        reason: 'Synthetic deferred candidate for policy validation.',
        expected_answer_types: ['YES', 'NO', 'UNKNOWN', 'TEXT'],
        expected_information_gain: 'LOW',
        priority: 'LOW',
        selection_rank: 999,
        enabled: true,
      },
      factStatus: 'MISSING',
    });

    expect(deferred.decision).toBe('ASK_LATER');
    expect(deferred.candidate?.candidate_id).toBe('deferred_candidate');
  });
});

describe('isGeneralKnowledgeQuestion', () => {
  it('keeps pure definitions, how-to and privacy questions general', () => {
    for (const message of ['Co oznacza IOB?', 'Jak działa SMB?', 'Jak działa SMB w Trio?', 'Co to jest bolus przedłużony?', 'Czym jest hipoglikemia?', 'Co oznacza strzałka w dół?', 'Czy to zostanie tylko w tej rozmowie?', 'Czy zapiszesz ten posiłek?']) {
      expect(isGeneralKnowledgeQuestion(message), message).toBe(true);
    }
  });

  it('reads a definition wording about the patient\'s own event, reading or setting as a question about the patient', () => {
    for (const message of [
      'Co oznacza ten spadek o 14:30?',
      'Jak działa jego bazal, że tak rośnie?',
      'Co oznacza wynik 250 po obiedzie?',
      'Jak w tej rozmowie pisałem, po kolacji spadł do 50 — dlaczego?',
      'Co oznacza ta strzałka w dół o 8:15?',
    ]) {
      expect(isGeneralKnowledgeQuestion(message), message).toBe(false);
    }
  });
});
