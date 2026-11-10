import { afterEach, describe, expect, it } from 'vitest';
import { ForbiddenError, ValidationError } from '@shared/errors/app-error';
import { predict } from '@modules/glucose-forecast/application/prediction-engine';
import { ApiService } from './api.service';

const PATIENT = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-11-06T12:00:00.000Z');

class Repo {
  optedIn = false;
  isOwner = true;
  careAccess = true;
  writes: Array<{ enabled: boolean; userId: string | null }> = [];
  async getAccessRow(userId: string, patientId: string): Promise<any> {
    return { user_id: userId, patient_id: patientId, can_read_patient: true, can_write_patient: true };
  }
  async insertAuditEvent(): Promise<void> {}
  async getMemberScopes(): Promise<any> {
    return { is_owner: this.isOwner, glucose_alerts: true, ai_chat_meals: this.careAccess };
  }
  async getPredictionExperimentOptIn(): Promise<boolean> {
    return this.optedIn;
  }
  async setPredictionExperimentOptIn(_patientId: string, enabled: boolean, userId: string | null): Promise<void> {
    this.writes.push({ enabled, userId });
    this.optedIn = enabled;
  }
}

const principal = { user_id: 'u1', auth_subject: 'u1' } as any;

function serviceWith(repo: Repo): { service: ApiService; reads: () => number } {
  const service = new ApiService(repo as any, {} as any);
  let reads = 0;
  (service as any).predictionService = {
    forApp: async (_patientId: string, now: Date) => {
      reads += 1;
      const set = predict({ now, readings: [{ at: '2026-11-06T11:58:00.000Z', value: 120 }], prediction: null });
      return { ...set, plan: [{ kind: 'PLANNED_MEAL', at: '2026-11-06T12:30:00.000Z', title: 'Obiad', state: 'PLANNED' }], late_rise: [{ meal_id: 'm1', from: '2026-11-06T13:00:00.000Z', to: '2026-11-06T15:00:00.000Z', insulin_planned: false, insulin_given: false }] } as any;
    },
  };
  return { service, reads: () => reads };
}

describe('the forecast line and the prediction experiment', () => {
  afterEach(() => {
    delete process.env.PREDICTION_EXPERIMENT_ENABLED;
    delete process.env.PREDICTION_LINE_ENABLED;
  });

  it('serves the line to every reader by default, without the experiment', async () => {
    const repo = new Repo();
    const { service } = serviceWith(repo);
    const answer = await service.getPrediction(principal, PATIENT, NOW);
    expect(answer.prediction).toMatchObject({ engine_version: 'prediction-engine.v2', line: null, risk: null });
    expect(answer.prediction.plan).toHaveLength(1);
    expect(answer.prediction.late_rise).toHaveLength(1);
    expect(answer.prediction.loop.glucose).toEqual({ at: '2026-11-06T11:58:00.000Z', value: 120 });
    expect(repo.writes).toEqual([]);
  });

  it('a member with only "Glukoza i alarmy" gets the line without the plan markers', async () => {
    const repo = new Repo();
    repo.isOwner = false;
    repo.careAccess = false;
    const answer = await serviceWith(repo).service.getPrediction(principal, PATIENT, NOW);
    expect(answer.prediction.loop.glucose).toEqual({ at: '2026-11-06T11:58:00.000Z', value: 120 });
    expect(answer.prediction.plan).toEqual([]);
    expect(answer.prediction.late_rise).toEqual([]);
    repo.careAccess = true;
    expect((await serviceWith(repo).service.getPrediction(principal, PATIENT, NOW)).prediction.plan).toHaveLength(1);
  });

  it('the line has its own server switch, apart from the experiment', async () => {
    const { service, reads } = serviceWith(new Repo());
    process.env.PREDICTION_LINE_ENABLED = 'false';
    await expect(service.getPrediction(principal, PATIENT, NOW)).rejects.toBeInstanceOf(ForbiddenError);
    expect(reads()).toBe(0);
    delete process.env.PREDICTION_LINE_ENABLED;
    process.env.PREDICTION_EXPERIMENT_ENABLED = 'false';
    await expect(service.getPrediction(principal, PATIENT, NOW)).resolves.toMatchObject({ patient_id: PATIENT });
  });

  it('an owner still turns the experiment on and off; the server kill switch stops it', async () => {
    const repo = new Repo();
    const { service } = serviceWith(repo);
    await service.setPredictionExperiment(principal, PATIENT, { enabled: true });
    await service.setPredictionExperiment(principal, PATIENT, { enabled: false });
    expect(repo.writes).toEqual([{ enabled: true, userId: 'u1' }, { enabled: false, userId: 'u1' }]);
    process.env.PREDICTION_EXPERIMENT_ENABLED = 'false';
    await expect(service.setPredictionExperiment(principal, PATIENT, { enabled: true })).rejects.toBeInstanceOf(ForbiddenError);
    expect(repo.writes).toHaveLength(2);
  });

  it('only an owner changes it, and any member reads it once on', async () => {
    const repo = new Repo();
    repo.isOwner = false;
    const { service } = serviceWith(repo);
    await expect(service.setPredictionExperiment(principal, PATIENT, { enabled: true })).rejects.toBeInstanceOf(ForbiddenError);
    expect(repo.writes).toEqual([]);
  });

  it('refuses anything but true or false', async () => {
    const { service } = serviceWith(new Repo());
    await expect(service.setPredictionExperiment(principal, PATIENT, { enabled: 'yes' })).rejects.toBeInstanceOf(ValidationError);
    await expect(service.setPredictionExperiment(principal, PATIENT, null)).rejects.toBeInstanceOf(ValidationError);
  });
});
