#!/usr/bin/env node
/**
 * Builds the production images and runs them as the single-server staging would (P6-5, P7-1), on
 * https://localhost:8443: a database and storage of its own, the release script (role, backup, migrations, start),
 * a smoke-test account, the smoke test against the stack, then a fresh encrypted backup and the restore drill.
 * `node deploy/local/up.mjs --down` stops it.
 */
import { execFileSync, spawnSync } from 'node:child_process';
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
  COMPOSE_FILES: '-f compose.yml -f compose.single.yml -f compose.local.yml',
  SKIP_PULL: '1',
};
const compose = ['compose', '-f', 'compose.yml', '-f', 'compose.single.yml', '-f', 'compose.local.yml'];
let failure = '';
const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, {
    cwd: deploy,
    env,
    ...opts,
    stdio: ['inherit', 'inherit', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.stderr?.length) process.stderr.write(r.stderr);
  if (r.status !== 0) {
    failure = String(r.stderr ?? r.error ?? '')
      .trim()
      .split('\n')
      .slice(-15)
      .join('\n');
    throw new Error(`${cmd} ${args.join(' ')} exited with ${r.status}`);
  }
};

if (process.argv.includes('--down')) {
  run('docker', [...compose, '--profile', 'release', 'down']);
  process.exit(0);
}

let current = 'start';
const step = (title) => {
  current = title;
  console.log(`\n==> ${title}`);
};
// In CI, name the failed step as an annotation: annotations are readable without opening the job log.
process.on('exit', (code) => {
  if (code !== 0 && process.env.GITHUB_ACTIONS) {
    const text = `${current}\n${failure}`.replace(/%/g, '%25').replace(/\r?\n/g, '%0A');
    console.log(`::error title=Local stack failed::${text}`);
  }
});

if (!process.argv.includes('--no-build')) {
  step('Building images');
  run('docker', ['build', '-f', 'apps/api/Dockerfile', '-t', env.API_IMAGE, '.'], { cwd: root });
  run('docker', ['build', '-f', 'apps/web/Dockerfile', '-t', env.WEB_IMAGE, '.'], { cwd: root });
}

step('Starting the database and storage');
run('docker', [...compose, 'up', '-d', '--wait', 'postgres', 'storage']);

step('Storage buckets (made by the provider in a real deployment)');
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

if (process.argv.includes('--alert-drill')) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (what, timeoutMs, test) => {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const value = await test().catch(() => null);
      if (value) return value;
      if (Date.now() > end) throw new Error(`Timed out waiting for: ${what}`);
      await sleep(3000);
    }
  };
  const prom = async (query) =>
    (await (await fetch(`http://127.0.0.1:9090/api/v1/query?query=${encodeURIComponent(query)}`)).json()).data
      .result;
  const sinkLog = () =>
    execFileSync('docker', [...compose, '--profile', 'monitoring', 'logs', '--no-color', 'alert-sink'], {
      cwd: deploy,
      env,
      encoding: 'utf8',
    });

  step('Monitoring: Prometheus, Alertmanager, Grafana and the alert sink');
  run('docker', [
    ...compose,
    '--profile',
    'monitoring',
    'up',
    '-d',
    'prometheus',
    'alertmanager',
    'grafana',
    'alert-sink',
  ]);
  await until('Prometheus scraping the API', 120_000, async () => {
    const r = await prom('up{job="innpilot-api"}');
    return r[0]?.value[1] === '1';
  });
  console.log('  ok   Prometheus scrapes the API metrics port');
  await until(
    'readiness metrics',
    60_000,
    async () => (await prom('min(innpilot_ready)'))[0]?.value[1] === '1',
  );
  console.log('  ok   database, storage and migrations report ready');
  const rules = await (await fetch('http://127.0.0.1:9090/api/v1/rules')).json();
  const names = rules.data.groups.flatMap((g) => g.rules.map((r) => r.name));
  if (names.length < 13 || !names.includes('InnPilotApiDown')) throw new Error(`rules not loaded: ${names}`);
  console.log(`  ok   ${names.length} alert rules loaded`);
  const grafana = readEnv('monitoring.env').GF_SECURITY_ADMIN_PASSWORD;
  await until('the Grafana dashboard', 120_000, async () => {
    const res = await fetch('http://127.0.0.1:3001/api/dashboards/uid/innpilot-overview', {
      headers: { authorization: `Basic ${Buffer.from(`admin:${grafana}`).toString('base64')}` },
    });
    return res.status === 200;
  });
  console.log('  ok   Grafana has the InnPilot dashboard');

  step('Alert drill: stop the API and wait for InnPilotApiDown at the sink');
  const t0 = Date.now();
  run('docker', [...compose, 'stop', 'api']);
  try {
    await until('InnPilotApiDown firing at the alert sink', 6 * 60_000, async () =>
      /ALERT .*"status":"firing".*InnPilotApiDown/.test(sinkLog()),
    );
    console.log(`  ok   InnPilotApiDown delivered after ${Math.round((Date.now() - t0) / 1000)} s`);
  } finally {
    run('docker', [...compose, 'start', 'api']);
  }
  await until('InnPilotApiDown resolved at the alert sink', 6 * 60_000, async () =>
    /ALERT .*"status":"resolved".*InnPilotApiDown/.test(sinkLog()),
  );
  console.log(`  ok   resolution delivered ${Math.round((Date.now() - t0) / 1000)} s after the stop`);
}
