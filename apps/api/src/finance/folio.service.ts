import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  addDays,
  type CreateFolioRequest,
  type FolioChargeDto,
  type FolioDto,
  type OpenFolioDto,
  type PostAllowanceRequest,
  type PostChargeRequest,
  type TransferChargeRequest,
  type VoidChargeRequest,
} from '@innpilot/contracts';
import { schema, type Tx } from '@innpilot/db';
import { Money } from '@innpilot/money';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { AuditService } from '../audit/audit.service';
import type { AuthContext, RequestMeta } from '../common/request';
import { AppError } from '../common/app-error';
import { Db } from '../db/db.module';
import { IdempotencyService } from '../idempotency/idempotency.service';
import { ledgerErrors, PostingService, type PostingLine } from './posting.service';
import { calculateTax, type TaxResult } from './tax-calc';
import { TaxService } from './tax.service';

const f = schema.folios;
const c = schema.folioCharges;
const ct = schema.folioChargeTaxes;
const r = schema.reservations;
const rr = schema.reservationRooms;
type PropertyRow = typeof schema.properties.$inferSelect;
type FolioRow = typeof f.$inferSelect;
type ChargeRow = typeof c.$inferSelect;

/** NUMERIC(19,4) → API form. Folio amounts are whole paisa (the database checks). */
const money2 = (v: string) => v.replace(/^(-?\d+)\.(\d{2})\d*$/, '$1.$2');
const qty = (v: string) => v.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
const pct = qty;

/**
 * Guest folios (accounting spec §5, P3-9 to P3-11). Every item is a source record posted to the ledger in the same
 * transaction: Dr guest receivable (on this folio) / Cr revenue and tax payable for a charge, the reverse for an
 * allowance. Items are never edited or deleted: a void posts the exact reversal, a transfer moves the receivable to
 * another folio. Room nights are not posted until check-out (D7); the folio shows them as pending.
 */
@Injectable()
export class FolioService {
  constructor(
    private readonly db: Db,
    private readonly posting: PostingService,
    private readonly tax: TaxService,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
  ) {}

  // ------------------------------------------------------------------------------------------- reads

  listForReservation(auth: AuthContext, propertyId: string, reservationId: string): Promise<FolioDto[]> {
    return this.db.tenant(auth.tenantId, async (tx) => {
      const property = await this.property(tx, propertyId);
      await this.reservation(tx, propertyId, reservationId);
      const rows = await tx
        .select({ id: f.id })
        .from(f)
        .where(eq(f.reservationId, reservationId))
        .orderBy(sql`${f.isPrimary} desc`, asc(f.createdAt));
      const out: FolioDto[] = [];
      for (const row of rows) out.push(await this.load(tx, property, row.id));
      return out;
    });
  }

  get(auth: AuthContext, propertyId: string, folioId: string): Promise<FolioDto> {
    return this.db.tenant(auth.tenantId, async (tx) =>
      this.load(tx, await this.property(tx, propertyId), folioId),
    );
  }

  /** Open folios of the property, for choosing a transfer target. */
  listOpen(auth: AuthContext, propertyId: string): Promise<OpenFolioDto[]> {
    return this.db.tenant(auth.tenantId, async (tx) => {
      await this.property(tx, propertyId);
      const rows = await tx
        .select({
          f,
          ref: r.bookingReference,
          guest: schema.guests.fullName,
          balance: sql<string>`(coalesce((select sum(x.gross_amount) from folio_charges x
                                 where x.folio_id = ${f.id} and x.status = 'posted'), 0)
                              - coalesce((select sum(p.amount) from payments p where p.folio_id = ${f.id}), 0)
                              + coalesce((select sum(rf.amount) from refunds rf join payments p on p.id = rf.payment_id
                                 where p.folio_id = ${f.id}), 0))::text`,
          room: sql<
            string | null
          >`(select rm.room_number from reservation_rooms y join rooms rm on rm.id = y.room_id
                                    where y.reservation_id = ${f.reservationId} and y.status = 'active'
                                    order by y.departure desc limit 1)`,
        })
        .from(f)
        .innerJoin(r, eq(r.id, f.reservationId))
        .innerJoin(schema.guests, eq(schema.guests.id, f.guestId))
        .where(and(eq(f.propertyId, propertyId), eq(f.status, 'open')))
        .orderBy(asc(r.bookingReference), sql`${f.isPrimary} desc`);
      return rows.map((x) => ({
        id: x.f.id,
        label: x.f.label,
        isPrimary: x.f.isPrimary,
        reservationId: x.f.reservationId,
        bookingReference: x.ref,
        guestName: x.guest,
        roomNumber: x.room,
        balance: Money.of(x.balance, x.f.currencyCode).round().toString(),
      }));
    });
  }

  // ------------------------------------------------------------------------------------------- folios

