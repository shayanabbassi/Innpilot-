'use client';

import type { ExpensesReportDto } from '@innpilot/contracts';
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import {
  DateRangeFields,
  Definitions,
  Figure,
  ReportFilterBar,
  ReportFootnote,
  useDateRange,
  useReportScope,
} from '@/components/report-filter';
import { Card, EmptyState, PageError, PageHeader, PageSkeleton, PermissionDenied } from '@/components/ui';
import { api } from '@/lib/api';
import { formatAmount } from '@/lib/finance';

const isZero = (v: string) => !/[1-9]/.test(v);

export default function ExpensesReportPage() {
  const t = useTranslations('reports');
  const scope = useReportScope('report.financial');
  const range = useDateRange(scope.businessDate);

  const res = useQuery({
    queryKey: ['reports', 'expenses', scope.scope, range.query],
    queryFn: () => api.get<ExpensesReportDto>(`/reports/expenses?${range.query}${scope.param}`),
    enabled: scope.allowed && range.valid,
  });

  if (!scope.allowed) return <PermissionDenied />;
  const d = res.data;
  const cur = d?.currencyCode ?? 'PKR';
  const f = (v: string) => formatAmount(v, cur);

  return (
    <>
      <PageHeader title={t('exTitle')} subtitle={t('exSubtitle')} />
      <ReportFilterBar scope={scope} report="expenses" query={range.query}>
        <DateRangeFields range={range} />
      </ReportFilterBar>
      {!range.valid ? null : res.isPending ? (
        <PageSkeleton />
      ) : res.isError ? (
        <PageError error={res.error} onRetry={() => void res.refetch()} />
      ) : d!.byAccount.length === 0 ? (
        <EmptyState message={t('exEmpty')} />
      ) : (
        <div className="flex flex-col gap-4">
          <Card>
            <dl className="grid grid-cols-2 gap-3">
              <Figure label={t('exTotal')} value={f(d!.total)} strong />
              <Figure label={t('exRecoverable')} value={f(d!.recoverableTax)} />
            </dl>
          </Card>
          <div className="grid gap-4 lg:grid-cols-2 lg:items-start">
            <Card title={t('exByAccount')}>
              <ul className="divide-y divide-line text-sm">
                {d!.byAccount.map((a) => (
                  <li key={a.accountId} className="flex items-baseline justify-between gap-3 py-2">
                    <span className="min-w-0">
                      <Link
                        href={`/finance/ledger?accountId=${a.accountId}&from=${d!.from}&to=${d!.to}`}
                        className="underline decoration-line underline-offset-2"
                      >
                        <span className="tabular">{a.code}</span> {a.name}
                      </Link>
                      {!isZero(a.tax) && (
                        <span className="block text-xs text-muted">
                          {t('exTaxIncluded', { tax: f(a.tax) })}
                        </span>
                      )}
                    </span>
                    <span className="tabular font-medium">{f(a.total)}</span>
                  </li>
                ))}
              </ul>
            </Card>
            <Card title={t('exByPayee')}>
              <ul className="divide-y divide-line text-sm">
                {d!.byPayee.map((p) => (
                  <li
                    key={`${p.supplierId ?? ''}-${p.name}`}
                    className="flex items-baseline justify-between gap-3 py-2"
                  >
                    <span className="min-w-0">
                      {p.name}
                      <span className="block text-xs text-muted">
                        {t('exPayeeLine', { cash: f(p.cash), bills: f(p.bills), count: p.vouchers })}
                      </span>
                    </span>
                    <span className="tabular font-medium">{f(p.total)}</span>
                  </li>
                ))}
              </ul>
            </Card>
          </div>
          <Definitions
            items={[
              [t('exTotal'), d!.definitions.amount ?? ''],
              [t('exTax'), d!.definitions.tax ?? ''],
              [t('exRecoverable'), d!.definitions.recoverableTax ?? ''],
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
