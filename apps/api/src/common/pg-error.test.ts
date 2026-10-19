import { describe, expect, it } from 'vitest';
import { pgErrorCode } from './pg-error';

describe('pgErrorCode', () => {
  it('reads the code from a driver error or from a wrapper’s cause', () => {
    const driver = Object.assign(new Error('duplicate key'), { code: '23505' });
    expect(pgErrorCode(driver)).toBe('23505');
    expect(pgErrorCode(new Error('Failed query', { cause: driver }))).toBe('23505');
  });

  it('ignores non-SQLSTATE codes and non-errors', () => {
    expect(pgErrorCode(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }))).toBeUndefined();
    expect(pgErrorCode(null)).toBeUndefined();
    expect(pgErrorCode('23505')).toBeUndefined();
  });
});
