/**
 * A 100-room hotel with a year of fictional activity (P5-16), shared by the report performance test and the
 * restore drill (6.5). Written with SQL in one transaction (about 25,000 room nights through the API would take
 * hours), as posted, balanced journals with the folio documents that go with them: the database's own guards still
 * check every entry at commit (balance, open period, cash dimension). Guests are "Perf Guest nnnn": no real data.
 */
import { randomUUID } from 'node:crypto';
import type { BrowserClient, Harness } from '../test/harness';

export interface Seeded {
  reservations: number;
  roomNights: number;
  journals: number;
  lines: number;
  auditEvents: number;
}

const DAY = 86_400_000;
const START = Date.parse('2025-10-19T00:00:00Z');
const NIGHTS = 365; // 2025-10-19 … 2026-10-18; the business date is 2026-10-19.
const date = (d: number) => new Date(START + d * DAY).toISOString().slice(0, 10);
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const reference = (n: number) => {
  let s = '';
  for (let i = 0, v = n; i < 7; i++, v = Math.floor(v / ALPHABET.length))
    s = ALPHABET[v % ALPHABET.length] + s;
  return `P${s}`;
};

/** Inserts rows column-wise through unnest, in chunks. */
async function bulk(h: Harness, table: string, columns: [name: string, type: string][], rows: unknown[][]) {
  for (let i = 0; i < rows.length; i += 5000) {
    const chunk = rows.slice(i, i + 5000);
    const params = columns.map((_, c) => chunk.map((r) => r[c]));
    await h.admin.query(
      `INSERT INTO ${table} (${columns.map(([n]) => n).join(', ')})
       SELECT * FROM unnest(${columns.map(([, t], c) => `$${c + 1}::${t}[]`).join(', ')})`,
      params,
    );
  }
}

