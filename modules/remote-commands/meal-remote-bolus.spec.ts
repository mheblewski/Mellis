import { describe, expect, it } from 'vitest';
import { mealRemoteBolusView } from './application/meal-remote-bolus';
import type { RemoteCommandRecord } from './application/remote-command-record';

const base = (overrides: Partial<RemoteCommandRecord>): RemoteCommandRecord => ({
  id: 'c1', patient_id: 'p1', user_id: 'u1', device_id: 'd1', source: 'CHAT_CARD', conversation_id: 'conv', proposal_id: 'card', follows_command_id: null,
  carbs_g: 20, insulin_u: 2.4, bolus_step: 0.05, icr_g_per_u: 8, icr_insulin_u: 2.5, meal_payload: null, context: {} as never, warnings: [],
  policy_version: 'remote-commands.v1', status: 'SUCCEEDED', trio_message: null, status_message: null,
  authorized_at: '2026-10-19T14:00:00.000Z', send_deadline: '2026-10-19T14:02:00.000Z', sent_at: null, answered_at: null,
  loop_action_id: null, meal_record_id: 'meal', matched_at: null, ...overrides,
});
const now = new Date('2026-10-19T14:05:00.000Z');

describe('meal page about its remote bolus', () => {
  it('says nothing when the bolus went the first time', () => {
    expect(mealRemoteBolusView([base({})], now)).toBeNull();
    expect(mealRemoteBolusView([], now)).toBeNull();
  });

  it('says the bolus was not given and offers it alone for 30 minutes', () => {
    const refused = base({ status: 'PARTIAL', trio_message: 'Command rejected: bolus amount (2.4 units) exceeds the maximum allowed (2 units). Details: User: GlucoMind.' });
    expect(mealRemoteBolusView([refused], now)).toMatchObject({
      state: 'BOLUS_NOT_GIVEN',
      message: 'Bolus nie został podany: bolus 2.4 j przekracza maksymalny bolus w Trio (2 j). Węglowodany są w Trio, insuliny nie podano.',
      insulin_u: 2.4,
      retry: { follows_command_id: 'c1', proposal_id: 'card', conversation_id: 'conv', until: '2026-10-19T14:30:00.000Z' },
    });
    expect(mealRemoteBolusView([refused], new Date('2026-10-19T14:31:00.000Z'))?.retry).toBeNull();
  });

  it('follows the retry', () => {
    const refused = base({ status: 'PARTIAL' });
    const retry = base({ id: 'c2', follows_command_id: 'c1', carbs_g: 0, insulin_u: 2, status: 'SENT', status_message: 'Polecenie wysłane, czekam na odpowiedź Trio.', authorized_at: '2026-10-19T14:04:00.000Z' });
    expect(mealRemoteBolusView([refused, retry], now)?.state).toBe('RETRY_IN_PROGRESS');
    expect(mealRemoteBolusView([refused, { ...retry, status: 'SUCCEEDED' }], now)).toMatchObject({ state: 'BOLUS_GIVEN_ON_RETRY', message: 'Bolus podany przy ponowieniu: 2 j.' });
    expect(mealRemoteBolusView([refused, { ...retry, status: 'REJECTED' }], now)).toMatchObject({ state: 'BOLUS_NOT_GIVEN', retry: { follows_command_id: 'c2' } });
  });
});
