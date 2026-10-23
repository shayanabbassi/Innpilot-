'use client';

import type { UserActivityDto } from '@innpilot/contracts';
import { useQuery } from '@tanstack/react-query';
import { useFormatter, useTranslations } from 'next-intl';
import Link from 'next/link';
import { DateRangeFields, ExportMenu, ReportFootnote, useDateRange } from '@/components/report-filter';
import { Card, EmptyState, PageError, PageHeader, PageSkeleton, PermissionDenied } from '@/components/ui';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';

export default function UserActivityPage() {
  const t = useTranslations('reports');
  const tActions = useTranslations('actions');
  const format = useFormatter();
  const { canTenant, property } = useSession();
  const allowed = canTenant('audit.read');
  const range = useDateRange(property?.businessDate ?? new Date().toISOString().slice(0, 10));

  const res = useQuery({
    queryKey: ['reports', 'user-activity', range.query],
    queryFn: () => api.get<UserActivityDto>(`/reports/user-activity?${range.query}`),
    enabled: allowed && range.valid,
  });

  if (!allowed) return <PermissionDenied />;
  const d = res.data;
  const label = (a: string) => (tActions.has(a as never) ? tActions(a as never) : a);
  const when = (iso: string) =>
    format.dateTime(new Date(iso), {
      dateStyle: 'medium',
      timeStyle: 'short',
      ...(d?.timezone ? { timeZone: d.timezone } : {}),
    });

  return (
    <>
      <PageHeader title={t('uaTitle')} subtitle={t('uaSubtitle')} />
      <Card className="no-print mb-4">
        <div className="mb-4 flex justify-end">
          <ExportMenu report="user-activity" query={range.query} all />
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 lg:items-end">
          <DateRangeFields range={range} />
        </div>
      </Card>
      {!range.valid ? null : res.isPending ? (
        <PageSkeleton />
      ) : res.isError ? (
        <PageError error={res.error} onRetry={() => void res.refetch()} />
      ) : (
        <div className="flex flex-col gap-4">
          {d!.users.length === 0 ? (
            <EmptyState message={t('uaEmpty')} />
          ) : (
            <Card title={t('uaTotal', { count: d!.totalEvents })}>
              <ul className="divide-y divide-line text-sm">
                {d!.users.map((u) => (
                  <li key={u.userId ?? 'system'} className="py-3">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <span className="font-medium text-ink">{u.name}</span>
                      <span className="tabular">{t('uaEvents', { count: u.events })}</span>
                    </div>
                    <p className="text-xs text-muted">
                      {t('uaLine', {
                        signIns: u.signIns,
                        failed: u.failedSignIns,
                        first: when(u.firstAt),
                        last: when(u.lastAt),
                      })}
                    </p>
                    <p className="mt-1 text-xs text-ink">
                      {u.topActions.map((a) => `${label(a.action)} (${a.count})`).join(' · ')}
                    </p>
                  </li>
                ))}
              </ul>
            </Card>
          )}
          <p className="text-sm">
            <Link href="/audit" className="underline decoration-line underline-offset-2">
              {t('uaFullLog')}
            </Link>
          </p>
          <ReportFootnote
            currencyCode={d!.currencyCode}
            timezone={d!.timezone}
            generatedAt={d!.generatedAt}
            note={t('uaNote')}
          />
        </div>
      )}
    </>
  );
}
