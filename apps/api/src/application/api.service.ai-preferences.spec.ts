import { describe, expect, it } from 'vitest';
import { ApiService } from './api.service';
import { NotFoundError, ValidationError } from '@shared/errors/app-error';
import type { UserAiPreferences } from '@shared/primitives/user-ai-preferences';

class AiPreferencesRepo {
  stored = new Map<string, UserAiPreferences>([['u1', { ai_role: 'PARENT', ai_instructions: 'Krótko.' }]]);
  async getUserAiPreferences(userId: string): Promise<UserAiPreferences> {
    return this.stored.get(userId) ?? { ai_role: null, ai_instructions: null };
  }
  async setUserAiPreferences(userId: string, preferences: UserAiPreferences): Promise<boolean> {
    if (userId === 'missing') return false;
    this.stored.set(userId, preferences);
    return true;
  }
}

const principal = (userId: string) => ({ user_id: userId, auth_subject: userId }) as any;

describe('ApiService user AI preferences', () => {
  it('reads the preferences of the user who asks', async () => {
    const service = new ApiService(new AiPreferencesRepo() as any, {} as any);
    expect(await service.getUserAiPreferences(principal('u1'))).toEqual({ ai_role: 'PARENT', ai_instructions: 'Krótko.' });
    expect(await service.getUserAiPreferences(principal('u2'))).toEqual({ ai_role: null, ai_instructions: null });
  });

  it('saves a role and trimmed text; blank text, null or a missing field clears it', async () => {
    const repo = new AiPreferencesRepo();
    const service = new ApiService(repo as any, {} as any);
    expect(await service.setUserAiPreferences(principal('u1'), { ai_role: 'PATIENT_SELF', ai_instructions: '  Mów do mnie jak lekarz.  ' }))
      .toEqual({ ai_role: 'PATIENT_SELF', ai_instructions: 'Mów do mnie jak lekarz.' });
    expect(repo.stored.get('u1')).toEqual({ ai_role: 'PATIENT_SELF', ai_instructions: 'Mów do mnie jak lekarz.' });
    expect(await service.setUserAiPreferences(principal('u1'), { ai_role: null, ai_instructions: '   ' })).toEqual({ ai_role: null, ai_instructions: null });
    expect(await service.setUserAiPreferences(principal('u1'), {})).toEqual({ ai_role: null, ai_instructions: null });
  });

  it('counts characters, not UTF-16 units: 500 emoji fit, 501 characters do not', async () => {
    const service = new ApiService(new AiPreferencesRepo() as any, {} as any);
    const emoji = '🙂'.repeat(500);
    expect((await service.setUserAiPreferences(principal('u1'), { ai_instructions: emoji })).ai_instructions).toBe(emoji);
    await expect(service.setUserAiPreferences(principal('u1'), { ai_instructions: 'a'.repeat(501) })).rejects.toBeInstanceOf(ValidationError);
  });

  it('refuses an unknown role or a non-text instruction', async () => {
    const service = new ApiService(new AiPreferencesRepo() as any, {} as any);
    for (const body of [{ ai_role: 'BOSS' }, { ai_role: 'parent' }, { ai_role: 3 }, { ai_instructions: 42 }, { ai_instructions: ['a'] }]) {
      await expect(service.setUserAiPreferences(principal('u1'), body)).rejects.toBeInstanceOf(ValidationError);
    }
  });

  it('refuses a user that does not exist', async () => {
    const service = new ApiService(new AiPreferencesRepo() as any, {} as any);
    await expect(service.setUserAiPreferences(principal('missing'), { ai_role: 'CLINICIAN' })).rejects.toBeInstanceOf(NotFoundError);
  });
});
