import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret } from './crypto';
import {
  base32Decode,
  base32Encode,
  generateTotpSecret,
  hotp,
  otpauthUri,
  timeStep,
  verifyTotp,
} from './totp';

// RFC 6238 Appendix B test secret (ASCII "12345678901234567890") and SHA-1 vectors, truncated to 6 digits.
const RFC_SECRET = Buffer.from('12345678901234567890', 'ascii');
const RFC_VECTORS: [number, string][] = [
  [59, '287082'],
  [1111111109, '081804'],
  [1111111111, '050471'],
  [1234567890, '005924'],
  [2000000000, '279037'],
];

describe('TOTP', () => {
  it.each(RFC_VECTORS)('matches RFC 6238 at t=%i', (seconds, code) => {
    expect(hotp(RFC_SECRET, timeStep(seconds * 1000))).toBe(code);
  });

  it('round-trips base32', () => {
    const buf = Buffer.from('any bytes \x00\xff here');
    expect(base32Decode(base32Encode(buf))).toEqual(buf);
    expect(base32Encode(RFC_SECRET)).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  });

  it('accepts one step of clock drift and returns the matched step', () => {
    const secret = base32Encode(RFC_SECRET);
    const now = 1111111111_000;
    const prev = hotp(RFC_SECRET, timeStep(now) - 1);
    expect(verifyTotp(secret, prev, { now })).toBe(timeStep(now) - 1);
    const tooOld = hotp(RFC_SECRET, timeStep(now) - 2);
    expect(verifyTotp(secret, tooOld, { now })).toBeNull();
  });

  it('rejects a code at or before the last used step (replay)', () => {
    const secret = base32Encode(RFC_SECRET);
    const now = 1111111111_000;
    const code = hotp(RFC_SECRET, timeStep(now));
    expect(verifyTotp(secret, code, { now, lastUsedStep: timeStep(now) })).toBeNull();
    expect(verifyTotp(secret, code, { now, lastUsedStep: timeStep(now) - 1 })).toBe(timeStep(now));
  });

  it('rejects malformed codes', () => {
    expect(verifyTotp(generateTotpSecret(), '12345')).toBeNull();
    expect(verifyTotp(generateTotpSecret(), 'abcdef')).toBeNull();
  });

  it('builds an authenticator URI', () => {
    const uri = otpauthUri('ABC', 'owner@example.test');
    expect(uri).toBe(
      'otpauth://totp/InnPilot%3Aowner%40example.test?secret=ABC&issuer=InnPilot&algorithm=SHA1&digits=6&period=30',
    );
  });
});

describe('secret encryption', () => {
  const key = Buffer.alloc(32, 7);

  it('round-trips and uses a fresh IV each time', () => {
    const a = encryptSecret('JBSWY3DPEHPK3PXP', key);
    const b = encryptSecret('JBSWY3DPEHPK3PXP', key);
    expect(a).not.toBe(b);
    expect(decryptSecret(a, key)).toBe('JBSWY3DPEHPK3PXP');
  });

  it('detects tampering and wrong keys', () => {
    const sealed = encryptSecret('secret', key);
    const parts = sealed.split('.');
    parts[3] = Buffer.from('tampered').toString('base64url');
    expect(() => decryptSecret(parts.join('.'), key)).toThrow();
    expect(() => decryptSecret(sealed, Buffer.alloc(32, 8))).toThrow();
  });
});
