/**
 * Phase 6 slice 6.8 — security review (Prompt D): automated probing of every route the API exposes, read from the
 * application's own route table so a new route cannot escape it.
 *
 *   unauthenticated   no session                                   → refused (401/403), never data
 *   cross-tenant      tenant B's owner, using tenant A's real ids  → refused or not found, never data
 *   role bypass       a tenant A user without the route's permission → refused, never data
 *   CSRF              a signed-in session without the CSRF token, or from another origin → 403 before any work
 *   platform          a hotel session on operator routes            → refused
 *
 * No probe may cause a server error. A positive control checks the ids are real: tenant A's owner can read them.
 */
import { randomUUID } from 'node:crypto';
import { buildAccess } from '../src/auth/access';
import type { RouteInfo } from '../src/openapi/routes';
import { collectRoutes } from '../src/openapi/routes';
import type { Permission, RoleCode } from '@innpilot/contracts';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { browser, ORIGIN, startHarness, type BrowserClient, type FixtureUser, type Harness } from './harness';

let h: Harness;
let ownerA: BrowserClient;
let ownerB: BrowserClient;
const ids: Record<string, string> = {};
const clients = new Map<string, BrowserClient>();
const routes = collectRoutes();

/** Path parameter → which tenant A record fills it, keyed by the segment before it ("guests/{id}"). */
const PARAM_TABLES: Record<string, string> = {
  'properties/{propertyId}': 'property',
  'properties/{id}': 'property',
  'room-types/{id}': 'room_types',
  'rooms/{id}': 'rooms',
  'rooms/{roomId}': 'reservation_rooms',
  'guests/{id}': 'guests',
  'documents/{documentId}': 'guest_documents',
  'scans/{scanId}': 'attachments:guest',
  'reservations/{id}': 'reservations',
  'reservations/{reservationId}': 'reservations',
  'stays/{stayId}': 'stays',
  'tasks/{id}': 'housekeeping_tasks',
  'tickets/{id}': 'maintenance_tickets',
  'accounts/{id}': 'accounts',
  'journal-entries/{id}': 'journal_entries',
  'tax-codes/{id}': 'tax_codes',
  'charge-categories/{id}': 'charge_categories',
  'folios/{id}': 'folios',
  'folio-charges/{id}': 'folio_charges',
  'payments/{id}': 'payments',
  'cash-accounts/{id}': 'cash_accounts',
  'cashier-shifts/{id}': 'cashier_shifts',
  'suppliers/{id}': 'suppliers',
  'expenses/{id}': 'expense_vouchers',
  'attachments/{attachmentId}': 'attachments:expense',
  'reconciliations/{id}': 'bank_reconciliations',
  'invoices/{id}': 'invoices',
  'users/{id}': 'users',
  'exports/{id}': 'jobs',
  'sessions/{id}': 'sessions',
};
const LITERALS: Record<string, string> = {
  'periods/{month}': '2026-10',
  'years/{year}': '2025',
  'reports/{report}': 'profit-loss',
  'rates/{rateId}': '',
  'tenants/{tenantId}': '',
  'files/{token}': 'not-a-link',
};

const unresolved = new Set<string>();

/**
 * Valid bodies for routes whose empty-body request would fail validation before the record is looked up, so the
 * cross-tenant probe reaches the lookup itself.
 */
const BODIES: Record<string, () => object> = {
  'PATCH /guests/{id}': () => ({ fullName: 'Probe' }),
  'POST /guests/{id}/documents': () => ({
    documentType: 'cnic',
    issuingCountry: 'PK',
    number: '35202-2222222-2',
  }),
  'POST /guests/{id}/documents/{documentId}/reveal': () => ({ reason: 'probe check' }),
  'POST /guests/{id}/scans/{scanId}/link': () => ({ reason: 'probe check' }),
  'PATCH /finance/accounts/{id}': () => ({ name: 'Probe' }),
  'PUT /finance/journal-entries/{id}': () => ({
    propertyId: h.fx.propB1,
    narration: 'Probe narration',
    lines: [
      { accountId: randomUUID(), debit: '1' },
      { accountId: randomUUID(), credit: '1' },
    ],
  }),
  'POST /finance/journal-entries/{id}/reverse': () => ({ reason: 'probe check' }),
  'PATCH /suppliers/{id}': () => ({ name: 'Probe' }),
  'PUT /users/{id}/roles': () => ({ roles: [{ role: 'front_desk', propertyId: null }] }),
  'POST /users/{id}/status': () => ({ status: 'disabled', reason: 'probe check' }),
  'POST /users/{id}/mfa/reset': () => ({ reason: 'probe check' }),
  'POST /users/{id}/password-reset': () => ({ reason: 'probe check' }),
};

