import { Injectable } from '@nestjs/common';
import type { CreateSupplierRequest, SupplierDto, UpdateSupplierRequest } from '@innpilot/contracts';
import { schema, type Tx } from '@innpilot/db';
import { Money } from '@innpilot/money';
import { asc, eq, sql } from 'drizzle-orm';
import { AuditService, changeSet } from '../audit/audit.service';
import { AppError } from '../common/app-error';
import { PG_UNIQUE_VIOLATION, pgErrorCode } from '../common/pg-error';
import type { AuthContext, RequestMeta } from '../common/request';
import { Db } from '../db/db.module';

const s = schema.suppliers;
type Row = typeof s.$inferSelect;

/**
 * Suppliers, shared by the tenant's properties. What each is owed is read from the accounts payable lines that carry
 * it, so it always agrees with the ledger. Suppliers are never deleted; they are made inactive.
 */
@Injectable()
export class SuppliersService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  list(auth: AuthContext): Promise<SupplierDto[]> {
    return this.db.tenant(auth.tenantId, async (tx) => this.dtos(tx));
  }

  async create(auth: AuthContext, body: CreateSupplierRequest, meta: RequestMeta): Promise<SupplierDto> {
    try {
      return await this.db.tenant(auth.tenantId, async (tx) => {
        const [row] = await tx
          .insert(s)
          .values({
            tenantId: auth.tenantId,
            name: body.name,
            contact: body.contact || null,
            taxIdentifier: body.taxIdentifier || null,
            paymentTermsDays: body.paymentTermsDays,
            notes: body.notes || null,
          })
          .returning();
        await this.record(tx, auth, meta, 'supplier.created', row!.id, { name: row!.name });
        return (await this.dtos(tx, row!.id))[0]!;
      });
    } catch (err) {
      throw this.duplicate(err);
    }
  }

  async update(
    auth: AuthContext,
    id: string,
    body: UpdateSupplierRequest,
    meta: RequestMeta,
  ): Promise<SupplierDto> {
    try {
      return await this.db.tenant(auth.tenantId, async (tx) => {
        const [before] = await tx.select().from(s).where(eq(s.id, id)).for('update');
        if (!before) throw AppError.notFound('supplier');
        const set = {
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.contact !== undefined ? { contact: body.contact || null } : {}),
          ...(body.taxIdentifier !== undefined ? { taxIdentifier: body.taxIdentifier || null } : {}),
          ...(body.paymentTermsDays !== undefined ? { paymentTermsDays: body.paymentTermsDays } : {}),
          ...(body.notes !== undefined ? { notes: body.notes || null } : {}),
          ...(body.active !== undefined ? { active: body.active } : {}),
        };
        // Drizzle refuses an update with nothing to set.
        const row: Row = Object.keys(set).length
          ? (await tx.update(s).set(set).where(eq(s.id, id)).returning())[0]!
          : before;
        // Tax identifiers stay out of the audit log; only that one changed is recorded.
        const changes = changeSet(before, row, ['name', 'contact', 'paymentTermsDays', 'notes', 'active']);
        if (before.taxIdentifier !== row.taxIdentifier) changes.taxIdentifier = { from: '…', to: '…' };
        if (Object.keys(changes).length > 0) {
          await this.record(tx, auth, meta, 'supplier.updated', id, { name: row.name, ...changes });
        }
        return (await this.dtos(tx, id))[0]!;
      });
    } catch (err) {
      throw this.duplicate(err);
    }
  }

  private async dtos(tx: Tx, id?: string): Promise<SupplierDto[]> {
    const [tenant] = await tx.select({ c: schema.tenants.baseCurrency }).from(schema.tenants);
    const cur = tenant?.c ?? 'PKR';
    const rows = await tx
      .select({
        s,
        owed: sql<string>`(select coalesce(sum(l.credit - l.debit), 0)::text
          from journal_lines l join journal_entries e on e.id = l.journal_entry_id
          where l.supplier_id = suppliers.id and e.status <> 'draft')`,
        openBills: sql<string>`(select count(*)::text from expense_vouchers v
          where v.supplier_id = suppliers.id and v.status in ('approved', 'partly_paid'))`,
      })
      .from(s)
      .where(id ? eq(s.id, id) : undefined)
      .orderBy(asc(s.name));
    return rows.map(({ s: r, owed, openBills }) => ({
      id: r.id,
      name: r.name,
      contact: r.contact,
      taxIdentifier: r.taxIdentifier,
      paymentTermsDays: r.paymentTermsDays,
      notes: r.notes,
      active: r.active,
      owed: Money.fromStorage(owed, cur).round().toString(),
      openBills: Number(openBills),
    }));
  }

  private duplicate(err: unknown) {
    if (pgErrorCode(err) === PG_UNIQUE_VIOLATION) {
      return AppError.validation('A supplier with this name already exists.', [
        { path: 'name', message: 'Another supplier has this name.' },
      ]);
    }
    return err;
  }

  private async record(
    tx: Tx,
    auth: AuthContext,
    meta: RequestMeta,
    action: string,
    id: string,
    changes: Record<string, unknown>,
  ) {
    await this.audit.record(
      tx,
      {
        tenantId: auth.tenantId,
        actor: { type: 'user', userId: auth.userId },
        action,
        entityType: 'supplier',
        entityId: id,
        changes,
      },
      meta,
    );
  }
}
