#!/usr/bin/env node
/**
 * Copies home staging's storage off this computer (7.2 item 5, D22): the encrypted nightly backups and the
 * application's files (also encrypted), packed into one file in a folder that leaves the machine, such as a Google
 * Drive for desktop folder or a USB drive. Keeps the newest three copies there.
 *   node deploy/home/copy-offsite.mjs --to "G:\My Drive\InnPilot backups"   (remembered in deploy/home/offsite.env)
 *   node deploy/home/copy-offsite.mjs                                          (the remembered folder)
 * A rebuild starts from such a file: node deploy/home/rebuild-drill.mjs --from-file <file>.
 */
import { spawn } from 'node:child_process';
import {
  createWriteStream,
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const KEEP = 3;
const settingsFile = join(here, 'offsite.env');
const i = process.argv.indexOf('--to');
let to = i > 0 ? process.argv[i + 1] : undefined;
if (to) {
  to = resolve(to);
  writeFileSync(settingsFile, `# Where copy-offsite.mjs writes the storage copies.\nOFFSITE_DIR=${to}\n`);
} else if (existsSync(settingsFile)) {
  to = /^OFFSITE_DIR=(.*)$/m.exec(readFileSync(settingsFile, 'utf8'))?.[1]?.trim();
}
if (!to) {
  console.error('Give the folder once: node deploy/home/copy-offsite.mjs --to "<folder>"');
  process.exit(1);
}
if (!existsSync(to) || !statSync(to).isDirectory()) {
  console.error(
    `${to} is not a folder that exists. Create it (and check the drive is connected), then try again.`,
  );
  process.exit(1);
}

const stamp = new Date()
  .toISOString()
  .replace(/[-:]/g, '')
  .replace(/\.\d{3}/, '');
const name = `innpilot-storage-${stamp}.tar`;
const partial = join(to, `${name}.partial`);

// The storage gateway keeps object details in extended attributes; the archive keeps them so a rebuild can use it.
const tar = spawn(
  'docker',
  [
    'run',
    '--rm',
    '-v',
    'innpilot-staging_storagedata:/from:ro',
    'debian:bookworm-slim',
    'tar',
    '--xattrs',
    '--xattrs-include=*',
    '-C',
    '/from',
    '-cf',
    '-',
    '.',
  ],
  { stdio: ['ignore', 'pipe', 'inherit'] },
);
const file = createWriteStream(partial);
tar.stdout.pipe(file);
// Both: docker has exited, and every byte is written to the file.
const [code] = await Promise.all([
  new Promise((r) => tar.on('close', r)),
  new Promise((r) => file.on('close', r)),
]);
const bytes = existsSync(partial) ? statSync(partial).size : 0;
if (code !== 0 || bytes === 0) {
  rmSync(partial, { force: true });
  console.error(`The copy failed (exit ${code}); nothing was replaced in ${to}.`);
  process.exit(1);
}
renameSync(partial, join(to, name));

const copies = readdirSync(to)
  .filter((f) => /^innpilot-storage-\d{8}T\d{6}Z\.tar$/.test(f))
  .sort();
for (const old of copies.slice(0, Math.max(0, copies.length - KEEP))) rmSync(join(to, old));
console.log(
  `Copied ${(bytes / 1024 / 1024).toFixed(1)} MB to ${join(to, name)}; ${Math.min(copies.length, KEEP)} copies kept.`,
);
