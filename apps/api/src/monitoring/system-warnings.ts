import type { SystemWarningDto } from '@innpilot/contracts';

/** The same thresholds as deploy/monitoring/alerts.yml (InnPilotBackupTooOld, InnPilotJobBacklog). */
export const BACKUP_MAX_AGE_HOURS = 26;
export const JOB_BACKLOG_SECONDS = 900;

export interface SystemState {
  /** Backup runs recorded in backup_runs. */
  backupRuns: number;
  lastGoodBackupAt: Date | null;
  lastBackupOk: boolean | null;
  jobsFailed24h: number;
  oldestQueuedSeconds: number;
}

/** What the owner and manager should be told, worst first. Empty when all is well. */
export function systemWarnings(s: SystemState, now: Date): SystemWarningDto[] {
  const out: SystemWarningDto[] = [];
  if (!s.lastGoodBackupAt) {
    out.push({ code: 'backup_missing', severity: 'critical', since: null, count: null });
  } else if (now.getTime() - s.lastGoodBackupAt.getTime() > BACKUP_MAX_AGE_HOURS * 3_600_000) {
    out.push({
      code: 'backup_too_old',
      severity: 'critical',
      since: s.lastGoodBackupAt.toISOString(),
      count: null,
    });
  }
  if (s.backupRuns > 0 && s.lastBackupOk === false) {
    out.push({ code: 'backup_failed', severity: 'critical', since: null, count: null });
  }
  if (s.jobsFailed24h > 0) {
    out.push({ code: 'jobs_failing', severity: 'warning', since: null, count: s.jobsFailed24h });
  }
  if (s.oldestQueuedSeconds > JOB_BACKLOG_SECONDS) {
    out.push({
      code: 'jobs_backlog',
      severity: 'warning',
      since: new Date(now.getTime() - s.oldestQueuedSeconds * 1000).toISOString(),
      count: null,
    });
  }
  return out;
}
