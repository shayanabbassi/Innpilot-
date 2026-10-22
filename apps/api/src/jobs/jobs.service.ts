import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { schema, type Tx } from '@innpilot/db';
import { and, eq, sql } from 'drizzle-orm';
import { AppError } from '../common/app-error';
import { APP_CONFIG, type AppConfig } from '../config';
import { Db } from '../db/db.module';

export type JobKind = (typeof schema.jobs.$inferSelect)['kind'];

/** A claimed job, as the worker hands it to its handler. */
export interface ClaimedJob {
  id: string;
  tenantId: string;
  kind: JobKind;
  payload: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
  createdBy: string;
}

type Handler = (job: ClaimedJob) => Promise<void>;

interface Periodic {
  name: string;
  everyMs: number;
  run: () => Promise<unknown>;
  lastRun: number;
}

/** A running job's lease. A job still running after this is taken to have stopped and is tried again. */
const LEASE_SECONDS = 300;
/** Jobs one worker tick takes at most, so a burst cannot starve the periodic tasks. */
const PER_TICK = 10;

/**
 * Background jobs (slice 6.3, P6-4): a Postgres-backed queue, no Redis.
 *
 * - A job is created inside a request, with the tenant from the verified session; the worker claims it through
 *   one narrow SECURITY DEFINER function and runs the handler, which works inside that tenant's row-level security.
 * - Several API instances can share the queue: claiming uses SKIP LOCKED and a lease, so a job is worked on by one
 *   instance at a time and picked up again if its instance stops.
 * - A handler failing with an AppError (a refusal the person can act on) fails the job at once with that message.
 *   Anything else, including storage being down, is retried with growing waits, up to the job's attempts.
 * - Handlers must be safe to run twice: a retry may follow a run that did its work but stopped before recording it.
 */
@Injectable()
export class JobsService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('Jobs');
  private readonly handlers = new Map<JobKind, Handler>();
  private readonly periodic: Periodic[] = [];
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly db: Db,
  ) {}

  register(kind: JobKind, handler: Handler): void {
    this.handlers.set(kind, handler);
  }

  /** A task the worker runs every `everyMs`, e.g. deleting expired files. */
  every(name: string, everyMs: number, run: () => Promise<unknown>): void {
    this.periodic.push({ name, everyMs, run, lastRun: 0 });
  }

  /** Adds a job inside the caller's tenant transaction, so it exists only if the request's work commits. */
  async enqueue(
    tx: Tx,
    job: { tenantId: string; kind: JobKind; payload: Record<string, unknown>; createdBy: string },
  ): Promise<string> {
    const [row] = await tx
      .insert(schema.jobs)
      .values({ tenantId: job.tenantId, kind: job.kind, payload: job.payload, createdBy: job.createdBy })
      .returning({ id: schema.jobs.id });
    return row!.id;
  }

  onApplicationBootstrap(): void {
    if (this.config.JOBS_POLL_SECONDS === 0) return;
    this.timer = setInterval(() => void this.tick(), this.config.JOBS_POLL_SECONDS * 1000);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One worker pass: due jobs, then any periodic task whose time has come. Never overlaps itself. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.runDue(PER_TICK);
      for (const task of this.periodic) {
        if (Date.now() - task.lastRun < task.everyMs) continue;
        task.lastRun = Date.now();
        await task
          .run()
          .catch((err: unknown) => this.logger.error({ err }, `Periodic task ${task.name} failed`));
      }
    } catch (err) {
      this.logger.error({ err }, 'Job worker pass failed');
    } finally {
      this.ticking = false;
    }
  }

  /** Claims and runs up to `limit` due jobs, one at a time. Returns how many ran. */
  async runDue(limit = PER_TICK): Promise<number> {
    let ran = 0;
    while (ran < limit) {
      const job = await this.claim();
      if (!job) break;
      ran++;
      await this.run(job);
    }
    return ran;
  }

  /** Runs every periodic task now, whatever its schedule (tests and operators). */
  async runPeriodic(): Promise<void> {
    for (const task of this.periodic) {
      task.lastRun = Date.now();
      await task.run();
    }
  }

  private async claim(): Promise<ClaimedJob | null> {
    const res = await this.db.unscoped.execute<{
      id: string;
      tenant_id: string;
      kind: JobKind;
      payload: Record<string, unknown>;
      attempts: number;
      max_attempts: number;
      created_by: string;
    }>(sql`select * from job_claim(${LEASE_SECONDS})`);
    const r = res.rows[0];
    if (!r) return null;
    return {
      id: r.id,
      tenantId: r.tenant_id,
      kind: r.kind,
      payload: r.payload,
      attempts: r.attempts,
      maxAttempts: r.max_attempts,
      createdBy: r.created_by,
    };
  }

  private async run(job: ClaimedJob): Promise<void> {
    const handler = this.handlers.get(job.kind);
    try {
      if (!handler) throw new Error(`no handler for job kind ${job.kind}`);
      await handler(job);
      await this.finish(job, { status: 'succeeded', lastError: null });
    } catch (err) {
      const refusal = err instanceof AppError && err.code !== 'STORAGE_UNAVAILABLE';
      if (refusal) {
        await this.finish(job, { status: 'failed', lastError: err.message.slice(0, 500) });
        return;
      }
      this.logger.error({ err, jobId: job.id, attempt: job.attempts }, 'Job failed');
      if (job.attempts >= job.maxAttempts) {
        await this.finish(job, {
          status: 'failed',
          lastError: 'This could not be completed. Try again later, or ask for help if it keeps failing.',
        });
      } else {
        // 30 s, 60 s, 120 s, …
        const waitSeconds = 30 * 2 ** (job.attempts - 1);
        await this.db.tenant(job.tenantId, (tx) =>
          tx
            .update(schema.jobs)
            .set({
              status: 'queued',
              lockedUntil: null,
              runAfter: sql`now() + make_interval(secs => ${waitSeconds})`,
              lastError: 'Waiting to try again.',
            })
            .where(and(eq(schema.jobs.id, job.id), eq(schema.jobs.status, 'running'))),
        );
      }
    }
  }

  private async finish(
    job: ClaimedJob,
    outcome: { status: 'succeeded' | 'failed'; lastError: string | null },
  ): Promise<void> {
    await this.db.tenant(job.tenantId, (tx) =>
      tx
        .update(schema.jobs)
        .set({ ...outcome, finishedAt: sql`now()`, lockedUntil: null })
        .where(and(eq(schema.jobs.id, job.id), eq(schema.jobs.status, 'running'))),
    );
  }
}
