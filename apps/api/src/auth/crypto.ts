import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** 256-bit random token, base64url. */
export function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

export function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

export function safeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

const VERSION = 'v1';

/** AES-256-GCM. Output: v1.<iv>.<tag>.<ciphertext>, each base64url. */
export function encryptSecret(plain: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [VERSION, iv, cipher.getAuthTag(), ciphertext]
    .map((p) => (typeof p === 'string' ? p : p.toString('base64url')))
    .join('.');
}

export function decryptSecret(sealed: string, key: Buffer): string {
  const [version, iv, tag, ciphertext] = sealed.split('.');
  if (version !== VERSION || !iv || !tag || ciphertext === undefined)
    throw new Error('Unrecognised secret format');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString(
    'utf8',
  );
}
