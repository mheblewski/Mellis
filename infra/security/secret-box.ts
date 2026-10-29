import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Encrypts small secrets stored in the database (a patient's Nightscout token, sources.api_token_ciphertext) with
 * AES-256-GCM. The key comes from env (NIGHTSCOUT_TOKEN_ENCRYPTION_KEY: 32 bytes, base64 or hex) and never reaches the
 * database. Stored form: "v1:<iv>:<tag>:<ciphertext>", each part base64. Errors never contain the secret or the key.
 */
export class SecretBox {
  private constructor(private readonly key: Buffer) {}

  /** null when the variable is unset; a malformed key is refused (the process must not start with it). */
  static fromEnv(env: Record<string, string | undefined>, name = 'NIGHTSCOUT_TOKEN_ENCRYPTION_KEY'): SecretBox | null {
    const raw = env[name]?.trim();
    if (!raw) return null;
    return new SecretBox(parseKey(raw, name));
  }

  static fromKey(key: Buffer): SecretBox {
    if (key.length !== 32) throw new Error('SecretBox key must be 32 bytes');
    return new SecretBox(Buffer.from(key));
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), ciphertext.toString('base64')].join(':');
  }

  decrypt(stored: string): string {
    const parts = stored.split(':');
    if (parts.length !== 4 || parts[0] !== 'v1') throw new Error('SECRET_FORMAT_UNSUPPORTED');
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(parts[1], 'base64'));
      decipher.setAuthTag(Buffer.from(parts[2], 'base64'));
      return Buffer.concat([decipher.update(Buffer.from(parts[3], 'base64')), decipher.final()]).toString('utf8');
    } catch {
      // Wrong key or tampered value; the underlying error says nothing useful and must not be logged with context.
      throw new Error('SECRET_DECRYPT_FAILED');
    }
  }
}

function parseKey(raw: string, name: string): Buffer {
  const key = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw new Error(`Invalid environment variable: ${name} must be 32 bytes (64 hex characters or base64)`);
  }
  return key;
}
