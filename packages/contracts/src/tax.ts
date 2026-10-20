import { z } from 'zod';
import { uuid } from './common';
import { lineAmount } from './finance';
import { businessDate } from './reservations';

// ------------------------------------------------------------------------------------------------ tax codes

export const taxCodeCode = z
  .string()
  .trim()
  .transform((v) => v.toUpperCase())
  .pipe(z.string().regex(/^[A-Z0-9_-]{1,16}$/, 'Use up to 16 letters, digits, "-" or "_", e.g. PST.'));

/** A percentage as entered, e.g. "16" or "13.5". At most 4 decimal places, 0 to 100. Never a JS number. */
export const ratePercent = z
  .string()
  .trim()
  .regex(/^\d{1,3}(\.\d{1,4})?$/, 'Enter a percentage such as 16 or 13.5.')
  .refine((v) => /^(100(\.0+)?|\d{1,2}(\.\d+)?)$/.test(v), 'The rate must be between 0 and 100.');

export const taxRateInput = z
  .object({
    effectiveFrom: businessDate,
    ratePercent,
    /** Defaults to exclusive: tax is added on top of the amount (decision D6). */
    inclusive: z.boolean().default(false),
  })
  .strict();
export type TaxRateInput = z.infer<typeof taxRateInput>;

export const createTaxCodeRequest = z
  .object({
    code: taxCodeCode,
    name: z.string().trim().min(1, 'Enter a name.').max(80),
    jurisdiction: z.string().trim().max(80).optional(),
    /** Defaults to the system "Taxes payable" account. */
    payableAccountId: uuid.optional(),
    firstRate: taxRateInput,
  })
  .strict();
export type CreateTaxCodeRequest = z.infer<typeof createTaxCodeRequest>;

export const updateTaxCodeRequest = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    jurisdiction: z.string().trim().max(80).nullable().optional(),
    payableAccountId: uuid.optional(),
    active: z.boolean().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Change at least one field.' });
export type UpdateTaxCodeRequest = z.infer<typeof updateTaxCodeRequest>;

export const taxRateDto = z.object({
  id: uuid,
  effectiveFrom: z.string(),
  ratePercent: z.string(),
  inclusive: z.boolean(),
  createdAt: z.string(),
});
export type TaxRateDto = z.infer<typeof taxRateDto>;

export const taxCodeDto = z.object({
  id: uuid,
  code: z.string(),
  name: z.string(),
  jurisdiction: z.string().nullable(),
  payableAccountId: uuid,
  payableAccountCode: z.string(),
  payableAccountName: z.string(),
  active: z.boolean(),
  /** The rate in effect on the property's business date, if any. */
  currentRate: taxRateDto.nullable(),
  /** Newest first. */
  rates: z.array(taxRateDto),
});
export type TaxCodeDto = z.infer<typeof taxCodeDto>;

// ------------------------------------------------------------------------------------------------ charge categories

export const chargeCategoryCode = z
  .string()
  .trim()
  .transform((v) => v.toLowerCase())
  .pipe(z.string().regex(/^[a-z0-9_]{2,24}$/, 'Use 2 to 24 lowercase letters, digits or "_", e.g. minibar.'));

export const createChargeCategoryRequest = z
  .object({
    code: chargeCategoryCode,
    name: z.string().trim().min(1, 'Enter a name.').max(80),
    revenueAccountId: uuid,
    taxCodeIds: z.array(uuid).max(5).default([]),
  })
  .strict();
export type CreateChargeCategoryRequest = z.infer<typeof createChargeCategoryRequest>;

export const updateChargeCategoryRequest = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    revenueAccountId: uuid.optional(),
    taxCodeIds: z.array(uuid).max(5).optional(),
    active: z.boolean().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Change at least one field.' });
export type UpdateChargeCategoryRequest = z.infer<typeof updateChargeCategoryRequest>;

export const chargeCategoryDto = z.object({
  id: uuid,
  code: z.string(),
  name: z.string(),
  revenueAccountId: uuid,
  revenueAccountCode: z.string(),
  revenueAccountName: z.string(),
  /** "room": used for room nights at check-out; always active. */
  systemKind: z.enum(['room']).nullable(),
  active: z.boolean(),
  taxCodeIds: z.array(uuid),
});
export type ChargeCategoryDto = z.infer<typeof chargeCategoryDto>;

// ------------------------------------------------------------------------------------------------ preview

export const taxPreviewRequest = z
  .object({
    categoryId: uuid,
    /** For inclusive taxes this is the gross amount; for exclusive ones, the net. */
    amount: lineAmount,
    /** The rate in effect on this date is used. Defaults to the business date. */
    serviceDate: businessDate.optional(),
  })
  .strict();
export type TaxPreviewRequest = z.infer<typeof taxPreviewRequest>;

export const taxLineDto = z.object({
  taxCodeId: uuid,
  code: z.string(),
  name: z.string(),
  ratePercent: z.string(),
  inclusive: z.boolean(),
  base: z.string(),
  amount: z.string(),
});
export type TaxLineDto = z.infer<typeof taxLineDto>;

export const taxPreviewDto = z.object({
  serviceDate: z.string(),
  amount: z.string(),
  net: z.string(),
  taxTotal: z.string(),
  gross: z.string(),
  lines: z.array(taxLineDto),
  /** Codes on the category that have no rate in effect on the date (charged at zero). */
  notInEffect: z.array(z.string()),
});
export type TaxPreviewDto = z.infer<typeof taxPreviewDto>;

// ------------------------------------------------------------------------------------------------ invoice profile

export const registrationField = z
  .object({
    label: z.string().trim().min(1, 'Enter a label, e.g. NTN.').max(40),
    value: z.string().trim().min(1, 'Enter the value.').max(80),
  })
  .strict();

const prefix = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9/_-]{0,12}$/, 'Use up to 12 letters, digits, "/", "-" or "_".');

export const invoiceProfileRequest = z
  .object({
    legalName: z.string().trim().max(160).nullable(),
    address: z.string().trim().max(500).nullable(),
    registrationFields: z.array(registrationField).max(6),
    invoicePrefix: prefix,
    receiptPrefix: prefix,
    footer: z.string().trim().max(1000).nullable(),
  })
  .strict();
export type InvoiceProfileRequest = z.infer<typeof invoiceProfileRequest>;

export const invoiceProfileDto = invoiceProfileRequest.extend({
  updatedAt: z.string(),
  updatedByName: z.string().nullable(),
});
export type InvoiceProfileDto = z.infer<typeof invoiceProfileDto>;
