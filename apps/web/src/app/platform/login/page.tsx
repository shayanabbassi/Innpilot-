'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { platformLoginRequest, type OperatorDto, type PlatformLoginRequest } from '@innpilot/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { ApiErrorAlert, Button, Card, TextField } from '@/components/ui';
import { platformApi } from '@/lib/api';
import { applyServerErrors } from '@/lib/forms';

/** Operator sign-in: password and authenticator code in one step (MFA is never optional here). */
export default function PlatformLoginPage() {
  const t = useTranslations('platform');
  const router = useRouter();
  const queryClient = useQueryClient();
  const [error, setError] = useState<unknown>(null);
  const form = useForm<PlatformLoginRequest>({
    resolver: zodResolver(platformLoginRequest),
    defaultValues: { email: '', password: '', code: '' },
  });

  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);
    try {
      const operator = await platformApi.post<OperatorDto>('/platform/auth/login', values);
      queryClient.setQueryData(['platform', 'me'], operator);
      router.replace('/platform');
    } catch (err) {
      if (!applyServerErrors(err, form.setError, ['email', 'password', 'code'])) setError(err);
    }
  });

  return (
    <div className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-4">
      <p className="mb-2 text-center text-sm font-semibold uppercase text-muted">{t('title')}</p>
      <Card title={t('signIn')}>
        <form className="flex flex-col gap-4" onSubmit={(e) => void onSubmit(e)} noValidate>
          {error !== null && <ApiErrorAlert error={error} />}
          <TextField
            label={t('email')}
            type="email"
            autoComplete="username"
            {...form.register('email')}
            error={form.formState.errors.email?.message}
          />
          <TextField
            label={t('password')}
            type="password"
            autoComplete="current-password"
            {...form.register('password')}
            error={form.formState.errors.password?.message}
          />
          <TextField
            label={t('code')}
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            {...form.register('code')}
            error={form.formState.errors.code?.message}
          />
          <Button type="submit" busy={form.formState.isSubmitting}>
            {t('signIn')}
          </Button>
          <p className="text-xs text-muted">{t('signInNote')}</p>
        </form>
      </Card>
    </div>
  );
}
