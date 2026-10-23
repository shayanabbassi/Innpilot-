'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { mfaCodeRequest, type MfaCodeRequest } from '@innpilot/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { ApiErrorAlert, Button, TextField } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { applyServerErrors } from '@/lib/forms';
import { ME_QUERY_KEY } from '@/lib/session';
import { AuthFrame } from '../auth-frame';

export default function VerifyPage() {
  const t = useTranslations('mfa');
  const router = useRouter();
  const queryClient = useQueryClient();
  const [error, setError] = useState<unknown>(null);
  const form = useForm<MfaCodeRequest>({
    resolver: zodResolver(mfaCodeRequest),
    defaultValues: { code: '' },
  });

  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);
    try {
      await api.post('/auth/mfa/verify', values);
      await queryClient.refetchQueries({ queryKey: ME_QUERY_KEY });
      router.replace('/');
    } catch (err) {
      // A lost or locked session cannot continue here.
      if (err instanceof ApiError && (err.code === 'UNAUTHENTICATED' || err.code === 'ACCOUNT_LOCKED')) {
        router.replace('/login');
        return;
      }
      if (!applyServerErrors(err, form.setError, ['code'])) setError(err);
      form.resetField('code');
    }
  });

  const signOut = async () => {
    await api.post('/auth/logout').catch(() => undefined);
    queryClient.clear();
    router.replace('/login');
  };

  return (
    <AuthFrame title={t('verifyTitle')} subtitle={t('verifySubtitle')}>
      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
        {error !== null && <ApiErrorAlert error={error} />}
        <TextField
          label={t('code')}
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          autoFocus
          className="tabular"
          error={form.formState.errors.code?.message}
          {...form.register('code')}
        />
        <Button type="submit" busy={form.formState.isSubmitting} className="w-full">
          {form.formState.isSubmitting ? t('verifying') : t('verify')}
        </Button>
        <Button variant="ghost" onClick={signOut}>
          {t('useOtherAccount')}
        </Button>
      </form>
    </AuthFrame>
  );
}
