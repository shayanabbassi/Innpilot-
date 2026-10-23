'use client';

import { addDays, type ReservationDto, type ReservationStatus } from '@innpilot/contracts';
import { useQuery } from '@tanstack/react-query';
import { useFormatter, useTranslations } from 'next-intl';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useRoomData } from '@/components/rooms-setup';
import {
  Button,
  EmptyState,
  PageError,
  PageHeader,
  PageSkeleton,
  PermissionDenied,
  StatusBadge,
} from '@/components/ui';
import { api } from '@/lib/api';
import { isFree, layoutCalendar } from '@/lib/calendar';
import { STATUS_TONE } from '@/lib/reservation-ui';
import { useSession } from '@/lib/session';

const DAYS = 14;

const BAR: Record<ReservationStatus, string> = {
  pending: 'border border-dashed border-warning bg-warning-50 text-warning',
  confirmed: 'bg-teal-600 text-white',
  checked_in: 'bg-navy-800 text-white',
  checked_out: 'bg-navy-100 text-navy-800',
  cancelled: 'bg-danger-50 text-danger',
  no_show: 'bg-danger-50 text-danger',
};

export default function ReservationsPage() {
  const t = useTranslations('reservations');
  const format = useFormatter();
  const router = useRouter();
  const { property, can } = useSession();
  const allowed = !!property && can('reservation.read');
  const [from, setFrom] = useState(() => property?.businessDate ?? '');
  const [view, setView] = useState<'calendar' | 'list'>('calendar');
  const to = from ? addDays(from, DAYS) : '';
  const propertyId = property?.id ?? '';
  const { types, rooms } = useRoomData(propertyId);
  const reservations = useQuery({
    queryKey: ['reservations', propertyId, from, to],
    queryFn: () => api.get<ReservationDto[]>(`/properties/${propertyId}/reservations?from=${from}&to=${to}`),
    enabled: allowed && !!from,
  });

  if (!allowed) return <PermissionDenied />;
  const canWrite = can('reservation.write');
  const day = (d: string, style: 'short' | 'weekday') =>
    format.dateTime(
      new Date(`${d}T00:00:00Z`),
      style === 'weekday'
        ? { weekday: 'short', timeZone: 'UTC' }
        : { day: 'numeric', month: 'short', timeZone: 'UTC' },
    );

  const header = (
    <PageHeader
      title={t('title')}
      actions={
        canWrite && (
          <Link
            href="/reservations/new"
            className="inline-flex min-h-10 items-center rounded-md bg-teal-600 px-4 text-sm font-medium text-white hover:bg-teal-700"
          >
            {t('newBooking')}
          </Link>
        )
      }
    />
  );

  const toolbar = (
    <div className="mb-4 flex flex-wrap items-center gap-2">
      <div role="tablist" className="flex rounded-md border border-line bg-white p-0.5">
        {(['calendar', 'list'] as const).map((v) => (
          <button
            key={v}
            role="tab"
            aria-selected={view === v}
            onClick={() => setView(v)}
            className={`rounded px-3 py-1.5 text-sm ${view === v ? 'bg-navy-800 text-white' : 'text-ink'}`}
          >
            {t(v)}
          </button>
        ))}
      </div>
      <Button variant="secondary" onClick={() => setFrom(addDays(from, -7))}>
        ← {t('prev')}
      </Button>
      <Button variant="secondary" onClick={() => setFrom(property!.businessDate)}>
        {t('today')}
      </Button>
      <Button variant="secondary" onClick={() => setFrom(addDays(from, 7))}>
        {t('next')} →
      </Button>
      <span className="tabular text-sm text-muted">
        {day(from, 'short')} – {day(addDays(to, -1), 'short')}
      </span>
    </div>
  );

  if (types.isPending || rooms.isPending || reservations.isPending) {
    return (
      <>
        {header}
        {toolbar}
        <PageSkeleton />
      </>
    );
  }
  const error = types.error ?? rooms.error ?? reservations.error;
  if (error) {
    return (
      <>
        {header}
        <PageError error={error} onRetry={() => void reservations.refetch()} />
      </>
    );
  }

  const data = reservations.data ?? [];
  const activeRooms = (rooms.data ?? []).filter((r) => r.active);
  const layout = layoutCalendar(data, from, DAYS);
  const grid = { gridTemplateColumns: `6.5rem repeat(${DAYS}, minmax(3.25rem, 1fr))` };

  return (
    <>
      {header}
      {toolbar}
      {view === 'list' ? (
        data.length === 0 ? (
          <EmptyState message={t('emptyList')} />
        ) : (
          <ul className="divide-y divide-line rounded-lg border border-line bg-white">
            {[...data]
              .sort((a, b) => a.arrival.localeCompare(b.arrival))
              .map((r) => (
                <li key={r.id}>
                  <Link
                    href={`/reservations/${r.id}`}
                    className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 hover:bg-canvas"
                  >
                    <span className="tabular w-24 text-sm font-semibold text-ink">{r.bookingReference}</span>
                    <span className="min-w-40 flex-1 text-sm text-ink">{r.guest.fullName}</span>
                    <span className="tabular text-sm text-muted">
                      {day(r.arrival, 'short')} → {day(r.departure, 'short')}
                    </span>
                    <span className="text-sm text-muted">
                      {r.rooms
                        .filter((s) => s.status === 'active')
                        .map((s) => s.roomNumber ?? s.roomTypeCode)
                        .join(', ')}
                    </span>
                    <StatusBadge tone={STATUS_TONE[r.status]}>{t(`statuses.${r.status}`)}</StatusBadge>
                  </Link>
                </li>
              ))}
          </ul>
        )
      ) : activeRooms.length === 0 ? (
        <EmptyState message={t('noRooms')} />
      ) : (
        <>
          {canWrite && <p className="mb-2 text-xs text-muted">{t('calendarHint')}</p>}
          {/* Dense grid: scrolls sideways on small screens while the room column stays visible. */}
          <div className="overflow-x-auto rounded-lg border border-line bg-white">
            <div className="min-w-[56rem]">
              <div className="grid border-b border-line bg-canvas text-xs" style={grid}>
                <div className="sticky left-0 z-10 bg-canvas px-2 py-2 font-medium text-muted">
                  {t('room')}
                </div>
                {layout.days.map((d) => (
                  <div
                    key={d}
                    className={`tabular px-1 py-1 text-center ${d === property!.businessDate ? 'font-semibold text-teal-700' : 'text-muted'}`}
                  >
                    <div>{day(d, 'weekday')}</div>
                    <div>{day(d, 'short')}</div>
                  </div>
                ))}
              </div>
              {(types.data ?? [])
                .filter((type) => activeRooms.some((r) => r.roomTypeId === type.id))
                .map((type) => {
                  const unassigned = layout.unassignedByType.get(type.id);
                  return (
                    <section key={type.id} aria-label={`${type.code} ${type.name}`}>
                      <div className="border-b border-line bg-navy-50 px-2 py-1 text-xs font-semibold text-navy-800">
                        {type.code} — {type.name}
                      </div>
                      {unassigned && (
                        <div className="grid border-b border-line text-xs" style={grid}>
                          <div className="sticky left-0 z-10 bg-white px-2 py-1.5 text-muted">
                            {t('unassigned')}
                          </div>
                          {unassigned.map((n, i) => (
                            <div key={i} className="tabular py-1.5 text-center font-medium text-warning">
                              {n > 0 ? n : ''}
                            </div>
                          ))}
                        </div>
                      )}
                      {activeRooms
                        .filter((r) => r.roomTypeId === type.id)
                        .map((r) => {
                          const bars = layout.barsByRoom.get(r.id);
                          return (
                            <div key={r.id} className="grid border-b border-line" style={grid}>
                              <div
                                className="sticky left-0 z-10 bg-white px-2 py-2 text-sm font-medium text-ink"
                                style={{ gridRow: 1, gridColumn: 1 }}
                              >
                                {r.roomNumber}
                              </div>
                              {layout.days.map((d, i) => (
                                <button
                                  key={d}
                                  type="button"
                                  style={{ gridRow: 1, gridColumn: i + 2 }}
                                  disabled={!canWrite || !isFree(bars, i) || d < property!.businessDate}
                                  onClick={() =>
                                    router.push(
                                      `/reservations/new?roomId=${r.id}&roomTypeId=${type.id}&arrival=${d}`,
                                    )
                                  }
                                  aria-label={`${r.roomNumber} ${d}`}
                                  className="min-h-9 border-l border-line hover:bg-teal-50 disabled:cursor-default disabled:hover:bg-transparent"
                                />
                              ))}
                              {(bars ?? []).map((b) => (
                                <Link
                                  key={`${b.reservationId}-${b.start}`}
                                  href={`/reservations/${b.reservationId}`}
                                  style={{ gridRow: 1, gridColumn: `${b.start + 2} / span ${b.span}` }}
                                  className={`z-[1] m-1 truncate px-2 py-1 text-xs font-medium ${BAR[b.status]} ${
                                    b.clippedStart ? 'rounded-l-none' : 'rounded-l-md'
                                  } ${b.clippedEnd ? 'rounded-r-none' : 'rounded-r-md'}`}
                                  title={`${b.label} · ${t(`statuses.${b.status}`)}`}
                                >
                                  {b.label}
                                </Link>
                              ))}
                            </div>
                          );
                        })}
                    </section>
                  );
                })}
            </div>
          </div>
        </>
      )}
    </>
  );
}
