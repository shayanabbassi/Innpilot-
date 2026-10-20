'use client';

import type { TrialBalanceDto } from '@innpilot/contracts';
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useState } from 'react';
import {
  Alert,
  Card,
  EmptyState,
  PageError,
  PageHeader,
  PageSkeleton,
  PermissionDenied,
  StatusBadge,
  TextField,
} from '@/components/ui';
import { api } from '@/lib/api';
import { formatAmount, monthRange } from '@/lib/finance';
import { useSession } from '@/lib/session';

const isZero = (v: string) => !/[1-9]/.test(v);

export default function TrialBalancePage() {
  const t = useTranslations('finance');
  const { canTenant, property } = useSession();
  const allowed = canTenant('journal.read');
  const initial = monthRange(property?.businessDate ?? new Date().toISOString().slice(0, 10));
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [hideZero, setHideZero] = useState(true);
  const valid = !!from && !!to && from <= to;

  const tb = useQuery({
    queryKey: ['finance', 'trial-balance', from, to],
    queryFn: () => api.get<TrialBalanceDto>(`/finance/trial-balance?from=${from}&to=${to}`),
    enabled: allowed && valid,
  });

  if (!allowed) return <PermissionDenied />;
  const cur = tb.data?.currencyCode ?? 'PKR';
  const amount = (v: string) => (isZero(v) ? '' : formatAmount(v, cur));
  const rows =
    tb.data?.rows.filter(
      (r) =>
        !hideZero ||
        [r.openingDebit, r.openingCredit, r.debit, r.credit, r.closingDebit, r.closingCredit].some(
          (v) => !isZero(v),
        ),
    ) ?? [];

  return (
    <>
      <PageHeader title={t('tbTitle')} subtitle={t('tbSubtitle')} />
      <Card className="mb-4">
        <div className="grid gap-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
          <TextField label={t('from')} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          <TextField
            label={t('to')}
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            error={valid ? undefined : t('rangeError')}
          />
          <label className="flex min-h-10 items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="h-4 w-4"
              checked={hideZero}
              onChange={(e) => setHideZero(e.target.checked)}
            />
            {t('hideZero')}
          </label>
        </div>
      </Card>
      {!valid ? null : tb.isPending ? (
        <PageSkeleton />
      ) : tb.isError ? (
        <PageError error={tb.error} onRetry={() => void tb.refetch()} />
      ) : (
        <div className="flex flex-col gap-4">
          {tb.data.balanced ? (
            <div>
              <StatusBadge tone="success">{t('tbBalanced')}</StatusBadge>
            </div>
          ) : (
            <Alert>{t('tbNotBalanced')}</Alert>
          )}
          {rows.length === 0 ? (
            <EmptyState message={t('tbEmpty')} />
          ) : (
            <div className="overflow-x-auto rounded-lg border border-line bg-white">
              <table className="w-full min-w-[48rem] text-sm">
                <thead>
                  <tr className="border-b border-line text-left text-muted">
                    <th rowSpan={2} className="px-3 py-2 font-medium">
                      {t('account')}
                    </th>
                    <th colSpan={2} className="px-3 pt-2 text-center font-medium">
                      {t('opening')}
                    </th>
                    <th colSpan={2} className="px-3 pt-2 text-center font-medium">
                      {t('movement')}
                    </th>
                    <th colSpan={2} className="px-3 pt-2 text-center font-medium">
                      {t('closing')}
                    </th>
                  </tr>
                  <tr className="border-b border-line text-right text-xs text-muted">
                    {['opening', 'movement', 'closing'].flatMap((g) => [
                      <th key={`${g}-dr`} className="px-3 pb-2 font-medium">
                        {t('debit')}
                      </th>,
                      <th key={`${g}-cr`} className="px-3 pb-2 font-medium">
                        {t('credit')}
                      </th>,
                    ])}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.accountId} className="border-b border-line/60">
                      <td className="px-3 py-2">
                        <Link
                          href={`/finance/ledger?accountId=${r.accountId}&from=${from}&to=${to}`}
                          className={`underline decoration-line underline-offset-2 ${r.active ? '' : 'text-muted'}`}
                        >
                          <span className="tabular">{r.code}</span> {r.name}
                        </Link>
                      </td>
                      {[
                        r.openingDebit,
                        r.openingCredit,
                        r.debit,
                        r.credit,
                        r.closingDebit,
                        r.closingCredit,
                      ].map((v, i) => (
                        <td key={i} className="tabular px-3 py-2 text-right">
                          {amount(v)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="font-semibold">
                    <td className="px-3 py-2">{t('total')}</td>
                    {[
                      tb.data.totals.openingDebit,
                      tb.data.totals.openingCredit,
                      tb.data.totals.debit,
                      tb.data.totals.credit,
                      tb.data.totals.closingDebit,
                      tb.data.totals.closingCredit,
                    ].map((v, i) => (
                      <td key={i} className="tabular px-3 py-2 text-right">
                        {formatAmount(v, cur)}
                      </td>
                    ))}
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
          <p className="text-xs text-muted">{t('tbNote')}</p>
        </div>
      )}
    </>
  );
}
