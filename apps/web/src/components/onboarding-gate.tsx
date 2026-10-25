'use client';

import { useTranslations } from 'next-intl';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { useSession } from '@/lib/session';
import { Card, PageSkeleton } from './ui';

/**
 * While the current property has not finished setup, managers are kept on the wizard and other staff
 * see a notice. The API does not depend on this; it is navigation only.
 */
export function OnboardingGate({ children }: { children: ReactNode }) {
  const t = useTranslations('onboarding');
  const { property, can } = useSession();
  const router = useRouter();
  const pathname = usePathname();
  const pending = property !== null && !property.onboardingCompleted;
  const manager = can('property.manage');
  const redirect =
    pending && manager && pathname !== '/onboarding'
      ? '/onboarding'
      : !pending && pathname === '/onboarding'
        ? '/'
        : null;

  useEffect(() => {
    if (redirect) router.replace(redirect);
  }, [redirect, router]);

  if (redirect) return <PageSkeleton />;
  // The account page stays reachable so staff can still manage their own two-step verification.
  if (pending && !manager && pathname !== '/account') {
    return (
      <Card>
        <h1 className="text-lg font-semibold text-navy-800">{t('inProgressTitle')}</h1>
        <p className="mt-2 text-sm text-muted">{t('inProgressBody', { property: property.name })}</p>
      </Card>
    );
  }
  return <>{children}</>;
}