  /** The reservation's main folio, created if it does not exist yet. Called at check-in and walk-in. */
  async ensurePrimary(
    tx: Tx,
    auth: AuthContext,
    property: PropertyRow,
    reservationId: string,
  ): Promise<string> {
    const [existing] = await tx
      .select({ id: f.id })
      .from(f)
      .where(and(eq(f.reservationId, reservationId), eq(f.isPrimary, true)));
    if (existing) return existing.id;
    const res = await this.reservation(tx, property.id, reservationId);
    const [row] = await tx
      .insert(f)
      .values({
        tenantId: auth.tenantId,
        propertyId: property.id,
        reservationId,
        guestId: res.guestId,
        isPrimary: true,
        currencyCode: property.currencyCode,
        createdBy: auth.userId,
      })
      .returning({ id: f.id });
    return row!.id;
  }

  createFolio(
    auth: AuthContext,
    propertyId: string,
    reservationId: string,
    body: CreateFolioRequest,
    meta: RequestMeta,
  ): Promise<FolioDto> {
    return this.db.tenant(auth.tenantId, async (tx) => {
      const property = await this.property(tx, propertyId);
      const res = await this.reservation(tx, propertyId, reservationId);
      if (!['pending', 'confirmed', 'checked_in'].includes(res.status)) {
        throw new AppError('CONFLICT', `A ${res.status.replace('_', '-')} booking cannot get a new folio.`);
      }
      const primary = await this.ensurePrimary(tx, auth, property, reservationId);
      const label = body.label.trim();
      const id =
        label.toLowerCase() === 'main'
          ? primary
          : (
              await tx
                .insert(f)
                .values({
                  tenantId: auth.tenantId,
                  propertyId,
                  reservationId,
                  guestId: res.guestId,
                  label,
                  currencyCode: property.currencyCode,
                  createdBy: auth.userId,
                })
                .returning({ id: f.id })
            )[0]!.id;
      await this.record(tx, auth, propertyId, meta, 'folio.created', id, { reservationId, label });
      return this.load(tx, property, id);
    });
  }

  // ------------------------------------------------------------------------------------------- items

  postCharge(
    auth: AuthContext,
    propertyId: string,
    folioId: string,
    body: PostChargeRequest,
    key: string | undefined,
    meta: RequestMeta,
  ) {
    return this.command(auth, `POST /folios/${folioId}/charges`, key, body, async (tx) => {
      const property = await this.property(tx, propertyId);
      const folio = await this.openFolio(tx, propertyId, folioId);
      const amount = Money.of(body.quantity, property.currencyCode).multiply(body.unitPrice).round();
      const chargeId = await this.postItem(tx, auth, property, folio, {
        kind: 'charge',
        categoryId: body.categoryId,
        description: body.description,
        serviceDate: body.serviceDate,
        quantity: body.quantity,
        unitPrice: body.unitPrice,
        amount,
        reason: null,
        key,
      });
      await this.record(tx, auth, propertyId, meta, 'folio.charge_posted', folioId, {
        chargeId,
        description: body.description,
        amount: amount.toString(),
      });
      return { status: 201, body: await this.load(tx, property, folioId) };
    });
  }

  postAllowance(
    auth: AuthContext,
    propertyId: string,
    folioId: string,
    body: PostAllowanceRequest,
    key: string | undefined,
    meta: RequestMeta,
  ) {
    return this.command(auth, `POST /folios/${folioId}/allowances`, key, body, async (tx) => {
      const property = await this.property(tx, propertyId);
      const folio = await this.openFolio(tx, propertyId, folioId);
      const amount = Money.of(body.amount, property.currencyCode);
      const chargeId = await this.postItem(tx, auth, property, folio, {
        kind: 'allowance',
        categoryId: body.categoryId,
        description: body.description,
        serviceDate: body.serviceDate,
        quantity: '1',
        unitPrice: amount.toString(),
        amount,
        reason: body.reason,
        key,
      });
      await this.audit.record(
        tx,
        {
          tenantId: auth.tenantId,
          propertyId,
          actor: { type: 'user', userId: auth.userId },
          action: 'folio.allowance_posted',
          entityType: 'folio',
          entityId: folioId,
          changes: { chargeId, description: body.description, amount: amount.negate().toString() },
          reason: body.reason,
        },
        meta,
      );
      return { status: 201, body: await this.load(tx, property, folioId) };
    });
  }

