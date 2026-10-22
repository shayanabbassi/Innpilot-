'use client';

import type { OperatorDto } from '@innpilot/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { Button, PageError, PageSkeleton } from '@/components/ui';
import { ApiError, platformApi } from '@/lib/api';

/**
 * The operator console (slice 5.7): its own sign-in and session, apart from the hotel app. A dark bar marks it, so
 * an operator never mistakes it for a hotel's screens.
 */
export default function PlatformLayout({ children }: { children: ReactNode }) {
  const t = useTranslations('platform');
  const pathname = usePathname();
  const router = useRouter();
  const queryClient = useQueryClient();
  const isLogin = pathname === '/platform/login';
  const me = useQuery({
    queryKey: ['platform', 'me'],
    queryFn: () => platformApi.get<OperatorDto>('/platform/me'),
    enabled: !isLogin,
    retry: false,
  });
  const signedOut = me.error instanceof ApiError && me.error.code === 'UNAUTHENTICATED';

  useEffect(() => {
    if (!isLogin && signedOut) router.replace('/platform/login');
  }, [isLogin, signedOut, router]);

  if (isLogin) return <div className="min-h-dvh bg-canvas">{children}</div>;

  const signOut = async () => {
    try {
      await platformApi.post('/platform/auth/logout');
    } finally {
      queryClient.removeQueries({ queryKey: ['platform'] });
      router.replace('/platform/login');
    }
  };

  return (
    <div className="min-h-dvh bg-canvas">
      <header className="no-print bg-ink text-white">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
          <span className="font-semibold">{t('title')}</span>
          <nav className="flex gap-4 text-sm" aria-label={t('title')}>
            <Link
              href="/platform"
              className={pathname === '/platform' ? 'underline' : 'text-white/80 hover:text-white'}
            >
              {t('hotels')}
            </Link>
            <Link
              href="/platform/audit"
              className={pathname === '/platform/audit' ? 'underline' : 'text-white/80 hover:text-white'}
            >
              {t('auditLog')}
            </Link>
            <Link
              href="/platform/password"
              className={pathname === '/platform/password' ? 'underline' : 'text-white/80 hover:text-white'}
            >
              {t('password')}
            </Link>
          </nav>
          <div className="ml-auto flex items-center gap-3 text-sm">
            {me.data && <span className="text-white/80">{me.data.fullName}</span>}
            <Button variant="secondary" onClick={() => void signOut()}>
              {t('signOut')}
            </Button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">
        {me.isPending || signedOut ? (
          <PageSkeleton />
        ) : me.isError ? (
          <PageError error={me.error} onRetry={() => void me.refetch()} />
        ) : (
          children
        )}
      </main>
    </div>
  );
}
