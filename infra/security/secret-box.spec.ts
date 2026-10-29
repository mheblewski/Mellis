import { describe, expect, it } from 'vitest';
import { SecretBox } from './secret-box';

const KEY_HEX = 'ab'.repeat(32);

describe('SecretBox', () => {
  it('round-trips a token with a fresh IV each time and never stores it in clear', () => {
    const box = SecretBox.fromEnv({ NIGHTSCOUT_TOKEN_ENCRYPTION_KEY: KEY_HEX })!;
    const first = box.encrypt('reader-abc123');
    const second = box.encrypt('reader-abc123');
    expect(first).toMatch(/^v1:/);
    expect(first).not.toContain('reader-abc123');
    expect(first).not.toBe(second);
    expect(box.decrypt(first)).toBe('reader-abc123');
  });

  it('accepts a base64 key and is null when the variable is unset', () => {
    const key = Buffer.alloc(32, 3);
    expect(SecretBox.fromEnv({ NIGHTSCOUT_TOKEN_ENCRYPTION_KEY: key.toString('base64') })!.decrypt(SecretBox.fromKey(key).encrypt('x'))).toBe('x');
    expect(SecretBox.fromEnv({})).toBeNull();
  });

  it('refuses a short key without echoing it, and a wrong key or tampered value with a generic error', () => {
    expect(() => SecretBox.fromEnv({ NIGHTSCOUT_TOKEN_ENCRYPTION_KEY: 'too-short-secret' })).toThrow(/must be 32 bytes/);
    try {
      SecretBox.fromEnv({ NIGHTSCOUT_TOKEN_ENCRYPTION_KEY: 'too-short-secret' });
    } catch (error) {
      expect((error as Error).message).not.toContain('too-short-secret');
    }
    const stored = SecretBox.fromKey(Buffer.alloc(32, 1)).encrypt('reader-abc123');
    expect(() => SecretBox.fromKey(Buffer.alloc(32, 2)).decrypt(stored)).toThrow('SECRET_DECRYPT_FAILED');
    const parts = stored.split(':');
    parts[3] = Buffer.from('tampered').toString('base64');
    expect(() => SecretBox.fromKey(Buffer.alloc(32, 1)).decrypt(parts.join(':'))).toThrow('SECRET_DECRYPT_FAILED');
    expect(() => SecretBox.fromKey(Buffer.alloc(32, 1)).decrypt('plain-token')).toThrow('SECRET_FORMAT_UNSUPPORTED');
  });
});
