'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { MfaSetup } from '@/components/mfa-setup';
import { Alert } from '@/components/ui';
import { ME_QUERY_KEY } from '@/lib/session';
import { AuthFrame } from '../auth-frame';

export default function SetupMfaPage() {
  const t = useTranslations('mfa');
  const router = useRouter();
  const queryClient = useQueryClient();

  return (
    <AuthFrame title={t('setupTitle')}>
      <div className="flex flex-col gap-4">
        <Alert tone="info">{t('setupRequired')}</Alert>
        <MfaSetup
          onEnabled={async () => {
            await queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY });
            router.replace('/');
          }}
        />
      </div>
    </AuthFrame>
  );
}
