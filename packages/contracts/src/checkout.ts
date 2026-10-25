import { z } from 'zod';
import { uuid } from './common';
import { externalReference, paymentMethod } from './payments';

/**
 * How a folio that is not at zero is closed at check-out (FIN-008):
 *  - pay: take the balance now (method required);
 *  - refund: give the guest's credit back (needs payment.refund);
 *  - write_off: write the balance off as an expense (needs folio.adjust, reason);
 *  - on_account: leave it owed on the guest's account; the folio can still take payments (needs folio.adjust, reason).
 */
export const SETTLEMENT_ACTIONS = ['pay', 'refund', 'write_off', 'on_account'] as const;
export type SettlementAction = (typeof SETTLEMENT_ACTIONS)[number];

export const folioSettlement = z
  .object({
    folioId: uuid,
    action: z.enum(SETTLEMENT_ACTIONS),
    method: paymentMethod.optional(),
    cashAccountId: uuid.optional(),
    externalReference: externalReference.optional(),
    reason: z.string().trim().min(3, 'Give a reason (at least 3 characters).').max(500).optional(),
  })
  .strict()
  .superRefine((s, ctx) => {
    if ((s.action === 'pay' || s.action === 'refund') && !s.method) {
      ctx.addIssue({ code: 'custom', path: ['method'], message: 'Choose how the money is paid.' });
    }
    if ((s.action === 'write_off' || s.action === 'on_account') && !s.reason) {
      ctx.addIssue({ code: 'custom', path: ['reason'], message: 'Give a reason.' });
    }
  });
export type FolioSettlement = z.infer<typeof folioSettlement>;

export const checkOutRequest = z
  .object({ settlements: z.array(folioSettlement).max(10).default([]) })
  .strict();
export type CheckOutRequest = z.infer<typeof checkOutRequest>;

const amounts = { net: z.string(), tax: z.string(), gross: z.string() };

export const checkoutPreviewDto = z.object({
  stayId: uuid,
  reservationId: uuid,
  bookingReference: z.string(),
  guestName: z.string(),
  roomNumber: z.string(),
  businessDate: z.string(),
  /** The last guest of the booking to leave: folios must be settled now. */
  isLastStay: z.boolean(),
  /** Room nights this check-out will post (D7), each with the tax of its own date. */
  nights: z.array(z.object({ date: z.string(), roomNumber: z.string().nullable(), ...amounts })),
  nightsTotal: z.object(amounts),
  folios: z.array(
    z.object({
      folioId: uuid,
      label: z.string(),
      isPrimary: z.boolean(),
      /** Before this check-out's room nights and deposit application. */
      currentBalance: z.string(),
      nightsToPost: z.string(),
      depositToApply: z.string(),
      /** What will be left to settle: positive = to pay, negative = credit to refund. */
      balanceAfter: z.string(),
      needs: z.enum(['none', 'payment', 'refund']),
    }),
  ),
});
export type CheckoutPreviewDto = z.infer<typeof checkoutPreviewDto>;

export const invoiceSummaryDto = z.object({
  id: uuid,
  invoiceNumber: z.string(),
  folioId: uuid,
  issueDate: z.string(),
  gross: z.string(),
  balanceDue: z.string(),
});
export type InvoiceSummaryDto = z.infer<typeof invoiceSummaryDto>;

export const checkOutResultDto = z.object({
  stayId: uuid,
  reservationId: uuid,
  reservationStatus: z.string(),
  nightsPosted: z.number().int(),
  invoices: z.array(invoiceSummaryDto),
  folios: z.array(z.object({ folioId: uuid, status: z.enum(['open', 'settled', 'on_account']) })),
});
export type CheckOutResultDto = z.infer<typeof checkOutResultDto>;

export const invoiceDto = z.object({
  id: uuid,
  invoiceNumber: z.string(),
  issueDate: z.string(),
  currencyCode: z.string(),
  billTo: z.string(),
  bookingReference: z.string(),
  folioId: uuid,
  folioLabel: z.string(),
  reservationId: uuid,
  net: z.string(),
  tax: z.string(),
  gross: z.string(),
  paid: z.string(),
  writtenOff: z.string(),
  balanceDue: z.string(),
  taxSummary: z.array(
    z.object({
      code: z.string(),
      name: z.string(),
      ratePercent: z.string(),
      inclusive: z.boolean(),
      base: z.string(),
      amount: z.string(),
    }),
  ),
  lines: z.array(
    z.object({
      lineNo: z.number().int(),
      kind: z.string(),
      description: z.string(),
      serviceDate: z.string(),
      quantity: z.string(),
      unitPrice: z.string(),
      net: z.string(),
      tax: z.string(),
      gross: z.string(),
    }),
  ),
  hotel: z.object({
    name: z.string(),
    legalName: z.string().nullable(),
    address: z.string().nullable(),
    registrationFields: z.array(z.object({ label: z.string(), value: z.string() })),
    footer: z.string().nullable(),
  }),
  createdByName: z.string().nullable(),
  createdAt: z.string(),
});
export type InvoiceDto = z.infer<typeof invoiceDto>;
