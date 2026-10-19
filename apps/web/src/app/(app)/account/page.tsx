'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { MfaSetup } from '@/components/mfa-setup';
import { Alert, Card, PageHeader } from '@/components/ui';
import { ME_QUERY_KEY, useSession } from '@/lib/session';

export default function AccountPage() {
  const t = useTranslations('account');
  const { me } = useSession();
  const queryClient = useQueryClient();

  return (
    <>
      <PageHeader title={t('title')} subtitle={me.user.email} />
      <Card title={t('security')} className="max-w-xl">
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
    </>
  );
}
