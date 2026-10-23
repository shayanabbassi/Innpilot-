'use client';

import { addDays, RESERVATION_SOURCES, type GuestSummaryDto, type ReservationDto } from '@innpilot/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { BookingRoomPicker, toRoomInput, type RoomChoice } from '@/components/booking-room-picker';
import { GuestPicker } from '@/components/guest-picker';
import {
  ApiErrorAlert,
  Button,
  Card,
  PageHeader,
  PageSkeleton,
  PermissionDenied,
  SelectField,
  TextField,
} from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { useSession } from '@/lib/session';

export default function NewReservationPage() {
  // useSearchParams needs a Suspense boundary for static rendering.
  return (
    <Suspense fallback={<PageSkeleton />}>
      <NewReservation />
    </Suspense>
  );
}

function NewReservation() {
  const t = useTranslations('reservations');
  const router = useRouter();
  const params = useSearchParams();
  const queryClient = useQueryClient();
  const { property, can } = useSession();
  // One key per booking attempt: a double click or network retry cannot create two bookings.
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const [guest, setGuest] = useState<GuestSummaryDto | null>(null);
  const [source, setSource] = useState<(typeof RESERVATION_SOURCES)[number]>('phone');
  const [status, setStatus] = useState<'confirmed' | 'pending'>('confirmed');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const businessDate = property?.businessDate ?? '';
  const arrival =
    params.get('arrival') && params.get('arrival')! >= businessDate ? params.get('arrival')! : businessDate;
  const [choice, setChoice] = useState<RoomChoice>({
    arrival,
    departure: addDays(arrival, 1),
    adults: 2,
    children: 0,
    roomTypeId: params.get('roomTypeId') ?? '',
    roomId: params.get('roomId'),
    overrideRate: false,
    nightlyRate: '',
    rateOverrideReason: '',
  });

  if (!property || !can('reservation.write')) return <PermissionDenied />;

  const submit = async () => {
    setError(null);
    setFieldErrors({});
    if (!guest) {
      setFieldErrors({ guest: t('findGuest') });
      return;
    }
    setBusy(true);
    try {
      const created = await api.postWith<ReservationDto>(
        `/properties/${property.id}/reservations`,
        {
          guestId: guest.id,
          source,
          status,
          ...(notes.trim() ? { notes } : {}),
          rooms: [toRoomInput(choice)],
        },
        { 'idempotency-key': idempotencyKey },
      );
      void queryClient.invalidateQueries({ queryKey: ['reservations'] });
      router.replace(`/reservations/${created.id}`);
    } catch (err) {
      setBusy(false);
      if (err instanceof ApiError) {
        const mapped: Record<string, string> = {};
        for (const d of err.details) mapped[d.path.replace(/^rooms\.\d+\./, '')] = d.message;
        setFieldErrors(mapped);
        if (err.code === 'ROOM_UNAVAILABLE') {
          void queryClient.invalidateQueries({ queryKey: ['availability'] });
          // A different booking now, so it gets a new key.
          setIdempotencyKey(crypto.randomUUID());
        }
      }
      setError(err);
    }
  };

  return (
    <>
      <PageHeader title={t('newBooking')} />
      <div className="flex max-w-3xl flex-col gap-4">
        {error !== null && <ApiErrorAlert error={error} />}
        <Card title={t('guest')}>
          <GuestPicker value={guest} onChange={setGuest} error={fieldErrors.guest ?? fieldErrors.guestId} />
        </Card>
        <Card title={t('rooms')}>
          <BookingRoomPicker
            propertyId={property.id}
            minDate={businessDate}
            value={choice}
            onChange={setChoice}
            canOverrideRate={can('reservation.rate_override')}
            errors={fieldErrors}
          />
        </Card>
        <Card>
          <div className="grid gap-4 sm:grid-cols-2">
            <SelectField
              label={t('source')}
              value={source}
              onChange={(e) => setSource(e.target.value as typeof source)}
            >
              {RESERVATION_SOURCES.map((s) => (
                <option key={s} value={s}>
                  {t(`sources.${s}`)}
                </option>
              ))}
            </SelectField>
            <SelectField
              label={t('status')}
              value={status}
              onChange={(e) => setStatus(e.target.value as typeof status)}
            >
              <option value="confirmed">{t('statuses.confirmed')}</option>
              <option value="pending">{t('statuses.pending')}</option>
            </SelectField>
            <TextField
              label={t('notes')}
              className="sm:col-span-2"
              value={notes}
              maxLength={2000}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>
        </Card>
        <div className="flex justify-end">
          <Button busy={busy} disabled={!guest || !choice.roomTypeId} onClick={() => void submit()}>
            {busy ? t('creating') : t('create')}
          </Button>
        </div>
      </div>
    </>
  );
}
