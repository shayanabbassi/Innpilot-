import type { Permission } from '@innpilot/contracts';
import { schema, type Tx } from '@innpilot/db';
import { asc, eq, sql, type SQL } from 'drizzle-orm';
import { AppError } from '../common/app-error';
import type { AuthContext } from '../common/request';

/**
 * Which properties a report may read (P5-3). One property needs the permission on it; all properties (no
 * `propertyId`) need it from a tenant-wide role. The server decides; the screen only offers what is allowed.
 */
export function reportScope(auth: AuthContext, permission: Permission, propertyId: string | undefined) {
  if (propertyId) {
    const perms = auth.permissionsByProperty.get(propertyId);
    // A property the caller cannot see is reported as missing, whoever owns it.
    if (!perms) throw AppError.notFound('property');
    if (!perms.has(permission)) throw AppError.forbidden();
    return { propertyId };
  }
  if (!auth.tenantWidePermissions.has(permission)) {
    throw AppError.forbidden(
      'Choose a property: reports for all properties need a role for the whole hotel group.',
    );
  }
  return { propertyId: null };
}

/** `and e.property_id = …` for a journal entry alias `e`, or nothing for all properties. */
export function propertyFilter(propertyId: string | null): SQL {
  return propertyId ? sql`and e.property_id = ${propertyId}` : sql``;
}

/**
 * Year-end closing entries and their reversals (P5-5). The P&L leaves them out so that a range including
 * 31 December still shows that year's result; the balance sheet keeps them.
 */
export const notYearEndClose = sql`not (e.source_type = 'year_end_close' or exists (
  select 1 from journal_entries o where o.id = e.reverses_entry_id and o.source_type = 'year_end_close'))`;

/** The ledger is kept in the tenant's base currency. */
export async function ledgerCurrency(tx: Tx): Promise<string> {
  const [tenant] = await tx.select({ c: schema.tenants.baseCurrency }).from(schema.tenants);
  if (!tenant) throw AppError.notFound('tenant');
  return tenant.c;
}

/** The property's timezone, or the first property's for an all-properties report. */
export async function reportTimezone(tx: Tx, propertyId: string | null): Promise<string | null> {
  const p = schema.properties;
  const [row] = propertyId
    ? await tx.select({ tz: p.timezone }).from(p).where(eq(p.id, propertyId))
    : await tx.select({ tz: p.timezone }).from(p).orderBy(asc(p.createdAt)).limit(1);
  return row?.tz ?? null;
}

// ------------------------------------------------------------------------------------------- hotel dates

const DAY = 86_400_000;
const toDate = (d: string) => new Date(`${d}T00:00:00Z`);
const fromDate = (d: Date) => d.toISOString().slice(0, 10);

export function addDays(d: string, days: number): string {
  return fromDate(new Date(toDate(d).getTime() + days * DAY));
}

export function daysBetween(from: string, to: string): number {
  // Both are UTC midnights, so the difference is an exact number of days.
  return (toDate(to).getTime() - toDate(from).getTime()) / DAY;
}

/** The same date a year earlier; 29 February becomes 28 February. */
export function previousYear(d: string): string {
  const [y, m, day] = d.split('-').map(Number) as [number, number, number];
  const last = new Date(Date.UTC(y - 1, m, 0)).getUTCDate();
  return `${String(y - 1).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(Math.min(day, last)).padStart(2, '0')}`;
}
