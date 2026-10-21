'use client';

import type { PayablesAgingDto } from '@innpilot/contracts';
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

const isZero = (v: string) => !/[1-9]/.test(v);

export default function PayablesPage() {
  const t = useTranslations('reports');
  const scope = useReportScope('report.financial');
  const [asOf, setAsOf] = useState(scope.businessDate);

  const aging = useQuery({
    queryKey: ['reports', 'payables-aging', scope.scope, asOf],
    queryFn: () => api.get<PayablesAgingDto>(`/reports/payables-aging?asOf=${asOf}${scope.param}`),
    enabled: scope.allowed && !!asOf,
  });

  if (!scope.allowed) return <PermissionDenied />;
  const d = aging.data;
  const cur = d?.currencyCode ?? 'PKR';
  const f = (v: string) => formatAmount(v, cur);

  return (
    <>
      <PageHeader title={t('apTitle')} subtitle={t('apSubtitle')} />
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
          {d!.suppliers.length === 0 ? (
            <EmptyState message={t('apEmpty')} />
          ) : (
            d!.suppliers.map((s) => (
              <Card key={s.supplierId}>
                <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-semibold text-ink">{s.supplierName}</span>
                  <span className="tabular font-semibold">{f(s.balance)}</span>
                </div>
                <ul className="divide-y divide-line text-sm">
                  {s.bills.map((b) => (
                    <li
                      key={b.voucherId}
                      className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-2"
                    >
                      <div className="min-w-0">
                        <Link
                          href={`/expenses/${b.voucherId}`}
                          className="underline decoration-line underline-offset-2"
                        >
                          <span className="tabular">{b.voucherNumber}</span>
                          {b.billReference && ` · ${b.billReference}`}
                        </Link>
                        <p className="text-xs text-muted">
                          {t('apDates', { bill: b.billDate, due: b.dueDate })}
                          {!isZero(b.paid) && ` · ${t('apPaid', { paid: f(b.paid), total: f(b.total) })}`}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <BucketBadge bucket={b.bucket} days={b.days} />
                        <span className="tabular font-medium">{f(b.outstanding)}</span>
                      </div>
                    </li>
                  ))}
                  {!isZero(s.notLinked) && (
                    <li className="flex justify-between gap-3 py-2">
                      <span className="text-muted">{t('apNotLinked')}</span>
                      <span className="tabular font-medium">{f(s.notLinked)}</span>
                    </li>
                  )}
                </ul>
              </Card>
            ))
          )}
          <LedgerTie rows={d!.ledger} currency={cur} />
          <Definitions
            items={[
              [t('apOutstanding'), d!.definitions.outstanding ?? ''],
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