  voidCharge(
    auth: AuthContext,
    propertyId: string,
    chargeId: string,
    body: VoidChargeRequest,
    key: string | undefined,
    meta: RequestMeta,
  ) {
    return this.command(auth, `POST /folio-charges/${chargeId}/void`, key, body, async (tx) => {
      const property = await this.property(tx, propertyId);
      const charge = await this.lockCharge(tx, propertyId, chargeId);
      const folio = await this.openFolio(tx, propertyId, charge.folioId);
      // The reversal mirrors the revenue and tax lines exactly as first posted (even if the category's account or
      // the tax rate changed since), and takes the amount off the receivable of the folio the item is on now.
      const original = await this.originalLines(tx, charge);
      const gross = Money.of(charge.grossAmount, property.currencyCode).round();
      const receivable = await this.receivableAccount(tx);
      // D9: a billed room night that was accrued cleared Unbilled guest revenue. Voiding it takes the night out of
      // revenue (where the accrual put it), so nothing is left waiting in Unbilled for a night that will not be billed.
      const [accrued] = await tx
        .execute<{ unbilled: string; revenue: string }>(
          sql`
        select u.id as unbilled, a.revenue_account_id as revenue
        from room_night_charges n
        join room_revenue_accruals a on a.reservation_room_id = n.reservation_room_id and a.night = n.night
        join accounts u on u.system_role = 'unbilled_revenue'
        where n.charge_id = ${charge.id}`,
        )
        .then((x) => x.rows);
      const lines: PostingLine[] = [
        ...original.map((l) => ({
          accountId: accrued && l.accountId === accrued.unbilled ? accrued.revenue : l.accountId,
          debit: money2(l.credit),
          credit: money2(l.debit),
        })),
        gross.isPositive()
          ? { accountId: receivable, debit: '0', credit: gross.toString(), folioId: folio.id }
          : { accountId: receivable, debit: gross.negate().toString(), credit: '0', folioId: folio.id },
      ];
      const journalId = await this.posting.post(tx, auth, {
        propertyId,
        sourceType: 'folio_charge',
        sourceId: charge.id,
        purpose: 'void',
        narration: `Void: ${charge.description} — ${body.reason}`,
        lines,
        idempotencyKey: key ?? null,
      });
      await tx
        .update(c)
        .set({
          status: 'voided',
          voidJournalEntryId: journalId,
          voidedBy: auth.userId,
          voidedAt: sql`now()`,
          voidReason: body.reason,
        })
        .where(eq(c.id, charge.id));
      await this.audit.record(
        tx,
        {
          tenantId: auth.tenantId,
          propertyId,
          actor: { type: 'user', userId: auth.userId },
          action: 'folio.charge_voided',
          entityType: 'folio',
          entityId: folio.id,
          changes: { chargeId, description: charge.description, amount: money2(charge.grossAmount) },
          reason: body.reason,
        },
        meta,
      );
      return { status: 200, body: await this.load(tx, property, folio.id) };
    });
  }

  transferCharge(
    auth: AuthContext,
    propertyId: string,
    chargeId: string,
    body: TransferChargeRequest,
    key: string | undefined,
    meta: RequestMeta,
  ) {
    return this.command(auth, `POST /folio-charges/${chargeId}/transfer`, key, body, async (tx) => {
      const property = await this.property(tx, propertyId);
      const charge = await this.lockCharge(tx, propertyId, chargeId);
      const from = await this.openFolio(tx, propertyId, charge.folioId);
      if (body.toFolioId === from.id) throw AppError.validation('Choose a different folio.');
      const to = await this.openFolio(tx, propertyId, body.toFolioId);
      const newId = randomUUID();
      const gross = Money.of(charge.grossAmount, property.currencyCode).round();
      const receivable = await this.receivableAccount(tx);
      const amount = gross.abs().toString();
      // Only the receivable moves: Dr the new folio, Cr the old one (the other way round for an allowance).
      const [debitFolio, creditFolio] = gross.isPositive() ? [to.id, from.id] : [from.id, to.id];
      const journalId = await this.posting.post(tx, auth, {
        propertyId,
        sourceType: 'folio_charge',
        sourceId: newId,
        purpose: 'transfer',
        narration: `Transfer: ${charge.description} — ${body.reason}`,
        lines: [
          { accountId: receivable, debit: amount, credit: '0', folioId: debitFolio },
          { accountId: receivable, debit: '0', credit: amount, folioId: creditFolio },
        ],
        idempotencyKey: key ?? null,
      });
      await tx.insert(c).values({
        id: newId,
        tenantId: auth.tenantId,
        propertyId,
        folioId: to.id,
        categoryId: charge.categoryId,
        kind: charge.kind,
        description: charge.description,
        serviceDate: charge.serviceDate,
        quantity: charge.quantity,
        unitPrice: charge.unitPrice,
        netAmount: charge.netAmount,
        taxAmount: charge.taxAmount,
        grossAmount: charge.grossAmount,
        reason: charge.reason,
        journalEntryId: journalId,
        transferredFromId: charge.id,
        createdBy: auth.userId,
      });
      const taxes = await tx.select().from(ct).where(eq(ct.chargeId, charge.id));
      if (taxes.length > 0) {
        await tx.insert(ct).values(taxes.map(({ id: _id, ...t }) => ({ ...t, chargeId: newId })));
      }
      await tx.update(c).set({ status: 'transferred', transferredToId: newId }).where(eq(c.id, charge.id));
      await this.audit.record(
        tx,
        {
          tenantId: auth.tenantId,
          propertyId,
          actor: { type: 'user', userId: auth.userId },
          action: 'folio.charge_transferred',
          entityType: 'folio',
          entityId: from.id,
          changes: { chargeId, toFolioId: to.id, newChargeId: newId, amount: money2(charge.grossAmount) },
          reason: body.reason,
        },
        meta,
      );
      return { status: 200, body: await this.load(tx, property, from.id) };
    });
  }

