import { describe, expect, it, vi } from 'vitest';
import { ApiService } from './api.service';

const PATIENT = '11111111-1111-4111-8111-111111111111';
const CONVERSATION = '22222222-2222-4222-8222-222222222222';
const CARD = '44444444-4444-4444-8444-444444444444';
const CAREGIVER = { user_id: '33333333-3333-4333-8333-333333333333' } as any;
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

/** A rescue alert's conversation whose alert was pushed `alertMinutesAgo` ago, with one card proposed `cardMinutesAgo` ago. */
function setup(options: { alertMinutesAgo: number; cardMinutesAgo?: number; triggerType?: string }) {
  const repo = {
    async getAccessRow(userId: string, patientId: string) {
      return userId === CAREGIVER.user_id && patientId === PATIENT ? { can_read_patient: true, can_write_patient: true } : null;
    },
    insertAuditEvent: vi.fn(),
    getConversation: vi.fn(async () => ({ id: CONVERSATION, patient_id: PATIENT, trigger_type: options.triggerType ?? 'RESCUE_CARBS', messages: [] })),
  };
  const rescue = {
    getAlertByConversation: vi.fn(async () => ({ id: 'alert-1', notified_at: ago(options.alertMinutesAgo), reminder_sent_at: null, first_flag_at: ago(options.alertMinutesAgo + 2) })),
    listProposalsForConversation: vi.fn(async () => (options.cardMinutesAgo === undefined ? [] : [{ id: CARD, created_at: ago(options.cardMinutesAgo) }])),
    // NOT_FOUND ends the call at the store: reaching it is what every case checks (no age guard before it).
    logTreatment: vi.fn(async () => ({ status: 'NOT_FOUND' })),
    declineAlert: vi.fn(async () => ({ status: 'NOT_FOUND' })),
    acceptChatProposal: vi.fn(async () => ({ status: 'PROPOSAL_NOT_FOUND' })),
  };
  const api = new ApiService(repo as any, {} as any);
  (api as any).rescueCarbs = rescue;
  return { api, rescue };
}

describe('ApiService logs rescue carbs from stale alerts (stale-alerts.v1: only the loop send is refused)', () => {
  it('"Podano dosłodzenie" and "Nie podaję" on an alert pushed 2 h ago reach the store', async () => {
    const { api, rescue } = setup({ alertMinutesAgo: 120 });
    await expect(api.logRescueCarbs(CAREGIVER, PATIENT, CONVERSATION, { carbs_g: 4 })).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    await expect(api.declineRescueCarbs(CAREGIVER, PATIENT, CONVERSATION)).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    expect(rescue.logTreatment).toHaveBeenCalledOnce();
    expect(rescue.declineAlert).toHaveBeenCalledOnce();
  });

  it('a current alert reaches the store too', async () => {
    const { api, rescue } = setup({ alertMinutesAgo: 10 });
    await expect(api.logRescueCarbs(CAREGIVER, PATIENT, CONVERSATION, { carbs_g: 4 })).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    await expect(api.declineRescueCarbs(CAREGIVER, PATIENT, CONVERSATION)).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    expect(rescue.logTreatment).toHaveBeenCalledOnce();
    expect(rescue.declineAlert).toHaveBeenCalledOnce();
  });

  it('an old card in an alert\'s chat is still logged', async () => {
    const old = setup({ alertMinutesAgo: 10, cardMinutesAgo: 40 });
    await expect(old.api.logRescueCarbs(CAREGIVER, PATIENT, CONVERSATION, { carbs_g: 6, proposal_id: CARD })).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    expect(old.rescue.logTreatment).toHaveBeenCalledOnce();
  });

  it('"Podano X g" on an ordinary conversation\'s card proposed over 30 min ago only logs: accepted', async () => {
    const old = setup({ alertMinutesAgo: 0, cardMinutesAgo: 90, triggerType: 'USER' });
    await expect(old.api.acceptChatRescueCarbs(CAREGIVER, PATIENT, CONVERSATION, CARD, { carbs_g: 6 })).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    expect(old.rescue.acceptChatProposal).toHaveBeenCalledOnce();
  });
});
