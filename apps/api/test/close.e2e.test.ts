/**
 * Phase 4 slice 4.6 — month-end checklist and year-end close. Blockers stop a close, warnings need a reason; the
 * year-end entry zeroes revenue, cost and expense accounts into retained earnings and the trial balance still
 * balances; posting into a closed year is refused; reopening needs the owner and a reason and is audited.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { browser, ORIGIN, startHarness, type BrowserClient, type Harness } from './harness';

let h: Harness;
let acc: BrowserClient;
let owner: BrowserClient;
const account: Record<string, string> = {};

const withKey = (c: BrowserClient, path: string, body: object = {}, key: string = randomUUID()) =>
  c.agent
    .post(`/api/v1${path}`)
    .set('origin', ORIGIN)
    .set('x-csrf-token', c.csrf)
    .set('idempotency-key', key)
    .send(body);
const line = (code: string, debit = '0', credit = '0') => ({ accountId: account[code]!, debit, credit });
async function post(propertyId: string, lines: object[], accountingDate?: string) {
  const d = await withKey(acc, '/finance/journal-entries/draft', {
    propertyId,
    narration: 'Year test entry',
    lines,
    ...(accountingDate ? { accountingDate } : {}),
  });
  if (d.status !== 201) throw new Error(JSON.stringify(d.body));
  return withKey(acc, `/finance/journal-entries/${d.body.data.id}/post`);
}
async function balance(code: string, to = '2026-12-31'): Promise<string> {
  const { rows } = await h.admin.query<{ b: string }>(
    `SELECT coalesce(sum(l.debit - l.credit), 0)::numeric(19,2)::text AS b
     FROM journal_lines l JOIN journal_entries e ON e.id = l.journal_entry_id JOIN accounts a ON a.id = l.account_id
     WHERE a.tenant_id = $1 AND a.code = $2 AND e.status <> 'draft' AND e.accounting_date <= $3`,
    [h.fx.tenantA, code, to],
  );
  return rows[0]!.b;
}

beforeAll(async () => {
  h = await startHarness();
  acc = await browser(h).loginActive(h.fx.users.accountantA);
  owner = await browser(h).loginActive(h.fx.users.ownerA);
  for (const a of (await acc.get('/finance/accounts')).body.data) account[a.code] = a.id;
  // October 2026: room revenue and an expense in one property, other revenue in the second.
  expect((await post(h.fx.propA1, [line('1000', '50000'), line('4000', '0', '50000')])).status).toBe(200);
  expect((await post(h.fx.propA1, [line('6100', '12000'), line('1000', '0', '12000')])).status).toBe(200);
  expect((await post(h.fx.propA2, [line('1000', '8000'), line('4900', '0', '8000')])).status).toBe(200);
});

afterAll(async () => {
  await h?.close();
});

describe('month-end checklist', () => {
  it('lists blockers that stop the close', async () => {
    await withKey(acc, '/finance/journal-entries/draft', {
      propertyId: h.fx.propA1,
      narration: 'Unfinished accrual',
      lines: [line('6100', '10'), line('2300', '0', '10')],
    });
    const res = await acc.get('/finance/periods/2026-10/checklist');
    expect(res.status).toBe(200);
    expect(
      res.body.data.items.map((i: { check: string; severity: string }) => `${i.check}:${i.severity}`),
    ).toEqual(['business_dates_open:blocker', 'business_dates_open:blocker', 'draft_journals:blocker']);
    const refused = await acc.post('/finance/periods/2026-10/close', { reason: 'Close anyway' });
    expect(refused.status).toBe(409);
    expect((await acc.get('/finance/periods')).body.data[0]).toMatchObject({
      month: '2026-10',
      status: 'open',
    });
  });

  it('closes once blockers are gone; warnings need a reason, kept with the month', async () => {
    // The night audits of the rest of the year are not the subject here: move both properties into 2027 directly.
    await h.admin.query(`UPDATE properties SET business_date = '2027-01-02' WHERE tenant_id = $1`, [
      h.fx.tenantA,
    ]);
    const drafts = await h.admin.query<{ id: string }>(
      `SELECT id FROM journal_entries WHERE tenant_id = $1 AND status = 'draft'`,
      [h.fx.tenantA],
    );
    for (const d of drafts.rows) {
      await acc.agent
        .delete(`/api/v1/finance/journal-entries/${d.id}`)
        .set('origin', ORIGIN)
        .set('x-csrf-token', acc.csrf);
    }
    // A bank line in October makes "bank not reconciled" a warning.
    expect(
      (await post(h.fx.propA1, [line('1100', '500'), line('1000', '0', '500')], '2026-10-20')).status,
    ).toBe(200);
    const list = (await acc.get('/finance/periods/2026-10/checklist')).body.data;
    expect(list).toMatchObject({ blockers: 0, warnings: 1 });
    expect(list.items[0]).toMatchObject({ check: 'bank_not_reconciled', label: 'Bank' });
    const noReason = await acc.post('/finance/periods/2026-10/close', {});
    expect(noReason.status).toBe(400);
    expect(noReason.body.error.details[0].path).toBe('reason');
    const closed = await acc.post('/finance/periods/2026-10/close', {
      reason: 'Statement arrives next week',
    });
    expect(closed.status).toBe(200);
    expect(closed.body.data.find((p: { month: string }) => p.month === '2026-10')).toMatchObject({
      status: 'closed',
      closeReason: 'Statement arrives next week',
    });
  });
});

describe('year-end close', () => {
  const key = randomUUID();

  it('needs every month before December closed', async () => {
    const preview = (await acc.get('/finance/years/2026')).body.data;
    expect(preview.status).toBe('open');
    expect(preview.items.filter((i: { check: string }) => i.check === 'months_open')).toHaveLength(10);
    expect(preview.result).toBe('46000.00');
    expect(preview.entries.map((e: { result: string }) => e.result).sort()).toEqual(['38000.00', '8000.00']);
    const refused = await withKey(acc, '/finance/years/2026/close', { reason: 'Year end' });
    expect(refused.status).toBe(409);
  });

  it('posts the closing entries to retained earnings and closes December; the trial balance still balances', async () => {
    for (let m = 1; m <= 11; m++) {
      const month = `2026-${String(m).padStart(2, '0')}`;
      if (month === '2026-10') continue;
      const res = await acc.post(`/finance/periods/${month}/close`, { reason: 'Bank statement pending' });
      expect(res.status).toBe(200);
    }
    const res = await withKey(acc, '/finance/years/2026/close', { reason: 'Bank statement pending' }, key);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'closed', result: '46000.00', items: [] });
    expect(res.body.data.history[0]).toMatchObject({ status: 'closed', closedByName: 'accountant@a.test' });

    // Revenue, cost and expense accounts are zero for 2026; the result sits in retained earnings.
    for (const code of ['4000', '4900', '6100']) expect(await balance(code)).toBe('0.00');
    expect(await balance('3100')).toBe('-46000.00');
    const tb = (await acc.get('/finance/trial-balance?from=2026-01-01&to=2026-12-31')).body.data;
    expect(tb.balanced).toBe(true);
    const periods = (await acc.get('/finance/periods')).body.data;
    expect(periods.find((p: { month: string }) => p.month === '2026-12').status).toBe('closed');

    const replay = await withKey(acc, '/finance/years/2026/close', { reason: 'Bank statement pending' }, key);
    expect(replay.status).toBe(200);
    expect((await withKey(acc, '/finance/years/2026/close', { reason: 'Again' })).status).toBe(409);
  });

  it('refuses posting into the closed year and reopening one of its months on its own', async () => {
    const late = await post(h.fx.propA1, [line('6100', '100'), line('1000', '0', '100')], '2026-12-15');
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('PERIOD_CLOSED');
    // The refused entry stays a draft dated in December; it would block December's next close, so it goes.
    const drafts = await h.admin.query<{ id: string }>(
      `SELECT id FROM journal_entries WHERE tenant_id = $1 AND status = 'draft'`,
      [h.fx.tenantA],
    );
    expect(drafts.rows).toHaveLength(1);
    await acc.agent
      .delete(`/api/v1/finance/journal-entries/${drafts.rows[0]!.id}`)
      .set('origin', ORIGIN)
      .set('x-csrf-token', acc.csrf);
    expect(
      (await post(h.fx.propA1, [line('6100', '100'), line('1000', '0', '100')], '2027-01-02')).status,
    ).toBe(200);
    const month = await acc.post('/finance/periods/2026-12/reopen', { reason: 'Late bill' });
    expect(month.status).toBe(409);
  });

  it('reopens only for the owner with a reason, reversing the closing entries', async () => {
    expect((await withKey(acc, '/finance/years/2026/reopen', { reason: 'Late bill' })).status).toBe(403);
    expect((await withKey(owner, '/finance/years/2026/reopen', {})).status).toBe(400);
    const res = await withKey(owner, '/finance/years/2026/reopen', {
      reason: 'Supplier bill for December found',
    });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('open');
    expect(res.body.data.history[0]).toMatchObject({
      status: 'reopened',
      reopenReason: 'Supplier bill for December found',
    });
    expect(await balance('4000')).toBe('-50000.00');
    expect(await balance('3100')).toBe('0.00');
    // December is open again for the late bill; the year closes again afterwards.
    expect(
      (await post(h.fx.propA1, [line('6100', '1000'), line('2300', '0', '1000')], '2026-12-31')).status,
    ).toBe(200);
    const again = await withKey(owner, '/finance/years/2026/close', { reason: 'Bank statement pending' });
    expect(again.status).toBe(200);
    expect(again.body.data).toMatchObject({ status: 'closed', result: '45000.00' });
    expect(again.body.data.history).toHaveLength(2);
    expect(await balance('3100')).toBe('-45000.00');
    expect((await acc.get('/finance/trial-balance?from=2026-01-01&to=2026-12-31')).body.data.balanced).toBe(
      true,
    );
  });

  it('audits the closes and reopenings, and keeps other tenants out', async () => {
    const { rows } = await h.admin.query<{ action: string; n: number }>(
      `SELECT action, count(*)::int AS n FROM audit_events WHERE tenant_id = $1 AND action LIKE 'fiscal_year.%'
       GROUP BY action ORDER BY action`,
      [h.fx.tenantA],
    );
    expect(Object.fromEntries(rows.map((r) => [r.action, r.n]))).toEqual({
      'fiscal_year.closed': 2,
      'fiscal_year.reopened': 1,
    });
    const ownerB = await browser(h).loginActive(h.fx.users.ownerB);
    const theirs = (await ownerB.get('/finance/years/2026')).body.data;
    expect(theirs).toMatchObject({ status: 'open', entries: [], history: [] });
    const manager = await browser(h).loginActive(h.fx.users.managerA);
    expect((await withKey(manager, '/finance/years/2026/reopen', { reason: 'Not mine' })).status).toBe(403);
  });
});
