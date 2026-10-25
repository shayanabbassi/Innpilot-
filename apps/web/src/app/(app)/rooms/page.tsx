'use client';

import { BOARD_STATES, type BoardState, type RoomBoardDto } from '@innpilot/contracts';
import { useQuery } from '@tanstack/react-query';
import { useFormatter, useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';
import {
  EmptyState,
  PageError,
  PageHeader,
  PageSkeleton,
  PermissionDenied,
  SelectField,
  StatusBadge,
} from '@/components/ui';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';

const TONE: Record<BoardState, 'success' | 'neutral' | 'danger' | 'warning'> = {
  vacant_ready: 'success',
  vacant_dirty: 'warning',
  cleaning: 'warning',
  occupied: 'neutral',
  out_of_order: 'danger',
  inactive: 'neutral',
};

const CARD: Record<BoardState, string> = {
  vacant_ready: 'border-success/40',
  vacant_dirty: 'border-warning/50',
  cleaning: 'border-warning/50',
  occupied: 'border-navy-700/40',
  out_of_order: 'border-danger/50',
  inactive: 'border-dashed border-line opacity-70',
};

export default function RoomBoardPage() {
  const t = useTranslations('board');
  const format = useFormatter();
  const { property, can } = useSession();
  const allowed = !!property && can('room.read');
  const board = useQuery({
    queryKey: ['room-board', property?.id],
    queryFn: () => api.get<RoomBoardDto>(`/properties/${property!.id}/room-board`),
    enabled: allowed,
    refetchInterval: 60_000,
  });
  const [floor, setFloor] = useState('');
  const [typeId, setTypeId] = useState('');
  const [state, setState] = useState<BoardState | ''>('');

  const options = useMemo(() => {
    const rooms = board.data?.rooms ?? [];
    return {
      floors: [...new Set(rooms.map((r) => r.floor).filter((f): f is string => !!f))].sort(),
      types: [
        ...new Map(rooms.map((r) => [r.roomTypeId, `${r.roomTypeCode} — ${r.roomTypeName}`])).entries(),
      ],
    };
  }, [board.data]);

  if (!allowed) return <PermissionDenied />;
  if (board.isPending) return <PageSkeleton />;
  if (board.isError) return <PageError error={board.error} onRetry={() => void board.refetch()} />;

  const data = board.data;
  const rooms = data.rooms.filter(
    (r) =>
      (!floor || r.floor === floor) &&
      (!typeId || r.roomTypeId === typeId) &&
      (!state || r.boardState === state),
  );
  const date = format.dateTime(new Date(`${data.businessDate}T00:00:00Z`), {
    dateStyle: 'medium',
    timeZone: 'UTC',
  });

  return (
    <>
      <PageHeader title={t('title')} subtitle={t('subtitle', { date })} />
      {data.rooms.length === 0 ? (
        <EmptyState message={t('noRooms')} />
      ) : (
        <>
          <ul className="mb-4 flex flex-wrap gap-2" aria-label={t('filterState')}>
            {BOARD_STATES.filter((s) => (data.counts[s] ?? 0) > 0).map((s) => (
              <li key={s}>
                <button
                  type="button"
                  aria-pressed={state === s}
                  onClick={() => setState(state === s ? '' : s)}
                  className={`rounded-full border px-3 py-1 text-sm ${
                    state === s ? 'border-navy-800 bg-navy-800 text-white' : 'border-line bg-white text-ink'
                  }`}
                >
                  {t(`states.${s}`)} <span className="tabular font-semibold">{data.counts[s] ?? 0}</span>
                </button>
              </li>
            ))}
          </ul>
          <div className="mb-4 grid gap-3 sm:grid-cols-3">
            {options.floors.length > 0 && (
              <SelectField label={t('filterFloor')} value={floor} onChange={(e) => setFloor(e.target.value)}>
                <option value="">{t('all')}</option>
                {options.floors.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </SelectField>
            )}
            <SelectField label={t('filterType')} value={typeId} onChange={(e) => setTypeId(e.target.value)}>
              <option value="">{t('all')}</option>
              {options.types.map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </SelectField>
          </div>
          {rooms.length === 0 ? (
            <EmptyState message={t('empty')} />
          ) : (
            <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
              {rooms.map((r) => (
                <li key={r.id} className={`rounded-lg border-2 bg-white p-3 ${CARD[r.boardState]}`}>
                  <p className="tabular text-lg font-semibold text-ink">{r.roomNumber}</p>
                  <p className="text-xs text-muted">
                    {r.roomTypeCode}
                    {r.floor ? ` · ${t('floorLabel', { floor: r.floor })}` : ''}
                  </p>
                  <div className="mt-2">
                    <StatusBadge tone={TONE[r.boardState]}>{t(`states.${r.boardState}`)}</StatusBadge>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </>
  );
}
