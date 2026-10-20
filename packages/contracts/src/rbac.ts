import { z } from 'zod';

/**
 * Permission catalogue and system roles. The database seeds the same data in
 * packages/db/migrations/0001_foundation.sql; an integration test asserts they match.
 * Changing either requires a new migration.
 */
export const PERMISSIONS = {
  'property.read': 'View property profile and settings',
  'property.manage': 'Change property profile and settings',
  'user.read': 'View staff accounts and role assignments',
  'user.manage': 'Create staff accounts, assign roles, disable accounts',
  'audit.read': 'View the audit log',
  'room.read': 'View rooms, room types and the room board',
  'room.manage': 'Create and change rooms, room types and rates',
  'room.out_of_order': 'Take rooms out of order and return them to service',
  'reservation.read': 'View reservations',
  'reservation.write': 'Create, change and cancel reservations',
  'reservation.rate_override': 'Book at a rate other than the room type rate',
  'guest.read': 'View guest profiles and stay history',
  'guest.write': 'Create and change guest profiles',
  'guest.identity.read': 'View guest identity document details',
  'stay.checkin': 'Check guests in',
  'stay.checkout': 'Check guests out',
  'stay.readiness_override': 'Check in or move a guest into a room that is not ready',
  'housekeeping.read': 'View housekeeping tasks and room status',
  'housekeeping.write': 'Update cleaning, inspection and maintenance status',
  'folio.read': 'View guest folios',
  'folio.charge': 'Post charges to folios',
  'folio.adjust': 'Post adjustments, transfers and write-offs on folios',
  'payment.receive': 'Record payments and deposits',
  'payment.refund': 'Issue refunds',
  'cashier.operate': 'Open and close own cashier session',
  'cashier.approve': 'Approve cashier variances',
  'journal.read': 'View chart of accounts and journals',
  'account.manage': 'Create and change accounts in the chart of accounts',
  'journal.post': 'Post manual journal entries',
  'journal.reverse': 'Reverse posted journal entries',
  'period.close': 'Close accounting periods',
  'period.reopen': 'Reopen closed accounting periods',
  'expense.write': 'Record expenses and supplier bills',
  'expense.approve': 'Approve expenses and supplier bills',
  'expense.pay': 'Pay approved expenses and supplier bills',
  'tax.configure': 'Configure tax codes and invoice settings',
  'night_audit.run': 'Run the daily close and advance the business date',
  'report.operational': 'View operational reports',
  'report.financial': 'View financial reports and statements',
  'export.run': 'Export reports and data',
} as const;

export type Permission = keyof typeof PERMISSIONS;
export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];

export type RoleCode =
  | 'tenant_owner'
  | 'hotel_manager'
  | 'accountant'
  | 'cashier'
  | 'front_desk'
  | 'housekeeping'
  | 'read_only_auditor';

export interface RoleDefinition {
  name: string;
  description: string;
  /** Users holding this role must enrol and verify TOTP MFA before using the app. */
  mfaRequired: boolean;
  permissions: readonly Permission[];
}

const READ_ALL: Permission[] = ALL_PERMISSIONS.filter(
  (p) => p.endsWith('.read') && p !== 'guest.identity.read',
);

export const ROLES: Record<RoleCode, RoleDefinition> = {
  tenant_owner: {
    name: 'Owner',
    description: 'Full control of the hotel account, finance and staff.',
    mfaRequired: true,
    permissions: ALL_PERMISSIONS,
  },
  hotel_manager: {
    name: 'General manager',
    description: 'Runs daily operations, approves exceptions and manages staff.',
    mfaRequired: true,
    permissions: ALL_PERMISSIONS.filter(
      (p) =>
        ![
          'period.close',
          'period.reopen',
          'journal.post',
          'journal.reverse',
          'account.manage',
          'tax.configure',
        ].includes(p),
    ),
  },
  accountant: {
    name: 'Accountant',
    description: 'Manages the ledger, expenses, periods and financial reports.',
    mfaRequired: true,
    permissions: [
      ...READ_ALL,
      'account.manage',
      'journal.post',
      'journal.reverse',
      'period.close',
      'period.reopen',
      'expense.write',
      'expense.approve',
      'expense.pay',
      'cashier.approve',
      'tax.configure',
      'report.operational',
      'report.financial',
      'export.run',
    ],
  },
  cashier: {
    name: 'Cashier',
    description: 'Takes payments, runs a cashier session and records cash expenses.',
    mfaRequired: false,
    permissions: [
      'property.read',
      'room.read',
      'reservation.read',
      'guest.read',
      'folio.read',
      'folio.charge',
      'payment.receive',
      'cashier.operate',
      'expense.write',
      'report.operational',
    ],
  },
  front_desk: {
    name: 'Front desk',
    description: 'Handles reservations, check-in, check-out and guest charges.',
    mfaRequired: false,
    permissions: [
      'property.read',
      'room.read',
      'reservation.read',
      'reservation.write',
      'guest.read',
      'guest.write',
      'guest.identity.read',
      'stay.checkin',
      'stay.checkout',
      'housekeeping.read',
      'folio.read',
      'folio.charge',
      'payment.receive',
      'cashier.operate',
      'report.operational',
    ],
  },
  housekeeping: {
    name: 'Housekeeping',
    description: 'Sees assigned rooms and updates cleaning and maintenance status.',
    mfaRequired: false,
    permissions: ['property.read', 'room.read', 'housekeeping.read', 'housekeeping.write'],
  },
  read_only_auditor: {
    name: 'Auditor (read only)',
    description: 'Reads records and reports; cannot change anything.',
    mfaRequired: false,
    permissions: [...READ_ALL, 'report.operational', 'report.financial'],
  },
};

export const ROLE_CODES = Object.keys(ROLES) as RoleCode[];

export const roleCode = z.enum(ROLE_CODES as [RoleCode, ...RoleCode[]]);
export const permission = z.enum(ALL_PERMISSIONS as [Permission, ...Permission[]]);
