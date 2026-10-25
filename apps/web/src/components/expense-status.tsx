'use client';

import type { ExpenseDto } from '@innpilot/contracts';
import { useTranslations } from 'next-intl';
import { StatusBadge } from '@/components/ui';

const TONE = {
  draft: 'neutral',
  submitted: 'warning',
  approved: 'warning',
  partly_paid: 'warning',
  paid: 'success',
  void: 'neutral',
} as const;

/** Status, with "waiting for approval" for a paid cash expense not yet reviewed. */
export function ExpenseStatusBadge({ expense }: { expense: ExpenseDto }) {
  const t = useTranslations('expenses');
  if (expense.needsApproval) return <StatusBadge tone="warning">{t('needsApproval')}</StatusBadge>;
  return <StatusBadge tone={TONE[expense.status]}>{t(`statuses.${expense.status}`)}</StatusBadge>;
}
