/**
 * Phase 4 slice 4.3 — suppliers, expenses and payables. A cash expense posts Dr expense / Cr cash in one step; a
 * bill posts to payables on approval and payments clear it; partial payments never exceed the bill; the creator
 * cannot approve; recoverable tax goes to 1300; edits are refused once submitted; paying is idempotent; voids
 * reverse what was posted; supplier balances agree with the ledger; roles and isolation.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { browser, ORIGIN, startHarness, type BrowserClient, type Harness } from './harness';

let h: Harness;
let acc: BrowserClient;
let manager: BrowserClient;
let cashier: BrowserClient;
let base: string;
const cash: Record<string, string> = {};
const account: Record<string, string> = {};
let supplierId: string;

const withKey = (c: BrowserClient, path: string, body: object = {}, key: string = randomUUID()) =>
  c.agent
    .post(`/api/v1${path}`)
    .set('origin', ORIGIN)
    .set('x-csrf-token', c.csrf)
    .set('idempotency-key', key)
    .send(body);

async function linesOf(journalId: string) {
  const { rows } = await h.admin.query<{
    code: string;
    debit: string;
    credit: string;
    supplier: string | null;
  }>(
    `SELECT a.code, l.debit::numeric(19,2)::text AS debit, l.credit::numeric(19,2)::text AS credit,
            s.name AS supplier
     FROM journal_lines l JOIN accounts a ON a.id = l.account_id LEFT JOIN suppliers s ON s.id = l.supplier_id
     WHERE l.journal_entry_id = $1 ORDER BY l.line_no`,
    [journalId],
  );
  return rows;
}
async function ledgerBalance(code: string): Promise<string> {
  const { rows } = await h.admin.query<{ b: string }>(
    `SELECT coalesce(sum(l.debit - l.credit), 0)::numeric(19,2)::text AS b
     FROM journal_lines l JOIN journal_entries e ON e.id = l.journal_entry_id JOIN accounts a ON a.id = l.account_id
     WHERE a.tenant_id = $1 AND a.code = $2 AND e.status <> 'draft'`,
    [h.fx.tenantA, code],
  );
  return rows[0]!.b;
}
const drawer = async () =>
  (await acc.get(`${base}/cash-accounts`)).body.data.find(
    (c: { name: string }) => c.name === 'Front desk cash',
  ).balance as string;

beforeAll(async () => {
  h = await startHarness();
  acc = await browser(h).loginActive(h.fx.users.accountantA);
  manager = await browser(h).loginActive(h.fx.users.managerA);
  cashier = await browser(h).loginActive(h.fx.users.cashierA);
  base = `/properties/${h.fx.propA1}`;
  for (const a of (await acc.get('/finance/accounts')).body.data) account[a.code] = a.id;
  for (const c of (await acc.get(`${base}/cash-accounts`)).body.data) cash[c.name] = c.id;
  const ob = await withKey(acc, `${base}/opening-balances`, {
    asOf: '2026-10-18',
    lines: [
      { accountId: account['1000'], debit: '20000' },
      { accountId: account['1100'], debit: '100000' },
      { accountId: account['3000'], credit: '120000' },
    ],
  });
  if (ob.status !== 201) throw new Error(JSON.stringify(ob.body));
});

afterAll(async () => {
  await h?.close();
});

describe('suppliers', () => {
  it('are added by people with supplier.manage, listed for expense staff, unique by name', async () => {
    expect((await cashier.post('/suppliers', { name: 'Not allowed' })).status).toBe(403);
    const res = await acc.post('/suppliers', {
      name: 'Fresh Foods',
      contact: '0300 0000000',
      taxIdentifier: 'NTN-0000000',
      paymentTermsDays: 15,
    });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      name: 'Fresh Foods',
      owed: '0.00',
      openBills: 0,
      paymentTermsDays: 15,
    });
    supplierId = res.body.data.id;
    expect((await acc.post('/suppliers', { name: ' fresh foods ' })).status).toBe(400);
    const list = await cashier.get('/suppliers');
    expect(list.status).toBe(200);
    expect(list.body.data.map((s: { name: string }) => s.name)).toEqual(['Fresh Foods']);
    // Tax identifiers stay out of the audit log.
    const { rows } = await h.admin.query<{ c: string }>(
      `SELECT changes::text AS c FROM audit_events WHERE entity_id = $1`,
      [supplierId],
    );
    expect(rows.every((r) => !r.c.includes('NTN-0000000'))).toBe(true);
  });
});

describe('cash expense (petty cash)', () => {
  let id: string;

  const body = (amount: string) => ({
    kind: 'cash',
    payee: 'Hardware shop',
    expenseDate: '2026-10-19',
    description: 'Mop and buckets',
    attachmentRef: 'Petty cash file, slip 12',
    cashAccountId: cash['Front desk cash'],
    lines: [{ accountId: account['6200'], amount }],
  });

  it('offers the cashier only accounts an expense can use', async () => {
    const res = await cashier.get(`${base}/expenses/accounts`);
    expect(res.status).toBe(200);
    const codes = res.body.data.map((a: { code: string }) => a.code);
    expect(codes).toEqual(expect.arrayContaining(['5000', '6200', '6900', '1500']));
    expect(codes).not.toEqual(expect.arrayContaining(['1000']));
    expect(codes.some((c: string) => c.startsWith('4') || c === '1200' || c === '2000')).toBe(false);
  });

  it('refuses accounts that cannot take an expense', async () => {
    const revenue = await withKey(cashier, `${base}/expenses`, {
      ...body('100'),
      lines: [{ accountId: account['4000'], amount: '100' }],
    });
    expect(revenue.status).toBe(400);
    expect(revenue.body.error.details[0].path).toBe('lines.0.accountId');
    const cashLedger = await withKey(cashier, `${base}/expenses`, {
      ...body('100'),
      lines: [{ accountId: account['1000'], amount: '100' }],
    });
    expect(cashLedger.status).toBe(400);
  });

  it('is drafted, edited, then paid from the drawer in one balanced step', async () => {
    const draft = await withKey(cashier, `${base}/expenses`, body('1500'));
    expect(draft.status).toBe(201);
    expect(draft.body.data).toMatchObject({
      voucherNumber: 'EXP-000001',
      status: 'draft',
      totalAmount: '1500.00',
    });
    id = draft.body.data.id;
    const edited = await cashier.put(`${base}/expenses/${id}`, body('1600'));
    expect(edited.status).toBe(200);
    expect(edited.body.data.totalAmount).toBe('1600.00');

    const paid = await withKey(cashier, `${base}/expenses/${id}/submit`);
    expect(paid.status).toBe(200);
    expect(paid.body.data).toMatchObject({
      status: 'paid',
      paidAmount: '1600.00',
      outstanding: '0.00',
      needsApproval: true,
      cashAccountName: 'Front desk cash',
    });
    expect(await linesOf(paid.body.data.journalEntryId)).toEqual([
      { code: '6200', debit: '1600.00', credit: '0.00', supplier: null },
      { code: '1000', debit: '0.00', credit: '1600.00', supplier: null },
    ]);
    expect(await drawer()).toBe('18400.00');
    expect((await cashier.put(`${base}/expenses/${id}`, body('1700'))).status).toBe(409);
  });

  it('never pays out more than the drawer holds', async () => {
    const big = await withKey(cashier, `${base}/expenses`, body('30000'));
    const res = await withKey(cashier, `${base}/expenses/${big.body.data.id}/submit`);
    expect(res.status).toBe(409);
    expect((await cashier.get(`${base}/expenses/${big.body.data.id}`)).body.data.status).toBe('draft');
  });

  it('is reviewed by someone else', async () => {
    expect((await withKey(cashier, `${base}/expenses/${id}/approve`)).status).toBe(403);
    const res = await withKey(manager, `${base}/expenses/${id}/approve`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ needsApproval: false, approvedByName: 'manager@a.test' });
    expect((await withKey(manager, `${base}/expenses/${id}/approve`)).status).toBe(409);
  });
});

describe('supplier bill to payment', () => {
  let id: string;

  it('waits for approval, never by its creator, and recoverable tax goes to 1300', async () => {
    const draft = await withKey(acc, `${base}/expenses`, {
      kind: 'bill',
      supplierId,
      expenseDate: '2026-10-19',
      billReference: 'FF-2231',
      description: 'Kitchen supplies for October',
      lines: [
        { accountId: account['5000'], amount: '10000', taxAmount: '1800', taxRecoverable: true },
        { accountId: account['6400'], amount: '2000', taxAmount: '360' },
      ],
    });
    expect(draft.status).toBe(201);
    expect(draft.body.data).toMatchObject({
      dueDate: '2026-11-03',
      totalAmount: '14160.00',
      taxAmount: '2160.00',
    });
    id = draft.body.data.id;
    const submitted = await withKey(acc, `${base}/expenses/${id}/submit`);
    expect(submitted.body.data).toMatchObject({
      status: 'submitted',
      journalEntryId: null,
      needsApproval: true,
    });

    const self = await withKey(acc, `${base}/expenses/${id}/approve`);
    expect(self.status).toBe(403);
    const approved = await withKey(manager, `${base}/expenses/${id}/approve`);
    expect(approved.status).toBe(200);
    expect(approved.body.data).toMatchObject({ status: 'approved', outstanding: '14160.00' });
    expect(await linesOf(approved.body.data.journalEntryId)).toEqual([
      { code: '5000', debit: '10000.00', credit: '0.00', supplier: null },
      { code: '6400', debit: '2360.00', credit: '0.00', supplier: null },
      { code: '1300', debit: '1800.00', credit: '0.00', supplier: null },
      { code: '2000', debit: '0.00', credit: '14160.00', supplier: 'Fresh Foods' },
    ]);
    const supplier = (await acc.get('/suppliers')).body.data[0];
    expect(supplier).toMatchObject({ owed: '14160.00', openBills: 1 });
  });

  it('is paid in parts, never more than owed, once per key', async () => {
    expect(
      (await withKey(cashier, `${base}/expenses/${id}/pay`, { amount: '1', cashAccountId: cash['Bank'] }))
        .status,
    ).toBe(403);
    const part = await withKey(manager, `${base}/expenses/${id}/pay`, {
      amount: '5000',
      cashAccountId: cash['Bank'],
      reference: 'Cheque 1001',
    });
    expect(part.status).toBe(201);
    expect(part.body.data).toMatchObject({
      status: 'partly_paid',
      paidAmount: '5000.00',
      outstanding: '9160.00',
    });
    expect(await linesOf(part.body.data.payments[0].journalEntryId)).toEqual([
      { code: '2000', debit: '5000.00', credit: '0.00', supplier: 'Fresh Foods' },
      { code: '1100', debit: '0.00', credit: '5000.00', supplier: null },
    ]);
    const over = await withKey(manager, `${base}/expenses/${id}/pay`, {
      amount: '9160.01',
      cashAccountId: cash['Bank'],
    });
    expect(over.status).toBe(422);
    expect(over.body.error.code).toBe('PAYMENT_EXCEEDS_BALANCE');

    const key = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        withKey(manager, `${base}/expenses/${id}/pay`, { amount: '9160', cashAccountId: cash['Bank'] }, key),
      ),
    );
    expect(results.filter((r) => r.status === 201).length).toBeGreaterThanOrEqual(1);
    expect(results.every((r) => r.status === 201 || r.status === 409)).toBe(true);
    const final = (await acc.get(`${base}/expenses/${id}`)).body.data;
    expect(final).toMatchObject({ status: 'paid', outstanding: '0.00' });
    expect(final.payments).toHaveLength(2);
    expect((await acc.get('/suppliers')).body.data[0]).toMatchObject({ owed: '0.00', openBills: 0 });
    // Accounts payable agrees with the suppliers.
    expect(await ledgerBalance('2000')).toBe('0.00');
    expect(await ledgerBalance('1300')).toBe('1800.00');
  });

  it('cannot be voided once paid', async () => {
    expect((await withKey(manager, `${base}/expenses/${id}/void`, { reason: 'Mistake' })).status).toBe(409);
  });
});

describe('voids and corrections', () => {
  it('voids a draft with a reason; a posted expense is reversed by an approver only', async () => {
    const draft = await withKey(cashier, `${base}/expenses`, {
      kind: 'cash',
      expenseDate: '2026-10-19',
      description: 'Taxi for supplies',
      cashAccountId: cash['Front desk cash'],
      lines: [{ accountId: account['6900'], amount: '400' }],
    });
    expect((await withKey(cashier, `${base}/expenses/${draft.body.data.id}/void`, {})).status).toBe(400);
    const voided = await withKey(cashier, `${base}/expenses/${draft.body.data.id}/void`, {
      reason: 'Not needed',
    });
    expect(voided.body.data).toMatchObject({ status: 'void', voidReason: 'Not needed', outstanding: '0.00' });

    const again = await withKey(cashier, `${base}/expenses`, {
      kind: 'cash',
      expenseDate: '2026-10-19',
      description: 'Taxi for supplies',
      cashAccountId: cash['Front desk cash'],
      lines: [{ accountId: account['6900'], amount: '400' }],
    });
    const paid = await withKey(cashier, `${base}/expenses/${again.body.data.id}/submit`);
    expect(await drawer()).toBe('18000.00');
    expect(
      (await withKey(cashier, `${base}/expenses/${again.body.data.id}/void`, { reason: 'Wrong' })).status,
    ).toBe(403);
    const reversed = await withKey(manager, `${base}/expenses/${again.body.data.id}/void`, {
      reason: 'Taxi was paid by the supplier',
    });
    expect(reversed.status).toBe(200);
    const { rows } = await h.admin.query<{ status: string }>(
      `SELECT status FROM journal_entries WHERE id = $1`,
      [paid.body.data.journalEntryId],
    );
    expect(rows[0]!.status).toBe('reversed');
    expect(await drawer()).toBe('18400.00');
  });

  it('reverses an approved, unpaid bill on void', async () => {
    const bill = await withKey(acc, `${base}/expenses`, {
      kind: 'bill',
      supplierId,
      expenseDate: '2026-10-19',
      description: 'Duplicate bill',
      lines: [{ accountId: account['5000'], amount: '700' }],
    });
    await withKey(acc, `${base}/expenses/${bill.body.data.id}/submit`);
    await withKey(manager, `${base}/expenses/${bill.body.data.id}/approve`);
    expect((await acc.get('/suppliers')).body.data[0].owed).toBe('700.00');
    const res = await withKey(acc, `${base}/expenses/${bill.body.data.id}/void`, { reason: 'Entered twice' });
    expect(res.status).toBe(200);
    expect((await acc.get('/suppliers')).body.data[0]).toMatchObject({ owed: '0.00', openBills: 0 });
  });

  it('needs the supplier on any manual accounts payable line', async () => {
    const draft = await withKey(acc, '/finance/journal-entries/draft', {
      propertyId: h.fx.propA1,
      narration: 'Opening supplier balance',
      lines: [
        { accountId: account['5000'], debit: '100' },
        { accountId: account['2000'], credit: '100' },
      ],
    });
    const post = await withKey(acc, `/finance/journal-entries/${draft.body.data.id}/post`);
    expect(post.status).toBe(400);
    expect(post.body.error.details[0].path).toBe('lines.1.supplierId');
    const fixed = await acc.put(`/finance/journal-entries/${draft.body.data.id}`, {
      propertyId: h.fx.propA1,
      narration: 'Opening supplier balance',
      lines: [
        { accountId: account['5000'], debit: '100' },
        { accountId: account['2000'], credit: '100', supplierId },
      ],
    });
    expect(fixed.body.data.lines[1].supplierName).toBe('Fresh Foods');
    expect((await withKey(acc, `/finance/journal-entries/${draft.body.data.id}/post`)).status).toBe(200);
    expect((await acc.get('/suppliers')).body.data[0].owed).toBe('100.00');
    expect((await acc.get('/finance/trial-balance?from=2026-10-01&to=2026-10-31')).body.data.balanced).toBe(
      true,
    );
  });
});

describe('visibility, audit and isolation', () => {
  it('shows a cashier only their own expenses, approvers everything', async () => {
    const mine = (await cashier.get(`${base}/expenses`)).body.data;
    expect(mine.every((e: { createdByName: string }) => e.createdByName === 'cashier@a.test')).toBe(true);
    const all = (await manager.get(`${base}/expenses`)).body.data;
    expect(all.length).toBeGreaterThan(mine.length);
    const accBill = all.find((e: { createdByName: string }) => e.createdByName === 'accountant@a.test');
    expect((await cashier.get(`${base}/expenses/${accBill.id}`)).status).toBe(404);
    const toApprove = (await manager.get(`${base}/expenses?status=to_approve`)).body.data;
    expect(toApprove).toHaveLength(0);
    const desk = await browser(h).loginActive(h.fx.users.deskA);
    expect((await desk.get(`${base}/expenses`)).status).toBe(403);
  });

  it('audits each step', async () => {
    const { rows } = await h.admin.query<{ action: string }>(
      `SELECT DISTINCT action FROM audit_events WHERE tenant_id = $1
         AND (action LIKE 'expense.%' OR action LIKE 'supplier.%') ORDER BY action`,
      [h.fx.tenantA],
    );
    expect(rows.map((r) => r.action)).toEqual([
      'expense.approved',
      'expense.created',
      'expense.paid',
      'expense.payment_made',
      'expense.submitted',
      'expense.updated',
      'expense.voided',
      'supplier.created',
    ]);
  });

  it('keeps another tenant out', async () => {
    const one = (await acc.get(`${base}/expenses`)).body.data[0].id;
    const ownerB = await browser(h).loginActive(h.fx.users.ownerB);
    const baseB = `/properties/${h.fx.propB1}`;
    expect((await ownerB.get(`${base}/expenses`)).status).toBe(404);
    expect((await ownerB.get(`${baseB}/expenses/${one}`)).status).toBe(404);
    expect((await withKey(ownerB, `${baseB}/expenses/${one}/void`, { reason: 'Not mine' })).status).toBe(404);
    expect((await ownerB.get('/suppliers')).body.data).toEqual([]);
    expect((await ownerB.patch(`/suppliers/${supplierId}`, { name: 'Mine' })).status).toBe(404);
    const bill = await withKey(ownerB, `${baseB}/expenses`, {
      kind: 'bill',
      supplierId,
      expenseDate: '2026-10-19',
      description: 'Using a supplier from another hotel',
      lines: [{ accountId: account['5000'], amount: '10' }],
    });
    expect(bill.status).toBe(400);
  });
});
