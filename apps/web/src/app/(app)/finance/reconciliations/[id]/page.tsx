'use client';

import type { ReconciliationDetailDto } from '@innpilot/contracts';
import { Money } from '@innpilot/money';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useFormatter, useTranslations } from 'next-intl';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import {
  Alert,
  ApiErrorAlert,
  Button,
  Card,
  Dialog,
  PageError,
  PageHeader,
  PageSkeleton,
  PermissionDenied,
  StatusBadge,
  TextField,
} from '@/components/ui';
import { api } from '@/lib/api';
import { formatAmount } from '@/lib/finance';
import { useSession } from '@/lib/session';

/**
 * Tick the ledger lines that appear on the statement. Each change is saved at once and the server returns the
 * cleared balance and difference, so what is shown is always what will be recorded.
 */
export default function ReconciliationPage() {
  const t = useTranslations('reconciliation');
  const tCommon = useTranslations('common');
  const format = useFormatter();
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { can, property } = useSession();
  const allowed = can('journal.read');
  const key = ['reconciliations', 'one', id];
  const rec = useQuery({
    queryKey: key,
    queryFn: () => api.get<ReconciliationDetailDto>(`/properties/${property!.id}/reconciliations/${id}`),
    enabled: allowed && !!property,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [balance, setBalance] = useState<string | null>(null);
  const [dialog, setDialog] = useState<'complete' | 'abandon' | null>(null);
  const [explanation, setExplanation] = useState('');
  const [completeKey, setCompleteKey] = useState(() => crypto.randomUUID());

  if (!allowed) return <PermissionDenied />;
  if (rec.isPending) return <PageSkeleton />;
  if (rec.isError) return <PageError error={rec.error} onRetry={() => void rec.refetch()} />;
  const r = rec.data;
  const cur = property?.currencyCode ?? 'PKR';
  const editable = r.status === 'in_progress' && can('bank.reconcile');
  const difference = Money.of(r.difference, cur);
  const base = `/properties/${property!.id}/reconciliations/${id}`;

  const save = async (fn: () => Promise<ReconciliationDetailDto>) => {
    setBusy(true);
    setError(null);
    try {
      queryClient.setQueryData(key, await fn());
      await queryClient.invalidateQueries({ queryKey: ['reconciliations', property?.id] });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  const toggle = (lineId: string, on: boolean) => {
    const ids = r.lines
      .filter((l) => (l.journalLineId === lineId ? on : l.ticked))
      .map((l) => l.journalLineId);
    void save(() => api.put<ReconciliationDetailDto>(`${base}/items`, { journalLineIds: ids }));
  };
  const all = (on: boolean) =>
    void save(() =>
      api.put<ReconciliationDetailDto>(`${base}/items`, {
        journalLineIds: on ? r.lines.map((l) => l.journalLineId) : [],
      }),
    );
  const finish = async () => {
    setBusy(true);
    setError(null);
    try {
      const done = await api.postWith<ReconciliationDetailDto>(
        `${base}/complete`,
        { explanation: explanation.trim() || undefined },
        { 'idempotency-key': completeKey },
      );
      setCompleteKey(crypto.randomUUID());
      queryClient.setQueryData(key, done);
      await queryClient.invalidateQueries({ queryKey: ['reconciliations', property?.id] });
      setDialog(null);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  const abandon = async () => {
    setBusy(true);
    try {
      await api.del(base);
      await queryClient.invalidateQueries({ queryKey: ['reconciliations'] });
      router.push('/finance/reconciliations');
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        title={`${r.cashAccountName} · ${r.statementDate}`}
        subtitle={r.previousStatementDate ? t('since', { date: r.previousStatementDate }) : t('firstOne')}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge tone={r.status === 'completed' ? 'success' : 'warning'}>
              {t(`statuses.${r.status}`)}
            </StatusBadge>
            {editable && (
              <>
                <Button variant="secondary" onClick={() => setDialog('abandon')}>
                  {t('abandon')}
                </Button>
                <Button onClick={() => setDialog('complete')}>{t('complete')}</Button>
              </>
            )}
          </div>
        }
      />
      <p className="mb-4 text-sm">
        <Link href="/finance/reconciliations" className="text-teal-700 underline">
          {t('all')}
        </Link>
      </p>
      {error !== null && <ApiErrorAlert error={error} />}
      <div className="mt-4 grid gap-4 lg:grid-cols-[1fr_2fr]">
        <Card>
          <dl className="flex flex-col gap-3 text-sm" aria-live="polite">
            <div>
              <dt className={editable ? 'sr-only' : 'text-muted'}>{t('statementBalance')}</dt>
              <dd>
                {editable ? (
                  <div className="flex items-end gap-2">
                    <TextField
                      label={t('statementBalance')}
                      inputMode="decimal"
                      value={balance ?? r.statementBalance}
                      onChange={(e) => setBalance(e.target.value)}
                      className="tabular flex-1"
                    />
                    <Button
                      variant="secondary"
                      disabled={busy || balance === null || !/^-?\d{1,13}(\.\d{1,2})?$/.test(balance.trim())}
                      onClick={() =>
                        void save(() =>
                          api.patch<ReconciliationDetailDto>(base, { statementBalance: balance!.trim() }),
                        ).then(() => setBalance(null))
                      }
                    >
                      {tCommon('save')}
                    </Button>
                  </div>
                ) : (
                  <span className="tabular font-medium">{formatAmount(r.statementBalance, cur)}</span>
                )}
              </dd>
            </div>
            <div>
              <dt className="text-muted">{t('cleared')}</dt>
              <dd className="tabular font-medium">{formatAmount(r.clearedBalance, cur)}</dd>
            </div>
            <div>
              <dt className="text-muted">{t('difference')}</dt>
              <dd
                className={`tabular text-base font-semibold ${difference.isZero() ? 'text-success' : 'text-danger'}`}
              >
                {difference.isZero() ? t('noDifference') : formatAmount(r.difference, cur)}
              </dd>
            </div>
            {r.differenceExplanation && (
              <div>
                <dt className="text-muted">{t('explanation')}</dt>
                <dd>{r.differenceExplanation}</dd>
              </div>
            )}
            {r.completedAt && (
              <p className="text-xs text-muted">
                {t('completedBy', {
                  name: r.completedByName ?? '—',
                  time: format.dateTime(new Date(r.completedAt), { dateStyle: 'medium', timeStyle: 'short' }),
                })}
              </p>
            )}
          </dl>
        </Card>
        <Card title={t('lines')}>
          {editable && r.lines.length > 0 && (
            <div className="mb-3 flex gap-2">
              <Button variant="secondary" disabled={busy} onClick={() => all(true)}>
                {t('tickAll')}
              </Button>
              <Button variant="ghost" disabled={busy} onClick={() => all(false)}>
                {t('untickAll')}
              </Button>
            </div>
          )}
          {r.lines.length === 0 ? (
            <p className="text-sm text-muted">{t('noLines')}</p>
          ) : (
            <ul className="divide-y divide-line text-sm">
              {r.lines.map((l) => (
                <li key={l.journalLineId}>
                  <label className="flex min-h-12 cursor-pointer items-center gap-3 py-2">
                    <input
                      type="checkbox"
                      className="h-5 w-5 shrink-0"
                      checked={l.ticked}
                      disabled={!editable || busy}
                      onChange={(e) => toggle(l.journalLineId, e.target.checked)}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="tabular text-muted">{l.accountingDate}</span> {l.narration}
                      {(l.reference || l.description) && (
                        <span className="block text-xs text-muted">{l.reference ?? l.description}</span>
                      )}
                    </span>
                    <span className={`tabular font-medium ${l.amount.startsWith('-') ? 'text-danger' : ''}`}>
                      {formatAmount(l.amount, cur)}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
      <Dialog
        open={dialog !== null}
        onClose={() => setDialog(null)}
        title={dialog === 'abandon' ? t('abandonTitle') : t('completeTitle')}
      >
        <div className="flex flex-col gap-4">
          {error !== null && <ApiErrorAlert error={error} />}
          {dialog === 'abandon' ? (
            <p className="text-sm text-muted">{t('abandonExplain')}</p>
          ) : difference.isZero() ? (
            <Alert tone="success">{t('completeBalanced')}</Alert>
          ) : (
            <>
              <Alert tone="warning">
                {t('completeDifference', { amount: formatAmount(r.difference, cur) })}
              </Alert>
              <TextField
                label={t('explanation')}
                value={explanation}
                maxLength={1000}
                onChange={(e) => setExplanation(e.target.value)}
              />
            </>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setDialog(null)}>
              {tCommon('cancel')}
            </Button>
            <Button
              busy={busy}
              disabled={dialog === 'complete' && !difference.isZero() && explanation.trim().length < 3}
              onClick={() => void (dialog === 'abandon' ? abandon() : finish())}
            >
              {dialog === 'abandon' ? t('abandon') : t('complete')}
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}
