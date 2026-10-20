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
  numeric,
  pgTable,
  primaryKey,
  smallint,
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
  /** A cash closing variance above this needs approval (P4-5). */
  cashVarianceThreshold: numeric('cash_variance_threshold', { precision: 19, scale: 4 })
    .notNull()
    .default('500'),
  status: text('status', { enum: ['active', 'archived'] })
    .notNull()
    .default('active'),
  /** NULL while the setup wizard is unfinished. */
  onboardingCompletedAt: tsz('onboarding_completed_at'),
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

export const roomTypes = pgTable('room_types', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  propertyId: uuid('property_id').notNull(),
  code: citext('code').notNull(),
  name: text('name').notNull(),
  description: text('description'),
  capacityAdults: integer('capacity_adults').notNull(),
  capacityChildren: integer('capacity_children').notNull().default(0),
  active: boolean('active').notNull().default(true),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: tsz('created_at').notNull().defaultNow(),
  updatedAt: tsz('updated_at').notNull().defaultNow(),
  createdBy: uuid('created_by'),
});

export const rooms = pgTable('rooms', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  propertyId: uuid('property_id').notNull(),
  roomTypeId: uuid('room_type_id').notNull(),
  roomNumber: citext('room_number').notNull(),
  floor: text('floor'),
  housekeepingState: text('housekeeping_state', { enum: ['dirty', 'cleaning', 'clean', 'inspected'] })
    .notNull()
    .default('clean'),
  serviceState: text('service_state', { enum: ['in_service', 'out_of_order'] })
    .notNull()
    .default('in_service'),
  active: boolean('active').notNull().default(true),
  createdAt: tsz('created_at').notNull().defaultNow(),
  updatedAt: tsz('updated_at').notNull().defaultNow(),
  createdBy: uuid('created_by'),
});

export const roomTypeRates = pgTable('room_type_rates', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  propertyId: uuid('property_id').notNull(),
  roomTypeId: uuid('room_type_id').notNull(),
  effectiveFrom: date('effective_from', { mode: 'string' }).notNull(),
  /** NUMERIC(19,4) read as a string; convert with @innpilot/money, never Number(). */
  nightlyRate: numeric('nightly_rate', { precision: 19, scale: 4 }).notNull(),
  currencyCode: char('currency_code', { length: 3 }).notNull(),
  createdAt: tsz('created_at').notNull().defaultNow(),
  createdBy: uuid('created_by'),
});

export const roomStatusEvents = pgTable('room_status_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  propertyId: uuid('property_id').notNull(),
  roomId: uuid('room_id').notNull(),
  dimension: text('dimension', { enum: ['housekeeping', 'service'] }).notNull(),
  fromState: text('from_state'),
  toState: text('to_state').notNull(),
  reason: text('reason'),
  actorUserId: uuid('actor_user_id'),
  occurredAt: tsz('occurred_at').notNull().defaultNow(),
});

export const guests = pgTable('guests', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  fullName: text('full_name').notNull(),
  phone: text('phone'),
  phoneNormalized: text('phone_normalized'),
  email: citext('email'),
  nationality: char('nationality', { length: 2 }),
  addressLine: text('address_line'),
  city: text('city'),
  countryCode: char('country_code', { length: 2 }),
  preferences: text('preferences'),
  notes: text('notes'),
  marketingConsent: boolean('marketing_consent').notNull().default(false),
  consentUpdatedAt: tsz('consent_updated_at'),
  createdAt: tsz('created_at').notNull().defaultNow(),
  updatedAt: tsz('updated_at').notNull().defaultNow(),
  createdBy: uuid('created_by'),
});

export const guestDocuments = pgTable('guest_documents', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  guestId: uuid('guest_id').notNull(),
  documentType: text('document_type', { enum: ['cnic', 'passport', 'driving_license', 'other'] }).notNull(),
  issuingCountry: char('issuing_country', { length: 2 }).notNull(),
  /** Encrypted by the API; never select this into a response or log. */
  numberEnc: text('number_enc').notNull(),
  numberHmac: bytea('number_hmac').notNull(),
  numberLast4: text('number_last4').notNull(),
  expiryDate: date('expiry_date', { mode: 'string' }),
  createdAt: tsz('created_at').notNull().defaultNow(),
  createdBy: uuid('created_by'),
});

