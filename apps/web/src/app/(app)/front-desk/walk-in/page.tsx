'use client';

import { addDays, nightsBetween, type GuestSummaryDto, type StayDto } from '@innpilot/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { canProceed, RoomReadinessFields, useFreeRooms } from '@/components/front-desk';
import { GuestPicker } from '@/components/guest-picker';
import { formatRate } from '@/components/rooms-setup';
import { ApiErrorAlert, Button, Card, PageHeader, PermissionDenied, TextField } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { useSession } from '@/lib/session';

export default function WalkInPage() {
  const t = useTranslations('frontDesk');
  const tRes = useTranslations('reservations');
  const router = useRouter();
  const queryClient = useQueryClient();
  const { property, can } = useSession();
  const businessDate = property?.businessDate ?? '';
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [guest, setGuest] = useState<GuestSummaryDto | null>(null);
  const [departure, setDeparture] = useState(() => addDays(businessDate, 1));
  const [adults, setAdults] = useState(1);
  const [children, setChildren] = useState(0);
  const [roomId, setRoomId] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const free = useFreeRooms(businessDate, departure);

  if (!property || !can('stay.checkin') || !can('reservation.write')) return <PermissionDenied />;
  const chosen = free.options.find((o) => o.id === roomId);

  const submit = async () => {
    setError(null);
    setBusy(true);
    try {
      const stay = await api.postWith<StayDto>(
        `/properties/${property.id}/walk-ins`,
        {
          guestId: guest!.id,
          roomId,
          departure,
          adults,
          children,
          ...(reason.trim() ? { readinessOverrideReason: reason.trim() } : {}),
        },
        { 'idempotency-key': key },
      );
      await Promise.all(
        [['front-desk'], ['reservations'], ['room-board'], ['availability']].map((queryKey) =>
          queryClient.invalidateQueries({ queryKey }),
        ),
      );
      router.replace(`/reservations/${stay.reservationId}`);
    } catch (err) {
      setError(err);
      setBusy(false);
      if (err instanceof ApiError && (err.code === 'ROOM_UNAVAILABLE' || err.code === 'ROOM_NOT_READY')) {
        setKey(crypto.randomUUID());
        void queryClient.invalidateQueries({ queryKey: ['availability'] });
        void queryClient.invalidateQueries({ queryKey: ['room-board'] });
      }
    }
  };

  return (
    <>
      <PageHeader title={t('walkInTitle')} />
      <div className="flex max-w-3xl flex-col gap-4">
        {error !== null && <ApiErrorAlert error={error} />}
        <Card title={tRes('guest')}>
          <GuestPicker value={guest} onChange={setGuest} />
        </Card>
        <Card title={tRes('rooms')}>
          <div className="flex flex-col gap-4">
            <div className="grid gap-4 sm:grid-cols-3">
              <TextField
                label={t('stayUntil')}
                type="date"
                min={addDays(businessDate, 1)}
                value={departure}
                hint={tRes('nights', {
                  count: Math.max(0, nightsBetween(businessDate, departure)),
                })}
                onChange={(e) => {
                  setDeparture(e.target.value);
                  setRoomId('');
                }}
              />
              <TextField
                label={tRes('adults')}
                type="number"
                min={1}
                max={20}
                value={String(adults)}
                onChange={(e) => setAdults(Number(e.target.value) || 1)}
              />
              <TextField
                label={tRes('children')}
                type="number"
                min={0}
                max={20}
                value={String(children)}
                onChange={(e) => setChildren(Number(e.target.value) || 0)}
              />
            </div>
            {!free.isPending && free.options.length === 0 ? (
              <p className="text-sm text-muted">{t('noRoomsFree')}</p>
            ) : (
              <RoomReadinessFields
                label={t('roomsTonight')}
                options={free.options}
                roomId={roomId}
                onRoom={setRoomId}
                reason={reason}
                onReason={setReason}
              />
            )}
            {chosen?.nightlyRate && (
              <p className="text-sm text-muted">
                {t('ratePerNight', { rate: formatRate(chosen.nightlyRate, chosen.currencyCode) })}
              </p>
            )}
          </div>
        </Card>
        <div className="flex justify-end">
          <Button
            busy={busy}
            disabled={!guest || !canProceed(free.options, roomId, reason, can('stay.readiness_override'))}
            onClick={() => void submit()}
          >
            {busy ? t('creating') : t('create')}
          </Button>
        </div>
      </div>
    </>
  );
}
