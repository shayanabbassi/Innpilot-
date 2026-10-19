import { createHmac, randomBytes } from 'node:crypto';

/** RFC 6238 TOTP with the defaults every authenticator app supports: SHA-1, 6 digits, 30-second steps. */
const STEP_SECONDS = 30;
const DIGITS = 6;
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.replace(/=+$/, '').replace(/\s/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = BASE32.indexOf(ch);
    if (idx < 0) throw new Error('Invalid base32 character');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A new 160-bit secret, base32-encoded. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function hotp(secret: Buffer, counter: number, digits = DIGITS, algorithm = 'sha1'): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac(algorithm, secret).update(msg).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const code = (mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits;
  return code.toString().padStart(digits, '0');
}

export function timeStep(unixMs: number): number {
  return Math.floor(unixMs / 1000 / STEP_SECONDS);
}

/**
 * Checks a code against the current step and one step either side (clock drift).
 * Returns the matched step so the caller can reject reuse of that step or any earlier one.
 */
export function verifyTotp(
  secretBase32: string,
  code: string,
  options: { now?: number; lastUsedStep?: number | null } = {},
): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const secret = base32Decode(secretBase32);
  const current = timeStep(options.now ?? Date.now());
  for (const step of [current - 1, current, current + 1]) {
    if (options.lastUsedStep !== null && options.lastUsedStep !== undefined && step <= options.lastUsedStep)
      continue;
    if (hotp(secret, step) === code) return step;
  }
  return null;
}

export function otpauthUri(secretBase32: string, accountEmail: string, issuer = 'InnPilot'): string {
  const label = encodeURIComponent(`${issuer}:${accountEmail}`);
  const params = new URLSearchParams({
    secret: secretBase32,
    issuer,
    algorithm: 'SHA1',
    digits: '6',
    period: '30',
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