function fill(path: string): string {
  const parts = path.split('/');
  return parts
    .map((seg, i) => {
      if (!seg.startsWith('{')) return seg;
      const key = `${parts[i - 1]}/${seg}`;
      if (key in LITERALS) return LITERALS[key] || ids[key] || randomUUID();
      const id = ids[key];
      if (!id) unresolved.add(key);
      return id ?? randomUUID();
    })
    .join('/');
}

const send = (
  c: BrowserClient | null,
  method: string,
  path: string,
  opts: { csrf?: boolean; origin?: string; body?: object } = {},
) => {
  const agent = c ? c.agent : request(h.app.getHttpServer());
  const m = method.toLowerCase() as 'get' | 'post' | 'put' | 'patch' | 'delete';
  let r = agent[m](`/api/v1${path}`);
  if (method !== 'GET') {
    r = r.set('origin', opts.origin ?? ORIGIN).set('idempotency-key', randomUUID());
    if (c && opts.csrf !== false) r = r.set('x-csrf-token', c.csrf);
    r = r.send(opts.body ?? {});
  }
  return r;
};

const withKey = (c: BrowserClient, path: string, body: object) =>
  c.agent
    .post(`/api/v1${path}`)
    .set('origin', ORIGIN)
    .set('x-csrf-token', c.csrf)
    .set('idempotency-key', randomUUID())
    .send(body);

