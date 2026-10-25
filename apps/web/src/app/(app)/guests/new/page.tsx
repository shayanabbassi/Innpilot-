'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { GuestForm } from '@/components/guest-form';
import { PageHeader, PermissionDenied } from '@/components/ui';
import { useSession } from '@/lib/session';

export default function NewGuestPage() {
  const t = useTranslations('guests');
  const router = useRouter();
  const queryClient = useQueryClient();
  const { can } = useSession();
  if (!can('guest.write')) return <PermissionDenied />;
  return (
    <>
      <PageHeader title={t('newTitle')} />
      <GuestForm
        allowDocument={can('guest.identity.read')}
        onCancel={() => router.push('/guests')}
        onSaved={(g) => {
          void queryClient.invalidateQueries({ queryKey: ['guests'] });
          queryClient.setQueryData(['guest', g.id], g);
          router.replace(`/guests/${g.id}`);
        }}
      />
    </>
  );
}