  /**
   * A charge the system posts on its own, in the category marked with `kind` (a kept deposit becomes a
   * cancellation fee). Taxes follow the category set-up like any other charge.
   */
  async postSystemCharge(
    tx: Tx,
    auth: AuthContext,
    property: PropertyRow,
    folio: FolioRow,
    item: { kind: 'cancellation'; description: string; amount: Money; reason: string },
  ): Promise<string> {
    const [category] = await tx
      .select({ id: schema.chargeCategories.id })
      .from(schema.chargeCategories)
      .where(
        and(
          eq(schema.chargeCategories.propertyId, property.id),
          eq(schema.chargeCategories.systemKind, item.kind),
        ),
      );
    if (!category) throw AppError.notFound('cancellation fee category');
    return this.postItem(tx, auth, property, folio, {
      kind: 'charge',
      categoryId: category.id,
      description: item.description,
      quantity: '1',
      unitPrice: item.amount.toString(),
      amount: item.amount,
      reason: item.reason,
      key: undefined,
    });
  }

  /**
   * Posts one room night (D7) on the folio with the tax of that night, and records it against the booked room so the
   * same night can never be posted twice (unique key). Returns false if the night was already posted.
   */
  async postRoomNight(
    tx: Tx,
    auth: AuthContext,
    property: PropertyRow,
    folio: FolioRow,
    night: { date: string; reservationRoomId: string; rate: Money; roomNumber: string | null },
  ): Promise<boolean> {
    const [done] = await tx
      .select({ id: schema.roomNightCharges.id })
      .from(schema.roomNightCharges)
      .where(
        and(
          eq(schema.roomNightCharges.reservationRoomId, night.reservationRoomId),
          eq(schema.roomNightCharges.night, night.date),
        ),
      );
    if (done) return false;
    const [category] = await tx
      .select({ id: schema.chargeCategories.id })
      .from(schema.chargeCategories)
      .where(
        and(
          eq(schema.chargeCategories.propertyId, property.id),
          eq(schema.chargeCategories.systemKind, 'room'),
        ),
      );
    if (!category) throw AppError.notFound('room charge category');
    // D9: a night accrued by the night audit is already in revenue; billing it clears Unbilled guest revenue instead.
    const [accrual] = await tx
      .select({ net: schema.roomRevenueAccruals.netAmount })
      .from(schema.roomRevenueAccruals)
      .where(
        and(
          eq(schema.roomRevenueAccruals.reservationRoomId, night.reservationRoomId),
          eq(schema.roomRevenueAccruals.night, night.date),
        ),
      );
    const chargeId = await this.postItem(tx, auth, property, folio, {
      kind: 'room_night',
      accrued: accrual ? Money.fromStorage(accrual.net, property.currencyCode).round() : undefined,
      categoryId: category.id,
      description: night.roomNumber
        ? `Room ${night.roomNumber}, night of ${night.date}`
        : `Room, night of ${night.date}`,
      serviceDate: night.date,
      quantity: '1',
      unitPrice: night.rate.toString(),
      amount: night.rate,
      reason: null,
      key: undefined,
    });
    await tx.insert(schema.roomNightCharges).values({
      tenantId: auth.tenantId,
      propertyId: property.id,
      chargeId,
      reservationRoomId: night.reservationRoomId,
      night: night.date,
    });
    return true;
  }

  // ------------------------------------------------------------------------------------------- internals

