import { describe, expect, it } from 'vitest';
import { isBetaAccessAllowed, normalizeEmail, parsePermissions } from './sharing';

describe('sharing rules', () => {
  it('normalizes e-mails and refuses malformed ones', () => {
    expect(normalizeEmail('  Ewa.Kowalska@Example.COM ')).toBe('ewa.kowalska@example.com');
    expect(() => normalizeEmail('no-at-sign')).toThrow('INVALID_EMAIL');
    expect(() => normalizeEmail('a b@example.com')).toThrow('INVALID_EMAIL');
  });

  it('turns a permission on only with a literal true', () => {
    expect(parsePermissions({ glucose_alerts: true, ai_chat_meals: 'true', remote_commands: 1 })).toEqual({
      glucose_alerts: true, ai_chat_meals: false, manage_sharing: false, remote_commands: false,
    });
    expect(parsePermissions(null)).toEqual({ glucose_alerts: false, ai_chat_meals: false, manage_sharing: false, remote_commands: false });
  });

  it('lets anyone in with the allowlist off, otherwise only allowlisted, invited or linked e-mails', () => {
    const nobody = { allowlisted: false, invited: false, member: false };
    expect(isBetaAccessAllowed(false, nobody)).toBe(true);
    expect(isBetaAccessAllowed(true, nobody)).toBe(false);
    expect(isBetaAccessAllowed(true, { ...nobody, invited: true })).toBe(true);
    expect(isBetaAccessAllowed(true, { ...nobody, allowlisted: true })).toBe(true);
    expect(isBetaAccessAllowed(true, { ...nobody, member: true })).toBe(true);
  });
});