export const reservations = pgTable('reservations', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  propertyId: uuid('property_id').notNull(),
  bookingReference: text('booking_reference').notNull(),
  guestId: uuid('guest_id').notNull(),
  source: text('source', {
    enum: ['walk_in', 'phone', 'email', 'website', 'agent', 'ota', 'other'],
  }).notNull(),
  status: text('status', {
    enum: ['pending', 'confirmed', 'checked_in', 'checked_out', 'cancelled', 'no_show'],
  }).notNull(),
  notes: text('notes'),
  cancelReason: text('cancel_reason'),
  confirmedAt: tsz('confirmed_at'),
  cancelledAt: tsz('cancelled_at'),
  createdAt: tsz('created_at').notNull().defaultNow(),
  updatedAt: tsz('updated_at').notNull().defaultNow(),
  createdBy: uuid('created_by'),
});

export const reservationRooms = pgTable('reservation_rooms', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  propertyId: uuid('property_id').notNull(),
  reservationId: uuid('reservation_id').notNull(),
  roomTypeId: uuid('room_type_id').notNull(),
  roomId: uuid('room_id'),
  arrival: date('arrival', { mode: 'string' }).notNull(),
  departure: date('departure', { mode: 'string' }).notNull(),
  adults: integer('adults').notNull(),
  children: integer('children').notNull().default(0),
  nightlyRate: numeric('nightly_rate', { precision: 19, scale: 4 }).notNull(),
  currencyCode: char('currency_code', { length: 3 }).notNull(),
  rateOverridden: boolean('rate_overridden').notNull().default(false),
  status: text('status', { enum: ['active', 'released'] })
    .notNull()
    .default('active'),
  createdAt: tsz('created_at').notNull().defaultNow(),
  updatedAt: tsz('updated_at').notNull().defaultNow(),
  /** Set at check-in; a move's split segment inherits it. */
  stayId: uuid('stay_id'),
});

export const stays = pgTable('stays', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  propertyId: uuid('property_id').notNull(),
  reservationId: uuid('reservation_id').notNull(),
  guestId: uuid('guest_id').notNull(),
  status: text('status', { enum: ['in_house', 'checked_out'] })
    .notNull()
    .default('in_house'),
  checkedInAt: tsz('checked_in_at').notNull().defaultNow(),
  checkedInBy: uuid('checked_in_by'),
  checkedOutAt: tsz('checked_out_at'),
  checkedOutBy: uuid('checked_out_by'),
  createdAt: tsz('created_at').notNull().defaultNow(),
  updatedAt: tsz('updated_at').notNull().defaultNow(),
});

export const stayRooms = pgTable('stay_rooms', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  propertyId: uuid('property_id').notNull(),
  stayId: uuid('stay_id').notNull(),
  roomId: uuid('room_id').notNull(),
  fromDate: date('from_date', { mode: 'string' }).notNull(),
  startedAt: tsz('started_at').notNull().defaultNow(),
  endedAt: tsz('ended_at'),
  reason: text('reason'),
});

export const housekeepingTasks = pgTable('housekeeping_tasks', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  propertyId: uuid('property_id').notNull(),
  roomId: uuid('room_id').notNull(),
  taskType: text('task_type', { enum: ['clean', 'inspect'] }).notNull(),
  status: text('status', { enum: ['open', 'in_progress', 'done', 'cancelled'] })
    .notNull()
    .default('open'),
  source: text('source', { enum: ['manual', 'room_dirty', 'inspection_failed'] }).notNull(),
  assignedUserId: uuid('assigned_user_id'),
  notes: text('notes'),
  createdBy: uuid('created_by'),
  createdAt: tsz('created_at').notNull().defaultNow(),
  startedAt: tsz('started_at'),
  completedAt: tsz('completed_at'),
  completedBy: uuid('completed_by'),
});

