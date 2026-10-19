'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { timeOfDay, timeZone, type PropertyDto } from '@innpilot/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import {
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
import { firstIncompleteStep, ONBOARDING_STEPS, type OnboardingStep } from '@/lib/onboarding';
import { ME_QUERY_KEY, useSession } from '@/lib/session';

const TIME_ZONES = Intl.supportedValuesOf('timeZone');
const required = z.string().trim().min(1, 'Required to finish setup.').max(300);

const businessSchema = z.object({
  name: required.max(200),
  legalName: required.max(200),
  phone: required.max(40),
  email: z
    .string()
    .trim()
    .max(254)
    .refine((v) => v === '' || z.string().email().safeParse(v).success, 'Enter a valid email address.'),
});
const locationSchema = z.object({
  addressLine: required,
  city: required.max(100),
  timezone: timeZone,
  checkInTime: timeOfDay,
  checkOutTime: timeOfDay,
});

const STEP_LABEL = { business: 'stepBusiness', location: 'stepLocation', review: 'stepReview' } as const;

export default function OnboardingPage() {
  const t = useTranslations('onboarding');
  const session = useSession();
  const propertyId = session.property?.id;
  const allowed = session.can('property.manage');
  const property = useQuery({
    queryKey: ['property', propertyId],
    queryFn: () => api.get<PropertyDto>(`/properties/${propertyId}`),
    enabled: allowed && !!propertyId,
  });

  if (!allowed || !propertyId) return <PermissionDenied />;
  if (property.isPending) return <PageSkeleton />;
  if (property.isError) return <PageError error={property.error} onRetry={() => void property.refetch()} />;

  return (
    <>
      <PageHeader title={t('title', { property: property.data.name })} subtitle={t('subtitle')} />
      <Wizard key={property.data.id} initial={property.data} />
    </>
  );
}

function Wizard({ initial }: { initial: PropertyDto }) {
  const t = useTranslations('onboarding');
  const [property, setProperty] = useState(initial);
  const [step, setStep] = useState<OnboardingStep>(() => firstIncompleteStep(initial));
  const index = ONBOARDING_STEPS.indexOf(step);

  const saved = (updated: PropertyDto, next: OnboardingStep) => {
    setProperty(updated);
    setStep(next);
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[14rem_1fr]">
      <nav aria-label={t('progress', { current: index + 1, total: ONBOARDING_STEPS.length })}>
        <ol className="flex gap-2 overflow-x-auto lg:flex-col">
          {ONBOARDING_STEPS.map((s, i) => (
            <li
              key={s}
              aria-current={s === step ? 'step' : undefined}
              className={`flex shrink-0 items-center gap-2 rounded-md px-3 py-2 text-sm ${
                s === step ? 'bg-navy-800 text-white' : i < index ? 'text-navy-800' : 'text-muted'
              }`}
            >
              <span
                aria-hidden
                className={`flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold ${
                  s === step ? 'bg-white text-navy-800' : 'bg-navy-50 text-navy-800'
                }`}
              >
                {i + 1}
              </span>
              {t(STEP_LABEL[s])}
            </li>
          ))}
        </ol>
      </nav>
      <div className="max-w-2xl">
        {step === 'business' && <BusinessStep property={property} onSaved={(p) => saved(p, 'location')} />}
        {step === 'location' && (
          <LocationStep
            property={property}
            onBack={() => setStep('business')}
            onSaved={(p) => saved(p, 'review')}
          />
        )}
        {step === 'review' && <ReviewStep property={property} onEdit={setStep} />}
      </div>
    </div>
  );
}

/** Saves only the fields that changed, so the audit log shows exactly what was edited. */
async function saveStep<T extends Record<string, string>>(
  property: PropertyDto,
  values: T,
  dirty: Partial<Record<keyof T, unknown>>,
): Promise<PropertyDto> {
  const changed = Object.fromEntries(Object.entries(values).filter(([k]) => dirty[k as keyof T]));
  if (Object.keys(changed).length === 0) return property;
  return api.patch<PropertyDto>(`/properties/${property.id}`, changed);
}

function BusinessStep({ property, onSaved }: { property: PropertyDto; onSaved: (p: PropertyDto) => void }) {
  const t = useTranslations('onboarding');
  const tp = useTranslations('property');
  const [error, setError] = useState<unknown>(null);
  const form = useForm<z.infer<typeof businessSchema>>({
    resolver: zodResolver(businessSchema),
    defaultValues: {
      name: property.name,
      legalName: property.legalName ?? '',
      phone: property.phone ?? '',
      email: property.email ?? '',
    },
  });
  const { errors, isSubmitting, dirtyFields } = form.formState;

  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);
    try {
      onSaved(await saveStep(property, values, dirtyFields));
    } catch (err) {
      if (!applyServerErrors(err, form.setError, Object.keys(values))) setError(err);
    }
  });

  return (
    <form onSubmit={onSubmit} noValidate>
      <Card title={t('stepBusiness')}>
        <div className="grid gap-4 md:grid-cols-2">
          {error !== null && (
            <div className="md:col-span-2">
              <ApiErrorAlert error={error} />
            </div>
          )}
          <TextField label={tp('name')} error={errors.name?.message} {...form.register('name')} />
          <TextField
            label={tp('legalName')}
            error={errors.legalName?.message}
            {...form.register('legalName')}
          />
          <TextField
            label={tp('phone')}
            type="tel"
            error={errors.phone?.message}
            {...form.register('phone')}
          />
          <TextField
            label={tp('email')}
            type="email"
            error={errors.email?.message}
            {...form.register('email')}
          />
        </div>
        <div className="mt-6 flex justify-end">
          <Button type="submit" busy={isSubmitting}>
            {t('saveContinue')}
          </Button>
        </div>
      </Card>
    </form>
  );
}

