'use client';

import { useFormatter, useTranslations } from 'next-intl';
import { Dashboard } from '@/components/dashboard';
import { Alert, Card, PageHeader } from '@/components/ui';
import { useSession } from '@/lib/session';

/**
 * Overview. Roles with operational reports on the current property get the dashboard (slice 5.5); others (such as
 * housekeeping) see their property and roles. Only real data is shown, never placeholder metrics.
 */
export default function OverviewPage() {
  const t = useTranslations('overview');
  const tRoles = useTranslations('roles');
  const format = useFormatter();
  const { me, property, can } = useSession();

  return (
    <>
      <PageHeader
        title={t('title', { name: me.user.fullName })}
        subtitle={
          property
            ? t('dashboardSubtitle', {
                hotel: property.name,
                roles: property.roles.map((r) => tRoles(r)).join(', '),
              })
            : t('subtitle', { hotel: me.tenant.displayName })
        }
      />
      {!property ? (
        <Alert tone="warning">{t('noProperty')}</Alert>
      ) : can('report.operational') ? (
        <Dashboard key={property.id} propertyId={property.id} />
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          <Card title={t('propertyCard')}>
            <p className="text-lg font-semibold text-ink">{property.name}</p>
            <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
              <dt className="text-muted">{t('businessDate')}</dt>
              <dd className="tabular">
                {format.dateTime(new Date(`${property.businessDate}T00:00:00Z`), {
                  dateStyle: 'full',
                  timeZone: 'UTC',
                })}
              </dd>
              <dt className="text-muted">{t('timezone')}</dt>
              <dd>{property.timezone}</dd>
              <dt className="text-muted">{t('currency')}</dt>
              <dd>{property.currencyCode}</dd>
            </dl>
          </Card>
          <Card title={t('yourRoles')}>
            <ul className="flex flex-wrap gap-2">
              {property.roles.map((r) => (
                <li key={r} className="rounded-full bg-navy-50 px-3 py-1 text-sm text-navy-800">
                  {tRoles(r)}
                </li>
              ))}
            </ul>
          </Card>
        </div>
      )}
    </>
  );
}
