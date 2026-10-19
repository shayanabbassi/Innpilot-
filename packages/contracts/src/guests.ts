import { z } from 'zod';

/**
 * Digits-only phone key used for search and duplicate detection. Pakistani local formats are mapped to the
 * international form so "0300 1234567", "+92 300 1234567" and "0092-300-1234567" all match.
 * Display keeps whatever the guest gave.
 */
export function normalizePhone(raw: string): string | null {
  let digits = raw.replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.length === 11 && digits.startsWith('0')) digits = `92${digits.slice(1)}`;
  return digits.length >= 7 ? digits : null;
}

export const DOCUMENT_TYPES = ['cnic', 'passport', 'driving_license', 'other'] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

/** Canonical form of a document number: upper case, without spaces or hyphens. Used for the lookup hash. */
export function normalizeDocumentNumber(raw: string): string {
  return raw.replace(/[\s-]/g, '').toUpperCase();
}

const countryCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{2}$/, 'Use a 2-letter country code, e.g. PK.');

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .optional();

const phone = z
  .string()
  .trim()
  .max(40)
  .refine((v) => v === '' || normalizePhone(v) !== null, 'Enter a phone number with at least 7 digits.')
  .transform((v) => (v === '' ? null : v))
  .nullable()
  .optional();

const email = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .refine((v) => v === '' || z.string().email().safeParse(v).success, 'Enter a valid email address.')
  .transform((v) => (v === '' ? null : v))
  .nullable()
  .optional();

export const guestDocumentInput = z
  .object({
    documentType: z.enum(DOCUMENT_TYPES),
    issuingCountry: countryCode,
    number: z.string().trim().min(1, 'Enter the document number.').max(40),
    expiryDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2030-12-31.')
      .nullable()
      .optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    const n = normalizeDocumentNumber(v.number);
    if (v.documentType === 'cnic' && !/^\d{13}$/.test(n)) {
      ctx.addIssue({
        code: 'custom',
        path: ['number'],
        message: 'A CNIC has 13 digits, e.g. 35202-1234567-1.',
      });
    } else if (v.documentType === 'passport' && !/^[A-Z0-9]{6,12}$/.test(n)) {
      ctx.addIssue({
        code: 'custom',
        path: ['number'],
        message: 'A passport number has 6–12 letters or digits.',
      });
    } else if (!/^[A-Z0-9]{3,30}$/.test(n)) {
      ctx.addIssue({ code: 'custom', path: ['number'], message: 'Use 3–30 letters or digits.' });
    }
  });
export type GuestDocumentInput = z.infer<typeof guestDocumentInput>;

const guestFields = {
  fullName: z.string().trim().min(1, 'Enter the guest’s name.').max(200),
  phone,
  email,
  nationality: countryCode.nullable().optional(),
  addressLine: optionalText(300),
  city: optionalText(100),
  countryCode: countryCode.nullable().optional(),
  preferences: optionalText(1000),
  notes: optionalText(2000),
  marketingConsent: z.boolean().optional(),
};

export const createGuestRequest = z
  .object({ ...guestFields, document: guestDocumentInput.optional() })
  .strict();
export type CreateGuestRequest = z.infer<typeof createGuestRequest>;

export const updateGuestRequest = z
  .object({ ...guestFields, fullName: guestFields.fullName.optional() })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Change at least one field.' });
export type UpdateGuestRequest = z.infer<typeof updateGuestRequest>;

export const guestSearchQuery = z.object({
  search: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(25),
});
export type GuestSearchQuery = z.infer<typeof guestSearchQuery>;

export const duplicateCheckRequest = z
  .object({
    fullName: z.string().trim().max(200).optional(),
    phone: z.string().trim().max(40).optional(),
    email: z.string().trim().max(254).optional(),
    document: z
      .object({ documentType: z.enum(DOCUMENT_TYPES), number: z.string().trim().min(1).max(40) })
      .strict()
      .optional(),
    /** When editing, the guest itself is not a duplicate. */
    excludeGuestId: z.string().uuid().optional(),
  })
  .strict();
export type DuplicateCheckRequest = z.infer<typeof duplicateCheckRequest>;

export const revealRequest = z
  .object({ reason: z.string().trim().min(3, 'Give a reason for viewing the full number.').max(300) })
  .strict();
export type RevealRequest = z.infer<typeof revealRequest>;

// ---------------------------------------------------------------------------------------------------------------
// Responses. List results never contain identity-document data.
// ---------------------------------------------------------------------------------------------------------------

export const guestSummaryDto = z.object({
  id: z.string().uuid(),
  fullName: z.string(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  city: z.string().nullable(),
  nationality: z.string().nullable(),
});
export type GuestSummaryDto = z.infer<typeof guestSummaryDto>;

export const guestDocumentDto = z.object({
  id: z.string().uuid(),
  documentType: z.enum(DOCUMENT_TYPES),
  issuingCountry: z.string(),
  /** Last 4 characters only. The full number needs an audited reveal. */
  last4: z.string(),
  expiryDate: z.string().nullable(),
  createdAt: z.string().datetime(),
});
export type GuestDocumentDto = z.infer<typeof guestDocumentDto>;

export const guestDto = guestSummaryDto.extend({
  addressLine: z.string().nullable(),
  countryCode: z.string().nullable(),
  preferences: z.string().nullable(),
  notes: z.string().nullable(),
  marketingConsent: z.boolean(),
  createdAt: z.string().datetime(),
  documentCount: z.number().int(),
  /** Present only for callers with guest.identity.read; otherwise null and only the count is shown. */
  documents: z.array(guestDocumentDto).nullable(),
});
export type GuestDto = z.infer<typeof guestDto>;

export const DUPLICATE_REASONS = ['phone', 'email', 'document', 'name'] as const;
export const duplicateCandidateDto = guestSummaryDto.extend({
  reasons: z.array(z.enum(DUPLICATE_REASONS)),
});
export type DuplicateCandidateDto = z.infer<typeof duplicateCandidateDto>;

export const revealedDocumentDto = z.object({ id: z.string().uuid(), number: z.string() });
export type RevealedDocumentDto = z.infer<typeof revealedDocumentDto>;
