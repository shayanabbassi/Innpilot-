/**
 * QA scenario B (cashier closing), end to end with every Phase 4 module, as the Phase 4 exit gate requires:
 *   1. open shift with opening cash        4. transfer cash to another internal account
 *   2. receive a cash payment              5. expected cash from eligible movements
 *   3. record a cash-paid expense          6. enter the actual count
 *                                          7. explain the difference; approval because it is above the threshold
 * Expected: transfers are not income or expense; expected cash reconciles; the variance is traceable.
 * Every step is done by a cashier (role `cashier`); a supervisor approves.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { browser, ORIGIN, startHarness, type BrowserClient, type Harness } from './harness';

let h: Harness;
let acc: BrowserClient;
let desk: BrowserClient;
let cashier: BrowserClient;
let base: string;
const cash: Record<string, string> = {};
const account: Record<string, string> = {};

const withKey = (c: BrowserClient, path: string, body: object = {}, key: string = randomUUID()) =>
  c.agent
    .post(`/api/v1${base}${path}`)
    .set('origin', ORIGIN)
    .set('x-csrf-token', c.csrf)
    .set('idempotency-key', key)
    .send(body);
async function linesOf(journalId: string) {
  const { rows } = await h.admin.query<{ code: string; cls: string; debit: string; credit: string }>(
    `SELECT a.code, a.account_class AS cls, l.debit::numeric(19,2)::text AS debit, l.credit::numeric(19,2)::text AS credit
     FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE l.journal_entry_id = $1 ORDER BY l.line_no`,
    [journalId],
  );
  return rows;
}
async function drawerLedger(): Promise<string> {
  const { rows } = await h.admin.query<{ b: string }>(
    `SELECT coalesce(sum(l.debit - l.credit), 0)::numeric(19,2)::text AS b
     FROM journal_lines l JOIN journal_entries e ON e.id = l.journal_entry_id
     WHERE l.cash_account_id = $1 AND e.status <> 'draft'`,
    [cash['Front desk cash']],
  );
  return rows[0]!.b;
}

beforeAll(async () => {
  h = await startHarness();
  const owner = await browser(h).loginActive(h.fx.users.ownerA);
  acc = await browser(h).loginActive(h.fx.users.accountantA);
  desk = await browser(h).loginActive(h.fx.users.deskA);
  cashier = await browser(h).loginActive(h.fx.users.cashierA);
  base = `/properties/${h.fx.propA1}`;
  for (const a of (await acc.get('/finance/accounts')).body.data) account[a.code] = a.id;
  for (const c of (await acc.get(`${base}/cash-accounts`)).body.data) cash[c.name] = c.id;
  const ob = await acc.agent
    .post(`/api/v1${base}/opening-balances`)
    .set('origin', ORIGIN)
    .set('x-csrf-token', acc.csrf)
    .set('idempotency-key', randomUUID())
    .send({
      asOf: '2026-10-18',
      lines: [
        { accountId: account['1000'], debit: '10000' },
        { accountId: account['3000'], credit: '10000' },
      ],
    });
  if (ob.status !== 201) throw new Error(JSON.stringify(ob.body));
  const std = (
    await owner.post(`${base}/room-types`, {
      code: 'STD',
      name: 'Standard',
      capacityAdults: 2,
      capacityChildren: 0,
      nightlyRate: '8000',
    })
  ).body.data.id;
  await owner.post(`${base}/rooms/bulk`, { from: '701', to: '702', roomTypeId: std });
  const guestId = (await desk.post('/guests', { fullName: 'Scenario B Guest' })).body.data.id;
  (h as unknown as { reservationId: string }).reservationId = (
    await withKey(desk, '/reservations', {
      guestId,
      source: 'phone',
      rooms: [{ roomTypeId: std, arrival: '2026-10-20', departure: '2026-10-22', adults: 1 }],
    })
  ).body.data.id;
});

afterAll(async () => {
  await h?.close();
});

describe('QA scenario B: cashier closing', () => {
  let shiftId: string;
  let expenseId: string;
  let transferJournal: string;

  it('1. opens a shift with the opening cash', async () => {
    const res = await withKey(cashier, '/cashier-shifts/open', {
      cashAccountId: cash['Front desk cash'],
      openingCount: '10000',
    });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ openingCount: '10000.00', openingDifference: '0.00' });
    shiftId = res.body.data.id;
  });

  it('2. receives a cash payment', async () => {
    const reservationId = (h as unknown as { reservationId: string }).reservationId;
    const res = await withKey(cashier, '/payments', { reservationId, amount: '5000', method: 'cash' });
    expect(res.status).toBe(201);
  });

  it('3. records a cash-paid expense from the drawer', async () => {
    const draft = await withKey(cashier, '/expenses', {
      kind: 'cash',
      payee: 'Electrician',
      expenseDate: '2026-10-19',
      description: 'Replaced corridor lights',
      attachmentRef: 'Petty cash file, slip 3',
      cashAccountId: cash['Front desk cash'],
      lines: [{ accountId: account['6300'], amount: '300' }],
    });
    expect(draft.status).toBe(201);
    expenseId = draft.body.data.id;
    const paid = await withKey(cashier, `/expenses/${expenseId}/submit`);
    expect(paid.status).toBe(200);
    expect(await linesOf(paid.body.data.journalEntryId)).toEqual([
      { code: '6300', cls: 'expense', debit: '300.00', credit: '0.00' },
      { code: '1000', cls: 'asset', debit: '0.00', credit: '300.00' },
    ]);
  });

  it('4. transfers cash to the bank, which is not income or expense', async () => {
    const res = await withKey(cashier, '/transfers', {
      fromCashAccountId: cash['Front desk cash'],
      toCashAccountId: cash['Bank'],
      amount: '2000',
      reference: 'Deposit slip 9001',
    });
    expect(res.status).toBe(201);
    transferJournal = res.body.data.journalEntryId;
    const lines = await linesOf(transferJournal);
    expect(lines.every((l) => l.cls === 'asset')).toBe(true);
    expect(lines.map((l) => l.code)).toEqual(['1100', '1000']);
  });

  it('5. works out expected cash from the eligible movements only', async () => {
    const res = await cashier.get(`${base}/cashier-shifts/${shiftId}`);
    expect(res.body.data).toMatchObject({ cashIn: '5000.00', cashOut: '2300.00', expected: '12700.00' });
    expect(res.body.data.movements.map((m: { sourceType: string }) => m.sourceType)).toEqual([
      'payment',
      'expense',
      'cash_transfer',
    ]);
    // Expected cash reconciles to the drawer in the ledger.
    expect(await drawerLedger()).toBe('12700.00');
  });

  it('6–7. takes the count, needs the explanation, and the supervisor approves the variance', async () => {
    const noReason = await withKey(cashier, `/cashier-shifts/${shiftId}/submit-closing`, {
      countedAmount: '12100',
    });
    expect(noReason.status).toBe(400);
    const res = await withKey(cashier, `/cashier-shifts/${shiftId}/submit-closing`, {
      countedAmount: '12100',
      explanation: 'Change given twice during the evening rush',
    });
    expect(res.status).toBe(200);
    expect(res.body.data.closing).toMatchObject({
      status: 'submitted',
      variance: '-600.00',
      approvalRequired: true,
    });
    expect((await withKey(cashier, `/cashier-shifts/${shiftId}/approve-closing`)).status).toBe(403);
    const approved = await withKey(acc, `/cashier-shifts/${shiftId}/approve-closing`, { note: 'Agreed' });
    expect(approved.status).toBe(200);
    const variance = approved.body.data.closing;
    // Traceable: who counted, who explained, who approved, and the journal it posted.
    expect(variance).toMatchObject({
      status: 'approved',
      explanation: 'Change given twice during the evening rush',
      submittedByName: 'cashier@a.test',
      approvedByName: 'accountant@a.test',
    });
    expect(await linesOf(variance.varianceJournalEntryId)).toEqual([
      { code: '6970', cls: 'expense', debit: '600.00', credit: '0.00' },
      { code: '1000', cls: 'asset', debit: '0.00', credit: '600.00' },
    ]);
    expect(await drawerLedger()).toBe('12100.00');
  });

  it('the expense is reviewed by someone else, and the books balance', async () => {
    expect((await withKey(acc, `/expenses/${expenseId}/approve`)).body.data.needsApproval).toBe(false);
    expect((await acc.get('/finance/trial-balance?from=2026-10-01&to=2026-10-31')).body.data.balanced).toBe(
      true,
    );
  });
});
