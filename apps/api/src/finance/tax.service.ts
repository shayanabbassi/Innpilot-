import { Injectable } from '@nestjs/common';
import type {
  ChargeCategoryDto,
  CreateChargeCategoryRequest,
  CreateTaxCodeRequest,
  InvoiceProfileDto,
  InvoiceProfileRequest,
  TaxCodeDto,
  TaxPreviewDto,
  TaxPreviewRequest,
  TaxRateDto,
  TaxRateInput,
  UpdateChargeCategoryRequest,
  UpdateTaxCodeRequest,
} from '@innpilot/contracts';
import { schema, type Tx } from '@innpilot/db';
import { Money } from '@innpilot/money';
import { and, asc, desc, eq, inArray, lte } from 'drizzle-orm';
import { AuditService, changeSet } from '../audit/audit.service';
import { AppError } from '../common/app-error';
import { PG_UNIQUE_VIOLATION, pgErrorCode } from '../common/pg-error';
import type { AuthContext, RequestMeta } from '../common/request';
import { Db } from '../db/db.module';
import { calculateTax, type RateInEffect, type TaxResult } from './tax-calc';

const codes = schema.taxCodes;
const rates = schema.taxRates;
const cats = schema.chargeCategories;
const links = schema.chargeCategoryTaxes;
const accounts = schema.accounts;
type PropertyRow = typeof schema.properties.$inferSelect;

/** Strips the storage scale: "16.0000" → "16", "13.5000" → "13.5". */
const percent = (v: string) => v.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');

/**
 * Tax codes, their effective-dated rates, charge categories and the invoice profile (P3-8, P3-17). Nothing is
 * pre-configured: hotels enter the taxes that apply to them. Rates are never changed in place and cannot start
 * before the business date, so days already traded are never re-taxed (TAX-001).
 */
