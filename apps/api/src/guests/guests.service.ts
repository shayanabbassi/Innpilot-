import { Injectable } from '@nestjs/common';
import {
  normalizeDocumentNumber,
  normalizePhone,
  type CreateGuestRequest,
  type DuplicateCandidateDto,
  type DuplicateCheckRequest,
  type GuestDocumentDto,
  type GuestDocumentInput,
  type GuestDto,
  type GuestSearchQuery,
  type GuestSummaryDto,
  type Permission,
  type RevealedDocumentDto,
  type UpdateGuestRequest,
} from '@innpilot/contracts';
import { schema, type Tx } from '@innpilot/db';
import { and, asc, desc, eq, ilike, or, sql, type SQL } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service';
import { AppError } from '../common/app-error';
import type { AuthContext, RequestMeta } from '../common/request';
import { Db } from '../db/db.module';
import { PiiService } from './pii.service';

type GuestRow = typeof schema.guests.$inferSelect;
type DocumentRow = typeof schema.guestDocuments.$inferSelect;

const g = schema.guests;
const d = schema.guestDocuments;

/** Escapes LIKE wildcards in user input. */
const likeSafe = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

function summary(r: GuestRow): GuestSummaryDto {
  return {
    id: r.id,
    fullName: r.fullName,
    phone: r.phone,
    email: r.email,
    city: r.city,
    nationality: r.nationality,
  };
}

function documentDto(r: DocumentRow): GuestDocumentDto {
  return {
    id: r.id,
    documentType: r.documentType,
    issuingCountry: r.issuingCountry,
    last4: r.numberLast4,
    expiryDate: r.expiryDate,
    createdAt: r.createdAt.toISOString(),
  };
}

/** Holds the permission on any property (guests are shared by the tenant's properties). */
function holds(auth: AuthContext, permission: Permission): boolean {
  for (const perms of auth.permissionsByProperty.values()) if (perms.has(permission)) return true;
  return false;
}

const AUDITED_FIELDS = [
  'fullName',
  'phone',
  'email',
  'nationality',
  'addressLine',
  'city',
  'countryCode',
  'preferences',
  'notes',
  'marketingConsent',
] as const;

/**
 * Guest profiles. Privacy rules: list/search results carry no identity-document data; document numbers are
 * stored encrypted and only revealed one at a time, with a reason, to holders of guest.identity.read, and every
 * reveal is audited. Audit entries for profile edits name the fields changed, not their values.
 */
