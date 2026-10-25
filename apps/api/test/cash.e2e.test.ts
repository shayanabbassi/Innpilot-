/**
 * Phase 4 slice 4.1 — cash and bank accounts, transfers and opening balances. A transfer is one balanced journal
 * that never touches revenue or expense (Scenario B step 4); movements are read from the ledger and agree with it;
 * opening balances balance through Opening balance equity and are entered once; roles and isolation.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { browser, ORIGIN, startHarness, type BrowserClient, type Harness } from './harness';

let h: Harness;
let acc: BrowserClient;
let desk: BrowserClient;
let manager: BrowserClient;
let base: string;
const cash: Record<string, string> = {};
const account: Record<string, string> = {};

const withKey = (c: BrowserClient, path: string, body: object = {}, key: string = randomUUID()) =>
  c.agent
    .post(`/api/v1${path}`)
    .set('origin', ORIGIN)
    .set('x-csrf-token', c.csrf)
    .set('idempotency-key', key)
    .send(body);

async function ledgerBalance(code: string): Promise<string> {
  const { rows } = await h.admin.query<{ b: string }>(
    `SELECT coalesce(sum(l.debit - l.credit), 0)::numeric(19,2)::text AS b
     FROM journal_lines l JOIN journal_entries e ON e.id = l.journal_entry_id JOIN accounts a ON a.id = l.account_id
     WHERE a.tenant_id = $1 AND a.code = $2 AND e.status <> 'draft'`,
    [h.fx.tenantA, code],
  );
  return rows[0]!.b;
}
const balances = async () =>
  Object.fromEntries(
    ((await acc.get(`${base}/cash-accounts`)).body.data as { name: string; balance: string }[]).map((x) => [
      x.name,
      x.balance,
    ]),
  );

beforeAll(async () => {
  h = await startHarness();
  acc = await browser(h).loginActive(h.fx.users.accountantA);
  desk = await browser(h).loginActive(h.fx.users.deskA);
  manager = await browser(h).loginActive(h.fx.users.managerA);
  base = `/properties/${h.fx.propA1}`;
  for (const a of (await acc.get('/finance/accounts')).body.data) account[a.code] = a.id;
  for (const c of (await acc.get(`${base}/cash-accounts`)).body.data) cash[c.name] = c.id;
});

afterAll(async () => {
  await h?.close();
});

describe('cash accounts', () => {
  it('lists the seeded drawer, bank and card terminal; balances only for ledger readers', async () => {
    const list = await acc.get(`${base}/cash-accounts`);
    expect(list.status).toBe(200);
    expect(list.body.data.map((x: { name: string }) => x.name)).toEqual([
      'Front desk cash',
      'Bank',
      'Card terminal',
    ]);
    expect(list.body.data[0]).toMatchObject({ kind: 'cash', ledgerAccountCode: '1000', balance: '0.00' });
    const forDesk = await desk.get(`${base}/cash-accounts`);
    expect(forDesk.status).toBe(200);
    expect(forDesk.body.data.every((x: { balance: string | null }) => x.balance === null)).toBe(true);
  });

  it('adds a second bank account on the bank ledger account and refuses unsuitable ledger accounts', async () => {
    expect((await desk.post(`${base}/cash-accounts`, { name: 'Desk bank', kind: 'bank' })).status).toBe(403);
    const res = await acc.post(`${base}/cash-accounts`, {
      name: 'City Bank current',
      kind: 'bank',
      details: 'City Bank, Mall Road branch',
    });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      ledgerAccountCode: '1100',
      details: 'City Bank, Mall Road branch',
    });
    cash['City Bank current'] = res.body.data.id;

    const dup = await acc.post(`${base}/cash-accounts`, { name: 'City Bank current', kind: 'bank' });
    expect(dup.status).toBe(400);
    expect(dup.body.error.details[0].path).toBe('name');
    const revenue = await acc.post(`${base}/cash-accounts`, {
      name: 'Wrong',
      kind: 'other',
      ledgerAccountId: account['4000'],
    });
    expect(revenue.status).toBe(400);
    const receivable = await acc.post(`${base}/cash-accounts`, {
      name: 'Wrong',
      kind: 'other',
      ledgerAccountId: account['1200'],
    });
    expect(receivable.status).toBe(400);
    const card = await acc.post(`${base}/cash-accounts`, {
      name: 'Card',
      kind: 'bank',
      details: '4111 1111 1111 1111',
    });
    expect(card.status).toBe(400);
  });
});

describe('opening balances', () => {
  it('refuses revenue accounts and folio accounts, and needs journal.post', async () => {
    const bad = await withKey(acc, `${base}/opening-balances`, {
      asOf: '2026-10-18',
      lines: [
        { accountId: account['1000'], debit: '100' },
        { accountId: account['4000'], credit: '100' },
      ],
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error.details[0].path).toBe('lines.1.accountId');
    const folio = await withKey(acc, `${base}/opening-balances`, {
      asOf: '2026-10-18',
      lines: [{ accountId: account['1200'], debit: '100' }],
    });
    expect(folio.status).toBe(400);
    const forDesk = await withKey(desk, `${base}/opening-balances`, {
      asOf: '2026-10-18',
      lines: [{ accountId: account['1000'], debit: '100' }],
    });
    expect(forDesk.status).toBe(403);
    expect((await acc.get(`${base}/opening-balances`)).body.data).toBeNull();
  });

  it('posts once, balancing through opening balance equity, with ambiguous bank lines named', async () => {
    const body = {
      asOf: '2026-10-18',
      lines: [
        { accountId: account['1000'], debit: '50000' },
        { accountId: account['1100'], debit: '200000', cashAccountId: cash['Bank'] },
        { accountId: account['1100'], debit: '10000', cashAccountId: cash['City Bank current'] },
        { accountId: account['2400'], credit: '100000', description: 'Bank loan' },
      ],
    };
    // Two bank accounts post to 1100: a bank line without its account cannot be posted.
    const ambiguous = await withKey(acc, `${base}/opening-balances`, {
      ...body,
      lines: [{ accountId: account['1100'], debit: '1' }],
    });
    expect(ambiguous.status).toBe(400);
    expect(ambiguous.body.error.details[0].path).toBe('lines.0.cashAccountId');

    const key = randomUUID();
    const res = await withKey(acc, `${base}/opening-balances`, body, key);
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      asOf: '2026-10-18',
      totalDebit: '260000.00',
      totalCredit: '260000.00',
      equityAmount: '160000.00',
    });
    const replay = await withKey(acc, `${base}/opening-balances`, body, key);
    expect(replay.status).toBe(201);
    expect(replay.body.data.id).toBe(res.body.data.id);
    const again = await withKey(acc, `${base}/opening-balances`, body);
    expect(again.status).toBe(409);

    expect(await ledgerBalance('3900')).toBe('-160000.00');
    expect(await balances()).toMatchObject({
      'Front desk cash': '50000.00',
      Bank: '200000.00',
      'City Bank current': '10000.00',
    });
    expect((await acc.get(`${base}/opening-balances`)).body.data.id).toBe(res.body.data.id);
    const { rows } = await h.admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM opening_balances WHERE property_id = $1`,
      [h.fx.propA1],
    );
    expect(rows[0]!.n).toBe(1);
  });
});

describe('transfers (Scenario B step 4)', () => {
  let transferId: string;
  let journalId: string;

  it('moves cash to the bank in one journal with no revenue or expense lines', async () => {
    const res = await withKey(manager, `${base}/transfers`, {
      fromCashAccountId: cash['Front desk cash'],
      toCashAccountId: cash['Bank'],
      amount: '30000',
      reference: 'Deposit slip 4411',
    });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      fromCashAccountName: 'Front desk cash',
      toCashAccountName: 'Bank',
      amount: '30000.00',
      reference: 'Deposit slip 4411',
    });
    transferId = res.body.data.id;
    journalId = res.body.data.journalEntryId;
    const lines = await h.admin.query<{
      code: string;
      cls: string;
      debit: string;
      credit: string;
      cash: string;
    }>(
      `SELECT a.code, a.account_class AS cls, l.debit::numeric(19,2)::text AS debit,
              l.credit::numeric(19,2)::text AS credit, c.name AS cash
       FROM journal_lines l JOIN accounts a ON a.id = l.account_id JOIN cash_accounts c ON c.id = l.cash_account_id
       WHERE l.journal_entry_id = $1 ORDER BY l.line_no`,
      [journalId],
    );
    expect(lines.rows).toEqual([
      { code: '1100', cls: 'asset', debit: '30000.00', credit: '0.00', cash: 'Bank' },
      { code: '1000', cls: 'asset', debit: '0.00', credit: '30000.00', cash: 'Front desk cash' },
    ]);
    expect(await balances()).toMatchObject({ 'Front desk cash': '20000.00', Bank: '230000.00' });
  });

  it('never hands over more than a drawer holds, and needs two different active accounts', async () => {
    const over = await withKey(acc, `${base}/transfers`, {
      fromCashAccountId: cash['Front desk cash'],
      toCashAccountId: cash['Bank'],
      amount: '20000.01',
    });
    expect(over.status).toBe(409);
    expect(over.body.error.details[0].path).toBe('amount');
    const same = await withKey(acc, `${base}/transfers`, {
      fromCashAccountId: cash['Bank'],
      toCashAccountId: cash['Bank'],
      amount: '1',
    });
    expect(same.status).toBe(400);
  });

  it('records one transfer for simultaneous retries with one key', async () => {
    const key = randomUUID();
    const body = {
      fromCashAccountId: cash['Bank'],
      toCashAccountId: cash['City Bank current'],
      amount: '5000',
    };
    const results = await Promise.all(
      Array.from({ length: 6 }, () => withKey(acc, `${base}/transfers`, body, key)),
    );
    const ok = results.filter((r) => r.status === 201);
    expect(ok.length).toBeGreaterThanOrEqual(1);
    expect(results.every((r) => r.status === 201 || r.status === 409)).toBe(true);
    expect(new Set(ok.map((r) => r.body.data.id)).size).toBe(1);
    expect(await balances()).toMatchObject({ Bank: '225000.00', 'City Bank current': '15000.00' });
    const list = await acc.get(`${base}/transfers`);
    expect(list.body.data).toHaveLength(2);
    expect(list.body.data[1].id).toBe(transferId);
  });

  it('shows movements read from the ledger, which agree with it', async () => {
    const res = await acc.get(
      `${base}/cash-accounts/${cash['Front desk cash']}/movements?from=2026-10-19&to=2026-10-31`,
    );
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      openingBalance: '50000.00',
      totalIn: '0.00',
      totalOut: '30000.00',
      closingBalance: '20000.00',
    });
    expect(res.body.data.lines).toHaveLength(1);
    expect(res.body.data.lines[0]).toMatchObject({
      sourceType: 'cash_transfer',
      out: '30000.00',
      balance: '20000.00',
    });
    // Each cash ledger account equals the sum of its cash accounts.
    const b = await balances();
    expect(await ledgerBalance('1000')).toBe(b['Front desk cash']);
    expect(await ledgerBalance('1100')).toBe((Number(b['Bank']) + Number(b['City Bank current'])).toFixed(2));
    expect((await acc.get('/finance/trial-balance?from=2026-10-01&to=2026-10-31')).body.data.balanced).toBe(
      true,
    );
    expect(
      (await desk.get(`${base}/cash-accounts/${cash['Bank']}/movements?from=2026-10-01&to=2026-10-31`))
        .status,
    ).toBe(403);
  });

  it('needs cash.transfer', async () => {
    const body = { fromCashAccountId: cash['Bank'], toCashAccountId: cash['Front desk cash'], amount: '1' };
    expect((await withKey(desk, `${base}/transfers`, body)).status).toBe(403);
    const hk = await browser(h).loginActive(h.fx.users.housekeepingA);
    expect((await withKey(hk, `${base}/transfers`, body)).status).toBe(403);
    expect((await hk.get(`${base}/transfers`)).status).toBe(403);
  });
});

describe('manual journals on cash ledger accounts', () => {
  const draft = (cashAccountId?: string) => ({
    propertyId: h.fx.propA1,
    narration: 'Owner puts money in the bank',
    lines: [
      { accountId: account['1100'], debit: '1000', ...(cashAccountId ? { cashAccountId } : {}) },
      { accountId: account['3000'], credit: '1000' },
    ],
  });

  it('needs the bank account named when several share the ledger account', async () => {
    const d = await withKey(acc, '/finance/journal-entries/draft', draft());
    expect(d.status).toBe(201);
    expect(d.body.data.lines[0].cashAccountId).toBeNull();
    const post = await withKey(acc, `/finance/journal-entries/${d.body.data.id}/post`);
    expect(post.status).toBe(400);
    expect(post.body.error.details[0].path).toBe('lines.0.cashAccountId');

    const wrong = await acc.put(`/finance/journal-entries/${d.body.data.id}`, draft(cash['Front desk cash']));
    expect(wrong.status).toBe(400);
    const fixed = await acc.put(
      `/finance/journal-entries/${d.body.data.id}`,
      draft(cash['City Bank current']),
    );
    expect(fixed.status).toBe(200);
    expect(fixed.body.data.lines[0].cashAccountName).toBe('City Bank current');
    expect((await withKey(acc, `/finance/journal-entries/${d.body.data.id}/post`)).status).toBe(200);
    expect((await balances())['City Bank current']).toBe('16000.00');
  });

  it('fills in the drawer when it is the only cash account on the ledger account', async () => {
    const d = await withKey(acc, '/finance/journal-entries/draft', {
      propertyId: h.fx.propA1,
      narration: 'Float from owner',
      lines: [
        { accountId: account['1000'], debit: '500' },
        { accountId: account['3000'], credit: '500' },
      ],
    });
    expect(d.body.data.lines[0].cashAccountName).toBe('Front desk cash');
  });
});

describe('closing an account', () => {
  it('refuses to close an account holding money, and closes an empty one', async () => {
    const full = await acc.patch(`${base}/cash-accounts/${cash['City Bank current']}`, { active: false });
    expect(full.status).toBe(409);
    const spare = await acc.post(`${base}/cash-accounts`, { name: 'Spare drawer', kind: 'cash' });
    const closed = await acc.patch(`${base}/cash-accounts/${spare.body.data.id}`, { active: false });
    expect(closed.status).toBe(200);
    expect(closed.body.data.active).toBe(false);
    expect((await acc.patch(`${base}/cash-accounts/${spare.body.data.id}`, {})).status).toBe(400);
  });

  it('audits account changes, transfers and the opening balances', async () => {
    const { rows } = await h.admin.query<{ action: string }>(
      `SELECT DISTINCT action FROM audit_events WHERE tenant_id = $1 AND action IN
        ('cash_account.created', 'cash_account.updated', 'cash.transferred', 'finance.opening_balances_posted')
       ORDER BY action`,
      [h.fx.tenantA],
    );
    expect(rows.map((r) => r.action)).toEqual([
      'cash.transferred',
      'cash_account.created',
      'cash_account.updated',
      'finance.opening_balances_posted',
    ]);
  });
});

describe('isolation', () => {
  it("keeps another tenant out of this property's cash", async () => {
    const ownerB = await browser(h).loginActive(h.fx.users.ownerB);
    const baseB = `/properties/${h.fx.propB1}`;
    expect((await ownerB.get(`${base}/cash-accounts`)).status).toBe(404);
    expect(
      (await ownerB.get(`${baseB}/cash-accounts/${cash['Bank']}/movements?from=2026-10-01&to=2026-10-31`))
        .status,
    ).toBe(404);
    expect((await ownerB.patch(`${baseB}/cash-accounts/${cash['Bank']}`, { name: 'Mine now' })).status).toBe(
      404,
    );
    const steal = await withKey(ownerB, `${baseB}/transfers`, {
      fromCashAccountId: cash['Bank'],
      toCashAccountId: cash['Front desk cash'],
      amount: '1',
    });
    expect(steal.status).toBe(404);
    expect((await ownerB.get(`${baseB}/opening-balances`)).body.data).toBeNull();
  });
});