export const maintenanceTickets = pgTable('maintenance_tickets', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  propertyId: uuid('property_id').notNull(),
  roomId: uuid('room_id'),
  category: text('category', {
    enum: ['plumbing', 'electrical', 'hvac', 'furniture', 'appliance', 'cleaning', 'other'],
  }).notNull(),
  priority: text('priority', { enum: ['low', 'normal', 'high', 'urgent'] })
    .notNull()
    .default('normal'),
  status: text('status', { enum: ['open', 'in_progress', 'resolved', 'cancelled'] })
    .notNull()
    .default('open'),
  description: text('description').notNull(),
  outOfOrderFrom: date('out_of_order_from', { mode: 'string' }),
  outOfOrderTo: date('out_of_order_to', { mode: 'string' }),
  reportedBy: uuid('reported_by'),
  createdAt: tsz('created_at').notNull().defaultNow(),
  resolvedAt: tsz('resolved_at'),
  resolvedBy: uuid('resolved_by'),
  resolutionNote: text('resolution_note'),
  unassignedReservations: jsonb('unassigned_reservations')
    .$type<{ reservationId: string; bookingReference: string }[]>()
    .notNull()
    .default([]),
});

export const businessDateCloses = pgTable('business_date_closes', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  propertyId: uuid('property_id').notNull(),
  businessDate: date('business_date', { mode: 'string' }).notNull(),
  nextDate: date('next_date', { mode: 'string' }).notNull(),
  noShowsMarked: integer('no_shows_marked').notNull().default(0),
  unresolved: jsonb('unresolved').$type<unknown[]>().notNull().default([]),
  reason: text('reason'),
  snapshot: jsonb('snapshot').$type<Record<string, number>>().notNull(),
  closedBy: uuid('closed_by').notNull(),
  closedAt: tsz('closed_at').notNull().defaultNow(),
  /** day_close: the interim close of Phase 2; night_audit: from slice 4.5 on. */
  kind: text('kind').notNull().default('night_audit'),
  summary: jsonb('summary').$type<Record<string, unknown>>().notNull().default({}),
});

export const accounts = pgTable('accounts', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  code: text('code').notNull(),
  name: text('name').notNull(),
  accountClass: text('account_class').notNull(),
  normalBalance: text('normal_balance').notNull(),
  parentId: uuid('parent_id'),
  systemRole: text('system_role'),
  active: boolean('active').notNull().default(true),
  createdAt: tsz('created_at').notNull().defaultNow(),
  updatedAt: tsz('updated_at').notNull().defaultNow(),
});

export const fiscalPeriods = pgTable('fiscal_periods', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  startDate: date('start_date', { mode: 'string' }).notNull(),
  endDate: date('end_date', { mode: 'string' }).notNull(),
  status: text('status').notNull().default('open'),
  closedBy: uuid('closed_by'),
  closedAt: tsz('closed_at'),
  reopenedBy: uuid('reopened_by'),
  reopenedAt: tsz('reopened_at'),
  reopenReason: text('reopen_reason'),
  createdAt: tsz('created_at').notNull().defaultNow(),
});

export const documentSequences = pgTable('document_sequences', {
  tenantId: uuid('tenant_id').notNull(),
  propertyId: uuid('property_id'),
  series: text('series').notNull(),
  nextNumber: bigint('next_number', { mode: 'number' }).notNull().default(1),
});