  private async postItem(
    tx: Tx,
    auth: AuthContext,
    property: PropertyRow,
    folio: FolioRow,
    item: {
      kind: 'charge' | 'allowance' | 'room_night';
      categoryId: string;
      description: string;
      serviceDate?: string;
      quantity: string;
      unitPrice: string;
      amount: Money;
      reason: string | null;
      key: string | undefined;
      /** Room nights only: the net already accrued for this night (D9). */
      accrued?: Money;
    },
  ): Promise<string> {
    const serviceDate = item.serviceDate ?? property.businessDate;
    if (serviceDate > property.businessDate) {
      throw AppError.validation(`The date cannot be after the business date (${property.businessDate}).`, [
        { path: 'serviceDate', message: 'Choose today or an earlier date.' },
      ]);
    }
    const [category] = await tx
      .select({ cat: schema.chargeCategories })
      .from(schema.chargeCategories)
      .where(
        and(
          eq(schema.chargeCategories.propertyId, property.id),
          eq(schema.chargeCategories.id, item.categoryId),
        ),
      );
    if (!category || !category.cat.active) {
      throw AppError.validation('Choose an active charge category.', [
        { path: 'categoryId', message: 'Choose a category.' },
      ]);
    }
    if ((category.cat.systemKind === 'room') !== (item.kind === 'room_night') && item.kind !== 'allowance') {
      throw AppError.validation('Room nights are posted at check-out. Use another category for extras.', [
        { path: 'categoryId', message: 'Choose another category.' },
      ]);
    }
    if (!item.amount.isPositive()) throw AppError.validation('The amount must be more than zero.');

    const { rates } = await this.tax.ratesFor(tx, property.id, item.categoryId, serviceDate);
    const result = calculateTax(item.amount, rates);
    const sign = item.kind === 'allowance' ? -1 : 1;
    const signed = (m: Money) => (sign < 0 ? m.negate() : m);
    const payable = await this.payableAccounts(
      tx,
      rates.map((x) => x.taxCodeId),
    );

    const chargeId = randomUUID();
    const receivable = await this.receivableAccount(tx);
    const side = (m: Money, normal: 'debit' | 'credit') =>
      (normal === 'debit') === sign > 0
        ? { debit: m.toString(), credit: '0' }
        : { debit: '0', credit: m.toString() };
    const lines: PostingLine[] = [
      { accountId: receivable, folioId: folio.id, ...side(result.gross, 'debit') },
      ...(await this.revenueLines(tx, category.cat.revenueAccountId, result.net, item.accrued, side)),
      ...result.lines
        .filter((l) => l.amount.isPositive())
        .map((l) => ({ accountId: payable.get(l.taxCodeId)!, ...side(l.amount, 'credit') })),
    ];
    const res = await this.reservation(tx, property.id, folio.reservationId);
    const journalId = await this.posting.post(tx, auth, {
      propertyId: property.id,
      sourceType: 'folio_charge',
      sourceId: chargeId,
      narration: `${item.kind === 'allowance' ? 'Allowance' : 'Charge'}: ${item.description} (${res.bookingReference}, ${folio.label})`,
      lines,
      idempotencyKey: item.key ?? null,
    });

    await tx.insert(c).values({
      id: chargeId,
      tenantId: auth.tenantId,
      propertyId: property.id,
      folioId: folio.id,
      categoryId: item.categoryId,
      kind: item.kind,
      description: item.description,
      serviceDate,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      netAmount: signed(result.net).toStorage(),
      taxAmount: signed(result.taxTotal).toStorage(),
      grossAmount: signed(result.gross).toStorage(),
      reason: item.reason,
      journalEntryId: journalId,
      createdBy: auth.userId,
    });
    await this.snapshotTaxes(tx, auth, property.id, chargeId, result, payable, sign);
    return chargeId;
  }

  /**
   * The revenue side of a charge. For an accrued room night (D9) the accrued net clears Unbilled guest revenue and
   * only a difference (a rate or tax change since the accrual) touches revenue, so the night is never counted twice.
   */
  private async revenueLines(
    tx: Tx,
    revenueAccountId: string,
    net: Money,
    accrued: Money | undefined,
    side: (m: Money, normal: 'debit' | 'credit') => { debit: string; credit: string },
  ): Promise<PostingLine[]> {
    if (!accrued) return net.isPositive() ? [{ accountId: revenueAccountId, ...side(net, 'credit') }] : [];
    const [unbilled] = await tx
      .select({ id: schema.accounts.id })
      .from(schema.accounts)
      .where(eq(schema.accounts.systemRole, 'unbilled_revenue'));
    if (!unbilled) throw AppError.notFound('unbilled revenue account');
    const rest = net.subtract(accrued);
    return [
      { accountId: unbilled.id, ...side(accrued, 'credit'), description: 'Accrued at night audit' },
      ...(rest.isZero()
        ? []
        : [{ accountId: revenueAccountId, ...side(rest.abs(), rest.isPositive() ? 'credit' : 'debit') }]),
    ];
  }

  /** TAX-001: the rate, inclusivity, base and account as charged, kept with the item for ever. */
  private async snapshotTaxes(
    tx: Tx,
    auth: AuthContext,
    propertyId: string,
    chargeId: string,
    result: TaxResult,
    payable: Map<string, string>,
    sign: number,
  ) {
    if (result.lines.length === 0) return;
    await tx.insert(ct).values(
      result.lines.map((l) => ({
        tenantId: auth.tenantId,
        propertyId,
        chargeId,
        taxCodeId: l.taxCodeId,
        code: l.code,
        name: l.name,
        ratePercent: l.ratePercent,
        inclusive: l.inclusive,
        baseAmount: (sign < 0 ? l.base.negate() : l.base).toStorage(),
        taxAmount: (sign < 0 ? l.amount.negate() : l.amount).toStorage(),
        payableAccountId: payable.get(l.taxCodeId)!,
      })),
    );
  }

  /** Revenue and tax lines of the journal that first posted this item (following transfers back to it). */
  private async originalLines(tx: Tx, charge: ChargeRow) {
    let root = charge;
    for (let guard = 0; root.transferredFromId && guard < 100; guard++) {
      const [prev] = await tx.select().from(c).where(eq(c.id, root.transferredFromId));
      if (!prev) break;
      root = prev;
    }
    const receivable = await this.receivableAccount(tx);
    const lines = await tx
      .select()
      .from(schema.journalLines)
      .where(eq(schema.journalLines.journalEntryId, root.journalEntryId))
      .orderBy(asc(schema.journalLines.lineNo));
    return lines.filter((l) => !(l.accountId === receivable && l.folioId));
  }

