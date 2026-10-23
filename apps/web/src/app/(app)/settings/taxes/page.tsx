'use client';

import type { AccountDto, ChargeCategoryDto, TaxCodeDto, TaxPreviewDto } from '@innpilot/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import { useAccounts } from '@/components/journal-form';
import {
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

type DialogState =
  | { kind: 'newCode' }
  | { kind: 'editCode'; code: TaxCodeDto }
  | { kind: 'addRate'; code: TaxCodeDto }
  | { kind: 'newCategory' }
  | { kind: 'editCategory'; category: ChargeCategoryDto }
  | null;

export default function TaxesPage() {
  const t = useTranslations('taxes');
  const { property, can } = useSession();
  const allowed = !!property && can('property.read');
  const canEdit = can('tax.configure');
  const base = `/properties/${property?.id ?? ''}`;
  const codes = useQuery({
    queryKey: ['tax', property?.id, 'codes'],
    queryFn: () => api.get<TaxCodeDto[]>(`${base}/tax-codes`),
    enabled: allowed,
  });
  const categories = useQuery({
    queryKey: ['tax', property?.id, 'categories'],
    queryFn: () => api.get<ChargeCategoryDto[]>(`${base}/charge-categories`),
    enabled: allowed,
  });
  const accounts = useAccounts(allowed && canEdit);
  const [dialog, setDialog] = useState<DialogState>(null);

  if (!allowed) return <PermissionDenied />;
  if (codes.isPending || categories.isPending) return <PageSkeleton />;
  if (codes.isError) return <PageError error={codes.error} onRetry={() => void codes.refetch()} />;
  if (categories.isError)
    return <PageError error={categories.error} onRetry={() => void categories.refetch()} />;
  const codeById = new Map(codes.data.map((c) => [c.id, c]));

  return (
    <>
      <PageHeader
        title={t('title')}
        subtitle={t('subtitle')}
        actions={
          <Link
            href="/settings/invoice"
            className="inline-flex min-h-10 items-center text-sm text-teal-700 underline"
          >
            {t('invoiceLink')}
          </Link>
        }
      />
      <div className="flex flex-col gap-4">
        <Card title={t('codesTitle')}>
          <p className="mb-3 text-sm text-muted">{t('codesNote')}</p>
          {codes.data.length === 0 ? (
            <EmptyState message={t('noCodes')} />
          ) : (
            <ul className="divide-y divide-line">
              {codes.data.map((c) => (
                <li key={c.id} className="py-3 text-sm">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="font-medium text-ink">
                      {c.code} · {c.name}
                    </span>
                    {c.jurisdiction && <span className="text-muted">{c.jurisdiction}</span>}
                    {!c.active && <StatusBadge tone="warning">{t('inactive')}</StatusBadge>}
                    <span className="flex-1" />
                    {canEdit && (
                      <>
                        <Button variant="ghost" onClick={() => setDialog({ kind: 'addRate', code: c })}>
                          {t('addRate')}
                          <span className="sr-only"> {c.code}</span>
                        </Button>
                        <Button variant="ghost" onClick={() => setDialog({ kind: 'editCode', code: c })}>
                          {t('edit')}
                          <span className="sr-only"> {c.code}</span>
                        </Button>
                      </>
                    )}
                  </div>
                  <p className="mt-1 text-muted">
                    {c.currentRate
                      ? t(c.currentRate.inclusive ? 'rateNowInclusive' : 'rateNowExclusive', {
                          rate: c.currentRate.ratePercent,
                          from: c.currentRate.effectiveFrom,
                        })
                      : t('noRateNow')}
                    {' · '}
                    {t('collectedInto', { account: `${c.payableAccountCode} ${c.payableAccountName}` })}
                  </p>
                  <RateHistory code={c} canEdit={canEdit} businessDate={property!.businessDate} base={base} />
                </li>
              ))}
            </ul>
          )}
          {canEdit && (
            <div className="mt-3">
              <Button variant="secondary" onClick={() => setDialog({ kind: 'newCode' })}>
                {t('addCode')}
              </Button>
            </div>
          )}
        </Card>

        <Card title={t('categoriesTitle')}>
          <p className="mb-3 text-sm text-muted">{t('categoriesNote')}</p>
          <ul className="divide-y divide-line">
            {categories.data.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-3 text-sm">
                <div className="min-w-48 flex-1">
                  <p className={`font-medium ${c.active ? 'text-ink' : 'text-muted'}`}>
                    {c.name} <span className="text-xs text-muted">({c.code})</span>
                  </p>
                  <p className="text-muted">
                    {c.revenueAccountCode} {c.revenueAccountName} ·{' '}
                    {c.taxCodeIds.length === 0
                      ? t('noTaxes')
                      : c.taxCodeIds.map((id) => codeById.get(id)?.code ?? '?').join(' + ')}
                  </p>
                </div>
                {c.systemKind === 'room' && <StatusBadge tone="neutral">{t('roomNights')}</StatusBadge>}
                {!c.active && <StatusBadge tone="warning">{t('inactive')}</StatusBadge>}
                {canEdit && (
                  <Button variant="ghost" onClick={() => setDialog({ kind: 'editCategory', category: c })}>
                    {t('edit')}
                    <span className="sr-only"> {c.name}</span>
                  </Button>
                )}
              </li>
            ))}
          </ul>
          {canEdit && (
            <div className="mt-3">
              <Button variant="secondary" onClick={() => setDialog({ kind: 'newCategory' })}>
                {t('addCategory')}
              </Button>
            </div>
          )}
        </Card>

        <Calculator
          base={base}
          categories={categories.data.filter((c) => c.active)}
          currency={property!.currencyCode}
        />
      </div>

      <SetupDialog
        state={dialog}
        onClose={() => setDialog(null)}
        base={base}
        businessDate={property!.businessDate}
        codes={codes.data}
        accounts={accounts.data ?? []}
      />
    </>
  );
}

