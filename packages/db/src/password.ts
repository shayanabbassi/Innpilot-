import { hash, verify } from '@node-rs/argon2';

/**
 * Argon2id with the OWASP-recommended baseline (19 MiB memory, 2 iterations, 1 lane).
 * Parameters are encoded in each hash, so raising them later still verifies older hashes.
 */
const ARGON2ID = 2;
const OPTIONS = { algorithm: ARGON2ID, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export function hashPassword(plain: string): Promise<string> {
  return hash(plain, OPTIONS);
}

export async function verifyPassword(passwordHash: string, plain: string): Promise<boolean> {
  try {
    return await verify(passwordHash, plain);
  } catch {
    return false;
  }
}

let dummyHash: Promise<string> | undefined;
/**
 * Spends the same time as a real verification. Used when the email is unknown so response
 * timing does not reveal which accounts exist.
 */
export async function verifyAgainstDummy(plain: string): Promise<false> {
  dummyHash ??= hashPassword('innpilot-timing-equaliser');
  await verifyPassword(await dummyHash, plain);
  return false;
}
