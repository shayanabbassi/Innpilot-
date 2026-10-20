'use client';

import type { NightAuditSummaryDto } from '@innpilot/contracts';
import { useTranslations } from 'next-intl';
import { formatAmount } from '@/lib/finance';

/** The day's figures as the night audit stores them: read from the ledger and the source records. */
export function NightAuditSummary({
  summary,
  currency,
}: {
  summary: NightAuditSummaryDto;
  currency: string;
}) {
  const t = useTranslations('nightAudit');
  const row = (label: string, value: string, strong = false) => (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <dt className="text-muted">{label}</dt>
      <dd className={`tabular text-right ${strong ? 'font-semibold' : ''}`}>{value}</dd>
    </div>
  );
  const money = (v: string) => formatAmount(v, currency);
  return (
    <div className="flex flex-col gap-4 text-sm">
      <section>
        <h3 className="mb-1 font-medium text-ink">{t('revenue')}</h3>
        <dl className="divide-y divide-line">
          {summary.revenue.length === 0 && <p className="py-1 text-muted">{t('noRevenue')}</p>}
          {summary.revenue.map((r) => row(`${r.accountCode} ${r.accountName}`, money(r.amount)))}
          {row(t('revenueTotal'), money(summary.revenueTotal), true)}
        </dl>
        {summary.accrued.nights > 0 && (
          <p className="mt-1 text-xs text-muted">
            {t('accruedNote', { nights: summary.accrued.nights, amount: money(summary.accrued.net) })}
          </p>
        )}
      </section>
      <section>
        <h3 className="mb-1 font-medium text-ink">{t('rooms')}</h3>
        <dl className="divide-y divide-line">
          {row(
            t('occupancy'),
            t('occupancyValue', {
              occupied: summary.occupancy.occupied,
              sellable: summary.occupancy.sellable,
              percent: summary.occupancy.percent,
            }),
          )}
          {row(t('arrivals'), String(summary.arrivals))}
          {row(t('departures'), String(summary.departures))}
          {row(t('inHouse'), String(summary.inHouse))}
        </dl>
      </section>
      <section>
        <h3 className="mb-1 font-medium text-ink">{t('money')}</h3>
        <dl className="divide-y divide-line">
          {summary.receipts.length === 0 && <p className="py-1 text-muted">{t('noReceipts')}</p>}
          {summary.receipts.map((r) => row(t(`methods.${r.method}` as never), money(r.amount)))}
          {row(t('refunds'), money(summary.refunds))}
          {row(
            t('cashOutsideShift'),
            summary.cashOutsideShift.lines === 0
              ? t('none')
              : t('cashOutsideShiftValue', {
                  lines: summary.cashOutsideShift.lines,
                  in: money(summary.cashOutsideShift.in),
                  out: money(summary.cashOutsideShift.out),
                }),
          )}
          {summary.cashierVariances.map((v) =>
            row(t('variance', { drawer: v.drawer, cashier: v.cashier }), money(v.variance)),
          )}
        </dl>
      </section>
      <section>
        <h3 className="mb-1 font-medium text-ink">{t('followUp')}</h3>
        <dl className="divide-y divide-line">
          {row(
            t('foliosOnAccount'),
            t('countAmount', {
              count: summary.foliosOnAccount.count,
              amount: money(summary.foliosOnAccount.balance),
            }),
          )}
          {row(
            t('depositsToRefund'),
            t('countAmount', {
              count: summary.depositsToRefund.count,
              amount: money(summary.depositsToRefund.amount),
            }),
          )}
        </dl>
      </section>
    </div>
  );
}