function RateHistory({
  code,
  canEdit,
  businessDate,
  base,
}: {
  code: TaxCodeDto;
  canEdit: boolean;
  businessDate: string;
  base: string;
}) {
  const t = useTranslations('taxes');
  const queryClient = useQueryClient();
  const [error, setError] = useState<unknown>(null);
  if (code.rates.length < 2 && !code.rates.some((r) => r.effectiveFrom > businessDate)) return null;
  const remove = async (rateId: string) => {
    setError(null);
    try {
      await api.del(`${base}/tax-codes/${code.id}/rates/${rateId}`);
      await queryClient.invalidateQueries({ queryKey: ['tax'] });
    } catch (err) {
      setError(err);
    }
  };
  return (
    <details className="mt-2">
      <summary className="cursor-pointer text-xs text-teal-700">
        {t('history', { n: code.rates.length })}
      </summary>
      {error !== null && <ApiErrorAlert error={error} />}
      <ul className="mt-1 text-xs text-muted">
        {code.rates.map((r) => (
          <li key={r.id} className="flex items-center gap-2 py-0.5">
            <span className="tabular">{r.effectiveFrom}</span>
            <span>
              {r.ratePercent}% {r.inclusive ? t('inclusive') : t('exclusive')}
            </span>
            {r.effectiveFrom > businessDate ? (
              <>
                <StatusBadge tone="warning">{t('scheduled')}</StatusBadge>
                {canEdit && (
                  <button type="button" className="text-danger underline" onClick={() => void remove(r.id)}>
                    {t('withdraw')}
                  </button>
                )}
              </>
            ) : null}
          </li>
        ))}
      </ul>
    </details>
  );
}

