'use client';

import type { CashClosingDto, CashierShiftDto, ShiftMovementDto } from '@innpilot/contracts';
import { Money } from '@innpilot/money';
import { useFormatter, useTranslations } from 'next-intl';
import Link from 'next/link';
import { Card, StatusBadge } from '@/components/ui';
import { formatAmount } from '@/lib/finance';

/** Signed variance shown as short/over, never just a minus sign. */
export function VarianceText({ variance, currency }: { variance: string; currency: string }) {
  const t = useTranslations('cashier');
  const v = Money.of(variance, currency);
  if (v.isZero()) return <span className="text-success">{t('noVariance')}</span>;
  return (
    <span className={v.isNegative() ? 'text-danger' : 'text-warning'}>
      {t(v.isNegative() ? 'short' : 'over', { amount: formatAmount(v.abs().toString(), currency) })}
    </span>
  );
}

export function closingTone(c: CashClosingDto | null): 'neutral' | 'success' | 'warning' {
  if (!c) return 'neutral';
  return c.status === 'approved' ? 'success' : c.status === 'submitted' ? 'warning' : 'neutral';
}

/** Short state of a shift for lists and headers. */
export function ShiftStatusBadge({ shift }: { shift: CashierShiftDto }) {
  const t = useTranslations('cashier');
  if (shift.status === 'open') return <StatusBadge tone="success">{t('statusOpen')}</StatusBadge>;
  if (shift.closing?.status === 'submitted')
    return <StatusBadge tone="warning">{t('statusAwaiting')}</StatusBadge>;
  return <StatusBadge tone="neutral">{t('statusClosed')}</StatusBadge>;
}

export function ShiftSummary({ shift, currency }: { shift: CashierShiftDto; currency: string }) {
  const t = useTranslations('cashier');
  const format = useFormatter();
  const diff = Money.of(shift.openingDifference, currency);
  const row = (label: string, value: React.ReactNode, strong = false) => (
    <div className="flex items-baseline justify-between gap-3 py-1.5">
      <dt className="text-muted">{label}</dt>
      <dd className={`tabular text-right ${strong ? 'text-base font-semibold' : ''}`}>{value}</dd>
    </div>
  );
  return (
    <Card>
      <p className="mb-2 text-sm text-muted">
        {t('openedBy', {
          name: shift.userName,
          drawer: shift.cashAccountName,
          time: format.dateTime(new Date(shift.openedAt), { dateStyle: 'medium', timeStyle: 'short' }),
        })}
      </p>
      <dl className="divide-y divide-line text-sm">
        {row(t('openingCount'), formatAmount(shift.openingCount, currency))}
        {row(t('cashIn'), formatAmount(shift.cashIn, currency))}
        {row(t('cashOut'), formatAmount(shift.cashOut, currency))}
        {row(t('expected'), formatAmount(shift.expected, currency), true)}
      </dl>
      {!diff.isZero() && (
        <p className="mt-2 text-xs text-warning">
          {t('openingDifference', {
            book: formatAmount(shift.bookBalanceAtOpen, currency),
            count: formatAmount(shift.openingCount, currency),
          })}
        </p>
      )}
    </Card>
  );
}

export function ClosingCard({
  closing,
  currency,
  title,
  linkJournals,
}: {
  closing: CashClosingDto;
  currency: string;
  title?: string;
  linkJournals: boolean;
}) {
  const t = useTranslations('cashier');
  const format = useFormatter();
  const when = (iso: string) => format.dateTime(new Date(iso), { dateStyle: 'medium', timeStyle: 'short' });
  return (
    <Card title={title ?? t('closing')}>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <StatusBadge tone={closingTone(closing)}>{t(`closingStatus.${closing.status}`)}</StatusBadge>
        {closing.approvalRequired && closing.status === 'submitted' && (
          <span className="text-sm text-muted">
            {t('aboveThreshold', { threshold: formatAmount(closing.threshold, currency) })}
          </span>
        )}
      </div>
      <dl className="divide-y divide-line text-sm">
        <div className="flex justify-between gap-3 py-1.5">
          <dt className="text-muted">{t('expected')}</dt>
          <dd className="tabular">{formatAmount(closing.expectedAmount, currency)}</dd>
        </div>
        <div className="flex justify-between gap-3 py-1.5">
          <dt className="text-muted">{t('counted')}</dt>
          <dd className="tabular">{formatAmount(closing.countedAmount, currency)}</dd>
        </div>
        <div className="flex justify-between gap-3 py-1.5">
          <dt className="text-muted">{t('variance')}</dt>
          <dd className="tabular font-medium">
            <VarianceText variance={closing.variance} currency={currency} />
          </dd>
        </div>
      </dl>
      {closing.explanation && (
        <p className="mt-3 text-sm">
          <span className="text-muted">{t('explanation')}: </span>
          {closing.explanation}
        </p>
      )}
      <ul className="mt-3 flex flex-col gap-1 text-xs text-muted">
        <li>{t('submittedBy', { name: closing.submittedByName ?? '—', time: when(closing.submittedAt) })}</li>
        {closing.approvedAt && (
          <li>
            {t('approvedBy', { name: closing.approvedByName ?? '—', time: when(closing.approvedAt) })}
            {closing.approvalNote ? ` · ${closing.approvalNote}` : ''}
          </li>
        )}
        {closing.status === 'approved' && !closing.approvedAt && <li>{t('autoApproved')}</li>}
        {linkJournals && closing.varianceJournalEntryId && (
          <li>
            <Link
              href={`/finance/journals/${closing.varianceJournalEntryId}`}
              className="text-teal-700 underline"
            >
              {t('varianceJournal', { n: closing.varianceJournalNumber ?? 0 })}
            </Link>
          </li>
        )}
        {closing.reopenedAt && (
          <li>
            {t('reopenedBy', {
              name: closing.reopenedByName ?? '—',
              time: when(closing.reopenedAt),
              reason: closing.reopenReason ?? '',
            })}
          </li>
        )}
      </ul>
    </Card>
  );
}

/** Journal links only for people who can read the ledger. */
export function MovementList({
  movements,
  currency,
  linkJournals,
}: {
  movements: ShiftMovementDto[];
  currency: string;
  linkJournals: boolean;
}) {
  const t = useTranslations('cashier');
  return (
    <Card title={t('movements')}>
      {movements.length === 0 ? (
        <p className="text-sm text-muted">{t('noMovements')}</p>
      ) : (
        <ul className="divide-y divide-line text-sm">
          {movements.map((m, i) => (
            <li key={`${m.entryId}-${i}`} className="flex items-baseline gap-3 py-2">
              <span className="min-w-0 flex-1">
                {m.narration}
                {linkJournals && m.journalNumber !== null && (
                  <Link
                    href={`/finance/journals/${m.entryId}`}
                    className="ml-1 text-xs text-teal-700 underline"
                  >
                    #{m.journalNumber}
                  </Link>
                )}
              </span>
              <span className={`tabular font-medium ${/[1-9]/.test(m.in) ? 'text-success' : ''}`}>
                {/[1-9]/.test(m.in)
                  ? `+${formatAmount(m.in, currency)}`
                  : `−${formatAmount(m.out, currency)}`}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
