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
  if (parsed.data.NODE_ENV === 'production' && !parsed.data.COOKIE_SECURE) {
    throw new Error('COOKIE_SECURE must be true in production.');
  }
  if (parsed.data.PII_ENCRYPTION_KEY === parsed.data.MFA_ENCRYPTION_KEY) {
    throw new Error('PII_ENCRYPTION_KEY and MFA_ENCRYPTION_KEY must be different keys.');
  }
  if (parsed.data.NODE_ENV === 'production' && !parsed.data.RATE_LIMIT_ENABLED) {
    throw new Error('RATE_LIMIT_ENABLED must be true in production.');
  }
  if (parsed.data.NODE_ENV === 'production' && !parsed.data.STORAGE_ENDPOINT.startsWith('https://')) {
    throw new Error('STORAGE_ENDPOINT must use https in production.');
  }
  return parsed.data;
}