function Calculator({
  base,
  categories,
  currency,
}: {
  base: string;
  categories: ChargeCategoryDto[];
  currency: string;
}) {
  const t = useTranslations('taxes');
  const [categoryId, setCategoryId] = useState(categories.find((c) => c.systemKind === 'room')?.id ?? '');
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState('');
  const valid = !!categoryId && /^\d{1,13}(\.\d{1,2})?$/.test(amount.trim());
  const result = useQuery({
    queryKey: ['tax', base, 'preview', categoryId, amount.trim(), date],
    queryFn: () =>
      api.post<TaxPreviewDto>(`${base}/tax-preview`, {
        categoryId,
        amount: amount.trim(),
        ...(date ? { serviceDate: date } : {}),
      }),
    enabled: valid,
  });
  const fmt = (v: string) => formatAmount(v, currency);
  return (
    <Card title={t('calculatorTitle')}>
      <div className="grid gap-4 sm:grid-cols-3">
        <SelectField label={t('category')} value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </SelectField>
        <TextField
          label={t('amount')}
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          hint={t('amountHint')}
        />
        <TextField
          label={t('serviceDate')}
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
        />
      </div>
      {result.isError && <ApiErrorAlert error={result.error} />}
      {valid && result.data && (
        <dl className="mt-4 grid gap-1 text-sm" aria-live="polite">
          <Row label={t('net')}>{fmt(result.data.net)}</Row>
          {result.data.lines.map((l) => (
            <Row
              key={l.taxCodeId}
              label={`${l.code} ${l.ratePercent}% ${l.inclusive ? t('inclusive') : t('exclusive')}`}
            >
              {fmt(l.amount)}
            </Row>
          ))}
          <Row label={t('gross')} strong>
            {fmt(result.data.gross)}
          </Row>
          {result.data.notInEffect.length > 0 && (
            <p className="text-xs text-warning">
              {t('notInEffect', { codes: result.data.notInEffect.join(', ') })}
            </p>
          )}
        </dl>
      )}
    </Card>
  );
}

function Row({ label, children, strong }: { label: string; children: ReactNode; strong?: boolean }) {
  return (
    <div className={`flex justify-between gap-4 ${strong ? 'border-t border-line pt-1 font-semibold' : ''}`}>
      <dt className={strong ? '' : 'text-muted'}>{label}</dt>
      <dd className="tabular">{children}</dd>
    </div>
  );
}

