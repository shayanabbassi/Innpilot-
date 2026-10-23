'use client';

import type {
  ChargeCategoryDto,
  FolioChargeDto,
  FolioPaymentDto,
  PaymentDto,
  FolioDto,
  OpenFolioDto,
  TaxPreviewDto,
} from '@innpilot/contracts';
import { Money } from '@innpilot/money';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useState } from 'react';
import {
  Alert,
  ApiErrorAlert,
  Button,
  Card,
  Dialog,
  SelectField,
  StatusBadge,
  TextField,
} from '@/components/ui';
import { api } from '@/lib/api';
import { formatAmount } from '@/lib/finance';
import { useSession } from '@/lib/session';

type Action =
  | { kind: 'charge' }
  | { kind: 'allowance' }
  | { kind: 'folio' }
  | { kind: 'void'; item: FolioChargeDto }
  | { kind: 'transfer'; item: FolioChargeDto }
  | { kind: 'payment'; suggested: string }
  | { kind: 'refund'; payment: FolioPaymentDto }
  | null;

const AMOUNT = /^\d{1,13}(\.\d{1,2})?$/;
const QTY = /^\d{1,7}(\.\d{1,2})?$/;

/** Folios of one reservation: items, balance, pending room nights (posted at check-out) and corrections. */
export function FolioPanel({
  reservationId,
  reservationStatus,
}: {
  reservationId: string;
  reservationStatus: string;
}) {
  const t = useTranslations('folio');
  const { property, can } = useSession();
  const base = `/properties/${property?.id ?? ''}`;
  const folios = useQuery({
    queryKey: ['folios', reservationId],
    queryFn: () => api.get<FolioDto[]>(`${base}/reservations/${reservationId}/folios`),
    enabled: !!property,
  });
  const [selected, setSelected] = useState<string | null>(null);
  const [action, setAction] = useState<Action>(null);
  const canCharge = can('folio.charge');
  const canAdjust = can('folio.adjust');
  const canReceive = can('payment.receive');
  const canRefund = can('payment.refund');

  if (folios.isPending)
    return (
      <Card title={t('title')}>
        <p className="text-sm text-muted">…</p>
      </Card>
    );
  if (folios.isError) {
    return (
      <Card title={t('title')}>
        <ApiErrorAlert error={folios.error} />
      </Card>
    );
  }
  const list = folios.data;
  const canOpen = canCharge && ['pending', 'confirmed', 'checked_in'].includes(reservationStatus);
  if (list.length === 0) {
    return (
      <Card title={t('title')}>
        <p className="text-sm text-muted">{t('none')}</p>
        <div className="mt-3 flex flex-wrap gap-2">
          {canReceive && ['pending', 'confirmed'].includes(reservationStatus) && (
            <Button onClick={() => setAction({ kind: 'payment', suggested: '' })}>{t('takeDeposit')}</Button>
          )}
          {canOpen && (
            <Button variant="secondary" onClick={() => setAction({ kind: 'folio' })}>
              {t('openFolio')}
            </Button>
          )}
        </div>
        <ActionDialog
          action={action}
          onClose={() => setAction(null)}
          base={base}
          reservationId={reservationId}
          folio={null}
        />
      </Card>
    );
  }
  const folio = list.find((x) => x.id === selected) ?? list[0]!;
  const cur = folio.currencyCode;
  const fmt = (v: string) => formatAmount(v, cur);
  const open = folio.status === 'open';
  // Nights slept and "if checking out today" only mean something once the guest is in house.
  const inHouse = reservationStatus === 'checked_in';

  return (
    <Card title={t('title')}>
      {list.length > 1 && (
        <div role="tablist" aria-label={t('folios')} className="mb-4 flex flex-wrap gap-2">
          {list.map((x) => (
            <button
              key={x.id}
              role="tab"
              type="button"
              aria-selected={x.id === folio.id}
              onClick={() => setSelected(x.id)}
              className={`min-h-9 rounded-full border px-3 text-sm ${
                x.id === folio.id
                  ? 'border-teal-600 bg-teal-50 text-teal-700'
                  : 'border-line bg-white text-ink'
              }`}
            >
              {x.label} · <span className="tabular">{formatAmount(x.balance, x.currencyCode)}</span>
            </button>
          ))}
        </div>
      )}

      <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-muted">{t('balance')}</dt>
          <dd className="tabular text-lg font-semibold">{fmt(folio.balance)}</dd>
        </div>
        {folio.isPrimary && open && inHouse && (
          <>
            <div>
              <dt className="text-muted">{t('pendingNights', { n: folio.pendingNights.length })}</dt>
              <dd className="tabular">{fmt(folio.pending.gross)}</dd>
            </div>
            <div>
              <dt className="text-muted">{t('ifCheckOutToday')}</dt>
              <dd className="tabular font-medium">{fmt(folio.balanceWithPending)}</dd>
            </div>
          </>
        )}
      </dl>
      {folio.isPrimary &&
        open &&
        ['pending', 'confirmed', 'checked_in'].includes(reservationStatus) &&
        folio.stayEstimate.nights > 0 && (
          <p className="mt-2 text-xs text-muted">
            {t('estimate', { n: folio.stayEstimate.nights, amount: fmt(folio.stayEstimate.gross) })}
          </p>
        )}
      {Money.of(folio.depositHeld, cur).isPositive() && (
        <p className="mt-1 text-xs text-muted">{t('depositHeld', { amount: fmt(folio.depositHeld) })}</p>
      )}
      {folio.status === 'settled' && <Alert tone="info">{t('closed')}</Alert>}
      {folio.status === 'on_account' && (
        <Alert tone="warning">
          <p>{t('onAccount', { amount: fmt(folio.balance) })}</p>
          {canReceive && Money.of(folio.balance, cur).isPositive() && (
            <div className="mt-2">
              <Button onClick={() => setAction({ kind: 'payment', suggested: folio.balance })}>
                {t('takePayment')}
              </Button>
            </div>
          )}
        </Alert>
      )}
      {folio.invoices.length > 0 && (
        <p className="mt-2 text-sm">
          {t('invoicesLabel')}{' '}
          {folio.invoices.map((inv, i) => (
            <span key={inv.id}>
              {i > 0 && ', '}
              <Link href={`/invoices/${inv.id}`} className="font-medium text-teal-700 underline">
                {inv.invoiceNumber}
              </Link>
            </span>
          ))}
        </p>
      )}
      {Money.of(folio.writtenOff, cur).isPositive() && (
        <p className="mt-1 text-xs text-muted">{t('writtenOff', { amount: fmt(folio.writtenOff) })}</p>
      )}

      <ul className="mt-4 divide-y divide-line border-y border-line text-sm">
        {folio.charges.length === 0 && <li className="py-3 text-muted">{t('noItems')}</li>}
        {folio.charges.map((item) => (
          <li key={item.id} className="py-3">
            <div className="flex flex-wrap items-start gap-x-3 gap-y-1">
              <span className="tabular w-24 text-muted">{item.serviceDate}</span>
              <div className="min-w-40 flex-1">
                <p className={item.status === 'posted' ? 'text-ink' : 'text-muted line-through'}>
                  {item.description}
                </p>
                <p className="text-xs text-muted">
                  {item.categoryName}
                  {item.quantity !== '1' && ` · ${item.quantity} × ${fmt(item.unitPrice)}`}
                  {item.taxes.map((x) => ` · ${x.code} ${x.ratePercent}% ${fmt(x.amount)}`).join('')}
                  {item.journalNumber && (
                    <>
                      {' · '}
                      <Link href={`/finance/journals/${item.journalEntryId}`} className="underline">
                        {t('journal', { n: item.journalNumber })}
                      </Link>
                    </>
                  )}
                </p>
                {item.reason && <p className="text-xs text-muted">{t('reason', { reason: item.reason })}</p>}
                {item.voidReason && (
                  <p className="text-xs text-danger">{t('voidedBecause', { reason: item.voidReason })}</p>
                )}
                {item.transferredTo && (
                  <p className="text-xs text-muted">
                    {t('movedTo', {
                      folio: item.transferredTo.folioLabel,
                      ref: item.transferredTo.bookingReference,
                    })}
                  </p>
                )}
                {item.transferredFrom && (
                  <p className="text-xs text-muted">
                    {t('movedFrom', {
                      folio: item.transferredFrom.folioLabel,
                      ref: item.transferredFrom.bookingReference,
                    })}
                  </p>
                )}
              </div>
              <span className="tabular font-medium">{fmt(item.gross)}</span>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-2 pl-0 sm:pl-[6.75rem]">
              {item.kind === 'allowance' && <StatusBadge tone="neutral">{t('kinds.allowance')}</StatusBadge>}
              {item.status !== 'posted' && (
                <StatusBadge tone="warning">{t(`statuses.${item.status}`)}</StatusBadge>
              )}
              {item.status === 'posted' && open && canAdjust && (
                <>
                  <Button variant="ghost" onClick={() => setAction({ kind: 'void', item })}>
                    {t('void')}
                    <span className="sr-only"> {item.description}</span>
                  </Button>
                  <Button variant="ghost" onClick={() => setAction({ kind: 'transfer', item })}>
                    {t('transfer')}
                    <span className="sr-only"> {item.description}</span>
                  </Button>
                </>
              )}
            </div>
          </li>
        ))}
      </ul>

      {folio.isPrimary && open && inHouse && folio.pendingNights.length > 0 && (
        <details className="mt-3 text-sm">
          <summary className="cursor-pointer text-teal-700">{t('pendingDetail')}</summary>
          <ul className="mt-2 text-muted">
            {folio.pendingNights.map((n) => (
              <li key={`${n.date}-${n.roomNumber}`} className="flex justify-between gap-2 py-0.5">
                <span className="tabular">
                  {n.date} · {n.roomNumber ?? '—'}
                </span>
                <span className="tabular">
                  {fmt(n.net)} + {fmt(n.tax)} = {fmt(n.gross)}
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-1 text-xs text-muted">{t('pendingNote')}</p>
        </details>
      )}

      {folio.payments.length > 0 && (
        <section className="mt-4">
          <h3 className="mb-1 text-sm font-medium text-ink">{t('paymentsTitle')}</h3>
          <ul className="divide-y divide-line border-y border-line text-sm">
            {folio.payments.map((pay) => (
              <li key={pay.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                <span className="tabular w-24 text-muted">{pay.businessDate}</span>
                <span className="min-w-40 flex-1">
                  <Link href={`/receipts/${pay.id}`} className="font-medium text-teal-700 underline">
                    {pay.receiptNumber}
                  </Link>{' '}
                  <span className="text-xs text-muted">
                    {t(`kinds.${pay.kind}`)} · {t(`methods.${pay.method}`)}
                    {Money.of(pay.refunded, cur).isPositive() &&
                      ` · ${t('refundedAmount', { amount: fmt(pay.refunded) })}`}
                    {Money.of(pay.applied, cur).isPositive() &&
                      ` · ${t('appliedAmount', { amount: fmt(pay.applied) })}`}
                  </span>
                </span>
                <span className="tabular font-medium">−{fmt(pay.amount)}</span>
                {open && canRefund && Money.of(pay.refundable, cur).isPositive() && (
                  <Button variant="ghost" onClick={() => setAction({ kind: 'refund', payment: pay })}>
                    {t('refund')}
                    <span className="sr-only"> {pay.receiptNumber}</span>
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {open && (canCharge || canAdjust || canReceive) && (
        <div className="mt-4 flex flex-wrap gap-2">
          {canReceive && ['pending', 'confirmed', 'checked_in'].includes(reservationStatus) && (
            <Button
              onClick={() => {
                const due = Money.of(folio.balance, cur).add(Money.of(folio.stayEstimate.gross, cur));
                setAction({ kind: 'payment', suggested: due.isPositive() ? due.toString() : '' });
              }}
            >
              {['pending', 'confirmed'].includes(reservationStatus) ? t('takeDeposit') : t('takePayment')}
            </Button>
          )}
          {canCharge && (
            <Button variant="secondary" onClick={() => setAction({ kind: 'charge' })}>
              {t('addCharge')}
            </Button>
          )}
          {canAdjust && (
            <Button variant="secondary" onClick={() => setAction({ kind: 'allowance' })}>
              {t('addAllowance')}
            </Button>
          )}
          {canOpen && (
            <Button variant="ghost" onClick={() => setAction({ kind: 'folio' })}>
              {t('newFolio')}
            </Button>
          )}
        </div>
      )}
      <ActionDialog
        action={action}
        onClose={() => setAction(null)}
        base={base}
        reservationId={reservationId}
        folio={folio}
        onFolioCreated={setSelected}
      />
    </Card>
  );
}

function ActionDialog({
  action,
  onClose,
  base,
  reservationId,
  folio,
  onFolioCreated,
}: {
  action: Action;
  onClose: () => void;
  base: string;
  reservationId: string;
  folio: FolioDto | null;
  onFolioCreated?: (id: string) => void;
}) {
  const t = useTranslations('folio');
  const tCommon = useTranslations('common');
  const queryClient = useQueryClient();
  const { property } = useSession();
  const currency = folio?.currencyCode ?? property?.currencyCode ?? 'PKR';
  const [v, setV] = useState<Record<string, string>>({});
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [openedFor, setOpenedFor] = useState<Action>(null);
  const needsCategories = action?.kind === 'charge' || action?.kind === 'allowance';
  const categories = useQuery({
    queryKey: ['tax', property?.id, 'categories'],
    queryFn: () => api.get<ChargeCategoryDto[]>(`${base}/charge-categories`),
    enabled: needsCategories,
  });
  const targets = useQuery({
    queryKey: ['folios', 'open', property?.id],
    queryFn: () => api.get<OpenFolioDto[]>(`${base}/folios`),
    enabled: action?.kind === 'transfer',
  });

  if (action !== openedFor) {
    setOpenedFor(action);
    setError(null);
    setKey(crypto.randomUUID());
    setV(
      action?.kind === 'payment'
        ? { amount: action.suggested, method: 'cash' }
        : action?.kind === 'refund'
          ? { amount: action.payment.refundable, method: action.payment.method }
          : { quantity: '1' },
    );
  }
  const set = (k: string) => (e: { target: { value: string } }) =>
    setV((x) => ({ ...x, [k]: e.target.value }));
  const usable = (categories.data ?? []).filter((c) => c.active && c.systemKind !== 'room');
  const categoryId = v.categoryId ?? usable[0]?.id ?? '';

  // Live tax for a charge or allowance, from the server's own calculation.
  const entered =
    action?.kind === 'charge'
      ? QTY.test(v.quantity ?? '') && AMOUNT.test(v.unitPrice ?? '')
        ? Money.of(v.quantity!, currency).multiply(v.unitPrice!).round().toString()
        : null
      : action?.kind === 'allowance' && AMOUNT.test(v.amount ?? '')
        ? v.amount!
        : null;
  const preview = useQuery({
    queryKey: ['tax', base, 'preview', categoryId, entered, v.serviceDate ?? ''],
    queryFn: () =>
      api.post<TaxPreviewDto>(`${base}/tax-preview`, {
        categoryId,
        amount: entered,
        ...(v.serviceDate ? { serviceDate: v.serviceDate } : {}),
      }),
    enabled: !!entered && !!categoryId && /[1-9]/.test(entered),
  });

  const submit = async () => {
    if (!action) return;
    setBusy(true);
    setError(null);
    const headers = { 'idempotency-key': key };
    try {
      if (action.kind === 'folio') {
        const created = await api.post<FolioDto>(`${base}/reservations/${reservationId}/folios`, {
          label: (v.label ?? '').trim() || 'Main',
        });
        onFolioCreated?.(created.id);
      } else if (action.kind === 'charge') {
        await api.postWith(
          `${base}/folios/${folio!.id}/charges`,
          {
            categoryId,
            description: (v.description ?? '').trim(),
            quantity: (v.quantity ?? '1').trim(),
            unitPrice: (v.unitPrice ?? '').trim(),
            ...(v.serviceDate ? { serviceDate: v.serviceDate } : {}),
          },
          headers,
        );
      } else if (action.kind === 'allowance') {
        await api.postWith(
          `${base}/folios/${folio!.id}/allowances`,
          {
            categoryId,
            description: (v.description ?? '').trim(),
            amount: (v.amount ?? '').trim(),
            reason: (v.reason ?? '').trim(),
          },
          headers,
        );
      } else if (action.kind === 'payment') {
        await api.postWith<PaymentDto>(
          `${base}/payments`,
          {
            ...(folio ? { folioId: folio.id } : { reservationId }),
            amount: (v.amount ?? '').trim(),
            method: v.method ?? 'cash',
            ...(v.externalReference?.trim() ? { externalReference: v.externalReference.trim() } : {}),
            ...(v.notes?.trim() ? { notes: v.notes.trim() } : {}),
          },
          headers,
        );
      } else if (action.kind === 'refund') {
        await api.postWith<PaymentDto>(
          `${base}/payments/${action.payment.id}/refunds`,
          {
            amount: (v.amount ?? '').trim(),
            method: v.method,
            reason: (v.reason ?? '').trim(),
            ...(v.externalReference?.trim() ? { externalReference: v.externalReference.trim() } : {}),
          },
          headers,
        );
      } else if (action.kind === 'void') {
        await api.postWith(
          `${base}/folio-charges/${action.item.id}/void`,
          { reason: (v.reason ?? '').trim() },
          headers,
        );
      } else {
        await api.postWith(
          `${base}/folio-charges/${action.item.id}/transfer`,
          { toFolioId: v.toFolioId, reason: (v.reason ?? '').trim() },
          headers,
        );
      }
      await queryClient.invalidateQueries({ queryKey: ['folios'] });
      await queryClient.invalidateQueries({ queryKey: ['finance'] });
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const title = !action
    ? ''
    : action.kind === 'void'
      ? t('voidTitle', { item: action.item.description })
      : action.kind === 'transfer'
        ? t('transferTitle', { item: action.item.description })
        : action.kind === 'refund'
          ? t('refundTitle', { receipt: action.payment.receiptNumber })
          : action.kind === 'payment' && !folio
            ? t('depositTitle')
            : t(`${action.kind}Title`);
  const otherFolios = (targets.data ?? []).filter((x) => x.id !== folio?.id);

  return (
    <Dialog open={action !== null} onClose={onClose} title={title}>
      <div className="flex flex-col gap-4">
        {error !== null && <ApiErrorAlert error={error} />}
        {(action?.kind === 'payment' || action?.kind === 'refund') && (
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              label={action.kind === 'refund' ? t('refundAmount') : t('amountReceived')}
              inputMode="decimal"
              value={v.amount ?? ''}
              onChange={set('amount')}
              hint={
                action.kind === 'refund'
                  ? t('refundableHint', { amount: formatAmount(action.payment.refundable, currency) })
                  : undefined
              }
            />
            <SelectField label={t('method')} value={v.method ?? 'cash'} onChange={set('method')}>
              {(['cash', 'bank_transfer', 'card', 'other'] as const).map((m) => (
                <option key={m} value={m}>
                  {t(`methods.${m}`)}
                </option>
              ))}
            </SelectField>
            <TextField
              label={t('externalReference')}
              value={v.externalReference ?? ''}
              maxLength={60}
              onChange={set('externalReference')}
              hint={t('externalReferenceHint')}
              className="sm:col-span-2"
            />
            {action.kind === 'payment' && (
              <TextField
                label={t('notes')}
                value={v.notes ?? ''}
                maxLength={300}
                onChange={set('notes')}
                className="sm:col-span-2"
              />
            )}
          </div>
        )}
        {action?.kind === 'folio' && (
          <TextField
            label={t('folioLabel')}
            value={v.label ?? ''}
            maxLength={40}
            onChange={set('label')}
            hint={t('folioLabelHint')}
          />
        )}
        {needsCategories && (
          <>
            <SelectField label={t('category')} value={categoryId} onChange={set('categoryId')}>
              {usable.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </SelectField>
            <TextField
              label={t('description')}
              value={v.description ?? ''}
              maxLength={200}
              onChange={set('description')}
            />
          </>
        )}
        {action?.kind === 'charge' && (
          <div className="grid grid-cols-2 gap-4">
            <TextField
              label={t('quantity')}
              inputMode="decimal"
              value={v.quantity ?? ''}
              onChange={set('quantity')}
            />
            <TextField
              label={t('unitPrice')}
              inputMode="decimal"
              value={v.unitPrice ?? ''}
              onChange={set('unitPrice')}
            />
            <TextField
              label={t('serviceDate')}
              type="date"
              max={property?.businessDate}
              value={v.serviceDate ?? ''}
              onChange={set('serviceDate')}
              hint={t('serviceDateHint')}
              className="col-span-2"
            />
          </div>
        )}
        {action?.kind === 'allowance' && (
          <TextField
            label={t('allowanceAmount')}
            inputMode="decimal"
            value={v.amount ?? ''}
            onChange={set('amount')}
          />
        )}
        {needsCategories && preview.data && (
          <dl className="rounded-md bg-canvas p-3 text-sm" aria-live="polite">
            <div className="flex justify-between">
              <dt className="text-muted">{t('net')}</dt>
              <dd className="tabular">{formatAmount(preview.data.net, currency)}</dd>
            </div>
            {preview.data.lines.map((l) => (
              <div key={l.taxCodeId} className="flex justify-between">
                <dt className="text-muted">
                  {l.code} {l.ratePercent}%
                </dt>
                <dd className="tabular">{formatAmount(l.amount, currency)}</dd>
              </div>
            ))}
            <div className="flex justify-between font-semibold">
              <dt>{action?.kind === 'allowance' ? t('takenOff') : t('total')}</dt>
              <dd className="tabular">{formatAmount(preview.data.gross, currency)}</dd>
            </div>
          </dl>
        )}
        {action?.kind === 'transfer' && (
          <SelectField label={t('toFolio')} value={v.toFolioId ?? ''} onChange={set('toFolioId')}>
            <option value="">{t('chooseFolio')}</option>
            {otherFolios.map((x) => (
              <option key={x.id} value={x.id}>
                {x.bookingReference} · {x.label} · {x.guestName}
                {x.roomNumber ? ` · ${x.roomNumber}` : ''}
              </option>
            ))}
          </SelectField>
        )}
        {action?.kind === 'void' && (
          <p className="text-sm text-muted">
            {t('voidExplain', { amount: formatAmount(action.item.gross, currency) })}
          </p>
        )}
        {(action?.kind === 'allowance' ||
          action?.kind === 'void' ||
          action?.kind === 'transfer' ||
          action?.kind === 'refund') && (
          <TextField
            label={t('reasonLabel')}
            value={v.reason ?? ''}
            maxLength={500}
            onChange={set('reason')}
          />
        )}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            {tCommon('cancel')}
          </Button>
          <Button
            busy={busy}
            variant={action?.kind === 'void' ? 'danger' : 'primary'}
            disabled={
              (action?.kind !== 'folio' &&
                action?.kind !== 'charge' &&
                action?.kind !== 'payment' &&
                (v.reason ?? '').trim().length < 3) ||
              (action?.kind === 'transfer' && !v.toFolioId)
            }
            onClick={() => void submit()}
          >
            {busy ? tCommon('saving') : action ? t(`submit.${action.kind}`) : ''}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
