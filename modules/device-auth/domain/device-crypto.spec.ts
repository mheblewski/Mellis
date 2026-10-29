import { describe, expect, it } from 'vitest';
import { FakeDeviceKey } from '../testing/fake-device-keys';
import {
  bolusKeyMessage,
  DeviceAuthInputError,
  hashOneTimeCode,
  newOneTimeCode,
  normalizeOneTimeCode,
  pairingMessage,
  parseHandoffCiphertext,
  parseP256PublicKey,
  remoteSettingsHandoffMessage,
  parseSignedEnvelope,
  readSignedPayload,
  sameAmount,
  sameName,
  secretsEqual,
  sessionMessage,
  verifyDeviceSignature,
} from './device-crypto';

describe('device crypto (AUTH_MODE=device)', () => {
  it('reads the X9.63 P-256 point the Secure Enclave exports and refuses anything else', () => {
    const key = new FakeDeviceKey();
    expect(() => parseP256PublicKey(key.publicKey)).not.toThrow();
    for (const bad of ['', 'not base64', Buffer.alloc(65, 1).toString('base64'), Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 0xff)]).toString('base64'), key.publicKey.slice(0, -4), 42]) {
      expect(() => parseP256PublicKey(bad)).toThrow(DeviceAuthInputError);
    }
  });

  it('verifies DER signatures only for the right key and message', () => {
    const key = new FakeDeviceKey();
    const other = new FakeDeviceKey();
    const message = sessionMessage('device-1', 'challenge-1', 'nonce-1');
    const signature = key.sign(message);
    expect(verifyDeviceSignature(key.publicKey, message, signature)).toBe(true);
    expect(verifyDeviceSignature(other.publicKey, message, signature)).toBe(false);
    expect(verifyDeviceSignature(key.publicKey, sessionMessage('device-1', 'challenge-1', 'nonce-2'), signature)).toBe(false);
    expect(verifyDeviceSignature(key.publicKey, message, 'AAAA')).toBe(false);
    expect(verifyDeviceSignature(key.publicKey, message, undefined)).toBe(false);
  });

  it('makes one-time codes of 100 bits that survive typing (case, dashes, look-alikes)', () => {
    const code = newOneTimeCode();
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}(-[0-9A-HJKMNP-TV-Z]{5}){3}$/);
    expect(newOneTimeCode()).not.toBe(code);
    expect(hashOneTimeCode(code.toLowerCase().replace(/-/g, ' '))).toBe(hashOneTimeCode(code));
    expect(normalizeOneTimeCode('ab0-o1-il')).toBe('AB00111');
    expect(hashOneTimeCode('short')).toBeNull();
    expect(hashOneTimeCode(undefined)).toBeNull();
    expect(secretsEqual('a', 'a')).toBe(true);
    expect(secretsEqual('a', 'b')).toBe(false);
  });

  it('binds the pairing signature to the code and the device key (v2), or both keys for an older app (v1)', () => {
    expect(pairingMessage('abcde-fghjk', 'K1')).toBe('mellis-pair-v2\nABCDEFGHJK\nK1');
    expect(pairingMessage('abcde-fghjk', 'K1', null)).toBe('mellis-pair-v2\nABCDEFGHJK\nK1');
    expect(pairingMessage('abcde-fghjk', 'K1', 'K2')).toBe('mellis-pair-v1\nABCDEFGHJK\nK1\nK2');
  });

  it('binds the bolus key registration to the device, the challenge and the new key', () => {
    // The same string is pinned in the app's DeviceAuthTests (DeviceAuthMessage.bolusKey).
    expect(bolusKeyMessage('device-1', 'challenge-1', 'nonce-1', 'B1')).toBe('mellis-bolus-key-v1\ndevice-1\nchallenge-1\nnonce-1\nB1');
  });

  it('reads a signed remote command payload exactly as signed and refuses malformed ones', () => {
    const key = new FakeDeviceKey();
    const payload = { v: 1, type: 'remote_command', challenge_id: 'c', nonce: 'n', device_id: 'd', patient_id: 'p', patient_name: 'Janek', insulin_u: 2.5, carbs_g: 30, confirmation: 'Podać 2,5 j dla Janka?' };
    const envelope = parseSignedEnvelope(key.signPayload(payload));
    const read = readSignedPayload(envelope, 'remote_command');
    expect(read.payload).toEqual(payload);
    expect(verifyDeviceSignature(key.publicKey, read.bytes, envelope.signature)).toBe(true);
    expect(() => readSignedPayload(envelope, 'remote_bolus_confirm')).toThrow(DeviceAuthInputError);
    expect(() => readSignedPayload(parseSignedEnvelope(key.signPayload({ ...payload, confirmation: '' })), 'remote_command')).toThrow(DeviceAuthInputError);
    expect(() => readSignedPayload(parseSignedEnvelope(key.signPayload({ ...payload, insulin_u: '2.5' })), 'remote_command')).toThrow(DeviceAuthInputError);
    expect(() => parseSignedEnvelope({ payload: 1 })).toThrow(DeviceAuthInputError);
  });

  it('compares doses and names the way the phone shows them', () => {
    expect(sameAmount(2.5, 2.5000001)).toBe(true);
    expect(sameAmount(2.5, 2.55)).toBe(false);
    expect(sameName(' Janek ', 'Janek')).toBe(true);
    expect(sameName('Ewa', 'Janek')).toBe(false);
  });

  it('pins the remote settings hand-off message byte for byte (the iOS app signs the same bytes)', () => {
    const message = remoteSettingsHandoffMessage({
      patientId: '11111111-1111-4111-8111-111111111111',
      fromDeviceId: '22222222-2222-4222-8222-222222222222',
      toDeviceId: '33333333-3333-4333-8333-333333333333',
      loopKind: 'trio',
      recipientKey: 'bolus',
      ciphertext: 'BAEC',
    });
    expect(message).toBe('mellis-remote-settings-v1\n11111111-1111-4111-8111-111111111111\n22222222-2222-4222-8222-222222222222\n33333333-3333-4333-8333-333333333333\ntrio\nbolus\nBAEC');
  });

  it('accepts only canonical base64 of an ECIES-shaped message within the size limits', () => {
    const ok = Buffer.concat([Buffer.from([0x04]), Buffer.alloc(81, 7)]);
    expect(parseHandoffCiphertext(ok.toString('base64')).equals(ok)).toBe(true);
    expect(() => parseHandoffCiphertext(Buffer.alloc(82, 4).subarray(0, 81).toString('base64'))).toThrow(DeviceAuthInputError);
    expect(() => parseHandoffCiphertext(Buffer.concat([Buffer.from([0x05]), Buffer.alloc(81)]).toString('base64'))).toThrow(DeviceAuthInputError);
    expect(() => parseHandoffCiphertext(ok.toString('base64url'))).toThrow(DeviceAuthInputError);
    expect(() => parseHandoffCiphertext(Buffer.concat([Buffer.from([0x04]), Buffer.alloc(16 * 1024)]).toString('base64'))).toThrow(DeviceAuthInputError);
    expect(() => parseHandoffCiphertext(42)).toThrow(DeviceAuthInputError);
  });
});
