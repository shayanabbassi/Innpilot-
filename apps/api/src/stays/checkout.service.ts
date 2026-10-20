import { Injectable } from '@nestjs/common';
import type {
  CheckOutRequest,
  CheckOutResultDto,
  CheckoutPreviewDto,
  FolioDto,
  FolioSettlement,
  InvoiceSummaryDto,
  Permission,
} from '@innpilot/contracts';
import { schema, type Tx } from '@innpilot/db';
import { Money } from '@innpilot/money';
import { and, asc, eq, isNull, ne, sql } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service';
import { AppError } from '../common/app-error';
import { PG_EXCLUSION_VIOLATION, pgErrorCode } from '../common/pg-error';
import type { AuthContext, RequestMeta } from '../common/request';
import { Db } from '../db/db.module';
import { FolioService } from '../finance/folio.service';
import { InvoiceService } from '../finance/invoice.service';
import { PaymentService } from '../finance/payment.service';
import { ledgerErrors, PostingService } from '../finance/posting.service';
import { HousekeepingService } from '../housekeeping/housekeeping.service';
import { IdempotencyService } from '../idempotency/idempotency.service';

const st = schema.stays;
const seg = schema.stayRooms;
const rr = schema.reservationRooms;
type PropertyRow = typeof schema.properties.$inferSelect;
type StayRow = typeof st.$inferSelect;

/** Thrown inside a transaction to roll it back while returning a value (the check-out preview). */
class Rollback<T> extends Error {
  constructor(readonly value: T) {
    super('rollback');
  }
}

interface Prepared {
  stay: StayRow;
  isLastStay: boolean;
  nights: { date: string; roomNumber: string | null; net: Money; tax: Money; gross: Money }[];
  folios: FolioDto[];
}

/**
 * Check-out (OPS-003, FIN-008, decision D7). In one transaction: the stay's room nights up to the business date are
 * posted (each once, with that night's tax); for the booking's last guest out, deposits are applied to the bill and
 * every folio must end at zero — paid, refunded, written off or moved to the guest's account — before invoices are
 * issued. Then the stay ends, the booking is checked out and the room becomes dirty with exactly one cleaning task.
 * The preview runs the same steps and rolls them back, so what it shows is what check-out will do.
 */
@Injectable()
export class CheckoutService {
  constructor(
    private readonly db: Db,
    private readonly folios: FolioService,
    private readonly payments: PaymentService,
    private readonly invoices: InvoiceService,
    private readonly posting: PostingService,
    private readonly housekeeping: HousekeepingService,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
  ) {}

  async preview(auth: AuthContext, propertyId: string, stayId: string): Promise<CheckoutPreviewDto> {
    try {
      await this.rooms(() =>
        this.db.tenant(auth.tenantId, async (tx) => {
          const property = await this.property(tx, propertyId);
          const stay = await this.inHouse(tx, propertyId, stayId);
          const before = await this.folioViews(tx, property, stay.reservationId);
          const p = await this.prepare(tx, auth, property, stay);
          throw new Rollback(await this.previewDto(tx, property, p, before));
        }),
      );
    } catch (err) {
      if (err instanceof Rollback) return err.value as CheckoutPreviewDto;
      throw err;
    }
    throw new Error('unreachable');
  }

  checkOut(
    auth: AuthContext,
    propertyId: string,
    stayId: string,
    body: CheckOutRequest,
    key: string | undefined,
    meta: RequestMeta,
  ) {
    return this.rooms(() =>
      ledgerErrors(() =>
        this.db.tenant(auth.tenantId, (tx) =>
          this.idempotency.run(
            tx,
            {
              tenantId: auth.tenantId,
              actorUserId: auth.userId,
              scope: `POST /stays/${stayId}/check-out`,
              key,
              body,
            },
            async () => ({
              status: 200,
              body: await this.run(tx, auth, propertyId, stayId, body, key, meta),
            }),
          ),
        ),
      ),
    );
  }

  // ------------------------------------------------------------------------------------------- steps

