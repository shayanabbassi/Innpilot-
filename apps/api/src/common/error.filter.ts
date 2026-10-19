import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import type { ErrorBody } from '@innpilot/contracts';
import type { Response } from 'express';
import { AppError } from './app-error';
import type { AppRequest } from './request';

/**
 * Converts every error into the standard envelope. Unexpected errors are logged with the request id
 * and returned as a generic message: stack traces and database messages never reach the client.
 */
@Catch()
export class ErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger('ErrorFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const req = http.getRequest<AppRequest>();
    const res = http.getResponse<Response>();
    const error = this.toAppError(exception, req);

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
    this.logger.error({ err: exception, requestId: req.id }, 'Unhandled error');
    return new AppError(
      'INTERNAL_ERROR',
      'Something went wrong. Try again, and quote the request ID if it persists.',
    );
  }
}
