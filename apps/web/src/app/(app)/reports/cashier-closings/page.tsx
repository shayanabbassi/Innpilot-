'use client';

import type { CashierClosingsDto } from '@innpilot/contracts';
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
import {
  Alert,
  Card,
  EmptyState,
  PageError,
  PageHeader,
  PageSkeleton,
  PermissionDenied,
  StatusBadge,
} from '@/components/ui';
import { api } from '@/lib/api';
import { formatAmount } from '@/lib/finance';

const isZero = (v: string) => !/[1-9]/.test(v);

export default function CashierClosingsPage() {
  const t = useTranslations('reports');
  const tCashier = useTranslations('cashier');
  const scope = useReportScope('report.operational');
  const range = useDateRange(scope.businessDate);

  const res = useQuery({
    queryKey: ['reports', 'cashier-closings', scope.scope, range.query],
    queryFn: () => api.get<CashierClosingsDto>(`/reports/cashier-closings?${range.query}${scope.param}`),
    enabled: scope.allowed && range.valid,
  });

  if (!scope.allowed) return <PermissionDenied />;
  const d = res.data;
  const cur = d?.currencyCode ?? 'PKR';
  const f = (v: string) => formatAmount(v, cur);

  return (
    <>
      <PageHeader title={t('ccTitle')} subtitle={t('ccSubtitle')} />
      <ReportFilterBar scope={scope} report="cashier-closings" query={range.query}>
        <DateRangeFields range={range} />
      </ReportFilterBar>
      {!range.valid ? null : res.isPending ? (
        <PageSkeleton />
      ) : res.isError ? (
        <PageError error={res.error} onRetry={() => void res.refetch()} />
      ) : (
        <div className="flex flex-col gap-4">
          {!d!.allCashiers && <Alert tone="info">{t('ccOwnOnly')}</Alert>}
          <Card>
            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-5">
              <Figure label={t('ccClosings')} value={String(d!.totals.closings)} />
              <Figure label={t('ccShortages')} value={f(d!.totals.shortages)} />
              <Figure label={t('ccOverages')} value={f(d!.totals.overages)} />
              <Figure label={t('ccNet')} value={f(d!.totals.net)} strong />
              <Figure label={t('ccAwaiting')} value={String(d!.totals.awaitingApproval)} />
            </dl>
          </Card>
          {d!.closings.length === 0 ? (
            <EmptyState message={t('ccEmpty')} />
          ) : (
            <Card>
              <ul className="divide-y divide-line text-sm">
                {d!.closings.map((c) => (
                  <li key={c.closingId} className="py-3">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <Link
                        href={`/cashier/shifts/${c.shiftId}`}
                        className="font-medium underline decoration-line underline-offset-2"
                      >
                        {c.cashierName} · {c.cashAccountName}
                      </Link>
                      <StatusBadge
                        tone={
                          c.status === 'approved'
                            ? 'success'
                            : c.status === 'reopened'
                              ? 'neutral'
                              : 'warning'
                        }
                      >
                        {tCashier(`closingStatus.${c.status}`)}
                      </StatusBadge>
                    </div>
                    <dl className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-4">
                      <Figure label={t('date')} value={c.businessDate} />
                      <Figure label={t('ccExpected')} value={f(c.expected)} />
                      <Figure label={t('ccCounted')} value={f(c.counted)} />
                      <Figure label={t('ccVariance')} value={f(c.variance)} strong={!isZero(c.variance)} />
                    </dl>
                    {(c.explanation || c.approvedByName || c.reopenReason) && (
                      <p className="mt-2 text-xs text-muted">
                        {[
                          c.explanation && t('ccExplanation', { text: c.explanation }),
                          c.approvedByName && t('ccApprovedBy', { name: c.approvedByName }),
                          c.reopenReason && t('ccReopened', { reason: c.reopenReason }),
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            </Card>
          )}
          <Definitions
            items={[
              [t('ccVariance'), d!.definitions.variance ?? ''],
              [t('ccStatus'), d!.definitions.status ?? ''],
            ]}
          />
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