  private async run(
    tx: Tx,
    auth: AuthContext,
    propertyId: string,
    stayId: string,
    body: CheckOutRequest,
    key: string | undefined,
    meta: RequestMeta,
  ): Promise<CheckOutResultDto> {
    const property = await this.property(tx, propertyId);
    const stay = await this.inHouse(tx, propertyId, stayId);
    const prepared = await this.prepare(tx, auth, property, stay);

    const invoices: InvoiceSummaryDto[] = [];
    const closed: CheckOutResultDto['folios'] = [];
    if (prepared.isLastStay) {
      const missing: { path: string; message: string }[] = [];
      for (const folio of prepared.folios.filter((x) => x.status === 'open')) {
        const balance = Money.of(folio.balance, folio.currencyCode);
        const instruction = body.settlements.find((s) => s.folioId === folio.id);
        if (!balance.isZero() && !instruction) {
          missing.push({
            path: folio.id,
            message: balance.isPositive()
              ? `${folio.label}: ${balance.toString()} to pay, write off or move to the guest's account`
              : `${folio.label}: credit of ${balance.negate().toString()} to refund`,
          });
        }
      }
      if (missing.length > 0) {
        throw new AppError(
          'SETTLEMENT_REQUIRED',
          'Every folio must be settled before check-out: take payment, refund the credit, write off or move to the guest’s account.',
          missing,
        );
      }
      for (const folio of prepared.folios.filter((x) => x.status === 'open')) {
        const instruction = body.settlements.find((s) => s.folioId === folio.id);
        const status = await this.settle(tx, auth, property, folio, instruction, key, meta);
        const issued = await this.invoices.issue(tx, auth, property, folio.id);
        if (issued) invoices.push(issued);
        closed.push({ folioId: folio.id, status });
      }
    }

    // End the stay; the room needs cleaning (one task, however often this is retried).
    const [open] = await tx
      .select()
      .from(seg)
      .where(and(eq(seg.stayId, stay.id), isNull(seg.endedAt)));
    await tx
      .update(seg)
      .set({ endedAt: sql`now()` })
      .where(and(eq(seg.stayId, stay.id), isNull(seg.endedAt)));
    await tx
      .update(st)
      .set({ status: 'checked_out', checkedOutAt: sql`now()`, checkedOutBy: auth.userId })
      .where(eq(st.id, stay.id));
    if (open) await this.housekeeping.markDirty(tx, auth, propertyId, open.roomId, 'Guest checked out', meta);
    let reservationStatus = 'checked_in';
    if (prepared.isLastStay) {
      reservationStatus = 'checked_out';
      await tx
        .update(schema.reservations)
        .set({ status: 'checked_out' })
        .where(eq(schema.reservations.id, stay.reservationId));
    }
    await this.audit.record(
      tx,
      {
        tenantId: auth.tenantId,
        propertyId,
        actor: { type: 'user', userId: auth.userId },
        action: 'reservation.checked_out',
        entityType: 'reservation',
        entityId: stay.reservationId,
        changes: {
          stayId: stay.id,
          nightsPosted: prepared.nights.length,
          invoices: invoices.map((i) => i.invoiceNumber),
        },
      },
      meta,
    );
    return {
      stayId: stay.id,
      reservationId: stay.reservationId,
      reservationStatus,
      nightsPosted: prepared.nights.length,
      invoices,
      folios: closed,
    };
  }

  /**
   * Fixes the stay's dates to the business date (early departure releases later nights; an overstay extends the
   * booking if the room is free), posts the room nights, and — for the last guest out — applies deposits.
   */
  private async prepare(tx: Tx, auth: AuthContext, property: PropertyRow, stay: StayRow): Promise<Prepared> {
    const today = property.businessDate;
    const segments = await tx
      .select()
      .from(rr)
      .where(and(eq(rr.stayId, stay.id), eq(rr.status, 'active')))
      .orderBy(asc(rr.arrival));
    const last = segments[segments.length - 1];
    for (const s of segments) {
      if (s.arrival >= today) {
        await tx.update(rr).set({ status: 'released' }).where(eq(rr.id, s.id));
      } else if (s.departure > today || (s === last && s.departure < today)) {
        await tx.update(rr).set({ departure: today }).where(eq(rr.id, s.id));
      }
    }

    const primaryId = await this.folios.ensurePrimary(tx, auth, property, stay.reservationId);
    const primary = await this.folios.openFolio(tx, property.id, primaryId);
    // Nights slept and not yet posted (the dates above are already fixed to today).
    const { pending } = await this.folios.nights(tx, property, stay.reservationId);
    const mine = pending.filter((n) => n.stayId === stay.id);
    for (const n of mine) {
      await this.folios.postRoomNight(tx, auth, property, primary, {
        date: n.date,
        reservationRoomId: n.reservationRoomId,
        rate: n.rate,
        roomNumber: n.roomNumber,
      });
    }

    const [others] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(st)
      .where(and(eq(st.reservationId, stay.reservationId), eq(st.status, 'in_house'), ne(st.id, stay.id)));
    const isLastStay = (others?.n ?? 0) === 0;

    if (isLastStay) {
      for (const folio of await this.folioViews(tx, property, stay.reservationId)) {
        if (folio.status !== 'open') continue;
        const cur = folio.currencyCode;
        const held = Money.of(folio.depositHeld, cur);
        if (!held.isPositive()) continue;
        // Owed before deposits = balance + deposits still held. Apply only up to that, never more than is held.
        const owed = Money.of(folio.balance, cur).add(held);
        const limit = owed.compare(held) < 0 ? owed : held;
        if (limit.isPositive()) await this.payments.applyDeposits(tx, auth, property, folio.id, limit);
      }
    }
    return {
      stay,
      isLastStay,
      nights: mine.map((n) => ({
        date: n.date,
        roomNumber: n.roomNumber,
        net: n.net,
        tax: n.tax,
        gross: n.gross,
      })),
      folios: await this.folioViews(tx, property, stay.reservationId),
    };
  }

