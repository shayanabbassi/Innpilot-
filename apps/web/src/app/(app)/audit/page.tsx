'use client';

import type { AuditEventDto } from '@innpilot/contracts';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useFormatter, useTranslations } from 'next-intl';
import { Button, EmptyState, PageError, PageHeader, PageSkeleton, PermissionDenied } from '@/components/ui';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';

function describeChanges(changes: Record<string, unknown>): string {
  return Object.entries(changes)
    .map(([field, v]) => {
      if (v && typeof v === 'object' && 'from' in v && 'to' in v) {
        const { from, to } = v as { from: unknown; to: unknown };
        return `${field}: ${JSON.stringify(from)} → ${JSON.stringify(to)}`;
      }
      return `${field}: ${JSON.stringify(v)}`;
    })
    .join('; ');
}

export default function AuditPage() {
  const t = useTranslations('audit');
  const tActions = useTranslations('actions');
  const tCommon = useTranslations('common');
  const format = useFormatter();
  const session = useSession();
  const allowed = session.canTenant('audit.read');

  const events = useInfiniteQuery({
    queryKey: ['audit-events'],
    queryFn: ({ pageParam }) =>
      api.page<AuditEventDto>(
        `/audit-events?limit=50${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ''}`,
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled: allowed,
  });

  if (!allowed) return <PermissionDenied />;
  const rows = events.data?.pages.flatMap((p) => p.items) ?? [];
  const actionLabel = (a: string) => (tActions.has(a as never) ? tActions(a as never) : a);

  return (
    <>
      <PageHeader title={t('title')} subtitle={t('subtitle')} />
      {events.isPending ? (
        <PageSkeleton />
      ) : events.isError ? (
        <PageError error={events.error} onRetry={() => void events.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState message={t('empty')} />
      ) : (
        <>
          <ol className="divide-y divide-line rounded-lg border border-line bg-white">
            {rows.map((e) => (
              <li key={e.id} className="grid gap-1 px-4 py-3 text-sm md:grid-cols-[11rem_12rem_1fr]">
                <time dateTime={e.occurredAt} className="tabular text-muted">
                  {format.dateTime(new Date(e.occurredAt), { dateStyle: 'medium', timeStyle: 'medium' })}
                </time>
                <span className="font-medium text-ink">{e.actor.name ?? t('system')}</span>
                <div>
                  <p className="text-ink">{actionLabel(e.action)}</p>
                  {Object.keys(e.changes).length > 0 && (
                    <p className="mt-0.5 break-words text-xs text-muted">{describeChanges(e.changes)}</p>
                  )}
                  {e.reason && (
                    <p className="mt-0.5 text-xs text-muted">{t('reason', { reason: e.reason })}</p>
                  )}
                </div>
              </li>
            ))}
          </ol>
          {events.hasNextPage && (
            <div className="mt-4 flex justify-center">
              <Button
                variant="secondary"
                busy={events.isFetchingNextPage}
                onClick={() => void events.fetchNextPage()}
              >
                {events.isFetchingNextPage ? tCommon('loading') : tCommon('loadMore')}
              </Button>
            </div>
          )}
        </>
      )}
    </>
  );
}
