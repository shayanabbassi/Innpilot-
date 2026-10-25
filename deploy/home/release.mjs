#!/usr/bin/env node
/**
 * Releases InnPilot to home staging (docs/home-staging-runbook.md): the single-server stack on this computer as the
 * Compose project "innpilot-staging", behind Tailscale Funnel's public https address.
 *   node deploy/home/release.mjs              build the images from this checkout, then release
 *   node deploy/home/release.mjs --tag sha-…  use the images the Release workflow published instead
 *   node deploy/home/release.mjs --down       stop staging (its data stays)
 * Each release runs deploy/release.sh, as on a real server: role, encrypted backup, migrations, start. Then the
 * smoke test against the public address, with a smoke-test hotel of its own.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const deploy = join(here, '..');
const root = join(deploy, '..');
const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? (process.argv[i + 1] ?? '') : null;
};
const readEnv = (name) =>
  Object.fromEntries(
    readFileSync(join(here, name), 'utf8')
      .split('\n')
      .filter((l) => l.includes('=') && !l.startsWith('#'))
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]),
  );

const files = [
  'app.env',
  'release.env',
  'backup.env',
  'postgres.env',
  'storage.env',
  'monitoring.env',
  'smoke.env',
];
const missing = files.filter((f) => !existsSync(join(here, f)));
if (missing.length) {
  console.error(`Missing deploy/home/${missing.join(', ')}. First run (runbook step 4):`);
  console.error(
    '  node deploy/local/init.mjs --dir deploy/home --origin https://<pc>.<tailnet>.ts.net --buckets innpilot-staging',
  );
  process.exit(1);
}
const origin = readEnv('app.env').WEB_ORIGINS;
const tag = arg('tag');
const owner = 'shayanabbassi';
const env = {
  ...process.env,
  COMPOSE_PROJECT_NAME: 'innpilot-staging',
  API_IMAGE: tag ? `ghcr.io/${owner}/innpilot-api:${tag}` : 'innpilot-api:staging',
  WEB_IMAGE: tag ? `ghcr.io/${owner}/innpilot-web:${tag}` : 'innpilot-web:staging',
  SITE_ADDRESS: new URL(origin).host,
  COMPOSE_FILES: '-f compose.yml -f compose.single.yml -f compose.home.yml',
  ...(tag ? {} : { SKIP_PULL: '1' }),
};
const compose = ['compose', '-f', 'compose.yml', '-f', 'compose.single.yml', '-f', 'compose.home.yml'];
const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: deploy, env, ...opts });
  if (r.status !== 0) {
    console.error(`\nStopped: ${cmd} ${args.join(' ')} exited with ${r.status ?? r.error}.`);
    process.exit(1);
  }
};
const step = (title) => console.log(`\n==> ${title}`);

if (process.argv.includes('--down')) {
  // Never "down -v": the database and files live in the project's volumes.
  run('docker', [...compose, '--profile', 'release', '--profile', 'monitoring', 'stop']);
  process.exit(0);
}

if (tag === null) {
  const branch = execFileSync('git', ['branch', '--show-current'], { cwd: root, encoding: 'utf8' }).trim();
  const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
  }).trim();
  step(`Building the images from this checkout (${branch || 'detached'} at ${commit})`);
  if (branch !== 'main')
    console.log(`Note: staging normally runs main; this is ${branch || 'a detached commit'}.`);
  run('docker', ['build', '-f', 'apps/api/Dockerfile', '-t', env.API_IMAGE, '.'], { cwd: root });
  run('docker', ['build', '-f', 'apps/web/Dockerfile', '-t', env.WEB_IMAGE, '.'], { cwd: root });
} else if (!tag) {
  console.error('Give the image tag after --tag, e.g. --tag sha-0123456789ab (Actions → Release → the run).');
  process.exit(1);
}

step('Database and storage');
run('docker', [...compose, 'up', '-d', '--wait', 'postgres', 'storage']);
step('Storage buckets (once; kept afterwards)');
run('docker', [
  ...compose,
  '--profile',
  'release',
  'run',
  '--rm',
  'restore-drill',
  'node',
  'dist/ops/cli.js',
  'ensure-buckets',
]);

step('Release: role, backup, migrations, start');
run('sh', ['release.sh']);

step('Smoke-test hotel (once)');
const smoke = readEnv('smoke.env');
const created = spawnSync(
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
    'Smoke Check Hotel (staging)',
    '--display-name',
    'Smoke Check Hotel',
    '--property',
    'Smoke Check Hotel',
    '--owner-email',
    smoke.SMOKE_EMAIL,
    '--owner-name',
    'Smoke Check Owner',
  ],
  { cwd: deploy, env, input: `${smoke.SMOKE_PASSWORD}\n`, encoding: 'utf8' },
);
if (created.status !== 0 && !/already/i.test(`${created.stderr}${created.stdout}`)) {
  console.error(created.stderr || created.stdout);
  process.exit(1);
}
console.log(created.status === 0 ? 'Created.' : 'Already there.');

step(`Smoke test against ${origin}`);
const reachable = await fetch(`${origin}/api/v1/health/live`, { signal: AbortSignal.timeout(15000) })
  .then((r) => r.ok)
  .catch(() => false);
if (!reachable) {
  console.log(`${origin} does not answer yet. Turn on Tailscale Funnel (runbook step 3), then run:`);
  console.log(
    `  node scripts/smoke.mjs ${origin}   (with SMOKE_EMAIL and SMOKE_PASSWORD from deploy/home/smoke.env)`,
  );
  process.exit(0);
}
run(process.execPath, [join(root, 'scripts', 'smoke.mjs'), origin], { cwd: root, env: { ...env, ...smoke } });
console.log(`\nStaging is up at ${origin}`);