  private async settle(
    tx: Tx,
    auth: AuthContext,
    property: PropertyRow,
    folio: FolioDto,
    instruction: FolioSettlement | undefined,
    key: string | undefined,
    meta: RequestMeta,
  ): Promise<'settled' | 'on_account'> {
    const cur = folio.currencyCode;
    const balance = Money.of(folio.balance, cur);
    let status: 'settled' | 'on_account' = 'settled';
    if (!balance.isZero() && instruction) {
      const need = (permission: Permission) => {
        if (!auth.permissionsByProperty.get(property.id)?.has(permission)) {
          throw AppError.forbidden(`This settlement needs the ${permission} permission.`);
        }
      };
      const owing = balance.isPositive();
      if (instruction.action === 'pay') {
        if (!owing) throw AppError.validation(`${folio.label} is in credit; refund it instead.`);
        need('payment.receive');
        await this.payments.receiveInTx(
          tx,
          auth,
          property.id,
          {
            folioId: folio.id,
            amount: balance.toString(),
            method: instruction.method!,
            cashAccountId: instruction.cashAccountId,
            externalReference: instruction.externalReference,
          },
          key,
          meta,
        );
      } else if (instruction.action === 'refund') {
        if (owing) throw AppError.validation(`${folio.label} has a balance to pay, not a credit.`);
        need('payment.refund');
        let left = balance.negate();
        // Newest payments first, each only up to what is left of it.
        for (const pay of [...folio.payments].reverse()) {
          if (!left.isPositive()) break;
          const can = Money.of(pay.refundable, cur);
          if (!can.isPositive()) continue;
          const amount = can.compare(left) < 0 ? can : left;
          await this.payments.refundInTx(
            tx,
            auth,
            property.id,
            pay.id,
            {
              amount: amount.toString(),
              method: instruction.method,
              cashAccountId: instruction.cashAccountId,
              externalReference: instruction.externalReference,
              reason: instruction.reason ?? 'Credit refunded at check-out',
            },
            key,
            meta,
          );
          left = left.subtract(amount);
        }
        if (left.isPositive()) {
          throw new AppError(
            'CONFLICT',
            `${left.toString()} ${cur} of the credit on ${folio.label} cannot be refunded from its payments.`,
          );
        }
      } else if (instruction.action === 'write_off') {
        if (!owing) throw AppError.validation(`${folio.label} is in credit; there is nothing to write off.`);
        need('folio.adjust');
        const journalId = await this.posting.post(tx, auth, {
          propertyId: property.id,
          sourceType: 'folio_write_off',
          sourceId: folio.id,
          narration: `Write-off of ${folio.label} (${folio.bookingReference}): ${instruction.reason}`,
          lines: [
            { accountId: await this.systemAccount(tx, 'write_off'), debit: balance.toString(), credit: '0' },
            {
              accountId: await this.systemAccount(tx, 'guest_receivable'),
              debit: '0',
              credit: balance.toString(),
              folioId: folio.id,
            },
          ],
          idempotencyKey: key ?? null,
        });
        await tx
          .update(schema.folios)
          .set({ writtenOff: balance.toStorage(), writeOffJournalId: journalId })
          .where(eq(schema.folios.id, folio.id));
      } else {
        if (!owing) throw AppError.validation(`${folio.label} is in credit; refund it instead.`);
        need('folio.adjust');
        status = 'on_account';
      }
      if (instruction.action !== 'pay') {
        await this.audit.record(
          tx,
          {
            tenantId: auth.tenantId,
            propertyId: property.id,
            actor: { type: 'user', userId: auth.userId },
            action: `folio.${instruction.action === 'refund' ? 'credit_refunded' : instruction.action === 'write_off' ? 'written_off' : 'moved_to_account'}`,
            entityType: 'folio',
            entityId: folio.id,
            changes: { amount: balance.abs().toString() },
            reason: instruction.reason ?? null,
          },
          meta,
        );
      }
    }
    await tx
      .update(schema.folios)
      .set({
        status,
        settledAt: sql`now()`,
        settledBy: auth.userId,
        settlementReason: instruction?.reason ?? null,
      })
      .where(eq(schema.folios.id, folio.id));
    return status;
  }

