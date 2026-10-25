import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
  StreamableFile,
} from '@nestjs/common';
import type { SuccessBody } from '@innpilot/contracts';
import { map, type Observable } from 'rxjs';
import type { AppRequest } from './request';

/** Return from a controller to send a page of results with a continuation cursor. */
export class Page<T> {
  constructor(
    readonly items: T[],
    readonly nextCursor: string | null,
  ) {}
}

/** Wraps controller results as `{ data, meta: { requestId } }`; files (exports) are sent as they are. */
@Injectable()
export class EnvelopeInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<SuccessBody<unknown> | StreamableFile> {
    const req = context.switchToHttp().getRequest<AppRequest>();
    return next
      .handle()
      .pipe(
        map((result: unknown) =>
          result instanceof StreamableFile
            ? result
            : result instanceof Page
              ? { data: result.items, meta: { requestId: req.id, nextCursor: result.nextCursor } }
              : { data: result ?? null, meta: { requestId: req.id } },
        ),
      );
  }
}
