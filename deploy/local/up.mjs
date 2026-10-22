#!/usr/bin/env node
/**
 * Builds the production images and runs them as production would, on https://localhost:8443 (P6-5): a database
 * and storage of its own, the role provisioned, the release script (backup, migrations, start), a smoke-test
 * account, the smoke test against the stack, then a fresh encrypted backup and the restore drill (slice 6.5).
 * `node deploy/local/up.mjs --down` stops it.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const deploy = join(here, '..');
const root = join(deploy, '..');
const env = {
  ...process.env,
  API_IMAGE: 'innpilot-api:local',
  WEB_IMAGE: 'innpilot-web:local',
  SITE_ADDRESS: 'localhost',
  COMPOSE_FILES: '-f compose.yml -f compose.local.yml',
  SKIP_PULL: '1',
};
const compose = ['compose', '-f', 'compose.yml', '-f', 'compose.local.yml'];
const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { stdio: 'inherit', cwd: deploy, env, ...opts });

if (process.argv.includes('--down')) {
  run('docker', [...compose, '--profile', 'release', 'down']);
  process.exit(0);
}

const step = (title) => console.log(`\n==> ${title}`);

if (!process.argv.includes('--no-build')) {
  step('Building images');
  run('docker', ['build', '-f', 'apps/api/Dockerfile', '-t', env.API_IMAGE, '.'], { cwd: root });
  run('docker', ['build', '-f', 'apps/web/Dockerfile', '-t', env.WEB_IMAGE, '.'], { cwd: root });
}

step('Starting the database and storage');
run('docker', [...compose, 'up', '-d', '--wait', 'postgres', 'storage']);

step('Provisioning the restricted application role');
run('docker', [...compose, '--profile', 'release', 'run', '--rm', 'provision']);

step('Release: backup, migrations, start');
run('sh', ['release.sh']);

step('Smoke-test account');
const readEnv = (name) =>
  Object.fromEntries(
    readFileSync(join(here, name), 'utf8')
      .split('\n')
      .filter((l) => l.includes('=') && !l.startsWith('#'))
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
  );
const smoke = readEnv('smoke.env');
try {
  execFileSync(
    'docker',
    [
      ...compose,
      '--profile',
      'release',
      'run',
      '--rm',
      '-T',
      'migrate',
      'node',
      'node_modules/@innpilot/db/dist/cli.js',
      'tenant:create',
      '--slug',
      'smoke-check',
      '--legal-name',
      'Smoke Check Hotel (local)',
      '--display-name',
      'Smoke Check Hotel',
      '--property',
      'Smoke Check Hotel',
      '--owner-email',
      smoke.SMOKE_EMAIL,
      '--owner-name',
      'Smoke Check Owner',
    ],
    { cwd: deploy, env, input: `${smoke.SMOKE_PASSWORD}\n`, stdio: ['pipe', 'inherit', 'pipe'] },
  );
} catch (err) {
  const text = String(err.stderr ?? '');
  if (!/already/i.test(text)) throw err;
  console.log('Smoke-test hotel already exists.');
}

step('Trusting the local certificate for the smoke test only');
const ca = join(here, 'caddy-root.crt');
run('docker', [...compose, 'cp', 'proxy:/data/caddy/pki/authorities/local/root.crt', ca]);

step('Smoke test');
run(process.execPath, [join(root, 'scripts', 'smoke.mjs'), 'https://localhost:8443'], {
  env: { ...env, ...smoke, NODE_EXTRA_CA_CERTS: ca },
});

step('Encrypted backup');
run('docker', [...compose, '--profile', 'release', 'run', '--rm', 'backup']);

step('Restore drill: restore into a new database, check, sign in, drop');
run('docker', [...compose, '--profile', 'release', 'run', '--rm', 'restore-drill'], {
  env: {
    ...env,
    // As the owner would: the private key comes out of safe keeping for this run only.
    ...readEnv('backup-private.env'),
    DRILL_SIGNIN_EMAIL: smoke.SMOKE_EMAIL,
    DRILL_SIGNIN_PASSWORD: smoke.SMOKE_PASSWORD,
  },
});
