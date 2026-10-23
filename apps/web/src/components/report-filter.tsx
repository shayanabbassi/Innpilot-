'use client';

import type { ExportFormat, ExportJobDto, ExportReport, Permission } from '@innpilot/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useFormatter, useTranslations } from 'next-intl';
import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import { Alert, ApiErrorAlert, Button, Card, SelectField, TextField } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { monthRange } from '@/lib/finance';
import { useSession } from '@/lib/session';

const ALL = 'all';

/**
 * Which properties the user may run a report for (P5-3): each property where they hold the permission, and
 * "All properties" with a tenant-wide role. The API checks the same rule.
 */
export function useReportScope(permission: Permission) {
  const { me, property, canTenant } = useSession();
  const options = me.properties.filter((p) => p.permissions.includes(permission));
  const all = canTenant(permission);
  const initial =
    property && options.some((p) => p.id === property.id) ? property.id : (options[0]?.id ?? ALL);
  const [scope, setScope] = useState<string>(initial);
  return {
    allowed: options.length > 0 || all,
    options,
    all,
    scope,
    setScope,
    /** Query string fragment: `&propertyId=…`, or nothing for all properties. */
    param: scope === ALL ? '' : `&propertyId=${scope}`,
    businessDate:
      (options.find((p) => p.id === scope) ?? property)?.businessDate ??
      new Date().toISOString().slice(0, 10),
  };
}

/**
 * Export and print (P5-14, D15). The file comes from the same query as the screen; the server checks
 * `export.run` and audits it. Export buttons show only to users who hold `export.run` for the chosen scope. An export
 * too big to make while you wait can be prepared in the background (slice 6.3) and collected from My exports.
 */
export function ExportMenu({ report, query, all }: { report: ExportReport; query: string; all: boolean }) {
  const t = useTranslations('reports');
  const { property, canTenant, me } = useSession();
  const propertyId = /propertyId=([0-9a-f-]+)/.exec(query)?.[1];
  const canExport = all
    ? canTenant('export.run')
    : (me.properties.find((p) => p.id === (propertyId ?? property?.id))?.permissions.includes('export.run') ??
      false);
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<ExportFormat | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [tooLarge, setTooLarge] = useState<ExportFormat | null>(null);
  const [queued, setQueued] = useState(false);
  const [queueing, setQueueing] = useState(false);

  const prepare = async (format: ExportFormat) => {
    setQueueing(true);
    setError(null);
    try {
      await api.post<ExportJobDto>('/exports', {
        report,
        format,
        query: Object.fromEntries(new URLSearchParams(query)),
      });
      setTooLarge(null);
      setQueued(true);
      void queryClient.invalidateQueries({ queryKey: ['exports'] });
    } catch (err) {
      setError(err);
    } finally {
      setQueueing(false);
    }
  };

  const run = async (format: ExportFormat) => {
    setBusy(format);
    setError(null);
    setTooLarge(null);
    setQueued(false);
    try {
      const { blob, fileName } = await api.download(`/reports/${report}/export?format=${format}&${query}`);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'EXPORT_TOO_LARGE') setTooLarge(format);
      else setError(err);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="no-print flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        {canExport &&
          (['csv', 'xlsx'] as const).map((f) => (
            <Button key={f} variant="secondary" busy={busy === f} onClick={() => void run(f)}>
              {t(`export_${f}`)}
            </Button>
          ))}
        <Button variant="ghost" onClick={() => window.print()}>
          {t('print')}
        </Button>
      </div>
      {error !== null && <ApiErrorAlert error={error} />}
      {tooLarge && (
        <Alert tone="info">
          <span className="flex flex-wrap items-center gap-3">
            <span>{t('tooLargeForNow')}</span>
            <Button variant="secondary" busy={queueing} onClick={() => void prepare(tooLarge)}>
              {t('prepareInBackground')}
            </Button>
          </span>
        </Alert>
      )}
      {queued && (
        <Alert tone="success">
          {t.rich('preparing', {
            link: (chunks) => (
              <Link href="/exports" className="underline">
                {chunks}
              </Link>
            ),
          })}
        </Alert>
      )}
    </div>
  );
}

/** One filter bar for every report (UX §6.13): property first, then the report's own fields, then export. */
export function ReportFilterBar({
  scope,
  report,
  query,
  children,
}: {
  scope: ReturnType<typeof useReportScope>;
  /** With `query` (the report's own filters, without the property), shows the export menu. */
  report?: ExportReport;
  query?: string;
  children: ReactNode;
}) {
  const t = useTranslations('reports');
  return (
    <Card className="no-print mb-4">
      {report && query !== undefined && (
        <div className="mb-4 flex justify-end">
          <ExportMenu report={report} query={`${query}${scope.param}`} all={scope.param === ''} />
        </div>
      )}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 lg:items-end">
        <SelectField
          label={t('property')}
          value={scope.scope}
          onChange={(e) => scope.setScope(e.target.value)}
        >
          {scope.options.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
          {scope.all && <option value={ALL}>{t('allProperties')}</option>}
        </SelectField>
        {children}
      </div>
    </Card>
  );
}

/** The footer every report carries: what it is based on, in which currency and timezone. */
export function ReportFootnote({
  currencyCode,
  timezone,
  generatedAt,
  note,
}: {
  currencyCode: string;
  timezone: string | null;
  generatedAt: string;
  note: string;
}) {
  const t = useTranslations('reports');
  const format = useFormatter();
  // Timestamps are shown in the property's timezone (P5-2); hotel dates need no conversion.
  const at = format.dateTime(new Date(generatedAt), {
    dateStyle: 'medium',
    timeStyle: 'short',
    ...(timezone ? { timeZone: timezone } : {}),
  });
  return (
    <p className="text-xs text-muted">
      {note} {t('footnote', { currency: currencyCode, timezone: timezone ?? '—', at })}
    </p>
  );
}

/** Metric definitions shown with the report (04 Frontend §1: every figure says what it means). */
export function Definitions({ items }: { items: [label: string, text: string][] }) {
  const t = useTranslations('reports');
  return (
    <details className="rounded-lg border border-line bg-white p-3 text-sm">
      <summary className="cursor-pointer font-medium text-ink">{t('definitions')}</summary>
      <dl className="mt-2 grid gap-x-6 gap-y-1 sm:grid-cols-[auto_1fr]">
        {items.map(([label, text]) => (
          <div key={label} className="contents">
            <dt className="font-medium text-ink">{label}</dt>
            <dd className="text-muted">{text}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

/** A from–to range starting on the month of the hotel date, checked like the API checks it. */
export function useDateRange(businessDate: string) {
  const initial = monthRange(businessDate);
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  return { from, to, setFrom, setTo, valid: !!from && !!to && from <= to, query: `from=${from}&to=${to}` };
}

export function DateRangeFields({ range }: { range: ReturnType<typeof useDateRange> }) {
  const t = useTranslations('reports');
  return (
    <>
      <TextField
        label={t('from')}
        type="date"
        value={range.from}
        onChange={(e) => range.setFrom(e.target.value)}
      />
      <TextField
        label={t('to')}
        type="date"
        value={range.to}
        onChange={(e) => range.setTo(e.target.value)}
        error={range.valid ? undefined : t('rangeError')}
      />
    </>
  );
}

/** A figure with its label, for summaries that would be too wide as table columns on a phone. */
export function Figure({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return (
    <div>
      <dt className="text-xs text-muted">{label}</dt>
      <dd className={`tabular ${strong ? 'font-semibold text-ink' : 'text-ink'}`}>{value}</dd>
    </div>
  );
}
