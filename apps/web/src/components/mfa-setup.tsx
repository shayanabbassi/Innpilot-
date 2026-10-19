'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { mfaCodeRequest, type MfaCodeRequest, type MfaSetupResponse } from '@innpilot/contracts';
import { useTranslations } from 'next-intl';
import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { api } from '@/lib/api';
import { applyServerErrors } from '@/lib/forms';
import { ApiErrorAlert, Button, TextField } from './ui';

/** Enrolment: request a secret, show it as a QR code and key, then confirm with a first code. */
export function MfaSetup({ onEnabled }: { onEnabled: () => void | Promise<void> }) {
  const t = useTranslations('mfa');
  const [setup, setSetup] = useState<MfaSetupResponse | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const form = useForm<MfaCodeRequest>({
    resolver: zodResolver(mfaCodeRequest),
    defaultValues: { code: '' },
  });

  useEffect(() => {
    if (!setup) return;
    let cancelled = false;
    // Rendered locally: the secret never leaves the browser for a third-party QR service.
    QRCode.toDataURL(setup.otpauthUri, { margin: 1, width: 200 })
      .then((url) => !cancelled && setQr(url))
      .catch(() => !cancelled && setQr(null));
    return () => {
      cancelled = true;
    };
  }, [setup]);

  const start = async () => {
    setError(null);
    setStarting(true);
    try {
      setSetup(await api.post<MfaSetupResponse>('/auth/mfa/setup'));
    } catch (err) {
      setError(err);
    } finally {
      setStarting(false);
    }
  };

  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);
    try {
      await api.post('/auth/mfa/enable', values);
      await onEnabled();
    } catch (err) {
      if (!applyServerErrors(err, form.setError, ['code'])) setError(err);
      form.resetField('code');
    }
  });

  if (!setup) {
    return (
      <div className="flex flex-col gap-4">
        {error !== null && <ApiErrorAlert error={error} />}
        <Button onClick={start} busy={starting}>
          {starting ? t('starting') : t('start')}
        </Button>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
      {error !== null && <ApiErrorAlert error={error} />}
      <ol className="flex list-decimal flex-col gap-3 pl-5 text-sm text-ink">
        <li>{t('setupStep1')}</li>
        <li>
          {t('setupStep2')}
          <div className="mt-3 flex flex-col items-start gap-2">
            {qr && (
              <img
                src={qr}
                alt={t('qrAlt')}
                width={200}
                height={200}
                className="rounded border border-line"
              />
            )}
            <span className="text-xs text-muted">{t('manualKey')}</span>
            <code className="break-all rounded bg-canvas px-2 py-1 text-sm tracking-wider">
              {setup.secret}
            </code>
          </div>
        </li>
        <li>{t('setupStep3')}</li>
      </ol>
      <TextField
        label={t('code')}
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={6}
        className="tabular"
        error={form.formState.errors.code?.message}
        {...form.register('code')}
      />
      <Button type="submit" busy={form.formState.isSubmitting}>
        {form.formState.isSubmitting ? t('enabling') : t('enable')}
      </Button>
    </form>
  );
}
