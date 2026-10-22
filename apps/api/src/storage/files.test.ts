import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  contentDisposition,
  detectType,
  displayName,
  openFile,
  pdfHasActiveContent,
  sealFile,
  signLink,
  verifyLink,
} from './files';

const pdf = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n%%EOF');
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);

describe('file checks', () => {
  it('recognises PDF, JPEG and PNG from their content', () => {
    expect(detectType(pdf)).toBe('application/pdf');
    expect(detectType(jpeg)).toBe('image/jpeg');
    expect(detectType(png)).toBe('image/png');
  });

  it('refuses anything else, whatever it is called', () => {
    expect(detectType(Buffer.from('MZ\x90\x00 this is a windows program'))).toBeNull();
    expect(detectType(Buffer.from('<svg onload="alert(1)"></svg>'))).toBeNull();
    expect(detectType(Buffer.from('<html><script></script>'))).toBeNull();
    expect(detectType(Buffer.from('PK\x03\x04 a zip'))).toBeNull();
    expect(detectType(Buffer.alloc(0))).toBeNull();
  });

  it('flags PDFs that run code or carry files', () => {
    expect(pdfHasActiveContent(pdf)).toBe(false);
    expect(pdfHasActiveContent(Buffer.from('%PDF-1.4 << /OpenAction << /S /JavaScript /JS (x) >> >>'))).toBe(
      true,
    );
    expect(pdfHasActiveContent(Buffer.from('%PDF-1.7 << /Type /Action /S /Launch >>'))).toBe(true);
    expect(pdfHasActiveContent(Buffer.from('%PDF-1.7 << /Names << /EmbeddedFiles 3 0 R >> >>'))).toBe(true);
    // A word that merely starts the same way is not a match.
    expect(pdfHasActiveContent(Buffer.from('%PDF-1.7 << /JSON_like_name 1 >>'))).toBe(false);
  });

  it('makes the extension match the real type', () => {
    expect(displayName('receipt.pdf', 'application/pdf')).toBe('receipt.pdf');
    expect(displayName('photo.JPEG', 'image/jpeg')).toBe('photo.JPEG');
    expect(displayName('bill.exe', 'application/pdf')).toBe('bill.exe.pdf');
    expect(displayName('scan', 'image/png')).toBe('scan.png');
  });

  it('builds a header-safe Content-Disposition', () => {
    expect(contentDisposition('bill "march".pdf', 'inline')).toBe(
      `inline; filename="bill _march_.pdf"; filename*=UTF-8''bill%20%22march%22.pdf`,
    );
    expect(contentDisposition('رسید.pdf', 'attachment')).toContain('filename="____.pdf"');
  });
});

describe('file encryption', () => {
  const key = randomBytes(32);

  it('round-trips and does not store the plain bytes', () => {
    const id = randomUUID();
    const sealed = sealFile(pdf, key, id);
    expect(sealed.body.includes(Buffer.from('%PDF'))).toBe(false);
    expect(openFile(sealed, key, id).equals(pdf)).toBe(true);
  });

  it('will not open under another attachment id or after tampering', () => {
    const id = randomUUID();
    const sealed = sealFile(pdf, key, id);
    expect(() => openFile(sealed, key, randomUUID())).toThrow();
    const tampered = { ...sealed, body: Buffer.from(sealed.body) };
    tampered.body[0]! ^= 1;
    expect(() => openFile(tampered, key, id)).toThrow();
  });
});

describe('download links', () => {
  const key = randomBytes(32);
  const claims = {
    attachmentId: randomUUID(),
    tenantId: randomUUID(),
    userId: randomUUID(),
    expires: 1_900_000_000,
  };

  it('verifies its own signature and returns the claims', () => {
    expect(verifyLink(signLink(claims, key), key)).toEqual(claims);
  });

  it('rejects a changed claim, another key and junk', () => {
    const token = signLink(claims, key);
    const [payload, mac] = token.split('.');
    const forged = Buffer.from(
      Buffer.from(payload!, 'base64url').toString().replace(claims.userId, randomUUID()),
    ).toString('base64url');
    expect(verifyLink(`${forged}.${mac}`, key)).toBeNull();
    expect(verifyLink(token, randomBytes(32))).toBeNull();
    expect(verifyLink('nonsense', key)).toBeNull();
    expect(verifyLink(`${token}.extra`, key)).toBeNull();
  });
});
