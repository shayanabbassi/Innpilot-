import { z } from 'zod';
import { uuid } from './common';
import { lineAmount } from './finance';
import { businessDate } from './reservations';

export const PAYMENT_METHODS = ['cash', 'bank_transfer', 'card', 'other'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
export const paymentMethod = z.enum(PAYMENT_METHODS);

const positiveAmount = lineAmount.refine((v) => /[1-9]/.test(v), 'The amount must be more than zero.');

/**
 * A card terminal approval code or bank reference. Card numbers must never be entered: anything that looks like one
 * (13 to 19 digits, spaces and dashes ignored) is refused.
 */
export const externalReference = z
  .string()
  .trim()
  .max(60)
  .refine(
    (v) => !/\d{13,19}/.test(v.replace(/[\s-]/g, '')),
    'Do not enter card numbers. Use the terminal reference.',
  );

export const recordPaymentRequest = z
  .object({
    /** The folio to pay. Before check-in, send `reservationId` instead: the main folio is opened for the deposit. */
    folioId: uuid.optional(),
    reservationId: uuid.optional(),
    amount: positiveAmount,
    method: paymentMethod,
    /** Defaults to the property's account for the method (cash drawer, bank, card terminal). */
    cashAccountId: uuid.optional(),
    externalReference: externalReference.optional(),
    notes: z.string().trim().max(300).optional(),
  })
  .strict()
  .refine((v) => !v.folioId !== !v.reservationId, {
    path: ['folioId'],
    message: 'Choose the folio, or the booking for a deposit.',
  });
export type RecordPaymentRequest = z.infer<typeof recordPaymentRequest>;

export const refundRequest = z
  .object({
    amount: positiveAmount,
    /** Defaults to the method of the original payment. */
    method: paymentMethod.optional(),
    cashAccountId: uuid.optional(),
    externalReference: externalReference.optional(),
    reason: z.string().trim().min(3, 'Give a reason (at least 3 characters).').max(500),
  })
  .strict();
export type RefundRequest = z.infer<typeof refundRequest>;

export const refundDto = z.object({
  id: uuid,
  refundNumber: z.string(),
  amount: z.string(),
  method: paymentMethod,
  cashAccountName: z.string(),
  externalReference: z.string().nullable(),
  reason: z.string(),
  businessDate: z.string(),
  createdAt: z.string(),
  createdByName: z.string().nullable(),
  journalEntryId: uuid,
});
export type RefundDto = z.infer<typeof refundDto>;

export const paymentDto = z.object({
  id: uuid,
  receiptNumber: z.string(),
  /** deposit: received before check-in, held as a liability until applied to the bill. */
  kind: z.enum(['deposit', 'payment']),
  method: paymentMethod,
  cashAccountId: uuid,
  cashAccountName: z.string(),
  amount: z.string(),
  refunded: z.string(),
  /** Deposit already applied to the bill (or kept as a fee). */
  applied: z.string(),
  /** What can still be refunded: amount − refunded − applied. */
  refundable: z.string(),
  currencyCode: z.string(),
  businessDate: z.string(),
  receivedAt: z.string(),
  externalReference: z.string().nullable(),
  notes: z.string().nullable(),
  folioId: uuid,
  folioLabel: z.string(),
  reservationId: uuid,
  bookingReference: z.string(),
  guestName: z.string(),
  createdByName: z.string().nullable(),
  journalEntryId: uuid,
  journalNumber: z.number().int().nullable(),
  refunds: z.array(refundDto),
});
export type PaymentDto = z.infer<typeof paymentDto>;

export const paymentListQueryObject = z.object({
  from: businessDate.optional(),
  to: businessDate.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
export const paymentListQuery = paymentListQueryObject.refine((q) => !q.from || !q.to || q.from <= q.to, {
  path: ['to'],
  message: 'The end date must not be before the start date.',
});
export type PaymentListQuery = z.infer<typeof paymentListQuery>;

export const cashAccountDto = z.object({
  id: uuid,
  name: z.string(),
  kind: z.enum(['cash', 'bank', 'card_clearing', 'other']),
  ledgerAccountCode: z.string(),
  active: z.boolean(),
});
export type CashAccountDto = z.infer<typeof cashAccountDto>;

/** A receipt as printed: the payment plus what the invoice profile says about the hotel. */
export const receiptDto = z.object({
  payment: paymentDto,
  hotel: z.object({
    name: z.string(),
    legalName: z.string().nullable(),
    address: z.string().nullable(),
    registrationFields: z.array(z.object({ label: z.string(), value: z.string() })),
    footer: z.string().nullable(),
  }),
});
export type ReceiptDto = z.infer<typeof receiptDto>;

/** On cancel or no-show of a booking holding a deposit: refund it (later) or keep it as a fee (folio.adjust). */
export const depositHandling = z.enum(['refund', 'forfeit']);
export type DepositHandling = z.infer<typeof depositHandling>;
