'use client';

import type { FrontDeskTodayDto, StayDto } from '@innpilot/contracts';
import { useQuery } from '@tanstack/react-query';
import { useFormatter, useTranslations } from 'next-intl';
import Link from 'next/link';
import { useState } from 'react';
import { CheckInDialog, MoveDialog, ReadinessBadge, type CheckInTarget } from '@/components/front-desk';
import {
  Button,
  Card,
  EmptyState,
  PageError,
  PageHeader,
  PageSkeleton,
  PermissionDenied,
} from '@/components/ui';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';

export default function FrontDeskPage() {
  const t = useTranslations('frontDesk');
  const format = useFormatter();
  const { property, can } = useSession();
  const allowed = !!property && can('reservation.read');
  const [checkIn, setCheckIn] = useState<CheckInTarget | null>(null);
  const [moving, setMoving] = useState<StayDto | null>(null);
  const today = useQuery({
    queryKey: ['front-desk', property?.id],
    queryFn: () => api.get<FrontDeskTodayDto>(`/properties/${property!.id}/front-desk/today`),
    enabled: allowed,
    refetchInterval: 60_000,
  });

  if (!allowed) return <PermissionDenied />;
  const canCheckIn = can('stay.checkin');
  const date = (d: string) =>
    format.dateTime(new Date(`${d}T00:00:00Z`), { dateStyle: 'medium', timeZone: 'UTC' });
  const header = (
    <PageHeader
      title={t('title')}
      subtitle={t('subtitle', { date: date(property.businessDate) })}
      actions={
        canCheckIn &&
        can('reservation.write') && (
          <Link
            href="/front-desk/walk-in"
            className="inline-flex min-h-10 items-center rounded-md bg-teal-600 px-4 text-sm font-medium text-white hover:bg-teal-700"
          >
            {t('walkIn')}
          </Link>
        )
      }
    />
  );
  if (today.isPending) {
    return (
      <>
        {header}
        <PageSkeleton />
      </>
    );
  }
  if (today.isError) {
    return (
      <>
        {header}
        <PageError error={today.error} onRetry={() => void today.refetch()} />
      </>
    );
  }
  const d = today.data;

  return (
    <>
      {header}
      <div className="grid gap-4 xl:grid-cols-3">
        <Card title={`${t('arrivals')} (${d.arrivals.length})`}>
          {d.arrivals.length === 0 ? (
            <EmptyState message={t('noArrivals')} />
          ) : (
            <ul className="divide-y divide-line">
              {d.arrivals.map((a) => (
                <li
                  key={a.reservationRoomId}
                  className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0 text-sm">
                    <Link
                      href={`/reservations/${a.reservationId}`}
                      className="font-medium text-ink hover:underline"
                    >
                      {a.guest.fullName}
                    </Link>
                    <p className="text-muted">
                      {a.bookingReference} · {a.roomTypeCode} ·{' '}
                      {a.roomNumber ? t('room', { room: a.roomNumber }) : t('noRoom')} ·{' '}
                      {t('until', { date: date(a.departure) })}
                    </p>
                    {a.arrival < d.businessDate && (
                      <p className="text-xs text-warning">{t('lateArrival', { date: date(a.arrival) })}</p>
                    )}
                    {a.roomNumber && (
                      <div className="mt-1">
                        <ReadinessBadge problem={a.readiness} />
                      </div>
                    )}
                  </div>
                  {canCheckIn && (
                    <Button
                      className="shrink-0"
                      onClick={() =>
                        setCheckIn({
                          reservationId: a.reservationId,
                          reservationRoomId: a.reservationRoomId,
                          guestName: a.guest.fullName,
                          roomTypeId: a.roomTypeId,
                          roomId: a.roomId,
                          roomNumber: a.roomNumber,
                          departure: a.departure,
                        })
                      }
                    >
                      {t('checkIn')}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title={`${t('inHouse')} (${d.inHouse.length})`}>
          {d.inHouse.length === 0 ? (
            <EmptyState message={t('noInHouse')} />
          ) : (
            <ul className="divide-y divide-line">
              {d.inHouse.map((s) => (
                <li
                  key={s.id}
                  className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0 text-sm">
                    <p>
                      <span className="tabular mr-2 rounded bg-navy-50 px-1.5 py-0.5 text-xs font-semibold text-navy-800">
                        {s.roomNumber}
                      </span>
                      <Link
                        href={`/reservations/${s.reservationId}`}
                        className="font-medium text-ink hover:underline"
                      >
                        {s.guest.fullName}
                      </Link>
                    </p>
                    <p className="text-muted">{t('until', { date: date(s.departure) })}</p>
                  </div>
                  {canCheckIn && (
                    <Button variant="secondary" className="shrink-0" onClick={() => setMoving(s)}>
                      {t('move')}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title={`${t('departures')} (${d.departures.length})`}>
          {d.departures.length === 0 ? (
            <EmptyState message={t('noDepartures')} />
          ) : (
            <ul className="divide-y divide-line">
              {d.departures.map((s) => (
                <li key={s.id} className="py-3 text-sm">
                  <p>
                    <span className="tabular mr-2 rounded bg-navy-50 px-1.5 py-0.5 text-xs font-semibold text-navy-800">
                      {s.roomNumber}
                    </span>
                    <span className="font-medium text-ink">{s.guest.fullName}</span>
                  </p>
                  {s.departure < d.businessDate && (
                    <p className="text-xs text-danger">{t('overdue', { date: date(s.departure) })}</p>
                  )}
                </li>
              ))}
            </ul>
          )}
          <p className="mt-3 text-xs text-muted">{t('checkoutLater')}</p>
        </Card>
      </div>
      {checkIn && <CheckInDialog target={checkIn} onClose={() => setCheckIn(null)} />}
      {moving && <MoveDialog stay={moving} onClose={() => setMoving(null)} />}
    </>
  );
}
