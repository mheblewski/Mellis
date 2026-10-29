import { createHash, createPublicKey, randomBytes, timingSafeEqual, verify, type KeyObject } from 'node:crypto';

/**
 * Device auth (AUTH_MODE=device, docs/device-auth-api.md): the phone holds Secure Enclave P-256 keys (the device
 * key from pairing, the Face ID bound bolus key once remote bolus is confirmed) and sends only their public halves. Everything here is pure: key parsing, signature checks, one-time codes and the exact
 * bytes each signature covers.
 *
 * Keys: base64 of the X9.63 uncompressed point (0x04 || X || Y, 65 bytes), what SecKeyCopyExternalRepresentation gives
 * on iOS. Signatures: base64 of the DER ECDSA signature over SHA-256 of the message, what SecKeyCreateSignature with
 * .ecdsaSignatureMessageX962SHA256 gives.
 */

export class DeviceAuthInputError extends Error {
  constructor(readonly code: 'PUBLIC_KEY_INVALID' | 'SIGNATURE_INVALID' | 'PAYLOAD_INVALID') {
    super(code);
  }
}

/** The public key as a KeyObject; refuses anything but a valid P-256 point. */
export function parseP256PublicKey(raw: unknown): KeyObject {
  if (typeof raw !== 'string' || raw.length > 200) throw new DeviceAuthInputError('PUBLIC_KEY_INVALID');
  const bytes = Buffer.from(raw, 'base64');
  if (bytes.length !== 65 || bytes[0] !== 0x04 || bytes.toString('base64') !== raw.replace(/\s/g, '')) throw new DeviceAuthInputError('PUBLIC_KEY_INVALID');
  try {
    return createPublicKey({
      key: { kty: 'EC', crv: 'P-256', x: bytes.subarray(1, 33).toString('base64url'), y: bytes.subarray(33).toString('base64url') },
      format: 'jwk',
    });
  } catch {
    // Node refuses a point that is not on the curve.
    throw new DeviceAuthInputError('PUBLIC_KEY_INVALID');
  }
}

