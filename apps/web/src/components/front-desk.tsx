'use client';

import {
  OVERRIDABLE_PROBLEMS,
  type AvailabilityDto,
  type ReadinessProblem,
  type RoomBoardDto,
  type StayDto,
} from '@innpilot/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { readinessFromBoard } from '@/lib/readiness';
import { useSession } from '@/lib/session';
import { ApiErrorAlert, Button, Dialog, SelectField, StatusBadge, TextField } from './ui';

export interface RoomOption {
  id: string;
  roomNumber: string;
  roomTypeId: string;
  roomTypeCode: string;
  nightlyRate: string | null;
  currencyCode: string;
  readiness: ReadinessProblem | null;
}

/**
 * Rooms with no booking for [arrival, departure), with their readiness right now. Optionally limited to one
 * room type. Advisory only: the server re-checks both when the action is saved.
 */
export function useFreeRooms(arrival: string, departure: string, roomTypeId?: string) {
  const { property } = useSession();
  const propertyId = property?.id ?? '';
  const enabled = !!propertyId && !!arrival && !!departure && departure > arrival;
  const availability = useQuery({
    queryKey: ['availability', propertyId, arrival, departure],
    queryFn: () =>
      api.get<AvailabilityDto>(
        `/properties/${propertyId}/availability?arrival=${arrival}&departure=${departure}`,
      ),
    enabled,
  });
  const board = useQuery({
    queryKey: ['room-board', propertyId],
    queryFn: () => api.get<RoomBoardDto>(`/properties/${propertyId}/room-board`),
    enabled,
  });
  const options = useMemo<RoomOption[]>(() => {
    if (!availability.data || !board.data) return [];
    const state = new Map(board.data.rooms.map((r) => [r.id, r.boardState]));
    return availability.data.roomTypes
      .filter((t) => !roomTypeId || t.roomTypeId === roomTypeId)
      .flatMap((t) =>
        t.freeRooms.map((r) => ({
          id: r.id,
          roomNumber: r.roomNumber,
          roomTypeId: t.roomTypeId,
          roomTypeCode: t.code,
          nightlyRate: t.nightlyRate,
          currencyCode: t.currencyCode,
          readiness: readinessFromBoard(state.get(r.id) ?? 'vacant_ready'),
        })),
      )
      .sort((a, b) => Number(a.readiness !== null) - Number(b.readiness !== null));
  }, [availability.data, board.data, roomTypeId]);
  return {
    options,
    isPending: enabled && (availability.isPending || board.isPending),
    error: availability.error ?? board.error,
  };
}

export function ReadinessBadge({ problem }: { problem: ReadinessProblem | null }) {
  const t = useTranslations('frontDesk.readiness');
  if (!problem) return <StatusBadge tone="success">{t('ready')}</StatusBadge>;
  return (
    <StatusBadge tone={problem === 'occupied' || problem === 'out_of_order' ? 'danger' : 'warning'}>
      {t(problem)}
    </StatusBadge>
  );
}

/** Room select plus, when the chosen room is not ready, the override reason (or an explanation). */
export function RoomReadinessFields({
  options,
  roomId,
  onRoom,
  reason,
  onReason,
  label,
}: {
  options: RoomOption[];
  roomId: string;
  onRoom: (id: string) => void;
  reason: string;
  onReason: (r: string) => void;
  label?: string;
}) {
  const t = useTranslations('frontDesk');
  const tReady = useTranslations('frontDesk.readiness');
  const { can } = useSession();
  const chosen = options.find((o) => o.id === roomId);
  const problem = chosen?.readiness ?? null;
  const overridable = problem !== null && OVERRIDABLE_PROBLEMS.includes(problem);
  return (
    <div className="flex flex-col gap-3">
      <SelectField label={label ?? t('chooseRoom')} value={roomId} onChange={(e) => onRoom(e.target.value)}>
        <option value="">{t('chooseRoomPlaceholder')}</option>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.roomNumber} · {o.roomTypeCode}
            {o.readiness ? ` — ${tReady(o.readiness)}` : ''}
          </option>
        ))}
      </SelectField>
      {problem && (
        <div className="rounded-md border border-warning/30 bg-warning-50 px-3 py-2 text-sm text-warning">
          <p>{t('notReady', { problem: tReady(problem).toLowerCase() })}</p>
          {(!overridable || !can('stay.readiness_override')) && (
            <p className="mt-1">{t('notReadyNoOverride')}</p>
          )}
        </div>
      )}
      {problem && overridable && can('stay.readiness_override') && (
        <TextField
          label={t('overrideReason')}
          value={reason}
          maxLength={300}
          onChange={(e) => onReason(e.target.value)}
        />
      )}
    </div>
  );
}

