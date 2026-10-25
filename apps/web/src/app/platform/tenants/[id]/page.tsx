'use client';

import {
  ROOM_BANDS,
  SUPPORT_MINUTES,
  TENANT_PLANS,
  TENANT_STATUSES,
  type PlatformTenantDetailDto,
  type SupportViewDto,
} from '@innpilot/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useFormatter, useTranslations } from 'next-intl';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import {
  Alert,
  ApiErrorAlert,
  Button,
  Card,
  EmptyState,
  PageError,
  PageHeader,
  PageSkeleton,
  SelectField,
  StatusBadge,
  TextField,
} from '@/components/ui';
import { platformApi } from '@/lib/api';
import { TENANT_STATUS_TONE } from '@/lib/platform';

export default function PlatformTenantPage() {
  const t = useTranslations('platform');
  const format = useFormatter();
  const { id } = useParams<{ id: string }>();
  const queryClient = useQueryClient();
  const detail = useQuery({
    queryKey: ['platform', 'tenant', id],
    queryFn: () => platformApi.get<PlatformTenantDetailDto>(`/platform/tenants/${id}`),
  });
  const when = (iso: string) => format.dateTime(new Date(iso), { dateStyle: 'medium', timeStyle: 'short' });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['platform'] });

  if (detail.isPending) return <PageSkeleton />;
  if (detail.isError) return <PageError error={detail.error} onRetry={() => void detail.refetch()} />;
  const { tenant, activeGrant, grants, log } = detail.data;

  return (
    <>
      <p className="mb-2 text-sm">
        <Link href="/platform" className="underline decoration-line underline-offset-2">
          {t('hotels')}
        </Link>
      </p>
      <PageHeader title={tenant.displayName} subtitle={`${tenant.legalName} · ${tenant.slug}`} />
      <div className="grid gap-4 lg:grid-cols-2 lg:items-start">
        <Card title={t('account')}>
          <dl className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <dt className="text-xs text-muted">{t('statusLabel')}</dt>
              <dd>
                <StatusBadge tone={TENANT_STATUS_TONE[tenant.status]}>
                  {t(`status_${tenant.status}`)}
                </StatusBadge>
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted">{t('planLabel')}</dt>
              <dd>
                {t(`plan_${tenant.plan}`)} · {t(`band_${tenant.roomBand}`)}
              </dd>
            </div>
            <div className="col-span-2">
              <dt className="text-xs text-muted">{t('usage')}</dt>
              <dd>
                {t('counts', { properties: tenant.properties, rooms: tenant.rooms, users: tenant.users })}
              </dd>
            </div>
          </dl>
          {tenant.overBand && (
            <div className="mt-3">
              <Alert tone="warning">{t('overBandText')}</Alert>
            </div>
          )}
          <ChangeAccount detail={detail.data} onDone={refresh} />
        </Card>
        <Card title={t('support')}>
          <p className="mb-3 text-sm text-muted">{t('supportText')}</p>
          {activeGrant ? (
            <ActiveAccess tenantId={id} expiresAt={when(activeGrant.expiresAt)} onDone={refresh} />
          ) : (
            <OpenAccess tenantId={id} onDone={refresh} />
          )}
        </Card>
      </div>
      {activeGrant && <SupportView tenantId={id} />}
      <div className="mt-4 grid gap-4 lg:grid-cols-2 lg:items-start">
        <Card title={t('grants')}>
          {grants.length === 0 ? (
            <EmptyState message={t('noGrants')} />
          ) : (
            <ul className="divide-y divide-line text-sm">
              {grants.map((g) => (
                <li key={g.id} className="py-2">
                  <p>
                    {g.operatorName} · {when(g.grantedAt)} → {when(g.endedAt ?? g.expiresAt)}{' '}
                    {g.active && <StatusBadge tone="warning">{t('open')}</StatusBadge>}
                  </p>
                  <p className="text-xs text-muted">{g.reason}</p>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title={t('log')}>
          {log.length === 0 ? (
            <EmptyState message={t('noLog')} />
          ) : (
            <ul className="divide-y divide-line text-sm">
              {log.map((e) => (
                <li key={e.id} className="py-2">
                  <p>
                    {t(`action_${e.action.replace('platform.', '')}` as never)} · {e.operatorName ?? '—'}
                  </p>
                  <p className="text-xs text-muted">
                    {when(e.occurredAt)}
                    {e.reason && ` · ${e.reason}`}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}

function ChangeAccount({ detail, onDone }: { detail: PlatformTenantDetailDto; onDone: () => unknown }) {
  const t = useTranslations('platform');
  const [status, setStatus] = useState<string>(detail.tenant.status);
  const [plan, setPlan] = useState<string>(detail.tenant.plan);
  const [band, setBand] = useState<string>(detail.tenant.roomBand);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const changed =
    status !== detail.tenant.status || plan !== detail.tenant.plan || band !== detail.tenant.roomBand;

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await platformApi.patch(`/platform/tenants/${detail.tenant.id}`, {
        ...(status !== detail.tenant.status ? { status } : {}),
        ...(plan !== detail.tenant.plan ? { plan } : {}),
        ...(band !== detail.tenant.roomBand ? { roomBand: band } : {}),
        reason,
      });
      setReason('');
      await onDone();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-4 flex flex-col gap-3 border-t border-line pt-4">
      {error !== null && <ApiErrorAlert error={error} />}
      <div className="grid gap-3 sm:grid-cols-3">
        <SelectField label={t('statusLabel')} value={status} onChange={(e) => setStatus(e.target.value)}>
          {TENANT_STATUSES.map((s) => (
            <option key={s} value={s}>
              {t(`status_${s}`)}
            </option>
          ))}
        </SelectField>
        <SelectField label={t('planLabel')} value={plan} onChange={(e) => setPlan(e.target.value)}>
          {TENANT_PLANS.map((p) => (
            <option key={p} value={p}>
              {t(`plan_${p}`)}
            </option>
          ))}
        </SelectField>
        <SelectField label={t('bandLabel')} value={band} onChange={(e) => setBand(e.target.value)}>
          {ROOM_BANDS.map((b) => (
            <option key={b} value={b}>
              {t(`band_${b}`)}
            </option>
          ))}
        </SelectField>
      </div>
      {status === 'suspended' && status !== detail.tenant.status && (
        <Alert tone="warning">{t('suspendWarning')}</Alert>
      )}
      <TextField
        label={t('reason')}
        value={reason}
        maxLength={500}
        onChange={(e) => setReason(e.target.value)}
        hint={t('reasonHint')}
      />
      <div>
        <Button busy={busy} disabled={!changed || reason.trim().length < 10} onClick={() => void save()}>
          {t('saveChanges')}
        </Button>
      </div>
    </div>
  );
}

function OpenAccess({ tenantId, onDone }: { tenantId: string; onDone: () => unknown }) {
  const t = useTranslations('platform');
  const [reason, setReason] = useState('');
  const [minutes, setMinutes] = useState('30');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const open = async () => {
    setBusy(true);
    setError(null);
    try {
      await platformApi.post(`/platform/tenants/${tenantId}/access`, { reason, minutes: Number(minutes) });
      setReason('');
      await onDone();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-3">
      {error !== null && <ApiErrorAlert error={error} />}
      <TextField
        label={t('reason')}
        value={reason}
        maxLength={500}
        onChange={(e) => setReason(e.target.value)}
        hint={t('accessReasonHint')}
      />
      <SelectField label={t('duration')} value={minutes} onChange={(e) => setMinutes(e.target.value)}>
        {SUPPORT_MINUTES.map((m) => (
          <option key={m} value={m}>
            {t('minutes', { count: m })}
          </option>
        ))}
      </SelectField>
      <div>
        <Button busy={busy} disabled={reason.trim().length < 10} onClick={() => void open()}>
          {t('openAccess')}
        </Button>
      </div>
    </div>
  );
}

function ActiveAccess({
  tenantId,
  expiresAt,
  onDone,
}: {
  tenantId: string;
  expiresAt: string;
  onDone: () => unknown;
}) {
  const t = useTranslations('platform');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const end = async () => {
    setBusy(true);
    try {
      await platformApi.post(`/platform/tenants/${tenantId}/access/end`);
      await onDone();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-3">
      {error !== null && <ApiErrorAlert error={error} />}
      <Alert tone="warning">{t('accessOpen', { until: expiresAt })}</Alert>
      <div>
        <Button variant="secondary" busy={busy} onClick={() => void end()}>
          {t('endAccess')}
        </Button>
      </div>
    </div>
  );
}

function SupportView({ tenantId }: { tenantId: string }) {
  const t = useTranslations('platform');
  const format = useFormatter();
  const view = useQuery({
    queryKey: ['platform', 'support', tenantId],
    queryFn: () => platformApi.get<SupportViewDto>(`/platform/tenants/${tenantId}/support`),
    staleTime: 60_000,
  });
  if (view.isPending) return <PageSkeleton />;
  if (view.isError) return <PageError error={view.error} onRetry={() => void view.refetch()} />;
  const d = view.data;
  return (
    <div className="mt-4 grid gap-4 lg:grid-cols-3 lg:items-start">
      <Card title={t('properties')}>
        <ul className="divide-y divide-line text-sm">
          {d.properties.map((p) => (
            <li key={p.id} className="py-2">
              {p.name}
              <span className="block text-xs text-muted">
                {t('businessDate', { date: p.businessDate })} · {p.timezone} · {p.status}
              </span>
            </li>
          ))}
        </ul>
      </Card>
      <Card title={t('staff')}>
        <ul className="divide-y divide-line text-sm">
          {d.users.map((u) => (
            <li key={u.id} className="py-2">
              {u.fullName}
              <span className="block break-all text-xs text-muted">
                {u.email} · {u.roles.join(', ') || t('noRoles')} · {u.status}
                {u.mfaEnabled ? ` · ${t('mfaOn')}` : ''}
                {u.locked ? ` · ${t('locked')}` : ''}
              </span>
            </li>
          ))}
        </ul>
      </Card>
      <Card title={t('recentActivity')}>
        <ul className="divide-y divide-line text-sm">
          {d.recentActivity.map((a, i) => (
            <li key={i} className="py-2">
              <span className="font-mono text-xs">{a.action}</span>
              <span className="block text-xs text-muted">
                {format.dateTime(new Date(a.occurredAt), { dateStyle: 'medium', timeStyle: 'short' })}
              </span>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
