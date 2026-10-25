/**
 * Removes personal data and secrets from text that leaves the application in error reports (slice 6.6): guest
 * identity numbers, phone numbers and other long digit runs, email addresses, and anything token-like. Applied to
 * messages and stack traces; request bodies, query strings and headers are never included in a report at all.
 */
const RULES: [RegExp, string][] = [
  // Connection strings and URLs with credentials (first: the other rules would split them).
  [/\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@\S+/gi, '[url-with-credentials]'],
  // Pakistani CNIC in any spacing: 35202-1234567-1, 3520212345671.
  [/\b\d{5}[-\s]?\d{7}[-\s]?\d\b/g, '[id-number]'],
  // Passport-like numbers: one or two letters then 6 to 9 digits.
  [/\b[A-Z]{1,2}\d{6,9}\b/g, '[id-number]'],
  [/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]'],
  // Phone numbers and any other long number (card-like runs included), with spaces, dashes or a leading +.
  [/\+?\d(?:[\s-]?\d){8,}/g, '[number]'],
  // Signed tokens (download links: <claims>.<signature>), then any long opaque token (sessions, keys): 32+
  // characters of base64url or hex.
  [/\b[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g, '[secret]'],
  [/\b[A-Za-z0-9_-]{32,}\b/g, '[secret]'],
];

export function scrub(text: string): string {
  let out = text;
  for (const [pattern, replacement] of RULES) out = out.replace(pattern, replacement);
  return out;
}

/**
 * The query layer puts a failed statement's parameters in its message ("params: …"): names, phone numbers, amounts.
 * No pattern can recognise all personal data, so the parameter list is dropped entirely.
 */
function dropParams(text: string): string {
  return text.replace(/\nparams: .*/g, '\nparams: [removed]');
}

/** The parts of an error worth reporting, scrubbed: name, message, a short stack, and a database error code. */
export function scrubError(err: unknown): { name: string; message: string; stack?: string; code?: string } {
  if (!(err instanceof Error)) {
    return { name: 'NonError', message: scrub(dropParams(String(err))).slice(0, 500) };
  }
  const code = (err as { code?: unknown }).code;
  return {
    name: err.name,
    message: scrub(dropParams(err.message)).slice(0, 500),
    // Database errors carry "detail" and "where" with row values: deliberately not copied.
    ...(err.stack ? { stack: scrub(dropParams(err.stack).split('\n').slice(0, 12).join('\n')) } : {}),
    ...(typeof code === 'string' && /^[0-9A-Z_]{1,20}$/.test(code) ? { code } : {}),
  };
}