/** Activity in tenant A, so the probes use real ids of every kind. */
async function seedTenantA() {
  const base = `/properties/${h.fx.propA1}`;
  const desk = await browser(h).loginActive(h.fx.users.deskA);
  const acc = await browser(h).loginActive(h.fx.users.accountantA);
  const cashier = await browser(h).loginActive(h.fx.users.cashierA);
  const hk = await browser(h).loginActive(h.fx.users.housekeepingA);
  const ok = async (label: string, res: Promise<request.Response>) => {
    const r = await res;
    if (r.status >= 300) {
      process.stdout.write(`seed step "${label}" answered ${r.status}: ${JSON.stringify(r.body?.error)}\n`);
    }
    return r;
  };
  const std = (
    await ok(
      'room type',
      ownerA.post(`${base}/room-types`, {
        code: 'STD',
        name: 'Standard',
        capacityAdults: 2,
        capacityChildren: 0,
        nightlyRate: '5000',
      }),
    )
  ).body.data.id;
  const rooms = (
    await ok('rooms', ownerA.post(`${base}/rooms/bulk`, { from: '101', to: '103', roomTypeId: std }))
  ).body.data;
  const guest = await ok(
    'guest',
    desk.post('/guests', {
      fullName: 'Probe Guest',
      document: { documentType: 'cnic', issuingCountry: 'PK', number: '35202-1111111-1' },
    }),
  );
  await ok(
    'scan',
    desk.upload(
      `/guests/${guest.body.data.id}/scans?fileName=s.jpg`,
      Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]),
      'image/jpeg',
    ),
  );
  const { rows } = await h.admin.query<{ d: string }>(
    `SELECT business_date::text AS d FROM properties WHERE id = $1`,
    [h.fx.propA1],
  );
  const today = rows[0]!.d;
  const next = new Date(Date.parse(today) + 86400000).toISOString().slice(0, 10);
  const booked = await ok(
    'reservation',
    withKey(desk, `${base}/reservations`, {
      guestId: guest.body.data.id,
      source: 'phone',
      rooms: [{ roomTypeId: std, roomId: rooms[0].id, arrival: today, departure: next, adults: 1 }],
    }),
  );
  const reservationId = booked.body.data.id;
  const rrId = booked.body.data.rooms[0].id;
  const stay = await ok(
    'check-in',
    withKey(desk, `${base}/reservations/${reservationId}/rooms/${rrId}/check-in`, {}),
  );
  const folios = (await desk.get(`${base}/reservations/${reservationId}/folios`)).body.data;
  const cat = (await acc.get(`${base}/charge-categories`)).body.data.find(
    (c: { code: string }) => c.code === 'fnb',
  );
  if (folios?.[0] && cat) {
    await ok(
      'charge',
      withKey(desk, `${base}/folios/${folios[0].id}/charges`, {
        categoryId: cat.id,
        description: 'Tea',
        quantity: '1',
        unitPrice: '300',
      }),
    );
  }
  if (stay.status === 200) {
    await ok(
      'check-out',
      withKey(desk, `${base}/stays/${stay.body.data.id}/check-out`, {
        settlements: [{ folioId: folios[0].id, action: 'pay', method: 'card', externalReference: 'PROBE 1' }],
      }),
    );
  }
  await ok(
    'ticket',
    hk.post(`${base}/maintenance/tickets`, {
      roomId: rooms[1].id,
      category: 'plumbing',
      description: 'Probe tap',
    }),
  );
  const cash = Object.fromEntries(
    ((await acc.get(`${base}/cash-accounts`)).body.data as { name: string; id: string }[]).map((c) => [
      c.name,
      c.id,
    ]),
  );
  await ok(
    'shift',
    withKey(cashier, `${base}/cashier-shifts/open`, {
      cashAccountId: cash['Front desk cash'],
      openingCount: '0',
    }),
  );
  const account: Record<string, string> = {};
  for (const a of (await acc.get('/finance/accounts')).body.data) account[a.code] = a.id;
  await ok(
    'journal',
    withKey(acc, '/finance/journal-entries/draft', {
      propertyId: h.fx.propA1,
      narration: 'Probe journal',
      accountingDate: today,
      lines: [
        { accountId: account['6900'], debit: '10' },
        { accountId: account['3000'], credit: '10' },
      ],
    }),
  );
  await ok(
    'tax code',
    acc.post(`${base}/tax-codes`, {
      code: 'PRB',
      name: 'Probe tax',
      firstRate: { effectiveFrom: today, ratePercent: '5' },
    }),
  );
  await ok('supplier', acc.post('/suppliers', { name: 'Probe Supplier' }));
  const expense = await ok(
    'expense',
    withKey(acc, `${base}/expenses`, {
      kind: 'cash',
      expenseDate: today,
      description: 'Probe expense',
      cashAccountId: cash['Front desk cash'],
      lines: [{ accountId: account['6900'], amount: '100' }],
    }),
  );
  await ok(
    'expense attachment',
    acc.upload(
      `${base}/expenses/${expense.body.data.id}/attachments?fileName=r.pdf`,
      Buffer.from('%PDF-1.4\n%%EOF\n'),
      'application/pdf',
    ),
  );
  await ok(
    'reconciliation',
    acc.post(`${base}/reconciliations`, {
      cashAccountId: cash['Bank'],
      statementDate: today,
      statementBalance: '0',
    }),
  );
  await ok(
    'export',
    acc.post('/exports', {
      report: 'profit-loss',
      format: 'csv',
      query: { from: '2026-10-01', to: today, propertyId: h.fx.propA1 },
    }),
  );

  // One tenant A id per kind, straight from the database.
  ids['properties/{propertyId}'] = h.fx.propA1;
  ids['properties/{id}'] = h.fx.propA1;
  for (const [key, table] of Object.entries(PARAM_TABLES)) {
    if (table === 'property') continue;
    const [name, owner] = table.split(':');
    const where = owner ? `AND owner_type = '${owner}'` : '';
    const r = await h.admin.query<{ id: string }>(
      `SELECT id FROM ${name} WHERE tenant_id = $1 ${where} LIMIT 1`,
      [h.fx.tenantA],
    );
    if (r.rows[0]) ids[key] = r.rows[0].id;
  }
  const rate = await h.admin
    .query<{ id: string }>(`SELECT id FROM room_type_rates WHERE tenant_id = $1 LIMIT 1`, [h.fx.tenantA])
    .catch(() => ({ rows: [] }));
  if (rate.rows[0]) ids['rates/{rateId}'] = rate.rows[0].id;
  ids['tenants/{tenantId}'] = h.fx.tenantA;
}

