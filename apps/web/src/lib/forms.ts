import type { FieldValues, Path, UseFormSetError } from 'react-hook-form';
import { ApiError } from './api';

/**
 * Copies server-side field errors onto the form. Returns true if every issue landed on a field,
 * so the caller only needs a general alert for the rest.
 */
export function applyServerErrors<T extends FieldValues>(
  error: unknown,
  setError: UseFormSetError<T>,
  fields: readonly string[],
): boolean {
  if (!(error instanceof ApiError) || error.details.length === 0) return false;
  let allMapped = true;
  for (const issue of error.details) {
    const field = issue.path.split('.')[0] ?? '';
    if (fields.includes(field)) setError(field as Path<T>, { type: 'server', message: issue.message });
    else allMapped = false;
  }
  return allMapped;
}
