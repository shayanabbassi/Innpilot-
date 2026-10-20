'use client';

import type { ExpenseDto } from '@innpilot/contracts';
import { Money } from '@innpilot/money';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useFormatter, useTranslations } from 'next-intl';
import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { ExpenseForm } from '@/components/expense-form';
import { ExpenseStatusBadge } from '@/components/expense-status';
import { useCashAccounts } from '@/components/journal-form';
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
  SelectField,
  TextField,
} from '@/components/ui';
import { api } from '@/lib/api';
import { formatAmount } from '@/lib/finance';
import { useSession } from '@/lib/session';

export default function ExpenseDetailPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <ExpenseDetail />
    </Suspense>
  );
}

type Action = 'submit' | 'approve' | 'pay' | 'void' | null;

function ExpenseDetail() {
  const t = useTranslations('expenses');
  const format = useFormatter();
  const { id } = useParams<{ id: string }>();
  const params = useSearchParams();
  const { can, property, me } = useSession();
  const allowed = can('expense.write');
  const expense = useQuery({
    queryKey: ['expenses', 'one', id],
    queryFn: () => api.get<ExpenseDto>(`/properties/${property!.id}/expenses/${id}`),
    enabled: allowed && !!property,
  });
  const [editing, setEditing] = useState(false);
  const [action, setAction] = useState<Action>(null);

  if (!allowed) return <PermissionDenied />;
  if (expense.isPending) return <PageSkeleton />;
  if (expense.isError) return <PageError error={expense.error} onRetry={() => void expense.refetch()} />;
  const e = expense.data;
  const cur = property?.currencyCode ?? 'PKR';
  const links = can('journal.read');
  const when = (iso: string) => format.dateTime(new Date(iso), { dateStyle: 'medium', timeStyle: 'short' });

  if (editing && e.status === 'draft') {
    return (
      <>
        <PageHeader title={t('editTitle', { number: e.voucherNumber })} />
        <ExpenseForm draft={e} />
      </>
    );
  }

  const canApprove = can('expense.approve') && e.needsApproval && e.createdById !== me.user.id;
  const canPay =
    can('expense.pay') && e.kind === 'bill' && (e.status === 'approved' || e.status === 'partly_paid');
  const canVoid =
    e.status === 'draft' ||
    e.status === 'submitted' ||
    (can('expense.approve') && (e.status === 'approved' || (e.kind === 'cash' && e.status === 'paid')));

  return (
    <>
      <PageHeader
        title={`${e.voucherNumber} · ${e.supplierName ?? e.payee ?? t(`kinds.${e.kind}`)}`}
        subtitle={e.description}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <ExpenseStatusBadge expense={e} />
            {e.status === 'draft' && (
              <>
                <Button variant="secondary" onClick={() => setEditing(true)}>
                  {t('edit')}
                </Button>
                <Button onClick={() => setAction('submit')}>
                  {e.kind === 'cash' ? t('pay') : t('submit')}
                </Button>
              </>
            )}
            {canApprove && <Button onClick={() => setAction('approve')}>{t('approve')}</Button>}
            {canPay && <Button onClick={() => setAction('pay')}>{t('payBill')}</Button>}
            {canVoid && (
              <Button variant="secondary" onClick={() => setAction('void')}>
                {t('void')}
              </Button>
            )}
          </div>
        }
      />
      <p className="mb-4 text-sm">
        <Link href="/expenses" className="text-teal-700 underline">
          {t('all')}
        </Link>
      </p>
      {params.get('submitFailed') && e.status === 'draft' && (
        <Alert tone="warning">{t('submitFailed')}</Alert>
      )}
      {e.status === 'void' && (
        <Alert tone="info">
          {t('voidedNote', { name: e.voidedByName ?? '—', reason: e.voidReason ?? '' })}
        </Alert>
      )}
      <div className="mt-4 grid gap-4 lg:grid-cols-[2fr_1fr]">
        <div className="flex flex-col gap-4">
          <Card title={t('lines')}>
            <ul className="divide-y divide-line text-sm">
              {e.lines.map((l) => (
                <li key={l.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2">
                  <span className="min-w-0 flex-1">
                    <span className="tabular font-medium">{l.accountCode}</span> {l.accountName}
                    {l.description && <span className="block text-xs text-muted">{l.description}</span>}
                    {/[1-9]/.test(l.taxAmount) && (
                      <span className="block text-xs text-muted">
                        {t(l.taxRecoverable ? 'taxRecoverableNote' : 'taxInCostNote', {
                          amount: formatAmount(l.taxAmount, cur),
                        })}
                      </span>
                    )}
                  </span>
                  <span className="tabular">{formatAmount(l.amount, cur)}</span>
                </li>
              ))}
            </ul>
            <dl className="mt-3 grid grid-cols-3 gap-2 border-t border-line pt-3 text-sm">
              <div>
                <dt className="text-muted">{t('net')}</dt>
                <dd className="tabular">{formatAmount(e.netAmount, cur)}</dd>
              </div>
              <div>
                <dt className="text-muted">{t('tax')}</dt>
                <dd className="tabular">{formatAmount(e.taxAmount, cur)}</dd>
              </div>
              <div>
                <dt className="text-muted">{t('total')}</dt>
                <dd className="tabular font-semibold">{formatAmount(e.totalAmount, cur)}</dd>
              </div>
            </dl>
          </Card>
          {e.kind === 'bill' && (
            <Card title={t('payments')}>
              {e.payments.length === 0 ? (
                <p className="text-sm text-muted">{t('noPayments')}</p>
              ) : (
                <ul className="divide-y divide-line text-sm">
                  {e.payments.map((p) => (
                    <li key={p.id} className="flex flex-wrap items-baseline gap-x-3 py-2">
                      <span className="tabular text-muted">{p.businessDate}</span>
                      <span className="min-w-0 flex-1">
                        {p.cashAccountName}
                        {p.reference ? ` · ${p.reference}` : ''}
                      </span>
                      <span className="tabular font-medium">{formatAmount(p.amount, cur)}</span>
                    </li>
                  ))}
                </ul>
              )}
              <p className="mt-3 text-sm">
                {t('outstanding')}:{' '}
                <span className="tabular font-semibold">{formatAmount(e.outstanding, cur)}</span>
              </p>
            </Card>
          )}
        </div>
        <Card>
          <dl className="flex flex-col gap-2 text-sm">
            <Row label={t('kind')} value={t(`kinds.${e.kind}`)} />
            <Row label={e.kind === 'bill' ? t('billDate') : t('expenseDate')} value={e.expenseDate} />
            {e.dueDate && <Row label={t('dueDate')} value={e.dueDate} />}
            {e.billReference && (
              <Row
                label={e.kind === 'bill' ? t('billReference') : t('receiptReference')}
                value={e.billReference}
              />
            )}
            {e.cashAccountName && <Row label={t('paidFrom')} value={e.cashAccountName} />}
            {e.attachmentRef && <Row label={t('attachmentRef')} value={e.attachmentRef} />}
            <Row label={t('createdBy')} value={`${e.createdByName ?? '—'}, ${when(e.createdAt)}`} />
            {e.submittedAt && (
              <Row label={t('submittedBy')} value={`${e.submittedByName ?? '—'}, ${when(e.submittedAt)}`} />
            )}
            {e.approvedAt && (
              <Row label={t('approvedBy')} value={`${e.approvedByName ?? '—'}, ${when(e.approvedAt)}`} />
            )}
            {e.journalEntryId && (
              <Row
                label={t('journal')}
                value={
                  links ? (
                    <Link href={`/finance/journals/${e.journalEntryId}`} className="text-teal-700 underline">
                      {t('journalNo', { n: e.journalNumber ?? 0 })}
                    </Link>
                  ) : (
                    t('journalNo', { n: e.journalNumber ?? 0 })
                  )
                }
              />
            )}
          </dl>
        </Card>
      </div>
      <ActionDialog action={action} expense={e} onClose={() => setAction(null)} />
    </>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="text-muted">{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function ActionDialog({
  action,
  expense,
  onClose,
}: {
  action: Action;
  expense: ExpenseDto;
  onClose: () => void;
}) {
  const t = useTranslations('expenses');
  const tCommon = useTranslations('common');
  const { property } = useSession();
  const queryClient = useQueryClient();
  const cashAccounts = useCashAccounts(property?.id, action === 'pay' || action === 'submit');
  const cur = property?.currencyCode ?? 'PKR';
  const [amount, setAmount] = useState('');
  const [cashAccountId, setCashAccountId] = useState('');
  const [text, setText] = useState('');
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [openedFor, setOpenedFor] = useState<Action>(null);
  if (action !== openedFor) {
    setOpenedFor(action);
    setAmount(expense.outstanding);
    setCashAccountId(expense.cashAccountId ?? '');
    setText('');
    setError(null);
  }

  const run = async () => {
    setBusy(true);
    setError(null);
    const path = `/properties/${property!.id}/expenses/${expense.id}/${action}`;
    const body =
      action === 'pay'
        ? { amount: amount.trim(), cashAccountId, reference: text.trim() || undefined }
        : action === 'void'
          ? { reason: text.trim() }
          : action === 'submit' && expense.kind === 'cash'
            ? { cashAccountId: cashAccountId || undefined }
            : {};
    try {
      await api.postWith(path, body, { 'idempotency-key': key });
      setKey(crypto.randomUUID());
      await queryClient.invalidateQueries({ queryKey: ['expenses'] });
      await queryClient.invalidateQueries({ queryKey: ['suppliers'] });
      await queryClient.invalidateQueries({ queryKey: ['finance'] });
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const titles: Record<Exclude<Action, null>, string> = {
    submit: expense.kind === 'cash' ? t('payTitle') : t('submitTitle'),
    approve: t('approveTitle'),
    pay: t('payBillTitle'),
    void: t('voidTitle'),
  };
  const explain: Record<Exclude<Action, null>, string> = {
    submit: expense.kind === 'cash' ? t('payExplain') : t('submitExplain'),
    approve: expense.kind === 'bill' ? t('approveBillExplain') : t('approveCashExplain'),
    pay: t('payBillExplain'),
    void: expense.journalEntryId ? t('voidPostedExplain') : t('voidExplain'),
  };
  const amountOk =
    /^\d{1,13}(\.\d{1,2})?$/.test(amount.trim()) &&
    Money.of(amount.trim(), cur).isPositive() &&
    Money.of(amount.trim(), cur).compare(Money.of(expense.outstanding, cur)) <= 0;
  const disabled =
    (action === 'pay' && (!amountOk || !cashAccountId)) ||
    (action === 'void' && text.trim().length < 3) ||
    (action === 'submit' && expense.kind === 'cash' && !cashAccountId);

  return (
    <Dialog open={action !== null} onClose={onClose} title={action ? titles[action] : ''}>
      <div className="flex flex-col gap-4">
        {action && <p className="text-sm text-muted">{explain[action]}</p>}
        {error !== null && <ApiErrorAlert error={error} />}
        {(action === 'pay' || (action === 'submit' && expense.kind === 'cash')) && (
          <SelectField
            label={t('paidFrom')}
            value={cashAccountId}
            onChange={(e) => setCashAccountId(e.target.value)}
          >
            <option value="">{t('chooseCashAccount')}</option>
            {(cashAccounts.data ?? [])
              .filter((c) => c.active)
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                  {c.balance !== null ? ` (${formatAmount(c.balance, cur)})` : ''}
                </option>
              ))}
          </SelectField>
        )}
        {action === 'pay' && (
          <TextField
            label={t('amount')}
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            hint={t('upTo', { amount: formatAmount(expense.outstanding, cur) })}
            className="tabular"
          />
        )}
        {(action === 'pay' || action === 'void') && (
          <TextField
            label={action === 'pay' ? t('paymentReference') : t('reason')}
            value={text}
            maxLength={action === 'pay' ? 80 : 500}
            onChange={(e) => setText(e.target.value)}
          />
        )}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            {tCommon('cancel')}
          </Button>
          <Button busy={busy} disabled={disabled} onClick={() => void run()}>
            {action ? titles[action] : ''}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
