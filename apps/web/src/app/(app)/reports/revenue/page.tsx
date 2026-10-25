'use client';

import type { RevenueDto } from '@innpilot/contracts';
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import {
  DateRangeFields,
  Definitions,
  ReportFilterBar,
  ReportFootnote,
  useDateRange,
  useReportScope,
} from '@/components/report-filter';
import { Card, EmptyState, PageError, PageHeader, PageSkeleton, PermissionDenied } from '@/components/ui';
import { api } from '@/lib/api';
import { formatAmount } from '@/lib/finance';

const isZero = (v: string) => !/[1-9]/.test(v);

export default function RevenuePage() {
  const t = useTranslations('reports');
  const tPay = useTranslations('folio');
  const scope = useReportScope('report.financial');
  const range = useDateRange(scope.businessDate);

  const rev = useQuery({
    queryKey: ['reports', 'revenue', scope.scope, range.query],
    queryFn: () => api.get<RevenueDto>(`/reports/revenue?${range.query}${scope.param}`),
    enabled: scope.allowed && range.valid,
  });

  if (!scope.allowed) return <PermissionDenied />;
  const d = rev.data;
  const cur = d?.currencyCode ?? 'PKR';
  const f = (v: string) => formatAmount(v, cur);
  const cell = 'tabular px-3 py-2 text-right';

  return (
    <>
      <PageHeader title={t('revTitle')} subtitle={t('revSubtitle')} />
      <ReportFilterBar scope={scope} report="revenue" query={range.query}>
        <DateRangeFields range={range} />
      </ReportFilterBar>
      {!range.valid ? null : rev.isPending ? (
        <PageSkeleton />
      ) : rev.isError ? (
        <PageError error={rev.error} onRetry={() => void rev.refetch()} />
      ) : (
        <div className="flex flex-col gap-4">
          <Card title={t('revByAccount')}>
            {d!.categories.length === 0 ? (
              <EmptyState message={t('revEmpty')} />
            ) : (
              <table className="w-full text-sm">
                <tbody>
                  {d!.categories.map((c) => (
                    <tr key={c.accountId} className="border-b border-line/60">
                      <td className="py-2 pr-3">
                        <Link
                          href={`/finance/ledger?accountId=${c.accountId}&from=${d!.from}&to=${d!.to}`}
                          className="underline decoration-line underline-offset-2"
                        >
                          <span className="tabular">{c.code}</span> {c.name}
                        </Link>
                      </td>
                      <td className="tabular py-2 text-right">{f(c.total)}</td>
                    </tr>
                  ))}
                  <tr className="font-semibold">
                    <td className="py-2 pr-3">{t('revTotal')}</td>
                    <td className="tabular py-2 text-right">{f(d!.total)}</td>
                  </tr>
                </tbody>
              </table>
            )}
          </Card>
          {d!.days.length > 0 && (
            <section aria-label={t('revByDay')}>
              <h2 className="mb-2 text-base font-semibold text-navy-800">{t('revByDay')}</h2>
              <div className="overflow-x-auto rounded-lg border border-line bg-white">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-line text-muted">
                      <th className="px-3 py-2 text-left font-medium">{t('date')}</th>
                      {d!.categories.map((c) => (
                        <th key={c.accountId} className="px-3 py-2 text-right font-medium" title={c.name}>
                          {c.code}
                        </th>
                      ))}
                      <th className="px-3 py-2 text-right font-medium">{t('total')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d!.days.map((day) => (
                      <tr key={day.date} className="border-b border-line/60">
                        <td className="tabular px-3 py-2">{day.date}</td>
                        {day.amounts.map((a, i) => (
                          <td key={i} className={cell}>
                            {isZero(a) ? '' : f(a)}
                          </td>
                        ))}
                        <td className={`${cell} font-medium`}>{f(day.total)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
          <Card title={t('revReceipts')}>
            <p className="mb-2 text-xs text-muted">{t('revReceiptsNote')}</p>
            {d!.receipts.length === 0 ? (
              <EmptyState message={t('revNoReceipts')} />
            ) : (
              <ul className="divide-y divide-line text-sm">
                {d!.receipts.map((r) => (
                  <li key={r.method} className="flex items-baseline justify-between gap-3 py-2">
                    <span>
                      {tPay(`methods.${r.method}`)}
                      <span className="block text-xs text-muted">
                        {t('revReceiptsLine', {
                          deposits: f(r.deposits),
                          payments: f(r.payments),
                          refunds: f(r.refunds),
                        })}
                      </span>
                    </span>
                    <span className="tabular font-medium">{f(r.net)}</span>
                  </li>
                ))}
                <li className="flex justify-between py-2 font-semibold">
                  <span>{t('revReceiptsTotal')}</span>
                  <span className="tabular">{f(d!.receiptsTotal)}</span>
                </li>
              </ul>
            )}
          </Card>
          <Definitions
            items={[
              [t('revTotal'), d!.definitions.revenue ?? ''],
              [t('revReceipts'), d!.definitions.receipts ?? ''],
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
