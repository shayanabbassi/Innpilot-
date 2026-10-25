import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException } from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import type { ErrorBody } from '@innpilot/contracts';
import type { Response } from 'express';
import { ErrorReporter } from '../monitoring/error-reporter.service';
import { MetricsService } from '../monitoring/metrics.service';
import { AppError } from './app-error';
import type { AppRequest } from './request';

/**
 * Converts every error into the standard envelope. Unexpected errors are reported (scrubbed, with the request id)
 * and returned as a generic message: stack traces and database messages never reach the client. Every error is
 * counted by its code, which is what the failed sign-in spike and error-rate alerts watch (6.6).
 */
@Catch()
export class ErrorFilter implements ExceptionFilter {
  constructor(
    private readonly reporter: ErrorReporter,
    private readonly metrics: MetricsService,
  ) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const req = http.getRequest<AppRequest>();
    const res = http.getResponse<Response>();
    const error = this.toAppError(exception, req);
    this.metrics.errors.inc({ code: error.code });

    const body: ErrorBody = {
      error: {
        code: error.code,
        message: error.message,
        ...(error.details ? { details: error.details } : {}),
      },
      meta: { requestId: req.id },
    };
    res.status(error.status).json(body);
  }

  private toAppError(exception: unknown, req: AppRequest): AppError {
    if (exception instanceof AppError) return exception;
    if (exception instanceof ThrottlerException) {
      return new AppError('RATE_LIMITED', 'Too many requests. Wait a moment and try again.');
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      if (status === 404) return new AppError('NOT_FOUND', 'The requested resource was not found.');
      if (status === 413) return AppError.validation('The request is too large.');
      if (status === 400)
        return AppError.validation('The request could not be read. Check that it is valid JSON.');
      if (status < 500) return AppError.validation(exception.message);
    }
    this.reporter.report(exception, {
      requestId: req.id,
      method: req.method,
      route: routeTemplate(req),
      tenantId: req.auth?.tenantId,
      userId: req.auth?.userId,
    });
    return new AppError(
      'INTERNAL_ERROR',
      'Something went wrong. Try again, and quote the request ID if it persists.',
    );
  }
}

/** The matched route's template (e.g. /api/v1/guests/:id), never the actual path with its ids. */
export function routeTemplate(req: { route?: { path?: unknown } }): string {
  return typeof req.route?.path === 'string' ? req.route.path : 'unmatched';
}