  // ------------------------------------------------------------------------------------------- helpers

  private async previewDto(
    tx: Tx,
    property: PropertyRow,
    p: Prepared,
    before: FolioDto[],
  ): Promise<CheckoutPreviewDto> {
    const cur = property.currencyCode;
    const [stayRow] = await tx
      .select({ ref: schema.reservations.bookingReference, guest: schema.guests.fullName })
      .from(schema.reservations)
      .innerJoin(schema.guests, eq(schema.guests.id, schema.reservations.guestId))
      .where(eq(schema.reservations.id, p.stay.reservationId));
    const [room] = await tx
      .select({ number: schema.rooms.roomNumber })
      .from(seg)
      .innerJoin(schema.rooms, eq(schema.rooms.id, seg.roomId))
      .where(and(eq(seg.stayId, p.stay.id), isNull(seg.endedAt)));
    const sum = (k: 'net' | 'tax' | 'gross') =>
      Money.sum(
        p.nights.map((n) => n[k]),
        cur,
      );
    return {
      stayId: p.stay.id,
      reservationId: p.stay.reservationId,
      bookingReference: stayRow?.ref ?? '',
      guestName: stayRow?.guest ?? '',
      roomNumber: room?.number ?? '',
      businessDate: property.businessDate,
      isLastStay: p.isLastStay,
      nights: p.nights.map((n) => ({
        date: n.date,
        roomNumber: n.roomNumber,
        net: n.net.toString(),
        tax: n.tax.toString(),
        gross: n.gross.toString(),
      })),
      nightsTotal: { net: sum('net').toString(), tax: sum('tax').toString(), gross: sum('gross').toString() },
      folios: p.folios
        .filter((f) => f.status === 'open')
        .map((f) => {
          const b = before.find((x) => x.id === f.id);
          const after = Money.of(f.balance, cur);
          const nightsToPost = f.isPrimary ? sum('gross') : Money.zero(cur);
          const applied = Money.of(b?.depositHeld ?? '0', cur).subtract(Money.of(f.depositHeld, cur));
          return {
            folioId: f.id,
            label: f.label,
            isPrimary: f.isPrimary,
            currentBalance: b?.balance ?? f.balance,
            nightsToPost: nightsToPost.toString(),
            depositToApply: applied.toString(),
            balanceAfter: after.toString(),
            needs: after.isZero() ? 'none' : after.isPositive() ? 'payment' : 'refund',
          };
        }),
    };
  }

  private async folioViews(tx: Tx, property: PropertyRow, reservationId: string): Promise<FolioDto[]> {
    const rows = await tx
      .select({ id: schema.folios.id })
      .from(schema.folios)
      .where(eq(schema.folios.reservationId, reservationId))
      .orderBy(sql`${schema.folios.isPrimary} desc`, asc(schema.folios.createdAt));
    const out: FolioDto[] = [];
    for (const r of rows) out.push(await this.folios.load(tx, property, r.id));
    return out;
  }

  private async inHouse(tx: Tx, propertyId: string, stayId: string): Promise<StayRow> {
    const [stay] = await tx
      .select()
      .from(st)
      .where(and(eq(st.propertyId, propertyId), eq(st.id, stayId)))
      .for('update');
    if (!stay) throw AppError.notFound('stay');
    if (stay.status !== 'in_house') throw new AppError('CONFLICT', 'This guest has already checked out.');
    return stay;
  }

  private async systemAccount(tx: Tx, role: string): Promise<string> {
    const [a] = await tx
      .select({ id: schema.accounts.id })
      .from(schema.accounts)
      .where(eq(schema.accounts.systemRole, role));
    if (!a) throw AppError.notFound('system account');
    return a.id;
  }

  private async property(tx: Tx, propertyId: string): Promise<PropertyRow> {
    const [p] = await tx.select().from(schema.properties).where(eq(schema.properties.id, propertyId));
    if (!p) throw AppError.notFound('property');
    return p;
  }

  /** An overstay that runs into another booking of the room cannot be extended: say so instead of a 500. */
  private async rooms<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (pgErrorCode(err) === PG_EXCLUSION_VIOLATION) {
        throw new AppError(
          'ROOM_UNAVAILABLE',
          'The guest stayed past the booked departure and the room is booked for someone else from today. Move the guest first.',
        );
      }
      throw err;
    }
  }
}
