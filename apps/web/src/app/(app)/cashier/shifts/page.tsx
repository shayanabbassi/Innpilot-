'use client';

import { SHIFT_FILTERS, type CashierShiftDto, type ShiftFilter } from '@innpilot/contracts';
import { useQuery } from '@tanstack/react-query';
import { useFormatter, useTranslations } from 'next-intl';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { ShiftStatusBadge, VarianceText } from '@/components/cashier';
import { Card, EmptyState, PageError, PageHeader, PageSkeleton, PermissionDenied } from '@/components/ui';
import { api } from '@/lib/api';
import { formatAmount } from '@/lib/finance';
import { useSession } from '@/lib/session';

export default function ShiftsPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Shifts />
    </Suspense>
  );
}

/** Shift history; supervisors see everyone's and the closings waiting for approval. */
function Shifts() {
  const t = useTranslations('cashier');
  const format = useFormatter();
  const { can, property } = useSession();
  const allowed = can('folio.read');
  const supervisor = can('cashier.approve') || can('journal.read');
  const params = useSearchParams();
  const router = useRouter();
  const raw = params.get('status');
  const status: ShiftFilter = (SHIFT_FILTERS as readonly string[]).includes(raw ?? '')
    ? (raw as ShiftFilter)
    : supervisor && can('cashier.approve')
      ? 'awaiting_approval'
      : 'all';
  const shifts = useQuery({
    queryKey: ['cashier', 'shifts', property?.id, status],
    queryFn: () => api.get<CashierShiftDto[]>(`/properties/${property!.id}/cashier-shifts?status=${status}`),
    enabled: allowed && !!property,
  });

  if (!allowed) return <PermissionDenied />;
  const cur = property?.currencyCode ?? 'PKR';

  return (
    <>
      <PageHeader title={supervisor ? t('shiftsTitle') : t('myShiftsTitle')} subtitle={t('shiftsSubtitle')} />
      <div className="mb-4 flex flex-wrap gap-2" role="tablist" aria-label={t('filter')}>
        {SHIFT_FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            role="tab"
            aria-selected={f === status}
            onClick={() => router.replace(`/cashier/shifts?status=${f}`)}
            className={`min-h-10 rounded-full border px-4 text-sm ${
              f === status ? 'border-teal-700 bg-teal-700 text-white' : 'border-line bg-white text-navy-800'
            }`}
          >
            {t(`filters.${f}`)}
          </button>
        ))}
      </div>
      {shifts.isPending ? (
        <PageSkeleton />
      ) : shifts.isError ? (
        <PageError error={shifts.error} onRetry={() => void shifts.refetch()} />
      ) : shifts.data.length === 0 ? (
        <EmptyState message={t('noShifts')} />
      ) : (
        <Card>
          <ul className="divide-y divide-line text-sm">
            {shifts.data.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-3">
                <div className="min-w-0 flex-1">
                  <Link href={`/cashier/shifts/${s.id}`} className="font-medium underline decoration-line">
                    {s.cashAccountName} · {s.userName}
                  </Link>
                  <p className="text-xs text-muted">
                    {format.dateTime(new Date(s.openedAt), { dateStyle: 'medium', timeStyle: 'short' })} ·{' '}
                    {t('expectedShort', { amount: formatAmount(s.expected, cur) })}
                  </p>
                </div>
                {s.closing && (
                  <span className="tabular text-sm">
                    <VarianceText variance={s.closing.variance} currency={cur} />
                  </span>
                )}
                <ShiftStatusBadge shift={s} />
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}
