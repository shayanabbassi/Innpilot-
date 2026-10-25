'use client';

import { useTranslations } from 'next-intl';
import { PasswordChangeForm } from '@/components/password-change';
import { Card, PageHeader } from '@/components/ui';
import { platformApi } from '@/lib/api';

/** An operator changes their own password; their other sessions end. */
export default function PlatformPasswordPage() {
  const t = useTranslations('password');
  return (
    <>
      <PageHeader title={t('title')} />
      <Card className="max-w-xl">
        <PasswordChangeForm submit={(body) => platformApi.post('/platform/auth/password', body)} />
      </Card>
    </>
  );
}
