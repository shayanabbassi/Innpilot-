#!/usr/bin/env node
/**
 * Smoke test for a deployed InnPilot (P6-5): run after every release, against staging, production or the local
 * production-like stack. No dependencies.
 *
 *   node scripts/smoke.mjs https://app.example.com
 *
 * Optional: SMOKE_EMAIL and SMOKE_PASSWORD for a sign-in round trip with a dedicated smoke-test account.
 * Exits non-zero, listing every failed check, if anything is wrong.
 */
const base = (process.argv[2] ?? '').replace(/\/+$/, '');
if (!/^https?:\/\//.test(base)) {
  console.error('Usage: node scripts/smoke.mjs <base-url>');
  process.exit(2);
}
const origin = new URL(base).origin;
const failures = [];
let passed = 0;

async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures.push(name);
    console.log(`  FAIL ${name}: ${err instanceof Error ? err.message : err}`);
  }
}
function expect(cond, message) {
  if (!cond) throw new Error(message);
}
const get = (path, init = {}) => fetch(`${base}${path}`, { redirect: 'manual', ...init });

console.log(`Smoke test: ${base}`);

await check('API health answers ok', async () => {
  const res = await get('/api/v1/health');
  expect(res.status === 200, `status ${res.status}`);
  const body = await res.json();
  expect(body?.data?.status === 'ok', `body ${JSON.stringify(body)}`);
});

await check('sign-in page is served with security headers', async () => {
  const res = await get('/login');
  expect(res.status === 200, `status ${res.status}`);
  const h = res.headers;
  if (base.startsWith('https://')) {
    expect(/max-age=\d{7,}/.test(h.get('strict-transport-security') ?? ''), 'no HSTS');
  }
  expect((h.get('content-security-policy') ?? '').includes("frame-ancestors 'none'"), 'no CSP');
  expect(h.get('x-frame-options') === 'DENY', 'no X-Frame-Options');
  expect(h.get('x-content-type-options') === 'nosniff', 'no nosniff');
  expect(!h.get('x-powered-by'), 'X-Powered-By is exposed');
  expect(!h.get('server'), `Server header exposed: ${h.get('server')}`);
});

await check('API refuses a request without a session', async () => {
  const res = await get('/api/v1/auth/me');
  expect(res.status === 401, `status ${res.status}`);
  const body = await res.json();
  expect(body?.error?.code === 'UNAUTHENTICATED', `code ${body?.error?.code}`);
  expect(!!body?.meta?.requestId, 'no request id');
});

await check('API refuses a cross-site sign-in attempt', async () => {
  const res = await get('/api/v1/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://attacker.example' },
    body: JSON.stringify({ email: 'smoke@example.invalid', password: 'not-a-real-password' }),
  });
  expect(res.status === 403, `status ${res.status}`);
  expect((await res.json())?.error?.code === 'CSRF_FAILED', 'not CSRF_FAILED');
});

await check('unknown API routes answer in the error envelope, without internals', async () => {
  const res = await get('/api/v1/definitely-not-a-route');
  expect(res.status === 404, `status ${res.status}`);
  const text = await res.text();
  expect(!/stack|node_modules|Error:/.test(text), 'internals in the response');
});

if (process.env.SMOKE_EMAIL && process.env.SMOKE_PASSWORD) {
  await check('a smoke-test account can sign in and out, with secure cookies', async () => {
    const login = await get('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({ email: process.env.SMOKE_EMAIL, password: process.env.SMOKE_PASSWORD }),
    });
    expect(login.status === 200, `login status ${login.status}`);
    const cookies = login.headers.getSetCookie();
    const session = cookies.find((c) => /ip_session=/.test(c));
    const csrf = cookies.find((c) => /ip_csrf=/.test(c));
    expect(session && csrf, 'session cookies missing');
    if (base.startsWith('https://')) {
      expect(
        /^__Host-/.test(session) && /;\s*Secure/i.test(session),
        'session cookie is not __Host- and Secure',
      );
    }
    expect(/HttpOnly/i.test(session), 'session cookie is not HttpOnly');
    const cookie = cookies.map((c) => c.split(';')[0]).join('; ');
    const me = await get('/api/v1/auth/me', { headers: { cookie } });
    expect(me.status === 200, `me status ${me.status}`);
    const token = decodeURIComponent(csrf.split(';')[0].split('=').slice(1).join('='));
    const out = await get('/api/v1/auth/logout', {
      method: 'POST',
      headers: { cookie, origin, 'x-csrf-token': token },
    });
    expect(out.status === 200 || out.status === 204, `logout status ${out.status}`);
    const after = await get('/api/v1/auth/me', { headers: { cookie } });
    expect(after.status === 401, `session still valid after sign-out (${after.status})`);
  });
}

console.log(`${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
