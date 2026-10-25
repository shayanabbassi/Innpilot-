'use client';

import type { OccupancyDto } from '@innpilot/contracts';
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
import { Card, PageError, PageHeader, PageSkeleton, PermissionDenied, StatusBadge } from '@/components/ui';
import { api } from '@/lib/api';
import { formatAmount } from '@/lib/finance';

export default function OccupancyPage() {
  const t = useTranslations('reports');
  const scope = useReportScope('report.operational');
  const range = useDateRange(scope.businessDate);

  const occ = useQuery({
    queryKey: ['reports', 'occupancy', scope.scope, range.query],
    queryFn: () => api.get<OccupancyDto>(`/reports/occupancy?${range.query}${scope.param}`),
    enabled: scope.allowed && range.valid,
  });

  if (!scope.allowed) return <PermissionDenied />;
  const d = occ.data;
  const cur = d?.currencyCode ?? 'PKR';
  const f = (v: string | null) => (v === null ? '—' : formatAmount(v, cur));
  const pct = (v: string | null) => (v === null ? '—' : `${v}%`);
  const cell = 'tabular px-1 py-2 text-right sm:px-2';

  return (
    <>
      <PageHeader title={t('occTitle')} subtitle={t('occSubtitle')} />
      <ReportFilterBar scope={scope} report="occupancy" query={range.query}>
        <DateRangeFields range={range} />
      </ReportFilterBar>
      {!range.valid ? null : occ.isPending ? (
        <PageSkeleton />
      ) : occ.isError ? (
        <PageError error={occ.error} onRetry={() => void occ.refetch()} />
      ) : (
        <div className="flex flex-col gap-4">
          <Card title={t('occActualTotals')}>
            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
              <Figure label={t('occAvailable')} value={String(d!.totals.available)} />
              <Figure label={t('occSold')} value={String(d!.totals.sold)} />
              <Figure label={t('occOccupancy')} value={pct(d!.totals.occupancy)} strong />
              <Figure label={t('occRoomRevenue')} value={f(d!.totals.roomRevenue)} />
              <Figure label={t('occAdr')} value={f(d!.totals.adr)} strong />
              <Figure label={t('occRevpar')} value={f(d!.totals.revpar)} strong />
            </dl>
          </Card>
          <div className="overflow-x-auto rounded-lg border border-line bg-white">
            <table className="w-full text-xs sm:text-sm">
              <thead>
                <tr className="border-b border-line text-right text-muted">
                  <th className="px-1 py-2 text-left font-medium sm:px-2">{t('occNight')}</th>
                  <th className="px-1 py-2 font-medium sm:px-2">{t('occAvailableShort')}</th>
                  <th className="px-1 py-2 font-medium sm:px-2">{t('occSoldShort')}</th>
                  <th className="px-1 py-2 font-medium sm:px-2">%</th>
                  <th className="hidden px-1 py-2 font-medium sm:table-cell sm:px-2">
                    {t('occRoomRevenue')}
                  </th>
                  <th className="px-1 py-2 font-medium sm:px-2">{t('occAdr')}</th>
                  <th className="hidden px-1 py-2 font-medium sm:table-cell sm:px-2">{t('occRevpar')}</th>
                </tr>
              </thead>
              <tbody>
                {d!.nights.map((n) => (
                  <tr
                    key={n.night}
                    className={`border-b border-line/60 ${n.basis === 'actual' ? '' : 'text-muted'}`}
                  >
                    <td className="whitespace-nowrap px-1 py-2 sm:px-2">
                      <span className="tabular">{n.night}</span>
                      {n.basis === 'on_the_books' && (
                        <span className="ml-1 hidden sm:inline">
                          <StatusBadge tone="neutral">{t('occOnTheBooks')}</StatusBadge>
                        </span>
                      )}
                      {n.outOfService > 0 && (
                        <span className="block text-xs text-muted">
                          {t('occOoo', { count: n.outOfService })}
                        </span>
                      )}
                    </td>
                    <td className={cell}>{n.available}</td>
                    <td className={cell}>{n.sold}</td>
                    <td className={cell}>{pct(n.occupancy)}</td>
                    <td className={`${cell} hidden sm:table-cell`}>
                      {n.basis === 'actual' ? f(n.roomRevenue) : '—'}
                    </td>
                    <td className={cell}>{f(n.adr)}</td>
                    <td className={`${cell} hidden sm:table-cell`}>{f(n.revpar)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-muted">{t('occBasisNote')}</p>
          <Definitions
            items={[
              [t('occAvailable'), d!.definitions.available ?? ''],
              [t('occSold'), d!.definitions.sold ?? ''],
              [t('occOccupancy'), d!.definitions.occupancy ?? ''],
              [t('occRoomRevenue'), d!.definitions.roomRevenue ?? ''],
              [t('occAdr'), d!.definitions.adr ?? ''],
              [t('occRevpar'), d!.definitions.revpar ?? ''],
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
