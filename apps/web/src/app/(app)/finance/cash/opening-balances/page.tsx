'use client';

import type { OpeningBalancesDto, OpeningBalancesRequest } from '@innpilot/contracts';
import { Money } from '@innpilot/money';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { useAccounts, useCashAccounts } from '@/components/journal-form';
import {
  Alert,
  ApiErrorAlert,
  Button,
  Card,
  PageError,
  PageHeader,
  PageSkeleton,
  PermissionDenied,
  SelectField,
  TextField,
} from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { formatAmount, journalTotals } from '@/lib/finance';
import { useSession } from '@/lib/session';

/** Opening balances on these follow guest folios; the difference account is filled in by the server. */
const EXCLUDED_ROLES = new Set(['guest_receivable', 'guest_deposits', 'opening_balance_equity']);
const BALANCE_SHEET = new Set(['asset', 'liability', 'equity']);

interface LineState {
  key: string;
  accountId: string;
  cashAccountId: string;
  debit: string;
  credit: string;
  description: string;
}
const blank = (): LineState => ({
  key: crypto.randomUUID(),
  accountId: '',
  cashAccountId: '',
  debit: '',
  credit: '',
  description: '',
});

function dayBefore(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

export default function OpeningBalancesPage() {
  const t = useTranslations('cash');
  const { can, property } = useSession();
  const allowed = can('journal.read');
  const existing = useQuery({
    queryKey: ['finance', 'opening-balances', property?.id],
    queryFn: () => api.get<OpeningBalancesDto | null>(`/properties/${property!.id}/opening-balances`),
    enabled: allowed && !!property,
  });

  if (!allowed) return <PermissionDenied />;
  if (existing.isPending) return <PageSkeleton />;
  if (existing.isError) return <PageError error={existing.error} onRetry={() => void existing.refetch()} />;

  return (
    <>
      <PageHeader title={t('openingTitle')} subtitle={t('openingSubtitle')} />
      <p className="mb-4 text-sm">
        <Link href="/finance/cash" className="text-teal-700 underline">
          {t('allAccounts')}
        </Link>
      </p>
      {existing.data ? (
        <Alert tone="success">
          {t('openingDone', { date: existing.data.asOf, n: existing.data.journalNumber ?? 0 })}{' '}
          <Link href={`/finance/journals/${existing.data.journalEntryId}`} className="underline">
            {t('viewJournal', { n: existing.data.journalNumber ?? 0 })}
          </Link>
        </Alert>
      ) : can('journal.post') ? (
        <OpeningForm />
      ) : (
        <PermissionDenied />
      )}
    </>
  );
}

function OpeningForm() {
  const t = useTranslations('cash');
  const tFinance = useTranslations('finance');
  const queryClient = useQueryClient();
  const { property } = useSession();
  const accounts = useAccounts();
  const cashAccounts = useCashAccounts(property?.id);
  const currency = property?.currencyCode ?? 'PKR';
  const [asOf, setAsOf] = useState(() => (property ? dayBefore(property.businessDate) : ''));
  const [lines, setLines] = useState<LineState[]>([blank(), blank()]);
  const [confirmed, setConfirmed] = useState(false);
  // One key for this entry: a retry after a network error can never post it twice.
  const [key] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const choices = useMemo(
    () =>
      (accounts.data ?? []).filter(
        (a) =>
          a.active &&
          BALANCE_SHEET.has(a.accountClass) &&
          !(a.systemRole && EXCLUDED_ROLES.has(a.systemRole)),
      ),
    [accounts.data],
  );
  const cashChoices = (accountId: string) =>
    (cashAccounts.data ?? []).filter((c) => c.ledgerAccountId === accountId && c.active);
  const lineErrors = useMemo(() => {
    const out = new Map<string, string>();
    if (error instanceof ApiError) {
      for (const d of error.details) {
        const m = /^lines\.(\d+)\./.exec(d.path);
        if (m) out.set(lines[Number(m[1])]?.key ?? '', d.message);
      }
    }
    return out;
  }, [error, lines]);
  const update = (k: string, patch: Partial<LineState>) =>
    setLines((ls) => ls.map((l) => (l.key === k ? { ...l, ...patch } : l)));

  const totals = journalTotals(lines, currency);
  const difference = Money.of(totals.debit, currency).subtract(Money.of(totals.credit, currency));
  const used = lines.filter((l) => l.accountId && (/[1-9]/.test(l.debit) || /[1-9]/.test(l.credit)));

  const submit = async () => {
    setBusy(true);
    setError(null);
    const body: OpeningBalancesRequest = {
      asOf,
      lines: used.map((l) => ({
        accountId: l.accountId,
        debit: l.debit.trim() || '0',
        credit: l.credit.trim() || '0',
        description: l.description.trim() || undefined,
        cashAccountId: cashChoices(l.accountId).length > 1 ? l.cashAccountId || undefined : undefined,
      })),
    };
    try {
      await api.postWith<OpeningBalancesDto>(`/properties/${property!.id}/opening-balances`, body, {
        'idempotency-key': key,
      });
      await queryClient.invalidateQueries({ queryKey: ['finance'] });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {error !== null && <ApiErrorAlert error={error} />}
      <Alert tone="info">{t('openingExplain')}</Alert>
      <Card>
        <TextField
          label={t('openingAsOf')}
          type="date"
          value={asOf}
          max={property?.businessDate}
          onChange={(e) => setAsOf(e.target.value)}
          hint={t('openingAsOfHint')}
          className="sm:max-w-xs"
        />
      </Card>
      <Card title={tFinance('lines')}>
        {accounts.isError && <ApiErrorAlert error={accounts.error} />}
        <ol className="flex flex-col gap-3">
          {lines.map((l, i) => (
            <li
              key={l.key}
              className="grid gap-2 rounded-md border border-line p-3 md:grid-cols-[1fr_8rem_8rem_auto] md:items-end md:border-0 md:p-0"
            >
              <SelectField
                label={tFinance('lineAccount', { n: i + 1 })}
                value={l.accountId}
                onChange={(e) => update(l.key, { accountId: e.target.value, cashAccountId: '' })}
                error={lineErrors.get(l.key)}
              >
                <option value="">{tFinance('chooseAccount')}</option>
                {choices.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.code} · {a.name}
                  </option>
                ))}
              </SelectField>
              <TextField
                label={tFinance('debit')}
                inputMode="decimal"
                value={l.debit}
                onChange={(e) =>
                  update(l.key, { debit: e.target.value, ...(e.target.value ? { credit: '' } : {}) })
                }
                className="tabular"
              />
              <TextField
                label={tFinance('credit')}
                inputMode="decimal"
                value={l.credit}
                onChange={(e) =>
                  update(l.key, { credit: e.target.value, ...(e.target.value ? { debit: '' } : {}) })
                }
                className="tabular"
              />
              <Button
                variant="ghost"
                disabled={lines.length <= 1}
                onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}
                aria-label={tFinance('removeLine', { n: i + 1 })}
              >
                {tFinance('remove')}
              </Button>
              {cashChoices(l.accountId).length > 1 && (
                <SelectField
                  label={tFinance('lineCashAccount', { n: i + 1 })}
                  value={l.cashAccountId}
                  onChange={(e) => update(l.key, { cashAccountId: e.target.value })}
                  className="md:col-span-4"
                >
                  <option value="">{tFinance('chooseCashAccount')}</option>
                  {cashChoices(l.accountId).map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </SelectField>
              )}
              <TextField
                label={tFinance('lineDescription')}
                value={l.description}
                maxLength={300}
                onChange={(e) => update(l.key, { description: e.target.value })}
                className="md:col-span-4"
              />
            </li>
          ))}
        </ol>
        <div className="mt-3">
          <Button
            variant="secondary"
            onClick={() => setLines((ls) => [...ls, blank()])}
            disabled={lines.length >= 200}
          >
            {tFinance('addLine')}
          </Button>
        </div>
        <dl className="mt-4 grid grid-cols-3 gap-2 border-t border-line pt-3 text-sm" aria-live="polite">
          <div>
            <dt className="text-muted">{tFinance('totalDebit')}</dt>
            <dd className="tabular font-medium">{formatAmount(totals.debit, currency)}</dd>
          </div>
          <div>
            <dt className="text-muted">{tFinance('totalCredit')}</dt>
            <dd className="tabular font-medium">{formatAmount(totals.credit, currency)}</dd>
          </div>
          <div>
            <dt className="text-muted">{t('openingEquity')}</dt>
            <dd className="tabular font-medium">
              {difference.isZero()
                ? formatAmount('0', currency)
                : `${formatAmount(difference.abs().toString(), currency)} ${tFinance(difference.isPositive() ? 'cr' : 'dr')}`}
            </dd>
          </div>
        </dl>
      </Card>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          className="mt-0.5 h-4 w-4"
          checked={confirmed}
          onChange={(e) => setConfirmed(e.target.checked)}
        />
        {t('openingConfirm')}
      </label>
      <div className="flex justify-end">
        <Button
          busy={busy}
          disabled={busy || !confirmed || used.length === 0 || !asOf}
          onClick={() => void submit()}
        >
          {busy ? tFinance('posting') : t('openingSubmit')}
        </Button>
      </div>
    </div>
  );
}