type Outcome = { route: string; probe: string; status: number };
const outcomes: Outcome[] = [];

beforeAll(async () => {
  h = await startHarness();
  ownerA = await browser(h).loginActive(h.fx.users.ownerA);
  ownerB = await browser(h).loginActive(h.fx.users.ownerB);
  await seedTenantA();
}, 180_000);

afterAll(async () => {
  await h?.close();
});

async function sessionFor(name: keyof Harness['fx']['users']): Promise<BrowserClient> {
  if (!clients.has(name)) clients.set(name, await browser(h).loginActive(h.fx.users[name]));
  return clients.get(name)!;
}

const isPlatform = (r: RouteInfo) => r.policy?.kind === 'platform';
const isPublic = (r: RouteInfo) => r.policy?.kind === 'public';
const tenantRoutes = routes.filter((r) => !isPlatform(r) && !isPublic(r));

describe('every route', () => {
  it('has a declared access policy', () => {
    expect(routes.filter((r) => !r.policy).map((r) => r.key)).toEqual([]);
    expect(routes.length).toBeGreaterThan(190);
  });

  it('refuses requests without a session', async () => {
    for (const r of [...tenantRoutes, ...routes.filter(isPlatform)]) {
      const res = await send(null, r.method, fill(r.path));
      outcomes.push({ route: r.key, probe: 'unauthenticated', status: res.status });
    }
    const bad = outcomes.filter((o) => o.probe === 'unauthenticated' && ![401, 403].includes(o.status));
    expect(bad).toEqual([]);
  });

  it("refuses tenant B's owner every tenant A record", async () => {
    // Routes that carry a tenant A id; the others only ever answer with the caller's own tenant.
    // Literal parameters (a month, a year, a report name) are not tenant A records: tenant B rightly reads its own.
    const literalOnly = (path: string) =>
      [...path.matchAll(/([^/]+)\/(\{[^}]+\})/g)].every(([, seg, p]) => `${seg}/${p}` in LITERALS);
    const scoped = tenantRoutes.filter(
      (r) => /\{/.test(r.path) && !r.path.startsWith('/auth/sessions') && !literalOnly(r.path),
    );
    for (const r of scoped) {
      const res =
        r.key === 'POST /guests/{id}/scans'
          ? await ownerB.upload(
              `${fill(r.path)}?fileName=x.jpg`,
              Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9]),
              'image/jpeg',
            )
          : await send(ownerB, r.method, fill(r.path), { body: BODIES[r.key]?.() });
      outcomes.push({ route: r.key, probe: 'cross-tenant', status: res.status });
    }
    const leaked = outcomes.filter((o) => o.probe === 'cross-tenant' && (o.status < 300 || o.status >= 500));
    expect(leaked).toEqual([]);
  });

  it('refuses every role that lacks the route permission', async () => {
    const candidates: (keyof Harness['fx']['users'])[] = [
      'deskA',
      'housekeepingA',
      'auditorA',
      'cashierA',
      'accountantA',
      'managerA1',
    ];
    const access = new Map<string, ReturnType<typeof buildAccess>>();
    const properties = [h.fx.propA1, h.fx.propA2];
    for (const name of candidates) {
      const u = h.fx.users[name] as FixtureUser;
      const { rows } = await h.admin.query<{ role: RoleCode; property_id: string | null }>(
        'SELECT role_code AS role, property_id FROM user_roles WHERE user_id = $1',
        [u.id],
      );
      access.set(
        name,
        buildAccess(
          rows.map((x) => ({ role: x.role, propertyId: x.property_id })),
          properties,
        ),
      );
    }
    const allowed = (name: string, r: RouteInfo): boolean => {
      if (r.policy?.kind !== 'permission') return true;
      const a = access.get(name)!;
      const p = r.policy.permission as Permission;
      if (r.policy.scope === 'tenant') return a.tenantWidePermissions.has(p);
      if (r.policy.scope === 'any') return [...a.permissionsByProperty.values()].some((s) => s.has(p));
      return !!a.permissionsByProperty.get(h.fx.propA1)?.has(p);
    };
    for (const r of tenantRoutes.filter((x) => x.policy?.kind === 'permission')) {
      const name = candidates.find((n) => !allowed(n, r));
      if (!name) {
        outcomes.push({ route: r.key, probe: 'role: every role holds it', status: 0 });
        continue;
      }
      const res = await send(await sessionFor(name), r.method, fill(r.path));
      outcomes.push({ route: r.key, probe: `role (${name})`, status: res.status });
    }
    const bypassed = outcomes.filter(
      (o) => o.probe.startsWith('role (') && (o.status < 300 || o.status >= 500),
    );
    expect(bypassed).toEqual([]);
  });

  it('refuses state changes without the CSRF token or from another origin', async () => {
    const unsafe = tenantRoutes.filter((r) => r.method !== 'GET');
    for (const r of unsafe) {
      const noToken = await send(ownerA, r.method, fill(r.path), { csrf: false });
      const foreign = await send(ownerA, r.method, fill(r.path), { origin: 'https://attacker.example' });
      outcomes.push({ route: r.key, probe: 'csrf: no token', status: noToken.status });
      outcomes.push({ route: r.key, probe: 'csrf: foreign origin', status: foreign.status });
      expect([r.key, noToken.body.error?.code]).toEqual([r.key, 'CSRF_FAILED']);
      expect([r.key, foreign.body.error?.code]).toEqual([r.key, 'CSRF_FAILED']);
    }
  });

  it('refuses hotel sessions on platform routes', async () => {
    for (const r of routes.filter(isPlatform)) {
      const res = await send(ownerA, r.method, fill(r.path));
      outcomes.push({ route: r.key, probe: 'platform: hotel session', status: res.status });
      expect([r.key, res.status < 300 || res.status >= 500]).toEqual([r.key, false]);
    }
  });

  it("uses real ids: tenant A's owner can read them (positive control)", async () => {
    const reads = tenantRoutes.filter(
      (r) =>
        r.method === 'GET' && /\{/.test(r.path) && !r.path.includes('{token}') && !r.path.includes('/export'),
    );
    const results: Outcome[] = [];
    for (const r of reads) {
      const res = await send(ownerA, 'GET', fill(r.path));
      results.push({ route: r.key, probe: 'owner A read', status: res.status });
    }
    const ok = results.filter((o) => o.status === 200).length;
    process.stdout.write(
      `\nSECURITY PROBE SUMMARY\n${JSON.stringify(
        {
          routes: routes.length,
          probes: outcomes.length,
          byProbe: Object.entries(
            outcomes.reduce<Record<string, Record<number, number>>>((acc, o) => {
              const k = o.probe.replace(/ \(.*\)$/, '');
              acc[k] ??= {};
              acc[k][o.status] = (acc[k][o.status] ?? 0) + 1;
              return acc;
            }, {}),
          ),
          positiveControl: { reads: results.length, ok, notOk: results.filter((o) => o.status !== 200) },
          crossTenantNot404: outcomes.filter((o) => o.probe === 'cross-tenant' && o.status !== 404),
          unresolvedParams: [...unresolved],
          serverErrors: outcomes.filter((o) => o.status >= 500),
        },
        null,
        1,
      )}\n`,
    );
    expect(outcomes.filter((o) => o.status >= 500)).toEqual([]);
    expect(results.filter((o) => o.status >= 500)).toEqual([]);
    expect(ok / results.length).toBeGreaterThan(0.9);
  });
});
