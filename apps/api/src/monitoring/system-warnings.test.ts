import { describe, expect, it } from 'vitest';
import { systemWarnings, type SystemState } from './system-warnings';

const now = new Date('2026-10-29T12:00:00Z');
const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000);
const healthy: SystemState = {
  backupRuns: 3,
  lastGoodBackupAt: hoursAgo(2),
  lastBackupOk: true,
  jobsFailed24h: 0,
  oldestQueuedSeconds: 0,
};
const codes = (s: Partial<SystemState>) => systemWarnings({ ...healthy, ...s }, now).map((w) => w.code);

describe('system warnings', () => {
  it('says nothing when backups are recent and background work is fine', () => {
    expect(systemWarnings(healthy, now)).toEqual([]);
  });

  it('warns when no backup has ever succeeded', () => {
    expect(codes({ backupRuns: 0, lastGoodBackupAt: null, lastBackupOk: null })).toEqual(['backup_missing']);
  });

  it('warns when the last good backup is older than 26 hours, with its time', () => {
    expect(codes({ lastGoodBackupAt: hoursAgo(25) })).toEqual([]);
    const [w] = systemWarnings({ ...healthy, lastGoodBackupAt: hoursAgo(27) }, now);
    expect(w).toEqual({
      code: 'backup_too_old',
      severity: 'critical',
      since: hoursAgo(27).toISOString(),
      count: null,
    });
  });

  it('warns when the latest attempt failed, even with an older good backup', () => {
    expect(codes({ lastBackupOk: false })).toEqual(['backup_failed']);
  });

  it('warns about failed and long-waiting background work, as warnings not critical', () => {
    const w = systemWarnings({ ...healthy, jobsFailed24h: 2, oldestQueuedSeconds: 1200 }, now);
    expect(w.map((x) => [x.code, x.severity, x.count])).toEqual([
      ['jobs_failing', 'warning', 2],
      ['jobs_backlog', 'warning', null],
    ]);
    expect(codes({ oldestQueuedSeconds: 900 })).toEqual([]);
  });
});
