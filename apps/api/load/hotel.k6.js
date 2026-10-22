/* global __ENV, __VU, open, crypto */
/**
 * InnPilot load test (slice 6.7, QA §5). Run by apps/api/perf/load.perf.test.ts, which prepares the 100-room year,
 * the users and their sessions, and checks the database afterwards.
 *
 * Steady load for three minutes, a busy hour at a 100-room hotel and more:
 *   front desk  20 people: arrivals, the room board, availability, bookings, guests, folios; 1 in 8 books a stay
 *               and takes a deposit, retrying the request once as a dropped connection would
 *   cashier      8 people: payments, folios, cash accounts
 *   reporting    4 people: dashboard and reports (heavier; outside the 500 ms target for common reads)
 * Bursts on top:
 *   booking      30 people book the hotel's last free room for the same nights at the same moment
 *   payment      20 retries of one deposit with the same idempotency key at the same moment
 */
import { check, sleep } from 'k6';
import http from 'k6/http';
import { Counter } from 'k6/metrics';

const cfg = JSON.parse(open(__ENV.CONFIG));
const P = `/properties/${cfg.propertyId}`;

// 409 answers are part of the test (a full room, a request already in progress), not failures.
http.setResponseCallback(http.expectedStatuses({ min: 200, max: 299 }, 409));