export function canProceed(
  options: RoomOption[],
  roomId: string,
  reason: string,
  canOverride: boolean,
): boolean {
  const chosen = options.find((o) => o.id === roomId);
  if (!chosen) return false;
  if (!chosen.readiness) return true;
  return OVERRIDABLE_PROBLEMS.includes(chosen.readiness) && canOverride && reason.trim().length >= 3;
}

function useInvalidateFrontDesk() {
  const queryClient = useQueryClient();
  return () =>
    Promise.all(
      [
        ['front-desk'],
        ['reservations'],
        ['reservation'],
        ['reservation-history'],
        ['room-board'],
        ['availability'],
      ].map((queryKey) => queryClient.invalidateQueries({ queryKey })),
    );
}

export interface CheckInTarget {
  reservationId: string;
  reservationRoomId: string;
  guestName: string;
  roomTypeId: string;
  roomId: string | null;
  roomNumber: string | null;
  departure: string;
}

export function CheckInDialog({ target, onClose }: { target: CheckInTarget; onClose: () => void }) {
  const t = useTranslations('frontDesk');
  const { property, can } = useSession();
  const invalidate = useInvalidateFrontDesk();
  // One key per attempt: a double click or retry cannot check the guest in twice.
  const [key] = useState(() => crypto.randomUUID());
  const [roomId, setRoomId] = useState(target.roomId ?? '');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const businessDate = property?.businessDate ?? '';
  const free = useFreeRooms(businessDate, target.departure, target.roomTypeId);
  // The assigned room is booked by this guest, so it is not in the "free" list; add it with its readiness.
  const board = useQuery({
    queryKey: ['room-board', property?.id],
    queryFn: () => api.get<RoomBoardDto>(`/properties/${property!.id}/room-board`),
    enabled: !!target.roomId,
  });
  const assigned = board.data?.rooms.find((r) => r.id === target.roomId);
  const options: RoomOption[] = target.roomId
    ? assigned
      ? [
          {
            id: assigned.id,
            roomNumber: assigned.roomNumber,
            roomTypeId: assigned.roomTypeId,
            roomTypeCode: assigned.roomTypeCode,
            nightlyRate: null,
            currencyCode: 'PKR',
            readiness: readinessFromBoard(assigned.boardState),
          },
        ]
      : []
    : free.options;

  const submit = async () => {
    setError(null);
    setBusy(true);
    try {
      await api.postWith<StayDto>(
        `/properties/${property!.id}/reservations/${target.reservationId}/rooms/${target.reservationRoomId}/check-in`,
        {
          ...(target.roomId ? {} : { roomId }),
          ...(reason.trim() ? { readinessOverrideReason: reason.trim() } : {}),
        },
        { 'idempotency-key': key },
      );
      await invalidate();
      onClose();
    } catch (err) {
      setError(err);
      setBusy(false);
      void invalidate();
    }
  };

  return (
    <Dialog open onClose={onClose} title={t('checkInTitle', { guest: target.guestName })}>
      <div className="flex flex-col gap-4">
        {error !== null && <ApiErrorAlert error={error} />}
        <RoomReadinessFields
          options={options}
          roomId={roomId}
          onRoom={setRoomId}
          reason={reason}
          onReason={setReason}
        />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button
            busy={busy}
            disabled={!canProceed(options, roomId, reason, can('stay.readiness_override'))}
            onClick={() => void submit()}
          >
            {t('confirmCheckIn')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

export function MoveDialog({ stay, onClose }: { stay: StayDto; onClose: () => void }) {
  const t = useTranslations('frontDesk');
  const { property, can } = useSession();
  const invalidate = useInvalidateFrontDesk();
  const [roomId, setRoomId] = useState('');
  const [moveReason, setMoveReason] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const free = useFreeRooms(property?.businessDate ?? '', stay.departure);
  const options = free.options.filter((o) => o.id !== stay.roomId);

  const submit = async () => {
    setError(null);
    setBusy(true);
    try {
      await api.post<StayDto>(`/properties/${property!.id}/stays/${stay.id}/move`, {
        roomId,
        reason: moveReason.trim(),
        ...(reason.trim() ? { readinessOverrideReason: reason.trim() } : {}),
      });
      await invalidate();
      onClose();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={t('moveTitle', { guest: stay.guest.fullName, room: stay.roomNumber })}
    >
      <div className="flex flex-col gap-4">
        {error !== null && <ApiErrorAlert error={error} />}
        <RoomReadinessFields
          options={options}
          roomId={roomId}
          onRoom={setRoomId}
          reason={reason}
          onReason={setReason}
        />
        <TextField
          label={t('moveReason')}
          value={moveReason}
          maxLength={300}
          onChange={(e) => setMoveReason(e.target.value)}
        />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button
            busy={busy}
            disabled={
              moveReason.trim().length < 3 ||
              !canProceed(options, roomId, reason, can('stay.readiness_override'))
            }
            onClick={() => void submit()}
          >
            {t('confirmMove')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
