'use client';

import type { DiscrepanciesDto } from '@innpilot/contracts';
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import type { ReactNode } from 'react';
import {
  DateRangeFields,
  ReportFilterBar,
  ReportFootnote,
  useDateRange,
  useReportScope,
} from '@/components/report-filter';
import { Card, EmptyState, PageError, PageHeader, PageSkeleton, PermissionDenied } from '@/components/ui';
import { api } from '@/lib/api';
import { formatAmount } from '@/lib/finance';

const isZero = (v: string) => !/[1-9]/.test(v);

export default function DiscrepanciesPage() {
  const t = useTranslations('reports');
  const scope = useReportScope('report.financial');
  const range = useDateRange(scope.businessDate);

  const res = useQuery({
    queryKey: ['reports', 'discrepancies', scope.scope, range.query],
    queryFn: () => api.get<DiscrepanciesDto>(`/reports/discrepancies?${range.query}${scope.param}`),
    enabled: scope.allowed && range.valid,
  });

  if (!scope.allowed) return <PermissionDenied />;
  const d = res.data;
  const cur = d?.currencyCode ?? 'PKR';
  const f = (v: string) => formatAmount(v, cur);
  const section = (title: string, text: string, count: number, children: ReactNode) => (
    <Card title={t('discSection', { title, count })}>
      <p className="-mt-2 mb-2 text-xs text-muted">{text}</p>
      {count === 0 ? (
        <EmptyState message={t('discNone')} />
      ) : (
        <ul className="divide-y divide-line text-sm">{children}</ul>
      )}
    </Card>
  );
  const row = (key: string, main: ReactNode, sub: string, amount: string) => (
    <li key={key} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 py-2">
      <span className="min-w-0">
        {main}
        <span className="block text-xs text-muted">{sub}</span>
      </span>
      <span className="tabular font-medium">{amount}</span>
    </li>
  );

  return (
    <>
      <PageHeader title={t('discTitle')} subtitle={t('discSubtitle')} />
      <ReportFilterBar scope={scope} report="discrepancies" query={range.query}>
        <DateRangeFields range={range} />
      </ReportFilterBar>
      {!range.valid ? null : res.isPending ? (
        <PageSkeleton />
      ) : res.isError ? (
        <PageError error={res.error} onRetry={() => void res.refetch()} />
      ) : (
        <div className="flex flex-col gap-4">
          {section(
            t('discVariances'),
            d!.definitions.variances ?? '',
            d!.variances.length,
            d!.variances.map((v) =>
              row(
                v.shiftId,
                <Link
                  href={`/cashier/shifts/${v.shiftId}`}
                  className="underline decoration-line underline-offset-2"
                >
                  {v.cashierName} · {v.cashAccountName}
                </Link>,
                [v.businessDate, v.explanation].filter(Boolean).join(' · '),
                f(v.variance),
              ),
            ),
          )}
          {section(
            t('discOpenings'),
            d!.definitions.openingDifferences ?? '',
            d!.openingDifferences.length,
            d!.openingDifferences.map((o) =>
              row(
                o.shiftId,
                <Link
                  href={`/cashier/shifts/${o.shiftId}`}
                  className="underline decoration-line underline-offset-2"
                >
                  {o.cashierName} · {o.cashAccountName}
                </Link>,
                t('discOpeningLine', {
                  date: o.businessDate,
                  counted: f(o.openingCount),
                  book: f(o.bookBalance),
                }),
                f(o.difference),
              ),
            ),
          )}
          {section(
            t('discOutside'),
            d!.definitions.cashOutsideShifts ?? '',
            d!.cashOutsideShifts.length,
            d!.cashOutsideShifts.map((c) =>
              row(
                `${c.entryId}-${c.cashAccountName}`,
                <Link
                  href={`/finance/journals/${c.entryId}`}
                  className="underline decoration-line underline-offset-2"
                >
                  {t('discJournal', { number: c.journalNumber })} · {c.narration}
                </Link>,
                `${c.accountingDate} · ${c.cashAccountName}`,
                isZero(c.amountOut) ? `+${f(c.amountIn)}` : `−${f(c.amountOut)}`,
              ),
            ),
          )}
          {section(
            t('discOverrides'),
            d!.definitions.auditOverrides ?? '',
            d!.auditOverrides.length,
            d!.auditOverrides.map((o) =>
              row(
                o.businessDate,
                <span>{o.reason}</span>,
                t('discOverrideLine', { date: o.businessDate, name: o.closedByName }),
                t('discIssues', { count: o.issues }),
              ),
            ),
          )}
          <ReportFootnote
            currencyCode={cur}
            timezone={d!.timezone}
            generatedAt={d!.generatedAt}
            note={t('opsNote')}
          />
        </div>
      )}
    </>
  );
}
