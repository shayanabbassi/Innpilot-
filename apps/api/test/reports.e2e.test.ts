/**
 * Phase 5 slice 5.1 — profit and loss, balance sheet and the trial balance under the report permission.
 * The financial statements recipe (06 §3): opening balances and transactions give a balanced trial balance, net
 * profit equals the change in equity, assets = liabilities + equity before and after a year-end close, and the same
 * filters twice give the same figures. Drafts never count; reversals net out. Front desk is refused whatever the
 * screen shows (SEC-002); a property-scoped manager sees only their property; other tenants see nothing.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { browser, ORIGIN, startHarness, type BrowserClient, type Harness } from './harness';

let h: Harness;
let acc: BrowserClient;
const account: Record<string, string> = {};

const withKey = (c: BrowserClient, path: string, body: object = {}) =>
  c.agent
    .post(`/api/v1${path}`)
    .set('origin', ORIGIN)
    .set('x-csrf-token', c.csrf)
    .set('idempotency-key', randomUUID())
    .send(body);
const line = (code: string, debit = '0', credit = '0') => ({ accountId: account[code]!, debit, credit });
async function draft(propertyId: string, lines: object[], accountingDate: string): Promise<string> {
  const d = await withKey(acc, '/finance/journal-entries/draft', {
    propertyId,
    narration: 'Report test entry',
    lines,
    accountingDate,
  });
  if (d.status !== 201) throw new Error(JSON.stringify(d.body));
  return d.body.data.id;
}
async function post(propertyId: string, lines: object[], accountingDate: string): Promise<string> {
  const id = await draft(propertyId, lines, accountingDate);
  const res = await withKey(acc, `/finance/journal-entries/${id}/post`);
  if (res.status !== 200) throw new Error(JSON.stringify(res.body));
  return id;
}

type Row = { code: string; amount: string; comparison: string | null };
type Section = { key: string; rows: Row[]; total: { amount: string; comparison: string | null } };
const section = (body: { sections: Section[] }, key: string) => body.sections.find((s) => s.key === key)!;
const codes = (s: { rows: { code: string; amount: string }[] }) => s.rows.map((r) => `${r.code}:${r.amount}`);

beforeAll(async () => {
  h = await startHarness();
  acc = await browser(h).loginActive(h.fx.users.accountantA);
  for (const a of (await acc.get('/finance/accounts')).body.data) account[a.code] = a.id;
  const A1 = h.fx.propA1;
  // Opening position: owner capital in cash, equipment bought with a loan.
  await post(A1, [line('1000', '100000'), line('3000', '0', '100000')], '2026-09-01');
  await post(A1, [line('1500', '60000'), line('2400', '0', '60000')], '2026-09-01');
  // September: room revenue (the comparison period).
  await post(A1, [line('1000', '3000'), line('4000', '0', '3000')], '2026-09-15');
  // October.
  await post(A1, [line('1000', '50000'), line('4000', '0', '50000')], '2026-10-05');
  await post(A1, [line('1000', '6000'), line('4100', '0', '6000')], '2026-10-06');
  await post(A1, [line('5000', '2500'), line('1000', '0', '2500')], '2026-10-07');
  await post(A1, [line('6100', '12000'), line('1000', '0', '12000')], '2026-10-08');
  await post(A1, [line('1000', '1500'), line('7000', '0', '1500')], '2026-10-09');
  await post(A1, [line('7100', '700'), line('1000', '0', '700')], '2026-10-10');
  // A repair posted by mistake and reversed: it nets out of every statement.
  const wrong = await post(A1, [line('6300', '400'), line('1000', '0', '400')], '2026-10-11');
  const rev = await withKey(acc, `/finance/journal-entries/${wrong}/reverse`, {
    reason: 'Posted to the wrong hotel',
    accountingDate: '2026-10-12',
  });
  expect(rev.status).toBe(200);
  // A draft never counts.
  await draft(A1, [line('6100', '999'), line('1000', '0', '999')], '2026-10-13');
  // The second property.
  await post(h.fx.propA2, [line('1000', '8000'), line('4900', '0', '8000')], '2026-10-14');
});

afterAll(async () => {
  await h?.close();
});

const OCT = 'from=2026-10-01&to=2026-10-31';

describe('profit and loss', () => {
  it('shows revenue, costs and expenses with gross, operating and net profit for one property', async () => {
    const res = await acc.get(`/reports/profit-loss?${OCT}&propertyId=${h.fx.propA1}`);
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d).toMatchObject({
      propertyId: h.fx.propA1,
      currencyCode: 'PKR',
      timezone: 'Asia/Karachi',
      compare: 'none',
    });
    expect(codes(section(d, 'revenue'))).toEqual(['4000:50000.00', '4100:6000.00']);
    expect(codes(section(d, 'cost_of_sales'))).toEqual(['5000:2500.00']);
    // The reversed repair (6300) and the draft are not there.
    expect(codes(section(d, 'operating_expense'))).toEqual(['6100:12000.00']);
    expect(codes(section(d, 'other'))).toEqual(['7000:1500.00', '7100:-700.00']);
    expect(d.grossProfit).toEqual({ amount: '53500.00', comparison: null });
    expect(d.operatingProfit.amount).toBe('41500.00');
    expect(d.netProfit.amount).toBe('42300.00');
    expect(d.definitions.revenue).toMatch(/Not cash received/);
  });

  it('covers all properties for a tenant-wide role', async () => {
    const d = (await acc.get(`/reports/profit-loss?${OCT}`)).body.data;
    expect(d.propertyId).toBeNull();
    expect(codes(section(d, 'revenue'))).toEqual(['4000:50000.00', '4100:6000.00', '4900:8000.00']);
    expect(d.netProfit.amount).toBe('50300.00');
  });

  it('adds a comparison column for the previous period', async () => {
    const d = (await acc.get(`/reports/profit-loss?${OCT}&compare=previous_period&propertyId=${h.fx.propA1}`))
      .body.data;
    expect(d).toMatchObject({ comparisonFrom: '2026-08-31', comparisonTo: '2026-09-30' });
    expect(section(d, 'revenue').rows[0]).toMatchObject({
      code: '4000',
      amount: '50000.00',
      comparison: '3000.00',
    });
    expect(section(d, 'revenue').rows[1]).toMatchObject({ code: '4100', comparison: '0.00' });
    expect(d.netProfit).toEqual({ amount: '42300.00', comparison: '3000.00' });
  });

  it('gives the same figures for the same filters', async () => {
    const strip = (b: { data: { generatedAt?: string } }) => ({ ...b.data, generatedAt: undefined });
    const a = await acc.get(`/reports/profit-loss?${OCT}&compare=previous_year`);
    const b = await acc.get(`/reports/profit-loss?${OCT}&compare=previous_year`);
    expect(strip(a.body)).toEqual(strip(b.body));
    expect(a.body.data).toMatchObject({ comparisonFrom: '2025-10-01', comparisonTo: '2025-10-31' });
  });

  it('refuses an end date before the start date', async () => {
    const res = await acc.get('/reports/profit-loss?from=2026-10-31&to=2026-10-01');
    expect(res.status).toBe(400);
    expect(res.body.error.details[0].path).toBe('to');
  });
});

describe('balance sheet', () => {
  it('balances, with the current-year result in equity', async () => {
    const res = await acc.get(`/reports/balance-sheet?asOf=2026-10-31&propertyId=${h.fx.propA1}`);
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(codes(section(d, 'current_asset'))).toEqual(['1000:145300.00']);
    expect(codes(section(d, 'non_current_asset'))).toEqual(['1500:60000.00']);
    expect(codes(section(d, 'non_current_liability'))).toEqual(['2400:60000.00']);
    expect(codes(section(d, 'equity'))).toEqual(['3000:100000.00']);
    expect(d).toMatchObject({
      currentYearResult: '45300.00',
      earlierYearsResult: '0.00',
      totalAssets: '205300.00',
      totalLiabilities: '60000.00',
      totalEquity: '145300.00',
      totalLiabilitiesAndEquity: '205300.00',
      difference: '0.00',
      balanced: true,
    });
  });

  it('moves by exactly the net profit of the period between two dates', async () => {
    const before = (await acc.get(`/reports/balance-sheet?asOf=2026-09-30&propertyId=${h.fx.propA1}`)).body
      .data;
    const after = (await acc.get(`/reports/balance-sheet?asOf=2026-10-31&propertyId=${h.fx.propA1}`)).body
      .data;
    const pl = (await acc.get(`/reports/profit-loss?${OCT}&propertyId=${h.fx.propA1}`)).body.data;
    expect(before.currentYearResult).toBe('3000.00');
    expect(Number(after.totalEquity) - Number(before.totalEquity)).toBe(Number(pl.netProfit.amount));
    expect(before.balanced).toBe(true);
  });

  it('agrees with the trial balance for all properties', async () => {
    const bs = (await acc.get('/reports/balance-sheet?asOf=2026-10-31')).body.data;
    expect(bs).toMatchObject({ totalAssets: '213300.00', currentYearResult: '53300.00', balanced: true });
    const tb = (await acc.get('/reports/trial-balance?from=2026-01-01&to=2026-10-31')).body.data;
    expect(tb.balanced).toBe(true);
    const cash = tb.rows.find((r: { code: string }) => r.code === '1000');
    expect(cash.closingDebit).toBe('153300.00');
  });
});

describe('year-end close', () => {
  it('shows an unclosed year apart, then in retained earnings once closed; the P&L keeps the result', async () => {
    // The night audits are not the subject here: move the business dates into 2027 directly.
    await h.admin.query(`UPDATE properties SET business_date = '2027-01-05' WHERE tenant_id = $1`, [
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
    await post(h.fx.propA1, [line('1000', '1000'), line('4000', '0', '1000')], '2027-01-03');

    const open = (await acc.get(`/reports/balance-sheet?asOf=2027-01-05&propertyId=${h.fx.propA1}`)).body
      .data;
    expect(open).toMatchObject({
      currentYearResult: '1000.00',
      earlierYearsResult: '45300.00',
      balanced: true,
    });

    for (let m = 1; m <= 11; m++) {
      const res = await acc.post(`/finance/periods/2026-${String(m).padStart(2, '0')}/close`, {
        reason: 'Year end',
      });
      expect(res.status).toBe(200);
    }
    expect((await withKey(acc, '/finance/years/2026/close', { reason: 'Year end' })).status).toBe(200);

    const closed = (await acc.get(`/reports/balance-sheet?asOf=2027-01-05&propertyId=${h.fx.propA1}`)).body
      .data;
    expect(codes(section(closed, 'equity'))).toEqual(['3000:100000.00', '3100:45300.00']);
    expect(closed).toMatchObject({
      currentYearResult: '1000.00',
      earlierYearsResult: '0.00',
      balanced: true,
    });
    expect(closed.totalAssets).toBe(open.totalAssets);
    const yearEnd = (await acc.get(`/reports/balance-sheet?asOf=2026-12-31&propertyId=${h.fx.propA1}`)).body
      .data;
    expect(yearEnd).toMatchObject({ currentYearResult: '0.00', balanced: true });

    // The closing entry dated 31 December is left out of the P&L.
    const year = (
      await acc.get(`/reports/profit-loss?from=2026-01-01&to=2026-12-31&propertyId=${h.fx.propA1}`)
    ).body.data;
    expect(year.netProfit.amount).toBe('45300.00');
  });
});

describe('permissions and isolation', () => {
  it('refuses roles without report.financial whatever the screen shows (SEC-002)', async () => {
    const desk = await browser(h).loginActive(h.fx.users.deskA);
    const cashier = await browser(h).loginActive(h.fx.users.cashierA);
    const hk = await browser(h).loginActive(h.fx.users.housekeepingA);
    for (const c of [desk, cashier, hk]) {
      for (const path of [
        `/reports/profit-loss?${OCT}&propertyId=${h.fx.propA1}`,
        `/reports/balance-sheet?asOf=2026-10-31&propertyId=${h.fx.propA1}`,
        `/reports/trial-balance?${OCT}&propertyId=${h.fx.propA1}`,
      ]) {
        expect((await c.get(path)).status).toBe(403);
      }
    }
  });

  it('limits a property-scoped manager to their property', async () => {
    const m1 = await browser(h).loginActive(h.fx.users.managerA1);
    expect((await m1.get(`/reports/profit-loss?${OCT}&propertyId=${h.fx.propA1}`)).status).toBe(200);
    expect((await m1.get(`/reports/trial-balance?${OCT}&propertyId=${h.fx.propA1}`)).status).toBe(200);
    expect((await m1.get(`/reports/profit-loss?${OCT}&propertyId=${h.fx.propA2}`)).status).toBe(404);
    const all = await m1.get(`/reports/balance-sheet?asOf=2026-10-31`);
    expect(all.status).toBe(403);
    expect((await m1.get(`/reports/trial-balance?${OCT}`)).status).toBe(403);
  });

  it('lets the read-only auditor read every property', async () => {
    const auditor = await browser(h).loginActive(h.fx.users.auditorA);
    expect((await auditor.get(`/reports/profit-loss?${OCT}`)).body.data.netProfit.amount).toBe('50300.00');
  });

  it('shows another tenant nothing', async () => {
    const ownerB = await browser(h).loginActive(h.fx.users.ownerB);
    expect((await ownerB.get(`/reports/profit-loss?${OCT}&propertyId=${h.fx.propA1}`)).status).toBe(404);
    expect(
      (await ownerB.get(`/reports/balance-sheet?asOf=2026-10-31&propertyId=${h.fx.propA1}`)).status,
    ).toBe(404);
    const own = (await ownerB.get(`/reports/profit-loss?${OCT}`)).body.data;
    expect(own.sections.every((s: Section) => s.rows.length === 0)).toBe(true);
    expect((await ownerB.get('/reports/balance-sheet?asOf=2026-10-31')).body.data.totalAssets).toBe('0.00');
  });
});

describe('report groups', () => {
  it('lets the accountant move an account between current and non-current, audited', async () => {
    const res = await acc.patch(`/finance/accounts/${account['1500']}`, { reportGroup: 'current_asset' });
    expect(res.status).toBe(200);
    expect(res.body.data.reportGroup).toBe('current_asset');
    const bs = (await acc.get(`/reports/balance-sheet?asOf=2026-10-31&propertyId=${h.fx.propA1}`)).body.data;
    expect(codes(section(bs, 'current_asset'))).toEqual(['1000:145300.00', '1500:60000.00']);
    expect(bs.totalAssets).toBe('205300.00');
    const audit = await h.admin.query<{ changes: Record<string, unknown> }>(
      `SELECT changes FROM audit_events WHERE tenant_id = $1 AND action = 'account.updated' AND entity_id = $2`,
      [h.fx.tenantA, account['1500']],
    );
    expect(audit.rows[0]!.changes).toMatchObject({
      reportGroup: { from: 'non_current_asset', to: 'current_asset' },
    });
    expect(
      (await acc.patch(`/finance/accounts/${account['1500']}`, { reportGroup: 'non_current_asset' })).status,
    ).toBe(200);
  });

  it('refuses a group that does not fit the class', async () => {
    const res = await acc.patch(`/finance/accounts/${account['4000']}`, { reportGroup: 'current_asset' });
    expect(res.status).toBe(400);
    expect(res.body.error.details[0].path).toBe('reportGroup');
    const create = await acc.post('/finance/accounts', {
      code: '1650',
      name: 'Kitchen equipment',
      accountClass: 'asset',
      reportGroup: 'non_current_asset',
    });
    expect(create.status).toBe(201);
    expect(create.body.data.reportGroup).toBe('non_current_asset');
    const bad = await acc.post('/finance/accounts', {
      code: '2650',
      name: 'Odd',
      accountClass: 'liability',
      reportGroup: 'equity',
    });
    expect(bad.status).toBe(400);
  });
});
