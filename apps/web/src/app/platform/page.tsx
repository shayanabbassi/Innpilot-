'use client';

import type { PlatformTenantDto } from '@innpilot/contracts';
import { useQuery } from '@tanstack/react-query';
import { useFormatter, useTranslations } from 'next-intl';
import Link from 'next/link';
import { EmptyState, PageError, PageHeader, PageSkeleton, StatusBadge } from '@/components/ui';
import { platformApi } from '@/lib/api';
import { TENANT_STATUS_TONE } from '@/lib/platform';

/** Hotels on the platform: metadata and counts only. */
export default function PlatformTenantsPage() {
  const t = useTranslations('platform');
  const format = useFormatter();
  const list = useQuery({
    queryKey: ['platform', 'tenants'],
    queryFn: () => platformApi.get<PlatformTenantDto[]>('/platform/tenants'),
  });

  if (list.isPending) return <PageSkeleton />;
  if (list.isError) return <PageError error={list.error} onRetry={() => void list.refetch()} />;

  return (
    <>
      <PageHeader title={t('hotels')} subtitle={t('hotelsSubtitle')} />
      {list.data.length === 0 ? (
        <EmptyState message={t('noHotels')} />
      ) : (
        <ul className="grid gap-3 md:grid-cols-2">
          {list.data.map((h) => (
            <li key={h.id}>
              <Link
                href={`/platform/tenants/${h.id}`}
                className="block rounded-lg border border-line bg-white p-4 hover:border-navy-700/40"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-semibold text-ink">{h.displayName}</span>
                  <StatusBadge tone={TENANT_STATUS_TONE[h.status]}>{t(`status_${h.status}`)}</StatusBadge>
                </div>
                <p className="mt-1 text-xs text-muted">
                  {h.slug} · {t(`plan_${h.plan}`)} · {t(`band_${h.roomBand}`)}
                </p>
                <p className="mt-2 text-sm">
                  {t('counts', { properties: h.properties, rooms: h.rooms, users: h.users })}
                </p>
                {h.overBand && (
                  <p className="mt-1">
                    <StatusBadge tone="warning">{t('overBand')}</StatusBadge>
                  </p>
                )}
                <p className="mt-1 text-xs text-muted">
                  {h.lastSignIn
                    ? t('lastSignIn', {
                        at: format.dateTime(new Date(h.lastSignIn), {
                          dateStyle: 'medium',
                          timeStyle: 'short',
                        }),
                      })
                    : t('neverSignedIn')}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