@Injectable()
export class TaxService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  // ------------------------------------------------------------------------------------------- tax codes

  listTaxCodes(auth: AuthContext, propertyId: string): Promise<TaxCodeDto[]> {
    return this.db.tenant(auth.tenantId, async (tx) => {
      const property = await this.property(tx, propertyId);
      return this.taxCodeDtos(tx, property);
    });
  }

  createTaxCode(
    auth: AuthContext,
    propertyId: string,
    body: CreateTaxCodeRequest,
    meta: RequestMeta,
  ): Promise<TaxCodeDto> {
    return this.unique(`Tax code ${body.code} already exists.`, 'code', () =>
      this.db.tenant(auth.tenantId, async (tx) => {
        const property = await this.property(tx, propertyId);
        const payable = body.payableAccountId ?? (await this.systemAccount(tx, 'tax_payable'));
        await this.assertAccount(tx, payable, 'payable');
        this.assertRateDate(body.firstRate, property);
        const [row] = await tx
          .insert(codes)
          .values({
            tenantId: auth.tenantId,
            propertyId,
            code: body.code,
            name: body.name,
            jurisdiction: body.jurisdiction || null,
            payableAccountId: payable,
          })
          .returning();
        await this.insertRate(tx, auth, propertyId, row!.id, body.firstRate);
        await this.record(tx, auth, propertyId, meta, 'tax_code.created', 'tax_code', row!.id, {
          code: row!.code,
          name: row!.name,
          ratePercent: body.firstRate.ratePercent,
          inclusive: body.firstRate.inclusive,
          effectiveFrom: body.firstRate.effectiveFrom,
        });
        return this.oneTaxCode(tx, property, row!.id);
      }),
    );
  }

  updateTaxCode(
    auth: AuthContext,
    propertyId: string,
    id: string,
    body: UpdateTaxCodeRequest,
    meta: RequestMeta,
  ): Promise<TaxCodeDto> {
    return this.db.tenant(auth.tenantId, async (tx) => {
      const property = await this.property(tx, propertyId);
      const before = await this.taxCode(tx, propertyId, id, true);
      if (body.payableAccountId) await this.assertAccount(tx, body.payableAccountId, 'payable');
      const set = {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.jurisdiction !== undefined ? { jurisdiction: body.jurisdiction || null } : {}),
        ...(body.payableAccountId !== undefined ? { payableAccountId: body.payableAccountId } : {}),
        ...(body.active !== undefined ? { active: body.active } : {}),
      };
      // Drizzle refuses an update with nothing to set.
      const after = Object.keys(set).length
        ? (await tx.update(codes).set(set).where(eq(codes.id, id)).returning())[0]!
        : before;
      const changes = changeSet(before, after, ['name', 'jurisdiction', 'payableAccountId', 'active']);
      if (Object.keys(changes).length > 0) {
        await this.record(tx, auth, propertyId, meta, 'tax_code.updated', 'tax_code', id, {
          code: before.code,
          ...changes,
        });
      }
      return this.oneTaxCode(tx, property, id);
    });
  }

  addRate(
    auth: AuthContext,
    propertyId: string,
    id: string,
    body: TaxRateInput,
    meta: RequestMeta,
  ): Promise<TaxCodeDto> {
    return this.unique('There is already a rate starting on that date.', 'effectiveFrom', () =>
      this.db.tenant(auth.tenantId, async (tx) => {
        const property = await this.property(tx, propertyId);
        const code = await this.taxCode(tx, propertyId, id, true);
        this.assertRateDate(body, property);
        await this.insertRate(tx, auth, propertyId, id, body);
        await this.record(tx, auth, propertyId, meta, 'tax_code.rate_added', 'tax_code', id, {
          code: code.code,
          ratePercent: body.ratePercent,
          inclusive: body.inclusive,
          effectiveFrom: body.effectiveFrom,
        });
        return this.oneTaxCode(tx, property, id);
      }),
    );
  }

  removeRate(
    auth: AuthContext,
    propertyId: string,
    id: string,
    rateId: string,
    meta: RequestMeta,
  ): Promise<TaxCodeDto> {
    return this.db.tenant(auth.tenantId, async (tx) => {
      const property = await this.property(tx, propertyId);
      const code = await this.taxCode(tx, propertyId, id, true);
      const [rate] = await tx
        .select()
        .from(rates)
        .where(and(eq(rates.id, rateId), eq(rates.taxCodeId, id)));
      if (!rate) throw AppError.notFound('tax rate');
      if (rate.effectiveFrom <= property.businessDate) {
        throw new AppError(
          'CONFLICT',
          'This rate is already in effect and is kept as history. Add a new rate to change it from a later date.',
        );
      }
      await tx.delete(rates).where(eq(rates.id, rateId));
      await this.record(tx, auth, propertyId, meta, 'tax_code.rate_removed', 'tax_code', id, {
        code: code.code,
        ratePercent: percent(rate.ratePercent),
        effectiveFrom: rate.effectiveFrom,
      });
      return this.oneTaxCode(tx, property, id);
    });
  }

  // ------------------------------------------------------------------------------------------- categories

  listCategories(auth: AuthContext, propertyId: string): Promise<ChargeCategoryDto[]> {
    return this.db.tenant(auth.tenantId, async (tx) => {
      await this.property(tx, propertyId);
      return this.categoryDtos(tx, propertyId);
    });
  }

  createCategory(
    auth: AuthContext,
    propertyId: string,
    body: CreateChargeCategoryRequest,
    meta: RequestMeta,
  ): Promise<ChargeCategoryDto> {
    return this.unique(`Category ${body.code} already exists.`, 'code', () =>
      this.db.tenant(auth.tenantId, async (tx) => {
        await this.property(tx, propertyId);
        await this.assertAccount(tx, body.revenueAccountId, 'revenue');
        const [row] = await tx
          .insert(cats)
          .values({
            tenantId: auth.tenantId,
            propertyId,
            code: body.code,
            name: body.name,
            revenueAccountId: body.revenueAccountId,
          })
          .returning();
        await this.setCategoryTaxes(tx, auth, propertyId, row!.id, body.taxCodeIds);
        await this.record(tx, auth, propertyId, meta, 'charge_category.created', 'charge_category', row!.id, {
          code: row!.code,
          name: row!.name,
          taxCodes: body.taxCodeIds.length,
        });
        return this.oneCategory(tx, propertyId, row!.id);
      }),
    );
  }

  updateCategory(
    auth: AuthContext,
    propertyId: string,
    id: string,
    body: UpdateChargeCategoryRequest,
    meta: RequestMeta,
  ): Promise<ChargeCategoryDto> {
    return this.db.tenant(auth.tenantId, async (tx) => {
      await this.property(tx, propertyId);
      const [before] = await tx
        .select()
        .from(cats)
        .where(and(eq(cats.propertyId, propertyId), eq(cats.id, id)))
        .for('update');
      if (!before) throw AppError.notFound('charge category');
      if (body.active === false && before.systemKind) {
        throw AppError.validation('The room category is used for room nights and always stays active.');
      }
      if (body.revenueAccountId) await this.assertAccount(tx, body.revenueAccountId, 'revenue');
      const set = {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.revenueAccountId !== undefined ? { revenueAccountId: body.revenueAccountId } : {}),
        ...(body.active !== undefined ? { active: body.active } : {}),
      };
      // A PATCH that only changes the tax codes has nothing to set on the row, and Drizzle refuses an empty update.
      const after = Object.keys(set).length
        ? (await tx.update(cats).set(set).where(eq(cats.id, id)).returning())[0]!
        : before;
      const changes: Record<string, unknown> = changeSet(before, after, [
        'name',
        'revenueAccountId',
        'active',
      ]);
      if (body.taxCodeIds) {
        const old = (await tx.select().from(links).where(eq(links.categoryId, id)))
          .map((l) => l.taxCodeId)
          .sort();
        const next = [...new Set(body.taxCodeIds)].sort();
        if (old.join() !== next.join()) {
          await this.setCategoryTaxes(tx, auth, propertyId, id, next);
          changes.taxCodes = { from: old.length, to: next.length };
        }
      }
      if (Object.keys(changes).length > 0) {
        await this.record(tx, auth, propertyId, meta, 'charge_category.updated', 'charge_category', id, {
          code: before.code,
          ...changes,
        });
      }
      return this.oneCategory(tx, propertyId, id);
    });
  }

  // ------------------------------------------------------------------------------------------- invoice profile

  getInvoiceProfile(auth: AuthContext, propertyId: string): Promise<InvoiceProfileDto> {
    return this.db.tenant(auth.tenantId, async (tx) => {
      await this.property(tx, propertyId);
      return this.profileDto(tx, propertyId);
    });
  }

  putInvoiceProfile(
    auth: AuthContext,
    propertyId: string,
    body: InvoiceProfileRequest,
    meta: RequestMeta,
  ): Promise<InvoiceProfileDto> {
    return this.db.tenant(auth.tenantId, async (tx) => {
      await this.property(tx, propertyId);
      const p = schema.invoiceProfiles;
      const values = {
        legalName: body.legalName || null,
        address: body.address || null,
        registrationFields: body.registrationFields,
        invoicePrefix: body.invoicePrefix,
        receiptPrefix: body.receiptPrefix,
        footer: body.footer || null,
        updatedBy: auth.userId,
      };
      await tx
        .insert(p)
        .values({ propertyId, tenantId: auth.tenantId, ...values })
        .onConflictDoUpdate({ target: p.propertyId, set: values });
      // Field labels are recorded; values (registration numbers) stay out of the audit log.
      await this.record(tx, auth, propertyId, meta, 'invoice_profile.updated', 'property', propertyId, {
        registrationLabels: body.registrationFields.map((f) => f.label),
        invoicePrefix: body.invoicePrefix,
        receiptPrefix: body.receiptPrefix,
      });
      return this.profileDto(tx, propertyId);
    });
  }

  // ------------------------------------------------------------------------------------------- calculation

  preview(auth: AuthContext, propertyId: string, body: TaxPreviewRequest): Promise<TaxPreviewDto> {
    return this.db.tenant(auth.tenantId, async (tx) => {
      const property = await this.property(tx, propertyId);
      const date = body.serviceDate ?? property.businessDate;
      const { rates: inEffect, notInEffect } = await this.ratesFor(tx, propertyId, body.categoryId, date);
      const result = calculateTax(Money.of(body.amount, property.currencyCode), inEffect);
      return { serviceDate: date, notInEffect, ...previewAmounts(result) };
    });
  }

  /**
   * The active tax codes on a category with the rate each has on `date`. Codes with no rate yet are reported, not
   * charged. Used by the preview now and by folio charges (slice 3.3).
   */
  async ratesFor(
    tx: Tx,
    propertyId: string,
    categoryId: string,
    date: string,
  ): Promise<{ rates: RateInEffect[]; notInEffect: string[] }> {
    const [category] = await tx
      .select({ id: cats.id })
      .from(cats)
      .where(and(eq(cats.propertyId, propertyId), eq(cats.id, categoryId)));
    if (!category) throw AppError.notFound('charge category');
    const linked = await tx
      .select({ c: codes })
      .from(links)
      .innerJoin(codes, eq(codes.id, links.taxCodeId))
      .where(and(eq(links.categoryId, categoryId), eq(codes.active, true)))
      .orderBy(asc(codes.code));
    const out: RateInEffect[] = [];
    const notInEffect: string[] = [];
    for (const { c } of linked) {
      const [rate] = await tx
        .select()
        .from(rates)
        .where(and(eq(rates.taxCodeId, c.id), lte(rates.effectiveFrom, date)))
        .orderBy(desc(rates.effectiveFrom))
        .limit(1);
      if (!rate) notInEffect.push(c.code);
      else
        out.push({
          taxCodeId: c.id,
          code: c.code,
          name: c.name,
          ratePercent: percent(rate.ratePercent),
          inclusive: rate.inclusive,
        });
    }
    return { rates: out, notInEffect };
  }

  // ------------------------------------------------------------------------------------------- internals

  private async insertRate(
    tx: Tx,
    auth: AuthContext,
    propertyId: string,
    taxCodeId: string,
    r: TaxRateInput,
  ) {
    await tx.insert(rates).values({
      tenantId: auth.tenantId,
      propertyId,
      taxCodeId,
      effectiveFrom: r.effectiveFrom,
      ratePercent: r.ratePercent,
      inclusive: r.inclusive,
      createdBy: auth.userId,
    });
  }

  private assertRateDate(r: TaxRateInput, property: PropertyRow) {
    if (r.effectiveFrom < property.businessDate) {
      throw AppError.validation(
        `A rate cannot start before the business date (${property.businessDate}); days already traded keep their tax.`,
        [{ path: 'effectiveFrom', message: `Choose ${property.businessDate} or later.` }],
      );
    }
  }

  private async setCategoryTaxes(
    tx: Tx,
    auth: AuthContext,
    propertyId: string,
    categoryId: string,
    ids: string[],
  ) {
    const unique = [...new Set(ids)];
    if (unique.length > 0) {
      const found = await tx
        .select({ id: codes.id })
        .from(codes)
        .where(and(eq(codes.propertyId, propertyId), inArray(codes.id, unique)));
      if (found.length !== unique.length) {
        throw AppError.validation('Choose tax codes set up for this property.', [
          { path: 'taxCodeIds', message: 'One of the tax codes was not found.' },
        ]);
      }
    }
    await tx.delete(links).where(eq(links.categoryId, categoryId));
    if (unique.length > 0) {
      await tx
        .insert(links)
        .values(unique.map((taxCodeId) => ({ tenantId: auth.tenantId, propertyId, categoryId, taxCodeId })));
    }
  }

  /** Tax goes to an active liability account; revenue to an active credit-normal revenue or other-income account. */
  private async assertAccount(tx: Tx, id: string, use: 'payable' | 'revenue') {
    const [a] = await tx.select().from(accounts).where(eq(accounts.id, id));
    const ok =
      a &&
      a.active &&
      (use === 'payable'
        ? a.accountClass === 'liability'
        : (a.accountClass === 'revenue' || a.accountClass === 'other') && a.normalBalance === 'credit');
    if (!ok) {
      const field = use === 'payable' ? 'payableAccountId' : 'revenueAccountId';
      throw AppError.validation(
        use === 'payable'
          ? 'Tax must be collected into an active liability account (2000–2999).'
          : 'Charges must post to an active revenue or other-income account.',
        [{ path: field, message: 'Choose a different account.' }],
      );
    }
  }

  private async systemAccount(tx: Tx, role: string): Promise<string> {
    const [a] = await tx.select({ id: accounts.id }).from(accounts).where(eq(accounts.systemRole, role));
    if (!a) throw AppError.notFound('system account');
    return a.id;
  }

  private async taxCode(tx: Tx, propertyId: string, id: string, lock = false) {
    const q = tx
      .select()
      .from(codes)
      .where(and(eq(codes.propertyId, propertyId), eq(codes.id, id)));
    const [row] = lock ? await q.for('update') : await q;
    if (!row) throw AppError.notFound('tax code');
    return row;
  }

  private async oneTaxCode(tx: Tx, property: PropertyRow, id: string): Promise<TaxCodeDto> {
    const all = await this.taxCodeDtos(tx, property);
    return all.find((c) => c.id === id)!;
  }

  private async taxCodeDtos(tx: Tx, property: PropertyRow): Promise<TaxCodeDto[]> {
    const rows = await tx
      .select({ c: codes, accountCode: accounts.code, accountName: accounts.name })
      .from(codes)
      .innerJoin(accounts, eq(accounts.id, codes.payableAccountId))
      .where(eq(codes.propertyId, property.id))
      .orderBy(asc(codes.code));
    const allRates = rows.length
      ? await tx
          .select()
          .from(rates)
          .where(
            inArray(
              rates.taxCodeId,
              rows.map((r) => r.c.id),
            ),
          )
          .orderBy(desc(rates.effectiveFrom))
      : [];
    return rows.map(({ c, accountCode, accountName }) => {
      const mine = allRates.filter((r) => r.taxCodeId === c.id).map(rateDto);
      return {
        id: c.id,
        code: c.code,
        name: c.name,
        jurisdiction: c.jurisdiction,
        payableAccountId: c.payableAccountId,
        payableAccountCode: accountCode,
        payableAccountName: accountName,
        active: c.active,
        currentRate: mine.find((r) => r.effectiveFrom <= property.businessDate) ?? null,
        rates: mine,
      };
    });
  }

  private async oneCategory(tx: Tx, propertyId: string, id: string): Promise<ChargeCategoryDto> {
    return (await this.categoryDtos(tx, propertyId)).find((c) => c.id === id)!;
  }

  private async categoryDtos(tx: Tx, propertyId: string): Promise<ChargeCategoryDto[]> {
    const rows = await tx
      .select({ c: cats, accountCode: accounts.code, accountName: accounts.name })
      .from(cats)
      .innerJoin(accounts, eq(accounts.id, cats.revenueAccountId))
      .where(eq(cats.propertyId, propertyId))
      .orderBy(asc(cats.name));
    const allLinks = await tx.select().from(links).where(eq(links.propertyId, propertyId));
    return rows.map(({ c, accountCode, accountName }) => ({
      id: c.id,
      code: c.code,
      name: c.name,
      revenueAccountId: c.revenueAccountId,
      revenueAccountCode: accountCode,
      revenueAccountName: accountName,
      systemKind: (c.systemKind as 'room' | null) ?? null,
      active: c.active,
      taxCodeIds: allLinks.filter((l) => l.categoryId === c.id).map((l) => l.taxCodeId),
    }));
  }

  private async profileDto(tx: Tx, propertyId: string): Promise<InvoiceProfileDto> {
    const [row] = await tx
      .select({ p: schema.invoiceProfiles, name: schema.users.fullName })
      .from(schema.invoiceProfiles)
      .leftJoin(schema.users, eq(schema.users.id, schema.invoiceProfiles.updatedBy))
      .where(eq(schema.invoiceProfiles.propertyId, propertyId));
    if (!row) throw AppError.notFound('invoice profile');
    return {
      legalName: row.p.legalName,
      address: row.p.address,
      registrationFields: row.p.registrationFields,
      invoicePrefix: row.p.invoicePrefix,
      receiptPrefix: row.p.receiptPrefix,
      footer: row.p.footer,
      updatedAt: row.p.updatedAt.toISOString(),
      updatedByName: row.name,
    };
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
    entityType: string,
    entityId: string,
    changes: Record<string, unknown>,
  ) {
    await this.audit.record(
      tx,
      {
        tenantId: auth.tenantId,
        propertyId,
        actor: { type: 'user', userId: auth.userId },
        action,
        entityType,
        entityId,
        changes,
      },
      meta,
    );
  }

  private async unique<T>(message: string, path: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (pgErrorCode(err) === PG_UNIQUE_VIOLATION) throw AppError.validation(message, [{ path, message }]);
      throw err;
    }
  }
}

function rateDto(r: typeof rates.$inferSelect): TaxRateDto {
  return {
    id: r.id,
    effectiveFrom: r.effectiveFrom,
    ratePercent: percent(r.ratePercent),
    inclusive: r.inclusive,
    createdAt: r.createdAt.toISOString(),
  };
}

function previewAmounts(r: TaxResult) {
  return {
    amount: r.amount.round().toString(),
    net: r.net.toString(),
    taxTotal: r.taxTotal.toString(),
    gross: r.gross.toString(),
    lines: r.lines.map((l) => ({
      taxCodeId: l.taxCodeId,
      code: l.code,
      name: l.name,
      ratePercent: l.ratePercent,
      inclusive: l.inclusive,
      base: l.base.toString(),
      amount: l.amount.toString(),
    })),
  };
}
