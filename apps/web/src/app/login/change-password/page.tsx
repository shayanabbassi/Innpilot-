'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { PasswordChangeForm } from '@/components/password-change';
import { Button } from '@/components/ui';
import { api } from '@/lib/api';
import { ME_QUERY_KEY } from '@/lib/session';
import { AuthFrame } from '../auth-frame';

/** After a manager-issued reset (D18): the temporary password works only to choose a new one. */
export default function ChangePasswordPage() {
  const t = useTranslations('password');
  const router = useRouter();
  const queryClient = useQueryClient();

  const signOut = async () => {
    await api.post('/auth/logout').catch(() => undefined);
    queryClient.clear();
    router.replace('/login');
  };

  return (
    <AuthFrame title={t('requiredTitle')} subtitle={t('requiredSubtitle')}>
      <PasswordChangeForm
        afterReset
        submit={(body) => api.post('/auth/password', body)}
        onDone={() => {
          void queryClient.refetchQueries({ queryKey: ME_QUERY_KEY }).then(() => router.replace('/'));
        }}
      />
      <div className="mt-4">
        <Button variant="ghost" onClick={() => void signOut()}>
          {t('signOut')}
        </Button>
      </div>
    </AuthFrame>
  );
}
