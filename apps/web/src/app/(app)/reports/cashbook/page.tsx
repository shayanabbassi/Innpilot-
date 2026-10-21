'use client';

import type { CashbookDto } from '@innpilot/contracts';
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useState } from 'react';
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
  SelectField,
  StatusBadge,
} from '@/components/ui';
import { api } from '@/lib/api';
import { formatAmount } from '@/lib/finance';

const isZero = (v: string) => !/[1-9]/.test(v);

export default function CashbookPage() {
  const t = useTranslations('reports');
  const tCash = useTranslations('cash');
  const scope = useReportScope('report.financial');
  const range = useDateRange(scope.businessDate);
  const [kind, setKind] = useState('');

  const book = useQuery({
    queryKey: ['reports', 'cashbook', scope.scope, range.query, kind],
    queryFn: () =>
      api.get<CashbookDto>(`/reports/cashbook?${range.query}${scope.param}${kind ? `&kind=${kind}` : ''}`),
    enabled: scope.allowed && range.valid,
  });

  if (!scope.allowed) return <PermissionDenied />;
  const d = book.data;
  const cur = d?.currencyCode ?? 'PKR';
  const f = (v: string) => formatAmount(v, cur);

  return (
    <>
      <PageHeader title={t('cbTitle')} subtitle={t('cbSubtitle')} />
      <ReportFilterBar scope={scope} report="cashbook" query={`${range.query}${kind ? `&kind=${kind}` : ''}`}>
        <DateRangeFields range={range} />
        <SelectField label={t('cbKind')} value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="">{t('cbAllKinds')}</option>
          {(['cash', 'bank', 'card_clearing', 'other'] as const).map((k) => (
            <option key={k} value={k}>
              {tCash(`kinds.${k}`)}
            </option>
          ))}
        </SelectField>
      </ReportFilterBar>
      {!range.valid ? null : book.isPending ? (
        <PageSkeleton />
      ) : book.isError ? (
        <PageError error={book.error} onRetry={() => void book.refetch()} />
      ) : (
        <div className="flex flex-col gap-4">
          {d!.reconciled ? (
            <div>
              <StatusBadge tone="success">{t('cbReconciled')}</StatusBadge>
            </div>
          ) : (
            <Alert>{t('cbNotReconciled')}</Alert>
          )}
          {d!.accounts.length === 0 ? (
            <EmptyState message={t('cbEmpty')} />
          ) : (
            d!.accounts.map((a) => (
              <Card key={a.cashAccountId}>
                <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
                  <Link
                    href={`/finance/cash/${a.cashAccountId}`}
                    className="font-semibold text-ink underline decoration-line underline-offset-2"
                  >
                    {a.name}
                  </Link>
                  <span className="text-xs text-muted">
                    {tCash(`kinds.${a.kind}`)} · {t('ledgerAccount', { code: a.ledgerAccountCode })}
                    {!a.active && ` · ${t('inactive')}`}
                  </span>
                </div>
                <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <Figure label={t('opening')} value={f(a.opening)} />
                  <Figure label={t('receipts')} value={f(a.receipts)} />
                  <Figure label={t('payments')} value={f(a.payments)} />
                  <Figure label={t('closing')} value={f(a.closing)} strong />
                </dl>
                {a.days.length > 0 && (
                  <details className="mt-3">
                    <summary className="cursor-pointer text-sm font-medium text-navy-800">
                      {t('cbDays', { count: a.days.length })}
                    </summary>
                    <div className="mt-2 overflow-x-auto">
                      <table className="w-full text-xs sm:text-sm">
                        <thead>
                          <tr className="border-b border-line text-right text-xs text-muted">
                            <th className="py-1 pr-1 sm:pr-2 text-left font-medium">{t('date')}</th>
                            <th className="px-1 py-1 sm:px-2 font-medium">{t('receipts')}</th>
                            <th className="px-1 py-1 sm:px-2 font-medium">{t('payments')}</th>
                            <th className="py-1 pl-1 sm:pl-2 font-medium">{t('closing')}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {a.days.map((day) => (
                            <tr key={day.date} className="border-b border-line/60 text-right">
                              <td className="tabular whitespace-nowrap py-1 pr-1 sm:pr-2 text-left">
                                {day.date}
                              </td>
                              <td className="tabular px-1 sm:px-2 py-1">
                                {isZero(day.receipts) ? '' : f(day.receipts)}
                              </td>
                              <td className="tabular px-1 sm:px-2 py-1">
                                {isZero(day.payments) ? '' : f(day.payments)}
                              </td>
                              <td className="tabular py-1 pl-1 sm:pl-2">{f(day.closing)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </details>
                )}
              </Card>
            ))
          )}
          {d!.accounts.length > 1 && (
            <Card title={t('total')}>
              <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Figure label={t('opening')} value={f(d!.totals.opening)} />
                <Figure label={t('receipts')} value={f(d!.totals.receipts)} />
                <Figure label={t('payments')} value={f(d!.totals.payments)} />
                <Figure label={t('closing')} value={f(d!.totals.closing)} strong />
              </dl>
            </Card>
          )}
          {d!.controls.length > 0 && (
            <Card title={t('cbControls')}>
              <ul className="divide-y divide-line text-sm">
                {d!.controls.map((c) => (
                  <li key={c.accountId} className="py-2">
                    <p className="font-medium text-ink">
                      <span className="tabular">{c.code}</span> {c.name}
                    </p>
                    <dl className="mt-1 grid grid-cols-3 gap-3">
                      <Figure label={t('cbDrawersBanks')} value={f(c.cashAccountsTotal)} />
                      <Figure label={t('cbLedger')} value={f(c.ledgerBalance)} />
                      <Figure
                        label={t('difference')}
                        value={f(c.difference)}
                        strong={!isZero(c.difference)}
                      />
                    </dl>
                  </li>
                ))}
              </ul>
            </Card>
          )}
          <Definitions
            items={[
              [t('receipts'), d!.definitions.receipts ?? ''],
              [t('payments'), d!.definitions.payments ?? ''],
              [t('closing'), d!.definitions.closing ?? ''],
              [t('cbControls'), d!.definitions.controls ?? ''],
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
