import { z } from 'zod';

/**
 * System warnings shown inside InnPilot (7.2, owner's choice: no outside alert service). On an on-premises or home
 * install nobody watches a monitoring screen, so the owner and manager see backup and background-work problems as a
 * banner. The same conditions as the alert rules in deploy/monitoring/alerts.yml.
 */
export const SYSTEM_WARNING_CODES = [
  'backup_missing',
  'backup_too_old',
  'backup_failed',
  'jobs_failing',
  'jobs_backlog',
] as const;
export type SystemWarningCode = (typeof SYSTEM_WARNING_CODES)[number];

export const systemWarningDto = z.object({
  code: z.enum(SYSTEM_WARNING_CODES),
  severity: z.enum(['critical', 'warning']),
  /** When the condition started, where known (the last good backup, the oldest waiting job). */
  since: z.string().nullable(),
  /** How many, where it is a count (failed jobs in the last 24 hours). */
  count: z.number().int().nullable(),
});
export type SystemWarningDto = z.infer<typeof systemWarningDto>;

export const systemWarningsDto = z.object({
  /** Off on a hosted multi-hotel service, where the operator watches these; on for a single-hotel install. */
  enabled: z.boolean(),
  checkedAt: z.string(),
  warnings: z.array(systemWarningDto),
});
export type SystemWarningsDto = z.infer<typeof systemWarningsDto>;