export const options = {
  scenarios: {
    front_desk: { executor: 'constant-vus', vus: 20, duration: '3m', exec: 'frontDesk' },
    cashier: { executor: 'constant-vus', vus: 8, duration: '3m', exec: 'cashier' },
    reporting: { executor: 'constant-vus', vus: 4, duration: '3m', exec: 'reporting' },
    booking_burst: {
      executor: 'per-vu-iterations',
      vus: 30,
      iterations: 1,
      startTime: '60s',
      exec: 'bookingBurst',
    },
    payment_retry_burst: {
      executor: 'per-vu-iterations',
      vus: 20,
      iterations: 1,
      startTime: '90s',
      exec: 'paymentRetryBurst',
    },
  },
  thresholds: {
    // QA §5: common reads p95 under 500 ms (heavy reports excluded and measured separately).
    'http_req_duration{kind:read}': ['p(95)<500'],
    'http_req_duration{kind:write}': ['p(95)<1000'],
    'http_req_duration{kind:report}': ['p(95)<3000'],
    http_req_failed: ['rate<0.01'],
    checks: ['rate>0.99'],
  },
  summaryTrendStats: ['avg', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

const bookingWins = new Counter('booking_burst_confirmed');
const bookingRefusals = new Counter('booking_burst_refused');

function session(role) {
  const list = cfg.sessions[role];
  return list[(__VU - 1) % list.length];
}

function headers(s, extra = {}) {
  return {
    cookie: s.cookie,
    origin: cfg.origin,
    'x-csrf-token': s.csrf,
    'content-type': 'application/json',
    ...extra,
  };
}

function get(s, path, kind, name) {
  return http.get(`${cfg.baseUrl}/api/v1${path}`, { headers: headers(s), tags: { kind, name } });
}

function post(s, path, body, kind, name, key) {
  return http.post(`${cfg.baseUrl}/api/v1${path}`, JSON.stringify(body), {
    headers: headers(s, key ? { 'idempotency-key': key } : {}),
    tags: { kind, name },
  });
}

const pick = (list) => list[Math.floor(Math.random() * list.length)];
const day = (offset) =>
  new Date(Date.parse(cfg.firstFutureDate) + offset * 86400000).toISOString().slice(0, 10);

export function frontDesk() {
  const s = session('front_desk');
  const r = Math.random();
  if (r < 0.2) {
    check(get(s, `${P}/front-desk/today`, 'read', 'front-desk today'), {
      'front desk 200': (x) => x.status === 200,
    });
  } else if (r < 0.35) {
    check(get(s, `${P}/room-board`, 'read', 'room board'), { 'room board 200': (x) => x.status === 200 });
  } else if (r < 0.5) {
    const a = Math.floor(Math.random() * 40);
    check(get(s, `${P}/availability?arrival=${day(a)}&departure=${day(a + 2)}`, 'read', 'availability'), {
      'availability 200': (x) => x.status === 200,
    });
  } else if (r < 0.62) {
    check(
      get(
        s,
        `${P}/reservations?search=${encodeURIComponent(pick(cfg.searches))}&limit=20`,
        'read',
        'reservation search',
      ),
      {
        'reservations 200': (x) => x.status === 200,
      },
    );
  } else if (r < 0.75) {
    check(get(s, `/guests?search=${encodeURIComponent(pick(cfg.searches))}`, 'read', 'guest search'), {
      'guests 200': (x) => x.status === 200,
    });
  } else if (r < 0.875) {
    check(get(s, `${P}/folios/${pick(cfg.folioIds)}`, 'read', 'folio'), {
      'folio 200': (x) => x.status === 200,
    });
  } else {
    // A booking and its deposit; the deposit request is sent twice with one key, as a retry after a timeout.
    const arrival = Math.floor(Math.random() * 60);
    const booked = post(
      s,
      `${P}/reservations`,
      {
        guestId: pick(cfg.guestIds),
        source: 'phone',
        rooms: [
          {
            roomTypeId: cfg.roomTypeId,
            arrival: day(arrival),
            departure: day(arrival + 1 + Math.floor(Math.random() * 3)),
            adults: 1,
          },
        ],
      },
      'write',
      'book',
      crypto.randomUUID(),
    );
    // 409: that night is full by now; the hotel has 100 rooms, so this is rare but legitimate.
    check(booked, { 'booking 201 or full': (x) => x.status === 201 || x.status === 409 });
    if (booked.status === 201) {
      const key = crypto.randomUUID();
      const body = { reservationId: booked.json('data.id'), amount: '1000', method: 'cash' };
      const first = post(s, `${P}/payments`, body, 'write', 'deposit', key);
      const retry = post(s, `${P}/payments`, body, 'write', 'deposit retry', key);
      check(first, { 'deposit 201': (x) => x.status === 201 });
      check(retry, {
        'retry returns the same payment': (x) =>
          x.status === 201 && x.json('data.id') === first.json('data.id'),
      });
    }
  }
  sleep(1);
}

export function cashier() {
  const s = session('cashier');
  const r = Math.random();
  if (r < 0.4) {
    check(get(s, `${P}/payments?from=${cfg.monthFrom}&to=${cfg.monthTo}&limit=50`, 'read', 'payments'), {
      'payments 200': (x) => x.status === 200,
    });
  } else if (r < 0.8) {
    check(get(s, `${P}/folios/${pick(cfg.folioIds)}`, 'read', 'folio'), {
      'folio 200': (x) => x.status === 200,
    });
  } else {
    check(get(s, `${P}/cash-accounts`, 'read', 'cash accounts'), {
      'cash accounts 200': (x) => x.status === 200,
    });
  }
  sleep(2);
}

export function reporting() {
  const s = session('reporting');
  const month = `from=${cfg.monthFrom}&to=${cfg.monthTo}&propertyId=${cfg.propertyId}`;
  const paths = [
    [`/dashboard?propertyId=${cfg.propertyId}`, 'dashboard'],
    [`/reports/profit-loss?${month}`, 'profit and loss'],
    [`/reports/cashbook?${month}`, 'cashbook'],
    [`/reports/occupancy?${month}`, 'occupancy'],
    [`/reports/receivables-aging?asOf=${cfg.monthTo}&propertyId=${cfg.propertyId}`, 'receivables'],
  ];
  const [path, name] = pick(paths);
  check(get(s, path, 'report', name), { 'report 200': (x) => x.status === 200 });
  sleep(3);
}

export function bookingBurst() {
  const s = session('front_desk');
  const res = post(
    s,
    `${P}/reservations`,
    {
      guestId: pick(cfg.guestIds),
      source: 'phone',
      rooms: [
        {
          roomTypeId: cfg.burst.lastRoomTypeId,
          arrival: cfg.burst.arrival,
          departure: cfg.burst.departure,
          adults: 1,
        },
      ],
    },
    'write',
    'burst booking',
    crypto.randomUUID(),
  );
  if (res.status === 201) bookingWins.add(1);
  if (res.status === 409) bookingRefusals.add(1);
  check(res, {
    'burst booking confirmed or refused as full': (x) =>
      x.status === 201 || (x.status === 409 && x.json('error.code') === 'ROOM_UNAVAILABLE'),
  });
}

export function paymentRetryBurst() {
  const s = cfg.sessions.front_desk[0];
  const res = post(
    s,
    `${P}/payments`,
    { reservationId: cfg.burst.reservationId, amount: '2500', method: 'cash' },
    'write',
    'burst deposit retry',
    cfg.burst.paymentKey,
  );
  check(res, {
    'retried deposit recorded once or reported in progress': (x) =>
      x.status === 201 || (x.status === 409 && x.json('error.code') === 'IDEMPOTENCY_IN_PROGRESS'),
  });
}
