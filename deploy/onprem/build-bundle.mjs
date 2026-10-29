#!/usr/bin/env node
/**
 * Builds the on-premises installer bundle (D22) that you give to a hotel: a folder and a zip with the installer,
 * the stack definition and the InnPilot version it installs.
 *   node deploy/onprem/build-bundle.mjs                      the version on main (its published sha- tag)
 *   node deploy/onprem/build-bundle.mjs --version v1.0.0     a tagged release
 * Writes deploy/onprem/out/InnPilot-<version>/ and InnPilot-<version>.zip. Refuses a version whose images are not
 * published (anyone can pull them: the hotel's computer needs no GitHub account).
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const deploy = join(here, '..');
const root = join(deploy, '..');
const OWNER = 'shayanabbassi';
const i = process.argv.indexOf('--version');
let version = i > 0 ? process.argv[i + 1] : undefined;
if (!version) {
  execFileSync('git', ['fetch', '-q', 'origin', 'main'], { cwd: root });
  const sha = execFileSync('git', ['rev-parse', 'origin/main'], { cwd: root, encoding: 'utf8' }).trim();
  version = `sha-${sha.slice(0, 12)}`;
}
if (!/^(v\d+\.\d+\.\d+|sha-[0-9a-f]{12})$/.test(version)) {
  console.error(`Not a release version: ${version} (v1.2.3 or sha-<12 hex>)`);
  process.exit(2);
}

// Both images must be published for this version, and readable without signing in.
for (const image of ['innpilot-api', 'innpilot-web']) {
  const repo = `${OWNER}/${image}`;
  const token = (await (await fetch(`https://ghcr.io/token?scope=repository:${repo}:pull`)).json()).token;
  const res = await fetch(`https://ghcr.io/v2/${repo}/manifests/${version}`, {
    method: 'HEAD',
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.oci.image.index.v1+json' },
  });
  if (res.status !== 200) {
    console.error(`ghcr.io/${repo}:${version} is not published (or not public): ${res.status}.`);
    process.exit(1);
  }
}

const name = `InnPilot-${version}`;
const out = join(here, 'out');
const dir = join(out, name);
rmSync(dir, { recursive: true, force: true });
mkdirSync(join(dir, 'caddy'), { recursive: true });
const files = [
  [join(deploy, 'compose.yml'), 'compose.yml'],
  [join(deploy, 'compose.single.yml'), 'compose.single.yml'],
  [join(deploy, 'compose.onprem.yml'), 'compose.onprem.yml'],
  [join(deploy, 'caddy', 'Caddyfile.home'), 'caddy/Caddyfile.home'],
  [join(deploy, 'caddy', 'innpilot.caddy'), 'caddy/innpilot.caddy'],
  [join(here, 'install.ps1'), 'install.ps1'],
  [join(here, 'backup-offsite.ps1'), 'backup-offsite.ps1'],
  [join(here, 'InnPilot-Install.cmd'), 'InnPilot-Install.cmd'],
  [join(here, 'README.txt'), 'README.txt'],
];
for (const [from, to] of files) copyFileSync(from, join(dir, to));
writeFileSync(join(dir, 'VERSION'), `${version}\n`);

const zip = join(out, `${name}.zip`);
rmSync(zip, { force: true });
// Windows' own tar writes zip archives; elsewhere, zip(1).
const winTar = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
if (existsSync(winTar)) execFileSync(winTar, ['-a', '-c', '-f', zip, '-C', out, name]);
else execFileSync('zip', ['-qr', zip, name], { cwd: out });
console.log(`Bundle for ${version}:\n  ${dir}\n  ${zip}`);
