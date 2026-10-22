import { createHash, randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  ATTACHMENT_MAX_BYTES,
  type AttachmentDto,
  type AttachmentType,
  type FileLinkDto,
  type Permission,
} from '@innpilot/contracts';
import { schema, type Tx } from '@innpilot/db';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service';
import { AppError } from '../common/app-error';
import type { AppRequest, AuthContext, RequestMeta } from '../common/request';
import { Db } from '../db/db.module';
import { FileStore } from './file-store.service';
import { detectType, displayName, pdfHasActiveContent } from './files';

const a = schema.attachments;
/** Bodies up to this size are read and discarded when over the limit; beyond it the connection is closed. */
const DISCARD_LIMIT = 4 * ATTACHMENT_MAX_BYTES;
type AttachmentRow = typeof a.$inferSelect;

/** What a file is attached to. Callers check the owner exists and the caller may see it before using this. */
export type AttachmentOwner =
  { kind: 'expense'; expenseId: string; propertyId: string } | { kind: 'guest'; guestId: string };

export interface DownloadFile {
  body: Buffer;
  contentType: AttachmentType;
  fileName: string;
}

/**
 * Attachments in private object storage (slice 6.2, SEC-003).
 *
 * - Stored through FileStore: a private bucket only the API reaches, every file encrypted before it leaves.
 * - Object keys carry the tenant and property and a random id: never a file name or anything about a guest.
 * - Only PDF, JPEG and PNG, recognised from the content, at most 5 MB; PDFs with scripts or embedded files are
 *   refused.
 * - Downloads use a link that names one attachment, tenant and user and stops working after five minutes. The
 *   link is issued only after the caller's access to the owning record is checked.
 */
