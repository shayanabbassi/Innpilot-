'use client';

import type { Comparison, ProfitLossDto } from '@innpilot/contracts';
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import { Definitions, ReportFilterBar, ReportFootnote, useReportScope } from '@/components/report-filter';
import {
  EmptyState,
  PageError,
  PageHeader,
  PageSkeleton,
  PermissionDenied,
  SelectField,
  TextField,
} from '@/components/ui';
import { api } from '@/lib/api';
import { formatAmount, monthRange } from '@/lib/finance';

export default function ProfitLossPage() {
  const t = useTranslations('reports');
  const scope = useReportScope('report.financial');
  const initial = monthRange(scope.businessDate);
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [compare, setCompare] = useState<Comparison>('none');
  const valid = !!from && !!to && from <= to;

  const pl = useQuery({
    queryKey: ['reports', 'profit-loss', scope.scope, from, to, compare],
    queryFn: () =>
      api.get<ProfitLossDto>(`/reports/profit-loss?from=${from}&to=${to}&compare=${compare}${scope.param}`),
    enabled: scope.allowed && valid,
  });

  if (!scope.allowed) return <PermissionDenied />;
  const d = pl.data;
  const cur = d?.currencyCode ?? 'PKR';
  const withCmp = !!d && d.compare !== 'none';
  const ledger = (accountId: string) => `/finance/ledger?accountId=${accountId}&from=${from}&to=${to}`;
  const cell = 'tabular px-3 py-2 text-right';
  const total = (label: string, f: { amount: string; comparison: string | null }, strong = false) => (
    <tr className={`border-b border-line ${strong ? 'bg-canvas font-semibold' : 'font-medium'}`}>
      <td className="px-3 py-2">{label}</td>
      <td className={cell}>{formatAmount(f.amount, cur)}</td>
      {withCmp && <td className={cell}>{f.comparison === null ? '' : formatAmount(f.comparison, cur)}</td>}
    </tr>
  );

  return (
    <>
      <PageHeader title={t('plTitle')} subtitle={t('plSubtitle')} />
      <ReportFilterBar scope={scope} report="profit-loss" query={`from=${from}&to=${to}&compare=${compare}`}>
        <TextField label={t('from')} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        <TextField
          label={t('to')}
          type="date"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          error={valid ? undefined : t('rangeError')}
        />
        <SelectField
          label={t('compare')}
          value={compare}
          onChange={(e) => setCompare(e.target.value as Comparison)}
        >
          <option value="none">{t('compare_none')}</option>
          <option value="previous_period">{t('compare_previous_period')}</option>
          <option value="previous_year">{t('compare_previous_year')}</option>
        </SelectField>
      </ReportFilterBar>
      {!valid ? null : pl.isPending ? (
        <PageSkeleton />
      ) : pl.isError ? (
        <PageError error={pl.error} onRetry={() => void pl.refetch()} />
      ) : (
        <div className="flex flex-col gap-4">
          {d!.sections.every((s) => s.rows.length === 0) ? (
            <EmptyState message={t('plEmpty')} />
          ) : (
            <div className="overflow-x-auto rounded-lg border border-line bg-white">
              <table className="w-full min-w-[20rem] text-sm">
                {withCmp && (
                  <caption className="px-3 pt-2 text-left text-xs text-muted">
                    {t('comparedWith', {
                      from: d!.from,
                      to: d!.to,
                      cFrom: d!.comparisonFrom!,
                      cTo: d!.comparisonTo!,
                    })}
                  </caption>
                )}
                <thead>
                  <tr className="border-b border-line text-muted">
                    <th className="px-3 py-2 text-left font-medium">{t('account')}</th>
                    <th className="px-3 py-2 text-right font-medium">
                      {withCmp ? t('periodCol') : t('rangeLabel', { from: d!.from, to: d!.to })}
                    </th>
                    {withCmp && <th className="px-3 py-2 text-right font-medium">{t('comparisonCol')}</th>}
                  </tr>
                </thead>
                <tbody>
                  {d!.sections.map((s) => (
                    <SectionRows key={s.key} title={t(`pl_${s.key}`)}>
                      {s.rows.map((r) => (
                        <tr key={r.accountId} className="border-b border-line/60">
                          <td className="px-3 py-2 pl-6">
                            <Link
                              href={ledger(r.accountId)}
                              className="underline decoration-line underline-offset-2"
                            >
                              <span className="tabular">{r.code}</span> {r.name}
                            </Link>
                          </td>
                          <td className={cell}>{formatAmount(r.amount, cur)}</td>
                          {withCmp && <td className={cell}>{formatAmount(r.comparison ?? '0', cur)}</td>}
                        </tr>
                      ))}
                      {total(t(`pl_total_${s.key}`), s.total)}
                      {s.key === 'cost_of_sales' && total(t('grossProfit'), d!.grossProfit, true)}
                      {s.key === 'operating_expense' && total(t('operatingProfit'), d!.operatingProfit, true)}
                    </SectionRows>
                  ))}
                  {total(t('netProfit'), d!.netProfit, true)}
                </tbody>
              </table>
            </div>
          )}
          <Definitions
            items={[
              [t('pl_revenue'), d!.definitions.revenue ?? ''],
              [t('pl_cost_of_sales'), d!.definitions.cost_of_sales ?? ''],
              [t('pl_operating_expense'), d!.definitions.operating_expense ?? ''],
              [t('pl_other'), d!.definitions.other ?? ''],
              [t('grossProfit'), d!.definitions.grossProfit ?? ''],
              [t('operatingProfit'), d!.definitions.operatingProfit ?? ''],
              [t('netProfit'), d!.definitions.netProfit ?? ''],
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

function SectionRows({ title, children }: { title: string; children: ReactNode }) {
  return (
    <>
      <tr className="border-b border-line/60">
        <th
          colSpan={3}
          scope="colgroup"
          className="px-3 pb-1 pt-3 text-left text-xs font-semibold uppercase text-muted"
        >
          {title}
        </th>
      </tr>
      {children}
    </>
  );
}
