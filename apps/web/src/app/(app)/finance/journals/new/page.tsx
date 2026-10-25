'use client';

import { useTranslations } from 'next-intl';
import { JournalForm } from '@/components/journal-form';
import { PageHeader, PermissionDenied } from '@/components/ui';
import { useSession } from '@/lib/session';

export default function NewJournalPage() {
  const t = useTranslations('finance');
  const { canTenant } = useSession();
  if (!canTenant('journal.post')) return <PermissionDenied />;
  return (
    <>
      <PageHeader title={t('newJournal')} subtitle={t('newJournalSubtitle')} />
      <JournalForm />
    </>
  );
}
