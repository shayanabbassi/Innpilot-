'use client';

import type { PlatformAuditEventDto, PlatformTenantDto } from '@innpilot/contracts';
import { useQuery } from '@tanstack/react-query';
import { useFormatter, useTranslations } from 'next-intl';
import Link from 'next/link';
import { Card, EmptyState, PageError, PageHeader, PageSkeleton } from '@/components/ui';
import { platformApi } from '@/lib/api';

/** Everything operators did: sign-ins, account changes and support access. */
export default function PlatformAuditPage() {
  const t = useTranslations('platform');
  const format = useFormatter();
  const log = useQuery({
    queryKey: ['platform', 'audit'],
    queryFn: () => platformApi.get<PlatformAuditEventDto[]>('/platform/audit'),
  });
  const tenants = useQuery({
    queryKey: ['platform', 'tenants'],
    queryFn: () => platformApi.get<PlatformTenantDto[]>('/platform/tenants'),
  });

  if (log.isPending) return <PageSkeleton />;
  if (log.isError) return <PageError error={log.error} onRetry={() => void log.refetch()} />;
  const name = (id: string | null) =>
    id ? (tenants.data?.find((h) => h.id === id)?.displayName ?? id) : null;

  return (
    <>
      <PageHeader title={t('auditLog')} subtitle={t('auditSubtitle')} />
      {log.data.length === 0 ? (
        <EmptyState message={t('noLog')} />
      ) : (
        <Card>
          <ul className="divide-y divide-line text-sm">
            {log.data.map((e) => (
              <li key={e.id} className="py-2">
                <p>
                  {t(`action_${e.action.replace('platform.', '')}` as never)} · {e.operatorName ?? '—'}
                  {e.tenantId && (
                    <>
                      {' · '}
                      <Link
                        href={`/platform/tenants/${e.tenantId}`}
                        className="underline decoration-line underline-offset-2"
                      >
                        {name(e.tenantId)}
                      </Link>
                    </>
                  )}
                </p>
                <p className="text-xs text-muted">
                  {format.dateTime(new Date(e.occurredAt), { dateStyle: 'medium', timeStyle: 'short' })}
                  {e.reason && ` · ${e.reason}`}
                </p>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}