  private async payableAccounts(tx: Tx, taxCodeIds: string[]): Promise<Map<string, string>> {
    if (taxCodeIds.length === 0) return new Map();
    const rows = await tx
      .select({ id: schema.taxCodes.id, account: schema.taxCodes.payableAccountId })
      .from(schema.taxCodes)
      .where(inArray(schema.taxCodes.id, taxCodeIds));
    return new Map(rows.map((x) => [x.id, x.account]));
  }

  private async receivableAccount(tx: Tx): Promise<string> {
    const [a] = await tx
      .select({ id: schema.accounts.id })
      .from(schema.accounts)
      .where(eq(schema.accounts.systemRole, 'guest_receivable'));
    if (!a) throw AppError.notFound('guest receivable account');
    return a.id;
  }

  private async lockCharge(tx: Tx, propertyId: string, chargeId: string): Promise<ChargeRow> {
    const [charge] = await tx
      .select()
      .from(c)
      .where(and(eq(c.propertyId, propertyId), eq(c.id, chargeId)))
      .for('update');
    if (!charge) throw AppError.notFound('folio item');
    if (charge.status !== 'posted') {
      throw new AppError('CONFLICT', `This item has already been ${charge.status}.`);
    }
    return charge;
  }

  /** Locks the folio and refuses a closed one (FOLIO_CLOSED). */
  async openFolio(
    tx: Tx,
    propertyId: string,
    folioId: string,
    opts: { allowOnAccount?: boolean } = {},
  ): Promise<FolioRow> {
    const [folio] = await tx
      .select()
      .from(f)
      .where(and(eq(f.propertyId, propertyId), eq(f.id, folioId)))
      .for('update');
    if (!folio) throw AppError.notFound('folio');
    // A folio left on the guest's account after check-out can still take payments, nothing else.
    if (folio.status !== 'open' && !(opts.allowOnAccount && folio.status === 'on_account')) {
      throw new AppError(
        'FOLIO_CLOSED',
        'This folio is closed. Corrections after check-out use a refund or adjustment.',
      );
    }
    return folio;
  }

  /** Runs a money command once per Idempotency-Key, mapping ledger rule failures to clear errors. */
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

  /** The full folio view. Used by payments and check-out too. */
  async load(tx: Tx, property: PropertyRow, folioId: string): Promise<FolioDto> {
    const [row] = await tx
      .select({ f, ref: r.bookingReference, resStatus: r.status, guest: schema.guests.fullName })
      .from(f)
      .innerJoin(r, eq(r.id, f.reservationId))
      .innerJoin(schema.guests, eq(schema.guests.id, f.guestId))
      .where(and(eq(f.propertyId, property.id), eq(f.id, folioId)));
    if (!row) throw AppError.notFound('folio');
    const currency = row.f.currencyCode;
    const charges = await this.chargeDtos(tx, folioId);
    const live = charges.filter((x) => x.status === 'posted');
    const sum = (k: 'net' | 'tax' | 'gross') =>
      Money.sum(
        live.map((x) => Money.of(x[k], currency)),
        currency,
      );
    const posted = { net: sum('net'), tax: sum('tax'), gross: sum('gross') };
    const nights =
      row.f.isPrimary && row.f.status === 'open'
        ? await this.nights(tx, property, row.f.reservationId)
        : null;
    const zero = Money.zero(currency);
    const pending = nights?.pending ?? [];
    const pendingSum = (k: 'net' | 'tax' | 'gross') =>
      Money.sum(
        pending.map((n) => n[k]),
        currency,
      );
    const payments = await this.paymentSummaries(tx, folioId, currency);
    const total = (k: 'amount' | 'refunded') =>
      Money.sum(
        payments.map((p) => Money.of(p[k], currency)),
        currency,
      );
    const received = total('amount');
    const refunded = total('refunded');
    const depositHeld = Money.sum(
      payments.filter((p) => p.kind === 'deposit').map((p) => Money.of(p.refundable, currency)),
      currency,
    );
    const writtenOff = Money.of(row.f.writtenOff, currency).round();
    const balance = posted.gross.subtract(received).add(refunded).subtract(writtenOff);
    const invoices = await tx
      .select({ id: schema.invoices.id, invoiceNumber: schema.invoices.invoiceNumber })
      .from(schema.invoices)
      .where(eq(schema.invoices.folioId, folioId))
      .orderBy(asc(schema.invoices.createdAt));
    return {
      id: row.f.id,
      reservationId: row.f.reservationId,
      bookingReference: row.ref,
      guestId: row.f.guestId,
      guestName: row.guest,
      label: row.f.label,
      isPrimary: row.f.isPrimary,
      status: row.f.status as FolioDto['status'],
      currencyCode: currency,
      charges,
      payments,
      posted: { net: posted.net.toString(), tax: posted.tax.toString(), gross: posted.gross.toString() },
      received: received.toString(),
      writtenOff: writtenOff.toString(),
      invoices,
      refunded: refunded.toString(),
      depositHeld: depositHeld.toString(),
      balance: balance.toString(),
      pendingNights: pending.map((n) => ({
        date: n.date,
        roomNumber: n.roomNumber,
        rate: n.rate.toString(),
        net: n.net.toString(),
        tax: n.tax.toString(),
        gross: n.gross.toString(),
      })),
      pending: {
        net: pendingSum('net').toString(),
        tax: pendingSum('tax').toString(),
        gross: pendingSum('gross').toString(),
      },
      balanceWithPending: balance.add(pendingSum('gross')).toString(),
      stayEstimate: nights
        ? {
            nights: nights.estimate.nights,
            net: nights.estimate.net.toString(),
            tax: nights.estimate.tax.toString(),
            gross: nights.estimate.gross.toString(),
          }
        : { nights: 0, net: zero.toString(), tax: zero.toString(), gross: zero.toString() },
    };
  }

