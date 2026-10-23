import { monitorEventLoopDelay } from 'node:perf_hooks';
import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { readMigrations } from '@innpilot/db';
import { sql } from 'drizzle-orm';
import { Db } from '../db/db.module';
import { FileStore } from '../storage/file-store.service';

/** Request latency buckets in seconds; the latency target is 0.5 s at p95 (QA §5). */
const BUCKETS = [0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

/** Every label value is a route template, a method, a status or an error code: never a path, id or user data. */
type Labels = Record<string, string>;

function key(labels: Labels): string {
  return Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}="${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`)
    .join(',');
}

class Counter {
  private readonly values = new Map<string, number>();
  constructor(
    readonly name: string,
    readonly help: string,
  ) {}
  inc(labels: Labels, by = 1): void {
    const k = key(labels);
    this.values.set(k, (this.values.get(k) ?? 0) + by);
  }
  render(): string[] {
    return [
      `# HELP ${this.name} ${this.help}`,
      `# TYPE ${this.name} counter`,
      ...[...this.values].map(([k, v]) => `${this.name}{${k}} ${v}`),
    ];
  }
}

class Histogram {
  private readonly series = new Map<string, { buckets: number[]; sum: number; count: number }>();
  constructor(
    readonly name: string,
    readonly help: string,
  ) {}
  observe(labels: Labels, value: number): void {
    const k = key(labels);
    const s = this.series.get(k) ?? { buckets: BUCKETS.map(() => 0), sum: 0, count: 0 };
    BUCKETS.forEach((b, i) => {
      if (value <= b) s.buckets[i]!++;
    });
    s.sum += value;
    s.count++;
    this.series.set(k, s);
  }
  render(): string[] {
    const out = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const [k, s] of this.series) {
      const sep = k ? ',' : '';
      BUCKETS.forEach((b, i) => out.push(`${this.name}_bucket{${k}${sep}le="${b}"} ${s.buckets[i]}`));
      out.push(`${this.name}_bucket{${k}${sep}le="+Inf"} ${s.count}`);
      out.push(`${this.name}_sum{${k}} ${s.sum}`, `${this.name}_count{${k}} ${s.count}`);
    }
    return out;
  }
}

const gauge = (name: string, help: string, values: [Labels, number][]) => [
  `# HELP ${name} ${help}`,
  `# TYPE ${name} gauge`,
  ...values.map(([l, v]) => `${name}${Object.keys(l).length ? `{${key(l)}}` : ''} ${v}`),
];

/**
 * Application metrics in the Prometheus text format (slice 6.6), served on the internal metrics port only
 * (metrics-server.ts), never through the public proxy. Covers the runbook's list: uptime (scrape success,
 * readiness), latency, error rate, database capacity, queue failures, backup failures and failed sign-in spikes.
 */
@Injectable()
export class MetricsService implements OnModuleDestroy {
  readonly requests = new Counter(
    'innpilot_http_requests_total',
    'HTTP requests by route template and status.',
  );
  readonly duration = new Histogram(
    'innpilot_http_request_duration_seconds',
    'HTTP request duration by route template.',
  );
  readonly errors = new Counter(
    'innpilot_errors_total',
    'Error responses by stable error code (INVALID_CREDENTIALS, ACCOUNT_LOCKED, INTERNAL_ERROR, ...).',
  );
  readonly jobRuns = new Counter('innpilot_job_runs_total', 'Background job runs by kind and outcome.');
  private readonly loop = monitorEventLoopDelay({ resolution: 20 });
  private readonly started = Date.now();

  constructor(
    private readonly db: Db,
    private readonly files: FileStore,
  ) {
    this.loop.enable();
  }

  onModuleDestroy(): void {
    this.loop.disable();
  }

  observeRequest(method: string, route: string, status: number, seconds: number): void {
    this.requests.inc({ method, route, status: String(status) });
    this.duration.observe({ method, route }, seconds);
  }