export const journalEntries = pgTable('journal_entries', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  propertyId: uuid('property_id').notNull(),
  journalNumber: bigint('journal_number', { mode: 'number' }),
  status: text('status').notNull().default('draft'),
  accountingDate: date('accounting_date', { mode: 'string' }).notNull(),
  periodId: uuid('period_id'),
  currencyCode: char('currency_code', { length: 3 }).notNull(),
  sourceType: text('source_type').notNull(),
  sourceId: uuid('source_id'),
  purpose: text('purpose').notNull().default('main'),
  reference: text('reference'),
  narration: text('narration').notNull(),
  totalDebit: numeric('total_debit', { precision: 19, scale: 4 }).notNull().default('0'),
  totalCredit: numeric('total_credit', { precision: 19, scale: 4 }).notNull().default('0'),
  reversesEntryId: uuid('reverses_entry_id'),
  reversedById: uuid('reversed_by_id'),
  idempotencyKey: text('idempotency_key'),
  createdBy: uuid('created_by').notNull(),
  createdAt: tsz('created_at').notNull().defaultNow(),
  postedBy: uuid('posted_by'),
  postedAt: tsz('posted_at'),
});

export const journalLines = pgTable('journal_lines', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  journalEntryId: uuid('journal_entry_id').notNull(),
  lineNo: smallint('line_no').notNull(),
  accountId: uuid('account_id').notNull(),
  debit: numeric('debit', { precision: 19, scale: 4 }).notNull().default('0'),
  credit: numeric('credit', { precision: 19, scale: 4 }).notNull().default('0'),
  description: text('description'),
  folioId: uuid('folio_id'),
  cashAccountId: uuid('cash_account_id'),
  /** The open cashier shift on that drawer when the line was posted (P4-4). */
  cashierShiftId: uuid('cashier_shift_id'),
  /** Set on accounts payable lines, so each supplier's balance reconciles to the ledger (4.3). */
  supplierId: uuid('supplier_id'),
});

export const taxCodes = pgTable('tax_codes', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  propertyId: uuid('property_id').notNull(),
  code: text('code').notNull(),
  name: text('name').notNull(),
  jurisdiction: text('jurisdiction'),
  payableAccountId: uuid('payable_account_id').notNull(),
  active: boolean('active').notNull().default(true),
  createdAt: tsz('created_at').notNull().defaultNow(),
  updatedAt: tsz('updated_at').notNull().defaultNow(),
});

export const taxRates = pgTable('tax_rates', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  propertyId: uuid('property_id').notNull(),
  taxCodeId: uuid('tax_code_id').notNull(),
  effectiveFrom: date('effective_from', { mode: 'string' }).notNull(),
  ratePercent: numeric('rate_percent', { precision: 9, scale: 4 }).notNull(),
  inclusive: boolean('inclusive').notNull().default(false),
  createdBy: uuid('created_by'),
  createdAt: tsz('created_at').notNull().defaultNow(),
});

export const chargeCategories = pgTable('charge_categories', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  propertyId: uuid('property_id').notNull(),
  code: text('code').notNull(),
  name: text('name').notNull(),
  revenueAccountId: uuid('revenue_account_id').notNull(),
  systemKind: text('system_kind'),
  active: boolean('active').notNull().default(true),
  createdAt: tsz('created_at').notNull().defaultNow(),
  updatedAt: tsz('updated_at').notNull().defaultNow(),
});

export const chargeCategoryTaxes = pgTable(
  'charge_category_taxes',
  {
    tenantId: uuid('tenant_id').notNull(),
    propertyId: uuid('property_id').notNull(),
    categoryId: uuid('category_id').notNull(),
    taxCodeId: uuid('tax_code_id').notNull(),
  },
  (t) => [primaryKey({ columns: [t.categoryId, t.taxCodeId] })],
);

