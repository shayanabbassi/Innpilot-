import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  generateBackupKeys,
  keyId,
  openBackup,
  readManifest,
  sealBackup,
  type BackupManifest,
} from './backup-format';
import { dailyKey, expired, missedBackup, monthlyKey, previousRun } from './retention';

const keys = generateBackupKeys();
const other = generateBackupKeys();
const dump = Buffer.concat([Buffer.from('PGDMP'), randomBytes(4096)]);
const manifest = (): BackupManifest => ({
  database: 'innpilot',
  createdAt: '2026-10-22T21:00:00.000Z',
  serverVersion: '16.10',
  migrations: ['0001_foundation.sql', '0025_jobs.sql'],
  rowCounts: { tenants: 2, journal_lines: 40 },
  dumpBytes: dump.length,
  dumpSha256: createHash('sha256').update(dump).digest('hex'),
});

describe('backup file', () => {
  it('round-trips with the private key and never holds the dump in the clear', () => {
    const file = sealBackup(dump, manifest(), keys.publicKey);
    expect(file.includes(Buffer.from('PGDMP'))).toBe(false);
    expect(file.includes(dump.subarray(5, 64))).toBe(false);
    const opened = openBackup(file, keys.privateKey);
    expect(opened.dump.equals(dump)).toBe(true);
    expect(opened.manifest).toEqual(manifest());
    expect(readManifest(file).rowCounts).toEqual({ tenants: 2, journal_lines: 40 });
  });

  it('cannot be opened with another key pair', () => {
    const file = sealBackup(dump, manifest(), keys.publicKey);
    expect(() => openBackup(file, other.privateKey)).toThrow();
    expect(keyId(keys.publicKey)).not.toBe(keyId(other.publicKey));
  });

  it('detects any change to the data or the manifest', () => {
    const file = sealBackup(dump, manifest(), keys.publicKey);
    const flipped = Buffer.from(file);
    flipped[flipped.length - 100]! ^= 1;
    expect(() => openBackup(flipped, keys.privateKey)).toThrow();
    const edited = Buffer.from(file.toString('latin1').replace('"tenants":2', '"tenants":3'), 'latin1');
    expect(() => openBackup(edited, keys.privateKey)).toThrow();
    expect(() => openBackup(file.subarray(0, file.length - 10), keys.privateKey)).toThrow();
    expect(() => openBackup(Buffer.from('not a backup'), keys.privateKey)).toThrow(/Not an InnPilot backup/);
  });
});

describe('retention', () => {
  const now = new Date('2026-10-22T21:00:00Z');
  const day = (n: number) => dailyKey(new Date(now.getTime() - n * 86_400_000));

  it('keeps 35 days of nightly backups and 12 monthly copies', () => {
    const daily = Array.from({ length: 40 }, (_, i) => day(i));
    const monthly = Array.from({ length: 14 }, (_, i) => monthlyKey(new Date(Date.UTC(2025, 8 + i, 1))));
    const gone = expired([...daily, ...monthly, 'latest.json'], now);
    expect(gone.filter((k) => k.startsWith('daily/'))).toEqual([day(36), day(37), day(38), day(39)].sort());
    expect(gone.filter((k) => k.startsWith('monthly/'))).toEqual([
      'monthly/2025-09.ipbk',
      'monthly/2025-10.ipbk',
    ]);
    expect(gone).not.toContain('latest.json');
  });

  it('never deletes the newest backup, however old', () => {
    expect(expired([day(90)], now)).toEqual([]);
  });

  it('ignores objects it did not write', () => {
    expect(expired(['daily/notes.txt', 'other/2020.ipbk'], now)).toEqual([]);
  });
});

describe('missed nightly backups', () => {
  const at = '21:00';
  const t = (iso: string) => new Date(iso);

  it('finds the latest scheduled time at or before now', () => {
    expect(previousRun(at, t('2026-10-29T12:37:00Z')).toISOString()).toBe('2026-10-28T21:00:00.000Z');
    expect(previousRun(at, t('2026-10-29T21:00:00Z')).toISOString()).toBe('2026-10-29T21:00:00.000Z');
    expect(previousRun(at, t('2026-11-01T00:30:00Z')).toISOString()).toBe('2026-10-31T21:00:00.000Z');
  });

  it('is missed when the computer was off at the scheduled time (home staging, 2026-10-29)', () => {
    // Last backup on the 25th at 13:50; switched off every night since; started again on the 29th at noon.
    expect(missedBackup(t('2026-10-25T13:50:58Z'), at, t('2026-10-29T12:37:18Z'))).toBe(true);
  });

  it('is missed when there is no backup at all', () => {
    expect(missedBackup(null, at, t('2026-10-29T12:00:00Z'))).toBe(true);
  });

  it('is not missed when last night ran, or a backup was taken since', () => {
    expect(missedBackup(t('2026-10-28T21:00:40Z'), at, t('2026-10-29T12:00:00Z'))).toBe(false);
    expect(missedBackup(t('2026-10-29T09:15:00Z'), at, t('2026-10-29T12:00:00Z'))).toBe(false);
  });
});
