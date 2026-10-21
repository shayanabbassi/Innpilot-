'use client';

import type { MovementsDto } from '@innpilot/contracts';
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import {
  DateRangeFields,
  ReportFilterBar,
  ReportFootnote,
  useDateRange,
  useReportScope,
} from '@/components/report-filter';
import { Card, EmptyState, PageError, PageHeader, PageSkeleton, PermissionDenied } from '@/components/ui';
import { api } from '@/lib/api';

type Movement = MovementsDto['arrivals'][number];

export default function MovementsPage() {
  const t = useTranslations('reports');
  const tRes = useTranslations('reservations');
  const scope = useReportScope('report.operational');
  const range = useDateRange(scope.businessDate);

  const res = useQuery({
    queryKey: ['reports', 'arrivals-departures', scope.scope, range.query],
    queryFn: () => api.get<MovementsDto>(`/reports/arrivals-departures?${range.query}${scope.param}`),
    enabled: scope.allowed && range.valid,
  });

  if (!scope.allowed) return <PermissionDenied />;
  const d = res.data;
  const list = (title: string, rows: Movement[], date: (m: Movement) => string, empty: string) => (
    <Card title={t('movCount', { title, count: rows.length })}>
      {rows.length === 0 ? (
        <EmptyState message={empty} />
      ) : (
        <ul className="divide-y divide-line text-sm">
          {rows.map((m) => (
            <li
              key={`${m.reservationId}-${m.arrival}-${m.roomNumber ?? ''}`}
              className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 py-2"
            >
              <div className="min-w-0">
                <Link
                  href={`/reservations/${m.reservationId}`}
                  className="underline decoration-line underline-offset-2"
                >
                  {m.guestName}
                </Link>
                <p className="text-xs text-muted">
                  <span className="tabular">{m.bookingReference}</span> · {m.roomType}
                  {m.roomNumber
                    ? ` · ${t('movRoom', { room: m.roomNumber })}`
                    : ` · ${t('movNoRoom')}`} · {t('movNights', { count: m.nights })}
                </p>
              </div>
              <div className="text-right text-xs">
                <span className="tabular block">{date(m)}</span>
                <span className="text-muted">{tRes(`statuses.${m.status}`)}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );

  return (
    <>
      <PageHeader title={t('movTitle')} subtitle={t('movSubtitle')} />
      <ReportFilterBar scope={scope}>
        <DateRangeFields range={range} />
      </ReportFilterBar>
      {!range.valid ? null : res.isPending ? (
        <PageSkeleton />
      ) : res.isError ? (
        <PageError error={res.error} onRetry={() => void res.refetch()} />
      ) : (
        <div className="flex flex-col gap-4">
          <div className="grid gap-4 lg:grid-cols-2 lg:items-start">
            {list(t('movArrivals'), d!.arrivals, (m) => m.arrival, t('movNoArrivals'))}
            {list(t('movDepartures'), d!.departures, (m) => m.departure, t('movNoDepartures'))}
          </div>
          <ReportFootnote
            currencyCode={d!.currencyCode}
            timezone={d!.timezone}
            generatedAt={d!.generatedAt}
            note={t('movNote')}
          />
        </div>
      )}
    </>
  );
}