export const invoiceProfiles = pgTable('invoice_profiles', {
  propertyId: uuid('property_id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  legalName: text('legal_name'),
  address: text('address'),
  registrationFields: jsonb('registration_fields')
    .$type<{ label: string; value: string }[]>()
    .notNull()
    .default([]),
  invoicePrefix: text('invoice_prefix').notNull().default('INV-'),
  receiptPrefix: text('receipt_prefix').notNull().default('RCT-'),
  footer: text('footer'),
  updatedBy: uuid('updated_by'),
  updatedAt: tsz('updated_at').notNull().defaultNow(),
});

export const folios = pgTable('folios', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  propertyId: uuid('property_id').notNull(),
  reservationId: uuid('reservation_id').notNull(),
  guestId: uuid('guest_id').notNull(),
  label: text('label').notNull().default('Main'),
  isPrimary: boolean('is_primary').notNull().default(false),
  status: text('status').notNull().default('open'),
  currencyCode: char('currency_code', { length: 3 }).notNull(),
  createdBy: uuid('created_by'),
  createdAt: tsz('created_at').notNull().defaultNow(),
  updatedAt: tsz('updated_at').notNull().defaultNow(),
  writtenOff: numeric('written_off', { precision: 19, scale: 4 }).notNull().default('0'),
  writeOffJournalId: uuid('write_off_journal_id'),
  settledAt: tsz('settled_at'),
  settledBy: uuid('settled_by'),
  settlementReason: text('settlement_reason'),
});

export const folioCharges = pgTable('folio_charges', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  propertyId: uuid('property_id').notNull(),
  folioId: uuid('folio_id').notNull(),
  categoryId: uuid('category_id').notNull(),
  kind: text('kind').notNull(),
  description: text('description').notNull(),
  serviceDate: date('service_date', { mode: 'string' }).notNull(),
  quantity: numeric('quantity', { precision: 9, scale: 2 }).notNull().default('1'),
  unitPrice: numeric('unit_price', { precision: 19, scale: 4 }).notNull(),
  netAmount: numeric('net_amount', { precision: 19, scale: 4 }).notNull(),
  taxAmount: numeric('tax_amount', { precision: 19, scale: 4 }).notNull(),
  grossAmount: numeric('gross_amount', { precision: 19, scale: 4 }).notNull(),
  status: text('status').notNull().default('posted'),
  reason: text('reason'),
  journalEntryId: uuid('journal_entry_id').notNull(),
  transferredFromId: uuid('transferred_from_id'),
  transferredToId: uuid('transferred_to_id'),
  voidJournalEntryId: uuid('void_journal_entry_id'),
  voidedBy: uuid('voided_by'),
  voidedAt: tsz('voided_at'),
  voidReason: text('void_reason'),
  createdBy: uuid('created_by').notNull(),
  createdAt: tsz('created_at').notNull().defaultNow(),
});

export const folioChargeTaxes = pgTable('folio_charge_taxes', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  propertyId: uuid('property_id').notNull(),
  chargeId: uuid('charge_id').notNull(),
  taxCodeId: uuid('tax_code_id').notNull(),
  code: text('code').notNull(),
  name: text('name').notNull(),
  ratePercent: numeric('rate_percent', { precision: 9, scale: 4 }).notNull(),
  inclusive: boolean('inclusive').notNull(),
  baseAmount: numeric('base_amount', { precision: 19, scale: 4 }).notNull(),
  taxAmount: numeric('tax_amount', { precision: 19, scale: 4 }).notNull(),
  payableAccountId: uuid('payable_account_id').notNull(),
});

export const cashAccounts = pgTable('cash_accounts', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  propertyId: uuid('property_id').notNull(),
  name: text('name').notNull(),
  kind: text('kind').notNull(),
  ledgerAccountId: uuid('ledger_account_id').notNull(),
  details: text('details'),
  active: boolean('active').notNull().default(true),
  createdAt: tsz('created_at').notNull().defaultNow(),
});

export const payments = pgTable('payments', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  propertyId: uuid('property_id').notNull(),
  folioId: uuid('folio_id').notNull(),
  reservationId: uuid('reservation_id').notNull(),
  kind: text('kind').notNull(),
  method: text('method').notNull(),
  cashAccountId: uuid('cash_account_id').notNull(),
  amount: numeric('amount', { precision: 19, scale: 4 }).notNull(),
  currencyCode: char('currency_code', { length: 3 }).notNull(),
  businessDate: date('business_date', { mode: 'string' }).notNull(),
  receivedAt: tsz('received_at').notNull().defaultNow(),
  externalReference: text('external_reference'),
  notes: text('notes'),
  receiptNumber: text('receipt_number').notNull(),
  journalEntryId: uuid('journal_entry_id').notNull(),
  idempotencyKey: text('idempotency_key'),
  createdBy: uuid('created_by').notNull(),
});

