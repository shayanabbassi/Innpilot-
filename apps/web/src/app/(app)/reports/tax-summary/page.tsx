'use client';

import type { TaxSummaryDto } from '@innpilot/contracts';
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
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
} from '@/components/ui';
import { api } from '@/lib/api';
import { formatAmount } from '@/lib/finance';

/** Rates are stored with 4 decimals; show them as entered (16, 7.5). */
const rate = (v: string) => v.replace(/\.?0+$/, '');

export default function TaxSummaryPage() {
  const t = useTranslations('reports');
  const scope = useReportScope('report.financial');
  const range = useDateRange(scope.businessDate);

  const tax = useQuery({
    queryKey: ['reports', 'tax-summary', scope.scope, range.query],
    queryFn: () => api.get<TaxSummaryDto>(`/reports/tax-summary?${range.query}${scope.param}`),
    enabled: scope.allowed && range.valid,
  });

  if (!scope.allowed) return <PermissionDenied />;
  const d = tax.data;
  const cur = d?.currencyCode ?? 'PKR';
  const f = (v: string) => formatAmount(v, cur);
  const cell = 'tabular px-3 py-2 text-right';

  return (
    <>
      <PageHeader title={t('taxTitle')} subtitle={t('taxSubtitle')} />
      <ReportFilterBar scope={scope}>
        <DateRangeFields range={range} />
      </ReportFilterBar>
      {!range.valid ? null : tax.isPending ? (
        <PageSkeleton />
      ) : tax.isError ? (
        <PageError error={tax.error} onRetry={() => void tax.refetch()} />
      ) : (
        <div className="flex flex-col gap-4">
          <Alert tone="info">{t('taxNotAReturn')}</Alert>
          {d!.rows.length === 0 ? (
            <EmptyState message={t('taxEmpty')} />
          ) : (
            <div className="overflow-x-auto rounded-lg border border-line bg-white">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line text-muted">
                    <th className="px-3 py-2 text-left font-medium">{t('taxCode')}</th>
                    <th className="px-3 py-2 text-right font-medium">{t('taxableBase')}</th>
                    <th className="px-3 py-2 text-right font-medium">{t('taxAmount')}</th>
                  </tr>
                </thead>
                <tbody>
                  {d!.rows.map((r) => (
                    <tr key={`${r.code}-${r.ratePercent}-${r.inclusive}`} className="border-b border-line/60">
                      <td className="px-3 py-2">
                        <span className="font-medium">{r.code}</span> {r.name}
                        <span className="block text-xs text-muted">
                          {t('taxRateLine', {
                            rate: rate(r.ratePercent),
                            inclusive: r.inclusive ? 'yes' : 'no',
                            account: r.accountCode,
                          })}
                        </span>
                      </td>
                      <td className={cell}>{f(r.taxableBase)}</td>
                      <td className={cell}>{f(r.taxAmount)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="bg-canvas font-semibold">
                    <td className="px-3 py-2">{t('total')}</td>
                    <td className={cell}>{f(d!.totalTaxableBase)}</td>
                    <td className={cell}>{f(d!.totalTax)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
          {d!.accounts.length > 0 && (
            <Card title={t('taxAccounts')}>
              <ul className="divide-y divide-line text-sm">
                {d!.accounts.map((a) => (
                  <li key={a.accountId} className="py-2">
                    <p className="font-medium text-ink">
                      <span className="tabular">{a.code}</span> {a.name}
                    </p>
                    <dl className="mt-1 grid grid-cols-2 gap-3 sm:grid-cols-4">
                      <Figure label={t('taxOnBills')} value={f(a.chargedOnBills)} />
                      <Figure label={t('taxOtherPostings')} value={f(a.otherPostings)} />
                      <Figure label={t('taxMovement')} value={f(a.ledgerMovement)} />
                      <Figure label={t('taxClosing')} value={f(a.closingBalance)} strong />
                    </dl>
                  </li>
                ))}
              </ul>
            </Card>
          )}
          <Card>
            <dl>
              <Figure label={t('taxRecoverable')} value={f(d!.recoverablePurchaseTax)} strong />
            </dl>
          </Card>
          <Definitions
            items={[
              [t('taxAmount'), d!.definitions.rows ?? ''],
              [t('taxOtherPostings'), d!.definitions.otherPostings ?? ''],
              [t('taxRecoverable'), d!.definitions.recoverable ?? ''],
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