function SetupDialog({
  state,
  onClose,
  base,
  businessDate,
  codes,
  accounts,
}: {
  state: DialogState;
  onClose: () => void;
  base: string;
  businessDate: string;
  codes: TaxCodeDto[];
  accounts: AccountDto[];
}) {
  const t = useTranslations('taxes');
  const tCommon = useTranslations('common');
  const queryClient = useQueryClient();
  const [form, setForm] = useState<Record<string, string>>({});
  const [taxIds, setTaxIds] = useState<string[]>([]);
  const [inclusive, setInclusive] = useState(false);
  const [active, setActive] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [openedFor, setOpenedFor] = useState<DialogState>(null);

  if (state !== openedFor) {
    setOpenedFor(state);
    setError(null);
    setInclusive(false);
    const code = state?.kind === 'editCode' ? state.code : null;
    const cat = state?.kind === 'editCategory' ? state.category : null;
    setForm({
      code: '',
      name: code?.name ?? cat?.name ?? '',
      jurisdiction: code?.jurisdiction ?? '',
      account: code?.payableAccountId ?? cat?.revenueAccountId ?? '',
      rate: '',
      from: businessDate,
    });
    setTaxIds(cat?.taxCodeIds ?? []);
    setActive(code?.active ?? cat?.active ?? true);
  }
  const set = (k: string) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));
  const isCode = state?.kind === 'newCode' || state?.kind === 'editCode';
  const accountChoices = accounts.filter(
    (a) =>
      a.active &&
      (isCode
        ? a.accountClass === 'liability'
        : (a.accountClass === 'revenue' || a.accountClass === 'other') && a.normalBalance === 'credit'),
  );

  const save = async () => {
    if (!state) return;
    setBusy(true);
    setError(null);
    const rate = { effectiveFrom: form.from, ratePercent: form.rate?.trim(), inclusive };
    try {
      if (state.kind === 'newCode') {
        await api.post(`${base}/tax-codes`, {
          code: form.code,
          name: form.name,
          ...(form.jurisdiction ? { jurisdiction: form.jurisdiction } : {}),
          ...(form.account ? { payableAccountId: form.account } : {}),
          firstRate: rate,
        });
      } else if (state.kind === 'editCode') {
        await api.patch(`${base}/tax-codes/${state.code.id}`, {
          name: form.name,
          jurisdiction: form.jurisdiction || null,
          payableAccountId: form.account,
          active,
        });
      } else if (state.kind === 'addRate') {
        await api.post(`${base}/tax-codes/${state.code.id}/rates`, rate);
      } else if (state.kind === 'newCategory') {
        await api.post(`${base}/charge-categories`, {
          code: form.code,
          name: form.name,
          revenueAccountId: form.account,
          taxCodeIds: taxIds,
        });
      } else {
        await api.patch(`${base}/charge-categories/${state.category.id}`, {
          name: form.name,
          revenueAccountId: form.account,
          taxCodeIds: taxIds,
          ...(state.category.systemKind ? {} : { active }),
        });
      }
      await queryClient.invalidateQueries({ queryKey: ['tax'] });
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const title = !state
    ? ''
    : state.kind === 'newCode'
      ? t('addCode')
      : state.kind === 'editCode'
        ? t('editCode', { code: state.code.code })
        : state.kind === 'addRate'
          ? t('addRateTitle', { code: state.code.code })
          : state.kind === 'newCategory'
            ? t('addCategory')
            : t('editCategory', { name: state.category.name });
  const showRate = state?.kind === 'newCode' || state?.kind === 'addRate';
  const isNew = state?.kind === 'newCode' || state?.kind === 'newCategory';

  return (
    <Dialog open={state !== null} onClose={onClose} title={title}>
      <div className="flex flex-col gap-4">
        {error !== null && <ApiErrorAlert error={error} />}
        {isNew && (
          <TextField
            label={t('codeLabel')}
            value={form.code ?? ''}
            onChange={set('code')}
            hint={isCode ? t('codeHint') : t('categoryCodeHint')}
          />
        )}
        {state?.kind !== 'addRate' && (
          <TextField label={t('nameLabel')} value={form.name ?? ''} onChange={set('name')} />
        )}
        {isCode && (
          <TextField
            label={t('jurisdiction')}
            value={form.jurisdiction ?? ''}
            onChange={set('jurisdiction')}
            hint={t('jurisdictionHint')}
          />
        )}
        {state?.kind !== 'addRate' && (
          <SelectField
            label={isCode ? t('payableAccount') : t('revenueAccount')}
            value={form.account ?? ''}
            onChange={set('account')}
          >
            {isCode && <option value="">{t('defaultPayable')}</option>}
            {!isCode && !form.account && <option value="">{t('chooseAccount')}</option>}
            {accountChoices.map((a) => (
              <option key={a.id} value={a.id}>
                {a.code} · {a.name}
              </option>
            ))}
          </SelectField>
        )}
        {showRate && (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField
                label={t('ratePercent')}
                inputMode="decimal"
                value={form.rate ?? ''}
                onChange={set('rate')}
              />
              <TextField
                label={t('effectiveFrom')}
                type="date"
                min={businessDate}
                value={form.from ?? ''}
                onChange={set('from')}
                hint={t('effectiveHint')}
              />
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="h-4 w-4"
                checked={inclusive}
                onChange={(e) => setInclusive(e.target.checked)}
              />
              {t('inclusiveLabel')}
            </label>
          </>
        )}
        {(state?.kind === 'newCategory' || state?.kind === 'editCategory') && (
          <fieldset className="flex flex-col gap-2 text-sm">
            <legend className="mb-1 font-medium text-ink">{t('taxesOnCategory')}</legend>
            {codes.length === 0 && <p className="text-muted">{t('noCodes')}</p>}
            {codes.map((c) => (
              <label key={c.id} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  className="h-4 w-4"
                  checked={taxIds.includes(c.id)}
                  onChange={(e) =>
                    setTaxIds((ids) => (e.target.checked ? [...ids, c.id] : ids.filter((x) => x !== c.id)))
                  }
                />
                {c.code} · {c.name}
                {!c.active && <span className="text-muted">({t('inactive')})</span>}
              </label>
            ))}
          </fieldset>
        )}
        {(state?.kind === 'editCode' || (state?.kind === 'editCategory' && !state.category.systemKind)) && (
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
          <Button busy={busy} onClick={() => void save()}>
            {busy ? tCommon('saving') : tCommon('save')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