export const depositApplications = pgTable('deposit_applications', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  propertyId: uuid('property_id').notNull(),
  paymentId: uuid('payment_id').notNull(),
  amount: numeric('amount', { precision: 19, scale: 4 }).notNull(),
  journalEntryId: uuid('journal_entry_id').notNull(),
  createdBy: uuid('created_by').notNull(),
  createdAt: tsz('created_at').notNull().defaultNow(),
});

export const refunds = pgTable('refunds', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  propertyId: uuid('property_id').notNull(),
  paymentId: uuid('payment_id').notNull(),
  amount: numeric('amount', { precision: 19, scale: 4 }).notNull(),
  method: text('method').notNull(),
  cashAccountId: uuid('cash_account_id').notNull(),
  externalReference: text('external_reference'),
  reason: text('reason').notNull(),
  businessDate: date('business_date', { mode: 'string' }).notNull(),
  refundNumber: text('refund_number').notNull(),
  journalEntryId: uuid('journal_entry_id').notNull(),
  createdBy: uuid('created_by').notNull(),
  createdAt: tsz('created_at').notNull().defaultNow(),
});

export const roomNightCharges = pgTable('room_night_charges', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  propertyId: uuid('property_id').notNull(),
  chargeId: uuid('charge_id').notNull(),
  reservationRoomId: uuid('reservation_room_id').notNull(),
  night: date('night', { mode: 'string' }).notNull(),
});

export const invoices = pgTable('invoices', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  propertyId: uuid('property_id').notNull(),
  folioId: uuid('folio_id').notNull(),
  reservationId: uuid('reservation_id').notNull(),
  invoiceNumber: text('invoice_number').notNull(),
  issueDate: date('issue_date', { mode: 'string' }).notNull(),
  currencyCode: char('currency_code', { length: 3 }).notNull(),
  billTo: text('bill_to').notNull(),
  netAmount: numeric('net_amount', { precision: 19, scale: 4 }).notNull(),
  taxAmount: numeric('tax_amount', { precision: 19, scale: 4 }).notNull(),
  grossAmount: numeric('gross_amount', { precision: 19, scale: 4 }).notNull(),
  paidAmount: numeric('paid_amount', { precision: 19, scale: 4 }).notNull(),
  writtenOff: numeric('written_off', { precision: 19, scale: 4 }).notNull().default('0'),
  balanceDue: numeric('balance_due', { precision: 19, scale: 4 }).notNull(),
  taxSummary: jsonb('tax_summary').$type<unknown[]>().notNull().default([]),
  hotel: jsonb('hotel').$type<Record<string, unknown>>().notNull(),
  createdBy: uuid('created_by').notNull(),
  createdAt: tsz('created_at').notNull().defaultNow(),
});

export const invoiceLines = pgTable('invoice_lines', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  propertyId: uuid('property_id').notNull(),
  invoiceId: uuid('invoice_id').notNull(),
  lineNo: smallint('line_no').notNull(),
  kind: text('kind').notNull(),
  description: text('description').notNull(),
  serviceDate: date('service_date', { mode: 'string' }).notNull(),
  quantity: numeric('quantity', { precision: 9, scale: 2 }).notNull(),
  unitPrice: numeric('unit_price', { precision: 19, scale: 4 }).notNull(),
  netAmount: numeric('net_amount', { precision: 19, scale: 4 }).notNull(),
  taxAmount: numeric('tax_amount', { precision: 19, scale: 4 }).notNull(),
  grossAmount: numeric('gross_amount', { precision: 19, scale: 4 }).notNull(),
  taxes: jsonb('taxes').$type<unknown[]>().notNull().default([]),
});

