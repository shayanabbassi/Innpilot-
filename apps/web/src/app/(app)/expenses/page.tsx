'use client';

import { EXPENSE_FILTERS, type ExpenseDto, type ExpenseFilter } from '@innpilot/contracts';
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { ExpenseStatusBadge } from '@/components/expense-status';
import { Card, EmptyState, PageError, PageHeader, PageSkeleton, PermissionDenied } from '@/components/ui';
import { api } from '@/lib/api';
import { formatAmount } from '@/lib/finance';
import { useSession } from '@/lib/session';

export default function ExpensesPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Expenses />
    </Suspense>
  );
}

function Expenses() {
  const t = useTranslations('expenses');
  const { can, property } = useSession();
  const allowed = can('expense.write');
  const params = useSearchParams();
  const router = useRouter();
  const raw = params.get('status');
  const status: ExpenseFilter = (EXPENSE_FILTERS as readonly string[]).includes(raw ?? '')
    ? (raw as ExpenseFilter)
    : can('expense.approve')
      ? 'to_approve'
      : 'all';
  const expenses = useQuery({
    queryKey: ['expenses', property?.id, status],
    queryFn: () => api.get<ExpenseDto[]>(`/properties/${property!.id}/expenses?status=${status}`),
    enabled: allowed && !!property,
  });

  if (!allowed) return <PermissionDenied />;
  const cur = property?.currencyCode ?? 'PKR';

  return (
    <>
      <PageHeader
        title={t('title')}
        subtitle={t('subtitle')}
        actions={
          <Link
            href="/expenses/new"
            className="inline-flex min-h-10 items-center rounded-md bg-teal-700 px-4 text-sm font-medium text-white hover:bg-teal-800"
          >
            {t('newExpense')}
          </Link>
        }
      />
      <div className="mb-4 flex flex-wrap gap-2" role="tablist" aria-label={t('filter')}>
        {EXPENSE_FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            role="tab"
            aria-selected={f === status}
            onClick={() => router.replace(`/expenses?status=${f}`)}
            className={`min-h-10 rounded-full border px-4 text-sm ${
              f === status ? 'border-teal-700 bg-teal-700 text-white' : 'border-line bg-white text-navy-800'
            }`}
          >
            {t(`filters.${f}`)}
          </button>
        ))}
      </div>
      {expenses.isPending ? (
        <PageSkeleton />
      ) : expenses.isError ? (
        <PageError error={expenses.error} onRetry={() => void expenses.refetch()} />
      ) : expenses.data.length === 0 ? (
        <EmptyState message={t('none')} />
      ) : (
        <Card>
          <ul className="divide-y divide-line text-sm">
            {expenses.data.map((e) => (
              <li key={e.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-3">
                <div className="min-w-0 flex-1">
                  <Link href={`/expenses/${e.id}`} className="font-medium underline decoration-line">
                    {e.voucherNumber} · {e.supplierName ?? e.payee ?? t(`kinds.${e.kind}`)}
                  </Link>
                  <p className="truncate text-xs text-muted">
                    {e.expenseDate} · {e.description}
                  </p>
                </div>
                <span className="tabular font-medium">{formatAmount(e.totalAmount, cur)}</span>
                <ExpenseStatusBadge expense={e} />
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}
