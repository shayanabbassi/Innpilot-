'use client';

import { useTranslations } from 'next-intl';
import { RoomsSetup } from '@/components/rooms-setup';
import { Alert, PageHeader, PermissionDenied } from '@/components/ui';
import { useSession } from '@/lib/session';

export default function RoomsSettingsPage() {
  const t = useTranslations('rooms');
  const { property, can } = useSession();
  if (!property || !can('room.read')) return <PermissionDenied />;
  const canManage = can('room.manage');
  return (
    <>
      <PageHeader title={t('title')} subtitle={t('subtitle')} />
      {!canManage && (
        <div className="mb-4">
          <Alert tone="info">{t('readOnly')}</Alert>
        </div>
      )}
      <RoomsSetup key={property.id} propertyId={property.id} canManage={canManage} />
    </>
  );
}
