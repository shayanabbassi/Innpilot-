'use client';

import { AGING_BUCKETS, type AgingBucket } from '@innpilot/contracts';
import { useTranslations } from 'next-intl';
import { Card, StatusBadge } from '@/components/ui';
import { formatAmount } from '@/lib/finance';
import { Figure } from './report-filter';

type Totals = Record<AgingBucket | 'total', string>;

const TONE: Record<AgingBucket, 'neutral' | 'success' | 'warning' | 'danger'> = {
  current: 'success',
  d1_30: 'neutral',
  d31_60: 'warning',
  d61_90: 'warning',
  over_90: 'danger',
};

/** The D14 bucket of an item, with its days. */
export function BucketBadge({ bucket, days }: { bucket: AgingBucket; days: number }) {
  const t = useTranslations('reports');
  return (
    <StatusBadge tone={TONE[bucket]}>
      {t(`bucket_${bucket}`)}
      {days > 0 && ` · ${t('daysShort', { days })}`}
    </StatusBadge>
  );
}

/** Totals per bucket: two columns on a phone, one row on a wide screen. */
export function BucketTotals({
  totals,
  currency,
  title,
}: {
  totals: Totals;
  currency: string;
  title?: string;
}) {
  const t = useTranslations('reports');
  return (
    <Card title={title}>
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {AGING_BUCKETS.map((b) => (
          <Figure key={b} label={t(`bucket_${b}`)} value={formatAmount(totals[b], currency)} />
        ))}
        <Figure label={t('total')} value={formatAmount(totals.total, currency)} strong />
      </dl>
    </Card>
  );
}

/** Each ledger account against the items aged from it; what is not linked is shown, never hidden. */
export function LedgerTie({
  rows,
  currency,
}: {
  rows: {
    accountId: string;
    code: string;
    name: string;
    ledgerBalance: string;
    aged: string;
    notLinked: string;
  }[];
  currency: string;
}) {
  const t = useTranslations('reports');
  const f = (v: string) => formatAmount(v, currency);
  return (
    <Card title={t('agingTie')}>
      <ul className="divide-y divide-line text-sm">
        {rows.map((r) => (
          <li key={r.accountId} className="py-2">
            <p className="font-medium text-ink">
              <span className="tabular">{r.code}</span> {r.name}
            </p>
            <dl className="mt-1 grid grid-cols-3 gap-3">
              <Figure label={t('cbLedger')} value={f(r.ledgerBalance)} />
              <Figure label={t('agingAged')} value={f(r.aged)} />
              <Figure label={t('agingNotLinked')} value={f(r.notLinked)} strong={/[1-9]/.test(r.notLinked)} />
            </dl>
          </li>
        ))}
      </ul>
    </Card>
  );
}
