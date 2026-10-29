/**
 * Backup retention (P6-7): every nightly backup is kept for DAILY_DAYS; the first backup of each month is also kept
 * as that month's copy, for MONTHLY_COUNT months. The periods are defaults until the accountant and legal adviser
 * confirm them (Phase 6 plan, "for qualified people").
 */
export const DAILY_DAYS = 35;
export const MONTHLY_COUNT = 12;

/** Object keys: daily/<UTC timestamp>.ipbk and monthly/<YYYY-MM>.ipbk. */
export const dailyKey = (at: Date) => `daily/${stamp(at)}.ipbk`;
export const monthlyKey = (at: Date) => `monthly/${at.toISOString().slice(0, 7)}.ipbk`;
export const LATEST_KEY = 'latest.json';

export function stamp(at: Date): string {
  return at
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
}

/** Which backup objects to delete, given every key in the bucket and the current time. Never the newest daily. */
export function expired(keys: string[], now: Date): string[] {
  const out: string[] = [];
  const cutoff = new Date(now.getTime() - DAILY_DAYS * 86_400_000);
  const daily = keys.filter((k) => /^daily\/\d{8}T\d{6}Z\.ipbk$/.test(k)).sort();
  const newestDaily = daily.at(-1);
  for (const k of daily) {
    const at = parseStamp(k.slice('daily/'.length, -'.ipbk'.length));
    if (k !== newestDaily && at < cutoff) out.push(k);
  }
  const monthly = keys.filter((k) => /^monthly\/\d{4}-\d{2}\.ipbk$/.test(k)).sort();
  out.push(...monthly.slice(0, Math.max(0, monthly.length - MONTHLY_COUNT)));
  return out;
}

/** The latest scheduled time (`HH:MM` UTC, every day) at or before `now`. */
export function previousRun(at: string, now: Date): Date {
  const [h, m] = at.split(':').map(Number) as [number, number];
  const run = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), h, m));
  if (run > now) run.setUTCDate(run.getUTCDate() - 1);
  return run;
}

/**
 * Whether a nightly backup was missed: there is none yet, or the last one finished before the latest scheduled
 * time. A computer that is switched off at night (home staging, an on-premises install, D22) never reaches the
 * scheduled time, so the scheduler checks this when it starts and backs up straight away.
 */
export function missedBackup(lastFinishedAt: Date | null, at: string, now: Date): boolean {
  return !lastFinishedAt || lastFinishedAt < previousRun(at, now);
}

function parseStamp(s: string): Date {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(s)!;
  return new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!));
}
