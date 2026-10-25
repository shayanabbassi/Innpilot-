'use client';

import type {
  ExpenseAccountDto,
  ExpenseDraftRequest,
  ExpenseDto,
  ExpenseKind,
  SupplierDto,
} from '@innpilot/contracts';
import { Money } from '@innpilot/money';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { useCashAccounts } from '@/components/journal-form';
import { ApiErrorAlert, Button, Card, SelectField, TextField } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { formatAmount } from '@/lib/finance';
import { useSession } from '@/lib/session';

interface LineState {
  key: string;
  accountId: string;
  description: string;
  amount: string;
  taxAmount: string;
  taxRecoverable: boolean;
}
const blank = (): LineState => ({
  key: crypto.randomUUID(),
  accountId: '',
  description: '',
  amount: '',
  taxAmount: '',
  taxRecoverable: false,
});
const AMOUNT = /^\d{1,13}(\.\d{1,2})?$/;

export function useSuppliers(enabled = true) {
  return useQuery({
    queryKey: ['suppliers'],
    queryFn: () => api.get<SupplierDto[]>('/suppliers'),
    enabled,
  });
}

/** New expense or bill, or edit of a draft. Phone-friendly: one column, big targets, totals as you type. */
export function ExpenseForm({ draft }: { draft?: ExpenseDto }) {
  const t = useTranslations('expenses');
  const tCommon = useTranslations('common');
  const router = useRouter();
  const queryClient = useQueryClient();
  const { property } = useSession();
  const cur = property?.currencyCode ?? 'PKR';
  // Cashiers cannot read the chart of accounts, so the API lists the accounts an expense may use.
  const accounts = useQuery({
    queryKey: ['expenses', 'accounts', property?.id],
    queryFn: () => api.get<ExpenseAccountDto[]>(`/properties/${property!.id}/expenses/accounts`),
    enabled: !!property,
  });
  const suppliers = useSuppliers();
  const cashAccounts = useCashAccounts(property?.id);

  const [kind, setKind] = useState<ExpenseKind>(draft?.kind ?? 'cash');
  const [supplierId, setSupplierId] = useState(draft?.supplierId ?? '');
  const [payee, setPayee] = useState(draft?.payee ?? '');
  const [expenseDate, setExpenseDate] = useState(draft?.expenseDate ?? property?.businessDate ?? '');
  const [dueDate, setDueDate] = useState(draft?.dueDate ?? '');
  const [billReference, setBillReference] = useState(draft?.billReference ?? '');
  const [description, setDescription] = useState(draft?.description ?? '');
  const [attachmentRef, setAttachmentRef] = useState(draft?.attachmentRef ?? '');
  const [cashAccountId, setCashAccountId] = useState(draft?.cashAccountId ?? '');
  const [lines, setLines] = useState<LineState[]>(
    draft
      ? draft.lines.map((l) => ({
          key: l.id,
          accountId: l.accountId,
          description: l.description ?? '',
          amount: l.amount,
          taxAmount: /[1-9]/.test(l.taxAmount) ? l.taxAmount : '',
          taxRecoverable: l.taxRecoverable,
        }))
      : [blank()],
  );
  const [createKey, setCreateKey] = useState(() => crypto.randomUUID());
  const [submitKey, setSubmitKey] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState<'save' | 'submit' | null>(null);
  const [error, setError] = useState<unknown>(null);

  const choices = accounts.data ?? [];
  const activeCash = (cashAccounts.data ?? []).filter((c) => c.active);
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
  const fieldError = (path: string) =>
    error instanceof ApiError ? error.details.find((d) => d.path === path)?.message : undefined;

  const money = (v: string) => (AMOUNT.test(v.trim()) ? Money.of(v.trim(), cur) : Money.zero(cur));
  const net = Money.sum(
    lines.map((l) => money(l.amount)),
    cur,
  );
  const tax = Money.sum(
    lines.map((l) => money(l.taxAmount)),
    cur,
  );
  const update = (key: string, patch: Partial<LineState>) =>
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const body = (): ExpenseDraftRequest => ({
    kind,
    supplierId: supplierId || undefined,
    payee: kind === 'cash' ? payee.trim() || undefined : undefined,
    expenseDate,
    dueDate: kind === 'bill' ? dueDate || undefined : undefined,
    billReference: billReference.trim() || undefined,
    description: description.trim(),
    attachmentRef: attachmentRef.trim() || undefined,
    cashAccountId: kind === 'cash' ? cashAccountId || undefined : undefined,
    lines: lines
      .filter((l) => l.accountId || l.amount)
      .map((l) => ({
        accountId: l.accountId,
        description: l.description.trim() || undefined,
        amount: l.amount.trim(),
        taxAmount: l.taxAmount.trim() || '0',
        taxRecoverable: l.taxRecoverable,
      })),
  });

  const save = async (andSubmit: boolean) => {
    setError(null);
    setBusy(andSubmit ? 'submit' : 'save');
    let saved: ExpenseDto | null = null;
    try {
      saved = draft
        ? await api.put<ExpenseDto>(`/properties/${property!.id}/expenses/${draft.id}`, body())
        : await api.postWith<ExpenseDto>(`/properties/${property!.id}/expenses`, body(), {
            'idempotency-key': createKey,
          });
      setCreateKey(crypto.randomUUID());
      if (andSubmit) {
        await api.postWith(
          `/properties/${property!.id}/expenses/${saved.id}/submit`,
          {},
          {
            'idempotency-key': submitKey,
          },
        );
        setSubmitKey(crypto.randomUUID());
      }
      await queryClient.invalidateQueries({ queryKey: ['expenses'] });
      await queryClient.invalidateQueries({ queryKey: ['finance'] });
      router.push(`/expenses/${saved.id}`);
    } catch (err) {
      setError(err);
      // The draft was saved even if submitting failed; continue on its page.
      if (saved && !draft) router.push(`/expenses/${saved.id}?submitFailed=1`);
    } finally {
      setBusy(null);
    }
  };

  const ready =
    description.trim().length >= 3 &&
    !!expenseDate &&
    lines.some((l) => l.accountId && AMOUNT.test(l.amount.trim())) &&
    (kind === 'cash' || !!supplierId);

  return (
    <div className="flex flex-col gap-4">
      {error !== null && <ApiErrorAlert error={error} />}
      <Card>
        <div className="grid gap-4 sm:grid-cols-2">
          {!draft && (
            <fieldset className="sm:col-span-2">
              <legend className="mb-2 text-sm font-medium text-navy-800">{t('kind')}</legend>
              <div className="grid grid-cols-2 gap-2">
                {(['cash', 'bill'] as const).map((k) => (
                  <label
                    key={k}
                    className={`flex min-h-12 cursor-pointer flex-col justify-center rounded-md border px-3 py-2 text-sm ${
                      kind === k ? 'border-teal-700 bg-teal-50' : 'border-line bg-white'
                    }`}
                  >
                    <span className="flex items-center gap-2 font-medium">
                      <input
                        type="radio"
                        name="kind"
                        checked={kind === k}
                        onChange={() => setKind(k)}
                        className="h-4 w-4"
                      />
                      {t(`kinds.${k}`)}
                    </span>
                    <span className="text-xs text-muted">{t(`kindHints.${k}`)}</span>
                  </label>
                ))}
              </div>
            </fieldset>
          )}
          <SelectField
            label={kind === 'bill' ? t('supplier') : t('supplierOptional')}
            value={supplierId}
            onChange={(e) => setSupplierId(e.target.value)}
            error={fieldError('supplierId')}
          >
            <option value="">{t('chooseSupplier')}</option>
            {(suppliers.data ?? [])
              .filter((s) => s.active || s.id === supplierId)
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
          </SelectField>
          {kind === 'cash' && (
            <TextField
              label={t('payee')}
              value={payee}
              maxLength={160}
              onChange={(e) => setPayee(e.target.value)}
            />
          )}
          <TextField
            label={kind === 'bill' ? t('billDate') : t('expenseDate')}
            type="date"
            value={expenseDate}
            max={property?.businessDate}
            onChange={(e) => setExpenseDate(e.target.value)}
            error={fieldError('expenseDate')}
          />
          {kind === 'bill' && (
            <TextField
              label={t('dueDate')}
              type="date"
              value={dueDate}
              min={expenseDate}
              onChange={(e) => setDueDate(e.target.value)}
              hint={t('dueDateHint')}
              error={fieldError('dueDate')}
            />
          )}
          {kind === 'cash' && (
            <SelectField
              label={t('paidFrom')}
              value={cashAccountId}
              onChange={(e) => setCashAccountId(e.target.value)}
              error={fieldError('cashAccountId')}
            >
              <option value="">{t('chooseCashAccount')}</option>
              {activeCash.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </SelectField>
          )}
          <TextField
            label={t('description')}
            value={description}
            maxLength={500}
            onChange={(e) => setDescription(e.target.value)}
            className="sm:col-span-2"
          />
          <TextField
            label={kind === 'bill' ? t('billReference') : t('receiptReference')}
            value={billReference}
            maxLength={80}
            onChange={(e) => setBillReference(e.target.value)}
          />
          <TextField
            label={t('attachmentRef')}
            value={attachmentRef}
            maxLength={200}
            onChange={(e) => setAttachmentRef(e.target.value)}
            hint={t('attachmentRefHint')}
          />
        </div>
      </Card>

      <Card title={t('lines')}>
        <ol className="flex flex-col gap-3">
          {lines.map((l, i) => (
            <li key={l.key} className="grid gap-2 rounded-md border border-line p-3 sm:grid-cols-2">
              <SelectField
                label={t('lineAccount', { n: i + 1 })}
                value={l.accountId}
                onChange={(e) => update(l.key, { accountId: e.target.value })}
                error={lineErrors.get(l.key)}
                className="sm:col-span-2"
              >
                <option value="">{t('chooseAccount')}</option>
                {choices.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.code} · {a.name}
                  </option>
                ))}
              </SelectField>
              <TextField
                label={t('amount')}
                inputMode="decimal"
                value={l.amount}
                onChange={(e) => update(l.key, { amount: e.target.value })}
                className="tabular"
              />
              <TextField
                label={t('taxAmount')}
                inputMode="decimal"
                value={l.taxAmount}
                onChange={(e) => update(l.key, { taxAmount: e.target.value })}
                hint={t('taxHint')}
                className="tabular"
              />
              {money(l.taxAmount).isPositive() && (
                <label className="flex items-start gap-2 text-sm sm:col-span-2">
                  <input
                    type="checkbox"
                    className="mt-0.5 h-4 w-4"
                    checked={l.taxRecoverable}
                    onChange={(e) => update(l.key, { taxRecoverable: e.target.checked })}
                  />
                  {t('taxRecoverable')}
                </label>
              )}
              <TextField
                label={t('lineNote')}
                value={l.description}
                maxLength={300}
                onChange={(e) => update(l.key, { description: e.target.value })}
              />
              <div className="flex items-end justify-end">
                <Button
                  variant="ghost"
                  disabled={lines.length <= 1}
                  onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}
                  aria-label={t('removeLine', { n: i + 1 })}
                >
                  {t('remove')}
                </Button>
              </div>
            </li>
          ))}
        </ol>
        <div className="mt-3">
          <Button
            variant="secondary"
            onClick={() => setLines((ls) => [...ls, blank()])}
            disabled={lines.length >= 50}
          >
            {t('addLine')}
          </Button>
        </div>
        <dl className="mt-4 grid grid-cols-3 gap-2 border-t border-line pt-3 text-sm" aria-live="polite">
          <div>
            <dt className="text-muted">{t('net')}</dt>
            <dd className="tabular font-medium">{formatAmount(net.toString(), cur)}</dd>
          </div>
          <div>
            <dt className="text-muted">{t('tax')}</dt>
            <dd className="tabular font-medium">{formatAmount(tax.toString(), cur)}</dd>
          </div>
          <div>
            <dt className="text-muted">{t('total')}</dt>
            <dd className="tabular font-semibold">{formatAmount(net.add(tax).toString(), cur)}</dd>
          </div>
        </dl>
      </Card>

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button variant="secondary" onClick={() => router.back()}>
          {tCommon('cancel')}
        </Button>
        <Button
          variant="secondary"
          busy={busy === 'save'}
          disabled={busy !== null || !ready}
          onClick={() => void save(false)}
        >
          {t('saveDraft')}
        </Button>
        <Button
          busy={busy === 'submit'}
          disabled={busy !== null || !ready || (kind === 'cash' && !cashAccountId)}
          onClick={() => void save(true)}
        >
          {kind === 'cash' ? t('saveAndPay') : t('saveAndSubmit')}
        </Button>
      </div>
    </div>
  );
}
