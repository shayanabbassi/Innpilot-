'use client';

import type { AuditEventDto, AvailabilityDto, ReservationDto, ReservationRoomDto } from '@innpilot/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useFormatter, useTranslations } from 'next-intl';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { BookingRoomPicker, toRoomInput, type RoomChoice } from '@/components/booking-room-picker';
import { CheckInDialog, type CheckInTarget } from '@/components/front-desk';
import { formatRate } from '@/components/rooms-setup';
import {
  ApiErrorAlert,
  Button,
  Card,
  Dialog,
  PageError,
  PageHeader,
  PageSkeleton,
  PermissionDenied,
  SelectField,
  StatusBadge,
  TextField,
} from '@/components/ui';
import { api } from '@/lib/api';
import { STATUS_TONE } from '@/lib/reservation-ui';
import { useSession } from '@/lib/session';
import { FolioPanel } from '@/components/folio-panel';

type Dialogs =
  | { kind: 'cancel' }
  | { kind: 'noShow' }
  | { kind: 'assign'; seg: ReservationRoomDto }
  | { kind: 'addRoom' }
  | { kind: 'checkIn'; target: CheckInTarget }
  | null;

export default function ReservationPage() {
  const t = useTranslations('reservations');
  const tActions = useTranslations('actions');
  const format = useFormatter();
  const { id } = useParams<{ id: string }>();
  const { property, can } = useSession();
  const queryClient = useQueryClient();
  const [dialog, setDialog] = useState<Dialogs>(null);
  const propertyId = property?.id ?? '';
  const base = `/properties/${propertyId}/reservations/${id}`;
  const allowed = !!property && can('reservation.read');
  const reservation = useQuery({
    queryKey: ['reservation', id],
    queryFn: () => api.get<ReservationDto>(base),
    enabled: allowed,
  });
  const history = useQuery({
    queryKey: ['reservation-history', id],
    queryFn: () => api.get<AuditEventDto[]>(`${base}/history`),
    enabled: allowed,
  });
  const refresh = (next: ReservationDto) => {
    queryClient.setQueryData(['reservation', id], next);
    void queryClient.invalidateQueries({ queryKey: ['reservation-history', id] });
    void queryClient.invalidateQueries({ queryKey: ['reservations'] });
    void queryClient.invalidateQueries({ queryKey: ['availability'] });
  };
  const confirm = useMutation({
    mutationFn: () => api.post<ReservationDto>(`${base}/confirm`),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: (segId: string) => api.del<ReservationDto>(`${base}/rooms/${segId}`),
    onSuccess: refresh,
  });

  if (!allowed) return <PermissionDenied />;
  if (reservation.isPending) return <PageSkeleton />;
  if (reservation.isError)
    return <PageError error={reservation.error} onRetry={() => void reservation.refetch()} />;

  const r = reservation.data;
  const editable = can('reservation.write') && (r.status === 'pending' || r.status === 'confirmed');
  const date = (d: string) =>
    format.dateTime(new Date(`${d}T00:00:00Z`), { dateStyle: 'medium', timeZone: 'UTC' });
  const activeCount = r.rooms.filter((s) => s.status === 'active').length;
  const actionLabel = (a: string) => (tActions.has(a as never) ? tActions(a as never) : a);

  return (
    <>
      <Link href="/reservations" className="mb-2 inline-block text-sm text-teal-700 underline">
        {t('back')}
      </Link>
      <PageHeader
        title={t('reference', { reference: r.bookingReference })}
        subtitle={`${date(r.arrival)} → ${date(r.departure)} · ${t(`sources.${r.source}`)}`}
        actions={<StatusBadge tone={STATUS_TONE[r.status]}>{t(`statuses.${r.status}`)}</StatusBadge>}
      />
      {(confirm.isError || remove.isError) && (
        <div className="mb-4">
          <ApiErrorAlert error={confirm.error ?? remove.error} />
        </div>
      )}
      <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
        <div className="flex flex-col gap-4">
          <Card title={t('guest')}>
            <Link href={`/guests/${r.guest.id}`} className="font-medium text-teal-700 underline">
              {r.guest.fullName}
            </Link>
            <p className="text-sm text-muted">{[r.guest.phone, r.guest.email].filter(Boolean).join(' · ')}</p>
            {r.notes && <p className="mt-3 whitespace-pre-wrap text-sm text-ink">{r.notes}</p>}
            {r.cancelReason && <p className="mt-3 text-sm text-danger">{r.cancelReason}</p>}
          </Card>
          <Card title={t('rooms')}>
            <ul className="divide-y divide-line">
              {r.rooms.map((s) => (
                <li
                  key={s.id}
                  className={`flex flex-wrap items-start justify-between gap-2 py-3 ${s.status === 'released' ? 'opacity-60' : ''}`}
                >
                  <div className="text-sm">
                    <p className="font-medium text-ink">
                      {t('roomLine', { type: s.roomTypeCode, room: s.roomNumber ?? t('noRoomYet') })}{' '}
                      {s.status === 'released' && <StatusBadge tone="neutral">{t('released')}</StatusBadge>}
                      {s.rateOverridden && <StatusBadge tone="warning">{t('overridden')}</StatusBadge>}
                      {s.stayId && s.status === 'active' && (
                        <StatusBadge tone="neutral">{t('statuses.checked_in')}</StatusBadge>
                      )}
                    </p>
                    <p className="tabular text-muted">
                      {t('datesLine', {
                        arrival: date(s.arrival),
                        departure: date(s.departure),
                        nights: t('nights', { count: s.nights }),
                      })}
                    </p>
                    <p className="text-muted">
                      {t('guestsLine', { adults: s.adults, children: s.children })}
                    </p>
                    <p className="tabular text-muted">
                      {t('rateLine', { rate: formatRate(s.nightlyRate, s.currencyCode) })} ·{' '}
                      <span className="font-medium text-ink">{formatRate(s.roomTotal, s.currencyCode)}</span>
                    </p>
                  </div>
                  {can('stay.checkin') &&
                    s.status === 'active' &&
                    !s.stayId &&
                    (r.status === 'confirmed' || r.status === 'checked_in') &&
                    s.arrival <= (property?.businessDate ?? '') &&
                    s.departure > (property?.businessDate ?? '') && (
                      <Button
                        className="min-h-8 px-3"
                        onClick={() =>
                          setDialog({
                            kind: 'checkIn',
                            target: {
                              reservationId: r.id,
                              reservationRoomId: s.id,
                              guestName: r.guest.fullName,
                              roomTypeId: s.roomTypeId,
                              roomId: s.roomId,
                              roomNumber: s.roomNumber,
                              departure: s.departure,
                            },
                          })
                        }
                      >
                        {t('checkIn')}
                      </Button>
                    )}
                  {editable && s.status === 'active' && (
                    <div className="flex gap-1">
                      <Button
                        variant="ghost"
                        className="min-h-8 px-2"
                        onClick={() => setDialog({ kind: 'assign', seg: s })}
                      >
                        {s.roomId ? t('changeRoom') : t('assign')}
                      </Button>
                      {activeCount > 1 && (
                        <Button
                          variant="ghost"
                          className="min-h-8 px-2"
                          busy={remove.isPending && remove.variables === s.id}
                          onClick={() => remove.mutate(s.id)}
                        >
                          {t('removeRoom')}
                        </Button>
                      )}
                    </div>
                  )}
                </li>
              ))}
            </ul>
            {editable && (
              <Button variant="secondary" className="mt-3" onClick={() => setDialog({ kind: 'addRoom' })}>
                {t('addRoom')}
              </Button>
            )}
          </Card>
          {can('folio.read') && <FolioPanel reservationId={r.id} reservationStatus={r.status} />}
        </div>
        <div className="flex flex-col gap-4">
          {editable && (
            <Card>
              <div className="flex flex-col gap-2">
                {r.status === 'pending' && (
                  <Button busy={confirm.isPending} onClick={() => confirm.mutate()}>
                    {t('confirm')}
                  </Button>
                )}
                {r.arrival <= (property?.businessDate ?? '') && (
                  <Button variant="secondary" onClick={() => setDialog({ kind: 'noShow' })}>
                    {t('noShow')}
                  </Button>
                )}
                <Button variant="danger" onClick={() => setDialog({ kind: 'cancel' })}>
                  {t('cancel')}
                </Button>
              </div>
            </Card>
          )}
          <Card title={t('history')}>
            {history.isPending ? (
              <PageSkeleton />
            ) : history.isError ? (
              <ApiErrorAlert error={history.error} />
            ) : (
              <ol className="flex flex-col gap-3 text-sm">
                {history.data.map((e) => (
                  <li key={e.id}>
                    <p className="text-ink">{actionLabel(e.action)}</p>
                    <p className="text-xs text-muted">
                      {e.actor.name ?? '—'} ·{' '}
                      {format.dateTime(new Date(e.occurredAt), { dateStyle: 'medium', timeStyle: 'short' })}
                    </p>
                    {e.reason && <p className="text-xs text-muted">{e.reason}</p>}
                  </li>
                ))}
              </ol>
            )}
          </Card>
        </div>
      </div>

      {dialog?.kind === 'cancel' && (
        <ReasonDialog
          title={t('cancelTitle', { reference: r.bookingReference })}
          body={t('cancelBody')}
          confirmLabel={t('cancel')}
          required
          onClose={() => setDialog(null)}
          onSubmit={(reason) => api.post<ReservationDto>(`${base}/cancel`, { reason })}
          onDone={refresh}
        />
      )}
      {dialog?.kind === 'noShow' && (
        <ReasonDialog
          title={t('noShowTitle', { reference: r.bookingReference })}
          body={t('noShowBody')}
          confirmLabel={t('noShow')}
          onClose={() => setDialog(null)}
          onSubmit={(reason) => api.post<ReservationDto>(`${base}/no-show`, reason ? { reason } : {})}
          onDone={refresh}
        />
      )}
      {dialog?.kind === 'assign' && (
        <AssignDialog
          propertyId={propertyId}
          base={base}
          seg={dialog.seg}
          onClose={() => setDialog(null)}
          onDone={refresh}
        />
      )}
      {dialog?.kind === 'checkIn' && <CheckInDialog target={dialog.target} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'addRoom' && property && (
        <AddRoomDialog
          propertyId={propertyId}
          base={base}
          businessDate={property.businessDate}
          reservation={r}
          canOverrideRate={can('reservation.rate_override')}
          onClose={() => setDialog(null)}
          onDone={refresh}
        />
      )}
    </>
  );
}