  /** What each dependency answers now; the same checks as GET /health/ready. */
  async readiness(): Promise<Record<'database' | 'storage' | 'migrations', boolean>> {
    const [database, storage, migrations] = await Promise.all([
      this.db.unscoped
        .execute(sql`select 1`)
        .then(() => true)
        .catch(() => false),
      this.files.reachable(),
      this.db.unscoped
        .execute<{ name: string }>(sql`select ops_applied_migrations() as name`)
        .then((r) => {
          // Every migration this release ships must be applied (a newer database is fine).
          const applied = new Set(r.rows.map((m) => m.name));
          return readMigrations().every((m) => applied.has(m.name));
        })
        .catch(() => false),
    ]);
    return { database, storage, migrations };
  }

  async render(): Promise<string> {
    const lines: string[] = [];
    const ready = await this.readiness();
    lines.push(
      ...gauge(
        'innpilot_ready',
        'Whether a dependency is usable: 1 yes, 0 no.',
        Object.entries(ready).map(([dependency, ok]) => [{ dependency }, ok ? 1 : 0]),
      ),
    );
    const pool = this.db.poolStats();
    lines.push(
      ...gauge('innpilot_db_pool_connections', 'Database connections in the pool by state.', [
        [{ state: 'total' }, pool.total],
        [{ state: 'idle' }, pool.idle],
        [{ state: 'waiting' }, pool.waiting],
        [{ state: 'max' }, pool.max],
      ]),
    );
    const jobs = await this.db.unscoped
      .execute<{ queued: number; running: number; failed_24h: number; oldest_queued_seconds: number }>(
        sql`select * from ops_job_stats()`,
      )
      .then((r) => r.rows[0])
      .catch(() => undefined);
    if (jobs) {
      lines.push(
        ...gauge('innpilot_jobs', 'Background jobs by state (failed: last 24 hours).', [
          [{ state: 'queued' }, jobs.queued],
          [{ state: 'running' }, jobs.running],
          [{ state: 'failed_24h' }, jobs.failed_24h],
        ]),
        ...gauge('innpilot_jobs_oldest_queued_seconds', 'Age of the oldest due job still waiting.', [
          [{}, Number(jobs.oldest_queued_seconds)],
        ]),
      );
    }
    const backups = await this.db.unscoped
      .execute<{ last_ok: Date | null; last_ok_run: boolean | null; runs: number }>(
        sql`select (select max(finished_at) from backup_runs where ok) as last_ok,
                   (select ok from backup_runs order by finished_at desc limit 1) as last_ok_run,
                   (select count(*)::int from backup_runs) as runs`,
      )
      .then((r) => r.rows[0])
      .catch(() => undefined);
    if (backups && backups.runs > 0) {
      if (backups.last_ok) {
        lines.push(
          ...gauge('innpilot_backup_last_success_timestamp_seconds', 'When the last backup succeeded.', [
            [{}, Math.floor(new Date(backups.last_ok).getTime() / 1000)],
          ]),
        );
      }
      lines.push(
        ...gauge('innpilot_backup_last_run_ok', 'Whether the most recent backup attempt succeeded.', [
          [{}, backups.last_ok_run ? 1 : 0],
        ]),
      );
    }
    lines.push(
      ...this.requests.render(),
      ...this.duration.render(),
      ...this.errors.render(),
      ...this.jobRuns.render(),
      ...gauge('innpilot_process_uptime_seconds', 'Seconds since this API process started.', [
        [{}, Math.floor((Date.now() - this.started) / 1000)],
      ]),
      ...gauge('innpilot_process_resident_memory_bytes', 'Resident memory of this API process.', [
        [{}, process.memoryUsage().rss],
      ]),
      ...gauge(
        'innpilot_event_loop_delay_p99_seconds',
        'Event loop delay, 99th percentile, since the last scrape.',
        [[{}, this.loop.percentile(99) / 1e9]],
      ),
    );
    this.loop.reset();
    return `${lines.join('\n')}\n`;
  }
}
