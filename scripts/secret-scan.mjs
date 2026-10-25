#!/usr/bin/env node
/**
 * Secret scan (slice 6.8, security review): looks for credentials in every tracked file and in the web app's
 * browser bundles (apps/web/.next/static, when built).
 *
 * 1. Known shapes: private keys, cloud and GitHub tokens, connection strings with a password.
 * 2. Where local settings exist (.env, deploy/local/*.env, never committed), every secret value in them: none may
 *    appear in a tracked file or a bundle.
 *
 * A line holding a deliberate, fictional credential (a test of the scrubber, say) carries a
 * "secret-scan: allow <reason>" comment. Prints the file, line and kind of each finding, never the value. Exits 1 if
 * anything is found.
 *   node scripts/secret-scan.mjs
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');

const PATTERNS = [
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/],
  // AWS's own documentation key (ending in EXAMPLE) is used by the signing test and is not a credential.
  ['AWS access key', /\bAKIA(?![0-9A-Z]{9}EXAMPLE)[0-9A-Z]{16}\b/],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
  ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['Stripe live key', /\b(?:sk|rk)_live_[0-9A-Za-z]{16,}\b/],
  // A URL with an inline password, unless it is an obvious placeholder (<...>, ${...}, ci-only, ...).
  [
    'connection string with password',
    /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@'"`]+:(?!<|\$\{|\*\*\*|ci-only|password@|pw@|nothing|x@|pass@)[^\s@'"`]{6,}@[^\s'"`]+/i,
  ],
];

function listDir(rel) {
  const p = join(root, rel);
  return existsSync(p) ? readdirSync(p) : [];
}

/** For URLs, only the password inside (an address alone is not a secret); otherwise the value itself. */
function secretParts(value) {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    const password = /^[a-z][a-z0-9+.-]*:\/\/[^:@/]+:([^@]+)@/i.exec(value)?.[1];
    return password && password.length >= 8 ? [password] : [];
  }
  return [value];
}

/** Secret values from local settings files, which never leave this machine. */
function localSecrets() {
  const files = [
    '.env',
    ...listDir('deploy/local')
      .filter((f) => f.endsWith('.env'))
      .map((f) => `deploy/local/${f}`),
  ];
  const values = new Map();
  for (const f of files) {
    const p = join(root, f);
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (!m) continue;
      const [, key, value] = m;
      if (!/PASSWORD|SECRET|KEY|TOKEN|_URL/.test(key) || value.length < 12) continue;
      for (const part of secretParts(value)) values.set(part, `${f}: ${key}`);
    }
  }
  return values;
}

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(js|css|html|json|map)$/.test(name)) out.push(p);
  }
  return out;
}

const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
  .split('\0')
  .filter(Boolean)
  .map((f) => join(root, f));
const bundles = walk(join(root, 'apps/web/.next/static'));
const secrets = localSecrets();
const findings = [];

for (const file of [...tracked, ...bundles]) {
  let buf;
  try {
    buf = readFileSync(file);
  } catch {
    continue;
  }
  if (buf.includes(0)) continue; // binary
  const rel = file.slice(root.length + 1).replace(/\\/g, '/');
  buf
    .toString('utf8')
    .split('\n')
    .forEach((line, i) => {
      if (/secret-scan: allow \S/.test(line)) return;
      for (const [kind, re] of PATTERNS) if (re.test(line)) findings.push(`${rel}:${i + 1}  ${kind}`);
      for (const [value, source] of secrets) {
        if (line.includes(value)) findings.push(`${rel}:${i + 1}  value of ${source}`);
      }
    });
}

console.log(
  `Scanned ${tracked.length} tracked files and ${bundles.length} browser bundle files` +
    (secrets.size ? `, against ${secrets.size} local secret values.` : '.'),
);
if (findings.length) {
  console.log(`${findings.length} finding(s):\n${findings.map((f) => `  ${f}`).join('\n')}`);
  process.exit(1);
}
console.log('No secrets found.');
