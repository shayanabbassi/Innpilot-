'use client';

import {
  HOUSEKEEPING_TRANSITIONS,
  type HousekeepingState,
  type RoomBoardDto,
  type StaffMemberDto,
  type TaskDto,
} from '@innpilot/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useFormatter, useTranslations } from 'next-intl';
import { useState } from 'react';
import {
  ApiErrorAlert,
  Button,
  Dialog,
  EmptyState,
  PageError,
  PageHeader,
  PageSkeleton,
  PermissionDenied,
  StatusBadge,
  TextField,
} from '@/components/ui';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';

const STATE_TONE: Record<HousekeepingState, 'success' | 'neutral' | 'danger' | 'warning'> = {
  dirty: 'warning',
  cleaning: 'neutral',
  clean: 'success',
  inspected: 'success',
};

export default function HousekeepingPage() {
  const t = useTranslations('housekeeping');
  const format = useFormatter();
  const { property, can, me } = useSession();
  const allowed = !!property && can('housekeeping.read');
  const canWrite = can('housekeeping.write');
  // Housekeeping staff see their own and unassigned work by default; supervisors see everyone's.
  const isStaff = (property?.roles ?? []).every((r) => r === 'housekeeping');
  const [tab, setTab] = useState<'tasks' | 'rooms'>('tasks');
  const [mine, setMine] = useState(isStaff);
  const propertyId = property?.id ?? '';

  if (!allowed) return <PermissionDenied />;
  const date = format.dateTime(new Date(`${property.businessDate}T00:00:00Z`), {
    dateStyle: 'medium',
    timeZone: 'UTC',
  });

  return (
    <>
      <PageHeader title={t('title')} subtitle={t('subtitle', { date })} />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div role="tablist" className="flex rounded-md border border-line bg-white p-0.5">
          {(['tasks', 'rooms'] as const).map((v) => (
            <button
              key={v}
              role="tab"
              aria-selected={tab === v}
              onClick={() => setTab(v)}
              className={`rounded px-3 py-1.5 text-sm ${tab === v ? 'bg-navy-800 text-white' : 'text-ink'}`}
            >
              {t(v === 'tasks' ? 'tasksTab' : 'roomsTab')}
            </button>
          ))}
        </div>
        {tab === 'tasks' && (
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="h-4 w-4"
              checked={mine}
              onChange={(e) => setMine(e.target.checked)}
            />
            {t('mine')}
          </label>
        )}
      </div>
      {tab === 'tasks' ? (
        <TaskQueue propertyId={propertyId} mine={mine} canWrite={canWrite} meId={me.user.id} />
      ) : (
        <RoomStates propertyId={propertyId} canWrite={canWrite} />
      )}
    </>
  );
}

function useInvalidate(propertyId: string) {
  const queryClient = useQueryClient();
  return () =>
    Promise.all(
      [['hk-tasks', propertyId], ['room-board', propertyId], ['front-desk'], ['availability']].map(
        (queryKey) => queryClient.invalidateQueries({ queryKey }),
      ),
    );
}

