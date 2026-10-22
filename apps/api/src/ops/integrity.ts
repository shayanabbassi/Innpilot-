import type { Client } from 'pg';
import type { BackupManifest } from './backup-format';

export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

/** A migration as this release ships it. */
export interface ReleaseMigration {
  name: string;
  checksum: string;
}

/**
 * Integrity checks for a restored database (P6-8). Each is a property the application relies on and that a
 * damaged or incomplete restore would break. Run as the database owner, so row-level security does not hide rows.
 */
export async function runIntegrityChecks(
  db: Client,
  manifest: BackupManifest,
  release: ReleaseMigration[],
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const check = async (name: string, fn: () => Promise<{ ok: boolean; detail: string }>) => {
    try {
      results.push({ name, ...(await fn()) });
    } catch (err) {
      results.push({ name, ok: false, detail: `could not run: ${err instanceof Error ? err.message : err}` });
    }
  };
  const one = async <T>(text: string, values: unknown[] = []) => (await db.query(text, values)).rows[0] as T;

  await check('Migrations at the expected version', async () => {
    const rows = (
      await db.query<{ name: string; checksum: string }>(
        'SELECT name, checksum FROM schema_migrations ORDER BY name',
      )
    ).rows;
    const names = rows.map((r) => r.name);
    const shipped = new Map(release.map((m) => [m.name, m.checksum]));
    const unknown = rows.filter((r) => shipped.get(r.name) !== r.checksum).map((r) => r.name);
    const sameAsBackup = JSON.stringify(names) === JSON.stringify(manifest.migrations);
    const latest = names.at(-1) ?? 'none';
    const releaseLatest = release.at(-1)?.name ?? 'none';
    return {
      ok: sameAsBackup && unknown.length === 0,
      detail:
        `${names.length} applied, latest ${latest}` +
        (latest === releaseLatest
          ? ' (same as this release)'
          : `; this release ships up to ${releaseLatest}`) +
        (sameAsBackup ? '' : '; differs from the backup manifest') +
        (unknown.length ? `; not in this release or changed: ${unknown.join(', ')}` : ''),
    };
  });

  await check('Every table has the rows it had when backed up', async () => {
    const wrong: string[] = [];
    for (const [table, expected] of Object.entries(manifest.rowCounts)) {
      const r = await one<{ n: string }>(`SELECT count(*) AS n FROM public.${db.escapeIdentifier(table)}`);
      if (Number(r.n) !== expected) wrong.push(`${table}: ${r.n} instead of ${expected}`);
    }
    const total = Object.values(manifest.rowCounts).reduce((a, b) => a + b, 0);
    return {
      ok: wrong.length === 0,
      detail: wrong.length
        ? wrong.join('; ')
        : `${Object.keys(manifest.rowCounts).length} tables, ${total.toLocaleString('en')} rows`,
    };
  });

  await check("Every tenant's trial balance balances", async () => {
    const r = await one<{ tenants: number; bad: number; entries: number; bad_entries: number }>(`
      WITH lines AS (
        SELECT e.tenant_id, e.id, e.total_debit, e.total_credit, sum(l.debit) AS dr, sum(l.credit) AS cr
        FROM journal_entries e JOIN journal_lines l ON l.journal_entry_id = e.id
        WHERE e.status <> 'draft'
        GROUP BY e.tenant_id, e.id, e.total_debit, e.total_credit
      ), tenants AS (
        SELECT tenant_id, sum(dr) AS dr, sum(cr) AS cr FROM lines GROUP BY tenant_id
      )
      SELECT (SELECT count(*)::int FROM tenants) AS tenants,
             (SELECT count(*)::int FROM tenants WHERE dr <> cr) AS bad,
             (SELECT count(*)::int FROM lines) AS entries,
             (SELECT count(*)::int FROM lines WHERE dr <> cr OR dr <> total_debit OR cr <> total_credit) AS bad_entries`);
    return {
      ok: r.bad === 0 && r.bad_entries === 0,
      detail: `${r.tenants} tenants, ${r.entries.toLocaleString('en')} posted journals; unbalanced: ${r.bad} tenants, ${r.bad_entries} journals`,
    };
  });

  await check('Folio balances equal their ledger lines', async () => {
    // A folio's own balance (posted charges less payments, plus refunds, less write-off) against the receivable and
    // deposit lines tagged with it: the same reconciliation the folio screen and receivables report rely on.
    // Each side is totalled once per folio in a single pass, so this stays fast on a year of data.
    const r = await one<{ folios: number; bad: number; sample: string | null }>(`
      WITH charges AS (
        SELECT folio_id, sum(gross_amount) AS s FROM folio_charges WHERE status = 'posted' GROUP BY folio_id
      ), paid AS (
        SELECT folio_id, sum(amount) AS s FROM payments GROUP BY folio_id
      ), refunded AS (
        SELECT p.folio_id, sum(rf.amount) AS s FROM refunds rf JOIN payments p ON p.id = rf.payment_id
        GROUP BY p.folio_id
      ), ledger AS (
        SELECT l.folio_id, sum(l.debit - l.credit) AS s
        FROM journal_lines l
        JOIN journal_entries e ON e.id = l.journal_entry_id
        JOIN accounts a ON a.id = l.account_id
        WHERE l.folio_id IS NOT NULL AND e.status <> 'draft'
          AND a.system_role IN ('guest_receivable', 'guest_deposits')
        GROUP BY l.folio_id
      ), f AS (
        SELECT fo.id,
               coalesce(c.s, 0) - coalesce(p.s, 0) + coalesce(rf.s, 0) - fo.written_off AS own,
               coalesce(lg.s, 0) AS ledger
        FROM folios fo
        LEFT JOIN charges c ON c.folio_id = fo.id
        LEFT JOIN paid p ON p.folio_id = fo.id
        LEFT JOIN refunded rf ON rf.folio_id = fo.id
        LEFT JOIN ledger lg ON lg.folio_id = fo.id
      )
      SELECT count(*)::int AS folios, count(*) FILTER (WHERE own <> ledger)::int AS bad,
             min(id::text) FILTER (WHERE own <> ledger) AS sample
      FROM f`);
    return {
      ok: r.bad === 0,
      detail: `${r.folios.toLocaleString('en')} folios; ${r.bad} differ${r.sample ? ` (e.g. folio ${r.sample})` : ''}`,
    };
  });

  await check('Cash and bank accounts equal their ledger accounts', async () => {
    const r = await one<{ accounts: number; untagged: number; misposted: number }>(`
      SELECT (SELECT count(*)::int FROM cash_accounts) AS accounts,
             (SELECT count(*)::int FROM journal_lines l JOIN journal_entries e ON e.id = l.journal_entry_id
               WHERE e.status <> 'draft' AND l.cash_account_id IS NULL
                 AND l.account_id IN (SELECT ledger_account_id FROM cash_accounts)) AS untagged,
             (SELECT count(*)::int FROM journal_lines l JOIN cash_accounts c ON c.id = l.cash_account_id
               WHERE l.account_id <> c.ledger_account_id) AS misposted`);
    return {
      ok: r.untagged === 0 && r.misposted === 0,
      detail: `${r.accounts} cash and bank accounts; ledger lines without their account: ${r.untagged}; on the wrong ledger account: ${r.misposted}`,
    };
  });

  await check('Audit log intact and append-only', async () => {
    const r = await one<{ events: string; triggers: number; latest: Date | null }>(`
      SELECT (SELECT count(*) FROM audit_events) AS events,
             (SELECT count(*)::int FROM pg_trigger WHERE tgrelid = 'public.audit_events'::regclass
               AND tgname IN ('audit_events_append_only', 'audit_events_no_truncate') AND tgenabled <> 'D') AS triggers,
             (SELECT max(occurred_at) FROM audit_events) AS latest`);
    const afterBackup = r.latest && r.latest.getTime() > Date.parse(manifest.createdAt) + 60_000;
    return {
      ok: r.triggers === 2 && !afterBackup && Number(r.events) === (manifest.rowCounts.audit_events ?? -1),
      detail: `${Number(r.events).toLocaleString('en')} events, append-only guards ${r.triggers === 2 ? 'in place' : 'MISSING'}${afterBackup ? ', events dated after the backup' : ''}`,
    };
  });

  await check('Row-level security on every tenant table', async () => {
    const r = await one<{ tables: number; missing: string | null }>(`
      SELECT count(*)::int AS tables,
             string_agg(c.relname, ', ' ORDER BY c.relname) FILTER (WHERE NOT c.relrowsecurity) AS missing
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'
        AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped)`);
    return {
      ok: !r.missing,
      detail: r.missing
        ? `without row-level security: ${r.missing}`
        : `${r.tables} tables with tenant data, all protected`,
    };
  });

  return results;
}
