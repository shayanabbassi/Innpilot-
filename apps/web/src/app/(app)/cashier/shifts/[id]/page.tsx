'use client';

import type { CashierShiftDetailDto } from '@innpilot/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { ClosingCard, MovementList, ShiftStatusBadge, ShiftSummary } from '@/components/cashier';
import {
  ApiErrorAlert,
  Button,
  Card,
  Dialog,
  PageError,
  PageHeader,
  PageSkeleton,
  PermissionDenied,
  TextField,
} from '@/components/ui';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';

export default function ShiftDetailPage() {
  const t = useTranslations('cashier');
  const { id } = useParams<{ id: string }>();
  const { can, property, me } = useSession();
  const allowed = can('folio.read');
  const shift = useQuery({
    queryKey: ['cashier', 'shift', id],
    queryFn: () => api.get<CashierShiftDetailDto>(`/properties/${property!.id}/cashier-shifts/${id}`),
    enabled: allowed && !!property,
  });
  const [dialog, setDialog] = useState<'approve' | 'reopen' | null>(null);

  if (!allowed) return <PermissionDenied />;
  if (shift.isPending) return <PageSkeleton />;
  if (shift.isError) return <PageError error={shift.error} onRetry={() => void shift.refetch()} />;
  const s = shift.data;
  const cur = property?.currencyCode ?? 'PKR';
  const links = can('journal.read');
  // The submitter never approves their own closing; the server refuses it too.
  const canApprove = can('cashier.approve') && s.closing?.status === 'submitted' && s.userId !== me.user.id;
  const canReopen = can('cashier.reopen') && !!s.closing;

  return (
    <>
      <PageHeader
        title={`${s.cashAccountName} · ${s.userName}`}
        subtitle={s.businessDate}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <ShiftStatusBadge shift={s} />
            {canReopen && (
              <Button variant="secondary" onClick={() => setDialog('reopen')}>
                {t('reopen')}
              </Button>
            )}
            {canApprove && <Button onClick={() => setDialog('approve')}>{t('approve')}</Button>}
          </div>
        }
      />
      <p className="mb-4 text-sm">
        <Link href="/cashier/shifts" className="text-teal-700 underline">
          {t('allShifts')}
        </Link>
      </p>
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="flex flex-col gap-4">
          <ShiftSummary shift={s} currency={cur} />
          <MovementList movements={s.movements} currency={cur} linkJournals={links} />
        </div>
        <div className="flex flex-col gap-4">
          {s.closing ? (
            <ClosingCard closing={s.closing} currency={cur} linkJournals={links} />
          ) : (
            <Card>
              <p className="text-sm text-muted">{t('stillOpen')}</p>
            </Card>
          )}
          {s.reopenedClosings.map((c) => (
            <ClosingCard
              key={c.id}
              closing={c}
              currency={cur}
              linkJournals={links}
              title={t('earlierClosing')}
            />
          ))}
        </div>
      </div>
      <ActionDialog kind={dialog} shift={s} onClose={() => setDialog(null)} />
    </>
  );
}

function ActionDialog({
  kind,
  shift,
  onClose,
}: {
  kind: 'approve' | 'reopen' | null;
  shift: CashierShiftDetailDto;
  onClose: () => void;
}) {
  const t = useTranslations('cashier');
  const tCommon = useTranslations('common');
  const { property } = useSession();
  const queryClient = useQueryClient();
  const [text, setText] = useState('');
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [openedFor, setOpenedFor] = useState<typeof kind>(null);
  if (kind !== openedFor) {
    setOpenedFor(kind);
    setText('');
    setError(null);
  }

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.postWith(
        `/properties/${property!.id}/cashier-shifts/${shift.id}/${kind === 'approve' ? 'approve-closing' : 'reopen'}`,
        kind === 'approve' ? { note: text.trim() || undefined } : { reason: text.trim() },
        { 'idempotency-key': key },
      );
      setKey(crypto.randomUUID());
      await queryClient.invalidateQueries({ queryKey: ['cashier'] });
      await queryClient.invalidateQueries({ queryKey: ['finance'] });
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={kind !== null}
      onClose={onClose}
      title={kind === 'approve' ? t('approveTitle') : t('reopenTitle')}
    >
      <div className="flex flex-col gap-4">
        <p className="text-sm text-muted">{kind === 'approve' ? t('approveExplain') : t('reopenExplain')}</p>
        {error !== null && <ApiErrorAlert error={error} />}
        <TextField
          label={kind === 'approve' ? t('approvalNote') : t('reopenReason')}
          value={text}
          maxLength={500}
          onChange={(e) => setText(e.target.value)}
        />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            {tCommon('cancel')}
          </Button>
          <Button
            busy={busy}
            disabled={kind === 'reopen' && text.trim().length < 3}
            onClick={() => void run()}
          >
            {kind === 'approve' ? t('approve') : t('reopen')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
