'use client';

import type { BalanceSheetDto, BsSection } from '@innpilot/contracts';
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useState } from 'react';
import { Definitions, ReportFilterBar, ReportFootnote, useReportScope } from '@/components/report-filter';
import {
  Alert,
  PageError,
  PageHeader,
  PageSkeleton,
  PermissionDenied,
  StatusBadge,
  TextField,
} from '@/components/ui';
import { api } from '@/lib/api';
import { formatAmount } from '@/lib/finance';

const isZero = (v: string) => !/[1-9]/.test(v);

export default function BalanceSheetPage() {
  const t = useTranslations('reports');
  const scope = useReportScope('report.financial');
  const [asOf, setAsOf] = useState(scope.businessDate);

  const bs = useQuery({
    queryKey: ['reports', 'balance-sheet', scope.scope, asOf],
    queryFn: () => api.get<BalanceSheetDto>(`/reports/balance-sheet?asOf=${asOf}${scope.param}`),
    enabled: scope.allowed && !!asOf,
  });

  if (!scope.allowed) return <PermissionDenied />;
  const d = bs.data;
  const cur = d?.currencyCode ?? 'PKR';
  const section = (key: BsSection) => d!.sections.find((s) => s.key === key)!;
  const yearStart = `${asOf.slice(0, 4)}-01-01`;
  const cell = 'tabular px-3 py-2 text-right';

  const rows = (key: BsSection) =>
    section(key).rows.map((r) => (
      <tr key={r.accountId} className="border-b border-line/60">
        <td className="px-3 py-2 pl-6">
          <Link
            href={`/finance/ledger?accountId=${r.accountId}&from=${yearStart}&to=${asOf}`}
            className="underline decoration-line underline-offset-2"
          >
            <span className="tabular">{r.code}</span> {r.name}
          </Link>
        </td>
        <td className={cell}>{formatAmount(r.amount, cur)}</td>
      </tr>
    ));
  const line = (label: string, amount: string, tone: 'sub' | 'total' | 'plain' = 'sub') => (
    <tr
      className={`border-b border-line ${tone === 'total' ? 'bg-canvas font-semibold' : tone === 'sub' ? 'font-medium' : ''}`}
    >
      <td className={`px-3 py-2 ${tone === 'plain' ? 'pl-6' : ''}`}>{label}</td>
      <td className={cell}>{formatAmount(amount, cur)}</td>
    </tr>
  );
  const heading = (label: string) => (
    <tr className="border-b border-line/60">
      <th
        colSpan={2}
        scope="colgroup"
        className="px-3 pb-1 pt-3 text-left text-xs font-semibold uppercase text-muted"
      >
        {label}
      </th>
    </tr>
  );
  const block = (key: BsSection) =>
    section(key).rows.length > 0 && (
      <>
        {heading(t(`bs_${key}`))}
        {rows(key)}
        {line(t(`bs_total_${key}`), section(key).total)}
      </>
    );

  return (
    <>
      <PageHeader title={t('bsTitle')} subtitle={t('bsSubtitle')} />
      <ReportFilterBar scope={scope} report="balance-sheet" query={`asOf=${asOf}`}>
        <TextField label={t('asOf')} type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
      </ReportFilterBar>
      {!asOf ? null : bs.isPending ? (
        <PageSkeleton />
      ) : bs.isError ? (
        <PageError error={bs.error} onRetry={() => void bs.refetch()} />
      ) : (
        <div className="flex flex-col gap-4">
          {d!.balanced ? (
            <div>
              <StatusBadge tone="success">{t('bsBalanced')}</StatusBadge>
            </div>
          ) : (
            <Alert>{t('bsNotBalanced', { difference: formatAmount(d!.difference, cur) })}</Alert>
          )}
          <div className="grid gap-4 lg:grid-cols-2 lg:items-start">
            <div className="overflow-x-auto rounded-lg border border-line bg-white">
              <table className="w-full min-w-[20rem] text-sm">
                <tbody>
                  {block('current_asset')}
                  {block('non_current_asset')}
                  {line(t('totalAssets'), d!.totalAssets, 'total')}
                </tbody>
              </table>
            </div>
            <div className="overflow-x-auto rounded-lg border border-line bg-white">
              <table className="w-full min-w-[20rem] text-sm">
                <tbody>
                  {block('current_liability')}
                  {block('non_current_liability')}
                  {line(t('totalLiabilities'), d!.totalLiabilities)}
                  {heading(t('bs_equity'))}
                  {rows('equity')}
                  {line(t('currentYearResult', { year: asOf.slice(0, 4) }), d!.currentYearResult, 'plain')}
                  {!isZero(d!.earlierYearsResult) &&
                    line(t('earlierYearsResult'), d!.earlierYearsResult, 'plain')}
                  {line(t('bs_total_equity'), d!.totalEquity)}
                  {line(t('totalLiabilitiesAndEquity'), d!.totalLiabilitiesAndEquity, 'total')}
                </tbody>
              </table>
            </div>
          </div>
          {!isZero(d!.earlierYearsResult) && <Alert tone="warning">{t('earlierYearsNote')}</Alert>}
          <Definitions
            items={[
              [t('totalAssets'), d!.definitions.totalAssets ?? ''],
              [t('totalLiabilities'), d!.definitions.totalLiabilities ?? ''],
              [t('currentYearResult', { year: asOf.slice(0, 4) }), d!.definitions.currentYearResult ?? ''],
              [t('earlierYearsResult'), d!.definitions.earlierYearsResult ?? ''],
              [t('bs_total_equity'), d!.definitions.totalEquity ?? ''],
              [t('difference'), d!.definitions.difference ?? ''],
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
