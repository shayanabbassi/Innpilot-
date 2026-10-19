'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { updatePropertyRequest, type PropertyDto } from '@innpilot/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useFormatter, useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import type { z } from 'zod';
import {
  Alert,
  ApiErrorAlert,
  Button,
  Card,
  PageError,
  PageHeader,
  PageSkeleton,
  PermissionDenied,
  SelectField,
  TextField,
} from '@/components/ui';
import { api } from '@/lib/api';
import { applyServerErrors } from '@/lib/forms';
import { ME_QUERY_KEY, useSession } from '@/lib/session';

type FormValues = z.input<typeof updatePropertyRequest>;
const FIELDS = [
  'name',
  'legalName',
  'addressLine',
  'city',
  'phone',
  'email',
  'timezone',
  'checkInTime',
  'checkOutTime',
] as const;
const TIME_ZONES = Intl.supportedValuesOf('timeZone');

function toForm(p: PropertyDto): FormValues {
  return {
    name: p.name,
    legalName: p.legalName ?? '',
    addressLine: p.addressLine ?? '',
    city: p.city ?? '',
    phone: p.phone ?? '',
    email: p.email ?? '',
    timezone: p.timezone,
    checkInTime: p.checkInTime,
    checkOutTime: p.checkOutTime,
  };
}

export default function PropertySettingsPage() {
  const t = useTranslations('property');
  const session = useSession();
  const propertyId = session.property?.id;
  const allowed = session.can('property.read');
  const property = useQuery({
    queryKey: ['property', propertyId],
    queryFn: () => api.get<PropertyDto>(`/properties/${propertyId}`),
    enabled: allowed && !!propertyId,
  });

  if (!allowed || !propertyId) return <PermissionDenied />;
  return (
    <>
      <PageHeader title={t('title')} subtitle={t('subtitle')} />
      {property.isPending ? (
        <PageSkeleton />
      ) : property.isError ? (
        <PageError error={property.error} onRetry={() => void property.refetch()} />
      ) : (
        <PropertyForm
          key={property.data.id}
          property={property.data}
          canEdit={session.can('property.manage')}
        />
      )}
    </>
  );
}

function PropertyForm({ property, canEdit }: { property: PropertyDto; canEdit: boolean }) {
  const t = useTranslations('property');
  const tCommon = useTranslations('common');
  const format = useFormatter();
  const queryClient = useQueryClient();
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);
  const form = useForm<FormValues>({
    resolver: zodResolver(updatePropertyRequest),
    defaultValues: toForm(property),
  });
  const { errors, isDirty, isSubmitting, dirtyFields } = form.formState;

  useEffect(() => {
    if (isDirty) setSaved(false);
  }, [isDirty]);

  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);
    // Send only what changed, so the audit log records exactly the edit made.
    const changed = Object.fromEntries(
      Object.entries(values).filter(([k]) => dirtyFields[k as keyof FormValues]),
    );
    try {
      const updated = await api.patch<PropertyDto>(`/properties/${property.id}`, changed);
      queryClient.setQueryData(['property', property.id], updated);
      await queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY });
      form.reset(toForm(updated));
      setSaved(true);
    } catch (err) {
      if (!applyServerErrors(err, form.setError, FIELDS)) setError(err);
    }
  });

  const field = (name: (typeof FIELDS)[number], extra: Record<string, unknown> = {}) => ({
    label: t(name),
    disabled: !canEdit,
    error: errors[name]?.message,
    ...extra,
    ...form.register(name),
  });

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
      {!canEdit && <Alert tone="info">{t('readOnly')}</Alert>}
      {error !== null && <ApiErrorAlert error={error} />}
      {saved && <Alert tone="success">{tCommon('saved')}</Alert>}
      <Card>
        <div className="grid gap-4 md:grid-cols-2">
          <TextField {...field('name')} />
          <TextField {...field('legalName')} />
          <TextField {...field('addressLine')} className="md:col-span-2" />
          <TextField {...field('city')} />
          <TextField {...field('phone', { type: 'tel' })} />
          <TextField {...field('email', { type: 'email' })} />
        </div>
      </Card>
      <Card>
        <div className="grid gap-4 md:grid-cols-2">
          <SelectField {...field('timezone')}>
            {TIME_ZONES.map((tz) => (
              <option key={tz} value={tz}>
                {tz}
              </option>
            ))}
          </SelectField>
          <div className="hidden md:block" />
          <TextField {...field('checkInTime', { type: 'time' })} />
          <TextField {...field('checkOutTime', { type: 'time' })} />
          <TextField
            label={t('currency')}
            value={property.currencyCode}
            disabled
            hint={t('currencyNote')}
            readOnly
          />
          <TextField
            label={t('businessDate')}
            value={format.dateTime(new Date(`${property.businessDate}T00:00:00Z`), {
              dateStyle: 'medium',
              timeZone: 'UTC',
            })}
            disabled
            readOnly
            hint={t('businessDateNote')}
          />
        </div>
      </Card>
      {canEdit && (
        <div className="flex justify-end">
          <Button type="submit" disabled={!isDirty} busy={isSubmitting}>
            {isSubmitting ? tCommon('saving') : tCommon('save')}
          </Button>
        </div>
      )}
    </form>
  );
}
