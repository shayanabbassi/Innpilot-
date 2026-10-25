'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { password, PASSWORD_MIN_LENGTH, z, type ChangePasswordRequest } from '@innpilot/contracts';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Alert, ApiErrorAlert, Button, TextField } from '@/components/ui';
import { applyServerErrors } from '@/lib/forms';

type Values = ChangePasswordRequest & { confirm: string };

/** The API's rules (changePasswordRequest) plus the confirmation, which only the screen needs. */
function formSchema(mismatch: string, same: string) {
  return z
    .object({
      currentPassword: z.string().min(1, 'Enter your current password.').max(128),
      newPassword: password,
      confirm: z.string(),
    })
    .refine((v) => v.newPassword !== v.currentPassword, { path: ['newPassword'], message: same })
    .refine((v) => v.confirm === v.newPassword, { path: ['confirm'], message: mismatch });
}

/**
 * Change password (slice 6.1): the current password (or the temporary one from a reset), then the new one twice.
 * `submit` posts to the hotel or the operator API; the server checks everything again.
 */
export function PasswordChangeForm({
  submit,
  afterReset = false,
  onDone,
}: {
  submit: (body: ChangePasswordRequest) => Promise<unknown>;
  /** Signed in with a temporary password: label the first field accordingly. */
  afterReset?: boolean;
  onDone?: () => void;
}) {
  const t = useTranslations('password');
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState(false);
  const form = useForm<Values>({
    resolver: zodResolver(formSchema(t('mismatch'), t('same'))),
    defaultValues: { currentPassword: '', newPassword: '', confirm: '' },
  });

  const onSubmit = form.handleSubmit(async ({ confirm: _confirm, ...body }) => {
    setError(null);
    setDone(false);
    try {
      await submit(body);
      form.reset();
      setDone(true);
      onDone?.();
    } catch (err) {
      if (!applyServerErrors(err, form.setError, ['currentPassword', 'newPassword'])) setError(err);
    }
  });

  return (
    <form onSubmit={(e) => void onSubmit(e)} noValidate className="flex flex-col gap-4">
      {error !== null && <ApiErrorAlert error={error} />}
      {done && <Alert tone="success">{t('changed')}</Alert>}
      <TextField
        label={afterReset ? t('temporary') : t('current')}
        type="password"
        autoComplete="current-password"
        error={form.formState.errors.currentPassword?.message}
        {...form.register('currentPassword')}
      />
      <TextField
        label={t('new')}
        type="password"
        autoComplete="new-password"
        hint={t('rule', { min: PASSWORD_MIN_LENGTH })}
        error={form.formState.errors.newPassword?.message}
        {...form.register('newPassword')}
      />
      <TextField
        label={t('confirm')}
        type="password"
        autoComplete="new-password"
        error={form.formState.errors.confirm?.message}
        {...form.register('confirm')}
      />
      <div>
        <Button type="submit" busy={form.formState.isSubmitting}>
          {t('save')}
        </Button>
      </div>
    </form>
  );
}
