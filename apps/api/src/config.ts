import { z } from 'zod';

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().url(),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  WEB_ORIGINS: z
    .string()
    .min(1)
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  COOKIE_SECURE: bool.default('true'),
  MFA_ENCRYPTION_KEY: z
    .string()
    .refine(
      (v) => Buffer.from(v, 'base64url').length === 32,
      'MFA_ENCRYPTION_KEY must be 32 bytes, base64url.',
    ),
  /** 32 bytes, base64url. Encrypts guest identity-document numbers and keys their lookup hash. */
  PII_ENCRYPTION_KEY: z
    .string()
    .refine(
      (v) => Buffer.from(v, 'base64url').length === 32,
      'PII_ENCRYPTION_KEY must be 32 bytes, base64url.',
    ),
  SESSION_IDLE_MINUTES: z.coerce
    .number()
    .int()
    .min(5)
    .max(24 * 60)
    .default(30),
  SESSION_ABSOLUTE_HOURS: z.coerce
    .number()
    .int()
    .min(1)
    .max(7 * 24)
    .default(12),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  /** Express "trust proxy" setting, so rate limits and audit IPs use the real client address. */
  TRUST_PROXY: z.string().default('loopback'),
  /** Per-IP request rate limits. Only end-to-end tests switch this off. */
  RATE_LIMIT_ENABLED: bool.default('true'),
  /**
   * How often this instance looks for background jobs (slice 6.3). 0 turns the worker off, for an instance that
   * should only serve requests (and in tests, which run jobs directly).
   */
  JOBS_POLL_SECONDS: z.coerce.number().int().min(0).max(3600).default(5),
  /** Private S3-compatible object storage for attachments (slice 6.2). Path-style addressing. */
  STORAGE_ENDPOINT: z
    .string()
    .url()
    .transform((v) => v.replace(/\/+$/, '')),
  STORAGE_REGION: z.string().min(1).default('us-east-1'),
  STORAGE_BUCKET: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/, 'Use a valid S3 bucket name.'),
  STORAGE_ACCESS_KEY_ID: z.string().min(3),
  STORAGE_SECRET_ACCESS_KEY: z.string().min(8),
});

export type AppConfig = z.infer<typeof schema>;
export const APP_CONFIG = Symbol('APP_CONFIG');

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration:\n${problems}`);
  }
  if (parsed.data.PII_ENCRYPTION_KEY === parsed.data.MFA_ENCRYPTION_KEY) {
    throw new Error('PII_ENCRYPTION_KEY and MFA_ENCRYPTION_KEY must be different keys.');
  }
  if (parsed.data.NODE_ENV === 'production') {
    const problems = productionProblems(parsed.data);
    if (problems.length) {
      throw new Error(`Unsafe configuration for production:\n${problems.map((p) => `  ${p}`).join('\n')}`);
    }
  }
  return parsed.data;
}

/** A host on the deployment's private network (a container or service name), never the public internet. */
function privateServiceHost(url: string): boolean {
  return !new URL(url).hostname.includes('.');
}

/** True for keys that look like placeholders: too few distinct bytes to be random. */
function weakKey(base64url: string): boolean {
  return new Set(Buffer.from(base64url, 'base64url')).size < 16;
}

/**
 * Settings that are fine on a laptop but unsafe in production (P6-5). Start-up lists every problem at once, so a
 * misconfigured release fails before it serves anything. The database role is checked separately once connected
 * (see assertRestrictedDatabaseRole), because only the database knows what it may bypass.
 */
export function productionProblems(c: AppConfig): string[] {
  const problems: string[] = [];
  if (!c.COOKIE_SECURE) problems.push('COOKIE_SECURE must be true (cookies only over HTTPS).');
  if (!c.RATE_LIMIT_ENABLED) problems.push('RATE_LIMIT_ENABLED must be true.');
  for (const origin of c.WEB_ORIGINS) {
    if (!origin.startsWith('https://')) problems.push(`WEB_ORIGINS must all use https (${origin}).`);
  }
  if (c.LOG_LEVEL === 'debug' || c.LOG_LEVEL === 'trace') {
    problems.push('LOG_LEVEL must be info or quieter: debug and trace logs carry request details.');
  }
  // Storage may be reached over plain http only inside the private network; files are encrypted by the API.
  if (!c.STORAGE_ENDPOINT.startsWith('https://') && !privateServiceHost(c.STORAGE_ENDPOINT)) {
    problems.push('STORAGE_ENDPOINT must use https unless it is a service on the private network.');
  }
  if (c.STORAGE_SECRET_ACCESS_KEY.length < 20) problems.push('STORAGE_SECRET_ACCESS_KEY is too short.');
  if (weakKey(c.MFA_ENCRYPTION_KEY)) problems.push('MFA_ENCRYPTION_KEY is not random; generate a new key.');
  if (weakKey(c.PII_ENCRYPTION_KEY)) problems.push('PII_ENCRYPTION_KEY is not random; generate a new key.');
  const dbUser = decodeURIComponent(new URL(c.DATABASE_URL).username);
  if (dbUser === 'postgres') {
    problems.push('DATABASE_URL must use the restricted application role, not the postgres superuser.');
  }
  return problems;
}
