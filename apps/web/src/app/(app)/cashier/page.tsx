'use client';

import type { CashierShiftDetailDto, CashierShiftDto } from '@innpilot/contracts';
import { Money } from '@innpilot/money';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useState } from 'react';
import { ClosingCard, MovementList, ShiftSummary, VarianceText } from '@/components/cashier';
import { useCashAccounts } from '@/components/journal-form';
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

const AMOUNT = /^\d{1,13}(\.\d{1,2})?$/;

/** "My shift": open a shift with the opening count, watch expected cash, close with the count (CASH-001). */
export default function MyShiftPage() {
  const t = useTranslations('cashier');
  const { can, property } = useSession();
  const allowed = can('cashier.operate');
  const current = useQuery({
    queryKey: ['cashier', 'current', property?.id],
    queryFn: () => api.get<CashierShiftDto | null>(`/properties/${property!.id}/cashier-shifts/current`),
    enabled: allowed && !!property,
  });
  // The shift just closed stays on screen so the cashier sees the result.
  const [closedId, setClosedId] = useState<string | null>(null);

  if (!allowed) return <PermissionDenied />;
  if (current.isPending) return <PageSkeleton />;
  if (current.isError) return <PageError error={current.error} onRetry={() => void current.refetch()} />;

  return (
    <>
      <PageHeader
        title={t('title')}
        subtitle={t('subtitle')}
        actions={
          <Link href="/cashier/shifts" className="text-sm text-teal-700 underline">
            {t('history')}
          </Link>
        }
      />
      {current.data ? (
        <OpenShift shiftId={current.data.id} onClosed={setClosedId} />
      ) : closedId ? (
        <ClosedResult shiftId={closedId} onNew={() => setClosedId(null)} />
      ) : (
        <OpenForm />
      )}
    </>
  );
}

function useShift(id: string) {
  const { property } = useSession();
  return useQuery({
    queryKey: ['cashier', 'shift', id],
    queryFn: () => api.get<CashierShiftDetailDto>(`/properties/${property!.id}/cashier-shifts/${id}`),
    enabled: !!property,
  });
}

function OpenForm() {
  const t = useTranslations('cashier');
  const { property } = useSession();
  const queryClient = useQueryClient();
  const accounts = useCashAccounts(property?.id);
  const drawers = (accounts.data ?? []).filter((a) => a.kind === 'cash' && a.active);
  const [drawer, setDrawer] = useState('');
  const [count, setCount] = useState('');
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const chosen = drawer || (drawers.length === 1 ? drawers[0]!.id : '');

  const open = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.postWith(
        `/properties/${property!.id}/cashier-shifts/open`,
        { cashAccountId: chosen, openingCount: count.trim() },
        { 'idempotency-key': key },
      );
      setKey(crypto.randomUUID());
      await queryClient.invalidateQueries({ queryKey: ['cashier'] });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title={t('openTitle')}>
      <div className="flex flex-col gap-4">
        <p className="text-sm text-muted">{t('openExplain')}</p>
        {error !== null && <ApiErrorAlert error={error} />}
        {accounts.isError && <ApiErrorAlert error={accounts.error} />}
        <SelectField label={t('drawer')} value={chosen} onChange={(e) => setDrawer(e.target.value)}>
          <option value="">{t('chooseDrawer')}</option>
          {drawers.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </SelectField>
        <TextField
          label={t('openingCount')}
          inputMode="decimal"
          value={count}
          onChange={(e) => setCount(e.target.value)}
          hint={t('openingCountHint')}
          className="tabular"
        />
        <div className="flex justify-end">
          <Button busy={busy} disabled={!chosen || !AMOUNT.test(count.trim())} onClick={() => void open()}>
            {t('openShift')}
          </Button>
        </div>
      </div>
    </Card>
  );
}

function OpenShift({ shiftId, onClosed }: { shiftId: string; onClosed: (id: string) => void }) {
  const t = useTranslations('cashier');
  const { property, can } = useSession();
  const queryClient = useQueryClient();
  const shift = useShift(shiftId);
  const [counted, setCounted] = useState('');
  const [explanation, setExplanation] = useState('');
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const cur = property?.currencyCode ?? 'PKR';

  if (shift.isPending) return <PageSkeleton />;
  if (shift.isError) return <PageError error={shift.error} onRetry={() => void shift.refetch()} />;
  const s = shift.data;
  const validCount = AMOUNT.test(counted.trim());
  const variance = validCount ? Money.of(counted.trim(), cur).subtract(Money.of(s.expected, cur)) : null;
  const threshold = Money.of(property?.cashVarianceThreshold ?? '0', cur);
  const needsReason = !!variance && !variance.isZero();

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.postWith(
        `/properties/${property!.id}/cashier-shifts/${s.id}/submit-closing`,
        { countedAmount: counted.trim(), explanation: explanation.trim() || undefined },
        { 'idempotency-key': key },
      );
      setKey(crypto.randomUUID());
      onClosed(s.id);
      await queryClient.invalidateQueries({ queryKey: ['cashier'] });
      await queryClient.invalidateQueries({ queryKey: ['finance'] });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="flex flex-col gap-4">
        <ShiftSummary shift={s} currency={cur} />
        <MovementList movements={s.movements} currency={cur} linkJournals={can('journal.read')} />
      </div>
      <Card title={t('closeTitle')}>
        <div className="flex flex-col gap-4">
          <p className="text-sm text-muted">{t('closeExplain')}</p>
          {error !== null && <ApiErrorAlert error={error} />}
          <TextField
            label={t('counted')}
            inputMode="decimal"
            value={counted}
            onChange={(e) => setCounted(e.target.value)}
            className="tabular"
          />
          {variance && (
            <p className="text-sm" aria-live="polite">
              {t('varianceLive')}: <VarianceText variance={variance.toString()} currency={cur} />
            </p>
          )}
          {needsReason && variance.abs().compare(threshold) > 0 && (
            <Alert tone="warning">
              {t('needsApproval', { threshold: formatAmount(threshold.toString(), cur) })}
            </Alert>
          )}
          <TextField
            label={needsReason ? t('explanationRequired') : t('explanationOptional')}
            value={explanation}
            maxLength={1000}
            onChange={(e) => setExplanation(e.target.value)}
          />
          <div className="flex justify-end">
            <Button
              busy={busy}
              disabled={!validCount || (needsReason && explanation.trim().length < 3)}
              onClick={() => void submit()}
            >
              {t('submitClosing')}
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}

function ClosedResult({ shiftId, onNew }: { shiftId: string; onNew: () => void }) {
  const t = useTranslations('cashier');
  const { property, can } = useSession();
  const shift = useShift(shiftId);
  const cur = property?.currencyCode ?? 'PKR';
  if (shift.isPending) return <PageSkeleton />;
  if (shift.isError) return <PageError error={shift.error} onRetry={() => void shift.refetch()} />;
  const c = shift.data.closing;
  return (
    <div className="flex flex-col gap-4">
      <Alert tone={c?.status === 'submitted' ? 'warning' : 'success'}>
        {c?.status === 'submitted' ? t('submittedWaiting') : t('closedDone')}
      </Alert>
      {c && <ClosingCard closing={c} currency={cur} linkJournals={can('journal.read')} />}
      <div className="flex justify-end">
        <Button variant="secondary" onClick={onNew}>
          {t('openAnother')}
        </Button>
      </div>
    </div>
  );
}
