import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loadConfig } from './config';

const key = () => randomBytes(32).toString('base64url');

/** A configuration a real production deployment would use. */
const production = (): NodeJS.ProcessEnv => ({
  NODE_ENV: 'production',
  DATABASE_URL: 'postgres://innpilot_app:long-random-password@db.internal.example:5432/innpilot', // secret-scan: allow fictional
  WEB_ORIGINS: 'https://app.innpilot.example',
  COOKIE_SECURE: 'true',
  MFA_ENCRYPTION_KEY: key(),
  PII_ENCRYPTION_KEY: key(),
  LOG_LEVEL: 'info',
  STORAGE_ENDPOINT: 'https://storage.example',
  STORAGE_BUCKET: 'innpilot-prod',
  STORAGE_ACCESS_KEY_ID: 'innpilot-api',
  STORAGE_SECRET_ACCESS_KEY: 'a-long-random-storage-secret-value',
});

const problems = (env: NodeJS.ProcessEnv) => {
  try {
    loadConfig(env);
    return '';
  } catch (err) {
    return (err as Error).message;
  }
};

describe('production configuration', () => {
  it('starts with safe settings', () => {
    expect(problems(production())).toBe('');
  });

  it('allows plain http to storage only on the private network', () => {
    expect(problems({ ...production(), STORAGE_ENDPOINT: 'http://storage:7070' })).toBe('');
    expect(problems({ ...production(), STORAGE_ENDPOINT: 'http://storage.example:7070' })).toMatch(
      /STORAGE_ENDPOINT must use https/,
    );
  });

  it('refuses each unsafe setting, listing them all at once', () => {
    const message = problems({
      ...production(),
      COOKIE_SECURE: 'false',
      RATE_LIMIT_ENABLED: 'false',
      WEB_ORIGINS: 'https://app.innpilot.example,http://localhost:3000',
      LOG_LEVEL: 'debug',
      STORAGE_SECRET_ACCESS_KEY: 'short-secret',
      MFA_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64url'),
      PII_ENCRYPTION_KEY: Buffer.alloc(32, 5).toString('base64url'),
      DATABASE_URL: 'postgres://postgres:pw@db.internal.example:5432/innpilot',
    });
    for (const expected of [
      /COOKIE_SECURE must be true/,
      /RATE_LIMIT_ENABLED must be true/,
      /WEB_ORIGINS must all use https \(http:\/\/localhost:3000\)/,
      /LOG_LEVEL must be info or quieter/,
      /STORAGE_SECRET_ACCESS_KEY is too short/,
      /MFA_ENCRYPTION_KEY is not random/,
      /PII_ENCRYPTION_KEY is not random/,
      /not the postgres superuser/,
    ]) {
      expect(message).toMatch(expected);
    }
  });

  it('keeps development permissive', () => {
    expect(
      problems({
        ...production(),
        NODE_ENV: 'development',
        COOKIE_SECURE: 'false',
        WEB_ORIGINS: 'http://localhost:3000',
        LOG_LEVEL: 'debug',
      }),
    ).toBe('');
  });
});