function TaskQueue({
  propertyId,
  mine,
  canWrite,
  meId,
}: {
  propertyId: string;
  mine: boolean;
  canWrite: boolean;
  meId: string;
}) {
  const t = useTranslations('housekeeping');
  const invalidate = useInvalidate(propertyId);
  const [failing, setFailing] = useState<TaskDto | null>(null);
  const tasks = useQuery({
    queryKey: ['hk-tasks', propertyId, mine],
    queryFn: () => api.get<TaskDto[]>(`/properties/${propertyId}/housekeeping/tasks?mine=${mine}`),
    refetchInterval: 30_000,
  });
  const staff = useQuery({
    queryKey: ['hk-staff', propertyId],
    queryFn: () => api.get<StaffMemberDto[]>(`/properties/${propertyId}/housekeeping/staff`),
    enabled: canWrite,
  });
  const act = useMutation({
    mutationFn: ({ id, action, body }: { id: string; action: 'start' | 'complete'; body?: object }) =>
      api.post<TaskDto>(`/properties/${propertyId}/housekeeping/tasks/${id}/${action}`, body ?? {}),
    onSuccess: invalidate,
  });
  const assign = useMutation({
    mutationFn: ({ id, userId }: { id: string; userId: string | null }) =>
      api.patch<TaskDto>(`/properties/${propertyId}/housekeeping/tasks/${id}`, { assignedUserId: userId }),
    onSuccess: invalidate,
  });

  if (tasks.isPending) return <PageSkeleton />;
  if (tasks.isError) return <PageError error={tasks.error} onRetry={() => void tasks.refetch()} />;
  if (tasks.data.length === 0) return <EmptyState message={t('noTasks')} />;

  return (
    <>
      {(act.isError || assign.isError) && (
        <div className="mb-3">
          <ApiErrorAlert error={act.error ?? assign.error} />
        </div>
      )}
      <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {tasks.data.map((task) => (
          <li key={task.id} className="flex flex-col gap-3 rounded-lg border border-line bg-white p-4">
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="tabular text-xl font-semibold text-ink">{task.roomNumber}</p>
                <p className="text-xs text-muted">
                  {task.roomTypeCode}
                  {task.floor ? ` · ${t('floor', { floor: task.floor })}` : ''}
                </p>
              </div>
              <div className="flex flex-col items-end gap-1">
                <StatusBadge tone={task.taskType === 'clean' ? 'warning' : 'neutral'}>
                  {t(`taskTypes.${task.taskType}`)}
                </StatusBadge>
                <StatusBadge tone={STATE_TONE[task.housekeepingState]}>
                  {t(`states.${task.housekeepingState}`)}
                </StatusBadge>
              </div>
            </div>
            <p className="text-xs text-muted">
              {t(`sources.${task.source}`)} · {t(`taskStatus.${task.status}`)}
              {task.notes ? ` · ${task.notes}` : ''}
            </p>
            {canWrite && staff.data && (
              <label className="text-xs text-muted">
                {t('assignTo')}{' '}
                <select
                  className="ml-1 rounded border border-line bg-white px-1 py-0.5 text-sm text-ink"
                  value={task.assignedUserId ?? ''}
                  onChange={(e) => assign.mutate({ id: task.id, userId: e.target.value || null })}
                >
                  <option value="">{t('unassigned')}</option>
                  {staff.data.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.fullName}
                      {s.id === meId ? ' ✓' : ''}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {!canWrite && <p className="text-xs text-muted">{task.assignedName ?? t('unassigned')}</p>}
            {canWrite && (
              <div className="flex gap-2">
                {task.taskType === 'clean' && task.status === 'open' && (
                  <Button
                    variant="secondary"
                    className="flex-1"
                    busy={act.isPending}
                    onClick={() => act.mutate({ id: task.id, action: 'start' })}
                  >
                    {t('start')}
                  </Button>
                )}
                {task.taskType === 'clean' ? (
                  <Button
                    className="flex-1"
                    busy={act.isPending}
                    onClick={() => act.mutate({ id: task.id, action: 'complete' })}
                  >
                    {t('done')}
                  </Button>
                ) : (
                  <>
                    <Button
                      className="flex-1"
                      busy={act.isPending}
                      disabled={task.housekeepingState !== 'clean'}
                      onClick={() => act.mutate({ id: task.id, action: 'complete', body: { passed: true } })}
                    >
                      {t('pass')}
                    </Button>
                    <Button
                      variant="danger"
                      className="flex-1"
                      disabled={task.housekeepingState !== 'clean'}
                      onClick={() => setFailing(task)}
                    >
                      {t('fail')}
                    </Button>
                  </>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
      {failing && (
        <FailDialog
          onClose={() => setFailing(null)}
          onSubmit={(notes) =>
            act.mutateAsync({
              id: failing.id,
              action: 'complete',
              body: { passed: false, ...(notes ? { notes } : {}) },
            })
          }
        />
      )}
    </>
  );
}

function FailDialog({
  onClose,
  onSubmit,
}: {
  onClose: () => void;
  onSubmit: (notes: string) => Promise<unknown>;
}) {
  const t = useTranslations('housekeeping');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open onClose={onClose} title={t('fail')}>
      <div className="flex flex-col gap-4">
        <TextField
          label={t('failNote')}
          value={notes}
          maxLength={500}
          onChange={(e) => setNotes(e.target.value)}
        />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button
            variant="danger"
            busy={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onSubmit(notes.trim());
                onClose();
              } finally {
                setBusy(false);
              }
            }}
          >
            {t('fail')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

/** Every room with its state and only the transitions the rules allow. */
function RoomStates({ propertyId, canWrite }: { propertyId: string; canWrite: boolean }) {
  const t = useTranslations('housekeeping');
  const invalidate = useInvalidate(propertyId);
  const board = useQuery({
    queryKey: ['room-board', propertyId],
    queryFn: () => api.get<RoomBoardDto>(`/properties/${propertyId}/room-board`),
  });
  const change = useMutation({
    mutationFn: ({ roomId, state }: { roomId: string; state: HousekeepingState }) =>
      api.post(`/properties/${propertyId}/rooms/${roomId}/housekeeping-state`, { state }),
    onSuccess: invalidate,
  });
  const inspect = useMutation({
    mutationFn: (roomId: string) =>
      api.post(`/properties/${propertyId}/housekeeping/tasks`, { roomId, taskType: 'inspect' }),
    onSuccess: invalidate,
  });

  if (board.isPending) return <PageSkeleton />;
  if (board.isError) return <PageError error={board.error} onRetry={() => void board.refetch()} />;

  return (
    <>
      {(change.isError || inspect.isError) && (
        <div className="mb-3">
          <ApiErrorAlert error={change.error ?? inspect.error} />
        </div>
      )}
      <ul className="divide-y divide-line rounded-lg border border-line bg-white">
        {board.data.rooms
          .filter((r) => r.active)
          .map((r) => (
            <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2">
              <div className="flex items-center gap-3">
                <span className="tabular w-12 font-semibold text-ink">{r.roomNumber}</span>
                <StatusBadge tone={STATE_TONE[r.housekeepingState]}>
                  {t(`states.${r.housekeepingState}`)}
                </StatusBadge>
                {r.serviceState === 'out_of_order' && (
                  <StatusBadge tone="danger">{t('outOfOrder')}</StatusBadge>
                )}
              </div>
              {canWrite && (
                <div className="flex flex-wrap gap-1">
                  {HOUSEKEEPING_TRANSITIONS[r.housekeepingState].map((to) => (
                    <Button
                      key={to}
                      variant="ghost"
                      className="min-h-8 px-2"
                      busy={change.isPending && change.variables?.roomId === r.id}
                      onClick={() => change.mutate({ roomId: r.id, state: to })}
                    >
                      {t('markAs', { state: t(`states.${to}`).toLowerCase() })}
                    </Button>
                  ))}
                  {r.housekeepingState === 'clean' && (
                    <Button variant="ghost" className="min-h-8 px-2" onClick={() => inspect.mutate(r.id)}>
                      {t('requestInspection')}
                    </Button>
                  )}
                </div>
              )}
            </li>
          ))}
      </ul>
    </>
  );
}
