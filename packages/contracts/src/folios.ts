import { z } from 'zod';
import { uuid } from './common';
import { lineAmount } from './finance';
import { businessDate } from './reservations';

const positiveAmount = lineAmount.refine((v) => /[1-9]/.test(v), 'The amount must be more than zero.');

/** Quantity as entered: up to 2 decimal places (e.g. 1.5 hours), more than zero. A string, never a JS number. */
export const quantity = z
  .string()
  .trim()
  .regex(/^\d{1,7}(\.\d{1,2})?$/, 'Enter a quantity such as 1 or 2.5.')
  .refine((v) => /[1-9]/.test(v), 'The quantity must be more than zero.');

export const postChargeRequest = z
  .object({
    categoryId: uuid,
    description: z.string().trim().min(1, 'Describe the charge.').max(200),
    /** Defaults to the business date; never later than it. */
    serviceDate: businessDate.optional(),
    quantity: quantity.default('1'),
    /** Price per unit as entered. For inclusive taxes this includes tax. */
    unitPrice: positiveAmount,
  })
  .strict();
export type PostChargeRequest = z.infer<typeof postChargeRequest>;

/** A discount or correction: reduces the folio, with tax reversed by the same rules. Needs `folio.adjust`. */
export const postAllowanceRequest = z
  .object({
    categoryId: uuid,
    description: z.string().trim().min(1, 'Describe the allowance.').max(200),
    serviceDate: businessDate.optional(),
    /** The amount to take off, as a positive number (as entered: tax-inclusive if the taxes are inclusive). */
    amount: positiveAmount,
    reason: z.string().trim().min(3, 'Give a reason (at least 3 characters).').max(500),
  })
  .strict();
export type PostAllowanceRequest = z.infer<typeof postAllowanceRequest>;

export const voidChargeRequest = z
  .object({ reason: z.string().trim().min(3, 'Give a reason (at least 3 characters).').max(500) })
  .strict();
export type VoidChargeRequest = z.infer<typeof voidChargeRequest>;

export const transferChargeRequest = z
  .object({
    toFolioId: uuid,
    reason: z.string().trim().min(3, 'Give a reason (at least 3 characters).').max(500),
  })
  .strict();
export type TransferChargeRequest = z.infer<typeof transferChargeRequest>;

export const createFolioRequest = z
  .object({ label: z.string().trim().min(1, 'Name the folio, e.g. Company.').max(40) })
  .strict();
export type CreateFolioRequest = z.infer<typeof createFolioRequest>;

export const FOLIO_STATUSES = ['open', 'settled', 'on_account'] as const;
export const CHARGE_KINDS = ['charge', 'allowance', 'room_night'] as const;
export const CHARGE_STATUSES = ['posted', 'voided', 'transferred'] as const;

export const chargeTaxDto = z.object({
  code: z.string(),
  name: z.string(),
  ratePercent: z.string(),
  inclusive: z.boolean(),
  amount: z.string(),
});

const folioRef = z.object({
  chargeId: uuid,
  folioId: uuid,
  folioLabel: z.string(),
  bookingReference: z.string(),
});

export const folioChargeDto = z.object({
  id: uuid,
  kind: z.enum(CHARGE_KINDS),
  categoryId: uuid,
  categoryName: z.string(),
  description: z.string(),
  serviceDate: z.string(),
  quantity: z.string(),
  unitPrice: z.string(),
  /** Signed: allowances are negative. */
  net: z.string(),
  tax: z.string(),
  gross: z.string(),
  status: z.enum(CHARGE_STATUSES),
  reason: z.string().nullable(),
  taxes: z.array(chargeTaxDto),
  journalEntryId: uuid,
  journalNumber: z.number().int().nullable(),
  transferredFrom: folioRef.nullable(),
  transferredTo: folioRef.nullable(),
  voidReason: z.string().nullable(),
  voidedAt: z.string().nullable(),
  voidedByName: z.string().nullable(),
  createdByName: z.string().nullable(),
  createdAt: z.string(),
});
export type FolioChargeDto = z.infer<typeof folioChargeDto>;

/** A night stayed but not yet posted (decision D7): posted at check-out with the tax in effect on that night. */
export const pendingNightDto = z.object({
  date: z.string(),
  roomNumber: z.string().nullable(),
  rate: z.string(),
  net: z.string(),
  tax: z.string(),
  gross: z.string(),
});

const amounts = { net: z.string(), tax: z.string(), gross: z.string() };

export const folioPaymentDto = z.object({
  id: uuid,
  receiptNumber: z.string(),
  kind: z.enum(['deposit', 'payment']),
  method: z.enum(['cash', 'bank_transfer', 'card', 'other']),
  amount: z.string(),
  refunded: z.string(),
  applied: z.string(),
  refundable: z.string(),
  businessDate: z.string(),
});
export type FolioPaymentDto = z.infer<typeof folioPaymentDto>;

export const folioDto = z.object({
  id: uuid,
  reservationId: uuid,
  bookingReference: z.string(),
  guestId: uuid,
  guestName: z.string(),
  label: z.string(),
  isPrimary: z.boolean(),
  status: z.enum(FOLIO_STATUSES),
  currencyCode: z.string(),
  charges: z.array(folioChargeDto),
  payments: z.array(folioPaymentDto),
  /** Posted items only (voided and transferred-out items excluded). */
  posted: z.object(amounts),
  /** Money received on this folio (deposits and payments) and refunded from it. */
  received: z.string(),
  refunded: z.string(),
  /** Deposits not yet applied to the bill: still a liability in the ledger. */
  depositHeld: z.string(),
  /** Positive: the guest owes; negative: the guest is in credit. Charges − allowances − received + refunded. */
  balance: z.string(),
  /** Primary folio only: nights stayed so far, not yet posted. */
  pendingNights: z.array(pendingNightDto),
  pending: z.object(amounts),
  /** The balance if the guest checked out today. */
  balanceWithPending: z.string(),
  /** Primary folio only: all booked nights to departure, as an estimate at today's tax rates. */
  stayEstimate: z.object({ nights: z.number().int(), ...amounts }),
});
export type FolioDto = z.infer<typeof folioDto>;

export const openFolioDto = z.object({
  id: uuid,
  label: z.string(),
  isPrimary: z.boolean(),
  reservationId: uuid,
  bookingReference: z.string(),
  guestName: z.string(),
  roomNumber: z.string().nullable(),
  balance: z.string(),
});
export type OpenFolioDto = z.infer<typeof openFolioDto>;
