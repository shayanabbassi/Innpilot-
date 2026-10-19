/**
 * Typed mirror of the SQL migrations for Drizzle queries. Migrations are the source of truth;
 * `schema.integration.test.ts` fails if a column here disagrees with the database.
 */
import {
  bigint,
  boolean,
  char,
  customType,
  date,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  time,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

const citext = customType<{ data: string }>({ dataType: () => 'citext' });
const bytea = customType<{ data: Buffer }>({ dataType: () => 'bytea' });
const inet = customType<{ data: string }>({ dataType: () => 'inet' });
const tsz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const tenants = pgTable('tenants', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: citext('slug').notNull(),
  legalName: text('legal_name').notNull(),
  displayName: text('display_name').notNull(),
  status: text('status', { enum: ['trial', 'active', 'suspended', 'closed'] })
    .notNull()
    .default('trial'),
  baseCurrency: char('base_currency', { length: 3 }).notNull().default('PKR'),
  createdAt: tsz('created_at').notNull().defaultNow(),
  updatedAt: tsz('updated_at').notNull().defaultNow(),
});

export const properties = pgTable('properties', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  name: text('name').notNull(),
  legalName: text('legal_name'),
  timezone: text('timezone').notNull().default('Asia/Karachi'),
  currencyCode: char('currency_code', { length: 3 }).notNull().default('PKR'),
  addressLine: text('address_line'),
  city: text('city'),
  countryCode: char('country_code', { length: 2 }).notNull().default('PK'),
  phone: text('phone'),
  email: citext('email'),
  checkInTime: time('check_in_time').notNull().default('14:00'),
  checkOutTime: time('check_out_time').notNull().default('12:00'),
  businessDate: date('business_date', { mode: 'string' }).notNull(),
  status: text('status', { enum: ['active', 'archived'] })
    .notNull()
    .default('active'),
  createdAt: tsz('created_at').notNull().defaultNow(),
  updatedAt: tsz('updated_at').notNull().defaultNow(),
});

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  email: citext('email').notNull(),
  fullName: text('full_name').notNull(),
  passwordHash: text('password_hash').notNull(),
  passwordChangedAt: tsz('password_changed_at').notNull().defaultNow(),
  status: text('status', { enum: ['active', 'disabled'] })
    .notNull()
    .default('active'),
  mfaSecretEnc: text('mfa_secret_enc'),
  mfaEnabledAt: tsz('mfa_enabled_at'),
  mfaLastUsedStep: bigint('mfa_last_used_step', { mode: 'number' }),
  failedLoginCount: integer('failed_login_count').notNull().default(0),
  lockedUntil: tsz('locked_until'),
  lastLoginAt: tsz('last_login_at'),
  createdAt: tsz('created_at').notNull().defaultNow(),
  updatedAt: tsz('updated_at').notNull().defaultNow(),
  createdBy: uuid('created_by'),
});

export const permissions = pgTable('permissions', {
  code: text('code').primaryKey(),
  description: text('description').notNull(),
});

export const roles = pgTable('roles', {
  code: text('code').primaryKey(),
  name: text('name').notNull(),
  description: text('description').notNull(),
  mfaRequired: boolean('mfa_required').notNull().default(false),
  sortOrder: integer('sort_order').notNull(),
});

export const rolePermissions = pgTable(
  'role_permissions',
  {
    roleCode: text('role_code').notNull(),
    permissionCode: text('permission_code').notNull(),
  },
  (t) => [primaryKey({ columns: [t.roleCode, t.permissionCode] })],
);

export const userRoles = pgTable('user_roles', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  userId: uuid('user_id').notNull(),
  propertyId: uuid('property_id'),
  roleCode: text('role_code').notNull(),
  createdAt: tsz('created_at').notNull().defaultNow(),
  createdBy: uuid('created_by'),
});

export const sessions = pgTable('sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  userId: uuid('user_id').notNull(),
  tokenHash: bytea('token_hash').notNull(),
  csrfTokenHash: bytea('csrf_token_hash').notNull(),
  mfaVerifiedAt: tsz('mfa_verified_at'),
  createdAt: tsz('created_at').notNull().defaultNow(),
  lastSeenAt: tsz('last_seen_at').notNull().defaultNow(),
  idleExpiresAt: tsz('idle_expires_at').notNull(),
  absoluteExpiresAt: tsz('absolute_expires_at').notNull(),
  revokedAt: tsz('revoked_at'),
  revokedReason: text('revoked_reason'),
  ip: inet('ip'),
  userAgent: text('user_agent'),
});

export const auditEvents = pgTable('audit_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  propertyId: uuid('property_id'),
  actorType: text('actor_type', { enum: ['user', 'system', 'platform'] }).notNull(),
  actorUserId: uuid('actor_user_id'),
  action: text('action').notNull(),
  entityType: text('entity_type').notNull(),
  entityId: uuid('entity_id'),
  changes: jsonb('changes').$type<Record<string, unknown>>().notNull().default({}),
  reason: text('reason'),
  requestId: text('request_id'),
  ip: inet('ip'),
  occurredAt: tsz('occurred_at').notNull().defaultNow(),
});

export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    tenantId: uuid('tenant_id').notNull(),
    scope: text('scope').notNull(),
    key: text('key').notNull(),
    actorUserId: uuid('actor_user_id').notNull(),
    requestHash: text('request_hash').notNull(),
    status: text('status', { enum: ['in_progress', 'completed'] }).notNull(),
    responseStatus: integer('response_status'),
    responseBody: jsonb('response_body'),
    createdAt: tsz('created_at').notNull().defaultNow(),
    completedAt: tsz('completed_at'),
    expiresAt: tsz('expires_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.scope, t.key] })],
);
