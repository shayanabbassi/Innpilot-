import { type PipeTransform } from '@nestjs/common';
import { type ZodError, type ZodTypeAny, type z } from 'zod';
import { AppError } from './app-error';

export function zodIssues(error: ZodError) {
  return error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
}

/** Validates and normalises a request part. Use as `@Body(new ZodPipe(schema))`. */
export class ZodPipe<S extends ZodTypeAny> implements PipeTransform<unknown, z.infer<S>> {
  constructor(private readonly schema: S) {}

  transform(value: unknown): z.infer<S> {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw AppError.validation('Review the highlighted fields.', zodIssues(result.error));
    }
    return result.data;
  }
}