function ReasonDialog({
  title,
  body,
  confirmLabel,
  required = false,
  onClose,
  onSubmit,
  onDone,
}: {
  title: string;
  body: string;
  confirmLabel: string;
  required?: boolean;
  onClose: () => void;
  onSubmit: (reason: string) => Promise<ReservationDto>;
  onDone: (r: ReservationDto) => void;
}) {
  const t = useTranslations('reservations');
  const [reason, setReason] = useState('');
  const run = useMutation({
    mutationFn: () => onSubmit(reason.trim()),
    onSuccess: (r) => {
      onDone(r);
      onClose();
    },
  });
  return (
    <Dialog open onClose={onClose} title={title}>
      <div className="flex flex-col gap-4">
        <p className="text-sm text-muted">{body}</p>
        {run.isError && <ApiErrorAlert error={run.error} />}
        <TextField
          label={t('cancelReason')}
          value={reason}
          maxLength={500}
          onChange={(e) => setReason(e.target.value)}
        />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            {t('keep')}
          </Button>
          <Button
            variant="danger"
            busy={run.isPending}
            disabled={required && reason.trim().length < 3}
            onClick={() => run.mutate()}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function AssignDialog({
  propertyId,
  base,
  seg,
  onClose,
  onDone,
}: {
  propertyId: string;
  base: string;
  seg: ReservationRoomDto;
  onClose: () => void;
  onDone: (r: ReservationDto) => void;
}) {
  const t = useTranslations('reservations');
  const [roomId, setRoomId] = useState(seg.roomId ?? '');
  const availability = useQuery({
    queryKey: ['availability', propertyId, seg.arrival, seg.departure],
    queryFn: () =>
      api.get<AvailabilityDto>(
        `/properties/${propertyId}/availability?arrival=${seg.arrival}&departure=${seg.departure}`,
      ),
  });
  const free = availability.data?.roomTypes.find((x) => x.roomTypeId === seg.roomTypeId)?.freeRooms ?? [];
  const options =
    seg.roomId && seg.roomNumber ? [{ id: seg.roomId, roomNumber: seg.roomNumber }, ...free] : free;
  const run = useMutation({
    mutationFn: (next: string | null) =>
      api.post<ReservationDto>(`${base}/rooms/${seg.id}/assign`, { roomId: next }),
    onSuccess: (r) => {
      onDone(r);
      onClose();
    },
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('assignTitle', { type: seg.roomTypeCode, arrival: seg.arrival, departure: seg.departure })}
    >
      <div className="flex flex-col gap-4">
        {run.isError && <ApiErrorAlert error={run.error} />}
        <SelectField label={t('room')} value={roomId} onChange={(e) => setRoomId(e.target.value)}>
          <option value="">{t('anyRoom')}</option>
          {options.map((r) => (
            <option key={r.id} value={r.id}>
              {r.roomNumber}
            </option>
          ))}
        </SelectField>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            {t('close')}
          </Button>
          <Button
            busy={run.isPending}
            disabled={roomId === (seg.roomId ?? '')}
            onClick={() => run.mutate(roomId || null)}
          >
            {roomId ? t('assign') : t('unassign')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function AddRoomDialog({
  propertyId,
  base,
  businessDate,
  reservation,
  canOverrideRate,
  onClose,
  onDone,
}: {
  propertyId: string;
  base: string;
  businessDate: string;
  reservation: ReservationDto;
  canOverrideRate: boolean;
  onClose: () => void;
  onDone: (r: ReservationDto) => void;
}) {
  const t = useTranslations('reservations');
  const start = reservation.arrival >= businessDate ? reservation.arrival : businessDate;
  const [choice, setChoice] = useState<RoomChoice>({
    arrival: start,
    departure: reservation.departure > start ? reservation.departure : start,
    adults: 2,
    children: 0,
    roomTypeId: '',
    roomId: null,
    overrideRate: false,
    nightlyRate: '',
    rateOverrideReason: '',
  });
  const run = useMutation({
    mutationFn: () => api.post<ReservationDto>(`${base}/rooms`, toRoomInput(choice)),
    onSuccess: (r) => {
      onDone(r);
      onClose();
    },
  });
  return (
    <Dialog open onClose={onClose} title={t('addRoom')}>
      <div className="flex flex-col gap-4">
        {run.isError && <ApiErrorAlert error={run.error} />}
        <BookingRoomPicker
          propertyId={propertyId}
          minDate={businessDate}
          value={choice}
          onChange={setChoice}
          canOverrideRate={canOverrideRate}
        />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            {t('close')}
          </Button>
          <Button busy={run.isPending} disabled={!choice.roomTypeId} onClick={() => run.mutate()}>
            {t('addRoom')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
