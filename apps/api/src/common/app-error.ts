import type { ErrorCode, FieldIssue } from '@innpilot/contracts';

const STATUS: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  UNAUTHENTICATED: 401,
  INVALID_CREDENTIALS: 401,
  ACCOUNT_LOCKED: 423,
  MFA_REQUIRED: 403,
  MFA_ENROLLMENT_REQUIRED: 403,
  INVALID_MFA_CODE: 400,
  FORBIDDEN: 403,
  CSRF_FAILED: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  IDEMPOTENCY_KEY_REUSED: 422,
  IDEMPOTENCY_IN_PROGRESS: 409,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
};

/** An error that is safe to show to the user. Anything else becomes a generic INTERNAL_ERROR. */
export class AppError extends Error {
  readonly status: number;

  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: FieldIssue[],
  ) {
    super(message);
    this.status = STATUS[code];
  }

  static notFound(what = 'record'): AppError {
    // Same response whether the record is missing or belongs to another tenant (non-disclosing policy).
    return new AppError('NOT_FOUND', `The ${what} was not found.`);
  }

  static forbidden(message = 'You do not have permission to do this.'): AppError {
    return new AppError('FORBIDDEN', message);
  }

  static validation(message: string, details?: FieldIssue[]): AppError {
    return new AppError('VALIDATION_ERROR', message, details);
  }
}
