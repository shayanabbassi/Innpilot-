'use client';

import type { SystemWarningsDto } from '@innpilot/contracts';
import { useQuery } from '@tanstack/react-query';
import { useFormatter, useTranslations } from 'next-intl';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';
import { Alert } from './ui';

/**
 * Backup and background-work warnings for the owner and manager (slice 7.2), shown above every page while the
 * problem lasts. Nothing appears when all is well, for other roles, or on a hosted service where the operator
 * watches these instead.
 */
export function SystemWarnings() {
  const t = useTranslations('systemWarnings');
  const format = useFormatter();
  const { me, canTenant } = useSession();
  const allowed =
    canTenant('system.warnings') || me.properties.some((p) => p.permissions.includes('system.warnings'));
  const q = useQuery({
    queryKey: ['system', 'warnings'],
    queryFn: () => api.get<SystemWarningsDto>('/system/warnings'),
    enabled: allowed,
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
  });
  if (!allowed || !q.data?.enabled || q.data.warnings.length === 0) return null;

  return (
    <div className="mb-4 space-y-2">
      {q.data.warnings.map((w) => (
        <Alert key={w.code} tone={w.severity === 'critical' ? 'danger' : 'warning'}>
          <p className="font-medium">
            {t(`${w.code}.title`, {
              since: w.since ? format.relativeTime(new Date(w.since)) : '',
              count: w.count ?? 0,
            })}
          </p>
          <p className="mt-1">{t(`${w.code}.action`)}</p>
        </Alert>
      ))}
    </div>
  );
}