export async function seedHundredRoomYear(h: Harness, owner: BrowserClient): Promise<Seeded> {
  const base = `/properties/${h.fx.propA1}`;
  const tenant = h.fx.tenantA;
  const property = h.fx.propA1;
  const userId = h.fx.users.ownerA.id;

  const std = (
    await owner.post(`${base}/room-types`, {
      code: 'STD',
      name: 'Standard',
      capacityAdults: 2,
      capacityChildren: 0,
      nightlyRate: '8000',
    })
  ).body.data.id as string;
  const rooms: string[] = [];
  for (const [from, to] of [
    ['101', '150'],
    ['201', '250'],
  ]) {
    const res = await owner.post(`${base}/rooms/bulk`, { from, to, roomTypeId: std });
    if (res.status !== 201) throw new Error(JSON.stringify(res.body));
    rooms.push(...(res.body.data as { id: string }[]).map((r) => r.id));
  }
  if (rooms.length !== 100) throw new Error(`expected 100 rooms, got ${rooms.length}`);
  const account: Record<string, string> = {};
  for (const a of (await owner.get('/finance/accounts')).body.data) account[a.code] = a.id;
  const cash: Record<string, string> = {};
  for (const c of (await owner.get(`${base}/cash-accounts`)).body.data) cash[c.name] = c.id;

  await h.admin.query('BEGIN');
  // Monthly periods for the year.
  for (let m = 0; m <= 12; m++) {
    const start = new Date(Date.UTC(2025, 9 + m, 1));
    const end = new Date(Date.UTC(2025, 10 + m, 0));
    await h.admin.query(
      `INSERT INTO fiscal_periods (tenant_id, start_date, end_date) VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id, start_date) DO NOTHING`,
      [tenant, start.toISOString().slice(0, 10), end.toISOString().slice(0, 10)],
    );
  }
  const periods = (
    await h.admin.query<{ id: string; m: string }>(
      `SELECT id, to_char(start_date, 'YYYY-MM') AS m FROM fiscal_periods WHERE tenant_id = $1`,
      [tenant],
    )
  ).rows;
  const period = (d: string) => periods.find((p) => p.m === d.slice(0, 7))!.id;

  // Guests.
  const guests = Array.from({ length: 3000 }, (_, i) => [
    randomUUID(),
    tenant,
    `Perf Guest ${String(i + 1).padStart(4, '0')}`,
  ]);
  await bulk(
    h,
    'guests',
    [
      ['id', 'uuid'],
      ['tenant_id', 'uuid'],
      ['full_name', 'text'],
    ],
    guests,
  );

  // Two-night stays with a night between them in every room: about two thirds occupancy.
  const reservations: unknown[][] = [];
  const reservationRooms: unknown[][] = [];
  const folios: unknown[][] = [];
  const nightsOf: { rr: string; night: number }[] = [];
  const stays: {
    folio: string;
    reservation: string;
    departure: number;
    onAccount: boolean;
    bank: boolean;
  }[] = [];
  let n = 0;
  for (let r = 0; r < rooms.length; r++) {
    for (let d = r % 3; d + 2 <= NIGHTS; d += 3) {
      const id = randomUUID();
      const rr = randomUUID();
      const folio = randomUUID();
      const guest = guests[n % guests.length]![0];
      reservations.push([id, tenant, property, reference(n), guest, 'phone', 'checked_out']);
      reservationRooms.push([
        rr,
        tenant,
        property,
        id,
        std,
        rooms[r],
        date(d),
        date(d + 2),
        1,
        '8000',
        'PKR',
      ]);
      // One stay in twenty is left on account (unpaid) so the receivables report has something to age.
      const onAccount = n % 20 === 0;
      folios.push([
        folio,
        tenant,
        property,
        id,
        guest,
        true,
        onAccount ? 'on_account' : 'settled',
        'PKR',
        new Date(START + (d + 2) * DAY),
      ]);
      nightsOf.push({ rr, night: d }, { rr, night: d + 1 });
      stays.push({ folio, reservation: id, departure: d + 2, onAccount, bank: n % 2 === 0 });
      n++;
    }
  }
  await bulk(
    h,
    'reservations',
    [
      ['id', 'uuid'],
      ['tenant_id', 'uuid'],
      ['property_id', 'uuid'],
      ['booking_reference', 'text'],
      ['guest_id', 'uuid'],
      ['source', 'text'],
      ['status', 'text'],
    ],
    reservations,
  );
  await bulk(
    h,
    'reservation_rooms',
    [
      ['id', 'uuid'],
      ['tenant_id', 'uuid'],
      ['property_id', 'uuid'],
      ['reservation_id', 'uuid'],
      ['room_type_id', 'uuid'],
      ['room_id', 'uuid'],
      ['arrival', 'date'],
      ['departure', 'date'],
      ['adults', 'int'],
      ['nightly_rate', 'numeric'],
      ['currency_code', 'text'],
    ],
    reservationRooms,
  );
  await bulk(
    h,
    'folios',
    [
      ['id', 'uuid'],
      ['tenant_id', 'uuid'],
      ['property_id', 'uuid'],
      ['reservation_id', 'uuid'],
      ['guest_id', 'uuid'],
      ['is_primary', 'boolean'],
      ['status', 'text'],
      ['currency_code', 'text'],
      ['settled_at', 'timestamptz'],
    ],
    folios,
  );

  // Journals: the nightly accrual (D9), the check-out bill and its payment, and daily expenses.
  const entries: unknown[][] = [];
  const lines: unknown[][] = [];
  let number = 1;
  const entry = (
    d: number,
    narration: string,
    ls: [account: string, debit: string, credit: string, folio?: string, cashAccount?: string][],
  ) => {
    const id = randomUUID();
    const total = ls.reduce((s, l) => s + Number(l[1]), 0).toFixed(2);
    entries.push([
      id,
      tenant,
      property,
      number++,
      'draft',
      date(d),
      period(date(d)),
      'PKR',
      'perf_seed',
      narration,
      total,
      total,
      userId,
      userId,
      new Date(START + d * DAY),
    ]);
    ls.forEach(([a, dr, cr, folio, cashAccount], i) =>
      lines.push([tenant, id, i + 1, account[a], dr, cr, folio ?? null, cashAccount ?? null]),
    );
    return id;
  };
  const accruals: unknown[][] = [];
  for (let d = 0; d < NIGHTS; d++) {
    const tonight = nightsOf.filter((x) => x.night === d);
    if (tonight.length === 0) continue;
    const amount = (tonight.length * 8000).toFixed(2);
    const id = entry(d, `Night audit accrual ${date(d)}`, [
      ['1210', amount, '0'],
      ['4000', '0', amount],
    ]);
    for (const x of tonight)
      accruals.push([tenant, property, x.rr, date(x.night), date(x.night), '8000', account['4000'], id]);
    // Daily running costs paid from the drawer.
    entry(d, `Daily costs ${date(d)}`, [
      ['6100', '3500.00', '0'],
      ['6200', '1800.00', '0'],
      ['6400', '2200.00', '0'],
      ['1000', '0', '7500.00', undefined, cash['Front desk cash']],
    ]);
  }
  // The folio's own documents match its journals, as the application writes them: the room nights billed at
  // check-out, and the payment on every stay not left on account (the restore drill reconciles the two).
  const roomCategory = (
    await h.admin.query<{ id: string }>(
      `SELECT id FROM charge_categories WHERE property_id = $1 AND system_kind = 'room'`,
      [property],
    )
  ).rows[0]!.id;
  const charges: unknown[][] = [];
  const payments: unknown[][] = [];
  for (const s of stays) {
    const billed = entry(s.departure, 'Check-out: room nights billed', [
      ['1200', '16000.00', '0', s.folio],
      ['1210', '0', '16000.00'],
    ]);
    charges.push([
      tenant,
      property,
      s.folio,
      roomCategory,
      'room_night',
      'Room nights',
      date(s.departure - 1),
      2,
      '8000',
      '16000',
      '0',
      '16000',
      billed,
      userId,
    ]);
    if (!s.onAccount) {
      const paid = entry(s.departure, 'Payment at check-out', [
        s.bank
          ? ['1100', '16000.00', '0', undefined, cash['Bank']]
          : ['1000', '16000.00', '0', undefined, cash['Front desk cash']],
        ['1200', '0', '16000.00', s.folio],
      ]);
      payments.push([
        tenant,
        property,
        s.folio,
        s.reservation,
        'payment',
        s.bank ? 'bank_transfer' : 'cash',
        s.bank ? cash['Bank'] : cash['Front desk cash'],
        '16000',
        'PKR',
        date(s.departure),
        `PERF-${payments.length + 1}`,
        paid,
        userId,
      ]);
    }
  }
  await bulk(
    h,
    'journal_entries',
    [
      ['id', 'uuid'],
      ['tenant_id', 'uuid'],
      ['property_id', 'uuid'],
      ['journal_number', 'bigint'],
      ['status', 'text'],
      ['accounting_date', 'date'],
      ['period_id', 'uuid'],
      ['currency_code', 'text'],
      ['source_type', 'text'],
      ['narration', 'text'],
      ['total_debit', 'numeric'],
      ['total_credit', 'numeric'],
      ['created_by', 'uuid'],
      ['posted_by', 'uuid'],
      ['posted_at', 'timestamptz'],
    ],
    entries,
  );
  await bulk(
    h,
    'journal_lines',
    [
      ['tenant_id', 'uuid'],
      ['journal_entry_id', 'uuid'],
      ['line_no', 'smallint'],
      ['account_id', 'uuid'],
      ['debit', 'numeric'],
      ['credit', 'numeric'],
      ['folio_id', 'uuid'],
      ['cash_account_id', 'uuid'],
    ],
    lines,
  );
  // Like the posting service: lines go onto drafts, then the entries are posted (each period checked open).
  await h.admin.query(
    `UPDATE journal_entries SET status = 'posted' WHERE tenant_id = $1 AND source_type = 'perf_seed'`,
    [tenant],
  );
  await bulk(
    h,
    'room_revenue_accruals',
    [
      ['tenant_id', 'uuid'],
      ['property_id', 'uuid'],
      ['reservation_room_id', 'uuid'],
      ['night', 'date'],
      ['business_date', 'date'],
      ['net_amount', 'numeric'],
      ['revenue_account_id', 'uuid'],
      ['journal_entry_id', 'uuid'],
    ],
    accruals,
  );
  await bulk(
    h,
    'folio_charges',
    [
      ['tenant_id', 'uuid'],
      ['property_id', 'uuid'],
      ['folio_id', 'uuid'],
      ['category_id', 'uuid'],
      ['kind', 'text'],
      ['description', 'text'],
      ['service_date', 'date'],
      ['quantity', 'numeric'],
      ['unit_price', 'numeric'],
      ['net_amount', 'numeric'],
      ['tax_amount', 'numeric'],
      ['gross_amount', 'numeric'],
      ['journal_entry_id', 'uuid'],
      ['created_by', 'uuid'],
    ],
    charges,
  );
  await bulk(
    h,
    'payments',
    [
      ['tenant_id', 'uuid'],
      ['property_id', 'uuid'],
      ['folio_id', 'uuid'],
      ['reservation_id', 'uuid'],
      ['kind', 'text'],
      ['method', 'text'],
      ['cash_account_id', 'uuid'],
      ['amount', 'numeric'],
      ['currency_code', 'text'],
      ['business_date', 'date'],
      ['receipt_number', 'text'],
      ['journal_entry_id', 'uuid'],
      ['created_by', 'uuid'],
    ],
    payments,
  );
  // A year of audit log: staff activity every day.
  const audit: unknown[][] = [];
  for (let d = 0; d < NIGHTS; d++) {
    for (let i = 0; i < 80; i++) {
      audit.push([
        tenant,
        property,
        'user',
        userId,
        i % 10 === 0 ? 'auth.login' : 'folio.charge_posted',
        'folio',
        new Date(START + d * DAY + i * 600_000),
      ]);
    }
  }
  await bulk(
    h,
    'audit_events',
    [
      ['tenant_id', 'uuid'],
      ['property_id', 'uuid'],
      ['actor_type', 'text'],
      ['actor_user_id', 'uuid'],
      ['action', 'text'],
      ['entity_type', 'text'],
      ['occurred_at', 'timestamptz'],
    ],
    audit,
  );
  await h.admin.query('COMMIT'); // The deferred balance checks run here.
  await h.admin.query('ANALYZE');
  return {
    reservations: reservations.length,
    roomNights: accruals.length,
    journals: entries.length,
    lines: lines.length,
    auditEvents: audit.length,
  };
}
