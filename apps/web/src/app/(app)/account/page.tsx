'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { MfaSetup } from '@/components/mfa-setup';
import { MySessions } from '@/components/my-sessions';
import { PasswordChangeForm } from '@/components/password-change';
import { api } from '@/lib/api';
import { Alert, Card, PageHeader } from '@/components/ui';
import { ME_QUERY_KEY, useSession } from '@/lib/session';

export default function AccountPage() {
  const t = useTranslations('account');
  const tPassword = useTranslations('password');
  const { me } = useSession();
  const queryClient = useQueryClient();

  return (
    <>
      <PageHeader title={t('title')} subtitle={me.user.email} />
      <div className="grid max-w-5xl gap-4 lg:grid-cols-2 lg:items-start">
        <Card title={t('security')}>
          {me.user.mfaEnabled ? (
            <div className="flex flex-col gap-3">
              <Alert tone="success">{t('mfaOn')}</Alert>
              <p className="text-sm text-muted">{t('lostPhone')}</p>
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              <p className="text-sm text-muted">{t('mfaOff')}</p>
              <MfaSetup onEnabled={() => queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY })} />
            </div>
          )}
        </Card>
        <Card title={tPassword('title')}>
          <PasswordChangeForm
            submit={(body) => api.post('/auth/password', body)}
            onDone={() => queryClient.invalidateQueries({ queryKey: ['auth', 'sessions'] })}
          />
        </Card>
        <Card title={tPassword('sessions')} className="lg:col-span-2">
          <MySessions />
        </Card>
      </div>
    </>
  );
}
