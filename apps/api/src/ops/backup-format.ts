import {
  constants,
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  privateDecrypt,
  publicEncrypt,
  randomBytes,
} from 'node:crypto';

/**
 * The encrypted backup file (slice 6.5, P6-7).
 *
 *   INNPILOT-BACKUP 1\n
 *   <header JSON>\n
 *   <AES-256-GCM ciphertext of the pg_dump archive><16-byte tag>
 *
 * Envelope encryption: every backup has its own random data key, wrapped with the backup RSA public key
 * (RSA-OAEP, SHA-256). The job that makes backups holds only the public key, so neither it nor anyone who takes the
 * bucket can read them; restoring needs the private key, which the owner keeps offline. The header (manifest and
 * wrapped key) is authenticated as additional data: changing any of it makes decryption fail.
 */

const MAGIC = 'INNPILOT-BACKUP 1\n';

/** What the backup records about the database, taken in the same snapshot as the dump. */
export interface BackupManifest {
  database: string;
  createdAt: string;
  serverVersion: string;
  /** Applied migrations, in order. */
  migrations: string[];
  /** Row count of every table in the public schema. */
  rowCounts: Record<string, number>;
  dumpBytes: number;
  dumpSha256: string;
}

interface Header {
  manifest: BackupManifest;
  /** RSA-OAEP-wrapped data key, base64. */
  key: string;
  iv: string;
  /** SHA-256 of the public key used, so a restore can tell which key pair it needs. */
  keyId: string;
}

export interface BackupKeys {
  /** base64 DER (SPKI): goes to the backup job. */
  publicKey: string;
  /** base64 DER (PKCS#8): kept offline, used only to restore. */
  privateKey: string;
}

export function generateBackupKeys(): BackupKeys {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 4096 });
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
  };
}

export function keyId(publicKeyBase64: string): string {
  return createHash('sha256').update(Buffer.from(publicKeyBase64, 'base64')).digest('hex').slice(0, 16);
}

export function sealBackup(dump: Buffer, manifest: BackupManifest, publicKeyBase64: string): Buffer {
  const publicKey = createPublicKey({
    key: Buffer.from(publicKeyBase64, 'base64'),
    format: 'der',
    type: 'spki',
  });
  const dataKey = randomBytes(32);
  const iv = randomBytes(12);
  const header: Header = {
    manifest,
    key: publicEncrypt(
      { key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
      dataKey,
    ).toString('base64'),
    iv: iv.toString('base64'),
    keyId: keyId(publicKeyBase64),
  };
  const headerLine = Buffer.from(`${JSON.stringify(header)}\n`, 'utf8');
  const cipher = createCipheriv('aes-256-gcm', dataKey, iv);
  cipher.setAAD(Buffer.concat([Buffer.from(MAGIC), headerLine]));
  const body = Buffer.concat([cipher.update(dump), cipher.final()]);
  return Buffer.concat([Buffer.from(MAGIC), headerLine, body, cipher.getAuthTag()]);
}

/** The manifest, readable without the private key (for listing and checks); not yet authenticated. */
export function readManifest(file: Buffer): BackupManifest {
  return parse(file).header.manifest;
}

/** Decrypts and authenticates a backup; throws if the key is wrong or anything was changed. */
export function openBackup(
  file: Buffer,
  privateKeyBase64: string,
): { dump: Buffer; manifest: BackupManifest } {
  const { header, headerEnd } = parse(file);
  const privateKey = createPrivateKey({
    key: Buffer.from(privateKeyBase64, 'base64'),
    format: 'der',
    type: 'pkcs8',
  });
  const dataKey = privateDecrypt(
    { key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    Buffer.from(header.key, 'base64'),
  );
  const decipher = createDecipheriv('aes-256-gcm', dataKey, Buffer.from(header.iv, 'base64'));
  decipher.setAAD(file.subarray(0, headerEnd));
  decipher.setAuthTag(file.subarray(file.length - 16));
  const dump = Buffer.concat([decipher.update(file.subarray(headerEnd, file.length - 16)), decipher.final()]);
  if (createHash('sha256').update(dump).digest('hex') !== header.manifest.dumpSha256) {
    throw new Error('The backup does not match its recorded checksum.');
  }
  return { dump, manifest: header.manifest };
}

function parse(file: Buffer): { header: Header; headerEnd: number } {
  if (file.subarray(0, MAGIC.length).toString('utf8') !== MAGIC) {
    throw new Error('Not an InnPilot backup (unknown format).');
  }
  const newline = file.indexOf(0x0a, MAGIC.length);
  if (newline < 0 || file.length < newline + 1 + 16) throw new Error('The backup file is truncated.');
  const header = JSON.parse(file.subarray(MAGIC.length, newline).toString('utf8')) as Header;
  return { header, headerEnd: newline + 1 };
}
