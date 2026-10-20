'use client';

import type {
  CheckOutResultDto,
  CheckoutPreviewDto,
  FolioSettlement,
  PaymentMethod,
  SettlementAction,
} from '@innpilot/contracts';
import { PAYMENT_METHODS } from '@innpilot/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
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
import { api } from '@/lib/api';
import { formatAmount } from '@/lib/finance';
import { useSession } from '@/lib/session';

interface Choice {
  action: SettlementAction;
  method: PaymentMethod;
  externalReference: string;
  reason: string;
}

/**
 * Check-out (FIN-008, OPS-003, D7): what will be posted and applied, then how each folio is settled. The preview is
 * the server's own dry run, so the amounts shown are the amounts that will be posted.
 */
export default function CheckOutPage() {
  const t = useTranslations('checkout');
  const tFolio = useTranslations('folio');
  const tCommon = useTranslations('common');
  const { stayId } = useParams<{ stayId: string }>();
  const queryClient = useQueryClient();
  const { property, can } = useSession();
  const allowed = !!property && can('stay.checkout');
  const base = `/properties/${property?.id ?? ''}`;
  const preview = useQuery({
    queryKey: ['checkout-preview', stayId],
    queryFn: () => api.get<CheckoutPreviewDto>(`${base}/stays/${stayId}/checkout-preview`),
    enabled: allowed,
  });
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState<CheckOutResultDto | null>(null);

  if (!allowed) return <PermissionDenied />;
  if (done) {
    return (
      <>
        <PageHeader title={t('doneTitle')} />
        <div className="flex flex-col gap-4">
          <Alert tone="success">
            {t('done', { nights: done.nightsPosted })}
            {done.reservationStatus !== 'checked_out' && ` ${t('othersStill')}`}
          </Alert>
          {done.invoices.length > 0 && (
            <Card title={t('invoices')}>
              <ul className="flex flex-col gap-2 text-sm">
                {done.invoices.map((i) => (
                  <li key={i.id} className="flex justify-between gap-2">
                    <Link href={`/invoices/${i.id}`} className="font-medium text-teal-700 underline">
                      {i.invoiceNumber}
                    </Link>
                    <span className="tabular">
                      {formatAmount(i.gross, property.currencyCode)}
                      {/[1-9]/.test(i.balanceDue) &&
                        ` · ${t('onAccount', { amount: formatAmount(i.balanceDue, property.currencyCode) })}`}
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
          <div className="flex flex-wrap gap-2">
            <Link href="/front-desk" className="text-sm text-teal-700 underline">
              {t('backToFrontDesk')}
            </Link>
            <Link href={`/reservations/${done.reservationId}`} className="text-sm text-teal-700 underline">
              {t('viewBooking')}
            </Link>
          </div>
        </div>
      </>
    );
  }
  if (preview.isPending) return <PageSkeleton />;
  if (preview.isError) return <PageError error={preview.error} onRetry={() => void preview.refetch()} />;
  const p = preview.data;
  const cur = property.currencyCode;
  const fmt = (v: string) => formatAmount(v, cur);
  const toSettle = p.isLastStay ? p.folios.filter((f) => f.needs !== 'none') : [];
  const choiceFor = (folioId: string, needs: 'payment' | 'refund'): Choice =>
    choices[folioId] ?? {
      action: needs === 'refund' ? 'refund' : 'pay',
      method: 'cash',
      externalReference: '',
      reason: '',
    };
  const update = (folioId: string, needs: 'payment' | 'refund', patch: Partial<Choice>) =>
    setChoices((c) => ({ ...c, [folioId]: { ...choiceFor(folioId, needs), ...patch } }));
  const missingReason = toSettle.some((f) => {
    const c = choiceFor(f.folioId, f.needs as 'payment' | 'refund');
    return (c.action === 'write_off' || c.action === 'on_account') && c.reason.trim().length < 3;
  });

  const submit = async () => {
    setBusy(true);
    setError(null);
    const settlements: FolioSettlement[] = toSettle.map((f) => {
      const c = choiceFor(f.folioId, f.needs as 'payment' | 'refund');
      const moves = c.action === 'pay' || c.action === 'refund';
      return {
        folioId: f.folioId,
        action: c.action,
        ...(moves ? { method: c.method } : {}),
        ...(moves && c.externalReference.trim() ? { externalReference: c.externalReference.trim() } : {}),
        ...(c.reason.trim() ? { reason: c.reason.trim() } : {}),
      };
    });
    try {
      const result = await api.postWith<CheckOutResultDto>(
        `${base}/stays/${stayId}/check-out`,
        { settlements },
        { 'idempotency-key': key },
      );
      setKey(crypto.randomUUID());
      await queryClient.invalidateQueries();
      setDone(result);
    } catch (err) {
      setError(err);
      void preview.refetch();
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Link href="/front-desk" className="mb-2 inline-block text-sm text-teal-700 underline">
        {t('backToFrontDesk')}
      </Link>
      <PageHeader
        title={t('title', { room: p.roomNumber })}
        subtitle={`${p.guestName} · ${p.bookingReference}`}
      />
      <div className="flex flex-col gap-4">
        {error !== null && <ApiErrorAlert error={error} />}
        <Card title={t('nightsTitle', { n: p.nights.length })}>
          {p.nights.length === 0 ? (
            <p className="text-sm text-muted">{t('noNights')}</p>
          ) : (
            <ul className="divide-y divide-line text-sm">
              {p.nights.map((n) => (
                <li key={n.date} className="flex justify-between gap-2 py-1.5">
                  <span className="tabular">
                    {n.date} · {n.roomNumber ?? '—'}
                  </span>
                  <span className="tabular">
                    {fmt(n.net)} + {fmt(n.tax)} = {fmt(n.gross)}
                  </span>
                </li>
              ))}
              <li className="flex justify-between gap-2 py-1.5 font-semibold">
                <span>{t('total')}</span>
                <span className="tabular">{fmt(p.nightsTotal.gross)}</span>
              </li>
            </ul>
          )}
        </Card>

        {!p.isLastStay && <Alert tone="info">{t('notLast')}</Alert>}

        {p.isLastStay &&
          p.folios.map((f) => (
            <Card key={f.folioId} title={t('folioTitle', { label: f.label })}>
              <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
                <div>
                  <dt className="text-muted">{t('now')}</dt>
                  <dd className="tabular">{fmt(f.currentBalance)}</dd>
                </div>
                <div>
                  <dt className="text-muted">{t('plusNights')}</dt>
                  <dd className="tabular">{fmt(f.nightsToPost)}</dd>
                </div>
                <div>
                  <dt className="text-muted">{t('lessDeposit')}</dt>
                  <dd className="tabular">{fmt(f.depositToApply)}</dd>
                </div>
                <div>
                  <dt className="text-muted">{t('toSettle')}</dt>
                  <dd className="tabular text-base font-semibold">{fmt(f.balanceAfter)}</dd>
                </div>
              </dl>
              {f.needs === 'none' ? (
                <p className="mt-3 text-sm text-success">{t('nothingToSettle')}</p>
              ) : (
                <SettlementForm
                  needs={f.needs}
                  choice={choiceFor(f.folioId, f.needs)}
                  canAdjust={can('folio.adjust')}
                  canRefund={can('payment.refund')}
                  onChange={(patch) => update(f.folioId, f.needs as 'payment' | 'refund', patch)}
                />
              )}
            </Card>
          ))}

        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Link
            href="/front-desk"
            className="inline-flex min-h-10 items-center justify-center rounded-md border border-line bg-white px-4 text-sm font-medium text-ink"
          >
            {tCommon('cancel')}
          </Link>
          <Button busy={busy} disabled={missingReason} onClick={() => void submit()}>
            {busy ? t('checkingOut') : t('confirm')}
          </Button>
        </div>
        <p className="text-xs text-muted">{tFolio('pendingNote')}</p>
      </div>
    </>
  );
}

function SettlementForm({
  needs,
  choice,
  canAdjust,
  canRefund,
  onChange,
}: {
  needs: 'payment' | 'refund';
  choice: Choice;
  canAdjust: boolean;
  canRefund: boolean;
  onChange: (patch: Partial<Choice>) => void;
}) {
  const t = useTranslations('checkout');
  const tFolio = useTranslations('folio');
  const actions: SettlementAction[] =
    needs === 'refund'
      ? canRefund
        ? ['refund']
        : []
      : ['pay', ...(canAdjust ? (['write_off', 'on_account'] as const) : [])];
  const moves = choice.action === 'pay' || choice.action === 'refund';
  if (actions.length === 0) return <Alert tone="warning">{t('needsRefundRole')}</Alert>;
  return (
    <div className="mt-3 grid gap-4 sm:grid-cols-2">
      <SelectField
        label={t('how')}
        value={choice.action}
        onChange={(e) => onChange({ action: e.target.value as SettlementAction })}
      >
        {actions.map((a) => (
          <option key={a} value={a}>
            {t(`actions.${a}`)}
          </option>
        ))}
      </SelectField>
      {moves && (
        <SelectField
          label={tFolio('method')}
          value={choice.method}
          onChange={(e) => onChange({ method: e.target.value as PaymentMethod })}
        >
          {PAYMENT_METHODS.map((m) => (
            <option key={m} value={m}>
              {tFolio(`methods.${m}`)}
            </option>
          ))}
        </SelectField>
      )}
      {moves && (
        <TextField
          label={tFolio('externalReference')}
          value={choice.externalReference}
          maxLength={60}
          onChange={(e) => onChange({ externalReference: e.target.value })}
          hint={tFolio('externalReferenceHint')}
          className="sm:col-span-2"
        />
      )}
      {choice.action !== 'pay' && (
        <TextField
          label={tFolio('reasonLabel')}
          value={choice.reason}
          maxLength={500}
          onChange={(e) => onChange({ reason: e.target.value })}
          className="sm:col-span-2"
        />
      )}
    </div>
  );
}
