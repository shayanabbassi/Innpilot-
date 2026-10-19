/** Stable machine-readable error codes. Clients branch on these, never on message text. */
export const ERROR_CODES = [
  'VALIDATION_ERROR',
  'UNAUTHENTICATED',
  'INVALID_CREDENTIALS',
  'ACCOUNT_LOCKED',
  'MFA_REQUIRED',
  'MFA_ENROLLMENT_REQUIRED',
  'INVALID_MFA_CODE',
  'FORBIDDEN',
  'CSRF_FAILED',
  'NOT_FOUND',
  'CONFLICT',
  'IDEMPOTENCY_KEY_REUSED',
  'IDEMPOTENCY_IN_PROGRESS',
  'RATE_LIMITED',
  'INTERNAL_ERROR',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface FieldIssue {
  /** Dot path of the offending field, e.g. "checkInTime" or "assignments.0.role". */
  path: string;
  message: string;
}

export interface ErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    details?: FieldIssue[];
  };
  meta: { requestId: string };
}

export interface SuccessBody<T> {
  data: T;
  meta: { requestId: string; nextCursor?: string | null };
}
