'use client';

import { DAY_CLOSE_CHECKS, type DayCloseDto, type DayClosePreviewDto } from '@innpilot/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useFormatter, useTranslations } from 'next-intl';
import Link from 'next/link';
import { useState } from 'react';
import {
  Alert,
  ApiErrorAlert,
  Button,
  Card,
  EmptyState,
  PageError,
  PageHeader,
  PageSkeleton,
  PermissionDenied,
  TextField,
} from '@/components/ui';
import { api } from '@/lib/api';
import { ME_QUERY_KEY, useSession } from '@/lib/session';

export default function DayClosePage() {
  const t = useTranslations('dayClose');
  const format = useFormatter();
  const queryClient = useQueryClient();
  const { property, can } = useSession();
  const allowed = !!property && can('night_audit.run');
  const propertyId = property?.id ?? '';
  const preview = useQuery({
    queryKey: ['day-close', propertyId],
    queryFn: () => api.get<DayClosePreviewDto>(`/properties/${propertyId}/day-close/preview`),
    enabled: allowed,
  });
  const history = useQuery({
    queryKey: ['day-close-history', propertyId],
    queryFn: () => api.get<DayCloseDto[]>(`/properties/${propertyId}/day-close/history`),
    enabled: allowed,
  });
  // One key per attempt, renewed after each close, so a double click cannot close two days.
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [markNoShows, setMarkNoShows] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState<DayCloseDto | null>(null);

  if (!allowed) return <PermissionDenied />;
  const date = (d: string) =>
    format.dateTime(new Date(`${d}T00:00:00Z`), { dateStyle: 'medium', timeZone: 'UTC' });
  if (preview.isPending) return <PageSkeleton />;
  if (preview.isError) return <PageError error={preview.error} onRetry={() => void preview.refetch()} />;

  const p = preview.data;
  const pendingArrivals = p.issues.filter((i) => i.check === 'arrivals_pending');
  const remaining = p.issues.filter((i) => !(markNoShows && i.check === 'arrivals_pending'));
  const needsReason = remaining.length > 0;

  const submit = async () => {
    setError(null);
    setBusy(true);
    try {
      const closed = await api.postWith<DayCloseDto>(
        `/properties/${propertyId}/day-close`,
        { businessDate: p.businessDate, markNoShows, ...(reason.trim() ? { reason: reason.trim() } : {}) },
        { 'idempotency-key': key },
      );
      setDone(closed);
      setKey(crypto.randomUUID());
      setMarkNoShows(false);
      setReason('');
      // Everything keyed by the business date is now stale.
      await queryClient.invalidateQueries();
      await queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY });
    } catch (err) {
      setError(err);
      void preview.refetch();
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        title={t('title')}
        subtitle={t('subtitle', { date: date(p.businessDate), next: date(p.nextDate) })}
      />
      <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
        <div className="flex flex-col gap-4">
          <Alert tone="info">{t('interimNote')}</Alert>
          {done && (
            <Alert tone="success">
              {t('closed', { date: date(done.businessDate), next: date(done.nextDate) })}
            </Alert>
          )}
          {error !== null && <ApiErrorAlert error={error} />}
          <Card title={t('checks')}>
            <p className="mb-3 text-sm text-muted">
              {t('counts', {
                inHouse: p.counts.inHouse,
                checkedIn: p.counts.arrivalsCheckedIn,
                sellable: p.counts.sellableRooms,
              })}
            </p>
            {p.issues.length === 0 ? (
              <p className="text-sm text-success">{t('allClear')}</p>
            ) : (
              <div className="flex flex-col gap-4">
                {DAY_CLOSE_CHECKS.filter((c) => p.issues.some((i) => i.check === c)).map((check) => (
                  <section key={check}>
                    <h3 className="mb-1 text-sm font-medium text-ink">{t(`checkLabels.${check}`)}</h3>
                    <ul className="flex flex-wrap gap-2 text-sm">
                      {p.issues
                        .filter((i) => i.check === check)
                        .map((i) => (
                          <li
                            key={`${check}-${i.label}`}
                            className="rounded-md border border-line bg-canvas px-2 py-1"
                          >
                            {i.reservationId ? (
                              <Link
                                href={`/reservations/${i.reservationId}`}
                                className="font-medium text-teal-700 underline"
                              >
                                {i.label}
                              </Link>
                            ) : (
                              <span className="font-medium">{i.label}</span>
                            )}
                            {i.detail && <span className="text-muted"> · {i.detail}</span>}
                          </li>
                        ))}
                    </ul>
                  </section>
                ))}
              </div>
            )}
            {p.serviceChanges.length > 0 && (
              <div className="mt-4 border-t border-line pt-3 text-sm">
                <p className="font-medium text-ink">{t('serviceChanges', { next: date(p.nextDate) })}</p>
                <ul className="mt-1 text-muted">
                  {p.serviceChanges.map((c) => (
                    <li key={c.roomId}>
                      {c.to === 'out_of_order'
                        ? t('goesOutOfOrder', { room: c.roomNumber })
                        : t('returnsToService', { room: c.roomNumber })}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </Card>
          <Card>
            <div className="flex flex-col gap-4">
              {pendingArrivals.length > 0 && (
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="h-4 w-4"
                    checked={markNoShows}
                    onChange={(e) => setMarkNoShows(e.target.checked)}
                  />
                  {t('markNoShows', { count: pendingArrivals.length })}
                </label>
              )}
              {needsReason && (
                <TextField
                  label={t('reason')}
                  value={reason}
                  maxLength={500}
                  onChange={(e) => setReason(e.target.value)}
                />
              )}
              <div className="flex justify-end">
                <Button
                  variant={needsReason ? 'danger' : 'primary'}
                  busy={busy}
                  disabled={needsReason && reason.trim().length < 3}
                  onClick={() => void submit()}
                >
                  {busy ? t('closing') : t('close', { date: date(p.businessDate) })}
                </Button>
              </div>
            </div>
          </Card>
        </div>
        <Card title={t('history')}>
          {history.isPending ? (
            <PageSkeleton />
          ) : history.isError ? (
            <ApiErrorAlert error={history.error} />
          ) : history.data.length === 0 ? (
            <EmptyState message={t('noHistory')} />
          ) : (
            <ul className="flex flex-col gap-3 text-sm">
              {history.data.map((c) => (
                <li key={c.id}>
                  <p className="text-ink">
                    {t('historyLine', {
                      date: date(c.businessDate),
                      name: c.closedByName ?? '—',
                      noShows: c.noShowsMarked,
                    })}
                  </p>
                  <p className="text-xs text-muted">
                    {t('unresolvedCount', { count: c.unresolved.length })}
                    {c.reason ? ` · ${c.reason}` : ''}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
