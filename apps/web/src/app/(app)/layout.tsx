'use client';

import { useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { AppShell } from '@/components/app-shell';
import { PageError, PageSkeleton } from '@/components/ui';
import { ApiError } from '@/lib/api';
import { SessionProvider, useMe } from '@/lib/session';

/** Signed-in area. Sends the user to the right sign-in step if the session is missing or incomplete. */
export default function AppLayout({ children }: { children: ReactNode }) {
  const router = useRouter();
  const me = useMe();

  const unauthenticated = me.error instanceof ApiError && me.error.code === 'UNAUTHENTICATED';
  const redirect = unauthenticated
    ? '/login'
    : me.data?.sessionState === 'mfa_verify'
      ? '/login/verify'
      : me.data?.sessionState === 'mfa_enroll'
        ? '/login/setup-mfa'
        : null;

  useEffect(() => {
    if (redirect) router.replace(redirect);
  }, [redirect, router]);

  if (me.isPending || redirect) {
    return (
      <div className="mx-auto max-w-6xl px-4 py-10">
        <PageSkeleton />
      </div>
    );
  }
  if (me.isError) {
    return (
      <div className="mx-auto max-w-xl px-4 py-10">
        <PageError error={me.error} onRetry={() => void me.refetch()} />
      </div>
    );
  }
  return (
    <SessionProvider me={me.data}>
      <AppShell>{children}</AppShell>
    </SessionProvider>
  );
}
