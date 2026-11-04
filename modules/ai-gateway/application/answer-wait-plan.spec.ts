import { describe, expect, it } from 'vitest';
import { buildAnswerWaitPlan, WAIT_LINES } from './answer-wait-plan';

const now = new Date('2026-11-04T17:30:00.000Z');
const snapshot = (fields: Record<string, unknown> = {}) => ({ current_glucose: 132, trend: 'Flat', age_minutes: 2, iob: 1.35, ...fields });

describe('buildAnswerWaitPlan', () => {
  it('names the data of a dose question', () => {
    expect(buildAnswerWaitPlan({ current_state_snapshot: snapshot() }, { doseRequested: true, now })).toEqual({
      started_at: now.toISOString(), stale_reading: false, catalog: [WAIT_LINES.insulin, WAIT_LINES.readings, WAIT_LINES.plan],
    });
  });

  it('leaves out what the data do not hold', () => {
    const plan = buildAnswerWaitPlan({ current_state_snapshot: snapshot({ iob: 0.05, age_minutes: 12 }) }, { doseRequested: true, now });
    expect(plan).toMatchObject({ stale_reading: true, catalog: [WAIT_LINES.plan] });
    expect(buildAnswerWaitPlan({ current_state_snapshot: snapshot(), therapy_now: { loop: { iob_u: 1, stale: true } } }, { doseRequested: true, now })?.catalog).toEqual([WAIT_LINES.readings, WAIT_LINES.plan]);
  });

  it('says what it analyses for other questions, and stays silent in a hypo chat', () => {
    const question = (text: string, extra: Record<string, unknown> = {}) => ({ current_state_snapshot: snapshot(), analysis_request_input: { user_message_text: text, range_type: 'TODAY', ...extra } });
    expect(buildAnswerWaitPlan(question('Dlaczego po obiedzie cukier wzrósł?'), { doseRequested: false, now })?.catalog).toEqual([WAIT_LINES.today, WAIT_LINES.causes]);
    expect(buildAnswerWaitPlan(question('Jak minął dzień?'), { doseRequested: false, now })?.catalog).toEqual([WAIT_LINES.today]);
    expect(buildAnswerWaitPlan(question('Jak minął tydzień?', { range_type: 'LAST_7_DAYS' }), { doseRequested: false, now })?.catalog).toEqual([WAIT_LINES.period]);
    expect(buildAnswerWaitPlan(question('Dlaczego?', { focus_hypo_episode_id: 'h' }), { doseRequested: false, now })?.catalog).toEqual([]);
  });

  it('starts when the caregiver asked, on every attempt', () => {
    const asked = '2026-11-04T17:29:40.000Z';
    expect(buildAnswerWaitPlan({ current_state_snapshot: snapshot(), analysis_request_input: { requested_at: asked } }, { doseRequested: false, now }).started_at).toBe(asked);
    const messages = [{ role: 'USER', created_at: '2026-11-04T10:00:00.000Z' }, { role: 'ASSISTANT', created_at: '2026-11-04T10:00:10.000Z' }, { role: 'USER', created_at: asked }];
    expect(buildAnswerWaitPlan({ current_state_snapshot: null, conversation_context: { messages } }, { doseRequested: false, now }).started_at).toBe(asked);
  });

  it('has no sentences for a question without patient data', () => {
    const empty = { started_at: now.toISOString(), stale_reading: false, catalog: [] };
    expect(buildAnswerWaitPlan({ current_state_snapshot: null }, { doseRequested: true, now })).toEqual(empty);
    expect(buildAnswerWaitPlan(null, { doseRequested: true, now })).toEqual(empty);
  });

  it('never says a number, a dose direction or an order', () => {
    for (const line of Object.values(WAIT_LINES)) {
      expect(line).not.toMatch(/\d|mniej|połow|rozłoż|poczekaj|spokojnie|bezpiecznie|uwzględnia|wylicza/i);
      expect(line.length).toBeLessThanOrEqual(55);
    }
  });
});
