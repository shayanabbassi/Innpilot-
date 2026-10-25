'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import {
  bulkCreateRoomsRequest,
  createRateRequest,
  createRoomRequest,
  createRoomTypeRequest,
  expandRoomRange,
  updateRoomTypeRequest,
  type RoomDto,
  type RoomTypeDto,
  type RoomTypeRateDto,
} from '@innpilot/contracts';
import { Money } from '@innpilot/money';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useFormatter, useTranslations } from 'next-intl';
import { useState } from 'react';
import { useForm, type Resolver } from 'react-hook-form';
import type { z } from 'zod';
import { api } from '@/lib/api';
import { applyServerErrors } from '@/lib/forms';
import { useSession } from '@/lib/session';
import {
  ApiErrorAlert,
  Button,
  Card,
  Dialog,
  EmptyState,
  PageError,
  PageSkeleton,
  SelectField,
  StatusBadge,
  TextField,
} from './ui';

export const roomTypesKey = (propertyId: string) => ['room-types', propertyId] as const;
export const roomsKey = (propertyId: string) => ['rooms', propertyId] as const;

export function useRoomData(propertyId: string) {
  const types = useQuery({
    queryKey: roomTypesKey(propertyId),
    queryFn: () => api.get<RoomTypeDto[]>(`/properties/${propertyId}/room-types`),
  });
  const rooms = useQuery({
    queryKey: roomsKey(propertyId),
    queryFn: () => api.get<RoomDto[]>(`/properties/${propertyId}/rooms`),
  });
  return { types, rooms };
}

export function formatRate(amount: string, currency: string): string {
  return Money.of(amount, currency).format('en-PK');
}

