import { createHash, hkdfSync } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { FILE_LINK_SECONDS, type FileLinkDto } from '@innpilot/contracts';
import { AppError } from '../common/app-error';
import type { AuthContext } from '../common/request';
import { APP_CONFIG, type AppConfig } from '../config';
import { openFile, sealFile, signLink, verifyLink, type LinkKind } from './files';
import { S3Client, StorageError } from './s3';

/** What the database keeps to open a stored file again. */
export interface StoredFile {
  sha256: Buffer;
  encIv: Buffer;
  encTag: Buffer;
}

/**
 * The private bucket, shared by attachments (6.2) and prepared exports (6.3). Only the API talks to it. Files are
 * encrypted here (AES-256-GCM, a key derived from PII_ENCRYPTION_KEY, bound to the file's id) before they leave, so
 * the bucket alone reveals nothing. Download links name one file, tenant and user and expire after five minutes.
 */
@Injectable()
export class FileStore {
  private readonly logger = new Logger('FileStore');
  private readonly s3: S3Client;
  private readonly fileKey: Buffer;
  private readonly linkKey: Buffer;
  private bucketReady = false;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    this.s3 = new S3Client({
      endpoint: config.STORAGE_ENDPOINT,
      region: config.STORAGE_REGION,
      bucket: config.STORAGE_BUCKET,
      accessKeyId: config.STORAGE_ACCESS_KEY_ID,
      secretAccessKey: config.STORAGE_SECRET_ACCESS_KEY,
    });
    const root = Buffer.from(config.PII_ENCRYPTION_KEY, 'base64url');
    this.fileKey = Buffer.from(hkdfSync('sha256', root, Buffer.alloc(0), 'innpilot/files/encrypt/v1', 32));
    this.linkKey = Buffer.from(hkdfSync('sha256', root, Buffer.alloc(0), 'innpilot/files/link/v1', 32));
  }

  /**
   * Whether the bucket answers (readiness, 6.6). Outside production a bucket that does not exist yet counts as
   * reachable: it is created on first use.
   */
  async reachable(): Promise<boolean> {
    try {
      return (await this.s3.bucketExists()) || this.config.NODE_ENV !== 'production';
    } catch {
      return false;
    }
  }

  /** Encrypts and stores `plain` at `key`, replacing anything there. Storage failures become STORAGE_UNAVAILABLE. */
  async put(key: string, plain: Buffer, fileId: string): Promise<StoredFile> {
    const sealed = sealFile(plain, this.fileKey, fileId);
    await this.storage('PUT', async () => {
      // Created on first use outside production; in production the bucket must already exist.
      if (!this.bucketReady && this.config.NODE_ENV !== 'production') {
        if (!(await this.s3.bucketExists())) await this.s3.createBucket();
        this.bucketReady = true;
      }
      await this.s3.put(key, sealed.body, 'application/octet-stream');
    });
    return { sha256: createHash('sha256').update(plain).digest(), encIv: sealed.iv, encTag: sealed.tag };
  }

  /** The plain file, checked against its checksum; null if the object is missing. */
  async read(key: string, stored: StoredFile, fileId: string): Promise<Buffer | null> {
    const body = await this.storage('GET', () => this.s3.get(key));
    if (!body) {
      this.logger.error({ fileId }, 'Stored file is missing');
      return null;
    }
    const plain = openFile({ body, iv: stored.encIv, tag: stored.encTag }, this.fileKey, fileId);
    if (!createHash('sha256').update(plain).digest().equals(stored.sha256)) {
      throw new Error(`stored file ${fileId} does not match its checksum`);
    }
    return plain;
  }

  /** Deletes an object; a missing one is fine. Throws StorageError so callers decide what a failure means. */
  delete(key: string): Promise<void> {
    return this.s3.delete(key);
  }

  /** Deletes an object, logging (not throwing) on failure: the caller has already recorded the removal. */
  async deleteQuietly(key: string, fileId: string): Promise<void> {
    await this.s3.delete(key).catch((err: unknown) => {
      this.logger.warn({ err, fileId }, 'Stored file not deleted; it will be cleaned up later');
    });
  }

  /** A short-lived download link for the caller only. Callers check access to the file first. */
  link(kind: LinkKind, fileId: string, auth: AuthContext): FileLinkDto {
    const expires = Math.floor(Date.now() / 1000) + FILE_LINK_SECONDS;
    const token = signLink(
      { kind, id: fileId, tenantId: auth.tenantId, userId: auth.userId, expires },
      this.linkKey,
    );
    return { url: `/api/v1/files/${token}`, expiresAt: new Date(expires * 1000).toISOString() };
  }

  /**
   * Checks a link for the signed-in caller. Every failure except expiry looks the same (not found), so a link
   * reveals nothing to anyone other than the person it was issued to.
   */
  verify(token: string, auth: AuthContext): { kind: LinkKind; id: string } {
    const claims = verifyLink(token, this.linkKey);
    if (!claims || claims.tenantId !== auth.tenantId || claims.userId !== auth.userId) {
      throw AppError.notFound('file');
    }
    if (claims.expires < Date.now() / 1000) {
      throw new AppError(
        'LINK_EXPIRED',
        'This link has expired. Open the file again from where you found it.',
      );
    }
    return { kind: claims.kind, id: claims.id };
  }

  async storage<T>(op: string, call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (err) {
      if (!(err instanceof StorageError)) throw err;
      this.logger.error({ err: { message: err.message, status: err.status } }, `Storage ${op} failed`);
      throw new AppError(
        'STORAGE_UNAVAILABLE',
        'File storage is not available right now. Try again shortly.',
      );
    }
  }
}
