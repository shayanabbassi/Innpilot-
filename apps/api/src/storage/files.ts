import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { AttachmentType } from '@innpilot/contracts';

/**
 * File checks, encryption and download links for attachments (slice 6.2). Pure functions; the services hold the
 * keys.
 */

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** The type from the first bytes of the file. The name and the declared type are never trusted. */
export function detectType(file: Buffer): AttachmentType | null {
  if (file.length >= 5 && file.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (file.length >= 3 && file[0] === 0xff && file[1] === 0xd8 && file[2] === 0xff) return 'image/jpeg';
  if (file.length >= 8 && file.subarray(0, 8).equals(PNG)) return 'image/png';
  return null;
}

/**
 * PDF features that run code or carry other files. A receipt or an identity scan never needs them, so a PDF that
 * names one is refused. This reads the file as written; content inside compressed streams is not unpacked, so it
 * is a first filter, not a malware scanner.
 */
const ACTIVE_PDF = /\/(JavaScript|JS|Launch|EmbeddedFiles?|RichMedia|XFA|SubmitForm|ImportData)\b/;

export function pdfHasActiveContent(file: Buffer): boolean {
  return ACTIVE_PDF.test(file.toString('latin1'));
}

const EXTENSIONS: Record<AttachmentType, string[]> = {
  'application/pdf': ['pdf'],
  'image/jpeg': ['jpg', 'jpeg'],
  'image/png': ['png'],
};

/** The display name, ending in an extension that matches what the file really is ("bill.exe" → "bill.exe.pdf"). */
export function displayName(name: string, type: AttachmentType): string {
  const ext = name.split('.').pop()?.toLowerCase();
  const allowed = EXTENSIONS[type];
  return name.includes('.') && ext && allowed.includes(ext) ? name : `${name}.${allowed[0]}`;
}

/** `Content-Disposition` for a download: ASCII fallback plus the exact name, never a raw quote or newline. */
export function contentDisposition(name: string, disposition: 'inline' | 'attachment'): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

export interface Sealed {
  body: Buffer;
  iv: Buffer;
  tag: Buffer;
}

/**
 * AES-256-GCM. The attachment id is the associated data, so a stored file only opens as the attachment it was
 * written for (swapping two objects in the bucket is detected).
 */
export function sealFile(plain: Buffer, key: Buffer, attachmentId: string): Sealed {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(attachmentId, 'utf8'));
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return { body, iv, tag: cipher.getAuthTag() };
}

export function openFile(sealed: Sealed, key: Buffer, attachmentId: string): Buffer {
  const decipher = createDecipheriv('aes-256-gcm', key, sealed.iv);
  decipher.setAAD(Buffer.from(attachmentId, 'utf8'));
  decipher.setAuthTag(sealed.tag);
  return Buffer.concat([decipher.update(sealed.body), decipher.final()]);
}

/** What a link opens: an attachment (`a`) or a prepared export (`e`). */
export type LinkKind = 'a' | 'e';

export interface LinkClaims {
  kind: LinkKind;
  id: string;
  tenantId: string;
  userId: string;
  /** Unix seconds. */
  expires: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** `<claims>.<hmac>`, both base64url. Bound to one file, tenant and user, and to a time. */
export function signLink(claims: LinkClaims, key: Buffer): string {
  const payload = Buffer.from(
    [claims.kind, claims.id, claims.tenantId, claims.userId, String(claims.expires)].join('.'),
  ).toString('base64url');
  const mac = createHmac('sha256', key).update(payload).digest('base64url');
  return `${payload}.${mac}`;
}

/** The claims if the signature is right (expiry is the caller's check), otherwise null. */
export function verifyLink(token: string, key: Buffer): LinkClaims | null {
  const [payload, mac, extra] = token.split('.');
  if (!payload || !mac || extra !== undefined) return null;
  const expected = createHmac('sha256', key).update(payload).digest();
  const given = Buffer.from(mac, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  const [kind, id, tenantId, userId, expires, extraPart] = Buffer.from(payload, 'base64url')
    .toString()
    .split('.');
  if ((kind !== 'a' && kind !== 'e') || !id || !tenantId || !userId || !expires || extraPart !== undefined)
    return null;
  if (!UUID.test(id) || !UUID.test(tenantId) || !UUID.test(userId) || !/^\d+$/.test(expires)) return null;
  return { kind, id, tenantId, userId, expires: Number(expires) };
}