  /**
   * Room nights for the reservation at the agreed rate of each booked-room segment, with room-category tax for the
   * night's date. Pending: nights already slept (from check-in up to, not including, the business date). Estimate:
   * every booked night to departure.
   */
  /** Room nights of a booking not yet posted. Used by the folio view and by check-out. */
  async nights(tx: Tx, property: PropertyRow, reservationId: string, pendingThrough?: string) {
    // Pending: nights slept so far (before the business date), or up to and including `pendingThrough`.
    const pendingBefore = pendingThrough ? addDays(pendingThrough, 1) : property.businessDate;
    const currency = property.currencyCode;
    const [roomCategory] = await tx
      .select({ id: schema.chargeCategories.id })
      .from(schema.chargeCategories)
      .where(
        and(
          eq(schema.chargeCategories.propertyId, property.id),
          eq(schema.chargeCategories.systemKind, 'room'),
        ),
      );
    const segments = await tx
      .select({
        rr,
        roomNumber: schema.rooms.roomNumber,
        checkedIn: sql<
          string | null
        >`(select min(s.from_date)::text from stay_rooms s where s.stay_id = ${rr.stayId})`,
      })
      .from(rr)
      .leftJoin(schema.rooms, eq(schema.rooms.id, rr.roomId))
      .where(and(eq(rr.reservationId, reservationId), eq(rr.status, 'active')))
      .orderBy(asc(rr.arrival));
    // Nights already posted (at an earlier check-out of the booking) are never offered again.
    const postedRows = segments.length
      ? await tx
          .select({ rr: schema.roomNightCharges.reservationRoomId, night: schema.roomNightCharges.night })
          .from(schema.roomNightCharges)
          .where(
            inArray(
              schema.roomNightCharges.reservationRoomId,
              segments.map((x) => x.rr.id),
            ),
          )
      : [];
    const posted = new Set(postedRows.map((x) => `${x.rr}|${x.night}`));
    const taxCache = new Map<string, Awaited<ReturnType<TaxService['ratesFor']>>['rates']>();
    const night = async (
      date: string,
      rate: Money,
      roomNumber: string | null,
      segment: typeof rr.$inferSelect,
    ) => {
      if (!taxCache.has(date)) {
        taxCache.set(
          date,
          roomCategory ? (await this.tax.ratesFor(tx, property.id, roomCategory.id, date)).rates : [],
        );
      }
      const t = calculateTax(rate, taxCache.get(date)!);
      return {
        date,
        roomNumber,
        rate,
        net: t.net,
        tax: t.taxTotal,
        gross: t.gross,
        reservationRoomId: segment.id,
        stayId: segment.stayId,
        roomId: segment.roomId,
      };
    };
    const pending: Awaited<ReturnType<typeof night>>[] = [];
    const estimate = {
      nights: 0,
      net: Money.zero(currency),
      tax: Money.zero(currency),
      gross: Money.zero(currency),
    };
    for (const s of segments) {
      const rate = Money.of(s.rr.nightlyRate, currency).round();
      const start = s.rr.stayId && s.checkedIn && s.checkedIn > s.rr.arrival ? s.checkedIn : s.rr.arrival;
      for (let d = start; d < s.rr.departure; d = addDays(d, 1)) {
        if (posted.has(`${s.rr.id}|${d}`)) continue;
        const n = await night(d, rate, s.roomNumber, s.rr);
        estimate.nights += 1;
        estimate.net = estimate.net.add(n.net);
        estimate.tax = estimate.tax.add(n.tax);
        estimate.gross = estimate.gross.add(n.gross);
        if (s.rr.stayId && d < pendingBefore) pending.push(n);
      }
    }
    return { pending, estimate };
  }

