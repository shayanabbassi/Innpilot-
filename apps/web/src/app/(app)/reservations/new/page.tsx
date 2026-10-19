'use client';

import {
  addDays,
  RESERVATION_SOURCES,
  type GuestDto,
  type GuestSummaryDto,
  type ReservationDto,
} from '@innpilot/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { BookingRoomPicker, toRoomInput, type RoomChoice } from '@/components/booking-room-picker';
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

/** Search existing guests, or add a minimal new one without leaving the booking. */
function GuestPicker({
  value,
  onChange,
  error,
}: {
  value: GuestSummaryDto | null;
  onChange: (g: GuestSummaryDto | null) => void;
  error?: string;
}) {
  const t = useTranslations('reservations');
  const { can } = useSession();
  const [input, setInput] = useState('');
  const [search, setSearch] = useState('');
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [addError, setAddError] = useState<unknown>(null);
  useEffect(() => {
    const id = setTimeout(() => setSearch(input.trim()), 300);
    return () => clearTimeout(id);
  }, [input]);
  const results = useQuery({
    queryKey: ['guests', search],
    queryFn: () => api.get<GuestSummaryDto[]>(`/guests?search=${encodeURIComponent(search)}&limit=8`),
    enabled: search.length >= 2,
  });

  if (value) {
    return (
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="font-medium text-ink">{value.fullName}</p>
          <p className="text-sm text-muted">{[value.phone, value.email].filter(Boolean).join(' · ')}</p>
        </div>
        <Button variant="ghost" onClick={() => onChange(null)}>
          {t('changeGuest')}
        </Button>
      </div>
    );
  }

  const add = async () => {
    setAddError(null);
    try {
      const g = await api.post<GuestDto>('/guests', { fullName: name, ...(phone ? { phone } : {}) });
      onChange(g);
    } catch (err) {
      setAddError(err);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <TextField
        label={t('findGuest')}
        placeholder={t('findGuestPlaceholder')}
        value={input}
        error={error}
        onChange={(e) => setInput(e.target.value)}
      />
      {search.length >= 2 && results.data && (
        <ul className="divide-y divide-line rounded-md border border-line">
          {results.data.length === 0 && <li className="px-3 py-2 text-sm text-muted">{t('noGuestFound')}</li>}
          {results.data.map((g) => (
            <li key={g.id}>
              <button
                type="button"
                className="w-full px-3 py-2 text-left text-sm hover:bg-canvas"
                onClick={() => onChange(g)}
              >
                <span className="font-medium text-ink">{g.fullName}</span>{' '}
                <span className="text-muted">{[g.phone, g.email].filter(Boolean).join(' · ')}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {can('guest.write') &&
        (adding ? (
          <div className="grid gap-3 rounded-md border border-line p-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
            {addError !== null && (
              <div className="sm:col-span-3">
                <ApiErrorAlert error={addError} />
              </div>
            )}
            <TextField label={t('newGuestName')} value={name} onChange={(e) => setName(e.target.value)} />
            <TextField
              label={t('newGuestPhone')}
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
            />
            <Button disabled={!name.trim()} onClick={() => void add()}>
              {t('addGuest')}
            </Button>
          </div>
        ) : (
          <div>
            <Button variant="secondary" onClick={() => setAdding(true)}>
              {t('createGuest')}
            </Button>
          </div>
        ))}
    </div>
  );
}
