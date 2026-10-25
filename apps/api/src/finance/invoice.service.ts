import { Injectable } from '@nestjs/common';
import type { InvoiceDto, InvoiceSummaryDto } from '@innpilot/contracts';
import { schema, type Tx } from '@innpilot/db';
import { Money } from '@innpilot/money';
import { and, asc, eq } from 'drizzle-orm';
import { AppError } from '../common/app-error';
import type { AuthContext } from '../common/request';
import { Db } from '../db/db.module';
import { FolioService } from './folio.service';
import { PostingService } from './posting.service';

const inv = schema.invoices;
const lines = schema.invoiceLines;
type PropertyRow = typeof schema.properties.$inferSelect;

const pad = (n: number) => String(n).padStart(6, '0');
const money2 = (v: string) => v.replace(/^(-?\d+)\.(\d{2})\d*$/, '$1.$2');

/**
 * Invoices (P3-17, D8): issued at check-out from a settled folio and frozen at that moment — lines, tax summary and
 * the hotel's details are copied, so later edits to the folio set-up, tax rates or invoice profile never change an
 * issued invoice. Numbers are gapless per property. Not a certified tax invoice (local review needed before use).
 */
@Injectable()
export class InvoiceService {
  constructor(
    private readonly db: Db,
    private readonly folios: FolioService,
    private readonly posting: PostingService,
  ) {}

  get(auth: AuthContext, propertyId: string, id: string): Promise<InvoiceDto> {
    return this.db.tenant(auth.tenantId, async (tx) => {
      const [row] = await tx
        .select({
          i: inv,
          ref: schema.reservations.bookingReference,
          label: schema.folios.label,
          by: schema.users.fullName,
        })
        .from(inv)
        .innerJoin(schema.reservations, eq(schema.reservations.id, inv.reservationId))
        .innerJoin(schema.folios, eq(schema.folios.id, inv.folioId))
        .leftJoin(schema.users, eq(schema.users.id, inv.createdBy))
        .where(and(eq(inv.propertyId, propertyId), eq(inv.id, id)));
      if (!row) throw AppError.notFound('invoice');
      const items = await tx.select().from(lines).where(eq(lines.invoiceId, id)).orderBy(asc(lines.lineNo));
      const hotel = row.i.hotel as InvoiceDto['hotel'];
      return {
        id: row.i.id,
        invoiceNumber: row.i.invoiceNumber,
        issueDate: row.i.issueDate,
        currencyCode: row.i.currencyCode,
        billTo: row.i.billTo,
        bookingReference: row.ref,
        folioId: row.i.folioId,
        folioLabel: row.label,
        reservationId: row.i.reservationId,
        net: money2(row.i.netAmount),
        tax: money2(row.i.taxAmount),
        gross: money2(row.i.grossAmount),
        paid: money2(row.i.paidAmount),
        writtenOff: money2(row.i.writtenOff),
        balanceDue: money2(row.i.balanceDue),
        taxSummary: row.i.taxSummary as InvoiceDto['taxSummary'],
        lines: items.map((l) => ({
          lineNo: l.lineNo,
          kind: l.kind,
          description: l.description,
          serviceDate: l.serviceDate,
          quantity: l.quantity.replace(/\.00$/, ''),
          unitPrice: money2(l.unitPrice),
          net: money2(l.netAmount),
          tax: money2(l.taxAmount),
          gross: money2(l.grossAmount),
        })),
        hotel,
        createdByName: row.by,
        createdAt: row.i.createdAt.toISOString(),
      };
    });
  }

  /** Issues the invoice of a folio from its posted items. Returns null for a folio with nothing on it. */
  async issue(
    tx: Tx,
    auth: AuthContext,
    property: PropertyRow,
    folioId: string,
  ): Promise<InvoiceSummaryDto | null> {
    const folio = await this.folios.load(tx, property, folioId);
    const items = folio.charges.filter((c) => c.status === 'posted');
    if (items.length === 0) return null;
    const cur = folio.currencyCode;
    const [profile] = await tx
      .select()
      .from(schema.invoiceProfiles)
      .where(eq(schema.invoiceProfiles.propertyId, property.id));
    const number = `${profile?.invoicePrefix ?? 'INV-'}${pad(
      await this.posting.nextNumber(tx, auth.tenantId, property.id, 'invoice'),
    )}`;

    // Tax summary by code, rate and inclusivity, from each item's own snapshot (TAX-001).
    const summary = new Map<
      string,
      { code: string; name: string; ratePercent: string; inclusive: boolean; base: Money; amount: Money }
    >();
    for (const item of items) {
      for (const t of item.taxes) {
        const k = `${t.code}|${t.ratePercent}|${t.inclusive}`;
        const s = summary.get(k) ?? {
          code: t.code,
          name: t.name,
          ratePercent: t.ratePercent,
          inclusive: t.inclusive,
          base: Money.zero(cur),
          amount: Money.zero(cur),
        };
        s.base = s.base.add(Money.of(item.net, cur));
        s.amount = s.amount.add(Money.of(t.amount, cur));
        summary.set(k, s);
      }
    }

    const paid = Money.of(folio.received, cur).subtract(Money.of(folio.refunded, cur));
    const [row] = await tx
      .insert(inv)
      .values({
        tenantId: auth.tenantId,
        propertyId: property.id,
        folioId,
        reservationId: folio.reservationId,
        invoiceNumber: number,
        issueDate: property.businessDate,
        currencyCode: cur,
        billTo:
          folio.isPrimary || folio.label === 'Main' ? folio.guestName : `${folio.guestName} (${folio.label})`,
        netAmount: Money.of(folio.posted.net, cur).toStorage(),
        taxAmount: Money.of(folio.posted.tax, cur).toStorage(),
        grossAmount: Money.of(folio.posted.gross, cur).toStorage(),
        paidAmount: paid.toStorage(),
        writtenOff: Money.of(folio.writtenOff, cur).toStorage(),
        balanceDue: Money.of(folio.balance, cur).toStorage(),
        taxSummary: [...summary.values()].map((s) => ({
          code: s.code,
          name: s.name,
          ratePercent: s.ratePercent,
          inclusive: s.inclusive,
          base: s.base.toString(),
          amount: s.amount.toString(),
        })),
        hotel: {
          name: property.name,
          legalName: profile?.legalName ?? property.legalName ?? null,
          address: profile?.address ?? null,
          registrationFields: profile?.registrationFields ?? [],
          footer: profile?.footer ?? null,
        },
        createdBy: auth.userId,
      })
      .returning();
    await tx.insert(lines).values(
      items.map((item, i) => ({
        tenantId: auth.tenantId,
        propertyId: property.id,
        invoiceId: row!.id,
        lineNo: i + 1,
        kind: item.kind,
        description: item.description,
        serviceDate: item.serviceDate,
        quantity: item.quantity,
        unitPrice: Money.of(item.unitPrice, cur).toStorage(),
        netAmount: Money.of(item.net, cur).toStorage(),
        taxAmount: Money.of(item.tax, cur).toStorage(),
        grossAmount: Money.of(item.gross, cur).toStorage(),
        taxes: item.taxes.map((t) => ({ code: t.code, ratePercent: t.ratePercent, amount: t.amount })),
      })),
    );
    return {
      id: row!.id,
      invoiceNumber: number,
      folioId,
      issueDate: row!.issueDate,
      gross: folio.posted.gross,
      balanceDue: folio.balance,
    };
  }
}
