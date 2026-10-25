'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import {
  createGuestRequest,
  DOCUMENT_TYPES,
  type DuplicateCandidateDto,
  type GuestDto,
} from '@innpilot/contracts';
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useForm, type Resolver } from 'react-hook-form';
import type { z } from 'zod';
import { api } from '@/lib/api';
import { applyServerErrors } from '@/lib/forms';
import { Alert, ApiErrorAlert, Button, Card, SelectField, TextField } from './ui';

type FormValues = z.input<typeof createGuestRequest>;
const FIELDS = [
  'fullName',
  'phone',
  'email',
  'nationality',
  'addressLine',
  'city',
  'countryCode',
  'preferences',
  'notes',
  'document',
];

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}

function toForm(g?: GuestDto): FormValues {
  return {
    fullName: g?.fullName ?? '',
    phone: g?.phone ?? '',
    email: g?.email ?? '',
    nationality: g?.nationality ?? '',
    addressLine: g?.addressLine ?? '',
    city: g?.city ?? '',
    countryCode: g?.countryCode ?? '',
    preferences: g?.preferences ?? '',
    notes: g?.notes ?? '',
    marketingConsent: g?.marketingConsent ?? false,
  };
}

/** Empty country codes mean "not given" (the fields also turn an empty box into null, so the form validates). */
function clean(values: FormValues): FormValues {
  const out = { ...values };
  if (!out.nationality) out.nationality = null;
  if (!out.countryCode) out.countryCode = null;
  if (out.document && !out.document.number) delete out.document;
  return out;
}

/**
 * Create or edit a guest. While typing, likely existing profiles (same phone, email or document, similar name)
 * are shown so staff can open them instead of creating a duplicate.
 */
