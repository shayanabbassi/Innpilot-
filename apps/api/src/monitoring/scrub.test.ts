import { describe, expect, it } from 'vitest';
import { scrub, scrubError } from './scrub';

// Fictional values only.
describe('scrub', () => {
  it('removes identity numbers in any spacing', () => {
    for (const cnic of ['35202-1234567-1', '3520212345671', '35202 1234567 1']) {
      expect(scrub(`duplicate document ${cnic} for guest`)).toBe('duplicate document [id-number] for guest');
    }
    expect(scrub('passport XK9081726 expired')).toBe('passport [id-number] expired');
  });

  it('removes phone numbers, emails and long numbers', () => {
    expect(scrub('call +92 300 1234567 or 0300-1234567')).toBe('call [number] or [number]');
    expect(scrub('sent to ali.khan@example.pk')).toBe('sent to [email]');
    expect(scrub('card 4111111111111111 refused')).toBe('card [number] refused');
  });

  it('removes credentials in URLs and token-like strings', () => {
    expect(scrub('connect postgres://innpilot_app:s3cret@db.internal:5432/innpilot failed')).toBe(
      'connect [url-with-credentials] failed',
    );
    expect(
      scrub('link /api/v1/files/YS4xMjM0NTY3ODkwYWJjZGVmZ2hpams.Gju4-_bUjq_moRVPon4z7NukhJcya0JP6Y6'),
    ).toBe('link /api/v1/files/[secret]');
  });

  it('keeps ordinary messages readable', () => {
    const text =
      'Cannot read properties of undefined (reading "id") at FolioService.post (folio.service.ts:120:15)';
    expect(scrub(text)).toBe(text);
    expect(scrub('room 101, 2 nights, PKR 16000.00')).toBe('room 101, 2 nights, PKR 16000.00');
  });

  it('reports database errors without their row details', () => {
    const err = Object.assign(new Error('duplicate key value violates unique constraint "guests_pkey"'), {
      code: '23505',
      detail: 'Key (phone)=(03001234567) already exists.',
      where: 'SQL statement',
    });
    const out = scrubError(err);
    expect(out).toMatchObject({ name: 'Error', code: '23505' });
    expect(JSON.stringify(out)).not.toMatch(/03001234567|detail|where/);
  });

  it('drops the parameters a failed query carries in its message', () => {
    const err = new Error(
      'Failed query: insert into "guests" ("full_name", "phone") values ($1, $2)\nparams: Ayesha Siddiqui,03001234567',
    );
    const out = scrubError(err);
    expect(out.message).toBe(
      'Failed query: insert into "guests" ("full_name", "phone") values ($1, $2)\nparams: [removed]',
    );
    expect(JSON.stringify(out)).not.toMatch(/Ayesha|Siddiqui|03001234567/);
  });
});
