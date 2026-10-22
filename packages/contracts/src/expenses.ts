import { z } from 'zod';
import { uuid } from './common';
import { attachmentDto } from './attachments';
import { lineAmount } from './finance';
import { businessDate } from './reservations';

const positiveAmount = lineAmount.refine((v) => /[1-9]/.test(v), 'The amount must be more than zero.');
const optionalText = (max: number) => z.string().trim().max(max).optional();

// ------------------------------------------------------------------------------------------------ suppliers

export const createSupplierRequest = z
  .object({
    name: z.string().trim().min(1, 'Enter a name.').max(160),
    contact: optionalText(200),
    taxIdentifier: optionalText(40),
    /** Days after the bill date the payment is due; 0 = on receipt. */
    paymentTermsDays: z.coerce.number().int().min(0).max(365).default(0),
    notes: optionalText(500),
  })
  .strict();
export type CreateSupplierRequest = z.infer<typeof createSupplierRequest>;

export const updateSupplierRequest = z
  .object({
    name: z.string().trim().min(1, 'Enter a name.').max(160).optional(),
    contact: z.string().trim().max(200).nullable().optional(),
    taxIdentifier: z.string().trim().max(40).nullable().optional(),
    paymentTermsDays: z.coerce.number().int().min(0).max(365).optional(),
    notes: z.string().trim().max(500).nullable().optional(),
    active: z.boolean().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Change at least one field.' });
export type UpdateSupplierRequest = z.infer<typeof updateSupplierRequest>;

export const supplierDto = z.object({
  id: uuid,
  name: z.string(),
  contact: z.string().nullable(),
  taxIdentifier: z.string().nullable(),
  paymentTermsDays: z.number().int(),
  notes: z.string().nullable(),
  active: z.boolean(),
  /** What the hotel owes this supplier: its accounts payable lines in the ledger, credit minus debit. */
  owed: z.string(),
  /** Approved bills not yet fully paid. */
  openBills: z.number().int(),
});
export type SupplierDto = z.infer<typeof supplierDto>;

// ------------------------------------------------------------------------------------------------ expenses

export const EXPENSE_KINDS = ['cash', 'bill'] as const;
export type ExpenseKind = (typeof EXPENSE_KINDS)[number];

export const EXPENSE_STATUSES = ['draft', 'submitted', 'approved', 'partly_paid', 'paid', 'void'] as const;
export type ExpenseStatus = (typeof EXPENSE_STATUSES)[number];

/** An account an expense line can use: expense, cost of sales, or a non-system asset that is not cash. */
export const expenseAccountDto = z.object({ id: uuid, code: z.string(), name: z.string() });
export type ExpenseAccountDto = z.infer<typeof expenseAccountDto>;

export const expenseLineInput = z
  .object({
    /** An expense, cost of sales or (for purchases kept as assets) a non-system asset account. */
    accountId: uuid,
    description: optionalText(300),
    /** Before tax. */
    amount: positiveAmount,
    /** Purchase tax as charged on the bill (P4-7); nothing is assumed. */
    taxAmount: lineAmount.default('0'),
    /** Recoverable tax goes to Tax recoverable; otherwise it is part of the cost. The hotel's tax adviser decides. */
    taxRecoverable: z.boolean().default(false),
  })
  .strict();
export type ExpenseLineInput = z.infer<typeof expenseLineInput>;

export const expenseDraftRequest = z
  .object({
    /** cash: paid now from a cash or bank account; bill: a supplier bill to approve into payables and pay later. */
    kind: z.enum(EXPENSE_KINDS),
    supplierId: uuid.optional(),
    /** Who was paid, when there is no supplier record (petty cash). */
    payee: optionalText(160),
    expenseDate: businessDate,
    /** Bills only; defaults from the supplier's payment terms. */
    dueDate: businessDate.optional(),
    billReference: optionalText(80),
    description: z.string().trim().min(3, 'Describe the expense (at least 3 characters).').max(500),
    /** D12: where the paper receipt or bill is kept. */
    attachmentRef: optionalText(200),
    /** Cash expenses: the drawer or bank account it is paid from. */
    cashAccountId: uuid.optional(),
    lines: z.array(expenseLineInput).min(1, 'Add at least one line.').max(50),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.kind === 'bill' && !v.supplierId) {
      ctx.addIssue({ code: 'custom', path: ['supplierId'], message: 'Choose the supplier of this bill.' });
    }
    if (v.kind === 'cash' && v.dueDate) {
      ctx.addIssue({
        code: 'custom',
        path: ['dueDate'],
        message: 'A cash expense is paid now; it has no due date.',
      });
    }
    if (v.dueDate && v.dueDate < v.expenseDate) {
      ctx.addIssue({
        code: 'custom',
        path: ['dueDate'],
        message: 'The due date cannot be before the bill date.',
      });
    }
  });
export type ExpenseDraftRequest = z.infer<typeof expenseDraftRequest>;

/** Submitting a cash expense pays it from the cash account (which may be given here); a bill goes for approval. */
export const submitExpenseRequest = z.object({ cashAccountId: uuid.optional() }).strict();
export type SubmitExpenseRequest = z.infer<typeof submitExpenseRequest>;

export const payExpenseRequest = z
  .object({
    amount: positiveAmount,
    cashAccountId: uuid,
    reference: optionalText(80),
  })
  .strict();
export type PayExpenseRequest = z.infer<typeof payExpenseRequest>;

export const voidExpenseRequest = z
  .object({ reason: z.string().trim().min(3, 'Give a reason (at least 3 characters).').max(500) })
  .strict();
export type VoidExpenseRequest = z.infer<typeof voidExpenseRequest>;

export const EXPENSE_FILTERS = ['to_approve', 'unpaid', 'draft', 'paid', 'void', 'all'] as const;
export type ExpenseFilter = (typeof EXPENSE_FILTERS)[number];

export const expenseListQueryObject = z.object({
  status: z.enum(EXPENSE_FILTERS).default('all'),
  supplierId: uuid.optional(),
  from: businessDate.optional(),
  to: businessDate.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
export const expenseListQuery = expenseListQueryObject.refine((q) => !q.from || !q.to || q.from <= q.to, {
  path: ['to'],
  message: 'The end date must not be before the start date.',
});
export type ExpenseListQuery = z.infer<typeof expenseListQuery>;

export const expenseLineDto = z.object({
  id: uuid,
  lineNo: z.number().int(),
  accountId: uuid,
  accountCode: z.string(),
  accountName: z.string(),
  description: z.string().nullable(),
  amount: z.string(),
  taxAmount: z.string(),
  taxRecoverable: z.boolean(),
});
export type ExpenseLineDto = z.infer<typeof expenseLineDto>;

export const expensePaymentDto = z.object({
  id: uuid,
  amount: z.string(),
  cashAccountId: uuid,
  cashAccountName: z.string(),
  businessDate: z.string(),
  reference: z.string().nullable(),
  journalEntryId: uuid,
  journalNumber: z.number().int().nullable(),
  createdByName: z.string().nullable(),
  createdAt: z.string(),
});
export type ExpensePaymentDto = z.infer<typeof expensePaymentDto>;

export const expenseDto = z.object({
  id: uuid,
  voucherNumber: z.string(),
  kind: z.enum(EXPENSE_KINDS),
  status: z.enum(EXPENSE_STATUSES),
  supplierId: uuid.nullable(),
  supplierName: z.string().nullable(),
  payee: z.string().nullable(),
  expenseDate: z.string(),
  dueDate: z.string().nullable(),
  billReference: z.string().nullable(),
  description: z.string(),
  attachmentRef: z.string().nullable(),
  /** Receipts and bill scans (slice 6.2). */
  attachments: z.array(attachmentDto),
  cashAccountId: uuid.nullable(),
  cashAccountName: z.string().nullable(),
  netAmount: z.string(),
  taxAmount: z.string(),
  totalAmount: z.string(),
  paidAmount: z.string(),
  outstanding: z.string(),
  /** A bill waiting for approval, or a cash expense paid and not yet reviewed. */
  needsApproval: z.boolean(),
  journalEntryId: uuid.nullable(),
  journalNumber: z.number().int().nullable(),
  createdById: uuid,
  createdByName: z.string().nullable(),
  createdAt: z.string(),
  submittedByName: z.string().nullable(),
  submittedAt: z.string().nullable(),
  approvedByName: z.string().nullable(),
  approvedAt: z.string().nullable(),
  voidedByName: z.string().nullable(),
  voidedAt: z.string().nullable(),
  voidReason: z.string().nullable(),
  lines: z.array(expenseLineDto),
  payments: z.array(expensePaymentDto),
});
export type ExpenseDto = z.infer<typeof expenseDto>;