export const cashTransfers = pgTable('cash_transfers', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  propertyId: uuid('property_id').notNull(),
  fromCashAccountId: uuid('from_cash_account_id').notNull(),
  toCashAccountId: uuid('to_cash_account_id').notNull(),
  amount: numeric('amount', { precision: 19, scale: 4 }).notNull(),
  businessDate: date('business_date', { mode: 'string' }).notNull(),
  reference: text('reference'),
  notes: text('notes'),
  journalEntryId: uuid('journal_entry_id').notNull(),
  createdBy: uuid('created_by').notNull(),
  createdAt: tsz('created_at').notNull().defaultNow(),
});

export const openingBalances = pgTable('opening_balances', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  propertyId: uuid('property_id').notNull(),
  asOf: date('as_of', { mode: 'string' }).notNull(),
  journalEntryId: uuid('journal_entry_id').notNull(),
  createdBy: uuid('created_by').notNull(),
  createdAt: tsz('created_at').notNull().defaultNow(),
});

export const cashierShifts = pgTable('cashier_shifts', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  propertyId: uuid('property_id').notNull(),
  cashAccountId: uuid('cash_account_id').notNull(),
  userId: uuid('user_id').notNull(),
  businessDate: date('business_date', { mode: 'string' }).notNull(),
  openedAt: tsz('opened_at').notNull().defaultNow(),
  openingCount: numeric('opening_count', { precision: 19, scale: 4 }).notNull(),
  bookBalanceAtOpen: numeric('book_balance_at_open', { precision: 19, scale: 4 }).notNull(),
  status: text('status').notNull().default('open'),
  closedAt: tsz('closed_at'),
});

export const cashClosings = pgTable('cash_closings', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  propertyId: uuid('property_id').notNull(),
  shiftId: uuid('shift_id').notNull(),
  cashAccountId: uuid('cash_account_id').notNull(),
  businessDate: date('business_date', { mode: 'string' }).notNull(),
  expectedAmount: numeric('expected_amount', { precision: 19, scale: 4 }).notNull(),
  countedAmount: numeric('counted_amount', { precision: 19, scale: 4 }).notNull(),
  variance: numeric('variance', { precision: 19, scale: 4 }).notNull(),
  explanation: text('explanation'),
  threshold: numeric('threshold', { precision: 19, scale: 4 }).notNull(),
  approvalRequired: boolean('approval_required').notNull(),
  status: text('status').notNull(),
  submittedBy: uuid('submitted_by').notNull(),
  submittedAt: tsz('submitted_at').notNull().defaultNow(),
  approvedBy: uuid('approved_by'),
  approvedAt: tsz('approved_at'),
  approvalNote: text('approval_note'),
  varianceJournalEntryId: uuid('variance_journal_entry_id'),
  reopenedBy: uuid('reopened_by'),
  reopenedAt: tsz('reopened_at'),
  reopenReason: text('reopen_reason'),
});

export const suppliers = pgTable('suppliers', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  name: text('name').notNull(),
  contact: text('contact'),
  taxIdentifier: text('tax_identifier'),
  paymentTermsDays: integer('payment_terms_days').notNull().default(0),
  notes: text('notes'),
  active: boolean('active').notNull().default(true),
  createdAt: tsz('created_at').notNull().defaultNow(),
});

export const expenseVouchers = pgTable('expense_vouchers', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  propertyId: uuid('property_id').notNull(),
  voucherNumber: text('voucher_number').notNull(),
  kind: text('kind').notNull(),
  status: text('status').notNull().default('draft'),
  supplierId: uuid('supplier_id'),
  payee: text('payee'),
  expenseDate: date('expense_date', { mode: 'string' }).notNull(),
  dueDate: date('due_date', { mode: 'string' }),
  billReference: text('bill_reference'),
  description: text('description').notNull(),
  attachmentRef: text('attachment_ref'),
  cashAccountId: uuid('cash_account_id'),
  netAmount: numeric('net_amount', { precision: 19, scale: 4 }).notNull().default('0'),
  taxAmount: numeric('tax_amount', { precision: 19, scale: 4 }).notNull().default('0'),
  totalAmount: numeric('total_amount', { precision: 19, scale: 4 }).notNull().default('0'),
  journalEntryId: uuid('journal_entry_id'),
  createdBy: uuid('created_by').notNull(),
  createdAt: tsz('created_at').notNull().defaultNow(),
  submittedBy: uuid('submitted_by'),
  submittedAt: tsz('submitted_at'),
  approvedBy: uuid('approved_by'),
  approvedAt: tsz('approved_at'),
  voidedBy: uuid('voided_by'),
  voidedAt: tsz('voided_at'),
  voidReason: text('void_reason'),
});