/** Room types, rates and rooms for one property. Used in settings and in the setup wizard. */
export function RoomsSetup({ propertyId, canManage }: { propertyId: string; canManage: boolean }) {
  const t = useTranslations('rooms');
  const { types, rooms } = useRoomData(propertyId);
  const [dialog, setDialog] = useState<
    | { kind: 'addType' }
    | { kind: 'editType'; type: RoomTypeDto }
    | { kind: 'rates'; type: RoomTypeDto }
    | { kind: 'addRooms' }
    | null
  >(null);

  if (types.isPending || rooms.isPending) return <PageSkeleton />;
  if (types.isError) return <PageError error={types.error} onRetry={() => void types.refetch()} />;
  if (rooms.isError) return <PageError error={rooms.error} onRetry={() => void rooms.refetch()} />;
  const activeTypes = types.data.filter((x) => x.active);

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-semibold text-navy-800">{t('types')}</h2>
          {canManage && <Button onClick={() => setDialog({ kind: 'addType' })}>{t('addType')}</Button>}
        </div>
        {types.data.length === 0 ? (
          <EmptyState message={t('noTypes')} />
        ) : (
          <ul className="divide-y divide-line">
            {types.data.map((type) => (
              <RoomTypeRow
                key={type.id}
                type={type}
                canManage={canManage}
                onEdit={() => setDialog({ kind: 'editType', type })}
                onRates={() => setDialog({ kind: 'rates', type })}
              />
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-semibold text-navy-800">{t('roomsHeading')}</h2>
          {canManage && (
            <Button disabled={activeTypes.length === 0} onClick={() => setDialog({ kind: 'addRooms' })}>
              {t('addRooms')}
            </Button>
          )}
        </div>
        <RoomList propertyId={propertyId} types={types.data} rooms={rooms.data} canManage={canManage} />
      </Card>

      {dialog?.kind === 'addType' && (
        <RoomTypeDialog propertyId={propertyId} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === 'editType' && (
        <RoomTypeDialog propertyId={propertyId} type={dialog.type} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === 'rates' && (
        <RatesDialog
          propertyId={propertyId}
          type={dialog.type}
          canManage={canManage}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'addRooms' && (
        <AddRoomsDialog propertyId={propertyId} types={activeTypes} onClose={() => setDialog(null)} />
      )}
    </div>
  );
}

function RoomTypeRow({
  type,
  canManage,
  onEdit,
  onRates,
}: {
  type: RoomTypeDto;
  canManage: boolean;
  onEdit: () => void;
  onRates: () => void;
}) {
  const t = useTranslations('rooms');
  return (
    <li className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <p className="font-medium text-ink">
          <span className="mr-2 rounded bg-navy-50 px-1.5 py-0.5 text-xs font-semibold text-navy-800">
            {type.code}
          </span>
          {type.name} {!type.active && <StatusBadge tone="neutral">{t('inactive')}</StatusBadge>}
        </p>
        <p className="mt-1 text-sm text-muted">
          {t('capacityValue', { adults: type.capacityAdults, children: type.capacityChildren })} ·{' '}
          {t('roomCount')}: {type.roomCount}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="tabular text-right text-sm font-medium text-ink">
          {type.currentRate ? (
            formatRate(type.currentRate.nightlyRate, type.currentRate.currencyCode)
          ) : (
            <StatusBadge tone="warning">{t('noRate')}</StatusBadge>
          )}
        </span>
        <Button variant="ghost" className="min-h-8 px-2" onClick={onRates}>
          {t('rates')}
        </Button>
        {canManage && (
          <Button variant="ghost" className="min-h-8 px-2" onClick={onEdit}>
            {t('edit')}
          </Button>
        )}
      </div>
    </li>
  );
}

function useInvalidateRooms(propertyId: string) {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: roomTypesKey(propertyId) }),
      queryClient.invalidateQueries({ queryKey: roomsKey(propertyId) }),
      queryClient.invalidateQueries({ queryKey: ['room-board', propertyId] }),
    ]);
}

type TypeForm = z.input<typeof createRoomTypeRequest> & { active?: boolean };

function RoomTypeDialog({
  propertyId,
  type,
  onClose,
}: {
  propertyId: string;
  type?: RoomTypeDto;
  onClose: () => void;
}) {
  const t = useTranslations('rooms');
  const tCommon = useTranslations('common');
  const invalidate = useInvalidateRooms(propertyId);
  const [error, setError] = useState<unknown>(null);
  const form = useForm<TypeForm>({
    // One dialog for create and edit; each validates with its own contract schema.
    resolver: (type
      ? zodResolver(updateRoomTypeRequest)
      : zodResolver(createRoomTypeRequest)) as unknown as Resolver<TypeForm>,
    defaultValues: type
      ? {
          name: type.name,
          description: type.description ?? '',
          capacityAdults: type.capacityAdults,
          capacityChildren: type.capacityChildren,
          active: type.active,
        }
      : { code: '', name: '', description: '', capacityAdults: 2, capacityChildren: 0, nightlyRate: '' },
  });
  const { errors, isSubmitting } = form.formState;

  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);
    try {
      if (type) {
        await api.patch(`/properties/${propertyId}/room-types/${type.id}`, values);
      } else {
        await api.post(`/properties/${propertyId}/room-types`, values);
      }
      await invalidate();
      onClose();
    } catch (err) {
      if (
        !applyServerErrors(err, form.setError, [
          'code',
          'name',
          'description',
          'capacityAdults',
          'capacityChildren',
          'nightlyRate',
        ])
      ) {
        setError(err);
      }
    }
  });

  return (
    <Dialog open onClose={onClose} title={type ? t('editType', { name: type.name }) : t('addType')}>
      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
        {error !== null && <ApiErrorAlert error={error} />}
        {!type && (
          <TextField
            label={t('code')}
            hint={t('codeHint')}
            error={errors.code?.message}
            {...form.register('code')}
          />
        )}
        <TextField label={t('name')} error={errors.name?.message} {...form.register('name')} />
        <div className="grid grid-cols-2 gap-4">
          <TextField
            label={t('adults')}
            type="number"
            min={1}
            max={20}
            error={errors.capacityAdults?.message}
            {...form.register('capacityAdults')}
          />
          <TextField
            label={t('children')}
            type="number"
            min={0}
            max={20}
            error={errors.capacityChildren?.message}
            {...form.register('capacityChildren')}
          />
        </div>
        {!type && (
          <TextField
            label={t('firstRate')}
            inputMode="decimal"
            className="tabular"
            hint={t('rateHint')}
            error={errors.nightlyRate?.message}
            {...form.register('nightlyRate', { setValueAs: (v: string) => v.trim() || undefined })}
          />
        )}
        {type && (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" className="h-4 w-4" {...form.register('active')} />
            {t('active')}
          </label>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            {tCommon('cancel')}
          </Button>
          <Button type="submit" busy={isSubmitting}>
            {type ? t('save') : t('add')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function RatesDialog({
  propertyId,
  type,
  canManage,
  onClose,
}: {
  propertyId: string;
  type: RoomTypeDto;
  canManage: boolean;
  onClose: () => void;
}) {
  const t = useTranslations('rooms');
  const tCommon = useTranslations('common');
  const format = useFormatter();
  const invalidate = useInvalidateRooms(propertyId);
  const ratesKey = ['rates', type.id] as const;
  const queryClient = useQueryClient();
  const rates = useQuery({
    queryKey: ratesKey,
    queryFn: () => api.get<RoomTypeRateDto[]>(`/properties/${propertyId}/room-types/${type.id}/rates`),
  });
  const [error, setError] = useState<unknown>(null);
  const form = useForm<z.input<typeof createRateRequest>>({
    resolver: zodResolver(createRateRequest),
    defaultValues: { nightlyRate: '' },
  });
  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ratesKey });
    await invalidate();
  };
  const remove = useMutation({
    mutationFn: (rateId: string) =>
      api.del(`/properties/${propertyId}/room-types/${type.id}/rates/${rateId}`),
    onSuccess: refresh,
  });

  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);
    try {
      await api.post(`/properties/${propertyId}/room-types/${type.id}/rates`, {
        nightlyRate: values.nightlyRate,
        ...(values.effectiveFrom ? { effectiveFrom: values.effectiveFrom } : {}),
      });
      form.reset({ nightlyRate: '', effectiveFrom: '' });
      await refresh();
    } catch (err) {
      if (!applyServerErrors(err, form.setError, ['nightlyRate', 'effectiveFrom'])) setError(err);
    }
  });

  const currentId = type.currentRate?.id;
  const businessDate = useSession().property?.businessDate ?? '';
  const dateLabel = (d: string) =>
    format.dateTime(new Date(`${d}T00:00:00Z`), { dateStyle: 'medium', timeZone: 'UTC' });

  return (
    <Dialog open onClose={onClose} title={t('ratesTitle', { name: type.name })}>
      <p className="mb-4 text-sm text-muted">{t('ratesIntro')}</p>
      {rates.isPending ? (
        <PageSkeleton />
      ) : rates.isError ? (
        <ApiErrorAlert error={rates.error} />
      ) : rates.data.length === 0 ? (
        <EmptyState message={t('noRate')} />
      ) : (
        <ul className="mb-4 divide-y divide-line text-sm">
          {rates.data.map((r) => {
            const status =
              r.id === currentId ? 'current' : r.effectiveFrom > businessDate ? 'scheduled' : 'past';
            return (
              <li key={r.id} className="flex items-center justify-between gap-2 py-2">
                <span>
                  {t('effectiveFrom')} {dateLabel(r.effectiveFrom)}{' '}
                  <StatusBadge tone={status === 'current' ? 'success' : 'neutral'}>{t(status)}</StatusBadge>
                </span>
                <span className="flex items-center gap-2">
                  <span className="tabular font-medium">{formatRate(r.nightlyRate, r.currencyCode)}</span>
                  {canManage && status === 'scheduled' && (
                    <Button
                      variant="ghost"
                      className="min-h-8 px-2"
                      busy={remove.isPending && remove.variables === r.id}
                      onClick={() => remove.mutate(r.id)}
                    >
                      {t('remove')}
                    </Button>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {remove.isError && <ApiErrorAlert error={remove.error} />}
      {canManage && (
        <form onSubmit={onSubmit} noValidate className="flex flex-col gap-3 border-t border-line pt-4">
          {error !== null && <ApiErrorAlert error={error} />}
          <div className="grid gap-3 sm:grid-cols-2">
            <TextField
              label={t('firstRate')}
              inputMode="decimal"
              className="tabular"
              error={form.formState.errors.nightlyRate?.message}
              {...form.register('nightlyRate')}
            />
            <TextField
              label={t('effectiveFrom')}
              type="date"
              error={form.formState.errors.effectiveFrom?.message}
              {...form.register('effectiveFrom', { setValueAs: (v: string) => v || undefined })}
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={onClose}>
              {tCommon('close')}
            </Button>
            <Button type="submit" busy={form.formState.isSubmitting}>
              {t('addRate')}
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

type AddRoomsForm = {
  mode: 'single' | 'range';
  roomNumber: string;
  from: string;
  to: string;
  prefix: string;
  floor: string;
  roomTypeId: string;
};

function AddRoomsDialog({
  propertyId,
  types,
  onClose,
}: {
  propertyId: string;
  types: RoomTypeDto[];
  onClose: () => void;
}) {
  const t = useTranslations('rooms');
  const tCommon = useTranslations('common');
  const invalidate = useInvalidateRooms(propertyId);
  const [error, setError] = useState<unknown>(null);
  const form = useForm<AddRoomsForm>({
    defaultValues: {
      mode: 'range',
      roomNumber: '',
      from: '',
      to: '',
      prefix: '',
      floor: '',
      roomTypeId: types[0]?.id ?? '',
    },
  });
  const v = form.watch();
  const { errors, isSubmitting } = form.formState;

  const rangeBody = {
    from: v.from,
    to: v.to,
    roomTypeId: v.roomTypeId,
    ...(v.prefix ? { prefix: v.prefix } : {}),
    ...(v.floor ? { floor: v.floor } : {}),
  };
  const rangeCheck = v.mode === 'range' ? bulkCreateRoomsRequest.safeParse(rangeBody) : null;
  const preview = rangeCheck?.success ? expandRoomRange(rangeCheck.data) : [];

  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);
    form.clearErrors();
    const schema = values.mode === 'single' ? createRoomRequest : bulkCreateRoomsRequest;
    const body =
      values.mode === 'single'
        ? {
            roomNumber: values.roomNumber,
            roomTypeId: values.roomTypeId,
            ...(values.floor ? { floor: values.floor } : {}),
          }
        : rangeBody;
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        form.setError(String(issue.path[0]) as keyof AddRoomsForm, { message: issue.message });
      }
      return;
    }
    try {
      await api.post(`/properties/${propertyId}/rooms${values.mode === 'range' ? '/bulk' : ''}`, parsed.data);
      await invalidate();
      onClose();
    } catch (err) {
      if (
        !applyServerErrors(err, form.setError, ['roomNumber', 'from', 'to', 'prefix', 'floor', 'roomTypeId'])
      )
        setError(err);
    }
  });

  return (
    <Dialog open onClose={onClose} title={t('addRooms')}>
      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
        {error !== null && <ApiErrorAlert error={error} />}
        <fieldset className="flex gap-4 text-sm">
          <legend className="mb-1 text-sm font-medium text-ink">{t('mode')}</legend>
          <label className="flex items-center gap-2">
            <input type="radio" value="range" {...form.register('mode')} /> {t('range')}
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" value="single" {...form.register('mode')} /> {t('single')}
          </label>
        </fieldset>
        <SelectField
          label={t('roomType')}
          error={errors.roomTypeId?.message}
          {...form.register('roomTypeId')}
        >
          {types.map((type) => (
            <option key={type.id} value={type.id}>
              {type.code} — {type.name}
            </option>
          ))}
        </SelectField>
        {v.mode === 'single' ? (
          <TextField
            label={t('roomNumber')}
            error={errors.roomNumber?.message}
            {...form.register('roomNumber')}
          />
        ) : (
          <div className="grid grid-cols-3 gap-3">
            <TextField label={t('prefix')} error={errors.prefix?.message} {...form.register('prefix')} />
            <TextField
              label={t('from')}
              inputMode="numeric"
              error={errors.from?.message}
              {...form.register('from')}
            />
            <TextField
              label={t('to')}
              inputMode="numeric"
              error={errors.to?.message}
              {...form.register('to')}
            />
          </div>
        )}
        <TextField label={t('floor')} error={errors.floor?.message} {...form.register('floor')} />
        {preview.length > 0 && (
          <p className="text-sm text-muted" aria-live="polite">
            {t('preview', {
              count: preview.length,
              list:
                preview.length > 8
                  ? `${preview.slice(0, 4).join(', ')} … ${preview.slice(-2).join(', ')}`
                  : preview.join(', '),
            })}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            {tCommon('cancel')}
          </Button>
          <Button type="submit" busy={isSubmitting}>
            {t('add')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function RoomList({
  propertyId,
  types,
  rooms,
  canManage,
}: {
  propertyId: string;
  types: RoomTypeDto[];
  rooms: RoomDto[];
  canManage: boolean;
}) {
  const t = useTranslations('rooms');
  const [editing, setEditing] = useState<RoomDto | null>(null);
  if (rooms.length === 0) return <EmptyState message={t('noRooms')} />;
  return (
    <div className="flex flex-col gap-4">
      {types
        .filter((type) => rooms.some((r) => r.roomTypeId === type.id))
        .map((type) => (
          <section key={type.id}>
            <h3 className="mb-2 text-sm font-medium text-muted">
              {type.code} — {type.name}
            </h3>
            <ul className="flex flex-wrap gap-2">
              {rooms
                .filter((r) => r.roomTypeId === type.id)
                .map((r) => (
                  <li key={r.id}>
                    <button
                      type="button"
                      disabled={!canManage}
                      onClick={() => setEditing(r)}
                      className={`tabular min-w-14 rounded-md border px-3 py-1.5 text-sm ${
                        r.active
                          ? 'border-line bg-white text-ink'
                          : 'border-dashed border-line bg-canvas text-muted line-through'
                      } ${canManage ? 'hover:border-teal-600' : 'cursor-default'}`}
                      aria-label={`${r.roomNumber}${r.active ? '' : ` (${t('inactive')})`}`}
                    >
                      {r.roomNumber}
                    </button>
                  </li>
                ))}
            </ul>
          </section>
        ))}
      {editing && (
        <EditRoomDialog
          propertyId={propertyId}
          room={editing}
          types={types}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function EditRoomDialog({
  propertyId,
  room,
  types,
  onClose,
}: {
  propertyId: string;
  room: RoomDto;
  types: RoomTypeDto[];
  onClose: () => void;
}) {
  const t = useTranslations('rooms');
  const tCommon = useTranslations('common');
  const invalidate = useInvalidateRooms(propertyId);
  const [error, setError] = useState<unknown>(null);
  const form = useForm({
    defaultValues: {
      roomNumber: room.roomNumber,
      floor: room.floor ?? '',
      roomTypeId: room.roomTypeId,
      active: room.active,
    },
  });
  const { errors, isSubmitting, dirtyFields } = form.formState;

  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);
    const changed = Object.fromEntries(
      Object.entries(values).filter(([k]) => dirtyFields[k as keyof typeof values]),
    );
    if (Object.keys(changed).length === 0) return onClose();
    try {
      await api.patch(`/properties/${propertyId}/rooms/${room.id}`, changed);
      await invalidate();
      onClose();
    } catch (err) {
      if (!applyServerErrors(err, form.setError, ['roomNumber', 'floor', 'roomTypeId'])) setError(err);
    }
  });

  return (
    <Dialog open onClose={onClose} title={t('editRoom', { number: room.roomNumber })}>
      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
        {error !== null && <ApiErrorAlert error={error} />}
        <TextField
          label={t('roomNumber')}
          error={errors.roomNumber?.message}
          {...form.register('roomNumber')}
        />
        <TextField label={t('floor')} error={errors.floor?.message} {...form.register('floor')} />
        <SelectField
          label={t('roomType')}
          error={errors.roomTypeId?.message}
          {...form.register('roomTypeId')}
        >
          {types
            .filter((type) => type.active || type.id === room.roomTypeId)
            .map((type) => (
              <option key={type.id} value={type.id}>
                {type.code} — {type.name}
              </option>
            ))}
        </SelectField>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" className="h-4 w-4" {...form.register('active')} />
          {t('active')}
        </label>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            {tCommon('cancel')}
          </Button>
          <Button type="submit" busy={isSubmitting}>
            {t('save')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
