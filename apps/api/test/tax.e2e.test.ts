/** Phase 3 slice 3.2 — tax codes, effective-dated rates, charge categories, invoice profile (TAX-001). */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { browser, ORIGIN, startHarness, type BrowserClient, type Harness } from './harness';

let h: Harness;
let acc: BrowserClient;
let base: string;
const cat: Record<string, string> = {};
const account: Record<string, string> = {};
let pst: { id: string; rates: { id: string; effectiveFrom: string }[] };

const del = (c: BrowserClient, path: string) =>
  c.agent.delete(`/api/v1${path}`).set('origin', ORIGIN).set('x-csrf-token', c.csrf);
const preview = (c: BrowserClient, category: string, amount: string, serviceDate?: string) =>
  c.post(`${base}/tax-preview`, {
    categoryId: cat[category],
    amount,
    ...(serviceDate ? { serviceDate } : {}),
  });
const audits = async (action: string) =>
  (
    await h.admin.query<{ changes: unknown }>(
      'SELECT changes FROM audit_events WHERE action = $1 ORDER BY occurred_at',
      [action],
    )
  ).rows;

beforeAll(async () => {
  h = await startHarness();
  acc = await browser(h).loginActive(h.fx.users.accountantA);
  base = `/properties/${h.fx.propA1}`;
  for (const c of (await acc.get(`${base}/charge-categories`)).body.data) cat[c.code] = c.id;
  for (const a of (await acc.get('/finance/accounts')).body.data) account[a.code] = a.id;
});

afterAll(async () => {
  await h?.close();
});

describe('defaults', () => {
  it('starts with charge categories on the revenue accounts and no taxes at all', async () => {
    const cats = (await acc.get(`${base}/charge-categories`)).body.data;
    expect(cats.map((c: { code: string }) => c.code).sort()).toEqual([
      'cancellation',
      'fnb',
      'laundry',
      'meeting',
      'other',
      'room',
      'transport',
    ]);
    expect(cats.find((c: { code: string }) => c.code === 'room')).toMatchObject({
      systemKind: 'room',
      revenueAccountCode: '4000',
      taxCodeIds: [],
    });
    expect((await acc.get(`${base}/tax-codes`)).body.data).toEqual([]);
    const res = await preview(acc, 'room', '12500.50');
    expect(res.body.data).toMatchObject({ net: '12500.50', taxTotal: '0.00', gross: '12500.50', lines: [] });
  });
});