export const expenseLines = pgTable('expense_lines', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  voucherId: uuid('voucher_id').notNull(),
  lineNo: integer('line_no').notNull(),
  accountId: uuid('account_id').notNull(),
  description: text('description'),
  amount: numeric('amount', { precision: 19, scale: 4 }).notNull(),
  taxAmount: numeric('tax_amount', { precision: 19, scale: 4 }).notNull().default('0'),
  taxRecoverable: boolean('tax_recoverable').notNull().default(false),
});

export const expensePayments = pgTable('expense_payments', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  propertyId: uuid('property_id').notNull(),
  voucherId: uuid('voucher_id').notNull(),
  cashAccountId: uuid('cash_account_id').notNull(),
  amount: numeric('amount', { precision: 19, scale: 4 }).notNull(),
  businessDate: date('business_date', { mode: 'string' }).notNull(),
  reference: text('reference'),
  journalEntryId: uuid('journal_entry_id').notNull(),
  createdBy: uuid('created_by').notNull(),
  createdAt: tsz('created_at').notNull().defaultNow(),
});

export const bankReconciliations = pgTable('bank_reconciliations', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  propertyId: uuid('property_id').notNull(),
  cashAccountId: uuid('cash_account_id').notNull(),
  statementDate: date('statement_date', { mode: 'string' }).notNull(),
  statementBalance: numeric('statement_balance', { precision: 19, scale: 4 }).notNull(),
  status: text('status').notNull().default('in_progress'),
  clearedBalance: numeric('cleared_balance', { precision: 19, scale: 4 }),
  difference: numeric('difference', { precision: 19, scale: 4 }),
  differenceExplanation: text('difference_explanation'),
  createdBy: uuid('created_by').notNull(),
  createdAt: tsz('created_at').notNull().defaultNow(),
  completedBy: uuid('completed_by'),
  completedAt: tsz('completed_at'),
});

export const reconciliationItems = pgTable('reconciliation_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  reconciliationId: uuid('reconciliation_id').notNull(),
  journalLineId: uuid('journal_line_id').notNull(),
});

export const cardSettlements = pgTable('card_settlements', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  propertyId: uuid('property_id').notNull(),
  clearingAccountId: uuid('clearing_account_id').notNull(),
  bankAccountId: uuid('bank_account_id').notNull(),
  grossAmount: numeric('gross_amount', { precision: 19, scale: 4 }).notNull(),
  feeAmount: numeric('fee_amount', { precision: 19, scale: 4 }).notNull().default('0'),
  businessDate: date('business_date', { mode: 'string' }).notNull(),
  reference: text('reference'),
  journalEntryId: uuid('journal_entry_id').notNull(),
  createdBy: uuid('created_by').notNull(),
  createdAt: tsz('created_at').notNull().defaultNow(),
});

export const roomRevenueAccruals = pgTable('room_revenue_accruals', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  propertyId: uuid('property_id').notNull(),
  reservationRoomId: uuid('reservation_room_id').notNull(),
  night: date('night', { mode: 'string' }).notNull(),
  businessDate: date('business_date', { mode: 'string' }).notNull(),
  netAmount: numeric('net_amount', { precision: 19, scale: 4 }).notNull(),
  revenueAccountId: uuid('revenue_account_id').notNull(),
  journalEntryId: uuid('journal_entry_id').notNull(),
  createdAt: tsz('created_at').notNull().defaultNow(),
});
