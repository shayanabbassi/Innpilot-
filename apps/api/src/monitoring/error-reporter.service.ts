import { Inject, Injectable, Logger } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config';
import { scrubError } from './scrub';

/** Where an error happened: route template and ids only, never the request's query, body or headers. */
export interface ErrorContext {
  requestId?: string;
  method?: string;
  route?: string;
  tenantId?: string;
  userId?: string;
  jobId?: string;
  jobKind?: string;
}

/** Reports sent to the webhook per minute at most; beyond that only the log has them. */
const PER_MINUTE = 30;

/**
 * Error tracking (slice 6.6), provider-neutral: every unexpected error becomes one scrubbed report, logged as
 * structured JSON and, if ERROR_WEBHOOK_URL is set, posted there (an error-tracking service's ingest endpoint or a
 * team chat webhook). Reports carry no guest identity data, contact details or secrets (scrub.ts), and no request
 * content at all.
 */
@Injectable()
export class ErrorReporter {
  private readonly logger = new Logger('ErrorReporter');
  private window = { start: 0, sent: 0 };

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  report(err: unknown, context: ErrorContext = {}): void {
    const report = {
      event: 'error',
      time: new Date().toISOString(),
      service: 'innpilot-api',
      environment: this.config.NODE_ENV,
      error: scrubError(err),
      // Not "context": the logger uses that key for its own name.
      where: context,
    };
    this.logger.error(report, 'Unhandled error');
    const url = this.config.ERROR_WEBHOOK_URL;
    if (!url) return;
    const now = Date.now();
    if (now - this.window.start > 60_000) this.window = { start: now, sent: 0 };
    if (++this.window.sent > PER_MINUTE) return;
    void fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(report),
      signal: AbortSignal.timeout(5000),
    }).catch(() => this.logger.warn('Error report could not be delivered to ERROR_WEBHOOK_URL'));
  }
}
