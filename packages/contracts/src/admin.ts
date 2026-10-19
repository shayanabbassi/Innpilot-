import { z } from 'zod';
import { password } from './auth';
import { listQuery, timeOfDay, timeZone, uuid } from './common';
import { roleCode } from './rbac';

/** Response schemas double as the TypeScript types and the OpenAPI contract. */
export const propertyDto = z.object({
  id: z.string().uuid(),
  name: z.string(),
  legalName: z.string().nullable(),
  timezone: z.string(),
  currencyCode: z.string(),
  addressLine: z.string().nullable(),
  city: z.string().nullable(),
  countryCode: z.string(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  checkInTime: z.string(),
  checkOutTime: z.string(),
  /** YYYY-MM-DD; the hotel's operating date. */
  businessDate: z.string(),
  status: z.enum(['active', 'archived']),
});
export type PropertyDto = z.infer<typeof propertyDto>;

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .optional();

export const updatePropertyRequest = z
  .object({
    name: z.string().trim().min(1, 'Enter the property name.').max(200).optional(),
    legalName: optionalText(200),
    timezone: timeZone.optional(),
    addressLine: optionalText(300),
    city: optionalText(100),
    phone: optionalText(40),
    email: z
      .string()
      .trim()
      .toLowerCase()
      .max(254)
      .refine((v) => v === '' || z.string().email().safeParse(v).success, 'Enter a valid email address.')
      .transform((v) => (v === '' ? null : v))
      .nullable()
      .optional(),
    checkInTime: timeOfDay.optional(),
    checkOutTime: timeOfDay.optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Change at least one field.' });
export type UpdatePropertyRequest = z.infer<typeof updatePropertyRequest>;

export const roleAssignment = z.object({
  role: roleCode,
  /** null = every property in the tenant. */
  propertyId: uuid.nullable(),
});
export type RoleAssignmentDto = z.infer<typeof roleAssignment>;

export const userDto = z.object({
  id: z.string().uuid(),
  email: z.string(),
  fullName: z.string(),
  status: z.enum(['active', 'disabled']),
  mfaEnabled: z.boolean(),
  lastLoginAt: z.string().datetime().nullable(),
  roles: z.array(roleAssignment),
});
export type UserDto = z.infer<typeof userDto>;

export const createUserRequest = z
  .object({
    email: z.string().trim().toLowerCase().email('Enter a valid email address.').max(254),
    fullName: z.string().trim().min(1, 'Enter the full name.').max(200),
    /** Initial password, communicated to the staff member by the creator. */
    password,
    roles: z.array(roleAssignment).min(1, 'Assign at least one role.').max(20),
  })
  .strict();
export type CreateUserRequest = z.infer<typeof createUserRequest>;

export const setUserRolesRequest = z
  .object({ roles: z.array(roleAssignment).min(1, 'Assign at least one role.').max(20) })
  .strict();
export type SetUserRolesRequest = z.infer<typeof setUserRolesRequest>;

export const setUserStatusRequest = z
  .object({
    status: z.enum(['active', 'disabled']),
    reason: z.string().trim().min(3, 'Give a reason.').max(500),
  })
  .strict();
export type SetUserStatusRequest = z.infer<typeof setUserStatusRequest>;

export const auditEventDto = z.object({
  id: z.string().uuid(),
  occurredAt: z.string().datetime(),
  action: z.string(),
  entityType: z.string(),
  entityId: z.string().uuid().nullable(),
  propertyId: z.string().uuid().nullable(),
  actor: z.object({
    type: z.enum(['user', 'system', 'platform']),
    userId: z.string().uuid().nullable(),
    name: z.string().nullable(),
  }),
  changes: z.record(z.unknown()),
  reason: z.string().nullable(),
  requestId: z.string().nullable(),
});
export type AuditEventDto = z.infer<typeof auditEventDto>;

export const auditEventsQuery = listQuery.extend({
  entityType: z.string().max(60).optional(),
  entityId: uuid.optional(),
});
export type AuditEventsQuery = z.infer<typeof auditEventsQuery>;

export const reasonRequest = z
  .object({ reason: z.string().trim().min(3, 'Give a reason.').max(500) })
  .strict();
export type ReasonRequest = z.infer<typeof reasonRequest>;
