'use client';

import type { CashMovementsDto } from '@innpilot/contracts';
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import {
  Card,
  EmptyState,
  PageError,
  PageHeader,
  PageSkeleton,
  PermissionDenied,
  TextField,
} from '@/components/ui';
import { api } from '@/lib/api';
import { formatAmount, monthRange } from '@/lib/finance';
import { useSession } from '@/lib/session';

export default function CashMovementsPage() {
  // useSearchParams needs a Suspense boundary for static rendering.
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Movements />
    </Suspense>
  );
}

function Movements() {
  const t = useTranslations('cash');
  const tFinance = useTranslations('finance');
  const { id } = useParams<{ id: string }>();
  const { can, property } = useSession();
  const allowed = can('journal.read');
  const params = useSearchParams();
  const router = useRouter();
  const month = monthRange(property?.businessDate ?? new Date().toISOString().slice(0, 10));
  const from = params.get('from') ?? month.from;
  const to = params.get('to') ?? month.to;
  const valid = !!from && !!to && from <= to;

  const movements = useQuery({
    queryKey: ['finance', 'cash-movements', id, from, to],
    queryFn: () =>
      api.get<CashMovementsDto>(
        `/properties/${property!.id}/cash-accounts/${id}/movements?from=${from}&to=${to}`,
      ),
    enabled: allowed && valid && !!property,
  });

  if (!allowed) return <PermissionDenied />;
  const go = (next: { from?: string; to?: string }) => {
    const q = new URLSearchParams({ from, to, ...next });
    router.replace(`/finance/cash/${id}?${q.toString()}`);
  };
  const cur = property?.currencyCode ?? 'PKR';
  const m = movements.data;

  return (
    <>
      <PageHeader
        title={m ? t('movementsTitle', { name: m.account.name }) : t('movements')}
        subtitle={t('movementsSubtitle')}
      />
      <p className="mb-4 text-sm">
        <Link href="/finance/cash" className="text-teal-700 underline">
          {t('allAccounts')}
        </Link>
      </p>
      <Card className="mb-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            label={tFinance('from')}
            type="date"
            value={from}
            onChange={(e) => go({ from: e.target.value })}
          />
          <TextField
            label={tFinance('to')}
            type="date"
            value={to}
            onChange={(e) => go({ to: e.target.value })}
            error={from <= to ? undefined : tFinance('rangeError')}
          />
        </div>
      </Card>
      {!valid ? null : movements.isPending ? (
        <PageSkeleton />
      ) : movements.isError ? (
        <PageError error={movements.error} onRetry={() => void movements.refetch()} />
      ) : m!.lines.length === 0 && m!.openingBalance === '0.00' ? (
        <EmptyState message={t('noMovements')} />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line bg-white">
          <table className="w-full min-w-[40rem] text-sm">
            <thead>
              <tr className="border-b border-line text-left text-muted">
                <th className="px-3 py-2 font-medium">{t('date')}</th>
                <th className="px-3 py-2 font-medium">{t('journal')}</th>
                <th className="px-3 py-2 font-medium">{t('description')}</th>
                <th className="px-3 py-2 text-right font-medium">{t('in')}</th>
                <th className="px-3 py-2 text-right font-medium">{t('out')}</th>
                <th className="px-3 py-2 text-right font-medium">{t('balance')}</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-b border-line/60 text-muted">
                <td className="tabular px-3 py-2">{from}</td>
                <td className="px-3 py-2" colSpan={4}>
                  {t('openingBalance')}
                </td>
                <td className="tabular px-3 py-2 text-right">{formatAmount(m!.openingBalance, cur)}</td>
              </tr>
              {m!.lines.map((l, i) => (
                <tr key={`${l.entryId}-${i}`} className="border-b border-line/60 align-top">
                  <td className="tabular px-3 py-2">{l.accountingDate}</td>
                  <td className="px-3 py-2">
                    <Link href={`/finance/journals/${l.entryId}`} className="tabular text-teal-700 underline">
                      {tFinance('journalNo', { n: l.journalNumber })}
                    </Link>
                  </td>
                  <td className="px-3 py-2">
                    {l.narration}
                    {l.description && <p className="text-xs text-muted">{l.description}</p>}
                  </td>
                  <td className="tabular px-3 py-2 text-right">
                    {/[1-9]/.test(l.in) ? formatAmount(l.in, cur) : ''}
                  </td>
                  <td className="tabular px-3 py-2 text-right">
                    {/[1-9]/.test(l.out) ? formatAmount(l.out, cur) : ''}
                  </td>
                  <td className="tabular px-3 py-2 text-right">{formatAmount(l.balance, cur)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="font-semibold">
                <td className="px-3 py-2" colSpan={3}>
                  {t('closingBalance')}
                </td>
                <td className="tabular px-3 py-2 text-right">{formatAmount(m!.totalIn, cur)}</td>
                <td className="tabular px-3 py-2 text-right">{formatAmount(m!.totalOut, cur)}</td>
                <td className="tabular px-3 py-2 text-right">{formatAmount(m!.closingBalance, cur)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </>
  );
}
