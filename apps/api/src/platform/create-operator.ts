/* eslint-disable no-console -- a command-line tool reports on the terminal; credentials go to the file only. */
/**
 * Creates a platform operator (slice 5.7). There is no self-service sign-up for operators: whoever runs the
 * platform creates them here.
 *
 *   pnpm --filter @innpilot/api platform:operator <email> "<full name>" <output file>
 *
 * A random password and an authenticator secret are generated and written to the output file only (never printed),
 * for the operator to set up their authenticator app and sign in. Delete the file once that is done.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { hashPassword } from '@innpilot/db';
import { Client } from 'pg';
import { encryptSecret } from '../auth/crypto';
import { generateTotpSecret, otpauthUri } from '../auth/totp';
import { loadConfig } from '../config';

async function main() {
  const [email, fullName, out] = process.argv.slice(2);
  if (!email || !fullName || !out) {
    console.error('Usage: platform:operator <email> "<full name>" <output file>');
    process.exit(2);
  }
  if (existsSync(out)) {
    console.error(`${out} already exists; choose a new file so no credentials are overwritten.`);
    process.exit(2);
  }
  const config = loadConfig();
  const password = randomBytes(18).toString('base64url');
  const secret = generateTotpSecret();
  const client = new Client({ connectionString: config.DATABASE_URL });
  await client.connect();
  try {
    await client.query(
      `INSERT INTO platform_operators (email, full_name, password_hash, mfa_secret_enc) VALUES ($1, $2, $3, $4)`,
      [
        email.trim().toLowerCase(),
        fullName.trim(),
        await hashPassword(password),
        encryptSecret(secret, Buffer.from(config.MFA_ENCRYPTION_KEY, 'base64url')),
      ],
    );
  } finally {
    await client.end();
  }
  writeFileSync(
    out,
    [
      `InnPilot platform operator: ${email}`,
      `Password: ${password}`,
      `Authenticator secret: ${secret}`,
      `Authenticator link: ${otpauthUri(secret, email, 'InnPilot Platform')}`,
      'Delete this file once the authenticator app is set up and you have signed in.',
      '',
    ].join('\n'),
    { mode: 0o600 },
  );
  console.log(`Operator ${email} created. Credentials written to ${out}.`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : 'Could not create the operator.');
  process.exit(1);
});