describe('tax codes', () => {
  it('adds a code with its first rate, collected into Taxes payable by default', async () => {
    const res = await acc.post(`${base}/tax-codes`, {
      code: 'pst',
      name: 'Provincial sales tax',
      jurisdiction: 'Punjab',
      firstRate: { effectiveFrom: '2026-10-19', ratePercent: '16' },
    });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      code: 'PST',
      payableAccountCode: '2200',
      currentRate: { ratePercent: '16', inclusive: false, effectiveFrom: '2026-10-19' },
    });
    pst = res.body.data;
    expect(await audits('tax_code.created')).toHaveLength(1);
  });

  it('refuses backdated rates, duplicate codes and non-liability accounts', async () => {
    const backdated = await acc.post(`${base}/tax-codes`, {
      code: 'OLD',
      name: 'Backdated',
      firstRate: { effectiveFrom: '2026-10-01', ratePercent: '5' },
    });
    expect(backdated.status).toBe(400);
    expect(backdated.body.error.details[0].path).toBe('effectiveFrom');
    expect(
      (
        await acc.post(`${base}/tax-codes`, {
          code: 'PST',
          name: 'Again',
          firstRate: { effectiveFrom: '2026-10-19', ratePercent: '5' },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await acc.post(`${base}/tax-codes`, {
          code: 'REV',
          name: 'Into revenue',
          payableAccountId: account['4000'],
          firstRate: { effectiveFrom: '2026-10-19', ratePercent: '5' },
        })
      ).status,
    ).toBe(400);
    expect(
      (await acc.post(`${base}/tax-codes/${pst.id}/rates`, { effectiveFrom: '2026-10-18', ratePercent: '1' }))
        .status,
    ).toBe(400);
  });

  it('applies the category taxes in the preview, rounded to the paisa', async () => {
    const linked = await acc.patch(`${base}/charge-categories/${cat['room']}`, { taxCodeIds: [pst.id] });
    expect(linked.body.data.taxCodeIds).toEqual([pst.id]);
    const res = await preview(acc, 'room', '12500.50');
    expect(res.body.data).toMatchObject({
      serviceDate: '2026-10-19',
      net: '12500.50',
      taxTotal: '2000.08',
      gross: '14500.58',
      lines: [{ code: 'PST', ratePercent: '16', inclusive: false, base: '12500.50', amount: '2000.08' }],
    });
  });

  it('TAX-001: a later rate change leaves earlier dates and the rate history untouched', async () => {
    const added = await acc.post(`${base}/tax-codes/${pst.id}/rates`, {
      effectiveFrom: '2026-11-01',
      ratePercent: '17',
    });
    expect(added.status).toBe(201);
    expect(added.body.data.rates.map((r: { ratePercent: string }) => r.ratePercent)).toEqual(['17', '16']);
    expect(added.body.data.currentRate.ratePercent).toBe('16');

    expect((await preview(acc, 'room', '1000', '2026-10-25')).body.data.taxTotal).toBe('160.00');
    expect((await preview(acc, 'room', '1000', '2026-11-02')).body.data.taxTotal).toBe('170.00');

    // The rate in effect is history: it cannot be removed, and the database refuses edits to any rate.
    const current = added.body.data.rates.find(
      (r: { effectiveFrom: string }) => r.effectiveFrom === '2026-10-19',
    );
    expect((await del(acc, `${base}/tax-codes/${pst.id}/rates/${current.id}`)).status).toBe(409);
    await expect(
      h.admin.query(`UPDATE tax_rates SET rate_percent = 20 WHERE id = $1`, [current.id]),
    ).rejects.toThrow(/not allowed/);

    // A rate not yet in effect can be withdrawn.
    const future = added.body.data.rates.find(
      (r: { effectiveFrom: string }) => r.effectiveFrom === '2026-11-01',
    );
    const removed = await del(acc, `${base}/tax-codes/${pst.id}/rates/${future.id}`);
    expect(removed.status).toBe(200);
    expect((await preview(acc, 'room', '1000', '2026-11-02')).body.data.taxTotal).toBe('160.00');
    expect(await audits('tax_code.rate_added')).toHaveLength(1);
    expect(await audits('tax_code.rate_removed')).toHaveLength(1);
  });

  it('splits inclusive taxes out of the amount', async () => {
    const bed = await acc.post(`${base}/tax-codes`, {
      code: 'BED',
      name: 'Bed tax',
      firstRate: { effectiveFrom: '2026-10-19', ratePercent: '5', inclusive: true },
    });
    await acc.patch(`${base}/charge-categories/${cat['fnb']}`, { taxCodeIds: [bed.body.data.id, pst.id] });
    const res = await preview(acc, 'fnb', '1050');
    // 1050 includes 5% bed tax → net 1000; PST 16% is then added on the net.
    expect(res.body.data).toMatchObject({ net: '1000.00', taxTotal: '210.00', gross: '1210.00' });
    expect(res.body.data.lines.map((l: { code: string; amount: string }) => [l.code, l.amount])).toEqual([
      ['BED', '50.00'],
      ['PST', '160.00'],
    ]);
  });

  it('skips inactive codes and reports codes with no rate in effect yet', async () => {
    const later = await acc.post(`${base}/tax-codes`, {
      code: 'NEW',
      name: 'Starts next month',
      firstRate: { effectiveFrom: '2026-11-01', ratePercent: '2' },
    });
    expect(later.body.data.currentRate).toBeNull();
    await acc.patch(`${base}/charge-categories/${cat['laundry']}`, {
      taxCodeIds: [later.body.data.id, pst.id],
    });
    await acc.patch(`${base}/tax-codes/${pst.id}`, { active: false });
    const res = await preview(acc, 'laundry', '100');
    expect(res.body.data).toMatchObject({ taxTotal: '0.00', notInEffect: ['NEW'] });
    await acc.patch(`${base}/tax-codes/${pst.id}`, { active: true });
    expect((await preview(acc, 'laundry', '100')).body.data.taxTotal).toBe('16.00');
  });
});

