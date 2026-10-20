import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type {
  CashAccountDto,
  PaymentDto,
  PaymentListQuery,
  PaymentMethod,
  ReceiptDto,
  RecordPaymentRequest,
  RefundDto,
  RefundRequest,
} from '@innpilot/contracts';
import { schema, type Tx } from '@innpilot/db';
import { Money } from '@innpilot/money';
import { and, asc, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { AuditService } from '../audit/audit.service';
import { AppError } from '../common/app-error';
import type { AuthContext, RequestMeta } from '../common/request';
import { Db } from '../db/db.module';
import { IdempotencyService } from '../idempotency/idempotency.service';
import { FolioService } from './folio.service';
import { ledgerErrors, PostingService } from './posting.service';

const p = schema.payments;
const rf = schema.refunds;
const da = schema.depositApplications;
const ca = schema.cashAccounts;
type PropertyRow = typeof schema.properties.$inferSelect;
type PaymentRow = typeof p.$inferSelect;

const DEFAULT_ACCOUNT_KIND: Record<PaymentMethod, string> = {
  cash: 'cash',
  bank_transfer: 'bank',
  card: 'card_clearing',
  other: 'cash',
};

const pad = (n: number) => String(n).padStart(6, '0');

/**
 * Money received and returned (P3-12, P3-13). Each payment, refund and deposit application is a source record
 * posted to the ledger in the same transaction, once per Idempotency-Key (FIN-003):
 *   deposit (before check-in): Dr cash/bank/clearing, Cr guest deposits — a liability, not revenue (FIN-007);
 *   payment (during the stay):  Dr cash/bank/clearing, Cr guest receivable;
 *   refund:                     the reverse, from the deposit still held or from the receivable;
 *   deposit application:        Dr guest deposits, Cr guest receivable (at check-out, or when kept as a fee).
 * Every guest-side line carries the folio, so a folio always reconciles to the ledger.
 */
@Injectable()
export class PaymentService {
  constructor(
    private readonly db: Db,
    private readonly posting: PostingService,
    private readonly folios: FolioService,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
  ) {}

  // ------------------------------------------------------------------------------------------- reads

  cashAccounts(auth: AuthContext, propertyId: string): Promise<CashAccountDto[]> {
    return this.db.tenant(auth.tenantId, async (tx) => {
      await this.property(tx, propertyId);
      const rows = await tx
        .select({ c: ca, code: schema.accounts.code })
        .from(ca)
        .innerJoin(schema.accounts, eq(schema.accounts.id, ca.ledgerAccountId))
        .where(eq(ca.propertyId, propertyId))
        .orderBy(asc(schema.accounts.code));
      return rows.map(({ c, code }) => ({
        id: c.id,
        name: c.name,
        kind: c.kind as CashAccountDto['kind'],
        ledgerAccountCode: code,
        active: c.active,
      }));
    });
  }

  list(auth: AuthContext, propertyId: string, q: PaymentListQuery): Promise<PaymentDto[]> {
    return this.db.tenant(auth.tenantId, async (tx) => {
      await this.property(tx, propertyId);
      const rows = await tx
        .select({ id: p.id })
        .from(p)
        .where(
          and(
            eq(p.propertyId, propertyId),
            q.from ? gte(p.businessDate, q.from) : undefined,
            q.to ? lte(p.businessDate, q.to) : undefined,
          ),
        )
        .orderBy(desc(p.receivedAt))
        .limit(q.limit);
      return this.dtos(
        tx,
        rows.map((x) => x.id),
      );
    });
  }

  get(auth: AuthContext, propertyId: string, id: string): Promise<PaymentDto> {
    return this.db.tenant(auth.tenantId, async (tx) => {
      await this.property(tx, propertyId);
      return this.one(tx, propertyId, id);
    });
  }

  receipt(auth: AuthContext, propertyId: string, id: string): Promise<ReceiptDto> {
    return this.db.tenant(auth.tenantId, async (tx) => {
      const property = await this.property(tx, propertyId);
      const payment = await this.one(tx, propertyId, id);
      const [profile] = await tx
        .select()
        .from(schema.invoiceProfiles)
        .where(eq(schema.invoiceProfiles.propertyId, propertyId));
      return {
        payment,
        hotel: {
          name: property.name,
          legalName: profile?.legalName ?? property.legalName ?? null,
          address: profile?.address ?? null,
          registrationFields: profile?.registrationFields ?? [],
          footer: profile?.footer ?? null,
        },
      };
    });
  }

  // ------------------------------------------------------------------------------------------- record

  record(
    auth: AuthContext,
    propertyId: string,
    body: RecordPaymentRequest,
    key: string | undefined,
    meta: RequestMeta,
  ) {
    return this.command(auth, `POST /properties/${propertyId}/payments`, key, body, async (tx) => {
      const property = await this.property(tx, propertyId);
      let folioId = body.folioId;
      if (!folioId) {
        const res = await this.reservation(tx, propertyId, body.reservationId!);
        if (!['pending', 'confirmed', 'checked_in'].includes(res.status)) {
          throw new AppError('CONFLICT', `A ${res.status.replace('_', '-')} booking cannot take a deposit.`);
        }
        folioId = await this.folios.ensurePrimary(tx, auth, property, res.id);
      }
      const folio = await this.folios.openFolio(tx, propertyId, folioId);
      const res = await this.reservation(tx, propertyId, folio.reservationId);
      const kind = res.status === 'checked_in' ? 'payment' : 'deposit';
      const currency = property.currencyCode;
      const amount = Money.of(body.amount, currency);

      // A folio can take what is owed plus the room nights still to post (D7), never more: over-payments would
      // only have to be refunded again.
      const view = await this.folios.load(tx, property, folio.id);
      const due = Money.of(view.balance, currency).add(Money.of(view.stayEstimate.gross, currency));
      if (amount.compare(due) > 0) {
        throw new AppError(
          'PAYMENT_EXCEEDS_BALANCE',
          due.isPositive()
            ? `This folio can take at most ${due.toString()} ${currency} (balance plus nights still to post).`
            : 'Nothing is owed on this folio.',
          [{ path: 'amount', message: `At most ${due.isPositive() ? due.toString() : '0.00'}` }],
        );
      }

      const cash = await this.cashAccount(tx, propertyId, body.method, body.cashAccountId);
      const guestAccount = await this.systemAccount(
        tx,
        kind === 'deposit' ? 'guest_deposits' : 'guest_receivable',
      );
      const receiptNumber = `${await this.prefix(tx, propertyId)}${pad(
        await this.posting.nextNumber(tx, auth.tenantId, propertyId, 'receipt'),
      )}`;
      const id = randomUUID();
      const journalId = await this.posting.post(tx, auth, {
        propertyId,
        sourceType: 'payment',
        sourceId: id,
        reference: receiptNumber,
        narration: `${kind === 'deposit' ? 'Deposit' : 'Payment'} ${receiptNumber} (${res.bookingReference}, ${folio.label})`,
        lines: [
          { accountId: cash.ledgerAccountId, debit: amount.toString(), credit: '0' },
          { accountId: guestAccount, debit: '0', credit: amount.toString(), folioId: folio.id },
        ],
        idempotencyKey: key ?? null,
      });
      await tx.insert(p).values({
        id,
        tenantId: auth.tenantId,
        propertyId,
        folioId: folio.id,
        reservationId: res.id,
        kind,
        method: body.method,
        cashAccountId: cash.id,
        amount: amount.toStorage(),
        currencyCode: currency,
        businessDate: property.businessDate,
        externalReference: body.externalReference || null,
        notes: body.notes || null,
        receiptNumber,
        journalEntryId: journalId,
        idempotencyKey: key ?? null,
        createdBy: auth.userId,
      });
      await this.recordAudit(
        tx,
        auth,
        propertyId,
        meta,
        `payment.${kind === 'deposit' ? 'deposit_received' : 'received'}`,
        id,
        {
          receiptNumber,
          amount: amount.toString(),
          method: body.method,
          folioId: folio.id,
        },
      );
      return { status: 201, body: await this.one(tx, propertyId, id) };
    });
  }

  // ------------------------------------------------------------------------------------------- refund

  refund(
    auth: AuthContext,
    propertyId: string,
    paymentId: string,
    body: RefundRequest,
    key: string | undefined,
    meta: RequestMeta,
  ) {
    return this.command(auth, `POST /payments/${paymentId}/refunds`, key, body, async (tx) => {
      const property = await this.property(tx, propertyId);
      const payment = await this.lockPayment(tx, propertyId, paymentId);
      const folio = await this.folios.openFolio(tx, propertyId, payment.folioId);
      const currency = property.currencyCode;
      const amount = Money.of(body.amount, currency);

      const left = await this.remainder(tx, payment);
      if (amount.compare(left) > 0) {
        throw new AppError(
          'REFUND_EXCEEDS_REMAINDER',
          `Only ${left.toString()} ${currency} of receipt ${payment.receiptNumber} can still be refunded.`,
          [{ path: 'amount', message: `At most ${left.toString()}` }],
        );
      }
      // Never refund money the guest still owes: the folio must stay at or below zero, nights to post included.
      const view = await this.folios.load(tx, property, folio.id);
      const credit = Money.of(view.balanceWithPending, currency).negate();
      if (amount.compare(credit) > 0) {
        throw new AppError(
          'CONFLICT',
          credit.isPositive()
            ? `The guest is only in credit by ${credit.toString()} ${currency}. A larger refund would leave a balance owed.`
            : 'The guest is not in credit on this folio, so there is nothing to refund.',
          [{ path: 'amount', message: `At most ${credit.isPositive() ? credit.toString() : '0.00'}` }],
        );
      }

      const method = body.method ?? (payment.method as PaymentMethod);
      const cash = await this.cashAccount(tx, propertyId, method, body.cashAccountId);
      // What is left of a deposit is still held as a liability; a stay payment sits against the receivable.
      const guestAccount = await this.systemAccount(
        tx,
        payment.kind === 'deposit' ? 'guest_deposits' : 'guest_receivable',
      );
      const refundNumber = `RF-${pad(await this.posting.nextNumber(tx, auth.tenantId, propertyId, 'refund'))}`;
      const id = randomUUID();
      const journalId = await this.posting.post(tx, auth, {
        propertyId,
        sourceType: 'refund',
        sourceId: id,
        reference: refundNumber,
        narration: `Refund ${refundNumber} of ${payment.receiptNumber}: ${body.reason}`,
        lines: [
          { accountId: guestAccount, debit: amount.toString(), credit: '0', folioId: folio.id },
          { accountId: cash.ledgerAccountId, debit: '0', credit: amount.toString() },
        ],
        idempotencyKey: key ?? null,
      });
      await tx.insert(rf).values({
        id,
        tenantId: auth.tenantId,
        propertyId,
        paymentId,
        amount: amount.toStorage(),
        method,
        cashAccountId: cash.id,
        externalReference: body.externalReference || null,
        reason: body.reason,
        businessDate: property.businessDate,
        refundNumber,
        journalEntryId: journalId,
        createdBy: auth.userId,
      });
      await this.audit.record(
        tx,
        {
          tenantId: auth.tenantId,
          propertyId,
          actor: { type: 'user', userId: auth.userId },
          action: 'payment.refunded',
          entityType: 'payment',
          entityId: paymentId,
          changes: { refundNumber, amount: amount.toString(), receiptNumber: payment.receiptNumber },
          reason: body.reason,
        },
        meta,
      );
      return { status: 201, body: await this.one(tx, propertyId, paymentId) };
    });
  }

  // ------------------------------------------------------------------------------------------- deposits

  /** Deposits on the reservation's folios not yet refunded or applied: still a liability. */
  async depositHeld(tx: Tx, property: PropertyRow, reservationId: string): Promise<Money> {
    const deposits = await tx
      .select()
      .from(p)
      .where(and(eq(p.reservationId, reservationId), eq(p.kind, 'deposit')));
    let held = Money.zero(property.currencyCode);
    for (const d of deposits) held = held.add(await this.remainder(tx, d));
    return held;
  }

  /**
   * Applies deposits held on a folio to its bill, oldest first, up to `limit`: Dr guest deposits, Cr guest receivable.
   * Used at check-out (slice 3.5) and when a deposit is kept as a fee. Returns the amount applied.
   */
  async applyDeposits(
    tx: Tx,
    auth: AuthContext,
    property: PropertyRow,
    folioId: string,
    limit: Money,
  ): Promise<Money> {
    const deposits = await tx
      .select()
      .from(p)
      .where(and(eq(p.folioId, folioId), eq(p.kind, 'deposit')))
      .orderBy(asc(p.receivedAt))
      .for('update');
    const deposit = await this.systemAccount(tx, 'guest_deposits');
    const receivable = await this.systemAccount(tx, 'guest_receivable');
    let applied = Money.zero(property.currencyCode);
    for (const d of deposits) {
      const room = limit.subtract(applied);
      if (!room.isPositive()) break;
      const left = await this.remainder(tx, d);
      if (!left.isPositive()) continue;
      const amount = left.compare(room) > 0 ? room : left;
      const id = randomUUID();
      const journalId = await this.posting.post(tx, auth, {
        propertyId: property.id,
        sourceType: 'deposit_application',
        sourceId: id,
        reference: d.receiptNumber,
        narration: `Deposit ${d.receiptNumber} applied to the bill`,
        lines: [
          { accountId: deposit, debit: amount.toString(), credit: '0', folioId },
          { accountId: receivable, debit: '0', credit: amount.toString(), folioId },
        ],
      });
      await tx.insert(da).values({
        id,
        tenantId: auth.tenantId,
        propertyId: property.id,
        paymentId: d.id,
        amount: amount.toStorage(),
        journalEntryId: journalId,
        createdBy: auth.userId,
      });
      applied = applied.add(amount);
    }
    return applied;
  }

  /**
   * Keeps the deposits of a cancelled or no-show booking as a fee (P3-15): a charge in the cancellation category
   * for the amount held, then the deposits applied against it. Needs `folio.adjust`; the caller checks.
   */
  async forfeitDeposits(
    tx: Tx,
    auth: AuthContext,
    property: PropertyRow,
    reservationId: string,
    reason: string,
    meta: RequestMeta,
  ): Promise<Money> {
    const deposits = await tx
      .select()
      .from(p)
      .where(and(eq(p.reservationId, reservationId), eq(p.kind, 'deposit')));
    // Per folio: the fee is charged where the deposit sits, so each folio ends at zero.
    const heldByFolio = new Map<string, Money>();
    for (const d of deposits) {
      const left = await this.remainder(tx, d);
      if (left.isPositive())
        heldByFolio.set(
          d.folioId,
          (heldByFolio.get(d.folioId) ?? Money.zero(property.currencyCode)).add(left),
        );
    }
    let kept = Money.zero(property.currencyCode);
    for (const [folioId, held] of heldByFolio) {
      const folio = await this.folios.openFolio(tx, property.id, folioId);
      await this.folios.postSystemCharge(tx, auth, property, folio, {
        kind: 'cancellation',
        description: 'Deposit kept as cancellation or no-show fee',
        amount: held,
        reason,
      });
      kept = kept.add(await this.applyDeposits(tx, auth, property, folio.id, held));
    }
    if (kept.isPositive()) {
      await this.audit.record(
        tx,
        {
          tenantId: auth.tenantId,
          propertyId: property.id,
          actor: { type: 'user', userId: auth.userId },
          action: 'payment.deposit_forfeited',
          entityType: 'reservation',
          entityId: reservationId,
          changes: { amount: kept.toString(), folios: heldByFolio.size },
          reason,
        },
        meta,
      );
    }
    return kept;
  }

  forfeitForReservation(
    auth: AuthContext,
    propertyId: string,
    reservationId: string,
    reason: string,
    key: string | undefined,
    meta: RequestMeta,
  ) {
    return this.command(
      auth,
      `POST /reservations/${reservationId}/forfeit-deposit`,
      key,
      { reason },
      async (tx) => {
        const property = await this.property(tx, propertyId);
        const res = await this.reservation(tx, propertyId, reservationId);
        if (res.status !== 'cancelled' && res.status !== 'no_show') {
          throw new AppError(
            'CONFLICT',
            'A deposit can be kept as a fee only for a cancelled or no-show booking.',
          );
        }
        const kept = await this.forfeitDeposits(tx, auth, property, reservationId, reason, meta);
        if (!kept.isPositive()) throw new AppError('CONFLICT', 'This booking holds no deposit.');
        return { status: 200, body: { amount: kept.toString() } };
      },
    );
  }

  // ------------------------------------------------------------------------------------------- internals

  private async remainder(tx: Tx, payment: PaymentRow): Promise<Money> {
    const [x] = await tx
      .execute<{ used: string }>(
        sql`
      select (coalesce((select sum(amount) from refunds where payment_id = ${payment.id}), 0)
            + coalesce((select sum(amount) from deposit_applications where payment_id = ${payment.id}), 0))::text as used`,
      )
      .then((r) => r.rows);
    return Money.of(payment.amount, payment.currencyCode)
      .subtract(Money.of(x!.used, payment.currencyCode))
      .round();
  }

  private async lockPayment(tx: Tx, propertyId: string, id: string): Promise<PaymentRow> {
    const [row] = await tx
      .select()
      .from(p)
      .where(and(eq(p.propertyId, propertyId), eq(p.id, id)))
      .for('update');
    if (!row) throw AppError.notFound('payment');
    return row;
  }

  private async cashAccount(tx: Tx, propertyId: string, method: PaymentMethod, id?: string) {
    const [row] = await tx
      .select()
      .from(ca)
      .where(
        and(
          eq(ca.propertyId, propertyId),
          eq(ca.active, true),
          id ? eq(ca.id, id) : eq(ca.kind, DEFAULT_ACCOUNT_KIND[method]),
        ),
      )
      .orderBy(asc(ca.createdAt))
      .limit(1);
    if (!row) {
      throw AppError.validation('Choose an active cash or bank account for this payment.', [
        { path: 'cashAccountId', message: 'Choose an account.' },
      ]);
    }
    return row;
  }

  private async systemAccount(tx: Tx, role: string): Promise<string> {
    const [a] = await tx
      .select({ id: schema.accounts.id })
      .from(schema.accounts)
      .where(eq(schema.accounts.systemRole, role));
    if (!a) throw AppError.notFound('system account');
    return a.id;
  }

  private async prefix(tx: Tx, propertyId: string): Promise<string> {
    const [row] = await tx
      .select({ prefix: schema.invoiceProfiles.receiptPrefix })
      .from(schema.invoiceProfiles)
      .where(eq(schema.invoiceProfiles.propertyId, propertyId));
    return row?.prefix ?? 'RCT-';
  }

  private async one(tx: Tx, propertyId: string, id: string): Promise<PaymentDto> {
    const [row] = await tx
      .select({ id: p.id })
      .from(p)
      .where(and(eq(p.propertyId, propertyId), eq(p.id, id)));
    if (!row) throw AppError.notFound('payment');
    return (await this.dtos(tx, [id]))[0]!;
  }

  private async dtos(tx: Tx, ids: string[]): Promise<PaymentDto[]> {
    if (ids.length === 0) return [];
    const creator = alias(schema.users, 'creator');
    const rows = await tx
      .select({
        p,
        account: ca.name,
        folioLabel: schema.folios.label,
        ref: schema.reservations.bookingReference,
        guest: schema.guests.fullName,
        by: creator.fullName,
        journalNumber: schema.journalEntries.journalNumber,
      })
      .from(p)
      .innerJoin(ca, eq(ca.id, p.cashAccountId))
      .innerJoin(schema.folios, eq(schema.folios.id, p.folioId))
      .innerJoin(schema.reservations, eq(schema.reservations.id, p.reservationId))
      .innerJoin(schema.guests, eq(schema.guests.id, schema.folios.guestId))
      .innerJoin(schema.journalEntries, eq(schema.journalEntries.id, p.journalEntryId))
      .leftJoin(creator, eq(creator.id, p.createdBy))
      .where(inArray(p.id, ids))
      .orderBy(desc(p.receivedAt));
    const refundRows = await tx
      .select({ r: rf, account: ca.name, by: schema.users.fullName })
      .from(rf)
      .innerJoin(ca, eq(ca.id, rf.cashAccountId))
      .leftJoin(schema.users, eq(schema.users.id, rf.createdBy))
      .where(inArray(rf.paymentId, ids))
      .orderBy(asc(rf.createdAt));
    const appliedRows = await tx
      .select({ paymentId: da.paymentId, amount: da.amount })
      .from(da)
      .where(inArray(da.paymentId, ids));
    return rows.map((x) => {
      const cur = x.p.currencyCode;
      const amount = Money.of(x.p.amount, cur).round();
      const mine = refundRows.filter((r) => r.r.paymentId === x.p.id);
      const refunded = Money.sum(
        mine.map((r) => Money.of(r.r.amount, cur)),
        cur,
      ).round();
      const applied = Money.sum(
        appliedRows.filter((a) => a.paymentId === x.p.id).map((a) => Money.of(a.amount, cur)),
        cur,
      ).round();
      return {
        id: x.p.id,
        receiptNumber: x.p.receiptNumber,
        kind: x.p.kind as PaymentDto['kind'],
        method: x.p.method as PaymentMethod,
        cashAccountId: x.p.cashAccountId,
        cashAccountName: x.account,
        amount: amount.toString(),
        refunded: refunded.toString(),
        applied: applied.toString(),
        refundable: amount.subtract(refunded).subtract(applied).toString(),
        currencyCode: cur,
        businessDate: x.p.businessDate,
        receivedAt: x.p.receivedAt.toISOString(),
        externalReference: x.p.externalReference,
        notes: x.p.notes,
        folioId: x.p.folioId,
        folioLabel: x.folioLabel,
        reservationId: x.p.reservationId,
        bookingReference: x.ref,
        guestName: x.guest,
        createdByName: x.by,
        journalEntryId: x.p.journalEntryId,
        journalNumber: x.journalNumber,
        refunds: mine.map(({ r, account, by }): RefundDto => ({
          id: r.id,
          refundNumber: r.refundNumber,
          amount: Money.of(r.amount, cur).round().toString(),
          method: r.method as PaymentMethod,
          cashAccountName: account,
          externalReference: r.externalReference,
          reason: r.reason,
          businessDate: r.businessDate,
          createdAt: r.createdAt.toISOString(),
          createdByName: by,
          journalEntryId: r.journalEntryId,
        })),
      };
    });
  }

  private command<T>(
    auth: AuthContext,
    scope: string,
    key: string | undefined,
    body: unknown,
    execute: (tx: Tx) => Promise<{ status: number; body: T }>,
  ) {
    return ledgerErrors(() =>
      this.db.tenant(auth.tenantId, (tx) =>
        this.idempotency.run(
          tx,
          { tenantId: auth.tenantId, actorUserId: auth.userId, scope, key, body },
          () => execute(tx),
        ),
      ),
    );
  }

  private async reservation(tx: Tx, propertyId: string, id: string) {
    const [res] = await tx
      .select()
      .from(schema.reservations)
      .where(and(eq(schema.reservations.propertyId, propertyId), eq(schema.reservations.id, id)));
    if (!res) throw AppError.notFound('reservation');
    return res;
  }

  private async property(tx: Tx, propertyId: string): Promise<PropertyRow> {
    const [row] = await tx.select().from(schema.properties).where(eq(schema.properties.id, propertyId));
    if (!row) throw AppError.notFound('property');
    return row;
  }

  private async recordAudit(
    tx: Tx,
    auth: AuthContext,
    propertyId: string,
    meta: RequestMeta,
    action: string,
    paymentId: string,
    changes: Record<string, unknown>,
  ) {
    await this.audit.record(
      tx,
      {
        tenantId: auth.tenantId,
        propertyId,
        actor: { type: 'user', userId: auth.userId },
        action,
        entityType: 'payment',
        entityId: paymentId,
        changes,
      },
      meta,
    );
  }
}
