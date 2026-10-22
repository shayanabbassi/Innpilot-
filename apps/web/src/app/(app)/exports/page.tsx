'use client';

import type { ExportJobDto, ExportReport, FileLinkDto } from '@innpilot/contracts';
import { useQuery } from '@tanstack/react-query';
import { useFormatter, useTranslations } from 'next-intl';
import { useState } from 'react';
import {
  ApiErrorAlert,
  Button,
  Card,
  PageError,
  PageHeader,
  PageSkeleton,
  PermissionDenied,
  StatusBadge,
} from '@/components/ui';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';

/** The report screens' own titles, so a job reads the same as the report it came from. */
const TITLES: Record<ExportReport, string> = {
  'trial-balance': 'tbTitle',
  'profit-loss': 'plTitle',
  'balance-sheet': 'bsTitle',
  cashbook: 'cbTitle',
  'cash-flow': 'cfTitle',
  'tax-summary': 'taxTitle',
  revenue: 'revTitle',
  'receivables-aging': 'arTitle',
  'payables-aging': 'apTitle',
  occupancy: 'occTitle',
  'arrivals-departures': 'movTitle',
  'cashier-closings': 'ccTitle',
  expenses: 'exTitle',
  discrepancies: 'discTitle',
  'user-activity': 'uaTitle',
};

const TONES = {
  queued: 'neutral',
  running: 'warning',
  succeeded: 'success',
  failed: 'danger',
} as const;

/**
 * Exports prepared in the background (slice 6.3): status while they are made, then a download for 24 hours. Only
 * your own; the server enforces that too. Refreshes every few seconds while something is still being prepared.
 */
export default function ExportsPage() {
  const t = useTranslations('exports');
  const { canTenant, me } = useSession();
  const allowed = canTenant('export.run') || me.properties.some((p) => p.permissions.includes('export.run'));
  const list = useQuery({
    queryKey: ['exports'],
    queryFn: () => api.get<ExportJobDto[]>('/exports'),
    enabled: allowed,
    refetchInterval: (q) =>
      q.state.data?.some((j) => j.status === 'queued' || j.status === 'running') ? 4000 : false,
  });

  if (!allowed) return <PermissionDenied />;
  if (list.isPending) return <PageSkeleton />;
  if (list.isError) return <PageError error={list.error} onRetry={() => void list.refetch()} />;
  const working = list.data.some((j) => j.status === 'queued' || j.status === 'running');

  return (
    <>
      <PageHeader title={t('title')} subtitle={t('subtitle')} />
      <Card>
        {list.data.length === 0 ? (
          <p className="text-sm text-muted">{t('empty')}</p>
        ) : (
          <ul className="divide-y divide-line">
            {list.data.map((j) => (
              <ExportRow key={j.id} job={j} />
            ))}
          </ul>
        )}
        {working && <p className="mt-3 text-xs text-muted">{t('refreshNote')}</p>}
      </Card>
    </>
  );
}

function ExportRow({ job }: { job: ExportJobDto }) {
  const t = useTranslations('exports');
  const tReports = useTranslations('reports');
  const format = useFormatter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const when = (iso: string) => format.dateTime(new Date(iso), { dateStyle: 'medium', timeStyle: 'short' });
  const day = (d: string) =>
    format.dateTime(new Date(`${d}T00:00:00Z`), { dateStyle: 'medium', timeZone: 'UTC' });
  const q = job.query;
  const filters =
    q.from && q.to
      ? t('period', { from: day(q.from), to: day(q.to) })
      : q.asOf
        ? t('asOf', { date: day(q.asOf) })
        : '';

  /** A fresh five-minute link, followed at once; the browser saves the file. */
  const download = async () => {
    setBusy(true);
    setError(null);
    try {
      const { url } = await api.post<FileLinkDto>(`/exports/${job.id}/link`);
      window.location.assign(url);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="flex flex-col gap-2 py-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="min-w-0">
          <span className="block font-medium text-ink">
            {tReports(TITLES[job.report])} · {job.format === 'csv' ? 'CSV' : 'Excel'}
          </span>
          <span className="block text-xs text-muted">
            {filters && `${filters} · `}
            {t('asked')} {when(job.createdAt)}
          </span>
        </span>
        <span className="flex items-center gap-2">
          <StatusBadge tone={job.file?.expired ? 'neutral' : TONES[job.status]}>
            {job.file?.expired ? t('expired') : t(`statuses.${job.status}`)}
          </StatusBadge>
          {job.status === 'succeeded' && job.file && !job.file.expired && (
            <Button variant="secondary" className="min-h-8 px-3" busy={busy} onClick={() => void download()}>
              {t('download')}
            </Button>
          )}
        </span>
      </div>
      {job.file && !job.file.expired && (
        <p className="text-xs text-muted">
          {t('fileLine', {
            rows: format.number(job.file.rowCount),
            size: size(job.file.sizeBytes),
            until: when(job.file.expiresAt),
          })}
        </p>
      )}
      {job.error && <p className="text-xs text-danger">{job.error}</p>}
      {error !== null && <ApiErrorAlert error={error} />}
    </li>
  );
}

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
