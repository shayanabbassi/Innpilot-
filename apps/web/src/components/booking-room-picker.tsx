'use client';

import { addDays, nightsBetween, type AvailabilityDto } from '@innpilot/contracts';
import { Money } from '@innpilot/money';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { api } from '@/lib/api';
import { formatRate } from './rooms-setup';
import { SelectField, StatusBadge, TextField } from './ui';

export interface RoomChoice {
  arrival: string;
  departure: string;
  adults: number;
  children: number;
  roomTypeId: string;
  roomId: string | null;
  overrideRate: boolean;
  nightlyRate: string;
  rateOverrideReason: string;
}

/** Turns the picker state into the API's reservation room input. */
export function toRoomInput(c: RoomChoice) {
  return {
    roomTypeId: c.roomTypeId,
    roomId: c.roomId,
    arrival: c.arrival,
    departure: c.departure,
    adults: c.adults,
    children: c.children,
    ...(c.overrideRate ? { nightlyRate: c.nightlyRate, rateOverrideReason: c.rateOverrideReason } : {}),
  };
}

/**
 * Dates, guests, room type (with live availability) and optional room. Availability is advisory; the server
 * re-checks it when the booking is saved.
 */
export function BookingRoomPicker({
  propertyId,
  minDate,
  value,
  onChange,
  canOverrideRate,
  errors = {},
}: {
  propertyId: string;
  minDate: string;
  value: RoomChoice;
  onChange: (v: RoomChoice) => void;
  canOverrideRate: boolean;
  errors?: Record<string, string>;
}) {
  const t = useTranslations('reservations');
  const nights = value.arrival && value.departure ? nightsBetween(value.arrival, value.departure) : 0;
  const validRange = nights >= 1 && nights <= 60;
  const availability = useQuery({
    queryKey: ['availability', propertyId, value.arrival, value.departure],
    queryFn: () =>
      api.get<AvailabilityDto>(
        `/properties/${propertyId}/availability?arrival=${value.arrival}&departure=${value.departure}`,
      ),
    enabled: validRange,
    placeholderData: keepPreviousData,
  });
  const set = (patch: Partial<RoomChoice>) => onChange({ ...value, ...patch });
  const selected = availability.data?.roomTypes.find((x) => x.roomTypeId === value.roomTypeId);
  const rate = value.overrideRate ? value.nightlyRate : selected?.nightlyRate;
  let total: string | null = null;
  try {
    total =
      rate && validRange
        ? Money.of(rate, selected?.currencyCode ?? 'PKR')
            .multiply(String(nights))
            .toString()
        : null;
  } catch {
    total = null;
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-4">
        <TextField
          label={t('arrival')}
          type="date"
          min={minDate}
          value={value.arrival}
          error={errors.arrival}
          onChange={(e) => {
            const arrival = e.target.value;
            const departure =
              value.departure && value.departure > arrival ? value.departure : addDays(arrival, 1);
            set({ arrival, departure, roomId: null });
          }}
        />
        <TextField
          label={t('departure')}
          type="date"
          min={value.arrival ? addDays(value.arrival, 1) : minDate}
          value={value.departure}
          error={errors.departure}
          hint={validRange ? t('nights', { count: nights }) : undefined}
          onChange={(e) => set({ departure: e.target.value, roomId: null })}
        />
        <TextField
          label={t('adults')}
          type="number"
          min={1}
          max={20}
          value={String(value.adults)}
          error={errors.adults}
          onChange={(e) => set({ adults: Number(e.target.value) || 1 })}
        />
        <TextField
          label={t('children')}
          type="number"
          min={0}
          max={20}
          value={String(value.children)}
          onChange={(e) => set({ children: Number(e.target.value) || 0 })}
        />
      </div>

      <fieldset>
        <legend className="mb-2 text-sm font-medium text-ink">{t('roomType')}</legend>
        {errors.roomTypeId && <p className="mb-2 text-xs text-danger">{errors.roomTypeId}</p>}
        <ul className="grid gap-2 sm:grid-cols-2" aria-busy={availability.isFetching || undefined}>
          {(availability.data?.roomTypes ?? []).map((rt) => {
            const fits = value.adults <= rt.capacityAdults && value.children <= rt.capacityChildren;
            const disabled = rt.available === 0 || !fits || !rt.nightlyRate;
            return (
              <li key={rt.roomTypeId}>
                <label
                  className={`flex cursor-pointer items-center justify-between gap-2 rounded-md border p-3 text-sm ${
                    value.roomTypeId === rt.roomTypeId ? 'border-teal-600 bg-teal-50' : 'border-line bg-white'
                  } ${disabled ? 'cursor-not-allowed opacity-60' : ''}`}
                >
                  <span className="flex items-center gap-2">
                    <input
                      type="radio"
                      name="roomType"
                      disabled={disabled}
                      checked={value.roomTypeId === rt.roomTypeId}
                      onChange={() => set({ roomTypeId: rt.roomTypeId, roomId: null })}
                    />
                    <span>
                      <span className="font-medium text-ink">{rt.code}</span> {rt.name}
                    </span>
                  </span>
                  <span className="flex flex-col items-end gap-1">
                    <span className="tabular font-medium">
                      {rt.nightlyRate ? formatRate(rt.nightlyRate, rt.currencyCode) : t('noRate')}
                    </span>
                    <StatusBadge tone={rt.available > 0 ? 'success' : 'danger'}>
                      {rt.available > 0 ? t('available', { count: rt.available }) : t('soldOut')}
                    </StatusBadge>
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      </fieldset>

      {selected && (
        <SelectField
          label={t('specificRoom')}
          value={value.roomId ?? ''}
          error={errors.roomId}
          onChange={(e) => set({ roomId: e.target.value || null })}
        >
          <option value="">{t('anyRoom')}</option>
          {selected.freeRooms.map((r) => (
            <option key={r.id} value={r.id}>
              {r.roomNumber}
            </option>
          ))}
        </SelectField>
      )}

      {canOverrideRate && selected && (
        <div className="flex flex-col gap-3">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="h-4 w-4"
              checked={value.overrideRate}
              onChange={(e) =>
                set({ overrideRate: e.target.checked, nightlyRate: selected.nightlyRate ?? '' })
              }
            />
            {t('overrideRate')}
          </label>
          {value.overrideRate && (
            <div className="grid gap-3 sm:grid-cols-2">
              <TextField
                label={t('rate')}
                inputMode="decimal"
                className="tabular"
                value={value.nightlyRate}
                error={errors.nightlyRate}
                onChange={(e) => set({ nightlyRate: e.target.value })}
              />
              <TextField
                label={t('overrideReason')}
                value={value.rateOverrideReason}
                error={errors.rateOverrideReason}
                onChange={(e) => set({ rateOverrideReason: e.target.value })}
              />
            </div>
          )}
        </div>
      )}

      {total && selected && (
        <p className="flex justify-between rounded-md bg-canvas px-3 py-2 text-sm">
          <span className="text-muted">{t('total')}</span>
          <span className="tabular font-semibold text-ink">{formatRate(total, selected.currencyCode)}</span>
        </p>
      )}
    </div>
  );
}
