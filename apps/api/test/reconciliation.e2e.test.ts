/**
 * Phase 4 slice 4.4 — bank reconciliation and card settlements. Card fees go to bank charges; a settlement never
 * exceeds the clearing balance; a line is reconciled once; finishing with a difference needs an explanation; the
 * reconciled balance equals the ledger; completed reconciliations are locked; roles and isolation.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { browser, ORIGIN, startHarness, type BrowserClient, type Harness } from './harness';

let h: Harness;
let acc: BrowserClient;
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
const del = (c: BrowserClient, path: string) =>
  c.agent.delete(`/api/v1${path}`).set('origin', ORIGIN).set('x-csrf-token', c.csrf);

async function journal(lines: object[], narration: string) {
  const d = await withKey(acc, '/finance/journal-entries/draft', {
    propertyId: h.fx.propA1,
    narration,
    lines,
  });
  const p = await withKey(acc, `/finance/journal-entries/${d.body.data.id}/post`);
  if (p.status !== 200) throw new Error(JSON.stringify(p.body));
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

beforeAll(async () => {
  h = await startHarness();
  acc = await browser(h).loginActive(h.fx.users.accountantA);
  manager = await browser(h).loginActive(h.fx.users.managerA);
  base = `/properties/${h.fx.propA1}`;
  for (const a of (await acc.get('/finance/accounts')).body.data) account[a.code] = a.id;
  for (const c of (await acc.get(`${base}/cash-accounts`)).body.data) cash[c.name] = c.id;
  const ob = await withKey(acc, `${base}/opening-balances`, {
    asOf: '2026-10-18',
    lines: [
      { accountId: account['1100'], debit: '50000' },
      { accountId: account['1150'], debit: '8000' },
      { accountId: account['3000'], credit: '58000' },
    ],
  });
  if (ob.status !== 201) throw new Error(JSON.stringify(ob.body));
  await journal(
    [
      { accountId: account['1100'], debit: '2000' },
      { accountId: account['4900'], credit: '2000' },
    ],
    'Hall booking paid by transfer',
  );
  await journal(
    [
      { accountId: account['6900'], debit: '300' },
      { accountId: account['1100'], credit: '300' },
    ],
    'Monthly account fee',
  );
});

afterAll(async () => {
  await h?.close();
});

describe('card settlements', () => {
  it('moves the clearing balance to the bank with the fee in bank charges', async () => {
    const res = await withKey(manager, `${base}/card-settlements`, {
      clearingAccountId: cash['Card terminal'],
      bankAccountId: cash['Bank'],
      grossAmount: '5000',
      feeAmount: '125',
      reference: 'Batch 7781',
    });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      grossAmount: '5000.00',
      feeAmount: '125.00',
      netAmount: '4875.00',
    });
    const { rows } = await h.admin.query<{ code: string; debit: string; credit: string }>(
      `SELECT a.code, l.debit::numeric(19,2)::text AS debit, l.credit::numeric(19,2)::text AS credit
       FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE l.journal_entry_id = $1 ORDER BY l.line_no`,
      [res.body.data.journalEntryId],
    );
    expect(rows).toEqual([
      { code: '1100', debit: '4875.00', credit: '0.00' },
      { code: '6900', debit: '125.00', credit: '0.00' },
      { code: '1150', debit: '0.00', credit: '5000.00' },
    ]);
    expect(await ledgerBalance('1150')).toBe('3000.00');
  });

  it('never settles more than is waiting, needs a fee below the amount, and the right accounts', async () => {
    const body = { clearingAccountId: cash['Card terminal'], bankAccountId: cash['Bank'] };
    const over = await withKey(manager, `${base}/card-settlements`, { ...body, grossAmount: '3000.01' });
    expect(over.status).toBe(409);
    const fee = await withKey(manager, `${base}/card-settlements`, {
      ...body,
      grossAmount: '100',
      feeAmount: '100',
    });
    expect(fee.status).toBe(400);
    const wrong = await withKey(manager, `${base}/card-settlements`, {
      clearingAccountId: cash['Bank'],
      bankAccountId: cash['Front desk cash'],
      grossAmount: '10',
    });
    expect(wrong.status).toBe(400);
    const desk = await browser(h).loginActive(h.fx.users.deskA);
    expect((await withKey(desk, `${base}/card-settlements`, { ...body, grossAmount: '1' })).status).toBe(403);
    expect((await manager.get(`${base}/card-settlements`)).body.data).toHaveLength(1);
  });
});

describe('bank reconciliation', () => {
  let first: string;
  let second: string;

  it('is started by people with bank.reconcile, on bank or card accounts, one at a time', async () => {
    const managerTry = await manager.post(`${base}/reconciliations`, {
      cashAccountId: cash['Bank'],
      statementDate: '2026-10-18',
      statementBalance: '50000',
    });
    expect(managerTry.status).toBe(403);
    const drawer = await acc.post(`${base}/reconciliations`, {
      cashAccountId: cash['Front desk cash'],
      statementDate: '2026-10-18',
      statementBalance: '0',
    });
    expect(drawer.status).toBe(400);
    const future = await acc.post(`${base}/reconciliations`, {
      cashAccountId: cash['Bank'],
      statementDate: '2026-10-20',
      statementBalance: '0',
    });
    expect(future.status).toBe(400);

    const abandoned = await acc.post(`${base}/reconciliations`, {
      cashAccountId: cash['Bank'],
      statementDate: '2026-10-18',
      statementBalance: '1',
    });
    expect(abandoned.status).toBe(201);
    expect(
      (
        await acc.post(`${base}/reconciliations`, {
          cashAccountId: cash['Bank'],
          statementDate: '2026-10-18',
          statementBalance: '1',
        })
      ).status,
    ).toBe(409);
    expect((await del(acc, `${base}/reconciliations/${abandoned.body.data.id}`)).status).toBe(200);

    const res = await acc.post(`${base}/reconciliations`, {
      cashAccountId: cash['Bank'],
      statementDate: '2026-10-18',
      statementBalance: '50000',
    });
    expect(res.status).toBe(201);
    first = res.body.data.id;
    // Only the opening balance is dated on or before the statement.
    expect(res.body.data.lines.map((l: { amount: string }) => l.amount)).toEqual(['50000.00']);
    expect(res.body.data).toMatchObject({ clearedBalance: '0.00', difference: '50000.00', tickedCount: 0 });
  });

  it('completes with no difference once the statement lines are ticked', async () => {
    const detail = (await acc.get(`${base}/reconciliations/${first}`)).body.data;
    const ticked = await acc.put(`${base}/reconciliations/${first}/items`, {
      journalLineIds: detail.lines.map((l: { journalLineId: string }) => l.journalLineId),
    });
    expect(ticked.body.data).toMatchObject({
      clearedBalance: '50000.00',
      difference: '0.00',
      tickedCount: 1,
    });
    const done = await withKey(acc, `${base}/reconciliations/${first}/complete`);
    expect(done.status).toBe(200);
    expect(done.body.data).toMatchObject({
      status: 'completed',
      difference: '0.00',
      completedByName: 'accountant@a.test',
    });
    expect((await acc.put(`${base}/reconciliations/${first}/items`, { journalLineIds: [] })).status).toBe(
      409,
    );
  });

  it('carries on from the last statement; a reconciled line cannot be ticked again', async () => {
    const res = await acc.post(`${base}/reconciliations`, {
      cashAccountId: cash['Bank'],
      statementDate: '2026-10-19',
      statementBalance: '54575',
    });
    expect(res.status).toBe(201);
    second = res.body.data.id;
    expect(res.body.data).toMatchObject({ previousStatementDate: '2026-10-18', clearedBalance: '50000.00' });
    expect(res.body.data.lines.map((l: { amount: string }) => l.amount)).toEqual([
      '2000.00',
      '-300.00',
      '4875.00',
    ]);

    const firstLines = (await acc.get(`${base}/reconciliations/${first}`)).body.data.lines;
    const again = await acc.put(`${base}/reconciliations/${second}/items`, {
      journalLineIds: [firstLines[0].journalLineId],
    });
    expect(again.status).toBe(400);
    const drawerLine = await h.admin.query<{ id: string }>(
      `SELECT l.id FROM journal_lines l WHERE l.cash_account_id = $1 LIMIT 1`,
      [cash['Card terminal']],
    );
    expect(
      (await acc.put(`${base}/reconciliations/${second}/items`, { journalLineIds: [drawerLine.rows[0]!.id] }))
        .status,
    ).toBe(400);
  });

  it('needs an explanation to finish with a difference, which is recorded and not booked', async () => {
    const lines = (await acc.get(`${base}/reconciliations/${second}`)).body.data.lines;
    const onStatement = lines.filter((l: { amount: string }) => l.amount !== '2000.00');
    const ticked = await acc.put(`${base}/reconciliations/${second}/items`, {
      journalLineIds: onStatement.map((l: { journalLineId: string }) => l.journalLineId),
    });
    // The statement shows 54,575; the books say 56,575 with the hall booking not yet on it.
    expect(ticked.body.data).toMatchObject({ clearedBalance: '54575.00', difference: '0.00' });
    const changed = await acc.patch(`${base}/reconciliations/${second}`, { statementBalance: '54500' });
    expect(changed.body.data.difference).toBe('-75.00');
    const noReason = await withKey(acc, `${base}/reconciliations/${second}/complete`);
    expect(noReason.status).toBe(400);
    expect(noReason.body.error.details[0].path).toBe('explanation');
    const entriesBefore = await h.admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM journal_entries`,
    );
    const done = await withKey(acc, `${base}/reconciliations/${second}/complete`, {
      explanation: 'Bank took 75 in charges not yet entered; to be posted after review',
    });
    expect(done.status).toBe(200);
    expect(done.body.data).toMatchObject({ status: 'completed', difference: '-75.00' });
    const entriesAfter = await h.admin.query<{ n: number }>(`SELECT count(*)::int AS n FROM journal_entries`);
    expect(entriesAfter.rows[0]!.n).toBe(entriesBefore.rows[0]!.n);
    // The reconciled lines agree with the ledger: the bank ledger less the open line is the cleared balance.
    expect(await ledgerBalance('1100')).toBe('56575.00');
    expect(Number(done.body.data.clearedBalance) + 2000).toBe(56575);
  });

  it('only moves statements forward, and keeps completed ones locked', async () => {
    const back = await acc.post(`${base}/reconciliations`, {
      cashAccountId: cash['Bank'],
      statementDate: '2026-10-19',
      statementBalance: '0',
    });
    expect(back.status).toBe(400);
    expect((await del(acc, `${base}/reconciliations/${second}`)).status).toBe(409);
    expect((await acc.patch(`${base}/reconciliations/${second}`, { statementBalance: '1' })).status).toBe(
      409,
    );
    const list = (await acc.get(`${base}/reconciliations?cashAccountId=${cash['Bank']}`)).body.data;
    expect(list.map((r: { statementDate: string }) => r.statementDate)).toEqual(['2026-10-19', '2026-10-18']);
    expect((await acc.get('/finance/trial-balance?from=2026-10-01&to=2026-10-31')).body.data.balanced).toBe(
      true,
    );
  });
});

describe('audit and isolation', () => {
  it('audits reconciliations and settlements', async () => {
    const { rows } = await h.admin.query<{ action: string }>(
      `SELECT DISTINCT action FROM audit_events WHERE tenant_id = $1
         AND (action LIKE 'reconciliation.%' OR action = 'cash.card_settled') ORDER BY action`,
      [h.fx.tenantA],
    );
    expect(rows.map((r) => r.action)).toEqual([
      'cash.card_settled',
      'reconciliation.abandoned',
      'reconciliation.completed',
      'reconciliation.started',
    ]);
  });

  it('keeps another tenant out', async () => {
    const one = (await acc.get(`${base}/reconciliations`)).body.data[0].id;
    const ownerB = await browser(h).loginActive(h.fx.users.ownerB);
    const baseB = `/properties/${h.fx.propB1}`;
    expect((await ownerB.get(`${base}/reconciliations`)).status).toBe(404);
    expect((await ownerB.get(`${baseB}/reconciliations/${one}`)).status).toBe(404);
    expect((await del(ownerB, `${baseB}/reconciliations/${one}`)).status).toBe(404);
    const steal = await withKey(ownerB, `${baseB}/card-settlements`, {
      clearingAccountId: cash['Card terminal'],
      bankAccountId: cash['Bank'],
      grossAmount: '1',
    });
    expect(steal.status).toBe(404);
  });
});
