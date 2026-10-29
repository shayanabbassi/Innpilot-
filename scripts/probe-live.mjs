#!/usr/bin/env node
/**
 * Route probe against a running InnPilot (7.2 item 7): every route in docs/openapi/openapi.json, over the real
 * address, from outside, signed out. The full in-process probe (test/security-probe.e2e) also covers roles and
 * other hotels; this one proves the deployed stack (proxy, headers, rate limits) refuses what it must.
 *   node scripts/probe-live.mjs https://<address>
 * Checks: every non-public route refuses a signed-out request (401, or 403 for a cross-site write); every route
 * that changes something refuses a request from a foreign origin; public reads answer 200; nothing answers 5xx and
 * no error carries internals. Sends no credentials and changes nothing. Prints counts only.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const base = (process.argv[2] ?? '').replace(/\/+$/, '');
if (!/^https:\/\//.test(base)) {
  console.error('Usage: node scripts/probe-live.mjs https://<address>');
  process.exit(2);
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const doc = JSON.parse(readFileSync(join(root, 'docs', 'openapi', 'openapi.json'), 'utf8'));
const prefix = doc.servers?.[0]?.url ?? '/api/v1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One request; waits and retries on 429 so rate limits never hide an answer. */
async function send(method, path, headers = {}, body) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${base}${prefix}${path}`, {
      method,
      headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
      redirect: 'manual',
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    if (res.status === 429 && attempt < 8) {
      await sleep(Math.max(1, Number(res.headers.get('retry-after')) || 5) * 1000);
      continue;
    }
    return { status: res.status, text };
  }
}

const findings = [];
const tally = { routes: 0, signedOutRefused: 0, foreignOriginRefused: 0, publicOk: 0 };
const leaks = /stack|at [A-Za-z]+ \(|node_modules|ECONN|SELECT |INSERT |postgres:\/\//;

for (const [template, ops] of Object.entries(doc.paths)) {
  for (const [method, op] of Object.entries(ops)) {
    tally.routes++;
    const path = template.replace(/\{[^}]+\}/g, () => randomUUID());
    const verb = method.toUpperCase();
    const isPublic = Array.isArray(op.security) && op.security.length === 0;
    const label = `${verb} ${template}`;
    const check = (r, what) => {
      if (r.status >= 500) findings.push(`${label}: ${what} answered ${r.status}`);
      if (leaks.test(r.text)) findings.push(`${label}: ${what} carries internals`);
    };

    if (isPublic) {
      if (verb === 'GET') {
        const r = await send(verb, path);
        check(r, 'public read');
        if (r.status === 200) tally.publicOk++;
        else findings.push(`${label}: public read answered ${r.status}`);
      }
      continue;
    }

    const out = await send(verb, path, {}, verb === 'GET' || verb === 'DELETE' ? undefined : {});
    check(out, 'signed out');
    if (out.status === 401 || out.status === 403) tally.signedOutRefused++;
    else findings.push(`${label}: signed out answered ${out.status}`);

    if (verb !== 'GET') {
      const foreign = await send(
        verb,
        path,
        { origin: 'https://attacker.example' },
        verb === 'DELETE' ? undefined : {},
      );
      check(foreign, 'foreign origin');
      if (foreign.status === 401 || foreign.status === 403) tally.foreignOriginRefused++;
      else findings.push(`${label}: foreign origin answered ${foreign.status}`);
    }
    await sleep(50);
  }
}

console.log(`Probed ${tally.routes} routes at ${base}:`);
console.log(`  signed-out requests refused:      ${tally.signedOutRefused}`);
console.log(`  foreign-origin writes refused:    ${tally.foreignOriginRefused}`);
console.log(`  public reads answering 200:       ${tally.publicOk}`);
console.log(findings.length ? `${findings.length} finding(s):\n  ${findings.join('\n  ')}` : 'No findings.');
process.exit(findings.length ? 1 : 0);
