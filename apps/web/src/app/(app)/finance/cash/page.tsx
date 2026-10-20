'use client';

import {
  CASH_ACCOUNT_KINDS,
  type CardSettlementDto,
  type CashAccountDto,
  type CashAccountKind,
  type TransferDto,
} from '@innpilot/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useState } from 'react';
import { CardSettlementDialog } from '@/components/card-settlement';
import { useAccounts, useCashAccounts } from '@/components/journal-form';
import {
  Alert,
  ApiErrorAlert,
  Button,
  Card,
  Dialog,
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

/** Ledger accounts a cash account may post to: assets that the posting rules do not use for something else. */
const CASH_ROLES = new Set(['cash_on_hand', 'bank', 'payment_clearing']);

type Editing = { mode: 'new' } | { mode: 'edit'; account: CashAccountDto } | null;

export default function CashPage() {
  const t = useTranslations('cash');
  const { can, property } = useSession();
  const canRead = can('journal.read');
  const canTransfer = can('cash.transfer');
  const canManage = can('account.manage');
  const allowed = canRead || canTransfer;
  const accounts = useCashAccounts(property?.id, allowed);
  const transfers = useQuery({
    queryKey: ['finance', 'transfers', property?.id],
    queryFn: () => api.get<TransferDto[]>(`/properties/${property!.id}/transfers?limit=10`),
    enabled: canTransfer && !!property,
  });
  const [editing, setEditing] = useState<Editing>(null);
  const [transferOpen, setTransferOpen] = useState(false);
  const [done, setDone] = useState<TransferDto | null>(null);
  const [settleOpen, setSettleOpen] = useState(false);
  const [settled, setSettled] = useState<CardSettlementDto | null>(null);

  if (!allowed) return <PermissionDenied />;
  if (accounts.isPending) return <PageSkeleton />;
  if (accounts.isError) return <PageError error={accounts.error} onRetry={() => void accounts.refetch()} />;
  const cur = property?.currencyCode ?? 'PKR';

  return (
    <>
      <PageHeader
        title={t('title')}
        subtitle={t('subtitle')}
        actions={
          <div className="flex flex-wrap gap-2">
            {canRead && can('journal.post') && (
              <Link
                href="/finance/cash/opening-balances"
                className="inline-flex min-h-10 items-center rounded-md border border-line bg-white px-4 text-sm font-medium text-navy-800 hover:bg-navy-50"
              >
                {t('openingBalances')}
              </Link>
            )}
            {canManage && (
              <Button variant="secondary" onClick={() => setEditing({ mode: 'new' })}>
                {t('addAccount')}
              </Button>
            )}
            {canTransfer && accounts.data?.some((a) => a.kind === 'card_clearing' && a.active) && (
              <Button
                variant="secondary"
                onClick={() => {
                  setSettled(null);
                  setSettleOpen(true);
                }}
              >
                {t('settle')}
              </Button>
            )}
            {canTransfer && (
              <Button
                onClick={() => {
                  setDone(null);
                  setTransferOpen(true);
                }}
              >
                {t('transfer')}
              </Button>
            )}
          </div>
        }
      />
      <div className="flex flex-col gap-4">
        {done && (
          <Alert tone="success">
            {t('transferDone', {
              amount: formatAmount(done.amount, cur),
              from: done.fromCashAccountName,
              to: done.toCashAccountName,
            })}
          </Alert>
        )}
        {settled && (
          <Alert tone="success">
            {t('settleDone', {
              net: formatAmount(settled.netAmount, cur),
              to: settled.bankAccountName,
              fee: formatAmount(settled.feeAmount, cur),
            })}
          </Alert>
        )}
        {!canRead && <Alert tone="info">{t('balanceHidden')}</Alert>}
        {accounts.data.length === 0 ? (
          <EmptyState message={t('noAccounts')} />
        ) : (
          <Card>
            <ul className="divide-y divide-line text-sm">
              {accounts.data.map((a) => (
                <li key={a.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-3">
                  <div className="min-w-0 flex-1">
                    <p className={`font-medium ${a.active ? 'text-ink' : 'text-muted'}`}>
                      {canRead ? (
                        <Link
                          href={`/finance/cash/${a.id}`}
                          className="underline decoration-line underline-offset-2"
                        >
                          {a.name}
                        </Link>
                      ) : (
                        a.name
                      )}
                    </p>
                    <p className="text-xs text-muted">
                      {t(`kinds.${a.kind}`)} ·{' '}
                      {t('postsTo', { code: a.ledgerAccountCode, name: a.ledgerAccountName })}
                      {a.details ? ` · ${a.details}` : ''}
                    </p>
                  </div>
                  {!a.active && <StatusBadge tone="neutral">{t('closed')}</StatusBadge>}
                  {a.balance !== null && (
                    <span className="tabular w-36 text-right font-medium">
                      {formatAmount(a.balance, cur)}
                    </span>
                  )}
                  {canManage && (
                    <Button variant="ghost" onClick={() => setEditing({ mode: 'edit', account: a })}>
                      {t('edit')}
                      <span className="sr-only"> {a.name}</span>
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </Card>
        )}
        {canTransfer && (
          <Card title={t('recentTransfers')}>
            {transfers.isError ? (
              <ApiErrorAlert error={transfers.error} />
            ) : (transfers.data ?? []).length === 0 ? (
              <p className="text-sm text-muted">{transfers.isPending ? '…' : t('noTransfers')}</p>
            ) : (
              <ul className="divide-y divide-line text-sm">
                {transfers.data!.map((x) => (
                  <li key={x.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2">
                    <span className="tabular text-muted">{x.businessDate}</span>
                    <span className="min-w-0 flex-1">
                      {t('transferLine', { from: x.fromCashAccountName, to: x.toCashAccountName })}
                      {x.reference ? <span className="text-muted"> · {x.reference}</span> : null}
                    </span>
                    <span className="tabular font-medium">{formatAmount(x.amount, cur)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        )}
      </div>
      <AccountDialog editing={editing} onClose={() => setEditing(null)} />
      <CardSettlementDialog
        open={settleOpen}
        accounts={accounts.data}
        onClose={() => setSettleOpen(false)}
        onDone={(s) => {
          setSettleOpen(false);
          setSettled(s);
        }}
      />
      <TransferDialog
        open={transferOpen}
        accounts={accounts.data.filter((a) => a.active)}
        currency={cur}
        onClose={() => setTransferOpen(false)}
        onDone={(x) => {
          setTransferOpen(false);
          setDone(x);
        }}
      />
    </>
  );
}

function AccountDialog({ editing, onClose }: { editing: Editing; onClose: () => void }) {
  const t = useTranslations('cash');
  const tCommon = useTranslations('common');
  const { property, canTenant } = useSession();
  const queryClient = useQueryClient();
  const ledger = useAccounts(editing?.mode === 'new' && canTenant('journal.read'));
  const existing = editing?.mode === 'edit' ? editing.account : null;
  const [name, setName] = useState('');
  const [kind, setKind] = useState<CashAccountKind>('bank');
  const [details, setDetails] = useState('');
  const [ledgerAccountId, setLedgerAccountId] = useState('');
  const [active, setActive] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [openedFor, setOpenedFor] = useState<Editing>(null);

  // Reset the fields each time the dialog opens for a different account.
  if (editing !== openedFor) {
    setOpenedFor(editing);
    setError(null);
    setName(existing?.name ?? '');
    setKind(existing?.kind ?? 'bank');
    setDetails(existing?.details ?? '');
    setLedgerAccountId('');
    setActive(existing?.active ?? true);
  }

  const choices = (ledger.data ?? []).filter(
    (a) => a.accountClass === 'asset' && a.active && (!a.systemRole || CASH_ROLES.has(a.systemRole)),
  );

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      if (existing) {
        await api.patch(`/properties/${property!.id}/cash-accounts/${existing.id}`, {
          name: name.trim(),
          details: details.trim() || null,
          active,
        });
      } else {
        await api.post(`/properties/${property!.id}/cash-accounts`, {
          name: name.trim(),
          kind,
          details: details.trim() || undefined,
          ledgerAccountId: ledgerAccountId || undefined,
        });
      }
      await queryClient.invalidateQueries({ queryKey: ['finance', 'cash-accounts'] });
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={editing !== null}
      onClose={onClose}
      title={existing ? t('editTitle', { name: existing.name }) : t('addAccount')}
    >
      <div className="flex flex-col gap-4">
        {error !== null && <ApiErrorAlert error={error} />}
        <TextField label={t('name')} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
        {!existing && (
          <SelectField
            label={t('kind')}
            value={kind}
            onChange={(e) => setKind(e.target.value as CashAccountKind)}
          >
            {CASH_ACCOUNT_KINDS.map((k) => (
              <option key={k} value={k}>
                {t(`kinds.${k}`)}
              </option>
            ))}
          </SelectField>
        )}
        <TextField
          label={t('details')}
          value={details}
          maxLength={120}
          onChange={(e) => setDetails(e.target.value)}
          hint={t('detailsHint')}
        />
        {!existing && (
          <SelectField
            label={t('ledgerAccount')}
            value={ledgerAccountId}
            onChange={(e) => setLedgerAccountId(e.target.value)}
            hint={t('ledgerHint')}
          >
            {kind !== 'other' && <option value="">{t('ledgerDefault')}</option>}
            {kind === 'other' && <option value="">{t('chooseAccount')}</option>}
            {choices.map((a) => (
              <option key={a.id} value={a.id}>
                {a.code} · {a.name}
              </option>
            ))}
          </SelectField>
        )}
        {existing && (
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="h-4 w-4"
              checked={active}
              onChange={(e) => setActive(e.target.checked)}
            />
            {t('activeLabel')}
          </label>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            {tCommon('cancel')}
          </Button>
          <Button
            busy={busy}
            disabled={name.trim().length === 0 || (!existing && kind === 'other' && !ledgerAccountId)}
            onClick={() => void save()}
          >
            {busy ? tCommon('saving') : tCommon('save')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function TransferDialog({
  open,
  accounts,
  currency,
  onClose,
  onDone,
}: {
  open: boolean;
  accounts: CashAccountDto[];
  currency: string;
  onClose: () => void;
  onDone: (x: TransferDto) => void;
}) {
  const t = useTranslations('cash');
  const tCommon = useTranslations('common');
  const { property } = useSession();
  const queryClient = useQueryClient();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('');
  const [reference, setReference] = useState('');
  const [notes, setNotes] = useState('');
  // One key per transfer; a retry after a network error reuses it so the money never moves twice.
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [wasOpen, setWasOpen] = useState(false);

  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setFrom('');
      setTo('');
      setAmount('');
      setReference('');
      setNotes('');
      setError(null);
    }
  }

  const fromAccount = accounts.find((a) => a.id === from);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const done = await api.postWith<TransferDto>(
        `/properties/${property!.id}/transfers`,
        {
          fromCashAccountId: from,
          toCashAccountId: to,
          amount: amount.trim(),
          reference: reference.trim() || undefined,
          notes: notes.trim() || undefined,
        },
        { 'idempotency-key': key },
      );
      setKey(crypto.randomUUID());
      await queryClient.invalidateQueries({ queryKey: ['finance'] });
      onDone(done);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title={t('transferTitle')}>
      <div className="flex flex-col gap-4">
        <p className="text-sm text-muted">{t('transferExplain')}</p>
        {error !== null && <ApiErrorAlert error={error} />}
        <SelectField
          label={t('from')}
          value={from}
          onChange={(e) => setFrom(e.target.value)}
          hint={
            fromAccount && fromAccount.balance !== null
              ? `${t('balance')}: ${formatAmount(fromAccount.balance, currency)}`
              : undefined
          }
        >
          <option value="">{t('chooseAccount')}</option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </SelectField>
        <SelectField label={t('to')} value={to} onChange={(e) => setTo(e.target.value)}>
          <option value="">{t('chooseAccount')}</option>
          {accounts
            .filter((a) => a.id !== from)
            .map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
        </SelectField>
        <TextField
          label={t('amount')}
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          className="tabular"
        />
        <TextField
          label={t('transferReference')}
          value={reference}
          maxLength={80}
          onChange={(e) => setReference(e.target.value)}
          hint={t('transferReferenceHint')}
        />
        <TextField
          label={t('notes')}
          value={notes}
          maxLength={300}
          onChange={(e) => setNotes(e.target.value)}
        />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            {tCommon('cancel')}
          </Button>
          <Button
            busy={busy}
            disabled={!from || !to || from === to || !/^\d+(\.\d{1,2})?$/.test(amount.trim())}
            onClick={() => void submit()}
          >
            {t('transfer')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
