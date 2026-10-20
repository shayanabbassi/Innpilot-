'use client';

import { DAY_CLOSE_CHECKS, type DayCloseDto, type DayClosePreviewDto } from '@innpilot/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useFormatter, useTranslations } from 'next-intl';
import Link from 'next/link';
import { useState } from 'react';
import { NightAuditSummary } from '@/components/night-audit-summary';
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
import { formatAmount } from '@/lib/finance';
import { ME_QUERY_KEY, useSession } from '@/lib/session';

type Decision = 'refund' | 'forfeit';

export default function NightAuditPage() {
  const t = useTranslations('nightAudit');
  const tDay = useTranslations('dayClose');
  const format = useFormatter();
  const queryClient = useQueryClient();
  const { property, can } = useSession();
  const allowed = !!property && can('night_audit.run');
  const propertyId = property?.id ?? '';
  const cur = property?.currencyCode ?? 'PKR';
  const preview = useQuery({
    queryKey: ['night-audit', propertyId],
    queryFn: () => api.get<DayClosePreviewDto>(`/properties/${propertyId}/night-audit/preview`),
    enabled: allowed,
  });
  const history = useQuery({
    queryKey: ['night-audit-history', propertyId],
    queryFn: () => api.get<DayCloseDto[]>(`/properties/${propertyId}/night-audit/history`),
    enabled: allowed,
  });
  // One key per attempt, renewed after each run, so a double click cannot close two days.
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [markNoShows, setMarkNoShows] = useState(false);
  const [decisions, setDecisions] = useState<Record<string, Decision>>({});
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState<DayCloseDto | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  if (!allowed) return <PermissionDenied />;
  const date = (d: string) =>
    format.dateTime(new Date(`${d}T00:00:00Z`), { dateStyle: 'medium', timeZone: 'UTC' });
  if (preview.isPending) return <PageSkeleton />;
  if (preview.isError) return <PageError error={preview.error} onRetry={() => void preview.refetch()} />;

  const p = preview.data;
  const pendingArrivals = p.issues.filter((i) => i.check === 'arrivals_pending');
  const remaining = p.issues.filter((i) => !(markNoShows && i.check === 'arrivals_pending'));
  const needsReason = remaining.length > 0;
  const undecided = markNoShows ? p.noShowDeposits.filter((d) => !decisions[d.reservationId]) : [];

  const submit = async () => {
    setError(null);
    setBusy(true);
    try {
      const closed = await api.postWith<DayCloseDto>(
        `/properties/${propertyId}/night-audit`,
        {
          businessDate: p.businessDate,
          markNoShows,
          deposits: markNoShows ? decisions : {},
          ...(reason.trim() ? { reason: reason.trim() } : {}),
        },
        { 'idempotency-key': key },
      );
      setDone(closed);
      setKey(crypto.randomUUID());
      setMarkNoShows(false);
      setDecisions({});
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
      <div className="grid gap-4 lg:grid-cols-[1fr_22rem]">
        <div className="flex flex-col gap-4">
          {done && (
            <Alert tone="success">
              {t('done', { date: date(done.businessDate), next: date(done.nextDate) })}
            </Alert>
          )}
          {done?.summary && (
            <Card title={t('storedSummary', { date: date(done.businessDate) })}>
              <NightAuditSummary summary={done.summary} currency={cur} />
            </Card>
          )}
          {error !== null && <ApiErrorAlert error={error} />}
          <Card title={tDay('checks')}>
            <p className="mb-3 text-sm text-muted">
              {tDay('counts', {
                inHouse: p.counts.inHouse,
                checkedIn: p.counts.arrivalsCheckedIn,
                sellable: p.counts.sellableRooms,
              })}
            </p>
            {p.issues.length === 0 ? (
              <p className="text-sm text-success">{tDay('allClear')}</p>
            ) : (
              <div className="flex flex-col gap-4">
                {DAY_CLOSE_CHECKS.filter((c) => p.issues.some((i) => i.check === c)).map((check) => (
                  <section key={check}>
                    <h3 className="mb-1 text-sm font-medium text-ink">{tDay(`checkLabels.${check}`)}</h3>
                    <ul className="flex flex-wrap gap-2 text-sm">
                      {p.issues
                        .filter((i) => i.check === check)
                        .map((i) => (
                          <li
                            key={`${check}-${i.label}-${i.detail ?? ''}`}
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
                <p className="font-medium text-ink">{tDay('serviceChanges', { next: date(p.nextDate) })}</p>
                <ul className="mt-1 text-muted">
                  {p.serviceChanges.map((c) => (
                    <li key={c.roomId}>
                      {c.to === 'out_of_order'
                        ? tDay('goesOutOfOrder', { room: c.roomNumber })
                        : tDay('returnsToService', { room: c.roomNumber })}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </Card>
          <Card>
            <div className="flex flex-col gap-4">
              <p className="text-sm">
                {p.accruals.nights > 0
                  ? t('accrualPreview', {
                      nights: p.accruals.nights,
                      amount: formatAmount(p.accruals.net, cur),
                    })
                  : t('noAccrual')}
              </p>
              {pendingArrivals.length > 0 && (
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="h-4 w-4"
                    checked={markNoShows}
                    onChange={(e) => setMarkNoShows(e.target.checked)}
                  />
                  {tDay('markNoShows', { count: pendingArrivals.length })}
                </label>
              )}
              {markNoShows && p.noShowDeposits.length > 0 && (
                <fieldset className="rounded-md border border-line p-3">
                  <legend className="px-1 text-sm font-medium text-ink">{t('depositDecisions')}</legend>
                  <ul className="flex flex-col gap-3 text-sm">
                    {p.noShowDeposits.map((d) => (
                      <li key={d.reservationId}>
                        <p>
                          <span className="font-medium">{d.bookingReference}</span> · {d.guestName} ·{' '}
                          {t('holds', { amount: formatAmount(d.held, cur) })}
                        </p>
                        <div className="mt-1 flex flex-wrap gap-4">
                          {(['refund', 'forfeit'] as const).map((choice) => (
                            <label key={choice} className="flex min-h-10 items-center gap-2">
                              <input
                                type="radio"
                                name={`deposit-${d.reservationId}`}
                                className="h-4 w-4"
                                checked={decisions[d.reservationId] === choice}
                                disabled={choice === 'forfeit' && !can('folio.adjust')}
                                onChange={() => setDecisions((x) => ({ ...x, [d.reservationId]: choice }))}
                              />
                              {t(`decisions.${choice}`)}
                            </label>
                          ))}
                        </div>
                      </li>
                    ))}
                  </ul>
                </fieldset>
              )}
              {needsReason && (
                <TextField
                  label={t('overrideReason')}
                  value={reason}
                  maxLength={500}
                  onChange={(e) => setReason(e.target.value)}
                  hint={t('overrideHint')}
                />
              )}
              <div className="flex justify-end">
                <Button
                  variant={needsReason ? 'danger' : 'primary'}
                  busy={busy}
                  disabled={(needsReason && reason.trim().length < 3) || undecided.length > 0}
                  onClick={() => void submit()}
                >
                  {busy ? t('running') : t('run', { date: date(p.businessDate) })}
                </Button>
              </div>
            </div>
          </Card>
          <Card title={t('soFar')}>
            <NightAuditSummary summary={p.summary} currency={cur} />
          </Card>
        </div>
        <Card title={tDay('history')}>
          {history.isPending ? (
            <PageSkeleton />
          ) : history.isError ? (
            <ApiErrorAlert error={history.error} />
          ) : history.data.length === 0 ? (
            <EmptyState message={tDay('noHistory')} />
          ) : (
            <ul className="flex flex-col divide-y divide-line text-sm">
              {history.data.map((c) => (
                <li key={c.id} className="py-2">
                  <button
                    type="button"
                    className="w-full text-left"
                    aria-expanded={openId === c.id}
                    onClick={() => setOpenId(openId === c.id ? null : c.id)}
                  >
                    <p className="text-ink">
                      {tDay('historyLine', {
                        date: date(c.businessDate),
                        name: c.closedByName ?? '—',
                        noShows: c.noShowsMarked,
                      })}
                    </p>
                    <p className="text-xs text-muted">
                      {c.summary
                        ? t('historySummary', {
                            revenue: formatAmount(c.summary.revenueTotal, cur),
                            percent: c.summary.occupancy.percent,
                          })
                        : t('interimClose')}
                      {c.unresolved.length > 0
                        ? ` · ${tDay('unresolvedCount', { count: c.unresolved.length })}`
                        : ''}
                      {c.reason ? ` · ${c.reason}` : ''}
                    </p>
                  </button>
                  {openId === c.id && c.summary && (
                    <div className="mt-3">
                      <NightAuditSummary summary={c.summary} currency={cur} />
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
