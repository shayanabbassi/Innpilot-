'use client';

import { useTranslations } from 'next-intl';
import { ExpenseForm } from '@/components/expense-form';
import { PageHeader, PermissionDenied } from '@/components/ui';
import { useSession } from '@/lib/session';

export default function NewExpensePage() {
  const t = useTranslations('expenses');
  const { can } = useSession();
  if (!can('expense.write')) return <PermissionDenied />;
  return (
    <>
      <PageHeader title={t('newTitle')} subtitle={t('newSubtitle')} />
      <ExpenseForm />
    </>
  );
}
