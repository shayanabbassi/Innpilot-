'use client';

import type { ReconciliationDetailDto, ReconciliationDto } from '@innpilot/contracts';
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useCashAccounts } from '@/components/journal-form';
import {
  ApiErrorAlert,
  Button,
  Card,
  EmptyState,
  PageError,
  PageHeader,
  PageSkeleton,
  PermissionDenied,
  SelectField,
  StatusBadge,
  TextField,
} from '@/components/ui';
import { api } from '@/lib/api';
import { formatAmount } from '@/lib/finance';
import { useSession } from '@/lib/session';

export default function ReconciliationsPage() {
  const t = useTranslations('reconciliation');
  const { can, property } = useSession();
  const allowed = can('journal.read');
  const list = useQuery({
    queryKey: ['reconciliations', property?.id],
    queryFn: () => api.get<ReconciliationDto[]>(`/properties/${property!.id}/reconciliations`),
    enabled: allowed && !!property,
  });

  if (!allowed) return <PermissionDenied />;
  if (list.isPending) return <PageSkeleton />;
  if (list.isError) return <PageError error={list.error} onRetry={() => void list.refetch()} />;
  const cur = property?.currencyCode ?? 'PKR';

  return (
    <>
      <PageHeader title={t('title')} subtitle={t('subtitle')} />
      <div className="flex flex-col gap-4">
        {can('bank.reconcile') && <StartForm />}
        {list.data.length === 0 ? (
          <EmptyState message={t('none')} />
        ) : (
          <Card>
            <ul className="divide-y divide-line text-sm">
              {list.data.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-3">
                  <div className="min-w-0 flex-1">
                    <Link
                      href={`/finance/reconciliations/${r.id}`}
                      className="font-medium underline decoration-line"
                    >
                      {r.cashAccountName} · {r.statementDate}
                    </Link>
                    <p className="text-xs text-muted">
                      {t('statementShort', { amount: formatAmount(r.statementBalance, cur) })}
                      {/[1-9]/.test(r.difference)
                        ? ` · ${t('differenceShort', { amount: formatAmount(r.difference, cur) })}`
                        : ''}
                    </p>
                  </div>
                  <StatusBadge tone={r.status === 'completed' ? 'success' : 'warning'}>
                    {t(`statuses.${r.status}`)}
                  </StatusBadge>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>
    </>
  );
}

function StartForm() {
  const t = useTranslations('reconciliation');
  const router = useRouter();
  const { property } = useSession();
  const accounts = useCashAccounts(property?.id);
  const choices = (accounts.data ?? []).filter((a) => a.kind !== 'cash' && a.active);
  const [accountId, setAccountId] = useState('');
  const [date, setDate] = useState(property?.businessDate ?? '');
  const [balance, setBalance] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const chosen = accountId || (choices.length === 1 ? choices[0]!.id : '');

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const rec = await api.post<ReconciliationDetailDto>(`/properties/${property!.id}/reconciliations`, {
        cashAccountId: chosen,
        statementDate: date,
        statementBalance: balance.trim(),
      });
      router.push(`/finance/reconciliations/${rec.id}`);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title={t('startTitle')}>
      <div className="flex flex-col gap-4">
        <p className="text-sm text-muted">{t('startExplain')}</p>
        {error !== null && <ApiErrorAlert error={error} />}
        <div className="grid gap-4 sm:grid-cols-3">
          <SelectField label={t('account')} value={chosen} onChange={(e) => setAccountId(e.target.value)}>
            <option value="">{t('chooseAccount')}</option>
            {choices.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </SelectField>
          <TextField
            label={t('statementDate')}
            type="date"
            value={date}
            max={property?.businessDate}
            onChange={(e) => setDate(e.target.value)}
          />
          <TextField
            label={t('statementBalance')}
            inputMode="decimal"
            value={balance}
            onChange={(e) => setBalance(e.target.value)}
            hint={t('statementBalanceHint')}
            className="tabular"
          />
        </div>
        <div className="flex justify-end">
          <Button
            busy={busy}
            disabled={!chosen || !date || !/^-?\d{1,13}(\.\d{1,2})?$/.test(balance.trim())}
            onClick={() => void start()}
          >
            {t('start')}
          </Button>
        </div>
      </div>
    </Card>
  );
}