@Injectable()
export class AttachmentsService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly files: FileStore,
  ) {}

  /** Reads the raw request body (the file), refusing more than the size limit. */
  async readUpload(req: AppRequest): Promise<Buffer> {
    if (req.is('application/json') || req.is('multipart/*')) {
      throw new AppError('FILE_REJECTED', 'Send the file itself as the request body.');
    }
    // A body over the limit is read to its end and thrown away, so the client gets the 413 rather than a reset
    // connection (answering mid-upload makes the server close the socket while the client is still sending).
    // Past DISCARD_LIMIT the connection is cut: nobody honest sends that much.
    const declared = Number(req.headers['content-length'] ?? NaN);
    if (declared > DISCARD_LIMIT) {
      req.destroy();
      throw tooLarge();
    }
    return new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let done = false;
      const finish = (result: Buffer | Error) => {
        if (done) return;
        done = true;
        if (result instanceof Error) reject(result);
        else resolve(result);
      };
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size <= ATTACHMENT_MAX_BYTES) chunks.push(chunk);
        else if (size > DISCARD_LIMIT) {
          req.destroy();
          finish(tooLarge());
        } else chunks.length = 0;
      });
      req.on('end', () => finish(size > ATTACHMENT_MAX_BYTES ? tooLarge() : Buffer.concat(chunks)));
      req.on('error', (err) => finish(err));
      req.on('close', () => finish(AppError.validation('The upload did not finish.')));
    });
  }

  /** The live attachments of a record, oldest first. */
  async list(tx: Tx, owner: AttachmentOwner, removable: boolean): Promise<AttachmentDto[]> {
    const rows = await tx
      .select({ a, by: schema.users.fullName })
      .from(a)
      .leftJoin(schema.users, eq(schema.users.id, a.createdBy))
      .where(and(ownerFilter(owner), isNull(a.removedAt)))
      .orderBy(asc(a.createdAt));
    return rows.map((r) => dto(r.a, r.by, removable));
  }

  /** Live attachments of many expenses at once, for lists. Files on drafts can still be removed. */
  async listForExpenses(
    tx: Tx,
    expenseIds: string[],
    drafts: Set<string>,
  ): Promise<Map<string, AttachmentDto[]>> {
    const out = new Map<string, AttachmentDto[]>();
    if (expenseIds.length === 0) return out;
    const rows = await tx
      .select({ a, by: schema.users.fullName })
      .from(a)
      .leftJoin(schema.users, eq(schema.users.id, a.createdBy))
      .where(and(inArray(a.expenseId, expenseIds), isNull(a.removedAt)))
      .orderBy(asc(a.createdAt));
    for (const r of rows) {
      const list = out.get(r.a.expenseId!) ?? [];
      list.push(dto(r.a, r.by, drafts.has(r.a.expenseId!)));
      out.set(r.a.expenseId!, list);
    }
    return out;
  }

  /** One live attachment of this owner, or NOT_FOUND (also for another owner's or tenant's id). */
  async find(tx: Tx, owner: AttachmentOwner, attachmentId: string): Promise<AttachmentRow> {
    const [row] = await tx
      .select()
      .from(a)
      .where(and(eq(a.id, attachmentId), ownerFilter(owner), isNull(a.removedAt)));
    if (!row) throw AppError.notFound('file');
    return row;
  }

  /**
   * Checks and stores a file for `owner` inside the caller's transaction. The same file sent twice to the same
   * record returns the attachment already there.
   */
  async store(
    tx: Tx,
    auth: AuthContext,
    owner: AttachmentOwner,
    requestedName: string,
    file: Buffer,
    meta: RequestMeta,
  ): Promise<{ row: AttachmentRow; created: boolean }> {
    const type = inspect(file);
    const sha256 = createHash('sha256').update(file).digest();
    const [existing] = await tx
      .select()
      .from(a)
      .where(and(ownerFilter(owner), eq(a.sha256, sha256), isNull(a.removedAt)));
    if (existing) return { row: existing, created: false };

    const id = randomUUID();
    const scope = owner.kind === 'expense' ? `p/${owner.propertyId}` : 'shared';
    const objectKey = `t/${auth.tenantId}/${scope}/${id}`;
    // Identity scans get a neutral name: whatever the file was called may hold the guest's name or number.
    const fileName =
      owner.kind === 'guest' ? displayName('identity-scan', type) : displayName(requestedName, type);
    const stored = await this.files.put(objectKey, file, id);
    try {
      const [row] = await tx
        .insert(a)
        .values({
          id,
          tenantId: auth.tenantId,
          propertyId: owner.kind === 'expense' ? owner.propertyId : null,
          ownerType: owner.kind,
          expenseId: owner.kind === 'expense' ? owner.expenseId : null,
          guestId: owner.kind === 'guest' ? owner.guestId : null,
          objectKey,
          fileName,
          contentType: type,
          sizeBytes: file.length,
          ...stored,
          createdBy: auth.userId,
        })
        .returning();
      await this.audit.record(
        tx,
        {
          tenantId: auth.tenantId,
          propertyId: owner.kind === 'expense' ? owner.propertyId : null,
          actor: { type: 'user', userId: auth.userId },
          action: owner.kind === 'expense' ? 'expense.attachment_added' : 'guest.scan_added',
          entityType: owner.kind,
          entityId: owner.kind === 'expense' ? owner.expenseId : owner.guestId,
          changes: {
            attachmentId: id,
            contentType: type,
            sizeBytes: file.length,
            ...(owner.kind === 'expense' ? { fileName } : {}),
          },
        },
        meta,
      );
      return { row: row!, created: true };
    } catch (err) {
      // The row did not commit, so the object must not stay behind.
      await this.files.delete(objectKey).catch(() => undefined);
      throw err;
    }
  }

  /**
   * Marks an attachment removed (the row stays, with who and when) and deletes the stored file. Callers decide
   * whether removal is allowed: never for records already posted.
   */
  async remove(tx: Tx, auth: AuthContext, row: AttachmentRow, meta: RequestMeta): Promise<void> {
    await tx.update(a).set({ removedAt: new Date(), removedBy: auth.userId }).where(eq(a.id, row.id));
    await this.audit.record(
      tx,
      {
        tenantId: auth.tenantId,
        propertyId: row.propertyId,
        actor: { type: 'user', userId: auth.userId },
        action: row.ownerType === 'expense' ? 'expense.attachment_removed' : 'guest.scan_removed',
        entityType: row.ownerType,
        entityId: row.expenseId ?? row.guestId,
        changes: { attachmentId: row.id, contentType: row.contentType },
      },
      meta,
    );
    // After the row is marked: a failed delete leaves an orphan object, never a row pointing at nothing.
    await this.files.deleteQuietly(row.objectKey, row.id);
  }

  /** A short-lived download link for the caller only. Access to the owner is checked by the caller first. */
  link(auth: AuthContext, row: AttachmentRow): FileLinkDto {
    return this.files.link('a', row.id, auth);
  }

  /** Serves a verified link (FileStore.verify). Identity scans are audited on every download. */
  async download(auth: AuthContext, attachmentId: string, meta: RequestMeta): Promise<DownloadFile> {
    return this.db.tenant(auth.tenantId, async (tx) => {
      const [row] = await tx
        .select()
        .from(a)
        .where(and(eq(a.id, attachmentId), isNull(a.removedAt)));
      if (!row) throw AppError.notFound('file');
      // Permissions can be taken away within the link's life: check the basic one again.
      if (!stillAllowed(auth, row)) throw AppError.notFound('file');
      const body = await this.files.read(row.objectKey, row, row.id);
      if (!body) throw AppError.notFound('file');
      if (row.ownerType === 'guest') {
        await this.audit.record(
          tx,
          {
            tenantId: auth.tenantId,
            actor: { type: 'user', userId: auth.userId },
            action: 'guest.scan_downloaded',
            entityType: 'guest',
            entityId: row.guestId,
            changes: { attachmentId: row.id },
          },
          meta,
        );
      }
      return { body, contentType: row.contentType, fileName: row.fileName };
    });
  }
}

