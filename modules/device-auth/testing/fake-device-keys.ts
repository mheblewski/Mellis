import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';

/**
 * Tests only: what the phone's Secure Enclave does — a P-256 key pair whose public half is exported as the X9.63 point
 * (SecKeyCopyExternalRepresentation) and whose signatures are DER ECDSA over SHA-256
 * (SecKeyCreateSignature, .ecdsaSignatureMessageX962SHA256).
 */
export class FakeDeviceKey {
  private readonly privateKey: KeyObject;
  readonly publicKey: string;

  constructor() {
    const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    this.privateKey = pair.privateKey;
    const jwk = pair.publicKey.export({ format: 'jwk' });
    this.publicKey = Buffer.concat([Buffer.from([0x04]), Buffer.from(jwk.x as string, 'base64url'), Buffer.from(jwk.y as string, 'base64url')]).toString('base64');
  }

  sign(message: string | Buffer): string {
    return sign('sha256', typeof message === 'string' ? Buffer.from(message, 'utf8') : message, { key: this.privateKey, dsaEncoding: 'der' }).toString('base64');
  }

  /** A signed envelope: the exact JSON bytes (base64url) and their signature. */
  signPayload(payload: Record<string, unknown>): { payload: string; signature: string } {
    const bytes = Buffer.from(JSON.stringify(payload), 'utf8');
    return { payload: bytes.toString('base64url'), signature: this.sign(bytes) };
  }
}
