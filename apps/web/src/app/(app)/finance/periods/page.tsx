'use client';

import type { FiscalPeriodDto, PeriodChecklistDto } from '@innpilot/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useFormatter, useTranslations } from 'next-intl';
import Link from 'next/link';
import { useState } from 'react';
import { CloseChecklist } from '@/components/close-checklist';
import {
  ApiErrorAlert,
  Button,
  Dialog,
  PageError,
  PageHeader,
  PageSkeleton,
  PermissionDenied,
  StatusBadge,
  TextField,
} from '@/components/ui';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';

const PERIODS_KEY = ['finance', 'periods'] as const;

export default function PeriodsPage() {
  const t = useTranslations('finance');
  const tClose = useTranslations('close');
  const tCommon = useTranslations('common');
  const format = useFormatter();
  const queryClient = useQueryClient();
  const { canTenant } = useSession();
  const allowed = canTenant('journal.read');
  const periods = useQuery({
    queryKey: PERIODS_KEY,
    queryFn: () => api.get<FiscalPeriodDto[]>('/finance/periods'),
    enabled: allowed,
  });
  const [confirm, setConfirm] = useState<{ kind: 'close' | 'reopen'; month: string } | null>(null);
  // The month-end checklist (P4-10), loaded when the close dialog opens.
  const checklist = useQuery({
    queryKey: ['finance', 'checklist', confirm?.month],
    queryFn: () => api.get<PeriodChecklistDto>(`/finance/periods/${confirm!.month}/checklist`),
    enabled: confirm?.kind === 'close',
  });
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  if (!allowed) return <PermissionDenied />;
  if (periods.isPending) return <PageSkeleton />;
  if (periods.isError) return <PageError error={periods.error} onRetry={() => void periods.refetch()} />;

  const monthName = (m: string) =>
    format.dateTime(new Date(`${m}-01T00:00:00Z`), { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const when = (iso: string) => format.dateTime(new Date(iso), { dateStyle: 'medium' });
  const c = checklist.data;
  const closing = confirm?.kind === 'close';
  const needsReason = closing ? (c?.warnings ?? 0) > 0 : true;
  const blocked = closing && (!c || c.blockers > 0);

  const open = (kind: 'close' | 'reopen', month: string) => {
    setError(null);
    setReason('');
    setConfirm({ kind, month });
  };
  const submit = async () => {
    if (!confirm) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await api.post<FiscalPeriodDto[]>(
        `/finance/periods/${confirm.month}/${confirm.kind}`,
        reason.trim() ? { reason: reason.trim() } : {},
      );
      queryClient.setQueryData(PERIODS_KEY, updated);
      await queryClient.invalidateQueries({ queryKey: ['finance'] });
      setConfirm(null);
      setReason('');
    } catch (err) {
      setError(err);
      void checklist.refetch();
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        title={t('periodsTitle')}
        subtitle={t('periodsSubtitle')}
        actions={
          <Link href="/finance/year-end" className="text-sm text-teal-700 underline">
            {tClose('yearEndLink')}
          </Link>
        }
      />
      <ul className="divide-y divide-line rounded-lg border border-line bg-white">
        {periods.data.map((p) => (
          <li key={p.month} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 text-sm">
            <div className="min-w-40 flex-1">
              <p className="font-medium text-ink">{monthName(p.month)}</p>
              <p className="text-xs text-muted">
                {t('periodCounts', { posted: p.postedEntries, drafts: p.draftEntries })}
                {p.status === 'closed' && p.closedAt && (
                  <> · {t('closedBy', { name: p.closedByName ?? tCommon('none'), date: when(p.closedAt) })}</>
                )}
                {p.status === 'closed' && p.closeReason && (
                  <> · {tClose('acceptedBecause', { reason: p.closeReason })}</>
                )}
                {p.status === 'open' && p.reopenedAt && (
                  <>
                    {' '}
                    ·{' '}
                    {t('reopenedBy', {
                      name: p.reopenedByName ?? tCommon('none'),
                      date: when(p.reopenedAt),
                      reason: p.reopenReason ?? '',
                    })}
                  </>
                )}
              </p>
            </div>
            <StatusBadge tone={p.status === 'open' ? 'success' : 'neutral'}>
              {t(`periodStatus.${p.status}`)}
            </StatusBadge>
            {p.status === 'open' && canTenant('period.close') && (
              <Button variant="secondary" onClick={() => open('close', p.month)}>
                {t('closePeriod')}
                <span className="sr-only"> {monthName(p.month)}</span>
              </Button>
            )}
            {p.status === 'closed' && canTenant('period.reopen') && (
              <Button variant="secondary" onClick={() => open('reopen', p.month)}>
                {t('reopenPeriod')}
                <span className="sr-only"> {monthName(p.month)}</span>
              </Button>
            )}
          </li>
        ))}
      </ul>
      <Dialog
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        title={
          confirm
            ? t(confirm.kind === 'close' ? 'closeTitle' : 'reopenTitle', { month: monthName(confirm.month) })
            : ''
        }
      >
        <div className="flex flex-col gap-4">
          {error !== null && <ApiErrorAlert error={error} />}
          <p className="text-sm text-muted">
            {t(confirm?.kind === 'reopen' ? 'reopenExplain' : 'closeExplain')}
          </p>
          {closing &&
            (checklist.isPending ? (
              <p className="text-sm text-muted">{tClose('checking')}</p>
            ) : checklist.isError ? (
              <ApiErrorAlert error={checklist.error} />
            ) : (
              <CloseChecklist items={c!.items} />
            ))}
          {needsReason && !(closing && c && c.blockers > 0) && (
            <TextField
              label={closing ? tClose('acceptReason') : t('reason')}
              value={reason}
              maxLength={500}
              onChange={(e) => setReason(e.target.value)}
            />
          )}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setConfirm(null)}>
              {tCommon('cancel')}
            </Button>
            <Button
              busy={busy}
              disabled={blocked || (needsReason && reason.trim().length < 3)}
              onClick={() => void submit()}
            >
              {confirm?.kind === 'reopen' ? t('reopenPeriod') : t('closePeriod')}
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}
