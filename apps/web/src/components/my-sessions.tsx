'use client';

import type { SessionDto } from '@innpilot/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useFormatter, useTranslations } from 'next-intl';
import { ApiErrorAlert, Button, PageError, Skeleton, StatusBadge } from '@/components/ui';
import { api } from '@/lib/api';

const KEY = ['auth', 'sessions'];

/** Where you are signed in (slice 6.1): end a lost device's session, or every other one at once. */
export function MySessions() {
  const t = useTranslations('password');
  const format = useFormatter();
  const queryClient = useQueryClient();
  const list = useQuery({ queryKey: KEY, queryFn: () => api.get<SessionDto[]>('/auth/sessions') });
  const end = useMutation({
    mutationFn: (id: string | null) =>
      api.post(id ? `/auth/sessions/${id}/end` : '/auth/sessions/end-others'),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: KEY }),
  });

  if (list.isPending) return <Skeleton className="h-24" />;
  if (list.isError) return <PageError error={list.error} onRetry={() => void list.refetch()} />;
  const others = list.data.filter((s) => !s.current);
  const when = (iso: string) => format.dateTime(new Date(iso), { dateStyle: 'medium', timeStyle: 'short' });

  return (
    <div className="flex flex-col gap-3">
      {end.isError && <ApiErrorAlert error={end.error} />}
      <ul className="divide-y divide-line text-sm">
        {list.data.map((s) => (
          <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
            <span className="min-w-0">
              <span className="block break-words">
                {s.userAgent ? device(s.userAgent) : t('unknownDevice')}
              </span>
              <span className="block text-xs text-muted">
                {t('sessionLine', { since: when(s.createdAt), seen: when(s.lastSeenAt) })}
              </span>
            </span>
            {s.current ? (
              <StatusBadge tone="success">{t('thisDevice')}</StatusBadge>
            ) : (
              <Button
                variant="ghost"
                className="min-h-8 px-2"
                busy={end.isPending}
                onClick={() => end.mutate(s.id)}
              >
                {t('endSession')}
              </Button>
            )}
          </li>
        ))}
      </ul>
      {others.length > 0 && (
        <div>
          <Button variant="secondary" busy={end.isPending} onClick={() => end.mutate(null)}>
            {t('endOthers')}
          </Button>
        </div>
      )}
    </div>
  );
}

/** A short name for a browser's user agent, e.g. "Chrome on Windows". */
function device(ua: string): string {
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Chrome\//.test(ua)
      ? 'Chrome'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /Safari\//.test(ua)
          ? 'Safari'
          : 'Browser';
  const os = /Android/.test(ua)
    ? 'Android'
    : /iPhone|iPad/.test(ua)
      ? 'iOS'
      : /Windows/.test(ua)
        ? 'Windows'
        : /Mac OS X/.test(ua)
          ? 'macOS'
          : /Linux/.test(ua)
            ? 'Linux'
            : '';
  return os ? `${browser} on ${os}` : browser;
}