describe('charge categories', () => {
  it('adds categories on revenue accounts only and keeps the room category active', async () => {
    const created = await acc.post(`${base}/charge-categories`, {
      code: 'Minibar',
      name: 'Minibar',
      revenueAccountId: account['4100'],
      taxCodeIds: [pst.id],
    });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({
      code: 'minibar',
      revenueAccountCode: '4100',
      taxCodeIds: [pst.id],
    });
    expect(
      (
        await acc.post(`${base}/charge-categories`, {
          code: 'wrong',
          name: 'Wrong',
          revenueAccountId: account['2200'],
        })
      ).status,
    ).toBe(400);
    expect((await acc.patch(`${base}/charge-categories/${cat['room']}`, { active: false })).status).toBe(400);
    // An empty change is refused cleanly (it used to reach the database as an update with nothing to set).
    expect((await acc.patch(`${base}/charge-categories/${cat['room']}`, {})).status).toBe(400);
    expect((await acc.patch(`/finance/accounts/${account['4100']}`, {})).status).toBe(400);
    expect(
      (await acc.patch(`${base}/charge-categories/${cat['meeting']}`, { active: false })).body.data.active,
    ).toBe(false);
  });
});

describe('invoice profile', () => {
  it('stores label/value registration fields and audits the labels without the values', async () => {
    const before = await acc.get(`${base}/invoice-profile`);
    expect(before.body.data).toMatchObject({
      invoicePrefix: 'INV-',
      receiptPrefix: 'RCT-',
      registrationFields: [],
    });
    const res = await acc.put(`${base}/invoice-profile`, {
      legalName: 'A One Hospitality (Pvt) Ltd',
      address: '1 Test Road, Lahore',
      registrationFields: [
        { label: 'NTN', value: '0000000-1' },
        { label: 'PRA registration', value: 'P-000000' },
      ],
      invoicePrefix: 'A1-',
      receiptPrefix: 'A1R-',
      footer: 'Thank you for staying with us.',
    });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ invoicePrefix: 'A1-', updatedByName: 'accountant@a.test' });
    const [audit] = await audits('invoice_profile.updated');
    expect(audit?.changes).toMatchObject({ registrationLabels: ['NTN', 'PRA registration'] });
    expect(JSON.stringify(audit)).not.toContain('0000000-1');
  });
});

describe('tax permissions and isolation', () => {
  it('lets front desk read and preview but not change taxes', async () => {
    const desk = await browser(h).loginActive(h.fx.users.deskA);
    expect((await desk.get(`${base}/charge-categories`)).status).toBe(200);
    expect((await preview(desk, 'room', '100')).status).toBe(200);
    expect(
      (
        await desk.post(`${base}/tax-codes`, {
          code: 'X',
          name: 'X',
          firstRate: { effectiveFrom: '2026-10-19', ratePercent: '1' },
        })
      ).status,
    ).toBe(403);
    expect((await desk.patch(`${base}/charge-categories/${cat['room']}`, { taxCodeIds: [] })).status).toBe(
      403,
    );
    const manager = await browser(h).loginActive(h.fx.users.managerA);
    expect((await manager.put(`${base}/invoice-profile`, { legalName: null })).status).toBe(403);
  });

  it("keeps another tenant out, and refuses tax codes from another tenant's property", async () => {
    const ownerB = await browser(h).loginActive(h.fx.users.ownerB);
    expect((await ownerB.get(`${base}/tax-codes`)).status).toBe(404);
    expect((await ownerB.patch(`${base}/tax-codes/${pst.id}`, { active: false })).status).toBe(404);
    const baseB = `/properties/${h.fx.propB1}`;
    const theirs = (await ownerB.get(`${baseB}/charge-categories`)).body.data[0];
    const res = await ownerB.patch(`${baseB}/charge-categories/${theirs.id}`, { taxCodeIds: [pst.id] });
    expect(res.status).toBe(400);
    expect(
      (await ownerB.post(`${baseB}/tax-preview`, { categoryId: cat['room'], amount: '100' })).status,
    ).toBe(404);
  });
});