export function GuestForm({
  guest,
  allowDocument,
  onSaved,
  onCancel,
}: {
  guest?: GuestDto;
  allowDocument: boolean;
  onSaved: (g: GuestDto) => void;
  onCancel: () => void;
}) {
  const t = useTranslations('guests');
  const [error, setError] = useState<unknown>(null);
  const [withDocument, setWithDocument] = useState(false);
  const form = useForm<FormValues>({
    resolver: zodResolver(createGuestRequest) as unknown as Resolver<FormValues>,
    defaultValues: toForm(guest),
  });
  const { errors, isSubmitting, dirtyFields } = form.formState;

  const watched = form.watch(['fullName', 'phone', 'email', 'document.documentType', 'document.number']);
  const probe = useDebounced(
    {
      fullName: watched[0] ?? '',
      phone: watched[1] ?? '',
      email: watched[2] ?? '',
      document:
        withDocument && watched[4] ? { documentType: watched[3] ?? 'cnic', number: watched[4] } : undefined,
    },
    400,
  );
  const meaningful =
    probe.fullName.trim().length >= 3 ||
    (probe.phone ?? '').replace(/\D/g, '').length >= 7 ||
    (probe.email ?? '').includes('@') ||
    !!probe.document;
  const duplicates = useQuery({
    queryKey: ['guest-duplicates', probe, guest?.id],
    queryFn: () =>
      api.post<DuplicateCandidateDto[]>('/guests/duplicate-check', {
        ...(probe.fullName.trim() ? { fullName: probe.fullName } : {}),
        ...(probe.phone ? { phone: probe.phone } : {}),
        ...(probe.email ? { email: probe.email } : {}),
        ...(probe.document ? { document: probe.document } : {}),
        ...(guest ? { excludeGuestId: guest.id } : {}),
      }),
    enabled: meaningful,
    staleTime: 30_000,
  });

  const onSubmit = form.handleSubmit(async (raw) => {
    setError(null);
    const values = clean(raw);
    try {
      if (guest) {
        const changed = Object.fromEntries(
          Object.entries(values).filter(([k]) => dirtyFields[k as keyof FormValues]),
        );
        onSaved(
          Object.keys(changed).length ? await api.patch<GuestDto>(`/guests/${guest.id}`, changed) : guest,
        );
      } else {
        onSaved(
          await api.post<GuestDto>('/guests', withDocument ? values : { ...values, document: undefined }),
        );
      }
    } catch (err) {
      if (!applyServerErrors(err, form.setError, FIELDS)) setError(err);
    }
  });

  const tTypes = useTranslations('guests.types');
  const tReasons = useTranslations('guests.reasons');

  return (
    <form onSubmit={onSubmit} noValidate className="grid gap-4 lg:grid-cols-[1fr_18rem]">
      <div className="flex flex-col gap-4">
        {error !== null && <ApiErrorAlert error={error} />}
        <Card title={t('contact')}>
          <div className="grid gap-4 md:grid-cols-2">
            <TextField
              label={t('fullName')}
              className="md:col-span-2"
              autoComplete="off"
              error={errors.fullName?.message}
              {...form.register('fullName')}
            />
            <TextField
              label={t('phone')}
              type="tel"
              error={errors.phone?.message}
              {...form.register('phone')}
            />
            <TextField
              label={t('email')}
              type="email"
              error={errors.email?.message}
              {...form.register('email')}
            />
            <TextField
              label={t('nationality')}
              maxLength={2}
              error={errors.nationality?.message}
              {...form.register('nationality', { setValueAs: (v: string | null) => v || null })}
            />
          </div>
        </Card>
        <Card title={t('address')}>
          <div className="grid gap-4 md:grid-cols-2">
            <TextField
              label={t('addressLine')}
              className="md:col-span-2"
              error={errors.addressLine?.message}
              {...form.register('addressLine')}
            />
            <TextField label={t('city')} error={errors.city?.message} {...form.register('city')} />
            <TextField
              label={t('countryCode')}
              maxLength={2}
              error={errors.countryCode?.message}
              {...form.register('countryCode', { setValueAs: (v: string | null) => v || null })}
            />
          </div>
        </Card>
        <Card title={t('other')}>
          <div className="grid gap-4">
            <TextField
              label={t('preferences')}
              error={errors.preferences?.message}
              {...form.register('preferences')}
            />
            <TextField label={t('notes')} error={errors.notes?.message} {...form.register('notes')} />
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" className="h-4 w-4" {...form.register('marketingConsent')} />
              {t('marketingConsent')}
            </label>
          </div>
        </Card>
        {!guest && allowDocument && (
          <Card title={t('documentOptional')}>
            {!withDocument ? (
              <Button
                variant="secondary"
                onClick={() => {
                  form.setValue('document', {
                    documentType: 'cnic',
                    issuingCountry: 'PK',
                    number: '',
                    expiryDate: null,
                  });
                  setWithDocument(true);
                }}
              >
                {t('addDocument')}
              </Button>
            ) : (
              <div className="grid gap-4 md:grid-cols-2">
                <SelectField label={t('documentType')} {...form.register('document.documentType')}>
                  {DOCUMENT_TYPES.map((d) => (
                    <option key={d} value={d}>
                      {tTypes(d)}
                    </option>
                  ))}
                </SelectField>
                <TextField
                  label={t('issuingCountry')}
                  maxLength={2}
                  error={errors.document?.issuingCountry?.message}
                  {...form.register('document.issuingCountry')}
                />
                <TextField
                  label={t('number')}
                  autoComplete="off"
                  error={errors.document?.number?.message}
                  {...form.register('document.number')}
                />
                <TextField
                  label={t('expiryDate')}
                  type="date"
                  error={errors.document?.expiryDate?.message}
                  {...form.register('document.expiryDate', { setValueAs: (v: string) => v || null })}
                />
              </div>
            )}
          </Card>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onCancel}>
            {t('cancel')}
          </Button>
          <Button type="submit" busy={isSubmitting}>
            {guest ? t('save') : isSubmitting ? t('creating') : t('create')}
          </Button>
        </div>
      </div>

      <aside aria-live="polite" className="lg:sticky lg:top-20 lg:self-start">
        {duplicates.data && duplicates.data.length > 0 && (
          <Alert tone="warning">
            <p className="font-medium">{t('possibleDuplicates')}</p>
            <p className="mt-1 text-xs">{t('duplicatesHint')}</p>
            <ul className="mt-3 flex flex-col gap-2">
              {duplicates.data.map((c) => (
                <li key={c.id} className="rounded-md bg-white/70 p-2 text-ink">
                  <p className="font-medium">{c.fullName}</p>
                  <p className="text-xs text-muted">
                    {[c.phone, c.email, c.city].filter(Boolean).join(' · ')}
                  </p>
                  <p className="text-xs">{c.reasons.map((r) => tReasons(r)).join(', ')}</p>
                  <Link href={`/guests/${c.id}`} className="text-xs font-medium text-teal-700 underline">
                    {t('open')}
                  </Link>
                </li>
              ))}
            </ul>
          </Alert>
        )}
      </aside>
    </form>
  );
}