/** True only for a valid DER ECDSA P-256/SHA-256 signature of `message` by `publicKey`. */
export function verifyDeviceSignature(publicKey: KeyObject | string, message: Buffer | string, signature: unknown): boolean {
  if (typeof signature !== 'string' || signature.length === 0 || signature.length > 200) return false;
  const key = typeof publicKey === 'string' ? parseP256PublicKey(publicKey) : publicKey;
  try {
    return verify('sha256', typeof message === 'string' ? Buffer.from(message, 'utf8') : message, { key, dsaEncoding: 'der' }, Buffer.from(signature, 'base64'));
  } catch {
    return false;
  }
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Constant-time comparison of two secrets of any length (their hashes are compared). */
export function secretsEqual(a: string, b: string): boolean {
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
}

// Crockford base32: no I, L, O, U, so a code read aloud or typed from a screen survives.
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** A random code of `groups` × 5 characters (5 bits each), e.g. "7KQ2M-9XH4T-…"; 4 groups = 100 bits. */
export function newOneTimeCode(groups = 4): string {
  const chars: string[] = [];
  const bytes = randomBytes(groups * 5);
  for (const byte of bytes) chars.push(CODE_ALPHABET[byte & 31]);
  return Array.from({ length: groups }, (_, index) => chars.slice(index * 5, index * 5 + 5).join('')).join('-');
}

/**
 * The form codes are hashed and signed in: upper case, separators and spaces dropped, the look-alikes O→0 and I/L→1.
 * Empty when nothing usable is left.
 */
export function normalizeOneTimeCode(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1').replace(/[^0-9A-Z]/g, '').slice(0, 64);
}

export function hashOneTimeCode(raw: unknown): string | null {
  const code = normalizeOneTimeCode(raw);
  return code.length >= 16 ? sha256Hex(`mellis-code:${code}`) : null;
}

export function newSessionToken(): string {
  return `mls_${randomBytes(32).toString('base64url')}`;
}

export function newNonce(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * What a pairing phone signs: proof that it holds the private half of what it registers. Today's app pairs with the
 * device key alone (v2); the bolus key comes later (bolusKeyMessage). A phone that still sends both keys signs v1 with
 * each of them.
 */
export function pairingMessage(code: string, publicKey: string, bolusPublicKey?: string | null): string {
  if (bolusPublicKey) return ['mellis-pair-v1', normalizeOneTimeCode(code), publicKey, bolusPublicKey].join('\n');
  return ['mellis-pair-v2', normalizeOneTimeCode(code), publicKey].join('\n');
}

/**
 * What both keys sign when a paired phone registers its Face ID bound bolus key (POST /v1/me/devices/bolus-key): the
 * device key proves the phone, the new bolus key proves possession of its private half.
 */
export function bolusKeyMessage(deviceId: string, challengeId: string, nonce: string, bolusPublicKey: string): string {
  return ['mellis-bolus-key-v1', deviceId, challengeId, nonce, bolusPublicKey].join('\n');
}

/** What the device key signs for a session token. */
export function sessionMessage(deviceId: string, challengeId: string, nonce: string): string {
  return ['mellis-session-v1', deviceId, challengeId, nonce].join('\n');
}

/**
 * A remote command as the person confirmed it, signed by the Face ID bound bolus key. The phone sends the exact JSON
 * bytes (base64url) it signed; the server reads them, never re-serialises them.
 */
export interface SignedRemoteCommandPayload {
  v: 1;
  type: 'remote_command';
  challenge_id: string;
  nonce: string;
  device_id: string;
  patient_id: string;
  /** The patient's name as the server stores it (GET …/remote-commands/challenge returns it). */
  patient_name: string;
  insulin_u: number;
  carbs_g: number;
  /** The question the person answered with Face ID, naming the patient, e.g. "Podać 2,5 j dla Janka?". */
  confirmation: string;
}

/** The grantee's own "Tak, chcę podawać bolus zdalnie" for one patient, signed with the bolus key. */
export interface SignedRemoteBolusConfirmPayload {
  v: 1;
  type: 'remote_bolus_confirm';
  challenge_id: string;
  nonce: string;
  device_id: string;
  patient_id: string;
  patient_name: string;
  confirmation: string;
}

export interface SignedEnvelope {
  /** base64url of the exact UTF-8 JSON bytes that were signed. */
  payload: string;
  /** base64 DER ECDSA signature by the device's bolus key. */
  signature: string;
}

export function parseSignedEnvelope(raw: unknown): SignedEnvelope {
  const value = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
  if (!value || typeof value.payload !== 'string' || typeof value.signature !== 'string' || value.payload.length > 4096) {
    throw new DeviceAuthInputError('PAYLOAD_INVALID');
  }
  return { payload: value.payload, signature: value.signature };
}

/** The envelope's payload as JSON of the given type; anything malformed is PAYLOAD_INVALID. */
export function readSignedPayload<T extends SignedRemoteCommandPayload | SignedRemoteBolusConfirmPayload>(envelope: SignedEnvelope, type: T['type']): { bytes: Buffer; payload: T } {
  const bytes = Buffer.from(envelope.payload, 'base64url');
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new DeviceAuthInputError('PAYLOAD_INVALID');
  }
  const strings = ['challenge_id', 'nonce', 'device_id', 'patient_id', 'patient_name', 'confirmation'];
  const valid = parsed && typeof parsed === 'object' && parsed.v === 1 && parsed.type === type
    && strings.every((key) => typeof parsed[key] === 'string' && (parsed[key] as string).trim().length > 0 && (parsed[key] as string).length <= 300)
    && (type !== 'remote_command' || (isFiniteNumber(parsed.insulin_u) && isFiniteNumber(parsed.carbs_g)));
  if (!valid) throw new DeviceAuthInputError('PAYLOAD_INVALID');
  return { bytes, payload: parsed as unknown as T };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Doses compared as the phone rounds them (0.001 U / 0.1 g). */
export function sameAmount(a: number, b: number): boolean {
  return Math.abs(a - b) < 1e-3;
}

/** Names compared as stored: NFC, trimmed. */
export function sameName(a: string, b: string): boolean {
  return a.normalize('NFC').trim() === b.normalize('NFC').trim();
}

// Remote settings hand-off (step 2) ------------------------------------------------------------------------------------

export type HandoffLoopKind = 'trio' | 'loop';
export type HandoffRecipientKey = 'bolus' | 'device';

/** ECIES output of SecKeyCreateEncryptedData(.eciesEncryptionCofactorVariableIVX963SHA256AESGCM): 65-byte ephemeral key ‖ ciphertext ‖ 16-byte tag. */
export const HANDOFF_CIPHERTEXT_MIN_BYTES = 65 + 16 + 1;
export const HANDOFF_CIPHERTEXT_MAX_BYTES = 16 * 1024;

/**
 * What the owner's device key signs for one recipient device's package (POST /v1/patients/:id/remote-settings-handoffs):
 * the header fields and the exact ciphertext (canonical base64). The server checks it on upload; the recipient's phone
 * checks it again with the sender device's public key before decrypting.
 */
export function remoteSettingsHandoffMessage(input: { patientId: string; fromDeviceId: string; toDeviceId: string; loopKind: HandoffLoopKind; recipientKey: HandoffRecipientKey; ciphertext: string }): string {
  return ['mellis-remote-settings-v1', input.patientId, input.fromDeviceId, input.toDeviceId, input.loopKind, input.recipientKey, input.ciphertext].join('\n');
}

/** The ciphertext's bytes; canonical base64 of an ECIES message within the size limits, else PAYLOAD_INVALID. */
export function parseHandoffCiphertext(raw: unknown): Buffer {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > Math.ceil(HANDOFF_CIPHERTEXT_MAX_BYTES / 3) * 4) throw new DeviceAuthInputError('PAYLOAD_INVALID');
  const bytes = Buffer.from(raw, 'base64');
  if (bytes.toString('base64') !== raw || bytes.length < HANDOFF_CIPHERTEXT_MIN_BYTES || bytes.length > HANDOFF_CIPHERTEXT_MAX_BYTES || bytes[0] !== 0x04) {
    throw new DeviceAuthInputError('PAYLOAD_INVALID');
  }
  return bytes;
}