function LocationStep({
  property,
  onBack,
  onSaved,
}: {
  property: PropertyDto;
  onBack: () => void;
  onSaved: (p: PropertyDto) => void;
}) {
  const t = useTranslations('onboarding');
  const tp = useTranslations('property');
  const [error, setError] = useState<unknown>(null);
  const form = useForm<z.infer<typeof locationSchema>>({
    resolver: zodResolver(locationSchema),
    defaultValues: {
      addressLine: property.addressLine ?? '',
      city: property.city ?? '',
      timezone: property.timezone,
      checkInTime: property.checkInTime,
      checkOutTime: property.checkOutTime,
    },
  });
  const { errors, isSubmitting, dirtyFields } = form.formState;

  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);
    try {
      onSaved(await saveStep(property, values, dirtyFields));
    } catch (err) {
      if (!applyServerErrors(err, form.setError, Object.keys(values))) setError(err);
    }
  });

  return (
    <form onSubmit={onSubmit} noValidate>
      <Card title={t('stepLocation')}>
        <div className="grid gap-4 md:grid-cols-2">
          {error !== null && (
            <div className="md:col-span-2">
              <ApiErrorAlert error={error} />
            </div>
          )}
          <TextField
            label={tp('addressLine')}
            className="md:col-span-2"
            error={errors.addressLine?.message}
            {...form.register('addressLine')}
          />
          <TextField label={tp('city')} error={errors.city?.message} {...form.register('city')} />
          <SelectField label={tp('timezone')} error={errors.timezone?.message} {...form.register('timezone')}>
            {TIME_ZONES.map((tz) => (
              <option key={tz} value={tz}>
                {tz}
              </option>
            ))}
          </SelectField>
          <TextField
            label={tp('checkInTime')}
            type="time"
            error={errors.checkInTime?.message}
            {...form.register('checkInTime')}
          />
          <TextField
            label={tp('checkOutTime')}
            type="time"
            error={errors.checkOutTime?.message}
            {...form.register('checkOutTime')}
          />
          <TextField
            label={tp('currency')}
            value={property.currencyCode}
            hint={tp('currencyNote')}
            disabled
            readOnly
          />
        </div>
        <div className="mt-6 flex justify-between">
          <Button variant="secondary" onClick={onBack}>
            {t('back')}
          </Button>
          <Button type="submit" busy={isSubmitting}>
            {t('saveContinue')}
          </Button>
        </div>
      </Card>
    </form>
  );
}

function ReviewStep({ property, onEdit }: { property: PropertyDto; onEdit: (s: OnboardingStep) => void }) {
  const t = useTranslations('onboarding');
  const tp = useTranslations('property');
  const tCommon = useTranslations('common');
  const router = useRouter();
  const queryClient = useQueryClient();
  const [error, setError] = useState<unknown>(null);
  const [finishing, setFinishing] = useState(false);

  const finish = async () => {
    setError(null);
    setFinishing(true);
    try {
      const done = await api.post<PropertyDto>(`/properties/${property.id}/onboarding/complete`);
      queryClient.setQueryData(['property', property.id], done);
      await queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY });
      router.replace('/');
    } catch (err) {
      setError(err);
      setFinishing(false);
    }
  };

  const rows: { step: OnboardingStep; label: string; value: string | null }[] = [
    { step: 'business', label: tp('name'), value: property.name },
    { step: 'business', label: tp('legalName'), value: property.legalName },
    { step: 'business', label: tp('phone'), value: property.phone },
    { step: 'business', label: tp('email'), value: property.email },
    { step: 'location', label: tp('addressLine'), value: property.addressLine },
    { step: 'location', label: tp('city'), value: property.city },
    { step: 'location', label: tp('timezone'), value: property.timezone },
    { step: 'location', label: tp('checkInTime'), value: property.checkInTime },
    { step: 'location', label: tp('checkOutTime'), value: property.checkOutTime },
    { step: 'location', label: tp('currency'), value: property.currencyCode },
  ];

  return (
    <Card title={t('stepReview')}>
      <p className="mb-4 text-sm text-muted">{t('reviewIntro')}</p>
      {error !== null && (
        <div className="mb-4">
          <ApiErrorAlert error={error} />
        </div>
      )}
      <dl className="divide-y divide-line text-sm">
        {rows.map((r) => (
          <div key={r.label} className="grid grid-cols-[minmax(8rem,auto)_1fr_auto] items-center gap-3 py-2">
            <dt className="text-muted">{r.label}</dt>
            <dd className="break-words text-ink">{r.value || tCommon('none')}</dd>
            <dd>
              <Button variant="ghost" className="min-h-8 px-2" onClick={() => onEdit(r.step)}>
                {t('edit')}
                <span className="sr-only"> {r.label}</span>
              </Button>
            </dd>
          </div>
        ))}
      </dl>
      <div className="mt-6 flex justify-between">
        <Button variant="secondary" onClick={() => onEdit('location')}>
          {t('back')}
        </Button>
        <Button busy={finishing} onClick={() => void finish()}>
          {finishing ? t('finishing') : t('finish')}
        </Button>
      </div>
    </Card>
  );
}