  /** Payments on the folio with what has been refunded and applied from each. */
  private async paymentSummaries(tx: Tx, folioId: string, currency: string): Promise<FolioDto['payments']> {
    const { rows } = await tx.execute<{
      id: string;
      receipt_number: string;
      kind: 'deposit' | 'payment';
      method: FolioDto['payments'][number]['method'];
      amount: string;
      refunded: string;
      applied: string;
      business_date: string;
    }>(sql`
      select p.id, p.receipt_number, p.kind, p.method, p.amount::text, p.business_date::text,
             coalesce((select sum(amount) from refunds where payment_id = p.id), 0)::text as refunded,
             coalesce((select sum(amount) from deposit_applications where payment_id = p.id), 0)::text as applied
      from payments p where p.folio_id = ${folioId} order by p.received_at`);
    return rows.map((p) => {
      const amount = Money.of(p.amount, currency).round();
      const refunded = Money.of(p.refunded, currency).round();
      const applied = Money.of(p.applied, currency).round();
      return {
        id: p.id,
        receiptNumber: p.receipt_number,
        kind: p.kind,
        method: p.method,
        amount: amount.toString(),
        refunded: refunded.toString(),
        applied: applied.toString(),
        refundable: amount.subtract(refunded).subtract(applied).toString(),
        businessDate: p.business_date,
      };
    });
  }

  private async chargeDtos(tx: Tx, folioId: string): Promise<FolioChargeDto[]> {
    const creator = alias(schema.users, 'creator');
    const voider = alias(schema.users, 'voider');
    const rows = await tx
      .select({
        c,
        category: schema.chargeCategories.name,
        journalNumber: schema.journalEntries.journalNumber,
        creator: creator.fullName,
        voider: voider.fullName,
      })
      .from(c)
      .innerJoin(schema.chargeCategories, eq(schema.chargeCategories.id, c.categoryId))
      .innerJoin(schema.journalEntries, eq(schema.journalEntries.id, c.journalEntryId))
      .leftJoin(creator, eq(creator.id, c.createdBy))
      .leftJoin(voider, eq(voider.id, c.voidedBy))
      .where(eq(c.folioId, folioId))
      .orderBy(asc(c.serviceDate), asc(c.createdAt));
    const ids = rows.map((x) => x.c.id);
    const taxes = ids.length ? await tx.select().from(ct).where(inArray(ct.chargeId, ids)) : [];
    const linked = [
      ...new Set(
        rows.flatMap((x) => [x.c.transferredFromId, x.c.transferredToId]).filter((x): x is string => !!x),
      ),
    ];
    const refs = linked.length
      ? await tx
          .select({ id: c.id, folioId: f.id, label: f.label, ref: r.bookingReference })
          .from(c)
          .innerJoin(f, eq(f.id, c.folioId))
          .innerJoin(r, eq(r.id, f.reservationId))
          .where(inArray(c.id, linked))
      : [];
    const ref = (id: string | null) => {
      const x = id ? refs.find((y) => y.id === id) : undefined;
      return x ? { chargeId: x.id, folioId: x.folioId, folioLabel: x.label, bookingReference: x.ref } : null;
    };
    return rows.map(({ c: x, category, journalNumber, creator: by, voider: vb }) => ({
      id: x.id,
      kind: x.kind as FolioChargeDto['kind'],
      categoryId: x.categoryId,
      categoryName: category,
      description: x.description,
      serviceDate: x.serviceDate,
      quantity: qty(x.quantity),
      unitPrice: money2(x.unitPrice),
      net: money2(x.netAmount),
      tax: money2(x.taxAmount),
      gross: money2(x.grossAmount),
      status: x.status as FolioChargeDto['status'],
      reason: x.reason,
      taxes: taxes
        .filter((t) => t.chargeId === x.id)
        .map((t) => ({
          code: t.code,
          name: t.name,
          ratePercent: pct(t.ratePercent),
          inclusive: t.inclusive,
          amount: money2(t.taxAmount),
        })),
      journalEntryId: x.journalEntryId,
      journalNumber,
      transferredFrom: ref(x.transferredFromId),
      transferredTo: ref(x.transferredToId),
      voidReason: x.voidReason,
      voidedAt: x.voidedAt?.toISOString() ?? null,
      voidedByName: vb,
      createdByName: by,
      createdAt: x.createdAt.toISOString(),
    }));
  }

  private async reservation(tx: Tx, propertyId: string, reservationId: string) {
    const [res] = await tx
      .select()
      .from(r)
      .where(and(eq(r.propertyId, propertyId), eq(r.id, reservationId)));
    if (!res) throw AppError.notFound('reservation');
    return res;
  }

  private async property(tx: Tx, propertyId: string): Promise<PropertyRow> {
    const [p] = await tx.select().from(schema.properties).where(eq(schema.properties.id, propertyId));
    if (!p) throw AppError.notFound('property');
    return p;
  }

  private async record(
    tx: Tx,
    auth: AuthContext,
    propertyId: string,
    meta: RequestMeta,
    action: string,
    folioId: string,
    changes: Record<string, unknown>,
  ) {
    await this.audit.record(
      tx,
      {
        tenantId: auth.tenantId,
        propertyId,
        actor: { type: 'user', userId: auth.userId },
        action,
        entityType: 'folio',
        entityId: folioId,
        changes,
      },
      meta,
    );
  }
}
