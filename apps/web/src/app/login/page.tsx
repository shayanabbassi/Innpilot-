'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { loginRequest, type LoginRequest, type LoginResponse } from '@innpilot/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { ApiErrorAlert, Button, TextField } from '@/components/ui';
import { api } from '@/lib/api';
import { applyServerErrors } from '@/lib/forms';
import { AuthFrame } from './auth-frame';

const NEXT_STEP = { active: '/', mfa_verify: '/login/verify', mfa_enroll: '/login/setup-mfa' } as const;

export default function LoginPage() {
  const t = useTranslations('login');
  const router = useRouter();
  const queryClient = useQueryClient();
  const [error, setError] = useState<unknown>(null);
  const form = useForm<LoginRequest>({
    resolver: zodResolver(loginRequest),
    defaultValues: { email: '', password: '' },
  });

  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);
    try {
      const result = await api.post<LoginResponse>('/auth/login', values);
      queryClient.clear();
      router.replace(NEXT_STEP[result.sessionState]);
    } catch (err) {
      if (!applyServerErrors(err, form.setError, ['email', 'password'])) setError(err);
      // Keep the email; clear the password so it is not left on screen.
      form.resetField('password');
    }
  });

  return (
    <AuthFrame title={t('title')} subtitle={t('subtitle')}>
      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
        {error !== null && <ApiErrorAlert error={error} />}
        <TextField
          label={t('email')}
          type="email"
          autoComplete="username"
          inputMode="email"
          autoFocus
          error={form.formState.errors.email?.message}
          {...form.register('email')}
        />
        <TextField
          label={t('password')}
          type="password"
          autoComplete="current-password"
          error={form.formState.errors.password?.message}
          {...form.register('password')}
        />
        <Button type="submit" busy={form.formState.isSubmitting} className="mt-2 w-full">
          {form.formState.isSubmitting ? t('submitting') : t('submit')}
        </Button>
        <p className="text-center text-xs text-muted">{t('noRecovery')}</p>
      </form>
    </AuthFrame>
  );
}