@Injectable()
export class GuestsService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly pii: PiiService,
  ) {}

  search(auth: AuthContext, query: GuestSearchQuery): Promise<GuestSummaryDto[]> {
    return this.db.tenant(auth.tenantId, async (tx) => {
      const q = query.search?.trim() ?? '';
      let where: SQL | undefined;
      let order: SQL[] = [desc(g.createdAt)];
      if (q) {
        const digits = q.replace(/\D/g, '');
        const conditions: (SQL | undefined)[] = [ilike(g.fullName, `%${likeSafe(q)}%`)];
        if (digits.length >= 4) {
          const phoneKey = normalizePhone(q) ?? digits;
          conditions.push(sql`${g.phoneNormalized} like ${`%${likeSafe(phoneKey.slice(-9))}%`}`);
        }
        if (q.includes('@')) conditions.push(eq(g.email, q.toLowerCase()));
        // Fuzzy name match for typos and transliteration variants (Muhammad / Mohammad).
        if (q.length >= 3) conditions.push(sql`similarity(lower(${g.fullName}), lower(${q})) > 0.35`);
        where = or(...conditions);
        order = [sql`similarity(lower(${g.fullName}), lower(${q})) desc`, asc(g.fullName)];
      }
      const rows = await tx
        .select()
        .from(g)
        .where(where)
        .orderBy(...order)
        .limit(query.limit);
      return rows.map(summary);
    });
  }

  async duplicates(auth: AuthContext, input: DuplicateCheckRequest): Promise<DuplicateCandidateDto[]> {
    return this.db.tenant(auth.tenantId, (tx) => this.findDuplicates(tx, input));
  }

  private async findDuplicates(tx: Tx, input: DuplicateCheckRequest): Promise<DuplicateCandidateDto[]> {
    const reasons = new Map<string, Set<DuplicateCandidateDto['reasons'][number]>>();
    const rows = new Map<string, GuestRow>();
    const add = (list: GuestRow[], reason: DuplicateCandidateDto['reasons'][number]) => {
      for (const r of list) {
        if (r.id === input.excludeGuestId) continue;
        rows.set(r.id, r);
        if (!reasons.has(r.id)) reasons.set(r.id, new Set());
        reasons.get(r.id)!.add(reason);
      }
    };

    const phoneKey = input.phone ? normalizePhone(input.phone) : null;
    if (phoneKey) add(await tx.select().from(g).where(eq(g.phoneNormalized, phoneKey)).limit(5), 'phone');
    if (input.email?.includes('@')) {
      add(await tx.select().from(g).where(eq(g.email, input.email.toLowerCase())).limit(5), 'email');
    }
    if (input.document) {
      const key = this.pii.documentLookupKey(input.document.documentType, input.document.number);
      const matches = await tx
        .select({ guest: g })
        .from(d)
        .innerJoin(g, eq(g.id, d.guestId))
        .where(eq(d.numberHmac, key))
        .limit(5);
      add(
        matches.map((m) => m.guest),
        'document',
      );
    }
    const name = input.fullName?.trim();
    if (name && name.length >= 3) {
      add(
        await tx
          .select()
          .from(g)
          .where(sql`similarity(lower(${g.fullName}), lower(${name})) > 0.6`)
          .orderBy(sql`similarity(lower(${g.fullName}), lower(${name})) desc`)
          .limit(5),
        'name',
      );
    }
    // Strongest evidence first: document, phone, email, then name only.
    const weight = (id: string) => {
      const r = reasons.get(id)!;
      return (
        (r.has('document') ? 8 : 0) +
        (r.has('phone') ? 4 : 0) +
        (r.has('email') ? 2 : 0) +
        (r.has('name') ? 1 : 0)
      );
    };
    return [...rows.values()]
      .sort((a, b) => weight(b.id) - weight(a.id))
      .slice(0, 5)
      .map((r) => ({ ...summary(r), reasons: [...reasons.get(r.id)!] }));
  }

  get(auth: AuthContext, id: string): Promise<GuestDto> {
    return this.db.tenant(auth.tenantId, (tx) => this.load(tx, auth, id));
  }

  private async load(tx: Tx, auth: AuthContext, id: string): Promise<GuestDto> {
    const [row] = await tx.select().from(g).where(eq(g.id, id));
    if (!row) throw AppError.notFound('guest');
    const canSeeDocuments = holds(auth, 'guest.identity.read');
    const docs = await tx.select().from(d).where(eq(d.guestId, id)).orderBy(desc(d.createdAt));
    return {
      ...summary(row),
      addressLine: row.addressLine,
      countryCode: row.countryCode,
      preferences: row.preferences,
      notes: row.notes,
      marketingConsent: row.marketingConsent,
      createdAt: row.createdAt.toISOString(),
      documentCount: docs.length,
      documents: canSeeDocuments ? docs.map(documentDto) : null,
    };
  }

  async create(auth: AuthContext, body: CreateGuestRequest, meta: RequestMeta): Promise<GuestDto> {
    if (body.document && !holds(auth, 'guest.identity.read')) {
      throw AppError.forbidden('You do not have permission to record identity documents.');
    }
    return this.db.tenant(auth.tenantId, async (tx) => {
      const { document, ...fields } = body;
      const [row] = await tx
        .insert(g)
        .values({
          tenantId: auth.tenantId,
          ...fields,
          phoneNormalized: fields.phone ? normalizePhone(fields.phone) : null,
          consentUpdatedAt: fields.marketingConsent !== undefined ? new Date() : null,
          createdBy: auth.userId,
        })
        .returning();
      await this.audit.record(
        tx,
        {
          tenantId: auth.tenantId,
          actor: { type: 'user', userId: auth.userId },
          action: 'guest.created',
          entityType: 'guest',
          entityId: row!.id,
          changes: {
            fields: Object.keys(fields).filter(
              (k) =>
                fields[k as keyof typeof fields] !== null && fields[k as keyof typeof fields] !== undefined,
            ),
          },
        },
        meta,
      );
      if (document) await this.insertDocument(tx, auth, row!.id, document, meta);
      return this.load(tx, auth, row!.id);
    });
  }

  update(auth: AuthContext, id: string, body: UpdateGuestRequest, meta: RequestMeta): Promise<GuestDto> {
    return this.db.tenant(auth.tenantId, async (tx) => {
      const [before] = await tx.select().from(g).where(eq(g.id, id)).for('update');
      if (!before) throw AppError.notFound('guest');
      const patch: Partial<typeof g.$inferInsert> = { ...body };
      if ('phone' in body) patch.phoneNormalized = body.phone ? normalizePhone(body.phone) : null;
      if (body.marketingConsent !== undefined && body.marketingConsent !== before.marketingConsent) {
        patch.consentUpdatedAt = new Date();
      }
      const [after] = await tx.update(g).set(patch).where(eq(g.id, id)).returning();
      const changed = AUDITED_FIELDS.filter((f) => after![f] !== before[f]);
      if (changed.length > 0) {
        await this.audit.record(
          tx,
          {
            tenantId: auth.tenantId,
            actor: { type: 'user', userId: auth.userId },
            action: 'guest.updated',
            entityType: 'guest',
            entityId: id,
            // Personal data stays out of the audit log: record which fields changed, not their values.
            changes: { fields: changed },
          },
          meta,
        );
      }
      return this.load(tx, auth, id);
    });
  }

  // ------------------------------------------------------------------------------------------- documents

  private async insertDocument(
    tx: Tx,
    auth: AuthContext,
    guestId: string,
    input: GuestDocumentInput,
    meta: RequestMeta,
  ): Promise<void> {
    const normalized = normalizeDocumentNumber(input.number);
    const [doc] = await tx
      .insert(d)
      .values({
        tenantId: auth.tenantId,
        guestId,
        documentType: input.documentType,
        issuingCountry: input.issuingCountry,
        numberEnc: this.pii.encrypt(normalized),
        numberHmac: this.pii.documentLookupKey(input.documentType, normalized),
        numberLast4: normalized.slice(-4),
        expiryDate: input.expiryDate ?? null,
        createdBy: auth.userId,
      })
      .returning({ id: d.id });
    await this.audit.record(
      tx,
      {
        tenantId: auth.tenantId,
        actor: { type: 'user', userId: auth.userId },
        action: 'guest.document_added',
        entityType: 'guest',
        entityId: guestId,
        changes: {
          documentId: doc!.id,
          documentType: input.documentType,
          issuingCountry: input.issuingCountry,
        },
      },
      meta,
    );
  }

  addDocument(
    auth: AuthContext,
    guestId: string,
    input: GuestDocumentInput,
    meta: RequestMeta,
  ): Promise<GuestDto> {
    this.assertIdentityAccess(auth);
    return this.db.tenant(auth.tenantId, async (tx) => {
      const [guest] = await tx.select({ id: g.id }).from(g).where(eq(g.id, guestId)).for('update');
      if (!guest) throw AppError.notFound('guest');
      await this.insertDocument(tx, auth, guestId, input, meta);
      return this.load(tx, auth, guestId);
    });
  }

  removeDocument(
    auth: AuthContext,
    guestId: string,
    documentId: string,
    meta: RequestMeta,
  ): Promise<GuestDto> {
    this.assertIdentityAccess(auth);
    return this.db.tenant(auth.tenantId, async (tx) => {
      const [doc] = await tx
        .select()
        .from(d)
        .where(and(eq(d.id, documentId), eq(d.guestId, guestId)));
      if (!doc) throw AppError.notFound('document');
      await tx.delete(d).where(eq(d.id, documentId));
      await this.audit.record(
        tx,
        {
          tenantId: auth.tenantId,
          actor: { type: 'user', userId: auth.userId },
          action: 'guest.document_removed',
          entityType: 'guest',
          entityId: guestId,
          changes: { documentId, documentType: doc.documentType },
        },
        meta,
      );
      return this.load(tx, auth, guestId);
    });
  }

  /** Decrypts one document number for display. Requires a reason; the reveal itself is audited. */
  reveal(
    auth: AuthContext,
    guestId: string,
    documentId: string,
    reason: string,
    meta: RequestMeta,
  ): Promise<RevealedDocumentDto> {
    return this.db.tenant(auth.tenantId, async (tx) => {
      const [doc] = await tx
        .select()
        .from(d)
        .where(and(eq(d.id, documentId), eq(d.guestId, guestId)));
      if (!doc) throw AppError.notFound('document');
      await this.audit.record(
        tx,
        {
          tenantId: auth.tenantId,
          actor: { type: 'user', userId: auth.userId },
          action: 'guest.document_revealed',
          entityType: 'guest',
          entityId: guestId,
          changes: { documentId, documentType: doc.documentType },
          reason,
        },
        meta,
      );
      return { id: doc.id, number: this.pii.decrypt(doc.numberEnc) };
    });
  }

  private assertIdentityAccess(auth: AuthContext): void {
    if (!holds(auth, 'guest.identity.read')) {
      throw AppError.forbidden('You do not have permission to manage identity documents.');
    }
  }
}
