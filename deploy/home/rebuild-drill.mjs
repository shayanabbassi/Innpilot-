#!/usr/bin/env node
/**
 * Rebuild drill (P7-6): staging rebuilt from nothing but the saved settings and a copy of the backup storage, as
 * after a lost or broken computer. The same steps rebuild an on-premises install (D22).
 *   node deploy/home/rebuild-drill.mjs           drill beside live staging, then remove the rebuilt copy
 *   node deploy/home/rebuild-drill.mjs --keep    leave it running on http://127.0.0.1:8091 to look at
 * Needs deploy/home/*.env (the saved settings) including backup-private.env. Uses a fresh Compose project,
 * "innpilot-rebuild", with empty volumes; the storage of live staging stands in for the off-site copy of the
 * backups and files. Live staging is only read, never changed.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const deploy = join(here, '..');
const readEnv = (name) =>
  Object.fromEntries(
    readFileSync(join(here, name), 'utf8')
      .split('\n')
      .filter((l) => l.includes('=') && !l.startsWith('#'))
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]),
  );
if (!existsSync(join(here, 'backup-private.env'))) {
  console.error(
    'Copy backup-private.env from your safe copy into deploy/home first (delete it again afterwards).',
  );
  process.exit(1);
}

const project = 'innpilot-rebuild';
const origin = readEnv('app.env').WEB_ORIGINS;
const host = new URL(origin).host;
const smoke = readEnv('smoke.env');
// The rebuilt copy listens on 8091, beside live staging on 8090.
const work = mkdtempSync(join(tmpdir(), 'innpilot-rebuild-'));
const overlay = join(work, 'rebuild.yml');
writeFileSync(overlay, "services:\n  proxy:\n    ports: !override ['127.0.0.1:8091:80']\n");
const env = {
  ...process.env,
  COMPOSE_PROJECT_NAME: project,
  API_IMAGE: 'innpilot-api:staging',
  WEB_IMAGE: 'innpilot-web:staging',
  SITE_ADDRESS: host,
};
const compose = [
  'compose',
  '-f',
  'compose.yml',
  '-f',
  'compose.single.yml',
  '-f',
  'compose.home.yml',
  '-f',
  overlay,
];
const run = (args, opts = {}) => {
  const r = spawnSync('docker', args, { cwd: deploy, env, encoding: 'utf8', ...opts });
  if (r.status !== 0) {
    console.error(`\nStopped: docker ${args.join(' ')}\n${r.stderr || r.stdout}`);
    cleanUp();
    process.exit(1);
  }
  return r.stdout ?? '';
};
const sql = (db, query) =>
  run(['exec', `${project}-postgres-1`, 'psql', '-U', 'postgres', '-d', db, '-At', '-c', query]).trim();
const stagingSql = (query) =>
  execFileSync(
    'docker',
    ['exec', 'innpilot-staging-postgres-1', 'psql', '-U', 'postgres', '-d', 'innpilot', '-At', '-c', query],
    {
      encoding: 'utf8',
    },
  ).trim();
const step = (title) => console.log(`\n==> ${title}`);
const started = Date.now();
const keep = process.argv.includes('--keep');
function cleanUp() {
  if (!keep) spawnSync('docker', [...compose, '--profile', 'release', 'down', '-v'], { cwd: deploy, env });
  rmSync(work, { recursive: true, force: true });
}

step('A fresh, empty stack (new database and storage volumes)');
spawnSync('docker', [...compose, '--profile', 'release', 'down', '-v'], { cwd: deploy, env });
run([...compose, 'up', '-d', '--wait', 'postgres', 'storage'], { stdio: 'inherit' });

step('Storage copied in (stands in for the off-site copy of backups and files)');
run(['compose', '-p', project, 'stop', 'storage'], { stdio: 'inherit' });
run([
  'run',
  '--rm',
  '-v',
  'innpilot-staging_storagedata:/from:ro',
  '-v',
  `${project}_storagedata:/to`,
  'debian:bookworm-slim',
  'sh',
  '-c',
  // The storage gateway keeps object details in extended attributes: copy them too.
  'cd /from && tar --xattrs --xattrs-include="*" -cf - . | (cd /to && tar --xattrs --xattrs-include="*" -xf -)',
]);
run([...compose, 'up', '-d', 'storage'], { stdio: 'inherit' });

step('Application role');
run([...compose, '--profile', 'release', 'run', '--rm', 'provision'], { stdio: 'inherit' });

step('Restore the latest backup, check it, keep it');
const drill = run(
  [
    ...compose,
    '--profile',
    'release',
    'run',
    '--rm',
    '-e',
    'BACKUP_PRIVATE_KEY',
    '-e',
    'DRILL_SIGNIN_EMAIL',
    '-e',
    'DRILL_SIGNIN_PASSWORD',
    'restore-drill',
    'node',
    'dist/ops/cli.js',
    'restore-drill',
    '--keep',
  ],
  {
    env: {
      ...env,
      BACKUP_PRIVATE_KEY: readEnv('backup-private.env').BACKUP_PRIVATE_KEY,
      DRILL_SIGNIN_EMAIL: smoke.SMOKE_EMAIL,
      DRILL_SIGNIN_PASSWORD: smoke.SMOKE_PASSWORD,
    },
  },
);
console.log(
  drill
    .split('\n')
    .filter((l) => /Restore drill|Backup `|\| .* \| (ok|\*\*failed\*\*) \|/.test(l))
    .join('\n'),
);
const kept = /restored into `(innpilot_restore_\w+)`/.exec(drill)?.[1];
if (!kept) {
  console.error('The drill did not report the restored database.');
  cleanUp();
  process.exit(1);
}

step(`Make ${kept} the live database`);
run([...compose, 'stop', 'api', 'backups'], { stdio: 'inherit' });
sql(
  'postgres',
  `select pg_terminate_backend(pid) from pg_stat_activity where datname in ('innpilot', '${kept}') and pid <> pg_backend_pid()`,
);
sql('postgres', 'drop database innpilot');
sql('postgres', `alter database ${kept} rename to innpilot`);

step('Start InnPilot on the rebuilt database');
run([...compose, 'up', '-d', '--wait', 'api', 'web', 'proxy'], { stdio: 'inherit' });

step('Checks');
const base = 'http://127.0.0.1:8091';
const headers = { host, origin, 'content-type': 'application/json' };
const ready = await fetch(`${base}/api/v1/health/ready`, { headers: { host } });
const login = await fetch(`${base}/api/v1/auth/login`, {
  method: 'POST',
  headers,
  body: JSON.stringify({ email: smoke.SMOKE_EMAIL, password: smoke.SMOKE_PASSWORD }),
});
const counts = (q) => [q, stagingSql(q), sql('innpilot', q)];
const compared = [
  counts('select count(*) from tenants'),
  counts('select count(*) from users'),
  counts('select count(*) from rooms'),
  counts('select count(*) from journal_entries'),
  counts('select count(*) from audit_events'),
];
console.log(`ready: ${ready.status}; smoke-test sign-in: ${login.status}`);
console.log('| What | Live staging | Rebuilt |\n| --- | --- | --- |');
for (const [q, live, rebuilt] of compared)
  console.log(`| ${q.replace('select count(*) from ', '')} | ${live} | ${rebuilt} |`);
// The rebuilt copy holds what the backup held: activity on live staging after the backup is not in it.
const ok = ready.status === 200 && login.status === 200;
console.log(
  `\nRebuild drill ${ok ? 'PASSED' : 'FAILED'} in ${((Date.now() - started) / 1000).toFixed(1)} s.`,
);
if (keep)
  console.log(
    `Left running on ${base} (project ${project}); remove with: docker compose -p ${project} down -v`,
  );
cleanUp();
process.exit(ok ? 0 : 1);
