'use client';

import { TICKET_CATEGORIES, TICKET_PRIORITIES, type RoomDto, type TicketDto } from '@innpilot/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useFormatter, useTranslations } from 'next-intl';
import Link from 'next/link';
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
  SelectField,
  StatusBadge,
  TextField,
} from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { useSession } from '@/lib/session';

const PRIORITY_TONE = { low: 'neutral', normal: 'neutral', high: 'warning', urgent: 'danger' } as const;

export default function MaintenancePage() {
  const t = useTranslations('maintenance');
  const format = useFormatter();
  const { property, can } = useSession();
  const queryClient = useQueryClient();
  const allowed = !!property && can('housekeeping.read');
  const [status, setStatus] = useState<'active' | 'resolved'>('active');
  const [reporting, setReporting] = useState(false);
  const [resolving, setResolving] = useState<TicketDto | null>(null);
  const propertyId = property?.id ?? '';
  const tickets = useQuery({
    queryKey: ['tickets', propertyId, status],
    queryFn: () => api.get<TicketDto[]>(`/properties/${propertyId}/maintenance/tickets?status=${status}`),
    enabled: allowed,
  });
  const start = useMutation({
    mutationFn: (id: string) =>
      api.post<TicketDto>(`/properties/${propertyId}/maintenance/tickets/${id}/start`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['tickets', propertyId] }),
  });

  if (!allowed) return <PermissionDenied />;
  const canWrite = can('housekeeping.write');
  const date = (d: string) =>
    format.dateTime(new Date(`${d}T00:00:00Z`), { dateStyle: 'medium', timeZone: 'UTC' });

  return (
    <>
      <PageHeader
        title={t('title')}
        subtitle={t('subtitle')}
        actions={canWrite && <Button onClick={() => setReporting(true)}>{t('report')}</Button>}
      />
      <div role="tablist" className="mb-4 inline-flex rounded-md border border-line bg-white p-0.5">
        {(['active', 'resolved'] as const).map((v) => (
          <button
            key={v}
            role="tab"
            aria-selected={status === v}
            onClick={() => setStatus(v)}
            className={`rounded px-3 py-1.5 text-sm ${status === v ? 'bg-navy-800 text-white' : 'text-ink'}`}
          >
            {t(v)}
          </button>
        ))}
      </div>
      {start.isError && (
        <div className="mb-3">
          <ApiErrorAlert error={start.error} />
        </div>
      )}
      {tickets.isPending ? (
        <PageSkeleton />
      ) : tickets.isError ? (
        <PageError error={tickets.error} onRetry={() => void tickets.refetch()} />
      ) : tickets.data.length === 0 ? (
        <EmptyState message={status === 'active' ? t('none') : t('noneResolved')} />
      ) : (
        <ul className="divide-y divide-line rounded-lg border border-line bg-white">
          {tickets.data.map((tk) => (
            <li
              key={tk.id}
              className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-start sm:justify-between"
            >
              <div className="min-w-0 text-sm">
                <p className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold text-ink">{tk.roomNumber ?? t('noRoom')}</span>
                  <StatusBadge tone={PRIORITY_TONE[tk.priority]}>
                    {t(`priorities.${tk.priority}`)}
                  </StatusBadge>
                  <StatusBadge tone="neutral">{t(`categories.${tk.category}`)}</StatusBadge>
                  <StatusBadge tone={tk.status === 'resolved' ? 'success' : 'neutral'}>
                    {t(`statuses.${tk.status}`)}
                  </StatusBadge>
                </p>
                <p className="mt-1 text-ink">{tk.description}</p>
                {tk.outOfOrderFrom && (
                  <p className="mt-1 text-danger">
                    {t('oooPeriod', {
                      from: date(tk.outOfOrderFrom),
                      to: tk.outOfOrderTo ? date(tk.outOfOrderTo) : t('untilResolved'),
                    })}
                  </p>
                )}
                {tk.unassignedBookings.length > 0 && (
                  <p className="mt-1 text-warning">
                    {t('unassigned')}
                    {tk.unassignedBookings.map((b, i) => (
                      <span key={b.reservationId}>
                        {i > 0 && ', '}
                        <Link href={`/reservations/${b.reservationId}`} className="underline">
                          {b.bookingReference}
                        </Link>
                      </span>
                    ))}
                  </p>
                )}
                {tk.resolutionNote && <p className="mt-1 text-muted">{tk.resolutionNote}</p>}
                <p className="mt-1 text-xs text-muted">
                  {tk.reportedByName && `${t('reportedBy', { name: tk.reportedByName })} · `}
                  {format.dateTime(new Date(tk.createdAt), { dateStyle: 'medium', timeStyle: 'short' })}
                </p>
              </div>
              {canWrite && (tk.status === 'open' || tk.status === 'in_progress') && (
                <div className="flex shrink-0 gap-2">
                  {tk.status === 'open' && (
                    <Button
                      variant="secondary"
                      busy={start.isPending && start.variables === tk.id}
                      onClick={() => start.mutate(tk.id)}
                    >
                      {t('startWork')}
                    </Button>
                  )}
                  {(!tk.outOfOrderFrom || can('room.out_of_order')) && (
                    <Button onClick={() => setResolving(tk)}>{t('resolve')}</Button>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {reporting && (
        <ReportDialog
          propertyId={propertyId}
          businessDate={property.businessDate}
          onClose={() => setReporting(false)}
        />
      )}
      {resolving && (
        <ResolveDialog propertyId={propertyId} ticket={resolving} onClose={() => setResolving(null)} />
      )}
    </>
  );
}

function useInvalidate(propertyId: string) {
  const queryClient = useQueryClient();
  return () =>
    Promise.all(
      [
        ['tickets', propertyId],
        ['room-board', propertyId],
        ['availability'],
        ['reservations'],
        ['front-desk'],
      ].map((queryKey) => queryClient.invalidateQueries({ queryKey })),
    );
}

function ReportDialog({
  propertyId,
  businessDate,
  onClose,
}: {
  propertyId: string;
  businessDate: string;
  onClose: () => void;
}) {
  const t = useTranslations('maintenance');
  const { can } = useSession();
  const invalidate = useInvalidate(propertyId);
  const rooms = useQuery({
    queryKey: ['rooms', propertyId],
    queryFn: () => api.get<RoomDto[]>(`/properties/${propertyId}/rooms`),
  });
  const [roomId, setRoomId] = useState('');
  const [category, setCategory] = useState<(typeof TICKET_CATEGORIES)[number]>('other');
  const [priority, setPriority] = useState<(typeof TICKET_PRIORITIES)[number]>('normal');
  const [description, setDescription] = useState('');
  const [ooo, setOoo] = useState(false);
  const [from, setFrom] = useState(businessDate);
  const [to, setTo] = useState('');
  const [overrideReason, setOverrideReason] = useState('');
  const [needsOverride, setNeedsOverride] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const submit = async () => {
    setError(null);
    setBusy(true);
    try {
      await api.post<TicketDto>(`/properties/${propertyId}/maintenance/tickets`, {
        ...(roomId ? { roomId } : {}),
        category,
        priority,
        description,
        ...(ooo && roomId
          ? {
              outOfOrder: {
                from,
                ...(to ? { to } : {}),
                ...(overrideReason.trim() ? { overrideReason: overrideReason.trim() } : {}),
              },
            }
          : {}),
      });
      await invalidate();
      onClose();
    } catch (err) {
      setBusy(false);
      setError(err);
      if (err instanceof ApiError && err.details.some((d) => d.path === 'outOfOrder.overrideReason'))
        setNeedsOverride(true);
    }
  };

  return (
    <Dialog open onClose={onClose} title={t('report')}>
      <div className="flex flex-col gap-4">
        {error !== null && <ApiErrorAlert error={error} />}
        <SelectField label={t('room')} value={roomId} onChange={(e) => setRoomId(e.target.value)}>
          <option value="">{t('noRoom')}</option>
          {(rooms.data ?? [])
            .filter((r) => r.active)
            .map((r) => (
              <option key={r.id} value={r.id}>
                {r.roomNumber}
              </option>
            ))}
        </SelectField>
        <div className="grid grid-cols-2 gap-3">
          <SelectField
            label={t('category')}
            value={category}
            onChange={(e) => setCategory(e.target.value as typeof category)}
          >
            {TICKET_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {t(`categories.${c}`)}
              </option>
            ))}
          </SelectField>
          <SelectField
            label={t('priority')}
            value={priority}
            onChange={(e) => setPriority(e.target.value as typeof priority)}
          >
            {TICKET_PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {t(`priorities.${p}`)}
              </option>
            ))}
          </SelectField>
        </div>
        <TextField
          label={t('description')}
          value={description}
          maxLength={1000}
          onChange={(e) => setDescription(e.target.value)}
        />
        {roomId && can('room.out_of_order') && (
          <div className="flex flex-col gap-3 rounded-md border border-line p-3">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="h-4 w-4"
                checked={ooo}
                onChange={(e) => setOoo(e.target.checked)}
              />
              {t('takeOut')}
            </label>
            {ooo && (
              <div className="grid gap-3 sm:grid-cols-2">
                <TextField
                  label={t('from')}
                  type="date"
                  min={businessDate}
                  value={from}
                  onChange={(e) => setFrom(e.target.value)}
                />
                <TextField
                  label={t('to')}
                  type="date"
                  min={from}
                  value={to}
                  hint={t('toHint')}
                  onChange={(e) => setTo(e.target.value)}
                />
                {needsOverride && (
                  <TextField
                    label={t('overrideReason')}
                    className="sm:col-span-2"
                    value={overrideReason}
                    maxLength={300}
                    onChange={(e) => setOverrideReason(e.target.value)}
                  />
                )}
              </div>
            )}
          </div>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button busy={busy} disabled={description.trim().length < 3} onClick={() => void submit()}>
            {t('submit')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function ResolveDialog({
  propertyId,
  ticket,
  onClose,
}: {
  propertyId: string;
  ticket: TicketDto;
  onClose: () => void;
}) {
  const t = useTranslations('maintenance');
  const invalidate = useInvalidate(propertyId);
  const [note, setNote] = useState('');
  const run = useMutation({
    mutationFn: () =>
      api.post<TicketDto>(`/properties/${propertyId}/maintenance/tickets/${ticket.id}/resolve`, { note }),
    onSuccess: async () => {
      await invalidate();
      onClose();
    },
  });
  return (
    <Dialog open onClose={onClose} title={t('resolveTitle')}>
      <div className="flex flex-col gap-4">
        <p className="text-sm text-muted">{ticket.description}</p>
        {run.isError && <ApiErrorAlert error={run.error} />}
        <TextField
          label={t('resolveNote')}
          value={note}
          maxLength={1000}
          onChange={(e) => setNote(e.target.value)}
        />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button busy={run.isPending} disabled={note.trim().length < 3} onClick={() => run.mutate()}>
            {t('resolve')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
