import { createHmac, hkdfSync } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { normalizeDocumentNumber } from '@innpilot/contracts';
import { decryptSecret, encryptSecret } from '../auth/crypto';
import { APP_CONFIG, type AppConfig } from '../config';

/**
 * Encryption for guest identity data. One configured key; separate sub-keys for encryption and for the
 * lookup HMAC, derived with HKDF so a leaked hash key cannot decrypt anything.
 */
@Injectable()
export class PiiService {
  private readonly encKey: Buffer;
  private readonly hmacKey: Buffer;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    const root = Buffer.from(config.PII_ENCRYPTION_KEY, 'base64url');
    this.encKey = Buffer.from(hkdfSync('sha256', root, Buffer.alloc(0), 'innpilot/pii/encrypt/v1', 32));
    this.hmacKey = Buffer.from(hkdfSync('sha256', root, Buffer.alloc(0), 'innpilot/pii/lookup/v1', 32));
  }

  encrypt(plain: string): string {
    return encryptSecret(plain, this.encKey);
  }

  decrypt(sealed: string): string {
    return decryptSecret(sealed, this.encKey);
  }

  /** Same document number (in any spacing or case) → same 32-byte key, scoped by document type. */
  documentLookupKey(documentType: string, number: string): Buffer {
    return createHmac('sha256', this.hmacKey)
      .update(`${documentType}:${normalizeDocumentNumber(number)}`)
      .digest();
  }
}
