/**
 * Phase 3 slice 3.1 — ledger core through the API: FIN-001, FIN-002, FIN-004, FIN-005, FIN-006, idempotent posting,
 * permissions and tenant isolation.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { browser, ORIGIN, startHarness, type BrowserClient, type Harness } from './harness';

let h: Harness;
let acc: BrowserClient;
const code: Record<string, string> = {};

const withKey = (c: BrowserClient, path: string, body: object = {}, key: string = randomUUID()) =>
  c.agent
    .post(`/api/v1${path}`)
    .set('origin', ORIGIN)
    .set('x-csrf-token', c.csrf)
    .set('idempotency-key', key)
    .send(body);
const del = (c: BrowserClient, path: string) =>
  c.agent.delete(`/api/v1${path}`).set('origin', ORIGIN).set('x-csrf-token', c.csrf);

const line = (c: string, debit = '0', credit = '0') => ({ accountId: code[c]!, debit, credit });
const draft = (lines: object[], extra: object = {}, c: BrowserClient = acc) =>
  withKey(c, '/finance/journal-entries/draft', {
    propertyId: h.fx.propA1,
    narration: 'Opening cash float',
    lines,
    ...extra,
  });
const postEntry = (id: string, key?: string, c: BrowserClient = acc) =>
  withKey(c, `/finance/journal-entries/${id}/post`, {}, key);

async function posted(lines: object[], extra: object = {}) {
  const d = await draft(lines, extra);
  if (d.status !== 201) throw new Error(JSON.stringify(d.body));
  const p = await postEntry(d.body.data.id);
  if (p.status !== 200) throw new Error(JSON.stringify(p.body));
  return p.body.data;
}

const audits = async (action: string, entityId: string) =>
  (
    await h.admin.query<{ reason: string | null }>(
      'SELECT reason FROM audit_events WHERE action = $1 AND entity_id = $2',
      [action, entityId],
    )
  ).rows;

beforeAll(async () => {
  h = await startHarness();
  acc = await browser(h).loginActive(h.fx.users.accountantA);
  const res = await acc.get('/finance/accounts');
  for (const a of res.body.data) code[a.code] = a.id;
});

afterAll(async () => {
  await h?.close();
});

describe('chart of accounts', () => {
  it('starts every tenant with the template, system accounts marked', async () => {
    const res = await acc.get('/finance/accounts');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(45);
    expect(res.body.data.find((a: { code: string }) => a.code === '1200')).toMatchObject({
      name: 'Guest receivables',
      accountClass: 'asset',
      normalBalance: 'debit',
      systemRole: 'guest_receivable',
    });
  });

  it('adds, renames and deactivates accounts, with checks and an audit trail', async () => {
    const created = await acc.post('/finance/accounts', {
      code: '6150',
      name: 'Water',
      accountClass: 'expense',
      parentId: code['6100'],
    });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({
      normalBalance: 'debit',
      parentId: code['6100'],
      systemRole: null,
    });
    code['6150'] = created.body.data.id;

    expect(
      (await acc.post('/finance/accounts', { code: '6150', name: 'Again', accountClass: 'expense' })).status,
    ).toBe(400);
    expect(
      (await acc.post('/finance/accounts', { code: '4150', name: 'X', accountClass: 'expense' })).status,
    ).toBe(400);
    expect(
      (
        await acc.post('/finance/accounts', {
          code: '6160',
          name: 'X',
          accountClass: 'expense',
          parentId: code['4000'],
        })
      ).status,
    ).toBe(400);

    const renamed = await acc.patch(`/finance/accounts/${code['1000']}`, { name: 'Front office cash' });
    expect(renamed.body.data.name).toBe('Front office cash');
    expect((await acc.patch(`/finance/accounts/${code['1200']}`, { active: false })).status).toBe(400);
    expect((await acc.patch(`/finance/accounts/${code['6150']}`, { active: false })).body.data.active).toBe(
      false,
    );
    expect(await audits('account.updated', code['1000']!)).toHaveLength(1);
  });

  it('refuses inactive accounts in journals', async () => {
    const res = await draft([line('6150', '100'), line('1000', '0', '100')]);
    expect(res.status).toBe(400);
    await acc.patch(`/finance/accounts/${code['6150']}`, { active: true });
  });
});

describe('journals', () => {
  it('FIN-002: posts a balanced journal once, numbered, with an audit event', async () => {
    const d = await draft([line('1000', '50000'), line('3000', '0', '50000')]);
    expect(d.status).toBe(201);
    expect(d.body.data).toMatchObject({ status: 'draft', journalNumber: null, accountingDate: '2026-10-19' });

    const key = randomUUID();
    const res = await postEntry(d.body.data.id, key);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      status: 'posted',
      journalNumber: 1,
      totalDebit: '50000.00',
      totalCredit: '50000.00',
      postedByName: 'accountant@a.test',
    });
    expect(res.body.data.lines.map((l: { accountCode: string }) => l.accountCode)).toEqual(['1000', '3000']);

    const replay = await postEntry(d.body.data.id, key);
    expect(replay.body.data.journalNumber).toBe(1);
    expect((await postEntry(d.body.data.id)).status).toBe(409);
    expect(await audits('journal.posted', d.body.data.id)).toHaveLength(1);
  });

  it('FIN-001: rejects an unbalanced journal, leaves the draft as it was and uses no number', async () => {
    const d = await draft([line('6100', '1200'), line('1000', '0', '1100')]);
    expect(d.status).toBe(201);
    const res = await postEntry(d.body.data.id);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('JOURNAL_UNBALANCED');
    expect(res.body.error.message).toMatch(/1200\.00.*1100\.00/);
    expect((await acc.get(`/finance/journal-entries/${d.body.data.id}`)).body.data.status).toBe('draft');

    // Fix the draft and post: the next number follows on without a gap.
    const fixed = await acc.put(`/finance/journal-entries/${d.body.data.id}`, {
      propertyId: h.fx.propA1,
      narration: 'Electricity bill',
      lines: [line('6100', '1200'), line('1000', '0', '1200')],
    });
    expect(fixed.status).toBe(200);
    expect((await postEntry(d.body.data.id)).body.data.journalNumber).toBe(2);
  });

  it('posts one journal for many simultaneous retries of the same request (FIN-003 pattern)', async () => {
    const d = await draft([line('1100', '700'), line('4900', '0', '700')]);
    const key = randomUUID();
    const results = await Promise.all(Array.from({ length: 5 }, () => postEntry(d.body.data.id, key)));
    const ok = results.filter((r) => r.status === 200);
    expect(ok.length).toBeGreaterThanOrEqual(1);
    expect(new Set(ok.map((r) => r.body.data.journalNumber)).size).toBe(1);
    expect(results.every((r) => r.status === 200 || r.status === 409)).toBe(true);
    expect(await audits('journal.posted', d.body.data.id)).toHaveLength(1);
  });

  it('refuses future-dated entries', async () => {
    const res = await draft([line('1000', '1'), line('4900', '0', '1')], { accountingDate: '2026-10-25' });
    expect(res.status).toBe(400);
  });

  it('FIN-004: never edits or deletes a posted journal; reverses it with an equal and opposite entry', async () => {
    const original = await posted([line('6300', '2500'), line('1000', '0', '2500')], {
      narration: 'Plumber',
    });
    const body = {
      propertyId: h.fx.propA1,
      narration: 'Changed',
      lines: [line('6300', '1'), line('1000', '0', '1')],
    };
    expect((await acc.put(`/finance/journal-entries/${original.id}`, body)).status).toBe(409);
    expect((await del(acc, `/finance/journal-entries/${original.id}`)).status).toBe(409);

    expect((await withKey(acc, `/finance/journal-entries/${original.id}/reverse`, {})).status).toBe(400);
    const res = await withKey(acc, `/finance/journal-entries/${original.id}/reverse`, {
      reason: 'Bill was for the neighbouring property',
    });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      status: 'posted',
      sourceType: 'reversal',
      reversesEntryId: original.id,
      reversesNumber: original.journalNumber,
      totalDebit: '2500.00',
    });
    expect(
      res.body.data.lines.map((l: { accountCode: string; debit: string; credit: string }) => l),
    ).toMatchObject([
      { accountCode: '6300', debit: '0.00', credit: '2500.00' },
      { accountCode: '1000', debit: '2500.00', credit: '0.00' },
    ]);
    const after = await acc.get(`/finance/journal-entries/${original.id}`);
    expect(after.body.data).toMatchObject({ status: 'reversed', reversedById: res.body.data.id });
    expect(after.body.data.lines).toEqual(original.lines);
    expect((await audits('journal.reversed', original.id))[0]?.reason).toBe(
      'Bill was for the neighbouring property',
    );

    expect(
      (await withKey(acc, `/finance/journal-entries/${original.id}/reverse`, { reason: 'Again please' }))
        .status,
    ).toBe(409);
    expect(
      (
        await withKey(acc, `/finance/journal-entries/${res.body.data.id}/reverse`, {
          reason: 'Undo the undo',
        })
      ).status,
    ).toBe(409);
  });

  it('deletes drafts, with an audit event', async () => {
    const d = await draft([line('1000', '5'), line('4900', '0', '5')]);
    expect((await del(acc, `/finance/journal-entries/${d.body.data.id}`)).status).toBe(200);
    expect((await acc.get(`/finance/journal-entries/${d.body.data.id}`)).status).toBe(404);
    expect(await audits('journal.draft_deleted', d.body.data.id)).toHaveLength(1);
  });
});

describe('periods', () => {
  it('FIN-005: blocks posting into a closed month until it is reopened with a reason (audited)', async () => {
    const d = await draft([line('1000', '300'), line('4900', '0', '300')]);
    const close = await acc.post('/finance/periods/2026-10/close');
    expect(close.status).toBe(200);
    expect(close.body.data.find((p: { month: string }) => p.month === '2026-10')).toMatchObject({
      status: 'closed',
      closedByName: 'accountant@a.test',
    });
    expect((await acc.post('/finance/periods/2026-10/close')).status).toBe(409);

    const blocked = await postEntry(d.body.data.id);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('PERIOD_CLOSED');

    expect((await acc.post('/finance/periods/2026-10/reopen', {})).status).toBe(400);
    const reopen = await acc.post('/finance/periods/2026-10/reopen', {
      reason: 'Late supplier bill to record',
    });
    expect(reopen.status).toBe(200);
    const [period] = (
      await h.admin.query<{ id: string }>(
        `SELECT id FROM fiscal_periods WHERE tenant_id = $1 AND start_date = '2026-10-01'`,
        [h.fx.tenantA],
      )
    ).rows;
    expect((await audits('period.reopened', period!.id))[0]?.reason).toBe('Late supplier bill to record');
    expect((await postEntry(d.body.data.id)).status).toBe(200);
  });

  it('lists the last twelve months with entry counts', async () => {
    const res = await acc.get('/finance/periods');
    expect(res.body.data).toHaveLength(12);
    expect(res.body.data[0]).toMatchObject({ month: '2026-10', status: 'open' });
    expect(res.body.data[0].postedEntries).toBeGreaterThan(0);
  });
});

describe('reports', () => {
  it('FIN-006: the trial balance covers every account and balances', async () => {
    const res = await acc.get('/finance/trial-balance?from=2026-10-01&to=2026-10-31');
    expect(res.status).toBe(200);
    expect(res.body.data.rows).toHaveLength(46);
    expect(res.body.data.balanced).toBe(true);
    expect(res.body.data.totals.debit).toBe(res.body.data.totals.credit);
    const cash = res.body.data.rows.find((r: { code: string }) => r.code === '1000');
    // 50,000 float − 1,200 electricity − 2,500 plumber + 2,500 reversal + 300.
    expect(cash).toMatchObject({ closingDebit: '49100.00', closingCredit: '0.00' });
    const plumbing = res.body.data.rows.find((r: { code: string }) => r.code === '6300');
    expect(plumbing).toMatchObject({ debit: '2500.00', credit: '2500.00', closingDebit: '0.00' });

    // Same filters, same ledger: same answer.
    const again = await acc.get('/finance/trial-balance?from=2026-10-01&to=2026-10-31');
    expect(again.body.data).toEqual(res.body.data);

    // Before any posting, everything is zero and the movement moves into the opening balance.
    const later = await acc.get('/finance/trial-balance?from=2026-11-01&to=2026-11-30');
    expect(later.body.data.rows.find((r: { code: string }) => r.code === '1000')).toMatchObject({
      openingDebit: '49100.00',
      debit: '0.00',
      closingDebit: '49100.00',
    });
  });

  it('shows an account ledger with a running balance', async () => {
    const res = await acc.get(`/finance/ledger?accountId=${code['1000']}&from=2026-10-01&to=2026-10-31`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ openingBalance: '0.00', closingBalance: '49100.00' });
    expect(res.body.data.lines.map((l: { balance: string }) => l.balance)).toEqual([
      '50000.00',
      '48800.00',
      '46300.00',
      '48800.00',
      '49100.00',
    ]);
  });

  it('never counts drafts', async () => {
    await draft([line('1000', '999999'), line('4900', '0', '999999')]);
    const res = await acc.get(`/finance/ledger?accountId=${code['1000']}&from=2026-10-01&to=2026-10-31`);
    expect(res.body.data.closingBalance).toBe('49100.00');
  });
});

describe('ledger permissions and isolation', () => {
  it('lets managers and auditors read but not post, and keeps front desk out', async () => {
    const manager = await browser(h).loginActive(h.fx.users.managerA);
    expect((await manager.get('/finance/trial-balance?from=2026-10-01&to=2026-10-31')).status).toBe(200);
    expect((await draft([line('1000', '1'), line('4900', '0', '1')], {}, manager)).status).toBe(403);
    expect((await manager.post('/finance/periods/2026-10/close')).status).toBe(403);
    expect(
      (await manager.post('/finance/accounts', { code: '6170', name: 'X', accountClass: 'expense' })).status,
    ).toBe(403);

    const auditor = await browser(h).loginActive(h.fx.users.auditorA);
    expect((await auditor.get('/finance/journal-entries')).status).toBe(200);
    const list = await acc.get('/finance/journal-entries?status=posted');
    expect(
      (
        await withKey(auditor, `/finance/journal-entries/${list.body.data.items[0].id}/reverse`, {
          reason: 'No',
        })
      ).status,
    ).toBe(403);

    const desk = await browser(h).loginActive(h.fx.users.deskA);
    expect((await desk.get('/finance/accounts')).status).toBe(403);
    expect((await desk.get('/finance/trial-balance?from=2026-10-01&to=2026-10-31')).status).toBe(403);

    // A manager assigned to one property only has no tenant-wide ledger access.
    const local = await browser(h).loginActive(h.fx.users.managerA1);
    expect((await local.get('/finance/accounts')).status).toBe(403);
  });

  it("never shows or posts to another tenant's ledger", async () => {
    const ownerB = await browser(h).loginActive(h.fx.users.ownerB);
    const list = await acc.get('/finance/journal-entries?status=posted');
    const theirs = list.body.data.items[0].id;
    expect((await ownerB.get(`/finance/journal-entries/${theirs}`)).status).toBe(404);
    expect(
      (await withKey(ownerB, `/finance/journal-entries/${theirs}/reverse`, { reason: 'Mine now' })).status,
    ).toBe(404);
    expect(
      (await ownerB.get(`/finance/ledger?accountId=${code['1000']}&from=2026-10-01&to=2026-10-31`)).status,
    ).toBe(404);
    expect((await ownerB.patch(`/finance/accounts/${code['1000']}`, { name: 'Taken' })).status).toBe(404);
    // B's own trial balance is untouched by A's postings.
    const tb = await ownerB.get('/finance/trial-balance?from=2026-10-01&to=2026-10-31');
    expect(tb.body.data.totals.debit).toBe('0.00');
    // A's accounts and property are invisible to B, so a journal using them is refused.
    const res = await withKey(ownerB, '/finance/journal-entries/draft', {
      propertyId: h.fx.propB1,
      narration: 'Using tenant A accounts',
      lines: [line('1000', '10'), line('4900', '0', '10')],
    });
    expect(res.status).toBe(400);
    expect(
      (
        await withKey(ownerB, '/finance/journal-entries/draft', {
          propertyId: h.fx.propA1,
          narration: 'Into tenant A property',
          lines: [line('1000', '10'), line('4900', '0', '10')],
        })
      ).status,
    ).toBe(400);
  });
});
