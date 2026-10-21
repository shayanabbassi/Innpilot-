'use client';

import type { ReceivablesAgingDto } from '@innpilot/contracts';
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useState } from 'react';
import { BucketBadge, BucketTotals, LedgerTie } from '@/components/aging';
import { Definitions, ReportFilterBar, ReportFootnote, useReportScope } from '@/components/report-filter';
import {
  Card,
  EmptyState,
  PageError,
  PageHeader,
  PageSkeleton,
  PermissionDenied,
  TextField,
} from '@/components/ui';
import { api } from '@/lib/api';
import { formatAmount } from '@/lib/finance';

export default function ReceivablesPage() {
  const t = useTranslations('reports');
  const scope = useReportScope('report.financial');
  const [asOf, setAsOf] = useState(scope.businessDate);

  const aging = useQuery({
    queryKey: ['reports', 'receivables-aging', scope.scope, asOf],
    queryFn: () => api.get<ReceivablesAgingDto>(`/reports/receivables-aging?asOf=${asOf}${scope.param}`),
    enabled: scope.allowed && !!asOf,
  });

  if (!scope.allowed) return <PermissionDenied />;
  const d = aging.data;
  const cur = d?.currencyCode ?? 'PKR';
  const f = (v: string) => formatAmount(v, cur);

  return (
    <>
      <PageHeader title={t('arTitle')} subtitle={t('arSubtitle')} />
      <ReportFilterBar scope={scope}>
        <TextField label={t('asOf')} type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
      </ReportFilterBar>
      {!asOf ? null : aging.isPending ? (
        <PageSkeleton />
      ) : aging.isError ? (
        <PageError error={aging.error} onRetry={() => void aging.refetch()} />
      ) : (
        <div className="flex flex-col gap-4">
          <BucketTotals totals={d!.totals} currency={cur} />
          {d!.guests.length === 0 ? (
            <EmptyState message={t('arEmpty')} />
          ) : (
            d!.guests.map((g) => (
              <Card key={g.guestId}>
                <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
                  <Link
                    href={`/guests/${g.guestId}`}
                    className="font-semibold text-ink underline decoration-line underline-offset-2"
                  >
                    {g.guestName}
                  </Link>
                  <span className="tabular font-semibold">{f(g.totals.total)}</span>
                </div>
                <ul className="divide-y divide-line text-sm">
                  {g.folios.map((x) => (
                    <li
                      key={x.folioId}
                      className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-2"
                    >
                      <div className="min-w-0">
                        <Link
                          href={`/reservations/${x.reservationId}`}
                          className="underline decoration-line underline-offset-2"
                        >
                          <span className="tabular">{x.bookingReference}</span> · {x.label}
                        </Link>
                        <p className="text-xs text-muted">
                          {x.state === 'open'
                            ? t('arOpen')
                            : t('arInvoiced', { number: x.invoiceNumber ?? '', date: x.invoiceDate ?? '' })}
                          {x.deposits !== '0.00' && ` · ${t('arDeposits', { amount: f(x.deposits) })}`}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <BucketBadge bucket={x.bucket} days={x.days} />
                        <span className="tabular font-medium">{f(x.balance)}</span>
                      </div>
                    </li>
                  ))}
                </ul>
              </Card>
            ))
          )}
          <LedgerTie rows={d!.ledger} currency={cur} />
          <p className="text-xs text-muted">{t('arCompanyNote')}</p>
          <Definitions
            items={[
              [t('agingBalance'), d!.definitions.balance ?? ''],
              [t('agingDays'), d!.definitions.aging ?? ''],
              [t('agingNotLinked'), d!.definitions.notLinked ?? ''],
            ]}
          />
          <ReportFootnote
            currencyCode={cur}
            timezone={d!.timezone}
            generatedAt={d!.generatedAt}
            note={t('postedOnly')}
          />
        </div>
      )}
    </>
  );
}
