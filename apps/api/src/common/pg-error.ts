/** Postgres SQLSTATE codes the API reacts to. */
export const PG_UNIQUE_VIOLATION = '23505';
export const PG_FOREIGN_KEY_VIOLATION = '23503';

/**
 * The SQLSTATE of a database error. Drizzle wraps driver errors (the original is on `cause`),
 * so look at both levels.
 */
export function pgErrorCode(err: unknown): string | undefined {
  for (let e: unknown = err, depth = 0; e && typeof e === 'object' && depth < 3; depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
    e = (e as { cause?: unknown }).cause;
  }
  return undefined;
}

/** The HINT of a database error, used by ledger triggers to name the business rule that failed. */
export function pgErrorHint(err: unknown): string | undefined {
  for (let e: unknown = err, depth = 0; e && typeof e === 'object' && depth < 3; depth++) {
    const hint = (e as { hint?: unknown }).hint;
    if (typeof hint === 'string') return hint;
    e = (e as { cause?: unknown }).cause;
  }
  return undefined;
}
