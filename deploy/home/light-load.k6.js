/* global __ENV */
/**
 * Light load run against home staging (7.2 item 7): a few front-desk users reading the screens they use all day,
 * over the real address, through Tailscale Funnel. Not the 100-room capacity test (apps/api/load/hotel.k6.js): it
 * shows what a hotel's own computer and connection give, and that nothing fails under steady use.
 *   docker run --rm -i --add-host <host>:<funnel IPv4> -e BASE=https://<host> -e EMAIL=... -e PASSWORD=...
 *     grafana/k6:2.2.0 run - < deploy/home/light-load.k6.js
 * The account is a staging-only front-desk user (deploy/home/load.env); reads only, nothing is changed.
 */
import http from 'k6/http';
import { check, fail, sleep } from 'k6';

const BASE = `${__ENV.BASE}/api/v1`;
const ORIGIN = __ENV.BASE;

export const options = {
  // Keep each user's session cookie between rounds (k6 clears cookies every round by default).
  noCookiesReset: true,
  scenarios: {
    front_desk: { executor: 'constant-vus', vus: 5, duration: '2m' },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    'http_req_duration{kind:read}': ['p(95)<1500'],
  },
};

let propertyId = null;

function signIn() {
  const res = http.post(
    `${BASE}/auth/login`,
    JSON.stringify({ email: __ENV.EMAIL, password: __ENV.PASSWORD }),
    {
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      tags: { kind: 'sign-in' },
    },
  );
  if (res.status !== 200) fail(`sign-in answered ${res.status}`);
  const me = http.get(`${BASE}/auth/me`, { tags: { kind: 'read', name: 'me' } });
  propertyId = me.json('data.properties.0.id');
  if (!propertyId) fail('no property for the load account');
}

export default function () {
  if (!propertyId) signIn();
  const today = new Date().toISOString().slice(0, 10);
  const month = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
  const reads = [
    ['front desk today', `/properties/${propertyId}/front-desk/today`],
    ['room board', `/properties/${propertyId}/room-board`],
    ['reservations', `/properties/${propertyId}/reservations?from=${today}&to=${month}`],
    ['guests', '/guests?search=a'],
    ['dashboard', `/dashboard?propertyId=${propertyId}`],
  ];
  for (const [name, path] of reads) {
    const res = http.get(`${BASE}${path}`, { tags: { kind: 'read', name } });
    check(res, { [`${name} 200`]: (r) => r.status === 200 });
    sleep(1 + Math.random() * 2); // a person looking at the screen
  }
}
