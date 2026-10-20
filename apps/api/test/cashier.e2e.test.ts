/**
 * Phase 4 slice 4.2 — cashier shifts and closings. CASH-001 (variance calculated, reason required, approval policy
 * enforced) and QA scenario B: open shift with opening cash → cash payment → cash-paid expense → transfer to the
 * bank → expected cash → count → explained and approved variance. The expense module arrives in slice 4.3; here the
 * cash-paid expense is a manual journal paid from the drawer, which posts the same lines.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { browser, ORIGIN, startHarness, type BrowserClient, type Harness } from './harness';

let h: Harness;
let owner: BrowserClient;
let acc: BrowserClient;
let desk: BrowserClient;
let manager: BrowserClient;
let base: string;
const cash: Record<string, string> = {};
const account: Record<string, string> = {};
let reservationId: string;

const withKey = (c: BrowserClient, path: string, body: object = {}, key: string = randomUUID()) =>
  c.agent
    .post(`/api/v1${path}`)
    .set('origin', ORIGIN)
    .set('x-csrf-token', c.csrf)
    .set('idempotency-key', key)
    .send(body);

async function drawerLedger(cashAccountId: string): Promise<string> {
  const { rows } = await h.admin.query<{ b: string }>(
    `SELECT coalesce(sum(l.debit - l.credit), 0)::numeric(19,2)::text AS b
     FROM journal_lines l JOIN journal_entries e ON e.id = l.journal_entry_id
     WHERE l.cash_account_id = $1 AND e.status <> 'draft'`,
    [cashAccountId],
  );
  return rows[0]!.b;
}

beforeAll(async () => {
  h = await startHarness();
  owner = await browser(h).loginActive(h.fx.users.ownerA);
  acc = await browser(h).loginActive(h.fx.users.accountantA);
  desk = await browser(h).loginActive(h.fx.users.deskA);
  manager = await browser(h).loginActive(h.fx.users.managerA);
  base = `/properties/${h.fx.propA1}`;
  for (const a of (await acc.get('/finance/accounts')).body.data) account[a.code] = a.id;
  for (const c of (await acc.get(`${base}/cash-accounts`)).body.data) cash[c.name] = c.id;
  cash['Bar cash'] = (
    await acc.post(`${base}/cash-accounts`, { name: 'Bar cash', kind: 'cash' })
  ).body.data.id;
  // The drawer starts with 10,000 in the books, so the opening count agrees with them.
  const ob = await withKey(acc, `${base}/opening-balances`, {
    asOf: '2026-10-18',
    lines: [
      { accountId: account['1000'], debit: '10000', cashAccountId: cash['Front desk cash'] },
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
  await owner.post(`${base}/rooms/bulk`, { from: '501', to: '502', roomTypeId: std });
  const guestId = (await desk.post('/guests', { fullName: 'Shift Guest' })).body.data.id;
  const res = await withKey(desk, `${base}/reservations`, {
    guestId,
    source: 'phone',
    rooms: [{ roomTypeId: std, arrival: '2026-10-20', departure: '2026-10-22', adults: 1 }],
  });
  reservationId = res.body.data.id;
});

afterAll(async () => {
  await h?.close();
});

describe('opening a shift', () => {
  let shiftId: string;

  it('opens on a cash drawer with the counted cash and refuses a second open shift', async () => {
    expect((await desk.get(`${base}/cashier-shifts/current`)).body.data).toBeNull();
    const notDrawer = await withKey(desk, `${base}/cashier-shifts/open`, {
      cashAccountId: cash['Bank'],
      openingCount: '0',
    });
    expect(notDrawer.status).toBe(400);
    const res = await withKey(desk, `${base}/cashier-shifts/open`, {
      cashAccountId: cash['Front desk cash'],
      openingCount: '10000',
    });
    expect(res.status).toBe(201);
    shiftId = res.body.data.id;
    expect(res.body.data).toMatchObject({
      status: 'open',
      openingCount: '10000.00',
      bookBalanceAtOpen: '10000.00',
      openingDifference: '0.00',
      expected: '10000.00',
      closing: null,
    });
    const again = await withKey(desk, `${base}/cashier-shifts/open`, {
      cashAccountId: cash['Bar cash'],
      openingCount: '0',
    });
    expect(again.status).toBe(409);
    const taken = await withKey(manager, `${base}/cashier-shifts/open`, {
      cashAccountId: cash['Front desk cash'],
      openingCount: '0',
    });
    expect(taken.status).toBe(409);
    expect((await desk.get(`${base}/cashier-shifts/current`)).body.data.id).toBe(shiftId);
  });
});

describe('Scenario B: expected cash, count, explained and approved variance (CASH-001)', () => {
  let shiftId: string;

  beforeAll(async () => {
    shiftId = (await desk.get(`${base}/cashier-shifts/current`)).body.data.id;
  });

  it('counts the cash payment, the cash-paid expense and the transfer; card money stays out', async () => {
    const pay = await withKey(desk, `${base}/payments`, { reservationId, amount: '5000', method: 'cash' });
    expect(pay.status).toBe(201);
    const card = await withKey(desk, `${base}/payments`, {
      reservationId,
      amount: '1000',
      method: 'card',
      externalReference: 'AUTH 1',
    });
    expect(card.status).toBe(201);
    const expense = await withKey(acc, '/finance/journal-entries/draft', {
      propertyId: h.fx.propA1,
      narration: 'Plumber paid from the drawer',
      lines: [
        { accountId: account['6300'], debit: '300' },
        // Two drawers share 1000 (Front desk cash, Bar cash), so the line must say which.
        { accountId: account['1000'], credit: '300', cashAccountId: cash['Front desk cash'] },
      ],
    });
    expect((await withKey(acc, `/finance/journal-entries/${expense.body.data.id}/post`)).status).toBe(200);
    const transfer = await withKey(manager, `${base}/transfers`, {
      fromCashAccountId: cash['Front desk cash'],
      toCashAccountId: cash['Bank'],
      amount: '2000',
    });
    expect(transfer.status).toBe(201);

    const shift = await desk.get(`${base}/cashier-shifts/${shiftId}`);
    expect(shift.body.data).toMatchObject({ cashIn: '5000.00', cashOut: '2300.00', expected: '12700.00' });
    expect(shift.body.data.movements.map((m: { sourceType: string }) => m.sourceType)).toEqual([
      'payment',
      'manual',
      'cash_transfer',
    ]);
    // The transfer is not income or expense: its journal touches only the drawer and the bank.
    const { rows } = await h.admin.query<{ cls: string }>(
      `SELECT DISTINCT a.account_class AS cls FROM journal_lines l JOIN accounts a ON a.id = l.account_id
       WHERE l.journal_entry_id = $1`,
      [transfer.body.data.journalEntryId],
    );
    expect(rows.map((r) => r.cls)).toEqual(['asset']);
  });

  it('needs an explanation for a variance', async () => {
    const res = await withKey(desk, `${base}/cashier-shifts/${shiftId}/submit-closing`, {
      countedAmount: '12100',
    });
    expect(res.status).toBe(400);
    expect(res.body.error.details[0].path).toBe('explanation');
    // Nothing was closed by the refused attempt.
    expect((await desk.get(`${base}/cashier-shifts/current`)).body.data.id).toBe(shiftId);
  });

  it('holds a variance above the threshold for approval; the closing is then locked', async () => {
    const res = await withKey(desk, `${base}/cashier-shifts/${shiftId}/submit-closing`, {
      countedAmount: '12100',
      explanation: 'Change given twice to a walk-in guest',
    });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'closed', expected: '12700.00' });
    expect(res.body.data.closing).toMatchObject({
      status: 'submitted',
      expectedAmount: '12700.00',
      countedAmount: '12100.00',
      variance: '-600.00',
      threshold: '500.00',
      approvalRequired: true,
      varianceJournalEntryId: null,
    });
    // Nothing is posted until approval; the drawer still shows what the books expect.
    expect(await drawerLedger(cash['Front desk cash']!)).toBe('12700.00');
    const again = await withKey(desk, `${base}/cashier-shifts/${shiftId}/submit-closing`, {
      countedAmount: '12700',
    });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('CASH_CLOSING_ALREADY_SUBMITTED');
    // Cash taken after the closing no longer joins the shift.
    await withKey(desk, `${base}/payments`, { reservationId, amount: '100', method: 'cash' });
    expect((await desk.get(`${base}/cashier-shifts/${shiftId}`)).body.data.cashIn).toBe('5000.00');
  });

  it('is approved by a supervisor, posting the shortage to cash over and short', async () => {
    expect((await withKey(desk, `${base}/cashier-shifts/${shiftId}/approve-closing`)).status).toBe(403);
    const res = await withKey(manager, `${base}/cashier-shifts/${shiftId}/approve-closing`, {
      note: 'Checked with the guest',
    });
    expect(res.status).toBe(200);
    expect(res.body.data.closing).toMatchObject({
      status: 'approved',
      approvalNote: 'Checked with the guest',
    });
    const { rows } = await h.admin.query<{
      code: string;
      debit: string;
      credit: string;
      cash: string | null;
    }>(
      `SELECT a.code, l.debit::numeric(19,2)::text AS debit, l.credit::numeric(19,2)::text AS credit,
              l.cash_account_id AS cash
       FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE l.journal_entry_id = $1 ORDER BY l.line_no`,
      [res.body.data.closing.varianceJournalEntryId],
    );
    expect(rows).toEqual([
      { code: '6970', debit: '600.00', credit: '0.00', cash: null },
      { code: '1000', debit: '0.00', credit: '600.00', cash: cash['Front desk cash'] },
    ]);
    // The books now hold what was counted (plus the 100 taken after the closing).
    expect(await drawerLedger(cash['Front desk cash']!)).toBe('12200.00');
    expect((await withKey(manager, `${base}/cashier-shifts/${shiftId}/approve-closing`)).status).toBe(409);
    expect((await acc.get('/finance/trial-balance?from=2026-10-01&to=2026-10-31')).body.data.balanced).toBe(
      true,
    );
  });

  it('reopens only for the owner with a reason, reversing the variance; a recount closes it again', async () => {
    expect(
      (await withKey(manager, `${base}/cashier-shifts/${shiftId}/reopen`, { reason: 'Recount' })).status,
    ).toBe(403);
    expect((await withKey(owner, `${base}/cashier-shifts/${shiftId}/reopen`, {})).status).toBe(400);
    const approved = (await owner.get(`${base}/cashier-shifts/${shiftId}`)).body.data.closing;
    const res = await withKey(owner, `${base}/cashier-shifts/${shiftId}/reopen`, {
      reason: 'Missing 600 found in the safe',
    });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'open', closing: null });
    expect(res.body.data.reopenedClosings[0]).toMatchObject({
      status: 'reopened',
      reopenReason: 'Missing 600 found in the safe',
    });
    const { rows } = await h.admin.query<{ status: string }>(
      `SELECT status FROM journal_entries WHERE id = $1`,
      [approved.varianceJournalEntryId],
    );
    expect(rows[0]!.status).toBe('reversed');
    expect(await drawerLedger(cash['Front desk cash']!)).toBe('12800.00');

    const recount = await withKey(desk, `${base}/cashier-shifts/${shiftId}/submit-closing`, {
      countedAmount: '12700',
    });
    expect(recount.status).toBe(200);
    expect(recount.body.data.closing).toMatchObject({
      status: 'approved',
      variance: '0.00',
      approvalRequired: false,
      approvedByName: null,
      varianceJournalEntryId: null,
    });
  });
});

describe('approval policy', () => {
  it('accepts a small explained variance at once and posts it', async () => {
    const open = await withKey(manager, `${base}/cashier-shifts/open`, {
      cashAccountId: cash['Bar cash'],
      openingCount: '0',
    });
    expect(open.status).toBe(201);
    expect(open.body.data.openingDifference).toBe('0.00');
    const res = await withKey(manager, `${base}/cashier-shifts/${open.body.data.id}/submit-closing`, {
      countedAmount: '100',
      explanation: 'Tip left in the drawer',
    });
    expect(res.status).toBe(200);
    expect(res.body.data.closing).toMatchObject({
      status: 'approved',
      variance: '100.00',
      approvalRequired: false,
    });
    expect(await drawerLedger(cash['Bar cash']!)).toBe('100.00');
  });

  it('never lets the submitter approve their own closing', async () => {
    const open = await withKey(manager, `${base}/cashier-shifts/open`, {
      cashAccountId: cash['Bar cash'],
      openingCount: '1100',
    });
    const id = open.body.data.id;
    await withKey(manager, `${base}/cashier-shifts/${id}/submit-closing`, {
      countedAmount: '0',
      explanation: 'Float taken to the front desk without a transfer',
    });
    const self = await withKey(manager, `${base}/cashier-shifts/${id}/approve-closing`);
    expect(self.status).toBe(403);
    expect((await acc.get(`${base}/cashier-shifts/${id}`)).body.data.closing.status).toBe('submitted');
    const other = await withKey(acc, `${base}/cashier-shifts/${id}/approve-closing`);
    expect(other.status).toBe(200);
  });

  it('uses the property threshold, which only property managers change', async () => {
    expect((await acc.patch(`/properties/${h.fx.propA1}`, { cashVarianceThreshold: '50' })).status).toBe(403);
    const res = await owner.patch(`/properties/${h.fx.propA1}`, { cashVarianceThreshold: '50' });
    expect(res.status).toBe(200);
    expect(res.body.data.cashVarianceThreshold).toBe('50.00');
    const open = await withKey(desk, `${base}/cashier-shifts/open`, {
      cashAccountId: cash['Front desk cash'],
      openingCount: '12800',
    });
    const closed = await withKey(desk, `${base}/cashier-shifts/${open.body.data.id}/submit-closing`, {
      countedAmount: '12740',
      explanation: 'Coins short',
    });
    expect(closed.body.data.closing).toMatchObject({ approvalRequired: true, threshold: '50.00' });
  });

  it('opens one shift when the same cashier tries several times at once', async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        withKey(acc, `${base}/cashier-shifts/open`, { cashAccountId: cash['Bar cash'], openingCount: '0' }),
      ),
    );
    // The accountant has no cashier.operate: all refused, nothing opened.
    expect(results.every((r) => r.status === 403)).toBe(true);
    const tries = await Promise.all(
      Array.from({ length: 5 }, () =>
        withKey(manager, `${base}/cashier-shifts/open`, {
          cashAccountId: cash['Bar cash'],
          openingCount: '0',
        }),
      ),
    );
    expect(tries.filter((r) => r.status === 201)).toHaveLength(1);
    expect(tries.every((r) => r.status === 201 || r.status === 409)).toBe(true);
  });
});

describe('visibility, audit and isolation', () => {
  it('shows a cashier only their own shifts, supervisors everyone', async () => {
    const mine = await desk.get(`${base}/cashier-shifts`);
    expect(mine.status).toBe(200);
    expect(new Set(mine.body.data.map((s: { userName: string }) => s.userName)).size).toBe(1);
    const all = await acc.get(`${base}/cashier-shifts`);
    expect(new Set(all.body.data.map((s: { userName: string }) => s.userName)).size).toBe(2);
    const waiting = await acc.get(`${base}/cashier-shifts?status=awaiting_approval`);
    expect(waiting.body.data).toHaveLength(1);
    const managerShift = all.body.data.find(
      (s: { cashAccountName: string }) => s.cashAccountName === 'Bar cash',
    );
    expect((await desk.get(`${base}/cashier-shifts/${managerShift.id}`)).status).toBe(404);
    const hk = await browser(h).loginActive(h.fx.users.housekeepingA);
    expect((await hk.get(`${base}/cashier-shifts/current`)).status).toBe(403);
  });

  it('audits every step', async () => {
    const { rows } = await h.admin.query<{ action: string; n: number }>(
      `SELECT action, count(*)::int AS n FROM audit_events WHERE tenant_id = $1 AND action LIKE 'cashier.%'
       GROUP BY action ORDER BY action`,
      [h.fx.tenantA],
    );
    expect(Object.fromEntries(rows.map((r) => [r.action, r.n]))).toEqual({
      'cashier.closing_approved': 2,
      'cashier.closing_reopened': 1,
      'cashier.closing_submitted': 5,
      'cashier.shift_opened': 5,
    });
  });

  it("keeps another tenant out of this property's shifts", async () => {
    const shift = (await acc.get(`${base}/cashier-shifts`)).body.data[0].id;
    const ownerB = await browser(h).loginActive(h.fx.users.ownerB);
    const baseB = `/properties/${h.fx.propB1}`;
    expect((await ownerB.get(`${base}/cashier-shifts`)).status).toBe(404);
    expect((await ownerB.get(`${baseB}/cashier-shifts/${shift}`)).status).toBe(404);
    expect(
      (await withKey(ownerB, `${baseB}/cashier-shifts/${shift}/reopen`, { reason: 'Not mine' })).status,
    ).toBe(404);
    const open = await withKey(ownerB, `${baseB}/cashier-shifts/open`, {
      cashAccountId: cash['Front desk cash'],
      openingCount: '0',
    });
    expect(open.status).toBe(404);
  });
});
