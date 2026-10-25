'use client';

import type { CashFlowDto } from '@innpilot/contracts';
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import {
  DateRangeFields,
  Definitions,
  ReportFilterBar,
  ReportFootnote,
  useDateRange,
  useReportScope,
} from '@/components/report-filter';
import { Alert, PageError, PageHeader, PageSkeleton, PermissionDenied, StatusBadge } from '@/components/ui';
import { api } from '@/lib/api';
import { formatAmount } from '@/lib/finance';

const isZero = (v: string) => !/[1-9]/.test(v);

export default function CashFlowPage() {
  const t = useTranslations('reports');
  const scope = useReportScope('report.financial');
  const range = useDateRange(scope.businessDate);

  const flow = useQuery({
    queryKey: ['reports', 'cash-flow', scope.scope, range.query],
    queryFn: () => api.get<CashFlowDto>(`/reports/cash-flow?${range.query}${scope.param}`),
    enabled: scope.allowed && range.valid,
  });

  if (!scope.allowed) return <PermissionDenied />;
  const d = flow.data;
  const cur = d?.currencyCode ?? 'PKR';
  const f = (v: string) => formatAmount(v, cur);
  const total = (label: string, amount: string, strong = true) => (
    <tr className={`border-b border-line ${strong ? 'bg-canvas font-semibold' : 'font-medium'}`}>
      <td className="px-3 py-2">{label}</td>
      <td className="tabular px-3 py-2 text-right">{f(amount)}</td>
    </tr>
  );

  return (
    <>
      <PageHeader title={t('cfTitle')} subtitle={t('cfSubtitle')} />
      <ReportFilterBar scope={scope} report="cash-flow" query={range.query}>
        <DateRangeFields range={range} />
      </ReportFilterBar>
      {!range.valid ? null : flow.isPending ? (
        <PageSkeleton />
      ) : flow.isError ? (
        <PageError error={flow.error} onRetry={() => void flow.refetch()} />
      ) : (
        <div className="flex flex-col gap-4">
          {d!.reconciles ? (
            <div>
              <StatusBadge tone="success">{t('cfReconciles')}</StatusBadge>
            </div>
          ) : (
            <Alert>{t('cfNotReconciled')}</Alert>
          )}
          <div className="overflow-x-auto rounded-lg border border-line bg-white">
            <table className="w-full text-sm">
              <tbody>
                {total(t('cfOpening'), d!.openingCash, false)}
                {d!.sections.map((s) => (
                  <SectionRows key={s.key} title={t(`cf_${s.key}`)}>
                    {s.lines.map((l) => (
                      <tr key={l.key} className="border-b border-line/60">
                        <td className="px-3 py-2 pl-6">
                          {t(`cfl_${l.key}`)}
                          {!(isZero(l.inflow) || isZero(l.outflow)) && (
                            <span className="block text-xs text-muted">
                              {t('cfInOut', { inflow: f(l.inflow), outflow: f(l.outflow) })}
                            </span>
                          )}
                        </td>
                        <td className={`tabular px-3 py-2 text-right ${isZero(l.net) ? 'text-muted' : ''}`}>
                          {f(l.net)}
                        </td>
                      </tr>
                    ))}
                    {total(t(`cf_total_${s.key}`), s.net, false)}
                  </SectionRows>
                ))}
                {total(t('cfNetChange'), d!.netChange)}
                {total(t('cfClosing'), d!.closingCash)}
              </tbody>
            </table>
          </div>
          <p className="text-sm text-muted">{t('cfTransfers', { amount: f(d!.transfers) })}</p>
          <Definitions
            items={[
              [t('cfMethod'), d!.definitions.method ?? ''],
              ...d!.sections.flatMap((s) =>
                s.lines.map((l): [string, string] => [t(`cfl_${l.key}`), d!.definitions[l.key] ?? '']),
              ),
              [t('cfTransfersLabel'), d!.definitions.transfers ?? ''],
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
          colSpan={2}
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