function tooLarge(): AppError {
  return new AppError('FILE_TOO_LARGE', `The file is larger than ${ATTACHMENT_MAX_BYTES / 1024 / 1024} MB.`);
}

/** The file's real type, or a refusal the user can act on. */
function inspect(file: Buffer): AttachmentType {
  if (file.length === 0) throw new AppError('FILE_REJECTED', 'The file is empty.');
  const type = detectType(file);
  if (!type) throw new AppError('FILE_REJECTED', 'Only PDF, JPEG and PNG files can be attached.');
  if (type === 'application/pdf' && pdfHasActiveContent(file)) {
    throw new AppError(
      'FILE_REJECTED',
      'This PDF contains scripts or embedded files and cannot be attached. Print it to a new PDF or scan it.',
    );
  }
  return type;
}

function ownerFilter(owner: AttachmentOwner) {
  return owner.kind === 'expense'
    ? and(eq(a.ownerType, 'expense'), eq(a.expenseId, owner.expenseId), eq(a.propertyId, owner.propertyId))
    : and(eq(a.ownerType, 'guest'), eq(a.guestId, owner.guestId));
}

function holdsAnywhere(auth: AuthContext, permission: Permission): boolean {
  for (const perms of auth.permissionsByProperty.values()) if (perms.has(permission)) return true;
  return false;
}

function stillAllowed(auth: AuthContext, row: AttachmentRow): boolean {
  if (row.ownerType === 'guest') return holdsAnywhere(auth, 'guest.identity.read');
  return !!auth.permissionsByProperty.get(row.propertyId!)?.has('expense.write');
}

function dto(row: AttachmentRow, createdByName: string | null, removable: boolean): AttachmentDto {
  return {
    id: row.id,
    fileName: row.fileName,
    contentType: row.contentType,
    sizeBytes: row.sizeBytes,
    createdAt: row.createdAt.toISOString(),
    createdByName,
    removable,
  };
}
