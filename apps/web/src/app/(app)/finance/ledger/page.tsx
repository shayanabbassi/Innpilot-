'use client';

import type { LedgerDto } from '@innpilot/contracts';
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { useAccounts } from '@/components/journal-form';
import {
  Card,
  EmptyState,
  PageError,
  PageHeader,
  PageSkeleton,
  PermissionDenied,
  SelectField,
  TextField,
} from '@/components/ui';
import { api } from '@/lib/api';
import { balanceSide, formatAmount, monthRange } from '@/lib/finance';
import { useSession } from '@/lib/session';

export default function LedgerPage() {
  // useSearchParams needs a Suspense boundary for static rendering.
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Ledger />
    </Suspense>
  );
}

function Ledger() {
  const t = useTranslations('finance');
  const { canTenant, property } = useSession();
  const allowed = canTenant('journal.read');
  const params = useSearchParams();
  const router = useRouter();
  const month = monthRange(property?.businessDate ?? new Date().toISOString().slice(0, 10));
  const accountId = params.get('accountId') ?? '';
  const from = params.get('from') ?? month.from;
  const to = params.get('to') ?? month.to;
  const valid = !!accountId && !!from && !!to && from <= to;
  const accounts = useAccounts(allowed);

  const ledger = useQuery({
    queryKey: ['finance', 'ledger', accountId, from, to],
    queryFn: () => api.get<LedgerDto>(`/finance/ledger?accountId=${accountId}&from=${from}&to=${to}`),
    enabled: allowed && valid,
  });

  if (!allowed) return <PermissionDenied />;
  const go = (next: { accountId?: string; from?: string; to?: string }) => {
    const q = new URLSearchParams({ accountId, from, to, ...next });
    router.replace(`/finance/ledger?${q.toString()}`);
  };
  const cur = property?.currencyCode ?? 'PKR';
  const side = (v: string) => {
    const b = balanceSide(v);
    return b.side ? `${formatAmount(b.amount, cur)} ${t(b.side)}` : formatAmount('0', cur);
  };

  return (
    <>
      <PageHeader title={t('ledgerTitle')} subtitle={t('ledgerSubtitle')} />
      <Card className="mb-4">
        <div className="grid gap-4 sm:grid-cols-[2fr_1fr_1fr]">
          <SelectField
            label={t('account')}
            value={accountId}
            onChange={(e) => go({ accountId: e.target.value })}
          >
            <option value="">{t('chooseAccount')}</option>
            {(accounts.data ?? []).map((a) => (
              <option key={a.id} value={a.id}>
                {a.code} · {a.name}
              </option>
            ))}
          </SelectField>
          <TextField
            label={t('from')}
            type="date"
            value={from}
            onChange={(e) => go({ from: e.target.value })}
          />
          <TextField
            label={t('to')}
            type="date"
            value={to}
            onChange={(e) => go({ to: e.target.value })}
            error={from <= to ? undefined : t('rangeError')}
          />
        </div>
      </Card>
      {!accountId ? (
        <EmptyState message={t('ledgerPick')} />
      ) : !valid ? null : ledger.isPending ? (
        <PageSkeleton />
      ) : ledger.isError ? (
        <PageError error={ledger.error} onRetry={() => void ledger.refetch()} />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line bg-white">
          <table className="w-full min-w-[40rem] text-sm">
            <thead>
              <tr className="border-b border-line text-left text-muted">
                <th className="px-3 py-2 font-medium">{t('date')}</th>
                <th className="px-3 py-2 font-medium">{t('journal')}</th>
                <th className="px-3 py-2 font-medium">{t('narration')}</th>
                <th className="px-3 py-2 text-right font-medium">{t('debit')}</th>
                <th className="px-3 py-2 text-right font-medium">{t('credit')}</th>
                <th className="px-3 py-2 text-right font-medium">{t('balance')}</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-b border-line/60 text-muted">
                <td className="tabular px-3 py-2">{from}</td>
                <td className="px-3 py-2" colSpan={4}>
                  {t('openingBalance')}
                </td>
                <td className="tabular px-3 py-2 text-right">{side(ledger.data.openingBalance)}</td>
              </tr>
              {ledger.data.lines.map((l, i) => (
                <tr key={`${l.entryId}-${i}`} className="border-b border-line/60">
                  <td className="tabular px-3 py-2">{l.accountingDate}</td>
                  <td className="px-3 py-2">
                    <Link href={`/finance/journals/${l.entryId}`} className="tabular text-teal-700 underline">
                      {t('journalNo', { n: l.journalNumber })}
                    </Link>
                  </td>
                  <td className="px-3 py-2">{l.narration}</td>
                  <td className="tabular px-3 py-2 text-right">
                    {/[1-9]/.test(l.debit) ? formatAmount(l.debit, cur) : ''}
                  </td>
                  <td className="tabular px-3 py-2 text-right">
                    {/[1-9]/.test(l.credit) ? formatAmount(l.credit, cur) : ''}
                  </td>
                  <td className="tabular px-3 py-2 text-right">{side(l.balance)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="font-semibold">
                <td className="px-3 py-2" colSpan={3}>
                  {t('closingBalance')}
                </td>
                <td className="tabular px-3 py-2 text-right">{formatAmount(ledger.data.totalDebit, cur)}</td>
                <td className="tabular px-3 py-2 text-right">{formatAmount(ledger.data.totalCredit, cur)}</td>
                <td className="tabular px-3 py-2 text-right">{side(ledger.data.closingBalance)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </>
  );
}
